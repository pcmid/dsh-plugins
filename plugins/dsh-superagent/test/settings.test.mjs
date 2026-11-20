import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, mkdir, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sourceSettings,sourceValues } from '../host/source-settings.js'
import { publicFailure } from '../host/routes.js'
import { createAdmission } from '../host/admission.js'

const ids={tenantId:'tenant_demo',recipientId:'ou_me'}
const old={enabled:true,profile:'demo',...ids}
const id='flow-0001'
function fixture(initial,extra={}) {
  let config=initial, cliCalls=[],grants=new Map(),mentions=new Map(),starts=[],finishes=[],ended=[],writes=0
  const app=sourceSettings({
    readConfig:()=>config,
    saveConfig:async(value,check)=>{check();writes++;config=value},
    permissions:{load:k=>grants.get(k),save:(k,v)=>grants.set(k,structuredClone(v)),
      mentions:id=>{
        if(!mentions.has(id))mentions.set(id,new Map())
        const rows=mentions.get(id)
        return {get:k=>rows.get(k),put:(k,v)=>rows.set(k,structuredClone(v)),entries:()=>rows.entries()}
      }}, receive:()=>assert.fail('unexpected message'),
    runCli:async(...args)=>{cliCalls.push(args);throw Error('fixture')},
    managedDir:name=>'/fixture/managed/'+name,
    authFactory:({cliDir})=>({
      start:async v=>{starts.push([cliDir,v]);return {flowId:id,url:'https://open.feishu.cn/example',qrDataUrl:'data:image/png;base64,fixture',expiresAt:32000,secret:'NEVER RETURN'}},
      finish:async v=>{finishes.push(v);return {kind:'login',...ids,secret:'NEVER RETURN'}},
      cancel:async()=>{},dispose:()=>{ended.push(cliDir)},
    }),
    ...extra,
  })
  return {app,cliCalls,starts,finishes,ended,writes:()=>writes,set:v=>{config=v},get:()=>config}
}
async function settings(f) {return (await f.app.snapshot()).settings}
async function save(f,patch){const s=await settings(f);return f.app.saveFeishu({profile:s.profile,enabled:s.enabled,managed:s.managed,version:s.version,...patch})}

