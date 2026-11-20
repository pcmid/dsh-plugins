import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFeishuSource } from '../host/feishu.js'

const api='/open-apis/im/v1/messages', chatId='oc_one', tenantId='tenant', recipientId='ou_me', root='om_root', omt='omt_topic'
const at=1_800_000_000_555, messageId='om_target', forbidden='DO_NOT_IMPORT'
const ok=data=>({ok:true,identity:'user',data})
const row=(message_id,create_time,text,patch={})=>({message_id,chat_id:chatId,create_time:String(create_time),deleted:false,msg_type:'text',
  sender:{sender_type:'user',id_type:'open_id',id:'ou_writer',tenant_key:tenantId},
  body:{content:JSON.stringify({text})},...patch})
const direct=[{id:recipientId,id_type:'open_id',tenant_key:tenantId}]
const thread={root_id:root,parent_id:root,thread_id:omt}
const child=row(messageId,at,'only this is the request',{...thread,mentions:direct})
const top=row(messageId,at,'only this is the request',{mentions:direct})
const plain=(id,t,text,patch={})=>row(id,t,text,{...thread,...patch})
const texts=e=>JSON.parse(e.workerContext).map(r=>r.text).join('\n')
const page=(items,token)=>({items,has_more:!!token,...(token ? {page_token:token} : {})})
const flag=(argv,key)=>argv[argv.indexOf(key)+1]

// Only the output projection uses the installed CLI, on a synthetic dry-run with an empty temporary home.
function dryRun(t) {
  const home=mkdtempSync(join(tmpdir(),'sa-history-jq-'))
  t.after(()=>rmSync(home,{recursive:true,force:true}))
  const env={HOME:home,PATH:process.env.PATH,LARKSUITE_CLI_CONFIG_DIR:home,LARKSUITE_CLI_APP_ID:'cli_offline_fixture',
    LARKSUITE_CLI_APP_SECRET:'fixture',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}
  const invoke=args=>execFileSync('lark-cli',args,{env,cwd:home,encoding:'utf8',timeout:10_000})
  try {invoke(['--version'])} catch(e) {if(e.code==='ENOENT') {t.skip('no system CLI');return} throw e}
  return (argv,data)=>{
    const args=[...argv,'--dry-run'], i=args.indexOf('--jq')
    assert.ok(i>0)
    args[i+1]='.data='+JSON.stringify(data)+'|('+args[i+1]+')'
    const out=invoke(args)
    assert.ok(!out.includes(forbidden),'out-of-scope body escaped CLI stdout')
    const envelope=JSON.parse(out)
    assert.equal(envelope.dry_run,true);return {...envelope,dry_run:false}
  }
}

function fixture({target=child,group={},grantMode='once',options={},list=()=>page([]),rootRows=[],question,project=(_args,data)=>ok(data),deny=false,identity=recipientId}={}) {
  let admitted=false
  const config={enabled:true,profile:'fixture',tenantId,recipientId,automationSince:at-350_000,...options}
  const ref={chatId,threadId:target.root_id || target.message_id,messageId,at}
  const grant={mode:grantMode,chatId,threadId:ref.threadId,approvedAt:at+100,triggers:[{threadId:ref.threadId,messageId,at}]}
  const calls=[],events=[]
  const source=createFeishuSource({config,admission:{async run(scope,fn){
    assert.equal(scope.chatId,chatId)
    if(deny) throw Object.assign(new Error('denied'),{code:'admission-denied'})
    try {admitted=true;return await fn(grant)} finally {admitted=false}
  }},receive(event,g){assert.ok(admitted);assert.equal(g,grant);events.push(event)},async run(argv){
    calls.push(argv)
    assert.ok(admitted)
    const has=s=>argv.includes(s)
    if(has('im:message.p2p_msg:get_as_user')) return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
    if(has('+get-user')) return ok({user:{open_id:identity,tenant_key:tenantId}})
    if(has('chats')) return ok({chat_mode:'group',group_message_type:'chat',external:false,tenant_key:tenantId,...group})
    if(has(api+'/'+messageId)) return ok({items:[target]})
    if(has(api+'/search')) return ok({items:[{meta_data:{message_id:messageId}}]})
    if(has(api+'/mget')) return ok({items:[target]})
    if(has(api+'/'+root)) return project(argv,{items:rootRows})
    if(question && has(api+'/'+question.message_id)) return project(argv,{items:[question]})
    assert.ok(has(api) && has('GET') && has('--jq'))
    return project(argv,await list(JSON.parse(flag(argv,'--params'))))
  }})
  return {source,calls,events,config,grant,ref,consume:()=>source.consumeMention(ref,'recorded request'),
    lists:()=>calls.filter(argv=>argv.includes(api)),roots:()=>calls.filter(argv=>argv.includes(api+'/'+root))}
}

