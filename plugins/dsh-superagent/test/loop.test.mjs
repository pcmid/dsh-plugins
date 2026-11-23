import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoop } from '../host/loop.js'

const input = {caseId:'case_1',messageId:'om_in',text:'Example request',context:'Same authorized topic only',
  source:{kind:'feishu',scopeId:'f'.repeat(64),tenantId:'test',recipientId:'ou_owner',chatId:'oc_group',threadId:'om_root'},
  team:{lead:'',develop:'chosen-by-owner',answer:''},roleModels:{develop:{provider:'fake',model:'test'}}}
const task = {action:'work',role:'develop'}
const result = {answer:'October',sessionId:'worker-1',workspaceId:'space_1',resolvedPresetId:'chosen-by-owner'}
const reply = ({source,messageId}) => ({chatId:source.chatId,inReplyTo:messageId,messageId:'om_sent'})
const clone = structuredClone
function deferred() { let resolve; const promise=new Promise(r=>{resolve=r});return {resolve,promise} }
function harness(overrides={},initial) {
  const state={saved:clone(initial),commits:[],calls:[]}
  const effects = {decide:()=>task,work:()=>result,deliver:reply}
  state.loop=createLoop({load:async()=>state.saved, save:async value=>{
    state.saved=clone(value);state.commits.push(state.saved)
  },...Object.fromEntries(Object.entries(effects).map(([k,fn])=>[k,(args)=>{
    state.calls.push([k,args.messageId]);assert.ok(args.signal instanceof AbortSignal)
    return (overrides[k] || fn)(args)
  }])),...Object.fromEntries(Object.entries(overrides).filter(([k])=>!(k in effects)))})
  return state
}
// Pre-existing cases exercise the explicit automatic-send policy.
const automatic=(overrides,initial)=>harness({...overrides,isReleaseRequired:()=>false},initial)
async function run(h,job=input) {
  await h.loop.enqueue(job);await h.loop.drain();return (await h.loop.snapshot())[0]
}
const states=h=>h.commits.map(c=>c.jobs[0].status)

test('a final worker answer goes directly to outbound policy; only its public answer and receipt survive',async()=>{
  const changes=[]
  const h=automatic({
    onChange:()=>{changes.push(true);throw Error('disconnected UI')},
    decide:b=>{assert.deepEqual(b.team,input.team);assert.equal(b.context,undefined);return {...task,tool:'private-decision'}},
    work:b=>{assert.equal(b.role,task.role);assert.equal(b.criteria,undefined);assert.equal(b.attempt,1)
      assert.equal(b.roleModels.develop.model,'test');return {...result,thought:'private-work'}},
    deliver:b=>{assert.deepEqual(b.source,input.source);assert.equal(b.text,result.answer);assert.equal(b.messageId,input.messageId)
      assert.match(b.idempotencyKey,/^sa-[a-f0-9]{40}$/);assert.equal(h.saved.jobs[0].status,'delivering')
      return {...reply(b),auth:'private-receipt'}},
  })
  const row=await run(h,{...input,token:'private-input',source:{...input.source,url:'private-source-url'}})
  assert.deepEqual(states(h),['queued','deciding','assigned','working','approved','delivering','delivered'])
  const approved=h.commits.find(c=>c.jobs[0].status==='approved').jobs[0]
  assert.equal(approved.outputKind,'answer');assert.equal(approved.answer,result.answer)
  assert.equal(changes.length,h.commits.length)
  assert.deepEqual(row.receipt,reply(input));assert.equal(row.answer,result.answer);assert.equal(row.status,'delivered')
  assert.equal(row.sessionId,result.sessionId);assert.equal(row.workspaceId,result.workspaceId)
  assert.equal(row.presetId,input.team.develop);assert.equal(row.resolvedPresetId,result.resolvedPresetId);assert.equal(row.attempt,1)
  assert.equal(typeof row.updatedAt,'number');assert.equal(row.team,undefined);assert.equal(row.source,undefined)
  assert.equal(h.saved.jobs[0].text,undefined)
  assert.doesNotMatch(JSON.stringify(h.commits),/private-(decision|work|receipt|input|source-url)/)
  row.receipt.messageId='changed';assert.notEqual((await h.loop.snapshot())[0].receipt.messageId,'changed')
})

test('only an outgoing receipt in this account and chat is an echo after reopening',async()=>{
  const h=automatic();await run(h)
  const restored=harness({},h.saved).loop, owner=input.source
  assert.equal(await restored.isSentMessage(owner,owner.chatId,'om_sent'),true)
  for(const [identity,chat,id] of [[owner,owner.chatId,input.messageId],[owner,'oc_other','om_sent'],
    [{...owner,recipientId:'ou_other'},owner.chatId,'om_sent'],[{...owner,tenantId:'elsewhere'},owner.chatId,'om_sent']])
    assert.equal(await restored.isSentMessage(identity,chat,id),false)
})

test('legacy lookback is readable, but never forwarded to the router or worker',async()=>{
  for (const decisionHistory of ['ordinary conversation outside the case','']) {
    const h=automatic({
      decide:b=>{assert.equal(b.workerContext,input.context);assert.equal(b.decisionHistory,undefined);return task},
      work:b=>{assert.equal(b.workerContext,input.context);assert.equal(b.decisionHistory,undefined);return result},
    })
    assert.equal((await run(h,{...input,decisionHistory})).status,'delivered')
    assert.ok(h.commits.filter(c=>['queued','deciding'].includes(c.jobs[0].status)).every(c=>c.jobs[0].decisionHistory===decisionHistory))
    assert.ok(h.commits.slice(2).every(c=>!Object.hasOwn(c.jobs[0],'decisionHistory')))
    assert.ok(!(await h.loop.snapshot()).some(r=>Object.hasOwn(r,'decisionHistory')))
  }
  const h=automatic()
  await assert.rejects(h.loop.enqueue({...input,decisionHistory:'x'.repeat(4097)}),{code:'invalid-input'})
})

test('an old queued lookback can reopen without feeding the router or retaining it after ignore',async()=>{
  const h=harness()
  await run(h,{...input,decisionHistory:'frozen at the original @'})
  const queued=h.commits[0]
  const resume=harness({decide:b=>{
    assert.equal(b.context,undefined);assert.equal(b.decisionHistory,undefined)
    return {action:'ignore'}
  }},queued)
  await resume.loop.drain()
  assert.deepEqual(resume.calls,[['decide',input.messageId]])
  assert.equal(resume.saved.jobs[0].status,'ignored')
  assert.equal(Object.hasOwn(resume.saved.jobs[0],'decisionHistory'),false)
})

test('only a real decision can dispatch work, and ignore is terminal without an acknowledgement post',async()=>{
  for(const [d,status] of [[{action:'ignore'},'ignored'],[{action:'send',role:'develop',criteria:'ok'},'stopped'],
    [{action:'work',role:'devloop',criteria:'ok'},'stopped'],[{...task,criteria:'x'.repeat(2049)},'stopped']]) {
    const h=automatic({decide:()=>d})
    const row=await run(h)
    assert.equal(row.status,status);assert.deepEqual(h.calls,[['decide','om_in']]);assert.equal(row.attempt,0)
    await h.loop.enqueue(input);await h.loop.drain();assert.equal(h.calls.length,1)
  }
})

test('a mere queued worker receipt, malformed result or oversized answer never delivers',async()=>{
  for(const [overrides,reason,attempt] of [
    [{work:()=>({accepted:true,sessionId:'worker'})},'no-final-answer',1],
    [{work:()=>({...result,workspaceId:'file:///private'})},'no-final-answer',1],
    [{work:()=>({...result,answer:'x'.repeat(16385)})},'no-final-answer',1],
  ]){
    const h=automatic(overrides);const row=await run(h)
    assert.equal(row.status,'stopped');assert.equal(row.attempt,attempt);assert.equal(row.reason,reason)
    assert.equal(row.answer,undefined);assert.equal(row.receipt,undefined);assert.ok(!h.calls.some(([k])=>k==='deliver'))
    assert.doesNotMatch(JSON.stringify(h.commits),/October|file:\/\/\/private/)
  }
})

test('writes original target once; mismatched receipts, timeout and unknown errors never trigger redelivery',async()=>{
  for(const [effect,state,reason] of [
    [()=>({}), 'uncertain','delivery-uncertain'],
    [b=>({...reply(b),chatId:'oc_other'}),'uncertain','delivery-uncertain'],
    [b=>({...reply(b),inReplyTo:'om_other'}),'uncertain','delivery-uncertain'],
    [b=>({...reply(b),messageId:b.messageId}),'uncertain','delivery-uncertain'],
    [b=>({...reply(b),messageId:b.source.threadId}),'uncertain','delivery-uncertain'],
    [()=>{throw Error('private vendor transport detail')},'uncertain','delivery-uncertain'],
    [()=>{throw {code:'delivery-denied'}},'stopped','delivery-denied'],
  ]){
    const h=automatic({deliver:effect}),row=await run(h)
    assert.equal(row.status,state);assert.equal(row.reason,reason);assert.equal(row.receipt,undefined)
    assert.doesNotMatch(JSON.stringify(h.saved),/private vendor/)
    const resumed=automatic({},h.saved)
    await resumed.loop.enqueue(input);await resumed.loop.drain();assert.equal(resumed.calls.length,0)
  }
})

async function until(check,what) {
  for(let n=0;n<1000;n++){if(await check())return;await new Promise(r=>setImmediate(r))}
  assert.fail('timed out waiting for '+what)
}

