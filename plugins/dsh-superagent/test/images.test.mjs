import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { imageKey, imageMarker, legacyPostText, postImages, postText } from '../host/mention-text.js'
import { createFeishuSource } from '../host/feishu.js'
import { createLoop } from '../host/loop.js'

const mark = key => '[图片 #'+createHash('sha256').update(key).digest('hex').slice(0,6)+']'
const img = key => ({tag:'img',image_key:key})
const words = text => ({tag:'text',text})

test('an image reads as the same marker everywhere; invalid keys and the legacy rendering show nothing',()=>{
  assert.equal(imageMarker('img_v3_a-1'),mark('img_v3_a-1'));assert.notEqual(imageMarker('img_a'),imageMarker('img_b'))
  for (const key of ['img_v3_a-1','img_'+'x'.repeat(256)]) assert.equal(imageKey(key),true)
  for (const key of ['img_','img_'+'x'.repeat(257),'file_v3_a','IMG_a','img_a b','img_a/../b',' img_a','img_a\n',undefined,7])
    assert.equal(imageKey(key),false,String(key))
  const body={title:'标题',content:[[words('看'),img('img_one')],[img('bad key')],[img('img_two'),words('和'),img('img_one')]]}
  assert.equal(postText(body,[],{}),'标题\n看'+mark('img_one')+'\n'+mark('img_two')+'和'+mark('img_one'))
  assert.deepEqual(postImages(body),['img_one','img_two','img_one'])
  assert.equal(legacyPostText(body,[]),'标题\n看\n和')
  for (const other of [undefined,{},{content:'x'},{content:[img('img_one')]}]) assert.deepEqual(postImages(other),[])
})

// Feishu conversations with images, read through the source as in history-cli.test.mjs.
const api='/open-apis/im/v1/messages', chatId='oc_one', tenantId='tenant', recipientId='ou_me', root='om_root', omt='omt_topic'
const at=1_800_000_000_555, messageId='om_target', writer='ou_writer', forbidden='DO_NOT_IMPORT'
const ok=data=>({ok:true,identity:'user',data})
const page=(items,token)=>({items,has_more:!!token,...(token ? {page_token:token} : {})})
const flag=(argv,key)=>argv[argv.indexOf(key)+1]
const sender=(id=writer)=>({sender_type:'user',id_type:'open_id',id,tenant_key:tenantId})
const row=(message_id,t,msg_type,content,patch={})=>({message_id,chat_id:chatId,create_time:String(t),deleted:false,msg_type,
  sender:sender(),body:{content:JSON.stringify(content)},...patch})
const text=(id,t,s,patch)=>row(id,t,'text',{text:s},patch)
const image=(id,t,key,patch)=>row(id,t,'image',{image_key:key},patch)
const post=(id,t,lines,patch)=>row(id,t,'post',{content:lines},patch)
const thread={thread_id:omt,root_id:root,parent_id:root}
const direct={key:'@_user_1',id:recipientId,id_type:'open_id',tenant_key:tenantId}
// The request: a rich-text message that mentions the owner and shows one image.
const request=(patch={})=>post(messageId,at,[[{tag:'at',user_id:'@_user_1'},words(' 看这张'),img('img_req')]],{mentions:[direct],...patch})
const requestText='@你 看这张'+mark('img_req')
const shown=(id,key,t)=>({messageId:id,key,at:t})
const turns=e=>JSON.parse(e.workerContext).map(r=>r.text)

