const spaceMarkPaths={
  lead:'M5 15a7 7 0 0 1-2-5c0-4 4-7 9-7s9 3 9 7-4 7-9 7H9l-5 3z M8 10h8',
  check:'M4 12l5 5L20 6',
  history:'M3 10a9 9 0 1 1 2 8 M3 4v6h6 M12 7v6l4 2',
  chevron:'M9 5l7 7-7 7',back:'M21 12H4 M10 6l-6 6 6 6',
  link:'M10 7l2-2a5 5 0 1 1 7 7l-2 2 M14 17l-2 2a5 5 0 1 1-7-7l2-2 M8 16l8-8'
};
function Mark({name,size=16}) {
  return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.65,
    strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false},h('path',{d:spaceMarkPaths[name]}));
}
// Built-in roles use their localized names; a custom helper uses the name recorded with the run.
function spaceRoleLabel(role,tr,name) {
  const row=spaceRoles.find(([id])=>id===role);
  return row ? tr(row[1],row[2]) : name || role;
}
function spaceStatus(status,tr) {
  const labels={'awaiting-access':['待批准','Awaiting approval'],'not-handled':['已收到 · 未办理','Received · not handled'],received:['已收到','Received'],dispatching:['正在提交至 DSH','Submitting to DSH'],
    submitted:['已交给 DSH','Submitted to DSH'],failed:['提交失败','Submission failed'],
    'intake-failed':['收件失败，将自动重试','Intake failed; will retry automatically'],
    queued:['待判断','Queued'],deciding:['Router 分流中','Router is routing'],assigned:['待承办','Assigned'],working:['助手办理中','In progress'],
    approved:['已完成 · 尚未发送','Done · not yet sent'],
    'awaiting-release':['待你确认发送最终答复','Final reply awaiting your confirmation'],'question-release':['待你确认发送追问','Question awaiting your confirmation'],
    'question-ready':['追问待发送','Question ready to send'],'waiting-requester':['等待原提需人回复','Waiting for the original requester'],declined:['已选择不发送','Not sent by choice'],
    'taken-over':['已由你接手','Taken over by you'],merged:['已并入其他事项','Merged into another request'],
    delivering:['正在回复原消息','Delivering'],delivered:['已回复原消息','Delivered'],ignored:['无需处理','No action needed'],
    stopped:['已停止，未交付','Stopped without delivery'],uncertain:['结果待核实','Outcome unconfirmed']};
  return labels[status] ? tr(...labels[status]) : tr('状态未知','Status unknown');
}
function spaceStatusDot(status) {
  return h('i',{className:'x2-dot','data-status':status,'aria-hidden':true});
}
function spaceWithRuns(cases,runs=[]) {
  const index=new Map();
  for(const r of runs) {
    if(!index.has(r.caseId)) index.set(r.caseId,new Map());
    index.get(r.caseId).set(r.messageId,r);
  }
  const titles=new Map(cases.map(c=>[c.id,c.title]));
  return cases.map(item=>{
    const jobs=index.get(item.id);
    if(!jobs) return item;
    const messages=item.messages.map(m=>{
      const found=m.kind==='feishu' && jobs.get(m.requestId);
      if (!found) return m;
      // A merged message names the request it joined.
      const run=found.mergedInto && titles.has(found.mergedInto.caseId) ? {...found,mergedTitle:titles.get(found.mergedInto.caseId)} : found;
      const status=['delivered','waiting-requester'].includes(run.status) && !run.receipt?.messageId ? 'uncertain' :
        run.outputKind==='question' && run.status==='awaiting-release' ? 'question-release' :
        run.outputKind==='question' && run.status==='approved' ? 'question-ready' : run.status;
      return {...m,status,run};
    });
    const latest=messages.at(-1);
    return {...item,messages,status:latest?.status || item.status,hasWork:messages.some(m=>m.run && !['ignored','merged'].includes(m.status)),
      workerRole:latest?.run?.role || item.workerRole,workerRoleName:latest?.run?.roleName};
  });
}
function spaceCaseStatus(item) {
  return item.messages.find(m=>m.status==='uncertain')?.status || item.messages.find(m=>['awaiting-release','question-release'].includes(m.status))?.status || item.messages.find(m=>m.status==='dispatching')?.status || item.status;
}
function spaceOrigin(item,tr) {
  return item.source.kind==='feishu' ? tr('飞书消息','Feishu message') : tr('本机委托','Local request');
}
function spaceCurrentCase(item,source) {
  const s=source?.settings,c=item.source;
  return !!(source?.scopeId && s?.tenantId && s.recipientId && c.kind==='feishu' &&
    c.tenantId===s.tenantId && c.recipientId===s.recipientId && (!item.feedScopeId || item.feedScopeId===source.scopeId));
}
function spaceActivity(cases,mentions=[],source) {
  if(!source?.scopeId || !source.settings?.tenantId || !source.settings.recipientId)return [];
  const rows=[], index=new Map(), names=new Map(), groupNames=new Map(source?.groups?.map(g=>[g.chatId,g.name]));
  for(const item of cases) {
    if(!spaceCurrentCase(item,source))continue;
    const {chatId}=item.source;
    for(const message of item.messages) {
      if(message.kind!=='feishu')continue;
      const key=JSON.stringify([item.id,message.requestId]),row={key,item,message,chatId,name:item.source.name || groupNames.get(chatId)};
      index.set(key,row);rows.push(row);
    }
  }
  for(const mention of mentions) {
    if(mention.scopeId!==source.scopeId)continue;
    const {scopeId,chatId,threadId,messageId,text,at,name,canApprove,caseId,intakeFailure}=mention;
    const key=JSON.stringify([scopeId,chatId,threadId,messageId]);
    let row=caseId && index.get(JSON.stringify([caseId,messageId]));
    if(row) {
      row.key=key;row.message={...row.message,at};
      if(name) names.set(caseId,name);
    } else {
      row={key,mention,chatId,name,message:{kind:'feishu',requestId:messageId,text,at,status:canApprove?'awaiting-access':'not-handled'}};
      rows.push(row);
    }
    if(intakeFailure && !row.message.run) Object.assign(row.message,{status:'intake-failed',intakeFailure});
  }
  for(const row of rows) if(row.item) row.name=names.get(row.item.id) || row.name;
  return rows.sort((a,b)=>b.message.at-a.message.at);
}
function SpaceGroupLink({tr,chatId,name}) {
  const label=name && name!==chatId ? name : tr('飞书会话','Feishu conversation');
  return chatId ? h('a',{className:'sx-text-link',target:'_blank',rel:'noopener noreferrer',href:'https://applink.feishu.cn/client/chat/open?openChatId='+encodeURIComponent(chatId)},label) : label;
}
function spaceApprovalInput({scopeId,chatId,threadId,messageId},action) {
  // Ignoring permanently covers the whole conversation, so it names no topic or message.
  return action==='ignore' ? {scopeId,chatId,action} : {scopeId,chatId,threadId,messageId,action};
}
// The two dropdowns on a message awaiting approval. Allowing only its author needs the recorded sender.
function spaceApprovalActions(mention,menu,tr) {
  return menu==='allow' ? [{id:'once',label:tr('授权一次','Allow once')},{id:'permanent',label:tr('永久授权','Always allow')},
    ...mention.senderId ? [{id:'sender',label:tr('仅授权此用户','Allow this user only')}] : []] :
    [{id:'dismiss',label:tr('忽略一次','Ignore once')},{id:'ignore',label:tr('永久忽略','Always ignore')}];
}
function SpaceApproval({p,mention,returnFocus}) {
  if(!mention?.canApprove)return null;
  const choose=action=>{returnFocus.current?.focus();void p.groupAccess(spaceApprovalInput(mention,action))};
  const dropdown=(menu,zh,en)=>p.openMenu ? h('button',{className:'sx-quiet x2-dropdown',type:'button',disabled:p.busy,'aria-haspopup':'menu',
    onClick:e=>{const r=e.currentTarget.getBoundingClientRect();p.openMenu({kind:'superagent-approval',value:{key:spaceMentionKey(mention),menu}},{x:r.left,y:r.bottom})}},
    p.tr(zh,en),h(Mark,{name:'chevron',size:12})) :
    spaceApprovalActions(mention,menu,p.tr).map(a=>h('button',{key:a.id,className:'sx-quiet',type:'button',disabled:p.busy,onClick:()=>choose(a.id)},a.label));
  return h(React.Fragment,null,h('small',{className:'x2-approval-scope'},p.tr('授权一次仅限本话题；永久授权覆盖整个会话；仅授权此用户只办理这位成员在本会话的消息。忽略一次只略过这条，永久忽略后不再接收这个会话。','Allow once covers this topic; always allow covers the conversation; allow this user only covers that member in this conversation. Ignore once skips this message; always ignore stops receiving the conversation.')),
    h('div',{className:'sx-decision x2-approvals'},dropdown('allow','授权','Allow'),dropdown('ignore','忽略','Ignore')));
}
const spaceMentionKey=m=>JSON.stringify([m.scopeId,m.chatId,m.threadId,m.messageId]);
function SpaceTime({at,tr,day=false}) {
  const date=new Date(at);
  return h('time',{className:'x2-time',dateTime:date.toISOString()},
    day ? date.toLocaleDateString(tr('zh-CN','en-US'),{year:'numeric',month:'short',day:'numeric'}) :
      date.toLocaleTimeString(tr('zh-CN','en-US'),{hour:'2-digit',minute:'2-digit'}));
}

