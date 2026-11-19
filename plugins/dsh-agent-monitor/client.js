/**
 * Browser half of @pcmid/dsh-agent-monitor. It shows what the agents of a
 * session are doing in three slots, and only displays: the strip's header
 * expands and collapses its list, and nothing acts on an agent.
 *
 * - `conversation.input.dock`: a strip above the composer, among Harness's
 *   task list and goal bar, with one row per agent of the open session. It
 *   asks the Host half's `snapshot` route when it mounts and then every two
 *   seconds while the page is visible, and draws nothing while the session's
 *   own agent is alone and has no background job and no waiting goal.
 * - `sidebar.session.row.trailing`: a mark on the sidebar row of each session
 *   whose own agent has stopped and waits on background work, which the row
 *   itself does not show. The mark is left out while the row has Harness's
 *   own spinner for a running subagent of that agent.
 * - `sidebar.session.row.hover`: the same as a line of that row's hover card.
 *
 * Every row of the sidebar reads one store, which asks the Host half's
 * `sessions` route every five seconds while a row is mounted and the page is
 * visible.
 *
 * The strip's markup, spacing, type and tokens copy Harness's task list
 * (TodoPanel), and its running and idle marks copy that list's in-progress
 * and pending marks. The sidebar mark and the hover line copy the entries
 * Harness has in those two slots. Icons reference the theme's shared icon
 * sprite.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-agent-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    const NS = 'agentMonitor'
    /** The row id in cordis.patch.yml, and this plugin's entry id in each slot. */
    const ENTRY = 'agent-monitor'
    const PREFIX = 'dsh-am'
    /** Connection RPC channel and endpoint prefix of the Host half's routes. */
    const HOST_CHANNEL = '/api'
    const HOST_API = 'pcmid/agent-monitor'
    /** How often a mounted strip asks the Host again. */
    const POLL_MS = 2000
    /** How often the sidebar asks. A row only tells that agents are at work, and a page opened through a relay pays for every request. */
    const SIDEBAR_POLL_MS = 5000
    /** Jobs listed under one agent before the rest are counted. */
    const MAX_JOBS = 3
    /** Indentation per level of the agent tree, in px. */
    const INDENT = 16
    /** Joins the header's counts as the task list joins its own: HTML collapses ASCII spaces, en spaces keep the room. */
    const SEPARATOR = '\u2002·\u2002'

    const zh = {
      title: '智能体',
      self: '本会话',
      'summary.running': '{n} 个运行中',
      'summary.waiting': '{n} 个等待后台工作',
      'summary.idle': '{n} 个空闲',
      'state.running': '运行中',
      'state.thinking': '思考中',
      'state.waiting': '等待后台工作',
      'state.queued': '有待处理的消息',
      'state.idle': '空闲',
      'jobs.more': '另有 {n} 个',
      goalWaiting: '目标：等待后台工作，之后开始下一轮',
      'sidebar.label': '智能体：{counts}',
      'duration.seconds': '{s}秒',
      'duration.minutes': '{m}分{s}秒',
      'duration.hours': '{h}小时{m}分',
    }
    const en = {
      title: 'Agents',
      self: 'This session',
      'summary.running': '{n} working',
      'summary.waiting': '{n} waiting for background work',
      'summary.idle': '{n} idle',
      'state.running': 'Working',
      'state.thinking': 'Thinking',
      'state.waiting': 'Waiting for background work',
      'state.queued': 'Has queued messages',
      'state.idle': 'Idle',
      'jobs.more': '+{n} more',
      goalWaiting: 'Goal: waiting for background work before the next round',
      'sidebar.label': 'Agents: {counts}',
      'duration.seconds': '{s}s',
      'duration.minutes': '{m}m {s}s',
      'duration.hours': '{h}h {m}m',
    }

    /* The card, header and list are the task list's (TodoPanel.module.css) under this plugin's
       prefix: the same dock column, menu material, 13px type and 10px gaps. The spinner and the
       dot are the in-progress and pending marks of Harness's StateDot. */
    const CSS = `
.${PREFIX}-root {
  box-sizing: border-box; flex: none; overflow: hidden; margin: 0 auto;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset));
  max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
  border: 0; --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter); box-shadow: var(--dsw-elevation-panel);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.${PREFIX}-body { display: flex; flex-direction: column; gap: 8px; padding: 6px 12px; }
.${PREFIX}-header {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 0; border: none; background: transparent;
  text-align: left; cursor: pointer;
}
.${PREFIX}-lead, .${PREFIX}-chevron { display: grid; flex: none; place-items: center; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-title { flex: none; font-size: 13px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.${PREFIX}-summary {
  flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 13px; line-height: 20px; font-weight: 400;
  color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap;
}
.${PREFIX}-list {
  display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; max-height: 180px; overflow-y: auto;
}
.${PREFIX}-item {
  display: flex; flex: none; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.${PREFIX}-row, .${PREFIX}-note { display: flex; align-items: center; gap: 10px; min-width: 0; }
.${PREFIX}-glyph { display: grid; flex: none; place-items: center; width: 16px; height: 16px; }
.${PREFIX}-name, .${PREFIX}-label, .${PREFIX}-doing, .${PREFIX}-note-text {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* In a narrow column the label gives way first, then what the agent is doing; the name keeps up to half the row. */
.${PREFIX}-name { flex: none; max-width: 50%; }
.${PREFIX}-label { flex: 1 1 0; color: var(--dsw-alias-label-tertiary); }
/* Without a label before it, what the agent is doing still sits at the right. */
.${PREFIX}-doing { flex: 0 1 auto; max-width: 55%; margin-left: auto; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-time { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/* Lines under an agent start below its name: past the 16px mark and the 10px gap. */
.${PREFIX}-note { padding-left: 26px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-note-text { flex: 1 1 auto; }
.${PREFIX}-dot { position: relative; display: inline-block; flex: none; width: 10px; height: 10px; color: var(--dsw-alias-state-idle-primary); }
/* A full circle opts out of the theme's superellipse corners, as Harness's own dot does. */
.${PREFIX}-dot::after { content: ''; position: absolute; inset: 20%; border-radius: 50%; corner-shape: round; background: currentColor; }
.${PREFIX}-paused { display: block; flex: none; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-spinner { flex: none; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-turn { transform-origin: center; animation: ${PREFIX}-turn 1.5s linear infinite; }
.${PREFIX}-track, .${PREFIX}-arc { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.${PREFIX}-track { opacity: 0.25; }
.${PREFIX}-arc { stroke-dasharray: 12 150; animation: ${PREFIX}-arc 1.5s ease-in-out infinite; }
@keyframes ${PREFIX}-turn { to { transform: rotate(360deg); } }
@keyframes ${PREFIX}-arc {
  0%, 100% { stroke-dasharray: 12 150; stroke-dashoffset: 0; }
  50% { stroke-dasharray: 24 150; stroke-dashoffset: -6; }
}
@media (prefers-reduced-motion: reduce) {
  .${PREFIX}-turn, .${PREFIX}-arc { animation: none; }
  .${PREFIX}-arc { stroke-dasharray: 18 150; stroke-dashoffset: -3; }
}
/* The mark among the icons at the end of a sidebar session row, sized as Harness sizes its own there: to the row's 20px line. */
.${PREFIX}-mark { display: inline-flex; flex: none; align-items: center; justify-content: center; height: 20px; color: var(--dsw-alias-label-tertiary); }
/* Text for assistive technology only, hidden as the row hides the labels of its own status dot. */
.${PREFIX}-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
/* The line in the row's hover card, laid out as the scheduled-task lines there. The card is dark in both themes, so it has label tokens of its own. */
.${PREFIX}-hover { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.${PREFIX}-hover-icon { display: inline-flex; flex: none; align-items: center; height: 16px; color: var(--dsw-alias-hovercard-label-secondary); }
/* The counts follow the title on its line, and go below it when the card is too narrow for both. */
.${PREFIX}-hover-body { display: flex; flex-wrap: wrap; gap: 2px 6px; min-width: 0; font-size: 12px; line-height: 16px; }
.${PREFIX}-hover-title { color: var(--dsw-alias-hovercard-label-primary); }
.${PREFIX}-hover-counts { min-width: 0; color: var(--dsw-alias-hovercard-label-secondary); overflow-wrap: break-word; }
`

    /**
     * Whether the strip has something to show: more than the session's own
     * agent, or that agent has a background job or a goal waiting on one.
     * @param agents - the rows of the Host's answer.
     * @returns {boolean} whether the strip is drawn.
     */
    function visible(agents) {
      return agents.length > 1 || (agents[0]?.jobs?.length ?? 0) > 0 || agents[0]?.goalWaiting === true
    }

    /**
     * Counts of agents per state, as text. Zero counts are omitted.
     * @param {{ running: number, waiting: number, idle?: number }} counts - how many agents are in each state.
     * @param t - this plugin's translate function.
     * @returns {string} for example `2 working · 1 idle`.
     */
    function countsText({ running, waiting, idle = 0 }, t) {
      return [
        ...running > 0 ? [t('summary.running', { n: running })] : [],
        ...waiting > 0 ? [t('summary.waiting', { n: waiting })] : [],
        ...idle > 0 ? [t('summary.idle', { n: idle })] : [],
      ].join(SEPARATOR)
    }

    /**
     * The header's counts per state over all agents. An agent with queued
     * messages counts as idle.
     * @param agents - the rows of the Host's answer.
     * @param t - this plugin's translate function.
     * @returns {string} the counts as {@link countsText} writes them.
     */
    function summary(agents, t) {
      const running = agents.filter(row => row.state === 'running').length
      const waiting = agents.filter(row => row.state === 'waiting').length
      return countsText({ running, waiting, idle: agents.length - running - waiting }, t)
    }

    /**
     * A duration in whole seconds, written in its two largest units.
     * @param {number} ms - milliseconds; a negative value reads as zero.
     * @param t - this plugin's translate function.
     * @returns {string} for example `42s`, `3m 5s`, `2h 7m`.
     */
    function formatElapsed(ms, t) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (hours > 0) return t('duration.hours', { h: hours, m: minutes })
      if (minutes > 0) return t('duration.minutes', { m: minutes, s: total % 60 })
      return t('duration.seconds', { s: total })
    }

    /**
     * What a row says its agent is doing: the tool call in flight of a running
     * agent, "Thinking" between calls, and otherwise the state.
     * @param row - one row of the Host's answer.
     * @param t - this plugin's translate function.
     * @returns {string} the text at the right of the row.
     */
    function rowText(row, t) {
      if (row.state !== 'running') return t(`state.${row.state}`)
      if (row.activity === undefined) return t('state.thinking')
      return row.activity.summary === undefined ? row.activity.tool : `${row.activity.tool} · ${row.activity.summary}`
    }

    /**
     * Agents as the Host describes them, as a store that components subscribe
     * to. While it has a subscriber it reads them at once and then every
     * `interval` milliseconds, skipping reads while the page is hidden. A
     * failed read keeps the last answer, and the next tick reads again.
     * `agents` is replaced only when the answer changed; `at` is the time of
     * the latest read, which elapsed times are counted to.
     * @param {() => Promise<object[]>} read - asks the Host for the agents.
     * @param {number} interval - milliseconds from one read to the next.
     * @returns {{ getSnapshot: () => { agents: object[], at: number }, subscribe: (listener: () => void) => () => void }} the store.
     */
    function createMonitor(read, interval) {
      let snapshot = { agents: [], at: 0 }
      let answer = '[]'
      let reading = false
      let timer
      const listeners = new Set()

      async function poll() {
        if (reading || document.visibilityState !== 'visible') return
        reading = true
        try {
          const agents = await read()
          const next = JSON.stringify(agents)
          snapshot = { agents: next === answer ? snapshot.agents : agents, at: Date.now() }
          answer = next
          for (const listener of [...listeners]) listener()
        } catch {
          // The last answer stays; the next tick reads again.
        } finally {
          reading = false
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            timer = setInterval(() => { void poll() }, interval)
            void poll()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) clearInterval(timer)
          }
        },
      }
    }

    /** A glyph of the theme's icon sprite, the artwork Harness's own icons use. */
    function Glyph({ name, className, size = 14 }) {
      return h('svg', { width: size, height: size, className, 'aria-hidden': true }, h('use', { href: `#dsw-icon-${name}-regular` }))
    }

    /** As Harness's loaders do: start a loader's animations at document time zero, so every visible loader turns in step. */
    function syncSpinner(element) {
      if (element === null) return
      const pin = () => {
        for (const animation of element.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0
      }
      pin()
      element.addEventListener('animationstart', pin)
    }

    /** The mark before an agent's name: a turning ring while it runs, a pause sign while it waits on background work, a dot otherwise. */
    function StateMark({ state }) {
      if (state === 'running') {
        return h('svg', { ref: syncSpinner, className: `${PREFIX}-spinner`, width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true },
          h('g', { className: `${PREFIX}-turn` },
            h('circle', { className: `${PREFIX}-track`, cx: 12, cy: 12, r: 9.5 }),
            h('circle', { className: `${PREFIX}-arc`, cx: 12, cy: 12, r: 9.5 })))
      }
      if (state === 'waiting') return h(Glyph, { name: 'pause-outline', className: `${PREFIX}-paused` })
      return h('span', { className: `${PREFIX}-dot`, 'aria-hidden': true })
    }

    /** One agent: its state, name and task, what it is doing and for how long; below, its background jobs and a waiting goal. */
    function AgentRow({ row, now, t }) {
      // Only a running or waiting agent has jobs here: the Host calls an idle agent that owns one waiting.
      const jobs = row.jobs ?? []
      const elapsed = since => since === undefined ? null : h('span', { className: `${PREFIX}-time` }, formatElapsed(now - since, t))
      const note = (key, text, since) => h('div', { key, className: `${PREFIX}-note` }, h('span', { className: `${PREFIX}-note-text` }, text), elapsed(since))
      return h('li', { className: `${PREFIX}-item`, style: row.depth > 0 ? { paddingLeft: row.depth * INDENT } : undefined },
        h('div', { className: `${PREFIX}-row` },
          h('span', { className: `${PREFIX}-glyph`, role: 'img', 'aria-label': t(`state.${row.state}`) }, h(StateMark, { state: row.state })),
          h('span', { className: `${PREFIX}-name` }, row.depth === 0 ? t('self') : row.name),
          row.label === undefined ? null : h('span', { className: `${PREFIX}-label` }, row.label),
          h('span', { className: `${PREFIX}-doing` }, rowText(row, t)),
          elapsed(row.since)),
        jobs.slice(0, MAX_JOBS).map((job, index) => note(`job-${index}`, `${job.kind}: ${job.label}`, job.startedAt)),
        jobs.length > MAX_JOBS ? note('more', t('jobs.more', { n: jobs.length - MAX_JOBS })) : null,
        row.goalWaiting === true ? note('goal', t('goalWaiting')) : null)
    }

    /** The strip: a header with the counts per state, and the list of agents once expanded. Nothing while there is nothing to show. */
    function AgentMonitor({ useAgentMonitor, t }) {
      const [open, setOpen] = useState(false)
      const agents = useAgentMonitor(state => state.agents)
      // Elapsed times show only in the open list, so a collapsed strip does not render again with every read.
      const now = useAgentMonitor(state => open ? state.at : 0)
      if (!visible(agents)) return null
      return h('section', { className: `${PREFIX}-root`, 'aria-label': t('title') },
        h('div', { className: `${PREFIX}-body` },
          h('button', { type: 'button', className: `${PREFIX}-header`, 'aria-expanded': open, onClick: () => { setOpen(value => !value) } },
            h('span', { className: `${PREFIX}-lead`, 'aria-hidden': true }, h(Glyph, { name: 'users-outline' })),
            h('span', { className: `${PREFIX}-title` }, t('title')),
            h('span', { className: `${PREFIX}-summary` }, summary(agents, t)),
            // The task list's chevrons: up while collapsed, down while expanded.
            h('span', { className: `${PREFIX}-chevron`, 'aria-hidden': true }, h(Glyph, { name: open ? 'chevron-down-outline' : 'chevron-up-outline' }))),
          open ? h('ul', { className: `${PREFIX}-list` }, agents.map(row => h(AgentRow, { key: row.id, row, now, t }))) : null))
    }

    /**
     * What the sidebar says about one session: the counts of the running and
     * waiting agents of its tree, while its own agent waits on background work.
     * @param useWaitingAgents - selector hook over the store every row shares.
     * @param {string} sessionId - the row's session.
     * @param t - this plugin's translate function.
     * @param {boolean} [quietRowOnly] - say nothing while a subagent that agent created is running.
     * @returns {string | undefined} the counts; undefined while that agent does not wait, or while it is not to be said.
     */
    function useSessionCounts(useWaitingAgents, sessionId, t, quietRowOnly = false) {
      // The text is what is selected, so a row draws again only when what it says changes.
      return useWaitingAgents((state) => {
        const waiting = state.agents.find(agent => agent.id === sessionId)
        if (waiting === undefined || (quietRowOnly && waiting.subagentRunning)) return undefined
        return countsText(waiting, t)
      })
    }

    /**
     * The mark on a session's sidebar row: the pause sign of the strip's waiting agents. It is no control.
     * It is left out while a subagent the session's agent created is running: the row then has Harness's
     * own spinner, and a pause sign beside a spinner would contradict it.
     */
    function SessionMark({ sessionId, useWaitingAgents, t }) {
      const counts = useSessionCounts(useWaitingAgents, sessionId, t, true)
      if (counts === undefined) return null
      // As Harness's own mark on a row: a press on it does not open the session through the row.
      return h('span', { className: `${PREFIX}-mark`, onClick: (event) => { event.stopPropagation() } },
        h(StateMark, { state: 'waiting' }),
        h('span', { className: `${PREFIX}-hidden` }, t('sidebar.label', { counts })))
    }

    /** The line in the hover card of a session's sidebar row: the same sign, the title and the counts. */
    function SessionHover({ sessionId, useWaitingAgents, t }) {
      const counts = useSessionCounts(useWaitingAgents, sessionId, t)
      if (counts === undefined) return null
      return h('div', { className: `${PREFIX}-hover` },
        h('span', { className: `${PREFIX}-hover-icon` }, h(Glyph, { name: 'pause-outline', size: 12 })),
        h('span', { className: `${PREFIX}-hover-body` },
          h('span', { className: `${PREFIX}-hover-title` }, t('title')),
          h('span', { className: `${PREFIX}-hover-counts` }, counts)))
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      // The pure parts, so their tests need no page.
      __helpers: { visible, summary, formatElapsed, rowText },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-monitor: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = ENTRY
          style.textContent = CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'agent-monitor: styles')

        /** Ask one route of the Host half; a refusal throws. */
        async function ask(endpoint, payload) {
          const result = await ctx.connection.rpc.call(HOST_CHANNEL, `${HOST_API}/${endpoint}`, payload)
          if (!result.ok) throw new Error(result.error?.message ?? 'request failed')
          return result.value
        }

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: ENTRY,
          // Between Harness's task list (0) and its goal bar (10). Not 5, which the worktree bar of Harness's
          // experimental change-request plugin has: entries of equal order follow the order they were registered in.
          order: 6,
          locale: NS,
          // One store per session; the renderer hands it to that session's strip as the `useAgentMonitor` hook.
          inject: sessionId => ({ hooks: { agentMonitor: createMonitor(async () => (await ask('snapshot', { sessionId })).agents, POLL_MS) } }),
        }, AgentMonitor))

        // One store for the page. Every sidebar row and hover card reads it as the `useWaitingAgents` hook, so any number of rows costs one request per interval.
        const waitingAgents = createMonitor(async () => (await ask('sessions', {})).sessions, SIDEBAR_POLL_MS)
        const sidebar = () => ({ hooks: { waitingAgents } })
        // The end of the row and not its start: a row offers its leading cell only while its own state is idle, and a session whose turn has just ended holds its "completed" dot there.
        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: ENTRY,
          // After the icons of Harness's experimental change-request plugin (10).
          order: 20,
          locale: NS,
          inject: sidebar,
        }, SessionMark))
        ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
          name: 'sidebar.session.row.hover',
          id: ENTRY,
          // After Harness's scheduled tasks (10).
          order: 20,
          locale: NS,
          inject: sidebar,
        }, SessionHover))
      },
    }
  },
})
