import test from 'node:test'
import assert from 'node:assert/strict'
import { createCases } from '../host/cases.js'

function fixture() {
  let disk, t = 0
  const calls = [], rows = [{id:'a',name:'Alpha'}, {id:'b',name:'Beta'}, {id:'bad',broken:true}]
  const deps = {
    load:async () => structuredClone(disk), save:async v => { disk = structuredClone(v) },
    listPresets:async () => rows, now:() => ++t, executor:{submit:async input => {
      const saved = disk.cases.find(c => c.id === input.caseId)
      assert.equal(saved.messages.at(-1).status,'dispatching')
      calls.push(input)
      return { accepted:true, sessionId:input.sessionId || 'session-'+input.caseId,workspaceId:'work',
        resolvedPresetId:input.presetId ?? 'native-default', resolvedModel:{provider:'p',model:'m',effort:'low'} }
    }},
  }
  return { service:createCases(deps),restart:() => createCases(deps),deps,rows,calls,get disk() {return disk} }
}
const event = (patch={}) => ({ tenantId:'tenant', recipientId:'owner', chatId:'chat', threadId:'topic', messageId:'root',
  senderId:'sender', text:'来自话题的原文', ...patch })
const local = (patch={}) => ({requestId:'local-1',text:'本机填写的指令',...patch})
const rejected = (promise,code) => assert.rejects(promise,e => e.code === code)
const configure = api => api.configure({team:{lead:'a', develop:'b'}})

test('each unbound role keeps its own model and uses the native default; old cases keep their effective preset', async () => {
  const {service,restart,rows,calls} = fixture()
  const empty = {lead:'',develop:'',answer:''}
  assert.deepEqual(await service.snapshot(),{team:empty,roleModels:{},cases:[]})
  const lead = await service.intake(local())
  assert.equal(lead.workerRole,'lead')
  assert.equal(lead.team.lead,'')
  assert.equal(lead.resolvedPresetId,'native-default')
  assert.equal(calls[0].presetId,undefined)
  await rejected(service.configure({team:{lead:'bad'}}),'preset-unavailable')
  await rejected(service.configure({team:{lead:'a'},roleModels:{answer:{inherit:true}}}),'invalid-input')
  assert.equal((await service.snapshot()).team.lead,'')
  await configure(service)
  const setting = {inherit:true,effort:'low'}
  await service.configure({roleModels:{answer:setting}})
  rows[1].broken = true
  await rejected(service.intake(local({requestId:'broken',lane:'develop'})),'preset-unavailable')
  const answer = await service.intake(local({requestId:'answer',lane:'answer'}))
  assert.equal(answer.workerRole,'answer')
  assert.equal(answer.team.lead,'a')
  assert.equal(calls.at(-1).presetId,undefined)
  assert.deepEqual(calls.at(-1).model,setting)
  await service.configure({team:{lead:'',answer:'a'}})
  assert.equal((await restart().snapshot()).team.lead,'')
  assert.deepEqual((await restart().snapshot()).cases.find(c=>c.id===answer.id),answer)
  const next = await restart().intake(local({caseId:answer.id,requestId:'follow'}))
  assert.deepEqual(next.team,answer.team)
  assert.equal(calls.at(-1).presetId,'native-default')
})

test('a legacy case that recorded the lead as its worker is never reassigned', async () => {
  const {service,calls} = fixture()
  await configure(service)
  const c = await service.intake(local())
  // This schema-1 shape was produced when an unbound lane borrowed the lead.
  const state = await service.snapshot()
  state.cases[0].lane = 'answer'
  const api = createCases({load:()=>({schema:1,...state}),save:async()=>{},listPresets:async()=>[],
    executor:{submit:async p=>{calls.push(p);return {accepted:true,sessionId:c.sessionId,workspaceId:c.workspaceId}}}})
  await api.configure({team:{lead:''}})
  const next = await api.intake(local({requestId:'follow',caseId:c.id}))
  assert.equal(next.workerRole,'lead')
  assert.equal(next.lane,'answer')
  assert.equal(next.team.lead,'a')
  assert.equal(calls.at(-1).presetId,'a')
})