test('reading the unbound page performs no authorization or CLI traffic; saving a profile is not a grant',async()=>{
  const f=fixture()
  assert.deepEqual(await settings(f),{enabled:false,profile:'',managed:true,pollIntervalMinutes:1,historyCount:10,historyMinutes:5,allowPrivateChats:false,...{tenantId:'',recipientId:''},version:(await settings(f)).version})
  await save(f,{enabled:true,profile:'demo'})
  const snap=await f.app.snapshot()
  assert.equal(snap.configured,false);assert.deepEqual(snap.groups,[]);assert.deepEqual(f.starts,[]);assert.deepEqual(f.cliCalls,[])
  await assert.rejects(f.app.startFeishuAuth({version:snap.settings.version,kind:'login'}),{code:'invalid-input'})
  assert.deepEqual(f.starts,[])
  const flow=await f.app.startFeishuAuth({version:snap.settings.version,kind:'login',automation:true})
  assert.equal('secret' in flow,false)
  assert.deepEqual(f.starts,[['/fixture/managed/demo',{profile:'demo',kind:'login'}]])
  assert.deepEqual(await f.app.finishFeishuAuth({version:snap.settings.version,flowId:id}),{kind:'login'})
  const linked=await f.app.snapshot();assert.equal(linked.settings.recipientId,ids.recipientId);assert.equal(linked.configured,true)
  assert.notEqual(linked.settings.version,snap.settings.version);assert.deepEqual(linked.groups,[]);assert.deepEqual(f.cliCalls,[])
})
test('legacy grants are preserved, never inherited by an identically named managed profile',async()=>{
  const f=fixture(old), before=await f.app.snapshot();assert.equal(before.settings.managed,false)
  await assert.rejects(f.app.startFeishuAuth({version:before.settings.version,kind:'setup'}),{code:'invalid-input'})
  const chatId='oc_demo',proposal={profile:'demo',...ids,chatId,threadId:'om_topic'}
  await f.app.requestAccess({...proposal,managed:false})
  await f.app.groupAccess({scopeId:before.scopeId,chatId,threadId:proposal.threadId,action:'permanent'})
  await save(f,{managed:true})
  const draft=await settings(f);assert.equal(draft.recipientId,'')
  await f.app.startFeishuAuth({version:draft.version,kind:'login',automation:true})
  await f.app.finishFeishuAuth({version:draft.version,flowId:id})
  const after=await f.app.snapshot();assert.deepEqual(after.groups,[]);assert.notEqual(after.scopeId,before.scopeId)
  await assert.rejects(f.app.syncFeishu({scopeId:before.scopeId,chatId}),{code:'scope-changed'})
  assert.deepEqual(f.cliCalls,[])
  await f.app.requestAccess({...proposal,managed:true})
  await f.app.groupAccess({scopeId:after.scopeId,chatId,threadId:proposal.threadId,action:'permanent'})
  await assert.rejects(f.app.syncFeishu({scopeId:after.scopeId,chatId}),{code:'source-unavailable'})
  assert.equal(f.cliCalls[0][2],'/fixture/managed/demo')
  f.set(old);assert.equal((await f.app.snapshot()).groups[0].mode,'permanent')
})
test('disabling or changing identity invalidates challenges and stale browser saves',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve})
  const f=fixture(old,{authFactory:()=>({dispose(){},finish:async()=>{await gate;return {kind:'login',tenantId:'other',recipientId:'ou_late'}}})})
  const initial=await settings(f),pending=f.app.finishFeishuAuth({version:initial.version,flowId:id})
  await save(f,{enabled:false})
  release()
  await assert.rejects(pending,{code:'scope-changed'})
  await assert.rejects(f.app.saveFeishu({...initial}),{code:'scope-changed'})
  assert.equal(f.get().enabled,false);assert.equal(f.get().recipientId,'ou_me')
})
test('opening or cancelling a reconnect cannot reactivate a paused account',async()=>{
  const f=fixture({...old,enabled:false,pollIntervalMinutes:4})
  const {version}=await settings(f)
  await f.app.startFeishuAuth({version,kind:'login',automation:true})
  await f.app.cancelFeishuAuth({version,flowId:id})
  assert.equal((await f.app.snapshot()).configured,false)
  assert.equal(f.writes(),0);await f.app.pollOnce();assert.deepEqual(f.cliCalls,[])
  await f.app.startFeishuAuth({version,kind:'login',automation:true})
  await f.app.finishFeishuAuth({version,flowId:id})
  assert.equal((await f.app.snapshot()).configured,true)
  assert.equal((await settings(f)).pollIntervalMinutes,4)
})

test('changing or clearing the executable keeps the same grants, binding and polling interval',async t=>{
  const root=await mkdtemp(join(tmpdir(),'superagent cli-')), cliPath=join(root,'lark-cli')
  t.after(()=>rm(root,{recursive:true,force:true}))
  const f=fixture({...old,automationSince:1,pollIntervalMinutes:4})
  const before=await f.app.snapshot(), version=before.settings.version
  await f.app.requestAccess(proposal);await f.app.groupAccess({scopeId:before.scopeId,chatId,threadId,action:'once'})
  const groups=(await f.app.snapshot()).groups
  for(const invalid of [null,'lark-cli','/bin/sh',cliPath,cliPath+' --as bot',root]) {
    await assert.rejects(f.app.setCliPath({version,cliPath:invalid}),{code:'invalid-cli-path'})
  }
  await mkdir(cliPath)
  await assert.rejects(f.app.setCliPath({version,cliPath}),{code:'invalid-cli-path'})
  await rm(cliPath,{recursive:true})
  await writeFile(cliPath,'not executed',{mode:0o600})
  if(process.platform!=='win32')await assert.rejects(f.app.setCliPath({version,cliPath}),{code:'invalid-cli-path'})
  assert.equal(f.writes(),0)
  await chmod(cliPath,0o700)
  const next=await f.app.setCliPath({version,cliPath})
  assert.equal(next.cliPath,cliPath)
  assert.notEqual(next.version,version)
  assert.equal((await f.app.snapshot()).scopeId,before.scopeId)
  assert.deepEqual((await f.app.snapshot()).groups,groups)
  assert.equal(next.automationSince,1);assert.equal(next.pollIntervalMinutes,4)
  await assert.rejects(f.app.setCliPath({version,cliPath:''}),{code:'scope-changed'})
  await f.app.setPollInterval({version:next.version,pollIntervalMinutes:6})
  assert.equal((await settings(f)).cliPath,cliPath)
  const paused=await save(f,{enabled:false})
  assert.equal(paused.cliPath,cliPath);assert.equal(paused.automationSince,undefined)
  await f.app.finishFeishuAuth({version:paused.version,flowId:id})
  assert.equal((await settings(f)).cliPath,cliPath)
  const restored=await f.app.setCliPath({version:(await settings(f)).version,cliPath:''})
  assert.equal(restored.cliPath ?? '','');assert.equal(restored.pollIntervalMinutes,6)
  assert.deepEqual(f.cliCalls,[])
})