test('each lane stays serial while routing runs beside work; the store lock is never held over an actor call',async()=>{
  const gates={work:deferred(),decide:deferred()}, entered={work:deferred(),decide:deferred()}
  const busy={route:0,work:0}, peak={route:0,work:0}
  const enter=async(lane,fn)=>{
    busy[lane]++;peak[lane]=Math.max(peak[lane],busy[lane])
    try {return await fn()} finally {busy[lane]--}
  }
  const h=automatic({
    decide:b=>enter('route',async()=>{if(b.messageId==='om_next'){entered.decide.resolve();await gates.decide.promise};return task}),
    work:b=>enter('work',async()=>{if(b.messageId==='om_in'){entered.work.resolve();await gates.work.promise};return result}),
    deliver:b=>enter('work',async()=>reply(b)),
  })
  const events=await Promise.all(Array.from({length:12},()=>h.loop.enqueue(input)))
  assert.ok(events.every(e=>e.messageId===input.messageId))
  const running=h.loop.drain();await entered.work.promise
  // Messages of other cases, so neither is handed to the first one's worker.
  const another={...input,caseId:'case_2',messageId:'om_next',text:'Next request'}
  const mutable=clone(another),second=h.loop.enqueue(mutable);mutable.source.chatId='oc_redirected'
  await second
  // The route lane decides the new message while the work lane is still busy.
  await entered.decide.promise
  assert.deepEqual(busy,{route:1,work:1})
  await assert.rejects(h.loop.enqueue({...input,source:{...input.source,threadId:'om_redirect'}}),{code:'request-conflict'})
  await assert.rejects(h.loop.enqueue({...input,source:{...input.source,scopeId:'a'.repeat(64)}}),{code:'request-conflict'})
  await h.loop.enqueue({...input,caseId:'case_3',messageId:'om_third',text:'Third request'})
  // Both lanes are inside an actor call, yet the store still answers; the third message waits for the route lane.
  assert.deepEqual((await h.loop.snapshot()).map(r=>r.status),['working','deciding','queued'])
  gates.decide.resolve()
  await until(async()=>(await h.loop.snapshot())[2].status==='assigned','the third message to be routed')
  // Routed work waits for the busy work lane.
  assert.deepEqual((await h.loop.snapshot()).map(r=>r.status),['working','assigned','assigned'])
  gates.work.resolve();await Promise.all([running,h.loop.drain(),h.loop.drain()])
  assert.deepEqual(peak,{route:1,work:1})
  assert.deepEqual(h.calls,[['decide','om_in'],['work','om_in'],['decide','om_next'],['decide','om_third'],
    ['deliver','om_in'],['work','om_next'],['deliver','om_next'],['work','om_third'],['deliver','om_third']])
  assert.deepEqual((await h.loop.snapshot()).map(r=>[r.status,r.receipt.chatId]),Array(3).fill(['delivered','oc_group']))
})

test('restarts resume only proven safe queued stages and never replay actors in flight',async()=>{
  const h=automatic()
  await run(h)
  for(const state of h.commits) {
    const {status,attempt}=state.jobs[0],resumed=automatic({},state)
    // Loading a projected view cannot call an actor.
    await resumed.loop.snapshot();assert.equal(resumed.calls.length,0)
    await resumed.loop.drain()
    const [row]=await resumed.loop.snapshot()
    if(status==='queued'){assert.deepEqual(resumed.calls.map(c=>c[0]),['decide','work','deliver'])}
    else if(status==='assigned' && attempt===0){assert.deepEqual(resumed.calls.map(c=>c[0]),['work','deliver'])}
    else if(status==='approved'){assert.deepEqual(resumed.calls.map(c=>c[0]),['deliver']);assert.equal(row.status,'delivered')}
    else {
      assert.equal(resumed.calls.length,0)
      assert.equal(row.status,['working','delivering'].includes(status)?'uncertain':status==='delivered'?'delivered':'stopped')
    }
  }
})

test('legacy awaiting-review and reviewing jobs load as interrupted without replay or delivery',async()=>{
  const h=automatic();await run(h)
  for(const status of ['awaiting-review','reviewing']) {
    const saved=clone(h.commits.find(s=>s.jobs[0].status==='working'))
    Object.assign(saved.jobs[0],{status,sessionId:result.sessionId,workspaceId:result.workspaceId,resolvedPresetId:result.resolvedPresetId})
    const resumed=automatic({},saved), [row]=await resumed.loop.snapshot()
    assert.deepEqual([row.status,row.reason],['stopped','interrupted'])
    assert.equal(row.answer,undefined);assert.equal(row.receipt,undefined)
    assert.equal(resumed.saved.jobs[0].status,'stopped')
    await resumed.loop.enqueue(input);await resumed.loop.drain()
    assert.deepEqual(resumed.calls,[])
    const reopened=automatic({},resumed.saved);await reopened.loop.drain()
    assert.deepEqual(await reopened.loop.snapshot(),[row]);assert.deepEqual(reopened.calls,[])
  }
})

const retryCommand=({caseId,messageId})=>({caseId,messageId})

test('retry before a worker was assigned requeues the original intake; the decision survives restart',async()=>{
  const h=harness({decide:()=>{throw Error('offline')}})
  const job={...input,workerContext:'Full authorized thread',requesterId:'ou_sender'}
  const failed=await run(h,job)
  assert.deepEqual([failed.status,failed.reason],['stopped','decision-failed'])
  const keys=['text','context','workerContext','requesterId','team','roleModels']
  for(const key of keys) assert.deepEqual(h.saved.jobs[0][key],job[key])
  assert.equal(h.saved.jobs[0].workerProof,undefined)
  const reopened=harness({},h.saved)
  const {status,attempt}=await reopened.loop.retry(retryCommand(job),{...job,text:'fallback must not replace intake'})
  assert.deepEqual([status,attempt],['queued',0]);await reopened.loop.drain()
  const pending=reopened.commits[0], queued=pending.jobs[0]
  assert.equal(queued.status,'queued');assert.equal(queued.retries,1)
  for(const key of keys) assert.deepEqual(queued[key],job[key])
  for(const key of ['role','presetId','criteria','sessionId','workspaceId','resolvedPresetId','reason','answer']) assert.ok(!(key in queued))
  const again=harness({},pending);await again.loop.drain()
  assert.deepEqual(again.calls.map(([s])=>s),['decide','work'])
  assert.equal(again.saved.jobs[0].status,'awaiting-release')
})

test('a legacy failed job rebuilds only its missing intake; a stale lead assignment is not a worker',async()=>{
  const old={schema:1,jobs:[{...retryCommand(input),source:input.source,status:'stopped',reason:'interrupted',attempt:1,updatedAt:1,
    role:'lead',presetId:'old',criteria:'old criterion',sessionId:'old-session',workspaceId:'old-workspace',resolvedPresetId:'old'}]}
  const fallback={text:'Original message from case history',requesterId:'ou_original',team:{...input.team,lead:'current-lead'},
    roleModels:{lead:{provider:'fixture',model:'current'}}}
  const h=harness({},old)
  await assert.rejects(h.loop.retry(retryCommand(input)),{code:'retry-unavailable'})
  const row=await h.loop.retry(retryCommand(input),fallback);await h.loop.drain()
  assert.equal(row.status,'queued')
  const queued=h.commits[0].jobs[0]
  for(const [k,v] of Object.entries(fallback))assert.deepEqual(queued[k],v)
  for(const k of ['role','presetId','criteria','sessionId','workspaceId','resolvedPresetId','workerProof'])assert.ok(!(k in queued))
  assert.deepEqual(h.calls.map(([s])=>s),['decide','work'])
})

test('known worker revives from stopped or work-uncertain without rerouting; each manual retry increments once',async()=>{
  for(const code of ['WORK_UNCERTAIN','AUTOMATION_UNAVAILABLE']) {
    const failWork=()=>{throw Object.assign(Error(),{code})}, h=harness({work:failWork,decide:()=>({...task,criteria:'fixture criterion'})})
    const initial=await run(h);assert.equal(initial.role,'develop');assert.equal(initial.status,code==='WORK_UNCERTAIN'?'uncertain':'stopped')
    const again=harness({work:failWork},h.saved), cmd=retryCommand(initial)
    for(let n=1;n<=2;n++){
      const competing=await Promise.allSettled([again.loop.retry(cmd),again.loop.retry(cmd)])
      assert.deepEqual(competing.map(x=>x.status),['fulfilled','rejected'])
      assert.equal(competing[0].value.status,'assigned');assert.equal(competing[0].value.attempt,0)
      assert.equal(competing[1].reason.code,'retry-unavailable')
      await again.loop.drain();assert.equal(again.saved.jobs[0].retries,n)
    }
    const assigned=again.commits.find(s=>s.jobs[0].status==='assigned' && s.jobs[0].retries===2)
    assert.equal(assigned.jobs[0].criteria,'fixture criterion');assert.equal(assigned.jobs[0].presetId,input.team.develop)
    let request
    const recovered=harness({work:j=>{request=j;return result}},assigned)
    await recovered.loop.drain()
    assert.deepEqual(recovered.calls.map(([s])=>s),['work'])
    assert.equal(request.continueWork,true);assert.equal(request.role,'develop');assert.equal(request.attempt,1)
    assert.equal(request.retries,2);assert.equal(request.text,input.text)
    assert.equal(recovered.saved.jobs[0].status,'awaiting-release')
  }
})

