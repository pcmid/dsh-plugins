import { createHash,randomUUID } from 'node:crypto'
import { createAdmission,validAdmissionScope } from './admission.js'
import { createFeishuSource,hasFeishuIdentity } from './feishu.js'
import { createFeishuAuth } from './auth.js'
import { validateCliPath } from './cli-path.js'
import { pollDiagnostic } from './poll-diagnostics.js'

const fail = code => { throw Object.assign(new Error(code), {code}) }
const profileOK = v => typeof v === 'string' && v === v.trim() && /^\w[\w.-]{0,127}$/.test(v)
const text = v => typeof v === 'string' ? v : ''
const minutesOK = n => Number.isSafeInteger(n) && n >= 1 && n <= 1440
const limitOK = (n,max) => Number.isSafeInteger(n) && n>=0 && n<=max
const timeOK = n => Number.isSafeInteger(n) && n>0
const publicSettings = ({privateChatsSince,...settings}) => settings
export function sourceValues(f = {}) {
  const profile = text(f?.profile)
  const automationSince=timeOK(f?.automationSince) ? f.automationSince : undefined
  const allowPrivateChats=f?.allowPrivateChats===true && validAdmissionScope(f) &&
    timeOK(f.privateChatsSince) && f.privateChatsSince>=(automationSince ?? 0)
  // A configured 0.4 profile belongs to the user's CLI; never silently move it or reinitialize it.
  return {enabled:f?.enabled === true,profile,managed:f?.managed === true || (!profile && f?.managed !== false),
    ...(f?.cliPath ? {cliPath:f.cliPath} : {}),
    historyCount:limitOK(f?.historyCount,100) ? f.historyCount : f?.historyCount===undefined ? 10 : 0,
    historyMinutes:limitOK(f?.historyMinutes,1440) ? f.historyMinutes : f?.historyMinutes===undefined ? 5 : 0,
    tenantId:text(f?.tenantId),recipientId:text(f?.recipientId),pollIntervalMinutes:minutesOK(f?.pollIntervalMinutes) ? f.pollIntervalMinutes : 1,
    ...(automationSince ? {automationSince} : {}),allowPrivateChats,...(allowPrivateChats ? {privateChatsSince:f.privateChatsSince} : {})}
}
export function sourceSettings({readConfig,saveConfig,permissions,receive,hasReceived=()=>false,hasIntake=()=>false,isSentMessage=()=>false,isQuestionReply=()=>false,waitingQuestions=()=>[],resumeQuestion,runCli,managedDir,onChange=()=>{},authFactory = createFeishuAuth}) {
  let active, disposed = false, tail = Promise.resolve(), ioTail = Promise.resolve(), timer, polling, started=false
  let lastPrivateConsent=0
  function current() {
    if (disposed) fail('settings-unavailable')
    const f = sourceValues(readConfig()), {pollIntervalMinutes,historyCount,historyMinutes,allowPrivateChats,privateChatsSince,...identity} = f, key = JSON.stringify(identity)
    lastPrivateConsent=Math.max(lastPrivateConsent,privateChatsSince ?? 0)
    if (active?.key === key) {
      const s=active.settings
      if (s.pollIntervalMinutes!==pollIntervalMinutes || s.historyCount!==historyCount || s.historyMinutes!==historyMinutes ||
          s.allowPrivateChats!==allowPrivateChats || s.privateChatsSince!==privateChatsSince) {
        Object.assign(active.config,{pollIntervalMinutes,historyCount,historyMinutes,allowPrivateChats,privateChatsSince})
        active.settings={...f,version:randomUUID()}
      }
      return active
    }
    active?.auth.dispose()
    const {profile,tenantId,recipientId} = f
    const scope = {profile,tenantId,recipientId,...(f.managed ? {managed:true} : {})}
    const configured = hasFeishuIdentity(f)
    const admission = configured ? createAdmission({scope,...permissions,consentSince:f.automationSince,privateEpoch:()=>{
      const f=sourceValues(readConfig())
      return f.enabled && f.automationSince && f.profile===profile && f.recipientId===recipientId && f.tenantId===tenantId ? f.privateChatsSince : undefined
    }}) : null
    const logKey = validAdmissionScope(f) ? createHash('sha256').update(JSON.stringify(scope)).digest('hex') : null
    const bindingId = configured ? logKey : null
    const scopeId = bindingId && f.automationSince ? createHash('sha256').update(JSON.stringify([bindingId,f.automationSince])).digest('hex') : bindingId
    const cliDir = f.managed && profileOK(profile) ? managedDir?.(profile) : undefined
    // The first profile is not enrolled and has no grants. A missing managed directory must never use the shared CLI.
    const check=()=>{if(current()!==rec) fail('scope-changed')}
    const rec = {key,logKey,unsavedLogs:[],config:f,names:new Map(),seen:new Map(),settings:{...f,version:randomUUID()},configured,admission,bindingId,scopeId,cliDir,auth:authFactory({cliDir,cliPath:f.cliPath})}
    rec.source = createFeishuSource({config:f,cliDir,admission,check,onPollWarning:(e,stage)=>recordFailure(rec,e,stage),isSentMessage:(chatId,id)=>isSentMessage(scope,chatId,id),
      isQuestionReply:(chatId,id)=>isQuestionReply(scope,chatId,id),receive:(msg,grant)=>{
      check();checkPrivate(rec,msg)
      const automatic=!!f.automationSince
      return receive(msg,automatic ? grantScope(rec,grant) : scopeId,automatic,automatic ? rec.scopeId : undefined)
    },...(runCli ? {run:runCli} : {})})
    return active = rec
  }
  function versioned(version) {
    const rec=current()
    if (version !== rec.settings.version) fail('scope-changed')
    return rec
  }
  const serial = fn => {const r=tail.then(fn);tail=r.catch(()=>{});return r}
  async function persist(rec, next) {
    if (!saveConfig) fail('settings-unavailable')
    const expected = rec.settings.version
    const check = () => versioned(expected)
    check()
    try { await saveConfig(next,check) }
    catch (e) { if(e?.code==='scope-changed')throw e;fail('settings-unavailable') }
    const saved=current()
    if (JSON.stringify(sourceValues(saved.settings)) !== JSON.stringify(sourceValues(next))) fail('settings-unavailable')
    if (started && !polling) schedule(rec===saved ? saved.settings.pollIntervalMinutes*60_000 : 0)
    onChange()
    return publicSettings(saved.settings)
  }
  function authProfile(version) {
    const rec=versioned(version)
    // Reconnect a paused account without turning its old read access back on before consent.
    if (!profileOK(rec.settings.profile) || (!rec.settings.enabled && !validAdmissionScope(rec.settings))) fail('source-unconfigured')
    if (rec.settings.managed && !rec.cliDir) fail('settings-unavailable')
    return rec
  }
  function granted(scopeId) {
    const rec=current()
    if(!rec.configured) fail('source-unconfigured')
    if(rec.scopeId!==scopeId) fail('scope-changed')
    if(rec.settings.managed && !rec.cliDir) fail('settings-unavailable')
    return rec
  }
  function topicRequest(input) {
    const keys=['profile','managed','tenantId','recipientId','chatId','threadId']
    if(!input || typeof input!=='object' || Object.keys(input).length!==keys.length ||
        !keys.every(k=>Object.hasOwn(input,k)) || typeof input.threadId!=='string') fail('invalid-input')
    const rec=current()
    if(!rec.configured) fail('source-unconfigured')
    if(!keys.slice(0,4).every(k=>input[k]===rec.settings[k])) fail('scope-changed')
    return {rec:granted(rec.scopeId),target:{chatId:input.chatId,threadId:input.threadId}}
  }
  // The UI identity fingerprint is not an authority to resume a job. A new grant invalidates the old job.
  function grantScope(rec,g) {
    return createHash('sha256').update(JSON.stringify([rec.bindingId,rec.settings.automationSince,
      g.chatId,g.mode,g.threadId || null,g.grantId || null,g.approvedAt ?? null])).digest('hex')
  }
  function checkPrivate(rec,ref) {
    if(ref.privatePeerId!==undefined || ref.privateChatsSince!==undefined) {
      if(!ref.privatePeerId || !rec.config.allowPrivateChats || !ref.privateChatsSince || ref.privateChatsSince!==rec.config.privateChatsSince) fail('scope-changed')
    }
  }
  const peerRef=g=>g.privatePeerId ? {privatePeerId:g.privatePeerId,privateChatsSince:g.privateChatsSince} : {}
  function jobScope(source,signal) {
    signal?.throwIfAborted()
    const rec=current()
    if (!rec.configured || !rec.settings.automationSince || rec.settings.managed && !rec.cliDir ||
        source?.kind!=='feishu' || typeof source.threadId!=='string' ||
        source.tenantId!==rec.settings.tenantId || source.recipientId!==rec.settings.recipientId) fail('admission-denied')
    checkPrivate(rec,source)
    return {rec,checkGrant:grant=>{
      signal?.throwIfAborted()
      checkPrivate(rec,source)
      if(current()!==rec || grant.privatePeerId!==source.privatePeerId || grant.privateChatsSince!==source.privateChatsSince || grantScope(rec,grant)!==source.scopeId) fail('admission-denied')
    }}
  }
  function sync(rec,target) {
    return rec.source.sync(target,grant=>rec.settings.automationSince ? {since:Math.max(rec.settings.automationSince,grant.approvedAt || 0)} : {})
  }
  function live(rec) {if(disposed || current()!==rec) fail('scope-changed')}
  function io(fn) {const op=ioTail.then(fn);ioTail=op.catch(()=>{});return op}
  function pollError(rec,value) {
    if(!disposed && active===rec && !!rec.pollError!==value) {rec.pollError=value;onChange()}
  }
  async function recordFailure(rec,error,stage) {
    if(disposed || active!==rec || !rec.logKey || error?.code==='scope-changed')return
    const row=pollDiagnostic(error,stage)
    try {
      if(!permissions.pollLogs)throw Error()
      await permissions.pollLogs.append(rec.logKey,row)
    } catch {rec.unsavedLogs=[row,...rec.unsavedLogs].slice(0,20)}
    if(!disposed && active===rec)onChange()
  }
  // Persist the grant before attempting the exact original message. A crash before ack is safe:
  // the case and loop already deduplicate the same message under the same grant.
  async function replay(rec,groups) {
    let ok=true
    for(const g of groups) {
      if(g.mode==='pending')continue
      for(const ref of g.triggers || []) {
        if(ref.handled || ref.at<=rec.settings.automationSince)continue
        live(rec)
        try {
          const {threadId,messageId,at}=ref
          const scope=grantScope(rec,g)
          if (!await hasIntake(scope,messageId)) {
            const target={chatId:g.chatId,threadId,messageId,at,...peerRef(g),...(g.mode==='sender' ? {senderId:g.senderId} : {})}, archived=await archive(rec,target)
            if(archived) await rec.source.consumeMention(ref.ownerSelfMention ? {...target,ownerSelfMention:true} : target,archived.text)
          }
          live(rec)
          await rec.admission.ackTrigger({chatId:g.chatId,threadId,messageId,grantId:g.grantId})
          rec.seen.set(messageId,{scope,at,epoch:g.privateChatsSince})
        } catch(e) {ok=false;await recordFailure(rec,e,'receive')} // Keep the unacknowledged trigger for retry; do not starve other groups.
      }
    }
    return ok
  }
  // Reading a verified direct mention is not permission to create a case or call a model.
  async function archive(rec,ref) {
    checkPrivate(rec,ref)
    const consent=rec.settings.automationSince
    const recorded=await rec.admission.getMention(ref,consent)
    live(rec)
    if(recorded) return recorded
    const message=await rec.source.readMention(ref)
    live(rec)
    checkPrivate(rec,ref)
    if(!message) return null
    const {ownerSelfMention,...record}=message // Never persist the CLI's transient proof as a reusable approval.
    const {changed}=await rec.admission.recordMention(record,consent)
    if(changed) onChange()
    return message
  }
  // v4 retained exact references but no body for pending triggers. Hydrate only those known
  // references, not the chat or earlier thread history, when opening an upgraded store.
  async function hydrate(rec,groups) {
    if(rec.hydrated) return true
    let ok=true
    for(const g of groups) for(const t of g.triggers || []) {
      if(g.mode!=='pending' || t.handled || t.at<=rec.settings.automationSince) continue
      try {await archive(rec,{chatId:g.chatId,threadId:t.threadId,messageId:t.messageId,at:t.at,...peerRef(g)})}
      catch(e) {ok=false;await recordFailure(rec,e,'message')}
    }
    rec.hydrated=ok
    return ok
  }
  // Upgrade known pending rows only, in small batches after normal intake. Opening Activity stays offline.
  async function repairMentionNames(rec,groups) {
    const consent=rec.settings.automationSince, a=rec.admission
    if (!rec.nameRepairs) {
      const rows=groups.some(g=>g.mode==='pending' && g.triggers) ? await a.listMentions(consent) : []
      rec.nameRepairs=rows.filter(m=>m.canApprove && /@_user_\d+/.test(m.text))
        .map(({chatId,threadId,messageId,at,...m})=>({chatId,threadId,messageId,at,...peerRef(m)}))
    }
    for(const ref of rec.nameRepairs.splice(0,2)) {
      live(rec)
      try {
        if(await a.repairMentionNames(ref,consent,async r=>{
          checkPrivate(rec,r)
          const result=await rec.source.readMention(r,{legacyText:true})
          live(rec);checkPrivate(rec,r)
          return result
        })) onChange()
      } catch(e) {
        if(e?.code!=='scope-changed'){rec.nameRepairs.push(ref);await recordFailure(rec,e,'message')}
      }
    }
  }
  // Each feed advances independently. A failed P2P read must not hold back group mentions (or vice versa).
  async function scanFeed(rec,epoch,startedAt) {
    const consent=rec.settings.automationSince, a=rec.admission
    const floor=epoch ?? consent
    const check=()=>{ live(rec);if(epoch && rec.config.privateChatsSince!==epoch)fail('scope-changed') }
    const save=value=>epoch ? a.setPrivateScan(epoch,value) : a.setScan(consent,value)
    let scan=epoch ? await a.getPrivateScan(epoch) : await a.getScan(consent)
    if(!scan) {
      scan={since:epoch ?? Math.max(consent,startedAt)}
      await save(scan)
    }
    const until=scan.until ?? Date.now()
    if(until<=scan.since)return true
    for(let page=0;page<8;page++) {
      check()
      let result
      try {
        const request={...scan,until}
        result=epoch ? await rec.source.discoverPrivate(request) : await rec.source.discover(request)
      } catch(e) {
        if(scan.pageToken){check();await save({since:scan.since})}
        throw e
      }
      let pageOK=true
      for(const {ownerSelfMention:candidate,...ref} of result.mentions) {
        check()
        if(epoch ? ref.privateChatsSince!==epoch || !ref.privatePeerId || ref.at<=epoch : ref.privatePeerId!==undefined)continue
        try {
          // An ignored conversation, or messages from before a revocation, are not read, recorded or proposed.
          if(await a.skip(ref)) continue
          const archived=await archive(rec,ref)
          if(!archived) continue
          check()
          const verifyOwn = candidate===true ? async()=>{
            // A later grant (e.g. promotion to permanent) must not restart a previously handled item.
            if(await hasReceived(rec.config,ref.chatId,ref.messageId))return null
            const exact=archived.ownerSelfMention ? archived : await rec.source.readMention(ref)
            check()
            return exact
          } : undefined
          const {grant,changed}=await a.observe(ref,consent,verifyOwn)
          if(changed)onChange()
          if(!grant)continue
          const scope=grantScope(rec,grant), original=grant.triggers?.find(t=>t.messageId===ref.messageId && !t.handled)
          if(rec.seen.get(ref.messageId)?.scope!==scope && !await hasIntake(scope,ref.messageId)) {
            await rec.source.consumeMention(original?.ownerSelfMention ? {...ref,ownerSelfMention:true} : ref,archived.text)
            check()
          }
          if(original)await a.ackTrigger({chatId:ref.chatId,threadId:ref.threadId,messageId:ref.messageId,grantId:grant.grantId})
          rec.seen.set(ref.messageId,{scope,at:ref.at,epoch})
        } catch(e) {pageOK=false;await recordFailure(rec,e,'receive')}
      }
      check()
      if(!pageOK)return false
      scan=result.nextPageToken ? {since:scan.since,until,pageToken:result.nextPageToken} :
        {since:Math.max(floor,scan.since,until-300_000)}
      await save(scan)
      if(!scan.pageToken) {
        for(const [id,m] of rec.seen)if(m.epoch===epoch && m.at<=scan.since)rec.seen.delete(id)
        break
      }
    }
    return true
  }
  async function pollQuestions(rec,groups) {
    const scopes=new Set(groups.filter(g=>g.mode!=='pending').map(g=>grantScope(rec,g)))
    let ok=true
    for(const job of await waitingQuestions({tenantId:rec.config.tenantId,recipientId:rec.config.recipientId})) {
      if(!scopes.has(job.source.scopeId))continue
      live(rec)
      try {
        const {checkGrant}=jobScope(job.source)
        const reply=await rec.source.readQuestionReply(job,checkGrant)
        if(reply){live(rec);checkPrivate(rec,job.source);await resumeQuestion(job,reply)}
      } catch(e){ok=false;await recordFailure(rec,e,'receive')}
    }
    return ok
  }
  async function poll() {
    if(disposed)return
    const rec=current(), consent=rec.settings.automationSince, startedAt=Date.now()
    if(!consent || !rec.configured || rec.settings.managed && !rec.cliDir) return
    try {
      const groups=await rec.admission.list(), hydrated=await hydrate(rec,groups)
      // Older grants can lack a label. Resolve only known approved chats, never enumerate groups.
      const unnamed=new Set(groups.filter(g=>!['pending','ignored'].includes(g.mode) && !g.privatePeerId && !g.name && !rec.names.has(g.chatId)).map(g=>g.chatId))
      for(const chatId of [...unnamed].slice(0,4)) {
        try {
          const name=await rec.source.groupName(chatId)
          live(rec);rec.names.set(chatId,name)
          if(name) onChange()
        } catch(e) {await recordFailure(rec,e,'group')} // Missing display names do not block intake.
      }
      let ok=await replay(rec,groups) && hydrated
      ok=await pollQuestions(rec,groups) && ok
      for(const epoch of [undefined,...(rec.config.allowPrivateChats ? [rec.config.privateChatsSince] : [])]){
        try { ok=await scanFeed(rec,epoch,startedAt) && ok }
        catch(e){if(e?.code!=='scope-changed'){ok=false;await recordFailure(rec,e,'poll')}}
      }
      await repairMentionNames(rec,groups)
      pollError(rec,!ok)
    } catch(e) {pollError(rec,true);await recordFailure(rec,e,'poll')}
  }
  function pollOnce() {
    if(disposed) return Promise.resolve()
    return polling ??= io(poll).finally(()=>{polling=undefined})
  }
  function schedule(ms) {
    clearTimeout(timer)
    if(disposed) return
    timer=setTimeout(()=>{
      const start=Date.now()
      void pollOnce().finally(()=>{
        if(disposed)return
        const period=current().settings.pollIntervalMinutes*60_000
        // Keep the configured start-to-start cadence; skip missed ticks instead of overlapping CLI calls.
        schedule(period-(Math.max(0,Date.now()-start)%period))
      })
    },ms)
    timer.unref?.()
  }
  // Trigger IDs are host-only evidence, never an owner-supplied replay request.
  const visible=(rec,rows)=>rows.map(({chatId,mode,threadId,name=rec.names.get(chatId),approvedAt,grantId,triggers,ignoredAt,senderId,note})=>({
    chatId,mode,...(threadId?{threadId}:{}),...(mode==='sender' ? {senderId,...(note ? {note} : {})} : {}),...(name?{name}:{}),...(grantId?{approvedAt,grantId}:{}),
    ...(mode==='once' && triggers?.[0] ? {mentionAt:triggers[0].at} : {}),...(mode==='ignored' ? {ignoredAt} : {}),
  }))
  async function snapshot(cases,automation=[]) {
    const rec=current(), consent=rec.settings.automationSince
    const groups=rec.admission ? await rec.admission.list() : []
    const source={...rec.source.status(),...(rec.pollError && consent ? {state:'error',detail:'未能完成本次飞书轮询，将自动重试。'} : {}),
      configured:rec.configured,scopeId:rec.scopeId,settings:publicSettings(rec.settings),groups:visible(rec,groups)}
    if(!cases) {
      let saved=[]
      try {if(rec.logKey && permissions.pollLogs)saved=await permissions.pollLogs.list(rec.logKey)} catch { /* Settings still work if log storage is unavailable. */ }
      live(rec)
      return {...source,pollErrors:[...rec.unsavedLogs,...saved].sort((a,b)=>b.at-a.at).slice(0,20)}
    }
    const rows=consent && rec.admission ? await rec.admission.listMentions(consent) : []
    live(rec)
    const links=new Map(), previous=new Set(groups.filter(g=>['once','permanent','sender'].includes(g.mode)).map(g=>grantScope(rec,g)))
    // Filter the copied action tokens against this same grant snapshot, not one storage read per job.
    const pending=new Map(automation.filter(r=>r.releaseToken).map(r=>[JSON.stringify([r.caseId,r.messageId]),r]))
    const key=(chat,thread,id)=>JSON.stringify([chat,thread,id])
    for(const c of cases) {
      const s=c.source
      if(s.kind!=='feishu' || s.tenantId!==rec.settings.tenantId || s.recipientId!==rec.settings.recipientId ||
          !(c.feedScopeId===rec.scopeId || (!c.feedScopeId && previous.has(s.scopeId))))continue
      const allowed=pending.size && consent && rec.configured && (!rec.settings.managed || rec.cliDir) && previous.has(s.scopeId)
      for(const m of c.messages) if(m.kind==='feishu'){
        links.set(key(s.chatId,s.threadId,m.requestId),c.id)
        if(allowed)pending.delete(JSON.stringify([c.id,m.requestId]))
      }
    }
    // Without current access a pending reply can only be declined; sending rechecks access anyway.
    for(const row of pending.values()) row.releaseBlocked=true
    return {source,mentions:rows.map(({privatePeerId,privateChatsSince,...row})=>{
      const caseId=links.get(key(row.chatId,row.threadId,row.messageId))
      return {...row,scopeId:rec.scopeId,...(caseId ? {caseId,canApprove:false} : {})}
    })}
  }
  return {
    startPolling() {if(!started && !disposed) {started=true;schedule(0)}},
    pollOnce,
    // requesterId is the job's verified author; a grant for one member covers only their requests.
    async validateRelease(source,signal,requesterId) {
      const {rec,checkGrant}=jobScope(source,signal)
      await rec.admission.run({chatId:source.chatId,threadId:source.threadId,...(requesterId ? {senderId:requesterId} : {})},checkGrant)
    },
    async assertAutomation(source,signal,requesterId) {
      const {rec,checkGrant}=jobScope(source,signal)
      await rec.source.assertAllowed({...source,...(requesterId ? {senderId:requesterId} : {})},checkGrant)
      signal?.throwIfAborted()
      if(current()!==rec) fail('scope-changed')
    },
    // Images a seat is about to receive, read under the job's current grant.
    async loadImages(source,refs,signal,requesterId) {
      const {rec,checkGrant}=jobScope(source,signal)
      const images=await rec.source.images({source,refs,requesterId},checkGrant)
      signal?.throwIfAborted()
      if(current()!==rec) fail('scope-changed')
      return images
    },
    async deliverReviewed(job) {
      try {
        const {rec,checkGrant}=jobScope(job?.source,job?.signal)
        return await rec.source.reply(job,checkGrant)
      } catch(e) {fail(e?.code==='delivery-uncertain' ? e.code : 'delivery-denied')}
    },
    snapshot:()=>snapshot(),
    activitySnapshot:(cases,automation)=>snapshot(cases,automation),
    setPollInterval: ({version,pollIntervalMinutes}) => serial(async()=>{
      const rec=versioned(version)
      if(!minutesOK(pollIntervalMinutes)) fail('invalid-input')
      return rec.settings.pollIntervalMinutes===pollIntervalMinutes ? publicSettings(rec.settings) :
        persist(rec,{...sourceValues(rec.settings),pollIntervalMinutes})
    }),
    setHistoryLimits: ({version,historyCount,historyMinutes}) => serial(async()=>{
      const rec=versioned(version)
      if(!limitOK(historyCount,100) || !limitOK(historyMinutes,1440)) fail('invalid-input')
      return rec.settings.historyCount===historyCount && rec.settings.historyMinutes===historyMinutes ? publicSettings(rec.settings) :
        persist(rec,{...sourceValues(rec.settings),historyCount,historyMinutes})
    }),
    setCliPath: ({version,cliPath}) => serial(async()=>{
      const rec=versioned(version), path=await validateCliPath(cliPath)
      versioned(version)
      return (rec.settings.cliPath ?? '')===path ? publicSettings(rec.settings) :
        persist(rec,{...sourceValues(rec.settings),cliPath:path})
    }),
    setPrivateChats: ({version,allowPrivateChats}) => serial(async()=>{
      const rec=versioned(version)
      if(typeof allowPrivateChats!=='boolean')fail('invalid-input')
      if(allowPrivateChats && (!rec.configured || !rec.settings.automationSince))fail('source-unconfigured')
      if(rec.settings.allowPrivateChats===allowPrivateChats)return publicSettings(rec.settings)
      const {privateChatsSince,...next}=sourceValues(rec.settings)
      return persist(rec,{...next,allowPrivateChats,...(allowPrivateChats ?
        {privateChatsSince:Math.max(Date.now(),rec.settings.automationSince,lastPrivateConsent+1)} : {})})
    }),
    saveFeishu: ({version,enabled,profile,managed}) => serial(async()=>{
      const rec=versioned(version)
      if(typeof enabled!=='boolean' || typeof managed!=='boolean' || !profileOK(profile) || (managed && profile.length>64)) fail('invalid-input')
      const same = profile===rec.settings.profile && managed===rec.settings.managed
      const {cliPath,pollIntervalMinutes,historyCount,historyMinutes,allowPrivateChats,privateChatsSince}=rec.settings
      return persist(rec,{enabled,profile,managed,pollIntervalMinutes,historyCount,historyMinutes,...(cliPath ? {cliPath} : {}),...(same ? {tenantId:rec.settings.tenantId,recipientId:rec.settings.recipientId} : {}),
         ...(same && allowPrivateChats ? {allowPrivateChats:true,privateChatsSince} : {allowPrivateChats:false}),
         ...(same && enabled && rec.settings.automationSince ? {automationSince:rec.settings.automationSince} : {})})
    }),
    async startFeishuAuth({version,kind,automation}) {
      const rec=authProfile(version),{profile,managed}=rec.settings
      if (!['login','setup'].includes(kind) || (kind==='login' && automation!==true) || (kind==='setup' && (!rec.settings.enabled || !managed || rec.configured || automation!==undefined))) fail('invalid-input')
      const {flowId,url,qrDataUrl,expiresAt}=await rec.auth.start({profile,kind})
      versioned(version)
      return {flowId,url,qrDataUrl,expiresAt}
    },
    async finishFeishuAuth({version,flowId}) {
      const rec=authProfile(version),{profile,managed}=rec.settings
      // Keep cancellation and disabling available while the provider verifies consent.
      const result=await rec.auth.finish({profile,flowId})
      return serial(async()=>{
        versioned(version)
        if(result?.kind==='setup' && managed) return {kind:'setup'}
        if(result?.kind!=='login' || !validAdmissionScope({profile,tenantId:result.tenantId,recipientId:result.recipientId})) fail('auth-unavailable')
        const {privateChatsSince,allowPrivateChats:wasAllowed,...previous}=sourceValues(rec.settings)
        const allowPrivateChats=wasAllowed && previous.tenantId===result.tenantId && previous.recipientId===result.recipientId
        const automationSince=Math.max(Date.now(),(previous.automationSince || 0)+1)
        await persist(rec,{...previous,enabled:true,profile,managed,tenantId:result.tenantId,recipientId:result.recipientId,automationSince,
          allowPrivateChats,...(allowPrivateChats ? {privateChatsSince:Math.max(automationSince,lastPrivateConsent+1)} : {})})
        await current().admission.setScan(automationSince,{since:automationSince})
        return {kind:'login'}
      })
    },
    async cancelFeishuAuth({version,flowId}) {
      const rec=versioned(version)
      await rec.auth.cancel({profile:rec.settings.profile,flowId})
      return {cancelled:true}
    },
    // A trusted Host source may propose metadata, never grant access or import message text.
    requestAccess: input => serial(async()=>{
      const {rec,target}=topicRequest(input)
      const rows=await rec.admission.update({action:'register',...target})
      onChange()
      return {mode:rows.find(row=>row.chatId===target.chatId && (['permanent','ignored'].includes(row.mode) || row.threadId===target.threadId)).mode}
    }),
    syncTopic: input => serial(async()=>{
      const {rec,target}=topicRequest(input)
      return sync(rec,target)
    }),
    groupAccess: ({scopeId,...command}) => serial(async()=>{
      const rec=granted(scopeId)
      if(!['once','permanent','sender','dismiss','ignore','revoke'].includes(command.action)) fail('invalid-input')
      const groups=await rec.admission.update(command)
      onChange()
      if(rec.settings.automationSince && ['once','permanent','sender'].includes(command.action) &&
        groups.some(g=>g.chatId===command.chatId && g.mode!=='pending' && g.triggers?.some(t=>!t.handled))) {
        void io(async()=>{live(rec);if(!await replay(rec,await rec.admission.list()))pollError(rec,true)}).catch(async e=>{pollError(rec,true);await recordFailure(rec,e,'receive')})
      }
      return visible(rec,groups)
    }),
    syncFeishu: ({scopeId,...target}) => serial(async()=>{
      const rec=granted(scopeId)
      try { return await sync(rec,target) }
      catch(e){if(['invalid-input','storage-unavailable','admission-denied','scope-changed'].includes(e?.code))throw e;fail('source-unavailable')}
    }),
    async dispose() {
      disposed=true
      clearTimeout(timer)
      await Promise.allSettled([active?.auth.dispose(),polling,tail,ioTail])
    },
  }
}