test('history settings apply together, retain the grant and survive path, pause and login changes',async()=>{
  const cliPath='/fixture/CLI tools/lark-cli',f=fixture({...old,automationSince:1,cliPath,pollIntervalMinutes:7})
  const before=await f.app.snapshot(),defaults=before.settings
  await f.app.requestAccess(proposal);await f.app.groupAccess({scopeId:before.scopeId,chatId,threadId,action:'once'})
  const groups=(await f.app.snapshot()).groups
  assert.deepEqual([defaults.historyCount,defaults.historyMinutes],[10,5])
  for(const [historyCount,historyMinutes] of [[101,5],[10,1441],[-1,5],[10,-1],[0.1,1],[0,2.1],['3',5],[1,null],[1,undefined]]) {
    await assert.rejects(f.app.setHistoryLimits({version:defaults.version,historyCount,historyMinutes}),{code:'invalid-input'})
  }
  await f.app.setHistoryLimits({version:defaults.version,historyCount:10,historyMinutes:5})
  assert.equal(f.writes(),0)
  for(const [historyCount,historyMinutes] of [[100,1440],[0,5],[13,0]]) {
    const s=await f.app.setHistoryLimits({version:(await settings(f)).version,historyCount,historyMinutes})
    assert.deepEqual([s.historyCount,s.historyMinutes],[historyCount,historyMinutes])
    assert.equal(s.automationSince,1);assert.equal(s.cliPath,cliPath);assert.equal(s.pollIntervalMinutes,7)
    const view=await f.app.snapshot();assert.equal(view.scopeId,before.scopeId);assert.deepEqual(view.groups,groups)
  }
  assert.equal(f.ended.length,0,'history changes do not restart the bound source or dispose its auth client')
  await assert.rejects(f.app.setHistoryLimits({version:defaults.version,historyCount:3,historyMinutes:2}),{code:'scope-changed'})
  const cleared=await f.app.setCliPath({version:(await settings(f)).version,cliPath:''})
  assert.equal(cleared.historyMinutes,0);assert.equal(cleared.historyCount,13)
  const paused=await save(f,{enabled:false})
  await f.app.finishFeishuAuth({version:paused.version,flowId:id})
  const reopened=fixture(f.get()),s=await settings(reopened)
  assert.deepEqual([s.historyCount,s.historyMinutes,s.pollIntervalMinutes,s.tenantId,s.recipientId],[13,0,7,ids.tenantId,ids.recipientId])
  assert.deepEqual(f.cliCalls,[])
  await Promise.all([f.app.dispose(),reopened.app.dispose()])
})
test('missing history limits use migration defaults; explicitly malformed stored limits cannot expand reads',()=>{
  for(const [field,max,defaultValue] of [['historyCount',100,10],['historyMinutes',1440,5]]) {
    assert.equal(sourceValues({})[field],defaultValue)
    for(const value of [0,max])assert.equal(sourceValues({[field]:value})[field],value)
    for(const value of [1.1,max+1,-1,'1',null])assert.equal(sourceValues({[field]:value})[field],0)
  }
})

