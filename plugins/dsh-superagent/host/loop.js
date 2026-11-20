import { createHash,randomUUID } from 'node:crypto'

const roles = ['lead','develop','answer']
const legacySourceKeys = ['kind','scopeId','tenantId','recipientId','chatId','threadId']
const sourceKeys = [...legacySourceKeys,'privatePeerId','privateChatsSince']
const workerRoles = ['develop','answer']
const starting = new Map([['queued','deciding'],['assigned','working'],['approved','delivering'],['released','delivering']])
const terminal = new Set(['ignored','stopped','uncertain','delivered','declined','taken-over','merged'])
// Records from the removed review stage stay readable; loading stops them as interrupted.
const statuses = new Set([...starting.keys(),...starting.values(),...terminal,'awaiting-release','waiting-requester','awaiting-review','reviewing'])
const reasons = new Set(['interrupted','work-uncertain','delivery-uncertain','delivery-denied','access-denied',
  'decision-failed','work-failed','review-failed','invalid-decision','no-final-answer','invalid-review','review-stopped','rework-limit'])
const accessErrors = new Set(['admission-denied','scope-changed','source-unconfigured','automation-disabled','source-unavailable'])
const publicFields = ['caseId','messageId','status','attempt','updatedAt','role','presetId','resolvedPresetId',
  'criteria','sessionId','workspaceId','targetWorkspaceId','answer','outputKind','reason','receipt','supplements','mergedInto']
const storedFields = [...publicFields,'text','context','decisionHistory','source','team','roleModels','releaseNonce','releaseProof',
  'requesterId','workerContext','workerImages','workerProof','turns','retries','supplementId']
// Later messages merged into this job wait in `supplements` until a worker run takes them in.
const intakeKeys = ['text','context','team','roleModels','workerContext','workerImages','requesterId','supplements','supplementId']
// Failed work keeps its intake so the owner can retry; a possibly delivered reply is never retried.
const retryable = j => j.status === 'stopped' || j.status === 'uncertain' && j.reason === 'work-uncertain'
// The owner can take over a worker session any time except while its reply is being posted.
const takeable = j => workerRoles.includes(j.role) &&
  (['assigned','working','approved','awaiting-release','released','waiting-requester'].includes(j.status) || retryable(j))
const accepted = new Set(['approved','awaiting-release','released','delivering','delivered','declined','waiting-requester'])
// Jobs a later message in the same conversation may be merged into: unfinished worker jobs, and in a
// native thread also a reply already posted. A reply being posted, and anything archived, is excluded.
const openStatuses = ['assigned','working','approved','awaiting-release','waiting-requester']
const supplementsOK = v => v === undefined || Array.isArray(v) && v.length > 0 && v.length <= 20 &&
  v.every(x => only(x,['messageId','text','senderId']) && message(x.messageId) && prose(x.text,65536) && (x.senderId === undefined || user(x.senderId)))
const releaseFields = ['caseId','messageId','token','action']
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const only = (v,keys) => object(v) && Object.keys(v).every(k => keys.includes(k))
const short = v => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(v)
const matches = (v,re) => typeof v === 'string' && v.trim() === v && re.test(v)
const ref = v => matches(v,/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,255}$/)
const message = v => matches(v,/^om_[\w-]{1,128}$/)
const user = v => matches(v,/^ou_[\w-]{1,128}$/)
const time = v => Number.isSafeInteger(v) && v > 0
const digest = v => matches(v,/^[a-f0-9]{64}$/)
const prose = (v,n) => typeof v === 'string' && v.length <= n && !!v.trim()
const modelOK = m => object(m) && (m.inherit === true
  ? Object.keys(m).every(k => ['inherit','effort'].includes(k)) && short(m.effort)
  : Object.keys(m).every(k => ['provider','model','effort','name'].includes(k)) && short(m.provider) && short(m.model) &&
    (m.effort === undefined || m.effort === '' || short(m.effort)) && (m.name === undefined || m.name === '' || short(m.name)))
const sourceOK = s => s?.kind === 'feishu' && matches(s.scopeId,/^[a-f0-9]{64}$/) &&
  matches(s.tenantId,/^[\w-]{1,128}$/) && matches(s.recipientId,/^ou_[\w-]{1,128}$/) &&
  matches(s.chatId,/^oc_[\w-]{1,128}$/) && message(s.threadId) && (s.privatePeerId === undefined
    ? s.privateChatsSince === undefined : user(s.privatePeerId) && s.privatePeerId !== s.recipientId && time(s.privateChatsSince))