function SpaceActivityRow({p,row,open,restore}) {
  const {tr}=p,{message,mention}=row,trigger=React.useRef(null),statusId=React.useId();
  React.useLayoutEffect(()=>{if(restore)trigger.current?.focus()},[restore]);
  return h('li',{className:'x2-activity-row'},
    h(SpaceTime,{at:message.at,tr}),spaceStatusDot(message.status),
    h('div',{className:'x2-activity-copy'},
      h('button',{type:'button',className:'x2-activity-open',ref:trigger,'aria-describedby':message.intakeFailure ? statusId : undefined,onClick:()=>open(row.key)},
        message.text.length>140 ? message.text.slice(0,140)+'…' : message.text),
      h('small',{id:statusId},h(SpaceGroupLink,{tr,chatId:row.chatId,name:row.name}),' · ',spaceActivityStatus(message,tr)),
      h(SpaceApproval,{p,mention,returnFocus:trigger})),
    h('span',{className:'x2-row-link','aria-hidden':true},h(Mark,{name:'chevron',size:13})));
}
function SpaceRefresh({p}) {
  return h('button',{type:'button',className:'x2-back',onClick:p.reload,disabled:p.busy || p.refreshing,'aria-busy':p.refreshing},
    p.refreshing ? p.tr('刷新中…','Refreshing…') : p.tr('刷新','Refresh'));
}
function SpaceActivity({p,entries,open,headingRef,backId,compact}) {
  const {tr}=p,days=new Map();
  for(const e of entries) {
    const day=new Date(e.message.at).toDateString();
    if (!days.has(day)) days.set(day,[]);
    days.get(day).push(e);
  }
  return h('section',{className:compact?'x2-feed-list':'x2-page x2-activity','aria-label':tr('动态','Activity')},
    !compact && h('header',{className:'x2-page-head'},h('h2',{tabIndex:-1,ref:headingRef},tr('动态','Activity')),h(SpaceRefresh,{p})),
    !entries.length && h('p',{className:compact?'x2-lead-info':'x2-empty'},tr('暂无动态','No activity yet')),
    [...days].map(([day,rows])=>h('section',{key:day,className:'x2-day'},
      h('h3',null,h(SpaceTime,{at:rows[0].message.at,tr,day:true})),
      h('ul',{className:'x2-history'},rows.map(row=>h(SpaceActivityRow,{key:row.key,p,row,open,restore:row.key===backId}))))));
}
function spaceGrantLabel({mode,approvedAt,ignoredAt,note},tr) {
  const at=mode==='ignored' ? ignoredAt : approvedAt;
  // A member grant names the approving message, since member names are not resolved.
  const who=mode==='sender' ? tr('仅允许一位成员','Only one member')+(note ? tr('（发送「'+note+'」的人）',' (sender of “'+note+'”)') : '') : '';
  if(!Number.isFinite(at))return mode==='ignored' ? tr('已忽略此会话','Ignored') : who || tr('已永久允许此会话','Always allowed');
  const time=new Date(at).toLocaleString(tr('zh-CN','en-US'),{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  return mode==='ignored' ? tr(time+' 起忽略','Ignored since '+time) : who ? who+' · '+tr(time+' 起',' since '+time) : tr(time+' 起永久允许','Always allowed since '+time);
}
function SpaceGroup({p,group,label}) {
  const {tr,source,busy}=p,{chatId,name,mode,senderId}=group;
  return h('div',{className:'x2-account-row x2-grant'},
    h('div',null,h(SpaceGroupLink,{tr,chatId,name}),h('p',null,label)),
    h('button',{className:'sx-quiet',type:'button',disabled:busy,onClick:()=>p.groupAccess({scopeId:source.scopeId,chatId,action:'revoke',...(mode==='sender' ? {senderId} : {})})},
      mode==='ignored' ? tr('取消忽略','Stop ignoring') : tr('撤销授权','Revoke access')));
}
// Only the initiating page holds the display link; reject external or malformed artwork.
function spaceFeishuFlow(kind,value,now) {
  const fail=code=>{throw Object.assign(new Error(code),{code})};
  const {url,qrDataUrl,flowId,expiresAt}=value || {};
  let target;
  try { target=new URL(url); } catch { fail('auth-unavailable'); }
  const page=kind==='setup' ? 'https://open.feishu.cn/page/cli' : 'https://accounts.feishu.cn/oauth/v1/device/verify';
  if (target.origin+target.pathname!==page || target.username || target.password || typeof flowId!=='string' || !flowId ||
      typeof qrDataUrl!=='string' || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(qrDataUrl) || !Number.isFinite(expiresAt))
    fail('auth-unavailable');
  if (expiresAt<=now) fail('auth-expired');
  return {kind,flowId,url,qrDataUrl,expiresAt};
}
// A lost confirmation or cancellation response does not invalidate the user's link.
const spaceFeishuEnded=code=>['auth-expired','auth-denied','scope-changed'].includes(code);
// The button prepares the plugin-owned profile; only Feishu can grant consent.
async function spaceConnectFeishu(settings,ask,active) {
  let s=settings;
  const bound=!!s.tenantId && !!s.recipientId;
  if (!bound && (!s.enabled || !s.profile)) s=await ask('saveFeishu',{version:s.version,enabled:true,
    profile:s.profile || 'superagent',managed:s.profile ? s.managed : true});
  if (!active()) return null;
  const start=async kind=>({kind,version:s.version,...await ask('startFeishuAuth',{version:s.version,kind,...(kind==='login'?{automation:true}:{})})});
  if(s.managed && !bound) {
    try{return await start('setup')}catch(e){if(e.code!=='auth-profile-exists') throw e}
  }
  return active() ? start('login') : null;
}
const spacePollStages={
  identity:['核对登录账号','Check account'],search:['搜索新消息','Search messages'],metadata:['核对消息信息','Check message metadata'],
  group:['核对会话','Check conversation'],message:['读取消息','Read message'],history:['读取消息前文','Read prior messages'],
  admission:['核对办理授权','Check handling access'],storage:['读写本机记录','Access local storage'],
  receive:['接收消息','Receive message'],poll:['检查新消息','Poll for messages']
};
const spacePollReasons={
  'cli-not-found':['找不到 lark-cli','lark-cli was not found'],'cli-not-executable':['无法执行 lark-cli','lark-cli is not executable'],
  'context-too-large':['消息上下文过长，未交给助手','Message context too large; not sent to the assistant'],
  timeout:['请求超时','Request timed out'],'login-required':['需要登录飞书','Feishu login required'],
  'permission-denied':['飞书权限不足','Insufficient Feishu permissions'],'invalid-parameters':['请求参数无效','Invalid request parameters'],
  'rate-limited':['请求过于频繁','Rate limit exceeded'],network:['网络连接失败','Network connection failed'],
  'api-error':['飞书接口返回错误','Feishu API returned an error'],'identity-mismatch':['登录账号与绑定身份不符','Account does not match the binding'],
  'invalid-response':['返回数据无效','Invalid response'],'storage-unavailable':['本机记录不可用','Local storage unavailable'],
  'admission-denied':['会话或话题未获准办理','Conversation or topic not approved'],'cli-failed':['lark-cli 执行失败','lark-cli failed'],
  unknown:['原因未确定','Cause unknown']
};
function spacePollLabels(row,tr) {
  if(typeof row?.stage!=='string' || !Object.hasOwn(spacePollStages,row.stage) ||
    typeof row.reason!=='string' || !Object.hasOwn(spacePollReasons,row.reason))return;
  return {stage:tr(...spacePollStages[row.stage]),reason:tr(...spacePollReasons[row.reason])};
}
function spaceActivityStatus(message,tr) {
  const status=spaceStatus(message.status,tr),problem=message.intakeFailure && spacePollLabels(message.intakeFailure,tr);
  return problem ? status+' · '+problem.stage+tr('：',': ')+problem.reason : status;
}
function spacePollLogRows(records,tr) {
  if(!Array.isArray(records) || !records.length)return [];
  const format=new Intl.DateTimeFormat(tr('zh-CN','en-US'),{dateStyle:'medium',timeStyle:'medium'});
  return records.flatMap(row=>{
    const labels=spacePollLabels(row,tr);
    if(!labels || !Number.isSafeInteger(row.at) || row.at<=0 || row.at>8.64e15)return [];
    const {at,larkCode}=row;
    return [{iso:new Date(at).toISOString(),time:format.format(at),...labels,
      ...(Number.isInteger(larkCode) && larkCode>0 && larkCode<=2147483647 ? {code:tr('飞书错误码：','Feishu error code: ')+larkCode} : {})}];
  });
}
function spaceSourceStatus({state,detail},tr) {
  if(state==='unverified')return tr('尚未核验飞书账号。','The Feishu account has not yet been verified.');
  if(state==='ready')return detail==='已验证；本次仅处理一页，仍有未读取的匹配项。'
    ? tr('本次检查已完成，仍有匹配消息待同步。','This check completed. More matching messages remain.')
    : tr('最近一次飞书检查已完成。','The last Feishu check completed.');
  if(state==='error')return detail==='未能完成本次飞书轮询，将自动重试。'
    ? tr('未能完成本次飞书轮询，将自动重试。','The Feishu check failed and will retry automatically.')
    : tr('最近一次飞书操作未成功。','The last Feishu operation did not complete.');
  return null;
}
function SpacePollLog({records,tr}) {
  const rows=spacePollLogRows(records,tr);
  if(!rows.length)return null;
  return h('details',{className:'x2-poll-log'},h('summary',null,tr('错误日志','Error log')),
    h('ol',null,rows.map((r,i)=>h('li',{key:i},
      h('time',{dateTime:r.iso},r.time),h('span',null,r.stage,tr('：',': '),r.reason),r.code && h('small',null,r.code)))));
}
// Settings manage whole conversations only; per-topic "approve once" grants are not listed here.
function SpaceSourceGroups({p}) {
  const {tr,source}=p,groups=source.groups.filter(group=>['permanent','sender'].includes(group.mode)),ignored=source.groups.filter(group=>group.mode==='ignored');
  return h(React.Fragment,null,
    h('section',{className:'sx-fields x2-source-section'},
      h('h3',null,tr('永久允许的会话','Always-allowed conversations')),
      !groups.length && h('p',null,tr('暂无永久允许的会话。可在「动态」里对消息选择「授权 → 永久授权」。','No always-allowed conversations. In Activity, choose Allow → Always allow on a message.')),
      groups.map(group=>h(SpaceGroup,{p,key:group.chatId+(group.senderId || ''),group,label:spaceGrantLabel(group,tr)}))),
    ignored.length>0 && h('section',{className:'sx-fields x2-source-section'},
      h('h3',null,tr('已忽略的会话','Ignored conversations')),
      ignored.map(group=>h(SpaceGroup,{p,key:group.chatId,group,label:spaceGrantLabel(group,tr)}))));
}
async function spaceCommitPollInterval(draft,settings,save) {
  if(!draft)return null;
  const next=Number(draft.value);
  if(!Number.isInteger(next) || next<1 || next>1440)return draft;
  if(next===(settings.pollIntervalMinutes ?? 1))return null;
  const saved=await save({version:draft.version ?? settings.version,pollIntervalMinutes:next});
  return saved ? null : {value:draft.value};
}
function SpacePollInterval({settings,tr,save,disabled}) {
  const id=React.useId(),[draft,setDraft]=React.useState(null),stored=String(settings.pollIntervalMinutes ?? 1);
  async function commit(e) {
    e.preventDefault();
    if(disabled || !draft)return;
    const next=await spaceCommitPollInterval(draft,settings,save);
    setDraft(current=>current===draft ? next : current);
  }
  return h('form',{className:'x2-account-row x2-poll-interval',onSubmit:commit},
    h('label',{htmlFor:id},tr('检查新消息的间隔','Message check interval')),
    h('div',{className:'x2-poll-control'},h('input',{id,type:'number',min:1,max:1440,step:1,required:true,value:draft?.value ?? stored,disabled,
      onChange:e=>{const value=e.currentTarget.value;setDraft(value===stored ? null : {value,version:draft?.version ?? settings.version})},
      onKeyDown:e=>{if(e.key==='Escape' && !e.nativeEvent.isComposing)setDraft(null)}}),tr('分钟','min'),
      h('button',{type:'submit',className:'sx-quiet',disabled:disabled || !draft || draft.value===stored},tr('保存','Save'))));
}
function spaceHistoryValues(settings,draft) {
  return {historyCount:draft?.historyCount ?? String(settings.historyCount ?? 10),
    historyMinutes:draft?.historyMinutes ?? String(settings.historyMinutes ?? 5)};
}
function spaceHistoryPatch(draft,settings) {
  const values=spaceHistoryValues(settings,draft);
  if(!draft || values.historyCount==='' || values.historyMinutes==='')return null;
  const historyCount=Number(values.historyCount),historyMinutes=Number(values.historyMinutes);
  if(!Number.isInteger(historyCount) || historyCount<0 || historyCount>100 ||
     !Number.isInteger(historyMinutes) || historyMinutes<0 || historyMinutes>1440)return null;
  return {version:draft.version ?? settings.version,historyCount,historyMinutes};
}
function SpaceHistoryLimits({settings,tr,save,disabled}) {
  const [draft,setDraft]=React.useState(null),heading=React.useId();
  const stored=spaceHistoryValues(settings),values=spaceHistoryValues(settings,draft);
  const dirty=values.historyCount!==stored.historyCount || values.historyMinutes!==stored.historyMinutes;
  function edit(key,value) {
    const next={...draft,version:draft?.version ?? settings.version,[key]:value};
    if(value===stored[key])delete next[key];
    setDraft(next.historyCount===undefined && next.historyMinutes===undefined ? null : next);
  }
  async function commit(e) {
    e.preventDefault();
    const patch=spaceHistoryPatch(draft,settings);
    if(disabled || !dirty || !patch)return;
    const saved=await save(patch);
    setDraft(d=>d!==draft ? d : saved ? null : {...draft,version:undefined});
  }
  const field=(key,label,max)=>h('label',{className:'x2-poll-control'},label,h('input',{type:'number',min:0,max,step:1,required:true,
    value:values[key],disabled,onChange:e=>edit(key,e.currentTarget.value),onKeyDown:e=>{if(e.key==='Escape')setDraft(null)}}));
  return h('form',{className:'x2-account-row x2-history-limits','aria-labelledby':heading,onSubmit:commit},
    h('div',null,h('h3',{id:heading},tr('补读消息前文','Prior message context')),
      h('p',null,tr('有飞书话题时读取完整话题。仅无话题时按以下范围补读：默认最多 10 条、向前 5 分钟；任一项为 0 即不补读。','The full thread is read when available. Only unthreaded messages use these limits: by default, up to 10 messages from the preceding 5 minutes. Set either to 0 to skip that lookback.'))),
    h('div',{className:'x2-history-fields'},field('historyCount',tr('最多条数','Max messages'),100),
      field('historyMinutes',tr('向前分钟数','Minutes back'),1440),
      h('button',{type:'submit',className:'sx-quiet',disabled:disabled || !dirty},tr('保存','Save'))));
}
async function spaceCommitCliPath(draft,settings,save) {
  if(!draft || draft.value===(settings.cliPath ?? ''))return null;
  const saved=await save({version:draft.version ?? settings.version,cliPath:draft.value});
  // Keep a rejected path editable; the next explicit attempt uses the refreshed version.
  return saved ? null : {value:draft.value,unsaved:true};
}
function SpaceCliPath({settings,tr,save,disabled,draft,setDraft}) {
  const id=React.useId(),currentPath=settings.cliPath ?? '';
  async function commit() {
    if(!draft || disabled)return;
    const next=await spaceCommitCliPath(draft,settings,save);
    setDraft(current=>current===draft ? next : current);
  }
  return h('form',{className:'x2-account-row x2-cli-path',onSubmit:e=>{e.preventDefault();void commit()}},
    h('label',{htmlFor:id},tr('lark-cli 可执行文件路径','lark-cli executable path'),
      h('small',null,tr('留空使用系统 PATH。','Leave empty to use the system PATH.'),
        draft?.unsaved && tr(' 修改尚未保存。',' Changes not saved.'))),
    h('div',{className:'x2-cli-path-control'},h('input',{id,type:'text',value:draft?.value ?? currentPath,disabled,spellCheck:false,autoCapitalize:'none',autoComplete:'off',
      onChange:e=>{const value=e.currentTarget.value;setDraft(value===currentPath ? null : {version:draft?.version ?? settings.version,value})},
      onKeyDown:e=>{if(e.key==='Escape' && !e.nativeEvent.isComposing)setDraft(null)}}),
      h('button',{type:'submit',className:'sx-quiet',disabled:disabled || !draft || draft.value===currentPath},tr('保存','Save'))));
}
function SpaceSettingSwitch({label,description,checked,disabled,onChange}) {
  const id=React.useId();
  return h('label',{className:'x2-setting-switch',htmlFor:id},
    h('span',null,h('strong',{id:id+'-title'},label),h('small',{id:id+'-description'},description)),
    h('button',{id,type:'button',role:'switch','aria-checked':checked,'aria-labelledby':id+'-title','aria-describedby':id+'-description',
      className:'x2-switch',disabled,onClick:()=>onChange(!checked)},h('span',{'aria-hidden':true})));
}
function SpacePrivateChats({settings,canEnable,disabled,save,tr}) {
  const checked=settings.allowPrivateChats===true;
  return h(SpaceSettingSwitch,{label:tr('接收其他人的私聊','Receive direct messages from others'),
    description:!checked && !canEnable ? tr('先连接飞书并授权自动办理。','Connect Feishu and authorize automated handling first.') :
      tr('开启后，对方私聊你无需 @；和群里别人 @你一样，未获办理授权的消息在「动态」中待批。重新开启不会补收关闭期间的消息。','When this is on, SuperAgent receives direct messages from others even if they don’t mention you. As with group mentions, requests without existing access await approval in Activity. Messages sent while this was off are not backfilled.'),
    checked,disabled:disabled || (!checked && !canEnable),onChange:next=>void save({version:settings.version,allowPrivateChats:next})});
}
function SpaceSource({p}) {
  const {source,tr,feishuAction:ask,reloadFeishu:reload}=p, s=source.settings;
  const bound=!!s.tenantId && !!s.recipientId, connected=bound && s.enabled, status=connected && spaceSourceStatus(source,tr);
  const [cliDraft,setCliDraft]=React.useState(null),pathDirty=!!cliDraft && cliDraft.value!==(s.cliPath ?? '');
  const [flow,setFlow]=React.useState(null),[step,setStep]=React.useState(''),[error,setError]=React.useState('');
  const live=React.useRef(false),held=React.useRef(null),locked=React.useRef(false);
  const authLink=React.useRef(null),accountAction=React.useRef(null),lastFocusFlow=React.useRef(null);
  React.useLayoutEffect(()=>{
    const id=flow?.flowId ?? null;
    if(step || p.busy || id===lastFocusFlow.current)return;
    lastFocusFlow.current=id;
    // Only restore focus when the control that opened or closed the flow disappeared.
    if(document.activeElement===document.body)(id ? authLink : accountAction).current?.focus();
  },[flow,step,p.busy]);
  const cancel=React.useCallback(f=>ask('cancelFeishuAuth',{version:f.version,flowId:f.flowId}),[ask]);
  React.useEffect(()=>{live.current=true;return ()=>{
    live.current=false;if(held.current) void cancel(held.current).catch(()=>{});held.current=null;
  }},[cancel]);
  function clear(){held.current=null;setFlow(null)}
  React.useEffect(()=>{
    if(!flow)return;
    const timer=setTimeout(()=>{if(held.current===flow){clear();setError('auth-expired')}},Math.max(0,flow.expiresAt-Date.now()));
    return ()=>clearTimeout(timer);
  },[flow]);
  React.useEffect(()=>{
    const f=held.current;
    if(f && f.version!==s.version && f.initial!==s.version){clear();setError('scope-changed')}
  },[s.version]);
  async function show(raw,initial) {
    if(!raw)return;
    if(!live.current){await cancel(raw).catch(()=>{});return}
    let f;
    try { f={...spaceFeishuFlow(raw.kind,raw,Date.now()),version:raw.version,initial}; }
    catch(e){if(raw.flowId)await cancel(raw).catch(()=>{});throw e}
    held.current=f;setFlow(f);
  }
  async function act(action) {
    if(locked.current || p.busy)return;
    const f=held.current;
    locked.current=true;setStep(action);setError('');
    try {
      if(action==='connect' || action==='separate') {
        const base=action==='separate' && !bound && ['auth-profile-missing','auth-setup-locked'].includes(error)
          ? await ask('saveFeishu',{version:s.version,enabled:true,managed:true,profile:'superagent-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')}) : s;
        if(live.current)await show(await spaceConnectFeishu(base,ask,()=>live.current),s.version);
        if(live.current)await reload();
      } else if(action==='pause') {
        await ask('saveFeishu',{version:s.version,profile:s.profile,managed:s.managed,enabled:false});
        if(live.current)await reload();
      } else if(f) {
        if(action==='cancel'){await cancel(f);if(live.current)clear();return}
        const result=await ask('finishFeishuAuth',{version:f.version,flowId:f.flowId});
        if(!live.current)return;
        if(result?.kind!==f.kind)throw Object.assign(new Error(),{code:'auth-unavailable'});
        clear();
        if(result.kind==='setup') {
          const next=await ask('startFeishuAuth',{version:f.version,kind:'login',automation:true});
          await show({...next,kind:'login',version:f.version},f.version);
        } else await reload();
      }
    } catch(e) {
      if(live.current){
        if(f && spaceFeishuEnded(e.code))clear();
        setError(e.code || (f?'auth-unconfirmed':'auth-unavailable'));await reload();
      }
    } finally {locked.current=false;if(live.current)setStep('')}
  }
  const busy=p.busy || !!step, button=(label,action,primary=false)=>h('button',{className:primary?'sx-solid':'sx-quiet',type:'button',
    ref:action==='connect' ? accountAction : undefined,disabled:busy || (pathDirty && ['connect','separate'].includes(action)),onClick:()=>void act(action)},label);
  return h('div',{className:'sx-fields x2-source'},
    h('section',{className:'sx-fields x2-source-section'},
      h('div',{className:'x2-account-row'},h('div',null,h('h3',null,tr('飞书账号','Feishu account')),
        h('p',null,connected?(source.automationEnabled?tr('已绑定 · 已授权自动办理','Bound · automatic processing authorized'):tr('已绑定 · 尚未授权自动办理','Connected · automation not authorized')):bound?tr('已暂停接收','Paused'):tr('未连接','Not connected'))),
        !flow && (connected?h('div',{className:'sx-decision'},button(source.automationEnabled?tr('重新授权','Reauthorize'):tr('授权自动办理','Authorize automated handling'),'connect',!source.automationEnabled),button(tr('暂停接收','Pause'),'pause')):bound?button(tr('重新连接飞书','Reconnect Feishu'),'connect',true):
          button(step==='connect'?tr('正在连接…','Connecting…'):tr('连接飞书','Connect Feishu'),'connect',true))),
      status && h('p',{role:'status'},status),
      h(SpacePollLog,{records:source.pollErrors,tr}),
      !flow && h('p',null,tr('你在内部群、「与自己的聊天」或已开启接收的私聊中明确 @自己，等同于为该话题选「授权一次」，不必再点。对外发送仍遵守你的确认设置。','When you explicitly mention yourself in an internal group, your self-chat, or an enabled direct chat, it counts as Allow once for that topic. Your outbound confirmation setting still applies.'),
        !source.automationEnabled && tr('连接并授权后开始接收。消息获准办理前只供查看；对外发送时，会以你的身份回复原消息。',' Connect and authorize Feishu to receive messages. Until approved they are read-only. Outgoing replies are posted to the original message as you.')),
      flow && h('div',{className:'sx-fields x2-auth-flow'},
        h('p',null,flow.kind==='setup'?tr('先在飞书确认创建应用，再连接账号。','Confirm app creation in Feishu before connecting your account.'):
          tr('在飞书授权读取身份和会话消息、搜索直接 @你的消息，并以你的身份回复。仅同一飞书账号已有的会话和话题授权继续适用。','Authorize identity and message reads, direct mention searches, and replies as you. Only conversation and topic approvals for the same Feishu account carry over.')),
        h('a',{ref:authLink,className:'sx-text-link',target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer',href:flow.url},tr('打开飞书','Open Feishu')),
        h('img',{src:flow.qrDataUrl,alt:tr('也可用飞书扫码确认','Or scan with Feishu to confirm')}),
        h('div',{className:'sx-decision'},button(tr('我已确认','I have confirmed'),'finish',true),button(tr('取消','Cancel'),'cancel'))),
      h(SpaceCliPath,{settings:s,tr,save:p.setCliPath,draft:cliDraft,setDraft:setCliDraft,disabled:busy || !!flow}),
      h(SpacePrivateChats,{settings:s,canEnable:connected && source.automationEnabled,disabled:busy || !!flow,save:p.setPrivateChats,tr}),
      h(SpacePollInterval,{key:source.scopeId,settings:s,tr,save:p.setPollInterval,disabled:busy || !!flow}),
      h(SpaceHistoryLimits,{settings:s,tr,save:p.setHistoryLimits,disabled:busy || !!flow}),
      error && h('p',{role:'alert'},spaceErrorText(error,tr)),
      !flow && !bound && ['auth-profile-missing','auth-setup-locked'].includes(error) &&
        button(tr('另建专用连接','Start a separate connection'),'separate')),
    connected && h(SpaceSourceGroups,{p:{...p,busy},key:source.scopeId}));
}
function SpaceReleasePolicy({p}) {
  const {tr}=p;
  return h(SpaceSettingSwitch,{label:tr('对外发送前需我确认','Ask me before sending replies'),
    description:tr('开启时，每条追问和最终答复都需单独确认。关闭后新产生的追问和答复会自动发送，已在等待确认的不会自动发送。','When on, each question and final reply needs separate confirmation. When off, new questions and replies are sent automatically; those already awaiting confirmation stay on hold.'),
    checked:p.releaseRequired!==false,disabled:p.busy,onChange:next=>void p.setReleasePolicy({required:next})});
}
function SpaceSettings({p,source,show}) {
  const {tr}=p;
  return h('section',{className:'x2-page'},
    h('header',{className:'x2-page-head'},h('h2',null,'SuperAgent')),
    h('nav',{className:'x2-config-nav','aria-label':tr('设置类别','Settings categories')},
      [['team',tr('团队分工','Team roles')],['source',tr('飞书','Feishu')]].map(([id,label])=>
        h('button',{type:'button',key:id,'aria-current':(source?'source':'team')===id ? 'page' : undefined,onClick:()=>show(id)},label))),
    h('div',{className:source?'x2-fields':'x2-team-fields'},source ? h(SpaceSource,{p}) : h(React.Fragment,null,h(SpaceTeamRoles,p),h(SpaceReleasePolicy,{p}))));
}

function spaceRecordedPreset(item,role,tr) {
  if (item.team[role]) return item.teamNames?.[role] || item.team[role];
  if (role!==item.workerRole) return null;
  return item.resolvedPresetId ? tr('会话默认预设','Session default preset')+' · '+item.resolvedPresetId :
    tr('会话默认预设（未记录实际预设）','Session default preset (actual preset not recorded)');
}
function spaceSpeaker(speaker,tr) {
  if(speaker==='requester') return tr('提需人','Requester');
  if(speaker==='owner') return tr('你','You');
  const n=/^participant-(\d+)$/.exec(speaker)?.[1];
  return n ? tr('参与者 '+n,'Participant '+n) : speaker;
}
// The thread lines brought in with each message, exactly as the assistants received them.
function SpaceIntakeContext({tr,item}) {
  const rows=item.messages.filter(m=>m.kind==='feishu' && m.context?.length);
  if(!rows.length) return null;
  return h('section',null,h('h4',null,tr('带入的上下文','Context brought in')),
    rows.map(m=>h('ol',{key:m.requestId,className:'x2-intake-context'},m.context.map((line,i)=>h('li',{key:i},
      h('cite',null,new Date(line.at).toLocaleString(tr('zh-CN','en-US'),{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),
        ' · ',spaceSpeaker(line.speaker,tr),line.request && tr('（本条请求）',' (this request)')),
      h('p',null,line.text))))));
}
function SpaceMaterials({p,item,id}) {
  const {tr}=p, {source}=item;
  return h('aside',{id,className:'x2-materials','aria-label':tr('事项材料','Case materials')},
    h('h3',{className:'x2-rail-title'},tr('事项材料','Case materials')),
    h('section',null,h('h4',null,tr('来源','Source')),
      h('p',null,source.kind==='feishu' ? h(SpaceGroupLink,{tr,chatId:source.chatId,name:source.name}) : spaceOrigin(item,tr))),
    h(SpaceIntakeContext,{tr,item}),
    item.team && h('section',null,h('h4',null,tr('受理时的分工','Assignment at intake')),
      spaceRoles.map(([id,zh,en])=>{
        const preset=spaceRecordedPreset(item,id,tr),m=item.roleModels[id];
        return preset && h('p',{key:id},tr(zh,en),' · ',preset,
          m && ' · '+(m.inherit ? tr('DSH 默认','DSH default') : m.name || m.model)+(m.effort ? ' · '+spaceEffortName(m.effort,null,tr) : ''));
      })),
    item.resolvedModel && h('section',null,h('h4',null,tr('承办会话实际使用的模型','Model used by the case session')),
      h('p',null,item.resolvedModel.provider,' · ',item.resolvedModel.model,item.resolvedModel.effort && ' · '+spaceEffortName(item.resolvedModel.effort,null,tr))),
    item.sessionId && h('section',null,h('h4',null,tr('DSH 会话','DSH session')),h('code',null,item.sessionId)));
}
function spaceReleaseSelection({source,mentions},item,message) {
  const r=message.run,c=item.source;
  if(!r || r.caseId!==item.id || r.messageId!==message.requestId || message.kind!=='feishu' || c.kind!=='feishu')return null;
  const current=spaceCurrentCase(item,source);
  const mention=current && mentions?.find(m=>m.scopeId===source.scopeId && m.caseId===item.id && m.messageId===r.messageId &&
    m.chatId===c.chatId && m.threadId===c.threadId);
  return {chatId:c.chatId,name:mention?.name || c.name || (current && source.groups?.find(g=>g.chatId===c.chatId)?.name),
    at:mention?.at,input:current && c.chatId && c.threadId && r.status==='awaiting-release' && r.answer?.trim() && r.releaseToken
      ? {caseId:item.id,messageId:r.messageId,token:r.releaseToken} : null};
}
function spaceReleaseTopic(mentionAt,receivedAt,tr) {
  const label=tr('原消息','Original message'),at=mentionAt ?? receivedAt;
  if(!Number.isFinite(at))return label;
  const time=new Date(at).toLocaleString(tr('zh-CN','en-US'));
  return label+' · '+(mentionAt==null?tr('本机收件时间：','Received locally: '):tr('消息时间：','Message time: '))+time;
}
function SpaceRunOutput({p,item,message}) {
  const {tr}=p,r=message.run,heading=React.useRef(null);
  const pending=r.status==='awaiting-release',target=pending && spaceReleaseSelection(p,item,message);
  function choose(action) {heading.current?.focus();void p.releaseOutput({...target.input,action})}
  return h('div',{className:'x2-run-result','data-pending':pending},
    h('strong',{tabIndex:-1,ref:heading},r.outputKind==='question' ?
      (pending ? tr('待确认发送的追问','Question awaiting your confirmation') : tr('助手的追问','Question from the assistant')) :
      (pending ? tr('待确认发送的最终答复','Final reply awaiting your confirmation') : tr('最终答复','Final reply'))),
    h('p',null,r.answer),
    pending && target && h('p',{className:'x2-step-detail'},tr('回复至：','Reply to: '),h(SpaceGroupLink,{tr,chatId:target.chatId,name:target.name}),
      ' · ',spaceReleaseTopic(target.at,message.at,tr)),
    pending && (target?.input ? h('div',{className:'sx-decision x2-approvals'},
      // After access was revoked the reply can no longer be sent, only declined.
      r.releaseBlocked ? h('small',{className:'x2-approval-scope'},tr('授权已撤销，只能选择不发送。','Access was revoked; this can only be declined.')) :
        h('button',{type:'button',className:'sx-solid',disabled:p.busy,onClick:()=>choose('send')},tr('确认发送','Confirm send')),
      h('button',{type:'button',className:'sx-quiet',disabled:p.busy,onClick:()=>choose('decline')},tr('不发送','Do not send')))
      : h('p',{className:'x2-step-detail'},tr('当前无法放行，请核对飞书身份与话题授权。','Cannot release this reply. Check the Feishu identity and topic access.'))));
}
// Matches the Host: failed work can be retried; a reply that may already be posted cannot.
const spaceRetryable=run=>run.status==='stopped' || run.status==='uncertain' && run.reason==='work-uncertain';
// Matches the Host: a worker session can be taken over except while its reply is being posted.
const spaceTakeable=run=>!!run.workerSessionId && !!run.role && run.role!=='lead' &&
  (['assigned','working','approved','awaiting-release','waiting-requester'].includes(run.status) || spaceRetryable(run));
// Actions in the shared row menu, on the case's latest eligible message. Only cases still
// listed in Activity can be archived, so an archived case stays reachable there.
function spaceCaseMenu({records,archive,retry,takeOver,tr,source},caseId) {
  const item=records.find(r=>r.id===caseId);
  if(!item) return [];
  const latest=test=>[...item.messages].reverse().find(m=>m.run && test(m.run));
  const failed=latest(spaceRetryable),takeable=latest(spaceTakeable);
  return [
    ...takeable ? [{id:'takeover',label:tr('接手','Take over'),run:()=>takeOver(item,takeable)}] : [],
    ...failed ? [{id:'retry',label:tr('重试','Retry'),run:()=>retry(item,failed)}] : [],
    ...spaceCurrentCase(item,source) ? [{id:'archive',label:tr('归档','Archive'),run:()=>archive(item)}] : [],
  ];
}
// Messages of one seat from its native event stream: human input (the requester's reply, or
// your own messages after takeover), model text, and what the model sent through a reply tool,
// including the streaming attempt. Reasoning, other tool calls, tool results, SuperAgent's own
// instructions and child sessions are not shown.
const spaceReplyTools={superagent_answer:['answer','reply'],superagent_ask_requester:['question','question']};
function spaceSeatOutput(entries) {
  const items=[],live=new Map();
  const push=b=>{
    if(b?.type==='text' && b.text?.trim()) items.push({kind:'text',text:b.text});
    else if(b?.type==='tool-call' && spaceReplyTools[b.name]) {
      const [field,kind]=spaceReplyTools[b.name];
      try {const text=JSON.parse(b.arguments)?.[field];if(typeof text==='string' && text.trim()) items.push({kind,text})} catch { /* Still streaming or malformed. */ }
    }
  };
  const human=data=>{
    const text=(data?.content || []).filter(b=>b.type==='text').map(b=>b.text).join('');
    if(!text.trim() || data?.source?.kind!=='user') return;
    if(text.startsWith('SUPERAGENT_')) {
      // SuperAgent's own instruction; only the requester's reply inside it is human input.
      try {const reply=JSON.parse(text.slice(text.lastIndexOf('\n')+1))?.requesterReply;if(typeof reply==='string' && reply.trim()) items.push({kind:'requester',text:reply})} catch { /* Not a reply round. */ }
    } else items.push({kind:'owner',text});
  };
  for(const entry of entries) {
    const e=entry?.event;
    if(entry?.type==='event' && e?.type==='user/message') human(e.data);
    else if(entry?.type==='event' && e?.type==='assistant/message') for(const b of e.data?.message?.content || []) push(b);
    else if(entry?.type==='transient' && e?.type==='assistant/live-chunk') {
      const c=e.data?.chunk,id=e.data?.attemptId;
      if(!c || c.index===undefined) continue;
      if(!live.has(id)) live.set(id,new Map());
      const blocks=live.get(id),b=blocks.get(c.index) || {type:c.blockType,text:'',arguments:''};
      if(c.type==='block-start') b.type=c.blockType;
      else if(c.type==='text-delta') {b.type='text';b.text+=c.text}
      else if(c.type==='tool-call-delta') {b.type='tool-call';b.name=c.name ?? b.name;b.arguments+=c.argumentsDelta}
      else if(c.type==='reasoning-delta') b.type='reasoning';
      else if(c.type==='block-end') Object.assign(b,c.block);
      blocks.set(c.index,b);
    }
  }
  for(const blocks of live.values()) for(const b of [...blocks.entries()].sort((x,y)=>x[0]-y[0]).map(([,b])=>b)) push(b);
  return items;
}
function SpaceSeatOutput({p,sessionId,who}) {
  const {tr}=p,[binding,setBinding]=React.useState(null);
  React.useEffect(()=>{
    let reference;
    try {reference=p.retainSession?.(sessionId)} catch {return}
    if(!reference) return;
    setBinding(reference.binding);
    return ()=>{setBinding(null);reference.release()};
  },[sessionId,p.retainSession]);
  const source=binding?.eventSource;
  const subscribe=React.useCallback(fn=>source ? source.subscribe(fn) : ()=>{},[source]);
  const view=React.useSyncExternalStore(subscribe,()=>source?.getSnapshot());
  const items=React.useMemo(()=>spaceSeatOutput(view?.entries || []),[view]);
  if(!items.length) return null;
  const labels={requester:tr('提需人回复','Requester replied'),owner:tr('你','You'),reply:tr('答复','Reply'),question:tr('追问','Question')};
  return h('section',{className:'x2-seat-output'},h('div',{className:'x2-byline'},h('strong',null,who)),
    items.map((item,i)=>h('div',{key:i,className:'x2-seat-message','data-kind':item.kind},
      labels[item.kind] && h('span',{className:'x2-seat-label'},labels[item.kind]),h('pre',null,item.text))));
}
function SpaceMessageWork({p,item,message}) {
  const {tr}=p,run=message.run,steps=spaceWorkSteps(message,tr);
  if(!run) return h('p',{className:'x2-step-detail'},steps[0].stage);
  const preset=run.resolvedPresetId,worker=preset && (p.roster.find(row=>row.id===preset)?.name || preset);
  return h(React.Fragment,null,
    steps.length>0 && h('details',{className:'x2-process',open:true},
      h('summary',null,tr('办理过程','Work process'),' · ',spaceStatus(message.status,tr)),
      h('ol',{className:'x2-events'},steps.map((step,i)=>h('li',{key:i,className:'x2-process-step'},
        h('div',{className:'x2-byline'},h('strong',null,step.who),
          step.kind==='worker' && h('span',null,worker || spaceRoleLabel(run.role,tr,run.roleName))),
        h('p',null,step.stage),step.detail && h('p',{className:'x2-step-detail'},step.detail)))),
      (run.routerSessionId || run.workerSessionId) && h('div',{className:'x2-model-output'},
        h('h4',null,tr('会话记录','Conversation record')),
        run.routerSessionId && h(SpaceSeatOutput,{p,sessionId:run.routerSessionId,who:spaceRoleLabel('lead',tr)}),
        run.workerSessionId && h(SpaceSeatOutput,{p,sessionId:run.workerSessionId,who:worker || spaceRoleLabel(run.role,tr,run.roleName)})),
      (run.sessionId || run.workerSessionId) && h('button',{type:'button',className:'x2-back',onClick:()=>p.openSession(run.sessionId || run.workerSessionId)},
        h(Mark,{name:'link',size:13}),tr('查看本次承办会话','Open this work session'))),
    run.answer && h(SpaceRunOutput,{p,item,message}),
    ['delivered','waiting-requester'].includes(run.status) && run.receipt?.messageId && h('p',{className:'x2-receipt'},
      h(Mark,{name:'check',size:14}),tr('飞书已确认回帖','Reply confirmed by Feishu')));
}

function SpaceRecord({p,item,headingRef}) {
  const {tr}=p, [material,setMaterial]=React.useState(false), panelId=React.useId();
  const status=spaceCaseStatus(item);
  return h('article',{className:'x2-reader'},
    h('header',{className:'x2-subject'},
      h('div',{className:'x2-record-title'},h('h2',{ref:headingRef,tabIndex:-1},item.title),
        h('button',{type:'button',className:'x2-material-toggle','aria-expanded':material,'aria-controls':material ? panelId : undefined,onClick:()=>setMaterial(!material)},
          tr('事项材料','Case materials'),h(Mark,{name:'chevron',size:13}))),
      h('div',{className:'x2-owners'},h('span',null,spaceOrigin(item,tr)),item.workerRole && ' · '+spaceRoleLabel(item.workerRole,tr,item.workerRoleName),
        h('span',{className:'x2-state'},spaceStatusDot(status),spaceStatus(status,tr)),
        item.sessionId && h('button',{type:'button',className:'x2-back',onClick:()=>p.openSession(item.sessionId)},
          h(Mark,{name:'link',size:13}),tr('打开 DSH 会话','Open DSH conversation')))),
    h('div',{className:'x2-read-scroll',tabIndex:0,role:'region','aria-label':tr('事项内容','Case contents')},
      h('div',{className:'x2-read-layout','data-material':material},material && h(SpaceMaterials,{p,item,id:panelId}),
        h('div',{className:'x2-transcript'},h('ol',{className:'x2-events'},item.messages.map(message=>{
          const key=JSON.stringify([item.id,message.kind,message.requestId]);
          return h('li',{key,className:'x2-event'},
            h('div',{className:'x2-event-body'},h('div',{className:'x2-byline'},h('strong',null,message.kind==='feishu' ? tr('飞书原消息','Original Feishu message') : tr('你','You')),
              h(SpaceTime,{at:message.at,tr})),
              h('p',null,message.text),h(SpaceMessageWork,{p,item,message}),
              message.error && h('p',null,spaceErrorText(message.error,tr))));
        }))))));
}

function SpaceActivityDetail({p,row,back}) {
  const {tr}=p,{message,item,mention}=row,heading=React.useRef(null);
  React.useLayoutEffect(()=>{heading.current?.focus()},[row.key]);
  return h('article',{className:'x2-reader'},
    h('header',{className:'x2-subject'},
      h('button',{type:'button',className:'x2-back',onClick:back},h(Mark,{name:'back'}),tr('返回动态','Back to activity')),
      h('h2',{tabIndex:-1,ref:heading},tr('飞书消息','Feishu message')),
      h('div',{className:'x2-owners'},h(SpaceGroupLink,{tr,chatId:row.chatId,name:row.name}),
        h(SpaceTime,{at:message.at,tr}),h('span',{className:'x2-state'},spaceStatusDot(message.status),spaceActivityStatus(message,tr)))),
    h('div',{className:'x2-read-scroll x2-transcript',tabIndex:0,role:'region','aria-label':tr('消息内容','Message contents')},
      h('div',{className:'x2-event-body'},h('p',null,message.text),
        h(SpaceApproval,{p,mention,returnFocus:heading}),
        item && !message.intakeFailure && h(SpaceMessageWork,{p,item,message}),message.error && h('p',null,spaceErrorText(message.error,tr)))));
}

function spaceWorkspaceView(cases,view,compact,entries=[]) {
  const records=cases.filter(item=>!item.archivedAt && (item.hasWork || item.team || item.sessionId));
  const activity=view.section==='activity';
  const entry=activity && entries.find(row=>row.key===view.anchor);
  const selected=activity ? entry?.item : records.find(item=>item.id===view.caseId) || records[0];
  const reading=activity ? !!entry : selected && (!compact || selected.id===view.detailId);
  return {records,selected,entry,page:reading ? 'record' : view.section};
}

function EditionWorkspace(p) {
  const {tr}=p, desk=React.useRef(null), heading=React.useRef(null), currentRow=React.useRef(null), focus=React.useRef(false);
  const {cases}=p;
  const [compact,setCompact]=React.useState(true),[view,setView]=React.useState({section:'cases'});
  React.useLayoutEffect(()=>{
    const el=desk.current,measure=()=>setCompact(getComputedStyle(el).display!=='grid');
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return ()=>observer.disconnect();
  },[]);
  const entries=React.useMemo(()=>spaceActivity(cases,p.mentions,p.source),[cases,p.mentions,p.source]);
  const {records,selected,entry,page}=spaceWorkspaceView(cases,view,compact,entries);
  function showSection(section){setView({section,caseId:view.caseId})}
  function openRecord(item) {
    focus.current=true;
    setView({section:'cases',caseId:item.id,detailId:item.id});
  }
  function back() {
    focus.current=true;
    setView({section:view.section,caseId:view.caseId,backId:view.anchor});
  }
  async function archive(item) {
    const i=records.findIndex(r=>r.id===item.id),next=records[i+1] || records[i-1];
    if(!await p.archiveCase({caseId:item.id})) return;
    focus.current=true;
    setView({section:'cases',caseId:next?.id});
  }
  async function retry(item,message) {
    if(!await p.retryWork({caseId:item.id,messageId:message.requestId})) return;
    p.notify?.(tr('已重新开始办理','Work restarted'));
    focus.current=true;
    setView({section:'cases',caseId:item.id,detailId:item.id});
  }
  async function takeOver(item,message) {
    const value=await p.takeOver({caseId:item.id,messageId:message.requestId});
    if(value?.sessionId) p.openSession(value.sessionId);
  }
  const menuState=React.useRef(null);
  menuState.current={records,archive,retry,takeOver,tr,source:p.source};
  // One registration for the shared DSH row menu; its actions read the latest records on each opening.
  React.useEffect(()=>p.registerCaseMenu?.(({caseId})=>spaceCaseMenu(menuState.current,caseId)),[p.registerCaseMenu]);
  // The approval dropdowns read the latest pending mentions on each opening.
  const approvals=React.useRef(null);
  approvals.current={mentions:p.mentions || [],tr,groupAccess:p.groupAccess};
  React.useEffect(()=>p.registerMenu?.('pcmid-superagent.approval','superagent-approval',({key,menu})=>{
    const {mentions,tr,groupAccess}=approvals.current,mention=mentions.find(m=>m.canApprove && spaceMentionKey(m)===key);
    return mention ? spaceApprovalActions(mention,menu,tr).map(a=>({...a,run:()=>groupAccess(spaceApprovalInput(mention,a.id))})) : [];
  }),[p.registerMenu]);
  React.useLayoutEffect(()=>{
    if(!focus.current) return;
    focus.current=false;
    if(page==='cases') currentRow.current?.focus();
    if(page==='record' && !view.anchor) heading.current?.focus();
  },[view,page]);
  const casesLabel=tr('事项','Cases'),activityLabel=tr('动态','Activity');
  const feed=page==='activity' && h(SpaceActivity,{p,entries,compact,headingRef:heading,backId:view.backId,
    open:anchor=>setView({section:'activity',caseId:view.caseId,anchor})});
  return h('section',{className:'sx2','aria-label':tr('SuperAgent 工作区','SuperAgent workspace')},
    p.error && h('p',{className:'x2-lead-info',role:'alert'},p.error),
    compact && page==='record' && h('header',{className:'x2-mast'},h('button',{type:'button',className:'x2-nav-toggle',onClick:back},
      h(Mark,{name:'back',size:17}),view.section==='activity' ? tr('返回动态','Back to activity') : tr('返回事项','Back to cases'))),
    h('div',{className:'x2-desk',ref:desk,'data-page':page},
      h('div',{className:'x2-directory'},
        h('nav',{className:'x2-nav','aria-label':tr('工作区导航','Workspace navigation')},
          h('div',{className:'x2-brand'},h('h1',null,'SuperAgent'),compact && feed && h(SpaceRefresh,{p})),
          h('div',{className:'x2-sections'},[['cases',casesLabel],['activity',activityLabel]].map(([id,label])=>h('button',{
            key:id,type:'button','aria-current':view.section===id ? 'page' : undefined,onClick:()=>showSection(id)},label))),
          view.section==='cases' && (records.length ? h('ul',{className:'x2-tree','aria-label':casesLabel},records.map(item=>{
            const target={kind:'superagent-case',value:{caseId:item.id}};
            return h('li',{key:item.id,className:'x2-case-row'},h('button',{type:'button',
              ref:item.id===selected?.id ? currentRow : undefined,title:compact ? undefined : item.title,
              'aria-current':page==='record' && item.id===selected?.id ? 'true' : undefined,onClick:()=>openRecord(item),...p.menu?.trigger?.(target)},
              h('span',null,item.title)),
              p.menu?.button({target,label:tr('“'+item.title+'”的更多操作','More actions for '+item.title),className:'x2-row-menu'}));
          })) :
            compact && h('p',{className:'x2-lead-info'},tr('暂无事项','No cases yet')))),
        compact && feed),
      h('div',{className:'x2-panel'},entry ? h(SpaceActivityDetail,{key:entry.key,p,row:entry,back}) :
        page==='record' ? h(SpaceRecord,{key:selected.id,p,item:selected,headingRef:heading}) :
        page==='activity' ? !compact && feed :
        !compact && h('section',{className:'x2-page'},h('h2',null,casesLabel),h('p',{className:'x2-empty'},tr('暂无事项','No cases yet'))))));
}
