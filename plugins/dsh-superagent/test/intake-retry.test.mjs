import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {sourceSettings} from '../host/source-settings.js'
import {admissionRecord,createAdmission} from '../host/admission.js'

const cfg={enabled:true,profile:'retry',tenantId:'tenant_test',recipientId:'ou_owner',automationSince:100}
const chatId='oc_group', base='/open-apis/im/v1/messages', secret='PRIVATE_BODY_OR_CLI_OUTPUT'
const ok=data=>({ok:true,identity:'user',data})
const diag={at:2_000_000,stage:'history',reason:'invalid-response'}
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const scopeOf=g=>hash([hash({profile:cfg.profile,tenantId:cfg.tenantId,recipientId:cfg.recipientId}),cfg.automationSince,g.chatId,g.mode,g.threadId ?? null,g.grantId,g.approvedAt])
function msg(id,at,sender='ou_requester') {
  return {message_id:id,chat_id:chatId,thread_id:'omt_'+id,deleted:false,msg_type:'text',create_time:String(at),
    sender:{id_type:'open_id',sender_type:'user',id:sender,tenant_key:cfg.tenantId},
    mentions:[{id:cfg.recipientId,id_type:'open_id',tenant_key:cfg.tenantId}],body:{content:JSON.stringify({text:secret+id})}}
}
const ref=m=>({chatId,threadId:m.message_id,messageId:m.message_id,at:Number(m.create_time),senderId:m.sender.id})
function fixture(t) {
  let now=1000,config={...cfg}
  t.mock.method(Date,'now',()=>now)
  const grants=new Map(), feed=new Map(), jobs=new Set(), safeLogs=[], received=[], scopes=[], searches=[], history=[], exact=[], calls=[]
  const first=msg('om_bad',1100), second=msg('om_ok',1200), last=msg('om_later',1300), rows=[first,second,last]
  const control={hits:true,fault:'invalid',failSave:false}
  const permissions={load:k=>grants.get(k),save:(k,v)=>{
    if(control.failSave && v.groups.some(g=>g.failures))throw Error(secret)
    grants.set(k,admissionRecord.parse(v))
  },mentions:()=>({get:k=>feed.get(k),put:(k,v)=>feed.set(k,structuredClone(v)),entries:()=>feed.entries()}),
    pollLogs:{list:()=>safeLogs,append:(_k,d)=>safeLogs.push(d)}}
  const a=createAdmission({scope:cfg,...permissions,consentSince:cfg.automationSince})
  const open=()=>sourceSettings({readConfig:()=>config,permissions,
    hasIntake:async(s,id)=>{await control.beforeIntake?.(id);return jobs.has(s+id)},receive:(e,s)=>{received.push(e.messageId);scopes.push(s);jobs.add(s+e.messageId)},
    runCli:async argv=>{
      calls.push(argv)
      const flag=k=>JSON.parse(argv[argv.indexOf(k)+1])
      if(argv.includes('+get-user'))return ok({user:{open_id:cfg.recipientId,tenant_key:cfg.tenantId}})
      if(argv.includes('check'))return {ok:true,granted:['im:message.p2p_msg:get_as_user'],missing:[]}
      if(argv.includes('/open-apis/im/v1/chat_p2p/batch_query'))return ok({p2p_chats:[]})
      if(argv.includes('chats'))return ok({name:'Group',chat_mode:'group',external:false,tenant_key:cfg.tenantId})
      if(argv.includes(base+'/search')) {
        const {page_token}=flag('--params')
        searches.push(page_token)
        const page=control.hits ? (page_token ? [last] : [first,second]) : []
        return ok({items:page.map(m=>({meta_data:{message_id:m.message_id,chat_id:chatId,is_p2p_chat:false}})),
          has_more:control.hits && !page_token,...(control.hits && !page_token ? {page_token:'next'} : {})})
      }
      if(argv.includes(base+'/mget'))return ok({items:rows.filter(m=>flag('--params').message_ids.includes(m.message_id))})
      const m=rows.find(r=>argv.includes(base+'/'+r.message_id))
      if(m){exact.push(m.message_id);return ok({items:[m]})}
      assert.ok(argv.includes(base),'only exact request and its native thread may be read')
      const {container_id:id}=flag('--params')
      history.push(id)
      if(id===first.thread_id && control.fault){
        if(control.fault==='permission')return {ok:false,error:{type:'authorization',subtype:'missing_scope',message:secret}}
        return ok({items:secret}) // A malformed material page, after the exact request was verified.
      }
      return ok({items:[],has_more:false})
    }})
  return {a,open,first,second,last,control,received,scopes,calls,searches,history,exact,feed,safeLogs,grants,
    at:v=>{now=v},config:v=>{config=v},item:app=>app.activitySnapshot([],[]).then(x=>x.mentions.find(m=>m.messageId===first.message_id)),
    start:async()=>{await a.setScan(cfg.automationSince,{since:101});await a.update({action:'register',chatId});await a.update({action:'permanent',chatId});now=diag.at}}
}

