const spaceRoles = [
  ['lead','Router','Router'],
  ['develop','开发助手','Developer','代码和工程任务，包括构建和部署。','Code and engineering tasks, including builds and deployment.'],
  ['answer','答疑助手','Q&A','其他问题和文字任务。','Other questions and text tasks.']
];
// Settings snapshots from before custom helpers carry no list: both built-in helpers, enabled.
const spaceBuiltinHelpers=[{id:'develop',builtin:true,disabled:false},{id:'answer',builtin:true,disabled:false}];
function spaceEffortName(id,row,tr) {
  const known={off:['关闭','Off'],none:['无','None'],minimal:['最低','Minimal'],low:['低','Low'],medium:['中','Medium'],high:['高','High'],xhigh:['极高','Extra high'],max:['最高','Max']};
  const label=row?.effortNames && Object.hasOwn(row.effortNames,id) ? row.effortNames[id] : '';
  if (typeof label==='string' && label && label.toLowerCase()!==id.toLowerCase() &&
      (!Object.hasOwn(known,id) || label.toLowerCase()!==known[id][1].toLowerCase())) return label;
  return Object.hasOwn(known,id) ? tr(...known[id]) : (label || id);
}
const spaceRouteKey = (provider,model) => JSON.stringify([provider,model]);

// Keep provider identity: different providers can advertise the same model ID.
function spaceRoleChoice(rows, saved, field, value) {
  if (field === 'model' && value === '') return null;
  if (field === 'effort') {
    if (!value) return saved && !saved.inherit ? {...saved,effort:''} : null;
    const row=spaceEffectiveModel(rows,saved);
    if (!row?.efforts.includes(value)) return undefined;
    return !saved || saved.inherit ? {inherit:true,effort:value} : {...saved,effort:value};
  }
  const row=field==='model' && rows.find(r=>spaceRouteKey(r.providerId,r.modelId)===value);
  return row ? {provider:row.providerId,model:row.modelId,name:row.modelName,effort:''} : undefined;
}

function spaceEffectiveModel(rows,saved) {
  return !saved || saved.inherit ? rows.find(r=>r.isDshDefault) :
    rows.find(r=>r.providerId===saved.provider && r.modelId===saved.model);
}

// A saved choice that disappeared stays visible, but cannot be selected again.
function spaceDefaultOptions(defaultLabel,value,unavailableLabel) {
  const options=[{value:'',label:defaultLabel}];
  if (unavailableLabel!=null) options.push({value,disabled:true,label:unavailableLabel});
  return options;
}

function spaceModelDirectory(catalog) {
  const rows=catalog?.rows || [], providers=new Map();
  for (const row of rows) {
    const {providerId,modelId}=row;
    if (!providers.has(providerId)) providers.set(providerId,{
      key:providerId,label:row.providerName,options:[]
    });
    providers.get(providerId).options.push({value:spaceRouteKey(providerId,modelId),label:row.modelName});
  }
  return {rows,groups:[...providers.values()].sort((a,b)=>Number(b.key==='deepseek-official')-Number(a.key==='deepseek-official')),defaultRow:spaceEffectiveModel(rows),
    status:!catalog ? 'loading' : catalog.error ? 'error' : 'ready'};
}

function spaceRoleModelOptions({rows,groups,defaultRow,status},saved,tr) {
  const inherit=tr('默认','Default'), pinned=saved && !saved.inherit;
  const row=pinned ? spaceEffectiveModel(rows,saved) : defaultRow;
  let model=inherit;
  if (rows.length || saved) {
    const value=pinned ? spaceRouteKey(saved.provider,saved.model) : '';
    const unavailable=pinned && !row ?
      (saved.name || saved.model)+(status==='ready' ? tr('（不在目录中）',' (not listed)') : '') : null;
    const options=spaceDefaultOptions(inherit,value,unavailable);
    model={value,groups:[{options},...groups],inheritedLabel:defaultRow?.modelName};
  }
  const efforts=row?.efforts || [], value=saved?.effort || '';
  let effort;
  if (efforts.length || value) {
    const defaultEffort=(!pinned && row?.configuredEffort) || row?.defaultEffort;
    const inheritedLabel=efforts.includes(defaultEffort) ? spaceEffortName(defaultEffort,row,tr) : inherit;
    const unavailable=value && !efforts.includes(value) ? spaceEffortName(value,row,tr)+tr('（当前不可用）',' (currently unavailable)') : null;
    const options=spaceDefaultOptions(inherit,value,unavailable).concat(efforts.map(e=>({value:e,label:spaceEffortName(e,row,tr)})));
    effort={value,groups:[{options}],inheritedLabel};
  } else {
    effort=status==='loading' ? tr('读取中…','Loading…') :
      !pinned && !row ? tr('默认模型未提供档位','Default model levels not available') :
      row?.capabilitiesKnown ? tr('该模型不可调','Not adjustable for this model') : tr('未提供强度档位','No effort levels listed');
  }
  if (typeof model!=='string') {
    const entries=[{value:'model',label:tr('模型','Model'),detail:row?.modelName}];
    if (efforts.length) {
      const current=value || (!pinned && row.configuredEffort) || row.defaultEffort;
      entries.push({value:'effort',label:tr('推理等级','Effort'),detail:current ? spaceEffortName(current,row,tr) : tr('默认','Default')});
    }
    model.pages={root:row ? [{options:entries}] : null,effort,search:rows.length>4};
  }
  return {model,effort};
}

