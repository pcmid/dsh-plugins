import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createFeishuSource} from '../host/feishu.js'

const api='/open-apis/im/v1/messages', mapping='/open-apis/im/v1/chat_p2p/batch_query'
const recipientId='ou_me', requesterId='ou_requester', tenantId='tenant', chatId='oc_source', threadId='om_original', omt='omt_verified'
const messageId=threadId, questionId='om_question', privateSince=50, since=10, forbidden='not-for-this-question'
const ok=data=>({ok:true,identity:'user',data})
const mk=(id,senderId,at,text,patch={})=>({message_id:id,chat_id:chatId,create_time:String(at),deleted:false,msg_type:'text',
  sender:{sender_type:'user',id_type:'open_id',tenant_key:tenantId,id:senderId},body:{content:JSON.stringify({text})},...patch})
function fixture({privateChat=false,project=false,changed,mutateQuestion,mutateOriginal,validGrant=true,owner=recipientId,parent=questionId}={}) {
  const config={enabled:true,profile:'offline',recipientId,tenantId,automationSince:since,...(privateChat && {allowPrivateChats:true,privateChatsSince:privateSince})}
  const proof=privateChat?{privatePeerId:requesterId,privateChatsSince:privateSince}:{}
  const src={kind:'feishu',tenantId,recipientId,chatId,threadId,scopeId:'a'.repeat(64),...proof}
  const grant={mode:'once',threadId,chatId,approvedAt:59,...proof}
  const original=mk(messageId,requesterId,80,'request',privateChat?{}:{thread_id:omt,mentions:[{id_type:'open_id',id:recipientId,tenant_key:tenantId}]})
  if (privateChat) original.sender.tenant_key='other-tenant'
  const question=mk(questionId,recipientId,100,forbidden,{parent_id:messageId,root_id:threadId,...(!privateChat && {thread_id:omt})})
  const child=(id,who,at,text,patch)=>mk(id,who,at,text,{parent_id:parent,root_id:threadId,...(!privateChat && {thread_id:omt}),...patch})
  const answer=child('om_answer',requesterId,110,'first reply')
  if (privateChat) answer.sender.tenant_key='other-tenant'
  mutateOriginal?.(original);mutateQuestion?.(question)
  const page1=[child('om_other','ou_other',101,forbidden),child('om_unrelated',requesterId,102,forbidden,{parent_id:messageId}),
    child('om_foreign',requesterId,103,forbidden,{chat_id:'oc_else'}),child('om_stale',requesterId,99,forbidden),
    child('om_deleted',requesterId,104,forbidden,{deleted:true}),child('om_fwd',requesterId,105,forbidden,{upper_message_id:'om_forward'}),
    child('om_wrongroot',requesterId,106,forbidden,{root_id:'om_other_root'})]
  if(!privateChat) page1.push(child('om_sibling',requesterId,108,forbidden,{thread_id:'omt_sibling'}))
  const calls=[],pages=[]
  let locked=false, running=true
  const live=()=>{if(!running)throw Object.assign(Error('disposed'),{code:'scope-changed'})}
  const source=createFeishuSource({config,check:live,admission:{async run(scope,fn){
    assert.deepEqual(scope,{chatId,threadId});locked=true
    try{return await fn(grant)}finally{locked=false}
  }},receive:()=>assert.fail('a clarification must not dispatch new work'),run:async argv=>{
    assert.ok(locked)
    calls.push(argv)
    const has=s=>argv.includes(s),arg=k=>argv[argv.indexOf(k)+1]
    const output=(data,check=false)=>{
      if(!project || !has('--jq'))return ok(data)
      const out=execFileSync('jq',['-c',arg('--jq')],{input:JSON.stringify(ok(data)),encoding:'utf8'})
      if(check) assert.ok(!out.includes(forbidden),'unrelated body crossed the CLI projection')
      return JSON.parse(out)
    }
    if(has('+get-user'))return output({user:{open_id:owner,tenant_key:tenantId}})
    if(has('auth'))return privateChat ? {ok:true,missing:[],granted:['im:message.p2p_msg:get_as_user']} :
      {ok:false,missing:['im:message.p2p_msg:get_as_user'],granted:[]}
    if(has('chats'))return output({chat_mode:'group',group_message_type:'chat',external:false,tenant_key:tenantId})
    if(has(mapping)) {
      const [id]=JSON.parse(arg('--data')).chatter_ids
      return output({p2p_chats:[{chat_id:id===recipientId?'oc_self':chatId,chatter_id1:recipientId,chatter_id2:id}]})
    }
    if(has(api+'/'+messageId))return output({items:[original]})
    if(has(api+'/'+questionId))return output({items:[question]},true)
    assert.ok(has(api) && has('GET'))
    const params=JSON.parse(arg('--params'));pages.push(params)
    assert.equal(params.container_id_type,privateChat?'chat':'thread')
    assert.equal(params.container_id,privateChat?chatId:omt)
    assert.equal(params.sort_type,'ByCreateTimeAsc')
    if(privateChat)assert.equal(params.start_time,'0')
    changed?.({config,dispose:()=>running=false})
    if(!arg('--jq').includes('.parent_id=='+JSON.stringify(questionId))) {
      assert.ok(!privateChat)
      return output({items:[original,{...question,body:{content:'{"text":"sent question"}'}},answer,
        child('om_comment','ou_colleague',105,'subsequent bystander note')],has_more:false},true)
    }
    return params.page_token==='next' ? output({items:[answer,child('om_later',requesterId,120,'later')],has_more:false},true) :
      output({items:page1,has_more:true,page_token:'next'},true)
  }})
  const input={source:src,messageId,requesterId,questionId,originalText:'archived original'}
  return {input,source,config,pages,calls,read:(params=input)=>source.readQuestionReply(params,g=>{
    assert.ok(locked);assert.equal(g,grant)
    if(!validGrant)throw Object.assign(Error('old grant'),{code:'admission-denied'})
  })}
}

