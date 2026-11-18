import { z } from 'zod'

export const SPEEDS = ['standard', 'fast', 'ultrafast']
const speedSchema = z.enum(SPEEDS)
const RECEIPT = 'Codex Provider speed: '

export function splitServiceTier(id) {
  const at = id.lastIndexOf('@')
  return at > 0 && at < id.length - 1 ? { model: id.slice(0, at), serviceTier: id.slice(at + 1) } : { model: id, serviceTier: undefined }
}

export function legacySpeed(model) {
  const tier = splitServiceTier(model).serviceTier
  return tier === 'ultrafast' ? 'ultrafast' : tier === 'priority' ? 'fast' : 'standard'
}

export function parseSpeed(input) {
  const arg = input.trim().toLowerCase()
  const choices = { '': 'toggle', on: 'fast', off: 'standard', standard: 'standard', fast: 'fast', ultra: 'ultrafast', ultrafast: 'ultrafast' }
  return Object.hasOwn(choices, arg) ? choices[arg] : undefined
}

export function speedReceipt(selected) {
  return `${RECEIPT}${selected}.\n`
}

// Capabilities only downgrade a selection; an unknown model cannot enable a paid tier.
export function resolveSpeed(selected, metadata) {
  const tiers = new Set(metadata?.serviceTiers?.map(tier => tier.id))
  const actual = selected === 'ultrafast' && tiers.has('ultrafast') ? 'ultrafast'
    : selected !== 'standard' && tiers.has('priority') ? 'fast' : 'standard'
  return { selected, actual, serviceTier: actual === 'ultrafast' ? 'ultrafast' : actual === 'fast' ? 'priority' : undefined }
}

const lastUsedSchema = z.object({ model: z.string(), selected: speedSchema, actual: speedSchema }).nullable()

export const speedProjection = {
  key: 'codexSpeed',
  stateVersion: 1,
  stateSchema: z.object({
    selected: speedSchema.nullable(), selectedAt: z.number(),
    running: z.array(z.object({ id: z.string(), seq: z.number(), wanted: z.string() })),
    lastUsed: lastUsedSchema,
  }),
  init: () => ({ selected: null, selectedAt: -1, running: [], lastUsed: null }),
  apply(state, event) {
    const { data } = event
    if (event.type === 'command/run' && data.name === 'fast' && typeof data.args === 'string') {
      const wanted = parseSpeed(data.args)
      if (wanted === undefined) return state
      return { ...state, running: [...state.running, { id: data.commandId, seq: event.seq, wanted }] }
    }
    if (event.type === 'command/done') {
      const run = state.running.find(entry => entry.id === data.commandId)
      if (!run) return state
      const selected = SPEEDS.find(speed => data.text?.startsWith(speedReceipt(speed)))
      const accepted = data.kind === 'success' && selected !== undefined
        && (run.wanted === 'toggle' ? selected !== 'ultrafast' : selected === run.wanted) && run.seq > state.selectedAt
      return { ...state, running: state.running.filter(entry => entry !== run),
        ...(accepted ? { selected, selectedAt: run.seq } : {}) }
    }
    if (event.type === 'assistant/message' && data.message.source?.provider === 'codex-provider') {
      const codex = data.message.source.replayState?.response?.codex
      const parsed = lastUsedSchema.safeParse(codex?.speed)
      if (parsed.success && parsed.data !== null) return { ...state, lastUsed: parsed.data }
    }
    return state
  },
  wire: {
    viewSchema: z.object({ selected: speedSchema.nullable(), lastUsed: lastUsedSchema }),
    summary: false,
    view: state => ({ selected: state.selected, lastUsed: state.lastUsed }),
  },
}

export async function registerSpeed(ctx, adapterOf) {
  const handle = await ctx.sessionProjections.register(speedProjection)
  ctx.commands.register({
    definitionId: '@pcmid/dsh-codex-provider/fast/v1',
    name: 'fast',
    description: 'Codex speed: /fast [on|off|standard|fast|ultra|ultrafast]; no argument toggles Fast.',
    input: { hint: 'on | off | standard | fast | ultra | ultrafast' },
    async handler({ agent, rawInput, signal }) {
      const wanted = parseSpeed(rawInput)
      if (wanted === undefined) return { kind: 'error', text: 'Usage: /fast [on|off|standard|fast|ultra|ultrafast]' }
      const route = agent.model.current()
      if (route?.provider !== 'codex-provider') return { kind: 'error', text: '/fast requires a Codex Provider model.' }
      const adapter = adapterOf()
      if (!adapter) return { kind: 'error', text: 'Codex Provider is disabled.' }
      const saved = handle.stateOf(agent.session).selected ?? legacySpeed(route.model)
      const selected = wanted === 'toggle' ? saved === 'standard' ? 'fast' : 'standard' : wanted
      try {
        const model = splitServiceTier(route.model).model
        const catalog = await adapter.loadCatalog(signal)
        signal.throwIfAborted()
        const { actual } = resolveSpeed(selected, catalog.find(entry => entry.model === model))
        return { kind: 'success', text: speedReceipt(selected)
          + `Next request: ${actual} (${model}).${actual !== selected ? ' The selected speed is unavailable; using the supported lower tier.' : ''} Higher speeds may use more quota.` }
      } catch (error) {
        return { kind: 'error', text: error?.message || 'Could not read Codex speed capabilities.' }
      }
    },
  })
  return handle
}
