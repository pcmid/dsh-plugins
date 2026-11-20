import test from 'node:test'
import assert from 'node:assert/strict'
import {createFeishuSource,hasFeishuIdentity} from '../host/feishu.js'
import {createAdmission} from '../host/admission.js'

const config = {enabled:true,profile:'fixture',tenantId:'tenant',recipientId:'ou_person'}
const chatId = 'oc_test', root = 'om_root', topic = 'omt_one'
const ok = data => ({ok:true,identity:'user',data})
const user = ok({user:{open_id:'ou_person',tenant_key:'tenant'}}), group = ok({chat_mode:'group',external:false,tenant_key:'tenant'})
const msg = (patch = {}) => ({message_id:root,chat_id:chatId,thread_id:topic,create_time:'1',msg_type:'text',
  deleted:false,sender:{sender_type:'user',id_type:'open_id',id:'ou_requester',tenant_key:'tenant'},
  mentions:[{id_type:'open_id',id:'ou_person',tenant_key:'tenant'}],body:{content:'{"text":"@_user_1 请求核对"}'},...patch})
const flag = (argv,key) => argv[argv.indexOf(key)+1]

async function setup(responses = [], {mode='permanent',options=config,trigger,now=2} = {}) {
  const calls = [],received = []
  let persisted
  const feed = new Map()
  const admission = createAdmission({scope:config,consentSince:options.automationSince,load:async()=>persisted,save:async(_k,row)=>{persisted = row},now:()=>now,
    mentions:async()=>({get:k=>feed.get(k),put:async(k,v)=>feed.set(k,structuredClone(v)),entries:()=>feed.entries()})})
  if (trigger) await admission.observe(trigger,options.automationSince)
  else await admission.update({action:'register',chatId,threadId:root})
  if (mode !== 'pending') await admission.update({action:mode,chatId,threadId:root})
  const source = createFeishuSource({config:options,admission,
    receive:async event=>{received.push(event)},run:async(argv,stdin)=>{
      if (argv.includes('im:message.p2p_msg:get_as_user')) return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
      calls.push({argv,stdin})
      assert.equal(argv[0],'--profile');assert.equal(argv[1],'fixture');if(!argv.includes('check')) assert.equal(flag(argv,'--as'),'user')
      if (!responses.length) throw new Error('Unexpected CLI invocation')
      return responses.shift()
    }})
  return {source,received,calls,admission}
}

test('disabled/unconfigured initialization and status never open the CLI; no read before admission',async()=>{
  for (const options of [{}, {...config,profile:'--profile'}, {...config,recipientId:'not-an-open-id'}]) {
    const {source,calls} = await setup([],{options})
    assert.equal(hasFeishuIdentity(options),false)
    assert.equal(source.status().canReply,false)
    await assert.rejects(source.sync({chatId}))
    assert.deepEqual(calls,[])
  }
  const {source,calls,admission} = await setup([],{mode:'pending'})
  assert.equal(source.status().state,'unverified')
  await assert.rejects(source.sync({chatId}),{code:'admission-denied'})
  await admission.update({action:'once',chatId,threadId:root})
  for (const scope of [{chatId},{chatId,threadId:'om_other'},{chatId,threadId:topic},{chatId:'oc_test,oc_else'}]) {
    await assert.rejects(source.sync(scope))
  }
  assert.deepEqual(calls,[])
})

test('verify actual user and tenant and internal group before looking up message content',async()=>{
  for (const [responses,count] of [
    [[{...user,identity:'bot'}],1],
    [[ok({user:{open_id:'ou_else',tenant_key:'tenant'}})],1],
    [[ok({user:{open_id:'ou_person',tenant_key:'other'}})],1],
    [[user,ok({chat_mode:'p2p',external:false})],2],
    [[user,ok({chat_mode:'group',external:true})],2],
  ]) {
    const {source,calls} = await setup(responses)
    await assert.rejects(source.sync({chatId}))
    assert.equal(calls.length,count)
    assert.equal(source.status().state,'error')
  }
})

