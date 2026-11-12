// Shared runtime for the MCP and Skills settings pages: React handles, the Host
// RPC helper, a tiny observable store, the locale and CSS registries the parts
// add to, icons, and controls copied from the Harness primitives (the plugin
// may not import Harness Client packages, so every control lives here and
// styles only through `--dsw-*` tokens).

const React = require('react');
const h = React.createElement;
const { Fragment, forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } = React;

const NS = 'settings.mcpSkills';
const PREFIX = 'dsh-ms';
const CHANNEL = '/api';
const ENDPOINT = 'mcp-skills';

// ---------------------------------------------------------------------------
// Locale and CSS registries. Each part calls addDict / addCss at load time;
// keys use a part prefix (`c_` core, `mcp_`, `sk_`) so parts never collide.
// ---------------------------------------------------------------------------

const DICT = { zh: {}, en: {} };
function addDict(zh, en) {
  Object.assign(DICT.zh, zh);
  Object.assign(DICT.en, en);
}
const CSS_PARTS = [];
function addCss(text) { CSS_PARTS.push(text); }
function Styles() { return h('style', null, CSS_PARTS.join('\n')); }

/** Replace `{key}` placeholders; missing values become ''. */
function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (values[key] === undefined ? '' : String(values[key])));
}

addDict({
  c_back: '返回',
  c_cancel: '取消',
  c_save: '保存',
  c_saving: '正在保存…',
  c_delete: '删除',
  c_retry: '重试',
  c_close: '关闭',
  c_loading: '正在加载…',
  c_search: '搜索',
  c_clearSearch: '清除搜索',
  c_moreInfo: '说明',
  c_required: '必填',
  c_justNow: '刚刚',
  c_minutesAgo: '{n} 分钟前',
  c_hoursAgo: '{n} 小时前',
  c_daysAgo: '{n} 天前',
  c_loadFailed: '读取失败：{reason}',
  c_unknownError: '未知错误',
}, {
  c_back: 'Back',
  c_cancel: 'Cancel',
  c_save: 'Save',
  c_saving: 'Saving…',
  c_delete: 'Delete',
  c_retry: 'Retry',
  c_close: 'Close',
  c_loading: 'Loading…',
  c_search: 'Search',
  c_clearSearch: 'Clear search',
  c_moreInfo: 'More info',
  c_required: 'Required',
  c_justNow: 'just now',
  c_minutesAgo: '{n} min ago',
  c_hoursAgo: '{n} h ago',
  c_daysAgo: '{n} d ago',
  c_loadFailed: 'Could not load: {reason}',
  c_unknownError: 'Unknown error',
});

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

/** Observable value with a stable snapshot between changes (the `hooks` compartment binds it to `use<Name>`). */
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
      if (next === snapshot) return;
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    update(patch) {
      this.set({ ...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch) });
    },
  };
}

class CallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Call one Host route of this plugin; resolves the value or throws CallError. */
function createRpc(ctx) {
  return async (op, payload = {}) => {
    const result = await ctx.connection.rpc.call(CHANNEL, `${ENDPOINT}/${op}`, payload);
    if (!result || !result.ok) {
      throw new CallError(String(result?.error?.code ?? 'internal'), result?.error?.message ?? 'Request failed');
    }
    return result.value;
  };
}

/** Unwrap a generated Remote result (`{ ok, value | error }`) or throw CallError. */
function unwrapRemote(result) {
  if (result && result.ok) return result.value;
  throw new CallError(String(result?.error?.code ?? 'remote'), result?.error?.message ?? 'Request failed');
}

function errorText(error, t) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return t ? t('c_unknownError') : 'Unknown error';
}

function formatAgo(ms, now, t) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return t('c_justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return fill(t('c_minutesAgo'), { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return fill(t('c_hoursAgo'), { n: hours });
  return fill(t('c_daysAgo'), { n: Math.round(hours / 24) });
}