test('native thread and flat peer DM: read only the earliest direct reply from the original human; no @ needed',async t=>{
  let jq=true
  try{execFileSync('jq',['--version'])}catch(e){if(e.code==='ENOENT')jq=false;else throw e}
  for(const privateChat of [false,true]) for(const project of jq?[false,true]:[false]) {
    const f=fixture({privateChat,project})
    const {workerContext,...reply}=await f.read()
    assert.deepEqual(reply,{chatId,threadId,messageId:'om_answer',senderId:requesterId,parentId:questionId,at:110,text:'first reply'})
    if(privateChat)assert.equal(workerContext,undefined)
    else assert.deepEqual(JSON.parse(workerContext),[
      {speaker:'requester',at:80,text:'archived original',request:true},{speaker:'owner',at:100,text:'sent question'},
      {speaker:'participant-1',at:105,text:'subsequent bystander note'},{speaker:'requester',at:110,text:'first reply'},
    ])
    assert.equal(f.pages.length,privateChat?2:3)
  }
  if(!jq)t.diagnostic('no jq installed; Host unprojected-response boundary covered')
})

test('receipt proof, original requester and exact parent must agree before a response can resume anything',async()=>{
  for(const mutateQuestion of [r=>r.sender.id='ou_other',r=>r.parent_id='om_other',r=>r.root_id='om_else',r=>r.deleted=true,r=>r.create_time='60']){
    const f=fixture({mutateQuestion});assert.equal(await f.read(),null);assert.equal(f.pages.length,0)
  }
  for(const mutateOriginal of [r=>r.sender.id='ou_other',r=>r.mentions=[],r=>r.deleted=true,r=>r.create_time='58']) {
    const f=fixture({mutateOriginal});assert.equal(await f.read(),null);assert.equal(f.pages.length,0)
  }
  const f=fixture({parent:'om_not_question'});assert.equal(await f.read(),null);assert.equal(f.pages.length,2,'no full-thread reads on an empty waiting poll')
})

test('stale grant, identity, private switch, private generation or disposal stop the targeted read',async()=>{
  const revoked=fixture({validGrant:false})
  await assert.rejects(revoked.read());assert.equal(revoked.calls.length,0)
  const stale=fixture({privateChat:true});stale.config.privateChatsSince=privateSince+10
  await assert.rejects(stale.read());assert.equal(stale.calls.length,0)
  const wrong=fixture({owner:'ou_changed'});await assert.rejects(wrong.read());assert.equal(wrong.pages.length,0)
  for(const changed of [({config})=>config.allowPrivateChats=false,({dispose})=>dispose()]){
    const f=fixture({privateChat:true,changed});await assert.rejects(f.read());assert.equal(f.pages.length,1)
  }
})