test('group search is constrained upstream, then rechecked using raw IDs; text is not an @',async()=>{
  const unsafe = [
    {chat_id:'oc_else'}, {sender:{...msg().sender,tenant_key:'else'}},
    {sender:{...msg().sender,id:'ou_person'},mentions:[]},  {sender:{...msg().sender,sender_type:'app'}},
    {mentions:[{...msg().mentions[0],id_type:'app_id'}]}, {mentions:[{...msg().mentions[0],id:'all'}]},
    {mentions:[]}, {mentions:[{...msg().mentions[0],tenant_key:'else'}]}, {deleted:true}, {upper_message_id:'om_merged'},
    {msg_type:'interactive'}, {parent_id:'om_direct',root_id:''},
  ].map((patch,i)=>msg({message_id:'om_'+i,...patch}))
  const reply = msg({message_id:'om_reply',root_id:root,create_time:'2'})
  const allowed = [msg(),reply,...unsafe]
  const hits = ok({items:allowed.map(m=>({meta_data:{message_id:m.message_id}})),has_more:true,page_token:'p2'})
  const {source,received,calls} = await setup([user,group,hits,ok({items:[reply,...allowed,msg({message_id:'om_not_selected'})]})])
  const res = await source.sync({chatId})
  assert.equal(res.accepted,2);assert.equal(res.status.canReply,false);assert.match(res.status.detail,/一页/)
  assert.deepEqual(received.map(x=>x.messageId),[root,'om_reply'])
  assert.deepEqual(received[1],{tenantId:'tenant',recipientId:'ou_person',chatId,threadId:root,messageId:'om_reply',
    senderId:'ou_requester',text:'@_user_1 请求核对'})
  assert.equal(calls.length,4)
  assert.deepEqual(JSON.parse(flag(calls[2].argv,'--data')).filter,
    {chat_ids:[chatId],chat_type:'group',from_types:['user'],at_chatter_ids:['ou_person']})
  assert.deepEqual(JSON.parse(flag(calls[3].argv,'--params')).message_ids,allowed.map(x=>x.message_id))
})

test('one-topic grant resolves the approved root first, then reads only its provider container',async()=>{
  const child = msg({message_id:'om_r',root_id:root})
  const {source,calls,received} = await setup([user,group,ok({items:[msg()]}),ok({items:[
    child,msg({message_id:'om_else',root_id:'om_other'}),msg({message_id:'om_bad',chat_id:'oc_else',root_id:root}),
    msg({message_id:'om_else_topic',thread_id:'omt_other',root_id:root}),msg(),
  ]})],{mode:'once'})
  assert.equal((await source.sync({chatId,threadId:root})).accepted,2)
  assert.deepEqual(received.map(m=>m.messageId),[root,'om_r'])
  assert.ok(calls[2].argv.includes('/open-apis/im/v1/messages/'+root))
  assert.deepEqual(JSON.parse(flag(calls[3].argv,'--params')),{container_id_type:'thread',container_id:topic,
    sort_type:'ByCreateTimeDesc',page_size:50,user_id_type:'open_id'})
  assert.ok(calls.every(c=>!c.argv.includes('POST')))
})

test('wrong group/root/tenant does not expand or persist the single-message lookup',async()=>{
  for (const other of [msg({chat_id:'oc_other'}),msg({root_id:'om_else'}),msg({sender:{...msg().sender,tenant_key:'else'}})]) {
    const {source,calls,received} = await setup([user,group,ok({items:[other]})],{mode:'once'})
    await assert.rejects(source.sync({chatId,threadId:root}),/根消息/)
    assert.equal(calls.length,3)
    assert.deepEqual(received,[])
  }
})

const grants={ok:true,missing:null,granted:['im:message.send_as_user','im:message']}
const delivery = {messageId:root,text:'@./never-read-from-disk',idempotencyKey:'private-intent-id',
  source:{kind:'feishu',tenantId:'tenant',recipientId:'ou_person',chatId,threadId:root}}

