window.__ModuleLoader__.load({
  id: '@pcmid/dsh-model-defaults',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useId, useRef, useState } = React;

    const NS = 'settings.modelDefaults';
    const PREFIX = 'dsh-md';
    const FULL_ACCESS = 'danger-full-access';
    const SAVED_NOTICE_MS = 1600;
    const NAMESPACES = {
      conversation: 'agent-default-model',
      permission: 'permission',
      agent: 'agent-preset-registry',
    };
    /** Host dictionary keys for shipped permission presets; Harness owns these names. */
    const PERMISSION_LABEL_KEYS = {
      'read-only': 'preset.readOnly',
      'workspace-write': 'preset.workspaceWrite',
      [FULL_ACCESS]: 'preset.fullAccess',
    };
    /** Host dictionary keys for shipped agent presets; a preset that names itself keeps its own name. */
    const AGENT_LABEL_KEYS = {
      standard: 'presetStandardName',
      ptc: 'presetPtcName',
      minimal: 'presetMinimalName',
      cordis: 'presetCordisName',
    };
    /** Shipped presets Harness hides while Developer tools are off. */
    const CODING_TOOL_PRESETS = new Set(['ptc', 'minimal']);

    const zh = {
      title: '默认设置',
      newSessions: '新会话',
      providers: '供应商',
      modelLabel: '模型',
      modelTip: '新会话始终使用这个模型。在输入框切换模型只影响当前会话。',
      agentLabel: '智能体',
      agentTip: '新会话默认使用的智能体。已开始的会话不受影响。',
      permissionLabel: '权限',
      permissionTip: '新会话的默认权限，不影响已开始的会话。当前会话的权限在输入框切换。',
      chooseModel: '选择模型',
      chooseHint: '选择后生效',
      effortDefault: '默认',
      effortAria: '{label}的推理强度',
      unavailable: '{model}（不可用）',
      loading: '加载中',
      saved: '已保存',
      saveFailed: '保存失败，请重试',
      loadFailed: '部分选项加载失败',
      retry: '重试',
      blankSyncFailed: '默认值已保存，但当前的新会话没有切换：{reason}',
      moreInfo: '{label}的说明',
      riskTitle: '确认启用完全权限？',
      riskBody: '启用完全权限后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。',
      riskAck: '我已了解风险，并愿意继续',
      riskCancel: '取消',
      riskConfirm: '启用完全权限',
    };
    const en = {
      title: 'Defaults',
      newSessions: 'New sessions',
      providers: 'Providers',
      modelLabel: 'Model',
      modelTip: 'New sessions always start with this model. Switching models in the composer only affects the current session.',
      agentLabel: 'Agent',
      agentTip: 'The agent new sessions start with. Sessions already started keep theirs.',
      permissionLabel: 'Permissions',
      permissionTip: 'The default permissions for new sessions. Sessions already started keep theirs; switch the current one in the composer.',
      chooseModel: 'Choose a model',
      chooseHint: 'Takes effect once chosen',
      effortDefault: 'Default',
      effortAria: '{label} reasoning effort',
      unavailable: '{model} (unavailable)',
      loading: 'Loading',
      saved: 'Saved',
      saveFailed: 'Could not save. Try again.',
      loadFailed: 'Some options could not load',
      retry: 'Retry',
      blankSyncFailed: 'The default was saved, but the current new session did not switch: {reason}',
      moreInfo: 'About {label}',
      riskTitle: 'Enable full access?',
      riskBody: 'Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
      riskAck: 'I understand the risk and want to continue',
      riskCancel: 'Cancel',
      riskConfirm: 'Enable full access',
    };

    /* Host class names are hashed, so placement uses only the outlet's public
       `data-slot` anchor and the section's direct h2/p/ul children. The section
       is a flex column and the anchor is display:contents, so `order` lifts this
       block above the provider rows. If that layout changes, the block stays in
       the footer position. Control styles follow the Harness primitives; tokens
       the public theme list omits fall back to ones it names. */
    const SECTION = `div:has(> [data-slot="settings.models.footer"] .${PREFIX}-root)`;
    const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
    const CSS = `
${SECTION} > h2, ${SECTION} > p { order: -2; }
${SECTION} > ul { margin-top: 0; }
.${PREFIX}-root { order: -1; display: flex; flex-direction: column; gap: 20px; margin-top: 12px; }
.${PREFIX}-group { display: flex; flex-direction: column; gap: 8px; padding-bottom: 20px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-heading { margin: 0 0 4px; font-size: 14px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary); }
.${PREFIX}-providers { margin: 0; font-size: 14px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary); }
.${PREFIX}-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-height: 36px; }
.${PREFIX}-row[data-muted] .${PREFIX}-name { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.${PREFIX}-label { flex: 0 1 216px; min-width: 140px; display: inline-flex; align-items: center; gap: 6px; }
.${PREFIX}-name { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); transition: color 120ms ease; }
.${PREFIX}-controls { flex: 1 1 280px; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${PREFIX}-trigger { box-sizing: border-box; display: inline-flex; align-items: center; gap: 8px; height: 32px; max-width: 280px; padding: 0 30px 0 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); background-color: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); background-image: ${CHEVRON}; background-repeat: no-repeat; background-position: right 10px center; background-size: 12px 12px; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: start; cursor: pointer; anchor-name: var(--${PREFIX}-anchor); transition: background-color 120ms ease; }
.${PREFIX}-trigger:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.${PREFIX}-trigger:disabled { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); cursor: default; }
@media (hover: hover) { .${PREFIX}-trigger:hover:not(:disabled) { background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); } }
.${PREFIX}-trigger-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-trigger[data-empty] .${PREFIX}-trigger-text { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.${PREFIX}-icon { flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-menu { --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-sizing: border-box; position: fixed; position-anchor: var(--${PREFIX}-anchor); inset: auto; top: calc(anchor(bottom) + 4px); left: anchor(left); position-try-fallbacks: flip-block; margin: 0; width: max-content; min-width: anchor-size(width); max-width: min(360px, calc(100vw - 24px)); max-height: min(320px, calc(100vh - 24px)); overflow-y: auto; padding: 4px; border: 0; border-radius: var(--dsw-radius-lg, 10px); background: linear-gradient(var(--dsw-menu-surface-fill, transparent), var(--dsw-menu-surface-fill, transparent)), var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgb(0 0 0 / 0.24)); color: var(--dsw-alias-label-primary); }
.${PREFIX}-menu:popover-open { animation: ${PREFIX}-fade 100ms ease-out; }
.${PREFIX}-menu-heading { padding: 4px 8px 2px; font-size: 11px; line-height: 16px; font-weight: 500; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.${PREFIX}-option { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 30px; padding: 4px 8px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer; outline: none; }
.${PREFIX}-option:focus-visible, .${PREFIX}-option:focus { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); }
@media (hover: hover) { .${PREFIX}-option:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); } }
.${PREFIX}-check { flex: none; width: 14px; height: 14px; }
.${PREFIX}-segmented { --${PREFIX}-gap: 2px; position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: var(--${PREFIX}-gap); max-width: 100%; padding: 2px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.${PREFIX}-segmented-pill { position: absolute; top: 2px; left: 2px; width: calc((100% - 4px - var(--${PREFIX}-gap) * (var(--${PREFIX}-count) - 1)) / var(--${PREFIX}-count)); height: calc(100% - 4px); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgb(0 0 0 / 0.16)); transform: translateX(calc(var(--${PREFIX}-index) * (100% + var(--${PREFIX}-gap)))); transition: transform 160ms ease; pointer-events: none; }
.${PREFIX}-segment { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 28px; padding: 0 14px; border-radius: var(--dsw-radius-sm, 6px); font-size: 13px; line-height: 20px; white-space: nowrap; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: color 120ms ease; }
.${PREFIX}-segment input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: inherit; }
.${PREFIX}-segment[data-selected] { font-weight: 500; color: var(--dsw-alias-label-primary); }
@media (hover: hover) { .${PREFIX}-segment:hover { color: var(--dsw-alias-label-primary); } }
.${PREFIX}-segment:has(input:focus-visible) { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.${PREFIX}-segmented[aria-busy="true"] { opacity: 0.7; }
.${PREFIX}-checkbox { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.${PREFIX}-checkbox input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.${PREFIX}-checkbox input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.${PREFIX}-checkbox:has(input:disabled) { cursor: default; opacity: 0.5; }
.${PREFIX}-tip { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); cursor: help; anchor-name: var(--${PREFIX}-anchor); transition: color 120ms ease; }
@media (hover: hover) { .${PREFIX}-tip:hover { color: var(--dsw-alias-label-primary); } }
.${PREFIX}-tip:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; color: var(--dsw-alias-label-primary); }
.${PREFIX}-tip svg { width: 14px; height: 14px; }
.${PREFIX}-bubble { box-sizing: border-box; position: fixed; position-anchor: var(--${PREFIX}-anchor); inset: auto; bottom: calc(anchor(top) + 6px); left: anchor(left); position-try-fallbacks: flip-block; margin: 0; width: max-content; max-width: min(300px, calc(100vw - 24px)); padding: 5px 9px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-bg-overlay)); color: var(--dsw-static-neutral-bluish-00, var(--dsw-alias-label-primary)); font-size: 13px; line-height: 20px; pointer-events: none; }
.${PREFIX}-bubble:popover-open { animation: ${PREFIX}-fade 120ms ease-out; }
.${PREFIX}-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); animation: ${PREFIX}-fade 120ms ease-out; }
.${PREFIX}-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-load-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${PREFIX}-button { box-sizing: border-box; height: 32px; min-width: 72px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); background: transparent; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); cursor: pointer; }
@media (hover: hover) { .${PREFIX}-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); } }
.${PREFIX}-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.${PREFIX}-button[data-size="small"] { height: 24px; min-width: 0; padding: 0 10px; font-size: 12px; }
.${PREFIX}-button[data-primary] { border-color: transparent; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-1); }
.${PREFIX}-button:disabled { opacity: 0.4; cursor: default; }
.${PREFIX}-dialog { box-sizing: border-box; width: min(440px, calc(100vw - 48px)); padding: 22px 24px 24px; border: 0; border-radius: var(--dsw-radius-panel, 14px); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgb(0 0 0 / 0.24)); color: var(--dsw-alias-label-primary); }
.${PREFIX}-dialog::backdrop { background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 0.5)); backdrop-filter: var(--dsw-mask-blur, none); }
.${PREFIX}-dialog h3 { margin: 0 0 12px; font-size: 16px; font-weight: 500; line-height: 24px; }
.${PREFIX}-dialog p { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-dialog .${PREFIX}-checkbox { align-items: flex-start; margin-top: 16px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-dialog .${PREFIX}-checkbox input { margin-top: 3px; }
.${PREFIX}-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
@keyframes ${PREFIX}-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .${PREFIX}-menu:popover-open, .${PREFIX}-bubble:popover-open, .${PREFIX}-status { animation: none; }
  .${PREFIX}-segmented-pill, .${PREFIX}-segment, .${PREFIX}-trigger, .${PREFIX}-tip, .${PREFIX}-name { transition: none; }
}
`;

    function fill(template, name, value) {
      return template.replace(`{${name}}`, () => value);
    }

    /** Read another plugin's dictionary, falling back when it does not carry the key. */
    function hostText(t, key, fallback) {
      try {
        const text = t(key);
        return typeof text === 'string' && text !== '' && text !== key ? text : fallback;
      } catch {
        return fallback;
      }
    }

    function findModel(groups, provider, model) {
      const group = groups.find(candidate => candidate.id === provider);
      return group === undefined ? undefined : group.models.find(candidate => candidate.id === model);
    }

    function routeKey(provider, model) {
      return JSON.stringify([provider, model]);
    }

    function selectionOf(value) {
      if (!value || !value.provider || !value.model) return undefined;
      return {
        provider: value.provider,
        model: value.model,
        ...value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {},
      };
    }

    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          snapshot = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /** Joins the settings forms, the Host catalogs, and write state onto the view. */
    function createController(ctx) {
      const forms = {
        conversation: ctx.configForms.get(NAMESPACES.conversation),
        permission: ctx.configForms.get(NAMESPACES.permission),
        agent: ctx.configForms.get(NAMESPACES.agent),
      };
      const developerTools = ctx.configForms.developerTools.enabled;
      const fields = ['conversation', 'agent', 'permission'];
      const writes = Object.fromEntries(fields.map(field => [field, { saving: false, failed: false, saved: false, notice: null }]));
      const timers = new Map();
      const resources = {
        catalog: { status: 'idle', groups: [], generation: 0 },
        roster: { status: 'idle', rows: [], generation: 0 },
        permissions: { status: 'idle', value: null, generation: 0 },
      };
      let pendingRisk = false;
      let requested = false;
      let disposed = false;

      const agentOptions = () => {
        const tools = developerTools.getSnapshot();
        return resources.roster.rows
          .filter(row => row.broken === undefined)
          .filter(row => tools || row.name !== undefined || !CODING_TOOL_PRESETS.has(row.id));
      };

      const projection = () => {
        const snapshots = Object.fromEntries(Object.entries(forms).map(([key, form]) => [key, form.getSnapshot()]));
        const permissionCatalog = resources.permissions.value;
        return {
          modelsReady: resources.catalog.status === 'ready' || resources.catalog.groups.length > 0,
          groups: resources.catalog.groups,
          loadFailed: Object.values(resources).some(resource => resource.status === 'error'),
          pendingRisk,
          conversation: {
            ...writes.conversation,
            selected: selectionOf(snapshots.conversation.value),
            enabled: snapshots.conversation.status === 'ready' && snapshots.conversation.writable,
            visible: snapshots.conversation.status !== 'unavailable',
          },
          agent: {
            ...writes.agent,
            options: agentOptions().map(row => ({ id: row.id, ...row.name === undefined ? {} : { name: row.name } })),
            current: resources.roster.rows.find(row => row.isDefault)?.id,
            enabled: snapshots.agent.status === 'ready' && snapshots.agent.writable,
            loading: resources.roster.status !== 'ready',
            visible: snapshots.agent.status !== 'unavailable'
              && (resources.roster.status !== 'ready' || agentOptions().length > 0),
          },
          permission: {
            ...writes.permission,
            options: permissionCatalog === null ? [] : permissionCatalog.defaultOptions.map(option => ({ id: option.value, name: option.name })),
            current: snapshots.permission.value?.defaultPreset ?? permissionCatalog?.defaultPreset,
            enabled: snapshots.permission.status === 'ready' && snapshots.permission.writable,
            loading: permissionCatalog === null,
            visible: snapshots.permission.status !== 'unavailable',
          },
        };
      };

      const store = createStore(projection());
      const publish = () => { if (!disposed) store.set(projection()); };

      /** Latest read wins; a failed read keeps what the last good read showed. */
      const read = async (key, call, accept) => {
        const resource = resources[key];
        const generation = ++resource.generation;
        resource.status = 'loading';
        publish();
        let response;
        try {
          response = await call();
        } catch {
          response = { ok: false };
        }
        if (disposed || generation !== resource.generation) return;
        if (response.ok) {
          accept(response.value);
          resource.status = 'ready';
        } else {
          resource.status = 'error';
        }
        publish();
      };

      const loadCatalog = () => read('catalog', () => ctx.remote.session.modelCatalog(), (value) => {
        resources.catalog.groups = value.groups;
      });
      const loadRoster = () => read('roster', () => ctx.remote.agentPresets.list(), (value) => {
        resources.roster.rows = value.presets;
      });
      const loadPermissions = () => read('permissions', () => ctx.remote.permissionPresets.catalog(), (value) => {
        resources.permissions.value = value;
      });
      const loadAll = () => { void loadCatalog(); void loadRoster(); void loadPermissions(); };

      const setWrite = (field, patch) => {
        writes[field] = { ...writes[field], ...patch };
        publish();
      };

      /** One write at a time per field; the result drives its inline status. */
      const run = async (field, operation) => {
        if (writes[field].saving) return;
        clearTimeout(timers.get(field));
        setWrite(field, { saving: true, failed: false, saved: false, notice: null });
        let outcome = false;
        try {
          outcome = await operation();
        } catch {
          outcome = false;
        }
        if (disposed) return;
        const landed = outcome !== false;
        setWrite(field, {
          saving: false,
          failed: !landed,
          saved: landed && typeof outcome !== 'string',
          notice: typeof outcome === 'string' ? outcome : null,
        });
        if (landed) {
          timers.set(field, setTimeout(() => { setWrite(field, { saved: false }); }, SAVED_NOTICE_MS));
        }
      };

      const writeSelection = (field, form, next) => run(field, () => {
        const set = (name, value) => ({ op: 'set', path: [name], value });
        const unset = name => ({ op: 'unset', path: [name] });
        return form.mutate([
          set('provider', next.provider),
          set('model', next.model),
          next.reasoningEffort === undefined ? unset('reasoningEffort') : set('reasoningEffort', next.reasoningEffort),
        ]);
      });

      const pickModel = (field, form, key) => {
        const [provider, model] = JSON.parse(key);
        const previous = selectionOf(form.getSnapshot().value);
        const reasoning = findModel(resources.catalog.groups, provider, model)?.reasoning;
        // An effort the next model does not offer falls back to that model's default.
        const kept = previous?.reasoningEffort !== undefined
          && reasoning?.efforts.some(effort => effort.id === previous.reasoningEffort);
        void writeSelection(field, form, { provider, model, ...kept ? { reasoningEffort: previous.reasoningEffort } : {} });
      };

      const pickEffort = (field, form, effort) => {
        const previous = selectionOf(form.getSnapshot().value);
        if (previous === undefined) return;
        void writeSelection(field, form, {
          provider: previous.provider,
          model: previous.model,
          ...effort === '' ? {} : { reasoningEffort: effort },
        });
      };

      const writePermission = (id) => { void run('permission', () => forms.permission.set('defaultPreset', id)); };

      /** The blank session on screen, captured before the write so a later navigation cannot retarget it. */
      const mainBlankSession = () => Object.values(ctx.sessions.list.getSnapshot().byId)
        .find(session => session.blank && (session.retainedBy.mainView ?? 0) > 0);

      const unsubscribe = [
        ...Object.values(forms).map(form => form.subscribe(publish)),
        developerTools.subscribe(publish),
      ];

      return {
        /** Reload one resource only after the page first asked: an unopened page fetches nothing. */
        refresh(key) {
          if (!requested) return;
          if (key === 'catalog') void loadCatalog();
          else if (key === 'roster') void loadRoster();
          else if (key === 'permissions') void loadPermissions();
          else loadAll();
        },
        dispose() {
          disposed = true;
          for (const timer of timers.values()) clearTimeout(timer);
          for (const off of unsubscribe) off();
        },
        face: {
          hooks: { modelDefaults: store },
          load() {
            if (requested) return;
            requested = true;
            loadAll();
          },
          retry: loadAll,
          pickConversationModel: (key) => { pickModel('conversation', forms.conversation, key); },
          pickConversationEffort: (effort) => { pickEffort('conversation', forms.conversation, effort); },
          pickAgent(id) {
            const blank = mainBlankSession();
            void run('agent', async () => {
              if (!(await forms.agent.set('selectedDefault', id))) return false;
              await loadRoster();
              if (blank === undefined || blank.projectionValues?.agentPreset === id) return true;
              const switched = await ctx.remote.agentPresets.select(blank.id, id);
              return switched.ok ? true : (switched.error?.message ?? '');
            });
          },
          /** Full access needs an explicit acknowledgement; every other preset writes directly. */
          pickPermission(id) {
            if (id === FULL_ACCESS) {
              pendingRisk = true;
              publish();
              return;
            }
            writePermission(id);
          },
          confirmRisk() {
            if (!pendingRisk) return;
            pendingRisk = false;
            writePermission(FULL_ACCESS);
          },
          cancelRisk() {
            if (!pendingRisk) return;
            pendingRisk = false;
            publish();
          },
          agentLabel: (option) => {
            const key = option.name === undefined ? AGENT_LABEL_KEYS[option.id] : undefined;
            const own = option.name ?? option.id;
            return key === undefined ? own : hostText(ctx.locale.bind('settings.agentPreset'), key, own);
          },
          permissionLabel: (option) => {
            const key = PERMISSION_LABEL_KEYS[option.id];
            return key === undefined ? option.name : hostText(ctx.locale.bind('settings.permission'), key, option.name);
          },
        },
      };
    }

    function safeId(raw) {
      return raw.replace(/[^a-zA-Z0-9_-]/g, '');
    }

    function svg(className, children) {
      return h('svg', { className, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, children);
    }

    function SparkleIcon() {
      return svg(`${PREFIX}-icon`, [
        h('path', { key: 'a', d: 'M6.5 3l1.1 3.1L10.7 7.2 7.6 8.3 6.5 11.4 5.4 8.3 2.3 7.2l3.1-1.1z' }),
        h('path', { key: 'b', d: 'M12 2v2.4M10.8 3.2h2.4M12 10.5v2.4M10.8 11.7h2.4' }),
      ]);
    }

    function AgentIcon() {
      return svg(`${PREFIX}-icon`, [
        h('rect', { key: 'a', x: 3, y: 5, width: 10, height: 8, rx: 2 }),
        h('path', { key: 'b', d: 'M8 5V2.8M6 8.6v.8M10 8.6v.8M1.5 8.2v2M14.5 8.2v2' }),
      ]);
    }

    function CheckIcon() {
      return svg(`${PREFIX}-check`, h('path', { d: 'M3.5 8.5l3 3 6-7' }));
    }

    /** Hover or focus reveals one sentence; the top layer keeps it clear of scroll containers. */
    function Tip({ label, text, t }) {
      const id = safeId(useId());
      const bubble = useRef(null);
      const show = () => { if (bubble.current && !bubble.current.matches(':popover-open')) bubble.current.showPopover(); };
      const hide = () => { if (bubble.current && bubble.current.matches(':popover-open')) bubble.current.hidePopover(); };
      useEffect(() => hide, []);
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: `${PREFIX}-tip`,
          style: { [`--${PREFIX}-anchor`]: `--${PREFIX}-tip-${id}` },
          'aria-label': fill(t('moreInfo'), 'label', label),
          'aria-describedby': `${PREFIX}-bubble-${id}`,
          onMouseEnter: show,
          onMouseLeave: hide,
          onFocus: show,
          onBlur: hide,
          onKeyDown: (event) => { if (event.key === 'Escape') hide(); },
        }, svg(null, [
          h('circle', { key: 'a', cx: 8, cy: 8, r: 6.25 }),
          h('path', { key: 'b', d: 'M8 7.4v3.4M8 5.2v.1' }),
        ])),
        h('span', {
          id: `${PREFIX}-bubble-${id}`,
          ref: bubble,
          role: 'tooltip',
          popover: 'manual',
          className: `${PREFIX}-bubble`,
          style: { [`--${PREFIX}-anchor`]: `--${PREFIX}-tip-${id}` },
        }, text));
    }

    /** Listbox in a light-dismiss popover: the platform handles outside clicks, Esc, and focus return. */
    function Dropdown({ label, icon, valueLabel, empty, groups, selected, disabled, onSelect }) {
      const id = safeId(useId());
      const list = useRef(null);
      const [open, setOpen] = useState(false);
      useEffect(() => {
        const element = list.current;
        if (element === null) return undefined;
        const onToggle = (event) => {
          const next = event.newState === 'open';
          setOpen(next);
          if (next) (element.querySelector('[aria-selected="true"]') ?? element.querySelector('[role="option"]'))?.focus();
        };
        element.addEventListener('toggle', onToggle);
        return () => { element.removeEventListener('toggle', onToggle); };
      }, []);
      const choose = (value) => {
        list.current?.hidePopover();
        if (value !== selected) onSelect(value);
      };
      const onListKey = (event) => {
        const options = [...list.current.querySelectorAll('[role="option"]')];
        const index = options.indexOf(document.activeElement);
        const focus = (next) => { event.preventDefault(); options[next]?.focus(); };
        if (event.key === 'ArrowDown') focus(Math.min(index + 1, options.length - 1));
        else if (event.key === 'ArrowUp') focus(Math.max(index - 1, 0));
        else if (event.key === 'Home') focus(0);
        else if (event.key === 'End') focus(options.length - 1);
        else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          document.activeElement?.click();
        } else if (event.key === 'Tab') list.current.hidePopover();
      };
      const anchor = { [`--${PREFIX}-anchor`]: `--${PREFIX}-menu-${id}` };
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: `${PREFIX}-trigger`,
          style: anchor,
          disabled,
          popovertarget: `${PREFIX}-list-${id}`,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-label': `${label}: ${valueLabel}`,
          ...empty ? { 'data-empty': true } : {},
          onKeyDown: (event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            list.current?.showPopover();
          },
        }, icon, h('span', { className: `${PREFIX}-trigger-text` }, valueLabel)),
        h('div', {
          id: `${PREFIX}-list-${id}`,
          ref: list,
          popover: 'auto',
          role: 'listbox',
          'aria-label': label,
          className: `${PREFIX}-menu`,
          style: anchor,
          onKeyDown: onListKey,
        }, groups.map(group => h(React.Fragment, { key: group.key },
          group.label === undefined ? null : h('div', { className: `${PREFIX}-menu-heading`, role: 'presentation' }, group.label),
          group.options.map(option => h('div', {
            key: option.value,
            role: 'option',
            tabIndex: -1,
            'aria-selected': option.value === selected,
            className: `${PREFIX}-option`,
            onClick: () => { choose(option.value); },
          }, option.label, option.value === selected ? h(CheckIcon) : null))))));
    }

    /** Native radios carry arrow-key movement and focus; the pill only draws the selection. */
    function Segmented({ label, options, current, busy, disabled, onSelect }) {
      const name = `${PREFIX}-radio-${safeId(useId())}`;
      const index = Math.max(options.findIndex(option => option.id === current), 0);
      return h('div', {
        role: 'radiogroup',
        'aria-label': label,
        'aria-busy': busy,
        className: `${PREFIX}-segmented`,
        style: { [`--${PREFIX}-count`]: options.length, [`--${PREFIX}-index`]: index },
      },
      h('span', { className: `${PREFIX}-segmented-pill`, 'aria-hidden': true }),
      options.map(option => h('label', {
        key: option.id,
        className: `${PREFIX}-segment`,
        ...option.id === current ? { 'data-selected': true } : {},
      },
      h('input', {
        type: 'radio',
        name,
        value: option.id,
        checked: option.id === current,
        disabled,
        onChange: () => { if (!busy) onSelect(option.id); },
      }),
      option.label)));
    }

    /** Modal in the top layer: the platform traps focus and closes on Esc. */
    function RiskDialog({ open, t, onCancel, onConfirm }) {
      const dialog = useRef(null);
      const ack = useRef(null);
      const [acknowledged, setAcknowledged] = useState(false);
      useEffect(() => {
        const element = dialog.current;
        if (element === null) return undefined;
        if (open && !element.open) {
          setAcknowledged(false);
          element.showModal();
          ack.current?.focus();
        } else if (!open && element.open) {
          element.close();
        }
        const onClose = () => { onCancel(); };
        element.addEventListener('close', onClose);
        return () => { element.removeEventListener('close', onClose); };
      }, [open, onCancel]);
      return h('dialog', { ref: dialog, className: `${PREFIX}-dialog`, 'aria-labelledby': `${PREFIX}-risk-title` },
        h('h3', { id: `${PREFIX}-risk-title` }, t('riskTitle')),
        h('p', null, t('riskBody')),
        h('label', { className: `${PREFIX}-checkbox` },
          h('input', {
            ref: ack,
            type: 'checkbox',
            checked: acknowledged,
            onChange: (event) => { setAcknowledged(event.target.checked); },
          }),
          t('riskAck')),
        h('div', { className: `${PREFIX}-dialog-actions` },
          h('button', { type: 'button', className: `${PREFIX}-button`, onClick: onCancel }, t('riskCancel')),
          h('button', {
            type: 'button',
            className: `${PREFIX}-button`,
            'data-primary': true,
            disabled: !acknowledged,
            onClick: onConfirm,
          }, t('riskConfirm'))));
    }

    function WriteStatus({ write, t, hint }) {
      if (write.failed) return h('span', { className: `${PREFIX}-status`, 'data-tone': 'error', role: 'alert' }, t('saveFailed'));
      if (write.notice !== null) return h('span', { className: `${PREFIX}-status`, 'data-tone': 'error', role: 'alert' }, fill(t('blankSyncFailed'), 'reason', write.notice));
      if (write.saved) return h('span', { className: `${PREFIX}-status`, role: 'status' }, t('saved'));
      return hint === undefined ? null : h('span', { className: `${PREFIX}-status` }, hint);
    }

    function Row({ label, tip, muted, t, children }) {
      return h('div', { className: `${PREFIX}-row`, ...muted ? { 'data-muted': true } : {} },
        h('div', { className: `${PREFIX}-label` },
          h('span', { className: `${PREFIX}-name` }, label),
          tip === undefined ? null : h(Tip, { label, text: tip, t })),
        h('div', { className: `${PREFIX}-controls` }, children));
    }

    /** Model and effort pickers for one stored selection. */
    function ModelControls({ label, row, groups, ready, t, disabled, onModel, onEffort, placeholder }) {
      const { selected } = row;
      const known = selected === undefined ? undefined : findModel(groups, selected.provider, selected.model);
      const valueLabel = selected === undefined
        ? (ready ? placeholder : t('loading'))
        : known?.name ?? (ready ? fill(t('unavailable'), 'model', selected.model) : selected.model);
      const menus = groups.map(group => ({
        key: group.id,
        ...groups.length > 1 ? { label: group.name } : {},
        options: group.models.map(model => ({ value: routeKey(group.id, model.id), label: model.name })),
      }));
      const efforts = known?.reasoning?.efforts ?? [];
      const effort = selected?.reasoningEffort;
      const effortOptions = [
        { value: '', label: t('effortDefault') },
        ...effort !== undefined && !efforts.some(option => option.id === effort) ? [{ value: effort, label: effort }] : [],
        ...efforts.map(option => ({ value: option.id, label: option.name })),
      ];
      return h(React.Fragment, null,
        h(Dropdown, {
          label,
          icon: h(SparkleIcon),
          valueLabel,
          empty: selected === undefined,
          groups: menus,
          selected: selected === undefined ? '' : routeKey(selected.provider, selected.model),
          disabled: disabled || !ready,
          onSelect: onModel,
        }),
        selected === undefined || effortOptions.length === 1
          ? null
          : h(Dropdown, {
            label: fill(t('effortAria'), 'label', label),
            valueLabel: effortOptions.find(option => option.value === (effort ?? ''))?.label ?? t('effortDefault'),
            groups: [{ key: 'efforts', options: effortOptions }],
            selected: effort ?? '',
            disabled: disabled || !ready,
            onSelect: onEffort,
          }));
    }

    function ModelDefaults(props) {
      const { t, load } = props;
      const state = props.useModelDefaults(snapshot => snapshot);
      useEffect(() => { load(); }, [load]);
      const { conversation, agent, permission, groups, modelsReady } = state;
      const hasNewSessions = conversation.visible || agent.visible || permission.visible;
      const agentOptions = agent.options.map(option => ({ value: option.id, label: props.agentLabel(option) }));
      const agentCurrent = agentOptions.find(option => option.value === agent.current);
      const permissionOptions = permission.options.map(option => ({ id: option.id, label: props.permissionLabel(option) }));
      return h('div', { className: `${PREFIX}-root` },
        h('style', null, CSS),
        hasNewSessions
          ? h('section', { className: `${PREFIX}-group`, 'aria-labelledby': `${PREFIX}-new` },
            h('h3', { id: `${PREFIX}-new`, className: `${PREFIX}-heading` }, t('newSessions')),
            conversation.visible
              ? h(Row, { label: t('modelLabel'), tip: t('modelTip'), t },
                h(ModelControls, {
                  label: t('modelLabel'),
                  row: conversation,
                  groups,
                  ready: modelsReady,
                  t,
                  disabled: !conversation.enabled || conversation.saving,
                  placeholder: t('chooseModel'),
                  onModel: props.pickConversationModel,
                  onEffort: props.pickConversationEffort,
                }),
                h(WriteStatus, { write: conversation, t }))
              : null,
            agent.visible
              ? h(Row, { label: t('agentLabel'), tip: t('agentTip'), t },
                h(Dropdown, {
                  label: t('agentLabel'),
                  icon: h(AgentIcon),
                  valueLabel: agentCurrent?.label ?? t('loading'),
                  empty: agentCurrent === undefined,
                  groups: [{ key: 'agents', options: agentOptions }],
                  selected: agent.current ?? '',
                  disabled: !agent.enabled || agent.saving || agent.loading,
                  onSelect: props.pickAgent,
                }),
                h(WriteStatus, { write: agent, t }))
              : null,
            permission.visible
              ? h(Row, { label: t('permissionLabel'), tip: t('permissionTip'), t },
                permission.loading
                  ? h('span', { className: `${PREFIX}-status` }, t('loading'))
                  : h(Segmented, {
                    label: t('permissionLabel'),
                    options: permissionOptions,
                    current: permission.current,
                    busy: permission.saving,
                    disabled: !permission.enabled,
                    onSelect: props.pickPermission,
                  }),
                h(WriteStatus, { write: permission, t }))
              : null)
          : null,
        state.loadFailed
          ? h('div', { className: `${PREFIX}-load-error` },
            h('span', { className: `${PREFIX}-status`, 'data-tone': 'error', role: 'alert' }, t('loadFailed')),
            h('button', { type: 'button', className: `${PREFIX}-button`, 'data-size': 'small', onClick: props.retry }, t('retry')))
          : null,
        h(RiskDialog, { open: state.pendingRisk, t, onCancel: props.cancelRisk, onConfirm: props.confirmRisk }),
        h('h3', { className: `${PREFIX}-providers` }, t('providers')));
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'remote', 'remote.session', 'remote.agentPresets', 'remote.permissionPresets', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-defaults: dictionaries');
        const controller = createController(ctx);
        ctx.effect(() => () => { controller.dispose(); }, 'model-defaults: form subscriptions');
        ctx.effect(() => {
          const disposers = [
            ctx.remote.$on('llm/adapters-updated', () => { controller.refresh('catalog'); }),
            ctx.remote.$on('permission-presets/catalog-changed', () => { controller.refresh('permissions'); }),
            ctx.remote.$on('settings/document-updated', (ns) => {
              // A settings commit can change a route's models; only these two namespaces move the others.
              controller.refresh('catalog');
              if (ns === NAMESPACES.agent) controller.refresh('roster');
              if (ns === NAMESPACES.permission) controller.refresh('permissions');
            }),
            ctx.on('connection/reset', () => { controller.refresh('all'); }),
          ];
          return () => { for (const dispose of disposers) dispose(); };
        }, 'model-defaults: invalidations');
        ctx.effect(() => ctx.configForms.whileServed(
          Object.values(NAMESPACES),
          () => ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
            name: 'settings.models.footer',
            id: 'model-defaults',
            order: -100,
            label: () => t('title'),
            locale: NS,
            inject: () => controller.face,
          }, ModelDefaults)),
        ), 'model-defaults: section');
      },
    };
  },
});
