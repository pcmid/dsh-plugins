import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFeishuSource} from '../host/feishu.js'

const me='ou_me', peer='ou_requester', dm='oc_dm', self='oc_me', messageId='om_in', epoch=2000, at=3500
const config={enabled:true,profile:'fixture',recipientId:me,tenantId:'tenant',automationSince:1000,
  allowPrivateChats:true,privateChatsSince:epoch,historyCount:0}
const privateProof={privatePeerId:peer,privateChatsSince:epoch}
const ref={chatId:dm,messageId,threadId:messageId,at,...privateProof}
// Discovery and reads add the verified author from the CLI row.
const found={...ref,senderId:peer}
const request={source:{kind:'feishu',tenantId:'tenant',recipientId:me,threadId:messageId,chatId:dm,...privateProof},
  messageId,text:'reviewed answer',idempotencyKey:'once-only'}
const scope='im:message.p2p_msg:get_as_user',base='/open-apis/im/v1/messages',mapping='/open-apis/im/v1/chat_p2p/batch_query',chatDetails='/open-apis/im/v1/chats/batch_query'
const origin={chat_id:dm,message_id:messageId,sender:{id:peer,id_type:'open_id',sender_type:'user',tenant_key:'external'},
  mentions:[],deleted:false,msg_type:'text',body:{content:'{"text":"plain request"}'},create_time:String(at)}
const pair={chat_id:dm,chatter_id1:peer,chatter_id2:me}
const hit=(r,from=r.sender.id,flag=true)=>({meta_data:{message_id:r.message_id,chat_id:r.chat_id,is_p2p_chat:flag,from_id:from},
  display_info:'NEVER_IMPORT_SEARCH_BODY'})
const window={since:1000,until:4000}
const ok=data=>({ok:true,identity:'user',data})
const flag=(argv,k)=>argv[argv.indexOf(k)+1]
function fixture(opt={}) {
  const cfg={...config,...opt.config},calls=[],events=[],table=opt.rows ?? [origin]
  const grant={mode:'once',chatId:dm,threadId:messageId,approvedAt:3000,...privateProof,...opt.grant}
  const f={cfg,calls,events,grant,source:undefined}
  const projected=(args,data)=>opt.project ? opt.project(args,data) : ok(data)
  f.source=createFeishuSource({config:cfg,admission:{run:(target,fn)=>fn(grant)},receive:e=>events.push(e),
    isQuestionReply:(chat,parent)=>chat===dm && parent==='om_question',isSentMessage:(_,id)=>id==='om_previously_sent',
    async run(args,stdin){
      await opt.during?.(args,f)
      calls.push(args)
      if (args.includes('+get-user')) return ok({user:{open_id:me,tenant_key:'tenant'}})
      if (args.includes('auth')) return {ok:true,granted:flag(args,'--scope').split(' '),missing:[]}
      if (args.includes(mapping)) {
        const {chatter_ids:ids}=JSON.parse(flag(args,'--data'));assert.deepEqual(JSON.parse(flag(args,'--params')),{chatter_id_type:'open_id'})
        return projected(args,{p2p_chats:ids.includes(me) ? [{chat_id:self,chatter_id1:me,chatter_id2:me}] :
          (opt.pairs ?? [pair]).filter(p=>ids.includes(p.chatter_id1)||ids.includes(p.chatter_id2))})
      }
      if (args.includes(chatDetails)) {
        assert.deepEqual(JSON.parse(flag(args,'--params')),{user_id_type:'open_id'})
        assert.deepEqual(JSON.parse(flag(args,'--data')),{chat_ids:[dm]})
        return projected(args,{items:opt.details ?? [{chat_id:dm,chat_mode:'p2p',p2p_target_id:peer,p2p_target_type:'user'}]})
      }
      if (args.includes(base+'/search')) {
        const body=JSON.parse(flag(args,'--data'))
        assert.equal(body.query,'');assert.equal(body.filter.chat_type,'p2p');assert.deepEqual(body.filter.from_types,['user'])
        assert.equal(body.filter.at_chatter_ids,undefined)
        assert.equal(body.filter.time_range.start_time,'1970-01-01T00:00:02Z')
        return projected(args,{items:opt.hits ?? table.map(r=>hit(r)),has_more:!!opt.next,page_token:opt.next})
      }
      if (args.includes(base+'/mget')) {
        const {message_ids:ids,user_id_type}=JSON.parse(flag(args,'--params'));assert.equal(user_id_type,'open_id')
        return projected(args,{items:table.filter(r=>ids.includes(r.message_id))})
      }
      if (args.includes(base+'/'+messageId)) return projected(args,{items:opt.exact ?? [origin]})
      if (opt.question && args.includes(base+'/om_question')) return projected(args,{items:[opt.question]})
      if (opt.answers && args.includes(base)) return projected(args,{items:opt.answers,has_more:false})
      assert.ok(args.includes('+messages-reply'));assert.equal(flag(args,'--message-id'),messageId);assert.ok(!args.includes('--reply-in-thread'))
      assert.deepEqual(JSON.parse(stdin),{text:request.text});return ok({message_id:'om_sent',chat_id:dm})
    }})
  return f
}

