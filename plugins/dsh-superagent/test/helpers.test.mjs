import test from 'node:test'
import assert from 'node:assert/strict'
import { createCases } from '../host/cases.js'
import { createLoop } from '../host/loop.js'
import { assignable, builtinHelpers } from '../host/helpers.js'

function cases() {
  let disk
  const deps = {load:async()=>structuredClone(disk),save:async v=>{disk=structuredClone(v)},listPresets:async()=>[{id:'ops',name:'Ops'}],executor:{}}
  return {service:createCases(deps),restart:()=>createCases(deps),get disk(){return disk}}
}
const rejected = (p,code) => assert.rejects(p,e=>e.code===code)
const source = {kind:'feishu',scopeId:'f'.repeat(64),tenantId:'test',recipientId:'ou_owner',chatId:'oc_group',threadId:'om_root'}

test('built-in helpers can only be switched; owner-added helpers can be edited, switched and removed',async()=>{
  const c=cases(), {service}=c
  assert.deepEqual((await service.teamSettings()).helpers,[{id:'develop',builtin:true,disabled:false},{id:'answer',builtin:true,disabled:false}])
  for(const op of [{action:'remove',id:'develop'},{action:'edit',id:'answer',name:'x',description:'y'},{action:'add',name:' ',description:'y'},
    {action:'add',name:'x'.repeat(41),description:'y'},{action:'add',name:'x',description:'y'.repeat(501)},{action:'disable',id:'missing'},{action:'rename',id:'develop'}])
    await rejected(service.configure({helper:op}),'invalid-input')
  let s=await service.configure({helper:{action:'add',name:' 运维助手 ',description:'服务器巡检\n和告警处理。'}})
  const ops=s.helpers.at(-1)
  assert.match(ops.id,/^helper-[a-f0-9]{8}$/)
  assert.deepEqual(ops,{id:ops.id,builtin:false,disabled:false,name:'运维助手',description:'服务器巡检\n和告警处理。'})
  assert.equal(s.team[ops.id],'')
  s=await service.configure({team:{[ops.id]:'ops'},roleModels:{[ops.id]:{provider:'p',model:'m'}}})
  s=await service.configure({helper:{action:'disable',id:'develop'}})
  s=await service.configure({helper:{action:'edit',id:ops.id,name:'巡检助手',description:'只做巡检。'}})
  assert.deepEqual((await c.restart().teamSettings()).helpers.map(h=>[h.id,h.disabled,h.name]),[['develop',true,undefined],['answer',false,undefined],[ops.id,false,'巡检助手']])
  assert.deepEqual(assignable(s.helpers),[builtinHelpers[1],{id:ops.id,name:'巡检助手',description:'只做巡检。'}])
  for(const id of ['answer',ops.id]) await service.configure({helper:{action:'disable',id}})
  assert.deepEqual(assignable((await service.teamSettings()).helpers),[],'every helper may be disabled')
  await service.configure({helper:{action:'enable',id:'develop'}})
  s=await service.configure({helper:{action:'remove',id:ops.id}})
  assert.deepEqual(s.helpers.map(h=>h.id),['develop','answer']);assert.ok(!(ops.id in s.team));assert.ok(!(ops.id in s.roleModels))
  await rejected(service.configure({team:{[ops.id]:''}}),'invalid-input')
  for(let i=0;i<18;i++) await service.configure({helper:{action:'add',name:'h'+i,description:'d'}})
  await rejected(service.configure({helper:{action:'add',name:'over',description:'d'}}),'invalid-input')
})

test('the Router assigns among the helpers enabled when the message was queued; a later change does not move queued work',async()=>{
  const ops={id:'helper-0a1b2c3d',name:'运维助手',description:'Server checks.'}
  const decided=[], worked=[]
  let saved
  const loop=createLoop({load:async()=>saved,save:async v=>{saved=structuredClone(v)},isReleaseRequired:()=>true,
    decide:j=>{decided.push(j.helpers);return {action:'work',role:ops.id}},
    work:j=>{worked.push([j.role,j.team[j.role],j.helpers]);return {answer:'Done.',sessionId:'s',workspaceId:'w'}},deliver:()=>{}})
  const job={caseId:'case_1',messageId:'om_in',text:'Check the server.',source,team:{lead:'',answer:'',[ops.id]:'ops',develop:''},
    roleModels:{[ops.id]:{provider:'p',model:'m'}},helpers:[builtinHelpers[1],ops]}
  await loop.enqueue(job);await loop.drain()
  const [row]=await loop.snapshot()
  assert.deepEqual(decided,[[builtinHelpers[1],ops]])
  assert.deepEqual(worked,[[ops.id,'ops',[builtinHelpers[1],ops]]])
  assert.deepEqual([row.status,row.role,row.presetId,row.roleName],['awaiting-release',ops.id,'ops','运维助手'])
  // A disabled built-in is not in the job's list: a decision for it is refused, not executed.
  saved=undefined
  const refused=createLoop({load:async()=>saved,save:async v=>{saved=structuredClone(v)},decide:()=>({action:'work',role:'develop'}),work:assert.fail,deliver:()=>{}})
  await refused.enqueue({...job,messageId:'om_other'});await refused.drain()
  assert.deepEqual((await refused.snapshot()).map(r=>[r.status,r.reason]),[['stopped','invalid-decision']])
  await assert.rejects(refused.enqueue({...job,messageId:'om_bad',helpers:[{...ops,name:''}]}),{code:'invalid-input'})
})

test('legacy jobs and settings without a helper list keep the built-in pair',async()=>{
  let saved={schema:1,jobs:[{caseId:'case_1',messageId:'om_in',text:'Old.',source,team:{lead:'',develop:'d',answer:''},roleModels:{},
    status:'assigned',attempt:0,updatedAt:1,role:'develop',presetId:'d'}]}
  const work=[]
  const loop=createLoop({load:async()=>saved,save:async v=>{saved=structuredClone(v)},decide:assert.fail,
    work:j=>{work.push([j.role,j.helpers]);return {answer:'Done.',sessionId:'s',workspaceId:'w'}},deliver:()=>{}})
  await loop.drain()
  assert.deepEqual(work,[['develop',undefined]])
  assert.equal((await loop.snapshot())[0].roleName,undefined)
  let disk={schema:1,team:{lead:'',develop:'',answer:''},roleModels:{},cases:[]}
  const service=createCases({load:async()=>structuredClone(disk),save:async v=>{disk=v},listPresets:async()=>[],executor:{}})
  assert.deepEqual(assignable((await service.teamSettings()).helpers),builtinHelpers)
  await service.configure({team:{lead:''}})
  assert.equal(disk.helpers,undefined,'an untouched helper list is not written')
})