test('installed CLI filters chat timeline by scope, human, time, mention approval and type before stdout',async t=>{
  const project=dryRun(t);if(!project) return
  const bad=(i,patch)=>row('om_bad'+i,at-1000,forbidden,patch)
  const input=[
    bad(1,{chat_id:'oc_else'}),bad(2,{...thread}),bad(3,{thread_id:'omt_unrelated'}),bad(4,{deleted:true}),
    bad(5,{sender:{...top.sender,tenant_key:'other'}}),bad(6,{sender:{...top.sender,sender_type:'app'}}),
    bad(7,{mentions:direct}),bad(8,{upper_message_id:'om_forward'}),bad(9,{msg_type:'image'}),bad(10,{update_time:String(at+1)}),
    bad(11,{create_time:String(at-300_001)}),bad(12,{create_time:String(at+1)}),bad(13,{create_time:String(at)}),
    row('om_two',at-10,'second'),row('om_first',at-300_000,'first',{update_time:'0'}),
  ].sort((a,b)=>Number(b.create_time)-Number(a.create_time))
  const f=fixture({target:top,grantMode:'permanent',project,list:p=>{
    assert.deepEqual(p,{container_id_type:'chat',container_id:chatId,sort_type:'ByCreateTimeDesc',
      page_size:50,only_thread_root_messages:true,start_time:String(Math.floor((at-300000)/1000)),end_time:String(Math.ceil(at/1000))})
    return page(input)
  }})
  await f.consume()
  assert.equal(f.events.length,1);assert.equal(f.events[0].messageId,messageId);assert.equal(f.events[0].text,'recorded request')
  assert.equal(texts(f.events[0]),'first\nsecond');assert.equal(f.roots().length,0)
})

test('native threads ignore both limits and OAuth age; include later and other mentions but not neighbor threads',async t=>{
  const project=dryRun(t);if(!project)return
  for(const projection of [project,(_argv,data)=>ok(data)]) {
    const anchor=row(root,at-9_000_000,'old root',{thread_id:omt,sender:{...top.sender,id:'ou_third'}})
    const before=Array.from({length:14},(_,i)=>plain('om_before'+i,at-600_000+i,'prior '+i))
    const later=plain('om_next',at+200_000,'another request',{mentions:direct,sender:{...top.sender,id:recipientId}})
    const ignored=[plain('om_other',at+5,forbidden,{thread_id:'omt_other'}),plain('om_sibling',at-4,forbidden,{root_id:'om_else'}),
      plain('om_external',at-2,forbidden,{chat_id:'oc_else'}),plain('om_app',at+3,forbidden,{sender:{...top.sender,sender_type:'app'}}),
      plain('om_forward',at+3,forbidden,{upper_message_id:'om_merged'}),plain('om_file',at+3,forbidden,{msg_type:'file'}),
      {...child,body:{content:JSON.stringify({text:forbidden})}}]
    let pages=0
    const f=fixture({target:{...child,thread_id:undefined},options:{historyCount:0,historyMinutes:0},project:projection,
      rootRows:[{...anchor,parent_id:'om_else',body:{content:JSON.stringify({text:forbidden})}},anchor],list:p=>{
        assert.deepEqual(p,{container_id_type:'thread',container_id:omt,sort_type:'ByCreateTimeAsc',page_size:50,...(pages?{page_token:'next'+pages}:{})})
        pages++
        return pages===10 ? page([later,...ignored]) : page(pages===1?before:[],'next'+pages)
      }})
    await f.consume()
    assert.equal(pages,10);assert.equal(f.roots().length,1)
    assert.equal(texts(f.events[0]),['old root',...before.map((_,i)=>'prior '+i),'recorded request','another request'].join('\n'))
    const turn=JSON.parse(f.events[0].workerContext)
    assert.deepEqual(turn[0],{speaker:'participant-1',at:at-9_000_000,text:'old root'})
    assert.deepEqual(turn.at(-2),{speaker:'requester',at,text:'recorded request',request:true})
    assert.equal(turn.at(-1).speaker,'owner');assert.ok(!f.events[0].workerContext.includes('ou_'))
    assert.equal(f.events[0].decisionHistory,undefined)
  }
})