/** Persisted UI preference (not configuration): survives reloads in this browser only. */
function readPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(`${PREFIX}:${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try { window.localStorage.setItem(`${PREFIX}:${key}`, JSON.stringify(value)); } catch { /* storage unavailable: preference stays in memory */ }
}

const cx = (...names) => names.filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Icons (16px line glyphs drawn for this plugin)
// ---------------------------------------------------------------------------

function svg(size, children, extra) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false', ...extra,
  }, children);
}
const Icon = {
  back: (s = 14) => svg(s, h('path', { d: 'M10 3.5L5.5 8l4.5 4.5' })),
  chevronDown: (s = 12) => svg(s, h('path', { d: 'M4 6l4 4 4-4' })),
  chevronRight: (s = 12) => svg(s, h('path', { d: 'M6 4l4 4-4 4' })),
  plus: (s = 14) => svg(s, h('path', { d: 'M8 3v10M3 8h10' })),
  search: (s = 14) => svg(s, [h('circle', { key: 'c', cx: 7, cy: 7, r: 4.25 }), h('path', { key: 'l', d: 'M10.25 10.25L13.5 13.5' })]),
  close: (s = 12) => svg(s, h('path', { d: 'M4 4l8 8M12 4l-8 8' })),
  check: (s = 14) => svg(s, h('path', { d: 'M3.5 8.5l3 3 6-7' })),
  trash: (s = 14) => svg(s, [h('path', { key: 'a', d: 'M3 4.5h10M6.5 4.5V3h3v1.5' }), h('path', { key: 'b', d: 'M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2' })]),
  lock: (s = 14) => svg(s, [h('rect', { key: 'r', x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }), h('path', { key: 'p', d: 'M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7' })]),
  unlock: (s = 14) => svg(s, [h('rect', { key: 'r', x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }), h('path', { key: 'p', d: 'M5.5 7V5.25a2.5 2.5 0 0 1 4.8-1' })]),
  refresh: (s = 14) => svg(s, [h('path', { key: 'a', d: 'M12.75 7.25A4.75 4.75 0 0 0 4.2 4.8L3 6' }), h('path', { key: 'b', d: 'M3 3v3h3' }), h('path', { key: 'c', d: 'M3.25 8.75a4.75 4.75 0 0 0 8.55 2.45L13 10' }), h('path', { key: 'd', d: 'M13 13v-3h-3' })]),
  play: (s = 14) => svg(s, h('path', { d: 'M5 3.5v9l7-4.5z' })),
  terminal: (s = 14) => svg(s, [h('rect', { key: 'r', x: 2, y: 3, width: 12, height: 10, rx: 2 }), h('path', { key: 'p', d: 'M5 6.5l2 1.5-2 1.5M8.5 10h2.5' })]),
  globe: (s = 14) => svg(s, [h('circle', { key: 'c', cx: 8, cy: 8, r: 5.75 }), h('path', { key: 'p', d: 'M2.25 8h11.5M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25z' })]),
  plug: (s = 16) => svg(s, [h('path', { key: 'a', d: 'M6 2v3M10 2v3' }), h('path', { key: 'b', d: 'M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0z' }), h('path', { key: 'c', d: 'M8 11v3' })]),
  book: (s = 16) => svg(s, [h('path', { key: 'a', d: 'M3 3.25A1.25 1.25 0 0 1 4.25 2H12.5v10H4.25A1.25 1.25 0 0 0 3 13.25z' }), h('path', { key: 'b', d: 'M3 13.25A1.25 1.25 0 0 0 4.25 14.5H12.5V12' }), h('path', { key: 'c', d: 'M6 5h4' })]),
  folder: (s = 14) => svg(s, h('path', { d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z' })),
  user: (s = 14) => svg(s, [h('circle', { key: 'c', cx: 8, cy: 5.5, r: 2.5 }), h('path', { key: 'p', d: 'M3.5 13.5c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5' })]),
  download: (s = 14) => svg(s, [h('path', { key: 'a', d: 'M8 2.5v8M4.75 7.5L8 10.75l3.25-3.25' }), h('path', { key: 'b', d: 'M3 13.5h10' })]),
  warning: (s = 14) => svg(s, [h('path', { key: 'a', d: 'M8 2.5l6 10.5H2z' }), h('path', { key: 'b', d: 'M8 6.5v3M8 11.5v.01' })]),
  info: (s = 14) => svg(s, [h('circle', { key: 'c', cx: 8, cy: 8, r: 5.75 }), h('path', { key: 'p', d: 'M8 7.25v3.5M8 5.25v.01' })]),
  tool: (s = 14) => svg(s, h('path', { d: 'M10.5 2.5a3 3 0 0 0-2.9 3.8L3 10.9 5.1 13l4.6-4.6a3 3 0 0 0 3.8-2.9l-1.8 1.1-1.6-1.6 1.1-1.8z' })),
  eye: (s = 14) => svg(s, [h('path', { key: 'a', d: 'M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z' }), h('circle', { key: 'c', cx: 8, cy: 8, r: 2 })]),
};

function Spinner({ size = 14, label }) {
  return h('svg', {
    className: `${PREFIX}-spinner`, width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    role: label ? 'img' : undefined, 'aria-label': label, 'aria-hidden': label ? undefined : true,
  },
  h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 2, opacity: 0.25 }),
  h('path', { d: 'M8 2a6 6 0 0 1 6 6', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }));
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function Button({ variant = 'secondary', size = 'md', icon, busy, children, className, type = 'button', ...rest }) {
  return h('button', {
    type, className: cx(`${PREFIX}-btn`, className), 'data-variant': variant, 'data-size': size,
    'aria-busy': busy ? 'true' : undefined, ...rest,
  }, busy ? h(Spinner, { size: 12 }) : icon, children === undefined ? null : h('span', null, children));
}

function IconButton({ label, icon, tone, pressed, className, ...rest }) {
  return h('button', {
    type: 'button', className: cx(`${PREFIX}-icon-btn`, className), 'aria-label': label, title: label,
    'data-tone': tone, 'aria-pressed': pressed === undefined ? undefined : String(Boolean(pressed)), ...rest,
  }, icon);
}

function Switch({ checked, onChange, label, disabled, busy }) {
  return h('button', {
    type: 'button', role: 'switch', className: `${PREFIX}-switch`, 'aria-checked': String(Boolean(checked)),
    'aria-label': label, title: label, disabled, 'aria-busy': busy ? 'true' : undefined,
    onClick: (event) => { event.stopPropagation(); onChange(!checked); },
    onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); },
  }, h('span', { className: `${PREFIX}-switch-thumb` }));
}

/** Single-choice segmented control with a sliding indicator (radiogroup semantics). */
function Segmented({ label, options, value, onChange, disabled, size = 'md' }) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  const refs = useRef([]);
  const move = (event, delta) => {
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return h('div', {
    className: `${PREFIX}-seg`, role: 'radiogroup', 'aria-label': label, 'data-size': size,
    style: { '--seg-count': options.length, '--seg-index': index }, 'aria-disabled': disabled ? 'true' : undefined,
  },
  h('span', { className: `${PREFIX}-seg-indicator`, 'aria-hidden': true }),
  options.map((option, i) => h('button', {
    key: option.value, ref: (node) => { refs.current[i] = node; }, type: 'button', role: 'radio',
    className: `${PREFIX}-seg-item`, 'aria-checked': String(option.value === value), tabIndex: option.value === value ? 0 : -1,
    disabled, title: option.title,
    onClick: () => { if (option.value !== value) onChange(option.value); },
    onKeyDown: (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(event, 1);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(event, -1);
    },
  }, option.icon ?? null, h('span', null, option.label))));
}

const TextInput = forwardRef(function TextInput({ value, onValue, mono, invalid, className, type = 'text', ...rest }, ref) {
  return h('input', {
    ref, type, value: value ?? '', className: cx(`${PREFIX}-input`, mono && `${PREFIX}-mono`, className),
    'aria-invalid': invalid ? 'true' : undefined, spellCheck: false, autoComplete: 'off',
    'data-1p-ignore': true, 'data-lpignore': 'true',
    onChange: onValue ? (event) => { onValue(event.target.value); } : rest.onChange, ...rest,
  });
});

/** Textarea that grows with its content between `minRows` and `maxRows`. */
const TextArea = forwardRef(function TextArea({ value, onValue, mono, invalid, minRows = 2, maxRows = 40, className, ...rest }, ref) {
  const inner = useRef(null);
  const setRef = (node) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };
  useLayoutEffect(() => {
    // Content-driven height cannot be expressed in CSS for a textarea (field-sizing is not universal yet).
    const node = inner.current;
    if (!node) return;
    const style = window.getComputedStyle(node);
    const line = parseFloat(style.lineHeight) || 20;
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    node.style.height = 'auto';
    const height = Math.min(Math.max(node.scrollHeight, line * minRows + chrome), line * maxRows + chrome);
    node.style.height = `${height}px`;
  }, [value, minRows, maxRows]);
  return h('textarea', {
    ref: setRef, value: value ?? '', className: cx(`${PREFIX}-input`, `${PREFIX}-textarea`, mono && `${PREFIX}-mono`, className),
    'aria-invalid': invalid ? 'true' : undefined, spellCheck: mono ? false : undefined, rows: minRows,
    onChange: onValue ? (event) => { onValue(event.target.value); } : rest.onChange, ...rest,
  });
});

function Checkbox({ checked, onChange, label, disabled, indeterminate, describedBy }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = Boolean(indeterminate); }, [indeterminate]);
  return h('label', { className: `${PREFIX}-checkbox`, 'data-disabled': disabled ? 'true' : undefined },
    h('input', { ref, type: 'checkbox', checked: Boolean(checked), disabled, 'aria-describedby': describedBy, onChange: (event) => { onChange(event.target.checked); } }),
    label === undefined ? null : h('span', null, label));
}

/** Labelled form field: label row (with optional help tip and trailing action), control, then error or hint. */
function Field({ label, help, hint, error, htmlFor, required, action, children, t }) {
  const hintId = useId();
  return h('div', { className: `${PREFIX}-field` },
    label === undefined && action === undefined ? null : h('div', { className: `${PREFIX}-field-head` },
      label === undefined ? null : h('label', { className: `${PREFIX}-field-label`, htmlFor },
        label, required ? h('span', { className: `${PREFIX}-required`, 'aria-hidden': true }, ' *') : null),
      help === undefined ? null : h(Tip, { text: help, label: t ? t('c_moreInfo') : 'Info' }),
      action === undefined ? null : h('span', { className: `${PREFIX}-field-action` }, action)),
    children,
    error ? h('p', { className: `${PREFIX}-field-error`, id: hintId, role: 'alert' }, error)
      : hint ? h('p', { className: `${PREFIX}-field-hint`, id: hintId }, hint) : null);
}

/** Hover/focus tooltip bubble anchored to a small "?" button. */
function Tip({ text, label }) {
  const id = useId().replace(/:/g, '');
  const [open, setOpen] = useState(false);
  return h('span', { className: `${PREFIX}-tip-wrap` },
    h('button', {
      type: 'button', className: `${PREFIX}-tip`, 'aria-label': label, 'aria-describedby': open ? `${PREFIX}-tip-${id}` : undefined,
      style: { anchorName: `--${PREFIX}-tip-${id}` },
      onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false), onFocus: () => setOpen(true), onBlur: () => setOpen(false),
    }, '?'),
    open ? h('span', { role: 'tooltip', id: `${PREFIX}-tip-${id}`, className: `${PREFIX}-bubble`, style: { positionAnchor: `--${PREFIX}-tip-${id}` } }, text) : null);
}

function Tag({ tone = 'outline', children, title, icon }) {
  return h('span', { className: `${PREFIX}-tag`, 'data-tone': tone, title }, icon ?? null, children);
}

/** Status dot; `busy` renders a spinner instead. */
function StatusDot({ tone }) {
  if (tone === 'busy') return h('span', { className: `${PREFIX}-dot-wrap` }, h(Spinner, { size: 10 }));
  return h('span', { className: `${PREFIX}-dot`, 'data-tone': tone, 'aria-hidden': true });
}

/**
 * Dropdown select whose options can carry a second line. Menu uses the popover
 * top layer with anchor positioning so it escapes the settings scroller.
 * options: [{ value, label, detail?, group?, disabled? }]
 */
function Select({ label, value, options, onChange, disabled, placeholder, icon, id }) {
  const anchor = `--${PREFIX}-sel-${useId().replace(/:/g, '')}`;
  const menu = useRef(null);
  const trigger = useRef(null);
  const [open, setOpen] = useState(false);
  const current = options.find(option => option.value === value);
  const enabled = options.filter(option => !option.disabled);
  const focusOption = (target) => {
    const node = menu.current?.querySelector(`[data-value="${CSS.escape(String(target))}"]`);
    node?.focus();
  };
  const show = () => {
    if (disabled) return;
    menu.current?.showPopover?.();
  };
  const choose = (next) => {
    menu.current?.hidePopover?.();
    trigger.current?.focus();
    if (next !== value) onChange(next);
  };
  const onMenuKey = (event) => {
    const index = enabled.findIndex(option => String(option.value) === event.target.dataset?.value);
    if (event.key === 'ArrowDown') { event.preventDefault(); focusOption(enabled[(index + 1) % enabled.length]?.value); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusOption(enabled[(index - 1 + enabled.length) % enabled.length]?.value); }
    else if (event.key === 'Home') { event.preventDefault(); focusOption(enabled[0]?.value); }
    else if (event.key === 'End') { event.preventDefault(); focusOption(enabled[enabled.length - 1]?.value); }
    else if (event.key === 'Tab') { menu.current?.hidePopover?.(); }
  };
  let lastGroup;
  return h(Fragment, null,
    h('button', {
      ref: trigger, id, type: 'button', className: `${PREFIX}-select`, disabled, 'aria-haspopup': 'listbox', 'aria-expanded': String(open),
      'aria-label': label, style: { anchorName: anchor },
      onClick: show,
      onKeyDown: (event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } },
    },
    icon ?? null,
    h('span', { className: cx(`${PREFIX}-select-text`, !current && `${PREFIX}-placeholder`) }, current ? current.label : (placeholder ?? '')),
    h('span', { className: `${PREFIX}-select-chevron` }, Icon.chevronDown(12))),
    h('div', {
      ref: menu, popover: 'auto', className: `${PREFIX}-menu`, role: 'listbox', 'aria-label': label,
      style: { positionAnchor: anchor }, onKeyDown: onMenuKey,
      onToggle: (event) => {
        const opened = event.newState === 'open';
        setOpen(opened);
        if (opened) requestAnimationFrame(() => focusOption(current && !current.disabled ? current.value : enabled[0]?.value));
      },
    },
    options.map((option) => {
      const heading = option.group !== undefined && option.group !== lastGroup
        ? h('div', { key: `g-${option.group}`, className: `${PREFIX}-menu-heading`, role: 'presentation' }, option.group) : null;
      lastGroup = option.group;
      return h(Fragment, { key: String(option.value) }, heading,
        h('div', {
          role: 'option', tabIndex: -1, 'data-value': String(option.value), 'aria-selected': String(option.value === value),
          'aria-disabled': option.disabled ? 'true' : undefined, className: `${PREFIX}-option`,
          onClick: () => { if (!option.disabled) choose(option.value); },
          onKeyDown: (event) => { if ((event.key === 'Enter' || event.key === ' ') && !option.disabled) { event.preventDefault(); choose(option.value); } },
        },
        h('span', { className: `${PREFIX}-option-text` },
          h('span', { className: `${PREFIX}-option-label` }, option.label),
          option.detail ? h('span', { className: `${PREFIX}-option-detail` }, option.detail) : null),
        option.value === value ? h('span', { className: `${PREFIX}-option-check` }, Icon.check(14)) : null));
    })));
}

/** Modal confirmation on a native <dialog>: Escape and the backdrop cancel; focus returns to the opener. */
function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel, danger, busy, error, onConfirm, onCancel }) {
  const ref = useRef(null);
  const opener = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      opener.current?.focus?.();
    }
  }, [open]);
  return h('dialog', {
    ref, className: `${PREFIX}-dialog`, 'aria-labelledby': `${PREFIX}-dlg-title`,
    onCancel: (event) => { event.preventDefault(); if (!busy) onCancel(); },
    onClick: (event) => { if (event.target === ref.current && !busy) onCancel(); },
  },
  open ? h(Fragment, null,
    h('h3', { id: `${PREFIX}-dlg-title` }, title),
    typeof body === 'string' ? h('p', null, body) : body,
    error ? h('p', { className: `${PREFIX}-field-error`, role: 'alert' }, error) : null,
    h('div', { className: `${PREFIX}-dialog-actions` },
      h(Button, { onClick: onCancel, disabled: busy, autoFocus: true }, cancelLabel),
      h(Button, { variant: danger ? 'danger-solid' : 'primary', onClick: onConfirm, busy }, confirmLabel))) : null);
}

function Alert({ tone = 'info', title, children, actions }) {
  return h('div', { className: `${PREFIX}-alert`, 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' },
    h('span', { className: `${PREFIX}-alert-icon` }, tone === 'info' ? Icon.info(14) : Icon.warning(14)),
    h('div', { className: `${PREFIX}-alert-body` },
      title ? h('div', { className: `${PREFIX}-alert-title` }, title) : null,
      children ? h('div', { className: `${PREFIX}-alert-text` }, children) : null,
      actions ? h('div', { className: `${PREFIX}-alert-actions` }, actions) : null));
}

function PageHeader({ title, intro, actions }) {
  return h('header', { className: `${PREFIX}-page-head` },
    h('div', { className: `${PREFIX}-page-titles` },
      h('h2', { className: `${PREFIX}-page-title` }, title),
      intro ? h('p', { className: `${PREFIX}-page-intro` }, intro) : null),
    actions ? h('div', { className: `${PREFIX}-page-actions` }, actions) : null);
}

/** Back link above a detail view; `label` names the parent page. */
function BackBar({ label, onBack, t }) {
  return h('button', { type: 'button', className: `${PREFIX}-back`, onClick: onBack, 'aria-label': `${t('c_back')}: ${label}` },
    Icon.back(14), h('span', null, label));
}

/** Title block of a detail view. When the view opens, its scroll container returns to the top and focus lands on the title. */
function DetailTitle({ title, subtitle, trailing, status }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // The settings content column keeps its scroll offset across views; a newly opened view starts at its top.
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const overflow = window.getComputedStyle(parent).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight) {
        parent.scrollTop = 0;
        break;
      }
    }
    node.focus({ preventScroll: true });
  }, []);
  return h('div', { className: `${PREFIX}-detail-head` },
    h('div', { className: `${PREFIX}-detail-titles` },
      h('div', { className: `${PREFIX}-detail-title-row` },
        h('h2', { ref, tabIndex: -1, className: `${PREFIX}-detail-title` }, title),
        status ?? null),
      subtitle ? h('div', { className: `${PREFIX}-detail-subtitle` }, subtitle) : null),
    trailing ? h('div', { className: `${PREFIX}-detail-trailing` }, trailing) : null);
}

function SectionHeading({ title, count, action, id }) {
  return h('div', { className: `${PREFIX}-section-head` },
    h('h3', { className: `${PREFIX}-section-title`, id }, title,
      count === undefined ? null : h('span', { className: `${PREFIX}-count` }, String(count))),
    action ? h('div', { className: `${PREFIX}-section-action` }, action) : null);
}

/** Collapsible region on <details>; `summary` may include a muted trailing summary text. */
function Disclosure({ title, summary, open, onToggle, children }) {
  return h('details', { className: `${PREFIX}-disclosure`, open, onToggle: onToggle ? (event) => onToggle(event.currentTarget.open) : undefined },
    h('summary', null, h('span', { className: `${PREFIX}-disclosure-title` }, title),
      summary ? h('span', { className: `${PREFIX}-disclosure-summary` }, summary) : null),
    h('div', { className: `${PREFIX}-disclosure-body` }, children));
}

function SearchInput({ value, onValue, placeholder, t, inputRef }) {
  return h('div', { className: `${PREFIX}-search` },
    Icon.search(14),
    h('input', {
      ref: inputRef, type: 'search', value, placeholder, 'aria-label': placeholder,
      onChange: (event) => onValue(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Escape' && value) { event.stopPropagation(); onValue(''); } },
    }),
    value ? h(IconButton, { label: t('c_clearSearch'), icon: Icon.close(12), onClick: () => onValue(''), className: `${PREFIX}-search-clear` }) : null);
}

/** Re-keyed wrapper that plays the view-enter animation whenever `viewKey` changes. */
function ViewFrame({ viewKey, children }) {
  return h('div', { key: viewKey, className: `${PREFIX}-view` }, children);
}

function LoadError({ message, onRetry, t }) {
  return h('div', { className: `${PREFIX}-load-error`, role: 'alert' },
    h('span', null, fill(t('c_loadFailed'), { reason: message })),
    onRetry ? h(Button, { size: 'sm', onClick: onRetry, icon: Icon.refresh(12) }, t('c_retry')) : null);
}

// ---------------------------------------------------------------------------
// Base CSS (tokens only; values follow the Harness settings pages)
// ---------------------------------------------------------------------------

addCss(`
.${PREFIX}-root { display: flex; flex-direction: column; gap: 16px; max-width: 720px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
.${PREFIX}-root *, .${PREFIX}-root *::before, .${PREFIX}-root *::after, .${PREFIX}-menu, .${PREFIX}-dialog, .${PREFIX}-dialog * { box-sizing: border-box; }
.${PREFIX}-view { display: flex; flex-direction: column; gap: 16px; animation: ${PREFIX}-enter 140ms ease-out; }
@keyframes ${PREFIX}-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes ${PREFIX}-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ${PREFIX}-spin { to { transform: rotate(360deg); } }
.${PREFIX}-spinner { flex: none; animation: ${PREFIX}-spin 0.9s linear infinite; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }

.${PREFIX}-page-head { display: flex; align-items: flex-start; gap: 12px; }
.${PREFIX}-page-titles { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.${PREFIX}-page-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.${PREFIX}-page-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-page-actions { flex: none; display: flex; gap: 8px; align-items: center; }

.${PREFIX}-back { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; height: 28px; margin: 0 0 -6px -8px; padding: 0 10px 0 6px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; transition: color 120ms ease, background-color 120ms ease; }
@media (hover: hover) { .${PREFIX}-back:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.${PREFIX}-detail-head { display: flex; align-items: flex-start; gap: 12px; }
.${PREFIX}-detail-titles { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.${PREFIX}-detail-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.${PREFIX}-detail-title { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; line-height: 24px; font-weight: 500; outline: none; }
.${PREFIX}-detail-subtitle { min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; user-select: text; }
.${PREFIX}-detail-trailing { flex: none; display: flex; align-items: center; gap: 8px; padding-top: 2px; }

.${PREFIX}-section { display: flex; flex-direction: column; gap: 12px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-section-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.${PREFIX}-section-title { flex: 1 1 auto; margin: 0; display: inline-flex; align-items: baseline; gap: 6px; font-size: 14px; line-height: 22px; font-weight: 500; }
.${PREFIX}-count { font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.${PREFIX}-section-action { flex: none; display: flex; gap: 6px; }

.${PREFIX}-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-md, 8px); font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer; transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease; }
.${PREFIX}-btn[data-size="sm"] { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm, 6px); font-size: 12px; line-height: 18px; gap: 4px; }
.${PREFIX}-btn[data-variant="primary"] { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary)); color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1)); }
.${PREFIX}-btn[data-variant="secondary"] { box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); background: transparent; color: var(--dsw-alias-label-primary); }
.${PREFIX}-btn[data-variant="ghost"] { background: transparent; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-btn[data-variant="danger"] { background: transparent; color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-btn[data-variant="danger-solid"] { background: var(--dsw-alias-state-error-primary); color: var(--dsw-static-neutral-bluish-00, #fff); }
@media (hover: hover) {
  .${PREFIX}-btn[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill)); }
  .${PREFIX}-btn[data-variant="secondary"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)); }
  .${PREFIX}-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .${PREFIX}-btn[data-variant="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
  .${PREFIX}-btn[data-variant="danger-solid"]:hover:not(:disabled) { filter: brightness(1.08); }
}
.${PREFIX}-btn:disabled { opacity: 0.4; cursor: default; }
.${PREFIX}-btn[aria-busy="true"] { opacity: 0.75; cursor: progress; }
.${PREFIX}-btn:focus-visible, .${PREFIX}-icon-btn:focus-visible, .${PREFIX}-back:focus-visible, .${PREFIX}-select:focus-visible, .${PREFIX}-tip:focus-visible, .${PREFIX}-disclosure > summary:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }

