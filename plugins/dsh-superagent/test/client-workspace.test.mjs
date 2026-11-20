import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createLoop } from '../host/loop.js'

const files=['role-menu','roles','work-steps','edition','runtime']
const source=(await Promise.all(files.map(name=>readFile(new URL('../src/'+name+'.js',import.meta.url),'utf8')))).join('\n')
const {spaceCatalogStore,spaceCatalogRows,spaceRoleChoice,spaceActivity,spaceWithRuns,spaceCaseStatus,spaceStatus,SpaceGroup,
  spaceCall,spacePresetGroups,spacePresetOptions,spacePresetLabel,spaceRecordedPreset,spaceWorkSteps,SpaceMessageWork,SpaceRecord,EditionWorkspace,SpaceConnected}=new Function(source+`
  return {spaceCatalogStore,spaceCatalogRows,spaceRoleChoice,spaceActivity,spaceWithRuns,spaceCaseStatus,spaceStatus,SpaceGroup,
    spaceCall,spacePresetGroups,spacePresetOptions,spacePresetLabel,spaceRecordedPreset,spaceWorkSteps,SpaceMessageWork,SpaceRecord,EditionWorkspace,SpaceConnected}`)()
const tr=cn=>cn
const fixtureSource={scopeId:'scope',settings:{tenantId:'tenant',recipientId:'me'}}

test('an empty workspace offers neither generated cases nor a sample-data action',()=>{
  assert.deepEqual(spaceActivity([],[],fixtureSource),[])
  assert.doesNotMatch(source,/spaceSampleCases|查看示例数据|sampleAt|x2-utilities/)
})

test('a real loop projection restores the public handoffs in the correct conversation after restart',async()=>{
  let saved
  const adapter={isReleaseRequired:()=>false,load:()=>saved,save:v=>{saved=structuredClone(v)},
    decide:()=>({action:'work',role:'develop',criteria:'保留截止时间'}),
    work:()=>({answer:'周一中午截止',sessionId:'work_1',workspaceId:'space_1',resolvedPresetId:'DevLoop'}),
    deliver:({source,messageId})=>({chatId:source.chatId,inReplyTo:messageId,messageId:'om_reply'})}
  const loop=createLoop(adapter)
  await loop.enqueue({caseId:'case_1',messageId:'om_in',text:'何时截止？',team:{lead:'',develop:'DevLoop',answer:''},roleModels:{},
    source:{kind:'feishu',scopeId:'b'.repeat(64),tenantId:'tenant',recipientId:'ou_me',chatId:'oc_group',threadId:'om_root'}})
  await loop.drain()
  await loop.dispose()
  const reopened=createLoop(adapter)
  try {
    const incoming=id=>({kind:'feishu',status:'received',requestId:id})
    const [item]=spaceWithRuns([{id:'case_1',messages:[incoming('om_other'),incoming('om_in')]}],await reopened.snapshot())
    const [earlier,latest]=item.messages,steps=spaceWorkSteps(latest,tr)
    assert.equal(earlier.run,undefined)
    assert.deepEqual(steps.map(s=>s.kind),['decision','assignment','worker','delivery'])
    assert.equal(latest.run.answer,'周一中午截止')
    assert.equal(latest.run.receipt.inReplyTo,latest.requestId)
  } finally {await reopened.dispose()}
})

test('case conversations and workspace activity are peer destinations, independent of available records',()=>{
  const route=new Function(source+';return spaceWorkspaceView')()
  const rows=[0,1,2,3].map(i=>({id:'case'+i,hasWork:i<3,source:{kind:'feishu',chatId:'oc_demo',...fixtureSource.settings},
    messages:[{kind:'feishu',requestId:'om_'+i,text:'fixture',at:100+i}]})),work=rows[1].id,ignored=rows[3].id
  for(const compact of [true,false]) {
    const show=(section,data,fields)=>route(data,{section,...fields},compact,spaceActivity(data,[],fixtureSource))
    for(const data of [[],[rows[3]]]) assert.equal(show('cases',data).page,'cases')
    assert.equal(show('cases',rows).page,compact?'cases':'record')
    assert.equal(show('cases',rows).records.length,3)
    assert.equal(show('cases',rows,{caseId:work,detailId:work}).selected.id,work)
    assert.equal(show('cases',rows,{caseId:work}).selected.id,work)
    assert.equal(show('activity',rows,{caseId:work}).page,'activity')
    assert.equal(show('activity',rows,{caseId:work,anchor:spaceActivity(rows,[],fixtureSource).find(r=>r.item.id===ignored).key}).selected.id,ignored)
    assert.equal(show('activity',rows,{caseId:work,backId:'message-key'}).page,'activity')
    assert.equal(show('activity',[],{detailId:ignored}).page,'activity')
  }
  assert.match(String(EditionWorkspace),/useState\(\{section:'cases'\}\)/)
  assert.match(String(EditionWorkspace),/\[\['cases',casesLabel\],\['activity',activityLabel\]\]\.map/)
  assert.match(String(EditionWorkspace),/tr\('事项','Cases'\)/);assert.doesNotMatch(source,/事项会话|Case conversations/)
})

