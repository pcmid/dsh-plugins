// rc.3 does not expose a session-independent public snapshot. Never load a catalog,
// call a provider, read account settings, or open an arbitrary session to populate a menu.
function spaceCatalogStore(ctx) {
  if (ctx.get('modules')?.manifest?.release?.version!=='0.2.2-rc.3') return null;
  const own=(obj,key)=>obj && Object.getOwnPropertyDescriptor(obj,key)?.value;
  const store=own(own(ctx.get('modelDirectories'),'catalog'),'store');
  return typeof store?.getSnapshot==='function' && typeof store?.subscribe==='function' ? store : null;
}
function spaceCatalogRows(state) {
  const rows=[], value=state?.value;
  if (state?.status!=='ready' || !Array.isArray(value?.groups)) return rows;
  const named=v=>typeof v==='string' && !!v.trim();
  for (const group of value.groups) {
    if (!named(group?.id) || !named(group.name) || !Array.isArray(group.models)) continue;
    for (const model of group.models) {
      const levels=model?.reasoning?.efforts ?? [];
      if (!named(model?.id) || !named(model.name) || !Array.isArray(levels) || !levels.every(e=>named(e?.id) && named(e.name))) continue;
      const efforts=levels.map(e=>e.id),isDshDefault=group.id===value.default?.provider && model.id===value.default.model;
      rows.push({providerId:group.id,providerName:group.name,modelId:model.id,modelName:model.name,isDshDefault,efforts,
        defaultEffort:model.reasoning?.defaultEffort,configuredEffort:isDshDefault ? value.default.reasoningEffort : undefined,
        effortNames:Object.fromEntries(levels.map(e=>[e.id,e.name])),capabilitiesKnown:true});
    }
  }
  return rows;
}
async function spaceCall(ctx,endpoint,payload) {
  const reply=await ctx.connection.rpc.call('/api','pcmid/superagent/'+endpoint,payload);
  if (!reply?.ok) throw Object.assign(new Error(reply?.error?.message),{code:reply?.error?.code});
  return reply.value;
}
function spaceErrorText(code,tr) {
  const labels={
    SOURCE_NOT_ALLOWED:['消息来源不允许执行。','This source cannot run instructions.'],INVALID_REQUEST:['委托格式不正确。','Invalid request.'],
    EXECUTOR_UNAVAILABLE:['DSH 执行服务不可用。','The DSH execution service is unavailable.'],
    PRESET_UNAVAILABLE:['已绑定的预设不可用。','The bound preset is unavailable.'],
    MODEL_UNAVAILABLE:['所选模型或思考强度不可用。','The selected model or reasoning effort is unavailable.'],
    SESSION_MISMATCH:['会话身份或预设不匹配。','The session identity or preset does not match.'],
    SESSION_UNAVAILABLE:['无法使用原会话。','The original session is unavailable.'],
    WORKSPACE_UNAVAILABLE:['无法使用 SuperAgent 工作区。','The SuperAgent workspace is unavailable.'],
    PROMPT_UNCERTAIN:['未确认 DSH 是否接单，请核对原会话。','Submission is unconfirmed. Check the original conversation.'],
    'scope-changed':['飞书身份已变更，请重新确认会话授权。','The Feishu identity changed. Review conversation access again.'],
    'source-unconfigured':['请在「飞书」中连接账号。','Connect your account under Feishu.'],
    'settings-unavailable':['配置未能保存，请刷新设置后重试。','Could not save the configuration. Refresh the settings and try again.'],
    'auth-unavailable':['飞书授权未完成，请检查本机 lark-cli 和网络后重试。','Authorization did not complete. Check lark-cli and your connection, then try again.'],
    'auth-unconfirmed':['尚未收到操作结果，可以再次确认或取消。','No result was received. You can check again or cancel.'],
    'auth-pending':['飞书尚未确认。请先在官方页面完成操作，再回来确认。','Feishu has not confirmed yet. Complete the step on its official page, then check again.'],
    'auth-expired':['链接已过期，请重新发起。','The link expired. Start again for a new link.'],
    'auth-denied':['飞书未批准此次请求。若要重试，请重新发起。','Feishu declined this request. Start again if you wish to retry.'],
    'auth-busy':['已有飞书操作在进行。请在发起页面继续，或待链接过期后重试。','Another Feishu operation is in progress. Continue on the page where it started or retry after expiry.'],
    'auth-setup-locked':['上一次连接可能仍在创建应用。可稍后重试，或另建专用连接。','App setup may still be running. Try again later or start a separate connection.'],
    'auth-profile-exists':['该飞书应用配置已存在，可以直接授权本人账号。','This app configuration already exists. You can authorize your account.'],
    'auth-profile-missing':['找不到原飞书应用，可另建专用连接。','The previous Feishu app could not be found. You can start a separate connection.'],
    'admission-denied':['此会话或话题未经授权。','This conversation or topic is not authorized.'],
    'release-stale':['这条答复已处理或已变更，请核对最新状态。','This reply was already handled or changed. Check its latest state.'],
    'source-unavailable':['飞书同步未成功。','Feishu sync failed.'],
    'invalid-input':['输入无效，请核对后重试。','Invalid input. Check your entries.'],
    'source-settings-changed':['飞书设置已变更。请核对后重新保存。','Feishu settings changed. Check your values and save again.'],
    'invalid-cli-path':['未保存。请填写本机 lark-cli 可执行文件的绝对路径，不要附加参数；留空可使用系统 PATH。','Not saved. Enter the absolute path to the lark-cli executable without arguments, or leave it empty to use the system PATH.'],
    'preset-unavailable':['预设不可用，请重新选择。','The preset is unavailable. Choose another.'],
    'roster-unavailable':['无法读取预设。','Presets could not be loaded.'],
    'case-not-found':['未找到此事项。','This case could not be found.'],
    'request-conflict':['请求与已保存的委托冲突。','This request conflicts with an existing submission.'],
    'case-busy':['此事项正在提交。','Submission is already in progress.'],
    'dispatch-uncertain':['无法确认上次提交，请核对原会话。','The last submission is unconfirmed. Check the original conversation.'],
    'storage-unavailable':['未能读取或保存工作区。','Could not read or save the workspace.']
  };
  return tr(...(Object.hasOwn(labels,code) ? labels[code] : ['操作未确认，请刷新查看工作区状态。','The operation was not confirmed. Refresh the workspace to check.']));
}

