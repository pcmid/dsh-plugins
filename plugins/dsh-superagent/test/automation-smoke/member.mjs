import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { memberA,memberB,memberGroup,memberRoot } from './feishu.mjs'
import { memberColdRequest,memberRequest,noteAnswer } from './provider.mjs'

// Two members of one group: the owner allows only A. B's mentions keep waiting; one of them is ignored once.
const ids={a1:'om_member_a1',b1:'om_member_b1',a2:'om_member_a_later',b2:'om_member_b2',a3:'om_member_a_cold',b3:'om_member_b_cold'}
const name='Fixture member group'
const job=(s,id)=>s.automation.find(j=>j.messageId===id)
const activity=(s,id)=>s.mentions.find(m=>m.messageId===id)
const rowsOf=groups=>groups.filter(g=>g.chatId===memberGroup)
const topicRow=(groups,threadId)=>rowsOf(groups).find(g=>g.threadId===threadId)
const act=(app,row,action)=>app.groupAccess({action,scopeId:row.scopeId,chatId:row.chatId,threadId:row.threadId,messageId:row.messageId})
const decision=(j,action)=>({caseId:j.caseId,messageId:j.messageId,token:j.releaseToken,action})
async function poll(app) {await app.pollOnce();await app.drain();return app.snapshot()}
async function attention(app,needed) {assert.equal((await app.attention()).needed,needed)}
// Proposed for approval, with the verified author recorded by the Host.
function waiting(state,id,senderId) {
  const m=activity(state,id)
  assert.deepEqual([m?.canApprove,m?.senderId,m?.name],[true,senderId,name],'waiting for admission: '+id)
  assert.ok(!job(state,id))
  return m
}
function answered(state,id) {
  const j=job(state,id)
  assert.deepEqual([j?.status,j?.answer],['awaiting-release',noteAnswer],JSON.stringify(j))
  assert.ok(j.releaseToken && !j.releaseBlocked && !j.receipt)
  return j
}

export async function memberBeforeExit(app,provider,transport) {
  const posts=transport.posts.length
  await app.setReleasePolicy({required:true})
  // a) B, then A, each @ the owner in the same topic; the owner allows only A.
  transport.publishMemberRoot()
  await delay(5)
  transport.publishMember(ids.b1,'Fixture member B: please look at this too.',memberB,memberRoot)
  await delay(5)
  transport.publishMember(ids.a1,memberRequest,memberA,memberRoot)
  let calls=provider.calls.length
  const both=await poll(app)
  assert.ifError(transport.error)
  const a1=waiting(both,ids.a1,memberA)
  waiting(both,ids.b1,memberB)
  assert.equal(topicRow(both.source.groups,memberRoot)?.mode,'pending')
  assert.equal(provider.calls.length,calls)
  const grant=rowsOf(await act(app,a1,'sender')).find(g=>g.mode==='sender')
  assert.deepEqual(grant,{chatId:memberGroup,mode:'sender',senderId:memberA,note:memberRequest,name,approvedAt:grant?.approvedAt,grantId:grant?.grantId})
  // B's proposal in that topic stays as it was, without waiting for a later poll.
  const kept=await app.snapshot()
  waiting(kept,ids.b1,memberB)
  assert.equal(topicRow(kept.source.groups,memberRoot)?.mode,'pending')
  const ran=await poll(app)
  assert.ifError(provider.error);assert.ifError(transport.error)
  assert.deepEqual(provider.calls.slice(calls),['DECIDE','WORK'])
  const first=answered(ran,ids.a1)
  waiting(ran,ids.b1,memberB) // B's mention in the same topic is still waiting.
  // A's later @ in another topic of this group is handled without another click.
  calls=provider.calls.length
  transport.publishMember(ids.a2,memberRequest,memberA)
  const later=await poll(app)
  assert.ifError(provider.error)
  assert.deepEqual(provider.calls.slice(calls),['DECIDE','WORK'])
  const second=answered(later,ids.a2)
  assert.equal(activity(later,ids.a2)?.canApprove,false)
  assert.equal(topicRow(later.source.groups,ids.a2),undefined,'no proposal for an allowed member')
  waiting(later,ids.b1,memberB)

  // d) A conversation with a member grant cannot be ignored.
  const scopeId=a1.scopeId,before=rowsOf((await app.settingsSnapshot()).source.groups)
  await assert.rejects(app.groupAccess({scopeId,chatId:memberGroup,action:'ignore'}),{code:'admission-denied'})
  assert.deepEqual(rowsOf((await app.settingsSnapshot()).source.groups),before)

  // c) Ignore B's mention once: it leaves admission and is not proposed again; a newer @ in that topic is.
  await act(app,activity(later,ids.b1),'dismiss')
  for(const state of [await app.snapshot(),await poll(app)]) {
    assert.equal(activity(state,ids.b1)?.canApprove,false)
    assert.ok(!job(state,ids.b1))
    assert.equal(topicRow(state.source.groups,memberRoot),undefined)
  }
  await delay(5)
  transport.publishMember(ids.b2,'Fixture member B: a newer question in that topic.',memberB,memberRoot)
  const again=await poll(app)
  const b2=waiting(again,ids.b2,memberB)
  assert.equal(activity(again,ids.b1)?.canApprove,false)
  assert.equal(topicRow(again.source.groups,memberRoot)?.mode,'pending')
  // Leave nothing waiting for admission or release: the release phase checks attention at quiet points.
  await act(app,b2,'dismiss')
  for(const j of [first,second])await app.releaseOutput(decision(j,'decline'))
  const done=await app.snapshot()
  assert.ok(!done.mentions.some(m=>m.chatId===memberGroup && m.canApprove))
  assert.deepEqual(rowsOf(done.source.groups),[grant])
  assert.equal(transport.posts.length,posts)
  await app.setReleasePolicy({required:false})
  console.log('PASS member grant: of two members’ @s in one topic, allowing A ran A’s message and A’s later @ in another topic without a click; B’s stayed pending. Ignoring once dropped B’s proposal for good, a newer @ there was proposed again. Ignoring the group was refused while the member grant existed. Zero posts.')
  return {grant}
}

