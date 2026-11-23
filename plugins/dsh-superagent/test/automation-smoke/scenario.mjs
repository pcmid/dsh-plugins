import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkPlacement,fixtureProject } from './placement.mjs'
import { issued,toolCwds,workerPreset,workerTool } from './worker-tool.mjs'
import { createActors } from '../../host/actors.js'
import { makeApp } from '../../host/app.js'
import { openStore } from '../../host/store.js'
import { archiveDuringWork,checkColdArchive,checkSeatArchives } from './archival.mjs'
import { legacyRound } from './legacy.mjs'
import { coldTakeover,exerciseTakeover,finishedTakeover } from './takeover.mjs'
import { failBeforeExit,retryAfterRestart } from './retries.mjs'
import { mergeAfterRestart,mergeBeforeExit } from './merge.mjs'
import { ignoreAfterRestart,ignoreBeforeExit } from './ignore.mjs'
import { memberAfterRestart,memberBeforeExit } from './member.mjs'
import { imagesRound } from './images.mjs'
import { chatId,clarificationId,declineId,fakeFeishu,firstId,followupId,foreignMessageId,messageId,otherDM,peerSelfId,privateMessageId,questionId,receiptId,root,selfChatId,selfMessageId,selfReceiptId,source } from './feishu.mjs'
import { answer,clarification,forbiddenAnswer,ignored,ownerAsk,probes,resultNames,mergeTool,softStops,sealId,sealRE,supersededQuestion,supersededAnswer,declinedQuestion,noteAnswer,noteRequest,privateRequest,question,request,rootText,sibling,unselected } from './provider.mjs'

const decision=(j,action)=>({caseId:j.caseId,messageId:j.messageId,token:j.releaseToken,action})
const job=(snapshot,id)=>snapshot.automation.find(j=>j.messageId===id)
const activity=(snapshot,id)=>snapshot.mentions.find(m=>m.messageId===id)
// The cases of one Feishu topic, each as its messages in order.
const topic=(snapshot,chat,thread)=>snapshot.cases.filter(c=>c.source.kind==='feishu' && c.source.chatId===chat && c.source.threadId===thread)
  .map(c=>c.messages.map(m=>[m.requestId,m.text]))
const act=(app,row,action)=>app.groupAccess({action,scopeId:row.scopeId,chatId:row.chatId,threadId:row.threadId,messageId:row.messageId})
async function poll(app) {await app.pollOnce();await app.drain();return app.snapshot()}

async function attention(app,needed) {
  const result=await app.attention()
  assert.equal(result.needed,needed)
  assert.ok(Number.isSafeInteger(result.revision) && result.revision>=0)
  return result.revision
}

// This isolated answerer is present only while the test's local operator is at the console.
// Merely submitting/approving a Feishu task never answers a native tool request.
async function localDecision(ctx,provider,expected,launch,whileWaiting) {
  assert.ok(ctx.get('approval'))
  const offered=Promise.withResolvers(),answered=Promise.withResolvers()
  const count=issued.length
  let claimed=false
  const off=ctx.on('approval/request',(req,next)=>{
    if(claimed || req.toolName!==workerTool || req.callId!==expected.callId || req.agent.id!==provider.proposed.get(expected.callId))return next()
    claimed=true
    offered.resolve(req)
    return answered.promise
  })
  const work=launch()
  try {
    const req=await Promise.race([offered.promise,work.then(()=>{assert.ifError(provider.error);assert.fail('operation finished without native approval')})])
    assert.equal(req.agent.session.id,provider.proposed.get(expected.callId))
    assert.equal(req.agent.session.header.agentPreset,workerPreset)
    assert.equal(req.toolName,workerTool)
    const call=req.agent.session.ownEvents().find(e=>e.type==='tool/call' && e.data.callId===expected.callId)
    assert.deepEqual([call?.data.name,JSON.parse(call?.data.arguments)],[workerTool,{label:expected.label}])
    assert.equal(issued.length,count,'pending native approval must precede execution')
    await whileWaiting()
    answered.resolve(expected.outcome)
    return await work
  } finally {answered.resolve('rejected');off()}
}

function checkApproval(events,callId,outcome) {
  const asks=events.filter(e=>e.type==='approval/asked' && e.data.toolName===workerTool && e.data.callId===callId)
  assert.equal(asks.length,1,'one native approval request for this exact call')
  const decisions=events.filter(e=>e.type==='approval/decided' && e.data.id===asks[0].data.id)
  assert.deepEqual(decisions.map(e=>e.data.outcome),[outcome])
}