test('private intake is bound, explicit, versioned and gets a fresh consent boundary after every off/on',async t=>{
  const advance=clock(t),f=fixture({...old,automationSince:Date.now()-3000})
  const toggle=(s,allowPrivateChats)=>f.app.setPrivateChats({version:s.version,allowPrivateChats})
  const initial=await settings(f)
  for(const value of [1,'true',undefined,null])await assert.rejects(toggle(initial,value),{code:'invalid-input'})
  const open=await toggle(initial,true),start=f.get().privateChatsSince
  assert.equal(start,Date.now());assert.equal(open.allowPrivateChats,true)
  assert.equal(Object.hasOwn(open,'privateChatsSince'),false)
  assert.deepEqual(await toggle(open,true),open);assert.equal(f.writes(),1)
  await assert.rejects(toggle(initial,false),{code:'scope-changed'})
  const [closed,stale]=await Promise.allSettled([toggle(open,false),toggle(open,true)])
  assert.equal(closed.value.allowPrivateChats,false);assert.equal(stale.reason.code,'scope-changed')
  assert.equal(Object.hasOwn(f.get(),'privateChatsSince'),false)
  const again=await toggle(closed.value,true);assert.ok(f.get().privateChatsSince>start,'same millisecond cannot revive old work')
  assert.equal(f.ended.length,0,'live config changed without restarting authentication or losing group access')
  const latest=f.get().privateChatsSince
  advance(1000);await f.app.setPollInterval({version:again.version,pollIntervalMinutes:11})
  assert.equal(f.get().privateChatsSince,latest)
  const paused=await save(f,{enabled:false})
  assert.equal(paused.allowPrivateChats,true);await f.app.pollOnce();assert.deepEqual(f.cliCalls,[])
  advance(10);await f.app.finishFeishuAuth({version:paused.version,flowId:id})
  assert.equal(f.get().privateChatsSince,Date.now());assert.equal(f.get().allowPrivateChats,true)
  assert.equal((await settings(f)).pollIntervalMinutes,11)
  const reopened=fixture(f.get());assert.deepEqual(sourceValues(reopened.get()),sourceValues(f.get()))
  await save(f,{profile:'different'})
  assert.equal(f.get().allowPrivateChats,false);assert.equal(f.get().privateChatsSince,undefined)
  await Promise.all([f.app.dispose(),reopened.app.dispose()])
})
test('private intake cannot be enabled before account consent, on a failed save or by inheriting another login',async()=>{
  for(const value of [undefined,old,{...old,enabled:false,automationSince:1}]){
    const f=fixture(value)
    await assert.rejects(f.app.setPrivateChats({version:(await settings(f)).version,allowPrivateChats:true}),{code:'source-unconfigured'})
    assert.equal(f.writes(),0);await f.app.dispose()
  }
  const active={...old,automationSince:100,allowPrivateChats:true,privateChatsSince:200}
  for(const patch of [{allowPrivateChats:'true'},{privateChatsSince:undefined},{privateChatsSince:99},{privateChatsSince:201.5},{recipientId:'invalid'}])
    assert.equal(sourceValues({...active,...patch}).allowPrivateChats,false)
  const broken=fixture({...old,automationSince:1},{saveConfig:async()=>{throw Error('save failed')}})
  await assert.rejects(broken.app.setPrivateChats({version:(await settings(broken)).version,allowPrivateChats:true}),{code:'settings-unavailable'})
  assert.equal((await settings(broken)).allowPrivateChats,false)
  const f=fixture(active,{authFactory:()=>({dispose(){},finish:async()=>({kind:'login',...ids,recipientId:'ou_different'})})})
  await f.app.finishFeishuAuth({version:(await settings(f)).version,flowId:id})
  assert.equal(f.get().allowPrivateChats,false);assert.equal(f.get().privateChatsSince,undefined)
  assert.deepEqual(f.cliCalls,[]);await Promise.all([f.app.dispose(),broken.app.dispose()])
})

test('bad profile or persistence failure never becomes a successful settings change',async()=>{
  const f=fixture(old,{saveConfig:async()=>{throw Error('private CLI or editor diagnostic')}})
  await assert.rejects(save(f,{profile:'../elsewhere'}),{code:'invalid-input'})
  await assert.rejects(save(f,{profile:'other'}),{code:'settings-unavailable'})
  assert.equal((await settings(f)).profile,'demo')
  assert.doesNotMatch(JSON.stringify(publicFailure(Error('token=private'))),/private/)
})
test('creating a dedicated application does not bind an identity or imply any group access',async()=>{
  const f=fixture({enabled:true,managed:true,profile:'demo'},{authFactory:()=>({finish:async()=>({kind:'setup'}),dispose(){}})})
  const {version}=await settings(f)
  assert.deepEqual(await f.app.finishFeishuAuth({version,flowId:id}),{kind:'setup'})
  assert.equal(f.writes(),0);assert.equal((await f.app.snapshot()).configured,false)
  await f.app.dispose()
  await assert.rejects(f.app.snapshot(),{code:'settings-unavailable'})
})