test('a permanent grant defers only the bad material; the other message and next discovery page run, and a cold poll recovers the exact item',async t=>{
  const f=fixture(t);await f.start()
  const app=f.open()
  await app.pollOnce()
  assert.deepEqual(f.searches,[undefined,'next'])
  assert.deepEqual(f.received,['om_ok','om_later'])
  assert.deepEqual(await f.a.getScan(cfg.automationSince),{since:diag.at-300_000})
  const m=await f.item(app)
  assert.deepEqual(m.intakeFailure,diag);assert.equal(m.canApprove,false)
  const [g]=await f.a.list()
  assert.equal(g.triggers,undefined,'a failed later request is never made a grant exception')
  assert.deepEqual(g.failures,[{threadId:'om_bad',messageId:'om_bad',senderId:'ou_requester',at:1100,diagnostic:diag}])
  assert.ok(f.feed.size===3,'normal activity archive is unchanged')
  assert.ok(!JSON.stringify([...f.grants.values(),...f.safeLogs,g.failures,m.intakeFailure]).includes(secret))
  assert.equal((await app.snapshot()).groups[0].failures,undefined)
  assert.equal((await app.snapshot()).state,'ready','one material did not break the feed')
  await app.dispose()
  f.control.hits=false // Earlier than the new cursor. Only the persisted pointer can recover this item.
  const cold=f.open()
  assert.deepEqual((await f.item(cold)).intakeFailure,diag)
  const before=f.history.length
  f.at(diag.at+5000);await cold.pollOnce()
  assert.equal(f.history.length,before+1);assert.deepEqual((await f.item(cold)).intakeFailure,diag,'no duplicate row or timestamp churn')
  f.control.fault=false;f.at(diag.at+8000);await cold.pollOnce()
  assert.deepEqual(f.received,['om_ok','om_later','om_bad']);assert.equal((await f.item(cold)).intakeFailure,undefined)
  assert.equal((await f.a.list())[0].failures,undefined)
  await cold.pollOnce();assert.equal(f.received.length,3)
  await cold.dispose()
})

test('a stale replay cannot use a replacement grant or even start an exact material read',async t=>{
  const f=fixture(t);await f.start()
  const app=f.open()
  await app.pollOnce()
  assert.deepEqual((await f.item(app)).intakeFailure,diag)
  const exact=f.exact.length,history=f.history.length
  f.control.hits=false;f.control.fault=false
  f.control.beforeIntake=async id=>{
    assert.equal(id,f.first.message_id)
    delete f.control.beforeIntake
    await f.a.update({action:'revoke',chatId})
    await f.a.update({action:'register',chatId})
    await f.a.update({action:'permanent',chatId})
  }
  f.at(diag.at+1);await app.pollOnce()
  assert.equal(f.exact.length,exact);assert.equal(f.history.length,history)
  assert.deepEqual(f.received,['om_ok','om_later']);assert.equal((await f.item(app)).intakeFailure,undefined)
  await app.dispose()
})

test('an overlapping topic grant cannot steal a member retry or its job, including after cold rescan and revocation',async t=>{
  const f=fixture(t), a=f.a, first=ref(f.first), seed=ref(msg('om_seed',850)), since=cfg.automationSince
  const record=async m=>{await a.recordMention({...m,text:secret},since);await a.observe(m,since)}
  const approve=async(action,m)=>a.update({action,chatId,threadId:m.threadId,messageId:m.messageId})
  const ack=(grant,m)=>a.ackTrigger({grantId:grant.grantId,chatId,threadId:m.threadId,messageId:m.messageId})
  await a.setScan(since,{since:101});await record(seed)
  const [member]=await approve('sender',seed)
  await ack(member,seed)
  f.at(2000)
  let app=f.open();await app.pollOnce()
  assert.ok((await f.item(app)).intakeFailure);assert.deepEqual(f.received,['om_ok','om_later'])
  // The older item can even be above the second grant's timestamp after a clock correction.
  const colleague={...ref(msg('om_colleague',1070,'ou_other')),threadId:first.threadId}
  f.at(1090);await record(colleague)
  await assert.rejects(approve('once',first),{code:'admission-denied'},'a stale UI cannot grant the already-failing receipt a second time')
  const topic=(await approve('once',colleague)).find(g=>g.mode==='once')
  await ack(topic,colleague)
  assert.equal((await a.observe(first,since)).grant.grantId,member.grantId)
  assert.equal((await a.observe({...first,messageId:'om_new_request',at:1500},since)).grant.grantId,topic.grantId)
  await app.dispose()
  f.at(2500);f.control.fault=false
  app=f.open();await app.pollOnce()
  assert.deepEqual(f.received,['om_ok','om_later','om_bad'])
  assert.equal(f.scopes.at(-1),scopeOf(member))
  const source={kind:'feishu',tenantId:cfg.tenantId,recipientId:cfg.recipientId,chatId,threadId:first.threadId,scopeId:scopeOf(member)}
  await app.validateRelease(source,undefined,first.senderId)
  await app.assertAutomation(source,undefined,first.senderId)
  await assert.rejects(app.validateRelease(source,undefined,colleague.senderId),{code:'admission-denied'})
  await app.dispose()
  // No in-memory seen set survives. The same search hit may not re-enter through the once grant.
  app=f.open();f.at(2600);await app.pollOnce()
  assert.deepEqual(f.received,['om_ok','om_later','om_bad'])
  await a.update({action:'revoke',chatId,senderId:first.senderId})
  assert.equal((await a.list())[0].grantId,topic.grantId)
  const n=f.calls.length
  await assert.rejects(app.validateRelease(source,undefined,first.senderId),{code:'admission-denied'})
  await assert.rejects(app.assertAutomation(source,undefined,first.senderId),{code:'admission-denied'})
  await assert.rejects(app.deliverReviewed({source,requesterId:first.senderId,messageId:first.messageId,text:'synthetic',idempotencyKey:'synthetic'}),{code:'delivery-denied'})
  assert.equal(f.calls.length,n,'reject before any identity, material or send call')
  await app.dispose()
})

