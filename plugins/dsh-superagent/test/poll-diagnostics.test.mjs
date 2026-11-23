import test from 'node:test'
import assert from 'node:assert/strict'
import {chmod,mkdtemp,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {pollDiagnostic,itemDiagnostic,cliProblem} from '../host/poll-diagnostics.js'
import {openStore} from '../host/store.js'
import {createFeishuSource} from '../host/feishu.js'

const config={enabled:true,profile:'fixture',tenantId:'tenant',recipientId:'ou_fixture',automationSince:1}
const ref={chatId:'oc_group',threadId:'om_root',messageId:'om_mention',at:200}
const secret='PRIVATE_FIXTURE_DIAGNOSTIC'
const ok=data=>({ok:true,identity:'user',data})
const envelope=error=>({ok:false,identity:'user',error:{message:secret,hint:secret,log_id:secret,...error}})
const self=ok({user:{open_id:'ou_fixture',tenant_key:'tenant'}})
const group=ok({external:false,chat_mode:'group',tenant_key:'tenant'})
const row={chat_id:ref.chatId,message_id:ref.messageId,root_id:ref.threadId,thread_id:'omt_thread',create_time:String(ref.at),
  sender:{id_type:'open_id',sender_type:'user',id:'ou_sender',tenant_key:'tenant'},deleted:false,msg_type:'text',
  mentions:[{id_type:'open_id',id:'ou_fixture',tenant_key:'tenant'}],body:{content:'{"text":"@"}'}}
const hits=ok({items:[{meta_data:{message_id:ref.messageId,chat_id:ref.chatId,is_p2p_chat:false}}]})
const grant={mode:'permanent',chatId:ref.chatId,approvedAt:1}
function adapter(responses,extra={}) {
  return createFeishuSource({config,admission:{run:async(t,fn)=>fn(grant)},receive:async()=>{},
    run:async argv=>{
      if(argv.includes('im:message.p2p_msg:get_as_user')) return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
      assert.ok(responses.length);return responses.shift()},...extra})
}
function expected(stage,reason,larkCode) {
  return e=>{
    const d=pollDiagnostic(e,'poll')
    assert.doesNotMatch(e.message+' '+JSON.stringify(e),/PRIVATE_FIXTURE_DIAGNOSTIC/)
    assert.ok(d.at>0);delete d.at
    assert.deepEqual(d,{stage,reason,...(larkCode===undefined?{}:{larkCode})})
    return true
  }
}

test('discovery, fetch and authorized history failures retain the exact safe stage',async()=>{
  const err=envelope({type:'authorization',subtype:'missing_scope',code:99991679})
  const discover=s=>s.discover({since:1,until:500}), read=s=>s.readMention(ref), consume=s=>s.consumeMention(ref)
  for (const [stage,responses,call] of [
    ['identity',[err],discover],['search',[self,err],discover],['metadata',[self,hits,err],discover],
    ['group',[self,hits,ok({items:[row]}),err],discover],['message',[self,group,err],read],
    ['history',[self,group,ok({items:[row]}),err],consume],
    ['history',[self,group,ok({items:[{...row,thread_id:''}]}),err],consume],
  ]) {
    const s=adapter(responses)
    await assert.rejects(call(s),expected(stage,'permission-denied',99991679))
    assert.doesNotMatch(JSON.stringify(s.status()),/PRIVATE_FIXTURE_DIAGNOSTIC/)
  }
  for (const [responses,call,stage] of [
    [[self,ok({items:{}})],discover,'search'],[[self,hits,ok({items:null})],discover,'metadata'],
    [[self,group,ok({items:null})],read,'message'],[[self,group,ok({items:[row]}),ok({items:{}})],consume,'history'],
  ]) await assert.rejects(call(adapter(responses)),expected(stage,'invalid-response'))
  await assert.rejects(discover(adapter([ok({user:{open_id:'ou_other',tenant_key:'tenant'}})])),expected('identity','identity-mismatch'))
})

test('typed system/CLI failures never retain free text, identifiers or unbounded integers',()=>{
  for (const [e,why] of [[{code:'ENOENT'},'cli-not-found'],[{code:'EACCES'},'cli-not-executable'],
    [{signal:'SIGTERM',killed:true},'timeout'],[{code:'ECONNRESET'},'network']]) {
    assert.deepEqual(cliProblem({...e,message:secret}),{reason:why})
  }
  for (const [e,why] of [
    [{type:'config',subtype:'not_configured'},'login-required'],[{type:'authentication',subtype:'token_expired'},'login-required'],
    [{type:'api',subtype:'invalid_argument'},'invalid-parameters'],[{type:'api',subtype:'invalid_parameters'},'invalid-parameters'],
    [{type:'api',code:99992402},'invalid-parameters'],
    [{type:'api',subtype:'rate_limited'},'rate-limited'],[{type:'network'},'network'],
    [{type:'api',code:9},'api-error'],[{type:secret,subtype:secret,code:9.2},'cli-failed'],
  ]) assert.deepEqual(cliProblem(null,envelope(e)),{reason:why,...(Number.isInteger(e.code)?{larkCode:e.code}:{})})
  for (const larkCode of [-1,0,'99',9.2,2147483648,Infinity]) {
    const d=pollDiagnostic({stage:secret,reason:secret,code:secret,larkCode,message:secret},secret)
    assert.deepEqual(Object.keys(d),['at','stage','reason'])
    assert.equal(d.stage,'poll');assert.equal(d.reason,'unknown')
  }
  assert.equal(pollDiagnostic({code:'storage-unavailable'},'message').stage,'storage')
  assert.equal(pollDiagnostic({code:'admission-denied'},'receive').reason,'admission-denied')
})

test('an admitted material failure is not a reason to advance past an authority, binding, storage or discovery failure',()=>{
  for(const stage of ['message','history','receive']) {
    const d=itemDiagnostic({stage,reason:'api-error',larkCode:42,message:secret,stdout:secret})
    assert.equal(d.stage,stage);assert.equal(d.larkCode,42);assert.ok(!JSON.stringify(d).includes(secret))
    for(const reason of ['login-required','identity-mismatch','permission-denied','storage-unavailable','admission-denied'])
      assert.equal(itemDiagnostic({stage,reason}),undefined)
    for(const code of ['scope-changed','storage-unavailable','admission-denied'])assert.equal(itemDiagnostic({stage,code}),undefined)
    assert.equal(itemDiagnostic({stage,reason:'api-error',larkCode:230027}),undefined)
  }
  for(const stage of ['identity','group','search','metadata','storage','admission','poll'])
    assert.equal(itemDiagnostic({stage,reason:'invalid-response'}),undefined)
})

test('real subprocess launch failures and JSON envelopes on either stream are classified without echo', {skip:process.platform==='win32'},async t=>{
  const temp=await realpath(tmpdir()),scratch=await mkdtemp(join(temp,'sa-diags-')),exe=join(scratch,'lark-cli')
  t.after(async()=>{
    assert.equal(dirname(await realpath(scratch)),temp)
    await rm(scratch,{recursive:true})
  })
  const s=adapter([],{config:{...config,cliPath:exe},run:undefined}), call=()=>s.discover({since:1,until:500})
  await assert.rejects(call(),expected('identity','cli-not-found'))
  await writeFile(exe,'#!/bin/sh\nexit 1\n',{mode:0o600})
  await assert.rejects(call(),expected('identity','cli-not-executable'))
  await chmod(exe,0o700)
  const err=JSON.stringify(envelope({type:'validation',subtype:'invalid_argument',code:99992402}))
  for (const code of [0,2]) for (const stream of ['stdout','stderr']) {
    const prefix=stream==='stderr' ? '// notice: '+secret+'\n' : ''
    await writeFile(exe,'#!'+process.execPath+'\nprocess.'+stream+'.write('+JSON.stringify(prefix+err)+');process.exitCode='+code)
    await assert.rejects(call(),expected('identity','invalid-parameters',99992402))
  }
  await writeFile(exe,'#!'+process.execPath+'\nconsole.log('+JSON.stringify(secret)+')')
  await assert.rejects(call(),expected('identity','invalid-response'))
})

test('auth check exit 1 recognizes only the exact missing self-chat scope and keeps group polling enabled',{skip:process.platform==='win32'},async t=>{
  const temp=await realpath(tmpdir()),scratch=await mkdtemp(join(temp,'sa-auth-check-')),exe=join(scratch,'lark-cli')
  t.after(async()=>{assert.equal(dirname(await realpath(scratch)),temp); await rm(scratch,{recursive:true})})
  const scope='im:message.p2p_msg:get_as_user', denied={ok:false,granted:null,missing:[scope],extra:secret}
  for (const [check,exitCode,stderr,reason] of [
    [denied,1,'','permission-denied'],[{...denied,granted:[]},1,'','permission-denied'],
    [{...denied,missing:['other:scope']},1,'','cli-failed'],[{...denied,granted:[scope]},1,'','cli-failed'],
    [denied,2,'','cli-failed'],[denied,1,JSON.stringify(envelope({type:'network'})),'network'],
  ]) {
    const script='#!'+process.execPath+'\n'+`const args=process.argv.slice(2);
if(args[2]==='auth') {console.log(JSON.stringify(${JSON.stringify(check)}));console.error(${JSON.stringify(stderr)});process.exitCode=${exitCode}}
else if(args[3]==='+get-user') console.log(JSON.stringify(${JSON.stringify(self)}))
else if(args[4]==='/open-apis/im/v1/messages/search' && JSON.parse(args[args.indexOf('--data')+1]).filter.chat_type==='group')
  console.log(JSON.stringify({ok:true,identity:'user',data:{items:[]}}))
else process.exitCode=3`
    await writeFile(exe,script,{mode:0o700})
    const warnings=[]
    const source=adapter([],{config:{...config,cliPath:exe},run:undefined,onPollWarning:(e,stage)=>warnings.push(pollDiagnostic(e,stage))})
    assert.deepEqual(await source.discover({since:1,until:500}),{mentions:[]})
    assert.deepEqual(warnings.map(d=>[d.stage,d.reason]),[['group',reason]])
    assert.ok(!JSON.stringify(warnings).includes(secret))
  }
})

test('diagnostic storage stays optional, isolated and bounded across reopen; parallel appends do not overwrite',async()=>{
  const persisted=new Map(),opened=[]
  const facility={async open(spec){
    opened.push(spec.name)
    return {table(name){const key=spec.name+':'+name
      if (!persisted.has(key)) persisted.set(key,new Map())
      const records=persisted.get(key)
      return {get:k=>records.get(k),put:async(k,v)=>{await Promise.resolve();records.set(k,spec.tables[name].valueSchema.parse(v))}}
    },close:async()=>{}}
  }}
  const a='1'.repeat(64), b='2'.repeat(64), row=at=>({at,stage:'search',reason:'invalid-parameters',larkCode:99992402})
  let store=await openStore(facility), logs=store.permissions.pollLogs
  assert.deepEqual(opened,['pcmid_superagent'])
  assert.deepEqual(await logs.list(a),[])
  await Promise.all([...Array.from({length:30},(_,i)=>logs.append(a,row(30-i))),logs.append(b,row(153))])
  const recent=Array.from({length:20},(_,i)=>row(30-i))
  assert.deepEqual(await logs.list(a),recent)
  const copy=await logs.list(a);copy[0].at=0
  assert.deepEqual(await logs.list(a),recent)
  for(const bad of [{...row(200),path:secret},{...row(200),stage:secret},{...row(200),larkCode:'99992402'}]) {
    await assert.rejects(logs.append(a,bad))
  }
  await assert.rejects(logs.append('../bad-binding',row(1)))
  await store.close();store=await openStore(facility);logs=store.permissions.pollLogs
  assert.deepEqual(await logs.list(a),recent);assert.deepEqual(await logs.list(b),[row(153)])
  assert.ok(!JSON.stringify([...persisted.values()].flatMap(t=>[...t.values()])).includes(secret))
  await store.close()
})