async function checkSession(ctx,id,role,outputs) {
  await ctx.sessionPersistence.flush()
  const log=await ctx.sessionPersistence.open(id,'read')
  try {
    assert.equal(log.header.agentPreset,role==='develop'?workerPreset:'superagent-'+role)
    const {events}=await log.read()
    assert.deepEqual(events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),outputs.map(()=>'completed'))
    if(role==='develop' && outputs[0]!==undefined) {
      const expected={id:sealId,name:workerTool,arguments:JSON.stringify({label:'original selected request'})}
      const block=events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message.content).find(b=>b.type==='tool-call')
      assert.deepEqual([block?.id,block?.name,block?.arguments],Object.values(expected))
      const call=events.find(e=>e.type==='tool/call')
      assert.deepEqual([call?.data.callId,call?.data.name,call?.data.arguments],Object.values(expected))
      assert.ok(!events.some(e=>e.type==='approval/asked'),'default-allow tool should not create any approval events')
      const steps=events.filter(e=>e.type==='assistant/message').map(e=>e.data.message.content.filter(b=>b.type==='tool-call'))
      const batch=steps.find(bs=>bs.some(b=>b.id==='fixture-after-submit'))
      assert.deepEqual(batch?.map(b=>b.name),['superagent_ask_requester','superagent_ask_requester',workerTool])
      const late=events.filter(e=>e.type==='tool/result' && e.data.message.toolCallId==='fixture-after-submit')
      assert.equal(late.length,1);assert.ok(!late[0].data.message.isError)
      assert.match(late[0].data.message.content[0].text,sealRE,'the ordinary tail tool ran under the native allow policy')
      assert.equal(events.filter(e=>e.type==='tool/result' && JSON.stringify(e.data).includes('SEAL:')).length,2,
        'both ordinary developer calls are retained, not re-executed after restart')
    } else assert.ok(!events.some(e=>e.type==='tool/call' && ![...resultNames.DECIDE,mergeTool].includes(e.data.name)))
    const names=role==='lead'?[...resultNames.DECIDE,mergeTool]:resultNames.WORK
    const calls=events.filter(e=>e.type==='tool/call' && names.includes(e.data.name)).map(e=>e.data)
    const submitted=role==='develop'?outputs.flatMap((text,i)=>[i?supersededAnswer:supersededQuestion,text]):outputs
    assert.equal(calls.length,submitted.length)
    for(const c of calls) {
      const receipts=events.filter(e=>e.type==='tool/result' && e.data.message.toolCallId===c.callId)
      assert.ok(receipts.length===1 && !receipts[0].data.message.isError)
    }
    if(outputs[0]!==undefined)assert.deepEqual(calls.map(c=>{
      const data=JSON.parse(c.arguments)
      return data.answer ?? data.question
    }),submitted)
  } finally {await log.close()}
}
async function checkControlTurns(ctx,provider) {
  assert.equal(new Set(provider.controls.map(c=>c.id)).size,provider.controls.length)
  for(const {id,role} of provider.controls) {
    assert.ok(!provider.workSessions.includes(id))
    await checkSession(ctx,id,role,[undefined])
  }
}

