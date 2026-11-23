import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createLoop } from '../host/loop.js'

const src = {kind:'feishu',scopeId:'a'.repeat(64),tenantId:'tenant',recipientId:'ou_owner',chatId:'oc_dm',threadId:'om_root',
  privatePeerId:'ou_requester',privateChatsSince:100}
const input = {source:src,caseId:'case_a',messageId:'om_intake',requesterId:'ou_requester',text:'Complete the request',
  workerContext:'長'.repeat(262144),team:{lead:'dispatcher',answer:'analyst',develop:'coder'},roleModels:{}}
const seat = {sessionId:'worker-1',workspaceId:'workspace',resolvedPresetId:'analyst'}
const cmd = (row,action='send')=>({caseId:row.caseId,messageId:row.messageId,token:row.releaseToken,action})
// A later @ in the same topic belongs to the same case.
const mention = n=>({...input,messageId:'om_reply'+n,text:'@owner clarification '+n,workerContext:undefined})
// Release validation names the job's verified requester, so a grant for one member can be checked.
const authorize = async (source,signal,requesterId)=>{assert.deepEqual(source,src);assert.equal(requesterId,input.requesterId);signal.throwIfAborted()}
function fixture(overrides={}) {
  let disk
  const calls = {decide:[],work:[],deliver:[]}, commits = []
  const actors = {
    decide:b=>b.messageId===input.messageId ? {action:'work',role:'answer'} :
      b.openWork?.length ? {action:'merge',target:b.openWork[0].ref} : {action:'ignore'},
    work:()=>({...seat,question:'Please clarify.'}),
    deliver:({source,messageId})=>({chatId:source.chatId,messageId:'om_sent'+calls.deliver.length,inReplyTo:messageId}),
  }
  function open(initial=disk) {
    disk = structuredClone(initial)
    return createLoop({
      load:()=>structuredClone(disk),save:s=>{disk=structuredClone(s);commits.push(disk)},
      caseInfo:(c,m)=>c===input.caseId && m===input.messageId ? input : undefined,
      ...Object.fromEntries(Object.entries(actors).map(([k,fn])=>[k,b=>{calls[k].push(b);return (overrides[k] ?? fn)(b)}])),
      ...overrides.policy && {isReleaseRequired:overrides.policy}
    })
  }
  return {open,calls,commits,get disk(){return disk}}
}
const row = async l=>{await l.drain();return (await l.snapshot())[0]}
const start = async(l,job=input)=>{await l.enqueue(job);return row(l)}
async function release(l,r,action) {await l.release(cmd(r,action),authorize);return row(l)}

