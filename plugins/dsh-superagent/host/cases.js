import { randomUUID } from 'node:crypto'
import { builtinIds, helperDescription, helperId, helperName, maxHelpers } from './helpers.js'

const roles = ['lead', 'develop', 'answer']
const newState = () => ({ schema: 1, team: { lead: '', develop: '', answer: '' }, roleModels: {}, cases: [] })
const copy = structuredClone
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
const body = value => typeof value === 'string' && value.length <= 65536 && !!value.trim()
const keysOnly = (obj, keys) => object(obj) && Object.keys(obj).every(key => keys.includes(key))
const errors = {
  'invalid-input': '请求内容无效。',
  'preset-unavailable': '绑定的预设不可用。',
  'roster-unavailable': '无法读取可用预设。',
  'case-not-found': '事项不存在。',
  'request-conflict': '这次提交与已有记录不一致。',
  'case-busy': '上一条委托仍在交给 DSH。',
  'dispatch-uncertain': '上一条委托的交接结果未确认，请先核对原生会话。',
  'storage-unavailable': '无法读取或保存事项记录。',
  'case-archived': '该话题的事项已归档。',
}
function fail(code) { throw Object.assign(new Error(errors[code]), { code }) }
const expect = condition => { if (!condition) fail('invalid-input') }

function modelChoice(value) {
  if (value?.inherit === true) {
    expect(keysOnly(value, ['inherit','effort']) && id(value.effort))
    return { inherit: true, effort: value.effort }
  }
  expect(keysOnly(value, ['provider','model','name','effort']) && id(value.provider) && id(value.model))
  expect(value.effort === undefined || value.effort === '' || id(value.effort))
  expect(value.name === undefined || typeof value.name === 'string' && value.name.length <= 512)
  return { provider: value.provider, model: value.model, name: value.name || value.model, effort: value.effort || '' }
}

const isTeam = t => object(t) && roles.every(role => t[role] === '' || id(t[role])) &&
  Object.entries(t).every(([k,v]) => (k === 'lead' || helperId(k)) && (v === '' || id(v)))
// Each built-in helper exactly once, plus owner-added helpers in the order they were added.
const helpersOf = s => s.helpers ?? builtinIds.map(id => ({ id }))
const helpersOK = list => Array.isArray(list) && list.length <= maxHelpers && new Set(list.map(h => h?.id)).size === list.length &&
  builtinIds.every(b => list.some(h => h?.id === b)) && list.every(h => object(h) && helperId(h.id) && (h.disabled === undefined || h.disabled === true) &&
    (builtinIds.includes(h.id) ? keysOnly(h,['id','disabled']) :
      keysOnly(h,['id','name','description','disabled']) && helperName(h.name) && helperDescription(h.description)))
// The thread lines handed to the assistants, as they saw them: anonymized speaker, time and text.
const contextOK = rows => Array.isArray(rows) && rows.length <= 500 && rows.every(r => keysOnly(r,['speaker','at','text','request']) &&
  typeof r.speaker === 'string' && /^(?:requester|owner|participant-\d{1,4})$/.test(r.speaker) && Number.isFinite(r.at) &&
  typeof r.text === 'string' && r.text.length <= 65536 && (r.request === undefined || r.request === true))