async function prepare(ctx,app,provider,transport) {
  const settings=await app.settingsSnapshot()
  assert.equal(settings.releaseRequired,true)
  assert.equal(settings.source.settings.allowPrivateChats,false)
  await app.configure({team:{lead:'superagent-lead',develop:workerPreset,answer:'superagent-answer'},roleModels:{
    lead:{provider:'offline',model:'director'},develop:{provider:'offline',model:'worker'},answer:{provider:'offline',model:'worker'},
  }})
  const historicalAt=Date.now()
  await delay(5)
  await app.pollOnce() // Establish the discovery baseline before publishing anything.
  assert.deepEqual((await app.settingsSnapshot()).source.groups,[])
  await attention(app,false)
  await delay(5)
  transport.indexHistorical(historicalAt)
  transport.indexStaleHit()
  transport.publishHistory()
  const firstAt=transport.publishFirst()
  await app.start()
  let pending
  for(let i=0;i<100;i++) {
    pending=await app.snapshot()
    if((pending.mentions?.length && pending.source.groups.length) || transport.error)break
    await delay(15)
  }
  assert.ifError(transport.error)
  assert.deepEqual(pending.source.groups.map(({chatId,threadId,mode})=>({chatId,threadId,mode})),[{chatId,threadId:root,mode:'pending'}])
  assert.deepEqual([...pending.mentions].sort((a,b)=>a.at-b.at).map(m=>[m.messageId,m.at,m.text,m.canApprove,m.name]),
    [[firstId,firstAt,unselected,true,'Fixture group']])
  assert.deepEqual(pending.cases,[]);assert.deepEqual(pending.automation,[]);assert.deepEqual(provider.calls,[])
  await attention(app,true) // The first unapproved mention alone is actionable.
  assert.deepEqual([...new Set(transport.exactReads)],[firstId])
  await app.pollOnce()
  assert.deepEqual(transport.historyReads,[]);assert.deepEqual(transport.posts,[])
  // The owner’s next structured self-mention, not the earlier peer mention, starts without groupAccess.
  const chosenAt=transport.publishRequest()
  await delay(5)
  transport.publishLaterReply()
  const requests=[]
  const stop=ctx.on('approval/request',(req,next)=>{requests.push(req.callId);return next()})
  let state
  try {state=await poll(app)} finally {stop()}
  assert.deepEqual(requests,[],'the preset’s default-allow fixture tool must not request an approval')
  assert.ifError(provider.error);assert.ifError(transport.error)
  assert.equal(activity(state,messageId)?.at,chosenAt)
  assert.equal(activity(state,messageId)?.canApprove,false)
  assert.equal(activity(state,firstId)?.caseId,undefined,'an earlier pending mention is not the owner’s request')
  assert.equal(job(state,firstId),undefined)
  assert.deepEqual(state.cases.map(c=>c.messages[0].requestId),[messageId])
  const granted=state.source.groups.find(g=>g.chatId===chatId && g.threadId===root)
  assert.deepEqual([granted?.mode,granted?.mentionAt],['once',chosenAt],'the exact owner trigger receives an ordinary once grant')
  const first=job(state,messageId)
  transport.editRequest() // Cold continuation must still use the admitted original version.
  assert.equal(first?.status,'awaiting-release',JSON.stringify(first))
  assert.equal(issued.length,2);assert.notEqual(issued[1],issued[0]);assert.ok(issued.every(s=>sealRE.test(s)))
  assert.deepEqual([first.outputKind,first.answer,first.role,first.resolvedPresetId],['question',question+' '+issued[0],'develop',workerPreset])
  assert.ok(first.releaseToken && !first.receipt)
  assert.deepEqual(provider.calls,['DECIDE','WORK'])
  assert.deepEqual(provider.workSessions,[first.sessionId])
  await checkPlacement(ctx,first,provider.project)
  assert.equal(toolCwds.get(sealId),provider.project.path,'the native executor ran the fixture tool in the chosen project')
  assert.ok(transport.historyReads.some(p=>p.container_id==='omt_root' && p.page_token),'full thread traverses multiple server pages')
  await checkSession(ctx,first.sessionId,'develop',[first.answer])
  transport.publishFollowup()
  await poll(app)
  transport.publishToDecline()
  const otherThread=await poll(app), proposal=activity(otherThread,declineId)
  assert.equal(job(otherThread,declineId),undefined,'automatic owner admission never grants the entire group')
  assert.ok(proposal?.canApprove)
  await act(app,proposal,'once')
  const ready=await poll(app)
  assert.ifError(provider.error)
  const second=job(ready,declineId)
  assert.equal(job(ready,followupId)?.status,'ignored')
  // One topic is one case: the later @ joined the request's case and went to the Router without new-work routing.
  assert.equal(job(ready,followupId).caseId,first.caseId,'a later @ in the topic joins its case')
  assert.deepEqual(topic(ready,chatId,root),[[[messageId,request],[followupId,ignored]]],'one case for the topic, messages appended in order')
  assert.deepEqual([second?.status,second?.outputKind,second?.answer],['awaiting-release','question',declinedQuestion])
  assert.ok(second.releaseToken && second.releaseToken!==first.releaseToken)
  assert.deepEqual(provider.calls,['DECIDE','WORK','DECIDE','DECIDE','WORK'])
  await checkControlTurns(ctx,provider)
  await checkPlacement(ctx,second) // No project selected for this request.
  // The owner sees the brought-in thread in case materials; another topic never appears.
  assert.ok(JSON.stringify(ready.cases).includes(rootText),'brought-in thread context is shown in case materials')
  assert.ok(!JSON.stringify(ready).includes(sibling),'other topics are absent from browser snapshots')
  await app.setReleasePolicy({required:false})
  await app.drain()
  assert.deepEqual((await app.snapshot()).automation,ready.automation,'old waiting questions never auto-release')
  assert.deepEqual(transport.posts,[])
  assert.deepEqual(transport.privateSearches,[])
  console.log('PASS native allow: each ordinary call ran once, including the tail call after two submitted questions; no approval event or outgoing post.')
  return ready
}