// The raw adapter response, and when the system CLI exists also its own jq projection on a synthetic dry run.
function projections(t) {
  const raw=(_argv,data)=>ok(data)
  const home=mkdtempSync(join(tmpdir(),'sa-images-jq-'))
  t.after(()=>rmSync(home,{recursive:true,force:true}))
  const env={HOME:home,PATH:process.env.PATH,LARKSUITE_CLI_CONFIG_DIR:home,LARKSUITE_CLI_APP_ID:'cli_offline_fixture',
    LARKSUITE_CLI_APP_SECRET:'fixture',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}
  const invoke=args=>execFileSync('lark-cli',args,{env,cwd:home,encoding:'utf8',timeout:10_000})
  try {invoke(['--version'])} catch(e) {if(e.code==='ENOENT') {t.diagnostic('no system CLI: raw projection only');return [raw]} throw e}
  return [raw,(argv,data)=>{
    const args=[...argv,'--dry-run'], i=args.indexOf('--jq')
    args[i+1]='.data='+JSON.stringify(data)+'|('+args[i+1]+')'
    const out=invoke(args)
    assert.ok(!out.includes(forbidden),'an invalid image or unrelated body escaped CLI stdout')
    return {...JSON.parse(out),dry_run:false}
  }]
}

function conversation({target=request(),options={},list=()=>page([]),rootRows=[],question,project}) {
  let admitted=false
  const config={enabled:true,profile:'fixture',tenantId,recipientId,automationSince:at-350_000,...options}
  const threadId=target.root_id || target.message_id
  const grant={mode:'permanent',chatId,threadId,approvedAt:at+100,triggers:[{threadId,messageId,at}]}
  const events=[]
  const source=createFeishuSource({config,admission:{async run(_scope,fn){admitted=true;try {return await fn(grant)} finally {admitted=false}}},
    receive(event){assert.ok(admitted);events.push(event)},async run(argv){
      assert.ok(admitted)
      const has=s=>argv.includes(s)
      if(has('im:message.p2p_msg:get_as_user')) return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
      if(has('+get-user')) return ok({user:{open_id:recipientId,tenant_key:tenantId}})
      if(has('chats')) return ok({chat_mode:'group',group_message_type:'chat',external:false,tenant_key:tenantId})
      if(has(api+'/'+messageId)) return ok({items:[target]})
      if(has(api+'/'+root)) return project(argv,{items:rootRows})
      if(question && has(api+'/'+question.message_id)) return project(argv,{items:[question]})
      assert.ok(has(api) && has('GET') && has('--jq'))
      return project(argv,list(JSON.parse(flag(argv,'--params'))))
    }})
  return {events,consume:()=>source.consumeMention({chatId,threadId,messageId,at}),
    readReply:questionId=>source.readQuestionReply({source:{kind:'feishu',tenantId,recipientId,chatId,threadId},
      messageId,requesterId:writer,questionId,originalText:'archived request'},()=>{})}
}

test('flat history: images read as markers, image-only posts count, empty rows take no count slot',async t=>{
  // Newest first, as the chat listing returns them.
  const rows=[
    post('om_empty',at-3,[[img('bad key')]]), image('om_badimg',at-5,forbidden),
    post('om_only',at-10,[[img('img_only'),img('img_mix')]]), post('om_mix',at-20,[[words('说明'),img('img_mix')]]),
    image('om_pic',at-30,'img_old'), text('om_text',at-40,'older words'), text('om_oldest',at-50,'beyond the count'),
  ]
  for (const project of projections(t)) {
    const f=conversation({options:{historyCount:4},project,list:()=>page(rows)})
    await f.consume()
    const [event]=f.events
    assert.equal(event.text,requestText)
    assert.deepEqual(turns(event),['older words',mark('img_old'),'说明'+mark('img_mix'),mark('img_only')+mark('img_mix')])
    // Each image once, in conversation order; the request's own image comes at the request's time.
    assert.deepEqual(event.workerImages,[shown('om_pic','img_old',at-30),shown('om_mix','img_mix',at-20),
      shown('om_only','img_only',at-10),shown(messageId,'img_req',at)])
  }
})