test('a new local intent snapshots model, roles and display names; a supplement survives restart unchanged', async () => {
  const { service,restart,calls } = fixture()
  const setting = {provider:'p',model:'m',name:'First model',effort:'low'}
  await service.configure({team:{lead:'a',develop:'b'},roleModels:{develop:setting,lead:{inherit:true,effort:'high'}}})
  const c = await service.intake(local({lane:'develop'}))
  assert.equal(c.status,'submitted')
  assert.deepEqual(c.source,{kind:'local'})
  assert.equal(c.teamNames.develop,'Beta')
  assert.deepEqual(c.resolvedModel,{provider:'p',model:'m',effort:'low'})
  assert.deepEqual(calls[0],{caseId:c.id,sessionId:undefined,sourceKind:'local',requestId:'local-1',text:local().text,presetId:'b',model:setting})
  c.roleModels.develop.effort='forged'
  await service.configure({team:{develop:'a'},roleModels:{develop:null}})
  const resumed = restart()
  let result = await resumed.intake(local({caseId:c.id,requestId:'next',text:'具体的补充'}))
  assert.equal(result.sessionId,c.sessionId)
  assert.equal(calls[1].sessionId,c.sessionId)
  assert.equal(calls[1].presetId,'b')
  assert.deepEqual(calls[1].model,c.resolvedModel)
  assert.deepEqual(result.messages.map(m => [m.kind,m.status]),[['local','submitted'],['local','submitted']])
  assert.equal(result.team.develop,'b')
  assert.deepEqual(result.roleModels.develop,setting)
  await rejected(resumed.intake(local({caseId:c.id,requestId:'a3',lane:'answer'})),'request-conflict')

  result = await resumed.intake(local({requestId:'another',lane:'develop'}))
  assert.notEqual(result.id,c.id,'matching text does not merge independent requests')
  assert.equal(result.team.develop,'a')
  assert.equal(calls.at(-1).model,null)
})

test('retries are durable and conflict-checked, never a second call or a second case', async () => {
  const {service,restart,calls} = fixture()
  await configure(service)
  const c = await service.intake(local())
  assert.equal((await restart().intake(local())).id,c.id)
  assert.equal(calls.length,1)
  await rejected(service.intake(local({text:'different'})),'request-conflict')
  await rejected(service.intake(local({caseId:c.id})),'request-conflict')
  await rejected(service.intake(local({lane:'answer'})),'request-conflict')
  await rejected(service.intake(local({requestId:'two',caseId:'missing'})),'case-not-found')
  await rejected(service.intake({...local(),source:{kind:'feishu'}}),'invalid-input')
})

test('Feishu receipt keeps provenance and scoped dedup, but has no execution or sending authority', async () => {
  const {service,restart,calls} = fixture()
  const first = await service.receive(event())
  assert.equal(first.status,'received')
  assert.equal(first.sessionId,null)
  assert.equal(first.team,null)
  assert.equal(first.workerRole,null)
  assert.equal((await service.receive(event({threadId:'other',text:'redelivery'}))).id,first.id)
  // A later message of the same topic joins its case.
  const follow=await service.receive(event({messageId:'follow',senderId:'person2'}))
  assert.equal(follow.id,first.id)
  assert.deepEqual(follow.messages.map(m => [m.requestId,m.senderId]),[['root','sender'],['follow','person2']])
  for (const input of [{tenantId:'other'},{recipientId:'other'},{chatId:'other'},{threadId:'other',messageId:'different'}])
    assert.notEqual((await service.receive(event(input))).id,first.id)
  assert.equal(calls.length,0)
  assert.equal((await restart().snapshot()).cases.length,5)
  const assigned = await service.intake(local({caseId:first.id,lane:'develop',requestId:'root'}))
  assert.equal(assigned.id,first.id)
  assert.deepEqual(assigned.source,first.source)
  assert.deepEqual(assigned.messages.map(m => m.kind),['feishu','feishu','local'])
  assert.equal(calls[0].sourceKind,'local')
  assert.equal(calls[0].text,local().text)
  assert.ok(!JSON.stringify(calls[0]).includes(event().text))
  await service.receive(event({messageId:'latest'}))
  assert.equal(calls.length,1)
  // Joining the case dispatches nothing and changes neither its session nor its delivery state.
  const same = (await service.snapshot()).cases[0]
  assert.equal(same.id,first.id)
  assert.equal(same.status,'received')
  assert.equal(same.sessionId,assigned.sessionId)
  assert.deepEqual(same.messages.map(m => m.kind),['feishu','feishu','local','feishu'])
  assert.ok(!('delivered' in same))
})