async function confirmQuestions(app,provider,transport,saved) {
  const before=await app.snapshot()
  for(const k of ['automation','cases','mentions'])assert.deepEqual(before[k],saved[k],k+' survived a cold Desktop exit')
  assert.equal((await app.settingsSnapshot()).releaseRequired,false)
  await app.setReleasePolicy({required:true})
  const replay=await poll(app)
  assert.deepEqual(replay.automation,saved.automation)
  assert.deepEqual(provider.calls,[]);assert.deepEqual(transport.posts,[])
  const send=decision(job(replay,messageId),'send'),decline=decision(job(replay,declineId),'decline')
  await app.releaseOutput(decline)
  await assert.rejects(app.releaseOutput({...decline,action:'send'}))
  assert.deepEqual(transport.posts,[])
  await app.releaseOutput(send)
  await assert.rejects(app.releaseOutput(send))
  await app.drain()
  const waiting=await app.snapshot()
  assert.equal(job(waiting,declineId).status,'declined')
  assert.equal(job(waiting,messageId).status,'waiting-requester')
  assert.deepEqual(transport.posts.map(p=>[p.anchor,p.id,p.text]),[[messageId,questionId,job(saved,messageId).answer]])
  assert.deepEqual(provider.calls,[])
  return waiting
}

async function resumeWork(ctx,app,provider,transport,waiting,saved) {
  assert.deepEqual((await app.snapshot()).automation,waiting.automation,'waiting-requester survives reopening native storage')
  const reads=transport.historyReads.length
  assert.equal(job(await poll(app),messageId).status,'waiting-requester')
  transport.publishWrongReplies()
  assert.equal(job(await poll(app),messageId).status,'waiting-requester')
  assert.equal(transport.historyReads.length,reads,'waiting alone does not poll a question’s replies')
  assert.deepEqual(provider.calls,[],'ordinary replies in the group do not wake the worker')
  provider.firstDraft=job(waiting,messageId).answer
  transport.publishClarification()
  const ready=await poll(app)
  assert.ifError(provider.error);assert.ifError(transport.error)
  const first=job(saved,messageId),final=job(ready,messageId),seal=first.answer.slice(question.length+1)
  assert.match(seal,sealRE)
  assert.deepEqual(issued,[],'the new OS process reuses the actual prior tool result without executing it again')
  const finalText=answer+' '+seal
  const merged=job(ready,clarificationId)
  assert.equal(merged?.caseId,first.caseId,'the reply joined the topic’s case')
  assert.deepEqual(topic(ready,chatId,root),[[[messageId,request],[followupId,ignored],[clarificationId,clarification]]],'still one case after the cold restart')
  assert.deepEqual([merged?.status,merged?.mergedInto],['merged',{caseId:first.caseId,messageId}])
  assert.equal(ready.automation.length,saved.automation.length+1,'the mention has its own Router decision, not its own worker')
  assert.ok(merged.routerSessionId && !merged.workerSessionId)
  assert.deepEqual([final?.status,final?.outputKind,final?.answer,final?.caseId,final?.sessionId],
    ['awaiting-release','answer',finalText,first.caseId,first.sessionId],JSON.stringify(final))
  assert.ok(final.releaseToken && final.releaseToken!==first.releaseToken)
  assert.deepEqual(provider.calls,['DECIDE','WORK'],'one decision merges the mention into the original worker')
  assert.deepEqual(provider.workSessions,[first.sessionId])
  await checkSession(ctx,first.sessionId,'develop',[first.answer,finalText])
  await checkPlacement(ctx,final,provider.project)
  console.log('PASS placement: Router stayed in SuperAgent; scoped worker and tool used the selected project, unplaced work stayed in SuperAgent. Invalid workspace received a native tool error and was corrected. Native project ownership survived takeover and cold continuation.')
  await checkControlTurns(ctx,provider)
  assert.deepEqual(transport.posts.map(p=>p.id),[questionId],'no final output rides on the question approval')
  await assert.rejects(app.releaseOutput(decision(first,'send')))
  await app.releaseOutput(decision(final,'send'))
  await app.drain()
  const delivered=await poll(app)
  assert.deepEqual(job(delivered,messageId).receipt,{chatId,inReplyTo:messageId,messageId:receiptId})
  assert.deepEqual(transport.posts.map(p=>[p.anchor,p.id,p.text]),[[messageId,questionId,first.answer],[messageId,receiptId,finalText]])
  return delivered
}

