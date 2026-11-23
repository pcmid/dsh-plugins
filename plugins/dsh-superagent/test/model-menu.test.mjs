import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source=await Promise.all(['role-menu','roles'].map(name=>readFile(new URL('../src/'+name+'.js',import.meta.url),'utf8')))
const {spaceModelDirectory,spaceRoleModelOptions,spaceRoleChoice,spaceRolePane,spaceMenuGroups,spaceMenuBounds,spaceMenuScrollDelta}=
  new Function(source.join('\n')+';return {spaceModelDirectory,spaceRoleModelOptions,spaceRoleChoice,spaceRolePane,spaceMenuGroups,spaceMenuBounds,spaceMenuScrollDelta}')()
const tr=cn=>cn
const row=(n)=>({providerId:n===1?'deepseek-official':'other',providerName:n===1?'DS':'Other',modelId:'m'+n,modelName:'Model '+n,
  isDshDefault:n===0,efforts:n===0?['low','high']:[],defaultEffort:'low',configuredEffort:n===0?'high':undefined})
const menu=(count,saved=null)=>spaceRoleModelOptions(spaceModelDirectory({rows:Array.from({length:count},(_,n)=>row(n))}),saved,tr).model

test('open the composer root on a resolved model; drill into model or supported effort without pinning the inherited default',()=>{
  const {value,pages,groups}=menu(4)
  assert.equal(value,''); assert.equal(spaceRolePane(pages,null),'root')
  assert.equal(menu(4).inheritedLabel,'Model 0');assert.equal(pages.effort.inheritedLabel,'高')
  assert.equal(groups[0].options[0].label,'默认');assert.equal(pages.effort.groups[0].options[0].label,'默认')
  assert.equal(menu(0),'默认')
  assert.deepEqual(pages.root[0].options.map(({label,detail})=>[label,detail]),[['模型','Model 0'],['推理等级','高']])
  assert.equal(spaceRolePane(pages,'model'),'model'); assert.equal(spaceRolePane(pages,'effort'),'effort')
  assert.equal(pages.effort.value,'');assert.deepEqual(spaceRoleChoice([row(0)],null,'effort','low'),{inherit:true,effort:'low'})
  assert.equal(groups[1].key,'deepseek-official')
  assert.equal(pages.search,false);assert.equal(menu(5).pages.search,true)
  const fixed=spaceRoleChoice([row(1)],null,'model',groups[1].options[0].value)
  assert.deepEqual(fixed,{provider:'deepseek-official',model:'m1',name:'Model 1',effort:''})
  const noEffort=menu(2,fixed).pages
  assert.deepEqual(noEffort.root[0].options.map(o=>o.value),['model']);assert.equal(spaceRolePane(noEffort,'effort'),'root')
  assert.equal(spaceRolePane(undefined,null),'single')
})

test('unlisted binding opens the model list directly and keeps the saved choice unavailable, not selected by default',()=>{
  const m=menu(4,{provider:'gone',model:'m1',name:'Gone'})
  assert.equal(spaceRolePane(m.pages,null),'model');assert.equal(m.pages.search,false)
  assert.equal(m.groups[0].options[1].value,m.value);assert.equal(m.groups[0].options[1].disabled,true)
})

test('search by model name inside each provider, retaining duplicate names and ranking prefix first',()=>{
  const group=(key,names)=>({key,options:names.map((label,i)=>({label,value:key+i}))})
  const gs=[group('A',['x G P T','GPT-X']),group('B',['GPT-X','other'])]
  assert.deepEqual(spaceMenuGroups(gs,' gpT ').map(g=>g.options.map(o=>o.value)),[['A1','A0'],['B0']])
  assert.deepEqual(spaceMenuGroups(gs,'absent'),[]);assert.equal(spaceMenuGroups(gs,''),gs)
  const {groups}=menu(5,{provider:'other',model:'m3',name:'Model 3'})
  assert.equal(spaceMenuGroups(groups,'Model 0')[0].options[0].value,'["other","m0"]')
  assert.equal(spaceMenuGroups(groups,'')[0].options[0].value,'')
})

test('Tab leaves the picker without committing the highlighted result; Enter still selects it',()=>{
  const tab=source[0].split("if (e.key==='Tab') {")[1].split('\n    }')[0]
  assert.match(tab,/x2-model-clear/);assert.match(tab,/close\(\);return/);assert.doesNotMatch(tab,/choose\(|preventDefault/)
  assert.match(source[0],/typing && e\.key==='Enter'\) \{e\.preventDefault\(\);choose\(enabled\[activeIndex\]\)/)
})

test('navigating up keeps the highlighted model below its pinned provider header',()=>{
  const list={top:100,bottom:300,height:200}
  const row=top=>({top,bottom:top+34,height:34})
  assert.equal(spaceMenuScrollDelta(row(108),list,24),-16)
  assert.equal(spaceMenuScrollDelta(row(124),list,24),0)
  assert.equal(spaceMenuScrollDelta(row(280),list,24),14)
  assert.equal(spaceMenuScrollDelta(row(108),list,0),0) // No sticky heading in the adjacent selectors.
})

test('model card follows the right edge above the trigger, flipping below when needed; siblings stay left-aligned below',()=>{
  const view={top:0,left:0,height:680,width:800},anchor={left:370,right:530,top:450,bottom:482}
  assert.deepEqual(spaceMenuBounds(anchor,view,76,240,true),{left:290,top:366,width:240,height:76})
  assert.equal(spaceMenuBounds({...anchor,top:22,bottom:54},view,360,300,true).top,62)
  const edge=spaceMenuBounds({...anchor,right:20},{...view,width:214},360,420,true)
  assert.deepEqual([edge.left,edge.width],[12,190])
  assert.deepEqual(spaceMenuBounds(anchor,view,76,238),{left:370,top:486,width:238,height:76})
})