test('reply is separately authorized, scoped to the stored source, checked against a real receipt',async()=>{
  const options = {...config,automationSince:1}
  for (const [opts,request] of [[config,delivery],[{...config,allowReply:true},delivery],[options,{...delivery,text:'<at user_id="all">@ALL</at>'}],
    [options,{...delivery,source:{...delivery.source,tenantId:'other'}}]]) {
    const {source,calls} = await setup([],{options:opts})
    await assert.rejects(source.reply(request));assert.deepEqual(calls,[])
  }
  const revoked = await setup([],{options,mode:'pending'})
  await assert.rejects(revoked.source.reply(delivery),{code:'admission-denied'})
  assert.deepEqual(revoked.calls,[])
  for (const missing of [{ok:false,missing:['im:message']},{...grants,granted:[]}, {...grants,missing:['im:message']}]) {
    const {source,calls}=await setup([user,group,missing],{mode:'once',options})
    await assert.rejects(source.reply(delivery));assert.equal(calls.length,3)
    assert.ok(calls.every(c=>!c.argv.includes('+messages-reply')))
  }
  for (const response of [ok({}),ok({message_id:'om_new',chat_id:'oc_else'}),
    {...ok({message_id:'om_new',chat_id:chatId}),dry_run:true},
    {...ok({message_id:'om_new',chat_id:chatId}),identity:'bot'},ok({message_id:root,chat_id:chatId})]) {
    const {source,calls} = await setup([user,group,grants,ok({items:[msg({create_time:'3'})]}),response],{mode:'once',options})
    await assert.rejects(source.reply(delivery),{code:'delivery-uncertain'})
    assert.equal(calls.length,5) // Uncertain send is not retried.
  }
  const {source,calls} = await setup([user,group,grants,ok({items:[msg({create_time:'3'})]}),ok({message_id:'om_new',chat_id:chatId})],{mode:'once',options})
  assert.deepEqual(await source.reply(delivery),{chatId,messageId:'om_new',inReplyTo:root})
  const {argv,stdin} = calls.at(-1)
  assert.equal(flag(argv,'--content'),'-');assert.equal(flag(argv,'--message-id'),root)
  assert.ok(argv.includes('--reply-in-thread'));assert.equal(flag(argv,'--idempotency-key'),delivery.idempotencyKey)
  assert.equal(JSON.parse(stdin).text,delivery.text);assert.ok(!argv.includes(delivery.text))
})

const options={...config,automationSince:10,historyCount:0}
const trigger={chatId,threadId:root,messageId:'om_trigger',at:11}
// Discovery and reads carry the verified author; the CLI's sender, never the caller, supplies it.
const sent={...trigger,senderId:'ou_requester'}
const first=msg({root_id:root,message_id:trigger.messageId,create_time:'11'})
const approved={options,trigger,now:20,mode:'once'}
const threadContext=()=>[ok({items:[msg()]}),ok({items:[],has_more:false})]
const hits=items=>ok({items:items.map(m=>({meta_data:{message_id:m.message_id,chat_id:m.chat_id ?? chatId,is_p2p_chat:m.chat_id==='oc_p2p'}})),has_more:false})