test('the Router’s workspace choice reaches the worker and survives worker retries; a Router retry decides afresh',async()=>{
  const requests=[], placement=j=>({continueWork:j.continueWork,targetWorkspaceId:j.targetWorkspaceId,previousWorkspaceId:j.previousWorkspaceId})
  const uncertain=()=>{throw Object.assign(Error(),{code:'WORK_UNCERTAIN'})}
  const h=harness({decide:()=>({...task,workspaceId:'ws-project'}),work:j=>{requests.push(placement(j));return uncertain()}})
  const failed=await run(h)
  assert.deepEqual([failed.status,failed.targetWorkspaceId],['uncertain','ws-project'])
  assert.equal(h.commits.find(c=>c.jobs[0].status==='assigned').jobs[0].targetWorkspaceId,'ws-project')
  // A worker retry keeps the choice; once the worker has a session, it also names the session's workspace.
  const again=harness({work:j=>{requests.push(placement(j));return uncertain()}},h.saved)
  assert.equal((await again.loop.retry(retryCommand(input))).targetWorkspaceId,'ws-project');await again.loop.drain()
  const seated=clone(again.saved);Object.assign(seated.jobs[0],{sessionId:result.sessionId,workspaceId:'ws-project',resolvedPresetId:result.resolvedPresetId})
  const resumed=harness({work:j=>{requests.push(placement(j));return {...result,workspaceId:'ws-project'}}},seated)
  await resumed.loop.retry(retryCommand(input));await resumed.loop.drain()
  assert.deepEqual(requests,[{targetWorkspaceId:'ws-project'},{continueWork:true,targetWorkspaceId:'ws-project'},
    {continueWork:true,targetWorkspaceId:'ws-project',previousWorkspaceId:'ws-project'}].map(r=>({continueWork:undefined,previousWorkspaceId:undefined,...r})))
  const [row]=await resumed.loop.snapshot()
  assert.deepEqual([row.status,row.workspaceId,row.targetWorkspaceId],['awaiting-release','ws-project','ws-project'])
  // A Router retry starts over: an invalid choice stops the decision, and the next decision's choice stands alone.
  const routed=harness({decide:()=>({...task,workspaceId:'not a workspace id'})})
  const stopped=await run(routed)
  assert.deepEqual([stopped.status,stopped.reason,'targetWorkspaceId' in stopped],['stopped','invalid-decision',false])
  const rerouted=harness({decide:()=>({...task,workspaceId:'ws-other'}),work:j=>{requests.push(placement(j));return result}},routed.saved)
  const queued=await rerouted.loop.retry(retryCommand(input),input)
  assert.deepEqual([queued.status,'targetWorkspaceId' in queued],['queued',false]);await rerouted.loop.drain()
  assert.equal(rerouted.saved.jobs[0].targetWorkspaceId,'ws-other');assert.equal(requests.at(-1).targetWorkspaceId,'ws-other')
  const plain=harness();await run(plain)
  assert.ok(plain.commits.every(c=>!('targetWorkspaceId' in c.jobs[0])))
  // Only a worker assignment carries a choice.
  const queuedWithChoice=clone(routed.commits[0]);queuedWithChoice.jobs[0].targetWorkspaceId='ws-other'
  await assert.rejects(harness({},queuedWithChoice).loop.drain(),{code:'storage-unavailable'})
})

test('retry cannot revive ignored, declined, delivered, ambiguous delivery or ongoing jobs',async()=>{
  const normal=automatic();await run(normal)
  const ignored=harness({decide:()=>({action:'ignore'})});await run(ignored)
  const unknown=automatic({deliver:()=>null});await run(unknown)
  const declined=harness(), pending=await run(declined)
  const awaiting=declined.saved
  await declined.loop.release(releaseCommand(pending,'decline'),allow)
  for(const initial of [ignored.saved,normal.saved,unknown.saved,declined.saved,awaiting,
    ...normal.commits.filter(s=>['queued','assigned','approved'].includes(s.jobs[0].status))]){
    const h=harness({},initial), before=await h.loop.snapshot()
    await assert.rejects(h.loop.retry(retryCommand(input),input),{code:'retry-unavailable'})
    assert.deepEqual(await h.loop.snapshot(),before);assert.deepEqual(h.calls,[]);assert.deepEqual(h.commits,[])
  }
  const go=deferred(),started=deferred(), busy=harness({work:async()=>{started.resolve();await go.promise;return result}})
  await busy.loop.enqueue(input);await started.promise
  try {
    assert.equal((await busy.loop.snapshot())[0].status,'working')
    await assert.rejects(busy.loop.retry(retryCommand(input)),{code:'retry-unavailable'})
  } finally {go.resolve();await busy.loop.drain()}
  assert.deepEqual(busy.calls.map(([s])=>s),['decide','work'])
})

const take=(loop,job=input)=>loop.takeOver(retryCommand(job),result.sessionId,result.workspaceId)

test('owner can take an assigned, completed-but-unsent or retryable worker; the sanitized handoff remains terminal on reload',async()=>{
  const h=harness({work:()=>({...result,workerProof:'f'.repeat(64)})}), pending=await run(h,{...input,requesterId:'ou_requester',workerContext:'Thread context'})
  await h.loop.release(releaseCommand(pending),allow);await h.loop.drain()
  const staleWork=h.commits.find(s=>s.jobs[0].status==='working')
  const rejected=harness({work:()=>{throw {code:'AUTOMATION_UNAVAILABLE'}}});await run(rejected)
  for(const saved of [...h.commits.filter(s=>['assigned','approved','awaiting-release','released'].includes(s.jobs[0].status)),staleWork,rejected.saved]){
    const m=harness({},saved), [before]=await m.loop.snapshot()
    if(before.sessionId){
      await assert.rejects(m.loop.takeOver(retryCommand(input),'other',result.workspaceId),{code:'takeover-unavailable'})
      await assert.rejects(m.loop.takeOver(retryCommand(input),result.sessionId,'other'),{code:'takeover-unavailable'})
    }
    const row=await take(m.loop)
    assert.deepEqual([row.status,row.sessionId,row.workspaceId],['taken-over',result.sessionId,result.workspaceId])
    for(const field of ['answer','outputKind','receipt','reason','workerProof','releaseNonce','releaseProof','text',
      'context','team','roleModels','requesterId','workerContext','turns'])assert.ok(!(field in m.saved.jobs[0]),field)
    const reboot=harness({},m.saved)
    await reboot.loop.drain();assert.deepEqual(await reboot.loop.snapshot(),[row])
    assert.deepEqual(await reboot.loop.takenOverSessions(),[result.sessionId])
    await assert.rejects(reboot.loop.retry(retryCommand(input),input),{code:'retry-unavailable'})
    await assert.rejects(take(reboot.loop),{code:'takeover-unavailable'})
    await assert.rejects(reboot.loop.release(releaseCommand(pending),allow),{code:'release-stale'})
    assert.deepEqual(reboot.calls,[])
  }
  const handed=harness({},rejected.saved);await take(handed.loop)
  for(const patch of [{role:'lead'},{sessionId:undefined,workspaceId:undefined},{workspaceId:''}]){
    const invalid=clone(handed.saved);Object.assign(invalid.jobs[0],patch)
    await assert.rejects(harness({},invalid).loop.takenOverSessions(),{code:'storage-unavailable'})
  }
})

test('working takeover aborts just this worker and ignores even a successful late result',async()=>{
  const entered=deferred(),finish=deferred();let workerSignal,otherSignal
  const h=harness({work:async j=>{
    if(j.messageId===input.messageId){workerSignal=j.signal;entered.resolve();await finish.promise}
    else otherSignal=j.signal
    return result
  }})
  await h.loop.enqueue(input);await entered.promise
  const other={...input,caseId:'case_2',messageId:'om_other'}
  await h.loop.enqueue(other)
  const row=await take(h.loop)
  assert.equal(row.status,'taken-over');assert.equal(workerSignal.aborted,true)
  finish.resolve();await h.loop.drain()
  assert.deepEqual((await h.loop.snapshot()).map(j=>[j.messageId,j.status]),[[input.messageId,'taken-over'],[other.messageId,'awaiting-release']])
  assert.equal(otherSignal.aborted,false)
  assert.deepEqual(h.calls,[['decide',input.messageId],['work',input.messageId],['decide',other.messageId],['work',other.messageId]])
})

test('cannot take an unassigned, ignored, declined, delivering, delivered or ambiguous-delivery job',async()=>{
  const h=automatic();await run(h)
  const ignored=harness({decide:()=>({action:'ignore'})});await run(ignored)
  const declined=harness(), pending=await run(declined);await declined.loop.release(releaseCommand(pending,'decline'),allow)
  const failedRouter=harness({decide:()=>{throw Error()}});await run(failedRouter)
  const unavailable={code:'takeover-unavailable'}
  const legacyLead=clone(failedRouter.saved);Object.assign(legacyLead.jobs[0],{role:'lead',presetId:'lead'})
  for(const saved of [h.commits[0],ignored.saved,declined.saved,failedRouter.saved,legacyLead,h.saved,
    h.commits.find(s=>s.jobs[0].status==='delivering')]){
    const m=harness({},saved),original=await m.loop.snapshot()
    await assert.rejects(take(m.loop),unavailable)
    assert.deepEqual(await m.loop.snapshot(),original);assert.deepEqual(m.calls,[])
  }
  const entered=deferred(),finish=deferred(),inFlight=automatic({deliver:async b=>{entered.resolve();await finish.promise;return reply(b)}})
  await inFlight.loop.enqueue(input);await entered.promise
  try {
    assert.equal((await inFlight.loop.snapshot())[0].status,'delivering')
    await assert.rejects(take(inFlight.loop),unavailable)
  } finally {finish.resolve();await inFlight.loop.drain()}
  assert.equal(inFlight.saved.jobs[0].status,'delivered')
})

test('storage write failure fails closed whether it hit disk or not; no external call precedes a committed intent',async()=>{
  for(const phase of ['working','delivering','delivered'])for(const landed of [false,true]){
    let disk
    const h=automatic({load:()=>disk,save:next=>{
      if(next.jobs[0].status===phase){if(landed)disk=clone(next);throw Error('secret storage diagnostic')}
      disk=clone(next)
    }})
    await h.loop.enqueue(input)
    await assert.rejects(h.loop.drain(),{code:'storage-unavailable'})
    await assert.rejects(h.loop.snapshot(),{message:'storage-unavailable'})
    if(phase==='working')assert.ok(!h.calls.some(([k])=>k==='work'))
    if(phase==='delivering')assert.ok(!h.calls.some(([k])=>k==='deliver'))
    const resumed=automatic({},disk);await resumed.loop.drain()
    const sendCount=[...h.calls,...resumed.calls].filter(([k])=>k==='deliver').length
    assert.ok(sendCount<=1)
    assert.ok([...h.calls,...resumed.calls].filter(([k])=>k==='work').length<=1)
  }
})

