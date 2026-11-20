import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { gates,issued } from './worker-tool.mjs'
import { chatId,colleague,messageId,source } from './feishu.mjs'
import { mergeCase } from './provider.mjs'

const owner=source.recipientId, answers=mergeCase.answers
const job=(s,id)=>s.automation.find(j=>j.messageId===id)
const command=({caseId,messageId})=>({caseId,messageId})
const decision=(j,action)=>({...command(j),token:j.releaseToken,action})
async function poll(app) {await app.pollOnce();await app.drain();return app.snapshot()}

// The worker's own native log: its SuperAgent prompts, turn outcomes and tool results.
async function nativeLog(ctx,id) {
  await ctx.sessionPersistence.flush()
  const log=await ctx.sessionPersistence.open(id,'read')
  try {
    const {events}=await log.read()
    return {
      prompts:events.filter(e=>e.type==='user/message' && e.data.source.kind==='user').map(e=>JSON.parse(e.data.content[0].text.split('\n').at(-1))),
      ends:events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),
      results:events.filter(e=>e.type==='tool/result').map(e=>[e.data.message.toolCallId,!!e.data.message.isError,e.data.error?.code]),
      calls:events.filter(e=>e.type==='tool/call').map(e=>e.data.name),
    }
  } finally {await log.close()}
}
const supplied=(log,i)=>log.prompts[i].supplements?.map(s=>[s.from,s.text])
// One merged message: terminal, pointing at the job it joined, with no worker of its own.
function mergedInto(state,m,target) {
  const row=job(state,m.id)
  assert.deepEqual([row?.status,row?.mergedInto,row?.workerSessionId,row?.receipt,row?.answer],['merged',command(target),undefined,undefined,undefined])
  assert.ok(row.routerSessionId,'the Router decided the merge in its own native session')
}

export async function mergeBeforeExit(ctx,app,provider,transport) {
  const posts=transport.posts.length, seals=issued.length
  await app.setReleasePolicy({required:true})
  // Open work elsewhere: an answer awaiting release in another group, and om_root's question draft in another thread.
  transport.publishOther()
  const elsewhere=await poll(app), other=job(elsewhere,mergeCase.other.id)
  assert.ifError(provider.error)
  assert.deepEqual([other?.status,other?.answer],['awaiting-release',answers.other])
  assert.equal(job(elsewhere,messageId).status,'awaiting-release')
  assert.notEqual(other.caseId,job(elsewhere,messageId).caseId)

  // a) The worker is inside a native tool body when a second @ in its thread arrives.
  const gate={entered:Promise.withResolvers(),running:false,aborted:false}
  gates.set(mergeCase.gate,gate)
  const start=provider.calls.length
  transport.publishMergeRoot()
  await delay(5)
  transport.publishMerge(mergeCase.work,owner)
  await app.pollOnce()
  await Promise.race([gate.entered.promise,app.drain().then(()=>{assert.ifError(provider.error);assert.fail('worker never entered its native tool')})])
  const running=job(await app.snapshot(),mergeCase.work.id), workerId=running?.workerSessionId
  assert.deepEqual([running?.status,running?.role],['working','develop'])
  assert.ok(workerId && gate.running)
  await delay(5)
  transport.publishMerge(mergeCase.add,colleague)
  const first=await poll(app)
  assert.ifError(provider.error);assert.ifError(transport.error)
  assert.equal(provider.mergeRoutedWhileTool,true)
  assert.ok(gate.aborted && !gate.running,'the merge cancelled the running native tool body')
  const drafted=job(first,mergeCase.work.id)
  mergedInto(first,mergeCase.add,drafted)
  assert.deepEqual([drafted.status,drafted.outputKind,drafted.answer,drafted.workerSessionId,drafted.supplements],
    ['awaiting-release','answer',answers.add,workerId,undefined])
  assert.ok(drafted.releaseToken && !drafted.receipt)
  assert.deepEqual(provider.calls.slice(start),['DECIDE','WORK','DECIDE','WORK'])
  assert.equal(issued.length,seals,'the cancelled tool body issued nothing')
  let log=await nativeLog(ctx,workerId)
  assert.deepEqual(log.ends,['aborted','completed'],'the running worker turn was aborted, then the same session continued')
  assert.deepEqual(log.results.find(r=>r[0]===mergeCase.gatedCall),[mergeCase.gatedCall,true,'ABORTED'])
  assert.deepEqual([log.prompts[1].continue,supplied(log,1)],[true,[[mergeCase.add.from,mergeCase.add.text]]])
  assert.equal(transport.posts.length,posts)
  console.log('PASS merge running: a second @ was routed while the worker was inside a native tool; superagent_merge aborted that turn and the same session continued with the supplement; the answer awaits release; zero posts.')

  // b) A draft awaiting release is discarded when a later @ merges into it.
  transport.publishMerge(mergeCase.more,owner)
  const second=await poll(app), redrafted=job(second,mergeCase.work.id)
  assert.ifError(provider.error)
  mergedInto(second,mergeCase.more,redrafted)
  assert.deepEqual([redrafted.status,redrafted.answer,redrafted.workerSessionId],['awaiting-release',answers.more,workerId])
  assert.ok(redrafted.releaseToken && redrafted.releaseToken!==drafted.releaseToken)
  await assert.rejects(app.releaseOutput(decision(drafted,'send')),{code:'release-stale'})
  log=await nativeLog(ctx,workerId)
  assert.deepEqual([log.ends,log.prompts[2].continue,supplied(log,2)],[['aborted','completed','completed'],true,[[mergeCase.more.from,mergeCase.more.text]]])
  assert.equal(transport.posts.length,posts)
  console.log('PASS merge draft: merging into a reply awaiting release made the old release token stale; the same worker drafted a new reply.')

  // d) The Router sees the open request but routes this @ as separate work.
  transport.publishMerge(mergeCase.own,colleague)
  const third=await poll(app), own=job(third,mergeCase.own.id)
  assert.ifError(provider.error)
  assert.deepEqual([own?.status,own?.answer,own?.role,own?.mergedInto],['awaiting-release',answers.own,'answer',undefined])
  assert.ok(own.workerSessionId && own.workerSessionId!==workerId)
  assert.deepEqual(job(third,mergeCase.work.id),redrafted,'independent work leaves the earlier request untouched')
  await app.releaseOutput(decision(own,'decline'))
  console.log('PASS merge route: with superagent_merge offered, a superagent_route decision got its own worker and left the earlier draft unchanged.')

  // c) A posted reply in the thread reopens; its next reply is a new message.
  await app.releaseOutput(decision(redrafted,'send'))
  await app.drain()
  const sent=job(await app.snapshot(),mergeCase.work.id)
  assert.deepEqual([sent.status,sent.receipt],['delivered',{chatId,inReplyTo:mergeCase.work.id,messageId:'om_merge_receipt_1'}])
  transport.publishMerge(mergeCase.late,colleague)
  const fourth=await poll(app), reopened=job(fourth,mergeCase.work.id)
  assert.ifError(provider.error)
  mergedInto(fourth,mergeCase.late,reopened)
  assert.deepEqual([reopened.status,reopened.answer,reopened.workerSessionId,reopened.receipt],['awaiting-release',answers.late,workerId,undefined])
  assert.equal(transport.posts.length,posts+1,'a reopened reply waits for its own release')
  await app.releaseOutput(decision(reopened,'send'))
  await app.drain()
  const resent=job(await app.snapshot(),mergeCase.work.id)
  assert.deepEqual([resent.status,resent.receipt],['delivered',{chatId,inReplyTo:mergeCase.work.id,messageId:'om_merge_receipt_2'}])
  const replies=transport.posts.slice(posts)
  assert.deepEqual(replies.map(p=>[p.anchor,p.id,p.text]),[[mergeCase.work.id,'om_merge_receipt_1',answers.more],[mergeCase.work.id,'om_merge_receipt_2',answers.late]])
  assert.notEqual(replies[0].key,replies[1].key,'the reopened reply has its own delivery idempotency key')
  log=await nativeLog(ctx,workerId)
  assert.deepEqual([log.ends,log.prompts[3].continue,supplied(log,3)],[['aborted','completed','completed','completed'],true,[[mergeCase.late.from,mergeCase.late.text]]])
  console.log('PASS merge delivered: an @ after the posted reply reopened it in the same session; after release a new message was posted with a different receipt and idempotency key.')

  // e) The other group's open answer and om_root's open question were never offered (asserted by the Router fixture).
  await app.releaseOutput(decision(other,'decline'))
  assert.equal(provider.mergeTurns,3)
  console.log('PASS merge scope: Router openWork listed only earlier requests of the same native thread; open work in another thread and another group never appeared.')

  // f) Leave a merged follow-up mid-run at exit; it must survive the cold restart.
  transport.publishMerge(mergeCase.final,owner)
  await app.pollOnce()
  await Promise.race([provider.mergeFinalTurn.promise,app.drain().then(()=>{assert.ifError(provider.error);assert.fail('merged worker never resumed')})])
  const inFlight=await app.snapshot()
  mergedInto(inFlight,mergeCase.final,job(inFlight,mergeCase.work.id))
  assert.equal(job(inFlight,mergeCase.work.id).status,'working')
  await app.setReleasePolicy({required:false})
  assert.equal(transport.posts.length,posts+2)
  return {workerId,tokens:[drafted.releaseToken,redrafted.releaseToken,reopened.releaseToken]}
}

