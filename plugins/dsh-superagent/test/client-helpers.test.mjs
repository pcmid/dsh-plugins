import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const files=['role-menu','roles','work-steps','edition','runtime']
const source=(await Promise.all(files.map(name=>readFile(new URL('../src/'+name+'.js',import.meta.url),'utf8')))).join('\n')
const tr=cn=>cn
const fake=(type,props,...children)=>({type,props:props ?? {},children:children.flat()})
const find=(node,match)=>!node || typeof node!=='object' ? [] : [...(match(node) ? [node] : []),...node.children.flatMap(c=>find(c,match))]
const text=node=>typeof node==='string' ? node : node && typeof node==='object' ? node.children.map(text).join('') : ''

// Hooks keep their slots across renders, so a click followed by render() shows the next state.
function mount(props) {
  const slots=[];let i=0
  const React={Fragment:'fragment',useLayoutEffect(){},
    useState(init){const k=i++;if(!(k in slots))slots[k]=init;return [slots[k],v=>{slots[k]=typeof v==='function' ? v(slots[k]) : v}]},
    useRef(init){const k=i++;if(!(k in slots))slots[k]={current:init};return slots[k]}}
  const {TeamRoles,SpaceSelect}=new Function('h','React',source+';return {TeamRoles:SpaceTeamRoles,SpaceSelect}')(fake,React)
  const sent=[]
  const p={tr,team:{lead:'',develop:'',answer:'',['helper-1a2b3c4d']:''},roleModels:{},roster:[],rosterStatus:'ready',catalog:{rows:[]},busy:false,
    configure:async patch=>{sent.push(patch);return {}},...props}
  return {sent,SpaceSelect,render:()=>{i=0;return TeamRoles(p)}}
}
const custom={id:'helper-1a2b3c4d',builtin:false,disabled:false,name:'运维助手',description:'部署和巡检。\n只处理生产环境。'}
const helpers=[{id:'develop',builtin:true,disabled:false},{id:'answer',builtin:true,disabled:true},custom]
const tables=node=>find(node,n=>n.type==='table')
const rowsOf=table=>find(table,n=>n.type==='tbody')[0].children
const buttons=(node,label)=>find(node,n=>n.type==='button' && text(n)===label)

test('team settings show the Router alone and a helper list; only custom helpers can be edited or deleted',()=>{
  const {render,SpaceSelect}=mount({helpers})
  const view=render(),[router,list]=tables(view)
  assert.deepEqual(find(view,n=>n.type==='h3').map(text),['Router','助手'])
  assert.deepEqual(find(router,n=>n.type==='th').map(text),['预设','模型','思考强度'])
  assert.deepEqual(find(router,n=>n.type===SpaceSelect).map(n=>n.props.label),['Router · 预设'])
  assert.equal(find(router,n=>n.props.role==='switch').length,0)
  assert.deepEqual(find(list,n=>n.type==='thead')[0].children[0].children.map(text),['名称','预设','模型','思考强度','启用','操作'])
  const rows=rowsOf(list)
  assert.deepEqual(rows.map(r=>[r.children[0].children[0],text(r.children[0].children[1])]),[
    ['开发助手','代码和工程任务，包括构建和部署。'],['答疑助手','其他问题和文字任务。'],['运维助手','部署和巡检。\n只处理生产环境。']])
  assert.deepEqual(rows.map(r=>find(r,n=>n.props.role==='switch')[0].props['aria-checked']),[true,false,true])
  assert.deepEqual(rows.map(r=>find(r,n=>n.type==='button' && !n.props.role).map(text)),[[],[],['编辑','删除']])
  assert.deepEqual(find(rows[2],n=>n.type===SpaceSelect).map(n=>n.props.label),['运维助手 · 预设'])
  assert.match(text(view),/更改只用于新事项；已有事项保留原分工。/)
})

test('a snapshot without a helper list shows both built-in helpers as enabled',()=>{
  const rows=rowsOf(tables(mount().render())[1])
  assert.deepEqual(rows.map(r=>[r.props.key,find(r,n=>n.props.role==='switch')[0].props['aria-checked']]),[['develop',true],['answer',true]])
})

test('switches, presets and deletion send one helper or team patch each; all helpers may be disabled',async()=>{
  const {render,sent}=mount({helpers})
  const rows=rowsOf(tables(render())[1])
  for(const r of rows) find(r,n=>n.props.role==='switch')[0].props.onClick()
  buttons(rows[2],'删除')[0].props.onClick()
  find(rows[2],n=>n.props.label==='运维助手 · 预设')[0].props.onChange('ops-preset')
  find(tables(render())[0],n=>n.props.label==='Router · 预设')[0].props.onChange('router-preset')
  assert.deepEqual(sent,[{helper:{action:'disable',id:'develop'}},{helper:{action:'enable',id:'answer'}},
    {helper:{action:'disable',id:'helper-1a2b3c4d'}},{helper:{action:'remove',id:'helper-1a2b3c4d'}},
    {team:{'helper-1a2b3c4d':'ops-preset'}},{team:{lead:'router-preset'}}])
})