test('archive survives restart without closing the case or changing its message and session',async()=>{
  const f=fixture(), first=await f.service.receive(event())
  const target={caseId:first.id}
  await rejected(f.service.archive({caseId:'absent'}),'case-not-found')
  assert.deepEqual(await f.service.archive(target),target)
  const archived=f.disk.cases[0], saved=f.disk
  assert.ok(Number.isFinite(archived.archivedAt))
  assert.deepEqual(archived,{...first,archivedAt:archived.archivedAt})
  const restored=f.restart()
  assert.deepEqual(await restored.archive(target),target)
  assert.equal(f.disk,saved,'no second archive write')
  assert.deepEqual((await restored.snapshot()).cases,[archived])
  assert.equal((await restored.receive(event())).archivedAt,archived.archivedAt)
  const follow=await restored.intake(local(target))
  assert.equal(follow.archivedAt,archived.archivedAt)
  assert.equal(follow.status,'submitted');assert.equal(f.calls.length,1)
})

test('one Feishu topic is one case: its later messages join it under any grant until the case is archived',async()=>{
  const f=fixture(), grantA='a'.repeat(64), grantB='b'.repeat(64)
  const topic={tenantId:'tenant',recipientId:'owner',chatId:'chat',threadId:'topic'}
  const first=await f.service.receive(event(),grantA)
  const second=await f.service.receive(event({messageId:'second',senderId:'person2'}),grantB)
  assert.equal(second.id,first.id)
  assert.deepEqual(second.source,first.source,'the case keeps the grant of its first message')
  assert.deepEqual(second.messages.map(m=>[m.requestId,m.senderId]),[['root','sender'],['second','person2']])
  // A redelivery under either grant is the same message.
  for(const scope of [grantA,grantB]) assert.equal((await f.service.receive(event({messageId:'second'}),scope)).messages.length,2)
  const elsewhere=await f.service.receive(event({messageId:'elsewhere',threadId:'topic-2'}),grantA)
  assert.notEqual(elsewhere.id,first.id)
  assert.equal(await f.service.isArchivedTopic(topic),false)
  await f.service.archive({caseId:first.id})
  const restored=f.restart()
  assert.equal(await restored.isArchivedTopic(topic),true)
  for(const other of [{threadId:'topic-2'},{chatId:'other'},{recipientId:'someone'},{tenantId:'other'}])
    assert.equal(await restored.isArchivedTopic({...topic,...other}),false,JSON.stringify(other))
  for(const scope of [grantA,grantB,undefined]) await rejected(restored.receive(event({messageId:'third'}),scope),'case-archived')
  // A message it already holds is still the same message.
  assert.equal((await restored.receive(event({messageId:'second'}),grantB)).id,first.id)
  const cases=(await restored.snapshot()).cases
  assert.equal(cases.length,2)
  assert.deepEqual(cases.find(c=>c.id===first.id).messages.map(m=>m.requestId),['root','second'])
  assert.equal((await restored.receive(event({messageId:'more',threadId:'topic-2'}),grantB)).id,elsewhere.id)
  assert.equal(f.calls.length,0)
})

test('a topic left with several cases by an older build follows its latest case, archived or not',async()=>{
  const f=fixture(), topic={tenantId:'tenant',recipientId:'owner',chatId:'chat',threadId:'topic'}
  const older=await f.service.receive(event())
  const newer={...structuredClone(older),id:'newer-case',createdAt:100,updatedAt:100,messages:[{...older.messages[0],requestId:'legacy',at:100}]}
  for(const archivedNewer of [false,true]) {
    const archived=yes=>yes ? {archivedAt:200} : {}
    // Listed first, the older case is found first; only creation time decides.
    await f.deps.save({...f.disk,cases:[{...older,...archived(!archivedNewer)},{...newer,...archived(archivedNewer)}]})
    const service=f.restart()
    assert.equal(await service.isArchivedTopic(topic),archivedNewer)
    const next=service.receive(event({messageId:'next'}))
    if(archivedNewer) await rejected(next,'case-archived')
    else assert.deepEqual((await next).messages.map(m=>m.requestId),['legacy','next'])
    assert.equal((await service.snapshot()).cases.find(c=>c.id===older.id).messages.length,1)
  }
})