test('two merged @ clarifications and the final answer keep the worker and require separate releases across restarts',async()=>{
  const f=fixture({work:()=>{
    const n=f.calls.work.length
    return {...seat,workerProof:String(n).repeat(64),...n===3 ? {answer:'Please clarify.'} : {question:'Please clarify.'}}
  }})
  let l=f.open(), current=await start(l)
  const tokens=[],keys=[]
  for(let n=1;n<=2;n++) {
    assert.equal(current.status,'awaiting-release')
    assert.equal(current.outputKind,'question');assert.equal(current.answer,'Please clarify.')
    assert.equal(current.receipt,undefined)
    assert.doesNotMatch(JSON.stringify(current),/workerContext|workerProof|requesterId|clarification|privatePeerId/)
    tokens.push(current.releaseToken)
    assert.equal(f.calls.deliver.length,n-1)
    await l.dispose();l=f.open();assert.deepEqual(await row(l),current)
    const waiting=await release(l,current)
    assert.equal(waiting.status,'waiting-requester')
    assert.equal(waiting.outputKind,'question');assert.equal(waiting.answer,current.answer)
    assert.equal(waiting.receipt.messageId,'om_sent'+n);assert.equal(waiting.releaseToken,undefined)
    keys.push(f.calls.deliver.at(-1).idempotencyKey)
    assert.equal(f.calls.deliver.at(-1).messageId,input.messageId);assert.equal(f.calls.deliver.at(-1).requesterId,input.requesterId)
    await l.dispose();l=f.open()
    assert.deepEqual(await row(l),waiting)
    assert.deepEqual(f.disk.jobs[0].turns,[{questionId:waiting.receipt.messageId}])
    assert.equal(await l.isSentMessage(src,src.chatId,waiting.receipt.messageId),true)
    assert.equal(await l.isSentMessage({...src,recipientId:'ou_else'},src.chatId,waiting.receipt.messageId),false)
    const reply=mention(n)
    if(n===2)reply.workerContext='updated full thread'
    await Promise.all(Array.from({length:6},()=>l.enqueue(reply)))
    current=await row(l)
    const routed=f.calls.decide.filter(b=>b.messageId===reply.messageId)
    assert.equal(routed.length,1)
    assert.deepEqual(routed[0].openWork,[{ref:'w1',request:input.text,state:'waiting for the requester',output:waiting.answer}])
    const merged=f.disk.jobs.find(j=>j.messageId===reply.messageId)
    assert.deepEqual([merged.status,merged.mergedInto],['merged',{caseId:input.caseId,messageId:input.messageId}])
    const work=f.calls.work.at(-1)
    assert.deepEqual([work.messageId,work.continueWork,work.previousWorkspaceId],[input.messageId,true,seat.workspaceId])
    assert.deepEqual(work.supplements,[{from:'requester',text:reply.text}])
    assert.equal(work.requesterReply,undefined);assert.equal(work.attempt,1)
    assert.equal(work.workerContext,reply.workerContext ?? input.workerContext)
    assert.equal(current.sessionId,seat.sessionId);assert.equal(current.resolvedPresetId,seat.resolvedPresetId)
    await assert.rejects(l.release({...cmd(current),token:tokens[n-1]},authorize),{code:'release-stale'})
  }
  assert.equal(current.status,'awaiting-release');assert.equal(current.outputKind,'answer')
  tokens.push(current.releaseToken)
  const done=await release(l,current);keys.push(f.calls.deliver.at(-1).idempotencyKey)
  assert.equal(done.status,'delivered');assert.equal(done.outputKind,'answer');assert.equal(done.receipt.messageId,'om_sent3')
  assert.deepEqual([new Set(tokens).size,new Set(keys).size],[3,3])
  assert.deepEqual(Object.fromEntries(Object.entries(f.calls).map(([k,v])=>[k,v.length])),{decide:3,work:3,deliver:3})
  assert.equal(f.calls.decide[0].workerContext,input.workerContext)
  assert.equal(f.calls.decide[0].answer,undefined)
  // Each stage names the verified requester, so a grant for that member alone still admits it.
  assert.equal(f.calls.decide[0].requesterId,input.requesterId)
  assert.equal(f.calls.deliver.at(-1).requesterId,input.requesterId)
  assert.equal(f.calls.work[0].workerContext,input.workerContext)
  assert.doesNotMatch(JSON.stringify(f.disk),/workerContext|workerProof|clarification [12]/)
  await l.dispose();l=f.open()
  assert.deepEqual(await row(l),done)
  assert.equal(await l.isSentMessage(src,src.chatId,'om_sent3'),true)
  assert.ok(!f.disk.jobs[0].turns)
  for(const n of [1,2])assert.equal(await l.hasReceived(src,src.chatId,mention(n).messageId),true)
})

test('takeover withdraws the outstanding question and later @ messages are not offered the handed-over worker',async()=>{
  for(const previous of [false,true]) {
    const f=fixture({policy:()=>false}),l=f.open()
    let waiting=await start(l)
    if(previous)waiting=await start(l,mention(1))
    assert.equal(waiting.status,'waiting-requester')
    const n=f.calls.work.length
    assert.equal(waiting.receipt.messageId,'om_sent'+n)
    await l.takeOver({caseId:input.caseId,messageId:input.messageId},seat.sessionId,seat.workspaceId)
    for(const k of ['turns','answer','outputKind','receipt','workerProof','requesterId','workerContext'])assert.ok(!(k in f.disk.jobs[0]),k)
    await l.dispose();const reboot=f.open()
    assert.equal((await row(reboot)).status,'taken-over')
    if(previous)assert.equal((await reboot.enqueue(mention(1))).status,'merged')
    const decided=f.calls.decide.length
    await reboot.enqueue(mention(2));await reboot.drain()
    // The case's worker was handed over, so the message is ignored without asking the Router.
    assert.equal(f.calls.decide.length,decided)
    assert.equal(f.disk.jobs.at(-1).status,'ignored')
    assert.equal(f.calls.work.length,n);assert.equal(f.calls.deliver.length,n)
  }
})

