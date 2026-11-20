import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFeishuSource} from '../host/feishu.js'

const me='ou_self', own='oc_self', group='oc_group', peer='oc_never_open', id='om_self', gid='om_group'
const endpoint='/open-apis/im/v1/messages', mapping='/open-apis/im/v1/chat_p2p/batch_query', scope='im:message.p2p_msg:get_as_user'
const secret='PRIVATE_NOT_TO_STDOUT', ok=data=>({ok:true,identity:'user',data})
const proof={chatter_id1:me,chatter_id2:me,chat_id:own}
const hit=(message_id,chat_id,is_p2p_chat)=>({meta_data:{message_id,chat_id,is_p2p_chat},display_info:secret})
const row=(message_id,chat_id,sender,text)=>({message_id,chat_id,create_time:'200',deleted:false,msg_type:'text',
  sender:{id:sender,tenant_key:'tenant',sender_type:'user',id_type:'open_id'},mentions:[{id:me,tenant_key:'tenant',id_type:'open_id'}],
  body:{content:JSON.stringify({text})}})
const m=row(id,own,me,'hand-written self mention'), g=row(gid,group,'ou_user','hello')
const ref={chatId:own,messageId:id,threadId:id,at:200,ownerSelfMention:true}, gref={chatId:group,messageId:gid,threadId:gid,at:200,name:'team'}
const flag=(argv,k)=>argv[argv.indexOf(k)+1]

function fixture({granted=true,maps=()=>[proof],project=(_args,data)=>ok(data),denyFirstBatch=false,target=m}={}) {
  const batches=[],searches=[],lookups=[],warnings=[],events=[],ops=[]
  let count=0,mode='once'
  const cfg={enabled:true,profile:'fixture',tenantId:'tenant',recipientId:me,automationSince:10}
  const source=createFeishuSource({config:cfg,onPollWarning:async(e,stage)=>warnings.push([stage,e.reason,e.larkCode]),
    admission:{run:async({chatId,threadId},fn)=>fn({mode,chatId,threadId,approvedAt:20})},receive:e=>events.push(e),async run(argv,stdin) {
      ops.push(argv)
      const has=s=>argv.includes(s)
      if(has('auth') && has('check')){
        const requested=flag(argv,'--scope').split(' ')
        if(has(scope) && !granted) return {ok:false,granted:[],missing:[scope]}
        return {ok:true,granted:requested,missing:[]}
      }
      const params=has('--params') && JSON.parse(flag(argv,'--params'))
      if(has('+get-user')) return ok({user:{open_id:me,tenant_key:'tenant'}})
      if(has(mapping)) {
        assert.deepEqual(params,{chatter_id_type:'open_id'});assert.deepEqual(JSON.parse(flag(argv,'--data')),{chatter_ids:[me]})
        return project(argv,{p2p_chats:maps(++count)})
      }
      if(has(endpoint+'/search')){
        searches.push(JSON.parse(flag(argv,'--data')).filter)
        return project(argv,{items:[hit(id,own,true),hit(gid,group,false),hit('om_private',peer,true),
          hit('om_unproved','oc_unproved',undefined),hit('om_false_type',peer,'false')],has_more:false})
      }
      if(has(endpoint+'/mget')){
        const ids=params.message_ids;batches.push(ids)
        assert.ok(!ids.some(x=>['om_private','om_unproved','om_false_type'].includes(x)))
        if(denyFirstBatch && batches.length===1) return {ok:false,error:{code:230027}}
        return project(argv,{items:[g,m].filter(r=>ids.includes(r.message_id))})
      }
      if(has('chats')){
        const chat=flag(argv,'--chat-id');lookups.push(chat);assert.equal(chat,group)
        return ok({name:'team',chat_mode:'group',external:false,tenant_key:'tenant'})
      }
      if(has(endpoint+'/'+id)) return project(argv,{items:[target,
        {...m,chat_id:peer,body:{content:JSON.stringify({text:secret})}},
        {...m,sender:{...m.sender,id:'ou_wrong'},body:{content:JSON.stringify({text:secret})}}]})
      if(has(endpoint)){
        assert.equal(mode,'permanent')
        assert.equal(params.container_id,own);assert.equal(params.container_id_type,'chat')
        return project(argv,{items:[
          {...row('om_before',own,me,'self history'),mentions:[],create_time:'100'},
          {...row('om_peer',peer,me,secret),mentions:[],create_time:'98'},
          {...row('om_forged',own,'ou_wrong',secret),mentions:[],create_time:'99'}
        ],has_more:false})
      }
      assert.ok(has('+messages-reply') && has(id));assert.ok(!has('--reply-in-thread'))
      assert.deepEqual(JSON.parse(stdin),{text:'reviewed reply'})
      return ok({chat_id:own,message_id:'om_out'})
    }})
  return {source,batches,searches,events,warnings,lookups,ops,setMode:v=>mode=v,discover:()=>source.discover({since:10,until:300})}
}