test('root intake keeps its archived text, including with count zero and replies after intake',async()=>{
  const f=fixture({target:{...top,thread_id:omt},options:{historyCount:0},list:()=>page([
    {...top,thread_id:omt,body:{content:JSON.stringify({text:'EDITED'})}},row('om_later',at+1,'later',{thread_id:omt,root_id:messageId})])})
  await f.consume()
  assert.equal(texts(f.events[0]),'recorded request\nlater');assert.equal(f.roots().length,0)
})

test('a flat quote uses bounded same-chat prehistory, not unbounded quoted root; no unknown topic widens to a chat',async t=>{
  const project=dryRun(t);if(!project)return
  const f=fixture({target:{...child,thread_id:undefined},rootRows:[row(root,at-900_000,forbidden)],project,
    list:p=>{assert.equal(p.container_id,chatId);return page([row('om_recent',at-2,'flat')])}})
  await f.consume();assert.equal(texts(f.events[0]),'flat')
  for(const rootRows of [[],[row(root,at-2,forbidden,{chat_id:'oc_other',thread_id:omt})]]) {
    const unknown=fixture({target:{...child,thread_id:undefined},rootRows,project})
    await assert.rejects(unknown.consume());assert.equal(unknown.lists().length,0);assert.deepEqual(unknown.events,[])
  }
})

test('flat-chat limits work with once approval; retain the nearest whole utterances across pages',async t=>{
  const project=dryRun(t);if(!project)return
  const last='Z'.repeat(7500)
  const f=fixture({target:top,options:{historyCount:2},project,list:p=>p.page_token==='n' ?
    page([row('om_recent2',at-20,'older'),row('om_older',at-30,forbidden)]) :
    page([row('om_quick',at-1,last),row('om_image',at-2,'',{msg_type:'post',body:{content:JSON.stringify({content:[[{tag:'img',image_key:forbidden}]]})}})],'n')})
  await f.consume();assert.equal(texts(f.events[0]),'older\n'+last);assert.equal(f.lists().length,2)
})