.${PREFIX}-icon-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
@media (hover: hover) {
  .${PREFIX}-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .${PREFIX}-icon-btn[data-tone="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); color: var(--dsw-alias-state-error-primary); }
}
.${PREFIX}-icon-btn[aria-pressed="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-icon-btn:disabled { opacity: 0.4; cursor: default; }

.${PREFIX}-switch { position: relative; flex: none; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); cursor: pointer; transition: background-color 120ms ease; }
.${PREFIX}-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.${PREFIX}-switch:disabled { opacity: 0.5; cursor: default; }
.${PREFIX}-switch[aria-busy="true"] { opacity: 0.7; cursor: progress; }
.${PREFIX}-switch:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 2px; }
.${PREFIX}-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb, var(--dsw-alias-label-primary-foreground, #fff)); transition: transform 120ms ease; }
.${PREFIX}-switch[aria-checked="true"] .${PREFIX}-switch-thumb { transform: translateX(16px); background: var(--dsw-alias-label-primary-foreground, #fff); }

.${PREFIX}-seg { position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; align-self: flex-start; max-width: 100%; padding: 3px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.${PREFIX}-seg-indicator { position: absolute; top: 3px; left: 3px; width: calc((100% - 6px - 2px * (var(--seg-count) - 1)) / var(--seg-count)); height: calc(100% - 6px); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgb(0 0 0 / 0.16)); transform: translateX(calc(var(--seg-index) * (100% + 2px))); transition: transform 160ms ease; pointer-events: none; }
.${PREFIX}-seg-item { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease; }
.${PREFIX}-seg[data-size="sm"] .${PREFIX}-seg-item { height: 24px; padding: 0 10px; font-size: 12px; line-height: 18px; }
.${PREFIX}-seg-item[aria-checked="true"] { color: var(--dsw-alias-label-primary); }
@media (hover: hover) { .${PREFIX}-seg-item:hover:not(:disabled) { color: var(--dsw-alias-label-primary); } }
.${PREFIX}-seg-item:disabled { cursor: default; opacity: 0.5; }
.${PREFIX}-seg-item:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: -2px; }

.${PREFIX}-input { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); outline: none; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; transition: border-color 120ms ease, box-shadow 120ms ease; }
.${PREFIX}-input.${PREFIX}-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.${PREFIX}-input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary)); }
.${PREFIX}-input:focus-visible { border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))) 18%, transparent); }
.${PREFIX}-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-input:disabled, .${PREFIX}-input:read-only { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-textarea { height: auto; padding: 7px 10px; resize: vertical; line-height: 20px; }
.${PREFIX}-textarea.${PREFIX}-mono { line-height: 19px; tab-size: 2; }

.${PREFIX}-checkbox { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.${PREFIX}-checkbox input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.${PREFIX}-checkbox input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 2px; }
.${PREFIX}-checkbox[data-disabled] { cursor: default; opacity: 0.5; }

.${PREFIX}-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.${PREFIX}-field-head { display: flex; align-items: center; gap: 6px; min-height: 18px; }
.${PREFIX}-field-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-required { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-field-action { margin-left: auto; display: inline-flex; gap: 4px; }
.${PREFIX}-field-hint, .${PREFIX}-field-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-field-error { color: var(--dsw-alias-state-error-primary); animation: ${PREFIX}-fade 120ms ease-out; }
.${PREFIX}-row-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }

.${PREFIX}-tip-wrap { display: inline-flex; }
.${PREFIX}-tip { width: 16px; height: 16px; padding: 0; border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius: 50%; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 11px; line-height: 15px; text-align: center; cursor: help; }
@media (hover: hover) { .${PREFIX}-tip:hover { color: var(--dsw-alias-label-primary); } }
.${PREFIX}-bubble { position: fixed; inset: auto; bottom: calc(anchor(top) + 6px); left: anchor(left); position-try-fallbacks: flip-block; z-index: 2147483000; width: max-content; max-width: min(300px, calc(100vw - 24px)); padding: 5px 9px; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-bg-overlay)); color: var(--dsw-static-neutral-bluish-00, var(--dsw-alias-label-primary)); font-size: 12px; line-height: 18px; font-weight: 400; pointer-events: none; animation: ${PREFIX}-fade 120ms ease-out; }