const routesOK = j => object(j.team) && roles.every(k => j.team[k] === '' || short(j.team[k])) &&
  object(j.roleModels) && Object.entries(j.roleModels).every(([k,m]) => roles.includes(k) && modelOK(m))
const contextOK = v => v === undefined || typeof v === 'string' && v.length <= 4096
const workerContextOK = v => v === undefined || typeof v === 'string' && v.length <= 262144
// Images of the conversation by reference: the message that carries each one and when it was sent.
const imagesOK = v => v === undefined || Array.isArray(v) && v.length > 0 && v.length <= 100 &&
  v.every(x => only(x,['messageId','key','at']) && message(x.messageId) && matches(x.key,/^img_[\w-]{1,256}$/) && time(x.at)) &&
  new Set(v.map(x => x.key)).size === v.length
// Later messages add their images; each image is kept once, the newest 100 at most.
const joinImages = (...lists) => {
  const seen = new Set(), all = lists.flat().filter(x => x && !seen.has(x.key) && seen.add(x.key)).slice(-100)
  return all.length ? all : undefined
}
const sameSource = (a,b) => sourceKeys.every(k => a[k] === b[k])
const sameBinding = (j,b) => j.source.tenantId === b.tenantId && j.source.recipientId === b.recipientId
const questionSeen = (j,id) => j.turns?.some(t => t.questionId === id)
const validReceipt = (r,j) => r?.inReplyTo === j.messageId && r.chatId === j.source.chatId &&
  message(r.messageId) && r.messageId !== j.messageId && r.messageId !== j.source.threadId

function fail(code) { throw Object.assign(new Error(code),{code}) }
function pick(obj,keys) { return Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k,obj[k]])) }
function incoming(input) {
  if (!input || !ref(input.caseId) || !message(input.messageId) || !sourceOK(input.source) ||
      !prose(input.text,65536) || !contextOK(input.context) || !contextOK(input.decisionHistory) || !routesOK(input) ||
      !workerContextOK(input.workerContext) || !imagesOK(input.workerImages) || input.requesterId !== undefined && !user(input.requesterId)) fail('invalid-input')
  return structuredClone({...pick(input,['caseId','messageId','text','context','decisionHistory','roleModels','requesterId','workerContext','workerImages']),
    source:pick(input.source,sourceKeys),team:pick(input.team,roles),status:'queued',attempt:0,updatedAt:Date.now()})
}

