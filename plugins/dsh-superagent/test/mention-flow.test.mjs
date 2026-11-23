import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFeishuSource } from '../host/feishu.js'
import { createLoop } from '../host/loop.js'
import { fileMarker } from '../host/mention-text.js'

// Modeled on a real conversation: the request quoted an older message in a group without topics, and
// SuperAgent's in-thread question then started a native thread rooted at that request.
const api='/open-apis/im/v1/messages', chatId='oc_group', tenantId='tenant', me='ou_me', requester='ou_requester'
const quoted='om_quoted_root', request='om_request', question='om_question', file='om_log_file', follow='om_follow', omt='omt_started'
const at=1_800_000_000_000
const ok=data=>({ok:true,identity:'user',data})
const direct=[{id:me,id_type:'open_id',tenant_key:tenantId,key:'@_user_1',name:'雷格'}]
const human=id=>({sender_type:'user',id_type:'open_id',id,tenant_key:tenantId})
const text=(message_id,t,body,patch={})=>({message_id,chat_id:chatId,create_time:String(at+t),deleted:false,msg_type:'text',sender:human(requester),
  body:{content:JSON.stringify({text:body})},...patch})
const inThread={thread_id:omt,root_id:request,parent_id:request}
const requestRow=text(request,0,'@_user_1 需要看一下这类 error 的含义',{root_id:quoted,parent_id:'om_quoted_reply',thread_id:omt,mentions:direct})
const questionRow=text(question,10,'请按错误类型各贴一条日志',{...inThread,sender:human(me)})
const fileRow={...text(file,20,'',inThread),msg_type:'file',body:{content:JSON.stringify({file_key:'file_v3_sample',file_name:'样例 [失败].xlsx'})}}
const followRow=text(follow,21,'@_user_1',{...inThread,mentions:direct})
const flag=(argv,key)=>argv[argv.indexOf(key)+1]

function dryRun(t) {
  const home=mkdtempSync(join(tmpdir(),'sa-flow-jq-'))
  t.after(()=>rmSync(home,{recursive:true,force:true}))
  const env={HOME:home,PATH:process.env.PATH,LARKSUITE_CLI_CONFIG_DIR:home,LARKSUITE_CLI_APP_ID:'cli_offline_fixture',
    LARKSUITE_CLI_APP_SECRET:'fixture',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}
  const invoke=args=>execFileSync('lark-cli',args,{env,cwd:home,encoding:'utf8',timeout:10_000})
  try {invoke(['--version'])} catch(e) {if(e.code==='ENOENT') {t.skip('no system CLI');return} throw e}
  return (argv,data)=>{
    const args=[...argv,'--dry-run'], i=args.indexOf('--jq')
    assert.ok(i>0)
    args[i+1]='.data='+JSON.stringify(data)+'|('+args[i+1]+')'
    return {...JSON.parse(invoke(args)),dry_run:false}
  }
}

function source({rows,grant,project=(_argv,data)=>ok(data),sent=[]}) {
  const calls=[],events=[]
  const config={enabled:true,profile:'fixture',tenantId,recipientId:me,automationSince:at-1000,historyCount:0}
  const byId=new Map(rows.map(r=>[r.message_id,r]))
  const s=createFeishuSource({config,admission:{run:(_target,fn)=>fn(grant)},receive:e=>{events.push(e)},
    isSentMessage:(_chat,id)=>sent.includes(id),async run(argv,stdin){
      calls.push(argv)
      const has=x=>argv.includes(x)
      if(has('im:message.p2p_msg:get_as_user')) return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
      if(has('auth')) return {ok:true,granted:flag(argv,'--scope').split(' '),missing:[]}
      if(has('+get-user')) return ok({user:{open_id:me,tenant_key:tenantId}})
      if(has('chats')) return ok({chat_mode:'group',group_message_type:'chat',external:false,tenant_key:tenantId})
      if(has('+messages-reply')) return ok({message_id:'om_sent',chat_id:chatId,stdin})
      if(has(api+'/search')) return project(argv,{items:rows.filter(r=>r.mentions).map(r=>({meta_data:{message_id:r.message_id,chat_id:chatId,is_p2p_chat:false}})),has_more:false})
      if(has(api+'/mget')) return project(argv,{items:JSON.parse(flag(argv,'--params')).message_ids.map(id=>byId.get(id))})
      const one=argv.find(a=>a.startsWith(api+'/om_'))
      if(one) return project(argv,{items:[byId.get(one.slice(api.length+1))].filter(Boolean)})
      const p=JSON.parse(flag(argv,'--params'))
      assert.equal(p.container_id_type,'thread');assert.equal(p.container_id,omt)
      return project(argv,{items:rows.filter(r=>r.thread_id===omt && r.message_id!==request),has_more:false})
    }})
  return {s,calls,events}
}