async function spaceRefreshWorkspace(reload,readRoster,manual) {
  const refresh=()=>Promise.all([reload(),readRoster()]);
  if (!manual) return refresh();
  const {active,pending,setRefreshing}=manual;
  if (!active.current || pending.current) return;
  pending.current=true;
  setRefreshing(true);
  try { await refresh() }
  finally {
    pending.current=false;
    if (active.current) setRefreshing(false);
  }
}

function SuperagentPage({t,ops,settingsOnly=false,renderFactorySlot,useContextMenu}) {
  const zh=t('language')==='zh',tr=React.useCallback((cn,en)=>zh ? cn : en,[zh]);
  const [generation,setGeneration]=React.useState(0);
  // The shared DSH row menu: its ellipsis button and right-click binding, when the menu plugin is loaded.
  const bindings=useContextMenu?.(),menu=renderFactorySlot && {button:props=>renderFactorySlot('contextMenu.button',props),trigger:bindings?.getTriggerProps};
  React.useEffect(()=>ops.onReset(()=>setGeneration(n=>n+1)),[ops]);
  return h('section',{className:settingsOnly?'sx sx-global-settings':'sx','aria-label':'SuperAgent'},h('style',null,css),h(SpaceConnected,{key:generation,ops,tr,settingsOnly,menu}));
}
function SpaceConnected({ops,tr,settingsOnly,menu}) {
  const [tab,setTab]=React.useState('team');
  const [snapshot,setSnapshot]=React.useState(null),[error,setError]=React.useState(null),[busy,setBusy]=React.useState(false);
  const [roster,setRoster]=React.useState(null),[rosterStatus,setRosterStatus]=React.useState('loading');
  const [catalog,setCatalog]=React.useState(null);
  const [refreshing,setRefreshing]=React.useState(false),manualPending=React.useRef(false);
  const active=React.useRef(true),lock=React.useRef(false),revision=React.useRef(0),rosterRev=React.useRef(0);
  const reload=React.useCallback(async (keepSource=false)=>{
    const token=++revision.current;
    try {
      const value=await ops.ask(settingsOnly?'settingsSnapshot':'snapshot',{});
      if(active.current && revision.current===token) {setSnapshot(value);setError(null);return value}
    } catch(e) {
      if(active.current && revision.current===token) {
        // A failed background read must not unmount (and cancel) an active authorization flow.
        if(!keepSource || e.code==='scope-changed') setSnapshot(null);
        setError(e.code || 'unavailable');
      }
    }
  },[ops,settingsOnly]);
  const readRoster=React.useCallback(async ()=>{
    const token=++rosterRev.current;
    try {
      const response=await ops.presets(),rows=response?.value?.presets;
      if (!response?.ok || !Array.isArray(rows)) throw Error('presets');
      if(active.current && rosterRev.current===token) {setRoster(spacePresetRoster(rows,ops.presetText));setRosterStatus('ready')}
    } catch {
      if(active.current && rosterRev.current===token){setRoster([]);setRosterStatus('error')}
    }
  },[ops]);
  React.useEffect(()=>{
    active.current=true;
    const refresh=()=>{if(!lock.current)void spaceRefreshWorkspace(()=>reload(settingsOnly),readRoster)};
    refresh(); window.addEventListener('focus',refresh);
    const off=settingsOnly && ops.observeModels(setCatalog);
    const unsubscribe=!settingsOnly && ops.onSettingsChange(()=>{if(!lock.current)void reload()});
    return ()=>{active.current=false;revision.current++;rosterRev.current++;if(off)off();if(unsubscribe)unsubscribe();window.removeEventListener('focus',refresh)};
  },[ops,reload,readRoster,settingsOnly]);
  React.useEffect(()=>{
    if(!Number.isSafeInteger(snapshot?.revision))return;
    let stopped=false,timer;
    const tick=async()=>{
      try {
        if(!document.hidden && !lock.current && await ops.ask('viewRevision',{})!==snapshot.revision &&
          !stopped && !lock.current)await reload(settingsOnly);
      } catch { /* The connection reset or next visible tick will refresh. */ }
      if(!stopped)timer=setTimeout(tick,4000);
    };
    if(settingsOnly)void tick();else timer=setTimeout(tick,4000);
    return ()=>{stopped=true;clearTimeout(timer)};
  },[settingsOnly,snapshot?.revision,ops,reload]);
  async function change(endpoint,input) {
    if (lock.current) return;
    const sourceEdit=['setCliPath','setHistoryLimits','setPrivateChats','setPollInterval'].includes(endpoint);
    lock.current=true;revision.current++;setBusy(true);setError(null);
    try {
      const value=await ops.ask(endpoint,input);
      if(!active.current) return;
      if(sourceEdit) setSnapshot(s=>s && {...s,source:{...s.source,settings:value}});
      await reload(sourceEdit);
      if(active.current) return value;
    } catch(e) {
      if(active.current){
        await reload(sourceEdit);
        if(active.current)setError(sourceEdit && e.code==='scope-changed' ? 'source-settings-changed' : e.code || 'unavailable');
      }
    } finally {
      lock.current=false;
      if(active.current) setBusy(false);
    }
  }
  if (!snapshot) return h('div',{className:'sx2'},h('section',{className:'x2-page'},h('h2',null,'SuperAgent'),
    h('p',{className:'x2-empty',role:error ? 'alert' : 'status'},error ? spaceErrorText(error,tr) : tr('正在读取工作区…','Loading workspace…')),
    error && h('button',{type:'button',className:'sx-quiet',onClick:()=>void reload()},tr('重试','Retry'))));
  const p={...snapshot,tr,catalog,roster:roster || [],rosterStatus,busy,error:error && spaceErrorText(error,tr),configure:patch=>change('configure',patch),
    feishuAction:ops.ask,reloadFeishu:reload,setCliPath:input=>change('setCliPath',input),setHistoryLimits:input=>change('setHistoryLimits',input),
     setPrivateChats:input=>change('setPrivateChats',input),setReleasePolicy:input=>change('setReleasePolicy',input),releaseOutput:input=>change('releaseOutput',input),
    archiveCase:input=>change('archiveCase',input),retryWork:input=>change('retryWork',input),takeOver:input=>change('takeOver',input),
    groupAccess:input=>change('groupAccess',input),setPollInterval:input=>change('setPollInterval',input)};
  if(settingsOnly) return h('div',{className:'sx2'},p.error && h('p',{role:'alert'},p.error),
    h(SpaceSettings,{p,source:tab==='source',show:setTab}));
  return h(EditionWorkspace,{...p,cases:spaceWithRuns(p.cases,p.automation),openSession:ops.openSession,refreshing,
    menu,registerCaseMenu:ops.registerCaseMenu,registerMenu:ops.registerMenu,openMenu:ops.openMenu,notify:ops.notify,retainSession:ops.retainSession,
    reload:()=>spaceRefreshWorkspace(reload,readRoster,{active,pending:manualPending,setRefreshing})});
}
// Whether SuperAgent needs the owner, for the sidebar icon. Polls the cheap view revision and
// rereads attention only when it changes, while the page is visible.
function spaceAttentionStore(ask) {
  let needed=false,revision,stopped=false,timer,busy=false;
  const listeners=new Set(),set=value=>{if(value!==needed){needed=value;listeners.forEach(fn=>fn())}};
  async function tick() {
    if(busy || stopped) return;
    busy=true;
    try {
      if(!document.hidden) {
        const current=await ask('viewRevision',{});
        if(current!==revision) {const value=await ask('attention',{});revision=value.revision;set(value.needed===true)}
      }
    } catch { /* Keep the last known state until the next tick. */ }
    finally {busy=false}
  }
  const refresh=()=>{revision=undefined;void tick()};
  return {
    getSnapshot:()=>needed,
    subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)},
    start(){void tick();timer=setInterval(tick,5000);window.addEventListener('focus',refresh);
      return ()=>{stopped=true;clearInterval(timer);window.removeEventListener('focus',refresh)}},
    refresh,
  };
}
function SpaceLeadIcon({size,store,tr}) {
  const needed=React.useSyncExternalStore(store.subscribe,store.getSnapshot);
  return h('span',{style:{position:'relative',display:'inline-flex'}},h(Mark,{name:'lead',size}),
    needed && h('span',{role:'img','aria-label':tr('需要你处理','Needs your attention'),style:{position:'absolute',top:-1,right:-2,width:7,height:7,
      borderRadius:'50%',background:'var(--dsw-alias-state-warn-primary)',boxShadow:'0 0 0 1.5px var(--dsw-specific-sidebar-fill)'}}));
}
function applySuperagent(ctx) {
  const id='pcmid-superagent', ns='pcmid.superagent';
  ctx.effect(()=>ctx.locale.register(ns,{zh:{label:'SuperAgent',language:'zh'},en:{label:'SuperAgent',language:'en'}}),'superagent: panel labels');
  const changes=new EventTarget(),t=ctx.locale.bind(ns),ops={
    ask:(endpoint,input)=>spaceCall(ctx,endpoint,input),
    presets:()=>ctx.remote.agentPresets.list(),presetText:ctx.locale.bind('settings.agentPreset'),
    // DSH does not open an archived session, so restore it to the sidebar first.
    openSession:async id=>{
      if(ctx.get?.('workspaces')?.list?.getSnapshot()?.archivedSessionIds?.includes(id)) await ctx.uiWorkspace.unarchiveSession(id);
      ctx.uiWorkspace.openSession(id);
    },
    // Read-only follow of a seat's native event stream; released when the case view unmounts.
    retainSession:id=>ctx.get('sessions')?.retain(id,{source:'superagentCase'}),
    registerCaseMenu:resolve=>ctx.get('contextMenus')?.register({id:'pcmid-superagent.case',target:'superagent-case',order:0,resolve:value=>resolve(value)}) ?? (()=>{}),
    registerMenu:(id,kind,resolve)=>ctx.get('contextMenus')?.register({id,target:kind,order:0,resolve:value=>resolve(value)}) ?? (()=>{}),
    // The shared DSH menu popup, anchored below a dropdown button.
    openMenu:ctx.get('contextMenus') ? (target,point)=>ctx.get('contextMenus').open(target,point) : undefined,
    notify:text=>ctx.get('contextMenus')?.notify(text,true),
    onReset:listener=>ctx.on('connection/reset',listener),
    onSettingsChange:listener=>{changes.addEventListener('change',listener);return ()=>changes.removeEventListener('change',listener)},
    observeModels:listener=>{
      listener({rows:[]});
      const observer=ctx.inject(['modules','modelDirectories'],scope=>{
        const store=spaceCatalogStore(scope);
        if(!store)return;
        scope.effect(()=>{
          const read=()=>listener({rows:spaceCatalogRows(store.getSnapshot())});
          const off=store.subscribe(read);read();return ()=>{off();listener({rows:[]})};
        },'superagent: observe cached model choices');
      });
      return ()=>observer.dispose();
    }
  };
  const settingsOps={...ops,async ask(endpoint,input){
    const result=await ops.ask(endpoint,input);
    if(['configure','saveFeishu','finishFeishuAuth','groupAccess','setPollInterval','setCliPath','setHistoryLimits','setPrivateChats','setReleasePolicy'].includes(endpoint)) changes.dispatchEvent(new Event('change'));
    return result;
  }};
  const attention=spaceAttentionStore(ops.ask);
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id,order:25,locale:ns,label:()=>t('label'),
    inject:()=>({ops:settingsOps,settingsOnly:true})},SuperagentPage));
  ctx.slots.inject('settings.section.icon',()=>ctx.slots.register({name:'settings.section.icon',id},
    ({size})=>h(Mark,{name:'lead',size})));
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:id,locale:ns,inject:()=>({ops})},SuperagentPage));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id,order:13,locale:ns,label:()=>t('label')},
    ({size=20,t:text})=>h(SpaceLeadIcon,{size,store:attention,tr:(zh,en)=>text?.('language')==='zh' ? zh : en})));
  ctx.effect(()=>attention.start(),'superagent: attention indicator');
  ctx.effect(()=>ctx.on('connection/reset',attention.refresh),'superagent: attention after reconnect');
}