// The nonce distinguishes approval requests; the digest pins the intake, the worker's answer and exact destination.
function releaseToken(j) {
  const target = [j.releaseNonce,j.caseId,j.messageId,...legacySourceKeys.map(k=>j.source[k]),j.text,j.answer]
  // Preserve approvals issued before private chats and clarification rounds existed.
  if (j.outputKind || j.requesterId || j.source.privatePeerId || j.turns)
    target.push(j.source.privatePeerId,j.source.privateChatsSince,j.requesterId,j.outputKind,j.turns?.at(-1)?.replyId)
  return createHash('sha256').update(JSON.stringify(target)).digest('hex')
}
function validTurns(j) {
  if (!j.turns) return j.turns === undefined && j.status !== 'waiting-requester'
  if (!Array.isArray(j.turns) || !j.turns.length || !ref(j.sessionId) || !ref(j.workspaceId) || !workerRoles.includes(j.role) ||
      ['queued','deciding','ignored'].includes(j.status) || !terminal.has(j.status) && !user(j.requesterId)) return false
  const seen = new Set([j.messageId,j.source.threadId])
  for (const [i,t] of j.turns.entries()) {
    if (!only(t,['questionId','replyId','question','reply']) || !message(t.questionId) || seen.has(t.questionId)) return false
    seen.add(t.questionId)
    if (!t.replyId) return i === j.turns.length-1 && j.status === 'waiting-requester' &&
      Object.keys(t).length === 1 && j.receipt?.messageId === t.questionId
    const stripped = t.question === undefined && t.reply === undefined
    // A retried worker continues its own session; earlier rounds keep only their message IDs.
    if (!message(t.replyId) || seen.has(t.replyId) || (terminal.has(j.status) ? !stripped :
      !(prose(t.question,16384) && prose(t.reply,65536) || stripped && (j.retries || j.supplementId)))) return false
    seen.add(t.replyId)
  }
  return j.status !== 'waiting-requester' && !seen.has(j.receipt?.messageId)
}
function validJob(j) {
  if (!only(j,storedFields) || !ref(j.caseId) || !message(j.messageId) || !only(j.source,sourceKeys) || !sourceOK(j.source) ||
      !statuses.has(j.status) || !Number.isInteger(j.attempt) || j.attempt < 0 || j.attempt > 2 ||
      !Number.isFinite(j.updatedAt) || (j.reason !== undefined && !reasons.has(j.reason)) ||
      j.retries !== undefined && !(Number.isSafeInteger(j.retries) && j.retries > 0)) return false
  const {status,attempt} = j
  if (!validTurns(j) || j.requesterId !== undefined && !user(j.requesterId) || !workerContextOK(j.workerContext) || !imagesOK(j.workerImages) ||
      j.workerProof !== undefined && !(digest(j.workerProof) && ref(j.sessionId))) return false
  if (j.decisionHistory !== undefined && (!['queued','deciding'].includes(status) || !contextOK(j.decisionHistory))) return false
  if (status === 'awaiting-release' || status === 'released') {
    if (!matches(j.releaseNonce,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)) return false
    if (status === 'released' ? j.releaseProof !== releaseToken(j) : j.releaseProof !== undefined) return false
  } else if (j.releaseNonce !== undefined || j.releaseProof !== undefined) return false
  if (terminal.has(status)) {
    if (Object.hasOwn(j,'workerProof') || !retryable(j) && intakeKeys.some(k => Object.hasOwn(j,k))) return false
    if (Object.hasOwn(j,'text') && (!prose(j.text,65536) || !contextOK(j.context) || !only(j.team,roles) || !routesOK(j))) return false
  } else if (!prose(j.text,65536) || !contextOK(j.context) || !only(j.team,roles) || !routesOK(j)) return false
  if ((j.sessionId !== undefined || j.workspaceId !== undefined) && !(ref(j.sessionId) && ref(j.workspaceId))) return false
  if (j.resolvedPresetId !== undefined && !short(j.resolvedPresetId)) return false
  if (j.role !== undefined || !['queued','deciding','ignored','stopped','uncertain','merged'].includes(status)) {
    if (!roles.includes(j.role) || !(short(j.presetId) || j.presetId === '') || j.criteria !== undefined && !prose(j.criteria,2048)) return false
  }
  // The DSH workspace the Router chose for the worker; absent means the SuperAgent workspace.
  if (j.targetWorkspaceId !== undefined && !(ref(j.targetWorkspaceId) && workerRoles.includes(j.role))) return false
  // A merged message points at the job it was merged into; supplements wait for that job's worker.
  if ((status === 'merged') !== (j.mergedInto !== undefined) || status === 'merged' && j.role !== undefined ||
      j.mergedInto !== undefined && !(only(j.mergedInto,['caseId','messageId']) && ref(j.mergedInto.caseId) && message(j.mergedInto.messageId))) return false
  if (!supplementsOK(j.supplements) || j.supplements && !workerRoles.includes(j.role) ||
      j.supplementId !== undefined && !(message(j.supplementId) && workerRoles.includes(j.role))) return false
  if (['queued','deciding','ignored'].includes(status) && attempt !== 0 || status === 'assigned' && attempt > 1) return false
  if ((accepted.has(status) || ['working','awaiting-review','reviewing'].includes(status)) && attempt === 0) return false
  if ((accepted.has(status) || ['awaiting-review','reviewing'].includes(status)) && !ref(j.sessionId)) return false
  if (status === 'taken-over' && !(workerRoles.includes(j.role) && ref(j.sessionId) && ref(j.workspaceId))) return false
  if (accepted.has(status) && !prose(j.answer,16384)) return false
  if (j.answer !== undefined && (!prose(j.answer,16384) || !(accepted.has(status) || ['stopped','uncertain'].includes(status)))) return false
  if (j.outputKind !== undefined && (!['answer','question'].includes(j.outputKind) || !prose(j.answer,16384))) return false
  if (status === 'waiting-requester' && j.outputKind !== 'question' || status === 'delivered' && j.outputKind === 'question' ||
      j.outputKind === 'question' && !terminal.has(status) && !user(j.requesterId)) return false
  return ['delivered','waiting-requester'].includes(status) ? only(j.receipt,['chatId','messageId','inReplyTo']) && validReceipt(j.receipt,j) : j.receipt === undefined
}