test('invalid inputs and malformed stored records fail closed; no other store, session or source is scanned',async()=>{
  const h=automatic()
  for(const bad of [{source:{...input.source,scopeId:''}},{messageId:'https://example.invalid'},
    {source:{...input.source,kind:'local'}},{text:''},{context:'x'.repeat(4097)},{roleModels:{develop:{token:'secret'}}}])
    await assert.rejects(h.loop.enqueue({...input,...bad}),{code:'invalid-input'})
  assert.equal(h.commits.length,0);await h.loop.drain();assert.equal(h.calls.length,0)
  const normal=automatic();await run(normal)
  const approved=normal.commits.find(c=>c.jobs[0].status==='approved')
  for(const invalid of [{schema:2,jobs:[]},{schema:1,jobs:[{}]},
    {schema:1,jobs:[...approved.jobs,...approved.jobs]},{schema:1,jobs:[{...approved.jobs[0],answer:''}]},
    {schema:1,jobs:[{...approved.jobs[0],source:{...input.source,token:'secret'}}]}]){
    const broken=automatic({},invalid)
    await assert.rejects(broken.loop.drain(),{code:'storage-unavailable'});assert.equal(broken.calls.length,0)
  }
})

test('changed authorization is checked at each stage by the caller and prevents further actions',async()=>{
  for(const stage of ['decide','work']){
    const h=automatic({[stage]:()=>{throw Object.assign(Error('secret tenant data'),{code:'scope-changed'})}})
    const row=await run(h)
    assert.deepEqual([row.status,row.reason],['stopped','access-denied']);assert.equal(h.calls.at(-1)[0],stage)
    assert.equal(row.answer,undefined);assert.doesNotMatch(JSON.stringify(h.commits),/secret tenant data/)
  }
})

test('only known worker rejection is a definite failure; unknown worker state must not be dispatched again',async()=>{
  for(const [code,status,reason] of [['AUTOMATION_UNAVAILABLE','stopped','work-failed'],['WORK_UNCERTAIN','uncertain','work-uncertain'],
    ['PRIVATE_DIAGNOSTIC','uncertain','work-uncertain']]){
    const h=automatic({work:()=>{throw {code}}}),row=await run(h)
    assert.deepEqual([row.status,row.reason],[status,reason])
    const resumed=automatic({},h.saved);await resumed.loop.enqueue(input);await resumed.loop.drain()
    assert.equal(resumed.calls.length,0);assert.doesNotMatch(JSON.stringify(h.saved),/PRIVATE_DIAGNOSTIC/)
  }
})

test('dispose aborts the in-flight actor and prevents new accepts and further work',async()=>{
  const started=deferred(),h=automatic({work:b=>new Promise((_,reject)=>{
    started.resolve();b.signal.addEventListener('abort',()=>reject(Error('private cancellation')),{once:true})
  })})
  await h.loop.enqueue(input);await started.promise
  const quit=h.loop.dispose()
  await assert.rejects(h.loop.enqueue({...input,messageId:'om_after'}),{code:'loop-disposed'})
  await quit;await h.loop.drain()
  const [row]=await h.loop.snapshot();assert.equal(row.status,'uncertain');assert.equal(row.reason,'work-uncertain')
  assert.deepEqual(h.calls.map(([k])=>k),['decide','work'])
})

const releaseCommand=(row,action='send')=>({caseId:row.caseId,messageId:row.messageId,token:row.releaseToken,action})
const allow=async(source,signal)=>{assert.deepEqual(source,input.source);signal.throwIfAborted()}

test('default manual gate publishes only the worker answer and a target-bound token, independent of subsequent policy changes',async()=>{
  const h=harness(), pending=await run(h)
  assert.deepEqual(h.calls.map(([k])=>k),['decide','work'])
  assert.equal(pending.status,'awaiting-release');assert.equal(pending.answer,result.answer)
  assert.match(pending.releaseToken,/^[a-f0-9]{64}$/)
  assert.equal(pending.releaseNonce,undefined);assert.equal(pending.source,undefined)
  const resumed=automatic({},h.saved)
  await resumed.loop.drain()
  assert.deepEqual(await resumed.loop.snapshot(),[pending])
  const row=await resumed.loop.release(releaseCommand(pending),allow)
  assert.equal(row.status,'approved');assert.equal(row.releaseToken,undefined);assert.equal(row.receipt,undefined)
  await resumed.loop.drain()
  const [done]=await resumed.loop.snapshot()
  assert.deepEqual(done.receipt,reply(input));assert.equal(done.status,'delivered')
  assert.deepEqual(resumed.calls,[['deliver',input.messageId]])
  assert.equal(done.releaseToken,undefined)
  await assert.rejects(resumed.loop.release(releaseCommand(pending),allow),{code:'release-stale'})
  const reboot=harness({},resumed.saved);await reboot.loop.drain()
  assert.deepEqual(reboot.calls,[])
})

test('decline persists as a terminal non-send with the worker answer and no reusable token',async()=>{
  let required=true
  const h=harness({isReleaseRequired:async()=>required})
  const pending=await run(h)
  required=false;await h.loop.drain()
  const row=await h.loop.release(releaseCommand(pending,'decline'),allow)
  assert.equal(row.status,'declined');assert.equal(row.answer,result.answer)
  assert.equal(row.releaseToken,undefined);assert.equal(row.receipt,undefined)
  assert.equal(h.saved.jobs[0].releaseNonce,undefined);assert.equal(h.saved.jobs[0].text,undefined)
  const reboot=automatic({},h.saved)
  assert.deepEqual(await run(reboot),row)
  await assert.rejects(reboot.loop.release(releaseCommand(pending),allow),{code:'release-stale'})
  assert.equal(reboot.calls.length,0)
})

test('old approved rows and persisted queued jobs obey the policy at the actual delivery boundary; unreadable policy asks',async()=>{
  const baseline=automatic();await run(baseline)
  for(const status of ['queued','approved']) {
    const old=baseline.commits.find(c=>c.jobs[0].status===status)
    for(const required of [undefined,async()=>undefined,async()=>{throw Error('private policy error')}]) {
      const h=harness({isReleaseRequired:required},old);await h.loop.drain()
      const [row]=await h.loop.snapshot()
      assert.equal(row.status,'awaiting-release')
      assert.equal(row.answer,result.answer);assert.equal(row.receipt,undefined)
      assert.equal(h.calls.some(([k])=>k==='deliver'),false)
    }
  }
})

test('release rejects altered command, stale digest, redirected source or revoked authorization without effects',async()=>{
  const h=harness(), pending=await run(h), cmd=releaseCommand(pending), deny=()=>{throw Object.assign(Error(),{code:'scope-changed'})}
  for(const extra of [{answer:'replacement'},{text:result.answer},{source:input.source},{action:'approve'},{token:'x'}]) {
    await assert.rejects(h.loop.release({...cmd,...extra},()=>assert.fail()),{code:'invalid-input'})
  }
  for(const extra of [{messageId:'om_different'},{caseId:'case_other'},{token:'a'.repeat(64)}]) {
    await assert.rejects(h.loop.release({...cmd,...extra},()=>assert.fail()),{code:'release-stale'})
  }
  await assert.rejects(h.loop.release(cmd),{code:'admission-denied'})
  await assert.rejects(h.loop.release(cmd,deny),{code:'scope-changed'})
  assert.deepEqual((await h.loop.snapshot())[0],pending)
  for(const altered of [{answer:'Other final answer'},{text:'Other original intake'},
    {source:{...input.source,chatId:'oc_else'}},{source:{...input.source,scopeId:'0'.repeat(64)}}]) {
    const persisted=clone(h.saved);Object.assign(persisted.jobs[0],altered)
    const reboot=harness({},persisted)
    assert.notEqual((await reboot.loop.snapshot())[0].releaseToken,cmd.token)
    await assert.rejects(reboot.loop.release(cmd,()=>assert.fail()),{code:'release-stale'})
    assert.equal(reboot.calls.length,0)
  }
})

test('validation runs outside the job lock and races compare-and-swap the original token only once',async()=>{
  const entered=deferred(), go=deferred(), h=harness(), pending=await run(h)
  const send=h.loop.release(releaseCommand(pending),async()=>{
    assert.equal((await h.loop.snapshot())[0].status,'awaiting-release')
    entered.resolve();await go.promise
  })
  await entered.promise
  assert.equal((await h.loop.release(releaseCommand(pending,'decline'),allow)).status,'declined')
  go.resolve();await assert.rejects(send,{code:'release-stale'})
  await h.loop.drain()
  assert.deepEqual(h.calls.map(([k])=>k),['decide','work'])
})

test('release resumes only proven unsent intents; a tampered released job cannot post, and in-flight posts do not repeat',async()=>{
  const h=harness(), pending=await run(h)
  await h.loop.release(releaseCommand(pending),allow);await h.loop.drain()
  for(const stage of ['released','delivering','delivered']) {
    const saved=h.commits.find(c=>c.jobs[0].status===stage)
    const reboot=harness({},saved);await reboot.loop.drain()
    assert.equal(reboot.calls.filter(([k])=>k==='deliver').length,stage==='released'?1:0)
    const [row]=await reboot.loop.snapshot()
    assert.equal(row.status,stage==='delivering'?'uncertain':'delivered')
    assert.equal(row.releaseToken,undefined)
    if (stage==='released') {
      const bad=clone(saved);bad.jobs[0].answer='not what the owner confirmed'
      const invalid=harness({},bad)
      await assert.rejects(invalid.loop.drain(),{code:'storage-unavailable'})
      assert.deepEqual(invalid.calls,[])
    }
  }
})

test('duplicate human sends race to one persisted intent and a single post',async()=>{
  const h=harness(), pending=await run(h), cmd=releaseCommand(pending)
  const attempts=await Promise.allSettled(Array.from({length:6},()=>h.loop.release(cmd,allow)))
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1)
  assert.ok(attempts.filter(a=>a.status==='rejected').every(a=>a.reason.code==='release-stale'))
  await h.loop.drain()
  assert.equal(h.calls.filter(([k])=>k==='deliver').length,1)
})

