import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFeishuSource } from '../host/feishu.js'

test('installed CLI dry-run: production argv and jq keep other messages and private fields out of stdout',async t=>{
  const home=mkdtempSync(join(tmpdir(),'superagent-cli-'))
  t.after(()=>rmSync(home,{recursive:true,force:true}))
  const env={PATH:process.env.PATH,HOME:home,LARKSUITE_CLI_CONFIG_DIR:home,LARKSUITE_CLI_APP_ID:'cli_offline_fixture',
    LARKSUITE_CLI_APP_SECRET:'fixture',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}
  const invoke=argv=>execFileSync('lark-cli',argv,{env,cwd:home,encoding:'utf8',timeout:10_000})
  try {invoke(['--version'])} catch(e) {if(e.code==='ENOENT') {t.skip('system lark-cli is not installed');return} throw e}
  const config={enabled:true,profile:'fixture',tenantId:'tenant',recipientId:'ou_me',automationSince:10,historyCount:0}
  const chatId='oc_demo',threadId='om_root',messageId='om_target',at=12,secret='SHOULD_NOT_CROSS_BOUNDARY'
  const row={message_id:messageId,chat_id:chatId,root_id:threadId,create_time:String(at),deleted:false,msg_type:'text',
    sender:{id:'ou_me',id_type:'open_id',sender_type:'user',tenant_key:'tenant',name:secret},
    mentions:[{id:'ou_me',id_type:'open_id',tenant_key:'tenant',name:secret,key:secret}],body:{content:JSON.stringify({text:secret})}}
  const rich={...row,thread_id:'omt_demo',msg_type:'post',body:{content:JSON.stringify({content:[[{tag:'at',user_id:'@_user_1'},{tag:'text',text:' exact request'}]]})},
    sender:{...row.sender,name:''},mentions:[{...row.mentions[0],name:'',key:'@_user_1'}]}
  const grant={mode:'once',threadId,chatId,approvedAt:13,triggers:[{messageId,threadId,at}]}, received=[]
  let searchBody
  const api='/open-apis/im/v1/messages'
  const source=createFeishuSource({config,admission:{run:(target,fn)=>{assert.deepEqual(target,{threadId,chatId});return fn(grant)}},
    receive:(event,g)=>{assert.equal(g,grant);received.push(event)},run(argv){
      const has=s=>argv.includes(s), flag=s=>argv[argv.indexOf(s)+1]
      let data
      if(has('im:message.p2p_msg:get_as_user')) return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
      if(has('+get-user')) data={user:{open_id:'ou_me',tenant_key:'tenant',name:'验证姓名',email:secret}}
      else if(has('chats')) data={chat_mode:'topic',external:false,tenant_key:'tenant',description:secret}
      else if(has(api+'/search')) {searchBody=JSON.parse(flag('--data'));data={items:[{meta_data:{message_id:messageId,chat_id:chatId,is_p2p_chat:false},highlight:secret}],has_more:false}}
      else if(has(api+'/mget')) data={items:[row]}
      else if(has(api+'/'+messageId)) data={items:[{...row,root_id:'om_other'},{...row,create_time:'14'},
        {...row,chat_id:'oc_other'},{...row,upper_message_id:'om_forward'},
        {...row,deleted:true},{...row,msg_type:'merge_forward'},{...row,mentions:[]},{...row,mentions:[{...row.mentions[0],id:'all'}]},
        {...row,sender:{...row.sender,id:'ou_me'},mentions:[]}, {...row,sender:{...row.sender,sender_type:'app'}},
        {...row,sender:{...row.sender,tenant_key:'other'}},rich]}
      else if(has(api+'/'+threadId)) data={items:[{...rich,message_id:threadId,root_id:'',create_time:'9'}]}
      else if(has(api)) {assert.equal(JSON.parse(flag('--params')).container_id,'omt_demo');data={items:[],has_more:false}}
      else assert.fail('unexpected command')
      // The real CLI supplies the envelope and executes our production projection. Replace only the dry-run business data.
      const args=[...argv,'--dry-run'], index=args.indexOf('--jq')
      assert.ok(index>=0)
      args[index+1]='.data='+JSON.stringify(data)+' | ('+args[index+1]+')'
      const stdout=invoke(args)
      assert.ok(!stdout.includes(secret),'a private field escaped the lark-cli projection')
      const result=JSON.parse(stdout)
      assert.equal(result.ok,true);assert.equal(result.identity,'user');assert.equal(result.dry_run,true)
      if(has(api+'/'+messageId)) assert.equal(result.data.items.length,1)
      return {...result,dry_run:false} // Only this injected transport can turn its fixture into a simulated live result.
    }})
  const refs=await source.discover({since:10,until:14})
  assert.deepEqual(refs,{mentions:[{chatId,threadId,messageId,at,ownerSelfMention:true}]})
  const [preview]=JSON.parse(invoke(['im','+messages-search','--as','user','--dry-run','--sender-type','user',
    '--chat-type','group','--at-chatter-ids','ou_me','--start','1970-01-01T00:00:00Z','--end','1970-01-01T00:00:01Z',
    '--page-size','50','--jq','.data.api']))
  assert.equal(preview.url,api+'/search');assert.deepEqual(preview.body,searchBody)
  assert.deepEqual(await source.readMention(refs.mentions[0]),{...refs.mentions[0],text:'@验证姓名 exact request'})
  assert.deepEqual(received,[])
  assert.deepEqual(await source.consumeMention(refs.mentions[0]),{accepted:1})
  assert.equal(received[0].text,'@验证姓名 exact request');assert.equal(received[0].senderId,config.recipientId)
})