function projection(j) {
  const p = structuredClone(pick(j,publicFields))
  if (j.status === 'awaiting-release') p.releaseToken = releaseToken(j)
  if (j.status === 'released') p.status = 'approved'
  return p
}
function transition(j,patch) {
  const next = {...j,...patch,updatedAt:Date.now()}
  // A patch clears a field by setting it to undefined; stored JSON never holds undefined.
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  if (next.status !== 'deciding') delete next.decisionHistory
  if (j.status === 'waiting-requester' && next.status === 'assigned') {
    delete next.receipt; delete next.answer; delete next.outputKind
  }
  if (next.status !== 'released' && next.status !== 'awaiting-release') {
    delete next.releaseNonce; delete next.releaseProof
  }
  if (terminal.has(next.status)) {
    // Case history already owns the intake. A tombstone keeps replay protection without copying it forever.
    delete next.workerProof
    if (!retryable(next)) for (const k of intakeKeys) delete next[k]
    if (next.turns) next.turns = next.turns.map(t=>pick(t,['questionId','replyId']))
  }
  return next
}
function interrupted(j) {
  if (j.status === 'working') return {status:'uncertain',reason:'work-uncertain'}
  if (j.status === 'delivering') return {status:'uncertain',reason:'delivery-uncertain'}
  if (['deciding','awaiting-review','reviewing'].includes(j.status) || j.status === 'assigned' && j.attempt > 0)
    return {status:'stopped',reason:'interrupted'}
}
const keyOf = j => JSON.stringify([j.source.scopeId,j.messageId])