test('an unconfirmed manual intent write never posts in the failed process; recovery uses only the persisted outcome',async()=>{
  const initial=harness(), pending=await run(initial), cmd=releaseCommand(pending)
  for (const landed of [false,true]) {
    let disk=clone(initial.saved)
    const h=harness({load:()=>clone(disk),save:async next=>{
      assert.equal(next.jobs[0].status,'released')
      if (landed) disk=clone(next)
      throw Error('uncertain write')
    }})
    await assert.rejects(h.loop.release(cmd,allow),{code:'storage-unavailable'})
    assert.equal(h.calls.length,0)
    const reboot=harness({},disk);await reboot.loop.drain()
    const [row]=await reboot.loop.snapshot()
    assert.equal(row.status,landed?'delivered':'awaiting-release')
    assert.equal(reboot.calls.length,landed?1:0)
  }
})

// A later direct message in the same conversation, which the Router may merge into earlier open work.
const requesterId='ou_requester'
const seat={sessionId:result.sessionId,workspaceId:result.workspaceId,resolvedPresetId:result.resolvedPresetId}
const first={...input,requesterId,workerContext:'Thread before the follow-up'}
const later=(messageId,text,extra={})=>({...first,messageId,text,workerContext:'Thread up to '+messageId,...extra})
const followUp=later('om_b','Also cover the empty case.')
const other={...input,caseId:'case_other',messageId:'om_other',source:{...input.source,chatId:'oc_other'}}
// The case record of each job: its original message, sender and the current team settings.
const cases=({archived=[],missing=[],info={}}={})=>async(caseId,messageId)=>missing.includes(messageId) ? undefined :
  {archived:archived.includes(messageId),text:'Case text of '+messageId,requesterId,team:input.team,roleModels:input.roleModels,...info[messageId]}
const routedAs=b=>({messageId:b.messageId,...b.retries !== undefined && {retries:b.retries},...'openWork' in b && {openWork:clone(b.openWork)}})
// Also whether the message's case may start new work; absent means it may.
const routedFull=b=>({...routedAs(b),...'routable' in b && {routable:b.routable}})
const mergeFollowUps=(routed,target='w1',ids=[followUp.messageId])=>b=>{
  routed.push(routedAs(b));return ids.includes(b.messageId) ? {action:'merge',target} : task
}
const byId=async(h,id)=>(await h.loop.snapshot()).find(r=>r.messageId===id)
const stored=(doc,id)=>doc.jobs.find(j=>j.messageId===id)
const atMerge=(h,id=followUp.messageId)=>h.commits.find(c=>stored(c,id)?.status==='merged')
const clarification=later('om_answer','@owner October.')

test('a follow-up merges into work not yet started; the worker takes each merged message in and posts anew',async()=>{
  const gate=deferred(), busy=deferred(), routed=[], worked=[], keys=[]
  const peer=later('om_c','Please use TypeScript.',{requesterId:'ou_peer'})
  const h=automatic({caseInfo:cases(),decide:mergeFollowUps(routed,'w1',[followUp.messageId,peer.messageId]),
    work:async b=>{worked.push(b);if(b.messageId===other.messageId){busy.resolve();await gate.promise};return result},
    deliver:b=>{keys.push(b.idempotencyKey);return reply(b)}})
  await h.loop.enqueue(other);await busy.promise
  for(const job of [first,followUp,peer]) await h.loop.enqueue(job)
  await until(async()=>(await byId(h,peer.messageId))?.status==='merged','both follow-ups to merge')
  const target=await byId(h,first.messageId)
  assert.deepEqual([target.status,target.attempt],['assigned',0])
  assert.deepEqual(target.supplements,[{messageId:followUp.messageId,text:followUp.text,senderId:requesterId},
    {messageId:peer.messageId,text:peer.text,senderId:'ou_peer'}])
  assert.equal(stored(h.saved,first.messageId).supplementId,peer.messageId)
  for(const job of [followUp,peer]) {
    const row=await byId(h,job.messageId)
    assert.deepEqual([row.status,row.mergedInto,row.role,row.supplements],['merged',{caseId:first.caseId,messageId:first.messageId},undefined,undefined])
    const saved=stored(h.saved,job.messageId)
    for(const k of ['text','context','team','roleModels','requesterId','workerContext','supplements','supplementId'])assert.ok(!(k in saved),k)
  }
  // Only open work of the same case is offered, and without internal keys.
  const offered=[{ref:'w1',request:first.text,state:'not started'}]
  assert.deepEqual(routed,[{messageId:other.messageId},{messageId:first.messageId},
    {messageId:followUp.messageId,openWork:offered},{messageId:peer.messageId,openWork:offered}])
  gate.resolve();await h.loop.drain()
  assert.deepEqual(worked.map(w=>w.messageId),[other.messageId,first.messageId])
  const rerun=worked[1]
  assert.deepEqual([rerun.continueWork,rerun.previousWorkspaceId,rerun.attempt,rerun.requesterId,rerun.workerContext],
    [true,undefined,1,requesterId,peer.workerContext])
  assert.deepEqual(rerun.supplements,[{text:followUp.text,from:'requester'},{text:peer.text,from:'participant'}])
  const done=await byId(h,first.messageId)
  assert.deepEqual([done.status,done.answer,done.supplements],['delivered',result.answer,undefined])
  assert.deepEqual(h.calls.filter(c=>c[1]!==other.messageId),[['decide',first.messageId],['decide',followUp.messageId],
    ['decide',peer.messageId],['work',first.messageId],['deliver',first.messageId]])
  for(const job of [followUp,peer]) assert.equal((await byId(h,job.messageId)).status,'merged')
  // A reply after merged messages is a new post, not a replay of the plain reply.
  const plain=automatic({deliver:b=>{keys.push(b.idempotencyKey);return reply(b)}});await run(plain,first)
  assert.equal(keys.length,3);assert.notEqual(keys[1],keys[2])
})

test('a follow-up interrupts its running worker; neither a late result nor a late failure overwrites the rerun',async()=>{
  for(const late of ['result','failure']) {
    const started=deferred(), finish=deferred(), worked=[], routed=[]
    const h=harness({caseInfo:cases(),decide:mergeFollowUps(routed),work:async b=>{
      worked.push(b)
      if(worked.length>1) return {...result,answer:'Answer with the follow-up'}
      started.resolve()
      await new Promise((resolve,reject)=>{
        finish.promise.then(resolve)
        if(late==='failure') b.signal.addEventListener('abort',()=>reject(Object.assign(Error(),{code:'WORK_UNCERTAIN'})),{once:true})
      })
      return {...result,answer:'Stale answer'}
    }})
    await h.loop.enqueue(first);await started.promise
    await h.loop.enqueue(followUp)
    await until(()=>worked[0].signal.aborted,'the running worker to be interrupted')
    assert.deepEqual(routed.at(-1),{messageId:followUp.messageId,openWork:[{ref:'w1',request:first.text,state:'in progress'}]})
    const reopened=stored(atMerge(h),first.messageId)
    assert.deepEqual([reopened.status,reopened.attempt,reopened.supplementId],['assigned',0,followUp.messageId],late)
    finish.resolve();await h.loop.drain()
    const row=await byId(h,first.messageId)
    assert.deepEqual([row.status,row.answer,row.attempt],['awaiting-release','Answer with the follow-up',1],late)
    assert.equal(worked.length,2);assert.equal(worked[1].continueWork,true)
    assert.deepEqual(worked[1].supplements,[{text:followUp.text,from:'requester'}])
    assert.equal(worked[1].signal.aborted,false)
    assert.doesNotMatch(JSON.stringify(h.commits),/Stale answer/)
    assert.ok(!h.commits.some(c=>['uncertain','stopped'].includes(stored(c,first.messageId)?.status)),late)
  }
})

test('a follow-up discards an unsent draft: the old release token is stale and the worker drafts again in its session',async()=>{
  const routed=[], worked=[]
  const h=harness({caseInfo:cases(),decide:mergeFollowUps(routed,'w1',[followUp.messageId,'om_c']),
    work:b=>{worked.push(b);return worked.length===1 ? result : {...result,answer:'November'}}})
  const pending=await run(h,first)
  assert.equal(pending.status,'awaiting-release')
  await h.loop.enqueue(followUp);await h.loop.drain()
  assert.deepEqual(routed.at(-1).openWork,[{ref:'w1',request:first.text,state:'reply drafted',output:result.answer}])
  const reopened=stored(atMerge(h),first.messageId)
  assert.equal(reopened.status,'assigned')
  for(const k of ['answer','outputKind','releaseNonce','releaseProof','receipt','workerProof','reason'])assert.ok(!(k in reopened),k)
  assert.deepEqual([reopened.sessionId,reopened.workspaceId,reopened.text],[result.sessionId,result.workspaceId,first.text])
  assert.deepEqual([worked[1].continueWork,worked[1].previousWorkspaceId,worked[1].supplements],
    [true,result.workspaceId,[{text:followUp.text,from:'requester'}]])
  const row=await byId(h,first.messageId)
  assert.deepEqual([row.status,row.answer,row.supplements],['awaiting-release','November',undefined])
  assert.ok(!('supplements' in stored(h.saved,first.messageId)),'the run took the merged message in')
  assert.notEqual(row.releaseToken,pending.releaseToken)
  await assert.rejects(h.loop.release(releaseCommand(pending),allow),{code:'release-stale'})
  assert.ok(!h.calls.some(([k])=>k==='deliver'))
  // A further follow-up brings only itself; the merged message already taken in is not repeated.
  const third=later('om_c','And mention the units.')
  await h.loop.enqueue(third);await h.loop.drain()
  assert.deepEqual(routed.at(-1).openWork,[{ref:'w1',request:first.text,state:'reply drafted',output:'November'}])
  assert.deepEqual(worked.map(w=>w.supplements),[undefined,[{text:followUp.text,from:'requester'}],[{text:third.text,from:'requester'}]])
  // A draft not yet put to the owner is discarded the same way while the work lane is busy elsewhere.
  const drafted=stored(h.commits.find(c=>stored(c,first.messageId)?.status==='approved'),first.messageId)
  const elsewhere=harness();await run(elsewhere,other)
  const gate=deferred(), busy=deferred(), routed2=[]
  const h2=harness({caseInfo:cases(),decide:mergeFollowUps(routed2),
    work:async b=>{if(b.messageId===other.messageId){busy.resolve();await gate.promise};return {...result,answer:'November'}}},
    {schema:1,jobs:[stored(elsewhere.commits.find(c=>c.jobs[0].status==='assigned'),other.messageId),drafted]})
  await h2.loop.enqueue(followUp);await busy.promise
  await until(async()=>(await byId(h2,followUp.messageId)).status==='merged','the follow-up to merge')
  assert.deepEqual(routed2.at(-1).openWork,[{ref:'w1',request:first.text,state:'reply drafted',output:result.answer}])
  assert.ok(!('answer' in stored(h2.saved,first.messageId)))
  gate.resolve();await h2.loop.drain()
  assert.deepEqual((await byId(h2,first.messageId)).answer,'November')
})