async function replayAndDM(ctx,app,provider,transport,delivered,retry) {
  const searches=transport.searches.length
  transport.replayReceipt()
  const replay=await poll(app)
  assert.ok(transport.searches.slice(searches).some(ids=>ids.includes(receiptId)))
  assert.equal(replay.source.state,'ready')
  for(const k of ['cases','mentions','automation'])assert.deepEqual(replay[k],delivered[k])
  await attention(app,true)
  await retryAfterRestart(ctx,app,provider,transport,retry)
  await attention(app,false) // Both live failures were retried, and their outputs declined.
  const calls=provider.calls.length

  // Same real worker across the restart, now under the owner's control. Its native ask is not SuperAgent work.
  const sessionId=provider.manualSession
  assert.ok(replay.automation.some(r=>r.status==='taken-over' && r.workerSessionId===sessionId))
  await localDecision(ctx,provider,ownerAsk,async()=>{
    const r=await ctx.sessionController.prompt({sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:ownerAsk.prompt}]},AbortSignal.timeout(5000))
    assert.ok(r.accepted);await ctx.agents.get(sessionId).whenIdle()
  },()=>attention(app,false))
  assert.ifError(provider.error);assert.ok(provider.ownerAskSettled)
  checkApproval(ctx.agents.get(sessionId).session.ownEvents(),ownerAsk.callId,'rejected')
  await attention(app,false)
  transport.publishSelf()
  const inbox=await poll(app)
  const self=activity(inbox,selfMessageId)
  assert.equal(self?.canApprove,false)
  assert.deepEqual([self.chatId,self.threadId,self.text],[selfChatId,selfMessageId,noteRequest])
  assert.equal(inbox.source.groups.find(g=>g.chatId===selfChatId && g.threadId===selfMessageId)?.mode,'once')
  assert.ok(!activity(inbox,'om_plain_self') && !job(inbox,'om_plain_self'),'owner notes without structured mentions are not tasks')
  assert.ok(transport.searches.some(h=>h.includes(foreignMessageId) && h.includes(selfMessageId)))
  assert.deepEqual(transport.privateSearches,[]);assert.deepEqual(transport.reverseProofs,[])
  for(const id of ['om_dm_before',foreignMessageId]){
    assert.ok(!transport.mgets.includes(id) && !transport.exactReads.includes(id) && !activity(inbox,id))
  }
  assert.deepEqual(provider.calls.slice(calls),['DECIDE','WORK'])
  const selfJob=job(inbox,selfMessageId)
  assert.deepEqual([selfJob?.status,selfJob?.answer],['awaiting-release',noteAnswer])
  assert.deepEqual(transport.posts.map(p=>p.id),[questionId,receiptId],'the self-chat shortcut cannot send its answer')
  await attention(app,true)
  await app.archiveCase({caseId:selfJob.caseId})
  checkSeatArchives(ctx,selfJob,true)
  await attention(app,true) // Still actionable: archiving does not dispose of a pending send.
  await app.releaseOutput(decision(selfJob,'send'))
  await app.drain()
  assert.deepEqual(job(await app.snapshot(),selfMessageId).receipt,{chatId:selfChatId,inReplyTo:selfMessageId,messageId:selfReceiptId})

  const {version}= (await app.settingsSnapshot()).source.settings
  await attention(app,false)
  const enabled=await app.setPrivateChats({version,allowPrivateChats:true})
  assert.equal(enabled.allowPrivateChats,true);assert.equal(enabled.privateChatsSince,undefined,'the authorization epoch is Host-private')
  await poll(app)
  await delay(5)
  transport.publishPeerSelf() // First event in this authorized P2P generation; not an inbound message from the peer.
  const beforePeer=transport.posts.length
  const outbound=await poll(app),ownerJob=job(outbound,peerSelfId)
  assert.ok(transport.reverseProofs.includes(otherDM),'the owner is not the peer: resolve and prove the actual other party')
  assert.deepEqual([ownerJob?.status,ownerJob?.answer,activity(outbound,peerSelfId)?.canApprove],['awaiting-release',noteAnswer,false])
  assert.equal(outbound.source.groups.find(g=>g.chatId===otherDM && g.threadId===peerSelfId)?.mode,'once')
  assert.ok(!activity(outbound,'om_outbound_plain') && !job(outbound,'om_outbound_plain'))
  assert.equal(transport.posts.length,beforePeer)
  transport.publishPrivate()
  const count=provider.calls.length, postCount=transport.posts.length
  const pending=await poll(app)
  assert.ok(transport.privateSearches.some(ids=>ids.includes(privateMessageId)),'actually discovered a peer DM without an @')
  const dm=activity(pending,privateMessageId)
  assert.ok(dm?.canApprove)
  assert.deepEqual([dm.chatId,dm.text],[otherDM,privateRequest])
  assert.ok(!activity(pending,'om_dm_before') && !activity(pending,foreignMessageId),'no backfill and no arbitrary outgoing DM')
  assert.ok(!job(pending,privateMessageId));assert.equal(provider.calls.length,count)
  assert.equal(transport.posts.length,postCount)
  await app.releaseOutput(decision(ownerJob,'send'))
  await app.drain()
  assert.deepEqual(job(await app.snapshot(),peerSelfId).receipt,{chatId:otherDM,inReplyTo:peerSelfId,messageId:'om_peer_self_receipt'})
  await app.configure({team:{lead:''}}) // Empty Router binding must also use a real native Session with the default preset.
  await act(app,dm,'once')
  const dmJob=job(await poll(app),privateMessageId)
  assert.deepEqual([dmJob?.status,dmJob?.outputKind,dmJob?.answer],['awaiting-release','answer',noteAnswer])
  assert.equal(transport.posts.length,postCount+1,'only the separately approved self-mention output was sent')
  await app.releaseOutput(decision(dmJob,'send'))
  await app.drain()
  assert.deepEqual(job(await app.snapshot(),privateMessageId).receipt,{chatId:otherDM,inReplyTo:privateMessageId,messageId:'om_private_receipt'})

  // The answer seat asks for the developer-only tool anyway. A model naming a tool cannot grant access.
  // It then tries the removed stop result, which is an unknown tool, and must answer instead.
  const before=transport.posts.length
  transport.publishProbe()
  const denied=await poll(app),probe=activity(denied,'om_missing_tool')
  assert.ok(probe?.canApprove && !job(denied,'om_missing_tool'))
  await attention(app,true) // This mention is still waiting for admission; there is no job yet.
  await act(app,probe,'once')
  const refused=job(await poll(app),'om_missing_tool')
  assert.ok(provider.proposed.has('forbidden-attempt'))
  assert.deepEqual([refused?.status,refused?.outputKind,refused?.answer],['awaiting-release','answer',forbiddenAnswer],JSON.stringify(refused))
  assert.equal(provider.stopRefused,refused.workerSessionId)
  assert.ok(refused.releaseToken && !refused.receipt)
  assert.deepEqual(issued,[],'a different preset cannot execute this tool')
  assert.equal(transport.posts.length,before)
  await ctx.sessionPersistence.flush()
  const stopLog=await ctx.sessionPersistence.open(refused.workerSessionId,'read')
  try {
    const {events}=await stopLog.read()
    assert.deepEqual(events.filter(e=>e.type==='tool/result').map(e=>[e.data.message.toolCallId,!!e.data.message.isError]),
      [['forbidden-attempt',true],['fixture-stop-attempt',true],[events.findLast(e=>e.type==='tool/call').data.callId,false]])
    assert.deepEqual(events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['completed'])
  } finally {await stopLog.close()}
  await attention(app,true)
  await app.releaseOutput(decision(refused,'decline'))
  await attention(app,false)
  for(const p of probes) {
    transport.publishProbe(p.id,p.request)
    const awaiting=await poll(app),entry=activity(awaiting,p.id)
    assert.ok(entry?.canApprove && !job(awaiting,p.id))
    const run=async()=>{await act(app,entry,'once');return poll(app)}
    const count=issued.length,ok=p.outcome==='allowed-once'
    const readings=[],observe=async expected=>readings.push([expected,await attention(app,expected)])
    provider.observeToolStep=()=>observe(false)
    const waits=ok || p.outcome==='rejected'
    const end=waits?await localDecision(ctx,provider,p,run,()=>observe(true)):await run()
    assert.deepEqual(readings.map(r=>r[0]),waits?[false,true,false]:[false,false])
    if(waits)assert.ok(readings[0][1]<readings[1][1] && readings[1][1]<readings[2][1],'both edges invalidate the attention view')
    assert.ifError(provider.error)
    const row=job(end,p.id),answer=ok?'The fixture returned '+issued[count]:'No seal was issued.'
    assert.equal(issued.length,count+Number(ok),'only a granted native ask runs this fixture body')
    assert.equal(provider.probeAnswers.get(p.callId),answer,'the worker continued after the native tool outcome')
    assert.deepEqual([row?.status,row?.answer],['awaiting-release',answer])
    assert.ok(row.releaseToken && !row.receipt)
    await attention(app,true)
    await app.releaseOutput(decision(row,'decline'))
    await attention(app,false)
    assert.equal(transport.posts.length,before)
    await ctx.sessionPersistence.flush()
    const log=await ctx.sessionPersistence.open(provider.proposed.get(p.callId),'read')
    try {
      const {events}=await log.read()
      if(p.outcome==='deny')assert.ok(!events.some(e=>e.type==='approval/asked'))
      else checkApproval(events,p.callId,p.outcome)
      const found=events.filter(e=>e.type==='tool/result' && e.data.message.toolCallId===p.callId)
      assert.equal(found.length,1)
      assert.equal(!!found[0].data.message.isError,!ok)
      if(p.outcome==='rejected' || p.outcome==='unavailable')assert.equal(found[0].data.error.code,'APPROVAL_'+p.outcome.toUpperCase())
    } finally {await log.close()}
  }
  console.log('PASS attention: automatic native asks toggled false/true/false around both allowed-once and rejected; a taken-over worker’s native ask stayed false. Pending admission, sends and active failures raised attention; archived failures did not, archived pending sends still did.')
  console.log('PASS native policies: ask/allowed-once ran once; ask/rejected, ask/unavailable and deny returned native errors and the worker continued without executing the tool. Unconfigured answer seat could not execute it; its superagent_stop call got an unknown-tool error and it answered instead. No probe sent a message.')
}