const goodRow = row => !!row && !row.broken;
// Built-in names come from DSH's settings.agentPreset dictionary, not from role names or preset IDs.
const spaceBuiltinPresets = new Map([
  ['standard',['presetStandardName','Standard mode']], ['ptc',['presetPtcName','PTC mode']],
  ['minimal',['presetMinimalName','Minimal mode']], ['cordis',['presetCordisName','Creator mode']]
]);
function spacePresetRoster(rows,presetText) {
  return rows.flatMap(row=>{
    if (!row || typeof row.id!=='string' || !row.id.trim()) return [];
    const builtin=row.name===undefined && spaceBuiltinPresets.get(row.id);
    const localized=builtin && presetText?.(builtin[0]);
    const name=builtin ? (localized && localized!==builtin[0] ? localized : builtin[1]) :
      typeof row.name==='string' && row.name.trim();
    return name ? [{...row,name,builtin:!!builtin}] : [];
  });
}

function spacePresetLabel(p,role) {
  const {team,roster,rosterStatus,tr}=p;
  if (!team[role]) return tr('默认','Default');
  if (rosterStatus==='loading') return tr('读取中…','Loading…');
  if (rosterStatus==='error') return tr('无法读取','Unavailable');
  const row=roster.find(r=>r.id===team[role]);
  if (!row || row.broken) return tr('预设不可用','Preset unavailable');
  return row.name?.trim() || tr('预设未命名','Unnamed preset');
}

function spacePresetGroups(roster,tr) {
  const choices=roster.filter(goodRow);
  return [false,true].map(builtin=>({key:String(builtin),label:builtin ? tr('DSH 内置','DSH built-in') : tr('自定义预设','Custom presets'),
    options:choices.filter(r=>r.builtin===builtin).map(r=>({value:r.id,label:r.name}))})).filter(g=>g.options.length);
}

function spacePresetOptions({roster,rosterStatus,tr},id,groups) {
  if (rosterStatus!=='ready') return rosterStatus==='loading' ? tr('读取中…','Loading…') : tr('无法读取预设','Presets unavailable');
  const current=roster.find(row=>row.id===id);
  const unavailable=id && !goodRow(current) ? (current ? current.name+tr('（不可用）',' (unavailable)') : tr('原绑定预设不可用','Bound preset unavailable')) : null;
  const options=spaceDefaultOptions(tr('默认','Default'),id,unavailable);
  return {value:id,groups:[{options},...groups]};
}

