import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../host/store.js'
import { ownerRoutes } from '../host/routes.js'
import { makeApp } from '../host/app.js'
import { createCases } from '../host/cases.js'
import { createAdmission } from '../host/admission.js'

function medium() {
  const rows = new Map()
  return {open: async spec=>({
    table:table=>{
      const prefix=spec.name+'/'+table+'/'
      return {get:key=>rows.get(prefix+key),
        put:async(key,value)=>rows.set(prefix+key,spec.tables[table].valueSchema.parse(value)),
        entries:()=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k.slice(prefix.length),v])}
    },close(){},
  })}
}
const identity = {enabled:true,profile:'demo-a',tenantId:'tenant-a',recipientId:'ou_me'}
async function mount(facility, f, extra={}) {
  const store = await openStore(facility)
  const api = makeApp({config:{feishu:f},...store,listPresets:async()=>[{id:'helper',name:'助理'}],
    executor:{async submit({caseId}){return {accepted:true,workspaceId:'work',sessionId:'session-'+caseId}}},
    ...extra,
  })
  const routes = new Map()
  ownerRoutes({fetch:{register:r=>routes.set(r.path,r)}},api)
  const send = async(endpoint,payload,override={})=>{
    const path = '/api/pcmid/superagent/'+endpoint
    const route = routes.get(path)
    assert.deepEqual(route.methods,['POST'])
    const response = await route.fetch(new Request('http://example.invalid'+path,{method:'POST',
      body:JSON.stringify({type:'client-request',rpcId:'fixture-1',payload,...override})}))
    assert.equal(response.status,200)
    const body = await response.json()
    assert.equal(body.rpcId,'fixture-1')
    return body.result
  }
  return {send,routes,api,close:store.close}
}
test('workspace is observational: only explicit settings mutations persist; no external or local prompt route',async()=>{
  const db=medium(), f=await mount(db,{})
  assert.deepEqual([...f.routes.keys()].map(s=>s.split('/').at(-1)),['snapshot','settingsSnapshot','viewRevision','attention','setPollInterval','setCliPath','setHistoryLimits','setPrivateChats','configure','setReleasePolicy','releaseOutput','archiveCase','retryWork','takeOver','groupAccess','syncFeishu','saveFeishu','startFeishuAuth','finishFeishuAuth','cancelFeishuAuth'])
  assert.equal(typeof f.api.intake,'undefined')
  assert.equal((await f.send('snapshot',{})).value.source.state,'disabled')
  assert.equal((await f.send('archiveCase',{caseId:'missing'})).error.code,'case-not-found')
  assert.equal((await f.send('retryWork',{caseId:'missing',messageId:'om_missing'})).error.code,'retry-unavailable')
  for(const [endpoint,payload] of [['archiveCase',{caseId:'missing',archivedAt:1}],
    ['takeOver',{caseId:'missing',messageId:'om_missing',sessionId:'client-chosen'}],
    ['retryWork',{caseId:'missing',messageId:'om_missing',sessionId:'replacement'}]])
    assert.equal((await f.send(endpoint,payload)).error.code,'invalid-input')
  await f.send('configure',{team:{lead:'helper'}})
  const settings=(await f.send('settingsSnapshot',{})).value
  assert.deepEqual(Object.keys(settings).sort(),['helpers','releaseRequired','revision','roleModels','source','team'])
  assert.equal(settings.team.lead,'helper')
  assert.equal(settings.releaseRequired,true)
  assert.equal((await f.send('setReleasePolicy',{required:'false'})).error.code,'invalid-input')
  assert.deepEqual((await f.send('setReleasePolicy',{required:false})).value,{releaseRequired:false})
  assert.equal((await f.send('releaseOutput',{text:'replacement',chatId:'oc_retarget'})).error.code,'invalid-input')
  assert.deepEqual(Object.keys((await f.send('configure',{team:{answer:'helper'}})).value).sort(),['helpers','roleModels','team'])
  await f.close()
  const reopened=await mount(db,{})
  assert.equal((await reopened.send('settingsSnapshot',{})).value.releaseRequired,false)
  const snapshot=(await reopened.send('snapshot',{})).value
  assert.equal(snapshot.team.lead,'helper');assert.deepEqual(snapshot.cases,[]);assert.deepEqual(snapshot.automation,[]);assert.deepEqual(snapshot.mentions,[])
  await reopened.close()
})
test('an archived case refuses retry and takeover with zero actor, CLI or send calls; an unarchived job cannot bypass a disabled source',async()=>{
  const db=medium(), seed=await openStore(db), scopeId='a'.repeat(64), cases=createCases(seed.state)
  const event={tenantId:'t',recipientId:'ou_owner',chatId:'oc_x',threadId:'om_root',senderId:'ou_requester',text:'Original intake'}
  const source={kind:'feishu',scopeId,tenantId:event.tenantId,recipientId:event.recipientId,chatId:event.chatId,threadId:event.threadId}
  const archivedCase=await cases.receive({...event,messageId:'om_archived'},scopeId)
  const liveCase=await cases.receive({...event,threadId:'om_other',messageId:'om_live'},scopeId)
  const archivedKey={caseId:archivedCase.id,messageId:'om_archived'}, liveKey={caseId:liveCase.id,messageId:'om_live'}
  const failed=key=>({...key,status:'stopped',reason:'decision-failed',attempt:0,updatedAt:1})
  await seed.automationStore.save({schema:1,jobs:[{...failed(archivedKey),source},{...failed(liveKey),source:{...source,threadId:'om_other'}}]})
  let calls=0
  const unexpected=()=>{calls++;throw Error('must not call actors, CLI or send')}, archivedSeats=[]
  const actors={decide:unexpected,work:unexpected,seats:unexpected,workerWorkspace:unexpected,handOver:unexpected,
    archiveSeats:async j=>{archivedSeats.push(j);throw Error('registry offline')}}
  const f=await mount(db,{},{actors,runCli:unexpected})
  try {
    // Archiving a case archives the seats of its own jobs; a failure there does not undo the archive.
    assert.deepEqual((await f.send('archiveCase',{caseId:archivedCase.id})).value,{caseId:archivedCase.id})
    assert.deepEqual(archivedSeats,[{...archivedKey,source}])
    const before=structuredClone((await seed.automationStore.load()).jobs)
    assert.equal((await f.send('retryWork',archivedKey)).error.code,'retry-unavailable')
    assert.equal((await f.send('takeOver',archivedKey)).error.code,'takeover-unavailable')
    await f.api.drain()
    assert.deepEqual((await seed.automationStore.load()).jobs,before)
    assert.equal(calls,0)
    // An unarchived failed job can be requeued, but a disabled source still stops it before any actor runs.
    assert.deepEqual((await f.send('retryWork',liveKey)).value,{...liveKey,status:'queued'})
    await f.api.drain()
    const j=(await seed.automationStore.load()).jobs.find(x=>x.messageId===liveKey.messageId)
    assert.deepEqual([j.status,j.reason,j.retries,j.text,j.requesterId],['stopped','access-denied',1,event.text,event.senderId])
    assert.equal(calls,0);assert.equal(archivedSeats.length,1)
  } finally {await f.api.dispose();await f.close();await seed.close()}
})

