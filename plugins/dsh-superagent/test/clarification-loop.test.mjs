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
const incomingReply = (job,n)=>({chatId:src.chatId,threadId:src.threadId,senderId:input.requesterId,
  parentId:job.questionId,at:200+n,messageId:'om_reply'+n,text:'clarification '+n})
const authorize = async (source,signal)=>{assert.deepEqual(source,src);signal.throwIfAborted()}
function fixture(overrides={}) {
  let disk
  const calls = {decide:[],work:[],deliver:[]}, commits = []
  const actors = {
    decide:()=>({action:'work',role:'answer'}),
    work:()=>({...seat,question:'Please clarify.'}),
    deliver:({source,messageId})=>({chatId:source.chatId,messageId:'om_sent'+calls.deliver.length,inReplyTo:messageId}),
  }
  function open(initial=disk) {
    disk = structuredClone(initial)
    return createLoop({
      load:()=>structuredClone(disk),save:s=>{disk=structuredClone(s);commits.push(disk)},
      ...Object.fromEntries(Object.entries(actors).map(([k,fn])=>[k,b=>{calls[k].push(b);return (overrides[k] ?? fn)(b)}])),
      ...overrides.policy && {isReleaseRequired:overrides.policy}
    })
  }
  return {open,calls,commits,get disk(){return disk}}
}
const row = async l=>{await l.drain();return (await l.snapshot())[0]}
const start = async(l,job=input)=>{await l.enqueue(job);return row(l)}
async function release(l,r,action) {await l.release(cmd(r,action),authorize);return row(l)}

test('two question rounds and the final independently require confirmation, keep the original seat, and survive restarts',async()=>{
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
    assert.deepEqual(await l.waitingQuestions(src),[])
    assert.equal(f.calls.deliver.length,n-1)
    await l.dispose();l=f.open();assert.deepEqual(await row(l),current)
    const waiting=await release(l,current)
    assert.equal(waiting.status,'waiting-requester')
    assert.equal(waiting.outputKind,'question');assert.equal(waiting.answer,current.answer)
    assert.equal(waiting.receipt.messageId,'om_sent'+n);assert.equal(waiting.releaseToken,undefined)
    keys.push(f.calls.deliver.at(-1).idempotencyKey)
    assert.equal(f.calls.deliver.at(-1).messageId,input.messageId)
    await l.dispose();l=f.open()
    const [w]=await l.waitingQuestions(src)
    assert.deepEqual(w,{caseId:input.caseId,messageId:input.messageId,source:src,requesterId:input.requesterId,questionId:'om_sent'+n,originalText:input.text})
    assert.equal(await l.isQuestionReceipt(src,src.chatId,w.questionId),true)
    assert.equal(await l.isSentMessage(src,src.chatId,w.questionId),true)
    const reply=incomingReply(w,n)
    if(n===2)reply.workerContext='updated full thread'
    const results=await Promise.all(Array.from({length:6},()=>l.resumeQuestion(w,reply)))
    assert.equal(results.filter(Boolean).length,1)
    current=await row(l)
    const work=f.calls.work.at(-1)
    assert.equal(work.previousSessionId,seat.sessionId);assert.equal(work.previousWorkspaceId,seat.workspaceId)
    assert.equal(work.previousResolvedPresetId,seat.resolvedPresetId);assert.equal(work.workerProof,String(n).repeat(64))
    assert.equal(work.requesterReply,reply.text);assert.equal(work.previousQuestion,'Please clarify.')
    assert.equal(work.attempt,1);assert.equal(work.workerContext,reply.workerContext ?? input.workerContext)
    assert.deepEqual(await l.waitingQuestions(src),[])
    await assert.rejects(l.release({...cmd(current),token:tokens[n-1]},authorize),{code:'release-stale'})
  }
  assert.equal(current.status,'awaiting-release');assert.equal(current.outputKind,'answer')
  tokens.push(current.releaseToken)
  const done=await release(l,current);keys.push(f.calls.deliver.at(-1).idempotencyKey)
  assert.equal(done.status,'delivered');assert.equal(done.outputKind,'answer');assert.equal(done.receipt.messageId,'om_sent3')
  assert.deepEqual([new Set(tokens).size,new Set(keys).size],[3,3])
  assert.deepEqual(f.calls.work.slice(1).map(w=>[w.previousQuestion,w.requesterReply]),[
    ['Please clarify.','clarification 1'],['Please clarify.','clarification 2']])
  assert.deepEqual(Object.fromEntries(Object.entries(f.calls).map(([k,v])=>[k,v.length])),{decide:1,work:3,deliver:3})
  assert.equal(f.calls.decide[0].workerContext,input.workerContext)
  assert.equal(f.calls.decide[0].answer,undefined)
  assert.equal(f.calls.decide[0].requesterId,undefined)
  assert.equal(f.calls.work[0].workerContext,input.workerContext)
  assert.doesNotMatch(JSON.stringify(f.disk),/workerContext|workerProof|clarification [12]/)
  await l.dispose();l=f.open()
  for(const n of [1,2]){
    assert.equal(await l.isQuestionReceipt(src,src.chatId,'om_sent'+n),true)
    assert.equal(await l.isQuestionReceipt({...src,recipientId:'ou_else'},src.chatId,'om_sent'+n),false)
    assert.equal(await l.isQuestionReceipt(src,'oc_else','om_sent'+n),false)
  }
  assert.equal(await l.isQuestionReceipt(src,src.chatId,'om_sent3'),false)
  assert.equal(await l.isSentMessage(src,src.chatId,'om_sent3'),true)
  assert.deepEqual(await l.waitingQuestions(src),[])
})

