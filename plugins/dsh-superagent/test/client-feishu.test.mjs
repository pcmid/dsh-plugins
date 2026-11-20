import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const src=await readFile(new URL('../src/edition.js',import.meta.url),'utf8')
const {connect,flow,ended,panels,minutes,interval}=new Function(src+`;return {connect:spaceConnectFeishu,flow:spaceFeishuFlow,ended:spaceFeishuEnded,
  panels:[SpaceSource,SpaceGroup,SpaceSourceGroups],minutes:spaceCommitPollInterval,interval:SpacePollInterval}`)()
const runtime=await readFile(new URL('../src/runtime.js',import.meta.url),'utf8')
const empty={version:'r1',enabled:false,managed:true,profile:'',tenantId:'',recipientId:''}
const saved={...empty,enabled:true,profile:'superagent',version:'r2'}
const alive=()=>true
test('secondary Feishu actions leave the host settings surface visible',async()=>{
  const css=await readFile(new URL('../src/base.css',import.meta.url),'utf8')
  assert.match(css,/\.sx\s+\.sx-quiet\s*\{[^}]*\bbackground\s*:\s*transparent\s*[;}]/)
  assert.match(css,/\.sx\s+\.sx-solid\s*\{[^}]*var\(--dsw-alias-button-primary-fill\)/)
})
test('a fresh connection prepares only the private app; no profile field, message sync or group approval',async()=>{
  const calls=[]
  const answer=await connect(empty,async(op,input)=>{
    calls.push([op,input]);return op==='saveFeishu'?saved:{flowId:'choice'}
  },alive)
  assert.deepEqual(answer,{kind:'setup',version:'r2',flowId:'choice'})
  assert.deepEqual(calls,[['saveFeishu',{version:'r1',enabled:true,managed:true,profile:'superagent'}],['startFeishuAuth',{kind:'setup',version:'r2'}]])
  for(const panel of panels)assert.doesNotMatch(String(panel),/h\(['"](?:input|select|textarea|form)['"]/)
})

test('source settings manage grants only; a legacy pending group never becomes a made-up message',()=>{
  const [,row,groups]=panels.map(String)
  assert.doesNotMatch(src+runtime,/listFeishuGroups|proposeFeishuGroup|syncFeishu/)
  assert.doesNotMatch(groups,/'pending'/)
  assert.doesNotMatch(row,/action:'(?:once|permanent)'|点击查看|在飞书查看此群/)
})
test('list and detail use independent group links and submit the same exact mention',()=>{
  const {row,detail,group,link,actions}=new Function(src+';return {row:SpaceActivityRow,detail:SpaceActivityDetail,group:SpaceGroup,link:SpaceGroupLink,actions:SpaceApproval}')()
  for(const c of [row,detail]) assert.match(String(c),/h\(SpaceApproval,\{p,mention,returnFocus:/)
  for(const c of [row,detail,group]) assert.match(String(c),/h\(SpaceGroupLink,/)
  assert.match(String(link),/tr\('飞书会话','Feishu conversation'\)/)
  assert.match(String(link),/encodeURIComponent\(chatId\)/)
  assert.match(String(actions),/if\(!mention\?\.canApprove\)return null/)
  assert.match(String(actions),/dropdown\('allow','授权','Allow'\),dropdown\('ignore','忽略','Ignore'\)/)
  const input=new Function(src+';return spaceApprovalInput')(),ref={scopeId:'s',chatId:'oc_x',threadId:'om_t',messageId:'om_m'}
  assert.deepEqual(input(ref,'ignore'),{scopeId:'s',chatId:'oc_x',action:'ignore'})
  // The member is never named by the browser; the Host takes it from the recorded message.
  for(const action of ['once','permanent','sender','dismiss'])
    assert.deepEqual(input({...ref,senderId:'ou_member',text:'body'},action),{...ref,action})
})

const fake=(type,props,...children)=>({type,props:props ?? {},children:children.flat()})
const view=new Function('h','React',src+`;return {approval:SpaceApproval,actions:spaceApprovalActions,key:spaceMentionKey,
  group:SpaceGroup,groups:SpaceSourceGroups,label:spaceGrantLabel,workspace:EditionWorkspace}`)(fake,{Fragment:'fragment'})
const find=(node,match)=>!node || typeof node!=='object' ? [] : [...(match(node) ? [node] : []),...node.children.flatMap(c=>find(c,match))]
const text=node=>typeof node==='string' ? node : node && typeof node==='object' ? node.children.map(text).join('') : ''

test('a pending message offers Allow and Ignore dropdowns; Allow this user only appears with a recorded sender',()=>{
  const tr=zh=>zh, mention={scopeId:'s',chatId:'oc_x',threadId:'om_t',messageId:'om_m',canApprove:true,senderId:'ou_member'}
  assert.deepEqual(view.actions(mention,'allow',tr),[{id:'once',label:'授权一次'},{id:'permanent',label:'永久授权'},{id:'sender',label:'仅授权此用户'}])
  const {senderId:_,...unknown}=mention
  assert.deepEqual(view.actions(unknown,'allow',tr).map(a=>a.id),['once','permanent'])
  assert.deepEqual(view.actions(mention,'ignore',tr),[{id:'dismiss',label:'忽略一次'},{id:'ignore',label:'永久忽略'}])
  assert.deepEqual(view.actions(unknown,'ignore',tr).map(a=>a.id),['dismiss','ignore'])
  const sent=[],opened=[],returnFocus={current:{focus:()=>sent.push('focus')}}
  const p={tr,busy:false,groupAccess:x=>sent.push(x),openMenu:(target,point)=>opened.push([target,point])}
  // Each dropdown opens the shared DSH menu below itself; opening one decides nothing.
  const menus=find(view.approval({p,mention,returnFocus}),n=>n.type==='button')
  assert.deepEqual(menus.map(b=>[b.children[0],b.props['aria-haspopup']]),[['授权','menu'],['忽略','menu']])
  menus.forEach((b,i)=>b.props.onClick({currentTarget:{getBoundingClientRect:()=>({left:10+i,bottom:40})}}))
  assert.deepEqual(opened,['allow','ignore'].map((menu,i)=>[{kind:'superagent-approval',value:{key:view.key(mention),menu}},{x:10+i,y:40}]))
  assert.deepEqual(sent,[])
  assert.ok(find(view.approval({p:{...p,busy:true},mention,returnFocus}),n=>n.type==='button').every(b=>b.props.disabled))
  // Without the shared menu the same choices are plain buttons; ignoring permanently names the conversation only.
  const plain=find(view.approval({p:{...p,openMenu:undefined},mention,returnFocus}),n=>n.type==='button')
  assert.deepEqual(plain.map(text),['授权一次','永久授权','仅授权此用户','忽略一次','永久忽略'])
  plain.forEach(b=>b.props.onClick())
  const ref={scopeId:'s',chatId:'oc_x',threadId:'om_t',messageId:'om_m'}
  assert.deepEqual(sent.filter(x=>x!=='focus'),[...['once','permanent','sender','dismiss'].map(action=>({...ref,action})),{scopeId:'s',chatId:'oc_x',action:'ignore'}])
  assert.deepEqual(find(view.approval({p:{...p,openMenu:undefined},mention:unknown,returnFocus}),n=>n.type==='button').map(text),
    ['授权一次','永久授权','忽略一次','永久忽略'])
  assert.equal(view.approval({p,mention:{...mention,canApprove:false},returnFocus}),null)
  // The workspace registers the menu once; it resolves only a still-approvable mention and submits the same input.
  const ui=String(view.workspace)
  assert.match(ui,/p\.registerMenu\?\.\('pcmid-superagent\.approval','superagent-approval',\(\{key,menu\}\)=>\{/)
  assert.match(ui,/mentions\.find\(m=>m\.canApprove && spaceMentionKey\(m\)===key\)/)
  assert.match(ui,/spaceApprovalActions\(mention,menu,tr\)\.map\(a=>\(\{\.\.\.a,run:\(\)=>groupAccess\(spaceApprovalInput\(mention,a\.id\)\)\}\)\) : \[\]/)
})

test('settings show each allowed member apart from always-allowed and ignored conversations; revoking a member names that member',()=>{
  const tr=zh=>zh, calls=[], at=Date.UTC(2026,0,1)
  const rows=[{chatId:'oc_a',mode:'permanent',approvedAt:at,grantId:'g1'},{chatId:'oc_b',mode:'sender',senderId:'ou_y',note:'帮我看下报表',approvedAt:at,grantId:'g2'},
    {chatId:'oc_b',mode:'sender',senderId:'ou_z',approvedAt:at,grantId:'g3'},{chatId:'oc_c',mode:'once',threadId:'om_t',approvedAt:at,grantId:'g4'},
    {chatId:'oc_d',mode:'pending',threadId:'om_p'},{chatId:'oc_e',mode:'ignored',ignoredAt:at}]
  const p={tr,busy:false,source:{scopeId:'scope',groups:rows},groupAccess:x=>calls.push(x)}
  const sections=find(view.groups({p}),n=>n.type==='section')
  const listed=sections.map(s=>find(s,n=>n.type===view.group).map(n=>[n.props.key,n.props.group.mode,n.props.label]))
  const time=new Date(at).toLocaleString('zh-CN',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
  assert.deepEqual(listed,[[['oc_a','permanent',time+' 起永久允许'],['oc_bou_y','sender','仅允许一位成员（发送「帮我看下报表」的人） · '+time+' 起'],
    ['oc_bou_z','sender','仅允许一位成员 · '+time+' 起']],[['oc_e','ignored',time+' 起忽略']]])
  assert.equal(view.label({mode:'sender',note:'帮我看下报表'},tr),'仅允许一位成员（发送「帮我看下报表」的人）')
  assert.equal(view.label({mode:'sender'},tr),'仅允许一位成员')
  for(const g of rows.filter(g=>['permanent','sender','ignored'].includes(g.mode))) {
    const [button]=find(view.group({p,group:g,label:''}),n=>n.type==='button')
    assert.equal(text(button),g.mode==='ignored' ? '取消忽略' : '撤销授权')
    button.props.onClick()
  }
  assert.deepEqual(calls,[{scopeId:'scope',chatId:'oc_a',action:'revoke'},{scopeId:'scope',chatId:'oc_b',action:'revoke',senderId:'ou_y'},
    {scopeId:'scope',chatId:'oc_b',action:'revoke',senderId:'ou_z'},{scopeId:'scope',chatId:'oc_e',action:'revoke'}])
})

test('settings list each always-allowed conversation once, never per-topic approvals, and revoke the whole conversation',()=>{
  const label=new Function(src+';return spaceGrantLabel')(),tr=zh=>zh
  assert.match(label({mode:'permanent',approvedAt:Date.UTC(2026,0,1)},tr),/起永久允许$/)
  assert.equal(label({mode:'permanent'},tr),'已永久允许此会话')
  const [,group,groups]=panels.map(String)
  assert.match(groups,/source\.groups\.filter\(group=>\['permanent','sender'\]\.includes\(group\.mode\)\)/)
  assert.match(groups,/key:group\.chatId/);assert.doesNotMatch(groups,/'once'|threadId/)
  assert.match(group,/action:'revoke',\.\.\.\(mode==='sender' \? \{senderId\} : \{\}\)\}\)/);assert.doesNotMatch(group,/threadId/)
  // Ignored conversations are listed apart and can be undone.
  assert.match(label({mode:'ignored',ignoredAt:Date.UTC(2026,0,1)},tr),/起忽略$/)
  assert.equal(label({mode:'ignored'},tr),'已忽略此会话')
  assert.match(groups,/source\.groups\.filter\(group=>group\.mode==='ignored'\)/);assert.match(groups,/tr\('已忽略的会话'/)
  assert.match(group,/mode==='ignored' \? tr\('取消忽略'/)
})
test('the poll log localizes the stored timestamp, step, cause and optional numeric Feishu error code only',()=>{
  const {rows,stages,reasons}=new Function(src+';return {rows:spacePollLogRows,stages:spacePollStages,reasons:spacePollReasons}')()
  const zh=cn=>cn,en=(_,english)=>english,at=Date.UTC(2026,10,20,5,6,7)
  const data=[{at,stage:'search',reason:'rate-limited',larkCode:99991400,stderr:'private-stderr',chatId:'oc_secret',token:'secret'},
    {at:at-1000,stage:'identity',reason:'login-required',args:['--secret'],text:'private-message'}]
  const localized=(at,locale)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'medium'}).format(at)
  assert.deepEqual(rows(data,zh),[
    {iso:new Date(at).toISOString(),time:localized(at,'zh-CN'),stage:'搜索新消息',reason:'请求过于频繁',code:'飞书错误码：99991400'},
    {iso:new Date(at-1000).toISOString(),time:localized(at-1000,'zh-CN'),stage:'核对登录账号',reason:'需要登录飞书'}])
  assert.deepEqual(rows(data,en).map(({time,stage,reason,code})=>[time,stage,reason,code]),[
    [localized(at,'en-US'),'Search messages','Rate limit exceeded','Feishu error code: 99991400'],
    [localized(at-1000,'en-US'),'Check account','Feishu login required',undefined]])
  assert.deepEqual(Object.keys(stages).sort(),'identity search metadata group message history admission storage receive poll'.split(' ').sort())
  assert.deepEqual(Object.keys(reasons).sort(),'context-too-large cli-not-found cli-not-executable timeout login-required permission-denied invalid-parameters rate-limited network api-error identity-mismatch invalid-response storage-unavailable admission-denied cli-failed unknown'.split(' ').sort())
  for(const invalid of [undefined,null,{},[],[null],...['oc_raw','toString','__proto__'].map(stage=>[{...data[0],stage}]),
    [{...data[0],reason:'private-stderr'}],[{...data[0],at:'yesterday'}],[{...data[0],at:9e15}]])assert.deepEqual(rows(invalid,zh),[])
  for(const larkCode of [null,0,-1,'99991400',1.5,2147483648])assert.equal('code' in rows([{...data[0],larkCode}],zh)[0],false)
  for(const larkCode of [1,2147483647])assert.equal(rows([{...data[0],larkCode}],en)[0].code,'Feishu error code: '+larkCode)
})
test('an actual historical log remains expandable independently of current connection or recovery; no fake empty errors',()=>{
  const [source,,groups]=panels.map(String),view=new Function(src+';return SpacePollLog')()
  for(const records of [undefined,[],[{at:1,stage:'not-a-stage',reason:'unknown'}]])assert.equal(view({records,tr:z=>z}),null)
  assert.match(String(view),/h\('details'/);assert.match(String(view),/h\('summary',null,tr\('错误日志','Error log'\)\)/)
  assert.doesNotMatch(String(view),/role:'(?:alert|status)'|source\.state|source\.detail/)
  const status=new Function(src+';return spaceSourceStatus')(),en=(_,english)=>english
  const log=[{at:1,stage:'group',reason:'unknown'}],describe=(state,detail)=>status({state,detail,pollErrors:log},en)
  assert.equal(describe('unverified'),'The Feishu account has not yet been verified.')
  assert.equal(describe('error','未能完成本次飞书轮询，将自动重试。'),'The Feishu check failed and will retry automatically.')
  assert.equal(describe('ready','private-detail'),'The last Feishu check completed.')
  assert.equal(describe('disabled'),null)
  assert.doesNotMatch(describe('error','private-detail'),/private-detail/)
  assert.match(source,/connected && spaceSourceStatus\(source,tr\)/)
  assert.match(source,/^\s*h\(SpacePollLog,\{records:source\.pollErrors,tr\}\),/m)
  assert.doesNotMatch(groups,/SpacePollLog|pollErrors|source\.detail/)
  assert.match(source,/内部群.*与自己的聊天.*私聊中明确 @自己.*授权一次/);assert.match(source,/internal group.*self-chat.*Allow once/)
})
test('self-chat and group records use their verified names or neutral conversation labels; the grant target does not depend on the name',()=>{
  const {origin,grant,detail,input}=new Function(src+';return {origin:spaceOrigin,grant:spaceGrantLabel,detail:SpaceActivityDetail,input:spaceApprovalInput}')()
  for(const name of ['与自己的聊天','内部项目群',undefined]){
    const ref={scopeId:'scope',chatId:'oc_any',threadId:'om_topic',messageId:'om_m',name}
    assert.equal(origin({source:{kind:'feishu',name}},z=>z),'飞书消息')
    assert.equal(grant({mode:'permanent',name},z=>z),'已永久允许此会话')
    assert.deepEqual(input(ref,'permanent'),{scopeId:ref.scopeId,chatId:ref.chatId,threadId:ref.threadId,messageId:ref.messageId,action:'permanent'})
  }
  assert.match(String(detail),/tr\('飞书消息','Feishu message'\)/)
  assert.doesNotMatch(src+runtime,/飞书群消息|永久批准此群|此群或话题未经授权|this group/i)
})
test('private intake is an explicit versioned switch; even self-chat still needs a direct mention',()=>{
  const c=String(new Function(src+';return SpacePrivateChats')())
  const control=String(new Function(src+';return SpaceSettingSwitch')())
  assert.match(c,/settings\.allowPrivateChats===true/);assert.match(c,/h\(SpaceSettingSwitch,/)
  assert.match(control,/type:'button',role:'switch','aria-checked':checked/);assert.match(control,/'aria-describedby':id\+'-description'/)
  assert.match(control,/className:'x2-switch',disabled,onClick:\(\)=>onChange\(!checked\)/)
  assert.match(c,/disabled \|\| \(!checked && !canEnable\)/)
  assert.match(c,/save\(\{version:settings\.version,allowPrivateChats:next\}\)/)
  assert.match(c,/对方私聊你无需 @/);assert.match(c,/群里别人 @你.*在「动态」中待批.*不会补收/)
  assert.match(String(panels[0]),/canEnable:connected && source\.automationEnabled/)
  assert.match(String(panels[0]),/授权一次.*对外发送仍遵守你的确认设置/)
  assert.match(runtime,/setPrivateChats:input=>change\('setPrivateChats',input\)/)
  const rows=new Function(src+';return spacePollLogRows')()([{at:1,stage:'history',reason:'context-too-large'}],cn=>cn)
  assert.equal(rows[0].reason,'线程内容过长，未交给助手')
})

test('both settings tabs observe lightweight revisions without asking the host to scan',()=>{
  assert.doesNotMatch(runtime,/settingsOnly && tab!=='source'/)
  assert.match(runtime,/if\(!Number\.isSafeInteger\(snapshot\?\.revision\)\)return/)
  assert.match(runtime,/!document\.hidden && !lock\.current && await ops\.ask\('viewRevision',\{\}\)!==snapshot\.revision/)
  assert.match(runtime,/ops\.ask\(settingsOnly\?'settingsSnapshot':'snapshot',\{\}\)/)
  assert.match(runtime,/!stopped && !lock\.current\)await reload\(settingsOnly\)/)
  assert.match(runtime,/if\(!keepSource \|\| e\.code==='scope-changed'\) setSnapshot\(null\)/)
})

test('interval edits save only on submit, survive settings refreshes, and retry a rejected version',async()=>{
  const field=String(interval)
  assert.match(field,/onSubmit:commit/);assert.doesNotMatch(field,/onBlur:|\.blur\(/)
  assert.match(field,/min:1,max:1440,step:1,required:true/);assert.match(field,/e\.key==='Escape'/)
  assert.match(String(panels[0]),/SpacePollInterval,\{key:source\.scopeId,/)
  assert.match(runtime,/sourceEdit=\[[^\]]*'setPollInterval'/)
  const s={...empty,version:'new',pollIntervalMinutes:60}
  for(const value of ['', '0','1441','1.5','not a number']){
    const draft={value};assert.equal(await minutes(draft,s,assert.fail),draft)
  }
  assert.equal(await minutes(null,s,assert.fail),null);assert.equal(await minutes({value:'60'},s,assert.fail),null)
  for(const value of ['1','1440']){
    const calls=[],draft={value,version:'at-edit'}
    const rejected=await minutes(draft,s,async patch=>{calls.push(patch)})
    assert.deepEqual(rejected,{value})
    assert.equal(await minutes(rejected,s,async patch=>{calls.push(patch);return {...s,...patch}}),null)
    assert.deepEqual(calls,[{version:'at-edit',pollIntervalMinutes:Number(value)},{version:'new',pollIntervalMinutes:Number(value)}])
  }
})
test('history limits are saved as a pair, with zero distinct from empty or a fallback',()=>{
  const {patch,form}=new Function(src+';return {patch:spaceHistoryPatch,form:SpaceHistoryLimits}')()
  for(const [count,minutes] of [[0,5],[10,0],[0,0],[100,1440],[11,1]]) {
    const draft={version:'r1',historyCount:String(count),historyMinutes:String(minutes)}
    assert.deepEqual(patch(draft,{version:'r2'}),{version:'r1',historyCount:count,historyMinutes:minutes})
    assert.equal(patch({...draft,version:undefined},{version:'refreshed'}).version,'refreshed')
  }
  for(const [historyCount,historyMinutes] of [['','5'],['10',''],['-1','1'],['101','1'],['1','1441'],['2','1.5'],['oops','0']]) {
    assert.equal(patch({historyCount,historyMinutes},{version:'r1'}),null)
  }
  // A second window disabled lookback while only the count was being edited.
  // The old version must first be refused; retry never restores the untouched time window.
  const concurrent={version:'new',historyCount:10,historyMinutes:0}
  assert.deepEqual(patch({version:'old',historyCount:'8'},concurrent),{version:'old',historyCount:8,historyMinutes:0})
  assert.deepEqual(patch({version:undefined,historyCount:'8'},concurrent),{version:'new',historyCount:8,historyMinutes:0})
  assert.deepEqual(patch({historyMinutes:'1'},{version:'new',historyCount:0,historyMinutes:5}),{version:'new',historyCount:0,historyMinutes:1})
  assert.match(String(form),/有飞书话题时读取完整话题。仅无话题时.*默认最多 10 条、向前 5 分钟；任一项为 0 即不补读/)
  assert.match(String(form),/min:0,max,step:1,required:true/)
  assert.match(String(form),/onSubmit:commit/)
  assert.doesNotMatch(String(form),/onBlur:|Number\([^)]*\) \|\|/)
  assert.match(runtime,/setHistoryLimits:input=>change\('setHistoryLimits',input\)/)
})

test('the CLI path field preserves pending edits across refreshes and submits a single exact executable or empty PATH override',async()=>{
  const {commit,field}=new Function(src+';return {commit:spaceCommitCliPath,field:SpaceCliPath}')()
  const absolute='/Applications/Local Tools/bin/lark-cli',fresh={...empty,version:'r2',cliPath:'/old/bin/lark-cli'}
  assert.equal(await commit(null,empty,assert.fail),null)
  assert.equal(await commit({value:''},empty,assert.fail),null)
  assert.equal(await commit({value:fresh.cliPath},fresh,assert.fail),null)
  const calls=[],failSave=async input=>{calls.push(input);return undefined}
  const rejected=await commit({value:absolute,version:'r1'},fresh,failSave)
  assert.deepEqual(calls,[{version:'r1',cliPath:absolute}]) // concurrent refresh must not upgrade the in-flight edit's version
  assert.deepEqual(rejected,{value:absolute,unsaved:true})
  const accept=async input=>{calls.push(input);return {...fresh,cliPath:input.cliPath,version:'r3'}}
  assert.equal(await commit(rejected,fresh,accept),null)
  assert.equal(await commit({value:'',version:'r2'},fresh,accept),null)
  assert.deepEqual(calls.slice(1),[{version:'r2',cliPath:absolute},{version:'r2',cliPath:''}])
  assert.match(String(field),/value:draft\?\.value \?\? currentPath/)
  assert.match(String(field),/setDraft\(current=>current===draft \? next : current\)/)
  assert.match(String(field),/h\('form',\{[^}]*onSubmit:e=>\{e\.preventDefault\(\);void commit\(\)/)
  assert.doesNotMatch(String(field),/onBlur:/)
  assert.match(String(field),/type:'submit'/)
  assert.match(String(field),/e\.key==='Escape' && !e\.nativeEvent\.isComposing\)setDraft\(null\)/)
  assert.match(String(panels[0]),/^\s*h\(SpaceCliPath,\{settings:s,tr,save:p\.setCliPath,draft:cliDraft,setDraft:setCliDraft,disabled:busy \|\| !!flow\}\)/m)
  assert.match(String(panels[0]),/pathDirty && \['connect','separate'\]\.includes\(action\)/)
  assert.match(runtime,/setCliPath:input=>change\('setCliPath',input\)/)
  const localError=new Function(runtime+';return spaceErrorText')(),zh=v=>v
  assert.match(localError('invalid-cli-path',zh),/未保存.*绝对路径.*不要附加参数.*留空/)
  assert.match(localError('source-settings-changed',zh),/设置已变更.*重新保存/)
  assert.match(runtime,/sourceEdit && e\.code==='scope-changed' \? 'source-settings-changed'/)
})

test('existing shared profiles and bound accounts are kept; a known dedicated app goes to consent without overwriting',async()=>{
  for(const s of [{...saved,profile:'old',managed:false},{...saved,tenantId:'t',recipientId:'ou_me'},saved]){
    const calls=[]
    const result=await connect(s,async(op,args)=>{
      assert.equal(op,'startFeishuAuth');calls.push(args.kind)
      assert.equal(args.automation,args.kind==='login'?true:undefined)
      if(args.kind==='setup')throw Object.assign(new Error(),{code:'auth-profile-exists'})
      return {flowId:'consent'}
    },alive)
    assert.equal(result.kind,'login')
    assert.deepEqual(calls,s===saved?['setup','login']:['login'])
  }
})
test('a paused bound account requests login without re-enabling before consent, even when login fails',async()=>{
  for(const managed of [true,false]){
    const s={...saved,enabled:false,managed,tenantId:'t',recipientId:'ou_me'}
    const expected=['startFeishuAuth',{version:s.version,kind:'login',automation:true}]
    const start=async(...args)=>{assert.deepEqual(args,expected);return {flowId:'pending'}}
    assert.deepEqual(await connect(s,start,alive),{kind:'login',version:s.version,flowId:'pending'})
    await assert.rejects(connect(s,async(...args)=>{assert.deepEqual(args,expected);throw Error('declined')},alive),/declined/)
  }
})
test('abandonment and ambiguous setup errors never start another authorization',async()=>{
  const calls=[]
  assert.equal(await connect(empty,async(op)=>{calls.push(op);return saved},()=>false),null)
  assert.deepEqual(calls,['saveFeishu'])
  await assert.rejects(connect(saved,async(op,cmd)=>{
    assert.equal(cmd.kind,'setup');throw Object.assign(Error(),{code:'auth-setup-locked'})
  },alive),{code:'auth-setup-locked'})
})
test('only the exact official page and a local PNG reach display state; expiry and refusals do not expose diagnostics',()=>{
  // The PNG is a 1x1 fixture, not a sign-in code.
  const value={flowId:'fixture',expiresAt:10,url:'https://open.feishu.cn/page/cli?fixture=1',
    qrDataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8919sAAAAASUVORK5CYII='}
  const login='https://accounts.feishu.cn/oauth/v1/device/verify?fixture=2'
  assert.deepEqual(flow('setup',{...value,privateExtra:'fixture-only'},0),{kind:'setup',...value})
  assert.deepEqual(flow('login',{...value,url:login},0),{kind:'login',...value,url:login})
  assert.throws(()=>flow('login',value,0),{code:'auth-unavailable'})
  for(const url of ['http://open.feishu.cn/page/cli','https://open.feishu.cn.example.invalid/page/cli',
    'https://open.feishu.cn:8443/page/cli','https://fixture@open.feishu.cn/page/cli','https://open.feishu.cn/other']) {
    assert.throws(()=>flow('setup',{...value,url},0),{code:'auth-unavailable'})
  }
  for(const qrDataUrl of ['https://example.invalid/qr.png','data:image/svg+xml;base64,fixture','data:image/png;base64,notPng'])
    assert.throws(()=>flow('setup',{...value,qrDataUrl},0),{code:'auth-unavailable'})
  assert.throws(()=>flow('setup',value,10),{code:'auth-expired'})
})
test('pending approval or an uncertain reply retains the page-local flow for another explicit check or cancel',()=>{
  for(const code of [undefined,'unavailable','auth-pending','auth-busy','auth-unavailable']) assert.equal(ended(code),false)
  for(const code of ['auth-expired','auth-denied','scope-changed']) assert.equal(ended(code),true)
})