test('snapshot discovers only existing seats and names the chosen workspace; owner takeover persists before notification and is restored on restart',async()=>{
  const db=medium(), store=await openStore(db), key={caseId:'case_a',messageId:'om_request'}
  const source={kind:'feishu',scopeId:'f'.repeat(64),tenantId:'t',recipientId:'ou_owner',chatId:'oc_group',threadId:'om_root'}
  await store.automationStore.save({schema:1,jobs:[{...key,source,status:'stopped',reason:'work-failed',role:'answer',presetId:'',
    attempt:1,retries:2,updatedAt:1,targetWorkspaceId:'ws-project'}]})
  const routerSessionId='router-session',workerSessionId='worker-session', projections=[], grants=[], placed=[]
  let changed, hasWorker=false
  const actors={observe:fn=>{changed=fn},seats:j=>{projections.push(j);return hasWorker ? {routerSessionId,workerSessionId} : {routerSessionId}},
    workerWorkspace:sessionId=>{placed.push(sessionId);return 'workspace'},workspaceTitle:id=>id==='ws-project' ? 'Project' : undefined,handOver:ids=>{
      const saved=store.automationStore.load().jobs[0]
      assert.deepEqual([saved.status,saved.sessionId],['taken-over',workerSessionId]);grants.push(ids)
    },decide:assert.fail,work:assert.fail}
  const f=await mount(db,{},{actors})
  const snapshot=async x=>(await x.send('snapshot',{})).value.automation[0]
  assert.equal((await snapshot(f)).routerSessionId,routerSessionId);assert.equal((await snapshot(f)).workerSessionId,undefined)
  assert.deepEqual(projections[0],{...key,source,retries:2})
  const first=await snapshot(f)
  assert.deepEqual([first.targetWorkspaceId,first.targetWorkspaceTitle],['ws-project','Project'])
  assert.equal((await f.send('takeOver',key)).error.code,'takeover-unavailable')
  assert.deepEqual(grants,[])
  const before=f.api.viewRevision();hasWorker=true;changed()
  assert.ok(f.api.viewRevision()>before)
  const both=await snapshot(f)
  assert.deepEqual([both.routerSessionId,both.workerSessionId],[routerSessionId,workerSessionId])
  assert.deepEqual((await f.send('takeOver',key)).value,{sessionId:workerSessionId})
  assert.deepEqual(grants,[[workerSessionId]]);assert.deepEqual(placed,[workerSessionId],'takeover asks where that session lives')
  const saved=(await store.automationStore.load()).jobs[0]
  assert.deepEqual([saved.status,saved.workspaceId],['taken-over','workspace'])
  assert.equal((await f.send('takeOver',key)).error.code,'takeover-unavailable')
  await f.api.dispose();await f.close()
  const restoredGrants=[],reopened=await mount(db,{},{actors:{...actors,handOver:ids=>restoredGrants.push(ids)}})
  try {
    await reopened.api.start()
    assert.deepEqual(restoredGrants,[[workerSessionId]])
    const restored=await snapshot(reopened)
    assert.deepEqual([restored.status,restored.sessionId,restored.workerSessionId],['taken-over',workerSessionId,workerSessionId])
  } finally {await reopened.api.dispose();await reopened.close();await store.close()}
})