test('an archived case leaves the case list but keeps its activity; the row menu offers retry and archive like a DSH session row',()=>{
  const route=new Function(source+';return spaceWorkspaceView')(),retryable=new Function(source+';return spaceRetryable')()
  const caseMenu=new Function(source+';return spaceCaseMenu')()
  const rows=[0,1].map(i=>({id:'case'+i,hasWork:true,...i===1 && {archivedAt:5},source:{kind:'feishu',chatId:'oc_demo',...fixtureSource.settings},
    messages:[{kind:'feishu',requestId:'om_'+i,text:'fixture',at:100+i}]}))
  assert.deepEqual(route(rows,{section:'cases'},false).records.map(r=>r.id),['case0'])
  const entries=spaceActivity(rows,[],fixtureSource),archived=entries.find(r=>r.item.id==='case1')
  assert.equal(route(rows,{section:'activity',anchor:archived.key},false,entries).selected.id,'case1')
  for(const [run,ok] of [[{status:'stopped',reason:'decision-failed'},true],[{status:'stopped',reason:'work-failed',role:'develop'},true],
    [{status:'uncertain',reason:'work-uncertain'},true],[{status:'uncertain',reason:'delivery-uncertain'},false],
    [{status:'ignored'},false],[{status:'declined'},false],[{status:'delivered'},false],[{status:'working'},false]])
    assert.equal(retryable(run),ok,JSON.stringify(run))
  const calls=[],state={tr:z=>z,source:{scopeId:'scope',...fixtureSource},archive:i=>calls.push(['archive',i.id]),retry:(i,m)=>calls.push(['retry',i.id,m.requestId]),
    records:[{...rows[0],messages:[{requestId:'om_old',run:{status:'stopped',reason:'work-failed'}},{requestId:'om_new',run:{status:'stopped',reason:'decision-failed'}}]},
      {...rows[0],id:'done',messages:[{requestId:'om_done',run:{status:'delivered'}}]},
      {...rows[0],id:'local',source:{kind:'local'},messages:[{requestId:'r',run:{status:'stopped'}}]}]}
  const menu=id=>caseMenu(state,id)
  assert.deepEqual(menu('case0').map(a=>a.label),['重试','归档'])
  menu('case0').forEach(a=>a.run())
  assert.deepEqual(calls,[['retry','case0','om_new'],['archive','case0']])
  assert.deepEqual(menu('done').map(a=>a.label),['归档'])
  assert.deepEqual(menu('local').map(a=>a.label),['重试'])
  const seat={role:'develop',workerSessionId:'superagent-auto-w'},taken=[]
  state.takeOver=(i,m)=>taken.push([i.id,m.requestId])
  state.records.push({...rows[0],id:'live',messages:[{requestId:'om_w',run:{...seat,status:'working'}}]},
    {...rows[0],id:'posting',messages:[{requestId:'om_p',run:{...seat,status:'delivering'}}]},
    {...rows[0],id:'unseated',messages:[{requestId:'om_u',run:{role:'develop',status:'working'}}]},
    {...rows[0],id:'failed',messages:[{requestId:'om_f',run:{...seat,status:'stopped',reason:'work-failed'}}]})
  assert.deepEqual(menu('live').map(a=>a.label),['接手','归档'])
  menu('live')[0].run();assert.deepEqual(taken,[['live','om_w']])
  assert.deepEqual(menu('posting').map(a=>a.label),['归档'])
  assert.deepEqual(menu('unseated').map(a=>a.label),['归档'])
  assert.deepEqual(menu('failed').map(a=>a.label),['接手','重试','归档'])
  assert.deepEqual(menu('missing'),[])
  const ui=String(EditionWorkspace)
  assert.match(ui,/p\.menu\?\.button\(\{target,label:/);assert.match(ui,/kind:'superagent-case'/);assert.doesNotMatch(ui,/name:'chevron'/)
})

test('SuperAgent is a standalone named global settings page; successful settings changes notify the mounted workspace',async()=>{
  const slots=new Map(),calls=[],deferred=[]
  let allow=true
  // The attention indicator starts polling as an effect; run it explicitly below.
  const ctx={slots:{inject:(name,run)=>run(),register:(slot,page)=>slots.set(slot.name,{...slot,page})},
    effect:(fn,label)=>/attention/.test(label) ? deferred.push(label) : fn(),on:()=>()=>{},get:()=>undefined,
    locale:{register(){},bind:()=>()=> 'SuperAgent'},uiWorkspace:{openSession:id=>calls.push(id)},
    connection:{rpc:{call:async(_base,path)=>{calls.push(path);return allow?{ok:true,value:{}}:{ok:false,error:{code:'forbidden'}}}}}}
  new Function(source+';return applySuperagent')()(ctx)
  assert.deepEqual(deferred,['superagent: attention indicator','superagent: attention after reconnect'])
  assert.equal(slots.get('sidebar.panellist').id,'pcmid-superagent')
  const section=slots.get('settings.section'),icon=slots.get('settings.section.icon'),main=slots.get('main')
  assert.equal(section.label(),'SuperAgent')
  assert.equal(section.order,25)
  assert.equal(icon.id,section.id)
  assert.equal(main.key,section.id)
  const {ops,settingsOnly}=section.inject()
  assert.equal(settingsOnly,true)
  assert.equal(main.inject().settingsOnly,undefined)
  assert.deepEqual(calls,[]) // Registration does not load cases or begin authorization.
  await main.inject().ops.openSession('historical-session')
  assert.deepEqual(calls,['historical-session'])
  assert.equal(main.inject().ops.openMenu,undefined,'without the shared menu the approval choices stay plain buttons')
  let changed=0
  const off=main.inject().ops.onSettingsChange(()=>changed++)
  await ops.ask('settingsSnapshot',{})
  assert.equal(changed,0)
  await ops.ask('configure',{team:{lead:'helper'}})
  assert.equal(changed,1)
  await ops.ask('setReleasePolicy',{required:false})
  assert.equal(changed,2)
  allow=false
  await assert.rejects(()=>ops.ask('groupAccess',{}))
  assert.equal(changed,2)
  off()
  allow=true
  await ops.ask('saveFeishu',{})
  assert.equal(changed,2)
})

function mountWith(services,uiWorkspace) {
  const slots=new Map()
  new Function(source+';return applySuperagent')()({slots:{inject:(name,run)=>run(),register:(slot,page)=>slots.set(slot.name,{...slot,page})},
    effect:(fn,label)=>/attention/.test(label) ? undefined : fn(),on:()=>()=>{},get:name=>services[name],
    locale:{register(){},bind:()=>()=> 'SuperAgent'},uiWorkspace,connection:{rpc:{call:async()=>({ok:true,value:{}})}}})
  return slots.get('main').inject().ops
}
test('opening an archived worker session restores it to the sidebar first; an active one opens directly',async()=>{
  const calls=[],archivedSessionIds=['archived-seat']
  const ui={unarchiveSession:async id=>{calls.push(['unarchive-start',id]);await new Promise(r=>setTimeout(r,5));calls.push(['unarchive-done',id])},
    openSession:id=>calls.push(['open',id])}
  const ops=mountWith({workspaces:{list:{getSnapshot:()=>({archivedSessionIds})}}},ui)
  await ops.openSession('archived-seat')
  assert.deepEqual(calls,[['unarchive-start','archived-seat'],['unarchive-done','archived-seat'],['open','archived-seat']])
  calls.length=0;await ops.openSession('active-seat')
  assert.deepEqual(calls,[['open','active-seat']])
  // Without the workspace list (or its snapshot) nothing is restored, and the session still opens.
  for(const services of [{},{workspaces:{}},{workspaces:{list:{getSnapshot:()=>undefined}}}]) {
    calls.length=0;await mountWith(services,ui).openSession('archived-seat')
    assert.deepEqual(calls,[['open','archived-seat']])
  }
  // A failed restore does not open the session.
  calls.length=0
  const failing=mountWith({workspaces:{list:{getSnapshot:()=>({archivedSessionIds})}}},{...ui,unarchiveSession:async()=>{throw Error('offline')}})
  await assert.rejects(failing.openSession('archived-seat'),/offline/);assert.deepEqual(calls,[])
})
test('approval dropdowns use the shared DSH menu: registration by kind and an anchored popup',async()=>{
  const registered=[],opened=[],off=()=>{}
  const ops=mountWith({contextMenus:{register:entry=>{registered.push(entry);return off},open:(target,point)=>opened.push([target,point]),notify(){}}},{})
  const value={key:'k',menu:'allow'}
  assert.equal(ops.registerMenu('pcmid-superagent.approval','superagent-approval',v=>['resolved',v]),off)
  assert.deepEqual(registered.map(({id,target,order})=>({id,target,order})),[{id:'pcmid-superagent.approval',target:'superagent-approval',order:0}])
  assert.deepEqual(registered[0].resolve(value),['resolved',value])
  ops.openMenu({kind:'superagent-approval',value},{x:1,y:2})
  assert.deepEqual(opened,[[{kind:'superagent-approval',value},{x:1,y:2}]])
  const bare=mountWith({},{})
  assert.equal(typeof bare.registerMenu('id','kind',()=>[]),'function');assert.equal(bare.openMenu,undefined)
})

test('the sidebar attention dot rereads attention only when the view revision changes and stops cleanly',async()=>{
  const store=new Function(source+';return spaceAttentionStore')()
  const saved={document:globalThis.document,window:globalThis.window},calls=[]
  let rev=1,needed=true
  globalThis.document={hidden:false};globalThis.window={addEventListener(){},removeEventListener(){}}
  try {
    const s=store(async endpoint=>{calls.push(endpoint);return endpoint==='viewRevision' ? rev : {needed,revision:rev}})
    let seen=0;const off=s.subscribe(()=>seen++)
    const stop=s.start()
    await new Promise(r=>setTimeout(r,10))
    assert.equal(s.getSnapshot(),true);assert.equal(seen,1);assert.deepEqual(calls,['viewRevision','attention'])
    s.refresh();await new Promise(r=>setTimeout(r,10))
    assert.deepEqual(calls.slice(2),['viewRevision','attention']);assert.equal(seen,1,'unchanged state does not notify')
    rev=2;needed=false;s.refresh();await new Promise(r=>setTimeout(r,10))
    assert.equal(s.getSnapshot(),false);assert.equal(seen,2)
    globalThis.document.hidden=true;const before=calls.length;s.refresh();await new Promise(r=>setTimeout(r,10))
    assert.equal(calls.length,before,'a hidden page does not poll')
    off();stop()
  } finally {Object.assign(globalThis,saved)}
})

test('the client posts only its addressed owner RPC and propagates a refusal rather than a result',async()=>{
  const calls=[]
  const context={connection:{rpc:{call:async(...args)=>{calls.push(args);return {ok:true,value:{cases:[]}}}}}}
  assert.deepEqual(await spaceCall(context,'snapshot',{}),{cases:[]})
  assert.deepEqual(calls,[['/api','pcmid/superagent/snapshot',{}]])
  context.connection.rpc.call=async()=>({ok:false,error:{code:'scope-changed',message:'old scope'}})
  await assert.rejects(()=>spaceCall(context,'groupAccess',{}),{code:'scope-changed'})
})

test('the workspace has no new request pane, local composer or intake submission; historical sessions can still open',()=>{
  assert.doesNotMatch(String(EditionWorkspace),/pane:\s*['"]new['"]|['"]settings['"]|SpaceSettings/)
  for(const component of [EditionWorkspace,SpaceRecord,SpaceMessageWork,SpaceConnected]) {
    assert.doesNotMatch(String(component),/SpaceIntake|['"]intake['"]|h\(['"](?:form|input|textarea)['"]/)
  }
  assert.match(String(SpaceRecord),/p\.openSession\(item\.sessionId\)/)
})

test('activity only includes Feishu messages; local intake stays in its case and dispatch is not completion',()=>{
  const local={kind:'local',requestId:'owner',at:2,status:'uncertain'}
  const mention={kind:'feishu',requestId:'mention',at:3,status:'received'}
  const c={id:'case',source:{kind:'feishu',chatId:'oc_fixture',...fixtureSource.settings},status:'received',sessionId:null,messages:[local,mention]}
  assert.deepEqual(spaceActivity([c],[],fixtureSource).map(e=>[e.item.id,e.message.requestId]),[['case','mention']])
  assert.equal(spaceCaseStatus(c),'uncertain')
  assert.equal(spaceCaseStatus({...c,messages:[{...local,status:'dispatching'},mention]}),'dispatching')
  assert.equal(spaceStatus('submitted',tr),'已交给 DSH')
  assert.equal(spaceActivity([]).length,0)
})

test('two requests in one thread open their own work sessions; acceptance is distinct from a send receipt',()=>{
  const source={id:'case',status:'received',sessionId:null,messages:['om_a','om_b'].map(requestId=>({kind:'feishu',status:'received',requestId}))}
  const run=(messageId,status,sessionId)=>({caseId:'case',messageId,status,sessionId})
  const sent=run('om_a','delivered','worker1')
  assert.equal(spaceWithRuns([source],[sent])[0].messages[0].status,'uncertain')
  const projection=spaceWithRuns([source],[run('om_b','approved','worker2'),{...sent,receipt:{messageId:'om_reply'}},{...run('om_a','working','other'),caseId:'different'}])[0]
  assert.equal(projection.sessionId,null);assert.equal(projection.status,'approved')
  assert.deepEqual(projection.messages.map(m=>[m.status,m.run.sessionId]),[['delivered','worker1'],['approved','worker2']])
  assert.match(String(SpaceRecord),/h\(SpaceMessageWork,\{p,item,message\}\)/)
  assert.match(String(SpaceMessageWork),/openSession\(run\.sessionId \|\| run\.workerSessionId\)/)
  assert.equal(spaceStatus('approved',tr),'已完成 · 尚未发送');assert.equal(spaceStatus('delivered',tr),'已回复原消息')
  assert.equal(spaceStatus('taken-over',tr),'已由你接手')
})
test('the case record lists human input, model text and reply-tool messages in order, nothing else',()=>{
  const output=new Function(source+';return spaceSeatOutput')()
  const event=(type,data)=>({type:'event',event:{type,data}}),live=(attemptId,chunk)=>({type:'transient',event:{type:'assistant/live-chunk',data:{attemptId,chunk}}})
  const user=text=>event('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text}]})
  const entries=[
    user('SUPERAGENT_WORK\ninstructions\n{"request":"PROMPT"}'),
    event('assistant/message',{message:{content:[{type:'reasoning',text:'thinking'},{type:'tool-call',id:'c1',name:'read',arguments:'{"path":"a"}'}]}}),
    event('tool/result',{message:{content:[{type:'text',text:'TOOL RESULT'}]}}),
    event('assistant/message',{message:{content:[{type:'text',text:'  '},{type:'text',text:'done'},
      {type:'tool-call',id:'c3',name:'superagent_ask_requester',arguments:'{"question":"Which version?"}'}]}}),
    user('SUPERAGENT_WORK\ninstructions\n{"request":"PROMPT","previousQuestion":"Which version?","requesterReply":"v2"}'),
    user('SUPERAGENT_CONTINUE\nNo result was submitted yet.'),
    event('assistant/message',{message:{content:[{type:'tool-call',id:'c4',name:'superagent_answer',arguments:'{"answer":"first"}'},
      {type:'tool-call',id:'c5',name:'superagent_answer',arguments:'{"answer":"second"}'}]}}),
    user('Owner after takeover'),
    live('a2',{type:'block-start',index:0,blockType:'text'}),live('a2',{type:'text-delta',index:0,text:'stre'}),live('a2',{type:'text-delta',index:0,text:'aming'}),
    live('a2',{type:'tool-call-delta',index:1,id:'c2',name:'bash',argumentsDelta:'{"c'}),live('a2',{type:'tool-call-delta',index:1,id:'c2',argumentsDelta:'":1}'}),
    live('a2',{type:'tool-call-delta',index:2,id:'c6',name:'superagent_answer',argumentsDelta:'{"answer":"par'}),
  ]
  assert.deepEqual(output(entries),[{kind:'text',text:'done'},{kind:'question',text:'Which version?'},{kind:'requester',text:'v2'},
    {kind:'reply',text:'first'},{kind:'reply',text:'second'},{kind:'owner',text:'Owner after takeover'},{kind:'text',text:'streaming'}])
  assert.deepEqual(output([]),[])
})
test('case materials show each brought-in line with its time, anonymized speaker and text',()=>{
  const {speaker,context}=new Function('h',source+';return {speaker:spaceSpeaker,context:SpaceIntakeContext}')(
    (type,props,...children)=>({type,props,children}))
  assert.deepEqual(['requester','owner','participant-2'].map(s=>speaker(s,tr)),['提需人','你','参与者 2'])
  assert.equal(context({tr,item:{messages:[{kind:'feishu',requestId:'m'}]}}),null)
  const rendered=JSON.stringify(context({tr,item:{messages:[{kind:'feishu',requestId:'m',context:[
    {speaker:'participant-1',at:Date.UTC(2026,0,1,8),text:'早先的讨论'},{speaker:'requester',at:Date.UTC(2026,0,1,9),text:'请处理',request:true}]}]}}))
  for(const part of ['带入的上下文','参与者 1','早先的讨论','提需人','（本条请求）','请处理'])assert.ok(rendered.includes(part),part)
  assert.match(String(new Function(source+';return SpaceMaterials')()),/h\(SpaceIntakeContext,\{tr,item\}\)/)
})
test('question confirmation, original requester wait and final confirmation are distinct projections',()=>{
  const c={id:'case',source:{kind:'feishu'},messages:[{kind:'feishu',requestId:'id'}]}
  const render=run=>spaceWithRuns([c],[{caseId:'case',messageId:'id',...run}])[0]
  const q=render({status:'awaiting-release',outputKind:'question'})
  assert.equal(spaceStatus(spaceCaseStatus(q),tr),'待你确认发送追问')
  for(const outputKind of ['answer',undefined])assert.equal(spaceStatus(spaceCaseStatus(render({status:'awaiting-release',outputKind})),tr),'待你确认发送最终答复')
  const waiting={status:'waiting-requester',outputKind:'question'}
  assert.equal(spaceStatus(render({...waiting,receipt:{messageId:'om_sent'}}).status,tr),'等待原提需人回复')
  assert.equal(render(waiting).status,'uncertain')
})

test('outbound review names the exact original group and only the current identity can decide this version',()=>{
  const select=new Function(source+';return spaceReleaseSelection')()
  const item={id:'case',feedScopeId:'scope',source:{kind:'feishu',...fixtureSource.settings,chatId:'oc_target',threadId:'om_topic'}}
  const run={caseId:'case',messageId:'om_in',status:'awaiting-release',releaseToken:'version-1',answer:'最终正文\n'.repeat(600)}
  const msg={kind:'feishu',requestId:'om_in',run}
  const m={scopeId:'scope',caseId:'case',messageId:'om_in',chatId:'oc_target',threadId:'om_topic',name:'正确群名',at:1234}
  const p={source:{...fixtureSource,groups:[{chatId:'oc_target',name:'旧群名'}]},mentions:[
    {...m,scopeId:'old',name:'旧账号'}, {...m,caseId:'other',name:'别的事项'}, {...m,messageId:'om_other',name:'别条'},
    {...m,threadId:'om_other',name:'别的话题'},{...m,chatId:'oc_other',name:'别群'},m]}
  assert.deepEqual(select(p,item,msg),{chatId:'oc_target',name:'正确群名',at:1234,input:{caseId:'case',messageId:'om_in',token:'version-1'}})
  assert.equal(select({...p,mentions:[]},item,msg).name,'旧群名')
  const topic=new Function(source+';return spaceReleaseTopic')()
  assert.match(topic(1234,9876,tr),/消息时间：/)
  assert.match(topic(undefined,9876,tr),/本机收件时间：/)
  assert.doesNotMatch(topic(undefined,9876,tr),/消息时间：/)
  assert.equal(topic(undefined,undefined,tr),'原消息')
  for(const [prop,record,message] of [
    [{...p,source:undefined},item,msg],[{...p,source:{...p.source,settings:{...fixtureSource.settings,recipientId:'other'}}},item,msg],
    [p,{...item,feedScopeId:'replaced'},msg],[p,{...item,source:{...item.source,tenantId:'old'}},msg],
    [p,{...item,source:{...item.source,threadId:''}},msg],
    ...[{releaseToken:undefined},{answer:'  '},{status:'declined'},{status:'delivered'}]
      .map(patch=>[p,item,{...msg,run:{...run,...patch}}])]) {
    assert.equal(select(prop,record,message).input,null)
  }
  for(const patch of [{caseId:'other'},{messageId:'om_other'}])assert.equal(select(p,item,{...msg,run:{...run,...patch}}),null)
})

test('a reply whose access was revoked can only be declined, with one line saying why',()=>{
  const fake=(type,props,...children)=>({type,props:props ?? {},children:children.flat()})
  const output=new Function('h','React',source+';return SpaceRunOutput')(fake,{Fragment:'fragment',useRef:()=>({current:null})})
  const find=(node,match)=>!node || typeof node!=='object' ? [] : [...(match(node) ? [node] : []),...node.children.flatMap(c=>find(c,match))]
  const text=node=>typeof node==='string' ? node : node && typeof node==='object' ? node.children.map(text).join('') : ''
  const item={id:'case',feedScopeId:'scope',source:{kind:'feishu',...fixtureSource.settings,chatId:'oc_target',threadId:'om_topic'}}
  const run={caseId:'case',messageId:'om_in',status:'awaiting-release',outputKind:'answer',releaseToken:'version-1',answer:'最终正文'}
  const sent=[],p={tr,busy:false,source:{...fixtureSource,groups:[]},mentions:[],releaseOutput:x=>sent.push(x)}
  const render=r=>output({p,item,message:{kind:'feishu',requestId:'om_in',run:r}})
  const open=render(run)
  assert.deepEqual(find(open,n=>n.type==='button').map(text),['确认发送','不发送'])
  assert.doesNotMatch(text(open),/授权已撤销/)
  const blocked=render({...run,releaseBlocked:true}),buttons=find(blocked,n=>n.type==='button')
  assert.deepEqual(buttons.map(text),['不发送'])
  assert.deepEqual(find(blocked,n=>n.type==='small').map(text),['授权已撤销，只能选择不发送。'])
  buttons[0].props.onClick()
  assert.deepEqual(sent,[{caseId:'case',messageId:'om_in',token:'version-1',action:'decline'}])
})

test('only details share outbound review: full answer before the destination and decision, never a composer or blind approval',()=>{
  const {row,detail,output,policy}=new Function(source+';return {row:SpaceActivityRow,detail:SpaceActivityDetail,output:SpaceRunOutput,policy:SpaceReleasePolicy}')()
  for(const component of [detail,SpaceRecord])assert.match(String(component),/h\(SpaceMessageWork,\{p,item,message\}\)/)
  assert.match(String(SpaceMessageWork),/h\(SpaceRunOutput,\{p,item,message\}\)/)
  assert.doesNotMatch(String(row),/SpaceRunOutput|SpaceMessageWork|releaseOutput|确认发送/)
  const result=String(output)
  assert.match(result,/h\('p',null,r\.answer\)[\s\S]*SpaceGroupLink[\s\S]*choose\('send'\)[\s\S]*choose\('decline'\)/)
  assert.match(result,/p\.releaseOutput\(\{\.\.\.target\.input,action\}\)/)
  assert.doesNotMatch(result,/\.slice\(|dangerouslySetInnerHTML|h\('(?:form|input|textarea)'/)
  assert.match(String(policy),/checked:p\.releaseRequired!==false/)
  assert.match(String(policy),/p\.setReleasePolicy\(\{required:next\}\)/)
  assert.match(String(SpaceMessageWork),/\['delivered','waiting-requester'\]\.includes\(run\.status\) && run\.receipt\?\.messageId/)
  assert.doesNotMatch(String(SpaceMessageWork),/h\('code',null,run\.receipt/)
  assert.equal(spaceCaseStatus({messages:[{status:'awaiting-release'},{status:'delivered'}],status:'delivered'}),'awaiting-release')
})

test('case materials describe the worker’s recorded preset without borrowing from another role or current settings',()=>{
  const item={team:{lead:'',develop:'',answer:''},roleModels:{},workerRole:'develop'}
  assert.match(spaceRecordedPreset(item,'develop',tr),/会话默认预设（未记录实际预设）/)
  const recorded={...item,resolvedPresetId:'frozen-default'}
  assert.equal(spaceRecordedPreset(recorded,'develop',tr),'会话默认预设 · frozen-default')
  assert.equal(spaceRecordedPreset(recorded,'answer',tr),null)
  const old={...item,workerRole:'lead',team:{...item.team,lead:'frozen-lead'},teamNames:{lead:'当时的负责人'}}
  assert.equal(spaceRecordedPreset(old,'lead',tr),'当时的负责人')
  assert.equal(spaceRecordedPreset(old,'develop',tr),null)
})

test('a previously pending message keeps its exact activity selection and original time when a case arrives',()=>{
  const {route,approve}=new Function(source+';return {route:spaceWorkspaceView,approve:spaceApprovalInput}')()
  const scopeId='scope',chatId='oc_group',threadId='om_root',target={scopeId,chatId,threadId}
  const first={...target,messageId:'om_a',at:20,text:'A',name:'协作群',canApprove:true}
  const second={...first,messageId:'om_b',at:30,text:'B'}
  const pending=spaceActivity([],[first,second],fixtureSource),[clicked,other]=pending
  assert.deepEqual(pending.map(r=>r.message.text),['B','A'])
  assert.notEqual(clicked.key,other.key)
  const view={section:'activity',anchor:clicked.key}
  for(const action of ['once','permanent']) assert.deepEqual(approve(clicked.mention,action),{...target,messageId:'om_b',action})
  assert.equal(route([],view,true,pending).entry.message.text,'B')
  const msg={kind:'feishu',requestId:'om_b',text:'B',at:90,status:'working'}
  const origin={...target,...fixtureSource.settings,kind:'feishu'}
  const cases=[{id:'actual',source:origin,messages:[msg]},{id:'unrelated',source:origin,messages:[msg]}]
  const after=spaceActivity(cases,[{...first,canApprove:false},{...second,caseId:'actual',canApprove:false}],fixtureSource)
  assert.equal(after.length,3)
  const merged=route(cases,view,false,after).entry
  assert.equal(merged.key,clicked.key);assert.equal(merged.item.id,'actual')
  assert.equal(merged.message.at,30);assert.equal(merged.message.status,'working');assert.equal(merged.name,'协作群')
  assert.equal(merged.mention,undefined)
  assert.equal(after.find(r=>r.key===other.key).message.status,'not-handled')
  assert.equal(route(cases,{section:'activity',backId:clicked.key},true,after).page,'activity')
})
test('activity only exposes current tenant, recipient and consent scope; the cases tab retains old records',()=>{
  const msg={kind:'feishu',requestId:'om_old',text:'已办',at:1,status:'received'}
  const item={id:'before',hasWork:true,messages:[msg],source:{kind:'feishu',chatId:'oc_old',tenantId:'tenant',recipientId:'me'}}
  const current={...fixtureSource,groups:[{chatId:'oc_old',name:'协作群'}]}
  const oldScope={...item,id:'old-epoch',feedScopeId:'previous'},items=[item,oldScope]
  assert.deepEqual(spaceActivity(items,[],current).map(row=>[row.item.id,row.name]),[['before','协作群']])
  assert.equal(spaceActivity([{...item,feedScopeId:current.scopeId}],[],current).length,1)
  for(const settings of [{...current.settings,recipientId:'other'},{...current.settings,tenantId:'other'},{}]) {
    assert.deepEqual(spaceActivity(items,[],{...current,settings}),[])
  }
  assert.deepEqual(spaceActivity(items,[],{...current,scopeId:null}),[])
  assert.deepEqual(spaceActivity(items,[{scopeId:'previous'}],undefined),[])
  assert.deepEqual(spaceActivity([],[{scopeId:'previous'}],current),[])
  const route=new Function(source+';return spaceWorkspaceView')()
  assert.deepEqual(route(items,{section:'cases'},false).records,items)
})
test('only an existing model cache of a checked release is observed; no session, getter or provider discovery',()=>{
  const calls=[],store={getSnapshot(){},subscribe(){}}
  function context(service,version='0.2.2-rc.3') {return {get(k){calls.push(k)
    if(k==='modules')return {manifest:{release:{version}}}
    if(k==='modelDirectories')return service
    assert.fail('unexpected service '+k)}}}
  assert.equal(spaceCatalogStore(context({catalog:{store}})),store)
  assert.equal(spaceCatalogStore(context({catalog:{store}},'0.2.2-rc.5')),store)
  assert.equal(spaceCatalogStore(context({catalog:{store}},'0.2.2-rc.4')),null)
  assert.equal(spaceCatalogStore(context({get catalog(){assert.fail('must not discover')}})),null)
  assert.equal(spaceCatalogStore(context({get catalog(){assert.fail()}},'next')),null)
  assert.deepEqual(new Set(calls),new Set(['modules','modelDirectories']))
  const data={status:'ready',value:{default:{provider:'a',model:'x',reasoningEffort:'high'},groups:[
    {id:'a',name:'Local A',models:[{id:'x',name:'Model X',reasoning:{defaultEffort:'low',efforts:[{id:'high',name:'High'},{id:'low',name:'Low'}]}}]},
    {id:'b',name:'Local B',models:[{id:'x',name:'Another X'}]}]}}
  const rows=spaceCatalogRows(data)
  assert.deepEqual(spaceCatalogRows(null),[])
  assert.deepEqual(spaceCatalogRows({...data,status:'idle'}),[])
  assert.equal(rows.length,2)
  assert.deepEqual(spaceRoleChoice(rows,null,'model','["b","x"]'),{provider:'b',model:'x',name:'Another X',effort:''})
  assert.deepEqual(spaceRoleChoice(rows,null,'effort','high'),{inherit:true,effort:'high'})
  assert.equal(spaceRoleChoice(rows,null,'effort','other'),undefined)
})

test('all roles allow the session default; a saved missing preset is not silently replaced',()=>{
  const roster=[{id:'dev',name:'Local Dev',builtin:false}],p={roster,rosterStatus:'ready',tr}
  const groups=spacePresetGroups(roster,tr),empty={value:'',label:'默认'}
  assert.deepEqual(groups[0].options,[{value:'dev',label:'Local Dev'}])
  assert.deepEqual(spacePresetOptions({...p,roster:[]},'',[]),{value:'',groups:[{options:[empty]}]})
  assert.deepEqual(spacePresetOptions(p,'dev',groups).groups[0].options,[empty])
  const missing=spacePresetOptions(p,'missing',groups)
  assert.equal(missing.value,'missing')
  assert.deepEqual(missing.groups[0].options,[empty,{value:'missing',disabled:true,label:'原绑定预设不可用'}])
  for(const role of ['lead','develop','answer']) {
    assert.equal(spacePresetLabel({...p,team:{lead:'dev',[role]:''}},role),empty.label)
  }
})