const self={user:{open_id:ids.recipientId,tenant_key:ids.tenantId}}
const chatId='oc_demo', threadId='om_root', proposal={profile:'demo',managed:false,...ids,chatId,threadId}
const group={chat_mode:'group',external:false,tenant_key:ids.tenantId}
const ok=data=>({ok:true,identity:'user',data})
function clock(t){let at=Date.now();t.mock.method(Date,'now',()=>at);return delta=>(at+=delta)}
function selfMapping(argv){
  if(argv.includes('check'))return {ok:true,granted:['im:message.p2p_msg:get_as_user'],missing:[]}
  if(argv.includes('/open-apis/im/v1/chat_p2p/batch_query'))return ok({p2p_chats:[
    {chat_id:'oc_fixture_self',chatter_id1:ids.recipientId,chatter_id2:ids.recipientId}]})
}
function fake(initial,read){
  const calls=[],received=[]
  const f=fixture(initial,{runCli:async argv=>{calls.push(argv);return selfMapping(argv) ?? ok(await read(argv))},
    receive:(...args)=>{received.push(args);return {id:'case'}}})
  return {...f,calls,received}
}
const flag=(argv,key)=>JSON.parse(argv[argv.indexOf(key)+1])

test('a legacy self-chat shows the name after exact background repair without approving it or changing the message',async t=>{
  const advance=clock(t),cfg={...old,automationSince:1},grants=new Map(),feed=new Map(),calls=[]
  const permissions={load:k=>grants.get(k),save:(k,v)=>grants.set(k,structuredClone(v)),
    mentions:()=>({get:k=>feed.get(k),put:(k,v)=>feed.set(k,structuredClone(v)),entries:()=>feed.entries()})}
  const ref={chatId:'oc_fixture_self',messageId:'om_oldping',threadId:'om_oldping',at:Date.now()-600000}
  const a=createAdmission({scope:cfg,...permissions,consentSince:1}), text='@_user_1 ping'
  await a.recordMention({...ref,text,name:'与自己的聊天'},1);await a.observe(ref,1)
  const groups=await a.list()
  const f=fixture(cfg,{permissions,runCli:async argv=>{
    calls.push(argv)
    if(argv.includes('+get-user'))return ok(self)
    const p2p=selfMapping(argv);if(p2p)return p2p
    if(argv.includes('/open-apis/im/v1/messages/search'))return ok({items:[],has_more:false})
    assert.ok(argv.includes('/open-apis/im/v1/messages/'+ref.messageId),'read only the archived original')
    return ok({items:[{message_id:ref.messageId,chat_id:ref.chatId,create_time:String(ref.at),update_time:String(ref.at),updated:false,deleted:false,msg_type:'text',
      sender:{id:ids.recipientId,id_type:'open_id',sender_type:'user',tenant_key:ids.tenantId},mentions:[
        {id:ids.recipientId,id_type:'open_id',tenant_key:ids.tenantId,key:'@_user_1',name:'测试用户'}],body:{content:JSON.stringify({text})}}]})
  }})
  const activity=async()=>(await f.app.activitySnapshot([],[])).mentions[0]
  assert.equal((await activity()).text,text);assert.deepEqual(calls,[])
  await f.app.pollOnce()
  assert.equal((await activity()).text,'@测试用户 ping');assert.equal((await activity()).canApprove,true)
  assert.deepEqual(await a.list(),groups)
  advance(2000);await f.app.pollOnce()
  assert.equal(calls.filter(argv=>argv.includes('/open-apis/im/v1/messages/'+ref.messageId)).length,1)
  await f.app.dispose()
})