test('attention counts an approvable mention, not a merely recorded or already linked message',async()=>{
  const db=medium(), store=await openStore(db), cfg={...identity,automationSince:1}
  const feed=createAdmission({scope:cfg,...store.permissions,consentSince:1})
  const ref={chatId:'oc_group',threadId:'om_root',messageId:'om_ping',at:100}
  await feed.recordMention({...ref,text:'Synthetic mention'},1)
  const f=await mount(db,cfg,{runCli:assert.fail})
  const needed=async a=>(await a.send('attention',{})).value.needed
  try {
    assert.equal(await needed(f),false)
    await feed.observe(ref,1)
    assert.equal(await needed(f),true)
    const {scopeId}=(await f.api.settingsSnapshot()).source
    await createCases(store.state).receive({...identity,...ref,text:'Synthetic mention',senderId:'ou_sender'},scopeId,scopeId)
  } finally {await f.api.dispose();await f.close()}
  const reopened=await mount(db,cfg,{runCli:assert.fail})
  try {assert.equal(await needed(reopened),false)} finally {await reopened.api.dispose();await reopened.close();await store.close()}
})

test('attention includes only live intake failures until retry, revocation, or archiving a partial case',async()=>{
  const db=medium(),store=await openStore(db),cfg={...identity,automationSince:1},chatId='oc_group'
  const feed=createAdmission({scope:cfg,...store.permissions,consentSince:1,now:()=>10})
  await feed.update({action:'register',chatId})
  const [grant]=await feed.update({action:'permanent',chatId})
  const [first,second,partial]=['om_first','om_second','om_partial'].map((messageId,i)=>({chatId,threadId:messageId,messageId,at:20+i,senderId:'ou_sender'}))
  const diagnostic={at:30,stage:'history',reason:'invalid-response'}
  for(const ref of [first,second,partial])await feed.recordMention({...ref,text:'Synthetic intake'},1)
  const f=await mount(db,cfg,{runCli:assert.fail})
  const attention=async needed=>assert.deepEqual((await f.send('attention',{})).value,{needed,revision:f.api.viewRevision()})
  try {
    const {source}=await f.api.activitySnapshot([],[])
    const {createHash}=await import('node:crypto'),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
    const {profile,tenantId,recipientId,automationSince}=cfg
    const grantScope=hash([hash({profile,tenantId,recipientId}),automationSince,chatId,grant.mode,null,grant.grantId,grant.approvedAt])
    const saved=await createCases(store.state).receive({...cfg,...partial,text:'Synthetic intake'},grantScope,source.scopeId)
    await attention(false)
    await feed.settleIntake(grant,first,diagnostic)
    await attention(true)
    await feed.settleIntake(grant,first)
    await attention(false)
    const receiveFailure={at:31,stage:'receive',reason:'unknown'}
    await feed.settleIntake(grant,partial,receiveFailure)
    await attention(true)
    const projection=async()=>(await f.send('snapshot',{})).value.mentions.find(m=>m.messageId===partial.messageId)
    const live=await projection()
    assert.deepEqual([live.caseId,live.intakeFailure,live.canApprove],[saved.id,receiveFailure,false])
    const {mentions}=await f.api.activitySnapshot([saved],[{caseId:saved.id,messageId:partial.messageId,status:'queued'}])
    assert.equal(mentions.find(m=>m.messageId===partial.messageId).intakeFailure,undefined)
    assert.ok((await f.send('archiveCase',{caseId:saved.id})).ok)
    assert.deepEqual((await projection()).intakeFailure,receiveFailure)
    await attention(false)
    await feed.settleIntake(grant,second,diagnostic)
    await attention(true)
    const before=f.api.viewRevision()
    assert.ok((await f.send('groupAccess',{scopeId:source.scopeId,chatId,action:'revoke'})).ok)
    assert.ok(f.api.viewRevision()>before);await attention(false)
  } finally {await f.api.dispose();await f.close();await store.close()}
})