test('a merged @ withdraws the outstanding question and resumes the worker once, even on replay',async()=>{
  let n=0
  const routed=[], worked=[], keys=[], go=deferred()
  const h=automatic({caseInfo:cases(),decide:mergeFollowUps(routed),
    work:async b=>{
      worked.push(b)
      if(worked.length===1) return {...seat,question:'Which month?'}
      await go.promise;return {...result,answer:'The fiscal October report'}
    },
    deliver:b=>{keys.push(b.idempotencyKey);return {...reply(b),messageId:'om_sent'+(++n)}}})
  const waiting=await run(h,first)
  assert.equal(waiting.status,'waiting-requester')
  assert.equal(await h.loop.isSentMessage(first.source,first.source.chatId,waiting.receipt.messageId),true)
  await h.loop.enqueue(followUp)
  await until(()=>worked.length===2,'the worker to rerun with the follow-up')
  assert.deepEqual(routed.at(-1).openWork,[{ref:'w1',request:first.text,state:'waiting for the requester',output:'Which month?'}])
  const reopened=stored(atMerge(h),first.messageId)
  assert.equal(reopened.status,'assigned')
  for(const k of ['turns','receipt','answer','outputKind'])assert.ok(!(k in reopened),k)
  assert.deepEqual((await byId(h,followUp.messageId)).mergedInto,{caseId:first.caseId,messageId:first.messageId})
  await h.loop.enqueue(followUp)
  go.resolve();await h.loop.drain()
  const second=worked[1]
  assert.deepEqual([second.continueWork,second.previousWorkspaceId,second.supplements],[true,result.workspaceId,[{text:followUp.text,from:'requester'}]])
  for(const k of ['previousSessionId','previousQuestion','requesterReply'])assert.ok(!(k in second),k)
  const row=await byId(h,first.messageId)
  assert.deepEqual([row.status,row.answer,row.receipt.messageId],['delivered','The fiscal October report','om_sent2'])
  assert.equal(worked.length,2);assert.equal(new Set(keys).size,2)
})

test('a legacy requester reply not yet taken in rides along ahead of a merged @',async()=>{
  const old=automatic({work:()=>({...seat,question:'Which month?'})})
  const waiting=await run(old,first)
  assert.equal(waiting.status,'waiting-requester')
  await old.loop.dispose()
  // A pre-mention-flow build committed the reply but had not started the worker.
  const saved=clone(old.saved),j=saved.jobs[0]
  Object.assign(j,{status:'assigned',attempt:0,turns:[{questionId:j.receipt.messageId,replyId:'om_legacy_answer',question:j.answer,reply:'October.'}]})
  delete j.receipt;delete j.answer;delete j.outputKind

  const worked=[], busy=deferred()
  const h=automatic({caseInfo:cases(),decide:mergeFollowUps([]),work:async b=>{
    worked.push(b)
    if (!b.continueWork) {
      busy.resolve()
      await new Promise((_,reject)=>b.signal.addEventListener('abort',()=>reject(Error('interrupted')),{once:true}))
    }
    return {...result,answer:'The October report'}
  },deliver:b=>({...reply(b),messageId:'om_final'})},saved)
  void h.loop.drain();await busy.promise
  assert.deepEqual([worked[0].previousQuestion,worked[0].requesterReply],['Which month?','October.'])
  await h.loop.enqueue(followUp);await h.loop.drain()
  assert.equal(worked.length,2)
  assert.deepEqual(worked[1].supplements,[{text:'October.',from:'requester'},{text:followUp.text,from:'requester'}])
  for(const k of ['previousQuestion','requesterReply'])assert.ok(!(k in worked[1]),k)
  assert.equal((await byId(h,first.messageId)).answer,'The October report')
})

test('a same-thread @ reopens a posted reply, even after a merged clarification, and posts a new reply',async()=>{
  for(const clarified of [false,true]) {
    let n=0
    const routed=[], worked=[], keys=[]
    const h=automatic({caseInfo:cases(),decide:mergeFollowUps(routed,'w1',[clarification.messageId,followUp.messageId]),
      work:b=>{worked.push(b);return clarified && worked.length===1 ? {...seat,question:'Which month?'} : {...result,answer:'Answer '+worked.length}},
      deliver:b=>{keys.push(b.idempotencyKey);return {...reply(b),messageId:'om_sent'+(++n)}}})
    const initial=await run(h,first)
    if(clarified) {
      assert.equal(initial.status,'waiting-requester')
      await h.loop.enqueue(clarification);await h.loop.drain()
      assert.equal((await byId(h,clarification.messageId)).status,'merged')
      assert.deepEqual(worked[1].supplements,[{text:clarification.text,from:'requester'}])
    }
    const posted=await byId(h,first.messageId)
    assert.equal(posted.status,'delivered')
    await h.loop.enqueue(followUp);await h.loop.drain()
    // A posted reply kept no intake: the case record stands in for the request.
    assert.deepEqual(routed.filter(r=>r.messageId===followUp.messageId),
      [{messageId:followUp.messageId,openWork:[{ref:'w1',request:'Case text of '+first.messageId,state:'replied',output:posted.answer}]}])
    const reopened=stored(atMerge(h),first.messageId)
    assert.deepEqual([reopened.status,reopened.text,reopened.requesterId,reopened.receipt,reopened.answer],
      ['assigned','Case text of '+first.messageId,requesterId,undefined,undefined])
    assert.deepEqual(reopened.team,input.team)
    assert.equal(reopened.turns,undefined)
    const last=worked.at(-1)
    assert.deepEqual([last.continueWork,last.previousWorkspaceId,last.text,last.supplements],
      [true,result.workspaceId,'Case text of '+first.messageId,[{text:followUp.text,from:'requester'}]])
    assert.ok(!('requesterReply' in last))
    const row=await byId(h,first.messageId)
    assert.deepEqual([row.status,row.sessionId,row.answer,row.receipt.messageId],['delivered',result.sessionId,'Answer '+worked.length,'om_sent'+n])
    assert.equal((await byId(h,followUp.messageId)).status,'merged')
    assert.equal(keys.length,clarified ? 3 : 2);assert.equal(new Set(keys).size,keys.length,'every post has its own idempotency key')
    // The reopened reply survives a restart as an ordinary delivered job.
    const reboot=automatic({},h.saved);await reboot.loop.drain()
    assert.deepEqual(await reboot.loop.snapshot(),await h.loop.snapshot());assert.deepEqual(reboot.calls,[])
  }
})

// A stored job copied to another message, conversation or binding.
function moved(j,messageId,{source={},...fields}={}) {
  const x={...clone(j),messageId,source:{...j.source,...source},...fields}
  if(x.receipt)x.receipt={chatId:x.source.chatId,messageId:'om_sent_'+messageId.slice(3),inReplyTo:messageId}
  return x
}
async function finished(overrides,job=first) {
  const h=harness(overrides);await run(h,job);return clone(h.saved.jobs[0])
}

