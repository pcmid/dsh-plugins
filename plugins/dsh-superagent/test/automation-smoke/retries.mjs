import assert from 'node:assert/strict'
import { issued } from './worker-tool.mjs'
import { followupId,messageId } from './feishu.mjs'
import { noteAnswer,retryRoute,retryWorker,sealRE } from './provider.mjs'

const job=(s,id)=>s.automation.find(j=>j.messageId===id)
const command=({caseId,messageId})=>({caseId,messageId})

export async function failBeforeExit(app,provider,transport) {
  const posts=transport.posts.length,seals=issued.length
  for(const p of [retryRoute,retryWorker]) {
    transport.publishGranted(p.id,p.text)
    await app.pollOnce();await app.drain()
  }
  assert.ifError(provider.error)
  const before=await app.snapshot(),router=job(before,retryRoute.id),worker=job(before,retryWorker.id)
  assert.deepEqual([router?.status,router?.reason,router?.role],['stopped','decision-failed',undefined])
  assert.ok(worker?.role==='develop' && (worker.status==='stopped' && worker.reason==='work-failed' ||
    worker.status==='uncertain' && worker.reason==='work-uncertain'),JSON.stringify(worker))
  assert.match(provider.retrySeal,sealRE)
  assert.deepEqual(issued.slice(seals),[provider.retrySeal],'real tool executed before the interrupted worker step')
  assert.ok(provider.retryRouterId && provider.retryWorkerId && provider.retryRouterId!==provider.retryWorkerId)
  const ignored=job(before,followupId)
  assert.equal(ignored.status,'ignored')
  await assert.rejects(app.retryWork(command(ignored)),{code:'retry-unavailable'})

  assert.equal(transport.posts.length,posts)
  return before
}

export async function retryAfterRestart(ctx,app,provider,transport,original) {
  const before=await app.snapshot(),start=provider.calls.length,posts=transport.posts.length,seals=issued.length
  const delivered=job(before,messageId)
  assert.equal(delivered.status,'delivered')
  await assert.rejects(app.retryWork(command(delivered)),{code:'retry-unavailable'})
  const router=job(before,retryRoute.id),worker=job(before,retryWorker.id)
  assert.equal(router.reason,'decision-failed')
  for(const [row,status] of [[router,'queued'],[worker,'assigned']]) {
    assert.deepEqual(await app.retryWork(command(row)),{...command(row),status})
    await app.drain()
    assert.ifError(provider.error)
  }
  const after=await app.snapshot(),routed=job(after,retryRoute.id),continued=job(after,retryWorker.id)
  assert.deepEqual(provider.calls.slice(start),['DECIDE','WORK','WORK'],'only the unassigned job visits the Router on retry')
  assert.notEqual(provider.retryRouterId,original.router)
  assert.equal((await ctx.sessionPersistence.stat(original.router)).header.agentPreset,'superagent-lead')
  assert.equal((await ctx.sessionPersistence.stat(provider.retryRouterId)).header.agentPreset,'superagent-lead')
  assert.deepEqual([routed?.caseId,routed?.status,routed?.answer],[router.caseId,'awaiting-release',noteAnswer])
  await ctx.sessionPersistence.flush()
  const log=await ctx.sessionPersistence.open(routed.workerSessionId,'read')
  try {
    const {events}=await log.read(), calls=events.filter(e=>e.type==='tool/call' && e.data.name==='superagent_answer').map(e=>e.data)
    assert.deepEqual(calls.map(c=>JSON.parse(c.arguments)),[{answer:''},{answer:noteAnswer}])
    assert.deepEqual(events.filter(e=>e.type==='tool/result').map(e=>[e.data.message.toolCallId,!!e.data.message.isError]),
      [[calls[0].callId,true],[calls[1].callId,false]])
    assert.deepEqual(events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['completed'])
  } finally {await log.close()}
  assert.deepEqual([continued?.sessionId,provider.retryWorkerId,provider.retrySeal],[original.worker,original.worker,original.seal])
  assert.deepEqual([continued.caseId,continued.status,continued.answer],[worker.caseId,'awaiting-release','Recovered '+original.seal])
  assert.ok(worker.routerSessionId && (await ctx.sessionPersistence.stat(worker.routerSessionId))?.header.id===worker.routerSessionId)
  assert.equal(continued.routerSessionId,worker.routerSessionId,'worker-only retry does not hide the unchanged Router conversation')
  assert.deepEqual([routed.routerSessionId,continued.workerSessionId],[provider.retryRouterId,original.worker])
  assert.equal(issued.length,seals,'retry reused the persisted result without another tool execution')
  assert.ok(routed.releaseToken && continued.releaseToken && !routed.receipt && !continued.receipt)
  assert.equal(transport.posts.length,posts)
  for(const row of [router,worker])assert.equal(before.cases.find(c=>c.id===row.caseId).archivedAt,undefined)
  assert.deepEqual(after.mentions,before.mentions)
  for(const j of [routed,continued])await app.releaseOutput({...command(j),action:'decline',token:j.releaseToken})
  assert.equal(transport.posts.length,posts)
  console.log('PASS retry: unarchived failures were retried cold. Router used a fresh session; worker resumed its original session with its prior tool result and no repeated execution. Both answers awaited release; ignored and delivered jobs rejected retry.')
}