test('attention reports pending sends always, failures only on unarchived cases, and an outstanding automatic seat approval',async()=>{
  for(const [status,needed] of [['awaiting-release',true],['stopped',true],['uncertain',true],
    ['ignored',false],['delivered',false],['taken-over',false],['merged',false]]){
    const db=medium(), store=await openStore(db), scopeId='a'.repeat(64)
    const source={kind:'feishu',scopeId,tenantId:'t',recipientId:'ou_owner',chatId:'oc_g',threadId:'om_root'}, messageId='om_task'
    const text='Synthetic request',c=await createCases(store.state).receive({...source,messageId,senderId:'ou_r',text},scopeId)
    const worker={role:'answer',presetId:'worker',attempt:1,sessionId:'fixture-session',workspaceId:'fixture-workspace'}
    const extra={
      'awaiting-release':{...worker,answer:'Fixture answer',outputKind:'answer',text,team:{lead:'',answer:'worker',develop:''},roleModels:{},
        releaseNonce:'00000000-0000-4000-8000-000000000001'},
      stopped:{reason:'decision-failed'},uncertain:{...worker,reason:'work-uncertain'},ignored:{},
      delivered:{...worker,answer:'Fixture answer',receipt:{chatId:source.chatId,messageId:'om_sent',inReplyTo:messageId}},'taken-over':worker,
      merged:{mergedInto:{caseId:'case_earlier',messageId:'om_earlier'}}
    }[status]
    await store.automationStore.save({schema:1,jobs:[{caseId:c.id,messageId,source,attempt:0,status,updatedAt:1,...extra}]})
    let active=false,changed
    const actors={observe:fn=>{changed=fn},awaitingApproval:()=>active,seats:()=>({}),decide:assert.fail,work:assert.fail}
    const f=await mount(db,{},{actors,runCli:assert.fail})
    const attention=async()=>{const res=await f.send('attention',{});assert.equal(res.ok,true);return res.value}
    try {
      assert.deepEqual(await attention(),{needed,revision:f.api.viewRevision()},status)
      if(status==='merged') assert.equal((await f.send('retryWork',{caseId:c.id,messageId})).error.code,'retry-unavailable')
      await f.send('archiveCase',{caseId:c.id})
      // Archiving dismisses a failure; a reply waiting for confirmation still needs the owner.
      assert.deepEqual(await attention(),{needed:status==='awaiting-release',revision:f.api.viewRevision()},status)
      if(status==='stopped'){
        const before=f.api.viewRevision();active=true;changed()
        assert.ok(f.api.viewRevision()>before)
        assert.deepEqual(await attention(),{needed:true,revision:f.api.viewRevision()})
        active=false;changed();assert.equal((await attention()).needed,false)
      }
      assert.equal((await f.send('attention',{caseId:c.id})).error.code,'invalid-input')
    } finally {await f.api.dispose();await f.close();await store.close()}
  }
})