test('the live source observes saved history limits on the next mention, without restarting auth or changing access',async t=>{
  const advance=clock(t),base='/open-apis/im/v1/messages',queries=[]
  const f=fake({...old,automationSince:1,historyCount:0,historyMinutes:5},args=>{
    if(args.includes('+get-user'))return self
    if(args.includes('chats'))return {...group,group_message_type:'chat'}
    if(args.includes(base)){
      queries.push(flag(args,'--params'))
      return {items:Array.from({length:9},(_,i)=>({message_id:'om_prior_'+i,chat_id:chatId,msg_type:'text',create_time:String(Date.now()-i-1),
        deleted:false,sender:{sender_type:'user',id_type:'open_id',id:'ou_sender',tenant_key:ids.tenantId},
        body:{content:JSON.stringify({text:'prior '+i})}})),has_more:false}
    }
    const id=args.find(x=>x.startsWith(base+'/om_'))?.slice(base.length+1)
    assert.ok(id,'only the exact mentioned message may be fetched')
    return {items:[{message_id:id,chat_id:chatId,msg_type:'text',create_time:String(Date.now()),deleted:false,
      sender:{sender_type:'user',id_type:'open_id',id:'ou_sender',tenant_key:ids.tenantId},
      mentions:[{id_type:'open_id',id:ids.recipientId,tenant_key:ids.tenantId}],body:{content:'{"text":"request"}'}}]}
  })
  const {scopeId}=await f.app.snapshot()
  await f.app.requestAccess(proposal);await f.app.groupAccess({scopeId,chatId,threadId,action:'permanent'})
  advance(1000)
  async function sync(threadId){assert.equal((await f.app.syncFeishu({scopeId,chatId,threadId})).accepted,1)}
  await sync('om_off');assert.equal(queries.length,0)
  await f.app.setHistoryLimits({version:(await settings(f)).version,historyCount:7,historyMinutes:2})
  await sync('om_changed');assert.equal(queries.length,1)
  assert.deepEqual(JSON.parse(f.received.at(-1)[0].workerContext).filter(row=>!row.request).map(row=>row.text),Array.from({length:7},(_,i)=>'prior '+(6-i)))
  assert.equal(queries[0].start_time,String(Math.floor((Date.now()-120000)/1000)))
  await f.app.setHistoryLimits({version:(await settings(f)).version,historyCount:7,historyMinutes:0})
  await sync('om_off_again');assert.equal(queries.length,1)
  assert.equal(f.ended.length,0);await f.app.dispose()
})

test('legacy read-only stays idle; an automatic binding discovers without a single registered group or manual pick',async t=>{
  const advance=clock(t),f=fake(old,argv=>argv.includes('+get-user') ? self : {items:[],has_more:false})
  await f.app.pollOnce()
  assert.deepEqual(f.calls,[])
  assert.equal(typeof f.app.listFeishuGroups,'undefined');assert.equal(typeof f.app.proposeFeishuGroup,'undefined')
  f.set({...old,automationSince:Date.now()-60_000});await f.app.pollOnce();advance(100)
  await Promise.all([f.app.pollOnce(),f.app.pollOnce()])
  assert.equal(f.calls.filter(c=>c.includes('+get-user')).length,1)
  const q=f.calls.find(c=>c.includes('/open-apis/im/v1/messages/search'))
  assert.equal(flag(q,'--data').filter.chat_ids,undefined)
  assert.equal(f.calls.some(c=>c.includes('+chat-list')),false)
  assert.deepEqual((await f.app.snapshot()).groups,[])
  await f.app.dispose();const n=f.calls.length;await f.app.pollOnce();assert.equal(f.calls.length,n)
})

test('a failed or expired cursor retries from the last completed boundary without skipping a window',async t=>{
  const advance=clock(t),pages=[]
  const f=fake({...old,automationSince:1},argv=>argv.includes('+get-user')?self:pages.shift())
  await f.app.pollOnce();advance(100)
  pages.push({items:[],has_more:true},{items:[],has_more:true,page_token:'p2'},{items:[],has_more:true,page_token:'p2'},{items:[],has_more:false})
  await f.app.pollOnce();advance(10);await f.app.pollOnce();advance(10);await f.app.pollOnce()
  const searches=f.calls.filter(c=>c.includes('/open-apis/im/v1/messages/search'))
  assert.deepEqual(searches.map(c=>flag(c,'--params').page_token),[undefined,undefined,'p2',undefined])
  assert.equal(new Set(searches.map(c=>flag(c,'--data').filter.time_range.start_time)).size,1)
  assert.equal((await f.app.snapshot()).state==='error',false)
  await f.app.dispose()
})