test('third-party DMs default off; off, old epochs and the opening instant yield no reads or dispatch',async()=>{
  for (const cfg of [{allowPrivateChats:undefined},{allowPrivateChats:false},{privateChatsSince:0}]) {
    const f=fixture({config:cfg})
    assert.deepEqual(await f.source.discoverPrivate(window),{mentions:[]})
    assert.equal(await f.source.readMention(ref),null)
    assert.deepEqual(await f.source.consumeMention(ref),{accepted:0})
    await assert.rejects(f.source.reply(request));assert.deepEqual(f.calls,[])
  }
  const f=fixture()
  for (const old of [{...ref,privateChatsSince:1000},{...ref,at:epoch}]) {
    assert.equal(await f.source.readMention(old),null);assert.deepEqual(await f.source.consumeMention(old),{accepted:0})
  }
  assert.deepEqual(f.calls,[])
})

test('only incoming mapped 1:1 peers enter (including a different tenant), never self, group, outgoing, or a question reply',async()=>{
  const rows=[origin,{...origin,message_id:'om_old',create_time:String(epoch)},
    {...origin,message_id:'om_answer',root_id:messageId,parent_id:'om_question'},
    {...origin,message_id:'om_owner',sender:{...origin.sender,id:me}},
    {...origin,message_id:'om_wrong_peer',sender:{...origin.sender,id:'ou_bystander'}},
    {...origin,message_id:'om_bad_chat',chat_id:'oc_other'},
    {...origin,message_id:'om_self',chat_id:self},{...origin,message_id:'om_group',chat_id:'oc_group'},
    {...origin,message_id:'om_bot',sender:{...origin.sender,sender_type:'app'}},
    {...origin,message_id:'om_spoofed',sender:{...origin.sender,id:'ou_changed'}}]
  const hits=rows.map(r=>hit(r,r.message_id==='om_spoofed' ? peer : r.sender.id,r.message_id!=='om_group'))
  const f=fixture({rows,hits,next:'opaque'})
  assert.deepEqual(await f.source.discoverPrivate(window),{mentions:[found],nextPageToken:'opaque'})
  const batch=JSON.parse(flag(f.calls.find(a=>a.includes(base+'/mget')),'--params')).message_ids
  assert.deepEqual(batch,[messageId,'om_old','om_answer','om_owner','om_bot','om_spoofed'])
  assert.ok(!f.calls.some(a=>a.includes(chatDetails))) // Ordinary outgoing speech does not even trigger partner lookup.
  assert.deepEqual(f.events,[]);assert.ok(!f.calls.some(a=>a.includes(base+'/'+messageId)))
  assert.deepEqual(await f.source.readMention(ref),{...found,text:'plain request'})
  assert.deepEqual(await f.source.consumeMention(ref,'approved text'),{accepted:1})
  assert.deepEqual(f.events.map(e=>[e.senderId,e.text,e.privatePeerId,e.privateChatsSince]),[[peer,'approved text',peer,epoch]])
  // Delivery after restart knows no cached chat catalog: proof comes from the durable grant and a fresh pair lookup.
  const cold=fixture();await cold.source.assertAllowed(request.source)
  assert.deepEqual(await cold.source.reply(request),{chatId:dm,messageId:'om_sent',inReplyTo:messageId})
  assert.ok(cold.calls.some(a=>a.includes(mapping)&&JSON.parse(flag(a,'--data')).chatter_ids[0]===peer))
})

const owner={...origin,sender:{...origin.sender,id:me,tenant_key:'tenant'},mentions:[{id:me,tenant_key:'tenant',id_type:'open_id'}]}
const ownRef={...ref,ownerSelfMention:true}, ownFound={...ownRef,senderId:me}