test('the Router is offered only open work of the message’s case and binding, at most the ten latest',async()=>{
  const awaiting=await finished({}), asking=await finished({work:()=>({...seat,question:'Which month?'})})
  const posted=await finished({isReleaseRequired:()=>false}), failed=await finished({work:()=>{throw {code:'AUTOMATION_UNAVAILABLE'}}})
  const unsure=await finished({work:()=>{throw {code:'WORK_UNCERTAIN'}}}), lost=await finished({isReleaseRequired:()=>false,deliver:()=>null})
  const declining=harness(), drafted=await run(declining,first);await declining.loop.release(releaseCommand(drafted,'decline'),allow)
  const handing=harness();await run(handing,first);await take(handing.loop,first)
  const [declined,handed]=[declining.saved.jobs[0],handing.saved.jobs[0]]
  assert.deepEqual([awaiting,asking,posted,failed,unsure,lost,declined,handed].map(j=>[j.status,j.reason]),[['awaiting-release',undefined],
    ['awaiting-release',undefined],['delivered',undefined],['stopped','work-failed'],['uncertain','work-uncertain'],['uncertain','delivery-uncertain'],
    ['declined',undefined],['taken-over',undefined]])
  const jobs=[
    moved(awaiting,'om_t01',{text:'Same case draft'}),
    moved(posted,'om_t02'),
    moved(awaiting,'om_t03',{caseId:'case_other',text:'Another case in the same chat'}),
    moved(awaiting,'om_t04',{source:{recipientId:'ou_other'}}),
    moved(awaiting,'om_t05',{source:{tenantId:'elsewhere'}}),
    moved(awaiting,'om_t06',{source:{scopeId:'e'.repeat(64)},text:'Separate grant in the same case'}),
    moved(declined,'om_t07'),
    moved(handed,'om_t08'),
    moved(lost,'om_t09'),
    moved(awaiting,'om_t10'),
    moved(awaiting,'om_t11'),
    moved(failed,'om_t12',{text:'Failed work'}),
    moved(unsure,'om_t13',{text:'Unconfirmed work'}),
    moved(asking,'om_t14',{text:'Same case question'}),
  ]
  const routed=[], looked=[], info=cases({archived:['om_t10'],missing:['om_t11']})
  const h=harness({caseInfo:(c,m)=>{looked.push(m);return info(c,m)},decide:b=>{routed.push(routedFull(b));return {action:'ignore'}}},{schema:1,jobs})
  await h.loop.enqueue(later('om_new','In the case'));await h.loop.drain()
  // Taken over and possibly posted work is not offered; a declined reply and failed work are.
  assert.deepEqual(routed[0],{messageId:'om_new',routable:false,openWork:[
    {ref:'w1',request:'Same case draft',state:'reply drafted',output:result.answer},
    {ref:'w2',request:'Case text of om_t02',state:'replied',output:result.answer},
    {ref:'w3',request:'Separate grant in the same case',state:'reply drafted',output:result.answer},
    {ref:'w4',request:'Case text of om_t07',state:'reply not sent',output:result.answer},
    {ref:'w5',request:'Failed work',state:'stopped'},
    {ref:'w6',request:'Unconfirmed work',state:'stopped'},
    {ref:'w7',request:'Same case question',state:'question drafted',output:'Which month?'}]})
  assert.deepEqual(looked,['om_t01','om_t02','om_t06','om_t07','om_t10','om_t11','om_t12','om_t13','om_t14'])
  // Another case in the same chat sees only its own work; a case without any worker may start new work.
  await h.loop.enqueue(later('om_beside','Beside it',{caseId:'case_other'}));await h.loop.drain()
  assert.deepEqual(routed[1],{messageId:'om_beside',routable:false,
    openWork:[{ref:'w1',request:'Another case in the same chat',state:'reply drafted',output:result.answer}]})
  await h.loop.enqueue(later('om_fresh','A new case',{caseId:'case_fresh'}));await h.loop.drain()
  assert.deepEqual(routed[2],{messageId:'om_fresh'})
  assert.deepEqual(h.calls.map(([k])=>k),['decide','decide','decide'])
  assert.deepEqual(h.saved.jobs.slice(0,jobs.length),jobs,'offering work changes nothing')
  // Of the latest ten, an archived case drops out without bringing older work back in.
  const many=Array.from({length:12},(_,i)=>moved(awaiting,'om_m'+String(i+1).padStart(2,'0'),{text:'Request '+(i+1)}))
  const routed2=[], h2=harness({caseInfo:cases({archived:['om_m05']}),decide:b=>{routed2.push(routedAs(b));return {action:'ignore'}}},{schema:1,jobs:many})
  await h2.loop.enqueue(later('om_new','In the thread'));await h2.loop.drain()
  assert.deepEqual(routed2[0].openWork,[3,4,6,7,8,9,10,11,12].map((n,i)=>({ref:'w'+(i+1),request:'Request '+n,state:'reply drafted',output:result.answer})))
})

test('a case that has its worker starts no other work: the Router may only hand a message to it or ignore the message',async()=>{
  const routed=[], h=harness({caseInfo:cases(),decide:b=>{routed.push(routedFull(b));return task}})
  const pending=await run(h,first)
  // Even a clearly new request in the case is not routed to a new worker.
  const fresh=later('om_new_request','Also translate the handbook.')
  await h.loop.enqueue(fresh);await h.loop.drain()
  assert.deepEqual(routed,[{messageId:first.messageId},{messageId:fresh.messageId,routable:false,
    openWork:[{ref:'w1',request:first.text,state:'reply drafted',output:result.answer}]}])
  const row=await byId(h,fresh.messageId)
  assert.deepEqual([row.status,row.reason,row.role],['stopped','invalid-decision',undefined])
  assert.deepEqual(await byId(h,first.messageId),pending)
  assert.deepEqual(h.calls,[['decide',first.messageId],['work',first.messageId],['decide',fresh.messageId]])
  // A worker taken over by the owner, or one whose reply may already be posted, takes nothing: the
  // message is ignored without asking the Router.
  const handed=harness();await run(handed,first);await take(handed.loop,first)
  const lost=automatic({deliver:()=>null});await run(lost,first)
  for(const saved of [handed.saved,lost.saved]) {
    const m=harness({caseInfo:cases()},saved)
    await m.loop.enqueue(followUp);await m.loop.drain()
    assert.deepEqual([(await byId(m,followUp.messageId)).status,stored(m.saved,first.messageId).status],
      ['ignored',saved.jobs[0].status])
    assert.deepEqual(m.calls,[])
  }
  // A case whose messages so far were all ignored has no worker yet: its next message may start one.
  const routed2=[], quiet=automatic({caseInfo:cases(),decide:b=>{routed2.push(routedFull(b));return b.messageId===first.messageId ? {action:'ignore'} : task}})
  await run(quiet,first)
  await quiet.loop.enqueue(followUp);await quiet.loop.drain()
  assert.deepEqual(routed2,[{messageId:first.messageId},{messageId:followUp.messageId}])
  assert.deepEqual((await quiet.loop.snapshot()).map(r=>[r.messageId,r.status]),[[first.messageId,'ignored'],[followUp.messageId,'delivered']])
})

test('a message waits while its case’s reply is being posted, then is handed to that worker',async()=>{
  const posting=deferred(), release=deferred(), routed=[], seen=[], worked=[]
  let n=0
  const h=automatic({caseInfo:cases(),
    decide:b=>{
      routed.push(routedFull(b))
      if(b.messageId!==followUp.messageId) return task
      seen.push(stored(h.saved,first.messageId).status)
      return {action:'merge',target:'w1'}
    },
    work:b=>{worked.push(b);return b.supplements ? {...result,answer:'Answer with the follow-up'} : result},
    deliver:async b=>{if(b.messageId===first.messageId && !n++){posting.resolve();await release.promise};return {...reply(b),messageId:'om_sent'+b.messageId+n}}})
  await h.loop.enqueue(first);await posting.promise
  await h.loop.enqueue(followUp)
  // Another case is routed meanwhile; this case's message is left for later.
  const elsewhere={...input,caseId:'case_elsewhere',messageId:'om_elsewhere'}
  await h.loop.enqueue(elsewhere)
  await until(async()=>(await byId(h,elsewhere.messageId)).status==='assigned','the other case to be routed')
  assert.deepEqual([(await byId(h,first.messageId)).status,(await byId(h,followUp.messageId)).status],['delivering','queued'])
  assert.ok(!routed.some(r=>r.messageId===followUp.messageId))
  release.resolve();await h.loop.drain()
  // Judged once the reply was posted, the message reopens that reply.
  assert.deepEqual(seen,['delivered'])
  assert.deepEqual(routed.find(r=>r.messageId===followUp.messageId),{messageId:followUp.messageId,routable:false,
    openWork:[{ref:'w1',request:'Case text of '+first.messageId,state:'replied',output:result.answer}]})
  assert.deepEqual((await byId(h,followUp.messageId)).mergedInto,{caseId:first.caseId,messageId:first.messageId})
  const rerun=worked.find(w=>w.messageId===first.messageId && w.supplements)
  assert.deepEqual([rerun.continueWork,rerun.supplements],[true,[{text:followUp.text,from:'requester'}]])
  const row=await byId(h,first.messageId)
  assert.deepEqual([row.status,row.answer],['delivered','Answer with the follow-up'])
  assert.equal(h.calls.filter(c=>c[0]==='deliver' && c[1]===first.messageId).length,2)
  assert.equal((await byId(h,elsewhere.messageId)).status,'delivered')
})

test('a declined reply or a stopped worker takes a later message of its case and continues in its own session',async()=>{
  // A declined reply kept no intake: the case record stands in, and the worker keeps its assigned preset.
  const routed=[], worked=[]
  const h=harness({caseInfo:cases({info:{[first.messageId]:{team:{...input.team,develop:'changed-since'}}}}),decide:mergeFollowUps(routed),
    work:b=>{worked.push(b);return worked.length===1 ? result : {...result,answer:'Reconsidered'}}})
  const pending=await run(h,first)
  await h.loop.release(releaseCommand(pending,'decline'),allow)
  await h.loop.enqueue(followUp);await h.loop.drain()
  assert.deepEqual(routed.at(-1).openWork,[{ref:'w1',request:'Case text of '+first.messageId,state:'reply not sent',output:result.answer}])
  const reopened=stored(atMerge(h),first.messageId)
  assert.deepEqual([reopened.status,reopened.text,reopened.requesterId,reopened.presetId,reopened.team.develop],
    ['assigned','Case text of '+first.messageId,requesterId,input.team.develop,input.team.develop])
  assert.deepEqual([worked[1].continueWork,worked[1].previousWorkspaceId,worked[1].supplements],[true,result.workspaceId,[{text:followUp.text,from:'requester'}]])
  const row=await byId(h,first.messageId)
  assert.deepEqual([row.status,row.answer],['awaiting-release','Reconsidered'])
  assert.notEqual(row.releaseToken,pending.releaseToken)
  // Stopped or unconfirmed work keeps its intake and runs again with the message.
  for(const code of ['AUTOMATION_UNAVAILABLE','WORK_UNCERTAIN']) {
    const routed=[], worked=[]
    const h=harness({caseInfo:cases(),decide:mergeFollowUps(routed),work:b=>{worked.push(b);if(worked.length===1)throw {code};return result}})
    const failed=await run(h,first)
    assert.equal(failed.status,code==='WORK_UNCERTAIN' ? 'uncertain' : 'stopped')
    await h.loop.enqueue(followUp);await h.loop.drain()
    assert.deepEqual(routed.at(-1).openWork,[{ref:'w1',request:first.text,state:'stopped'}],code)
    assert.equal((await byId(h,followUp.messageId)).status,'merged')
    assert.deepEqual([worked[1].continueWork,worked[1].text,worked[1].supplements],[true,first.text,[{text:followUp.text,from:'requester'}]])
    const row=await byId(h,first.messageId)
    assert.deepEqual([row.status,row.answer,row.reason],['awaiting-release',result.answer,undefined],code)
  }
})