test('a failed background poll leaves safe account-specific history in settings even after success and reopen',async t=>{
  const advance=clock(t),logs=new Map(),grants=new Map(),cfg={...old,automationSince:1}
  let bad=true
  const deps={permissions:{mentions:()=>new Map(),load:k=>grants.get(k),save:(k,v)=>grants.set(k,structuredClone(v)),
      pollLogs:{list:async k=>logs.get(k) ?? [],append:async(k,row)=>logs.set(k,[row,...(logs.get(k)??[])].slice(0,20))}},
    runCli:async argv=>selfMapping(argv) ?? (argv.includes('+get-user') ? ok(self) : bad ?
      {ok:false,error:{type:'api',subtype:'invalid_parameters',code:99992402,message:'PRIVATE GROUP BODY'}} : ok({items:[],has_more:false}))}
  const f=fixture(cfg,deps)
  await f.app.pollOnce();advance(1000);await f.app.pollOnce()
  let snap=await f.app.snapshot()
  assert.equal(snap.state,'error')
  assert.deepEqual(snap.pollErrors,[{at:Date.now(),stage:'search',reason:'invalid-parameters',larkCode:99992402}])
  assert.equal((await f.app.activitySnapshot([],[])).source.pollErrors,undefined)
  bad=false;advance(1000);await f.app.pollOnce()
  const recovered=await f.app.snapshot()
  assert.equal(recovered.state,'ready');assert.deepEqual(recovered.pollErrors,snap.pollErrors)
  await f.app.dispose()
  const reopened=fixture({...cfg,enabled:false},deps)
  assert.deepEqual((await reopened.app.snapshot()).pollErrors,snap.pollErrors)
  reopened.set({...cfg,recipientId:'ou_different'})
  assert.deepEqual((await reopened.app.snapshot()).pollErrors,[])
  await reopened.app.dispose()
})

test('an old grant without a name is labelled in the background, never by listing chats or opening settings',async t=>{
  const advance=clock(t)
  const f=fake({...old,automationSince:1},argv=>{
    if(argv.includes('+get-user'))return self
    if(argv.includes('chats')){assert.ok(argv.includes(chatId));return {...group,name:'产品讨论'}}
    if(argv.includes('/open-apis/im/v1/messages/search'))return {items:[],has_more:false}
    assert.fail('unexpected CLI command')
  })
  const {scopeId}=await f.app.snapshot()
  await f.app.requestAccess(proposal)
  await f.app.groupAccess({scopeId,action:'once',chatId,threadId})
  assert.equal(f.calls.length,0)
  await f.app.pollOnce();advance(100);await f.app.pollOnce()
  const n=f.calls.length
  assert.equal((await f.app.snapshot()).groups[0].name,'产品讨论')
  assert.equal(f.calls.length,n)
  assert.equal(f.calls.filter(c=>c.includes('chats')).length,1)
  assert.deepEqual(f.received,[])
  await f.app.dispose()
})

test('identity changes while checking self prevent every subsequent CLI read',async t=>{
  const advance=clock(t),gate=Promise.withResolvers(), entered=Promise.withResolvers()
  const f=fake({...old,automationSince:1},()=>{entered.resolve();return gate.promise})
  await f.app.pollOnce();advance(1);const tick=f.app.pollOnce()
  await entered.promise;f.set({...old,profile:'another',automationSince:2})
  gate.resolve(self);await tick
  assert.equal(f.calls.length,1)
})

