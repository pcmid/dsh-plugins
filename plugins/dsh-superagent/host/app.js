import { createCases } from './cases.js'
import { createLoop } from './loop.js'
import { sourceSettings } from './source-settings.js'

// Only the source adapter can start a job. A browser snapshot never drains the queue.
export function makeApp({config = {}, readConfig = ()=>config.feishu, saveConfig, state, permissions,
    executor, listPresets, runCli, managedDir, authFactory, automationStore, actors, roleDefaults}) {
  const cases = createCases({load:state.load,save:state.save,executor,listPresets})
  let revision=0, closed=false
  const changed=()=>{revision++}
  const channel=sourceSettings({readConfig,saveConfig,permissions,receive,hasReceived:(...args)=>loop?.hasReceived(...args) ?? false,hasIntake:(scope,id)=>loop?.hasIntake(scope,id) ?? false,isSentMessage:(...args)=>loop?.isSentMessage(...args) ?? false,
    runCli,managedDir,authFactory,onChange:changed})
  const guarded=fn=>async input=>{
    await channel.assertAutomation(input.source,input.signal,input.requesterId)
    input.signal?.throwIfAborted()
    // A seat reads the conversation's images and files itself, once it knows which ones it still needs.
    return fn({...input,loadImages:refs=>channel.loadImages(input.source,refs,input.signal,input.requesterId),
      loadFiles:(refs,use)=>channel.loadFiles(input.source,refs,input.signal,input.requesterId,use)})
  }
  const loop=automationStore && actors && createLoop({...automationStore,onChange:changed,isReleaseRequired:cases.isReleaseRequired,
    decide:guarded(actors.decide), work:guarded(actors.work),
    deliver:input=>channel.deliverReviewed(input),
    // A merge target's case: whether it is archived, and its original message for a reopened reply.
    caseInfo:async(caseId,messageId)=>{
      const {cases:rows}=await cases.snapshot(), c=rows.find(x=>x.id===caseId)
      if(!c?.messages.some(m=>m.kind==='feishu' && m.requestId===messageId))return undefined
      return {archived:c.archivedAt!==undefined,...await cases.retryIntake(caseId,messageId)}
    }})
  actors?.observe?.(changed) // A new Router or worker session appears in the case view.
  const unavailable=code=>Object.assign(new Error(code),{code})
  // An archived case is done: its sessions are archived, so it is neither retried nor taken over.
  const live=async(caseId,code)=>{if((await cases.snapshot()).cases.find(c=>c.id===caseId)?.archivedAt!==undefined)throw unavailable(code)}
  async function receive(event,scopeId,automatic=false,feedScopeId) {
    if(closed)throw new Error('disposed')
    if(automatic && (!loop || !/^[a-f0-9]{64}$/.test(scopeId || '')))throw new Error('automation unavailable')
    const item=await cases.receive(event,scopeId,feedScopeId)
    if(automatic) {
      const index=item.messages.findIndex(m=>m.kind==='feishu' && m.requestId===event.messageId)
      if(index<0)throw new Error('message not recorded')
      const {team,roleModels}=await cases.teamSettings()
      const source={...item.source,...(event.privatePeerId ? {privatePeerId:event.privatePeerId,privateChatsSince:event.privateChatsSince} : {})}
      await loop.enqueue({caseId:item.id,messageId:event.messageId,text:item.messages[index].text,requesterId:event.senderId,
        source,team,roleModels,workerContext:event.workerContext ?? '',...(event.workerImages?.length ? {workerImages:event.workerImages} : {}),
        ...(event.workerFiles?.length ? {workerFiles:event.workerFiles} : {})})
    }
    changed()
    return item
  }
  return {
    ...channel, async configure(patch){const result=await cases.configure(patch);changed();return result},
    async setReleasePolicy(input){const result=await cases.setReleasePolicy(input);changed();return result},
    async archiveCase(input){
      const result=await cases.archive(input)
      // The case's Router and worker sessions are archived with it.
      for(const j of loop ? (await loop.jobInputs()).filter(j=>j.caseId===result.caseId) : [])
        await actors.archiveSeats?.(j).catch(()=>{})
      changed();return result
    },
    async retryWork(input){
      if(!loop)throw unavailable('retry-unavailable')
      await live(input?.caseId,'retry-unavailable')
      const row=await loop.retry(input,await cases.retryIntake(input?.caseId,input?.messageId))
      changed()
      return {caseId:row.caseId,messageId:row.messageId,status:row.status}
    },
    async takeOver(input){
      if(!loop)throw unavailable('takeover-unavailable')
      await live(input?.caseId,'takeover-unavailable')
      const job=(await loop.jobInputs()).find(j=>j.caseId===input?.caseId && j.messageId===input?.messageId)
      const sessionId=job && (await actors.seats(job)).workerSessionId
      if(!sessionId)throw unavailable('takeover-unavailable')
      await loop.takeOver(input,sessionId,await actors.workerWorkspace(sessionId))
      actors.handOver([sessionId])
      changed()
      return {sessionId}
    },
    releaseOutput(input){
      if(!loop)throw Object.assign(new Error('release-stale'),{code:'release-stale'})
      return loop.release(input,channel.validateRelease)
    },
    async start(){
      if(closed)return
      if(loop){
        // A native owner prompt may arrive while the plugin is restoring its worker grants.
        const recovery=loop.takenOverSessions(actors.ownsWorkerSession).then(ids=>actors.handOver(ids))
        actors.waitForHandOvers?.(recovery)
        await recovery
      }
      if(roleDefaults){await cases.initializeRoles(roleDefaults);changed()}
      if(closed)return
      channel.startPolling();return loop?.drain()
    },
    drain:()=>loop?.drain(),
    async dispose(){
      closed=true
      // Stop new work before releasing the case storage.
      await Promise.allSettled([loop?.dispose(),channel.dispose(),cases.settled()])
    },
    viewRevision:()=>revision,
    // Whether the owner needs to act: approve a message, confirm a send, answer a native tool
    // approval in an automatic seat, or handle a failure. Archiving a case dismisses its failures only.
    async attention(){
      const version=revision
      const [workspace,rows]=await Promise.all([cases.snapshot(),loop?.snapshot() ?? []])
      const {mentions=[]}=await channel.activitySnapshot(workspace.cases,rows)
      const archived=new Set(workspace.cases.filter(c=>c.archivedAt).map(c=>c.id))
      const needed=mentions.some(m=>m.canApprove===true || m.intakeFailure && !archived.has(m.caseId)) || !!actors?.awaitingApproval?.() ||
        rows.some(r=>r.status==='awaiting-release' || !archived.has(r.caseId) && ['stopped','uncertain'].includes(r.status))
      return {needed,revision:version}
    },
    async snapshot(){
      const version=revision
      const [workspace,rows,inputs]=await Promise.all([cases.snapshot(),loop?.snapshot() ?? [],loop?.jobInputs() ?? []])
      // Each job's existing Router and worker sessions, so the owner can follow the model output.
      const seats=new Map(await Promise.all(inputs.map(async j=>[JSON.stringify([j.caseId,j.messageId]),await actors.seats(j)])))
      const automation=rows.map(r=>{
        const title=r.targetWorkspaceId && actors?.workspaceTitle?.(r.targetWorkspaceId)
        return {...r,...seats.get(JSON.stringify([r.caseId,r.messageId])),...title && {targetWorkspaceTitle:title}}
      })
      return {...workspace,...await channel.activitySnapshot(workspace.cases,automation),automation,revision:version}
    },
    async settingsSnapshot(){const version=revision;return {...await cases.teamSettings(),releaseRequired:await cases.isReleaseRequired(),source:await channel.snapshot(),revision:version}},
  }
}