test('installed CLI and Host use only each message’s mention map for the root, native replies and exact clarification',async t=>{
  const project=dryRun(t);if(!project)return
  const k='@_user_1',k10='@_user_10',uid='om_question'
  const named=(key,name)=>({key,name,id:forbidden,id_type:'open_id',tenant_key:'other'})
  const mentions=[{...direct[0],key:k},named(k10,'林$&'),named('@_user_99',forbidden)]
  const anchor=row(root,at-2,'请'+k10+'と'+k+'确认',{thread_id:omt,mentions})
  const question=plain(uid,at+1,'question',{parent_id:messageId,sender:{...top.sender,id:recipientId}})
  const rich=plain('om_response',at+2,'',{parent_id:uid,msg_type:'post',mentions:[named(k,'答者'),named(k10,forbidden)],body:{content:JSON.stringify({
    title:'原样 '+k,content:[[{tag:'at',user_id:k},{tag:'text',text:'正文 '+k},{tag:'code_block',text:' '+k10}],
      [{tag:'a',text:k,href:'https://example.invalid/'+k},{tag:'img',image_key:forbidden}]],other:forbidden,
  })}})
  const richText='原样 '+k+'\n@答者正文 '+k+' '+k10+'\n['+k+'](https://example.invalid/'+k+')'
  const self=plain('om_owner',at-1,'本人'+k+'补充',{sender:{...top.sender,id:recipientId,sender_name:'写信人'},mentions:[{...direct[0],key:k}]})
  const near=plain('om_prior',at-1,k10+'、'+k+'/@_user_55abc',{mentions:[named(k10,'$1'+k),named(k,'乙'),named('@_user_55',forbidden)]})
  const neighbor=plain('om_bad',at+1,forbidden,{root_id:'om_other',mentions:[named(k,forbidden)]})
  for(const projection of [project,(_argv,data)=>ok(data)]) {
    const f=fixture({list:()=>page([near,self,question,rich,neighbor]),question,rootRows:[anchor],project:projection})
    await f.consume()
    const turns=JSON.parse(f.events[0].workerContext).map(item=>item.text)
    assert.equal(turns[0],'请@林$&と@你确认')
    assert.ok(turns.includes('@$1'+k+'、@乙/@_user_55abc'),'replacement names are neither templates nor re-tokenized')
    assert.ok(turns.includes('本人@写信人补充'))
    assert.ok(turns.includes(richText));assert.ok(!f.events[0].workerContext.includes(forbidden))
    const result=await f.source.readQuestionReply({source:{kind:'feishu',tenantId,recipientId,chatId,threadId:root},
      messageId,requesterId:top.sender.id,questionId:uid,originalText:'archived'},()=>{})
    assert.equal(result.text,richText)
    assert.equal(JSON.parse(result.workerContext).at(-1).text,richText)
  }
})

test('zero limits disable only flat history and settings take effect on the next intake',async()=>{
  const f=fixture({target:top,options:{historyCount:0},list:()=>page([row('om_history',at-100,'history')])})
  await f.consume();assert.equal(f.events[0].workerContext,'');assert.equal(f.lists().length,0)
  Object.assign(f.config,{historyCount:2,historyMinutes:0})
  await f.consume();assert.equal(f.lists().length,0)
  Object.assign(f.config,{historyMinutes:5})
  await f.consume();assert.equal(texts(f.events.at(-1)),'history')
  await f.source.sync({chatId});assert.equal(texts(f.events.at(-1)),'history')
})

test('group eligibility, duplicate cursor, provider failure and oversized text never dispatch a partial thread',async()=>{
  for(const f of [fixture({deny:true}),fixture({identity:'ou_else'}),fixture({group:{external:true}})]){
    await assert.rejects(f.consume());assert.equal(f.lists().length,0);assert.equal(f.roots().length,0)
  }
  for(const rootRows of [[],[row(root,at-10,'wrong group',{chat_id:'oc_else'})]]) {
    const missing=fixture({rootRows,list:()=>page([plain('om_r',at+1,'reply without root')])})
    await assert.rejects(missing.consume(),/根消息/);assert.deepEqual(missing.events,[])
  }
  const expanded=fixture({target:{...top,thread_id:omt},list:()=>page([row('om_many',at+1,'@_user_1 '.repeat(4200),
    {thread_id:omt,root_id:messageId,mentions:[{key:'@_user_1',name:'x'.repeat(80)}]})])})
  await assert.rejects(expanded.consume(),/过大/);assert.deepEqual(expanded.events,[])
  const encoded=fixture({target:{...top,thread_id:omt},list:()=>page([row('om_long',at+1,'\\'.repeat(140000),{thread_id:omt,root_id:messageId})])})
  await assert.rejects(encoded.consume(),/过大/);assert.deepEqual(encoded.events,[])
  for(const list of [()=>page([],'loop'),()=>{throw new Error('offline')},()=>({items:[],has_more:true}),()=>page([plain('om_large',at-1,'x'.repeat(262145))])]) {
    const f=fixture({rootRows:[row(root,at-10,'root',{thread_id:omt})],list})
    await assert.rejects(f.consume(),{code:'source-unavailable'});assert.deepEqual(f.events,[])
  }
})

