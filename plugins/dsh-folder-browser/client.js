/**
 * Browser half of @pcmid/dsh-folder-browser.
 *
 * Fills ui-workspace's three directory-flow holes (sidebar "Add workspace",
 * the workspace picker, and the new-conversation hero) with a
 * command-palette style folder picker, in the spirit of VS Code's remote
 * "Open Folder" quick input and Raycast: one path field is both the location
 * and the filter, the list below shows the folders of the typed directory,
 * and the keyboard drives everything (↑↓ select, Tab/Enter go in,
 * Backspace on an empty segment goes up, ⌘/Ctrl+Enter opens). Mouse and
 * touch users get rows to click, a parent button, quick-location chips
 * (home, the folders that hold existing workspaces, and /), and an explicit
 * "Open <name>" button.
 *
 * Folders come from the Host through `ctx.uiWorkspace.listDirectory` /
 * `createDirectory`, served by the
 * `@deepseek-ai/dsh-host-directory-picker-browse` backend that this package's
 * Host half mounts, so the dialog browses the Host's disk wherever the
 * browser runs.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-folder-browser',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } = React

    const NS = 'pcmid.folderBrowser'
    const PREFIX = 'dsh-fb'
    const SLOTS = [
      'conversation.hero.workspace.directoryFlow',
      'sidebar.workspaces.directoryFlow',
      'workspace.picker.directoryFlow',
    ]
    /** Quick-location chips besides home and the root: the busiest folders holding workspaces. */
    const MAX_PLACES = 4
    /** Chip labels longer than this show only their last two segments. */
    const MAX_PLACE_LABEL = 28

    const zh = {
      title: '选择工作区文件夹',
      pathLabel: '文件夹路径',
      placeholder: '输入路径，如 ~/projects/',
      up: '上一级',
      places: '常用位置',
      home: '主目录',
      root: '根目录',
      open: '打开',
      openThis: '打开这个文件夹',
      cancel: '取消',
      newFolder: '新建文件夹',
      folderName: '文件夹名称',
      create: '创建',
      createNamed: '新建文件夹「{name}」',
      showHidden: '显示隐藏文件夹',
      workspaceBadge: '工作区',
      loading: '正在读取',
      empty: '这里没有子文件夹',
      noMatch: '没有匹配「{name}」的文件夹',
      truncated: '文件夹太多，只列出了前一部分。没列出的文件夹，输入完整名称后加 / 进入',
      goTo: '进入「{name}」',
      creating: '正在创建…',
      opening: '正在打开…',
      count: '{count} 个文件夹',
      shortcuts: '上下方向键选择，Tab 或回车进入，Backspace 回到上一级；没有选中项时回车打开当前文件夹，{mod}+回车打开选中的文件夹。',
      hintDownCreate: '新建',
      needAbsolute: '请输入以 / 或 ~ 开头的完整路径',
      readFailed: '无法读取这个文件夹',
      retry: '重试',
      hintEnter: '进入',
      hintOpen: '打开',
      hintCreate: '新建',
      hintSelect: '选择',
    }
    const en = {
      title: 'Choose a workspace folder',
      pathLabel: 'Folder path',
      placeholder: 'Type a path, like ~/projects/',
      up: 'Parent folder',
      places: 'Places',
      home: 'Home',
      root: 'Root',
      open: 'Open',
      openThis: 'Open this folder',
      cancel: 'Cancel',
      newFolder: 'New folder',
      folderName: 'Folder name',
      create: 'Create',
      createNamed: 'New folder "{name}"',
      showHidden: 'Show hidden folders',
      workspaceBadge: 'Workspace',
      loading: 'Loading',
      empty: 'No folders here',
      noMatch: 'No folders match "{name}"',
      truncated: 'Too many folders; only the first ones are listed. To open one that is not listed, type its full name followed by /.',
      goTo: 'Go to "{name}"',
      creating: 'Creating…',
      opening: 'Opening…',
      count: '{count} folders',
      shortcuts: 'Arrow keys select, Tab or Enter goes in, Backspace goes up. Enter with nothing selected opens the current folder; {mod}+Enter opens the selected one.',
      hintDownCreate: 'create',
      needAbsolute: 'Type a full path that starts with / or ~',
      readFailed: 'Could not read this folder',
      retry: 'Retry',
      hintEnter: 'go in',
      hintOpen: 'open',
      hintCreate: 'create',
      hintSelect: 'select',
    }

    /* ------------------------------------------------------------------ */
    /* Paths. The Host decides the separator; `home` reveals which one.     */
    /* ------------------------------------------------------------------ */

    function sepOf(home) {
      return home !== null && /^(?:[A-Za-z]:\\|\\\\)/.test(home) ? '\\' : '/'
    }
    function isSep(ch, sep) {
      return ch === '/' || (sep === '\\' && ch === '\\')
    }
    function lastSep(text, sep) {
      return sep === '\\' ? Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/')) : text.lastIndexOf('/')
    }
    function isRoot(path, sep) {
      return sep === '\\' ? /^(?:[A-Za-z]:\\|\\\\[^\\/]+[\\/][^\\/]+[\\/]?)$/.test(path) : path === '/'
    }
    function isAbsolute(text, sep) {
      return sep === '\\' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(text) : text.startsWith('/')
    }
    /** Drop trailing separators, keeping a root intact. */
    function trimEnd(path, sep) {
      let out = path
      while (out.length > 1 && isSep(out.at(-1), sep) && !isRoot(out, sep)) out = out.slice(0, -1)
      return out
    }
    /** Absolute path → field text: `~` for home, always ending with a separator. */
    function toField(path, home, sep) {
      let text = path
      if (home !== null && (path === home || path.startsWith(home + sep))) text = '~' + path.slice(home.length)
      return isSep(text.at(-1), sep) ? text : text + sep
    }
    /** Field directory part (ends with a separator) → absolute path, or null when not absolute. */
    function fromField(dirText, home, sep) {
      if (dirText === '') return null
      let text = dirText
      if (text.startsWith('~')) {
        if (text.length > 1 && !isSep(text[1], sep)) return null
        text = home + text.slice(1)
      }
      return isAbsolute(text, sep) ? trimEnd(text, sep) : null
    }
    function parentOf(path, sep) {
      const trimmed = trimEnd(path, sep)
      if (isRoot(trimmed, sep)) return null
      const at = lastSep(trimmed, sep)
      if (at === -1) return null
      return trimEnd(trimmed.slice(0, at + 1), sep)
    }
    function baseName(path, sep) {
      const trimmed = trimEnd(path, sep)
      const at = lastSep(trimmed, sep)
      return at === -1 || isRoot(trimmed, sep) ? trimmed : trimmed.slice(at + 1)
    }
    function placeLabel(path, home, sep) {
      const text = trimEnd(toField(path, home, sep), sep)
      if (text.length <= MAX_PLACE_LABEL) return text
      const parts = text.split(sep === '\\' ? /[\\/]/ : '/').filter(Boolean)
      return '…' + sep + parts.slice(-2).join(sep)
    }
    function validName(name) {
      return name.trim() !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name)
    }
    function childPath(dir, name, sep) {
      return isSep(dir.at(-1), sep) ? dir + name : dir + sep + name
    }
    /** Windows and macOS homes sit on case-insensitive disks by default; compare names folded there. */
    function folderOf(home, sep) {
      return sep === '\\' || (home ?? '').startsWith('/Users/') ? name => name.toLowerCase() : name => name
    }

    function fill(text, vars) {
      return text.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
    }
    function failureText(error) {
      const remote = error?.rpcError ?? error?.error
      if (typeof remote?.message === 'string' && remote.message !== '') return remote.message
      return error instanceof Error ? error.message : String(error)
    }
    /**
     * Whether to put the caret in the path field: yes with a keyboard in use, no on
     * touch screens, where it would raise the soft keyboard over the list. DSH marks
     * the current modality on <html data-input-modality>.
     */
    function wantsFieldFocus() {
      if (document.documentElement.dataset.inputModality === 'keyboard') return true
      return !(typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
    }
    /** IME composition, including Safari's confirming Enter that arrives after compositionend with keyCode 229. */
    function composingKey(event, composing) {
      return composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    }
    const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
    const MOD = IS_MAC ? '⌘' : 'Ctrl'

    const EMPTY = []
    const selectWorkspaceItems = snapshot => snapshot?.items ?? EMPTY
    const useNoWorkspaces = () => EMPTY

    /* ------------------------------------------------------------------ */
    /* Icons: 16px line art in currentColor.                                */
    /* ------------------------------------------------------------------ */

    function svg(size, className, children) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, className,
      }, children)
    }
    const FOLDER = 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.6l1.5 1.6h4.7A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4z'
    const Icon = {
      folder: ({ size = 16, className }) => svg(size, className, h('path', { d: FOLDER })),
      folderPlus: ({ size = 16, className }) => svg(size, className, [
        h('path', { key: 'f', d: FOLDER }), h('path', { key: 'p', d: 'M8 7v3.6M6.2 8.8h3.6' }),
      ]),
      home: ({ size = 14, className }) => svg(size, className, h('path', { d: 'M2.5 7.2 8 2.8l5.5 4.4M4 6.2v6.8h2.8V10h2.4v3H12V6.2' })),
      drive: ({ size = 14, className }) => svg(size, className, [
        h('rect', { key: 'r', x: 2, y: 4, width: 12, height: 8, rx: 1.6 }), h('path', { key: 'd', d: 'M10.5 8h1' }),
      ]),
      up: ({ size = 16, className }) => svg(size, className, h('path', { d: 'M12.5 13H8A2.5 2.5 0 0 1 5.5 10.5V3M2.8 5.7 5.5 3l2.7 2.7' })),
      plus: ({ size = 14, className }) => svg(size, className, h('path', { d: 'M8 3.5v9M3.5 8h9' })),
      eye: ({ size = 16, className }) => svg(size, className, [
        h('path', { key: 'e', d: 'M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z' }),
        h('circle', { key: 'c', cx: 8, cy: 8, r: 2 }),
      ]),
      eyeOff: ({ size = 16, className }) => svg(size, className, [
        h('path', { key: 'e', d: 'M6.3 3.8A6.6 6.6 0 0 1 8 3.6C12 3.6 14.4 8 14.4 8a12 12 0 0 1-1.7 2.3M4.2 4.9C2.5 6.1 1.6 8 1.6 8S4 12.4 8 12.4c1.1 0 2.1-.3 3-.8' }),
        h('path', { key: 's', d: 'M2.5 2.5l11 11' }),
      ]),
      chevron: ({ size = 14, className }) => svg(size, className, h('path', { d: 'M6 3.8 10.2 8 6 12.2' })),
      alert: ({ size = 20, className }) => svg(size, className, [
        h('circle', { key: 'c', cx: 8, cy: 8, r: 6 }), h('path', { key: 'l', d: 'M8 5v3.4M8 10.9v.1' }),
      ]),
    }

    /* ------------------------------------------------------------------ */
    /* Styles. Theme tokens only; fallbacks name tokens the theme lists.    */
    /* ------------------------------------------------------------------ */

    const P = PREFIX
    const ACCENT = 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))'
    const TERTIARY = 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))'
    const HAIRLINE = 'var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))'
    const HOVER = 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1))'
    const ACTIVE = 'var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)))'
    const CSS = `
.${P}-dialog { box-sizing: border-box; width: min(640px, calc(100vw - 32px)); height: min(520px, calc(100dvh - 48px)); max-width: none; max-height: none; margin: auto; padding: 0; border: 0; border-radius: var(--dsw-radius-panel, 14px); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgb(0 0 0 / 0.28)); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; overflow: hidden; outline: none; }
.${P}-dialog[open] { display: flex; flex-direction: column; animation: ${P}-enter 160ms cubic-bezier(0.2, 0, 0, 1); }
.${P}-dialog::backdrop { background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 0.45)); backdrop-filter: var(--dsw-mask-blur, none); }
.${P}-dialog *, .${P}-dialog *::before, .${P}-dialog *::after { box-sizing: border-box; }
@keyframes ${P}-enter { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: none; } }
.${P}-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.${P}-top { flex: none; border-bottom: 0.5px solid ${HAIRLINE}; }
.${P}-title { margin: 0; padding: 14px 18px 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.${P}-head { position: relative; display: flex; align-items: center; gap: 10px; padding: 4px 10px 6px 18px; }
.${P}-head-icon { flex: none; color: var(--dsw-alias-label-secondary); }
.${P}-input { flex: 1; min-width: 0; height: 40px; padding: 0; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 15px; line-height: 22px; }
.${P}-input::placeholder { color: ${TERTIARY}; }
.${P}-progress { position: absolute; left: 0; right: 0; bottom: -0.5px; height: 2px; overflow: hidden; opacity: 0; animation: ${P}-reveal 0s linear 160ms forwards; pointer-events: none; }
.${P}-progress::after { content: ''; position: absolute; top: 0; bottom: 0; left: -35%; width: 35%; border-radius: 2px; background: ${ACCENT}; animation: ${P}-slide 1.1s ease-in-out infinite; }
@keyframes ${P}-reveal { to { opacity: 1; } }
@keyframes ${P}-slide { to { left: 100%; } }

.${P}-icon-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.${P}-icon-btn[aria-pressed="true"] { background: ${ACTIVE}; color: var(--dsw-alias-label-primary); }
.${P}-icon-btn:disabled { opacity: 0.35; cursor: default; }
@media (hover: hover) { .${P}-icon-btn:hover:not(:disabled) { background: ${HOVER}; color: var(--dsw-alias-label-primary); } }

.${P}-places { display: flex; gap: 6px; padding: 0 14px 12px; overflow-x: auto; scrollbar-width: none; }
.${P}-places::-webkit-scrollbar { display: none; }
.${P}-chip { flex: none; display: inline-flex; align-items: center; gap: 5px; max-width: 240px; height: 26px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; box-shadow: inset 0 0 0 0.5px ${HAIRLINE}; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.${P}-chip[aria-current="true"] { background: ${ACTIVE}; box-shadow: none; color: var(--dsw-alias-label-primary); }
@media (hover: hover) { .${P}-chip:hover { background: ${HOVER}; color: var(--dsw-alias-label-primary); } }
.${P}-chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

.${P}-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.${P}-body[inert] { opacity: 0.6; }
.${P}-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; scroll-padding: 6px; outline: none; }
.${P}-list[data-stale] { pointer-events: none; opacity: 0.5; transition: opacity 120ms ease 160ms; }
.${P}-row { display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 6px 0 12px; border-radius: var(--dsw-radius-md, 8px); color: var(--dsw-alias-label-primary); cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent; }
.${P}-row[aria-selected="true"] { background: ${ACTIVE}; }
@media (hover: hover) { .${P}-row:hover { background: ${HOVER}; } .${P}-row[aria-selected="true"]:hover { background: ${ACTIVE}; } }
.${P}-row-icon { flex: none; color: var(--dsw-alias-label-secondary); }
.${P}-row[aria-selected="true"] .${P}-row-icon { color: var(--dsw-alias-label-primary); }
.${P}-row[data-hidden] .${P}-row-icon, .${P}-row[data-hidden] .${P}-row-name { opacity: 0.55; }
.${P}-row[data-kind="create"] .${P}-row-icon, .${P}-row[data-kind="goto"] .${P}-row-icon, .${P}-draft .${P}-row-icon { color: ${ACCENT}; }
.${P}-row[data-kind="create"] .${P}-row-name, .${P}-row[data-kind="goto"] .${P}-row-name { color: var(--dsw-alias-label-secondary); }
.${P}-row[data-kind="create"][aria-selected="true"] .${P}-row-name, .${P}-row[data-kind="goto"][aria-selected="true"] .${P}-row-name { color: var(--dsw-alias-label-primary); }
.${P}-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${P}-row-name[data-filtered] { color: var(--dsw-alias-label-secondary); }
.${P}-row-name mark { background: none; color: var(--dsw-alias-label-primary); font-weight: 600; }
.${P}-badge { flex: none; padding: 0 6px; border-radius: 4px; box-shadow: inset 0 0 0 0.5px ${HAIRLINE}; color: ${TERTIARY}; font-size: 11px; line-height: 18px; }
.${P}-row-open { flex: none; height: 24px; padding: 0 10px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-2, transparent); box-shadow: inset 0 0 0 0.5px ${HAIRLINE}; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; visibility: hidden; }
.${P}-row[aria-selected="true"] .${P}-row-open, .${P}-draft .${P}-row-open { visibility: visible; }
.${P}-row-open:disabled { opacity: 0.4; cursor: default; }
@media (hover: hover) { .${P}-row:hover .${P}-row-open { visibility: visible; } .${P}-row-open:hover:not(:disabled) { background: ${HOVER}; } }
@media (hover: none) { .${P}-list .${P}-row-open { display: none; } }
.${P}-row-chevron { flex: none; color: ${TERTIARY}; }
.${P}-draft { flex: none; margin: 6px 6px 0; cursor: default; }
.${P}-draft-input { flex: 1; min-width: 0; height: 26px; margin-left: -6px; padding: 0 6px; border: 0; border-radius: var(--dsw-radius-sm, 6px); outline: none; background: transparent; box-shadow: inset 0 0 0 1px ${ACCENT}; color: var(--dsw-alias-label-primary); font: inherit; }
.${P}-draft-input::placeholder { color: ${TERTIARY}; }

.${P}-nomatch { flex: none; padding: 10px 18px 0; color: ${TERTIARY}; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.${P}-note { flex: none; margin: 6px 6px 0; padding: 6px 12px; border-radius: var(--dsw-radius-md, 8px); background: ${HOVER}; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.${P}-error { flex: none; padding: 8px 18px; border-top: 0.5px solid ${HAIRLINE}; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.${P}-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 32px 24px; color: var(--dsw-alias-label-secondary); text-align: center; overflow-wrap: anywhere; }
.${P}-list .${P}-state { height: 100%; }
.${P}-state-title { color: var(--dsw-alias-label-primary); font-weight: 500; }
.${P}-state[data-tone="error"] .${P}-state-icon { color: var(--dsw-alias-state-error-primary); }
.${P}-state-icon { color: ${TERTIARY}; margin-bottom: 2px; }
.${P}-state-detail { max-width: 420px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.${P}-state .${P}-btn { margin-top: 8px; }

.${P}-foot { flex: none; display: flex; align-items: center; gap: 4px; padding: 12px 16px 12px 12px; border-top: 0.5px solid ${HAIRLINE}; }
.${P}-foot-right { display: flex; align-items: center; gap: 8px; min-width: 0; margin-left: auto; }
.${P}-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; height: 36px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; white-space: nowrap; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.${P}-btn[data-variant="ghost"] { padding: 0 10px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.${P}-btn[data-variant="outline"] { box-shadow: inset 0 0 0 0.5px ${HAIRLINE}; }
.${P}-btn[data-variant="primary"] { flex: 0 1 auto; max-width: 280px; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary)); color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1)); }
.${P}-btn:disabled { opacity: 0.4; cursor: default; }
.${P}-btn[aria-busy="true"] { opacity: 0.7; cursor: progress; }
@media (hover: hover) {
  .${P}-btn[data-variant="ghost"]:hover:not(:disabled), .${P}-btn[data-variant="outline"]:hover:not(:disabled) { background: ${HOVER}; color: var(--dsw-alias-label-primary); }
  .${P}-btn[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary))); }
}
.${P}-btn-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.${P}-spinner { flex: none; width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent; animation: ${P}-spin 0.7s linear infinite; }
@keyframes ${P}-spin { to { transform: rotate(360deg); } }
.${P}-hints { display: flex; align-items: center; gap: 12px; margin-right: 6px; color: ${TERTIARY}; font-size: 12px; line-height: 18px; white-space: nowrap; }
.${P}-hint { display: inline-flex; align-items: center; gap: 5px; }
.${P}-kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px; box-shadow: inset 0 0 0 0.5px ${HAIRLINE}; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 16px; }

.${P}-icon-btn:focus-visible, .${P}-chip:focus-visible, .${P}-btn:focus-visible, .${P}-row-open:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 1px; }

@media (max-width: 680px), (hover: none) { .${P}-hints { display: none; } }
@media (max-width: 480px) {
  .${P}-dialog { width: calc(100vw - 16px); height: min(620px, calc(100dvh - 24px)); }
  .${P}-foot .${P}-btn[data-variant="ghost"] .${P}-btn-label { display: none; }
}
@media (pointer: coarse) {
  .${P}-input, .${P}-draft-input { font-size: max(16px, 1em); }
  .${P}-row { min-height: 44px; }
  .${P}-chip { height: 32px; padding: 0 12px; }
  .${P}-btn { height: 40px; }
  .${P}-icon-btn { width: 40px; height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .${P}-dialog[open], .${P}-progress, .${P}-progress::after, .${P}-spinner { animation: none; }
  .${P}-progress { opacity: 1; }
}
`

    /* ------------------------------------------------------------------ */
    /* Components                                                           */
    /* ------------------------------------------------------------------ */

    function highlight(name, at, length) {
      if (at < 0 || length === 0) return name
      return [name.slice(0, at), h('mark', { key: 'm' }, name.slice(at, at + length)), name.slice(at + length)]
    }

    function Kbd({ keys, label }) {
      return h('span', { className: `${P}-hint` }, h('kbd', { className: `${P}-kbd` }, keys), label)
    }

    function StateView({ tone, icon = Icon.alert, title, detail, action }) {
      return h('div', { className: `${P}-state`, 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' },
        h(icon, { size: 20, className: `${P}-state-icon` }),
        h('div', { className: `${P}-state-title` }, title),
        detail ? h('div', { className: `${P}-state-detail` }, detail) : null,
        action ?? null)
    }

    /** Slot occupant: mounts the dialog only while the owner requests a pick. */
    function FolderBrowserFlow(props) {
      return props.open ? h(FolderBrowserDialog, props) : null
    }

    function FolderBrowserDialog(props) {
      const { busy, onPicked, t } = props
      const useWorkspaceItems = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : useNoWorkspaces
      const workspaces = useWorkspaceItems(selectWorkspaceItems)

      const dialogRef = useRef(null)
      const inputRef = useRef(null)
      const listRef = useRef(null)
      const baseId = useId()
      const listId = `${baseId}-list`
      const titleId = `${baseId}-title`
      const helpId = `${baseId}-help`
      const composing = useRef(false)
      const downOnBackdrop = useRef(false)
      const alive = useRef(true)
      /** Successful listings by requested absolute path, for instant back-and-forth. */
      const cache = useRef(new Map())
      const staleListing = useRef(null)
      const api = useRef(props)
      api.current = props

      const [home, setHome] = useState(null)
      const [bootError, setBootError] = useState(null)
      const [query, setQuery] = useState('')
      const [failure, setFailure] = useState(null)
      const [reload, setReload] = useState(0)
      const [, setLoaded] = useState(0)
      const [showHidden, setShowHidden] = useState(false)
      const [draft, setDraft] = useState(null)
      const [creating, setCreating] = useState(false)
      const [createError, setCreateError] = useState(null)
      const [cursor, setCursor] = useState({ key: '', index: -1 })

      const sep = sepOf(home)
      const fold = useMemo(() => folderOf(home, sep), [home, sep])
      const cut = lastSep(query, sep)
      const dirText = cut === -1 ? '' : query.slice(0, cut + 1)
      const fragment = cut === -1 ? query : query.slice(cut + 1)
      const dirPath = home === null ? null : fromField(dirText, home, sep)
      const listing = dirPath === null ? null : cache.current.get(dirPath) ?? null
      const failed = listing === null && failure !== null && failure.path === dirPath ? failure.message : null
      const loading = home === null ? bootError === null : dirPath !== null && listing === null && failed === null
      if (listing !== null) staleListing.current = listing
      // While the next level loads the previous rows stay on screen, dimmed and inert.
      const shown = listing ?? (loading ? staleListing.current : null)
      const live = listing !== null
      const parentPath = dirPath === null ? null : parentOf(dirPath, sep)
      const locked = busy || creating

      const focusField = useCallback(() => {
        if (wantsFieldFocus()) inputRef.current?.focus()
      }, [])

      const navigateTo = useCallback((path) => {
        setQuery(toField(path, home, sep))
        setDraft(null)
        setCreateError(null)
        focusField()
      }, [home, sep, focusField])

      // Open as a modal in the top layer; restore focus to the opener afterwards.
      useEffect(() => {
        const dialog = dialogRef.current
        const opener = document.activeElement
        alive.current = true
        if (!dialog.open) dialog.showModal()
        if (wantsFieldFocus()) inputRef.current?.focus()
        else dialog.focus()
        return () => {
          alive.current = false
          if (dialog.open) dialog.close()
          if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
        }
      }, [])

      // First listing: the Host home, which also fixes `~` and the separator.
      useEffect(() => {
        if (home !== null) return undefined
        const controller = new AbortController()
        api.current.listDirectory(undefined, controller.signal).then((level) => {
          if (controller.signal.aborted) return
          const levelSep = sepOf(level.home)
          cache.current.set(trimEnd(level.path, levelSep), level)
          setHome(level.home)
          setQuery(toField(level.path, level.home, levelSep))
        }, (error) => {
          if (!controller.signal.aborted) setBootError(failureText(error))
        })
        return () => { controller.abort() }
      }, [reload])

      // List the typed directory whenever it changes; a newer path aborts the older scan.
      useEffect(() => {
        if (dirPath === null || cache.current.has(dirPath)) return undefined
        const controller = new AbortController()
        api.current.listDirectory(dirPath, controller.signal).then((level) => {
          if (controller.signal.aborted) return
          cache.current.set(dirPath, level)
          setLoaded(n => n + 1)
        }, (error) => {
          if (!controller.signal.aborted) setFailure({ path: dirPath, message: failureText(error) })
        })
        return () => { controller.abort() }
      }, [dirPath, reload])

      const workspacePaths = useMemo(() => new Set(workspaces.map(item => item.path)), [workspaces])

      const places = useMemo(() => {
        if (home === null) return EMPTY
        const byParent = new Map()
        for (const item of workspaces) {
          const parent = parentOf(item.path, sep)
          if (parent === null || parent === home || isRoot(parent, sep)) continue
          const seen = byParent.get(parent)
          const at = seen !== undefined && seen.at > item.updatedAt ? seen.at : item.updatedAt
          byParent.set(parent, { path: parent, count: (seen?.count ?? 0) + 1, at })
        }
        const ranked = [...byParent.values()]
          .sort((a, b) => b.count - a.count || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
          .slice(0, MAX_PLACES)
        const list = [{ key: 'home', path: home, label: t('home'), title: home, icon: Icon.home }]
        for (const place of ranked) {
          list.push({ key: place.path, path: place.path, label: placeLabel(place.path, home, sep), title: place.path, icon: Icon.folder })
        }
        const root = sep === '/' ? '/' : /^[A-Za-z]:\\/.test(home) ? home.slice(0, 3) : null
        if (root !== null) list.push({ key: 'root', path: root, label: root, title: t('root'), icon: Icon.drive })
        return list
      }, [workspaces, home, sep, t])

      const rows = useMemo(() => {
        if (shown === null) return EMPTY
        // Filtering ignores case everywhere; whether a name already exists follows the Host's disk (see folderOf).
        const lower = fragment.toLowerCase()
        const allowHidden = showHidden || lower.startsWith('.')
        const out = []
        for (const entry of shown.entries) {
          if (entry.hidden && !allowHidden) continue
          const at = lower === '' ? -1 : entry.name.toLowerCase().indexOf(lower)
          if (lower === '' || at !== -1) out.push({ kind: 'dir', entry, at })
        }
        // Exact name first, then prefix matches; the sort is stable, so Host name order holds within each group.
        if (lower !== '') {
          const rank = row => (row.entry.name === fragment ? 0 : row.entry.name.toLowerCase() === lower ? 1 : row.at === 0 ? 2 : 3)
          out.sort((a, b) => rank(a) - rank(b))
        }
        const needle = fold(fragment)
        if (listing !== null && validName(fragment) && !listing.entries.some(entry => fold(entry.name) === needle)) {
          // A cut-off level may hold the folder without listing it: offer to go there instead of creating it.
          out.push(listing.truncated
            ? { kind: 'goto', name: fragment, path: childPath(listing.path, fragment, sep) }
            : { kind: 'create', name: fragment })
        }
        return out
      }, [shown, listing, fragment, showHidden, fold, sep])

      // Typing highlights the best real folder; the create and go-to suggestions need ↓ or a click.
      const filterKey = `${dirPath}\u0000${fragment}\u0000${showHidden}`
      const defaultIndex = fragment !== '' && rows[0]?.kind === 'dir' ? 0 : -1
      const wanted = cursor.key === filterKey ? cursor.index : defaultIndex
      const activeIndex = live ? Math.min(wanted, rows.length - 1) : -1
      const activeRow = activeIndex >= 0 ? rows[activeIndex] : null
      const moveCursor = (index) => { setCursor({ key: filterKey, index }) }
      const extraRow = rows.length > 0 && rows.at(-1).kind !== 'dir' ? rows.at(-1) : null

      const currentTarget = live && fragment === '' ? { path: listing.path, name: baseName(listing.path, sep) } : null
      const target = activeRow?.kind === 'dir'
        ? { path: activeRow.entry.path, name: activeRow.entry.name }
        : activeRow === null ? currentTarget : null

      const pick = (path) => {
        if (!locked && path) onPicked(path)
      }

      const create = async (name) => {
        if (locked || listing === null || !validName(name)) return
        setCreating(true)
        setCreateError(null)
        try {
          const created = await api.current.createDirectory(listing.path, name)
          if (!alive.current) return
          cache.current.delete(dirPath)
          setCreating(false)
          navigateTo(created)
        } catch (error) {
          if (!alive.current) return
          setCreating(false)
          setCreateError(failureText(error))
        }
      }

      const activate = (row) => {
        if (row.kind === 'dir') navigateTo(row.entry.path)
        else if (row.kind === 'goto') navigateTo(row.path)
        else void create(row.name)
      }

      const retry = () => {
        setFailure(null)
        setBootError(null)
        setReload(n => n + 1)
      }

      const cancel = () => {
        if (!locked) props.onCancel()
      }
      /** Escape backs out one level: the new-folder row first, then the dialog. */
      const escape = useRef(null)
      escape.current = () => {
        if (draft !== null) {
          if (!creating) {
            setDraft(null)
            setCreateError(null)
            focusField()
          }
          return
        }
        cancel()
      }

      useEffect(() => {
        if (activeIndex < 0) return
        listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
      }, [activeIndex, dirPath])
      useEffect(() => {
        if (listRef.current !== null) listRef.current.scrollTop = 0
      }, [dirPath])

      const onFieldKeyDown = (event) => {
        if (composingKey(event, composing.current)) return
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault()
            if (live && rows.length > 0) moveCursor(Math.min(activeIndex + 1, rows.length - 1))
            break
          case 'ArrowUp':
            event.preventDefault()
            if (live) moveCursor(Math.max(activeIndex - 1, -1))
            break
          case 'Tab':
            if (!event.shiftKey && activeRow?.kind === 'dir') {
              event.preventDefault()
              navigateTo(activeRow.entry.path)
            }
            break
          case 'Enter':
            event.preventDefault()
            if (event.repeat || !live) break
            if (event.metaKey || event.ctrlKey) {
              if (target !== null) pick(target.path)
            } else if (activeRow !== null) {
              activate(activeRow)
            } else if (target !== null) {
              pick(target.path)
            }
            break
          case 'Backspace': {
            const field = event.currentTarget
            const atEnd = field.selectionStart === query.length && field.selectionEnd === query.length
            if (fragment === '' && atEnd && parentPath !== null && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault()
              navigateTo(parentPath)
            }
            break
          }
          default:
            break
        }
      }

      const compositionHandlers = {
        onCompositionStart: () => { composing.current = true },
        onCompositionEnd: () => { composing.current = false },
      }

      const listRendered = bootError === null && !(home !== null && dirPath === null) && failed === null

      /* ---------- header ---------- */
      const head = h('div', { className: `${P}-top`, inert: locked ? '' : undefined },
        h('h2', { id: titleId, className: `${P}-title` }, t('title')),
        h('div', { className: `${P}-head` },
          h(Icon.folder, { size: 18, className: `${P}-head-icon` }),
          h('input', {
            ref: inputRef,
            className: `${P}-input`,
            value: query,
            placeholder: t('placeholder'),
            'aria-label': t('pathLabel'),
            'aria-describedby': helpId,
            role: 'combobox',
            'aria-expanded': listRendered,
            'aria-controls': listRendered ? listId : undefined,
            'aria-autocomplete': 'list',
            'aria-activedescendant': activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined,
            spellCheck: false,
            autoComplete: 'off',
            autoCapitalize: 'off',
            autoCorrect: 'off',
            enterKeyHint: 'go',
            onChange: (event) => {
              setQuery(event.target.value)
              setCreateError(null)
            },
            onKeyDown: onFieldKeyDown,
            ...compositionHandlers,
          }),
          h('span', { id: helpId, className: `${P}-sr` }, fill(t('shortcuts'), { mod: MOD })),
          h('button', {
            type: 'button',
            className: `${P}-icon-btn`,
            title: t('up'),
            'aria-label': t('up'),
            disabled: parentPath === null,
            onClick: () => { if (parentPath !== null) navigateTo(parentPath) },
          }, h(Icon.up)),
          loading ? h('span', { className: `${P}-progress`, role: 'progressbar', 'aria-label': t('loading') }) : null),
        places.length > 0
          ? h('div', { className: `${P}-places`, role: 'group', 'aria-label': t('places') },
            places.map(place => h('button', {
              key: place.key,
              type: 'button',
              className: `${P}-chip`,
              title: place.title,
              'aria-current': place.path === dirPath && fragment === '' ? 'true' : undefined,
              onClick: () => { navigateTo(place.path) },
            }, h(place.icon, { size: 14 }), h('span', { className: `${P}-chip-label` }, place.label))))
          : null)

      /* ---------- body ---------- */
      let body
      if (bootError !== null) {
        body = h(StateView, {
          tone: 'error',
          title: t('readFailed'),
          detail: bootError,
          action: h('button', { type: 'button', className: `${P}-btn`, 'data-variant': 'outline', onClick: retry }, t('retry')),
        })
      } else if (home !== null && dirPath === null) {
        body = h(StateView, { tone: 'info', title: t('needAbsolute') })
      } else if (failed !== null) {
        body = h(StateView, {
          tone: 'error',
          title: t('readFailed'),
          detail: failed,
          action: h('button', { type: 'button', className: `${P}-btn`, 'data-variant': 'outline', onClick: retry }, t('retry')),
        })
      } else {
        const draftRow = draft === null ? null : h('div', { className: `${P}-row ${P}-draft` },
          h(Icon.folderPlus, { className: `${P}-row-icon` }),
          h('input', {
            className: `${P}-draft-input`,
            value: draft,
            autoFocus: true,
            placeholder: t('folderName'),
            'aria-label': t('folderName'),
            readOnly: creating,
            spellCheck: false,
            autoComplete: 'off',
            autoCapitalize: 'off',
            onChange: (event) => {
              setDraft(event.target.value)
              setCreateError(null)
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || composingKey(event, composing.current)) return
              event.preventDefault()
              if (!event.repeat) void create(draft)
            },
            onBlur: () => { if (draft.trim() === '' && !creating) setDraft(null) },
            ...compositionHandlers,
          }),
          h('button', {
            type: 'button',
            className: `${P}-row-open`,
            disabled: creating || !validName(draft),
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { void create(draft) },
          }, creating ? t('creating') : t('create')))

        const items = rows.map((row, index) => {
          const selected = index === activeIndex
          const common = {
            id: `${listId}-${index}`,
            role: 'option',
            'aria-selected': selected,
            'data-index': index,
            className: `${P}-row`,
            // Keep focus in the path field so typing and arrows keep working after a click.
            onMouseDown: (event) => { if (document.activeElement === inputRef.current) event.preventDefault() },
            onClick: () => { if (live) activate(row) },
          }
          if (row.kind !== 'dir') {
            const label = row.kind === 'goto'
              ? fill(t('goTo'), { name: row.name })
              : creating && draft === null ? t('creating') : fill(t('createNamed'), { name: row.name })
            return h('div', { ...common, key: `\u0000${row.kind}`, 'data-kind': row.kind },
              h(row.kind === 'goto' ? Icon.chevron : Icon.folderPlus, { className: `${P}-row-icon` }),
              h('span', { className: `${P}-row-name` }, label))
          }
          const { entry } = row
          return h('div', {
            ...common,
            key: entry.path,
            'data-kind': 'dir',
            'data-hidden': entry.hidden ? '' : undefined,
            title: entry.path,
          },
          h(Icon.folder, { className: `${P}-row-icon` }),
          h('span', { className: `${P}-row-name`, 'data-filtered': fragment === '' ? undefined : '' },
            highlight(entry.name, row.at, fragment.length)),
          workspacePaths.has(entry.path) ? h('span', { className: `${P}-badge` }, t('workspaceBadge')) : null,
          h('button', {
            type: 'button',
            tabIndex: -1,
            'aria-hidden': true,
            className: `${P}-row-open`,
            disabled: busy,
            onMouseDown: (event) => { event.preventDefault() },
            onClick: (event) => {
              event.stopPropagation()
              if (live) pick(entry.path)
            },
          }, t('open')),
          h(Icon.chevron, { className: `${P}-row-chevron` }))
        })

        const nothing = shown !== null && rows.length === 0 && draft === null
        const onlySuggestion = shown !== null && fragment !== '' && rows.length === 1 && extraRow !== null
        body = h(Fragment, null,
          shown?.truncated ? h('div', { className: `${P}-note`, role: 'note' }, t('truncated')) : null,
          draftRow,
          onlySuggestion ? h('div', { className: `${P}-nomatch` }, fill(t('noMatch'), { name: fragment })) : null,
          h('div', {
            ref: listRef,
            id: listId,
            role: 'listbox',
            'aria-labelledby': titleId,
            'aria-busy': !live,
            className: `${P}-list`,
            'data-stale': live || shown === null ? undefined : '',
            'aria-hidden': !live && shown !== null ? true : undefined,
          }, items),
          nothing
            ? h('div', { className: `${P}-state`, role: 'status', style: { position: 'absolute', inset: 0, pointerEvents: 'none' } },
              h(Icon.folder, { size: 20, className: `${P}-state-icon` }),
              fragment === '' ? t('empty') : fill(t('noMatch'), { name: fragment }))
            : null,
          live ? h('span', { className: `${P}-sr`, role: 'status' }, fill(t('count'), { count: rows.filter(row => row.kind === 'dir').length })) : null,
          createError !== null ? h('div', { className: `${P}-error`, role: 'alert' }, createError) : null)
      }

      /* ---------- footer ---------- */
      let hints = null
      if (activeRow?.kind === 'dir') {
        hints = [h(Kbd, { key: 'enter', keys: '↵', label: t('hintEnter') }), h(Kbd, { key: 'open', keys: `${MOD} ↵`, label: t('hintOpen') })]
      } else if (activeRow?.kind === 'create') {
        hints = [h(Kbd, { key: 'create', keys: '↵', label: t('hintCreate') })]
      } else if (activeRow?.kind === 'goto') {
        hints = [h(Kbd, { key: 'goto', keys: '↵', label: t('hintEnter') })]
      } else if (target !== null) {
        hints = [h(Kbd, { key: 'open', keys: '↵', label: t('hintOpen') }), h(Kbd, { key: 'select', keys: '↑↓', label: t('hintSelect') })]
      } else if (live && extraRow?.kind === 'create') {
        hints = [h(Kbd, { key: 'create', keys: '↓', label: t('hintDownCreate') })]
      }

      const foot = h('div', { className: `${P}-foot` },
        h('button', {
          type: 'button',
          className: `${P}-btn`,
          'data-variant': 'ghost',
          title: t('newFolder'),
          disabled: !live || draft !== null || locked,
          onClick: () => {
            setDraft('')
            setCreateError(null)
          },
        }, h(Icon.plus), h('span', { className: `${P}-btn-label` }, t('newFolder'))),
        h('button', {
          type: 'button',
          className: `${P}-icon-btn`,
          title: t('showHidden'),
          'aria-label': t('showHidden'),
          'aria-pressed': showHidden,
          disabled: locked,
          onClick: () => { setShowHidden(value => !value) },
        }, h(showHidden ? Icon.eye : Icon.eyeOff)),
        h('div', { className: `${P}-foot-right` },
          hints === null || locked ? null : h('div', { className: `${P}-hints`, 'aria-hidden': true }, hints),
          h('button', { type: 'button', className: `${P}-btn`, 'data-variant': 'outline', disabled: locked, onClick: cancel }, t('cancel')),
          h('button', {
            type: 'button',
            className: `${P}-btn`,
            'data-variant': 'primary',
            disabled: !busy && (target === null || creating),
            'aria-busy': busy,
            title: target?.path,
            onClick: () => { if (target !== null) pick(target.path) },
          }, busy
            ? [h('span', { key: 's', className: `${P}-spinner`, 'aria-hidden': true }), t('opening')]
            : [t('open'), target === null ? null : h('span', { key: 'n', className: `${P}-btn-name` }, target.name)])))

      return h('dialog', {
        ref: dialogRef,
        className: `${P}-dialog`,
        'aria-labelledby': titleId,
        tabIndex: -1,
        onCancel: (event) => {
          event.preventDefault()
          escape.current()
        },
        onClose: () => { if (alive.current) props.onCancel() },
        onPointerDown: (event) => { downOnBackdrop.current = event.target === dialogRef.current },
        onClick: (event) => {
          if (event.target === dialogRef.current && downOnBackdrop.current) cancel()
        },
      }, head, h('div', { className: `${P}-body`, inert: locked ? '' : undefined }, body), foot)
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'folder-browser: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pcmidFolderBrowser = ''
          style.textContent = CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'folder-browser: styles')

        const face = {
          listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
          createDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
          t: ctx.locale.bind(NS),
        }
        const inject = () => face
        // All three holes install as one unit, whichever declaration arrives last.
        ctx.slots.inject(SLOTS[0], () =>
          ctx.slots.inject(SLOTS[1], () =>
            ctx.slots.inject(SLOTS[2], function* () {
              for (const name of SLOTS) yield ctx.slots.register({ name, inject }, FolderBrowserFlow)
            })))
      },
    }
  },
})