test('discover returns only direct mentions across eligible groups and only their metadata',async()=>{
  const second=msg({chat_id:'oc_two',message_id:'om_two',create_time:'13'})
  const items=[second,first,msg({message_id:'om_extra',root_id:root,create_time:'14'}),first,...[
    {create_time:'10'}, {create_time:'16'}, {create_time:'invalid'}, {mentions:[]}, {mentions:[{...first.mentions[0],id:'all'}]},
    {mentions:[{...first.mentions[0],tenant_key:'other'}]}, {mentions:[{...first.mentions[0],id_type:'app_id'}]},
    {sender:{...first.sender,id:'ou_person'},mentions:[]},  {sender:{...first.sender,sender_type:'app'}}, {sender:{...first.sender,tenant_key:'other'}},
    {upper_message_id:root}, {root_id:null,parent_id:'om_unproven'}, {deleted:true}, {msg_type:'interactive'}, {chat_id:'invalid'},
    {chat_id:'oc_external'}, {chat_id:'oc_p2p'}, {chat_id:'oc_foreign'},
  ].map((patch,i)=>({...first,message_id:'om_ignore_'+i,...patch}))]
  const page=hits(items)
  page.data.has_more=true;page.data.page_token='next'
  const {source,calls,received}=await setup([user,page,ok({items:[...items,msg({message_id:'om_injected'})]}),
    ok({...group.data,chat_mode:'topic',name:'群二'}),group,ok({...group.data,external:true}),
    ok({...group.data,tenant_key:'other'})],{options,mode:'pending'})
  assert.equal(source.listGroups,undefined);assert.equal(source.verifyCandidate,undefined)
  assert.deepEqual(await source.discover({since:10,until:15,pageToken:'prev'}),{mentions:[
    sent,{chatId:'oc_two',threadId:'om_two',messageId:'om_two',at:13,name:'群二',senderId:'ou_requester'},
    {...sent,messageId:'om_extra',at:14}],nextPageToken:'next'})
  assert.deepEqual(received,[])
  assert.deepEqual(JSON.parse(flag(calls[1].argv,'--params')),{page_size:50,page_token:'prev'})
  assert.deepEqual(JSON.parse(flag(calls[1].argv,'--data')),{query:'',filter:{chat_type:'group',from_types:['user'],
    at_chatter_ids:['ou_person'],time_range:{start_time:'1970-01-01T00:00:00Z',end_time:'1970-01-01T00:00:01Z'}}})
  assert.deepEqual(calls.slice(3).map(c=>flag(c.argv,'--chat-id')),['oc_two',chatId,'oc_external','oc_foreign'])
})

test('an explicit self-mention enters the feed, but only its grant permits processing and a plain-text reply',async()=>{
  const own={...first,sender:{...first.sender,id:config.recipientId}}
  const textOnly={...own,message_id:'om_plain',mentions:[],body:{content:'{"text":"@本人 不是结构化提及"}'}}
  const candidates=[own,textOnly,{...own,message_id:'om_all',mentions:[{...own.mentions[0],id:'all'}]},
    {...own,message_id:'om_bot',sender:{...own.sender,sender_type:'app'}},{...own,message_id:'om_p2p',chat_id:'oc_p2p'}]
  const responses=[user,hits(candidates),ok({items:candidates}),group,user,group,ok({items:[own]})]
  const f=await setup(responses,{...approved,mode:'pending'}), req={...delivery,messageId:own.message_id}
  assert.deepEqual(await f.source.discover({since:10,until:15}),{mentions:[{...trigger,senderId:config.recipientId,ownerSelfMention:true}]})
  assert.deepEqual(await f.source.readMention(trigger),{...trigger,senderId:config.recipientId,text:JSON.parse(own.body.content).text,ownerSelfMention:true})
  await assert.rejects(f.source.consumeMention(trigger),{code:'admission-denied'})
  await assert.rejects(f.source.reply(req),{code:'admission-denied'})
  assert.equal(f.received.length,0);assert.equal(responses.length,0)
  await f.admission.update({action:'once',chatId,threadId:root})
  responses.push(user,group,ok({items:[own]}),...threadContext())
  assert.deepEqual(await f.source.consumeMention(trigger),{accepted:1});assert.equal(f.received[0].senderId,config.recipientId)
  await assert.rejects(f.source.reply({...req,text:'<at user_id="ou_person">本人</at>'}))
  responses.push(user,group,grants,ok({items:[{...own,mentions:[]}]}))
  await assert.rejects(f.source.reply(req),{code:'source-unavailable'})
  assert.ok(!f.calls.some(c=>c.argv.includes('+messages-reply')))
  responses.push(user,group,grants,ok({items:[own]}),ok({message_id:'om_out',chat_id:chatId}))
  assert.deepEqual(await f.source.reply(req),{messageId:'om_out',chatId,inReplyTo:own.message_id})
  const {argv,stdin}=f.calls.at(-1)
  assert.equal(flag(argv,'--msg-type'),'text');assert.equal(flag(argv,'--message-id'),own.message_id)
  assert.deepEqual(JSON.parse(stdin),{text:req.text});assert.equal(responses.length,0)
})

