import assert from 'node:assert/strict'
import test from 'node:test'
import {createCases} from '../host/cases.js'
import {starterTeam} from '../host/role-defaults.js'

const provider='codex-provider'
const base={lead:'superagent-lead',develop:'superagent-develop',answer:'superagent-answer'}
function context(current=provider,includeAnswer=true){
  const calls=[],rows=[{id:'gpt-6.2-astra',efforts:['high','xhigh']},...(includeAnswer?[{id:'gpt-6-luna',efforts:['medium']}]:[])]
  const services={agentDefaultModel:{currentSelection:()=>({provider:current})},llm:{
    listModels:async p=>{assert.equal(p,provider);calls.push('list');return rows},
    resolveModelInfo:async (p,id)=>{assert.equal(p,provider);calls.push(id);return {provider,id,name:id,
      reasoning:{efforts:rows.find(r=>r.id===id).efforts.map(id=>({id}))}}}
  }}
  return {get:k=>services[k],logger:()=>({warn(){}}),calls}
}
test('starter routes use the current Codex catalog and only validated effort levels, with no generation',async()=>{
  const ctx=context(),{team,roleModels}=await starterTeam(ctx)
  assert.deepEqual(team,base)
  assert.deepEqual(ctx.calls,['list','gpt-6.2-astra','gpt-6-luna'])
  assert.deepEqual(Object.fromEntries(Object.entries(roleModels).map(([k,v])=>[k,[v.provider,v.model,v.effort]])),{
    lead:[provider,'gpt-6.2-astra','high'],develop:[provider,'gpt-6.2-astra','xhigh'],answer:[provider,'gpt-6-luna','medium']})
  const other=context('unrelated')
  assert.deepEqual(await starterTeam(other),{team:base,roleModels:{}})
  assert.deepEqual(other.calls,[])
  assert.equal((await starterTeam(context(provider,false))).roleModels.answer,undefined)
})
test('a stalled catalog cannot indefinitely block startup or fill guessed routes after its deadline',async()=>{
  let unblock
  const ctx=context(),llm=ctx.get('llm')
  const wait=new Promise(r=>{unblock=r})
  const setup=starterTeam({...ctx,get:k=>k==='llm'?{...llm,listModels:()=>wait}:ctx.get(k)},25)
  const result=await setup
  assert.deepEqual(result,{team:base,roleModels:{}})
  unblock([{id:'gpt-6.2-astra'}]);await new Promise(r=>setImmediate(r))
  assert.deepEqual(result.roleModels,{})
  assert.deepEqual(ctx.calls,[])
})
test('migrate only missing bindings once; retain manual presets, existing settings and later explicit native defaults',async()=>{
  let disk={schema:1,team:{lead:'',develop:'my-developer',answer:''},roleModels:{lead:{inherit:true,effort:'low'}},cases:[]}, checks=0
  const make=()=>createCases({load:()=>disk,save:s=>{disk=structuredClone(s)}}),init=async()=>{checks++;return starterTeam(context())}
  const app=make()
  await app.initializeRoles(init)
  assert.deepEqual(disk.team,{...base,develop:'my-developer'})
  assert.deepEqual(disk.roleModels.lead,{inherit:true,effort:'low'})
  assert.equal(disk.roleModels.answer.model,'gpt-6-luna')
  await app.configure({team:{answer:''},roleModels:{answer:null}})
  await app.setReleasePolicy({required:false})
  const restarted=make()
  await restarted.initializeRoles(init)
  assert.equal(checks,1)
  assert.equal((await restarted.teamSettings()).team.answer,'')
  assert.equal((await restarted.teamSettings()).roleModels.answer,undefined)
  assert.equal(await restarted.isReleaseRequired(),false)
})