test('declines and mismatched question receipts never wait or retry, even if the policy changes',async()=>{
  for(const outcome of ['decline','wrong-target','no-receipt']) {
    let required=true
    const f=fixture({policy:()=>required,deliver:()=>outcome==='wrong-target'?{chatId:src.chatId,messageId:'om_new',inReplyTo:'om_else'}:null})
    let l=f.open(), pending=await start(l)
    const stopped=await release(l,pending,outcome==='decline'?'decline':'send')
    assert.equal(stopped.status,outcome==='decline'?'declined':'uncertain')
    assert.equal(stopped.outputKind,'question');assert.equal(stopped.receipt,undefined)
    const n=f.calls.deliver.length
    await l.dispose();required=false;l=f.open();assert.deepEqual(await start(l),stopped)
    assert.equal(f.calls.deliver.length,n);assert.ok(!f.disk.jobs[0].turns)
    assert.equal(await l.isSentMessage(src,src.chatId,'om_new'),false)
    await assert.rejects(l.retry({caseId:input.caseId,messageId:input.messageId},input),{code:'retry-unavailable'})
    await assert.rejects(l.release(cmd(pending),authorize),{code:'release-stale'})
  }
})

test('incoming mentions still validate context, requester and the private chat binding',async()=>{
  const l=fixture().open()
  for(const patch of [{workerContext:'x'.repeat(262145)},{requesterId:'other'},
    {source:{...src,privateChatsSince:undefined}},{source:{...src,privatePeerId:undefined}},
    {source:{...src,privatePeerId:src.recipientId}}])
    await assert.rejects(l.enqueue({...input,...patch}),{code:'invalid-input'})
})

test('a merged clarification replays only before the worker starts; swapped seats or ambiguous output do not send',async()=>{
  const f=fixture({policy:()=>false,work:b=>b.continueWork ? {...seat,sessionId:'replacement',answer:'wrong seat'} : {...seat,question:'First?'}})
  const l=f.open()
  assert.equal((await start(l)).status,'waiting-requester')
  const reply=mention(1),stopped=await start(l,reply)
  assert.equal(stopped.status,'stopped');assert.equal(stopped.reason,'no-final-answer')
  const staged=f.commits.filter(s=>s.jobs[1]?.status==='merged')
  assert.deepEqual(staged.map(s=>s.jobs[0].status),['assigned','working','stopped'])
  for(const saved of staged) {
    const phase=saved.jobs[0].status,n=f.calls.work.length,nSend=f.calls.deliver.length
    const reboot=f.open(saved);await reboot.drain()
    assert.equal(f.calls.work.length-n,phase==='assigned'?1:0)
    assert.equal(f.calls.deliver.length,nSend)
    assert.equal(await reboot.hasReceived(src,src.chatId,reply.messageId),true)
  }
  for(const [overrides,job] of [
    [{decide:()=>({action:'work',role:'lead'})},input],
    [{work:()=>({...seat,answer:'both',question:'both'})},input],
    [{work:()=>({...seat,question:'unknown requester?'})},{...input,requesterId:undefined}],
    [{work:()=>({...seat,question:'question?',workerProof:'bad'})},input],
  ]) {
    const x=fixture(overrides),res=await start(x.open(),job)
    assert.equal(res.status,'stopped');assert.equal(x.calls.deliver.length,0)
  }
})