export async function mergeAfterRestart(ctx,app,provider,transport,saved) {
  const state=await app.snapshot(), target=job(state,mergeCase.work.id)
  assert.deepEqual([target?.status,target?.reason,target?.workerSessionId,target?.receipt],['uncertain','work-uncertain',saved.workerId,undefined])
  assert.deepEqual(target.supplements,[{messageId:mergeCase.final.id,text:mergeCase.final.text,senderId:owner}],'pending supplements survived the restart')
  for(const k of ['add','more','late','final'])mergedInto(state,mergeCase[k],target)
  assert.deepEqual([job(state,mergeCase.own.id).status,job(state,mergeCase.other.id).status],['declined','declined'])
  const start=provider.calls.length, posts=transport.posts.length
  assert.deepEqual(await app.retryWork(command(target)),{...command(target),status:'assigned'})
  await app.drain()
  assert.ifError(provider.error)
  const after=job(await app.snapshot(),mergeCase.work.id)
  assert.deepEqual([after.status,after.answer,after.workerSessionId,after.supplements],['awaiting-release',answers.final,saved.workerId,undefined])
  assert.ok(after.releaseToken && !saved.tokens.includes(after.releaseToken))
  assert.deepEqual(provider.calls.slice(start),['WORK'],'no Router call: the merge decision persisted')
  const log=await nativeLog(ctx,saved.workerId)
  assert.deepEqual(log.ends,['aborted','completed','completed','completed','aborted','completed'])
  assert.deepEqual(log.prompts.map((p,i)=>[p.continue,supplied(log,i)?.[0]?.[1]]),
    [[undefined,undefined],...['add','more','late','final','final'].map(k=>[true,mergeCase[k].text])])
  await app.releaseOutput(decision(after,'decline'))
  assert.equal(transport.posts.length,posts)
  console.log('PASS merge cold restart: merged rows and the pending supplement persisted; the owner retry continued the same native session with that supplement and drafted a new reply.')
}
