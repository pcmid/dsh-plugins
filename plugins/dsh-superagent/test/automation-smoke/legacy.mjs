import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,realpath} from 'node:fs/promises'
import {createLoop} from '../../host/loop.js'
import {openStore} from '../../host/store.js'
import {legacy,legacyPrompt} from './provider.mjs'

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const source={kind:'feishu',tenantId:'demo',recipientId:'ou_fixture',scopeId:'a'.repeat(64),chatId:'oc_legacy',threadId:'om_legacy_root'}
const job={caseId:'legacy-case',messageId:'om_legacy_request',requesterId:'ou_legacy',source,text:legacy.request,
  team:{lead:'',develop:'',answer:'superagent-answer'},roleModels:{answer:{provider:'offline',model:'worker'}}}
const sessionId='superagent-auto-'+hash([job.caseId,source.scopeId,source.tenantId,source.recipientId,source.chatId,source.threadId,job.messageId])
const questionId='om_legacy_question'

// Write an authentic native user/assistant JSON turn before the new actor is loaded. Generate the historical
// v2 receipt from what rc.3 actually recorded; do not rewrite the log or disable the new actor's proof checks.
async function oldWorker(ctx,path,j) {
  await mkdir(path,{recursive:true})
  const ws=await ctx.workspaceRegistry.create(await realpath(path),'SuperAgent')
  const preset=j.team.answer
  await ctx.sessionController.create({sessionId,workspaceId:ws.id,agentPreset:preset})
  const agent=ctx.agents.get(sessionId)
  agent.model.select(j.roleModels.answer)
  const r=await ctx.sessionController.prompt({sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:legacyPrompt}]},j.signal)
  assert.ok(r.accepted);await agent.whenIdle()
  const events=agent.session.ownEvents()
  assert.deepEqual(events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['completed'])
  assert.ok(!events.some(e=>e.type==='tool/call'))
  const entries=events.flatMap(e=>e.type==='user/message' && e.data.source.kind==='user'?[e.data]:e.type==='assistant/message'?[e.data.message]:[])
  assert.deepEqual(entries.map(m=>m.role),['user','assistant'])
  const {question}=JSON.parse(entries[1].content[0].text);assert.equal(question,legacy.question)
  const route=agent.model.current()
  let proof=hash(['native-v2',sessionId,ws.id,preset,'answer',j.text,j.requesterId,route.provider,route.model,route.reasoningEffort])
  for(const m of entries)proof=hash([proof,m.id,m.role,m.source.kind,m.source.rpcId,m.source.provider,m.source.model,m.content])
  return {question,sessionId,workspaceId:ws.id,resolvedPresetId:preset,workerProof:proof}
}

export async function legacyRound(ctx,path,actors) {
  const store=await openStore({open:spec=>ctx.storageDomain.open({...spec,name:'legacy_fixture_'+spec.name})})
  const loop=createLoop({...store.automationStore,decide:async()=>{assert.ok(!actors);return {action:'work',role:'answer'}},
    work:actors?.work ?? (j=>oldWorker(ctx,path,j)),deliver:async j=>{
      assert.ok(!actors);assert.equal(j.text,legacy.question)
      return {chatId:source.chatId,inReplyTo:job.messageId,messageId:questionId}
    }})
  try {
    if(!actors) {
      await loop.enqueue(job);await loop.drain()
      const [row]=await loop.snapshot()
      assert.deepEqual([row.status,row.answer,row.outputKind],['awaiting-release',legacy.question,'question'])
      await loop.release({caseId:job.caseId,messageId:job.messageId,token:row.releaseToken,action:'send'},()=>true)
      await loop.drain()
      assert.equal((await loop.snapshot())[0].status,'waiting-requester')
    } else {
      const [old]=await loop.waitingQuestions(source)
      assert.equal(old.questionId,questionId)
      assert.equal((await ctx.sessionPersistence.stat(sessionId))?.header.id,sessionId)
      assert.ok(await loop.resumeQuestion(old,{...source,messageId:'om_legacy_reply',senderId:job.requesterId,parentId:old.questionId,at:Date.now(),text:legacy.reply}))
      await loop.drain()
      const [row]=await loop.snapshot()
      assert.deepEqual([row.status,row.sessionId,row.outputKind,row.answer],['awaiting-release',sessionId,'answer','Confirmed: '+legacy.reply])
      assert.ok(row.releaseToken && !row.receipt)
      console.log('PASS migration: the cold native worker resumed its recorded legacy JSON question and submitted the final answer with a result tool; independent release still required.')
    }
  } finally {await loop.dispose();await store.close()}
}