test('owner self-mention in a peer DM requires a chat→peer lookup, bilateral proof and exact original self-mention',async()=>{
  const junk=[{message_id:'om_plain',mentions:[],body:{content:'{"text":"@me"}'}},
    {message_id:'om_all',mentions:[{...owner.mentions[0],id:'all'}]}, {message_id:'om_bot',sender:{...owner.sender,sender_type:'app'}},
    {message_id:'om_wrong_tenant',sender:{...owner.sender,tenant_key:'other'}}, {message_id:'om_previously_sent'},
    {message_id:'om_answer',root_id:messageId,parent_id:'om_question'}]
  const f=fixture({rows:[owner,...junk.map(x=>({...owner,...x}))],exact:[owner],
    grant:{approvedAt:at+10,triggers:[ownRef]}})
  assert.deepEqual((await f.source.discoverPrivate(window)).mentions,[ownFound])
  const paths=f.calls.map(a=>a[4])
  assert.ok(paths.indexOf(chatDetails)>paths.indexOf(base+'/mget'));assert.ok(paths.lastIndexOf(mapping)>paths.indexOf(chatDetails))
  assert.deepEqual(await f.source.readMention(ref),{...ownFound,text:'plain request'})
  assert.deepEqual(await f.source.consumeMention(ownRef),{accepted:1});assert.equal(f.events[0].senderId,me)
  assert.equal((await f.source.reply(request)).messageId,'om_sent')
  for(const details of [[],[{chat_id:dm,chat_mode:'group',p2p_target_id:peer}],
    [{chat_id:dm,chat_mode:'p2p',p2p_target_id:me}],[{chat_id:dm,chat_mode:'p2p',p2p_target_id:'ou_mismatched'}],
    [{chat_id:'oc_other',chat_mode:'p2p',p2p_target_id:peer}],[{chat_id:dm,chat_mode:'p2p',p2p_target_type:'bot',p2p_target_id:peer}]]) {
    const missing=fixture({rows:[owner],details})
    assert.deepEqual((await missing.source.discoverPrivate(window)).mentions,[])
    assert.ok(!missing.calls.some(a=>a.includes(base+'/'+messageId)))
  }
})

test('a question from a self-directed peer-DM intake accepts only the original owner’s explicit reply, not a peer answer',async()=>{
  const child=(id,sender,time,parent)=>({...owner,message_id:id,sender,create_time:String(time),mentions:[],root_id:messageId,parent_id:parent})
  const question=child('om_question',owner.sender,at+1,messageId)
  const answers=[child('om_peer_replied',origin.sender,at+2,'om_question'),child('om_wrong_parent',owner.sender,at+3,messageId),
    child('om_own_answer',owner.sender,at+4,'om_question')]
  const f=fixture({exact:[owner],grant:{triggers:[ownRef]},question,answers})
  const input={source:request.source,messageId,requesterId:me,questionId:'om_question',originalText:'archived request'}
  assert.equal(await f.source.readQuestionReply({...input,requesterId:peer},()=>{}),null)
  const answer=await f.source.readQuestionReply(input,()=>{})
  assert.equal(answer.messageId,'om_own_answer');assert.equal(answer.senderId,me)
})

test('a stored automatic trigger cannot be reused for a changed request or asserted by a discovery flag',async()=>{
  for(const exact of [origin,{...owner,mentions:[]},{...owner,mentions:[{...owner.mentions[0],id:'all'}]},
    {...owner,parent_id:'om_question',root_id:messageId}]) {
    const f=fixture({exact:[exact],grant:{triggers:[ownRef]}})
    assert.equal(await f.source.readMention(ownRef),null)
    assert.deepEqual(await f.source.consumeMention(ref),{accepted:0});await assert.rejects(f.source.reply(request))
    assert.deepEqual(f.events,[])
  }
  const inbound=fixture({grant:{triggers:[{...ownRef,messageId:'om_unrelated'}]}})
  assert.deepEqual(await inbound.source.readMention(ref),{...found,text:'plain request'})
  assert.deepEqual(await inbound.source.consumeMention(ref),{accepted:1}) // Same scope, another trigger is not this request.
})

