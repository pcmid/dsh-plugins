// Generated from src by scripts/build-client.mjs.
window.__ModuleLoader__.load({ id: "@pcmid/dsh-superagent", factory(require) {
"use strict"; const React = require("react"), h = React.createElement;
const css = ".sx {\n  box-sizing:border-box; width:100%; min-width:0; height:100%; min-height:0; overflow:auto;\n  background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);\n  font:inherit; font-size:14px; line-height:1.5; container:sx-panel / inline-size;\n}\n[data-platform=\"darwin\"] .sx { padding-block-start:var(--dsh-frame-top-clearance,0px); }\n.sx *, .sx *::before, .sx *::after { box-sizing:border-box; }\n.sx :is(button,input,select,textarea){font:inherit;color:inherit}\n.sx button,.sx summary,.sx select{cursor:pointer}\n.sx button:disabled,.sx select:disabled{cursor:default;opacity:.63}\n.sx svg{vertical-align:middle;flex-shrink:0}\n.sx :is(.sx-quiet,.sx-solid){display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);font-size:12px;font-weight:400;line-height:18px}\n.sx .sx-quiet{background:transparent;color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l3)}\n.sx .sx-solid{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}\n.sx :is(.sx-quiet,.sx-solid):disabled{opacity:.4}\n@media (hover:hover){\n  .sx .sx-quiet:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover-solid)}\n  .sx .sx-solid:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover)}\n}\n.sx .sx-fields{min-width:0;max-width:43rem;display:grid;gap:15px;align-content:start}\n.sx .sx-fields>p,.sx .sx-probe>p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65}\n.sx .sx-fields>.sx-quiet{justify-self:start}\n.sx .sx-field{display:grid;gap:5px;font-weight:550;align-items:center}\n.sx .sx-field select{min-width:0;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px 10px;background:var(--dsw-alias-bg-base);font-weight:400}\n.sx .sx-toggle{display:flex;justify-content:space-between;border-bottom:1px solid var(--dsw-alias-border-l1);padding-block:6px 12px}\n.sx .sx-toggle input{width:18px;height:18px;accent-color:var(--dsw-alias-brand-primary)}\n.sx .sx-probe{font-size:13px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}\n.sx .sx-probe[open]>summary{margin-bottom:12px}\n.sx .sx-probe>p{margin-top:8px}\n.sx .sx-decision{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}\n.sx .sx-composer{display:flex;min-width:0;gap:8px;align-items:center;padding:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base)}\n.sx .sx-composer:focus-within{border-color:var(--dsw-alias-brand-primary)}\n.sx .sx-composer input{width:0;min-width:0;flex:1;border:0;background:transparent;padding:7px 5px}\n.sx .sx-artifact{margin:10px 0;max-width:36rem;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}\n.sx .sx-artifact summary{font-weight:600;font-size:13px}\n.sx .sx-artifact summary svg{margin-inline:3px 7px;color:var(--dsw-alias-brand-primary)}\n.sx .sx-artifact summary small{font-weight:450;margin-inline-start:12px;color:var(--dsw-alias-label-secondary)}\n.sx .sx-artifact table{width:100%;border-collapse:collapse;font-size:13px;margin-block:10px}\n.sx .sx-artifact caption{text-align:start;font-size:12px;color:var(--dsw-alias-label-secondary)}\n.sx .sx-artifact :is(th,td){border:1px solid var(--dsw-alias-border-l1);text-align:start;padding:4px 8px}\n.sx .sx-artifact th{background:var(--dsw-alias-bg-layer-1)}\n.sx .sx-text-link{color:var(--dsw-alias-brand-primary);font-size:13px}\n.sx .sx-replay{display:grid;gap:4px;align-items:start;justify-items:start;font-size:13px}\n.sx .sx-replay>small,.sx .sx-replay>details{color:var(--dsw-alias-label-secondary)}\n.sx .sx-replay>details[open]{max-height:min(36vh,26rem);overflow:auto;padding:2px;max-width:100%}\n.sx .sx-replay details details{padding:5px 9px}\n.sx .sx-replay ol{padding-inline-start:20px}\n.sx .sx-replay ol li{margin:5px 0;overflow-wrap:anywhere}\n\n.sx2 {\n  --x2-bg: var(--dsw-alias-bg-base);\n  --x2-text: var(--dsw-alias-label-primary);\n  --x2-muted: var(--dsw-alias-label-secondary);\n  --x2-ink: var(--dsw-alias-brand-primary);\n  --x2-rule: var(--dsw-alias-border-l2);\n  --x2-paper: color-mix(in srgb, var(--x2-muted) 5%, var(--x2-bg));\n  --x2-hover: color-mix(in srgb, var(--x2-muted) 8%, transparent);\n  --x2-selected: color-mix(in srgb, var(--x2-ink) 9%, var(--x2-paper));\n  --x2-menu-fill: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2));\n  --x2-menu-filter: var(--dsw-menu-backdrop-filter, none);\n  --x2-menu-active: var(--dsw-alias-interactive-bg-hover, var(--x2-hover));\n  --x2-menu-caption: var(--dsw-alias-label-caption, var(--x2-muted));\n}\n\n/* DSH resolves elevation at the menu element, including its dark material stroke. */\n.sx2 .x2-role-menu {\n  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);\n  --x2-menu-shadow: var(--dsw-elevation-prominent, 0 0 0 1px var(--x2-rule));\n}\n\n.sx2 {\n  --x2-gutter: clamp(18px, 3.6cqi, 48px);\n  container: x2-space / inline-size;\n  display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0;\n  color: var(--x2-text); background: var(--x2-bg); font: inherit;\n}\n.sx2 :is(h1,h2,h3,h4,p,ul,ol,blockquote) { margin: 0; }\n.sx2 :is(.x2-tree,.x2-events,.x2-history) { list-style: none; padding: 0; }\n.sx2 :is(button,summary,select,input,a,[tabindex]):focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }\n.sx2 :is(.x2-nav button,.x2-read-scroll,.x2-activity-open,.x2-nav-toggle):focus-visible { outline-offset: -2px; }\n\n.sx2 .x2-mast { display: none; }\n.sx2 .x2-desk {\n  display: grid; grid-template-columns: clamp(185px, 24%, 246px) minmax(0,1fr);\n  flex: 1 1 0; min-width: 0; min-height: 0;\n}\n.sx2 .x2-directory {\n  min-height: 0; min-width: 0; overflow: auto; padding: 18px 8px;\n  background: var(--x2-paper); border-inline-end: 1px solid var(--dsw-alias-border-l1);\n}\n.sx2 .x2-brand { padding: 1px 12px 18px; }\n.sx2 .x2-brand h1 { font-size: 19px; font-weight: 580; line-height: 1.4; letter-spacing: -.035em; }\n.sx2 .x2-day h3 {\n  color: var(--x2-muted); font-size: 12px; font-weight: 540; line-height: 1.5;\n}\n.sx2 .x2-sections {\n  display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: stretch;\n  gap: 2px; padding: 2px; margin-bottom: 12px; border-radius: 9px; background: var(--x2-hover);\n}\n.sx2 .x2-directory .x2-sections button {\n  justify-content: center; text-align: center; padding-inline: 4px; font-size: 13px; line-height: 1.35; color: var(--x2-muted);\n}\n.sx2 .x2-directory .x2-sections button[aria-current='page'] {\n  color: var(--x2-text); background: var(--dsw-alias-bg-layer-2); box-shadow: 0 0 0 1px var(--x2-rule);\n}\n.sx2 .x2-case-row:has(> button[aria-current='true']) { background: var(--x2-hover); }\n.sx2 .x2-tree { display: grid; grid-template-columns: minmax(0,1fr); gap: 2px; }\n/* Case rows copy the DSH session row: the shared ellipsis trigger shows on hover, keyboard focus,\n   while its menu is open, and always on touch screens. */\n.sx2 .x2-case-row { display: flex; align-items: center; min-width: 0; border-radius: 8px; padding-inline-end: 12px; }\n.sx2 .x2-case-row > button:first-child { flex: 1; min-width: 0; background: transparent; }\n.sx2 .x2-nav .x2-row-menu {\n  flex: none; display: none; align-items: center; justify-content: center; width: 24px; height: 24px; min-height: 0;\n  margin: -4px; border: none; border-radius: var(--dsw-radius-xs); padding: 0; background: transparent; cursor: pointer;\n  color: var(--dsw-alias-label-tertiary);\n}\n.sx2 .x2-nav .x2-row-menu:focus-visible { outline-offset: -2px; }\n.sx2 .x2-case-row:has(.x2-row-menu[aria-expanded='true']) { background: var(--x2-hover); }\n.sx2 .x2-case-row:has(.x2-row-menu[aria-expanded='true']) .x2-row-menu,\nhtml[data-input-modality='keyboard'] .sx2 .x2-case-row:focus-within .x2-row-menu { display: inline-flex; }\n@media (hover:hover) {\n  .sx2 .x2-case-row:hover { background: var(--x2-hover); }\n  .sx2 .x2-case-row:hover .x2-row-menu { display: inline-flex; }\n  .sx2 .x2-nav .x2-row-menu:hover { color: var(--dsw-alias-label-primary); }\n}\n@media (hover:none) { .sx2 .x2-nav .x2-row-menu { display: inline-flex; } }\n.sx2 .x2-nav button, .sx2 .x2-nav-toggle, .sx2 .x2-config-nav button,\n.sx2 .x2-material-toggle, .sx2 .x2-back {\n  display: inline-flex; align-items: center; gap: 6px; min-height: 32px;\n  padding: 5px 10px; border: 0; border-radius: 8px; box-shadow: none;\n  background: transparent; color: var(--x2-muted); font: inherit; font-size: 13px;\n  line-height: 22px; text-align: start; cursor: pointer;\n}\n.sx2 .x2-nav button {\n  width: 100%; min-width: 0; padding-inline: 12px; color: var(--x2-text);\n  font-size: 14px; overflow-wrap: anywhere; white-space: normal;\n}\n.sx2 .x2-lead-info { padding-inline: 12px; color: var(--x2-muted); font-size: 12px; line-height: 1.6; }\n.sx2 .x2-lead-info strong { display: block; color: var(--x2-text); font-size: 13px; font-weight: 540; overflow-wrap: anywhere; }\n.sx2 :is(.x2-nav,.x2-config-nav) button[aria-current='page'] { background: var(--x2-selected); color: var(--x2-text); font-weight: 580; }\n.sx2 .x2-state { display: inline-flex; align-items: center; gap: 6px; color: var(--x2-muted); font-size: 12px; }\n.sx2 .x2-dot { display: inline-block; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--x2-muted); }\n.sx2 .x2-dot[data-status='delivered'] { background: var(--dsw-alias-state-success-primary); }\n.sx2 .x2-dot:is([data-status='uncertain'],[data-status='stopped'],[data-status='awaiting-release'],[data-status='question-release']) { background: var(--dsw-alias-state-warn-primary); }\n.sx2 .x2-dot[data-status='failed'] { background: var(--dsw-alias-state-error-primary); }\n\n.sx2 .x2-panel, .sx2 .x2-reader { min-height: 0; min-width: 0; height: 100%; }\n.sx2 .x2-reader { display: flex; flex-direction: column; }\n.sx2 .x2-subject, .sx2 .x2-page {\n  padding: clamp(19px,3.1cqi,38px) var(--x2-gutter) 0; min-width: 0; overflow-wrap: anywhere;\n}\n.sx2 .x2-subject { flex: none; overflow: auto; max-height: 42%; }\n.sx2 .x2-subject::after {\n  content: ''; display: block; max-width: 62rem; margin-top: 15px; border-bottom: 1px solid var(--x2-rule);\n}\n.sx2 .x2-record-title, .sx2 .x2-owners, .sx2 .x2-page-head {\n  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px;\n}\n.sx2 .x2-record-title { align-items: baseline; justify-content: space-between; max-width: 62rem; }\n.sx2 :is(.x2-subject,.x2-page) h2 { margin: 0; font-size: clamp(20px,2.3cqi,27px); line-height: 1.4; font-weight: 610; letter-spacing: -.025em; }\n.sx2 .x2-material-toggle, .sx2 .x2-back { color: var(--x2-ink); font-weight: 510; }\n.sx2 .x2-material-toggle[aria-expanded='true'] { background: var(--x2-paper); }\n.sx2 .x2-material-toggle[aria-expanded='true'] svg { transform: rotate(90deg); }\n.sx2 .x2-owners { font-size: 12.5px; line-height: 1.6; color: var(--x2-muted); }\n.sx2 .x2-owners { margin-top: 5px; }\n.sx2 .x2-subject > .x2-back { margin: 0 0 4px -8px; }\n.sx2 .x2-read-scroll { flex: 1 1 0; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; }\n.sx2 .x2-read-layout { min-width: 0; }\n.sx2 .x2-transcript { padding: 22px var(--x2-gutter) 12px; min-width: 0; }\n.sx2 .x2-events { display: grid; gap: 22px; }\n.sx2 .x2-event { min-width: 0; scroll-margin-block: 16px; }\n.sx2 .x2-event-body, .sx2 .x2-choice { min-width: 0; max-width: 76ch; overflow-wrap: anywhere; }\n.sx2 .x2-byline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 8px; color: var(--x2-muted); line-height: 1.5; }\n.sx2 .x2-byline strong { font-size: 12.5px; font-weight: 560; }\n.sx2 .x2-time, .sx2 .x2-activity-row time { color: var(--x2-muted); font-variant-numeric: tabular-nums; font-size: 12px; }\n.sx2 .x2-event-label { color: var(--x2-muted); font-size: 12px; }\n.sx2 .x2-event-body p, .sx2 .x2-empty { margin-top: 4px; font-size: 14px; line-height: 1.7; white-space: pre-wrap; }\n.sx2 .x2-empty { color: var(--x2-muted); }\n.sx2 .x2-process { max-width: 76ch; margin-block: 12px; }\n.sx2 .x2-process > summary { width: fit-content; max-width: 100%; padding: 5px 1px; font-size: 13px; line-height: 1.6; color: var(--x2-ink); overflow-wrap: anywhere; }\n.sx2 .x2-process[open] > .x2-events { margin: 8px 0; padding-inline-start: 14px; border-inline-start: 1px solid var(--x2-rule); gap: 14px; }\n.sx2 .x2-process-step { position: relative; }\n.sx2 .x2-process-step::before { content: ''; position: absolute; inset-inline-start: -17.5px; top: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--x2-muted); }\n.sx2 .x2-process-step p { margin-top: 2px; font-size: 13px; line-height: 1.55; }\n.sx2 .x2-model-output { display: grid; gap: 12px; margin: 8px 0 4px; }\n.sx2 .x2-model-output:not(:has(.x2-seat-output)) { display: none; }\n.sx2 .x2-model-output > h4 { margin: 0; font-size: 12.5px; font-weight: 560; color: var(--x2-muted); }\n.sx2 .x2-seat-output { display: grid; gap: 6px; min-width: 0; }\n.sx2 .x2-seat-message { display: grid; gap: 2px; min-width: 0; }\n.sx2 .x2-seat-label { font-size: 12px; color: var(--x2-muted); }\n.sx2 .x2-seat-output pre {\n  margin: 0; max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;\n  font: inherit; font-size: 13px; line-height: 1.6; color: var(--x2-text);\n}\n.sx2 .x2-event-body .x2-step-detail, .sx2 .x2-event-body .x2-receipt { color: var(--x2-muted); font-size: 12px; }\n.sx2 .x2-receipt svg { margin-inline-end: 4px; }\n.sx2 .x2-run-result { margin-block: 12px 6px; }\n.sx2 .x2-run-result[data-pending=\"true\"] { border-block-start: 1px solid var(--x2-rule); padding-block: 12px 4px; }\n.sx2 .x2-run-result .x2-approvals { margin-top: 12px; }\n.sx2 .x2-run-result > strong { font-size: 13px; font-weight: 560; }\n.sx2 .x2-choice { margin-block: 12px; }\n.sx2 .x2-compose { flex: none; padding: 8px var(--x2-gutter) 18px; }\n.sx2 .x2-compose .sx-composer {\n  max-width: 62rem; padding: 5px; background: var(--x2-paper);\n  border-color: transparent; border-radius: 12px;\n}\n.sx2 .x2-compose .sx-composer:focus-within { border-color: var(--x2-ink); }\n.sx2 .sx-composer input { padding-inline-start: 9px; }\n.sx2 .sx-composer .sx-solid:disabled { background: transparent; border-color: transparent; color: var(--x2-muted); opacity: 1; }\n.sx2 .x2-rail-title { display: flex; align-items: center; gap: 6px; }\n.sx2 .x2-rail-title, .sx2 .x2-materials h4 { font-size: 12px; color: var(--x2-muted); font-weight: 560; }\n.sx2 .x2-materials {\n  padding: 16px var(--x2-gutter); background: var(--x2-paper); color: var(--x2-text);\n  min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6;\n}\n.sx2 .x2-materials > section { margin-top: 14px; }\n.sx2 .x2-materials h4 { margin-bottom: 4px; }\n.sx2 .x2-materials :is(p,blockquote) { white-space: pre-wrap; }\n.sx2 .x2-materials blockquote { margin: 8px 0; padding-inline-start: 10px; border-inline-start: 2px solid var(--x2-rule); }\n.sx2 .x2-materials cite { display: block; color: var(--x2-muted); font-size: 12px; font-style: normal; }\n.sx2 .x2-intake-context { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }\n.sx2 .x2-intake-context p { margin: 0; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }\n.sx2 .x2-source-details summary { width: fit-content; max-width: 100%; }\n.sx2 .x2-file { overflow-x: auto; padding: 3px; margin: -3px; }\n.sx2 .x2-file .sx-artifact { margin: 0; }\n.sx2 .x2-materials summary { padding-block: 3px; }\n\n.sx2 .x2-page { height: 100%; overflow: auto; padding-bottom: 24px; }\n.sx2 .x2-page-head { gap: 8px; }\n.sx2 .x2-page-head > svg { color: var(--x2-muted); }\n.sx2 .x2-day { max-width: 62rem; margin-top: 22px; }\n.sx2 .x2-day h3 { margin-bottom: 6px; }\n.sx2 .x2-activity-row {\n  position: relative; width: 100%; display: grid; grid-template-columns: 4em 6px minmax(0,1fr) auto;\n  gap: 6px 12px; align-items: baseline; padding: 12px 8px;\n  border: 0; border-radius: 8px; background: transparent;\n  color: var(--x2-text); text-align: start; white-space: normal; font: inherit; cursor: pointer;\n}\n.sx2 .x2-activity-copy { min-width: 0; overflow-wrap: anywhere; }\n.sx2 .x2-activity-open { display: block; padding: 0; border: 0; background: transparent; color: inherit; text-align: start;\n  font-size: 14px; font-weight: 550; line-height: 1.55; overflow-wrap: anywhere; }\n.sx2 .x2-activity-open::after { content: ''; position: absolute; inset: 0; border-radius: 8px; }\n.sx2 .x2-activity-open:focus-visible { outline: none; }\n.sx2 .x2-activity-open:focus-visible::after { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }\n.sx2 .x2-activity-copy small { display: block; }\n.sx2 .x2-activity-copy :is(a, .x2-approvals button) { position: relative; z-index: 1; }\n.sx2 .x2-approval-scope { display: block; margin-top: 6px; color: var(--x2-muted); font-size: 12px; line-height: 18px; }\n.sx2 .x2-approvals { margin: 4px 0 0; padding: 0; border: 0; background: transparent; }\n.sx2 .x2-dropdown svg { transform: rotate(90deg); color: var(--x2-muted); }\n@media (pointer:coarse) { .sx2 .x2-approvals button { min-height: 44px; } }\n.sx2 .x2-activity-copy small { margin-top: 2px; color: var(--x2-muted); font-size: 12px; line-height: 1.55; }\n.sx2 .x2-row-link { pointer-events: none; display: inline-flex; align-items: center; gap: 3px; align-self: center; color: var(--x2-ink); font-size: 12px; }\n.sx2 .x2-history li + li { position: relative; }\n.sx2 .x2-history li + li::before {\n  content: ''; position: absolute; inset: 0 8px auto calc(4em + 38px);\n  border-top: 1px solid var(--dsw-alias-border-l1); pointer-events: none;\n}\n@media (hover:hover) {\n  .sx2 :is(.x2-nav,.x2-config-nav) button:not([aria-current]):not(.x2-row-menu):not(.x2-case-row > button):hover,\n  .sx2 :is(.x2-nav-toggle,.x2-activity-row,.x2-material-toggle,.x2-back):not(:disabled):hover {\n    background: var(--x2-hover); color: var(--x2-text);\n  }\n  .sx2 :is(.x2-row-link,.x2-process > summary,.x2-source-details summary):hover { text-decoration: underline; text-underline-offset: .18em; }\n}\n@container x2-space (min-width:64rem) {\n  .sx2 .x2-read-layout[data-material='true'] {\n    display: grid; grid-template-columns: minmax(0,1fr) clamp(236px,28%,320px); grid-template-areas: 'stream materials'; min-height: 100%; align-items: start;\n  }\n  .sx2 .x2-read-layout[data-material='true'] > .x2-transcript { grid-area: stream; padding-inline-end: clamp(18px,2.2cqi,34px); }\n  .sx2 .x2-read-layout[data-material='true'] > .x2-materials { grid-area: materials; padding: 20px 18px; }\n}\n@container x2-space (width > 42rem) {\n  .sx2 .x2-directory {\n    background: linear-gradient(to right, var(--dsw-specific-sidebar-fill) 66%, var(--x2-bg) 100%);\n    border-inline-end-color: transparent;\n  }\n  .sx2 .x2-tree button > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n}\n@container x2-space (max-width:42rem) {\n  .sx2 .x2-mast { display: flex; flex: none; align-items: center; gap: 8px; padding: 5px 12px 0 8px; }\n  .sx2 .x2-nav-toggle { min-height: 44px; color: var(--x2-ink); font-weight: 540; }\n  .sx2 .x2-brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; }\n  .sx2 .x2-brand .x2-back { width: auto; flex: none; margin-block: -9px; color: var(--x2-muted); }\n  .sx2 .x2-feed-list .x2-day { margin: 12px 12px 0; }\n  .sx2 .x2-nav button { min-height: 44px; }\n  .sx2 .x2-tree button > span:first-child { flex: 1; }\n  .sx2 .x2-subject > .x2-back { display: none; }\n  .sx2 .x2-desk { display: flex; flex-direction: column; }\n  .sx2 .x2-directory { flex: 1; padding-top: 10px; border-inline-end: 0; }\n  .sx2 .x2-desk[data-page='record'] .x2-directory,\n  .sx2 .x2-desk:not([data-page='record']) .x2-panel { display: none; }\n  .sx2 .x2-subject, .sx2 .x2-page { padding-top: 12px; }\n  .sx2 .x2-record-title { gap: 2px 6px; }\n  .sx2 .x2-compose { padding-bottom: 11px; }\n}\n@container x2-space (max-width:30rem) {\n  .sx2 .x2-activity-row { grid-template-columns: auto 6px minmax(0,1fr); gap: 2px 8px; padding-inline: 0; }\n  .sx2 .x2-row-link { display: none; }\n  .sx2 .x2-history li + li::before { inset-inline: 0; }\n}\n\n.sx.sx-global-settings, .sx-global-settings .sx2, .sx-global-settings .x2-page { height: auto; overflow: visible; padding: 0; background: transparent; }\n.sx2 .x2-config-nav { display: flex; gap: 4px; flex-wrap: wrap; margin-block: 18px 22px; }\n.sx2 .x2-fields { max-width: 40rem; min-width: 0; }\n.sx2 .x2-team-fields { max-width: 56rem; min-width: 0; container: x2-roles / inline-size; }\n.sx2 .x2-setting-switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 44px; padding-block: 16px; cursor: pointer; }\n.sx2 .x2-team-fields > .x2-setting-switch { margin-top: 16px; padding-inline: 8px; border-top: 0.5px solid var(--dsw-alias-border-l2); }\n.sx2 .x2-source .x2-setting-switch { border-bottom: 0.5px solid var(--dsw-alias-border-l2); }\n.sx2 .x2-setting-switch :is(strong,small) { display: block; }\n.sx2 .x2-setting-switch strong { font-size: 14px; line-height: 20px; font-weight: 500; }\n.sx2 .x2-setting-switch small { margin-top: 4px; color: var(--x2-muted); font-size: 12px; line-height: 18px; }\n.sx2 .x2-setting-switch:has(:disabled) { cursor: default; }\n.sx2 .x2-switch { display: inline-flex; align-items: center; flex: none; width: 36px; height: 20px; margin: 0; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3); }\n.sx2 .x2-switch > span { width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-switch-thumb); transition: transform 120ms ease; }\n.sx2 .x2-switch[aria-checked=\"true\"] { background: var(--dsw-alias-brand-primary); }\n.sx2 .x2-switch[aria-checked=\"true\"] > span { transform: translateX(16px); background: var(--dsw-alias-label-primary-foreground); }\n.sx2 .x2-switch:disabled { opacity: .5; }\n@media (prefers-reduced-motion: reduce) { .sx2 .x2-switch > span { transition: none; } }\n@media (forced-colors: active) { .sx2 .x2-switch { outline: 1px solid ButtonText; } .sx2 .x2-switch[aria-checked] > span { forced-color-adjust: none; background: ButtonText; } .sx2 .x2-switch:focus-visible { outline: 2px solid Highlight; } }\n.sx2 .x2-team-fields > .sx-replay { margin-top: 18px; }\n.sx2 .x2-roles table { width: 100%; border-collapse: collapse; table-layout: fixed; }\n.sx2 .x2-roles :is(th,td) { padding: 10px 8px; text-align: start; overflow-wrap: anywhere; }\n.sx2 .x2-roles thead th { font-size: 12px; font-weight: 500; color: var(--x2-muted); }\n.sx2 .x2-roles th:nth-child(3) { width: 34%; }\n.sx2 .x2-roles tbody tr { border-bottom: 1px solid var(--x2-rule); }\n.sx2 .x2-roles tbody th { font-size: 14px; font-weight: 550; }\n.sx2 .x2-roles td { font-size: 13px; color: var(--x2-muted); }\n.sx2 .x2-role-trigger, .sx2 .x2-roles select {\n  display: inline-flex; min-width: 0; max-width: 100%; min-height: 32px; align-items: center; justify-content: space-between;\n  gap: 8px; padding: 5px 7px; background: transparent; color: var(--x2-text); border: 0; border-radius: 7px; text-align: start;\n}\n.sx2 .x2-role-trigger > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.sx2 .x2-role-trigger svg { color: var(--x2-muted); transform: rotate(90deg); }\n.sx2 .x2-role-trigger:is(:disabled,[aria-disabled=\"true\"]) { color: var(--dsw-alias-label-dimmed); opacity: 1; cursor: default; }\n.sx2 .x2-role-trigger:is(:disabled,[aria-disabled=\"true\"]) svg { color: inherit; }\n.sx2 .x2-role-trigger:not(:disabled,[aria-disabled=\"true\"]):is([aria-expanded=\"true\"],:focus-visible) { background: var(--x2-menu-active); }\n.sx2 .x2-role-menu {\n  position: fixed; inset: auto; margin: 0; width: min(280px,calc(100vw - 16px)); max-height: min(370px,85dvh);\n  padding: 5px; overflow: hidden; border: 1px solid transparent; border-radius: 13px; font: inherit; font-size: 14px;\n  background: var(--x2-menu-fill); color: var(--x2-text); box-shadow: var(--x2-menu-shadow);\n  -webkit-backdrop-filter: var(--x2-menu-filter); backdrop-filter: var(--x2-menu-filter);\n}\n.sx2 .x2-role-menu:popover-open { display: flex; flex-direction: column; }\n.sx2 .x2-menu-search { flex: none; width: 100%; height: 36px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--x2-text); }\n.sx2 .x2-menu-search::placeholder { color: var(--x2-menu-caption); }\n.sx2 .x2-menu-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; }\n.sx2 .x2-menu-group { padding: 6px 9px 3px; color: var(--x2-muted); font-size: 11px; font-weight: 550; }\n.sx2 .x2-role-menu [role=\"option\"] { display: flex; width: 100%; min-height: 34px; justify-content: space-between; align-items: center;\n  gap: 8px; padding: 5px 9px; background: transparent; border: 0; border-radius: 8px; color: inherit; text-align: start; overflow-wrap: anywhere; }\n.sx2 .x2-role-menu [data-active=\"true\"] { background: var(--x2-menu-active); }\n.sx2 .x2-role-menu :is(input,button):focus-visible { outline-offset: -2px; }\n.sx2 .x2-menu-empty { padding: 9px; color: var(--x2-muted); }\n@media (hover:hover) {\n  .sx2 .x2-role-trigger:not(:disabled,[aria-disabled=\"true\"]):hover, .sx2 .x2-role-menu [role=\"option\"]:not(:disabled):hover { background: var(--x2-menu-active); }\n}\n@media (pointer:coarse) {\n  .sx2 .x2-menu-search { min-height: 44px; font-size: 16px; }\n  .sx2 .x2-role-menu [role=\"option\"] { min-height: 44px; }\n}\n/* The model cell opens the same two panes as the composer; the adjacent pickers keep their own sizing. */\n.sx2 .x2-model-menu { box-sizing: border-box; width: max-content; min-width: min(240px,100%,calc(100vw - 24px)); max-width: min(420px,calc(100vw - 24px)); padding: 4px; border: 0; font-size: 13px; }\n.sx2 .x2-model-menu:focus-visible { outline: none; }\n.sx2 .x2-model-menu [role^=\"menuitem\"] { display: flex; width: 100%; min-width: 0; min-height: 34px; gap: 6px; align-items: center;\n  padding: 5px 7px; border: 0; border-radius: var(--dsw-radius-md,8px); background: transparent; text-align: start; font-size: 13px; line-height: 18px; color: inherit; }\n.sx2 .x2-model-menu [role=\"menuitem\"] { padding: 0 8px; line-height: 20px; }\n.sx2 .x2-model-menu [role^=\"menuitem\"] > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.sx2 .x2-model-menu [role=\"menuitemradio\"] > span { flex: 1; }\n.sx2 .x2-model-menu [role^=\"menuitem\"] > svg { flex: none; }\n.sx2 .x2-model-menu .x2-model-current { flex: 1; text-align: end; color: var(--dsw-alias-label-tertiary); }\n.sx2 .x2-model-menu [role=\"menuitem\"] svg { color: var(--dsw-alias-menu-icon); }\n.sx2 .x2-model-menu [role^=\"menuitem\"]:disabled { color: var(--dsw-alias-label-dimmed); }\n.sx2 .x2-model-menu [data-active=\"true\"], .sx2 .x2-model-menu [role^=\"menuitem\"]:focus-visible { background: var(--x2-menu-active); outline: none; }\n@media (hover:hover) { .sx2 .x2-model-menu [role=\"menuitem\"]:not(:disabled):hover { background: var(--x2-menu-active); } }\n.sx2 .x2-model-menu .x2-menu-group {\n  position: sticky; top: 0; z-index: 1; padding: 5px 7px; color: var(--x2-menu-caption);\n  /* DSH's group tint is translucent; back it with a solid layer above scrolling labels. */\n  background-color: var(--dsw-alias-bg-layer-2);\n  background-image: linear-gradient(var(--dsw-alias-menu-group-header-fill),var(--dsw-alias-menu-group-header-fill));\n}\n.sx2 .x2-model-search { position: relative; flex: none; padding-block: 2px 3px; }\n.sx2 .x2-model-search .x2-menu-search { box-sizing: border-box; height: 26px; min-height: 0; padding: 5px 7px; font-size: 12px; }\n.sx2 .x2-model-search:has(button) input { padding-inline-end: 34px; }\n.sx2 .x2-model-search input:focus-visible { outline: none; }\n.sx2 .x2-model-clear { position: absolute; inset: 50% 4px auto auto; transform: translateY(-50%); width: 24px; height: 24px; padding: 0;\n  border: 0; border-radius: 50%; background: transparent; color: var(--x2-muted); line-height: 1; }\n.sx2 .x2-model-menu .x2-menu-empty { margin: 0; padding: 8px; font-size: 12px; line-height: 18px; }\n@media (pointer:coarse) { .sx2 .x2-model-search .x2-menu-search { height: auto; font-size: 16px; } }\n.sx2 .x2-source { gap: 20px; }\n.sx2 .x2-source-section { gap: 10px; }\n.sx2 .x2-source-section + .x2-source-section, .sx2 .x2-source > p + .x2-source-section { border-top: 1px solid var(--x2-rule); padding-top: 16px; }\n.sx2 .x2-account-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }\n.sx2 .x2-account-row > div:first-child p { margin-top: 4px; }\n.sx2 .x2-account-row p, .sx2 .x2-source [role=\"status\"] { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }\n.sx2 .x2-account-row > div:first-child { min-width: 0; }\n.sx2 .x2-source-section h3 { font-size: 14px; line-height: 20px; font-weight: 500; }\n.sx2 .x2-grant:last-child, .sx2 .x2-history-limits { border-bottom: 0; }\n.sx2 .x2-poll-interval, .sx2 .x2-grant .sx-text-link { font-size: 14px; font-weight: 400; line-height: 22px; }\n.sx2 .x2-cli-path small { display: block; margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }\n.sx2 .x2-cli-path-control { display: flex; align-items: center; gap: 8px; width: min(100%,23rem); max-width: 100%; }\n.sx2 .x2-cli-path-control button { flex: none; }\n.sx2 .x2-cli-path input { flex: 1; min-width: 0; height: 36px; padding: 0 8px; border: 0; border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); }\n.sx2 .x2-poll-control { display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); }\n.sx2 .x2-history-fields { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; }\n.sx2 :is(.x2-poll-interval,.x2-history-fields) input { width: 5.5rem; min-width: 72px; height: 36px; padding: 0 8px; border: 0; border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); text-align: center; font-variant-numeric: tabular-nums; }\n@media (pointer:coarse) {\n  .sx2 .x2-source :is(.sx-quiet,.sx-solid,.x2-poll-interval input,.x2-history-fields input,.x2-cli-path input) { min-height: 44px; }\n}\n.sx2 .x2-grant { overflow-wrap: anywhere; }\n.sx2 .x2-source .sx-decision { margin: 0; gap: 4px; }\n.sx2 .x2-auth-flow img { width: min(208px,100%); height: auto; }\n.sx2 .x2-poll-log > summary { width: fit-content; max-width: 100%; padding: 6px 0; font-size: 13px; cursor: pointer; }\n.sx2 .x2-poll-log ol { margin: 0; padding: 0; list-style: none; }\n.sx2 .x2-poll-log li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; padding: 8px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); font-size: 13px; overflow-wrap: anywhere; }\n.sx2 .x2-poll-log :is(time,small) { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }\n@media (pointer:coarse) { .sx2 .x2-poll-log > summary { min-height: 44px; } }\n.sx2 .x2-source [role=\"alert\"] { color: var(--dsw-alias-state-warn-primary); }\n.sx2 .x2-role-note { margin: 18px 8px 0; font-size: 12px; color: var(--x2-muted); }\n@container x2-roles (max-width: 32rem) {\n  .sx2 .x2-roles table, .sx2 .x2-roles tbody { display: block; }\n  .sx2 .x2-roles thead { position: absolute; clip-path: inset(50%); width: 1px; height: 1px; overflow: hidden; }\n  .sx2 .x2-roles tbody tr { display: grid; grid-template-columns: 1fr; padding-block: 10px; }\n  .sx2 .x2-roles tbody th { padding-block: 2px 5px; }\n  .sx2 .x2-roles td { display: grid; grid-template-columns: 5.8em minmax(0,1fr); align-items: center; min-height: 30px; padding-block: 0; }\n  .sx2 .x2-roles td::before { content: attr(data-label); font-size: 12px; }\n  .sx2 .x2-role-trigger, .sx2 .x2-roles select { width: 100%; min-height: 44px; }\n}\n";
// The composer's model menu writes to a live session. These choices write only to the role.
function spaceMenuGroups(groups,query) {
  const needle=query.trim().toLowerCase();
  if (!needle) return groups;
  // Keep provider groups and put prefix matches ahead of ordered subsequence matches.
  function rank(row) {
    const name=row.label.toLowerCase();
    if (name.startsWith(needle)) return -1;
    let last=-1,gaps=0;
    for (const char of needle) {
      const at=name.indexOf(char,last+1);
      if (at<0) return Infinity;
      gaps+=at-last-1;last=at;
    }
    return gaps;
  }
  // The ungrouped inheritance control is not a provider model and must never win a search.
  return groups.filter(g=>g.key!=null).map(g=>({...g,options:g.options.map(row=>({row,score:rank(row)}))
    .filter(x=>Number.isFinite(x.score)).sort((a,b)=>a.score-b.score).map(x=>x.row)})).filter(g=>g.options.length);
}

function spaceMenuBounds(anchor,view,wantHeight,wantWidth,modelMenu=false) {
  const pad=modelMenu?12:8, gap=modelMenu?8:4, left=view.left+pad, top=view.top+pad;
  const right=view.left+view.width-pad, bottom=view.top+view.height-pad;
  const clamp=(v,min,max)=>Math.max(min,Math.min(v,max));
  const width=Math.min(wantWidth,Math.max(1,right-left));
  const start=clamp(anchor.bottom+gap,top,bottom), end=clamp(anchor.top-gap,top,bottom);
  const down=bottom-start, up=end-top;
  const above=(modelMenu && up>=wantHeight) || (down<wantHeight && up>down);
  const height=Math.min(wantHeight,above ? up : down);
  return {left:clamp(modelMenu ? anchor.right-width : anchor.left,left,right-width),top:above ? end-height : start,width,height};
}

function spaceMenuScrollDelta(row,list,pinnedHeight) {
  if (row.bottom>list.bottom) return row.bottom-list.bottom;
  const visibleTop=list.top+Math.min(pinnedHeight,Math.max(0,list.height-row.height));
  return Math.min(0,row.top-visibleTop);
}

function SpaceSelect(props) {
  const {label,value,onChange,groups,disabled}=props;
  if (typeof HTMLElement==='undefined' || !('showPopover' in HTMLElement.prototype))
    return h('select',{'aria-label':label,value,disabled,onChange:e=>onChange(e.target.value)},groups.map((g,i)=>{
      const options=g.options.map(o=>h('option',{key:o.value,value:o.value,disabled:o.disabled},o.label));
      return g.label ? h('optgroup',{key:g.key ?? i,label:g.label},options) : options;
    }));
  return h(SpaceRoleMenu,props);
}

function spaceRolePane(pages,drill) {
  if (!pages) return 'single';
  if (!pages.root || drill==='model') return 'model';
  return drill==='effort' && pages.root[0].options.some(o=>o.value==='effort') ? 'effort' : 'root';
}

function SpaceRoleMenu({label,value,inheritedLabel,onChange,onEffort,tr,groups,pages,disabled}) {
  const id=React.useId(), button=React.useRef(null), panel=React.useRef(null), input=React.useRef(null), list=React.useRef(null);
  const [open,setOpen]=React.useState(false),[query,setQuery]=React.useState(''),[cursor,setCursor]=React.useState(null);
  const [drill,setDrill]=React.useState(null);
  const pane=spaceRolePane(pages,drill);
  const root=pane==='root',effort=pane==='effort',search=pane==='model' && pages.search;
  const options=root ? pages.root : effort ? pages.effort.groups : groups;
  const current=root ? null : effort ? pages.effort.value : value;
  const visible=open ? spaceMenuGroups(options,search ? query : '') : [];
  const enabled=visible.flatMap(g=>g.options.filter(o=>!o.disabled));
  const selected=groups.flatMap(g=>g.options).find(o=>o.value===value);
  const display=value==='' && inheritedLabel ? inheritedLabel : selected?.label;
  const active=enabled.some(o=>o.value===cursor) ? cursor :
    (!query && !root ? enabled.find(o=>o.value===current)?.value : undefined) ?? (root ? null : enabled[0]?.value);
  const activeIndex=enabled.findIndex(o=>o.value===active);
  const activeId=activeIndex<0 ? undefined : id+'-opt-'+activeIndex;
  const focusRow=()=>list.current?.querySelector('[data-active="true"]')?.focus({preventScroll:true});
  const close=()=>{panel.current?.hidePopover();button.current?.focus({preventScroll:true})};
  function navigate(next,focus=null) {setQuery('');setCursor(focus);setDrill(next)}
  function choose(o) {
    if (!o || o.disabled || disabled) return;
    if (root) {navigate(o.value);return}
    close();if(o.value!==current)(effort ? onEffort : onChange)(o.value);
  }
  React.useLayoutEffect(()=>{
    const el=panel.current;
    const toggle=()=>{const shown=el.matches(':popover-open');setOpen(shown);if(!shown)navigate(null)};
    el.addEventListener('toggle',toggle);
    return ()=>el.removeEventListener('toggle',toggle);
  },[]);
  React.useLayoutEffect(()=>{
    if (!open) return;
    const el=panel.current, scroll=list.current, vv=window.visualViewport;
    const place=()=>{
      const v={left:vv?.offsetLeft ?? 0,top:vv?.offsetTop ?? 0,width:vv?.width ?? document.documentElement.clientWidth,height:vv?.height ?? window.innerHeight};
      const chrome=pages ? 8+(input.current?.parentElement.offsetHeight || 0) : 12;
      if (pages) {
        el.style.minWidth=Math.max(1,Math.min(240,v.width-24))+'px';
        el.style.maxWidth=Math.max(1,Math.min(420,v.width-24))+'px';
      }
      const wanted=Math.min(pages ? Math.min(360,Math.max(80,v.height-96)) : 370,chrome+scroll.firstElementChild.offsetHeight+(el.querySelector('[role="status"]')?.offsetHeight || 0));
      const box=spaceMenuBounds(button.current.getBoundingClientRect(),v,wanted,pages ? el.offsetWidth : 238,!!pages);
      if (!pages) el.style.width=box.width+'px';
      Object.assign(el.style,{left:box.left+'px',top:box.top+'px',maxHeight:box.height+'px'});
    };
    const reposition=e=>{if(!el.contains(e.target instanceof Node ? e.target : null)) place()};
    place();
    const observer=new ResizeObserver(place);
    observer.observe(scroll.firstElementChild);observer.observe(button.current);
    window.addEventListener('scroll',reposition,true);window.addEventListener('resize',place);
    vv?.addEventListener('resize',place);vv?.addEventListener('scroll',place);
    return ()=>{observer.disconnect();window.removeEventListener('scroll',reposition,true);window.removeEventListener('resize',place);
      vv?.removeEventListener('resize',place);vv?.removeEventListener('scroll',place)};
  },[open,pane,search]);
  React.useLayoutEffect(()=>{
    if (!open) return;
    if (search && !window.matchMedia('(pointer: coarse)').matches) input.current?.focus({preventScroll:true});
    else if (list.current?.querySelector('[data-active="true"]')) focusRow();
    else panel.current.focus({preventScroll:true});
  },[open,pane,search]);
  React.useLayoutEffect(()=>{
    if (!open) return;
    const row=list.current?.querySelector('[data-active="true"]');
    if (!row) return;
    const header=pane==='model' ? row.closest('[role="group"]')?.querySelector('.x2-menu-group') : null;
    const delta=spaceMenuScrollDelta(row.getBoundingClientRect(),list.current.getBoundingClientRect(),header?.offsetHeight || 0);
    if (delta) list.current.scrollTop+=delta;
  },[open,pane,active,query]);
  function keyDown(e) {
    if (e.nativeEvent.isComposing || e.keyCode===229) return;
    if (e.key==='Escape') {
      e.preventDefault();e.stopPropagation();
      if (pages?.root && !root) navigate(null,pane); else close();
      return;
    }
    const typing=e.target===input.current;
    if (e.key==='Tab') {
      // Keep the search field and its clear button reachable from each other.
      if (search && query && (typing && !e.shiftKey || e.shiftKey && e.target.closest('.x2-model-clear'))) return;
      close();return;
    }
    if (typing && e.key==='Enter') {e.preventDefault();choose(enabled[activeIndex]);return}
    if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key) || typing && ['Home','End'].includes(e.key) || !enabled.length) return;
    e.preventDefault();
    const direction=e.key==='ArrowUp' ? -1 : 1;
    const idx=e.key==='Home' ? 0 : e.key==='End' ? enabled.length-1 : activeIndex<0 ? (direction>0 ? 0 : enabled.length-1) : (activeIndex+direction+enabled.length)%enabled.length;
    setCursor(enabled[idx].value);
    if (!typing) list.current.querySelectorAll('button:not(:disabled)')[idx]?.focus({preventScroll:true});
  }
  let index=0;
  return h(React.Fragment,null,h('button',{type:'button',ref:button,disabled:pages ? undefined : disabled,'aria-disabled':pages && disabled || undefined,className:'x2-role-trigger',popoverTarget:disabled ? undefined : id,
    'aria-label':label+tr('：',': ')+(display || ''),'aria-haspopup':pages?'menu':'dialog','aria-controls':id,'aria-expanded':open,
    onKeyDown:e=>{if(!disabled && (e.key==='ArrowDown' || e.key==='ArrowUp')){e.preventDefault();panel.current?.showPopover()}}},
    h('span',null,display),h(Mark,{name:'chevron',size:12})),
    h('div',{id,ref:panel,popover:'auto',tabIndex:-1,role:pages?'group':'dialog',className:'x2-role-menu'+(pages?' x2-model-menu':''),'data-menu-material':'translucent','aria-label':label,onKeyDown:keyDown,
      onBlur:e=>{if(e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && e.relatedTarget!==button.current && panel.current.matches(':popover-open')) panel.current.hidePopover()}},
      search && h('div',{className:'x2-model-search'},h('input',{type:'text',className:'x2-menu-search',ref:input,value:query,role:'searchbox',placeholder:tr('搜索模型…','Search models…'),
        'aria-label':tr('搜索模型','Search models'),'aria-controls':id+'-list','aria-activedescendant':activeId,
        onChange:e=>{setQuery(e.target.value);setCursor(null)}}),query && h('button',{type:'button',className:'x2-model-clear','aria-label':tr('清除搜索','Clear search'),
          onClick:()=>{setQuery('');setCursor(null);input.current?.focus()}},'×')),
      h('div',{ref:list,id:id+'-list',className:'x2-menu-scroll',role:pages?'menu':'listbox','aria-label':label},
        h('div',{role:'presentation'},visible.map((g,i)=>h('div',{role:'group',key:g.key ?? i,'aria-label':g.label || undefined},
          g.label && h('div',{className:'x2-menu-group','aria-hidden':true},g.label),
          g.options.map(o=>h('button',{type:'button',role:root?'menuitem':pages?'menuitemradio':'option',id:o.disabled ? undefined : id+'-opt-'+index++,key:o.value,tabIndex:-1,
            disabled:o.disabled,'aria-selected':pages?undefined:o.value===value,'aria-checked':pages&&!root?o.value===current:undefined,'aria-haspopup':root?'menu':undefined,
            'data-active':o.value===active,'data-chosen':o.value===current,title:pages?(o.detail || o.label):undefined,
            onMouseMove:pages&&!root&&!o.disabled?e=>{if (search) setCursor(o.value);else e.currentTarget.focus({preventScroll:true})}:undefined,onFocus:()=>setCursor(o.value),onClick:()=>choose(o)},h('span',null,o.label),
            root ? h(React.Fragment,null,h('span',{className:'x2-model-current'},o.detail),h(Mark,{name:'chevron',size:12})) :
              o.value===current && h(Mark,{name:'check',size:pages?14:16}))))))),
      open && !visible.length && h('p',{role:'status',className:'x2-menu-empty'},tr('没有匹配的模型。','No matching models.'))));
}

const spaceRoles = [
  ['lead','Router','Router'],['develop','开发助手','Developer'],['answer','答疑助手','Q&A']
];
function spaceEffortName(id,row,tr) {
  const known={off:['关闭','Off'],none:['无','None'],minimal:['最低','Minimal'],low:['低','Low'],medium:['中','Medium'],high:['高','High'],xhigh:['极高','Extra high'],max:['最高','Max']};
  const label=row?.effortNames && Object.hasOwn(row.effortNames,id) ? row.effortNames[id] : '';
  if (typeof label==='string' && label && label.toLowerCase()!==id.toLowerCase() &&
      (!Object.hasOwn(known,id) || label.toLowerCase()!==known[id][1].toLowerCase())) return label;
  return Object.hasOwn(known,id) ? tr(...known[id]) : (label || id);
}
const spaceRouteKey = (provider,model) => JSON.stringify([provider,model]);

// Keep provider identity: different providers can advertise the same model ID.
function spaceRoleChoice(rows, saved, field, value) {
  if (field === 'model' && value === '') return null;
  if (field === 'effort') {
    if (!value) return saved && !saved.inherit ? {...saved,effort:''} : null;
    const row=spaceEffectiveModel(rows,saved);
    if (!row?.efforts.includes(value)) return undefined;
    return !saved || saved.inherit ? {inherit:true,effort:value} : {...saved,effort:value};
  }
  const row=field==='model' && rows.find(r=>spaceRouteKey(r.providerId,r.modelId)===value);
  return row ? {provider:row.providerId,model:row.modelId,name:row.modelName,effort:''} : undefined;
}

function spaceEffectiveModel(rows,saved) {
  return !saved || saved.inherit ? rows.find(r=>r.isDshDefault) :
    rows.find(r=>r.providerId===saved.provider && r.modelId===saved.model);
}

// A saved choice that disappeared stays visible, but cannot be selected again.
function spaceDefaultOptions(defaultLabel,value,unavailableLabel) {
  const options=[{value:'',label:defaultLabel}];
  if (unavailableLabel!=null) options.push({value,disabled:true,label:unavailableLabel});
  return options;
}

function spaceModelDirectory(catalog) {
  const rows=catalog?.rows || [], providers=new Map();
  for (const row of rows) {
    const {providerId,modelId}=row;
    if (!providers.has(providerId)) providers.set(providerId,{
      key:providerId,label:row.providerName,options:[]
    });
    providers.get(providerId).options.push({value:spaceRouteKey(providerId,modelId),label:row.modelName});
  }
  return {rows,groups:[...providers.values()].sort((a,b)=>Number(b.key==='deepseek-official')-Number(a.key==='deepseek-official')),defaultRow:spaceEffectiveModel(rows),
    status:!catalog ? 'loading' : catalog.error ? 'error' : 'ready'};
}

function spaceRoleModelOptions({rows,groups,defaultRow,status},saved,tr) {
  const inherit=tr('默认','Default'), pinned=saved && !saved.inherit;
  const row=pinned ? spaceEffectiveModel(rows,saved) : defaultRow;
  let model=inherit;
  if (rows.length || saved) {
    const value=pinned ? spaceRouteKey(saved.provider,saved.model) : '';
    const unavailable=pinned && !row ?
      (saved.name || saved.model)+(status==='ready' ? tr('（不在目录中）',' (not listed)') : '') : null;
    const options=spaceDefaultOptions(inherit,value,unavailable);
    model={value,groups:[{options},...groups],inheritedLabel:defaultRow?.modelName};
  }
  const efforts=row?.efforts || [], value=saved?.effort || '';
  let effort;
  if (efforts.length || value) {
    const defaultEffort=(!pinned && row?.configuredEffort) || row?.defaultEffort;
    const inheritedLabel=efforts.includes(defaultEffort) ? spaceEffortName(defaultEffort,row,tr) : inherit;
    const unavailable=value && !efforts.includes(value) ? spaceEffortName(value,row,tr)+tr('（当前不可用）',' (currently unavailable)') : null;
    const options=spaceDefaultOptions(inherit,value,unavailable).concat(efforts.map(e=>({value:e,label:spaceEffortName(e,row,tr)})));
    effort={value,groups:[{options}],inheritedLabel};
  } else {
    effort=status==='loading' ? tr('读取中…','Loading…') :
      !pinned && !row ? tr('默认模型未提供档位','Default model levels not available') :
      row?.capabilitiesKnown ? tr('该模型不可调','Not adjustable for this model') : tr('未提供强度档位','No effort levels listed');
  }
  if (typeof model!=='string') {
    const entries=[{value:'model',label:tr('模型','Model'),detail:row?.modelName}];
    if (efforts.length) {
      const current=value || (!pinned && row.configuredEffort) || row.defaultEffort;
      entries.push({value:'effort',label:tr('推理等级','Effort'),detail:current ? spaceEffortName(current,row,tr) : tr('默认','Default')});
    }
    model.pages={root:row ? [{options:entries}] : null,effort,search:rows.length>4};
  }
  return {model,effort};
}

const goodRow = row => !!row && !row.broken;
// Built-in names come from DSH's settings.agentPreset dictionary, not from role names or preset IDs.
const spaceBuiltinPresets = new Map([
  ['standard',['presetStandardName','Standard mode']], ['ptc',['presetPtcName','PTC mode']],
  ['minimal',['presetMinimalName','Minimal mode']], ['cordis',['presetCordisName','Creator mode']]
]);
function spacePresetRoster(rows,presetText) {
  return rows.flatMap(row=>{
    if (!row || typeof row.id!=='string' || !row.id.trim()) return [];
    const builtin=row.name===undefined && spaceBuiltinPresets.get(row.id);
    const localized=builtin && presetText?.(builtin[0]);
    const name=builtin ? (localized && localized!==builtin[0] ? localized : builtin[1]) :
      typeof row.name==='string' && row.name.trim();
    return name ? [{...row,name,builtin:!!builtin}] : [];
  });
}

function spacePresetLabel(p,role) {
  const {team,roster,rosterStatus,tr}=p;
  if (!team[role]) return tr('默认','Default');
  if (rosterStatus==='loading') return tr('读取中…','Loading…');
  if (rosterStatus==='error') return tr('无法读取','Unavailable');
  const row=roster.find(r=>r.id===team[role]);
  if (!row || row.broken) return tr('预设不可用','Preset unavailable');
  return row.name?.trim() || tr('预设未命名','Unnamed preset');
}

function spacePresetGroups(roster,tr) {
  const choices=roster.filter(goodRow);
  return [false,true].map(builtin=>({key:String(builtin),label:builtin ? tr('DSH 内置','DSH built-in') : tr('自定义预设','Custom presets'),
    options:choices.filter(r=>r.builtin===builtin).map(r=>({value:r.id,label:r.name}))})).filter(g=>g.options.length);
}

function spacePresetOptions({roster,rosterStatus,tr},id,groups) {
  if (rosterStatus!=='ready') return rosterStatus==='loading' ? tr('读取中…','Loading…') : tr('无法读取预设','Presets unavailable');
  const current=roster.find(row=>row.id===id);
  const unavailable=id && !goodRow(current) ? (current ? current.name+tr('（不可用）',' (unavailable)') : tr('原绑定预设不可用','Bound preset unavailable')) : null;
  const options=spaceDefaultOptions(tr('默认','Default'),id,unavailable);
  return {value:id,groups:[{options},...groups]};
}

function SpaceTeamRoles(p) {
  const {tr,team,roleModels,roster,catalog,busy,configure}=p;
  const directory=spaceModelDirectory(catalog), presets=spacePresetGroups(roster,tr);
  const header=[tr('角色','Role'),tr('预设','Preset'),tr('模型','Model'),tr('思考强度','Reasoning effort')];
  function roleRow([role,zh,en]) {
    const name=tr(zh,en), saved=roleModels[role];
    const preset=spacePresetOptions(p,team[role],presets);
    const {model,effort}=spaceRoleModelOptions(directory,saved,tr);
    function choose(field,value) {
      const next=spaceRoleChoice(directory.rows,saved,field,value);
      if (next!==undefined) configure({roleModels:{[role]:next}});
    }
    function cell(column,choice,onChange,onEffort) {
      return h('td',{'data-label':column},typeof choice==='string' ? choice :
        h(SpaceSelect,{...choice,tr,label:name+' · '+column,onChange,onEffort,disabled:busy}));
    }
    return h('tr',{key:role},h('th',{scope:'row'},name),
      cell(header[1],preset,value=>configure({team:{[role]:value}})),
      cell(header[2],model,value=>choose('model',value),value=>choose('effort',value)),
      cell(header[3],effort,value=>choose('effort',value)));
  }
  return h('div',{className:'x2-roles'},h('table',{'aria-label':tr('团队分工','Team roles')},
    h('thead',null,h('tr',null,header.map(v=>h('th',{key:v,scope:'col'},v)))),
    h('tbody',null,spaceRoles.map(roleRow))),
    h('p',{className:'x2-role-note'},tr('更改只用于新事项；已有事项保留原分工。','Changes apply to new cases. Existing cases keep their assignments.')),
    !directory.rows.length && h('p',{className:'x2-role-note'},tr('本机没有已加载的模型目录。','No model catalog is loaded on this client.')));

}

// A run is a projection of the last durable state, not an event log.
function spaceWorkSteps(message,tr) {
  const run=message.run, steps=[], system='SuperAgent', router=spaceRoleLabel('lead',tr), worker='DSH', channel=tr('飞书','Feishu');
  const add=(kind,who,zh,en,detail)=>{
    steps.push({kind,who,stage:tr(zh,en),...(detail?{detail}:{})});
  };
  if (!run) {
    switch (message.status) {
      case 'received': add('intake',system,'已收到消息','Message received');break;
      case 'dispatching': add('assignment',system,'正在提交至 DSH','Submitting to DSH');break;
      case 'submitted': add('assignment',system,'已交给 DSH','Submitted to DSH');break;
      case 'failed': add('stop',system,'提交失败','Submission failed');break;
      case 'uncertain': add('unknown',system,'未确认 DSH 是否接单','Handoff to DSH unconfirmed');break;
      default: add('unknown',system,'办理状态未知','Work status unknown');
    }
    return steps;
  }
  const {status,reason}=run,question=run.outputKind==='question';
  if (status==='queued') add('decision',router,'等待判断','Awaiting assessment');
  else if (status==='deciding') add('decision',router,'正在判断是否办理','Assessing the request');
  else if (status==='ignored') add('decision',router,'判断无需办理','No action needed');
  else if (status==='merged') add('merge',router,'判断为已有事项的补充，已并入','Merged into an earlier request as a follow-up',
    run.mergedTitle && tr('并入：','Merged into: ')+run.mergedTitle);
  else {
    if (run.role) {
      add('decision',router,'决定办理','Accepted for work');
      const role=spaceRoleLabel(run.role,tr);
      const where=run.targetWorkspaceId && tr('工作区：','Workspace: ')+(run.targetWorkspaceTitle || run.targetWorkspaceId);
      const preset=run.presetId && tr('指定预设：','Requested preset: ')+run.presetId;
      add('assignment',router,role?'指派给'+role:'已派工',role?'Assigned to '+role:'Assigned',
        [preset,where].filter(Boolean).join(tr('；','; ')) || undefined);
    }
    // Follow-up messages merged into this request, waiting for its worker.
    if (run.supplements?.length) add('merge',router,'并入 '+run.supplements.length+' 条补充消息，助手将据此继续',
      'Merged '+run.supplements.length+' follow-up message(s); the worker continues with them');
    // The worker checks its own result; there is no separate review step.
    const done=['approved','awaiting-release','declined','delivering','delivered'].includes(status) || !!run.answer;
    if (question) add('worker',worker,'已提出追问','Clarifying question prepared');
    else if (done) add('worker',worker,'已完成办理','Work completed');
    else if (status==='working') add('worker',worker,'正在办理','Working');

    if (status==='awaiting-release') add('release',tr('你','You'),question?'等待你确认发送追问':'等待你确认发送最终答复',question?'Awaiting your confirmation to send the question':'Awaiting your confirmation to send the final reply');
    else if (status==='declined') add('release',tr('你','You'),'已选择不发送','Chose not to send');
    else if (status==='delivering') add('delivery',channel,'正在回复原消息','Replying to the original message');
    else if (status==='waiting-requester' && run.receipt?.messageId) add('delivery',channel,'追问已发送，等待原提需人回复','Question sent; waiting for the original requester');
    else if (status==='delivered' && run.receipt?.messageId) add('delivery',channel,'已回复原消息','Reply delivered');
    else if (['delivered','waiting-requester'].includes(status) || reason==='delivery-uncertain') add('unknown',channel,'送达结果未确认','Delivery unconfirmed');
    else if (reason==='delivery-denied') add('stop',system,'已停止，未发送回复','Stopped without sending a reply');
    else if (reason==='work-uncertain') add('unknown',worker,'助手办理结果未确认','Work outcome unconfirmed');
    else if (status==='taken-over') add('takeover',tr('你','You'),'已接手，SuperAgent 不再办理或发送','Taken over; SuperAgent no longer works on or posts it');
    else if (status==='stopped') {
      const causes={
        'decision-failed':['未能完成判断','Assessment failed'],'invalid-decision':['判断结果无效','Invalid assessment'],
        'work-failed':['未能完成办理','Work could not be completed'],'no-final-answer':['没有可发送的答复','No reply available to send'],
        // Reasons kept for records from the removed review stage.
        'review-stopped':['验收决定停止办理','Review ended the work'],'review-failed':['未能完成验收','Review failed'],
        'invalid-review':['验收结果无效','Invalid review'],'rework-limit':['返工后仍未通过验收','Revision did not pass review'],
        'access-denied':['未能核实当前授权','Current authorization could not be verified'],interrupted:['办理中断','Processing interrupted']
      };
      add('stop',system,'已停止办理','Processing stopped',Object.hasOwn(causes,reason) && tr(...causes[reason]));
    } else if (!['assigned','working','approved'].includes(status)) add('unknown',system,'办理状态未确认','Work status unconfirmed');
  }
  return steps;
}

const spaceMarkPaths={
  lead:'M5 15a7 7 0 0 1-2-5c0-4 4-7 9-7s9 3 9 7-4 7-9 7H9l-5 3z M8 10h8',
  check:'M4 12l5 5L20 6',
  history:'M3 10a9 9 0 1 1 2 8 M3 4v6h6 M12 7v6l4 2',
  chevron:'M9 5l7 7-7 7',back:'M21 12H4 M10 6l-6 6 6 6',
  link:'M10 7l2-2a5 5 0 1 1 7 7l-2 2 M14 17l-2 2a5 5 0 1 1-7-7l2-2 M8 16l8-8'
};
function Mark({name,size=16}) {
  return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.65,
    strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false},h('path',{d:spaceMarkPaths[name]}));
}
function spaceRoleLabel(role,tr) {
  const row=spaceRoles.find(([id])=>id===role);
  return row ? tr(row[1],row[2]) : '';
}
function spaceStatus(status,tr) {
  const labels={'awaiting-access':['待批准','Awaiting approval'],'not-handled':['已收到 · 未办理','Received · not handled'],received:['已收到','Received'],dispatching:['正在提交至 DSH','Submitting to DSH'],
    submitted:['已交给 DSH','Submitted to DSH'],failed:['提交失败','Submission failed'],
    queued:['待判断','Queued'],deciding:['Router 分流中','Router is routing'],assigned:['待承办','Assigned'],working:['助手办理中','In progress'],
    approved:['已完成 · 尚未发送','Done · not yet sent'],
    'awaiting-release':['待你确认发送最终答复','Final reply awaiting your confirmation'],'question-release':['待你确认发送追问','Question awaiting your confirmation'],
    'question-ready':['追问待发送','Question ready to send'],'waiting-requester':['等待原提需人回复','Waiting for the original requester'],declined:['已选择不发送','Not sent by choice'],
    'taken-over':['已由你接手','Taken over by you'],merged:['已并入其他事项','Merged into another request'],
    delivering:['正在回复原消息','Delivering'],delivered:['已回复原消息','Delivered'],ignored:['无需处理','No action needed'],
    stopped:['已停止，未交付','Stopped without delivery'],uncertain:['结果待核实','Outcome unconfirmed']};
  return labels[status] ? tr(...labels[status]) : tr('状态未知','Status unknown');
}
function spaceStatusDot(status) {
  return h('i',{className:'x2-dot','data-status':status,'aria-hidden':true});
}
function spaceWithRuns(cases,runs=[]) {
  const index=new Map();
  for(const r of runs) {
    if(!index.has(r.caseId)) index.set(r.caseId,new Map());
    index.get(r.caseId).set(r.messageId,r);
  }
  const titles=new Map(cases.map(c=>[c.id,c.title]));
  return cases.map(item=>{
    const jobs=index.get(item.id);
    if(!jobs) return item;
    const messages=item.messages.map(m=>{
      const found=m.kind==='feishu' && jobs.get(m.requestId);
      if (!found) return m;
      // A merged message names the request it joined.
      const run=found.mergedInto && titles.has(found.mergedInto.caseId) ? {...found,mergedTitle:titles.get(found.mergedInto.caseId)} : found;
      const status=['delivered','waiting-requester'].includes(run.status) && !run.receipt?.messageId ? 'uncertain' :
        run.outputKind==='question' && run.status==='awaiting-release' ? 'question-release' :
        run.outputKind==='question' && run.status==='approved' ? 'question-ready' : run.status;
      return {...m,status,run};
    });
    const latest=messages.at(-1);
    return {...item,messages,status:latest?.status || item.status,hasWork:messages.some(m=>m.run && !['ignored','merged'].includes(m.status)),
      workerRole:latest?.run?.role || item.workerRole};
  });
}
function spaceCaseStatus(item) {
  return item.messages.find(m=>m.status==='uncertain')?.status || item.messages.find(m=>['awaiting-release','question-release'].includes(m.status))?.status || item.messages.find(m=>m.status==='dispatching')?.status || item.status;
}
function spaceOrigin(item,tr) {
  return item.source.kind==='feishu' ? tr('飞书消息','Feishu message') : tr('本机委托','Local request');
}
function spaceCurrentCase(item,source) {
  const s=source?.settings,c=item.source;
  return !!(source?.scopeId && s?.tenantId && s.recipientId && c.kind==='feishu' &&
    c.tenantId===s.tenantId && c.recipientId===s.recipientId && (!item.feedScopeId || item.feedScopeId===source.scopeId));
}
function spaceActivity(cases,mentions=[],source) {
  if(!source?.scopeId || !source.settings?.tenantId || !source.settings.recipientId)return [];
  const rows=[], index=new Map(), names=new Map(), groupNames=new Map(source?.groups?.map(g=>[g.chatId,g.name]));
  for(const item of cases) {
    if(!spaceCurrentCase(item,source))continue;
    const {chatId}=item.source;
    for(const message of item.messages) {
      if(message.kind!=='feishu')continue;
      const key=JSON.stringify([item.id,message.requestId]),row={key,item,message,chatId,name:item.source.name || groupNames.get(chatId)};
      index.set(key,row);rows.push(row);
    }
  }
  for(const mention of mentions) {
    if(mention.scopeId!==source.scopeId)continue;
    const {scopeId,chatId,threadId,messageId,text,at,name,canApprove,caseId}=mention;
    const key=JSON.stringify([scopeId,chatId,threadId,messageId]),row=caseId && index.get(JSON.stringify([caseId,messageId]));
    if(row) {
      row.key=key;row.message={...row.message,at};
      if(name) names.set(caseId,name);
    } else rows.push({key,mention,chatId,name,message:{kind:'feishu',requestId:messageId,text,at,status:canApprove?'awaiting-access':'not-handled'}});
  }
  for(const row of rows) if(row.item) row.name=names.get(row.item.id) || row.name;
  return rows.sort((a,b)=>b.message.at-a.message.at);
}
function SpaceGroupLink({tr,chatId,name}) {
  const label=name && name!==chatId ? name : tr('飞书会话','Feishu conversation');
  return chatId ? h('a',{className:'sx-text-link',target:'_blank',rel:'noopener noreferrer',href:'https://applink.feishu.cn/client/chat/open?openChatId='+encodeURIComponent(chatId)},label) : label;
}
function spaceApprovalInput({scopeId,chatId,threadId,messageId},action) {
  // Ignoring permanently covers the whole conversation, so it names no topic or message.
  return action==='ignore' ? {scopeId,chatId,action} : {scopeId,chatId,threadId,messageId,action};
}
// The two dropdowns on a message awaiting approval. Allowing only its author needs the recorded sender.
function spaceApprovalActions(mention,menu,tr) {
  return menu==='allow' ? [{id:'once',label:tr('授权一次','Allow once')},{id:'permanent',label:tr('永久授权','Always allow')},
    ...mention.senderId ? [{id:'sender',label:tr('仅授权此用户','Allow this user only')}] : []] :
    [{id:'dismiss',label:tr('忽略一次','Ignore once')},{id:'ignore',label:tr('永久忽略','Always ignore')}];
}
function SpaceApproval({p,mention,returnFocus}) {
  if(!mention?.canApprove)return null;
  const choose=action=>{returnFocus.current?.focus();void p.groupAccess(spaceApprovalInput(mention,action))};
  const dropdown=(menu,zh,en)=>p.openMenu ? h('button',{className:'sx-quiet x2-dropdown',type:'button',disabled:p.busy,'aria-haspopup':'menu',
    onClick:e=>{const r=e.currentTarget.getBoundingClientRect();p.openMenu({kind:'superagent-approval',value:{key:spaceMentionKey(mention),menu}},{x:r.left,y:r.bottom})}},
    p.tr(zh,en),h(Mark,{name:'chevron',size:12})) :
    spaceApprovalActions(mention,menu,p.tr).map(a=>h('button',{key:a.id,className:'sx-quiet',type:'button',disabled:p.busy,onClick:()=>choose(a.id)},a.label));
  return h(React.Fragment,null,h('small',{className:'x2-approval-scope'},p.tr('授权一次仅限本话题；永久授权覆盖整个会话；仅授权此用户只办理这位成员在本会话的消息。忽略一次只略过这条，永久忽略后不再接收这个会话。','Allow once covers this topic; always allow covers the conversation; allow this user only covers that member in this conversation. Ignore once skips this message; always ignore stops receiving the conversation.')),
    h('div',{className:'sx-decision x2-approvals'},dropdown('allow','授权','Allow'),dropdown('ignore','忽略','Ignore')));
}
const spaceMentionKey=m=>JSON.stringify([m.scopeId,m.chatId,m.threadId,m.messageId]);
function SpaceTime({at,tr,day=false}) {
  const date=new Date(at);
  return h('time',{className:'x2-time',dateTime:date.toISOString()},
    day ? date.toLocaleDateString(tr('zh-CN','en-US'),{year:'numeric',month:'short',day:'numeric'}) :
      date.toLocaleTimeString(tr('zh-CN','en-US'),{hour:'2-digit',minute:'2-digit'}));
}