function dry(t) {
  const dir=mkdtempSync(join(tmpdir(),'sa-self-cli-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const env={HOME:dir,PATH:process.env.PATH,LARKSUITE_CLI_CONFIG_DIR:dir,LARKSUITE_CLI_APP_ID:'cli_offline_fixture',LARKSUITE_CLI_APP_SECRET:'fixture',
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}
  const invoke=args=>execFileSync('lark-cli',args,{env,cwd:dir,encoding:'utf8',timeout:10000})
  try {invoke(['--version'])} catch(e){if(e.code==='ENOENT') {t.skip('no system lark-cli');return}throw e}
  return (argv,data)=>{
    const args=[...argv,'--dry-run'],i=args.indexOf('--jq');assert.ok(i>0)
    args[i+1]='.data='+JSON.stringify(data)+'|('+args[i+1]+')'
    const out=invoke(args);assert.ok(!out.includes(secret));assert.ok(!out.includes(peer))
    const result=JSON.parse(out);assert.equal(result.dry_run,true)
    return {...result,dry_run:false}
  }
}

test('real CLI projections: both self-chat endpoints must match; a peer DM never enters mget, exact reads, history or reply',async t=>{
  const project=dry(t);if(!project)return
  const f=fixture({project})
  assert.deepEqual(await f.discover(),{mentions:[gref,{...ref,name:'与自己的聊天'}]})
  assert.deepEqual(f.batches,[[id,gid]]);assert.equal(f.searches[0].chat_type,undefined)
  assert.deepEqual(f.lookups,[group]);assert.deepEqual(f.events,[])
  assert.deepEqual(await f.source.readMention(ref),{...ref,text:'hand-written self mention',name:'与自己的聊天'})
  f.setMode('permanent')
  await f.source.consumeMention(ref)
  assert.deepEqual(JSON.parse(f.events[0].workerContext),[{speaker:'requester',at:100,text:'self history'}])
  assert.deepEqual(await f.source.reply({source:{kind:'feishu',tenantId:'tenant',recipientId:me,chatId:own,threadId:id},
    messageId:id,text:'reviewed reply',idempotencyKey:'fixture'}),{chatId:own,messageId:'om_out',inReplyTo:id})
  assert.deepEqual(f.lookups,[group]);assert.equal(f.ops.filter(a=>a.includes(mapping)).length,1)
})

test('host also rejects unclassified or peer hits before mget; wrong/ambiguous mapping warns but does not suppress groups',async()=>{
  for(const forged of [[{...proof,chatter_id2:'ou_other'}],[{...proof,chatter_id1:'ou_other'}],[proof,proof]]){
    const f=fixture({maps:count=>count===1 ? forged : [proof]})
    assert.deepEqual(await f.discover(),{mentions:[gref]})
    assert.deepEqual(f.batches,[[gid]]);assert.deepEqual(f.warnings,[['group','invalid-response',undefined]])
    assert.equal(f.searches[0].chat_type,'group')
    assert.equal((await f.discover()).mentions.length,2)
    assert.deepEqual(f.batches[1],[id,gid]);assert.equal(f.searches[1].chat_type,undefined)
  }
})

test('old OAuth remains group-only, logs missing scope once, and never looks up a P2P target',async()=>{
  const f=fixture({granted:false});await f.discover();await f.discover()
  assert.deepEqual(f.warnings,[['group','permission-denied',undefined]])
  assert.deepEqual(f.batches,[[gid],[gid]]);assert.equal(f.ops.filter(a=>a.includes(scope)).length,1)
  assert.ok(!f.ops.some(a=>a.includes(mapping)))
})

test('permission revoked during mixed mget does not stall existing groups or expand the retry',async()=>{
  const f=fixture({denyFirstBatch:true})
  assert.deepEqual(await f.discover(),{mentions:[gref]})
  assert.deepEqual(f.batches,[[id,gid],[gid]])
  assert.deepEqual(f.warnings,[['metadata','api-error',230027]])
  assert.equal((await f.discover()).mentions.length,2)
  assert.equal(f.ops.filter(a=>a.includes(mapping)).length,2)
})

test('a verified self chat still requires an actual self sender and structured mention for exact dispatch',async()=>{
  for(const target of [{...m,mentions:[]},{...m,sender:{...m.sender,id:'ou_other'}},{...m,deleted:true}]) {
    const f=fixture({target})
    assert.equal(await f.source.readMention(ref),null)
    assert.deepEqual(await f.source.consumeMention(ref),{accepted:0});assert.deepEqual(f.events,[])
  }
})