test('taking over withdraws the outstanding question; earlier completed round IDs still deduplicate on restart',async()=>{
  for(const previous of [false,true]) {
    const f=fixture({policy:()=>false}),l=f.open()
    await start(l)
    const [first]=await l.waitingQuestions(src)
    const reply1=incomingReply(first,1)
    if(previous){await l.resumeQuestion(first,reply1);await l.drain()}
    const [last]=await l.waitingQuestions(src), reply=incomingReply(last,2)
    const key={caseId:input.caseId,messageId:input.messageId}, n=f.calls.work.length
    await l.takeOver(key,seat.sessionId,seat.workspaceId)
    assert.deepEqual(await l.waitingQuestions(src),[])
    assert.equal(await l.resumeQuestion(last,reply),false)
    const stored=f.disk.jobs[0]
    assert.deepEqual(stored.turns,previous ? [{questionId:first.questionId,replyId:reply1.messageId}] : undefined)
    for(const k of ['answer','outputKind','receipt','workerProof','requesterId','workerContext'])assert.ok(!(k in stored))
    await l.dispose();const reboot=f.open()
    assert.equal((await row(reboot)).status,'taken-over')
    assert.equal(await reboot.resumeQuestion(last,reply),false)
    assert.equal(await reboot.isQuestionReceipt(src,src.chatId,first.questionId),previous)
    assert.equal(f.calls.work.length,n);assert.equal(f.calls.deliver.length,n)
  }
})

test('declines and mismatched question receipts never wait or retry, even if the policy changes',async()=>{
  for(const outcome of ['decline','wrong-target','no-receipt']) {
    const f=fixture({deliver:b=>outcome==='wrong-target'?{chatId:src.chatId,messageId:'om_new',inReplyTo:'om_else'}:null})
    let l=f.open(), pending=await start(l)
    const stopped=await release(l,pending,outcome==='decline'?'decline':'send')
    assert.equal(stopped.status,outcome==='decline'?'declined':'uncertain')
    assert.equal(stopped.outputKind,'question');assert.equal(stopped.receipt,undefined)
    const n=f.calls.deliver.length
    await l.dispose();l=f.open();await start(l)
    assert.equal(f.calls.deliver.length,n);assert.deepEqual(await l.waitingQuestions(src),[])
    assert.equal(await l.isQuestionReceipt(src,src.chatId,'om_new'),false)
    await assert.rejects(l.release(cmd(pending),authorize),{code:'release-stale'})
  }
})