.${PREFIX}-tag { display: inline-flex; align-items: center; gap: 3px; flex: none; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; font-weight: 500; white-space: nowrap; }
.${PREFIX}-tag[data-tone="outline"] { box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-tag[data-tone="neutral"] { background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-secondary); }
.${PREFIX}-tag[data-tone="success"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--dsw-alias-state-success-primary); }
.${PREFIX}-tag[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-tag[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-tag[data-tone="info"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 12%, transparent); color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }

.${PREFIX}-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.${PREFIX}-dot[data-tone="success"] { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); }
.${PREFIX}-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.${PREFIX}-dot[data-tone="idle"] { background: var(--dsw-alias-state-idle-primary); opacity: 0.7; }
.${PREFIX}-dot-wrap { display: inline-flex; width: 10px; height: 10px; align-items: center; justify-content: center; }

.${PREFIX}-select { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; text-align: start; cursor: pointer; transition: background-color 120ms ease; }
@media (hover: hover) { .${PREFIX}-select:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); } }
.${PREFIX}-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.${PREFIX}-select-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-placeholder { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-select-chevron { flex: none; display: inline-flex; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-menu { position: fixed; inset: auto; top: calc(anchor(bottom) + 4px); left: anchor(left); position-try-fallbacks: flip-block; margin: 0; min-width: anchor-size(width); width: max-content; max-width: min(420px, calc(100vw - 24px)); max-height: min(360px, calc(100vh - 24px)); overflow-y: auto; padding: 4px; border: 0; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgb(0 0 0 / 0.24)), inset 0 0 0 0.5px var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.${PREFIX}-menu:popover-open { animation: ${PREFIX}-fade 100ms ease-out; }
.${PREFIX}-menu-heading { padding: 6px 8px 2px; font-size: 11px; line-height: 16px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-option { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 32px; padding: 5px 8px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 20px; cursor: pointer; outline: none; }
.${PREFIX}-option:focus-visible, .${PREFIX}-option:focus { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); }
@media (hover: hover) { .${PREFIX}-option:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); } }
.${PREFIX}-option[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.${PREFIX}-option-text { display: flex; flex-direction: column; min-width: 0; }
.${PREFIX}-option-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-option-check { flex: none; display: inline-flex; color: var(--dsw-alias-label-secondary); }

.${PREFIX}-dialog { width: min(440px, calc(100vw - 48px)); padding: 22px 24px 20px; border: 0; border-radius: var(--dsw-radius-panel, 14px); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgb(0 0 0 / 0.24)); color: var(--dsw-alias-label-primary); }
.${PREFIX}-dialog[open] { animation: ${PREFIX}-enter 140ms ease-out; }
.${PREFIX}-dialog::backdrop { background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 0.5)); backdrop-filter: var(--dsw-mask-blur, none); }
.${PREFIX}-dialog h3 { margin: 0 0 10px; font-size: 16px; line-height: 24px; font-weight: 500; }
.${PREFIX}-dialog p { margin: 0 0 6px; font-size: 13px; line-height: 21px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.${PREFIX}-dialog code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; color: var(--dsw-alias-label-primary); }
.${PREFIX}-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