test('native thread: an image root, image-only replies and the request’s own image, each once in order',async t=>{
  const target=request(thread)
  const listing=[{...post('om_t1',at-50,[[img('img_t1')]]),...thread},{...text('om_t2',at-40,'words'),...thread},
    {...image('om_t3',at-30,forbidden),...thread},{...post('om_t4',at-20,[[img('bad key')]]),...thread},
    {...target,body:{content:JSON.stringify({content:[[words(forbidden)]]})}}, // An edited copy of the request.
    {...image('om_t5',at+10,'img_req'),...thread},{...image('om_t6',at+20,'img_late'),...thread}]
  for (const project of projections(t)) {
    const f=conversation({target,project,rootRows:[image(root,at-100,'img_root',{thread_id:omt,sender:sender('ou_third')})],list:()=>page(listing)})
    await f.consume()
    const [event]=f.events
    assert.deepEqual(turns(event),[mark('img_root'),mark('img_t1'),'words',requestText,mark('img_req'),mark('img_late')])
    assert.deepEqual(event.workerImages,[shown(root,'img_root',at-100),shown('om_t1','img_t1',at-50),
      shown(messageId,'img_req',at),shown('om_t6','img_late',at+20)])
  }
})

test('an image-only reply to a clarification counts as the reply, in a flat chat and in a native thread',async t=>{
  for (const project of projections(t)) {
    const question=text('om_q',at+1,'哪一张？',{parent_id:messageId,sender:sender(recipientId)})
    const answer=image('om_reply',at+2,'img_reply',{parent_id:'om_q'})
    const flat=conversation({project,question,list:()=>page([question,answer])})
    assert.deepEqual(await flat.readReply('om_q'),{chatId,threadId:messageId,messageId:'om_reply',senderId:writer,parentId:'om_q',
      at:at+2,text:mark('img_reply'),workerImages:[shown('om_reply','img_reply',at+2)]})

    const asked={...question,...thread,parent_id:messageId}, replied={...post('om_reply',at+2,[[img('img_reply')]]),...thread,parent_id:'om_q'}
    const native=conversation({target:request(thread),project,question:asked,rootRows:[image(root,at-100,'img_root',{thread_id:omt})],
      list:()=>page([{...image('om_t1',at-50,'img_t1'),...thread},asked,replied])})
    const {workerContext,...reply}=await native.readReply('om_q')
    // The refreshed thread supplies every image the worker may need, including the request's own.
    assert.deepEqual(reply,{chatId,threadId:root,messageId:'om_reply',senderId:writer,parentId:'om_q',at:at+2,text:mark('img_reply'),
      workerImages:[shown(root,'img_root',at-100),shown('om_t1','img_t1',at-50),shown(messageId,'img_req',at),shown('om_reply','img_reply',at+2)]})
    assert.deepEqual(JSON.parse(workerContext).map(r=>r.text),[mark('img_root'),mark('img_t1'),'archived request','哪一张？',mark('img_reply')])
  }
})

// Downloading the images of a job's conversation.
const job={source:{kind:'feishu',tenantId,recipientId,chatId,threadId:root},requesterId:writer}
function downloads({run,deny=false,options={}}) {
  const scopes=[]
  const config={enabled:true,profile:'fixture',tenantId,recipientId,automationSince:at-350_000,...options}
  const grant={mode:'permanent',chatId,threadId:root,approvedAt:at}
  const source=createFeishuSource({config,cliDir:'/cli-config',admission:{async run(scope,fn){
    scopes.push(scope)
    if(deny) throw Object.assign(Error('denied'),{code:'admission-denied'})
    return fn(grant)
  }},receive:()=>assert.fail('downloading images receives nothing'),async run(argv,input,cliDir,cwd){
    if(argv.includes('im:message.p2p_msg:get_as_user')) return {ok:false,granted:[],missing:['im:message.p2p_msg:get_as_user']}
    if(argv.includes('+get-user')) return ok({user:{open_id:recipientId,tenant_key:tenantId}})
    if(argv.includes('chats')) return ok({chat_mode:'group',external:false,tenant_key:tenantId})
    return run(argv,input,cliDir,cwd)
  }})
  return {source,scopes,grant,load:(refs,checkGrant=()=>{})=>source.images({...job,refs},checkGrant)}
}