test('only an exact requester, question parent, thread, binding and live round can resume; no silent truncation',async()=>{
  const f=fixture({policy:()=>false}),l=f.open(),waiting=await start(l)
  assert.equal(waiting.status,'waiting-requester')
  const [w]=await l.waitingQuestions(src),r=incomingReply(w,1)
  assert.deepEqual(await l.waitingQuestions({...src,tenantId:'other'}),[])
  for(const patch of [{chatId:'oc_other'},{threadId:'om_other'},{parentId:input.messageId},{senderId:'ou_other'},{messageId:w.questionId},
    {messageId:input.messageId},{messageId:src.threadId},{text:' '},{at:0},{workerContext:'x'.repeat(262145)}])
    await assert.rejects(l.resumeQuestion(w,{...r,...patch}),{code:'invalid-input'})
  for(const source of [{...src,scopeId:'e'.repeat(64)},{...src,privateChatsSince:101},{...src,recipientId:'ou_other'}])
    assert.equal(await l.resumeQuestion({...w,source},r),false)
  assert.deepEqual((await l.snapshot())[0],waiting)
  assert.equal(await l.resumeQuestion(w,r),true);await l.drain()
  assert.equal(await l.resumeQuestion(w,r),false)
  const [w2]=await l.waitingQuestions(src)
  assert.equal(await l.resumeQuestion(w2,{...incomingReply(w2,2),messageId:r.messageId}),false)
  assert.deepEqual(await l.waitingQuestions(src),[w2])
  for(const patch of [{workerContext:'x'.repeat(262145)},{requesterId:'other'},
    {source:{...src,privateChatsSince:undefined}},{source:{...src,privatePeerId:undefined}},
    {source:{...src,privatePeerId:src.recipientId}}])
    await assert.rejects(l.enqueue({...input,...patch}),{code:'invalid-input'})
})

test('resumed reply commit is restartable only before the worker starts; failures, swapped workers or ambiguous output do not send',async()=>{
  const f=fixture({policy:()=>false,work:b=>b.previousSessionId ? {...seat,sessionId:'replacement',answer:'wrong seat'} : {...seat,question:'First?'}})
  const l=f.open();await start(l)
  const [w]=await l.waitingQuestions(src),r=incomingReply(w,1)
  await l.resumeQuestion(w,r)
  const stopped=await row(l)
  assert.equal(stopped.status,'stopped');assert.equal(stopped.reason,'no-final-answer')
  const staged=f.commits.filter(s=>s.jobs[0].turns?.at(-1)?.replyId===r.messageId)
  for(const saved of staged) {
    const phase=saved.jobs[0].status,n=f.calls.work.length,nSend=f.calls.deliver.length
    const reboot=f.open(saved);await reboot.drain()
    assert.equal(f.calls.work.length-n,phase==='assigned'?1:0)
    assert.equal(f.calls.deliver.length,nSend)
    assert.equal(await reboot.isQuestionReceipt(src,src.chatId,w.questionId),true)
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

test('retrying an old stripped worker record after a roster change keeps its seat and resumes new questions normally',async()=>{
  const f=fixture({work:b=>{
    switch(f.calls.work.length){
      case 1:return {...seat,question:'Which report?',workerProof:'1'.repeat(64)}
      case 2:throw Object.assign(Error(),{code:'WORK_UNCERTAIN'})
      case 3:return {...seat,question:'Which month?',workerProof:'3'.repeat(64)}
      default:return {...seat,answer:'October report',workerProof:'4'.repeat(64)}
    }
  }})
  let l=f.open(), first=await start(l)
  await release(l,first)
  const [q]=await l.waitingQuestions(src)
  const one=incomingReply(q,1)
  await l.resumeQuestion(q,one);const failed=await row(l)
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
  assert.deepEqual(staged.jobs[0].turns,[{questionId:q.questionId,replyId:one.messageId}])
  assert.deepEqual([staged.jobs[0].workspaceId,staged.jobs[0].sessionId,staged.jobs[0].presetId],[seat.workspaceId,seat.sessionId,'analyst'])
  const reopened=fixture({work:()=>({...seat,answer:'Recovered result'})}), boot=reopened.open(staged)
  assert.equal((await row(boot)).status,'awaiting-release')
  assert.equal(reopened.calls.work.length,1);assert.equal(reopened.calls.work[0].continueWork,true);assert.equal(reopened.calls.decide.length,0)
  await release(l,next);const [q2]=await l.waitingQuestions(src)
  await l.dispose();l=f.open()
  const two=incomingReply(q2,2)
  assert.equal(await l.resumeQuestion(q2,two),true);const answer=await row(l)
  const last=f.calls.work.at(-1)
  assert.equal(last.team.answer,'analyst');assert.equal(last.previousSessionId,seat.sessionId)
  assert.equal(last.workerProof,'3'.repeat(64));assert.equal(last.previousQuestion,'Which month?')
  assert.equal(last.requesterReply,two.text);assert.equal(last.continueWork,undefined)
  assert.deepEqual([answer.status,answer.outputKind,answer.answer],['awaiting-release','answer','October report'])
  assert.equal(f.calls.decide.length,1);assert.equal(f.calls.deliver.length,2)
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