.${PREFIX}-alert { display: flex; gap: 10px; padding: 10px 12px; border-radius: var(--dsw-radius-lg, 10px); font-size: 13px; line-height: 20px; }
.${PREFIX}-alert[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.${PREFIX}-alert[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 11%, transparent); }
.${PREFIX}-alert[data-tone="info"] { background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); }
.${PREFIX}-alert-icon { flex: none; display: inline-flex; padding-top: 3px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-alert[data-tone="error"] .${PREFIX}-alert-icon { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-alert[data-tone="warn"] .${PREFIX}-alert-icon { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-alert-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.${PREFIX}-alert-title { font-weight: 500; }
.${PREFIX}-alert-text { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.${PREFIX}-alert-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }

.${PREFIX}-disclosure { border-radius: var(--dsw-radius-lg, 10px); }
.${PREFIX}-disclosure > summary { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 2px 4px; margin-left: -4px; border-radius: var(--dsw-radius-sm, 6px); list-style: none; cursor: pointer; }
.${PREFIX}-disclosure > summary::-webkit-details-marker { display: none; }
.${PREFIX}-disclosure > summary::before { content: ''; flex: none; width: 5px; height: 5px; margin: 0 3px 0 2px; border-right: 1.5px solid var(--dsw-alias-label-tertiary); border-bottom: 1.5px solid var(--dsw-alias-label-tertiary); transform: rotate(-45deg); transition: transform 120ms ease; }
.${PREFIX}-disclosure[open] > summary::before { transform: rotate(45deg); }
.${PREFIX}-disclosure-title { flex: none; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-disclosure-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
@media (hover: hover) { .${PREFIX}-disclosure > summary:hover .${PREFIX}-disclosure-title { color: var(--dsw-alias-label-primary); } }
.${PREFIX}-disclosure-body { display: flex; flex-direction: column; gap: 12px; padding: 10px 0 2px; }

.${PREFIX}-search { position: relative; display: flex; align-items: center; flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-search > svg { position: absolute; left: 11px; pointer-events: none; }
.${PREFIX}-search input { width: 100%; height: 32px; padding: 0 32px 0 32px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); outline: none; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.${PREFIX}-search input::-webkit-search-cancel-button { display: none; }
.${PREFIX}-search input::placeholder { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-search input:focus-visible { border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))) 18%, transparent); }
.${PREFIX}-search-clear { position: absolute; right: 2px; width: 26px; height: 26px; }

.${PREFIX}-card { display: flex; flex-direction: column; min-width: 0; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-xl, 12px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); transition: background-color 160ms ease, border-color 160ms ease; }
.${PREFIX}-module { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); }
.${PREFIX}-add-row { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 44px; border: 1px dashed var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-lg, 10px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; transition: background-color 120ms ease; }
@media (hover: hover) { .${PREFIX}-add-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.${PREFIX}-add-row:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-actions { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-actions-end { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.${PREFIX}-muted { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.${PREFIX}-load-error { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-skeleton { height: 64px; border-radius: var(--dsw-radius-xl, 12px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); opacity: 0.6; animation: ${PREFIX}-pulse 1.2s ease-in-out infinite alternate; }
@keyframes ${PREFIX}-pulse { from { opacity: 0.35; } to { opacity: 0.7; } }
.${PREFIX}-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@media (prefers-reduced-motion: reduce) {
  .${PREFIX}-view, .${PREFIX}-dialog[open], .${PREFIX}-menu:popover-open, .${PREFIX}-bubble, .${PREFIX}-field-error { animation: none; }
  .${PREFIX}-spinner { animation-duration: 2.4s; }
  .${PREFIX}-skeleton { animation: none; }
  .${PREFIX}-switch, .${PREFIX}-switch-thumb, .${PREFIX}-seg-indicator, .${PREFIX}-seg-item, .${PREFIX}-btn, .${PREFIX}-card { transition: none; }
}
`);