test('adding opens an inline form below the list; it closes only after the Host accepts it',async()=>{
  const {render,sent}=mount({helpers})
  buttons(render(),'添加助手')[0].props.onClick()
  let view=render()
  assert.equal(buttons(view,'添加助手').length,0)
  const form=()=>find(render(),n=>n.type==='form')[0]
  find(form(),n=>n.type==='input')[0].props.onChange({currentTarget:{value:'翻译助手'}})
  find(form(),n=>n.type==='textarea')[0].props.onChange({currentTarget:{value:'中英互译。'}})
  assert.deepEqual(find(form(),n=>n.type==='button').map(text),['添加','取消'])
  await form().props.onSubmit({preventDefault(){}})
  assert.deepEqual(sent,[{helper:{action:'add',name:'翻译助手',description:'中英互译。'}}])
  view=render()
  assert.equal(find(view,n=>n.type==='form').length,0);assert.equal(buttons(view,'添加助手').length,1)
})

test('a rejected add keeps the form and its text; cancel closes it without a patch',async()=>{
  const {render,sent}=mount({helpers,configure:async patch=>{sent.push(patch)}})
  buttons(render(),'添加助手')[0].props.onClick()
  const form=()=>find(render(),n=>n.type==='form')[0]
  find(form(),n=>n.type==='input')[0].props.onChange({currentTarget:{value:'x'.repeat(41)}})
  await form().props.onSubmit({preventDefault(){}})
  assert.equal(find(form(),n=>n.type==='input')[0].props.value,'x'.repeat(41))
  buttons(form(),'取消')[0].props.onClick()
  assert.equal(find(render(),n=>n.type==='form').length,0)
  assert.equal(sent.length,1)
})

test('editing a custom helper reuses the form, prefilled, and sends an edit patch',async()=>{
  const {render,sent}=mount({helpers})
  buttons(rowsOf(tables(render())[1])[2],'编辑')[0].props.onClick()
  const form=()=>find(render(),n=>n.type==='form')[0]
  assert.equal(find(form(),n=>n.type==='input')[0].props.value,'运维助手')
  assert.equal(find(form(),n=>n.type==='textarea')[0].props.value,custom.description)
  find(form(),n=>n.type==='input')[0].props.onChange({currentTarget:{value:'运维值班'}})
  await form().props.onSubmit({preventDefault(){}})
  assert.deepEqual(sent,[{helper:{action:'edit',id:custom.id,name:'运维值班',description:custom.description}}])
})

test('work steps, case owners and worker labels name a custom helper by its recorded name, else by its id',()=>{
  const {steps,label,withRuns,takeable}=new Function(source+';return {steps:spaceWorkSteps,label:spaceRoleLabel,withRuns:spaceWithRuns,takeable:spaceTakeable}')()
  const run={status:'working',role:'helper-1a2b3c4d',roleName:'运维助手',attempt:1}
  assert.equal(steps({kind:'feishu',status:'working',run},tr)[1].stage,'指派给运维助手')
  assert.equal(steps({kind:'feishu',status:'working',run:{...run,roleName:undefined}},tr)[1].stage,'指派给helper-1a2b3c4d')
  assert.equal(label('develop',tr,'别名'),'开发助手');assert.equal(label('lead',tr),'Router')
  const [item]=withRuns([{id:'c',messages:[{kind:'feishu',requestId:'m'}]}],[{caseId:'c',messageId:'m',...run}])
  assert.deepEqual([item.workerRole,item.workerRoleName],['helper-1a2b3c4d','运维助手'])
  assert.match(source,/spaceRoleLabel\(item\.workerRole,tr,item\.workerRoleName\)/)
  assert.equal((source.match(/spaceRoleLabel\(run\.role,tr,run\.roleName\)/g) || []).length,3)
  const seat={workerSessionId:'w',status:'working'}
  assert.equal(takeable({...seat,role:'helper-1a2b3c4d'}),true)
  assert.equal(takeable({...seat,role:'develop'}),true)
  for(const role of ['lead',undefined,''])assert.equal(takeable({...seat,role}),false,String(role))
  assert.equal(takeable({role:'helper-1a2b3c4d',status:'working'}),false)
  assert.equal(takeable({...seat,role:'helper-1a2b3c4d',status:'delivering'}),false)
})