test('merged rows and waiting supplements round-trip through the real store; neither needs the owner nor runs on a snapshot',async()=>{
  const db=medium(), store=await openStore(db), scopeId='a'.repeat(64), cases=createCases(store.state)
  const source={kind:'feishu',scopeId,tenantId:'t',recipientId:'ou_owner',chatId:'oc_g',threadId:'om_root'}
  const target=await cases.receive({...source,messageId:'om_first',senderId:'ou_r',text:'First request'},scopeId)
  const later=await cases.receive({...source,messageId:'om_more',senderId:'ou_r',text:'One more thing'},scopeId)
  const supplements=[{messageId:'om_more',text:'One more thing',senderId:'ou_r'}], mergedInto={caseId:target.id,messageId:'om_first'}
  await store.automationStore.save({schema:1,jobs:[
    {caseId:target.id,messageId:'om_first',source,status:'assigned',attempt:0,updatedAt:1,role:'answer',presetId:'worker',
      sessionId:'fixture-session',workspaceId:'fixture-workspace',text:'First request',requesterId:'ou_r',
      team:{lead:'',answer:'worker',develop:''},roleModels:{},supplements,supplementId:'om_more'},
    {caseId:later.id,messageId:'om_more',source,status:'merged',attempt:0,updatedAt:2,mergedInto}]})
  const actors={observe:()=>{},seats:()=>({}),decide:assert.fail,work:assert.fail}
  for(const round of [1,2]) {
    const f=await mount(db,{},{actors,runCli:assert.fail})
    try {
      const rows=(await f.send('snapshot',{})).value.automation
      assert.deepEqual(rows.map(r=>[r.messageId,r.status,r.supplements,r.mergedInto]),
        [['om_first','assigned',supplements,undefined],['om_more','merged',undefined,mergedInto]],'round '+round)
      assert.ok(rows.every(r=>!('supplementId' in r)))
      assert.equal((await f.send('attention',{})).value.needed,false)
      assert.equal((await f.send('retryWork',{caseId:later.id,messageId:'om_more'})).error.code,'retry-unavailable')
      assert.equal((await f.send('takeOver',{caseId:later.id,messageId:'om_more'})).error.code,'takeover-unavailable')
    } finally {await f.api.dispose();await f.close()}
  }
  await store.close()
})