test('a search index without open IDs only yields bodyless metadata until mapping matches the human sender',async()=>{
  const f=fixture({hits:[hit(origin,'legacy-provider-id')]})
  assert.deepEqual((await f.source.discoverPrivate(window)).mentions,[found])
  const n=f.calls.findIndex(a=>a.includes(base+'/mget'))
  assert.ok(n>=0);assert.ok(!flag(f.calls[n],'--jq').includes('body'))
  assert.ok(f.calls.slice(n+1).some(a=>a.includes(mapping)))
  for (const bad of [[{...pair,chatter_id2:'ou_else'}],[{...pair,chat_id:'oc_other'}],[]]) {
    const f=fixture({pairs:bad})
    assert.deepEqual((await f.source.discoverPrivate(window)).mentions,[]);assert.ok(!f.calls.some(a=>a.includes(base+'/mget')))
    assert.equal(await f.source.readMention(ref),null);await assert.rejects(f.source.reply(request))
    assert.ok(!f.calls.some(a=>a.includes(base+'/'+messageId)||a.includes('+messages-reply')))
  }
})

test('forged, old or mismatched grants and raw rows cannot use a private exact fetch to consume or reply',async()=>{
  for (const grant of [{privateChatsSince:1999},{privatePeerId:'ou_else'},{privatePeerId:undefined,privateChatsSince:undefined}]) {
    const f=fixture({grant});await assert.rejects(f.source.consumeMention(ref));await assert.rejects(f.source.reply(request));assert.deepEqual(f.calls,[])
  }
  for(const override of [{sender:{...origin.sender,id:me}},{sender:{...origin.sender,id:'ou_else'}},{create_time:String(epoch)},
    {chat_id:'oc_else'},{root_id:'om_other'},{deleted:true},{msg_type:'merge_forward'}]) {
    const f=fixture({exact:[{...origin,...override}]})
    assert.equal(await f.source.readMention(ref),null);assert.deepEqual(await f.source.consumeMention(ref),{accepted:0})
    await assert.rejects(f.source.reply(request));assert.deepEqual(f.events,[])
    assert.ok(!f.calls.some(a=>a.includes('+messages-reply')))
  }
})

test('closing then reopening while a read or send is waiting invalidates the old handle',async()=>{
  for (const [step,op] of [[base+'/search','discoverPrivate'],[base+'/mget','discoverPrivate'],[base+'/'+messageId,'consumeMention'],['auth','reply']]) {
    const f=fixture({during:(a,{cfg})=>{
      if (a.includes(step) && (step!=='auth'||!a.includes(scope))) {cfg.allowPrivateChats=false;cfg.privateChatsSince=epoch+1;cfg.allowPrivateChats=true}
    }})
    await assert.rejects(f.source[op](op==='discoverPrivate' ? window : op==='reply' ? request : ref))
    assert.deepEqual(f.events,[]);assert.ok(!f.calls.some(a=>a.includes('+messages-reply')))
  }
})

test('installed CLI dry-run checks private search, pair, projected metadata, and exact proved inbound body',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sa-private-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const env={HOME:dir,PATH:process.env.PATH,LARKSUITE_CLI_CONFIG_DIR:dir,LARKSUITE_CLI_APP_ID:'cli_offline_fixture',LARKSUITE_CLI_APP_SECRET:'fixture',
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}
  const invoke=args=>execFileSync('lark-cli',args,{env,cwd:dir,encoding:'utf8',timeout:10000})
  try {invoke(['--version'])} catch(e){if(e.code==='ENOENT'){t.skip('no installed lark-cli');return}throw e}
  const bad='NEVER_IMPORT_BODY'
  const project=(argv,data)=>{
    const args=[...argv,'--dry-run'],i=args.indexOf('--jq');assert.ok(i>0)
    args[i+1]='.data='+JSON.stringify(data)+' | ('+args[i+1]+')'
    const raw=invoke(args);assert.ok(!raw.includes(bad));assert.ok(!raw.includes('NEVER_IMPORT_SEARCH_BODY'))
    const out=JSON.parse(raw);assert.equal(out.dry_run,true);return {...out,dry_run:false}
  }
  for (const [row,expected] of [[origin,found],[owner,ownFound]]) {
    const f=fixture({rows:[{...row,body:{content:JSON.stringify({text:bad})}}],
      exact:[{...owner,mentions:[],body:{content:JSON.stringify({text:bad})}},row],project})
    assert.deepEqual((await f.source.discoverPrivate(window)).mentions,[expected])
    assert.deepEqual(await f.source.readMention(ref),{...expected,text:'plain request'})
  }
})