test('the exact admission generation, not just the current CLI account, guards resumed jobs',async t=>{
  const advance=clock(t),f=fake({...old,automationSince:1},argv=>argv.includes('+get-user')?self:group)
  const {scopeId}=await f.app.snapshot();await f.app.requestAccess(proposal)
  const [g]=await f.app.groupAccess({scopeId,chatId,threadId,action:'once'})
  const {createHash}=await import('node:crypto')
  const bindingId=createHash('sha256').update(JSON.stringify({profile:old.profile,...ids})).digest('hex')
  const id=createHash('sha256').update(JSON.stringify([bindingId,1,g.chatId,g.mode,g.threadId,g.grantId,g.approvedAt])).digest('hex')
  const source={kind:'feishu',scopeId:id,...ids,chatId,threadId}
  const reads=f.calls.length
  const item={id:'case-1',source,feedScopeId:scopeId,messages:[{kind:'feishu',requestId:'om_new'}]}
  const publicRuns=()=>['om_new','om_orphan'].map(messageId=>({caseId:item.id,messageId,releaseToken:'release-marker'}))
  const before=publicRuns()
  await f.app.activitySnapshot([item],before)
  assert.deepEqual(before.map(r=>r.releaseToken),['release-marker',undefined])
  await f.app.validateRelease(source)
  assert.equal(f.calls.length,reads,'rendering a release action reads only local authorization')
  await f.app.assertAutomation(source)
  const version=(await f.app.snapshot()).settings.version
  await f.app.setPollInterval({version,pollIntervalMinutes:5})
  await f.app.assertAutomation(source) // A cadence change is not a new grant.
  advance(1);await f.app.groupAccess({scopeId,chatId,threadId,action:'revoke'})
  await f.app.requestAccess(proposal);await f.app.groupAccess({scopeId,chatId,threadId,action:'once'})
  const n=f.calls.length
  const after=publicRuns()
  await f.app.activitySnapshot([item],after)
  assert.deepEqual(after.map(r=>r.releaseToken),[undefined,undefined],'same-account regrant must hide old actions')
  await assert.rejects(f.app.validateRelease(source),{code:'admission-denied'})
  await assert.rejects(f.app.assertAutomation(source),{code:'admission-denied'})
  await assert.rejects(f.app.deliverReviewed({source,messageId:'om_new',text:'ok',idempotencyKey:'fixture'}),{code:'delivery-denied'})
  assert.equal(f.calls.length,n)
})

test('one minute by default; changing the cadence reschedules a single timer and survives a pause and reauthorization',async t=>{
  const advance=clock(t),timers=new Map()
  t.mock.method(globalThis,'setTimeout',(fn,ms)=>{const h={};timers.set(h,{fn,ms});return h})
  t.mock.method(globalThis,'clearTimeout',h=>timers.delete(h))
  const f=fake({...old,automationSince:1},argv=>{if(argv.includes('+get-user')){advance(5000);return self}return {items:[],has_more:false}})
  const fire=async()=>{const [h,next]=[...timers][0];timers.delete(h);next.fn();await f.app.pollOnce()}
  f.app.startPolling();f.app.startPolling();advance(50);await fire()
  assert.deepEqual([...timers.values()].map(x=>x.ms),[60000])
  advance(60_000);await fire();assert.deepEqual([...timers.values()].map(x=>x.ms),[55_000])
  const {version}=await settings(f)
  for(const pollIntervalMinutes of [0,1.2,-1,1441,'3',null])await assert.rejects(f.app.setPollInterval({version,pollIntervalMinutes}),{code:'invalid-input'})
  assert.equal(f.writes(),0)
  await f.app.setPollInterval({version,pollIntervalMinutes:7})
  assert.deepEqual([...timers.values()].map(x=>x.ms),[420000])
  await assert.rejects(f.app.setPollInterval({version,pollIntervalMinutes:12}),{code:'scope-changed'})
  await save(f,{enabled:false});const n=f.calls.length;advance(20);await fire();assert.equal(f.calls.length,n)
  await save(f,{enabled:true})
  assert.equal((await settings(f)).automationSince,undefined)
  const s=await settings(f)
  await f.app.finishFeishuAuth({version:s.version,flowId:id})
  assert.equal((await settings(f)).pollIntervalMinutes,7)
  await f.app.dispose();assert.equal(timers.size,0)
})

test('new OAuth replaces a same-millisecond grant generation; disabling requires fresh authorization',async t=>{
  const date=Date.now(), f=fixture({...old,automationSince:date})
  t.mock.method(Date,'now',()=>date)
  const {scopeId}=await f.app.snapshot(), {version}=await settings(f)
  await f.app.startFeishuAuth({version,kind:'login',automation:true})
  await f.app.finishFeishuAuth({version,flowId:id})
  assert.equal(f.get().automationSince,date+1)
  await assert.rejects(f.app.groupAccess({scopeId,chatId,threadId,action:'once'}),{code:'scope-changed'})
  await save(f,{enabled:false});await save(f,{enabled:true})
  assert.equal((await f.app.snapshot()).automationEnabled,false)
})