function SpaceActivityRow({p,row,open,restore}) {
  const {tr}=p,{message,mention}=row,trigger=React.useRef(null);
  React.useLayoutEffect(()=>{if(restore)trigger.current?.focus()},[restore]);
  return h('li',{className:'x2-activity-row'},
    h(SpaceTime,{at:message.at,tr}),spaceStatusDot(message.status),
    h('div',{className:'x2-activity-copy'},
      h('button',{type:'button',className:'x2-activity-open',ref:trigger,onClick:()=>open(row.key)},
        message.text.length>140 ? message.text.slice(0,140)+'…' : message.text),
      h('small',null,h(SpaceGroupLink,{tr,chatId:row.chatId,name:row.name}),' · ',spaceStatus(message.status,tr)),
      h(SpaceApproval,{p,mention,returnFocus:trigger})),
    h('span',{className:'x2-row-link','aria-hidden':true},h(Mark,{name:'chevron',size:13})));
}
function SpaceRefresh({p}) {
  return h('button',{type:'button',className:'x2-back',onClick:p.reload,disabled:p.busy || p.refreshing,'aria-busy':p.refreshing},
    p.refreshing ? p.tr('刷新中…','Refreshing…') : p.tr('刷新','Refresh'));
}
function SpaceActivity({p,entries,open,headingRef,backId,compact}) {
  const {tr}=p,days=new Map();
  for(const e of entries) {
    const day=new Date(e.message.at).toDateString();
    if (!days.has(day)) days.set(day,[]);
    days.get(day).push(e);
  }
  return h('section',{className:compact?'x2-feed-list':'x2-page x2-activity','aria-label':tr('动态','Activity')},
    !compact && h('header',{className:'x2-page-head'},h('h2',{tabIndex:-1,ref:headingRef},tr('动态','Activity')),h(SpaceRefresh,{p})),
    !entries.length && h('p',{className:compact?'x2-lead-info':'x2-empty'},tr('暂无动态','No activity yet')),
    [...days].map(([day,rows])=>h('section',{key:day,className:'x2-day'},
      h('h3',null,h(SpaceTime,{at:rows[0].message.at,tr,day:true})),
      h('ul',{className:'x2-history'},rows.map(row=>h(SpaceActivityRow,{key:row.key,p,row,open,restore:row.key===backId}))))));
}
function spaceGrantLabel({mode,approvedAt,ignoredAt,note},tr) {
  const at=mode==='ignored' ? ignoredAt : approvedAt;
  // A member grant names the approving message, since member names are not resolved.
  const who=mode==='sender' ? tr('仅允许一位成员','Only one member')+(note ? tr('（发送「'+note+'」的人）',' (sender of “'+note+'”)') : '') : '';
  if(!Number.isFinite(at))return mode==='ignored' ? tr('已忽略此会话','Ignored') : who || tr('已永久允许此会话','Always allowed');
  const time=new Date(at).toLocaleString(tr('zh-CN','en-US'),{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  return mode==='ignored' ? tr(time+' 起忽略','Ignored since '+time) : who ? who+' · '+tr(time+' 起',' since '+time) : tr(time+' 起永久允许','Always allowed since '+time);
}
function SpaceGroup({p,group,label}) {
  const {tr,source,busy}=p,{chatId,name,mode,senderId}=group;
  return h('div',{className:'x2-account-row x2-grant'},
    h('div',null,h(SpaceGroupLink,{tr,chatId,name}),h('p',null,label)),
    h('button',{className:'sx-quiet',type:'button',disabled:busy,onClick:()=>p.groupAccess({scopeId:source.scopeId,chatId,action:'revoke',...(mode==='sender' ? {senderId} : {})})},
      mode==='ignored' ? tr('取消忽略','Stop ignoring') : tr('撤销授权','Revoke access')));
}
// Only the initiating page holds the display link; reject external or malformed artwork.
function spaceFeishuFlow(kind,value,now) {
  const fail=code=>{throw Object.assign(new Error(code),{code})};
  const {url,qrDataUrl,flowId,expiresAt}=value || {};
  let target;
  try { target=new URL(url); } catch { fail('auth-unavailable'); }
  const page=kind==='setup' ? 'https://open.feishu.cn/page/cli' : 'https://accounts.feishu.cn/oauth/v1/device/verify';
  if (target.origin+target.pathname!==page || target.username || target.password || typeof flowId!=='string' || !flowId ||
      typeof qrDataUrl!=='string' || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(qrDataUrl) || !Number.isFinite(expiresAt))
    fail('auth-unavailable');
  if (expiresAt<=now) fail('auth-expired');
  return {kind,flowId,url,qrDataUrl,expiresAt};
}
// A lost confirmation or cancellation response does not invalidate the user's link.
const spaceFeishuEnded=code=>['auth-expired','auth-denied','scope-changed'].includes(code);
// The button prepares the plugin-owned profile; only Feishu can grant consent.
async function spaceConnectFeishu(settings,ask,active) {
  let s=settings;
  const bound=!!s.tenantId && !!s.recipientId;
  if (!bound && (!s.enabled || !s.profile)) s=await ask('saveFeishu',{version:s.version,enabled:true,
    profile:s.profile || 'superagent',managed:s.profile ? s.managed : true});
  if (!active()) return null;
  const start=async kind=>({kind,version:s.version,...await ask('startFeishuAuth',{version:s.version,kind,...(kind==='login'?{automation:true}:{})})});
  if(s.managed && !bound) {
    try{return await start('setup')}catch(e){if(e.code!=='auth-profile-exists') throw e}
  }
  return active() ? start('login') : null;
}
const spacePollStages={
  identity:['核对登录账号','Check account'],search:['搜索新消息','Search messages'],metadata:['核对消息信息','Check message metadata'],
  group:['核对会话','Check conversation'],message:['读取消息','Read message'],history:['读取消息前文','Read prior messages'],
  admission:['核对办理授权','Check handling access'],storage:['读写本机记录','Access local storage'],
  receive:['接收消息','Receive message'],poll:['检查新消息','Poll for messages']
};
const spacePollReasons={
  'cli-not-found':['找不到 lark-cli','lark-cli was not found'],'cli-not-executable':['无法执行 lark-cli','lark-cli is not executable'],
  'context-too-large':['线程内容过长，未交给助手','Thread too large; not sent to the assistant'],
  timeout:['请求超时','Request timed out'],'login-required':['需要登录飞书','Feishu login required'],
  'permission-denied':['飞书权限不足','Insufficient Feishu permissions'],'invalid-parameters':['请求参数无效','Invalid request parameters'],
  'rate-limited':['请求过于频繁','Rate limit exceeded'],network:['网络连接失败','Network connection failed'],
  'api-error':['飞书接口返回错误','Feishu API returned an error'],'identity-mismatch':['登录账号与绑定身份不符','Account does not match the binding'],
  'invalid-response':['返回数据无效','Invalid response'],'storage-unavailable':['本机记录不可用','Local storage unavailable'],
  'admission-denied':['会话或话题未获准办理','Conversation or topic not approved'],'cli-failed':['lark-cli 执行失败','lark-cli failed'],
  unknown:['原因未确定','Cause unknown']
};
function spacePollLogRows(records,tr) {
  if(!Array.isArray(records) || !records.length)return [];
  const format=new Intl.DateTimeFormat(tr('zh-CN','en-US'),{dateStyle:'medium',timeStyle:'medium'});
  return records.flatMap(row=>{
    if(!row || !Number.isSafeInteger(row.at) || row.at<=0 || row.at>8.64e15 ||
      typeof row.stage!=='string' || !Object.hasOwn(spacePollStages,row.stage) ||
      typeof row.reason!=='string' || !Object.hasOwn(spacePollReasons,row.reason))return [];
    const {at,stage,reason,larkCode}=row;
    return [{iso:new Date(at).toISOString(),time:format.format(at),stage:tr(...spacePollStages[stage]),reason:tr(...spacePollReasons[reason]),
      ...(Number.isInteger(larkCode) && larkCode>0 && larkCode<=2147483647 ? {code:tr('飞书错误码：','Feishu error code: ')+larkCode} : {})}];
  });
}
function spaceSourceStatus({state,detail},tr) {
  if(state==='unverified')return tr('尚未核验飞书账号。','The Feishu account has not yet been verified.');
  if(state==='ready')return detail==='已验证；本次仅处理一页，仍有未读取的匹配项。'
    ? tr('本次检查已完成，仍有匹配消息待同步。','This check completed. More matching messages remain.')
    : tr('最近一次飞书检查已完成。','The last Feishu check completed.');
  if(state==='error')return detail==='未能完成本次飞书轮询，将自动重试。'
    ? tr('未能完成本次飞书轮询，将自动重试。','The Feishu check failed and will retry automatically.')
    : tr('最近一次飞书操作未成功。','The last Feishu operation did not complete.');
  return null;
}
function SpacePollLog({records,tr}) {
  const rows=spacePollLogRows(records,tr);
  if(!rows.length)return null;
  return h('details',{className:'x2-poll-log'},h('summary',null,tr('错误日志','Error log')),
    h('ol',null,rows.map((r,i)=>h('li',{key:i},
      h('time',{dateTime:r.iso},r.time),h('span',null,r.stage,tr('：',': '),r.reason),r.code && h('small',null,r.code)))));
}
// Settings manage whole conversations only; per-topic "approve once" grants are not listed here.
function SpaceSourceGroups({p}) {
  const {tr,source}=p,groups=source.groups.filter(group=>['permanent','sender'].includes(group.mode)),ignored=source.groups.filter(group=>group.mode==='ignored');
  return h(React.Fragment,null,
    h('section',{className:'sx-fields x2-source-section'},
      h('h3',null,tr('永久允许的会话','Always-allowed conversations')),
      !groups.length && h('p',null,tr('暂无永久允许的会话。可在「动态」里对消息选择「授权 → 永久授权」。','No always-allowed conversations. In Activity, choose Allow → Always allow on a message.')),
      groups.map(group=>h(SpaceGroup,{p,key:group.chatId+(group.senderId || ''),group,label:spaceGrantLabel(group,tr)}))),
    ignored.length>0 && h('section',{className:'sx-fields x2-source-section'},
      h('h3',null,tr('已忽略的会话','Ignored conversations')),
      ignored.map(group=>h(SpaceGroup,{p,key:group.chatId,group,label:spaceGrantLabel(group,tr)}))));
}
async function spaceCommitPollInterval(draft,settings,save) {
  if(!draft)return null;
  const next=Number(draft.value);
  if(!Number.isInteger(next) || next<1 || next>1440)return draft;
  if(next===(settings.pollIntervalMinutes ?? 1))return null;
  const saved=await save({version:draft.version ?? settings.version,pollIntervalMinutes:next});
  return saved ? null : {value:draft.value};
}
function SpacePollInterval({settings,tr,save,disabled}) {
  const id=React.useId(),[draft,setDraft]=React.useState(null),stored=String(settings.pollIntervalMinutes ?? 1);
  async function commit(e) {
    e.preventDefault();
    if(disabled || !draft)return;
    const next=await spaceCommitPollInterval(draft,settings,save);
    setDraft(current=>current===draft ? next : current);
  }
  return h('form',{className:'x2-account-row x2-poll-interval',onSubmit:commit},
    h('label',{htmlFor:id},tr('检查新消息的间隔','Message check interval')),
    h('div',{className:'x2-poll-control'},h('input',{id,type:'number',min:1,max:1440,step:1,required:true,value:draft?.value ?? stored,disabled,
      onChange:e=>{const value=e.currentTarget.value;setDraft(value===stored ? null : {value,version:draft?.version ?? settings.version})},
      onKeyDown:e=>{if(e.key==='Escape' && !e.nativeEvent.isComposing)setDraft(null)}}),tr('分钟','min'),
      h('button',{type:'submit',className:'sx-quiet',disabled:disabled || !draft || draft.value===stored},tr('保存','Save'))));
}
function spaceHistoryValues(settings,draft) {
  return {historyCount:draft?.historyCount ?? String(settings.historyCount ?? 10),
    historyMinutes:draft?.historyMinutes ?? String(settings.historyMinutes ?? 5)};
}
function spaceHistoryPatch(draft,settings) {
  const values=spaceHistoryValues(settings,draft);
  if(!draft || values.historyCount==='' || values.historyMinutes==='')return null;
  const historyCount=Number(values.historyCount),historyMinutes=Number(values.historyMinutes);
  if(!Number.isInteger(historyCount) || historyCount<0 || historyCount>100 ||
     !Number.isInteger(historyMinutes) || historyMinutes<0 || historyMinutes>1440)return null;
  return {version:draft.version ?? settings.version,historyCount,historyMinutes};
}
function SpaceHistoryLimits({settings,tr,save,disabled}) {
  const [draft,setDraft]=React.useState(null),heading=React.useId();
  const stored=spaceHistoryValues(settings),values=spaceHistoryValues(settings,draft);
  const dirty=values.historyCount!==stored.historyCount || values.historyMinutes!==stored.historyMinutes;
  function edit(key,value) {
    const next={...draft,version:draft?.version ?? settings.version,[key]:value};
    if(value===stored[key])delete next[key];
    setDraft(next.historyCount===undefined && next.historyMinutes===undefined ? null : next);
  }
  async function commit(e) {
    e.preventDefault();
    const patch=spaceHistoryPatch(draft,settings);
    if(disabled || !dirty || !patch)return;
    const saved=await save(patch);
    setDraft(d=>d!==draft ? d : saved ? null : {...draft,version:undefined});
  }
  const field=(key,label,max)=>h('label',{className:'x2-poll-control'},label,h('input',{type:'number',min:0,max,step:1,required:true,
    value:values[key],disabled,onChange:e=>edit(key,e.currentTarget.value),onKeyDown:e=>{if(e.key==='Escape')setDraft(null)}}));
  return h('form',{className:'x2-account-row x2-history-limits','aria-labelledby':heading,onSubmit:commit},
    h('div',null,h('h3',{id:heading},tr('补读消息前文','Prior message context')),
      h('p',null,tr('有飞书话题时读取完整话题。仅无话题时按以下范围补读：默认最多 10 条、向前 5 分钟；任一项为 0 即不补读。','The full thread is read when available. Only unthreaded messages use these limits: by default, up to 10 messages from the preceding 5 minutes. Set either to 0 to skip that lookback.'))),
    h('div',{className:'x2-history-fields'},field('historyCount',tr('最多条数','Max messages'),100),
      field('historyMinutes',tr('向前分钟数','Minutes back'),1440),
      h('button',{type:'submit',className:'sx-quiet',disabled:disabled || !dirty},tr('保存','Save'))));
}
async function spaceCommitCliPath(draft,settings,save) {
  if(!draft || draft.value===(settings.cliPath ?? ''))return null;
  const saved=await save({version:draft.version ?? settings.version,cliPath:draft.value});
  // Keep a rejected path editable; the next explicit attempt uses the refreshed version.
  return saved ? null : {value:draft.value,unsaved:true};
}
function SpaceCliPath({settings,tr,save,disabled,draft,setDraft}) {
  const id=React.useId(),currentPath=settings.cliPath ?? '';
  async function commit() {
    if(!draft || disabled)return;
    const next=await spaceCommitCliPath(draft,settings,save);
    setDraft(current=>current===draft ? next : current);
  }
  return h('form',{className:'x2-account-row x2-cli-path',onSubmit:e=>{e.preventDefault();void commit()}},
    h('label',{htmlFor:id},tr('lark-cli 可执行文件路径','lark-cli executable path'),
      h('small',null,tr('留空使用系统 PATH。','Leave empty to use the system PATH.'),
        draft?.unsaved && tr(' 修改尚未保存。',' Changes not saved.'))),
    h('div',{className:'x2-cli-path-control'},h('input',{id,type:'text',value:draft?.value ?? currentPath,disabled,spellCheck:false,autoCapitalize:'none',autoComplete:'off',
      onChange:e=>{const value=e.currentTarget.value;setDraft(value===currentPath ? null : {version:draft?.version ?? settings.version,value})},
      onKeyDown:e=>{if(e.key==='Escape' && !e.nativeEvent.isComposing)setDraft(null)}}),
      h('button',{type:'submit',className:'sx-quiet',disabled:disabled || !draft || draft.value===currentPath},tr('保存','Save'))));
}
function SpaceSettingSwitch({label,description,checked,disabled,onChange}) {
  const id=React.useId();
  return h('label',{className:'x2-setting-switch',htmlFor:id},
    h('span',null,h('strong',{id:id+'-title'},label),h('small',{id:id+'-description'},description)),
    h('button',{id,type:'button',role:'switch','aria-checked':checked,'aria-labelledby':id+'-title','aria-describedby':id+'-description',
      className:'x2-switch',disabled,onClick:()=>onChange(!checked)},h('span',{'aria-hidden':true})));
}
function SpacePrivateChats({settings,canEnable,disabled,save,tr}) {
  const checked=settings.allowPrivateChats===true;
  return h(SpaceSettingSwitch,{label:tr('接收其他人的私聊','Receive direct messages from others'),
    description:!checked && !canEnable ? tr('先连接飞书并授权自动办理。','Connect Feishu and authorize automated handling first.') :
      tr('开启后，对方私聊你无需 @；和群里别人 @你一样，未获办理授权的消息在「动态」中待批。重新开启不会补收关闭期间的消息。','When this is on, SuperAgent receives direct messages from others even if they don’t mention you. As with group mentions, requests without existing access await approval in Activity. Messages sent while this was off are not backfilled.'),
    checked,disabled:disabled || (!checked && !canEnable),onChange:next=>void save({version:settings.version,allowPrivateChats:next})});
}
function SpaceSource({p}) {
  const {source,tr,feishuAction:ask,reloadFeishu:reload}=p, s=source.settings;
  const bound=!!s.tenantId && !!s.recipientId, connected=bound && s.enabled, status=connected && spaceSourceStatus(source,tr);
  const [cliDraft,setCliDraft]=React.useState(null),pathDirty=!!cliDraft && cliDraft.value!==(s.cliPath ?? '');
  const [flow,setFlow]=React.useState(null),[step,setStep]=React.useState(''),[error,setError]=React.useState('');
  const live=React.useRef(false),held=React.useRef(null),locked=React.useRef(false);
  const authLink=React.useRef(null),accountAction=React.useRef(null),lastFocusFlow=React.useRef(null);
  React.useLayoutEffect(()=>{
    const id=flow?.flowId ?? null;
    if(step || p.busy || id===lastFocusFlow.current)return;
    lastFocusFlow.current=id;
    // Only restore focus when the control that opened or closed the flow disappeared.
    if(document.activeElement===document.body)(id ? authLink : accountAction).current?.focus();
  },[flow,step,p.busy]);
  const cancel=React.useCallback(f=>ask('cancelFeishuAuth',{version:f.version,flowId:f.flowId}),[ask]);
  React.useEffect(()=>{live.current=true;return ()=>{
    live.current=false;if(held.current) void cancel(held.current).catch(()=>{});held.current=null;
  }},[cancel]);
  function clear(){held.current=null;setFlow(null)}
  React.useEffect(()=>{
    if(!flow)return;
    const timer=setTimeout(()=>{if(held.current===flow){clear();setError('auth-expired')}},Math.max(0,flow.expiresAt-Date.now()));
    return ()=>clearTimeout(timer);
  },[flow]);
  React.useEffect(()=>{
    const f=held.current;
    if(f && f.version!==s.version && f.initial!==s.version){clear();setError('scope-changed')}
  },[s.version]);
  async function show(raw,initial) {
    if(!raw)return;
    if(!live.current){await cancel(raw).catch(()=>{});return}
    let f;
    try { f={...spaceFeishuFlow(raw.kind,raw,Date.now()),version:raw.version,initial}; }
    catch(e){if(raw.flowId)await cancel(raw).catch(()=>{});throw e}
    held.current=f;setFlow(f);
  }
  async function act(action) {
    if(locked.current || p.busy)return;
    const f=held.current;
    locked.current=true;setStep(action);setError('');
    try {
      if(action==='connect' || action==='separate') {
        const base=action==='separate' && !bound && ['auth-profile-missing','auth-setup-locked'].includes(error)
          ? await ask('saveFeishu',{version:s.version,enabled:true,managed:true,profile:'superagent-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')}) : s;
        if(live.current)await show(await spaceConnectFeishu(base,ask,()=>live.current),s.version);
        if(live.current)await reload();
      } else if(action==='pause') {
        await ask('saveFeishu',{version:s.version,profile:s.profile,managed:s.managed,enabled:false});
        if(live.current)await reload();
      } else if(f) {
        if(action==='cancel'){await cancel(f);if(live.current)clear();return}
        const result=await ask('finishFeishuAuth',{version:f.version,flowId:f.flowId});
        if(!live.current)return;
        if(result?.kind!==f.kind)throw Object.assign(new Error(),{code:'auth-unavailable'});
        clear();
        if(result.kind==='setup') {
          const next=await ask('startFeishuAuth',{version:f.version,kind:'login',automation:true});
          await show({...next,kind:'login',version:f.version},f.version);
        } else await reload();
      }
    } catch(e) {
      if(live.current){
        if(f && spaceFeishuEnded(e.code))clear();
        setError(e.code || (f?'auth-unconfirmed':'auth-unavailable'));await reload();
      }
    } finally {locked.current=false;if(live.current)setStep('')}
  }
  const busy=p.busy || !!step, button=(label,action,primary=false)=>h('button',{className:primary?'sx-solid':'sx-quiet',type:'button',
    ref:action==='connect' ? accountAction : undefined,disabled:busy || (pathDirty && ['connect','separate'].includes(action)),onClick:()=>void act(action)},label);
  return h('div',{className:'sx-fields x2-source'},
    h('section',{className:'sx-fields x2-source-section'},
      h('div',{className:'x2-account-row'},h('div',null,h('h3',null,tr('飞书账号','Feishu account')),
        h('p',null,connected?(source.automationEnabled?tr('已绑定 · 已授权自动办理','Bound · automatic processing authorized'):tr('已绑定 · 尚未授权自动办理','Connected · automation not authorized')):bound?tr('已暂停接收','Paused'):tr('未连接','Not connected'))),
        !flow && (connected?h('div',{className:'sx-decision'},button(source.automationEnabled?tr('重新授权','Reauthorize'):tr('授权自动办理','Authorize automated handling'),'connect',!source.automationEnabled),button(tr('暂停接收','Pause'),'pause')):bound?button(tr('重新连接飞书','Reconnect Feishu'),'connect',true):
          button(step==='connect'?tr('正在连接…','Connecting…'):tr('连接飞书','Connect Feishu'),'connect',true))),
      status && h('p',{role:'status'},status),
      h(SpacePollLog,{records:source.pollErrors,tr}),
      !flow && h('p',null,tr('你在内部群、「与自己的聊天」或已开启接收的私聊中明确 @自己，等同于为该话题选「授权一次」，不必再点。对外发送仍遵守你的确认设置。','When you explicitly mention yourself in an internal group, your self-chat, or an enabled direct chat, it counts as Allow once for that topic. Your outbound confirmation setting still applies.'),
        !source.automationEnabled && tr('连接并授权后开始接收。消息获准办理前只供查看；对外发送时，会以你的身份回复原消息。',' Connect and authorize Feishu to receive messages. Until approved they are read-only. Outgoing replies are posted to the original message as you.')),
      flow && h('div',{className:'sx-fields x2-auth-flow'},
        h('p',null,flow.kind==='setup'?tr('先在飞书确认创建应用，再连接账号。','Confirm app creation in Feishu before connecting your account.'):
          tr('在飞书授权读取身份和会话消息、搜索直接 @你的消息，并以你的身份回复。仅同一飞书账号已有的会话和话题授权继续适用。','Authorize identity and message reads, direct mention searches, and replies as you. Only conversation and topic approvals for the same Feishu account carry over.')),
        h('a',{ref:authLink,className:'sx-text-link',target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer',href:flow.url},tr('打开飞书','Open Feishu')),
        h('img',{src:flow.qrDataUrl,alt:tr('也可用飞书扫码确认','Or scan with Feishu to confirm')}),
        h('div',{className:'sx-decision'},button(tr('我已确认','I have confirmed'),'finish',true),button(tr('取消','Cancel'),'cancel'))),
      h(SpaceCliPath,{settings:s,tr,save:p.setCliPath,draft:cliDraft,setDraft:setCliDraft,disabled:busy || !!flow}),
      h(SpacePrivateChats,{settings:s,canEnable:connected && source.automationEnabled,disabled:busy || !!flow,save:p.setPrivateChats,tr}),
      h(SpacePollInterval,{key:source.scopeId,settings:s,tr,save:p.setPollInterval,disabled:busy || !!flow}),
      h(SpaceHistoryLimits,{settings:s,tr,save:p.setHistoryLimits,disabled:busy || !!flow}),
      error && h('p',{role:'alert'},spaceErrorText(error,tr)),
      !flow && !bound && ['auth-profile-missing','auth-setup-locked'].includes(error) &&
        button(tr('另建专用连接','Start a separate connection'),'separate')),
    connected && h(SpaceSourceGroups,{p:{...p,busy},key:source.scopeId}));
}
function SpaceReleasePolicy({p}) {
  const {tr}=p;
  return h(SpaceSettingSwitch,{label:tr('对外发送前需我确认','Ask me before sending replies'),
    description:tr('开启时，每条追问和最终答复都需单独确认。关闭后新产生的追问和答复会自动发送，已在等待确认的不会自动发送。','When on, each question and final reply needs separate confirmation. When off, new questions and replies are sent automatically; those already awaiting confirmation stay on hold.'),
    checked:p.releaseRequired!==false,disabled:p.busy,onChange:next=>void p.setReleasePolicy({required:next})});
}
function SpaceSettings({p,source,show}) {
  const {tr}=p;
  return h('section',{className:'x2-page'},
    h('header',{className:'x2-page-head'},h('h2',null,'SuperAgent')),
    h('nav',{className:'x2-config-nav','aria-label':tr('设置类别','Settings categories')},
      [['team',tr('团队分工','Team roles')],['source',tr('飞书','Feishu')]].map(([id,label])=>
        h('button',{type:'button',key:id,'aria-current':(source?'source':'team')===id ? 'page' : undefined,onClick:()=>show(id)},label))),
    h('div',{className:source?'x2-fields':'x2-team-fields'},source ? h(SpaceSource,{p}) : h(React.Fragment,null,h(SpaceTeamRoles,p),h(SpaceReleasePolicy,{p}))));
}

function spaceRecordedPreset(item,role,tr) {
  if (item.team[role]) return item.teamNames?.[role] || item.team[role];
  if (role!==item.workerRole) return null;
  return item.resolvedPresetId ? tr('会话默认预设','Session default preset')+' · '+item.resolvedPresetId :
    tr('会话默认预设（未记录实际预设）','Session default preset (actual preset not recorded)');
}
function spaceSpeaker(speaker,tr) {
  if(speaker==='requester') return tr('提需人','Requester');
  if(speaker==='owner') return tr('你','You');
  const n=/^participant-(\d+)$/.exec(speaker)?.[1];
  return n ? tr('参与者 '+n,'Participant '+n) : speaker;
}
// The thread lines brought in with each message, exactly as the assistants received them.
function SpaceIntakeContext({tr,item}) {
  const rows=item.messages.filter(m=>m.kind==='feishu' && m.context?.length);
  if(!rows.length) return null;
  return h('section',null,h('h4',null,tr('带入的上下文','Context brought in')),
    rows.map(m=>h('ol',{key:m.requestId,className:'x2-intake-context'},m.context.map((line,i)=>h('li',{key:i},
      h('cite',null,new Date(line.at).toLocaleString(tr('zh-CN','en-US'),{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),
        ' · ',spaceSpeaker(line.speaker,tr),line.request && tr('（本条请求）',' (this request)')),
      h('p',null,line.text))))));
}
function SpaceMaterials({p,item,id}) {
  const {tr}=p, {source}=item;
  return h('aside',{id,className:'x2-materials','aria-label':tr('事项材料','Case materials')},
    h('h3',{className:'x2-rail-title'},tr('事项材料','Case materials')),
    h('section',null,h('h4',null,tr('来源','Source')),h('p',null,spaceOrigin(item,tr)),
      source.kind==='feishu' && h('p',null,h(SpaceGroupLink,{tr,chatId:source.chatId,name:source.name}))),
    h(SpaceIntakeContext,{tr,item}),
    item.team && h('section',null,h('h4',null,tr('受理时的分工','Assignment at intake')),
      spaceRoles.map(([id,zh,en])=>{
        const preset=spaceRecordedPreset(item,id,tr),m=item.roleModels[id];
        return preset && h('p',{key:id},tr(zh,en),' · ',preset,
          m && ' · '+(m.inherit ? tr('DSH 默认','DSH default') : m.name || m.model)+(m.effort ? ' · '+spaceEffortName(m.effort,null,tr) : ''));
      })),
    item.resolvedModel && h('section',null,h('h4',null,tr('承办会话实际使用的模型','Model used by the case session')),
      h('p',null,item.resolvedModel.provider,' · ',item.resolvedModel.model,item.resolvedModel.effort && ' · '+spaceEffortName(item.resolvedModel.effort,null,tr))),
    item.sessionId && h('section',null,h('h4',null,tr('DSH 会话','DSH session')),h('code',null,item.sessionId)));
}
function spaceReleaseSelection({source,mentions},item,message) {
  const r=message.run,c=item.source;
  if(!r || r.caseId!==item.id || r.messageId!==message.requestId || message.kind!=='feishu' || c.kind!=='feishu')return null;
  const current=spaceCurrentCase(item,source);
  const mention=current && mentions?.find(m=>m.scopeId===source.scopeId && m.caseId===item.id && m.messageId===r.messageId &&
    m.chatId===c.chatId && m.threadId===c.threadId);
  return {chatId:c.chatId,name:mention?.name || c.name || (current && source.groups?.find(g=>g.chatId===c.chatId)?.name),
    at:mention?.at,input:current && c.chatId && c.threadId && r.status==='awaiting-release' && r.answer?.trim() && r.releaseToken
      ? {caseId:item.id,messageId:r.messageId,token:r.releaseToken} : null};
}
function spaceReleaseTopic(mentionAt,receivedAt,tr) {
  const label=tr('原消息','Original message'),at=mentionAt ?? receivedAt;
  if(!Number.isFinite(at))return label;
  const time=new Date(at).toLocaleString(tr('zh-CN','en-US'));
  return label+' · '+(mentionAt==null?tr('本机收件时间：','Received locally: '):tr('消息时间：','Message time: '))+time;
}
function SpaceRunOutput({p,item,message}) {
  const {tr}=p,r=message.run,heading=React.useRef(null);
  const pending=r.status==='awaiting-release',target=pending && spaceReleaseSelection(p,item,message);
  function choose(action) {heading.current?.focus();void p.releaseOutput({...target.input,action})}
  return h('div',{className:'x2-run-result','data-pending':pending},
    h('strong',{tabIndex:-1,ref:heading},r.outputKind==='question' ?
      (pending ? tr('待确认发送的追问','Question awaiting your confirmation') : tr('助手的追问','Question from the assistant')) :
      (pending ? tr('待确认发送的最终答复','Final reply awaiting your confirmation') : tr('最终答复','Final reply'))),
    h('p',null,r.answer),
    pending && target && h('p',{className:'x2-step-detail'},tr('回复至：','Reply to: '),h(SpaceGroupLink,{tr,chatId:target.chatId,name:target.name}),
      ' · ',spaceReleaseTopic(target.at,message.at,tr)),
    pending && (target?.input ? h('div',{className:'sx-decision x2-approvals'},
      // After access was revoked the reply can no longer be sent, only declined.
      r.releaseBlocked ? h('small',{className:'x2-approval-scope'},tr('授权已撤销，只能选择不发送。','Access was revoked; this can only be declined.')) :
        h('button',{type:'button',className:'sx-solid',disabled:p.busy,onClick:()=>choose('send')},tr('确认发送','Confirm send')),
      h('button',{type:'button',className:'sx-quiet',disabled:p.busy,onClick:()=>choose('decline')},tr('不发送','Do not send')))
      : h('p',{className:'x2-step-detail'},tr('当前无法放行，请核对飞书身份与话题授权。','Cannot release this reply. Check the Feishu identity and topic access.'))));
}
// Matches the Host: failed work can be retried; a reply that may already be posted cannot.
const spaceRetryable=run=>run.status==='stopped' || run.status==='uncertain' && run.reason==='work-uncertain';
// Matches the Host: a worker session can be taken over except while its reply is being posted.
const spaceTakeable=run=>!!run.workerSessionId && ['develop','answer'].includes(run.role) &&
  (['assigned','working','approved','awaiting-release','waiting-requester'].includes(run.status) || spaceRetryable(run));
// Actions in the shared row menu, on the case's latest eligible message. Only cases still
// listed in Activity can be archived, so an archived case stays reachable there.
function spaceCaseMenu({records,archive,retry,takeOver,tr,source},caseId) {
  const item=records.find(r=>r.id===caseId);
  if(!item) return [];
  const latest=test=>[...item.messages].reverse().find(m=>m.run && test(m.run));
  const failed=latest(spaceRetryable),takeable=latest(spaceTakeable);
  return [
    ...takeable ? [{id:'takeover',label:tr('接手','Take over'),run:()=>takeOver(item,takeable)}] : [],
    ...failed ? [{id:'retry',label:tr('重试','Retry'),run:()=>retry(item,failed)}] : [],
    ...spaceCurrentCase(item,source) ? [{id:'archive',label:tr('归档','Archive'),run:()=>archive(item)}] : [],
  ];
}
// Messages of one seat from its native event stream: human input (the requester's reply, or
// your own messages after takeover), model text, and what the model sent through a reply tool,
// including the streaming attempt. Reasoning, other tool calls, tool results, SuperAgent's own
// instructions and child sessions are not shown.
const spaceReplyTools={superagent_answer:['answer','reply'],superagent_ask_requester:['question','question']};
function spaceSeatOutput(entries) {
  const items=[],live=new Map();
  const push=b=>{
    if(b?.type==='text' && b.text?.trim()) items.push({kind:'text',text:b.text});
    else if(b?.type==='tool-call' && spaceReplyTools[b.name]) {
      const [field,kind]=spaceReplyTools[b.name];
      try {const text=JSON.parse(b.arguments)?.[field];if(typeof text==='string' && text.trim()) items.push({kind,text})} catch { /* Still streaming or malformed. */ }
    }
  };
  const human=data=>{
    const text=(data?.content || []).filter(b=>b.type==='text').map(b=>b.text).join('');
    if(!text.trim() || data?.source?.kind!=='user') return;
    if(text.startsWith('SUPERAGENT_')) {
      // SuperAgent's own instruction; only the requester's reply inside it is human input.
      try {const reply=JSON.parse(text.slice(text.lastIndexOf('\n')+1))?.requesterReply;if(typeof reply==='string' && reply.trim()) items.push({kind:'requester',text:reply})} catch { /* Not a reply round. */ }
    } else items.push({kind:'owner',text});
  };
  for(const entry of entries) {
    const e=entry?.event;
    if(entry?.type==='event' && e?.type==='user/message') human(e.data);
    else if(entry?.type==='event' && e?.type==='assistant/message') for(const b of e.data?.message?.content || []) push(b);
    else if(entry?.type==='transient' && e?.type==='assistant/live-chunk') {
      const c=e.data?.chunk,id=e.data?.attemptId;
      if(!c || c.index===undefined) continue;
      if(!live.has(id)) live.set(id,new Map());
      const blocks=live.get(id),b=blocks.get(c.index) || {type:c.blockType,text:'',arguments:''};
      if(c.type==='block-start') b.type=c.blockType;
      else if(c.type==='text-delta') {b.type='text';b.text+=c.text}
      else if(c.type==='tool-call-delta') {b.type='tool-call';b.name=c.name ?? b.name;b.arguments+=c.argumentsDelta}
      else if(c.type==='reasoning-delta') b.type='reasoning';
      else if(c.type==='block-end') Object.assign(b,c.block);
      blocks.set(c.index,b);
    }
  }
  for(const blocks of live.values()) for(const b of [...blocks.entries()].sort((x,y)=>x[0]-y[0]).map(([,b])=>b)) push(b);
  return items;
}
function SpaceSeatOutput({p,sessionId,who}) {
  const {tr}=p,[binding,setBinding]=React.useState(null);
  React.useEffect(()=>{
    let reference;
    try {reference=p.retainSession?.(sessionId)} catch {return}
    if(!reference) return;
    setBinding(reference.binding);
    return ()=>{setBinding(null);reference.release()};
  },[sessionId,p.retainSession]);
  const source=binding?.eventSource;
  const subscribe=React.useCallback(fn=>source ? source.subscribe(fn) : ()=>{},[source]);
  const view=React.useSyncExternalStore(subscribe,()=>source?.getSnapshot());
  const items=React.useMemo(()=>spaceSeatOutput(view?.entries || []),[view]);
  if(!items.length) return null;
  const labels={requester:tr('提需人回复','Requester replied'),owner:tr('你','You'),reply:tr('答复','Reply'),question:tr('追问','Question')};
  return h('section',{className:'x2-seat-output'},h('div',{className:'x2-byline'},h('strong',null,who)),
    items.map((item,i)=>h('div',{key:i,className:'x2-seat-message','data-kind':item.kind},
      labels[item.kind] && h('span',{className:'x2-seat-label'},labels[item.kind]),h('pre',null,item.text))));
}
function SpaceMessageWork({p,item,message}) {
  const {tr}=p,run=message.run,steps=spaceWorkSteps(message,tr);
  if(!run) return h('p',{className:'x2-step-detail'},steps[0].stage);
  const preset=run.resolvedPresetId,worker=preset && (p.roster.find(row=>row.id===preset)?.name || preset);
  return h(React.Fragment,null,
    steps.length>0 && h('details',{className:'x2-process',open:true},
      h('summary',null,tr('办理过程','Work process'),' · ',spaceStatus(message.status,tr)),
      h('ol',{className:'x2-events'},steps.map((step,i)=>h('li',{key:i,className:'x2-process-step'},
        h('div',{className:'x2-byline'},h('strong',null,step.who),
          step.kind==='worker' && h('span',null,worker || spaceRoleLabel(run.role,tr))),
        h('p',null,step.stage),step.detail && h('p',{className:'x2-step-detail'},step.detail)))),
      (run.routerSessionId || run.workerSessionId) && h('div',{className:'x2-model-output'},
        h('h4',null,tr('会话记录','Conversation record')),
        run.routerSessionId && h(SpaceSeatOutput,{p,sessionId:run.routerSessionId,who:spaceRoleLabel('lead',tr)}),
        run.workerSessionId && h(SpaceSeatOutput,{p,sessionId:run.workerSessionId,who:worker || spaceRoleLabel(run.role,tr)})),
      (run.sessionId || run.workerSessionId) && h('button',{type:'button',className:'x2-back',onClick:()=>p.openSession(run.sessionId || run.workerSessionId)},
        h(Mark,{name:'link',size:13}),tr('查看本次承办会话','Open this work session'))),
    run.answer && h(SpaceRunOutput,{p,item,message}),
    ['delivered','waiting-requester'].includes(run.status) && run.receipt?.messageId && h('p',{className:'x2-receipt'},
      h(Mark,{name:'check',size:14}),tr('飞书已确认回帖','Reply confirmed by Feishu')));
}

function SpaceRecord({p,item,headingRef}) {
  const {tr}=p, [material,setMaterial]=React.useState(false), panelId=React.useId();
  const status=spaceCaseStatus(item);
  return h('article',{className:'x2-reader'},
    h('header',{className:'x2-subject'},
      h('div',{className:'x2-record-title'},h('h2',{ref:headingRef,tabIndex:-1},item.title),
        h('button',{type:'button',className:'x2-material-toggle','aria-expanded':material,'aria-controls':material ? panelId : undefined,onClick:()=>setMaterial(!material)},
          tr('事项材料','Case materials'),h(Mark,{name:'chevron',size:13}))),
      h('div',{className:'x2-owners'},h('span',null,spaceOrigin(item,tr)),item.workerRole && ' · '+spaceRoleLabel(item.workerRole,tr),
        h('span',{className:'x2-state'},spaceStatusDot(status),spaceStatus(status,tr)),
        item.sessionId && h('button',{type:'button',className:'x2-back',onClick:()=>p.openSession(item.sessionId)},
          h(Mark,{name:'link',size:13}),tr('打开 DSH 会话','Open DSH conversation')))),
    h('div',{className:'x2-read-scroll',tabIndex:0,role:'region','aria-label':tr('事项内容','Case contents')},
      h('div',{className:'x2-read-layout','data-material':material},material && h(SpaceMaterials,{p,item,id:panelId}),
        h('div',{className:'x2-transcript'},h('ol',{className:'x2-events'},item.messages.map(message=>{
          const key=JSON.stringify([item.id,message.kind,message.requestId]);
          return h('li',{key,className:'x2-event'},
            h('div',{className:'x2-event-body'},h('div',{className:'x2-byline'},h('strong',null,message.kind==='feishu' ? tr('飞书原消息','Original Feishu message') : tr('你','You')),
              h(SpaceTime,{at:message.at,tr})),
              h('p',null,message.text),h(SpaceMessageWork,{p,item,message}),
              message.error && h('p',null,spaceErrorText(message.error,tr))));
        }))))));
}

function SpaceActivityDetail({p,row,back}) {
  const {tr}=p,{message,item,mention}=row,heading=React.useRef(null);
  React.useLayoutEffect(()=>{heading.current?.focus()},[row.key]);
  return h('article',{className:'x2-reader'},
    h('header',{className:'x2-subject'},
      h('button',{type:'button',className:'x2-back',onClick:back},h(Mark,{name:'back'}),tr('返回动态','Back to activity')),
      h('h2',{tabIndex:-1,ref:heading},tr('飞书消息','Feishu message')),
      h('div',{className:'x2-owners'},h(SpaceGroupLink,{tr,chatId:row.chatId,name:row.name}),
        h(SpaceTime,{at:message.at,tr}),h('span',{className:'x2-state'},spaceStatusDot(message.status),spaceStatus(message.status,tr)))),
    h('div',{className:'x2-read-scroll x2-transcript',tabIndex:0,role:'region','aria-label':tr('消息内容','Message contents')},
      h('div',{className:'x2-event-body'},h('p',null,message.text),
        h(SpaceApproval,{p,mention,returnFocus:heading}),
        item && h(SpaceMessageWork,{p,item,message}),message.error && h('p',null,spaceErrorText(message.error,tr)))));
}

function spaceWorkspaceView(cases,view,compact,entries=[]) {
  const records=cases.filter(item=>!item.archivedAt && (item.hasWork || item.team || item.sessionId));
  const activity=view.section==='activity';
  const entry=activity && entries.find(row=>row.key===view.anchor);
  const selected=activity ? entry?.item : records.find(item=>item.id===view.caseId) || records[0];
  const reading=activity ? !!entry : selected && (!compact || selected.id===view.detailId);
  return {records,selected,entry,page:reading ? 'record' : view.section};
}

function EditionWorkspace(p) {
  const {tr}=p, desk=React.useRef(null), heading=React.useRef(null), currentRow=React.useRef(null), focus=React.useRef(false);
  const {cases}=p;
  const [compact,setCompact]=React.useState(true),[view,setView]=React.useState({section:'cases'});
  React.useLayoutEffect(()=>{
    const el=desk.current,measure=()=>setCompact(getComputedStyle(el).display!=='grid');
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return ()=>observer.disconnect();
  },[]);
  const entries=React.useMemo(()=>spaceActivity(cases,p.mentions,p.source),[cases,p.mentions,p.source]);
  const {records,selected,entry,page}=spaceWorkspaceView(cases,view,compact,entries);
  function showSection(section){setView({section,caseId:view.caseId})}
  function openRecord(item) {
    focus.current=true;
    setView({section:'cases',caseId:item.id,detailId:item.id});
  }
  function back() {
    focus.current=true;
    setView({section:view.section,caseId:view.caseId,backId:view.anchor});
  }
  async function archive(item) {
    const i=records.findIndex(r=>r.id===item.id),next=records[i+1] || records[i-1];
    if(!await p.archiveCase({caseId:item.id})) return;
    focus.current=true;
    setView({section:'cases',caseId:next?.id});
  }
  async function retry(item,message) {
    if(!await p.retryWork({caseId:item.id,messageId:message.requestId})) return;
    p.notify?.(tr('已重新开始办理','Work restarted'));
    focus.current=true;
    setView({section:'cases',caseId:item.id,detailId:item.id});
  }
  async function takeOver(item,message) {
    const value=await p.takeOver({caseId:item.id,messageId:message.requestId});
    if(value?.sessionId) p.openSession(value.sessionId);
  }
  const menuState=React.useRef(null);
  menuState.current={records,archive,retry,takeOver,tr,source:p.source};
  // One registration for the shared DSH row menu; its actions read the latest records on each opening.
  React.useEffect(()=>p.registerCaseMenu?.(({caseId})=>spaceCaseMenu(menuState.current,caseId)),[p.registerCaseMenu]);
  // The approval dropdowns read the latest pending mentions on each opening.
  const approvals=React.useRef(null);
  approvals.current={mentions:p.mentions || [],tr,groupAccess:p.groupAccess};
  React.useEffect(()=>p.registerMenu?.('pcmid-superagent.approval','superagent-approval',({key,menu})=>{
    const {mentions,tr,groupAccess}=approvals.current,mention=mentions.find(m=>m.canApprove && spaceMentionKey(m)===key);
    return mention ? spaceApprovalActions(mention,menu,tr).map(a=>({...a,run:()=>groupAccess(spaceApprovalInput(mention,a.id))})) : [];
  }),[p.registerMenu]);
  React.useLayoutEffect(()=>{
    if(!focus.current) return;
    focus.current=false;
    if(page==='cases') currentRow.current?.focus();
    if(page==='record' && !view.anchor) heading.current?.focus();
  },[view,page]);
  const casesLabel=tr('事项','Cases'),activityLabel=tr('动态','Activity');
  const feed=page==='activity' && h(SpaceActivity,{p,entries,compact,headingRef:heading,backId:view.backId,
    open:anchor=>setView({section:'activity',caseId:view.caseId,anchor})});
  return h('section',{className:'sx2','aria-label':tr('SuperAgent 工作区','SuperAgent workspace')},
    p.error && h('p',{className:'x2-lead-info',role:'alert'},p.error),
    compact && page==='record' && h('header',{className:'x2-mast'},h('button',{type:'button',className:'x2-nav-toggle',onClick:back},
      h(Mark,{name:'back',size:17}),view.section==='activity' ? tr('返回动态','Back to activity') : tr('返回事项','Back to cases'))),
    h('div',{className:'x2-desk',ref:desk,'data-page':page},
      h('div',{className:'x2-directory'},
        h('nav',{className:'x2-nav','aria-label':tr('工作区导航','Workspace navigation')},
          h('div',{className:'x2-brand'},h('h1',null,'SuperAgent'),compact && feed && h(SpaceRefresh,{p})),
          h('div',{className:'x2-sections'},[['cases',casesLabel],['activity',activityLabel]].map(([id,label])=>h('button',{
            key:id,type:'button','aria-current':view.section===id ? 'page' : undefined,onClick:()=>showSection(id)},label))),
          view.section==='cases' && (records.length ? h('ul',{className:'x2-tree','aria-label':casesLabel},records.map(item=>{
            const target={kind:'superagent-case',value:{caseId:item.id}};
            return h('li',{key:item.id,className:'x2-case-row'},h('button',{type:'button',
              ref:item.id===selected?.id ? currentRow : undefined,title:compact ? undefined : item.title,
              'aria-current':page==='record' && item.id===selected?.id ? 'true' : undefined,onClick:()=>openRecord(item),...p.menu?.trigger?.(target)},
              h('span',null,item.title)),
              p.menu?.button({target,label:tr('“'+item.title+'”的更多操作','More actions for '+item.title),className:'x2-row-menu'}));
          })) :
            compact && h('p',{className:'x2-lead-info'},tr('暂无事项','No cases yet')))),
        compact && feed),
      h('div',{className:'x2-panel'},entry ? h(SpaceActivityDetail,{key:entry.key,p,row:entry,back}) :
        page==='record' ? h(SpaceRecord,{key:selected.id,p,item:selected,headingRef:heading}) :
        page==='activity' ? !compact && feed :
        !compact && h('section',{className:'x2-page'},h('h2',null,casesLabel),h('p',{className:'x2-empty'},tr('暂无事项','No cases yet'))))));
}

// DSH does not expose a session-independent public snapshot. Read the shared model cache only on releases
// whose cache shape was checked. Never load a catalog, call a provider, read account settings, or open an
// arbitrary session to populate a menu.
const spaceCatalogReleases=['0.2.2-rc.3','0.2.2-rc.5'];
function spaceCatalogStore(ctx) {
  if (!spaceCatalogReleases.includes(ctx.get('modules')?.manifest?.release?.version)) return null;
  const own=(obj,key)=>obj && Object.getOwnPropertyDescriptor(obj,key)?.value;
  const store=own(own(ctx.get('modelDirectories'),'catalog'),'store');
  return typeof store?.getSnapshot==='function' && typeof store?.subscribe==='function' ? store : null;
}
function spaceCatalogRows(state) {
  const rows=[], value=state?.value;
  if (state?.status!=='ready' || !Array.isArray(value?.groups)) return rows;
  const named=v=>typeof v==='string' && !!v.trim();
  for (const group of value.groups) {
    if (!named(group?.id) || !named(group.name) || !Array.isArray(group.models)) continue;
    for (const model of group.models) {
      const levels=model?.reasoning?.efforts ?? [];
      if (!named(model?.id) || !named(model.name) || !Array.isArray(levels) || !levels.every(e=>named(e?.id) && named(e.name))) continue;
      const efforts=levels.map(e=>e.id),isDshDefault=group.id===value.default?.provider && model.id===value.default.model;
      rows.push({providerId:group.id,providerName:group.name,modelId:model.id,modelName:model.name,isDshDefault,efforts,
        defaultEffort:model.reasoning?.defaultEffort,configuredEffort:isDshDefault ? value.default.reasoningEffort : undefined,
        effortNames:Object.fromEntries(levels.map(e=>[e.id,e.name])),capabilitiesKnown:true});
    }
  }
  return rows;
}
async function spaceCall(ctx,endpoint,payload) {
  const reply=await ctx.connection.rpc.call('/api','pcmid/superagent/'+endpoint,payload);
  if (!reply?.ok) throw Object.assign(new Error(reply?.error?.message),{code:reply?.error?.code});
  return reply.value;
}
function spaceErrorText(code,tr) {
  const labels={
    SOURCE_NOT_ALLOWED:['消息来源不允许执行。','This source cannot run instructions.'],INVALID_REQUEST:['委托格式不正确。','Invalid request.'],
    EXECUTOR_UNAVAILABLE:['DSH 执行服务不可用。','The DSH execution service is unavailable.'],
    PRESET_UNAVAILABLE:['已绑定的预设不可用。','The bound preset is unavailable.'],
    MODEL_UNAVAILABLE:['所选模型或思考强度不可用。','The selected model or reasoning effort is unavailable.'],
    SESSION_MISMATCH:['会话身份或预设不匹配。','The session identity or preset does not match.'],
    SESSION_UNAVAILABLE:['无法使用原会话。','The original session is unavailable.'],
    WORKSPACE_UNAVAILABLE:['无法使用 SuperAgent 工作区。','The SuperAgent workspace is unavailable.'],
    PROMPT_UNCERTAIN:['未确认 DSH 是否接单，请核对原会话。','Submission is unconfirmed. Check the original conversation.'],
    'scope-changed':['飞书身份已变更，请重新确认会话授权。','The Feishu identity changed. Review conversation access again.'],
    'source-unconfigured':['请在「飞书」中连接账号。','Connect your account under Feishu.'],
    'settings-unavailable':['配置未能保存，请刷新设置后重试。','Could not save the configuration. Refresh the settings and try again.'],
    'auth-unavailable':['飞书授权未完成，请检查本机 lark-cli 和网络后重试。','Authorization did not complete. Check lark-cli and your connection, then try again.'],
    'auth-unconfirmed':['尚未收到操作结果，可以再次确认或取消。','No result was received. You can check again or cancel.'],
    'auth-pending':['飞书尚未确认。请先在官方页面完成操作，再回来确认。','Feishu has not confirmed yet. Complete the step on its official page, then check again.'],
    'auth-expired':['链接已过期，请重新发起。','The link expired. Start again for a new link.'],
    'auth-denied':['飞书未批准此次请求。若要重试，请重新发起。','Feishu declined this request. Start again if you wish to retry.'],
    'auth-busy':['已有飞书操作在进行。请在发起页面继续，或待链接过期后重试。','Another Feishu operation is in progress. Continue on the page where it started or retry after expiry.'],
    'auth-setup-locked':['上一次连接可能仍在创建应用。可稍后重试，或另建专用连接。','App setup may still be running. Try again later or start a separate connection.'],
    'auth-profile-exists':['该飞书应用配置已存在，可以直接授权本人账号。','This app configuration already exists. You can authorize your account.'],
    'auth-profile-missing':['找不到原飞书应用，可另建专用连接。','The previous Feishu app could not be found. You can start a separate connection.'],
    'admission-denied':['此会话或话题未经授权。','This conversation or topic is not authorized.'],
    'release-stale':['这条答复已处理或已变更，请核对最新状态。','This reply was already handled or changed. Check its latest state.'],
    'source-unavailable':['飞书同步未成功。','Feishu sync failed.'],
    'invalid-input':['输入无效，请核对后重试。','Invalid input. Check your entries.'],
    'source-settings-changed':['飞书设置已变更。请核对后重新保存。','Feishu settings changed. Check your values and save again.'],
    'invalid-cli-path':['未保存。请填写本机 lark-cli 可执行文件的绝对路径，不要附加参数；留空可使用系统 PATH。','Not saved. Enter the absolute path to the lark-cli executable without arguments, or leave it empty to use the system PATH.'],
    'preset-unavailable':['预设不可用，请重新选择。','The preset is unavailable. Choose another.'],
    'roster-unavailable':['无法读取预设。','Presets could not be loaded.'],
    'case-not-found':['未找到此事项。','This case could not be found.'],
    'request-conflict':['请求与已保存的委托冲突。','This request conflicts with an existing submission.'],
    'case-busy':['此事项正在提交。','Submission is already in progress.'],
    'dispatch-uncertain':['无法确认上次提交，请核对原会话。','The last submission is unconfirmed. Check the original conversation.'],
    'storage-unavailable':['未能读取或保存工作区。','Could not read or save the workspace.']
  };
  return tr(...(Object.hasOwn(labels,code) ? labels[code] : ['操作未确认，请刷新查看工作区状态。','The operation was not confirmed. Refresh the workspace to check.']));
}

async function spaceRefreshWorkspace(reload,readRoster,manual) {
  const refresh=()=>Promise.all([reload(),readRoster()]);
  if (!manual) return refresh();
  const {active,pending,setRefreshing}=manual;
  if (!active.current || pending.current) return;
  pending.current=true;
  setRefreshing(true);
  try { await refresh() }
  finally {
    pending.current=false;
    if (active.current) setRefreshing(false);
  }
}

function SuperagentPage({t,ops,settingsOnly=false,renderFactorySlot,useContextMenu}) {
  const zh=t('language')==='zh',tr=React.useCallback((cn,en)=>zh ? cn : en,[zh]);
  const [generation,setGeneration]=React.useState(0);
  // The shared DSH row menu: its ellipsis button and right-click binding, when the menu plugin is loaded.
  const bindings=useContextMenu?.(),menu=renderFactorySlot && {button:props=>renderFactorySlot('contextMenu.button',props),trigger:bindings?.getTriggerProps};
  React.useEffect(()=>ops.onReset(()=>setGeneration(n=>n+1)),[ops]);
  return h('section',{className:settingsOnly?'sx sx-global-settings':'sx','aria-label':'SuperAgent'},h('style',null,css),h(SpaceConnected,{key:generation,ops,tr,settingsOnly,menu}));
}
function SpaceConnected({ops,tr,settingsOnly,menu}) {
  const [tab,setTab]=React.useState('team');
  const [snapshot,setSnapshot]=React.useState(null),[error,setError]=React.useState(null),[busy,setBusy]=React.useState(false);
  const [roster,setRoster]=React.useState(null),[rosterStatus,setRosterStatus]=React.useState('loading');
  const [catalog,setCatalog]=React.useState(null);
  const [refreshing,setRefreshing]=React.useState(false),manualPending=React.useRef(false);
  const active=React.useRef(true),lock=React.useRef(false),revision=React.useRef(0),rosterRev=React.useRef(0);
  const reload=React.useCallback(async (keepSource=false)=>{
    const token=++revision.current;
    try {
      const value=await ops.ask(settingsOnly?'settingsSnapshot':'snapshot',{});
      if(active.current && revision.current===token) {setSnapshot(value);setError(null);return value}
    } catch(e) {
      if(active.current && revision.current===token) {
        // A failed background read must not unmount (and cancel) an active authorization flow.
        if(!keepSource || e.code==='scope-changed') setSnapshot(null);
        setError(e.code || 'unavailable');
      }
    }
  },[ops,settingsOnly]);
  const readRoster=React.useCallback(async ()=>{
    const token=++rosterRev.current;
    try {
      const response=await ops.presets(),rows=response?.value?.presets;
      if (!response?.ok || !Array.isArray(rows)) throw Error('presets');
      if(active.current && rosterRev.current===token) {setRoster(spacePresetRoster(rows,ops.presetText));setRosterStatus('ready')}
    } catch {
      if(active.current && rosterRev.current===token){setRoster([]);setRosterStatus('error')}
    }
  },[ops]);
  React.useEffect(()=>{
    active.current=true;
    const refresh=()=>{if(!lock.current)void spaceRefreshWorkspace(()=>reload(settingsOnly),readRoster)};
    refresh(); window.addEventListener('focus',refresh);
    const off=settingsOnly && ops.observeModels(setCatalog);
    const unsubscribe=!settingsOnly && ops.onSettingsChange(()=>{if(!lock.current)void reload()});
    return ()=>{active.current=false;revision.current++;rosterRev.current++;if(off)off();if(unsubscribe)unsubscribe();window.removeEventListener('focus',refresh)};
  },[ops,reload,readRoster,settingsOnly]);
  React.useEffect(()=>{
    if(!Number.isSafeInteger(snapshot?.revision))return;
    let stopped=false,timer;
    const tick=async()=>{
      try {
        if(!document.hidden && !lock.current && await ops.ask('viewRevision',{})!==snapshot.revision &&
          !stopped && !lock.current)await reload(settingsOnly);
      } catch { /* The connection reset or next visible tick will refresh. */ }
      if(!stopped)timer=setTimeout(tick,4000);
    };
    if(settingsOnly)void tick();else timer=setTimeout(tick,4000);
    return ()=>{stopped=true;clearTimeout(timer)};
  },[settingsOnly,snapshot?.revision,ops,reload]);
  async function change(endpoint,input) {
    if (lock.current) return;
    const sourceEdit=['setCliPath','setHistoryLimits','setPrivateChats','setPollInterval'].includes(endpoint);
    lock.current=true;revision.current++;setBusy(true);setError(null);
    try {
      const value=await ops.ask(endpoint,input);
      if(!active.current) return;
      if(sourceEdit) setSnapshot(s=>s && {...s,source:{...s.source,settings:value}});
      await reload(sourceEdit);
      if(active.current) return value;
    } catch(e) {
      if(active.current){
        await reload(sourceEdit);
        if(active.current)setError(sourceEdit && e.code==='scope-changed' ? 'source-settings-changed' : e.code || 'unavailable');
      }
    } finally {
      lock.current=false;
      if(active.current) setBusy(false);
    }
  }
  if (!snapshot) return h('div',{className:'sx2'},h('section',{className:'x2-page'},h('h2',null,'SuperAgent'),
    h('p',{className:'x2-empty',role:error ? 'alert' : 'status'},error ? spaceErrorText(error,tr) : tr('正在读取工作区…','Loading workspace…')),
    error && h('button',{type:'button',className:'sx-quiet',onClick:()=>void reload()},tr('重试','Retry'))));
  const p={...snapshot,tr,catalog,roster:roster || [],rosterStatus,busy,error:error && spaceErrorText(error,tr),configure:patch=>change('configure',patch),
    feishuAction:ops.ask,reloadFeishu:reload,setCliPath:input=>change('setCliPath',input),setHistoryLimits:input=>change('setHistoryLimits',input),
     setPrivateChats:input=>change('setPrivateChats',input),setReleasePolicy:input=>change('setReleasePolicy',input),releaseOutput:input=>change('releaseOutput',input),
    archiveCase:input=>change('archiveCase',input),retryWork:input=>change('retryWork',input),takeOver:input=>change('takeOver',input),
    groupAccess:input=>change('groupAccess',input),setPollInterval:input=>change('setPollInterval',input)};
  if(settingsOnly) return h('div',{className:'sx2'},p.error && h('p',{role:'alert'},p.error),
    h(SpaceSettings,{p,source:tab==='source',show:setTab}));
  return h(EditionWorkspace,{...p,cases:spaceWithRuns(p.cases,p.automation),openSession:ops.openSession,refreshing,
    menu,registerCaseMenu:ops.registerCaseMenu,registerMenu:ops.registerMenu,openMenu:ops.openMenu,notify:ops.notify,retainSession:ops.retainSession,
    reload:()=>spaceRefreshWorkspace(reload,readRoster,{active,pending:manualPending,setRefreshing})});
}
// Whether SuperAgent needs the owner, for the sidebar icon. Polls the cheap view revision and
// rereads attention only when it changes, while the page is visible.
function spaceAttentionStore(ask) {
  let needed=false,revision,stopped=false,timer,busy=false;
  const listeners=new Set(),set=value=>{if(value!==needed){needed=value;listeners.forEach(fn=>fn())}};
  async function tick() {
    if(busy || stopped) return;
    busy=true;
    try {
      if(!document.hidden) {
        const current=await ask('viewRevision',{});
        if(current!==revision) {const value=await ask('attention',{});revision=value.revision;set(value.needed===true)}
      }
    } catch { /* Keep the last known state until the next tick. */ }
    finally {busy=false}
  }
  const refresh=()=>{revision=undefined;void tick()};
  return {
    getSnapshot:()=>needed,
    subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)},
    start(){void tick();timer=setInterval(tick,5000);window.addEventListener('focus',refresh);
      return ()=>{stopped=true;clearInterval(timer);window.removeEventListener('focus',refresh)}},
    refresh,
  };
}
function SpaceLeadIcon({size,store,tr}) {
  const needed=React.useSyncExternalStore(store.subscribe,store.getSnapshot);
  return h('span',{style:{position:'relative',display:'inline-flex'}},h(Mark,{name:'lead',size}),
    needed && h('span',{role:'img','aria-label':tr('需要你处理','Needs your attention'),style:{position:'absolute',top:-1,right:-2,width:7,height:7,
      borderRadius:'50%',background:'var(--dsw-alias-state-warn-primary)',boxShadow:'0 0 0 1.5px var(--dsw-specific-sidebar-fill)'}}));
}
function applySuperagent(ctx) {
  const id='pcmid-superagent', ns='pcmid.superagent';
  ctx.effect(()=>ctx.locale.register(ns,{zh:{label:'SuperAgent',language:'zh'},en:{label:'SuperAgent',language:'en'}}),'superagent: panel labels');
  const changes=new EventTarget(),t=ctx.locale.bind(ns),ops={
    ask:(endpoint,input)=>spaceCall(ctx,endpoint,input),
    presets:()=>ctx.remote.agentPresets.list(),presetText:ctx.locale.bind('settings.agentPreset'),
    // DSH does not open an archived session, so restore it to the sidebar first.
    openSession:async id=>{
      if(ctx.get?.('workspaces')?.list?.getSnapshot()?.archivedSessionIds?.includes(id)) await ctx.uiWorkspace.unarchiveSession(id);
      ctx.uiWorkspace.openSession(id);
    },
    // Read-only follow of a seat's native event stream; released when the case view unmounts.
    retainSession:id=>ctx.get('sessions')?.retain(id,{source:'superagentCase'}),
    registerCaseMenu:resolve=>ctx.get('contextMenus')?.register({id:'pcmid-superagent.case',target:'superagent-case',order:0,resolve:value=>resolve(value)}) ?? (()=>{}),
    registerMenu:(id,kind,resolve)=>ctx.get('contextMenus')?.register({id,target:kind,order:0,resolve:value=>resolve(value)}) ?? (()=>{}),
    // The shared DSH menu popup, anchored below a dropdown button.
    openMenu:ctx.get('contextMenus') ? (target,point)=>ctx.get('contextMenus').open(target,point) : undefined,
    notify:text=>ctx.get('contextMenus')?.notify(text,true),
    onReset:listener=>ctx.on('connection/reset',listener),
    onSettingsChange:listener=>{changes.addEventListener('change',listener);return ()=>changes.removeEventListener('change',listener)},
    observeModels:listener=>{
      listener({rows:[]});
      const observer=ctx.inject(['modules','modelDirectories'],scope=>{
        const store=spaceCatalogStore(scope);
        if(!store)return;
        scope.effect(()=>{
          const read=()=>listener({rows:spaceCatalogRows(store.getSnapshot())});
          const off=store.subscribe(read);read();return ()=>{off();listener({rows:[]})};
        },'superagent: observe cached model choices');
      });
      return ()=>observer.dispose();
    }
  };
  const settingsOps={...ops,async ask(endpoint,input){
    const result=await ops.ask(endpoint,input);
    if(['configure','saveFeishu','finishFeishuAuth','groupAccess','setPollInterval','setCliPath','setHistoryLimits','setPrivateChats','setReleasePolicy'].includes(endpoint)) changes.dispatchEvent(new Event('change'));
    return result;
  }};
  const attention=spaceAttentionStore(ops.ask);
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id,order:25,locale:ns,label:()=>t('label'),
    inject:()=>({ops:settingsOps,settingsOnly:true})},SuperagentPage));
  ctx.slots.inject('settings.section.icon',()=>ctx.slots.register({name:'settings.section.icon',id},
    ({size})=>h(Mark,{name:'lead',size})));
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:id,locale:ns,inject:()=>({ops})},SuperagentPage));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id,order:13,locale:ns,label:()=>t('label')},
    ({size=20,t:text})=>h(SpaceLeadIcon,{size,store:attention,tr:(zh,en)=>text?.('language')==='zh' ? zh : en})));
  ctx.effect(()=>attention.start(),'superagent: attention indicator');
  ctx.effect(()=>ctx.on('connection/reset',attention.refresh),'superagent: attention after reconnect');
}

return { inject: ['slots','locale','connection','uiWorkspace','remote','remote.agentPresets'], apply: applySuperagent };
} });