test('an @ in the thread that SuperAgent’s question started belongs to the request’s discussion and brings the shared file',async t=>{
  const project=dryRun(t)
  for (const projection of [undefined,project].filter((p,i)=>i===0 || p)) {
    const grant={mode:'once',chatId,threadId:request,approvedAt:at+15}
    const f=source({rows:[requestRow,questionRow,fileRow,followRow],grant,...projection && {project:projection},sent:[question]})
    // The follow-up is found by its @ and named by the request its thread grew from, not by the quoted message.
    const {mentions}=await f.s.discover({since:at+15,until:at+30})
    assert.deepEqual(mentions,[{chatId,threadId:request,messageId:follow,at:at+21,senderId:requester}])
    assert.deepEqual(await f.s.consumeMention(mentions[0]),{accepted:1})
    const [event]=f.events
    assert.equal(event.threadId,request)
    const marker=fileMarker('file_v3_sample','样例 [失败].xlsx')
    // Brackets in a file name cannot fake or break a marker.
    assert.match(marker,/^\[文件 样例 失败 \.xlsx #[0-9a-f]{6}\]$/)
    assert.deepEqual(JSON.parse(event.workerContext).map(r=>[r.speaker,r.text]),[
      ['requester','@雷格 需要看一下这类 error 的含义'],['owner','请按错误类型各贴一条日志'],['requester',marker],['requester','@雷格']])
    assert.deepEqual(event.workerFiles,[{messageId:file,key:'file_v3_sample',name:'样例 失败 .xlsx',at:at+20}])
  }
})

test('only an @ starts work: a file or a plain reply to the question is context, never a mention',async()=>{
  const grant={mode:'once',chatId,threadId:request,approvedAt:at+15}
  const plainReply=text('om_plain_reply',22,'日志在上面',{...inThread,parent_id:question})
  const f=source({rows:[requestRow,questionRow,fileRow,plainReply],grant,sent:[question]})
  // Search asks Feishu for @ mentions only; rows without one never reach discovery.
  assert.deepEqual((await f.s.discover({since:at+15,until:at+30})).mentions,[])
  assert.deepEqual(JSON.parse(flag(f.calls.find(a=>a.includes(api+'/search')),'--data')).filter.at_chatter_ids,[me])
})

test('a reply can still reach a request that later became a thread root, and an old record keeps its quoted discussion',async()=>{
  // The request now has a thread and still carries the root of the message it quoted.
  const grant={mode:'once',chatId,threadId:request,approvedAt:at-1}
  const f=source({rows:[requestRow],grant})
  const delivered=await f.s.reply({source:{kind:'feishu',tenantId,recipientId:me,chatId,threadId:request},messageId:request,
    text:'结论',idempotencyKey:'sa-key',requesterId:requester})
  assert.deepEqual(delivered,{chatId,messageId:'om_sent',inReplyTo:request})
  assert.ok(f.calls.find(a=>a.includes('+messages-reply')).includes('--reply-in-thread'))
  // Recorded before the rule changed, a flat quoting request was named by the quoted root; that name still verifies.
  const flat={...requestRow,thread_id:undefined}
  const old=source({rows:[flat],grant:{...grant,threadId:quoted}})
  const ref={chatId,threadId:quoted,messageId:request,at}
  assert.equal((await old.s.readMention(ref)).threadId,quoted)
  // A name it never had does not.
  assert.equal(await old.s.readMention({...ref,threadId:'om_unrelated'}),null)
  // Discovered fresh, the same flat request is its own discussion.
  assert.equal((await old.s.discover({since:at-1,until:at+1})).mentions[0].threadId,request)
})

const team={lead:'router',develop:'coder',answer:'analyst'}
const base=(scopeId,messageId,threadId,patch={})=>({caseId:'case_'+messageId,messageId,text:'text of '+messageId,requesterId:requester,team,roleModels:{},
  source:{kind:'feishu',scopeId,tenantId,recipientId:me,chatId,threadId},...patch})

test('a follow-up approved under its own grant still finds the waiting request and hands over its file',async()=>{
  let disk
  const routed=[], worked=[]
  const loop=createLoop({load:()=>structuredClone(disk),save:s=>{disk=structuredClone(s)},isReleaseRequired:()=>false,
    caseInfo:async(caseId,messageId)=>({archived:false,text:'case '+messageId,caseId}),
    decide:b=>{routed.push(b.openWork);return b.openWork ? {action:'merge',target:'w1'} : {action:'work',role:'answer'}},
    work:b=>{worked.push(b);return {sessionId:'worker',workspaceId:'ws',resolvedPresetId:'analyst',
      ...worked.length===1 ? {question:'请贴一条日志'} : {answer:'是上游超时'}}},
    deliver:({source,messageId})=>({chatId:source.chatId,messageId:'om_sent_'+messageId,inReplyTo:messageId})})
  // Recorded under the earlier rule: the waiting request is named by the message it quoted.
  await loop.enqueue(base('a'.repeat(64),request,quoted));await loop.drain()
  assert.equal((await loop.snapshot())[0].status,'waiting-requester')
  const files=[{messageId:file,key:'file_v3_sample',name:'样例.xlsx',at:at+20}]
  await loop.enqueue(base('b'.repeat(64),follow,request,{text:'@雷格',workerFiles:files}));await loop.drain()
  assert.deepEqual(routed[1],[{ref:'w1',request:'text of '+request,state:'waiting for the requester',output:'请贴一条日志'}])
  const rows=await loop.snapshot()
  assert.deepEqual(rows.map(r=>r.status),['delivered','merged'])
  assert.deepEqual(worked[1].supplements,[{text:'@雷格',from:'requester'}])
  assert.deepEqual(worked[1].workerFiles,files)
  assert.equal(worked[1].continueWork,true)
  // A message from another chat is never offered as related work.
  await loop.enqueue(base('b'.repeat(64),'om_elsewhere',request,{source:{...base('b'.repeat(64),'x',request).source,chatId:'oc_else'}}));await loop.drain()
  assert.equal(routed[2],undefined)
})