test('retrying a stripped legacy worker keeps its seat and takes a newly merged @ after another question',async()=>{
  const f=fixture({work:b=>{
    switch(f.calls.work.length){
      case 1:return {...seat,question:'Which report?',workerProof:'1'.repeat(64)}
      case 2:throw Object.assign(Error(),{code:'WORK_UNCERTAIN'})
      case 3:return {...seat,question:'Which month?',workerProof:'3'.repeat(64)}
      default:return {...seat,answer:'October report',workerProof:'4'.repeat(64)}
    }
  }})
  let l=f.open(), first=await start(l)
  const waiting=await release(l,first),oldQuestion=waiting.receipt.messageId
  // A previous release persisted a confirmed requester reply before starting the worker.
  const answered=structuredClone(f.disk),job=answered.jobs[0],one={messageId:'om_legacy_reply',text:'historical clarification'}
  Object.assign(job,{status:'assigned',attempt:0,turns:[{questionId:oldQuestion,replyId:one.messageId,question:job.answer,reply:one.text}]})
  delete job.receipt;delete job.answer;delete job.outputKind
  await l.dispose();l=f.open(answered)
  const failed=await row(l)
  assert.equal(f.calls.work.at(-1).requesterReply,one.text)
  assert.deepEqual([failed.status,failed.reason],['uncertain','work-uncertain'])
  assert.equal(f.disk.jobs[0].workerProof,undefined);assert.equal(f.disk.jobs[0].workerContext,input.workerContext)
  const old=structuredClone(f.disk)
  for(const k of ['text','team','roleModels','requesterId','workerContext','context'])delete old.jobs[0][k]
  await l.dispose();l=f.open(old)
  const cmd={caseId:input.caseId,messageId:input.messageId}
  const fallback={text:input.text,requesterId:input.requesterId,team:{...input.team,answer:'replacement',lead:'new-lead'},roleModels:{}}
  const assigned=await l.retry(cmd,fallback)
  assert.equal(assigned.status,'assigned');assert.equal(assigned.sessionId,seat.sessionId);assert.equal(assigned.resolvedPresetId,seat.resolvedPresetId)
  const next=await row(l);assert.equal(next.outputKind,'question')
  const retry=f.calls.work.at(-1)
  assert.deepEqual(retry.team,{...fallback.team,answer:'analyst'})
  assert.equal(retry.continueWork,true);assert.equal(retry.requesterReply,undefined);assert.equal(retry.workerProof,undefined)
  const staged=f.commits.find(s=>s.jobs[0].retries===1 && s.jobs[0].status==='assigned')
  assert.deepEqual(staged.jobs[0].turns,[{questionId:oldQuestion,replyId:one.messageId}])
  assert.deepEqual([staged.jobs[0].workspaceId,staged.jobs[0].sessionId,staged.jobs[0].presetId],[seat.workspaceId,seat.sessionId,'analyst'])
  const reopened=fixture({work:()=>({...seat,answer:'Recovered result'})}), boot=reopened.open(staged)
  assert.equal((await row(boot)).status,'awaiting-release')
  assert.equal(reopened.calls.work.length,1);assert.equal(reopened.calls.work[0].continueWork,true);assert.equal(reopened.calls.decide.length,0)
  const second=await release(l,next)
  assert.equal(second.status,'waiting-requester')
  await l.dispose();l=f.open()
  const two=mention(2),answer=await start(l,two)
  const last=f.calls.work.at(-1)
  assert.deepEqual([last.team.answer,last.continueWork,last.previousWorkspaceId],['analyst',true,seat.workspaceId])
  assert.deepEqual(last.supplements,[{from:'requester',text:two.text}])
  assert.equal(last.requesterReply,undefined)
  assert.deepEqual([answer.status,answer.sessionId,answer.outputKind,answer.answer],['awaiting-release',seat.sessionId,'answer','October report'])
  assert.equal(f.calls.decide.length,2);assert.equal(f.calls.deliver.length,2)
})

test('pre-clarification durable releases retain their exact token and older lead assignments cannot run',async()=>{
  const f=fixture({work:()=>({...seat,answer:'legacy final'})})
  const group={...src};delete group.privatePeerId;delete group.privateChatsSince
  const l=f.open();await start(l,{...input,source:group,requesterId:undefined,workerContext:undefined})
  const legacy=structuredClone(f.disk),j=legacy.jobs[0];delete j.outputKind
  const token=createHash('sha256').update(JSON.stringify([j.releaseNonce,j.caseId,j.messageId,...Object.values(group),j.text,j.answer])).digest('hex')
  const old=f.open(legacy)
  const [r]=await old.snapshot()
  assert.equal(r.releaseToken,token)
  await old.release(cmd(r),()=>true);assert.equal((await row(old)).status,'delivered')
  const assigned=structuredClone(f.commits.find(s=>s.jobs[0].status==='assigned'))
  Object.assign(assigned.jobs[0],{criteria:'old director assignment',role:'lead',presetId:'old'})
  const before=f.calls.work.length
  assert.equal((await row(f.open(assigned))).status,'stopped');assert.equal(f.calls.work.length,before)
})