test('a departed or ineligible chat cannot block discovery in the next group',async()=>{
  const gone={...first,chat_id:'oc_old',message_id:'om_old'}, items=[gone,first]
  for(const result of [{ok:false,error:{code:232011}},ok({...group.data,chat_status:'dissolved'})]) {
    const f=await setup([user,hits(items),ok({items}),result,group],{options,mode:'pending'})
    assert.deepEqual(await f.source.discover({since:10,until:15}),{mentions:[sent]})
  }
  const f=await setup([user,hits(items),ok({items}),{ok:false,error:{code:9999}}],{options})
  await assert.rejects(f.source.discover({since:10,until:15}),{code:'source-unavailable'})
})

test('empty pages progress by cursor; unverified self, consent and bad cursors fail closed',async()=>{
  const {source,calls}=await setup([],{options:config})
  await assert.rejects(source.discover({since:10,until:15}));assert.deepEqual(calls,[])
  for(const params of [{since:9,until:15},{since:20,until:10},{since:10,until:15,pageToken:' '}]) {
    const f=await setup([],{options})
    await assert.rejects(f.source.discover(params));assert.deepEqual(f.calls,[])
  }
  const f=await setup([ok({user:{open_id:'ou_else',tenant_key:'tenant'}})],{options})
  await assert.rejects(f.source.discover({since:10,until:15}));assert.equal(f.calls.length,1)
  for(const page of [ok({items:[],has_more:true,page_token:'prev'}),ok({items:[],has_more:true}),
    hits([{message_id:'wrong_id'}])]) {
    const f=await setup([user,page],{options})
    await assert.rejects(f.source.discover({since:10,until:15,pageToken:'prev'}));assert.equal(f.calls.length,2)
  }
  const empty=await setup([user,ok({items:[],has_more:true,page_token:'p2'})],{options})
  assert.deepEqual(await empty.source.discover({since:10,until:15}),{mentions:[],nextPageToken:'p2'})
})

test('legacy group name lookup checks the binding and one exact group; never lists groups or reads messages',async()=>{
  for(const [data,name] of [[{...group.data,name:'  私有群  '},'私有群'],[{...group.data,name:' '},null],
    [{...group.data,name:'私聊',chat_mode:'p2p'},null],[{...group.data,name:'外群',external:true},null],
    [{...group.data,name:'不属于当前租户',tenant_key:'other'},null]]) {
    const f=await setup([user,ok(data)],{options})
    assert.equal(await f.source.groupName(chatId),name)
    assert.deepEqual(f.calls.map(c=>c.argv.slice(2,4)),[['contact','+get-user'],['im','chats']])
    assert.ok(f.calls[1].argv.includes('get'));assert.equal(flag(f.calls[1].argv,'--chat-id'),chatId)
    assert.deepEqual(f.received,[])
  }
  for (const [opts,id] of [[config,chatId],[options,chatId+',oc_other']]) {
    const f=await setup([],{options:opts})
    await assert.rejects(f.source.groupName(id));assert.deepEqual(f.calls,[])
  }
  const mismatch=await setup([ok({user:{open_id:'ou_other',tenant_key:'tenant'}})],{options})
  await assert.rejects(mismatch.source.groupName(chatId));assert.equal(mismatch.calls.length,1)
})