test('a target taken over or archived while the Router decided is dropped, and the message is judged again without it; a declined one still takes it',async()=>{
  for(const change of ['declined','taken-over','archived']) {
    const routed=[], archived=[]
    let pending
    const h=harness({caseInfo:cases({archived}),decide:async b=>{
      routed.push(routedAs(b))
      if(b.messageId===first.messageId) return task
      if(change==='declined') await h.loop.release(releaseCommand(pending,'decline'),allow)
      else if(change==='taken-over') await take(h.loop,first)
      else archived.push(first.messageId)
      return {action:'merge',target:'w1'}
    }})
    pending=await run(h,first)
    await h.loop.enqueue(followUp);await h.loop.drain()
    // Judged again with no worker left to take it, the message is ignored without asking the Router.
    assert.deepEqual(routed.filter(r=>r.messageId===followUp.messageId),[
      {messageId:followUp.messageId,openWork:[{ref:'w1',request:first.text,state:'reply drafted',output:result.answer}]}],change)
    const row=await byId(h,followUp.messageId), target=await byId(h,first.messageId)
    if(change==='declined') {
      assert.deepEqual([row.status,row.mergedInto],['merged',{caseId:first.caseId,messageId:first.messageId}])
      assert.deepEqual([target.status,target.supplements],['awaiting-release',undefined])
      assert.notEqual(target.releaseToken,pending.releaseToken)
      continue
    }
    assert.deepEqual([row.status,row.mergedInto],['ignored',undefined],change)
    assert.equal(stored(h.saved,followUp.messageId).retries,1)
    assert.deepEqual([target.status,target.supplements],[change==='archived' ? 'awaiting-release' : change,undefined],change)
    if(change==='archived') assert.equal(target.releaseToken,pending.releaseToken)
  }
})

test('a merge naming no listed work, or work that cannot take the message, stops it after a single decision',async()=>{
  // Work whose case record is gone is not listed; with no other work to take it, the message is ignored undecided.
  for(const [target,caseInfo,decided] of [['w2',cases(),true],['w1',async()=>undefined,false]]) {
    const routed=[], h=harness({caseInfo,decide:mergeFollowUps(routed,target)})
    const pending=await run(h,first)
    await h.loop.enqueue(followUp);await h.loop.drain()
    const row=await byId(h,followUp.messageId)
    assert.deepEqual([row.status,row.reason,row.mergedInto],decided ? ['stopped','invalid-decision',undefined] : ['ignored',undefined,undefined])
    assert.deepEqual(await byId(h,first.messageId),pending)
    assert.deepEqual(h.calls.filter(c=>c[1]===followUp.messageId),decided ? [['decide',followUp.messageId]] : [])
  }
  // A posted reply whose case record lacks the original message cannot reopen; it is not offered again and again.
  const routed=[], merging=mergeFollowUps(routed)
  const h=automatic({caseInfo:cases({info:{[first.messageId]:{text:undefined}}}),
    decide:b=>routed.some(r=>r.messageId===followUp.messageId) && b.messageId===followUp.messageId ? (routed.push(routedAs(b)),{action:'ignore'}) : merging(b)})
  const posted=await run(h,first)
  await h.loop.enqueue(followUp);await h.loop.drain()
  assert.equal(routed.filter(r=>r.messageId===followUp.messageId).length,1)
  const row=await byId(h,followUp.messageId)
  assert.deepEqual([row.status,row.reason],['stopped','invalid-decision'])
  assert.deepEqual(await byId(h,first.messageId),posted)
  assert.deepEqual(h.calls.filter(c=>c[1]===followUp.messageId),[['decide',followUp.messageId]])
})

test('a merged message is final; merged rows and waiting supplements survive a restart and the worker then takes them in',async()=>{
  const gate=deferred(), busy=deferred(), routed=[]
  const h=automatic({caseInfo:cases(),decide:mergeFollowUps(routed),
    work:async b=>{if(b.messageId===other.messageId){busy.resolve();await gate.promise};return result}})
  await h.loop.enqueue(other);await busy.promise
  await h.loop.enqueue(first);await h.loop.enqueue(followUp)
  await until(async()=>(await byId(h,followUp.messageId))?.status==='merged','the follow-up to merge')
  const saved=clone(h.saved)
  gate.resolve();await h.loop.drain()
  await assert.rejects(h.loop.retry(retryCommand(followUp),followUp),{code:'retry-unavailable'})
  await assert.rejects(take(h.loop,followUp),{code:'takeover-unavailable'})
  // Restart while the supplement still waits.
  const worked=[], reboot=automatic({caseInfo:cases(),work:b=>{worked.push(b);return result}},saved)
  const before=await reboot.loop.snapshot()
  assert.deepEqual(before.find(r=>r.messageId===followUp.messageId).mergedInto,{caseId:first.caseId,messageId:first.messageId})
  assert.deepEqual(before.find(r=>r.messageId===first.messageId).supplements,[{messageId:followUp.messageId,text:followUp.text,senderId:requesterId}])
  await reboot.loop.drain()
  assert.deepEqual(reboot.calls,[['work',first.messageId],['deliver',first.messageId]])
  assert.deepEqual([worked[0].continueWork,worked[0].supplements],[true,[{text:followUp.text,from:'requester'}]])
  const rows=await reboot.loop.snapshot()
  assert.deepEqual(rows.map(r=>[r.messageId,r.status]),[[other.messageId,'uncertain'],[first.messageId,'delivered'],[followUp.messageId,'merged']])
  const again=automatic({},reboot.saved);await again.loop.drain()
  assert.deepEqual(await again.loop.snapshot(),rows);assert.deepEqual(again.calls,[])
  await assert.rejects(again.loop.retry(retryCommand(followUp),followUp),{code:'retry-unavailable'})
  // Malformed merge records fail closed.
  const mergedRow=stored(saved,followUp.messageId), target=stored(saved,first.messageId), queued=stored(h.commits[0],other.messageId)
  const omit=(o,k)=>{const x=clone(o);delete x[k];return x}
  const supplement={messageId:'om_s',text:'More'}
  for(const bad of [omit(mergedRow,'mergedInto'),{...mergedRow,role:'develop',presetId:''},{...mergedRow,mergedInto:{...mergedRow.mergedInto,at:1}},
    {...mergedRow,mergedInto:{caseId:first.caseId,messageId:'not-a-message'}},{...target,mergedInto:mergedRow.mergedInto},
    {...queued,supplements:[supplement]},{...queued,supplementId:'om_s'},{...target,supplements:Array(21).fill(supplement)},
    {...target,supplements:[]},{...target,supplements:[{...supplement,from:'requester'}]},{...target,supplements:[{...supplement,senderId:'someone'}]}]) {
    const broken=automatic({},{schema:1,jobs:[bad]})
    await assert.rejects(broken.loop.snapshot(),{code:'storage-unavailable'});assert.deepEqual(broken.calls,[])
  }
})

test('merged messages beyond twenty keep only the latest; one without a known sender reaches the worker as a participant',async()=>{
  const drafted=await finished({})
  const earlier=Array.from({length:20},(_,i)=>({messageId:'om_s'+(i+1),text:'Earlier '+(i+1)}))
  const worked=[], h=harness({caseInfo:cases(),decide:mergeFollowUps([]),work:b=>{worked.push(b);return result}},
    {schema:1,jobs:[{...drafted,supplements:earlier,supplementId:'om_s20'}]})
  await h.loop.enqueue(followUp);await h.loop.drain()
  const kept=stored(atMerge(h),first.messageId).supplements
  assert.deepEqual(kept,[...earlier.slice(1),{messageId:followUp.messageId,text:followUp.text,senderId:requesterId}])
  assert.deepEqual(worked[0].supplements,[...earlier.slice(1).map(s=>({text:s.text,from:'participant'})),{text:followUp.text,from:'requester'}])
})

test('every stage names the job’s verified requester; sending checks that member, declining needs no access',async()=>{
  const requesterId='ou_member', seen=[]
  const h=harness({decide:b=>{seen.push(['decide',b.requesterId]);return task},work:b=>{seen.push(['work',b.requesterId]);return result},
    deliver:b=>{seen.push(['deliver',b.requesterId]);return reply(b)}})
  const pending=await run(h,{...input,requesterId})
  const checks=[]
  const row=await h.loop.release(releaseCommand(pending),async(source,signal,id)=>{checks.push([source,id]);signal.throwIfAborted()})
  assert.equal(row.status,'approved');await h.loop.drain()
  assert.deepEqual(checks,[[input.source,requesterId]])
  assert.deepEqual(seen,[['decide',requesterId],['work',requesterId],['deliver',requesterId]])
  // A job without a known requester names none, so only a conversation or topic grant can admit it.
  const names=[], legacy=harness({decide:b=>{names.push(Object.hasOwn(b,'requesterId'));return task},
    deliver:b=>{names.push(Object.hasOwn(b,'requesterId'));return reply(b)}})
  const old=await run(legacy)
  await legacy.loop.release(releaseCommand(old),async(...args)=>{names.push(args.length===3 && args[2]===undefined)})
  await legacy.loop.drain()
  assert.deepEqual(names,[false,true,false])
  // After access is revoked, sending is refused, yet the owner can still decline without any check.
  const revoked=harness(), waiting=await run(revoked,{...input,requesterId})
  await assert.rejects(revoked.loop.release(releaseCommand(waiting),()=>false),{code:'admission-denied'})
  assert.equal((await revoked.loop.snapshot())[0].status,'awaiting-release')
  const declined=await revoked.loop.release(releaseCommand(waiting,'decline'),()=>assert.fail('declining posts nothing and checks no access'))
  assert.equal(declined.status,'declined');await revoked.loop.drain()
  assert.ok(!revoked.calls.some(([k])=>k==='deliver'))
})