// One Host instance owns this atomic document. Only trusted Host adapters call enqueue and the actors;
// each actor rechecks current source authorization. Neither a receipt of intake nor worker prose authorizes delivery.
export function createLoop({load,save,decide,work,deliver,onChange,isReleaseRequired=()=>true,caseInfo=async()=>undefined}) {
  let store, failed = false, tail = Promise.resolve(), running
  // Routing runs beside work, so a new message can be merged into a job that is still being worked on.
  const lanes = {route:{status:j=>j.status === 'queued'},work:{status:j=>starting.has(j.status) && j.status !== 'queued'}}
  const controller = new AbortController(), signal = controller.signal
  async function commit(jobs) {
    const next = {schema:1,jobs}
    try { await save(next) } catch { failed = true; fail('storage-unavailable') }
    store = next
    // View invalidation must neither block a store transaction nor fail a successfully committed operation.
    if (onChange) void Promise.resolve().then(() => onChange()).catch(() => {})
  }
  async function state() {
    if (failed) fail('storage-unavailable')
    if (store) return store
    try {
      const saved = await load()
      if (saved === undefined) return store = {schema:1,jobs:[]}
      if (saved?.schema !== 1 || !Array.isArray(saved.jobs) || !saved.jobs.every(validJob) ||
          new Set(saved.jobs.map(keyOf)).size !== saved.jobs.length) fail('storage-unavailable')
      const jobs = saved.jobs.map(j => { const patch = interrupted(j); return patch ? transition(j,patch) : j })
      if (jobs.some((j,i) => j !== saved.jobs[i])) await commit(jobs)
      else store = saved
      return store
    } catch { failed = true; fail('storage-unavailable') }
  }
  function locked(fn) {
    const p = tail.then(state).then(fn)
    tail = p.catch(() => {})
    return p
  }
  async function update(s,index,patch) {
    const jobs = s.jobs.slice()
    jobs[index] = transition(jobs[index],patch)
    await commit(jobs)
    return jobs[index]
  }
  function stopped(reason) { return {status:'stopped',reason} }
  // Earlier jobs in the same conversation this message might belong to: the same native thread, or
  // for a message outside any thread, other such messages in the same chat. Archived cases are excluded.
  function related(s,j) {
    const inThread = j.source.threadId !== j.messageId
    return s.jobs.filter(x => x !== j && x.source.scopeId === j.source.scopeId && sameBinding(x,j.source) &&
      x.source.chatId === j.source.chatId && workerRoles.includes(x.role) &&
      (inThread ? x.source.threadId === j.source.threadId : x.source.threadId === x.messageId) &&
      (openStatuses.includes(x.status) || inThread && x.status === 'delivered'))
  }
  async function openWork(j) {
    const rows = await locked(s => related(s,j).slice(-10).map(x => structuredClone(pick(x,['caseId','messageId','source','status','text','answer','outputKind']))))
    const out = []
    for (const x of rows) {
      const info = await caseInfo(x.caseId,x.messageId)
      if (!info || info.archived) continue
      const state = x.status === 'delivered' ? 'replied' : x.status === 'waiting-requester' ? 'waiting for the requester' :
        ['approved','awaiting-release'].includes(x.status) ? (x.outputKind === 'question' ? 'question drafted' : 'reply drafted') :
        x.status === 'working' ? 'in progress' : 'not started'
      out.push({ref:'w'+(out.length+1),key:keyOf(x),caseId:x.caseId,messageId:x.messageId,request:x.text ?? info.text,state,...x.answer && {output:x.answer}})
    }
    return out
  }
  async function execute(j,jobSignal) {
    const key = keyOf(j), signal = jobSignal
    const base = {...structuredClone(pick(j,['caseId','messageId','source','text','team','roleModels','retries','requesterId','workerImages'])),
      workerContext:j.workerContext ?? j.context,signal}
    const assignment = pick(j,['role','criteria','attempt','targetWorkspaceId'])
    if (j.status === 'deciding') {
      const open = await openWork(j)
      const d = await decide({...base,...open.length && {openWork:open.map(({ref,request,state,output})=>({ref,request,state,...output && {output}}))}}) // Routing only.
      if (d?.action === 'ignore') return {status:'ignored'}
      if (d?.action === 'merge') {
        const target = open.find(row=>row.ref === d.target)
        return target ? {merge:target} : stopped('invalid-decision')
      }
      if (d?.action !== 'work' || !workerRoles.includes(d.role) || d.criteria !== undefined && !prose(d.criteria,2048) ||
          d.workspaceId !== undefined && !ref(d.workspaceId)) return stopped('invalid-decision')
      return {status:'assigned',role:d.role,...pick(d,['criteria']),presetId:j.team[d.role],
        ...d.workspaceId && {targetWorkspaceId:d.workspaceId}}
    }
    const workerPacket = pick(j,['requesterId','workerProof'])
    if (j.status === 'working') {
      if (!workerRoles.includes(j.role)) return stopped('invalid-decision') // Legacy lead assignments cannot execute as workers.
      const last = j.turns?.at(-1)
      const supplements = j.supplements?.map(x=>({text:x.text,from:x.senderId && x.senderId === j.requesterId ? 'requester' : 'participant'}))
      const resume = {continueWork:true,...j.workspaceId && {previousWorkspaceId:j.workspaceId}}
      // Merged messages continue the worker's own session; a confirmed reply resumes its question;
      // a retry continues the session as recorded.
      const previous = supplements ? {...resume,supplements} :
        j.sessionId && last?.reply !== undefined ? {previousSessionId:j.sessionId,previousWorkspaceId:j.workspaceId,
          ...j.resolvedPresetId && {previousResolvedPresetId:j.resolvedPresetId},
          previousQuestion:last.question,requesterReply:last.reply} : j.retries ? resume : {}
      const r = await work({...base,...workerPacket,...assignment,...previous})
      const question = r?.question !== undefined
      if (!(question ? user(j.requesterId) && r.answer === undefined && prose(r.question,16384) : prose(r?.answer,16384)) ||
          !ref(r.sessionId) || !ref(r.workspaceId) || r.resolvedPresetId !== undefined && !short(r.resolvedPresetId) ||
          (j.workerProof || r.workerProof !== undefined) && !digest(r.workerProof) ||
          j.sessionId && (r.sessionId !== j.sessionId || r.workspaceId !== j.workspaceId ||
            r.resolvedPresetId !== undefined && r.resolvedPresetId !== j.resolvedPresetId)) return stopped('no-final-answer')
      const worker = pick(r,['sessionId','workspaceId','resolvedPresetId','workerProof'])
      // The worker checks its own result; only the owner's outbound policy remains before posting.
      return {status:'approved',outputKind:question ? 'question' : 'answer',answer:question ? r.question : r.answer,...worker,supplements:undefined}
    }
    const round = j.turns?.at(-1)?.replyId
    // A reply after merged messages is a new post, not a replay of the earlier one.
    const delivery = j.outputKind === 'question' || round || j.supplementId ?
      JSON.stringify([key,j.outputKind,round,...j.supplementId ? [j.supplementId] : []]) : key
    const idempotencyKey = 'sa-' + createHash('sha256').update(delivery).digest('hex').slice(0,40)
    const r = await deliver({...pick(base,['caseId','messageId','source','signal','requesterId']),text:j.answer,idempotencyKey})
    if (!validReceipt(r,j) || j.turns?.some(t=>t.questionId === r.messageId || t.replyId === r.messageId))
      return {status:'uncertain',reason:'delivery-uncertain'}
    const receipt = pick(r,['chatId','messageId','inReplyTo'])
    if (j.outputKind === 'question') return {status:'waiting-requester',receipt,turns:[...(j.turns ?? []),{questionId:r.messageId}]}
    return {status:'delivered',receipt}
  }
  // Merge message job m into target t: t's worker continues in its own session with m as a supplement.
  // Running work is interrupted, an unsent draft is discarded, and a posted reply in the same thread reopens.
  function merged(t,m,info) {
    if (!info || info.archived) return
    // A requester's reply the worker has not yet taken in rides along ahead of the new message.
    const last = t.turns?.at(-1)
    const pending = ['assigned','working'].includes(t.status) && !t.supplements && last?.reply !== undefined && last.replyId
      ? [{messageId:last.replyId,text:last.reply,...user(t.requesterId) && {senderId:t.requesterId}}] : []
    let next = {...t,status:'assigned',attempt:0,supplementId:m.messageId,
      supplements:[...(t.supplements ?? []),...pending,{messageId:m.messageId,text:m.text,...m.requesterId && {senderId:m.requesterId}}].slice(-20),
      ...m.workerContext !== undefined && {workerContext:m.workerContext},workerImages:joinImages(t.workerImages,m.workerImages)}
    delete next.answer; delete next.outputKind; delete next.workerProof; delete next.reason; delete next.receipt
    // A question still waiting for the requester is withdrawn; answered rounds stay on record.
    if (t.status === 'waiting-requester') next.turns = t.turns.slice(0,-1)
    // A posted reply kept no intake; the case record and current team stand in.
    if (t.status === 'delivered') next = {...next,...pick(info,['text','team','roleModels']),...user(info.requesterId) && {requesterId:info.requesterId}}
    if (next.turns && !next.turns.length) delete next.turns
    next = transition(next,{})
    return validJob(next) ? next : undefined
  }

  async function step(lane) {
    const claim = await locked(async s => {
      if (signal.aborted) return
      const i = s.jobs.findIndex(lanes[lane].status)
      if (i < 0) return
      const current = s.jobs[i].status, status = starting.get(current)
      if (current === 'approved') {
        let required = true
        try { required = (await isReleaseRequired()) !== false } catch { /* Unable to verify opt-out: ask the owner. */ }
        if (signal.aborted) return
        if (required) {
          await update(s,i,{status:'awaiting-release',releaseNonce:randomUUID()})
          return {paused:true}
        }
      }
      const j = await update(s,i,{status,...(status === 'working' ? {attempt:s.jobs[i].attempt+1} : {})})
      return {i,j}
    })
    if (!claim) return false
    if (claim.paused) return true
    const {i,j} = claim
    const own = new AbortController()
    if (lane === 'work') running = {key:keyOf(j),controller:own}
    let patch
    if (signal.aborted) patch = stopped('interrupted')
    else try {
      patch = await execute(j,AbortSignal.any([signal,own.signal]))
    } catch (e) {
      if (j.status === 'delivering') patch = e?.code === 'delivery-denied' ? stopped('delivery-denied') :
        {status:'uncertain',reason:'delivery-uncertain'}
      else if (accessErrors.has(e?.code)) patch = stopped('access-denied')
      else if (j.status === 'working' && e?.code !== 'AUTOMATION_UNAVAILABLE') patch = {status:'uncertain',reason:'work-uncertain'}
      else patch = stopped(({deciding:'decision-failed',working:'work-failed'})[j.status])
    } finally { if (lane === 'work') running = undefined }
    if (patch.merge) {
      const info = await caseInfo(patch.merge.caseId,patch.merge.messageId)
      await locked(async s => {
        if (s.jobs[i] !== j) return
        const t = s.jobs.findIndex(x => keyOf(x) === patch.merge.key), target = s.jobs[t]
        const open = target && related(s,j).includes(target) && info && !info.archived
        const next = open && merged(target,j,info)
        const jobs = s.jobs.slice()
        // A target that finished or was archived meanwhile: route this message again without it.
        // One that cannot take this message stops it rather than offering the same choice again.
        if (!next) jobs[i] = transition(j,open ? stopped('invalid-decision') : {status:'queued',retries:(j.retries ?? 0)+1})
        else {
          jobs[t] = next
          jobs[i] = transition(j,{status:'merged',mergedInto:{caseId:target.caseId,messageId:target.messageId}})
        }
        await commit(jobs)
        if (next && running?.key === keyOf(target)) running.controller.abort()
      })
    } else {
      // A takeover or a merge during the step wins over this step's outcome.
      await locked(s => s.jobs[i] !== j ? s.jobs[i] : update(s,i,patch))
    }
    void drain().catch(()=>{})
    return true
  }
  // Resolves once both lanes are idle, including work one lane hands to the other.
  async function settled() {
    for (let busy; (busy = Object.values(lanes).map(l=>l.runner).filter(Boolean)).length;) await Promise.all(busy)
  }
  function drain() {
    if (signal.aborted) return settled()
    for (const [name,lane] of Object.entries(lanes)) {
      lane.requested = true
      if (!lane.runner) lane.runner = (async () => {
        try {
          do {
            lane.requested = false
            while (!signal.aborted && await step(name)) { /* FIFO per lane, one external effect at a time */ }
          } while (lane.requested && !signal.aborted)
        } finally { lane.runner = undefined }
      })()
    }
    return settled()
  }
  async function enqueue(input) {
    if (signal.aborted) fail('loop-disposed')
    const j = incoming(input)
    const row = await locked(async s => {
      if (signal.aborted) fail('loop-disposed')
      const seen = s.jobs.find(x => x.messageId === j.messageId && (x.source.scopeId === j.source.scopeId || x.caseId === j.caseId))
      if (seen) {
        if (seen.caseId !== j.caseId || !sameSource(seen.source,j.source) || seen.requesterId && j.requesterId && seen.requesterId !== j.requesterId)
          fail('request-conflict')
        return projection(seen)
      }
      await commit([...s.jobs,j])
      return projection(j)
    })
    // A sync callback may hold the source lock. Never wait for an actor while accepting an event.
    void drain().catch(() => {})
    return row
  }
  async function release(command,validate) {
    if (!only(command,releaseFields)) fail('invalid-input')
    const {caseId,messageId,action,token} = command
    if (!ref(caseId) || !message(messageId) || !['send','decline'].includes(action) || !matches(token,/^[a-f0-9]{64}$/)) fail('invalid-input')
    if (typeof validate !== 'function') fail('admission-denied')
    const index = s => {
      if (signal.aborted) fail('loop-disposed')
      const i = s.jobs.findIndex(j=>j.status === 'awaiting-release' && j.caseId === caseId &&
        j.messageId === messageId && releaseToken(j) === token)
      if (i < 0) fail('release-stale')
      return i
    }
    // Admission can hold its own lock while enqueuing. Check it OUTSIDE the loop lock, then CAS the same request.
    const {source,requesterId} = await locked(s=>structuredClone(pick(s.jobs[index(s)],['source','requesterId'])))
    // Declining posts nothing, so it stays possible after access was revoked.
    if (action === 'send' && await validate(source,signal,requesterId) === false) fail('admission-denied')
    const row = await locked(async s=>projection(await update(s,index(s),action === 'send'
      ? {status:'released',releaseProof:token} : {status:'declined'})))
    if (action === 'send') void drain().catch(()=>{})
    return row
  }
  // Host-only. The adapter verifies live identity, original intake, grant and reply parent before this CAS.
  function waitingQuestions(binding) {
    return locked(s=>s.jobs.filter(j=>j.status === 'waiting-requester' && sameBinding(j,binding)).map(j=>({
      ...structuredClone(pick(j,['caseId','source','messageId','requesterId'])),questionId:j.receipt.messageId,originalText:j.text
    })))
  }
  async function resumeQuestion(job,reply) {
    const w = structuredClone(job), r = structuredClone(reply)
    if (!sourceOK(w?.source) || !ref(w.caseId) || !message(w.messageId) || !user(w.requesterId) || !message(w.questionId) ||
        r?.chatId !== w.source.chatId || r.threadId !== w.source.threadId || r.senderId !== w.requesterId ||
        r.parentId !== w.questionId || !message(r.messageId) || [w.questionId,w.messageId,w.source.threadId].includes(r.messageId) ||
        !time(r.at) || !prose(r.text,65536) || !workerContextOK(r.workerContext) || !imagesOK(r.workerImages)) fail('invalid-input')
    const changed = await locked(async s=>{
      if (signal.aborted) fail('loop-disposed')
      const i = s.jobs.findIndex(j=>j.status === 'waiting-requester' && j.caseId === w.caseId && j.messageId === w.messageId &&
        sameSource(j.source,w.source) && j.requesterId === w.requesterId && j.receipt.messageId === w.questionId)
      if (i < 0) return false
      const j = s.jobs[i]
      if (s.jobs.some(x=>sameBinding(x,j.source) && x.source.chatId === r.chatId &&
          (x.messageId === r.messageId || x.receipt?.messageId === r.messageId ||
           x.turns?.some(t=>t.questionId === r.messageId || t.replyId === r.messageId)))) return false
      const turn = {questionId:w.questionId,replyId:r.messageId,question:j.answer,reply:r.text}
      await update(s,i,{status:'assigned',attempt:0,...pick(r,['workerContext']),workerImages:joinImages(j.workerImages,r.workerImages),
        turns:[...j.turns.slice(0,-1),turn]})
      return true
    })
    if (changed) void drain().catch(()=>{})
    return changed
  }
  // Owner-only. No worker role: route again. A worker role: start that worker again on its own session.
  async function retry(command,fallback) {
    if (!only(command,['caseId','messageId']) || !ref(command.caseId) || !message(command.messageId)) fail('invalid-input')
    const row = await locked(async s=>{
      if (signal.aborted) fail('loop-disposed')
      const i = s.jobs.findIndex(j=>j.caseId === command.caseId && j.messageId === command.messageId), j = s.jobs[i]
      if (!j || !retryable(j)) fail('retry-unavailable')
      const worker = workerRoles.includes(j.role)
      // Older failed records dropped their intake; the case history and current team settings stand in.
      const intake = Object.hasOwn(j,'text') ? pick(j,intakeKeys) : {...pick(fallback ?? {},['text','team','roleModels']),
        ...user(fallback?.requesterId) && {requesterId:fallback.requesterId}}
      // The worker keeps the preset it was assigned, even if the team settings changed since.
      if (worker && intake.team) intake.team = {...intake.team,[j.role]:j.presetId}
      const next = {...pick(j,['caseId','messageId','source',...worker ? ['role','presetId','criteria','sessionId','workspaceId','resolvedPresetId','targetWorkspaceId'] : []]),
        ...structuredClone(intake),status:worker ? 'assigned' : 'queued',attempt:0,retries:(j.retries ?? 0)+1,updatedAt:Date.now(),
        ...worker && j.turns && {turns:j.turns.map(t=>pick(t,['questionId','replyId']))}}
      if (!validJob(next)) fail('retry-unavailable')
      const jobs = s.jobs.slice()
      jobs[i] = next
      await commit(jobs)
      return projection(next)
    })
    void drain().catch(()=>{})
    return row
  }
  // Owner-only. The worker session becomes an ordinary DSH session; SuperAgent stops and posts nothing more.
  async function takeOver(command,sessionId,workspaceId) {
    if (!only(command,['caseId','messageId']) || !ref(command.caseId) || !message(command.messageId) ||
        !ref(sessionId) || !ref(workspaceId)) fail('invalid-input')
    return locked(async s=>{
      if (signal.aborted) fail('loop-disposed')
      const i = s.jobs.findIndex(j=>j.caseId === command.caseId && j.messageId === command.messageId), j = s.jobs[i]
      if (!j || !takeable(j) || j.sessionId && j.sessionId !== sessionId || j.workspaceId && j.workspaceId !== workspaceId) fail('takeover-unavailable')
      // An unanswered question is withdrawn with the rest of the automatic work.
      const turns = j.turns?.filter(t=>t.replyId)
      const next = transition(j,{status:'taken-over',sessionId,workspaceId,turns:turns?.length ? turns : undefined})
      for (const k of ['answer','outputKind','receipt','reason']) delete next[k]
      if (!next.turns) delete next.turns
      if (!validJob(next)) fail('takeover-unavailable')
      const jobs = s.jobs.slice()
      jobs[i] = next
      await commit(jobs)
      if (running?.key === keyOf(j)) running.controller.abort()
      return projection(next)
    })
  }
  return {enqueue,drain,release,retry,takeOver,waitingQuestions,resumeQuestion,
    jobInputs:()=>locked(s=>s.jobs.map(j=>structuredClone(pick(j,['caseId','messageId','source','retries'])))),
    takenOverSessions:()=>locked(s=>s.jobs.filter(j=>j.status === 'taken-over').map(j=>j.sessionId)),
    hasIntake:(scopeId,messageId)=>locked(s=>s.jobs.some(j=>j.source.scopeId===scopeId && j.messageId===messageId)),
    hasReceived:(b,chatId,id)=>locked(s=>s.jobs.some(j=>sameBinding(j,b) && j.source.chatId===chatId && j.messageId===id)),
    isQuestionReceipt:(b,chatId,id)=>locked(s=>s.jobs.some(j=>sameBinding(j,b) && j.source.chatId === chatId && questionSeen(j,id))),
    isSentMessage:(b,chatId,id)=>locked(s=>s.jobs.some(j=>sameBinding(j,b) && j.source.chatId === chatId &&
      (j.status === 'delivered' && j.receipt.messageId === id || questionSeen(j,id)))),
    snapshot:() => locked(s => s.jobs.map(projection)),
    async dispose() {
      controller.abort()
      try { await settled() } finally { await tail }
    }}
}