function intakeContext(value) {
  if (typeof value !== 'string' || !value) return undefined
  try { const rows = JSON.parse(value); return contextOK(rows) && rows.length ? rows : undefined } catch { return undefined }
}
function validCase(c) {
  if (!id(c?.id) || !object(c.source) || !Number.isFinite(c.createdAt) || !Number.isFinite(c.updatedAt)) return false
  if (c.archivedAt !== undefined && !Number.isFinite(c.archivedAt)) return false
  if (c.source.kind !== 'local' && !(c.source.kind === 'feishu' && ['tenantId','recipientId','chatId','threadId'].every(k => id(c.source[k])))) return false
  if (!(c.sessionId === null && c.workspaceId === null || id(c.sessionId) && id(c.workspaceId))) return false
  if (!Array.isArray(c.messages) || !c.messages.length || c.status !== c.messages.at(-1)?.status ||
      !c.messages.every(m => id(m?.requestId) && body(m.text) && Number.isFinite(m.at) &&
        (m.kind === 'feishu' ? c.source.kind === 'feishu' && id(m.senderId) && m.status === 'received' && (m.context === undefined || contextOK(m.context)) :
          m.kind === 'local' && ['dispatching','submitted','failed','uncertain'].includes(m.status)))) return false
  return c.team === null ? c.source.kind === 'feishu' && c.sessionId === null && c.lane === null && c.workerRole === null && c.messages.every(m => m.kind === 'feishu') :
    isTeam(c.team) && roles.includes(c.lane) && roles.includes(c.workerRole) && object(c.roleModels) &&
      (c.resolvedPresetId === undefined || id(c.resolvedPresetId))
}
const safeErrors = new Set(['SOURCE_NOT_ALLOWED','INVALID_REQUEST','EXECUTOR_UNAVAILABLE','PRESET_UNAVAILABLE',
  'MODEL_UNAVAILABLE','SESSION_MISMATCH','SESSION_UNAVAILABLE','WORKSPACE_UNAVAILABLE','PROMPT_UNCERTAIN'])
// One Feishu topic is one case, whichever grant admitted each of its messages.
const sameTopic = (a,b) => a.kind === 'feishu' && a.tenantId === b.tenantId && a.recipientId === b.recipientId && a.chatId === b.chatId && a.threadId === b.threadId
const sameInbox = (a,b) => a.kind === 'feishu' && a.scopeId === b.scopeId && a.tenantId === b.tenantId && a.recipientId === b.recipientId && a.chatId === b.chatId
const replaceCase = (s,c) => ({ ...s, cases: [c, ...s.cases.filter(other => other.id !== c.id)] })
const view = ({ team,roleModels,cases }) => copy({ team,roleModels,cases })
const teamView = s => copy({ team:s.team, roleModels:s.roleModels, helpers:helpersOf(s).map(h => ({ id:h.id, builtin:builtinIds.includes(h.id),
  disabled:h.disabled === true, ...(h.name ? { name:h.name, description:h.description } : {}) })) })