test('feed can read a verified direct mention before approval without granting, receiving or replying',async()=>{
  const result=await setup([user,ok({...group.data,name:'系统群名'}),ok({items:[first]})],{options,mode:'pending'})
  const before=await result.admission.list()
  assert.deepEqual(await result.source.readMention({...trigger,name:'untrusted',text:'untrusted',senderId:'ou_untrusted'}),{...sent,name:'系统群名',text:'@_user_1 请求核对'})
  assert.deepEqual(result.received,[]);assert.deepEqual(await result.admission.list(),before)
  await assert.rejects(result.source.consumeMention(trigger),{code:'admission-denied'})
  await assert.rejects(result.source.reply({...delivery,messageId:trigger.messageId}),{code:'admission-denied'})
  assert.equal(result.calls.length,3)

  for(const other of [{...first,deleted:true},{...first,root_id:'om_else'},{...first,message_id:'om_else'},
    {...first,chat_id:'oc_else'},{...first,create_time:'12'},{...first,mentions:[]},{...first,mentions:[{...first.mentions[0],id:'all'}]},
    {...first,sender:{...first.sender,sender_type:'app'}},{...first,sender:{...first.sender,tenant_key:'other'}},{...first,msg_type:'merge_forward'}]) {
    const f=await setup([user,group,ok({items:[other]})],{options,mode:'pending'})
    assert.equal(await f.source.readMention(trigger),null);assert.deepEqual(f.received,[])
  }
  for(const otherGroup of [{...group.data,tenant_key:'other'},{...group.data,external:true},{...group.data,chat_mode:'p2p'}]) {
    const f=await setup([user,ok(otherGroup)],{options,mode:'pending'})
    assert.equal(await f.source.readMention(trigger),null);assert.equal(f.calls.length,2)
  }
  const stale=await setup([],{options,mode:'pending'}),readonly=await setup([],{mode:'pending'})
  assert.equal(await stale.source.readMention({...trigger,at:options.automationSince}),null)
  await assert.rejects(readonly.source.readMention(trigger));assert.deepEqual(readonly.calls,[]);assert.deepEqual(stale.calls,[])
})

test('rich posts use the received paragraphs and the actual mention IDs, never download attachments',async()=>{
  const row={...first,msg_type:'post',mentions:[{...first.mentions[0],key:'@_user_1',name:'本人'}],
    body:{content:JSON.stringify({title:'标题',content:[
      [{tag:'at',user_id:'@_user_1'},{tag:'text',text:' 看这里：'},{tag:'a',text:'例子',href:'https://example.invalid'}],
      [{tag:'code_block',text:'let x=42'}],[{tag:'img',image_key:'private image'}]],
      files:[{file_key:'private attachment'}]})}}
  const expected='标题\n@本人 看这里：[例子](https://example.invalid)\nlet x=42'
  const f=await setup([user,hits([row]),ok({items:[row]}),group,user,group,ok({items:[row]})],{options,mode:'pending'})
  assert.deepEqual((await f.source.discover({since:10,until:15})).mentions,[sent])
  assert.deepEqual(await f.source.readMention(trigger),{...sent,text:expected});assert.deepEqual(f.received,[])
  const approvedPost=await setup([user,group,ok({items:[row]}),...threadContext()],approved)
  assert.deepEqual(await approvedPost.source.consumeMention(trigger),{accepted:1})
  assert.equal(approvedPost.received[0].text,expected)
  for(const patch of [{mentions:[]},{mentions:[{...row.mentions[0],id:'all'}]},{body:{content:'{"content":[{}]}'}}]) {
    const f=await setup([user,group,ok({items:[{...row,...patch}]})],{options,mode:'pending'})
    assert.equal(await f.source.readMention(trigger),null)
  }
})