test('an unwritable retry and a missing authorization both keep the page boundary',async t=>{
  const f=fixture(t);await f.start()
  const app=f.open()
  for(const [failSave,fault] of [[true,'invalid'],[false,'permission']]) {
    Object.assign(f.control,{failSave,fault})
    const before=f.searches.length
    await app.pollOnce()
    assert.deepEqual(f.searches.slice(before),[undefined])
    assert.deepEqual(await f.a.getScan(cfg.automationSince),{since:101})
    assert.equal((await f.a.list())[0].failures,undefined)
    assert.equal((await f.item(app)).intakeFailure,undefined)
    assert.equal((await app.snapshot()).state,'error')
  }
  assert.deepEqual(f.received,['om_ok'])
  f.control.fault=false;await app.pollOnce()
  assert.deepEqual(f.received,['om_ok','om_bad','om_later']);await app.dispose()
})

test('approval replay retains the exact manual trigger and stops if it is revoked, replaced, or no longer bound',async t=>{
  const f=fixture(t), r=ref(f.first)
  await f.a.setScan(cfg.automationSince,{since:100})
  await f.a.recordMention({...r,text:secret},cfg.automationSince);await f.a.observe(r,cfg.automationSince)
  f.at(diag.at);f.control.hits=false
  const [g]=await f.a.update({action:'once',chatId,threadId:r.threadId,messageId:r.messageId})
  const app=f.open()
  await app.pollOnce()
  assert.deepEqual((await f.item(app)).intakeFailure,diag)
  const stored=(await f.a.list())[0];assert.ok(!stored.triggers[0].handled);assert.equal(stored.failures.length,1)
  const {scopeId}=await app.snapshot(), grantScope=scopeOf(g)
  const item={id:'case',source:{kind:'feishu',...cfg,scopeId:grantScope,chatId,threadId:r.threadId},
    feedScopeId:scopeId,messages:[{kind:'feishu',requestId:r.messageId}]}
  for (const [automation,d] of [[[],diag],[[{caseId:'case',messageId:r.messageId}],undefined]]) {
    const m=(await app.activitySnapshot([item],automation)).mentions[0]
    assert.equal(m.caseId,'case');assert.deepEqual(m.intakeFailure,d)
  }
  const stale={...item,id:'older-case',source:{...item.source,scopeId:'another-grant'}}
  const other=(await app.activitySnapshot([stale],[{caseId:stale.id,messageId:r.messageId}])).mentions[0]
  assert.equal(other.caseId,undefined);assert.deepEqual(other.intakeFailure,diag)
  for(const patch of [{profile:'another'},{tenantId:'another'},{recipientId:'ou_other'},{managed:true},{automationSince:diag.at+1}]){
    f.config({...cfg,...patch})
    assert.ok(!(await app.activitySnapshot([],[])).mentions.some(m=>m.intakeFailure))
  }
  f.config(cfg);await f.a.update({action:'revoke',chatId,threadId:r.threadId})
  await f.a.update({action:'register',chatId,threadId:r.threadId})
  await f.a.update({action:'once',chatId,threadId:r.threadId})
  const n=f.history.length
  await assert.rejects(f.a.settleIntake(g,r,diag),{code:'admission-denied'})
  f.control.fault=false;await app.pollOnce()
  assert.equal(f.history.length,n);assert.deepEqual(f.received,[]);assert.equal((await f.item(app)).intakeFailure,undefined)
  await app.dispose()
})