test('images() downloads each one into a fresh private directory, keeps only a file saved there, and removes the directory',async t=>{
  const outside=mkdtempSync(join(tmpdir(),'sa-images-outside-'))
  t.after(()=>rmSync(outside,{recursive:true,force:true}))
  writeFileSync(join(outside,'image'),'OUTSIDE')
  const saved=(dir,name='image')=>ok({saved_path:join(dir,name)})
  const behave={
    img_good:dir=>{writeFileSync(join(dir,'image.png'),'PNG');return saved(dir,'image.png')},
    img_failed:()=>{throw new Error('download refused')},
    img_refused:()=>({ok:false,error:{code:1}}),
    img_bot:dir=>{writeFileSync(join(dir,'image'),'BOT');return {...saved(dir),identity:'bot'}},
    img_outside:()=>saved(outside),
    img_link:dir=>{symlinkSync(join(outside,'image'),join(dir,'image'));return saved(dir)},
    img_folder:dir=>{mkdirSync(join(dir,'image'));return saved(dir)},
    img_missing:dir=>saved(dir,'nothing'),
    img_large:dir=>{writeFileSync(join(dir,'image'),'');truncateSync(join(dir,'image'),50*1024*1024+1);return saved(dir)},
  }
  const keys=Object.keys(behave), dirs=[], checked=[]
  const f=downloads({run:async(argv,input,cliDir,cwd)=>{
    const key=flag(argv,'--file-key')
    assert.deepEqual(argv,['--profile','fixture','im','+messages-resources-download','--message-id','om_'+key.slice(4),'--file-key',key,
      '--type','image','--output','image','--as','user','--format','json'])
    assert.equal(input,undefined);assert.equal(cliDir,'/cli-config')
    assert.equal(dirname(cwd),realpathSync(tmpdir()));assert.match(basename(cwd),/^superagent-image-/)
    assert.ok(existsSync(cwd) && !dirs.includes(cwd));dirs.push(cwd)
    return behave[key](cwd)
  }})
  const out=await f.load(keys.map(key=>({messageId:'om_'+key.slice(4),key})),g=>checked.push(g))
  assert.deepEqual(out,[Buffer.from('PNG'),...Array(keys.length-1).fill(null)])
  assert.equal(dirs.length,keys.length);assert.ok(dirs.every(d=>!existsSync(d)),'every private directory is removed')
  assert.ok(existsSync(join(outside,'image')),'a link out of the directory is removed, not its target')
  // Admission names the requester, and the job's grant is rechecked before each download.
  assert.deepEqual(f.scopes,[{chatId,threadId:root,senderId:writer}])
  assert.equal(checked.length,keys.length+1);assert.ok(checked.every(g=>g===f.grant))
})

test('images() refuses malformed requests before any CLI call; admission or a revoked grant stops downloads',async()=>{
  const calls=[], run=async(_argv,_input,_cliDir,cwd)=>{calls.push(cwd);return ok({saved_path:join(cwd,'none')})}
  const good={messageId:'om_a',key:'img_a'}
  for (const refs of [undefined,'img_a',[{...good,key:'file_a'}],[{...good,messageId:'oc_a'}],[{key:'img_a'}],Array(101).fill(good)])
    await assert.rejects(downloads({run}).load(refs),{code:'source-unavailable'})
  const f=downloads({run})
  await assert.rejects(f.source.images({...job,source:{...job.source,tenantId:'other'},refs:[good]},()=>{}),{code:'source-unavailable'})
  await assert.rejects(f.source.images({...job,refs:[good]}),{code:'source-unavailable'})
  await assert.rejects(downloads({run,options:{automationSince:undefined}}).load([good]),{code:'source-unavailable'})
  assert.deepEqual(f.scopes,[])
  const denied=downloads({run,deny:true})
  await assert.rejects(denied.load([good]),{code:'admission-denied'})
  assert.deepEqual(calls,[])
  // Without a valid requester the grant must cover the whole conversation.
  assert.deepEqual(await f.source.images({...job,requesterId:'someone',refs:[]},()=>{}),[])
  assert.deepEqual(f.scopes,[{chatId,threadId:root}])
  let n=0
  await assert.rejects(f.load([good,{messageId:'om_b',key:'img_b'}],()=>{if(++n===3) throw Object.assign(Error('revoked'),{code:'admission-denied'})}))
  assert.equal(calls.length,1,'the second image is not downloaded after the grant was revoked')
})