test('consume rechecks the exact row; terminal changes are skipped; transport failures remain retryable',async()=>{
  const pending=await setup([],{options,mode:'pending'})
  await assert.rejects(pending.source.consumeMention(trigger),{code:'admission-denied'});assert.deepEqual(pending.calls,[])
  const readonly=await setup([])
  await assert.rejects(readonly.source.consumeMention(trigger));assert.deepEqual(readonly.calls,[])
  for(const ref of [{...trigger,at:10},{...trigger,at:12},{...trigger,messageId:'om_impostor'}]) {
    const f=await setup([user,group],approved)
    assert.deepEqual(await f.source.consumeMention(ref),{accepted:0});assert.equal(f.calls.length,2);assert.deepEqual(f.received,[])
  }
  for(const lookup of [ok({items:[]}),{ok:false,error:{code:230110}},...[
    {message_id:root},{deleted:true},{root_id:'om_else'},{chat_id:'oc_other'},{create_time:'12'},
    {mentions:[]},{mentions:[{...first.mentions[0],id:'all'}]},{sender:{...first.sender,tenant_key:'other'}},
  ].map(p=>ok({items:[{...first,...p}]}))]) {
    const f=await setup([user,group,lookup],approved)
    assert.deepEqual(await f.source.consumeMention(trigger),{accepted:0});assert.deepEqual(f.received,[])
  }
  const failing=await setup([user,group,{ok:false,error:{code:1234}}],approved)
  await assert.rejects(failing.source.consumeMention(trigger),{code:'source-unavailable'})
  for(const [ref,row] of [[trigger,first],[{...trigger,messageId:'om_after',at:21},{...first,message_id:'om_after',create_time:'21'}]]) {
    const f=await setup([user,group,ok({items:[row]}),...threadContext()],approved)
    assert.deepEqual(await f.source.consumeMention(ref),{accepted:1});assert.equal(f.received[0].messageId,ref.messageId)
    assert.ok(f.calls[2].argv.includes('/open-apis/im/v1/messages/'+ref.messageId))
  }
})

test('readMention offers exact pre-fix text only on explicit, unedited name repair requests',async()=>{
  const mentions=[{...first.mentions[0],key:'@_user_1'}], body={content:'{"text":"@_user_1在吗"}'}
  const named=ok({user:{...user.data.user,name:'验证本人'}})
  for (const [patch,expected] of [[{},true],[{updated:false,update_time:first.create_time},true],
    [{updated:true,update_time:first.create_time},false],[{updated:false,update_time:'12'},false],[{update_time:'9'},false],
    [{update_time:'bad'},false],[{updated:'false'},false]]) {
    const row={...first,body,mentions,sender:{...first.sender,sender_name:'别人的名字'},...patch}
    const f=await setup([named,group,ok({items:[row]}),named,group,ok({items:[row]})],{options,mode:'pending'})
    const current={...sent,text:'@验证本人在吗'}
    assert.deepEqual(await f.source.readMention(trigger),current)
    assert.deepEqual(await f.source.readMention(trigger,{legacyText:true}),expected ? {...current,legacyText:'@_user_1在吗'} : current)
    assert.deepEqual(f.received,[])
  }
  const own={...first,body,mentions,sender:{...first.sender,id:config.recipientId,sender_name:'发言本人'}}
  const ownCase=await setup([named,group,ok({items:[own]})],{options,mode:'pending'})
  assert.deepEqual(await ownCase.source.readMention(trigger),{...trigger,senderId:config.recipientId,text:'@发言本人在吗',ownerSelfMention:true})
  const post={...first,msg_type:'post',mentions,body:{content:JSON.stringify({content:[[{tag:'at',user_id:'@_user_1'}]]})}}
  const postCase=await setup([user,group,ok({items:[post]})],{options,mode:'pending'})
  assert.deepEqual(await postCase.source.readMention(trigger,{legacyText:true}),{...sent,text:'@你',legacyText:'@_user_1'})
})

test('formatting does not change which requests fit the intake limit',async()=>{
  for(const [text,name,admitted] of [['@_user_1'+'a'.repeat(65528),'very long owner name',true],
    ['@_user_1 '+'a'.repeat(65527),'very long owner name',true],['@_user_1 '+'a'.repeat(65528),'你',false]]) {
    const row={...first,body:{content:JSON.stringify({text})},mentions:[{...first.mentions[0],key:'@_user_1',name}]}
    const f=await setup([user,group,ok({items:[row]})],{options,mode:'pending'})
    assert.deepEqual(await f.source.readMention(trigger,{legacyText:true}),admitted ? {...sent,text} : null)
  }
})