async function checkSoftStops(ctx,app,provider,transport) {
  const posts=transport.posts.length
  for(const s of softStops) {
    const start=provider.calls.length
    transport.publishGranted(s.id,s.request)
    const row=job(await poll(app),s.id)
    assert.ifError(provider.error)
    assert.deepEqual(provider.calls.slice(start),['DECIDE',...(s.routerDraft?['CONTINUE']:[]),'WORK','CONTINUE'])
    assert.deepEqual([row?.status,row?.outputKind,row?.answer],['awaiting-release','answer',s.answer])
    assert.ok(row.releaseToken && !row.receipt)
    assert.equal(transport.posts.length,posts)
    await ctx.sessionPersistence.flush()
    for(const [id,stage,reason,result] of [
      [row.routerSessionId,'DECIDE',s.routerDraft && 'completed','superagent_route'],
      [row.workerSessionId,'WORK',s.finish==='stop'?'completed':s.finish,'superagent_answer'],
    ]) {
      const log=await ctx.sessionPersistence.open(id,'read')
      try {
        const {events}=await log.read()
        const prompts=events.filter(e=>e.type==='user/message' && e.data.source.kind==='user').map(e=>e.data.content[0].text.split('\n')[0])
        assert.deepEqual(prompts,['SUPERAGENT_'+stage,...(reason?['SUPERAGENT_CONTINUE']:[])])
        assert.deepEqual(events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),[...(reason?[reason]:[]),'completed'])
        const calls=events.filter(e=>e.type==='tool/call').map(e=>e.data)
        assert.deepEqual(calls.map(c=>c.name),[result])
        assert.deepEqual(events.filter(e=>e.type==='tool/result').map(e=>[e.data.message.toolCallId,!!e.data.message.isError]),[[calls[0].callId,false]])
      } finally {await log.close()}
    }
  }
  console.log('PASS automatic continuation: Router text, worker JSON-looking text and worker max-tokens each got SUPERAGENT_CONTINUE in the same native session. Only a successful result-tool receipt finished each seat; both answers awaited release with zero new sends.')
}