// load/save own one private, atomically replaced document; only the Host source adapter calls receive.
export function createCases({ load, save, listPresets, executor, now = Date.now }) {
  let cached, queue = Promise.resolve()
  const inFlight = new Set()

  async function commit(next) {
    try { await save(next) } catch { cached = undefined; fail('storage-unavailable') }
    cached = next
  }
  async function state() {
    if (cached) return cached
    let stored
    try { stored = await load() } catch { fail('storage-unavailable') }
    if (stored === undefined) return cached = newState()
    if (stored?.schema !== 1 || !isTeam(stored.team) || !object(stored.roleModels) || stored.helpers !== undefined && !helpersOK(stored.helpers) ||
        !Array.isArray(stored.cases) || !stored.cases.every(validCase)) fail('storage-unavailable')
    // A crash between Host commit and DSH acknowledgement must never replay the prompt.
    let interrupted = false
    const cases = stored.cases.map(c => {
      if (!c.messages.some(m => m.status === 'dispatching' && !inFlight.has(m.requestId))) return c
      interrupted = true
      const messages = c.messages.map(m => m.status === 'dispatching' && !inFlight.has(m.requestId)
        ? { ...m, status: 'uncertain', error: 'PROMPT_UNCERTAIN' } : m)
      return { ...c, messages, status: messages.at(-1).status }
    })
    if (interrupted) await commit({ ...stored, cases })
    else cached = stored
    return cached
  }
  function locked(fn) {
    const work = queue.then(state).then(fn)
    queue = work.catch(() => {})
    return work
  }
  async function roster() {
    let rows
    try { rows = await listPresets() } catch { fail('roster-unavailable') }
    if (!Array.isArray(rows)) fail('roster-unavailable')
    return rows
  }
  function checkPreset(rows, presetId) {
    if (!rows.some(r => r?.id === presetId && r.broken === undefined)) fail('preset-unavailable')
  }
  // Initialize only missing bindings; once saved, selecting native defaults is a lasting owner choice.
  function initializeRoles(defaults) {
    return locked(async s => {
      if (s.roleDefaultsApplied) return
      const {team:initial,roleModels:models}=await defaults()
      const team={...s.team}, roleModels={...s.roleModels}
      for(const role of roles) {
        if (!team[role] && initial[role]) team[role]=initial[role]
        if (!roleModels[role] && models[role]) roleModels[role]=modelChoice(models[role])
      }
      await commit({...s,team,roleModels,roleDefaultsApplied:true})
    })
  }
  function setReleasePolicy({required}) {
    return locked(async s => {
      expect(typeof required==='boolean')
      if ((s.releaseRequired ?? true)!==required) await commit({...s,releaseRequired:required})
      return {releaseRequired:required}
    })
  }
  // One helper change: add, edit or remove an owner-added helper, or switch any helper on or off.
  function changeHelpers(helpers, team, roleModels, op) {
    const name = typeof op.name === 'string' ? op.name.trim() : op.name
    const description = typeof op.description === 'string' ? op.description.trim() : op.description
    if (op.action === 'add') {
      expect(keysOnly(op,['action','name','description']) && helperName(name) && helperDescription(description) && helpers.length < maxHelpers)
      let helper
      do helper = 'helper-' + randomUUID().slice(0,8); while (helpers.some(h => h.id === helper))
      team[helper] = ''
      return [...helpers, { id:helper, name, description }]
    }
    const h = helpers.find(x => x.id === op.id), custom = !!h && !builtinIds.includes(h.id)
    expect(!!h)
    if (op.action === 'edit') {
      expect(custom && keysOnly(op,['action','id','name','description']) && helperName(name) && helperDescription(description))
      return helpers.map(x => x === h ? { ...x, name, description } : x)
    }
    if (op.action === 'enable' || op.action === 'disable') {
      expect(keysOnly(op,['action','id']))
      return helpers.map(x => x !== h ? x : op.action === 'disable' ? { ...x, disabled:true } : (({ disabled, ...rest }) => rest)(x))
    }
    expect(op.action === 'remove' && custom && keysOnly(op,['action','id']))
    delete team[h.id]; delete roleModels[h.id]
    return helpers.filter(x => x !== h)
  }
  async function configure(patch) {
    expect(keysOnly(patch, ['team','roleModels','helper']))
    const patchTeam = patch.team === undefined ? {} : patch.team
    const patchModels = patch.roleModels === undefined ? {} : patch.roleModels
    expect(object(patchTeam) && object(patchModels) && (patch.helper === undefined || object(patch.helper)))
    return locked(async s => {
      const team = { ...s.team }, roleModels = { ...s.roleModels }
      const helpers = patch.helper ? changeHelpers(helpersOf(s), team, roleModels, patch.helper) : helpersOf(s)
      const keys = ['lead', ...helpers.map(h => h.id)]
      expect(keysOnly(patchTeam, keys) && keysOnly(patchModels, keys))
      const entries = Object.entries(patchTeam)
      const rows = entries.some(([,v]) => !!v) ? await roster() : []
      for (const [role, presetId] of entries) {
        expect(presetId === '' || id(presetId))
        if (presetId) checkPreset(rows, presetId)
        team[role] = presetId
      }
      for (const [role, setting] of Object.entries(patchModels)) {
        if (setting === null) delete roleModels[role]
        else roleModels[role] = modelChoice(setting)
      }
      await commit({ ...s, team, roleModels, ...(patch.helper || s.helpers ? { helpers } : {}) })
      return teamView(cached)
    })
  }
  function newCase(source,text,at) {
    return { id: randomUUID(), title: text.trim().split(/\r?\n/,1)[0].slice(0,100), source, lane: null,
      workerRole: null, team: null, roleModels: {}, sessionId: null, workspaceId: null,
      status: 'received', createdAt: at, updatedAt: at, messages: [] }
  }

  // Older records filed a request that quoted another message under the quoted root; the thread that grew
  // from such a request is still its topic.
  const inTopic = (c,source) => sameTopic(c.source,source) || sameTopic(c.source,{...source,threadId:c.source.threadId}) &&
    c.messages.some(m => m.kind === 'feishu' && m.requestId === source.threadId)
  const latestInTopic = (s,source) => s.cases.filter(c => inTopic(c,source)).reduce((a,c) => !a || c.createdAt > a.createdAt ? c : a, undefined)
  // Whether a topic's case was archived: its later messages are neither recorded nor handled.
  function isArchivedTopic(source) {
    return locked(s => latestInTopic(s,{kind:'feishu',...source})?.archivedAt !== undefined)
  }
  // Untrusted external text is history, never execution authority or a delivery receipt.
  async function receive(event,scopeId,feedScopeId) {
    expect(feedScopeId === undefined || typeof feedScopeId === 'string' && /^[a-f0-9]{64}$/.test(feedScopeId))
    expect(scopeId === undefined || typeof scopeId === 'string' && /^[a-f0-9]{64}$/.test(scopeId))
    expect(object(event) && ['tenantId','recipientId','chatId','threadId','messageId','senderId'].every(k => id(event[k])) && body(event.text))
    const { tenantId,recipientId,chatId,threadId,messageId,senderId,text } = event
    const source = { kind:'feishu', tenantId,recipientId,chatId,threadId,...(scopeId ? {scopeId} : {}) }
    return locked(async s => {
      const seen = s.cases.find(c => (sameInbox(c.source,source) || inTopic(c,source)) &&
        c.messages.some(m => m.kind === 'feishu' && m.requestId === messageId))
      if (seen) return copy(seen)
      const at = now()
      // Later messages of a topic join its latest case; an archived topic takes no new messages.
      const topic = latestInTopic(s,source)
      if (topic?.archivedAt !== undefined) fail('case-archived')
      const c = topic ?? newCase(source,text,at)
      const context = intakeContext(event.workerContext)
      const message = { kind:'feishu', requestId:messageId, senderId, text, at, status:'received', ...(context ? {context} : {}) }
      const next = { ...c, ...(feedScopeId ? {feedScopeId} : {}), messages: [...c.messages, message], updatedAt:at, status:message.status }
      await commit(replaceCase(s,next))
      return copy(next)
    })
  }

  async function intake(input) {
    expect(keysOnly(input,['requestId','caseId','text','lane']) && id(input.requestId) && body(input.text))
    const { requestId,caseId,text,lane } = input
    expect((caseId === undefined || id(caseId)) && (lane === undefined || roles.includes(lane)))
    const prepared = await locked(async s => {
      for (const c of s.cases) {
        const previous = c.messages.find(m => m.kind === 'local' && m.requestId === requestId)
        if (!previous) continue
        const originalTarget = c.source.kind === 'local' && c.messages[0] === previous ? undefined : c.id
        if (originalTarget !== caseId || previous.text !== text || (lane && c.lane !== lane)) fail('request-conflict')
        return { duplicate:copy(c) }
      }
      const at = now()
      let c = caseId ? s.cases.find(item => item.id === caseId) : newCase({kind:'local'},text,at)
      if (!c) fail('case-not-found')
      if (c.lane && lane && lane !== c.lane) fail('request-conflict')
      if (c.messages.some(m => m.status === 'dispatching')) fail('case-busy')
      if (c.messages.some(m => m.status === 'uncertain')) fail('dispatch-uncertain')
      if (!c.team) {
        const selected = lane || 'lead'
        const rows = Object.values(s.team).some(Boolean) ? await roster() : []
        if (s.team[selected]) checkPreset(rows,s.team[selected])
        const teamNames = Object.fromEntries(roles.map(role => {
          const row = rows.find(r => r?.id === s.team[role])
          return [role, typeof row?.name === 'string' && row.name.trim() || s.team[role]]
        }))
        c = { ...c, lane:selected, workerRole:selected, team:copy(s.team), teamNames, roleModels:copy(s.roleModels) }
      }
      const message = { kind:'local', requestId,text,at,status:'dispatching' }
      const next = { ...c, messages:[...c.messages,message], status:message.status, updatedAt:at }
      await commit(replaceCase(s,next))
      inFlight.add(requestId)
      return { caseId:next.id, sessionId:next.sessionId ?? undefined, requestId,text,
        presetId:next.team[next.workerRole] || next.resolvedPresetId, model:copy(next.resolvedModel || next.roleModels[next.workerRole] || null), sourceKind:'local' }
    })
    if (prepared.duplicate) return prepared.duplicate

    // Do not hold the store lock while DSH handles another case.
    let receipt, error
    try {
      if (typeof executor?.submit !== 'function') throw { code:'EXECUTOR_UNAVAILABLE' }
      receipt = await executor.submit(prepared)
    } catch (e) { error = e || {} }
    try {
      return await locked(async s => {
        const c = s.cases.find(row => row.id === prepared.caseId)
        if (!c) fail('storage-unavailable')
        const result = error || receipt
        const linked = id(result?.sessionId) && id(result.workspaceId) &&
          (!c.sessionId || c.sessionId === result.sessionId && c.workspaceId === result.workspaceId)
        const submitted = !error && receipt?.accepted === true && linked
        const knownError = safeErrors.has(error?.code)
        const status = submitted ? 'submitted' : knownError && error.status !== 'unknown' && error.code !== 'PROMPT_UNCERTAIN' ? 'failed' : 'uncertain'
        const code = knownError ? error.code : 'PROMPT_UNCERTAIN'
        const messages = c.messages.map(m => m.kind === 'local' && m.requestId === requestId
          ? { ...m, status, ...(submitted ? {} : { error:code }) } : m)
        const next = { ...c, messages, status:messages.at(-1).status, updatedAt:now() }
        if (linked && (knownError || submitted)) {
          next.sessionId = result.sessionId
          next.workspaceId = result.workspaceId
          if (!c.team[c.workerRole] && !c.resolvedPresetId && id(result.resolvedPresetId)) next.resolvedPresetId = result.resolvedPresetId
        }
        if (submitted && id(receipt.resolvedModel?.provider) && id(receipt.resolvedModel.model)) {
          const { provider, model, effort } = receipt.resolvedModel
          next.resolvedModel = { provider, model, effort:id(effort) ? effort : '' }
        }
        inFlight.delete(requestId)
        await commit(replaceCase(s,next))
        return copy(next)
      })
    } finally { inFlight.delete(requestId) }
  }

  // Archiving only hides the case from the case list; its work and activity stay as they are.
  function archive(input) {
    expect(keysOnly(input,['caseId']) && id(input.caseId))
    return locked(async s => {
      const c = s.cases.find(item => item.id === input.caseId)
      if (!c) fail('case-not-found')
      if (c.archivedAt === undefined) await commit({ ...s, cases: s.cases.map(item => item === c ? { ...c, archivedAt: now() } : item) })
      return { caseId: c.id }
    })
  }
  // Older failed work dropped its intake; retry rebuilds it from the case message and current team settings.
  function retryIntake(caseId,messageId) {
    return locked(s => {
      const m = s.cases.find(item => item.id === caseId)?.messages.find(row => row.kind === 'feishu' && row.requestId === messageId)
      if (!m) fail('case-not-found')
      return copy({ text: m.text, requesterId: m.senderId, team: s.team, roleModels: s.roleModels })
    })
  }

  return { snapshot:() => locked(view), teamSettings:() => locked(teamView), configure, intake, receive, archive, retryIntake,
    settled:()=>queue,initializeRoles,isArchivedTopic,setReleasePolicy,isReleaseRequired:()=>locked(s=>s.releaseRequired!==false) }
}
