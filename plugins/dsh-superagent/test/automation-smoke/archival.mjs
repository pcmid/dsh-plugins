import assert from 'node:assert/strict'
import {archiveActive} from './provider.mjs'
import {declineId} from './feishu.mjs'

const job=(state,id)=>state.automation.find(j=>j.messageId===id)
export function checkSeatArchives(ctx,row,workerArchived) {
  const ids=ctx.workspaceRegistry.archivedSessionIds
  assert.ok(row?.routerSessionId && row.workerSessionId)
  assert.ok(ids.includes(row.routerSessionId),'DSH archived the decided Router')
  assert.equal(ids.includes(row.workerSessionId),workerArchived,'DSH worker archive state')
}

export async function archiveDuringWork(ctx,app,provider,transport) {
  const posts=transport.posts.length
  transport.publishGranted(archiveActive.id,archiveActive.text)
  await app.pollOnce()
  const session=await Promise.race([provider.archiveTurn.promise,app.drain().then(()=>{
    assert.ifError(provider.error);assert.fail('worker did not enter its model')
  })])
  const active=job(await app.snapshot(),archiveActive.id)
  assert.deepEqual([active?.status,active?.workerSessionId],['working',session])
  checkSeatArchives(ctx,active,false)
  await app.archiveCase({caseId:active.caseId})
  await app.drain()
  assert.equal(provider.cancelledSession,session,'archiving interrupted the active native model')
  const state=await app.snapshot(),stopped=job(state,archiveActive.id)
  assert.ok(['uncertain','stopped'].includes(stopped.status))
  assert.ok(!stopped.releaseToken && !stopped.receipt)
  checkSeatArchives(ctx,stopped,true)
  await ctx.sessionPersistence.flush()
  const log=await ctx.sessionPersistence.open(session,'read')
  try {
    const {events}=await log.read()
    assert.deepEqual(events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['aborted'])
  } finally {await log.close()}
  // This other case already has a pending output; archiving must preserve its separate approval.
  const pending=job(state,declineId)
  assert.ok(pending.status==='awaiting-release' && pending.releaseToken)
  await app.archiveCase({caseId:pending.caseId})
  const archived=await app.snapshot()
  assert.deepEqual(archived.automation,state.automation)
  assert.deepEqual(archived.mentions,state.mentions)
  checkSeatArchives(ctx,pending,true)
  assert.equal(transport.posts.length,posts)
  return {session,status:stopped.status,token:pending.releaseToken,archivedAt:[stopped,pending].map(row=>archived.cases.find(c=>c.id===row.caseId).archivedAt)}
}

export async function checkColdArchive(ctx,app,provider,transport,saved) {
  const state=await app.snapshot(),stopped=job(state,archiveActive.id),pending=job(state,declineId)
  assert.deepEqual([stopped.workerSessionId,stopped.status,stopped.receipt],[saved.session,saved.status,undefined])
  assert.deepEqual([pending.status,pending.releaseToken],['awaiting-release',saved.token])
  const calls=provider.calls.length
  for(const [i,row] of [stopped,pending].entries()) {
    assert.ok(Number.isSafeInteger(saved.archivedAt[i]) && saved.archivedAt[i]>0)
    assert.equal(state.cases.find(c=>c.id===row.caseId)?.archivedAt,saved.archivedAt[i])
    checkSeatArchives(ctx,row,true)
    const target={caseId:row.caseId,messageId:row.messageId}
    await assert.rejects(app.retryWork(target),{code:'retry-unavailable'})
    await assert.rejects(app.takeOver(target),{code:'takeover-unavailable'})
  }
  await app.drain()
  assert.equal(provider.calls.length,calls)
  assert.deepEqual((await app.snapshot()).automation,state.automation)
  assert.equal(transport.posts.length,0)
  console.log('PASS native archive: decided Router archived independently. Archiving an active case aborted its native model without sending; cold restart retained both archived seats, the stopped job and a separate archived pending release.')
}
