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
  const follow={...job,caseId:'legacy-follow',messageId:'om_legacy_reply',text:legacy.reply}
  const loop=createLoop({...store.automationStore,caseInfo:()=>job,decide:b=>{
    if(!actors){assert.equal(b.messageId,job.messageId);return {action:'work',role:'answer'}}
    assert.equal(b.messageId,follow.messageId)
    assert.deepEqual(b.openWork,[{ref:'w1',request:job.text,state:'waiting for the requester',output:legacy.question}])
    return {action:'merge',target:'w1'}
  },
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
      const [old]=await loop.snapshot()
      assert.deepEqual([old.status,old.receipt.messageId],['waiting-requester',questionId])
      assert.equal((await ctx.sessionPersistence.stat(sessionId))?.header.id,sessionId)
      await loop.enqueue(follow)
      await loop.drain()
      const [row,merged]=await loop.snapshot()
      assert.deepEqual([merged.status,merged.mergedInto],['merged',{caseId:job.caseId,messageId:job.messageId}])
      assert.deepEqual([row.status,row.sessionId,row.outputKind,row.answer],['awaiting-release',sessionId,'answer','Confirmed: '+legacy.reply])
      assert.ok(row.releaseToken && !row.receipt)
      console.log('PASS migration: a merged mention continued the cold native worker with its recorded legacy JSON question; the final answer still requires its own release.')
    }
  } finally {await loop.dispose();await store.close()}
}