// The work queue carries image references with the job.
const input={caseId:'case_1',messageId:'om_in',text:'Example request',requesterId:'ou_requester',
  source:{kind:'feishu',scopeId:'f'.repeat(64),tenantId:'test',recipientId:'ou_owner',chatId:'oc_group',threadId:'om_root'},
  team:{lead:'',develop:'chosen',answer:''},roleModels:{develop:{provider:'fake',model:'test'}}}
const pic=(n,t=n)=>({messageId:'om_p'+n,key:'img_'+n,at:t})
const result={answer:'Done',sessionId:'worker-1',workspaceId:'space_1',resolvedPresetId:'chosen'}
function queue(effects={},initial,options={}) {
  const h={saved:structuredClone(initial),commits:[],calls:[]}
  let sent=0
  const actor=(name,fallback)=>async b=>{h.calls.push([name,b.messageId,structuredClone(b.workerImages)]);return (effects[name] ?? fallback)(b)}
  h.loop=createLoop({load:async()=>h.saved,save:async v=>{h.saved=structuredClone(v);h.commits.push(h.saved)},
    decide:actor('decide',()=>({action:'work',role:'develop'})),work:actor('work',()=>result),
    deliver:actor('deliver',({source,messageId})=>({chatId:source.chatId,inReplyTo:messageId,messageId:'om_sent'+(++sent)})),
    isReleaseRequired:()=>false,...options})
  return h
}
const storedJob=(h,id=input.messageId)=>h.saved.jobs.find(j=>j.messageId===id)
const sentTo=(h,actor)=>h.calls.filter(c=>c[0]===actor).map(c=>c[2])

test('job images are validated, reach the Router and the worker, and are dropped once the job is finished',async()=>{
  for (const bad of [[],{},'img_1',Array.from({length:101},(_,i)=>pic(i+1)),[{...pic(1),extra:true}],[{key:'img_1',at:1}],
    [{...pic(1),key:'file_1'}],[{...pic(1),key:'img_'+'x'.repeat(257)}],[{...pic(1),messageId:'oc_1'}],[pic(1,0)],[pic(1,1.5)],
    [pic(1),{...pic(2),key:'img_1'}]])
    await assert.rejects(queue().loop.enqueue({...input,workerImages:bad}),{code:'invalid-input'},JSON.stringify(bad).slice(0,80))
  const images=[pic(1),pic(2)], h=queue()
  await h.loop.enqueue({...input,workerImages:images});await h.loop.drain()
  assert.deepEqual(h.calls,[['decide',input.messageId,images],['work',input.messageId,images],['deliver',input.messageId,undefined]])
  const [row]=await h.loop.snapshot()
  assert.equal(row.status,'delivered');assert.ok(!('workerImages' in row) && !('workerImages' in storedJob(h)))
  // A stored job with malformed images, or a finished one still holding them, fails closed on load.
  const bad=structuredClone(h.commits[0]);bad.jobs[0].workerImages=[{...pic(1),key:'bad'}]
  const leaked=structuredClone(h.saved);leaked.jobs[0].workerImages=images
  for (const doc of [bad,leaked]) await assert.rejects(queue({},doc).loop.snapshot(),{code:'storage-unavailable'})
})