test('an older record named by the root its request quoted still takes the @ messages of the thread the request grew into',async()=>{
  const f=fixture(), grantA='a'.repeat(64), grantB='b'.repeat(64)
  // Recorded under the earlier rule: the request is filed under the message it quoted.
  const request=await f.service.receive(event({threadId:'quoted-root',messageId:'request'}),grantA)
  const grown={tenantId:'tenant',recipientId:'owner',chatId:'chat',threadId:'request'}
  const follow=await f.service.receive(event({threadId:'request',messageId:'follow',senderId:'person2'}),grantB)
  assert.equal(follow.id,request.id)
  assert.deepEqual(follow.source,request.source)
  assert.deepEqual(follow.messages.map(m=>m.requestId),['request','follow'])
  // A redelivery under either grant is the same message.
  for(const scope of [grantA,grantB])
    assert.deepEqual((await f.service.receive(event({threadId:'request',messageId:'follow'}),scope)).messages.map(m=>m.requestId),['request','follow'])
  // A thread named by a message of another chat, or by no recorded message, is its own topic.
  for(const other of [{chatId:'other'},{threadId:'unrelated'}])
    assert.notEqual((await f.service.receive(event({...other,messageId:'m-'+Object.values(other)[0]}),grantB)).id,request.id)
  assert.equal(await f.service.isArchivedTopic(grown),false)
  await f.service.archive({caseId:request.id})
  const restored=f.restart()
  for(const threadId of ['request','quoted-root']) assert.equal(await restored.isArchivedTopic({...grown,threadId}),true,threadId)
  assert.equal(await restored.isArchivedTopic({...grown,chatId:'other'}),false)
  await rejected(restored.receive(event({threadId:'request',messageId:'later'}),grantB),'case-archived')
  assert.deepEqual((await restored.snapshot()).cases.find(c=>c.id===request.id).messages.map(m=>m.requestId),['request','follow'])
})

test('the thread context handed to the assistants is kept on its message, as they saw it, across restart',async()=>{
  const f=fixture(), lines=[{speaker:'participant-1',at:1,text:'早先的讨论'},{speaker:'owner',at:2,text:'我的补充'},
    {speaker:'requester',at:3,text:'来自话题的原文',request:true}]
  const item=await f.service.receive(event({workerContext:JSON.stringify(lines)}))
  assert.deepEqual(item.messages[0].context,lines)
  assert.deepEqual((await f.restart().snapshot()).cases[0].messages[0].context,lines)
  for(const workerContext of ['','not json','[]',JSON.stringify([{speaker:'ou_real_id',at:1,text:'x'}]),JSON.stringify([{...lines[0],extra:1}])]) {
    const other=await f.service.receive(event({messageId:'m'+workerContext.length+workerContext.slice(0,3),workerContext}))
    assert.equal('context' in other.messages.at(-1),false,workerContext)
  }
})

test('retry intake uses only the exact original Feishu message, original sender, and current team',async()=>{
  const {service,restart}=fixture(), e=event({messageId:'om_old',senderId:'ou_sender'})
  const first=await service.receive(e), other=await service.receive(event({messageId:'om_other',threadId:'other-topic'}))
  const settings=await service.configure({team:{answer:'a'},roleModels:{answer:{provider:'fixture',model:'text'}}})
  const r=restart(), fallback=await r.retryIntake(first.id,e.messageId)
  const {helpers,...routes}=settings
  assert.deepEqual(fallback,{text:e.text,requesterId:e.senderId,...routes})
  await rejected(r.retryIntake(other.id,e.messageId),'case-not-found')
  const c=await r.intake(local())
  await rejected(r.retryIntake(c.id,'local-1'),'case-not-found')
})

test('concurrent cases dispatch independently and concurrent retries do not double-submit', async () => {
  const {service,deps} = fixture()
  await configure(service)
  let release, started
  const pending = new Promise(r => { release = r })
  const entered = new Promise(r => { started = r })
  let count = 0
  deps.executor.submit = async p => {
    count++
    if (p.requestId === 'first') { started(); await pending }
    return { accepted:true, sessionId:p.caseId,workspaceId:'work' }
  }
  const input = local({requestId:'first'})
  const first = service.intake(input)
  await entered
  const duplicate = await service.intake(input)
  assert.equal(duplicate.status,'dispatching')
  await rejected(service.intake(local({requestId:'append',caseId:duplicate.id})),'case-busy')
  assert.equal((await service.intake(local({requestId:'second'}))).status,'submitted')
  assert.equal((await service.snapshot()).cases.length,2)
  release()
  assert.equal((await first).status,'submitted')
  assert.equal(count,2)
})