export async function memberAfterRestart(app,provider,transport,saved) {
  const settings=await app.settingsSnapshot(),scopeId=settings.source.scopeId
  // e) The member grant survived the cold Desktop exit and still applies to A only.
  assert.deepEqual(rowsOf(settings.source.groups),[saved.grant],'the member grant survived the cold Desktop exit')
  const calls=provider.calls.length,posts=transport.posts.length
  transport.publishMember(ids.a3,memberColdRequest,memberA)
  transport.publishMember(ids.b3,'Fixture member B: after the restart.',memberB)
  const cold=await poll(app)
  assert.ifError(provider.error);assert.ifError(transport.error)
  assert.deepEqual(provider.calls.slice(calls),['DECIDE','WORK'])
  const pending=answered(cold,ids.a3)
  const b3=waiting(cold,ids.b3,memberB)

  // b) The owner revokes A before the reply is released: it can still be declined, but never sent.
  assert.deepEqual(rowsOf(await app.groupAccess({scopeId,chatId:memberGroup,action:'revoke',senderId:memberA})).filter(g=>g.mode==='sender'),[])
  const blocked=job(await app.snapshot(),ids.a3)
  assert.deepEqual([blocked?.status,blocked?.releaseToken,blocked?.releaseBlocked,blocked?.receipt],['awaiting-release',pending.releaseToken,true,undefined],
    'the revoked request is offered only for declining')
  await assert.rejects(app.releaseOutput(decision(blocked,'send')),{code:'admission-denied'})
  await app.drain()
  assert.equal(transport.posts.length,posts)
  await act(app,b3,'dismiss')
  await attention(app,true) // Only the blocked reply is left to decide.
  await app.releaseOutput(decision(blocked,'decline'))
  await app.drain()
  assert.equal(job(await app.snapshot(),ids.a3)?.status,'declined')
  assert.equal(transport.posts.length,posts)
  await attention(app,false)
  console.log('PASS member restart: the member grant survived the cold Desktop exit; A’s new @ ran without a click while B’s waited. After revoking A, A’s drafted reply kept its token marked releaseBlocked: sending was refused, declining succeeded and cleared attention. Zero posts.')
}