function SpaceTeamRoles(p) {
  const {tr,team,roleModels,roster,catalog,busy,configure}=p, helpers=p.helpers || spaceBuiltinHelpers;
  const [form,setForm]=React.useState(null), root=React.useRef(null), refocus=React.useRef(null);
  // After the form closes, return focus to the control that opened it.
  React.useLayoutEffect(()=>{
    if(form || busy || !refocus.current) return;
    root.current?.querySelector('[data-opens="'+refocus.current+'"]')?.focus();refocus.current=null;
  },[form,busy]);
  const directory=spaceModelDirectory(catalog), presets=spacePresetGroups(roster,tr);
  const header=[tr('预设','Preset'),tr('模型','Model'),tr('思考强度','Reasoning effort')];
  const thead=h('thead',null,h('tr',null,header.map(v=>h('th',{key:v,scope:'col'},v))));
  function pickers(role,name) {
    const saved=roleModels[role];
    const preset=spacePresetOptions(p,team[role],presets);
    const {model,effort}=spaceRoleModelOptions(directory,saved,tr);
    function choose(field,value) {
      const next=spaceRoleChoice(directory.rows,saved,field,value);
      if (next!==undefined) configure({roleModels:{[role]:next}});
    }
    function cell(column,choice,onChange,onEffort) {
      return h('td',{key:column,'data-label':column},typeof choice==='string' ? choice :
        h(SpaceSelect,{...choice,tr,label:name+' · '+column,onChange,onEffort,disabled:busy}));
    }
    return h('tr',null,cell(header[0],preset,value=>configure({team:{[role]:value}})),
      cell(header[1],model,value=>choose('model',value),value=>choose('effort',value)),
      cell(header[2],effort,value=>choose('effort',value)));
  }
  const helper=input=>configure({helper:input});
  function close() {refocus.current=form.id || 'add';setForm(null)}
  async function submit(e) {
    e.preventDefault();
    const {id,name,description}=form;
    if (await helper(id ? {action:'edit',id,name,description} : {action:'add',name,description})) close();
  }
  const edit=field=>e=>{const value=e.currentTarget.value;setForm(f=>({...f,[field]:value}))};
  const helperForm=()=>h('form',{className:'x2-helper-form',onSubmit:submit},
    h('label',null,tr('名称','Name'),h('input',{type:'text',value:form.name,disabled:busy,autoFocus:true,onChange:edit('name')})),
    h('label',null,tr('描述','Description'),h('textarea',{rows:3,value:form.description,disabled:busy,onChange:edit('description')})),
    h('div',{className:'x2-helper-actions'},
      h('button',{type:'submit',className:'sx-solid',disabled:busy},form.id ? tr('保存','Save') : tr('添加','Add')),
      h('button',{type:'button',className:'sx-quiet',onClick:close},tr('取消','Cancel'))));
  // One helper per row group: its name, description and controls, then its pickers in the Router's columns.
  function helperGroup(row) {
    const {id,builtin,disabled}=row, known=spaceRoles.find(r=>r[0]===id);
    const name=spaceRoleLabel(id,tr,row.name), description=known ? tr(known[3],known[4]) : row.description;
    const head=form?.id===id ? h('td',{colSpan:3},helperForm()) :
      h('th',{colSpan:3,scope:'rowgroup'},h('div',{className:'x2-helper-title'},
        h('span',null,h('span',{className:'x2-helper-name'},name),description && h('small',null,description)),
        h('span',{className:'x2-helper-actions'},
          !builtin && h('button',{type:'button',className:'sx-quiet','data-opens':id,disabled:busy,'aria-label':name+' · '+tr('编辑','Edit'),
            onClick:()=>setForm({id,name:row.name,description:row.description})},tr('编辑','Edit')),
          // A removed helper's row disappears; focus moves on to "Add helper".
          !builtin && h('button',{type:'button',className:'sx-quiet',disabled:busy,'aria-label':name+' · '+tr('删除','Delete'),
            onClick:()=>{refocus.current='add';void helper({action:'remove',id})}},tr('删除','Delete')),
          h('button',{type:'button',role:'switch','aria-checked':!disabled,'aria-label':name+' · '+tr('启用','Enabled'),
            className:'x2-switch',disabled:busy,onClick:()=>helper({action:disabled ? 'enable' : 'disable',id})},h('span',{'aria-hidden':true})))));
    return h('tbody',{key:id,className:disabled ? 'x2-helper-off' : undefined},h('tr',{className:'x2-helper-head'},head),pickers(id,name));
  }
  return h('div',{className:'x2-roles',ref:root},
    h('h3',null,'Router'),
    h('table',{className:'x2-router','aria-label':'Router'},thead,h('tbody',null,pickers('lead',spaceRoleLabel('lead',tr)))),
    h('h3',null,tr('助手','Helpers')),
    h('table',{className:'x2-helpers','aria-label':tr('助手','Helpers')},thead,helpers.map(helperGroup)),
    form && !form.id ? helperForm() :
      h('button',{type:'button',className:'sx-quiet x2-add-helper','data-opens':'add',disabled:busy,onClick:()=>setForm({name:'',description:''})},tr('添加助手','Add helper')),
    h('p',{className:'x2-role-note'},tr('更改只用于新事项；已有事项保留原分工。','Changes apply to new cases. Existing cases keep their assignments.')),
    !directory.rows.length && h('p',{className:'x2-role-note'},tr('本机没有已加载的模型目录。','No model catalog is loaded on this client.')));
}