test('a separate inbound request during dispatch never joins the in-flight case', async () => {
  const {service,deps} = fixture()
  const c = await service.receive(event())
  await configure(service)
  let release, started
  const entered = new Promise(r => { started = r })
  deps.executor.submit = () => { started(); return new Promise(r => { release = r }) }
  const sent = service.intake(local({caseId:c.id}))
  await entered
  await service.receive(event({messageId:'later',threadId:'another-topic'}))
  release({accepted:true,sessionId:'s',workspaceId:'w'})
  const result = await sent
  assert.equal(result.status,'submitted')
  assert.deepEqual(result.messages.map(m => m.status),['received','submitted'])
  assert.equal((await service.snapshot()).cases.length,2)
  assert.equal(result.sessionId,'s')
})

test('unconfirmed receipts do not fabricate a session, verified error links are retained, exceptions are not logged', async () => {
  const {service,deps} = fixture()
  await configure(service)
  deps.executor.submit = async () => ({accepted:true,sessionId:'only'})
  const unknown = await service.intake(local())
  assert.equal(unknown.status,'uncertain')
  assert.equal(unknown.sessionId,null)
  assert.equal(unknown.messages[0].error,'PROMPT_UNCERTAIN')
  await rejected(service.intake(local({requestId:'next',caseId:unknown.id})),'dispatch-uncertain')

  deps.executor.submit = async () => { throw Object.assign(new Error('private diagnostic'),{
    code:'PROMPT_UNCERTAIN',status:'unknown',sessionId:'real',workspaceId:'work'
  }) }
  const real = await service.intake(local({requestId:'another'}))
  assert.equal(real.status,'uncertain')
  assert.equal(real.sessionId,'real')
  assert.ok(!JSON.stringify(real).includes('private diagnostic'))

  deps.executor.submit = async () => { throw Object.assign(new Error('private information'),{code:'MODEL_UNAVAILABLE'}) }
  const failed = await service.intake(local({requestId:'different'}))
  assert.equal(failed.status,'failed')
  assert.equal(failed.messages[0].error,'MODEL_UNAVAILABLE')
  assert.equal(failed.sessionId,null)
  deps.executor.submit = async () => { throw Object.assign(new Error('unrecognized'),{sessionId:'unchecked',workspaceId:'other'}) }
  const unrecognized = await service.intake(local({requestId:'unrecognized'}))
  assert.equal(unrecognized.status,'uncertain')
  assert.equal(unrecognized.sessionId,null)
})

test('a failed durable write prevents submission; interrupted durable handoffs reopen as uncertain, never replayed', async () => {
  const {service,deps,restart,calls} = fixture()
  await configure(service)
  const save = deps.save
  deps.save = async () => { throw new Error('disk full') }
  await rejected(restart().intake(local()),'storage-unavailable')
  assert.equal(calls.length,0)
  let n = 0
  deps.save = async value => { if (++n === 2) throw new Error('stopped before acknowledgement'); await save(value) }
  await rejected(restart().intake(local()),'storage-unavailable')
  assert.equal(calls.length,1)
  deps.save = save
  const recovered = restart()
  const c = (await recovered.snapshot()).cases[0]
  assert.equal(c.status,'uncertain')
  assert.equal(c.messages[0].status,'uncertain')
  assert.equal(c.sessionId,null)
  assert.equal((await recovered.intake(local())).id,c.id)
  assert.equal(calls.length,1)
})

test('invalid storage or unavailable roster are explicit; malformed state is never replaced with an empty case list', async () => {
  const {deps} = fixture()
  let writes = 0
  for (const value of [null,{}, {schema:2}, {schema:1,team:{lead:'a',develop:'',answer:''},roleModels:{},cases:[{}]}]) {
    const service=createCases({...deps,load:() => value,save:() => {writes++}})
    await rejected(service.snapshot(),'storage-unavailable')
    await rejected(service.intake(local()),'storage-unavailable')
  }
  assert.equal(writes,0)
  const unavailable=createCases({...deps,listPresets:() => {throw new Error('not mounted')}})
  await rejected(unavailable.configure({team:{lead:'a'}}),'roster-unavailable')
})