test('admission is explicit, scoped and durable; blocked attempts make zero CLI calls',async()=>{
  const db=medium(); let calls=0
  const cli={runCli:async()=>{calls++;throw Error('private credentials diagnostic')}}
  const chatId='oc_a', threadId='om_topic', f=await mount(db,identity,cli)
  const {scopeId}= (await f.send('snapshot',{})).value.source
  const change=(action,extra={})=>f.send('groupAccess',{scopeId,chatId,action,...extra})
  assert.equal((await f.send('configure',{groups:[{chatId,mode:'permanent'}]})).error.code,'invalid-input')
  const proposal={profile:identity.profile,managed:false,tenantId:identity.tenantId,recipientId:identity.recipientId,chatId,threadId}
  await assert.rejects(f.api.requestAccess({...proposal,text:'untrusted body'}),{code:'invalid-input'})
  await assert.rejects(f.api.requestAccess({...proposal,action:'permanent'}),{code:'invalid-input'})
  await assert.rejects(f.api.requestAccess({...proposal,recipientId:'ou_foreign'}),{code:'scope-changed'})
  assert.deepEqual(await f.api.requestAccess(proposal),{mode:'pending'})
  await assert.rejects(f.api.syncTopic(proposal),{code:'admission-denied'})
  assert.equal(calls,0)
  assert.deepEqual((await f.send('settingsSnapshot',{})).value.source.groups,[{mode:'pending',chatId,threadId}])
  assert.equal((await f.send('syncFeishu',{scopeId,chatId})).error.code,'admission-denied')
  const grant=(await change('once',{threadId})).value
  assert.equal(grant[0].mode,'once')
  for (const scope of [{chatId},{chatId,threadId:'om_other'},{chatId:'oc_other',threadId}]) {
    assert.equal((await f.send('syncFeishu',{scopeId,...scope})).error.code,'admission-denied')
  }
  assert.equal(calls,0)
  const failure=await f.send('syncFeishu',{scopeId,chatId,threadId})
  assert.equal(failure.error.code,'source-unavailable')
  assert.doesNotMatch(JSON.stringify(failure),/private credentials/)
  assert.equal(calls,1)
  await f.close()
  const restored=await mount(db,identity,cli)
  assert.deepEqual((await restored.send('snapshot',{})).value.source.groups,grant)
  await restored.send('groupAccess',{scopeId,action:'revoke',chatId,threadId})
  assert.equal((await restored.send('groupAccess',{scopeId,action:'permanent',chatId,threadId})).error.code,'admission-denied')
  assert.equal((await restored.send('syncFeishu',{scopeId,chatId,threadId})).error.code,'admission-denied')
  const changed=await mount(db,{...identity,profile:'demo-b'},cli)
  assert.deepEqual((await changed.send('snapshot',{})).value.source.groups,[])
  assert.equal((await changed.send('groupAccess',{scopeId,action:'register',chatId})).error.code,'scope-changed')
  assert.equal(calls,1)
})
test('browser cannot choose a verified identity, submit credentials or inject an official authorization link',async()=>{
  let ops=0;const db=medium(),{send}=await mount(db,identity,{
    saveConfig:async()=>{ops++},
    authFactory:()=>({start:async()=>{ops++},finish:async()=>{ops++},dispose(){}}),
  })
  const {version}= (await send('snapshot',{})).value.source.settings
  for(const [action,payload] of [
    ['saveFeishu',{version,enabled:true,profile:'demo-a',managed:false,tenantId:'other',recipientId:'ou_other'}],
    ['startFeishuAuth',{version,kind:'login',scope:'all'}],
    ['finishFeishuAuth',{version,flowId:'foo',accessToken:'synthetic'}],
    ['startFeishuAuth',{version,kind:'login',url:'https://not-feishu.invalid/'}],
    ['saveFeishu',{version,enabled:true,profile:'demo-a',managed:true,cliDir:'/somewhere'}],
    ['setCliPath',{version,cliPath:'',args:['auth','login']}],
    ['setHistoryLimits',{version,historyCount:1,historyMinutes:1,threadId:'om_elsewhere'}],
    ['setHistoryLimits',{version,historyCount:1}],
    ['setPrivateChats',{version,allowPrivateChats:true,privateChatsSince:1}],
    ['setPrivateChats',{version,allowPrivateChats:'true'}],
  ]) assert.equal((await send(action,payload)).error.code,'invalid-input')
  assert.equal(ops,0)
})
test('invalid or disabled source identity cannot disable the workspace or create grants',async()=>{
  for(const config of [{},{...identity,recipientId:'invalid'},{...identity,profile:'--unexpected'}]){
    const f=await mount(medium(),config)
    const {source,cases}= (await f.send('snapshot',{})).value
    assert.equal(source.configured,false);assert.deepEqual(cases,[])
    assert.equal((await f.send('groupAccess',{chatId:'oc_a',action:'register'})).error.code,'source-unconfigured')
  }
})
test('the app names each job’s requester before every automated step, so a member grant runs only that member’s work',async()=>{
  const db=medium(), store=await openStore(db), cfg={...identity,automationSince:1}, member='ou_member'
  const chatId='oc_group', threadId='om_root', admission=createAdmission({scope:cfg,...store.permissions,consentSince:1})
  const ask={chatId,threadId,messageId:'om_ask',at:100,senderId:member}
  await admission.recordMention({...ask,text:'请帮忙'},1);await admission.observe(ask,1)
  const g=(await admission.update({action:'sender',chatId,threadId,messageId:ask.messageId})).find(g=>g.mode==='sender')
  const {createHash}=await import('node:crypto'), hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
  const scopeId=hash([hash({profile:cfg.profile,tenantId:cfg.tenantId,recipientId:cfg.recipientId}),1,chatId,'sender',null,g.grantId,g.approvedAt])
  const source={kind:'feishu',scopeId,tenantId:cfg.tenantId,recipientId:cfg.recipientId,chatId,threadId}
  const cases=createCases(store.state), keys=[]
  for(const [messageId,senderId] of [['om_ask',member],['om_other','ou_other']]) {
    const c=await cases.receive({tenantId:cfg.tenantId,recipientId:cfg.recipientId,chatId,threadId,messageId,senderId,text:'Request '+messageId},scopeId)
    keys.push({caseId:c.id,messageId})
  }
  await store.automationStore.save({schema:1,jobs:keys.map(k=>({...k,source,status:'stopped',reason:'decision-failed',attempt:0,updatedAt:1}))})
  const decided=[], cli=[]
  const actors={decide:b=>{decided.push([b.messageId,b.requesterId]);return {action:'ignore'}},work:assert.fail,seats:()=>({})}
  const runCli=async argv=>{
    cli.push(argv)
    if(argv.includes('check'))return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
    if(argv.includes('+get-user'))return {ok:true,identity:'user',data:{user:{open_id:cfg.recipientId,tenant_key:cfg.tenantId}}}
    if(argv.includes('chats'))return {ok:true,identity:'user',data:{chat_mode:'group',external:false,tenant_key:cfg.tenantId}}
    assert.fail('unexpected CLI command')
  }
  const f=await mount(db,cfg,{actors,runCli})
  try {
    for(const k of keys) assert.deepEqual((await f.send('retryWork',k)).value,{...k,status:'queued'})
    await f.api.drain()
    // Only the member's job reached the Router; the other requester was refused before any read.
    assert.deepEqual(decided,[['om_ask',member]])
    const jobs=(await store.automationStore.load()).jobs
    assert.deepEqual(jobs.map(j=>[j.messageId,j.status,j.reason]),[['om_ask','ignored',undefined],['om_other','stopped','access-denied']])
    assert.ok(cli.some(a=>a.includes('+get-user')))
  } finally {await f.api.dispose();await f.close();await store.close()}
})