export async function verify(ctx,provider,workspacePath) {
  const checkpoint=join(process.cwd(),'fixture-checkpoint.json')
  const saved=process.env.SMOKE_PHASE==='release'?JSON.parse(await readFile(checkpoint,'utf8')):null
  provider.project=await fixtureProject(ctx);provider.ownPath=workspacePath
  const transport=fakeFeishu(saved?.rows)
  const config=saved?.config ?? {feishu:{...source,enabled:true,automationSince:Date.now()-60_000}}
  let store=await openStore(ctx.storageDomain)
  if(!saved)await legacyRound(ctx,workspacePath)
  const actors=createActors(ctx,{workspacePath})
  const make=()=>makeApp({config,...store,saveConfig:async(next,check)=>{check();config.feishu=next},
    listPresets:()=>ctx.agentPresets.list(),actors,runCli:transport.run})
  let app=make()
  const reopen=async()=>{await app.dispose();await store.close();store=await openStore(ctx.storageDomain);app=make()}
  try {
    if(saved) {
      await coldTakeover(ctx,app,provider,transport,saved.takeover)
      await checkColdArchive(ctx,app,provider,transport,saved.archival)
      const waiting=await confirmQuestions(app,provider,transport,saved)
      await reopen()
      await resumeWork(ctx,app,provider,transport,waiting,saved)
      await reopen()
      await mergeAfterRestart(ctx,app,provider,transport,saved.merge)
      await replayAndDM(ctx,app,provider,transport,await app.snapshot(),saved.retry)
      await finishedTakeover(ctx,app)
      await ignoreAfterRestart(app,provider,transport,saved.ignore)
      await memberAfterRestart(app,provider,transport,saved.member)
      await checkSoftStops(ctx,app,provider,transport)
      console.log('PASS result tools: only the active seat saw its result tools, invalid answer returned an error and was corrected in one turn; both same-step submissions succeeded and only the last question/answer was retained for release. An ordinary tail call ran without an extra send or repeated execution on cold continuation.')
      await legacyRound(ctx,workspacePath,actors)
      await imagesRound(ctx,provider,actors)
      assert.ok(provider.emptyRouter,'the default Router reached the native provider')
      assert.equal((await ctx.sessionPersistence.stat(provider.emptyRouter)).header.agentPreset,'default-fixture')
      console.log('PASS automation: release; after cold restart the group question waited through unmentioned replies; a new mention merged back into the original worker. Each outgoing question or answer required its own approval; receipt replay did not dispatch again. Notes required owner self-mentions; opted-in peer DMs entered normal admission without an @.')
    } else {
      await prepare(ctx,app,provider,transport)
      const takeover=await exerciseTakeover(ctx,app,provider,transport)
      const archival=await archiveDuringWork(ctx,app,provider,transport)
      await failBeforeExit(app,provider,transport)
      const ignore=await ignoreBeforeExit(app,provider,transport)
      const member=await memberBeforeExit(app,provider,transport)
      const merge=await mergeBeforeExit(ctx,app,provider,transport)
      await reopen() // A cold exit interrupts the merged follow-up the worker is still running.
      assert.equal(provider.mergeCancelled,merge.workerId)
      const {automation,cases,mentions}=await app.snapshot()
      const retry={router:provider.retryRouterId,worker:provider.retryWorkerId,seal:provider.retrySeal}
      // This is only expected evidence and synthetic Lark input. DSH persists its own cases, queue and sessions.
      await writeFile(checkpoint,JSON.stringify({config,rows:transport.rows,automation,cases,mentions,retry,takeover,archival,merge,ignore,member}))
      console.log('PASS automation: prepare; installed DSH offline. Owner group self-mention acquired a once grant without a click; an earlier pending mention was not run; Router and worker saw the identical complete admitted thread, including the root and 14 old lines over multiple pages, no sibling. Two distinct questions awaited approval, zero posts. Peer DMs disabled.')
    }
  } finally {await app.dispose();await store.close();assert.ifError(provider.error);assert.ifError(transport.error)}
}
