import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source=(await Promise.all(['roles','edition','work-steps'].map(name=>readFile(new URL('../src/'+name+'.js',import.meta.url),'utf8')))).join('\n')
const steps=new Function(source+';return spaceWorkSteps')()
const en=(zh,english)=>english, zh=chinese=>chinese
const projected=(status,run,tr=en)=>steps({kind:'feishu',status,run:{status,...run}},tr)
const stages=rows=>rows.map(row=>row.stage)
const assigned=['Accepted for work','Assigned to Developer'],worked='Work completed'
const afterDecision={role:'develop',criteria:'Two examples',presetId:'dev-fixed'}
const approved={...afterDecision,answer:'public answer',attempt:1,sessionId:'internal-session-id'}
const receipt={messageId:'om_actual',inReplyTo:'om_initial',chatId:'oc_fixture'}

test('projects only the known progress of the current request from the last Host state, with no review step',()=>{
  const table=[
    ['queued',{attempt:0},['Awaiting assessment']],
    ['deciding',{attempt:0},['Assessing the request']],
    ['ignored',{attempt:0},['No action needed']],
    ['assigned',{...afterDecision,attempt:0},assigned],
    ['working',{...afterDecision,attempt:1},[...assigned,'Working']],
    ['approved',approved,[...assigned,worked]],
    ['awaiting-release',approved,[...assigned,worked,'Awaiting your confirmation to send the final reply']],
    ['declined',approved,[...assigned,worked,'Chose not to send']],
    ['delivering',approved,[...assigned,worked,'Replying to the original message']],
    ['delivered',{...approved,receipt},[...assigned,worked,'Reply delivered']],
    ['delivered',approved,[...assigned,worked,'Delivery unconfirmed']],
    ['stopped',{...approved,reason:'delivery-denied'},[...assigned,worked,'Stopped without sending a reply']],
    ['uncertain',{...approved,reason:'delivery-uncertain'},[...assigned,worked,'Delivery unconfirmed']],
    ['unknown-future-status',afterDecision,[...assigned,'Work status unconfirmed']],
    ['stopped',{attempt:0,reason:'decision-failed'},['Processing stopped']],
    ['stopped',{...afterDecision,attempt:1,reason:'no-final-answer'},[...assigned,'Processing stopped']],
    ['uncertain',{...afterDecision,attempt:1,reason:'work-uncertain'},[...assigned,'Work outcome unconfirmed']],
  ]
  for(const [status,run,expected] of table)assert.deepEqual(stages(projected(status,run)),expected,status)
  for(const row of table.flatMap(([status,run])=>projected(status,run)))assert.notEqual(row.kind,'review')
})

test('worker questions require an independent release and a real receipt before waiting for the original requester',()=>{
  const q={...approved,outputKind:'question'}
  const before=[...assigned,'Clarifying question prepared']
  assert.deepEqual(stages(projected('awaiting-release',q)),[...before,'Awaiting your confirmation to send the question'])
  assert.deepEqual(stages(projected('declined',q)),[...before,'Chose not to send'])
  assert.deepEqual(stages(projected('waiting-requester',{...q,receipt})),[...before,'Question sent; waiting for the original requester'])
  assert.deepEqual(stages(projected('waiting-requester',q)),[...before,'Delivery unconfirmed'])
  assert.deepEqual(stages(projected('approved',q)),before)
  assert.deepEqual(stages(projected('working',{...afterDecision,attempt:1,sessionId:'previous-question'})),[...assigned,'Working'])
})

test('records from the removed review stage show only their stop reason',()=>{
  assert.equal(projected('stopped',{reason:'rework-limit',attempt:2,...afterDecision},zh).at(-1).detail,'返工后仍未通过验收')
  assert.equal(projected('stopped',{reason:'interrupted',attempt:1,...afterDecision},zh).at(-1).detail,'办理中断')
})

test('a taken-over message ends with the owner taking over, without a reply or delivery step',()=>{
  assert.deepEqual(stages(projected('taken-over',{...afterDecision,attempt:1,sessionId:'s'})),[...assigned,'Taken over; SuperAgent no longer works on or posts it'])
})

test('the assignment names the DSH workspace the Router chose',()=>{
  const step=projected('working',{...afterDecision,attempt:1,targetWorkspaceId:'ws-1',targetWorkspaceTitle:'dsh-plugins'},zh)[1]
  assert.equal(step.detail,'指定预设：dev-fixed；工作区：dsh-plugins')
  assert.equal(projected('working',{...afterDecision,attempt:1},zh)[1].detail,'指定预设：dev-fixed')
})

test('historical statuses describe handoff only; no synthetic decisions, final results or deliveries',()=>{
  for(const [kind,status,label] of [
    ['feishu','received','Message received'],
    ['local','dispatching','Submitting to DSH'],
    ['local','submitted','Submitted to DSH'],
    ['local','failed','Submission failed'],
    ['local','uncertain','Handoff to DSH unconfirmed'],
    ['local','unknown','Work status unknown'],
  ]){
    const rows=steps({kind,status,text:'old input',sessionId:'linked',attempt:2},en)
    assert.deepEqual(stages(rows),[label])
    assert.ok(!['worker','review','delivery'].includes(rows[0].kind))
  }
})

test('localized steps keep only display evidence, not raw Host or provider fields, timestamps or duplicate content',()=>{
  const run={...approved,receipt,attempt:2,role:'answer',feedback:'rejected draft',system:'private instructions',
    updatedAt:1111,resolvedPresetId:'actual-worker-id',history:[{time:2222}]}
  const rows=projected('delivered',run,zh)
  assert.deepEqual(rows.slice(0,2),[
    {who:'Router',stage:'决定办理',kind:'decision'},
    {who:'Router',stage:'指派给答疑助手',kind:'assignment',detail:'指定预设：dev-fixed'},
  ])
  assert.deepEqual(rows.slice(2).map(s=>s.who),['DSH','飞书'])
  assert.deepEqual(rows.slice(2).map(s=>s.kind),['worker','delivery'])
  assert.doesNotMatch(JSON.stringify(rows),/public answer|om_actual|rejected draft|private instructions|internal-session-id|actual-worker-id|1111|2222/)
  assert.deepEqual(projected('stopped',{reason:'unknown raw diagnostic'},zh),[{kind:'stop',who:'SuperAgent',stage:'已停止办理'}])
})

test('a merged message names the request it joined; that request shows the follow-ups waiting for its worker',()=>{
  assert.deepEqual(projected('merged',{attempt:0,mergedInto:{caseId:'c',messageId:'om_a'},mergedTitle:'原请求'},zh),
    [{kind:'merge',who:'Router',stage:'判断为已有事项的补充，已并入',detail:'并入：原请求'}])
  const rows=projected('assigned',{...afterDecision,attempt:0,supplements:[{messageId:'om_b',text:'补充'}]},zh)
  assert.equal(rows.at(-1).stage,'并入 1 条补充消息，助手将据此继续')
})