test('a later @ in a case’s topic runs under the grant that admitted it, not the one the case started under',async t=>{
  let now=150
  t.mock.method(Date,'now',()=>now)
  const db=medium(), store=await openStore(db), cfg={...identity,automationSince:100}
  const chatId='oc_group', root='om_root', later='om_later', base='/open-apis/im/v1/messages'
  const row=(id,at,extra={})=>({message_id:id,chat_id:chatId,thread_id:'omt_root',deleted:false,msg_type:'text',create_time:String(at),
    sender:{id_type:'open_id',sender_type:'user',id:'ou_requester',tenant_key:cfg.tenantId},
    mentions:[{id:cfg.recipientId,id_type:'open_id',tenant_key:cfg.tenantId}],body:{content:JSON.stringify({text:'Request '+id})},...extra})
  const rows=[row(root,200)]
  const ok=data=>({ok:true,identity:'user',data})
  const runCli=async argv=>{
    const flag=k=>JSON.parse(argv[argv.indexOf(k)+1])
    if(argv.includes('+get-user'))return ok({user:{open_id:cfg.recipientId,tenant_key:cfg.tenantId}})
    if(argv.includes('check'))return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
    if(argv.includes('chats'))return ok({name:'Group',chat_mode:'group',external:false,tenant_key:cfg.tenantId})
    if(argv.includes(base+'/search'))return ok({items:rows.map(m=>({meta_data:{message_id:m.message_id,chat_id:chatId,is_p2p_chat:false}})),has_more:false})
    if(argv.includes(base+'/mget'))return ok({items:rows.filter(m=>flag('--params').message_ids.includes(m.message_id))})
    const m=rows.find(r=>argv.includes(base+'/'+r.message_id))
    if(m)return ok({items:[m]})
    assert.ok(argv.includes(base),'only the exact message and its native thread are read')
    return ok({items:[],has_more:false})
  }
  const a=createAdmission({scope:cfg,...store.permissions,consentSince:cfg.automationSince})
  await a.setScan(cfg.automationSince,{since:101})
  await a.update({action:'register',chatId})
  const [first]=await a.update({action:'permanent',chatId})
  const decided=[]
  const actors={decide:b=>{decided.push([b.messageId,b.source.scopeId]);return {action:'ignore'}},work:assert.fail,seats:()=>({})}
  const f=await mount(db,cfg,{actors,runCli})
  const {createHash}=await import('node:crypto'), hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
  const scopeOf=g=>hash([hash({profile:cfg.profile,tenantId:cfg.tenantId,recipientId:cfg.recipientId}),cfg.automationSince,chatId,g.mode,null,g.grantId,g.approvedAt])
  try {
    now=1000;await f.api.pollOnce();await f.api.drain()
    // The owner revokes the chat and approves it again: later messages come under the new grant only.
    now=1100;await a.update({action:'revoke',chatId});await a.update({action:'register',chatId})
    now=1200;const [second]=await a.update({action:'permanent',chatId})
    rows.push(row(later,1300,{root_id:root,parent_id:root}))
    now=2000;await f.api.pollOnce();await f.api.drain()
    const {cases}=await f.api.snapshot()
    assert.equal(cases.length,1)
    assert.deepEqual(cases[0].messages.map(m=>m.requestId),[root,later])
    assert.equal(cases[0].source.scopeId,scopeOf(first),'the case keeps the grant of its first message')
    const jobs=(await store.automationStore.load()).jobs
    assert.deepEqual(jobs.map(j=>[j.messageId,j.caseId,j.source.scopeId,j.status]),
      [[root,cases[0].id,scopeOf(first),'ignored'],[later,cases[0].id,scopeOf(second),'ignored']])
    assert.deepEqual(decided,[[root,scopeOf(first)],[later,scopeOf(second)]])
  } finally {await f.api.dispose();await f.close();await store.close()}
})