test('an edit cannot substitute a different request after approval or resurrect a removed mention',async()=>{
  const row=text=>({...first,body:{content:JSON.stringify({text})}})
  for (const [current,accepted] of [[row('B'),1],[{...row('B'),mentions:[]},0],[{...row('B'),deleted:true},0]]) {
    const f=await setup([user,group,ok({items:[row('A')]}),user,group,ok({items:[current]}),...(accepted ? threadContext() : [])],{...approved,mode:'pending'})
    const saved=await f.source.readMention(trigger)
    assert.equal(saved.text,'A');assert.deepEqual(f.received,[])
    await f.admission.update({action:'once',chatId,threadId:root})
    assert.deepEqual(await f.source.consumeMention(trigger,saved.text),{accepted})
    assert.deepEqual(f.received.map(m=>m.text),accepted ? ['A'] : [])
  }
})

test('only the recorded pre-grant request can receive a reply, at its verified creation time',async()=>{
  const request={...delivery,messageId:trigger.messageId}
  const f=await setup([user,group,grants,ok({items:[first]}),ok({message_id:'om_sent',chat_id:chatId})],approved)
  assert.deepEqual(await f.source.reply(request),{chatId,messageId:'om_sent',inReplyTo:trigger.messageId})
  for(const patch of [{create_time:'10'},{create_time:'12'},{message_id:'om_other'}]) {
    const row={...first,...patch}, f=await setup([user,group,grants,ok({items:[row]})],approved)
    await assert.rejects(f.source.reply({...request,messageId:row.message_id}))
    assert.ok(f.calls.every(c=>!c.argv.includes('+messages-reply')))
  }
})

test('under a grant for one member, intake and replies accept only that member’s exact messages',async()=>{
  const responses=[], f=await setup(responses,{options,trigger:sent,now:20,mode:'pending'})
  await f.admission.recordMention({...sent,text:'请求核对'},options.automationSince)
  await f.admission.update({action:'sender',chatId,threadId:root,messageId:trigger.messageId})
  const request={...delivery,messageId:trigger.messageId,requesterId:'ou_requester'}
  // Without the member, or naming someone else, the grant does not apply and nothing is read.
  for(const ref of [trigger,{...sent,senderId:'ou_other'}])
    await assert.rejects(f.source.consumeMention(ref),{code:'admission-denied'})
  for(const requesterId of [undefined,'ou_other'])
    await assert.rejects(f.source.reply({...request,requesterId}),{code:'admission-denied'})
  assert.deepEqual(f.calls,[])
  // The member's approved request and their later messages are received.
  responses.push(user,group,ok({items:[first]}),...threadContext())
  assert.deepEqual(await f.source.consumeMention(sent),{accepted:1})
  const later=msg({message_id:'om_later',root_id:root,create_time:'21'})
  responses.push(user,group,ok({items:[later]}),...threadContext())
  assert.deepEqual(await f.source.consumeMention({...sent,messageId:'om_later',at:21}),{accepted:1})
  assert.deepEqual(f.received.map(e=>[e.messageId,e.senderId]),[[trigger.messageId,'ou_requester'],['om_later','ou_requester']])
  // A discovery ref claiming the member cannot admit a message another person actually wrote.
  const impostor=msg({message_id:'om_impostor',root_id:root,create_time:'22',sender:{...first.sender,id:'ou_other'}})
  responses.push(user,group,ok({items:[impostor]}))
  assert.deepEqual(await f.source.consumeMention({...sent,messageId:'om_impostor',at:22}),{accepted:0})
  assert.equal(f.received.length,2);assert.equal(responses.length,0)
  // Replies: the member's own message is answered; another author's is refused before sending.
  responses.push(user,group,grants,ok({items:[impostor]}))
  await assert.rejects(f.source.reply({...request,messageId:'om_impostor'}),{code:'source-unavailable'})
  assert.ok(!f.calls.some(c=>c.argv.includes('+messages-reply')))
  responses.push(user,group,grants,ok({items:[first]}),ok({message_id:'om_sent',chat_id:chatId}))
  assert.deepEqual(await f.source.reply(request),{chatId,messageId:'om_sent',inReplyTo:trigger.messageId})
  assert.equal(responses.length,0)
})