test('a failed Router or worker keeps the images for the owner’s retry',async()=>{
  const images=[pic(1)], retry={caseId:input.caseId,messageId:input.messageId}
  for (const [effects,actors] of [[{decide:()=>{throw Error('offline')}},['decide','work']],
    [{work:()=>{throw Object.assign(Error(),{code:'WORK_UNCERTAIN'})}},['work']]]) {
    const failed=queue(effects)
    await failed.loop.enqueue({...input,workerImages:images});await failed.loop.drain()
    assert.ok(['stopped','uncertain'].includes(storedJob(failed).status));assert.deepEqual(storedJob(failed).workerImages,images)
    const again=queue({},failed.saved)
    await again.loop.retry(retry);await again.loop.drain()
    assert.deepEqual(again.calls.filter(c=>c[0]!=='deliver').map(c=>[c[0],c[2]]),actors.map(a=>[a,images]))
    assert.equal(storedJob(again).status,'delivered');assert.ok(!('workerImages' in storedJob(again)))
  }
})

test('a merged message adds its images to the job it joins: each image once, at most the newest hundred',async()=>{
  const caseInfo=async()=>({archived:false,text:'Case text',requesterId:input.requesterId,team:input.team,roleModels:input.roleModels})
  for (const [mine,theirs,joined] of [
    [[pic(1),pic(2)],[pic(2,5),pic(3,6)],[pic(1),pic(2),pic(3,6)]],
    [Array.from({length:100},(_,i)=>pic(i+1)),[pic(101)],Array.from({length:100},(_,i)=>pic(i+2))],
  ]) {
    const followUp={...input,messageId:'om_b',text:'Also this one.',workerImages:theirs}
    const h=queue({decide:b=>b.messageId===followUp.messageId ? {action:'merge',target:'w1'} : {action:'work',role:'develop'}},undefined,
      {caseInfo,isReleaseRequired:()=>true})
    await h.loop.enqueue({...input,workerImages:mine});await h.loop.drain()
    assert.equal(storedJob(h).status,'awaiting-release')
    await h.loop.enqueue(followUp);await h.loop.drain()
    assert.deepEqual(sentTo(h,'decide'),[mine,theirs]);assert.deepEqual(sentTo(h,'work'),[mine,joined])
    assert.deepEqual(storedJob(h).workerImages,joined)
    assert.equal(storedJob(h,followUp.messageId).status,'merged');assert.ok(!('workerImages' in storedJob(h,followUp.messageId)))
  }
})

test('the requester’s reply adds its images to the waiting job; malformed reply images are refused',async()=>{
  const seat={sessionId:result.sessionId,workspaceId:result.workspaceId,resolvedPresetId:result.resolvedPresetId}
  const h=queue({work:b=>b.requesterReply ? result : {...seat,question:'Which one?'}})
  await h.loop.enqueue({...input,workerImages:[pic(1),pic(2)]});await h.loop.drain()
  const [q]=await h.loop.waitingQuestions(input.source)
  const reply={chatId:q.source.chatId,threadId:q.source.threadId,senderId:q.requesterId,parentId:q.questionId,at:200,messageId:'om_answer',text:mark('img_9')}
  for (const workerImages of [[],{},'img_9',[{...pic(9),key:'bad'}]])
    await assert.rejects(h.loop.resumeQuestion(q,{...reply,workerImages}),{code:'invalid-input'})
  assert.equal(await h.loop.resumeQuestion(q,{...reply,workerImages:[pic(1,200),pic(9,200)]}),true);await h.loop.drain()
  assert.deepEqual(sentTo(h,'work'),[[pic(1),pic(2)],[pic(1),pic(2),pic(9,200)]])
  assert.equal(storedJob(h).status,'delivered')
})
