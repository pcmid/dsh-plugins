import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const named = value => typeof value === 'string' && value.trim().length > 0

class SubmitError extends Error {
  constructor(code, receipt) {
    super(code)
    this.code = code
    if (code === 'PROMPT_UNCERTAIN') this.status = 'unknown'
    Object.assign(this, receipt)
  }
}

function requireValue(ok, code) {
  if (!ok) throw new SubmitError(code)
}

export function modelChoice(model, inherited) {
  const useDefault = model == null || model.inherit === true
  const route = useDefault ? inherited : model
  requireValue(named(route?.provider) && named(route.model), 'MODEL_UNAVAILABLE')
  requireValue(model?.inherit !== true || (model.provider === undefined && model.model === undefined), 'MODEL_UNAVAILABLE')
  const effort = model == null ? inherited?.reasoningEffort : model.effort
  requireValue(effort === undefined || effort === '' || named(effort), 'MODEL_UNAVAILABLE')
  return { provider: route.provider, model: route.model, ...(effort ? { reasoningEffort: effort } : {}) }
}

function sameModel(a, b) {
  return a?.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

function checkHeader(header, sessionId, cwd, presetId) {
  requireValue(header?.id === sessionId && header.cwd === cwd && header.agentPreset === presetId
    && !header.origin && !header.parentSession && !header.isSeeded, 'SESSION_MISMATCH')
}

/**
 * Host-only. caseId and sourceKind come from the intake service, never directly
 * from RPC. The RPC owner gate is separate; a source label is not a credential.
 * workspacePath is a private, profile-specific directory, not the data store.
 */
export function createExecutor(ctx, { workspacePath }) {
  return { async submit({ caseId, sessionId: previous, requestId, text, presetId, model, sourceKind }) {
    requireValue(sourceKind === 'local', 'SOURCE_NOT_ALLOWED')
    requireValue(typeof caseId === 'string' && uuid.test(caseId) && named(requestId) && named(text), 'INVALID_REQUEST')
    requireValue(presetId === undefined || presetId === '' || named(presetId), 'PRESET_UNAVAILABLE')
    const sessionId = 'superagent-' + caseId
    requireValue(previous == null || previous === sessionId, 'SESSION_MISMATCH')
    let stage = 'EXECUTOR_UNAVAILABLE', receipt
    try {
      const get = key => {
        const service = ctx.get(key)
        requireValue(service, 'EXECUTOR_UNAVAILABLE')
        return service
      }
      const sessions = get('sessionController'), persistence = get('sessionPersistence'), agents = get('agents')
      const presets = get('agentPresets'), registry = get('workspaceRegistry'), cwd = get('workingDirectory')
      const llm = get('llm')

      stage = 'WORKSPACE_UNAVAILABLE'
      requireValue(typeof workspacePath === 'string' && isAbsolute(workspacePath) && basename(workspacePath), stage)
      if (previous == null) await mkdir(workspacePath, { recursive: true, mode: 0o700 })
      requireValue((await lstat(workspacePath)).isDirectory(), stage)
      const path = join(await realpath(dirname(workspacePath)), basename(workspacePath))
      const workspace = previous == null ? await registry.create(path, 'SuperAgent') : await registry.resolveByPath(path)
      requireValue(workspace?.path === path && named(workspace.id), stage)

      stage = 'SESSION_UNAVAILABLE'
      requireValue(!registry.archivedSessionIds.includes(sessionId), stage)
      const stored = await persistence.stat(sessionId)
      if (stored) requireValue(stored.formatStatus !== 'migration-required', stage)
      // An interrupted handoff may have created the session before the case saved its receipt.
      let effectivePreset = presetId || stored?.header?.agentPreset
      if (stored || effectivePreset) {
        stage = 'PRESET_UNAVAILABLE'
        requireValue(named(effectivePreset), stage)
        const preset = await presets.resolve(effectivePreset)
        requireValue(preset?.id === effectivePreset && preset.broken === undefined, stage)
      }
      stage = 'SESSION_UNAVAILABLE'
      let agent
      if (stored) {
        checkHeader(stored.header, sessionId, path, effectivePreset)
        requireValue(previous == null || workspace.sessionIds.includes(sessionId), 'SESSION_MISMATCH')
        // Native activation restores the recorded preset and Session selection.
        agent = (await sessions.resolveAgent(sessionId)).agent
        requireValue(agent, stage)
      } else {
        requireValue(previous == null && !agents.get(sessionId), stage)
      }
      stage = 'MODEL_UNAVAILABLE'
      const inherit = model == null || model.inherit === true
      const selection = modelChoice(model, !inherit ? undefined : agent
        ? agent.model.current() : get('agentDefaultModel').currentSelection())
      requireValue((await llm.listModels(selection.provider)).some(m => m.id === selection.model), stage)
      // Validates the exact effort. Do not pin an adapter-supplied default effort.
      await llm.resolveCallConfig(selection)

      const nativeDefault = !agent && !effectivePreset
      if (nativeDefault) {
        // Workspace defaults route the native create request, not agentPresets.resolve(undefined).
        stage = 'SESSION_UNAVAILABLE'
        requireValue(!await persistence.stat(sessionId) && !agents.get(sessionId) &&
          !registry.archivedSessionIds.includes(sessionId), stage)
        const created = await sessions.create({ workspaceId: workspace.id, sessionId })
        requireValue(created?.sessionId === sessionId, 'SESSION_MISMATCH')
        effectivePreset = created.agentPreset
        requireValue(named(effectivePreset), 'PRESET_UNAVAILABLE')
        agent = agents.get(sessionId)
        requireValue(agent && workspace.sessionIds.includes(sessionId), 'SESSION_MISMATCH')
      } else if (!agent) {
        stage = 'SESSION_UNAVAILABLE'
        // Unlike sessionController.create, create never substitutes a minted ID.
        const handle = await agents.create({
          sessionId, meta: { cwd: path, agentPreset: effectivePreset }, agentOptions: selection,
          setup: async (agentCtx, fresh) => {
            requireValue((await presets.mount(agentCtx, effectivePreset)).id === effectivePreset, 'PRESET_UNAVAILABLE')
            // Session-local; sessionController.selectModel would also save the global default.
            fresh.model.select(selection)
          },
        })
        agent = handle.agent
      }
      stage = 'SESSION_MISMATCH'
      const checkOwner = () => {
        checkHeader(agent.session.header, sessionId, path, effectivePreset)
        requireValue(agents.get(sessionId) === agent && agent.id === sessionId
          && presets.presetForSession(agent.session) === effectivePreset && presets.composedPreset(agent.ctx) === effectivePreset
          && cwd.get(agent.session) === path, stage)
      }
      checkOwner()
      stage = 'WORKSPACE_UNAVAILABLE'
      if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
      requireValue(workspace.sessionIds.includes(sessionId), stage)
      receipt = { sessionId, workspaceId: workspace.id, resolvedPresetId: effectivePreset }
      if (nativeDefault) {
        stage = 'MODEL_UNAVAILABLE'
        agent.model.select(selection)
      }
      stage = 'SESSION_MISMATCH'
      checkOwner()
      requireValue(!registry.archivedSessionIds.includes(sessionId), 'SESSION_UNAVAILABLE')
      requireValue(sameModel(agent.model.current(), selection), 'MODEL_UNAVAILABLE')
      stage = 'PROMPT_UNCERTAIN'
      const result = await sessions.prompt({
        sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }],
      }, new AbortController().signal)
      requireValue(result?.accepted === true, stage)
      return { ...receipt, accepted: true, resolvedModel: {
        provider: selection.provider, model: selection.model, effort: selection.reasoningEffort ?? '',
      } }
    } catch (error) {
      // Vendor diagnostics can contain request data. Export only local codes and proven addresses.
      const code = error instanceof SubmitError ? error.code :
        stage === 'SESSION_UNAVAILABLE' && ['agent-preset/not-found', 'agent-preset/invalid'].includes(error?.code) ? 'PRESET_UNAVAILABLE' : stage
      throw new SubmitError(code, receipt)
    }
  } }
}
