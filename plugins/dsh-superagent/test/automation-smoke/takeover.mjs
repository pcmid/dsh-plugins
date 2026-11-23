import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {followupId,messageId} from './feishu.mjs'
import {checkPlacement} from './placement.mjs'
import {held,manualPrompt,noteRequest,resultNames} from './provider.mjs'

const job=(s,id)=>s.automation.find(j=>j.messageId===id)
const command=({caseId,messageId})=>({caseId,messageId})
const waitingId='om_takeover_waiting'

async function seats(ctx,row) {
  assert.ok(row?.routerSessionId && row.workerSessionId && row.routerSessionId!==row.workerSessionId)
  await ctx.sessionPersistence.flush()
  for(const id of [row.routerSessionId,row.workerSessionId])assert.equal((await ctx.sessionPersistence.stat(id))?.header.id,id)
}
async function ownerPrompt(ctx,app,provider,transport,sessionId) {
  const before=await app.snapshot(),posts=transport.posts.length
  const taken=job(before,held.id)
  assert.deepEqual([taken?.status,taken?.workspaceId],['taken-over',provider.project.id])
  await checkPlacement(ctx,taken,provider.project)
  const phase=process.env.SMOKE_PHASE
  provider.manualSession=sessionId
  const accepted=await ctx.sessionController.prompt({sessionId,requestId:randomUUID(),mode:'queue',
    content:[{type:'text',text:manualPrompt(phase)}]},AbortSignal.timeout(5000))
  assert.ok(accepted.accepted)
  await ctx.agents.get(sessionId).whenIdle()
  assert.ifError(provider.error)
  assert.deepEqual(provider.manualTurns,[sessionId],'the manual prompt reached the actual native provider')
  await ctx.sessionPersistence.flush()
  const log=await ctx.sessionPersistence.open(sessionId,'read')
  try {
    const {events}=await log.read(),phases=phase==='prepare'?['prepare']:['prepare','release']
    const notices=events.filter(e=>e.type==='user/message' && e.data.source?.kind==='plugin:superagent-handoff')
    assert.equal(notices.length,1,'one durable context notice, not a second prompt or turn after restoring the worker')
    const ends=events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind)
    assert.equal(ends.length,1+phases.length)
    assert.equal(ends[0],'aborted','original native worker turn was cancelled, not completed')
    assert.deepEqual(ends.slice(1),phases.map(()=>'completed'))
    const answers=events.filter(e=>e.type==='assistant/message')
      .flatMap(e=>e.data.message.content).filter(b=>b.type==='text').map(b=>b.text)
    assert.deepEqual(answers,phases.map(p=>'Local owner reply: '+p))
  } finally {await log.close()}
  await app.drain()
  const after=await app.snapshot()
  for(const key of ['automation','cases','mentions'])assert.deepEqual(after[key],before[key],'owner text is not automation: '+key)
  assert.equal(transport.posts.length,posts)
}

export async function exerciseTakeover(ctx,app,provider,transport) {
  const posts=transport.posts.length
  await app.setReleasePolicy({required:true})
  transport.publishGranted(held.id,held.text)
  await app.pollOnce()
  const sessionId=await Promise.race([provider.heldTurn.promise,app.drain().then(()=>{
    assert.ifError(provider.error);assert.fail('worker never entered the native provider')
  })])
  const active=job(await app.snapshot(),held.id)
  assert.equal(active?.status,'working');await seats(ctx,active)
  assert.equal(sessionId,active.workerSessionId)
  await checkPlacement(ctx,active,provider.project)
  const worker=ctx.agents.get(sessionId), ordinary=ctx.agents.get('smoke-manual-tool-control')
  for(const name of resultNames.WORK) {
    assert.ok(worker.ctx.tools.get(name,worker))
    assert.ok(!ordinary.ctx.tools.get(name,ordinary),'a concurrently active seat must not expose '+name+' to another agent')
  }
  assert.deepEqual(await app.takeOver(command(active)),{sessionId})
  await app.drain();await ctx.agents.get(sessionId).whenIdle()
  assert.equal(provider.cancelledSession,sessionId,'the native provider received the cancellation signal')
  await ownerPrompt(ctx,app,provider,transport,sessionId)

  transport.publishGranted(waitingId,noteRequest)
  await app.pollOnce();await app.drain()
  const ready=job(await app.snapshot(),waitingId)
  assert.equal(ready?.status,'awaiting-release');assert.ok(ready.releaseToken);await seats(ctx,ready)
  assert.deepEqual(await app.takeOver(command(ready)),{sessionId:ready.workerSessionId})
  await assert.rejects(app.releaseOutput({...command(ready),action:'send',token:ready.releaseToken}),{code:'release-stale'})
  await app.drain()
  const taken=job(await app.snapshot(),waitingId)
  assert.deepEqual([taken.status,taken.workerSessionId,taken.releaseToken,taken.answer,taken.receipt],
    ['taken-over',ready.workerSessionId,undefined,undefined,undefined])
  assert.equal(transport.posts.length,posts)
  await app.setReleasePolicy({required:false})
  console.log('PASS takeover: a running native worker was cancelled; its ordinary owner prompt completed in the same session. Taking over a ready answer invalidated its release token. Zero posts.')
  return sessionId
}
export async function coldTakeover(ctx,app,provider,transport,sessionId) {
  await app.start()
  assert.equal(job(await app.snapshot(),held.id)?.workerSessionId,sessionId)
  await ownerPrompt(ctx,app,provider,transport,sessionId)
  assert.deepEqual(transport.posts,[])
  console.log('PASS cold takeover: ordinary owner prompt completed in the restored original native session; no automation or posts.')
}
export async function finishedTakeover(ctx,app) {
  const state=await app.snapshot()
  const delivered=job(state,messageId),ignored=job(state,followupId)
  assert.equal(delivered.status,'delivered');await seats(ctx,delivered)
  assert.equal(ignored.status,'ignored')
  assert.equal((await ctx.sessionPersistence.stat(ignored.routerSessionId))?.header.id,ignored.routerSessionId)
  assert.equal(ignored.workerSessionId,undefined)
  for(const row of [delivered,ignored])await assert.rejects(app.takeOver(command(row)),{code:'takeover-unavailable'})
}
