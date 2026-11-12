// MCP servers page (Client half): list → detail drill-down, paste-first add,
// one add/edit form whose secrets live in the credential store, batch import,
// and live status from `ctx.remote.mcpManager.watch`. Pure helpers come first
// (unit-tested in test/mcp-parse.test.mjs), then the controller, then the
// components and their CSS. Every top-level name carries an mcp/Mcp/MCP_ prefix
// because all client parts share one function scope.

const MCP_FORM_NS = 'mcp-manager';
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MCP_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_HEADER_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MCP_SOLE_TEMPLATE_RE = /^\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const MCP_ANY_TEMPLATE_RE = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MCP_TEMPLATE_START = '${credential:';
const MCP_DEFAULT_STARTUP_MS = 30000;
const MCP_DEFAULT_TOOL_CALL_MS = 60000;
const MCP_MAX_MS = 2147483647;
const MCP_ADD_OPENER = '+add';
const MCP_SECRET_KEY_RE = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL/i;
const MCP_NOT_SECRET_RE = /(?:^|[_-])(?:URL|URI|PATH|FILE|DIR|HOST|PORT|ENDPOINT)$/i;
const MCP_SHELL_ESCAPABLE = ' \t\'"\\$`|&;()<>!#*?[]{}~';
const MCP_SHELL_SAFE = /^[A-Za-z0-9_\-+=/.,:@%^~]+$/;
const MCP_ADVANCED_FIELDS = new Set(['cwd', 'startup', 'toolCall']);
/** Failure text that means the server wants credentials (same pattern as the Host supervisor). */
const MCP_AUTH_ERROR_RE = /\b401\b|requires authorization|unauthori[sz]ed|invalid_token/i;
const MCP_AUTH_CHECK_DEBOUNCE_MS = 600;
const MCP_STATE_RETRY_MS = 2000;
const MCP_FLOW_RANK = { pending: 0, exchanging: 1, done: 2, error: 2, cancelled: 2 };

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

const mcpHasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function mcpIsObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function mcpObject(value) { return mcpIsObject(value) ? value : {}; }
function mcpStr(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
function mcpArr(value) { return Array.isArray(value) ? value.map(mcpStr) : []; }
function mcpHasExpression(value) {
  if (mcpIsObject(value) && typeof value.__jsExpr === 'string') return true;
  if (Array.isArray(value)) return value.some(mcpHasExpression);
  if (mcpIsObject(value)) return Object.values(value).some(mcpHasExpression);
  return false;
}
/** Membership in a Set or an array (duck-typed so callers from another realm work). */
function mcpHas(collection, value) {
  if (!collection) return false;
  if (typeof collection.has === 'function') return collection.has(value);
  return Array.isArray(collection) && collection.includes(value);
}
function mcpFirstLine(text) { return mcpStr(text).trim().split(/\r?\n/)[0] ?? ''; }
function mcpSameArray(a, b) { return a.length === b.length && a.every((item, index) => item === b[index]); }
function mcpTemplate(ref) { return MCP_TEMPLATE_START + ref + '}'; }
function mcpIsUrl(text) { return /^https?:\/\/[^\s/?#]+\S*$/i.test(mcpStr(text)); }
function mcpUrlHost(url) {
  try { return new URL(url).hostname; } catch { return (/^https?:\/\/([^\s/?#:]+)/i.exec(url) ?? [])[1] ?? ''; }
}

// ---------------------------------------------------------------------------
// Shell words
// ---------------------------------------------------------------------------

/**
 * Split a command line the way a POSIX shell would, without expansion: single
 * quotes are literal, double quotes honour \" \\ \$ \`, a backslash outside
 * quotes escapes shell-special characters (before ordinary characters it stays,
 * so Windows paths survive), backslash-newline continues the line, `#` at a word
 * start comments to the end of the line. Unescaped newlines separate `lines`.
 */
function mcpShellSplit(input) {
  const text = String(input ?? '');
  const lines = [];
  let line = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) line.push(word);
    word = '';
    inWord = false;
  };
  const endLine = () => {
    endWord();
    if (line.length) lines.push(line);
    line = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = null; continue; }
      if (c === '\\') {
        const next = text[i + 1];
        if (next === '\n') { i += 1; continue; }
        if (next === '\r' && text[i + 2] === '\n') { i += 2; continue; }
        if (next !== undefined && '"\\$`'.includes(next)) { word += next; i += 1; continue; }
      }
      word += c;
      continue;
    }
    if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined) continue;
      if (next === '\n') { i += 1; continue; }
      if (next === '\r' && text[i + 2] === '\n') { i += 2; continue; }
      if (MCP_SHELL_ESCAPABLE.includes(next)) { word += next; inWord = true; i += 1; continue; }
      word += c;
      inWord = true;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === '\n') { endLine(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    if (c === '#' && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1;
      continue;
    }
    word += c;
    inWord = true;
  }
  endLine();
  const words = lines.flat();
  return quote ? { words, lines, error: 'quote' } : { words, lines };
}

/** Quote one word for display so that mcpShellSplit gives it back unchanged. */
function mcpShellQuote(word) {
  const text = String(word ?? '');
  if (text === '') return "''";
  if (MCP_SHELL_SAFE.test(text)) return text;
  if (!text.includes("'")) return `'${text}'`;
  if (!/["\\$`]/.test(text)) return `"${text}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function mcpShellJoin(words) {
  return words.map((word, index) => {
    const text = String(word ?? '');
    // A leading `NAME=value` would read back as an environment assignment.
    if (index === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return `'${text.replace(/'/g, "'\\''")}'`;
    return mcpShellQuote(text);
  }).join(' ');
}

/** Leading `KEY=VALUE` words (optionally after `env`) become environment pairs. */
function mcpExtractEnv(words) {
  const env = [];
  let index = 0;
  if (words[0] === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[1] ?? '')) index = 1;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
    const at = words[index].indexOf('=');
    env.push([words[index].slice(0, at), words[index].slice(at + 1)]);
    index += 1;
  }
  return { env, words: words.slice(index) };
}

/**
 * A pasted command block: `export KEY=VALUE` / `set KEY=VALUE` lines and
 * leading assignments become env pairs, a `$ ` prompt is dropped, and the last
 * remaining line is the command. Null when a quote is left open.
 */
function mcpCommandFromText(text) {
  const split = mcpShellSplit(text);
  if (split.error) return null;
  const env = [];
  let words = [];
  for (let line of split.lines) {
    if (line[0] === '$' || line[0] === '>' || line[0] === '%') line = line.slice(1);
    if (line[0] === 'export' || line[0] === 'set') {
      for (const word of line.slice(1)) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(word);
        if (match) env.push([match[1], match[2]]);
      }
      continue;
    }
    const extracted = mcpExtractEnv(line);
    env.push(...extracted.env);
    if (extracted.words.length) words = extracted.words;
  }
  return { env, words };
}

// ---------------------------------------------------------------------------
// JSON / JSONC
// ---------------------------------------------------------------------------

/** Drop `//` and block comments outside strings, then commas before `}` or `]`. */
function mcpStripJsonc(input) {
  const text = String(input ?? '');
  const skipString = (source, start) => {
    let j = start + 1;
    while (j < source.length && source[j] !== '"') {
      if (source[j] === '\\') j += 1;
      j += 1;
    }
    return j;
  };
  let bare = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      const end = skipString(text, i);
      bare += text.slice(i, end + 1);
      i = end + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      bare += c;
      i += 1;
    }
  }
  let out = '';
  for (let i = 0; i < bare.length; i += 1) {
    const c = bare[i];
    if (c === '"') {
      const end = skipString(bare, i);
      out += bare.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < bare.length && /\s/.test(bare[j])) j += 1;
      if (bare[j] === '}' || bare[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

/** JSON.parse after JSONC cleanup; a bare `"name": {...}` fragment is wrapped in braces. */
function mcpParseJsonLoose(input) {
  const cleaned = mcpStripJsonc(input).trim();
  try {
    return { value: JSON.parse(cleaned) };
  } catch (error) {
    if (cleaned.startsWith('"')) {
      try { return { value: JSON.parse(`{${cleaned.replace(/,\s*$/, '')}}`) }; } catch { /* report the original error */ }
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Normalized server name: [a-z0-9_-], no leading/trailing separators, at most 32 characters. */
function mcpNormalizeName(raw) {
  return String(raw ?? '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32)
    .replace(/[-_]+$/, '');
}

/** Normalization while typing: keeps a trailing separator the user is about to extend. */
function mcpTypeName(raw) {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 32);
}

/** `base`, or `base-2`, `base-3`… when taken (still at most 32 characters). */
function mcpUniqueName(base, taken) {
  const has = (name) => mcpHas(taken, name);
  const root = base || 'server';
  if (!has(root)) return root;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, 32 - suffix.length).replace(/[-_]+$/, '')}${suffix}`;
    if (!has(candidate)) return candidate;
  }
}

/** `@scope/server-github@1.2` → `github`, `mcp-server-fetch` → `fetch`, `/x/tiny-mcp.mjs` → `tiny`. */
function mcpCleanPackageName(raw) {
  let text = String(raw ?? '').trim().replace(/[?#].*$/, '').replace(/[\\/]+$/, '');
  text = text.replace(/\[[^\]]*\]$/, '').replace(/(?:==|>=|<=|~=|!=).*$/, '');
  text = text.replace(/^(@?[^@]+)@.*$/, '$1');
  const scope = /^@([^/]+)\//.exec(text)?.[1] ?? '';
  let last = text.split(/[\\/]/).pop() ?? '';
  last = last.replace(/:.*$/, '').replace(/\.(?:m?js|cjs|ts|mts|py|jar|exe|cmd|bat|sh|ps1)$/i, '');
  const lower = last.toLowerCase();
  let core = lower
    .replace(/^(?:mcp[-_]server[-_]|server[-_]mcp[-_]|mcp[-_]|server[-_])/, '')
    .replace(/(?:[-_]mcp[-_]server|[-_]server[-_]mcp|[-_]mcp|[-_]server)$/, '');
  if (scope && (core === '' || ['mcp', 'server', 'mcp-server', 'server-mcp'].includes(core))) core = scope.toLowerCase();
  return core || lower;
}

const MCP_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'npm', 'bun', 'uvx', 'uv', 'pipx', 'deno', 'docker', 'podman', 'node', 'nodejs', 'python', 'python3', 'py', 'java', 'go', 'dotnet', 'ruby', 'php', 'sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'tsx', 'ts-node']);
const MCP_RUNNER_SUBCOMMANDS = new Set(['run', 'dlx', 'exec', 'x', 'tool']);
const MCP_VALUE_OPTIONS = new Set(['-e', '--env', '-v', '--volume', '--name', '-p', '--publish', '--network', '-w', '--workdir', '--env-file', '--mount', '-u', '--user', '--entrypoint', '--platform', '--from', '--with', '--python', '--directory', '--registry', '--prefix', '--port', '--host', '-c', '--config']);
const MCP_PACKAGE_OPTIONS = new Set(['-m', '-jar', '--package']);

function mcpNameFromUrl(url) {
  const host = mcpUrlHost(url).replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return '';
  if (host === 'localhost') return 'localhost';
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return 'local';
  const labels = host.split('.').filter(Boolean);
  while (labels.length > 1 && /^(?:mcp|www|api|server|remote)$/.test(labels[0])) labels.shift();
  const first = labels[0] ?? '';
  return mcpNormalizeName(mcpCleanPackageName(first) || first);
}

/** The most package-like word of a command: the package a runner starts, a script, or the binary itself. */
function mcpNameFromCommand(words) {
  if (!words.length) return '';
  const binary = String(words[0]).split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  let candidate = '';
  if (MCP_RUNNERS.has(binary)) {
    const positional = [];
    for (let i = 1; i < words.length; i += 1) {
      const word = words[i];
      if (MCP_PACKAGE_OPTIONS.has(word)) { candidate = words[i + 1] ?? ''; break; }
      if (word === '--') continue;
      if (word.startsWith('-')) {
        if (MCP_VALUE_OPTIONS.has(word)) i += 1;
        continue;
      }
      positional.push(word);
    }
    if (!candidate) {
      let index = 0;
      while (index < positional.length - 1 && MCP_RUNNER_SUBCOMMANDS.has(positional[index])) index += 1;
      candidate = positional[index] ?? '';
    }
  }
  let name = mcpNormalizeName(mcpCleanPackageName(candidate || words[0]));
  if (['remote', 'proxy', 'gateway', 'supergateway'].includes(name)) {
    const url = words.find((word) => mcpIsUrl(word));
    if (url) name = mcpNameFromUrl(url) || name;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Secrets and credential templates
// ---------------------------------------------------------------------------

function mcpIsSecretKey(key) {
  const text = mcpStr(key);
  return MCP_SECRET_KEY_RE.test(text) && !MCP_NOT_SECRET_RE.test(text);
}

function mcpSoleCredential(value) { return MCP_SOLE_TEMPLATE_RE.exec(mcpStr(value))?.[1] ?? null; }
function mcpTemplateRefs(value) { return [...mcpStr(value).matchAll(MCP_ANY_TEMPLATE_RE)].map((match) => match[1]); }

/** True when some `${credential:` is not followed by a valid reference and `}`. */
function mcpTemplateProblem(value) {
  const text = mcpStr(value);
  let index = text.indexOf(MCP_TEMPLATE_START);
  while (index >= 0) {
    if (!/^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}/.test(text.slice(index))) return true;
    index = text.indexOf(MCP_TEMPLATE_START, index + 1);
  }
  return false;
}

function mcpRefPart(text) { return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_'); }
function mcpRefPrefix(server) { return `MCP_${mcpRefPart(server)}_`; }

/** `MCP_<SERVER>_<KEY>` (uppercase, other characters → `_`), then `_2`, `_3`… when taken. */
function mcpCredentialRef(server, key, taken = []) {
  const has = (ref) => mcpHas(taken, ref);
  const base = `${mcpRefPrefix(server)}${mcpRefPart(key)}`;
  if (!has(base)) return base;
  for (let n = 2; ; n += 1) if (!has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Every credential reference an entry's strings use. */
function mcpEntryRefs(entry) {
  const refs = new Set();
  if (!mcpIsObject(entry)) return refs;
  const add = (value) => { for (const ref of mcpTemplateRefs(value)) refs.add(ref); };
  add(entry.command);
  mcpArr(entry.args).forEach(add);
  add(entry.cwd);
  add(entry.url);
  Object.values(mcpObject(entry.env)).forEach(add);
  Object.values(mcpObject(entry.headers)).forEach(add);
  return refs;
}

function mcpConfigRefs(servers, exclude) {
  const refs = new Set();
  for (const [name, entry] of Object.entries(mcpObject(servers))) {
    if (name === exclude) continue;
    for (const ref of mcpEntryRefs(entry)) refs.add(ref);
  }
  return refs;
}

/**
 * Values copied from other clients: `${VAR}` / `${env:VAR}` / sole `$VAR` become
 * `${credential:VAR}` (the local provider also reads the Host environment);
 * VS Code `${input:…}` prompts and README placeholders (`<your-token>`) become
 * an empty value the user must fill, keeping the original as an example.
 */
function mcpMapPlaceholder(value) {
  const text = mcpStr(value);
  let mapped = text.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => mcpTemplate(name));
  const sole = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(mapped);
  if (sole) mapped = mcpTemplate(sole[1]);
  if (/\$\{input:[^}]*\}/.test(mapped) || /<[^<>]*>|\byour[\s_-]|_here\b|^x{3,}$|^\.{3}$|^(?:changeme|replace[-_ ]?me|todo)$/i.test(mapped)) {
    return { value: '', placeholder: true, example: text };
  }
  return { value: mapped };
}

// ---------------------------------------------------------------------------
// Paste detection
// ---------------------------------------------------------------------------

function mcpTransportOf(raw) {
  const type = mcpStr(raw).toLowerCase().replace(/[\s_-]/g, '');
  if (type === 'stdio' || type === 'local' || type === 'command') return { transport: 'stdio' };
  if (['http', 'https', 'streamablehttp', 'streamable', 'remote'].includes(type)) return { transport: 'streamable-http' };
  if (type === 'sse') return { transport: 'streamable-http', warning: 'sse' };
  return null;
}

function mcpIsServerLike(value) {
  if (!mcpIsObject(value)) return false;
  if (['command', 'url', 'serverUrl', 'httpUrl'].some((key) => mcpHasOwn(value, key))) return true;
  return mcpTransportOf(value.type ?? value.transport) !== null;
}

function mcpDeriveName(server) {
  const name = server.transport === 'stdio' ? mcpNameFromCommand([server.command, ...server.args].filter((word, index) => index > 0 || word)) : mcpNameFromUrl(server.url);
  return name || 'server';
}

function mcpMapPairs(object, kind, placeholders) {
  const out = {};
  for (const [key, raw] of Object.entries(mcpObject(object))) {
    const mapped = mcpMapPlaceholder(raw);
    out[key] = mapped.value;
    if (mapped.placeholder) placeholders[`${kind}:${key}`] = mapped.example;
  }
  return out;
}

/** One server from a JSON object in any of the common client formats. */
function mcpServerFromJson(raw, key) {
  const warnings = [];
  const placeholders = {};
  let commandWords = Array.isArray(raw.command) ? raw.command.map(mcpStr) : typeof raw.command === 'string' ? [raw.command] : [];
  const args = Array.isArray(raw.args) ? raw.args.map(mcpStr) : typeof raw.args === 'string' ? mcpShellSplit(raw.args).words : [];
  if (commandWords.length === 1 && args.length === 0 && /\s/.test(commandWords[0].trim())) {
    const split = mcpShellSplit(commandWords[0]);
    if (!split.error && split.words.length > 1) commandWords = split.words;
  }
  commandWords = commandWords.filter((word, index) => index > 0 || word.trim() !== '');
  const url = mcpStr(raw.url ?? raw.serverUrl ?? raw.httpUrl ?? raw.endpoint).trim();
  const typed = mcpTransportOf(raw.type ?? raw.transport);
  let transport = typed?.transport ?? (commandWords.length ? 'stdio' : url ? 'streamable-http' : 'stdio');
  if (transport === 'streamable-http' && !url && commandWords.length) transport = 'stdio';
  if (transport === 'stdio' && !commandWords.length && url) transport = 'streamable-http';
  if (typed?.warning && transport === 'streamable-http') warnings.push(typed.warning);
  const server = {
    name: '',
    derived: false,
    transport,
    command: commandWords[0] ?? '',
    args: [...commandWords.slice(1), ...args],
    env: mcpMapPairs(raw.env ?? raw.environment, 'env', placeholders),
    cwd: mcpStr(raw.cwd ?? raw.workingDirectory),
    url,
    headers: mcpMapPairs(raw.headers, 'headers', placeholders),
    enabled: !(raw.enabled === false || raw.disabled === true),
    warnings,
    placeholders,
  };
  const startup = Number(raw.startupTimeoutMs);
  if (Number.isInteger(startup) && startup > 0) server.startupTimeoutMs = startup;
  const toolCall = Number(raw.toolCallTimeoutMs);
  if (Number.isInteger(toolCall) && toolCall > 0) server.toolCallTimeoutMs = toolCall;
  const normalized = key === undefined ? '' : mcpNormalizeName(key);
  server.name = normalized || mcpDeriveName(server);
  server.derived = !normalized;
  return server;
}

/** `[key | undefined, raw]` pairs for every server a JSON document carries. */
function mcpJsonServerEntries(value) {
  if (Array.isArray(value)) {
    return value.filter(mcpIsServerLike).map((item) => [typeof item.name === 'string' ? item.name : undefined, item]);
  }
  if (!mcpIsObject(value)) return [];
  const pick = (map) => Object.entries(map).filter(([, raw]) => mcpIsServerLike(raw));
  const containers = [value.mcpServers, mcpIsObject(value.mcp) ? value.mcp.servers : undefined, value.servers, value.context_servers];
  for (const map of containers) if (mcpIsObject(map)) return pick(map);
  if (mcpIsObject(value.mcp) && Object.values(value.mcp).some(mcpIsServerLike)) return pick(value.mcp);
  if (mcpIsServerLike(value)) return [[typeof value.name === 'string' ? value.name : undefined, value]];
  return pick(value);
}

/** `claude|codex|gemini mcp add [options] <name> [--] <command…|url>`. */
function mcpParseCliAdd(words) {
  const tool = String(words[0] ?? '').split(/[\\/]/).pop();
  if (!['claude', 'codex', 'gemini'].includes(tool) || words[1] !== 'mcp' || words[2] !== 'add') return null;
  let transport = null;
  let url = '';
  let name;
  const env = {};
  const headers = {};
  let rest = [];
  const optionValue = (word, next) => {
    const at = word.indexOf('=');
    return at > 0 && word.startsWith('--') ? { value: word.slice(at + 1), used: 1 } : { value: next ?? '', used: 2 };
  };
  for (let i = 3; i < words.length;) {
    const word = words[i];
    const flag = word.startsWith('--') ? word.split('=')[0] : word;
    if (word === '--') { rest = words.slice(i + 1); break; }
    if (flag === '-t' || flag === '--transport') {
      const { value, used } = optionValue(word, words[i + 1]);
      transport = mcpTransportOf(value)?.transport ?? transport;
      i += used;
    } else if (flag === '-e' || flag === '--env') {
      const { value, used } = optionValue(word, words[i + 1]);
      const at = value.indexOf('=');
      if (at > 0) env[value.slice(0, at)] = value.slice(at + 1);
      i += used;
    } else if (flag === '-H' || flag === '--header') {
      const { value, used } = optionValue(word, words[i + 1]);
      const at = value.indexOf(':');
      if (at > 0) headers[value.slice(0, at).trim()] = value.slice(at + 1).trim();
      i += used;
    } else if (flag === '--url') {
      const { value, used } = optionValue(word, words[i + 1]);
      url = value;
      i += used;
    } else if (flag === '-s' || flag === '--scope' || flag === '--timeout' || flag === '--trust') {
      i += word.includes('=') || flag === '--trust' ? 1 : 2;
    } else if (word.startsWith('-') && name === undefined) {
      i += 1;
    } else if (name === undefined) {
      name = word;
      i += 1;
    } else {
      rest = words.slice(i);
      break;
    }
  }
  if (!url && rest.length && mcpIsUrl(rest[0])) url = rest[0];
  const remote = Boolean(url) || transport === 'streamable-http';
  const raw = remote
    ? { type: 'http', url: url || rest[0] || '', headers, env }
    : { command: rest[0] ?? '', args: rest.slice(1), env };
  return mcpServerFromJson(raw, name);
}

/**
 * Recognize pasted text. Returns `{ kind, servers, label?, warnings?, reason? }`
 * where kind is empty | unknown | command | url | json. A single result is
 * renamed away from `taken`; several keep their names (unique among themselves)
 * so the batch view can offer skip / overwrite.
 */
function mcpParsePaste(input, taken = []) {
  const text = String(input ?? '').trim();
  if (!text) return { kind: 'empty', servers: [] };
  let result = null;
  if (/^[[{"]/.test(text)) {
    const parsed = mcpParseJsonLoose(text);
    if (parsed.error === undefined) {
      const servers = mcpJsonServerEntries(parsed.value).map(([key, raw]) => mcpServerFromJson(raw, key));
      result = { kind: 'json', servers, warnings: [...new Set(servers.flatMap((server) => server.warnings))] };
    } else if (text[0] !== '"') {
      return { kind: 'unknown', servers: [], reason: parsed.error, json: true };
    }
  }
  if (!result && mcpIsUrl(text)) {
    const server = mcpServerFromJson({ type: 'http', url: text }, undefined);
    result = { kind: 'url', servers: [server], label: mcpUrlHost(text), warnings: [] };
  }
  if (!result) {
    const command = mcpCommandFromText(text);
    if (!command) return { kind: 'unknown', servers: [], reason: 'quote' };
    const cli = mcpParseCliAdd(command.words);
    if (cli) {
      for (const [key, value] of command.env) if (!mcpHasOwn(cli.env, key)) cli.env[key] = mcpMapPlaceholder(value).value;
      result = { kind: cli.transport === 'stdio' ? 'command' : 'url', servers: [cli], label: cli.transport === 'stdio' ? cli.command : mcpUrlHost(cli.url), warnings: cli.warnings };
    } else {
      const first = command.words[0] ?? '';
      if (!first || /[{}<>|;&]/.test(first)) return { kind: 'unknown', servers: [] };
      const env = {};
      const placeholders = {};
      for (const [key, value] of command.env) {
        const mapped = mcpMapPlaceholder(value);
        env[key] = mapped.value;
        if (mapped.placeholder) placeholders[`env:${key}`] = mapped.example;
      }
      const server = mcpServerFromJson({ command: first, args: command.words.slice(1) }, undefined);
      server.env = env;
      server.placeholders = placeholders;
      result = { kind: 'command', servers: [server], label: first, warnings: [] };
    }
  }
  const takenSet = new Set(taken);
  if (result.servers.length === 1) {
    result.servers[0].name = mcpUniqueName(result.servers[0].name, takenSet);
  } else {
    const seen = new Set();
    for (const server of result.servers) {
      server.name = mcpUniqueName(server.name, seen);
      seen.add(server.name);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Drafts (form state) and the entries they write
// ---------------------------------------------------------------------------

let mcpRowSeq = 0;

/** One key/value row; a value that is exactly `${credential:REF}` shows as a stored secret. */
function mcpRow(key, value, options = {}) {
  mcpRowSeq += 1;
  const id = `r${mcpRowSeq}`;
  const text = mcpStr(value);
  const ref = mcpSoleCredential(text);
  if (ref) return { id, key, value: '', secret: true, ref, locked: Boolean(options.locked), example: '' };
  return { id, key, value: text, secret: Boolean(options.secret), ref: null, locked: Boolean(options.locked), example: options.example ?? '' };
}

function mcpEnvKey(text) { return String(text ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '_'); }

function mcpMsToSec(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? String(Number((ms / 1000).toFixed(3))) : '';
}

/** Seconds text → integer milliseconds; null when not a positive number of seconds. */
function mcpSecToMs(text) {
  const trimmed = String(text ?? '').trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(trimmed)) return null;
  const ms = Math.round(Number(trimmed) * 1000);
  return ms >= 1 && ms <= MCP_MAX_MS ? ms : null;
}

/** What the dirty check compares: only fields of the selected transport. */
function mcpDraftSignature(draft) {
  const stdio = draft.transport === 'stdio';
  const rows = (draft[stdio ? 'env' : 'headers'] ?? []).map((row) => [row.key, row.value, row.secret, row.ref]);
  return JSON.stringify([draft.name, draft.transport, stdio ? draft.commandLine : draft.url, rows, stdio ? draft.cwd : '', draft.startupSec, draft.toolCallSec]);
}

function mcpFinishDraft(draft) {
  const full = { advancedOpen: false, errors: {}, focus: null, saving: false, saveError: null, savedAt: 0, warnings: [], enabled: true, ...draft };
  full.baseline = mcpDraftSignature(full);
  return full;
}

function mcpEmptyDraft() {
  return mcpFinishDraft({
    mode: 'add', target: null, origin: 'new', name: '', transport: 'stdio', commandLine: '', url: '',
    env: [], headers: [], cwd: '', startupSec: '', toolCallSec: '',
  });
}

/** Add-form draft prefilled from a recognized paste (secret-looking keys become secrets). */
function mcpDraftFromParsed(server, warnings = []) {
  const placeholders = mcpObject(server.placeholders);
  const rows = (map, kind) => Object.entries(mcpObject(map)).map(([key, value]) => {
    const marker = `${kind}:${key}`;
    const example = mcpHasOwn(placeholders, marker) ? placeholders[marker] : undefined;
    return mcpRow(key, value, { secret: example !== undefined || mcpIsSecretKey(key), example });
  });
  const command = mcpStr(server.command);
  const args = mcpArr(server.args);
  return mcpFinishDraft({
    mode: 'add', target: null, origin: 'new', name: server.name ?? '', transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    commandLine: command || args.length ? mcpShellJoin([command, ...args]) : '',
    url: mcpStr(server.url),
    env: rows(server.env, 'env'),
    headers: rows(server.headers, 'headers'),
    cwd: mcpStr(server.cwd),
    startupSec: server.startupTimeoutMs && server.startupTimeoutMs !== MCP_DEFAULT_STARTUP_MS ? mcpMsToSec(server.startupTimeoutMs) : '',
    toolCallSec: server.toolCallTimeoutMs ? mcpMsToSec(server.toolCallTimeoutMs) : '',
    enabled: server.enabled !== false,
    warnings,
  });
}

/**
 * Edit-form draft for a configured entry; keys the base layer supplies are
 * locked for inherited servers, and the Authorization header OAuth manages is
 * a read-only row.
 */
function mcpDraftFromEntry(name, entry, origin, baseEntry, oauthTemplate) {
  const base = mcpObject(baseEntry);
  const inherited = origin === 'inherited' || origin === 'overridden';
  const rows = (map, lockedMap, headers) => {
    const locked = new Set(inherited ? Object.keys(mcpObject(lockedMap)) : []);
    return Object.entries(mcpObject(map)).map(([key, value]) => {
      const row = mcpRow(key, value, { locked: locked.has(key) });
      return headers && mcpIsOAuthHeader(name, key, value, oauthTemplate) ? { ...row, oauth: true } : row;
    });
  };
  const command = mcpStr(entry.command);
  const args = mcpArr(entry.args);
  return mcpFinishDraft({
    mode: 'edit', target: name, origin, name, transport: entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    commandLine: command || args.length ? mcpShellJoin([command, ...args]) : '',
    url: mcpStr(entry.url),
    env: rows(entry.env, base.env, false),
    headers: rows(entry.headers, base.headers, true),
    cwd: mcpStr(entry.cwd),
    startupSec: typeof entry.startupTimeoutMs === 'number' && entry.startupTimeoutMs !== MCP_DEFAULT_STARTUP_MS ? mcpMsToSec(entry.startupTimeoutMs) : '',
    toolCallSec: typeof entry.toolCallTimeoutMs === 'number' ? mcpMsToSec(entry.toolCallTimeoutMs) : '',
    enabled: entry.enabled !== false,
  });
}

/** Typed secret values leave the store when the form closes; other edits stay. */
function mcpScrubDraft(draft) {
  const scrub = (rows) => rows.map((row) => (row.secret && row.value ? { ...row, value: '' } : row));
  return { ...draft, env: scrub(draft.env), headers: scrub(draft.headers), errors: {}, focus: null, saveError: null, saving: false };
}

/**
 * Field errors in field order (the first key is the field to focus). Each value
 * is `{ key, values? }` for the dictionary. Mirrors the Host's write validation.
 */
function mcpValidateDraft(draft, { taken = [] } = {}) {
  const errors = {};
  const add = (field, key, values) => { if (!mcpHasOwn(errors, field)) errors[field] = values ? { key, values } : { key }; };
  if (draft.mode === 'add') {
    if (!draft.name) add('name', 'mcp_errNameRequired');
    else if (!MCP_NAME_RE.test(draft.name)) add('name', 'mcp_errNameFormat');
    else if (mcpHas(taken, draft.name)) add('name', 'mcp_errNameTaken');
  }
  const stdio = draft.transport === 'stdio';
  if (stdio) {
    const split = mcpShellSplit(draft.commandLine);
    if (split.error) add('command', 'mcp_errQuote');
    else if (!split.words.length || !split.words[0].trim()) add('command', 'mcp_errCommandRequired');
    else if (split.words.some(mcpTemplateProblem)) add('command', 'mcp_errTemplate');
  } else {
    const url = draft.url.trim();
    if (!url) add('url', 'mcp_errUrlRequired');
    else if (!mcpIsUrl(url)) add('url', 'mcp_errUrlFormat');
    else if (mcpTemplateProblem(url)) add('url', 'mcp_errTemplate');
  }
  const kind = stdio ? 'env' : 'headers';
  const seen = new Set();
  for (const row of draft[kind]) {
    const key = row.key.trim();
    if (!key && !row.value && !row.ref) continue;
    const id = `${kind}:${row.id}`;
    if (!key) add(`${id}:key`, 'mcp_errKeyRequired');
    else if (stdio && !MCP_ENV_KEY_RE.test(key)) add(`${id}:key`, 'mcp_errEnvKey');
    else if (!stdio && !MCP_HEADER_RE.test(key)) add(`${id}:key`, 'mcp_errHeaderKey');
    else {
      const folded = stdio ? key : key.toLowerCase();
      if (seen.has(folded)) add(`${id}:key`, 'mcp_errKeyDuplicate');
      seen.add(folded);
    }
    if (row.secret) {
      if (!row.value && !row.ref) add(`${id}:value`, 'mcp_errSecretRequired');
    } else if (mcpTemplateProblem(row.value)) {
      add(`${id}:value`, 'mcp_errTemplate');
    }
  }
  if (stdio && mcpTemplateProblem(draft.cwd)) add('cwd', 'mcp_errTemplate');
  if (String(draft.startupSec ?? '').trim() && mcpSecToMs(draft.startupSec) === null) add('startup', 'mcp_errTimeout');
  if (String(draft.toolCallSec ?? '').trim() && mcpSecToMs(draft.toolCallSec) === null) add('toolCall', 'mcp_errTimeout');
  return errors;
}

/**
 * Credential plan for a save: rows with a typed secret get a reference (their
 * own `MCP_<SERVER>_` one when writable and unshared, else a fresh one) and a
 * `set`; stored secrets keep their template. `allowEmpty` (batch import) also
 * gives empty secrets a fresh reference, so the server waits for credentials.
 */
function mcpPlanSecrets(draft, server, { credInfo = {}, reserved = new Set(), allowEmpty = false } = {}) {
  const kind = draft.transport === 'stdio' ? 'env' : 'headers';
  const shared = new Set(reserved);
  const taken = new Set(shared);
  for (const row of draft[kind]) if (row.secret && row.ref) taken.add(row.ref);
  const prefix = mcpRefPrefix(server);
  const templates = new Map();
  const sets = [];
  for (const row of draft[kind]) {
    if (!row.secret) continue;
    const key = row.key.trim();
    if (!key) continue;
    let ref = row.ref;
    if (row.value !== '') {
      const reusable = ref && ref.startsWith(prefix) && !shared.has(ref) && mcpObject(credInfo[ref]).writable !== false;
      if (!reusable) {
        ref = mcpCredentialRef(server, key, taken);
        taken.add(ref);
      }
      sets.push({ ref, value: row.value });
    } else if (!ref) {
      if (!allowEmpty) continue;
      ref = mcpCredentialRef(server, key, taken);
      taken.add(ref);
    }
    templates.set(row.id, mcpTemplate(ref));
  }
  return { templates, sets };
}

/** The entry the draft describes (empty optional fields included; compact or diff it next). */
function mcpDraftToEntry(draft, templates = new Map()) {
  const stdio = draft.transport === 'stdio';
  const map = {};
  for (const row of draft[stdio ? 'env' : 'headers']) {
    const key = row.key.trim();
    if (!key) continue;
    // A secret never falls back to its plain value: no template means no value in config.
    map[key] = row.secret ? (templates.get(row.id) ?? (row.ref ? mcpTemplate(row.ref) : '')) : row.value;
  }
  const entry = { transport: stdio ? 'stdio' : 'streamable-http' };
  if (stdio) {
    const words = mcpShellSplit(draft.commandLine).words;
    entry.command = words[0] ?? '';
    entry.args = words.slice(1);
    entry.env = map;
    entry.cwd = draft.cwd.trim();
  } else {
    entry.url = draft.url.trim();
    entry.headers = map;
  }
  const startup = String(draft.startupSec ?? '').trim() ? mcpSecToMs(draft.startupSec) : null;
  const toolCall = String(draft.toolCallSec ?? '').trim() ? mcpSecToMs(draft.toolCallSec) : null;
  entry.startupTimeoutMs = startup === null ? undefined : startup;
  entry.toolCallTimeoutMs = toolCall === null ? undefined : toolCall;
  return entry;
}

/** A complete user-layer entry with only its transport's fields and no empty optional ones. */
function mcpCompactEntry(next, carry = {}) {
  const out = { transport: next.transport };
  if (next.transport === 'stdio') {
    out.command = next.command;
    if (next.args?.length) out.args = [...next.args];
    if (Object.keys(mcpObject(next.env)).length) out.env = { ...next.env };
    if (next.cwd) out.cwd = next.cwd;
  } else {
    out.url = next.url;
    if (Object.keys(mcpObject(next.headers)).length) out.headers = { ...next.headers };
  }
  if (carry.enabled === false) out.enabled = false;
  if (next.startupTimeoutMs !== undefined) out.startupTimeoutMs = next.startupTimeoutMs;
  if (next.toolCallTimeoutMs !== undefined) out.toolCallTimeoutMs = next.toolCallTimeoutMs;
  if (carry.closeTimeoutMs !== undefined) out.closeTimeoutMs = carry.closeTimeoutMs;
  // DSH must not retry a first failure; the Host supervisor reconnects servers that were connected.
  out.reconnect = { ...mcpObject(carry.reconnect), enabled: false };
  return out;
}

/**
 * Settings mutations that turn `current` into `next`. A user-added (or new)
 * server is written whole; an inherited one gets only its changed fields so the
 * override stays minimal (keys the base layer supplies are never unset). Every
 * save also turns DSH's own reconnect off (docs/auth-retry.md §1).
 */
function mcpEntryOps(name, origin, current, userRaw, baseRaw, next, carry = {}) {
  const path = (...rest) => ['servers', name, ...rest];
  if (origin === 'new' || origin === 'user') return [{ op: 'set', path: path(), value: mcpCompactEntry(next, carry) }];
  const ops = [];
  const cur = mcpObject(current);
  const user = mcpObject(userRaw);
  const base = mcpObject(baseRaw);
  const set = (value, ...rest) => ops.push({ op: 'set', path: path(...rest), value });
  const unset = (...rest) => ops.push({ op: 'unset', path: path(...rest) });
  const curTransport = cur.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  if (next.transport !== curTransport) set(next.transport, 'transport');
  const mapOps = (field, nextMap, curMap) => {
    const now = mcpObject(curMap);
    for (const [key, value] of Object.entries(nextMap)) if (mcpStr(now[key]) !== value || !mcpHasOwn(now, key)) set(value, field, key);
    for (const key of Object.keys(now)) {
      if (mcpHasOwn(nextMap, key)) continue;
      if (mcpHasOwn(mcpObject(user[field]), key) && !mcpHasOwn(mcpObject(base[field]), key)) unset(field, key);
    }
  };
  if (next.transport === 'stdio') {
    if (next.command !== mcpStr(cur.command)) set(next.command, 'command');
    if (!mcpSameArray(next.args, mcpArr(cur.args))) set([...next.args], 'args');
    if (next.cwd !== mcpStr(cur.cwd)) set(next.cwd, 'cwd');
    mapOps('env', next.env, cur.env);
  } else {
    if (next.url !== mcpStr(cur.url)) set(next.url, 'url');
    mapOps('headers', next.headers, cur.headers);
  }
  const userOnly = (field) => mcpHasOwn(user, field) && !mcpHasOwn(base, field);
  const curStartup = typeof cur.startupTimeoutMs === 'number' ? cur.startupTimeoutMs : MCP_DEFAULT_STARTUP_MS;
  const wantStartup = next.startupTimeoutMs ?? MCP_DEFAULT_STARTUP_MS;
  if (wantStartup !== curStartup) {
    if (next.startupTimeoutMs === undefined && userOnly('startupTimeoutMs')) unset('startupTimeoutMs');
    else set(wantStartup, 'startupTimeoutMs');
  }
  const curToolCall = typeof cur.toolCallTimeoutMs === 'number' ? cur.toolCallTimeoutMs : undefined;
  if (next.toolCallTimeoutMs !== curToolCall) {
    if (next.toolCallTimeoutMs !== undefined) set(next.toolCallTimeoutMs, 'toolCallTimeoutMs');
    else if (userOnly('toolCallTimeoutMs')) unset('toolCallTimeoutMs');
    else set(MCP_DEFAULT_TOOL_CALL_MS, 'toolCallTimeoutMs');
  }
  if (ops.length && mcpObject(cur.reconnect).enabled !== false) set(false, 'reconnect', 'enabled');
  return ops;
}

/** After a save: secret rows show their stored reference, typed values are gone. */
function mcpSettleDraft(draft, templates) {
  const settle = (rows) => rows.map((row) => {
    if (!row.secret) return row;
    return { ...row, value: '', ref: mcpSoleCredential(templates.get(row.id)) ?? row.ref };
  });
  return mcpFinishDraft({
    ...draft, env: settle(draft.env), headers: settle(draft.headers),
    errors: {}, focus: null, saving: false, saveError: null, savedAt: Date.now(),
  });
}

/** Non-default advanced values for the collapsed summary, as dictionary parts. */
function mcpAdvancedSummary(draft) {
  const parts = [];
  const cwd = draft.transport === 'stdio' ? draft.cwd.trim() : '';
  if (cwd) parts.push({ key: 'mcp_sumCwd', values: { v: cwd } });
  const startup = String(draft.startupSec ?? '').trim();
  const startupMs = mcpSecToMs(startup);
  if (startupMs !== null && startupMs !== MCP_DEFAULT_STARTUP_MS) parts.push({ key: 'mcp_sumStartup', values: { v: startup } });
  const toolCall = String(draft.toolCallSec ?? '').trim();
  if (mcpSecToMs(toolCall) !== null) parts.push({ key: 'mcp_sumToolCall', values: { v: toolCall } });
  return parts;
}

/** Why a batch item cannot be imported (dictionary key), or null. */
function mcpBatchProblem(server, registered) {
  if (registered.has(server.name)) return 'mcp_problemPlugin';
  if (server.transport === 'stdio' && !server.command) return 'mcp_problemCommand';
  if (server.transport !== 'stdio' && !mcpIsUrl(server.url)) return 'mcp_problemUrl';
  const values = [server.command, ...server.args, server.cwd, server.url, ...Object.values(server.env), ...Object.values(server.headers)];
  if (values.some(mcpTemplateProblem)) return 'mcp_problemTemplate';
  return null;
}

function mcpServerSummary(server) {
  if (server.transport !== 'stdio') return mcpStr(server.url);
  const command = mcpStr(server.command);
  const args = mcpArr(server.args);
  return command || args.length ? mcpShellJoin([command, ...args]) : '';
}

// ---------------------------------------------------------------------------
// Authorization (OAuth) and the Host supervisor (docs/auth-retry.md)
// ---------------------------------------------------------------------------

function mcpIsAuthError(text) { return MCP_AUTH_ERROR_RE.test(mcpStr(text)); }

/** Credential reference the Host stores this server's OAuth access token under. */
function mcpOAuthRef(name) { return `MCP_${mcpRefPart(name)}_OAUTH`; }
function mcpOAuthTemplate(name) { return `Bearer ${mcpTemplate(mcpOAuthRef(name))}`; }

/** The header key that carries Authorization (any case), or null. */
function mcpAuthHeaderKey(headers) {
  return Object.keys(mcpObject(headers)).find((key) => key.toLowerCase() === 'authorization') ?? null;
}

/** An `Authorization` header whose value is this server's OAuth template (or the one the Host returned). */
function mcpIsOAuthHeader(name, key, value, template) {
  if (mcpStr(key).toLowerCase() !== 'authorization') return false;
  const text = mcpStr(value);
  return text === mcpOAuthTemplate(name) || (Boolean(template) && text === template);
}

/** True when a Streamable HTTP entry sends this server's OAuth token. */
function mcpEntryUsesOAuth(name, entry, template) {
  const e = mcpObject(entry);
  if (e.transport !== 'streamable-http') return false;
  return Object.entries(mcpObject(e.headers)).some(([key, value]) => mcpIsOAuthHeader(name, key, value, template));
}

/**
 * Mutations that make an entry send the OAuth token: the Authorization header
 * (under its existing key, whatever its case) plus `reconnect.enabled: false`,
 * as path writes so an inherited server keeps a minimal override. Empty when
 * the header is already in place.
 */
function mcpAuthHeaderOps(name, entry, template = mcpOAuthTemplate(name)) {
  const e = mcpObject(entry);
  const headers = mcpObject(e.headers);
  const key = mcpAuthHeaderKey(headers) ?? 'Authorization';
  if (headers[key] === template) return [];
  const ops = [{ op: 'set', path: ['servers', name, 'headers', key], value: template }];
  if (mcpObject(e.reconnect).enabled !== false) ops.push({ op: 'set', path: ['servers', name, 'reconnect', 'enabled'], value: false });
  return ops;
}

/** Combine the flow this page started with the Host's view of it; the further-along status wins. */
function mcpMergeFlow(local, remote) {
  const a = mcpIsObject(local) ? local : null;
  const b = mcpIsObject(remote) ? remote : null;
  if (!a) return b;
  if (!b) return a;
  if (a.flowId !== b.flowId) return (Number(b.startedAt) || 0) >= (Number(a.startedAt) || 0) ? b : a;
  return (MCP_FLOW_RANK[a.status] ?? 0) > (MCP_FLOW_RANK[b.status] ?? 0) ? { ...b, status: a.status, error: a.error ?? b.error } : b;
}

/** `{ unit, n }` for a future instant (minutes under an hour, hours under two days, else days); null when past. */
function mcpUntil(at, now) {
  const ms = Number(at) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return { unit: 'min', n: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { unit: 'hour', n: hours };
  return { unit: 'day', n: Math.round(hours / 24) };
}

/**
 * Card / detail presentation of a server: dot tone, label key, the error to
 * summarize, and `kind` for the detail's status area. `extra` carries the
 * Host's supervisor and authorization state (`host`), whether the entry sends
 * its OAuth token (`oauth`), the authorization flow in progress (`flow`), and
 * whether a just-finished flow still explains the current status (`flowDone`).
 * Config `enabled: false` wins over a stale runtime status.
 */
function mcpStatusInfo(status, enabled, runtimeStatus, extra = {}) {
  if (!enabled) return { tone: 'idle', label: 'mcp_stDisabled', kind: 'disabled' };
  const host = mcpObject(extra.host);
  const state = mcpIsObject(status) ? status.state : null;
  const flowStatus = mcpObject(extra.flow).status;
  if (state !== 'connected' && (flowStatus === 'pending' || flowStatus === 'exchanging')) {
    return { tone: 'busy', label: 'mcp_stAuthWaiting', kind: 'auth-flow' };
  }
  if (extra.flowDone && state !== 'connected' && state !== 'connecting') {
    return { tone: 'busy', label: 'mcp_stAuthDone', kind: 'auth-done' };
  }
  if (!mcpIsObject(status)) return { tone: 'idle', label: runtimeStatus === 'ready' ? 'mcp_stUnknown' : 'mcp_stLoading', kind: 'unknown' };
  const auth = (error) => ({ tone: 'warn', label: 'mcp_stNeedsAuth', kind: 'auth', error: error || null, errorTone: 'warn', block: true });
  switch (state) {
    case 'connected':
      return { tone: 'success', label: 'mcp_stConnected', kind: 'connected', count: Number(status.toolCount) || 0 };
    case 'connecting':
      return { tone: 'busy', label: 'mcp_stConnecting', kind: 'connecting' };
    case 'disabled':
      // Just switched on: the runtime has not caught up yet.
      return { tone: 'busy', label: 'mcp_stConnecting', kind: 'connecting' };
    case 'reconnecting':
      return { tone: 'warn', label: 'mcp_stRetrying', kind: 'dsh-retrying', values: { attempt: status.attempt, max: status.maxAttempts }, nextAt: status.nextRetryAtMs, error: mcpStr(status.lastError) || null, errorTone: 'warn', block: true, summary: true };
    case 'waiting-credentials':
      if (extra.oauth) return auth(mcpStr(status.lastError));
      return { tone: 'warn', label: 'mcp_stCredentials', kind: 'credentials', error: mcpStr(status.lastError) || null, errorTone: 'warn', block: true, summary: true };
    case 'failed': {
      const lastError = mcpStr(status.lastError);
      if (status.reason === 'reconnect-disabled' || status.reason === 'gave-up') {
        const retry = mcpIsObject(host.retry) ? host.retry : null;
        if (status.reason === 'reconnect-disabled' && retry) {
          return {
            tone: 'warn', label: 'mcp_stAutoRetry', kind: 'retrying', values: { attempt: retry.attempt, max: retry.max },
            nextAt: retry.nextAt, error: lastError || mcpStr(retry.lastError) || null, errorTone: 'warn', block: true, summary: true,
          };
        }
        const authFailure = mcpIsObject(host.authFailure) ? mcpStr(host.authFailure.lastError) : '';
        if (mcpIsAuthError(lastError) || (!lastError && mcpIsAuthError(authFailure))) return auth(lastError || authFailure);
        if (status.reason === 'reconnect-disabled') {
          const gaveUp = mcpIsObject(host.gaveUp) ? host.gaveUp : null;
          if (gaveUp) {
            return { tone: 'error', label: 'mcp_stReconnectFailed', kind: 'gave-up', attempts: Number(gaveUp.attempts) || 0, error: lastError || mcpStr(gaveUp.lastError) || null, errorTone: 'error', block: true, summary: true };
          }
          return { tone: 'error', label: 'mcp_stFailed', kind: 'failed', error: lastError || null, errorTone: 'error', block: true, summary: true };
        }
      }
      let error = lastError || null;
      let errorKey = null;
      if (status.reason === 'cleanup') {
        error = mcpStr(status.result?.cleanupError) || null;
        errorKey = 'mcp_errCleanup';
      } else if (status.reason === 'gave-up') errorKey = 'mcp_errGaveUp';
      else if (status.reason === 'unclosed-generation') errorKey = 'mcp_errUnclosed';
      return { tone: 'error', label: 'mcp_stFailed', kind: 'dsh-failed', error, errorKey, errorTone: 'error', block: true, summary: true };
    }
    case 'closed':
      return { tone: 'idle', label: 'mcp_stClosed', kind: 'closed', error: mcpStr(status.result?.cleanupError) || null, closed: true };
    default:
      return { tone: 'idle', label: 'mcp_stUnknown', kind: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** Resolve a Remote stream open (handle, promise of a handle, or RemoteResult) to an async iterable. */
async function mcpOpenStream(opened) {
  let handle = opened;
  const iterable = (value) => value !== null && value !== undefined && typeof value[Symbol.asyncIterator] === 'function';
  if (!iterable(handle) && handle && typeof handle.then === 'function') handle = await handle;
  if (!iterable(handle) && mcpIsObject(handle) && 'ok' in handle) handle = unwrapRemote(handle);
  if (!iterable(handle)) throw new CallError('remote', 'The status stream is unavailable');
  return handle;
}

function mcpSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/**
 * Joins the `mcp-manager` settings form, the manager's status stream, the
 * credential store, and this plugin's `mcp-tools` route onto one store. View
 * state and drafts live here so closing Settings keeps them (typed secrets are
 * scrubbed when the page unmounts).
 */
function createMcpController(ctx, t) {
  const form = ctx.configForms.get(MCP_FORM_NS);
  const rpc = createRpc(ctx, API_MCP);
  const manager = () => ctx.remote.mcpManager;
  const credentials = () => ctx.remote.credentials;
  let disposed = false;
  const ui = { view: { kind: 'list' }, opener: null, query: '', paste: '', draft: null, batch: null, notice: null, confirm: null, justAdded: null };
  const runtime = { status: 'idle', list: null, error: null };
  let credInfo = {};
  let tools = {};
  let probes = {};
  const probeAborts = new Map();
  const busy = {};
  const pendingEnabled = {};
  const pendingTimers = new Map();
  let watchers = 0;
  let streamAbort = null;
  let streamHandle = null;
  let saveSeq = 0;
  // Host supervisor / authorization state from the `mcp-state` long-poll.
  const hostState = { status: 'idle', version: null, servers: {} };
  let poll = null;
  // `mcp-auth-check` results by URL; the add form's debounce timer.
  let authChecks = {};
  let checkTimer = null;
  let checkUrl = null;
  // Per-server authorization UI: { busy, error, clientRequired, clientId, clientSecret, callbackUrl, flow }.
  let authUi = {};
  // Templates `mcp-auth-start` returned, and the runtime status seen when a flow finished.
  const oauthTemplates = {};
  const flowDone = {};

  const readConfig = () => {
    const snapshot = form?.getSnapshot?.() ?? { status: 'unavailable' };
    return {
      status: snapshot.status ?? 'unavailable',
      writable: snapshot.writable !== false,
      servers: mcpObject(mcpObject(snapshot.value).servers),
      base: mcpObject(mcpObject(snapshot.base).servers),
      user: mcpObject(mcpObject(snapshot.user).servers),
    };
  };
  const originOf = (cfg, name) => {
    const inBase = mcpHasOwn(cfg.base, name);
    const inUser = mcpHasOwn(cfg.user, name);
    if (inBase) return inUser ? 'overridden' : 'inherited';
    return mcpHasOwn(cfg.servers, name) ? 'user' : 'plugin';
  };
  const configuredNames = (cfg) => new Set([...Object.keys(cfg.servers), ...Object.keys(cfg.base), ...Object.keys(cfg.user)]);
  const takenNames = (cfg = readConfig()) => {
    const names = configuredNames(cfg);
    for (const item of runtime.list ?? []) names.add(item.name);
    return names;
  };
  const registeredNames = (cfg) => {
    const configured = configuredNames(cfg);
    return new Set((runtime.list ?? []).map((item) => item.name).filter((name) => !configured.has(name)));
  };

  const hostOf = (name) => mcpObject(hostState.servers[name]);
  const effectiveFlow = (name) => {
    const flow = mcpMergeFlow(authUi[name]?.flow, hostOf(name).flow);
    return flow && typeof flow.flowId === 'string' ? flow : null;
  };
  /** A finished flow explains the status only until the runtime reports something new. */
  const flowJustDone = (name, flow, status) => {
    const mark = flowDone[name];
    return Boolean(flow && flow.status === 'done' && mark && mark.flowId === flow.flowId && mark.status === JSON.stringify(status ?? null));
  };
  /** How a server that needs authorization can get it: oauth (授权 button), token (header hint), readonly. */
  const authModeOf = (row, entry, writable) => {
    if (row.origin === 'plugin' || row.readOnly || row.transport !== 'streamable-http' || !writable) return { mode: 'readonly' };
    if (row.oauth || mcpIsObject(row.host.auth)) return { mode: 'oauth' };
    const check = authChecks[mcpStr(entry?.url).trim()];
    const kind = check?.status === 'done' ? check.result?.kind : null;
    if (kind === 'token' || kind === 'forbidden') return { mode: 'token' };
    return { mode: 'oauth', checking: check?.status === 'loading' };
  };

  const serverRows = (cfg) => {
    const statusByName = new Map((runtime.list ?? []).map((item) => [item.name, item.status]));
    const row = (name, origin, entry) => {
      const transport = entry ? (entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio') : null;
      const configEnabled = entry ? entry.enabled !== false : true;
      const status = statusByName.get(name) ?? null;
      const host = hostOf(name);
      const flow = effectiveFlow(name);
      const out = {
        name,
        origin,
        transport,
        url: transport === 'streamable-http' ? mcpStr(entry?.url).trim() : '',
        summary: entry ? mcpServerSummary({ transport, command: entry.command, args: entry.args, url: entry.url }) : '',
        enabled: mcpHasOwn(pendingEnabled, name) ? pendingEnabled[name] : configEnabled,
        pending: mcpHasOwn(pendingEnabled, name),
        status,
        busy: busy[name] ?? null,
        readOnly: origin === 'plugin' || mcpHasExpression(entry),
        oauth: mcpEntryUsesOAuth(name, entry, oauthTemplates[name]),
        host,
        flow,
      };
      out.info = mcpStatusInfo(status, out.enabled, runtime.status, { host, oauth: out.oauth, flow, flowDone: flowJustDone(name, flow, status) });
      const auth = authModeOf(out, entry, cfg.writable && cfg.status === 'ready');
      out.authMode = auth.mode;
      out.authChecking = Boolean(auth.checking);
      return out;
    };
    const rows = [];
    for (const [name, entry] of Object.entries(cfg.servers)) {
      if (mcpIsObject(entry)) rows.push(row(name, originOf(cfg, name), entry));
    }
    for (const item of runtime.list ?? []) {
      if (!mcpHasOwn(cfg.servers, item.name)) rows.push(row(item.name, 'plugin', null));
    }
    return rows;
  };

  /** What the add form shows under its URL and whether saving should start authorization. */
  const draftAuthView = () => {
    const draft = ui.draft;
    if (!draft || draft.mode !== 'add' || draft.transport !== 'streamable-http') return null;
    const url = draft.url.trim();
    if (!mcpIsUrl(url)) return null;
    const check = authChecks[url] ?? (checkUrl === url ? { status: 'loading' } : null);
    if (!check) return null;
    const result = mcpObject(check.result);
    const headerKey = mcpAuthHeaderKey(Object.fromEntries(draft.headers.filter((row) => row.key.trim() && (row.value || row.ref)).map((row) => [row.key.trim(), true])));
    return {
      status: check.status,
      kind: check.status === 'done' ? result.kind : check.status === 'error' ? 'unreachable' : null,
      issuer: mcpUrlHost(mcpStr(result.issuer)) || mcpStr(result.issuer),
      error: check.status === 'error' ? check.error : mcpStr(result.error),
      authorizeOnAdd: check.status === 'done' && result.kind === 'oauth' && !headerKey,
    };
  };

  const authView = () => {
    const out = {};
    const names = new Set([...Object.keys(authUi), ...Object.keys(hostState.servers)]);
    for (const name of names) {
      const { flow: _local, ...rest } = authUi[name] ?? {};
      out[name] = { busy: null, error: null, clientRequired: false, clientId: '', clientSecret: '', callbackUrl: '', ...rest, flow: effectiveFlow(name) };
    }
    return out;
  };

  const project = () => {
    const cfg = readConfig();
    return {
      view: ui.view,
      query: ui.query,
      paste: ui.paste,
      notice: ui.notice,
      confirm: ui.confirm,
      justAdded: ui.justAdded,
      config: { status: cfg.status, writable: cfg.writable },
      runtime: { status: runtime.status, error: runtime.error },
      servers: serverRows(cfg),
      draft: ui.draft === null ? null : { ...ui.draft, dirty: mcpDraftSignature(ui.draft) !== ui.draft.baseline, auth: draftAuthView() },
      batch: ui.batch,
      credInfo,
      tools,
      probes,
      auth: authView(),
      authChecks,
      hostState: { status: hostState.status, version: hostState.version, servers: hostState.servers },
    };
  };
  const store = createStore(project());
  const publish = () => {
    if (disposed) return;
    scheduleDraftCheck();
    store.set(project());
    ensureAuthChecks();
  };

  const failure = (error) => ({ key: 'mcp_errAction', values: { reason: errorText(error, t) } });
  const refused = { key: 'mcp_errRefused' };

  // -- Runtime status stream (open only while the page is mounted) ----------

  const startStream = () => {
    if (streamAbort || disposed) return;
    const abort = new AbortController();
    streamAbort = abort;
    if (runtime.status === 'idle') runtime.status = 'loading';
    void (async () => {
      let delay = 500;
      while (!abort.signal.aborted && !disposed) {
        let handle = null;
        try {
          handle = await mcpOpenStream(manager().watch(abort.signal));
          if (abort.signal.aborted) break;
          streamHandle = handle;
          for await (const list of handle) {
            if (abort.signal.aborted) break;
            delay = 500;
            runtime.list = Array.isArray(list) ? list.filter((item) => mcpIsObject(item) && typeof item.name === 'string') : [];
            runtime.status = 'ready';
            runtime.error = null;
            publish();
          }
        } catch (error) {
          if (abort.signal.aborted || disposed) break;
          runtime.error = errorText(error, t);
          if (runtime.status !== 'ready') runtime.status = 'error';
          publish();
        } finally {
          if (streamHandle === handle) streamHandle = null;
          try { handle?.dispose?.(); } catch { /* already closed */ }
        }
        if (abort.signal.aborted || disposed) break;
        await mcpSleep(delay, abort.signal);
        delay = Math.min(delay * 2, 10000);
      }
    })();
  };
  const stopStream = () => {
    streamAbort?.abort();
    streamAbort = null;
    try { streamHandle?.dispose?.(); } catch { /* already closed */ }
    streamHandle = null;
  };

  // -- Host supervisor / authorization state (`mcp-state` long-poll) ---------

  /** Remember the runtime status at the moment a flow finished, and drop local flows the Host has caught up with. */
  const noteFlows = (initial) => {
    const statusByName = new Map((runtime.list ?? []).map((item) => [item.name, item.status]));
    for (const [name, server] of Object.entries(hostState.servers)) {
      const flow = mcpObject(mcpObject(server).flow);
      if (flow.status === 'done' && flowDone[name]?.flowId !== flow.flowId) {
        // A flow that had already finished before this page looked explains nothing about the current status.
        flowDone[name] = { flowId: flow.flowId, status: initial ? null : JSON.stringify(statusByName.get(name) ?? null) };
      }
    }
    for (const [name, state] of Object.entries(authUi)) {
      const local = state.flow;
      if (!local) continue;
      const remote = mcpObject(hostOf(name).flow);
      const caughtUp = remote.flowId === local.flowId && (MCP_FLOW_RANK[remote.status] ?? 0) >= (MCP_FLOW_RANK[local.status] ?? 0);
      const stale = Date.now() - (Number(local.startedAt) || 0) > 10 * 60 * 1000;
      if (caughtUp || stale) authUi = { ...authUi, [name]: { ...state, flow: null } };
      if (remote.flowId === local.flowId && remote.status === 'done') authUi = { ...authUi, [name]: { ...authUi[name], clientRequired: false, clientSecret: '', callbackUrl: '', error: null } };
    }
  };

  const startPoll = () => {
    if (poll || disposed) return;
    const token = { abort: new AbortController() };
    poll = token;
    if (hostState.status === 'idle') hostState.status = 'loading';
    void (async () => {
      let since;
      while (poll === token && !disposed) {
        const began = Date.now();
        try {
          const value = await rpc('state', since === undefined ? {} : { since });
          if (poll !== token || disposed) break;
          const version = Number(value?.version);
          const changed = since === undefined || version !== hostState.version;
          hostState.status = 'ready';
          if (changed) {
            hostState.version = Number.isFinite(version) ? version : null;
            hostState.servers = mcpObject(value?.servers);
            noteFlows(since === undefined);
            publish();
          }
          since = Number.isFinite(version) ? version : undefined;
          // A Host that answers at once without a change would make this loop spin.
          if (!changed && Date.now() - began < 1000) await mcpSleep(MCP_STATE_RETRY_MS, token.abort.signal);
          else if (since === undefined) await mcpSleep(MCP_STATE_RETRY_MS, token.abort.signal);
        } catch {
          if (poll !== token || disposed) break;
          if (hostState.status !== 'ready') hostState.status = 'error';
          await mcpSleep(MCP_STATE_RETRY_MS, token.abort.signal);
        }
      }
    })();
  };
  const stopPoll = () => {
    poll?.abort.abort();
    poll = null;
  };

  // -- Authorization ----------------------------------------------------------

  const setAuth = (name, patch) => {
    authUi = { ...authUi, [name]: { ...(authUi[name] ?? {}), ...patch } };
    publish();
  };

  /** `mcp-auth-check` once per URL (the Host caches for a minute too). */
  const checkAuth = async (url, force) => {
    if (!mcpIsUrl(url)) return;
    const current = authChecks[url];
    if (current && (current.status === 'loading' || (!force && current.status === 'done'))) return;
    authChecks = { ...authChecks, [url]: { status: 'loading' } };
    if (checkUrl === url) checkUrl = null;
    publish();
    let entry;
    try {
      entry = { status: 'done', result: mcpObject(await rpc('auth-check', { url })) };
    } catch (error) {
      entry = { status: 'error', error: errorText(error, t) };
    }
    if (disposed) return;
    authChecks = { ...authChecks, [url]: entry };
    publish();
  };

  /** Servers stopped on an authorization failure without OAuth in their entry: find out whether OAuth is on offer. */
  function ensureAuthChecks() {
    if (disposed || watchers === 0) return;
    for (const row of store.getSnapshot().servers) {
      if (row.info.kind !== 'auth' || row.authMode !== 'oauth' || row.oauth || mcpIsObject(row.host.auth) || !row.url) continue;
      if (!authChecks[row.url]) void checkAuth(row.url);
    }
  }

  /** Debounced check of the add form's URL. */
  const scheduleDraftCheck = () => {
    const draft = ui.draft;
    const url = draft && draft.mode === 'add' && draft.transport === 'streamable-http' ? draft.url.trim() : '';
    const wanted = mcpIsUrl(url) && !authChecks[url] ? url : null;
    if (wanted === checkUrl) return;
    clearTimeout(checkTimer);
    checkTimer = null;
    checkUrl = wanted;
    if (wanted) {
      checkTimer = setTimeout(() => {
        checkTimer = null;
        void checkAuth(wanted);
      }, MCP_AUTH_CHECK_DEBOUNCE_MS);
    }
  };

  /** Show the OAuth header in an open edit draft that has unsaved changes, so saving it keeps the header. */
  const injectOAuthRow = (name, template) => {
    const draft = ui.draft;
    if (!draft || draft.mode !== 'edit' || draft.target !== name || draft.transport !== 'streamable-http') return;
    const existing = draft.headers.find((row) => row.key.toLowerCase() === 'authorization');
    const oauthRow = { ...mcpRow(existing?.key ?? 'Authorization', template), oauth: true, locked: Boolean(existing?.locked) };
    ui.draft = { ...draft, headers: existing ? draft.headers.map((row) => (row === existing ? { ...oauthRow, id: row.id } : row)) : [...draft.headers, oauthRow] };
  };

  /**
   * 授权: start the flow, open the authorization page right away, then make the
   * entry send the token (header and reconnect policy in one write).
   */
  const startAuth = async (name, options = {}) => {
    const state = authUi[name] ?? {};
    if (state.busy === 'start' || state.busy === 'header') return;
    const entry = readConfig().servers[name];
    // Right after an add the snapshot may not carry the entry yet; the caller passes its URL.
    const url = options.url ?? (mcpIsObject(entry) && entry.transport === 'streamable-http' ? mcpStr(entry.url).trim() : '');
    if (!url) return;
    const clientId = mcpStr(state.clientId).trim();
    const clientSecret = mcpStr(state.clientSecret);
    if (state.clientRequired && !clientId) {
      setAuth(name, { error: { key: 'mcp_errClientIdRequired' } });
      return;
    }
    if (options.fromCard) ui.notice = null;
    setAuth(name, { busy: 'start', error: null });
    let value;
    try {
      value = mcpObject(await rpc('auth-start', {
        server: name, url, ...(clientId ? { clientId } : {}), ...(clientId && clientSecret ? { clientSecret } : {}),
      }));
    } catch (error) {
      if (disposed) return;
      if (error?.code === 'oauth-client-required') {
        setAuth(name, { busy: null, clientRequired: true, error: null });
        // The client ID fields live in the detail view.
        if (options.fromCard) openDetail(name);
        return;
      }
      const problem = { key: 'mcp_authFlowError', values: { reason: errorText(error, t) } };
      if (options.fromCard) ui.notice = { tone: 'error', ...problem };
      setAuth(name, { busy: null, error: problem });
      return;
    }
    if (disposed) return;
    const authUrl = mcpStr(value.authUrl);
    if (authUrl) {
      try { window.open(authUrl, '_blank', 'noopener'); } catch { /* blocked: the panel's link opens it */ }
    }
    const template = mcpStr(value.template) || mcpOAuthTemplate(name);
    oauthTemplates[name] = template;
    const flow = { flowId: mcpStr(value.flowId), authUrl, redirectUri: mcpStr(value.redirectUri), status: 'pending', startedAt: Date.now() };
    setAuth(name, { busy: 'header', flow, clientRequired: false, clientSecret: '', callbackUrl: '', error: null });
    const ops = options.writtenTemplate === template ? [] : mcpAuthHeaderOps(name, readConfig().servers[name], template);
    let problem = null;
    if (ops.length) {
      try {
        if (!(await form.mutate(ops))) problem = refused;
      } catch (error) {
        problem = { key: 'mcp_errSave', values: { reason: errorText(error, t) } };
      }
    }
    if (disposed) return;
    if (problem) {
      // Without the header the token would never be used.
      void rpc('auth-cancel', { flowId: flow.flowId }).catch(() => {});
      setAuth(name, { busy: null, flow: { ...flow, status: 'cancelled' }, error: problem });
      return;
    }
    if (ops.length) injectOAuthRow(name, template);
    setAuth(name, { busy: null });
  };

  const completeAuth = async (name) => {
    const state = authUi[name] ?? {};
    const flow = effectiveFlow(name);
    const callbackUrl = mcpStr(state.callbackUrl).trim();
    if (!flow || state.busy) return;
    if (!callbackUrl) {
      setAuth(name, { error: { key: 'mcp_errCallbackRequired' } });
      return;
    }
    setAuth(name, { busy: 'complete', error: null });
    try {
      await rpc('auth-complete', { flowId: flow.flowId, callbackUrl });
      if (disposed) return;
      setAuth(name, { busy: null, callbackUrl: '', flow: { ...flow, status: 'done' } });
      noteFlowDone(name, flow.flowId);
    } catch (error) {
      if (disposed) return;
      setAuth(name, { busy: null, error: { key: 'mcp_authFlowError', values: { reason: errorText(error, t) } } });
    }
  };
  const noteFlowDone = (name, flowId) => {
    const status = (runtime.list ?? []).find((item) => item.name === name)?.status ?? null;
    flowDone[name] = { flowId, status: JSON.stringify(status) };
    publish();
  };

  const cancelAuth = async (name) => {
    const flow = effectiveFlow(name);
    const state = authUi[name] ?? {};
    if (state.busy) return;
    if (!flow || (flow.status !== 'pending' && flow.status !== 'exchanging')) {
      setAuth(name, { clientRequired: false, clientSecret: '', error: null });
      return;
    }
    setAuth(name, { busy: 'cancel', error: null, flow: { ...flow, status: 'cancelled' }, callbackUrl: '' });
    try {
      await rpc('auth-cancel', { flowId: flow.flowId });
    } catch { /* the flow expires on its own */ }
    if (disposed) return;
    setAuth(name, { busy: null });
  };

  /** 退出授权: revoke and forget the grant; the header stays, so the server needs authorization again. */
  const forgetAuth = async (name) => {
    if (authUi[name]?.busy) return;
    setAuth(name, { busy: 'forget', error: null });
    let problem = null;
    try {
      await rpc('auth-forget', { server: name });
    } catch (error) {
      problem = { key: 'mcp_authFlowError', values: { reason: errorText(error, t) } };
    }
    if (disposed) return;
    ui.notice = problem ? { tone: 'error', ...problem } : { tone: 'success', key: 'mcp_signedOut', values: { name } };
    setAuth(name, { busy: null });
  };

  // -- Credentials ------------------------------------------------------------

  const describeDraftRefs = () => {
    const draft = ui.draft;
    if (!draft) return;
    const refs = [...new Set([...draft.env, ...draft.headers].filter((row) => row.secret && row.ref && MCP_REF_RE.test(row.ref)).map((row) => row.ref))];
    if (!refs.length) return;
    void (async () => {
      try {
        const value = unwrapRemote(await credentials().describe(refs.slice(0, 64)));
        if (disposed) return;
        credInfo = { ...credInfo, ...mcpObject(value) };
        publish();
      } catch { /* placeholders fall back to "leave blank to keep" */ }
    })();
  };
  const unsetQuietly = async (refs) => {
    if (!refs.length) return;
    for (const ref of refs) {
      try { unwrapRemote(await credentials().unset(ref)); } catch { /* best effort: a leftover secret is harmless */ }
    }
    const next = { ...credInfo };
    for (const ref of refs) delete next[ref];
    credInfo = next;
  };
  /** Store each typed secret; returns the references this save created (for rollback). */
  const setSecrets = async (sets) => {
    if (!sets.length) return [];
    let before = null;
    try { before = mcpObject(unwrapRemote(await credentials().describe(sets.map((item) => item.ref).slice(0, 64)))); } catch { before = null; }
    const created = [];
    for (const item of sets) {
      try {
        unwrapRemote(await credentials().set(item.ref, item.value));
      } catch (error) {
        await unsetQuietly(created);
        throw error;
      }
      const known = before ? before[item.ref] : credInfo[item.ref];
      if (mcpObject(known).configured !== true) created.push(item.ref);
    }
    return created;
  };

  // -- Drafts -------------------------------------------------------------------

  const editDraftFor = (name) => {
    const cfg = readConfig();
    const entry = cfg.servers[name];
    if (!mcpIsObject(entry) || mcpHasExpression(entry)) return null;
    return mcpDraftFromEntry(name, entry, originOf(cfg, name), cfg.base[name], oauthTemplates[name]);
  };
  const isDirty = (draft) => mcpDraftSignature(draft) !== draft.baseline;

  /** Follow config changes in the open detail unless the user has unsaved edits. */
  const syncDraft = () => {
    const draft = ui.draft;
    if (ui.view.kind === 'detail') {
      const name = ui.view.name;
      if (!draft || draft.mode !== 'edit' || draft.target !== name) {
        ui.draft = editDraftFor(name);
        describeDraftRefs();
        return;
      }
    }
    if (!draft || draft.mode !== 'edit' || draft.saving || isDirty(draft)) return;
    const fresh = editDraftFor(draft.target);
    if (!fresh || (fresh.baseline === draft.baseline && fresh.origin === draft.origin)) return;
    ui.draft = { ...fresh, advancedOpen: draft.advancedOpen, savedAt: draft.savedAt };
    describeDraftRefs();
  };

  const prunePending = () => {
    const cfg = readConfig();
    for (const name of Object.keys(pendingEnabled)) {
      const entry = cfg.servers[name];
      if (mcpIsObject(entry) && (entry.enabled !== false) === pendingEnabled[name]) {
        delete pendingEnabled[name];
        clearTimeout(pendingTimers.get(name));
        pendingTimers.delete(name);
      }
    }
  };

  const offForm = form?.subscribe?.(() => {
    prunePending();
    syncDraft();
    publish();
  });

  const editDraft = (change) => {
    if (!ui.draft || ui.draft.saving) return;
    const next = { ...ui.draft, saveError: null };
    change(next);
    ui.draft = next;
    publish();
  };
  const dropErrors = (errors, prefix) => Object.fromEntries(Object.entries(errors).filter(([field]) => field !== prefix && !field.startsWith(`${prefix}:`)));
  const mergeRows = (rows, pairs, placeholders = {}) => {
    const next = [...rows];
    for (const [key, raw] of pairs) {
      const mapped = mcpMapPlaceholder(raw);
      const example = mapped.placeholder ? mapped.example : placeholders[key];
      const row = mcpRow(key, mapped.value, { secret: example !== undefined || mcpIsSecretKey(key), example });
      const index = next.findIndex((item) => item.key === key);
      if (index >= 0) next[index] = { ...row, locked: next[index].locked };
      else next.push(row);
    }
    return next;
  };
  /** Apply one recognized server to the open draft (paste into the command or URL box). */
  /** False when the draft cannot take this server (an inherited entry keeps its transport). */
  const canApply = (server) => {
    const d = ui.draft;
    if (!d || d.saving) return false;
    const locked = d.origin === 'inherited' || d.origin === 'overridden';
    return !(locked && d.transport !== server.transport);
  };
  const applyParsed = (server) => {
    editDraft((d) => {
      const switched = d.transport !== server.transport;
      d.transport = server.transport;
      if (server.transport === 'stdio') d.commandLine = mcpServerSummary(server);
      else d.url = server.url;
      const prefixed = (kind) => Object.fromEntries(Object.entries(mcpObject(server.placeholders)).filter(([marker]) => marker.startsWith(`${kind}:`)).map(([marker, example]) => [marker.slice(kind.length + 1), example]));
      const envPairs = Object.entries(server.env).map(([key, value]) => [key, mcpHasOwn(prefixed('env'), key) ? '' : value]);
      const headerPairs = Object.entries(server.headers).map(([key, value]) => [key, mcpHasOwn(prefixed('headers'), key) ? '' : value]);
      if (envPairs.length) d.env = mergeRows(d.env, envPairs, prefixed('env'));
      if (headerPairs.length) d.headers = mergeRows(d.headers, headerPairs, prefixed('headers'));
      if (server.cwd) d.cwd = server.cwd;
      if (d.mode === 'add' && !d.name) d.name = server.name;
      d.errors = dropErrors(dropErrors(d.errors, 'command'), 'url');
      if (switched) d.focus = server.transport === 'stdio' ? 'command' : 'url';
    });
  };

  const openParsed = (result) => {
    if (result.servers.length === 1) {
      const server = result.servers[0];
      ui.draft = mcpDraftFromParsed(server, [...new Set([...(result.warnings ?? []), ...server.warnings])]);
      ui.view = { kind: 'form' };
    } else {
      const cfg = readConfig();
      const configured = configuredNames(cfg);
      const registered = registeredNames(cfg);
      ui.batch = {
        items: result.servers.map((server, index) => {
          const problem = mcpBatchProblem(server, registered);
          return { key: String(index), server, summary: mcpServerSummary(server), include: !problem, exists: configured.has(server.name), mode: 'skip', problem };
        }),
        warnings: result.warnings ?? [],
        saving: false,
        error: null,
      };
      ui.view = { kind: 'batch' };
    }
    ui.paste = '';
    ui.notice = null;
    if (!ui.opener) ui.opener = MCP_ADD_OPENER;
    describeDraftRefs();
    publish();
  };

  // -- Writes -----------------------------------------------------------------

  const submitDraft = async () => {
    const draft = ui.draft;
    if (!draft || draft.saving) return;
    const cfg = readConfig();
    if (cfg.status !== 'ready' || !cfg.writable) {
      ui.draft = { ...draft, saveError: { key: 'mcp_readOnlyConfig' } };
      publish();
      return;
    }
    const name = draft.mode === 'add' ? draft.name : draft.target;
    const taken = takenNames(cfg);
    if (draft.mode === 'edit') taken.delete(name);
    const errors = mcpValidateDraft(draft, { taken });
    const fields = Object.keys(errors);
    if (fields.length) {
      ui.draft = { ...draft, errors, focus: fields[0], saveError: null, advancedOpen: draft.advancedOpen || fields.some((field) => MCP_ADVANCED_FIELDS.has(field)) };
      publish();
      return;
    }
    const authorizeOnAdd = draft.mode === 'add' && Boolean(draftAuthView()?.authorizeOnAdd);
    const seq = ++saveSeq;
    ui.draft = { ...draft, saving: true, saveError: null, errors: {} };
    publish();
    const current = cfg.servers[name];
    const userRaw = cfg.user[name];
    const baseRaw = cfg.base[name];
    const others = mcpConfigRefs(cfg.servers, name);
    const plan = mcpPlanSecrets(draft, name, { credInfo, reserved: others });
    let created = [];
    let outcome = null;
    let next = null;
    try {
      created = await setSecrets(plan.sets);
    } catch (error) {
      outcome = { key: 'mcp_errCredential', values: { reason: errorText(error, t) } };
    }
    if (!outcome) {
      next = mcpDraftToEntry(draft, plan.templates);
      if (authorizeOnAdd) {
        // The server needs OAuth: write the token header now, start authorization once it is saved.
        const headers = Object.fromEntries(Object.entries(next.headers).filter(([key]) => key.toLowerCase() !== 'authorization'));
        next.headers = { ...headers, Authorization: mcpOAuthTemplate(name) };
      }
      const user = mcpObject(userRaw);
      const carry = draft.mode === 'add'
        ? { enabled: draft.enabled }
        : { enabled: user.enabled, closeTimeoutMs: user.closeTimeoutMs, reconnect: user.reconnect };
      const ops = mcpEntryOps(name, draft.mode === 'add' ? 'new' : draft.origin, current, userRaw, baseRaw, next, carry);
      if (ops.length) {
        try {
          if (!(await form.mutate(ops))) outcome = refused;
        } catch (error) {
          outcome = { key: 'mcp_errSave', values: { reason: errorText(error, t) } };
        }
        if (outcome) await unsetQuietly(created);
      }
    }
    if (disposed) return;
    if (outcome) {
      if (ui.draft && seq === saveSeq) ui.draft = { ...ui.draft, saving: false, saveError: outcome };
      publish();
      return;
    }
    if (draft.mode === 'edit') {
      const prefix = mcpRefPrefix(name);
      const after = mcpEntryRefs(next);
      const baseRefs = mcpEntryRefs(baseRaw);
      void unsetQuietly([...mcpEntryRefs(current)].filter((ref) => ref.startsWith(prefix) && !after.has(ref) && !baseRefs.has(ref) && !others.has(ref)));
      if (ui.draft && ui.draft.target === name) {
        // Prefer the snapshot's view (origin and locked keys change once an override exists);
        // until the snapshot carries the write, keep the settled draft and let syncDraft follow.
        const settled = mcpSettleDraft(ui.draft, plan.templates);
        const fresh = editDraftFor(name);
        ui.draft = fresh && fresh.baseline === settled.baseline
          ? { ...fresh, advancedOpen: settled.advancedOpen, savedAt: settled.savedAt }
          : settled;
      }
    } else {
      ui.paste = '';
      ui.view = { kind: 'detail', name };
      ui.opener = name;
      ui.notice = null;
      ui.justAdded = name;
      // The snapshot may not carry the new entry yet; syncDraft fills the draft in when it does.
      ui.draft = editDraftFor(name);
    }
    describeDraftRefs();
    publish();
    if (authorizeOnAdd) void startAuth(name, { url: next.url, writtenTemplate: next.headers.Authorization });
  };

  const toggleEnabled = async (name, next) => {
    if (mcpHasOwn(pendingEnabled, name)) return;
    pendingEnabled[name] = next;
    ui.notice = null;
    publish();
    let problem = null;
    try {
      if (!(await form.mutate([{ op: 'set', path: ['servers', name, 'enabled'], value: next }]))) problem = refused;
    } catch (error) {
      problem = failure(error);
    }
    if (disposed) return;
    if (problem) {
      delete pendingEnabled[name];
      ui.notice = { tone: 'error', ...problem };
    } else {
      prunePending();
      // Keep the optimistic value until the snapshot catches up, but never forever.
      if (mcpHasOwn(pendingEnabled, name)) {
        pendingTimers.set(name, setTimeout(() => {
          pendingTimers.delete(name);
          delete pendingEnabled[name];
          publish();
        }, 6000));
      }
    }
    publish();
  };

  /** 重试 / 立即重试: the Host route resets its reconnect supervision, then restarts (§4). */
  const restart = async (name) => {
    if (busy[name]) return;
    busy[name] = 'restart';
    ui.notice = null;
    publish();
    try {
      await rpc('retry', { server: name });
    } catch (error) {
      ui.notice = { tone: 'error', ...failure(error) };
    }
    delete busy[name];
    publish();
  };

  const probe = async (name) => {
    probeAborts.get(name)?.abort();
    const abort = new AbortController();
    probeAborts.set(name, abort);
    probes = { ...probes, [name]: { status: 'running' } };
    publish();
    let entry;
    try {
      entry = { status: 'done', result: unwrapRemote(await manager().probe(name, abort.signal)) };
    } catch (error) {
      entry = { status: 'error', error: errorText(error, t) };
    }
    if (disposed || probeAborts.get(name) !== abort) return;
    probeAborts.delete(name);
    probes = { ...probes, [name]: entry };
    publish();
  };

  const loadTools = async (name, key, force) => {
    const current = tools[name];
    if (!force && current && current.key === key && current.status !== 'error') return;
    tools = { ...tools, [name]: { status: 'loading', items: current?.key === key ? current.items : [], key } };
    publish();
    let entry;
    try {
      const value = await rpc('tools', { server: name });
      const items = Array.isArray(value?.tools) ? value.tools.filter((tool) => mcpIsObject(tool) && typeof tool.name === 'string') : [];
      entry = { status: 'ready', items, key };
    } catch (error) {
      entry = { status: 'error', items: [], error: errorText(error, t), key };
    }
    if (disposed || tools[name]?.key !== key) return;
    tools = { ...tools, [name]: entry };
    publish();
  };

  const restoreDefault = async (name) => {
    if (busy[name]) return;
    const cfg = readConfig();
    busy[name] = 'restore';
    ui.notice = null;
    publish();
    let problem = null;
    try {
      if (!(await form.mutate([{ op: 'unset', path: ['servers', name] }]))) problem = refused;
    } catch (error) {
      problem = failure(error);
    }
    delete busy[name];
    if (disposed) return;
    if (problem) {
      ui.notice = { tone: 'error', ...problem };
    } else {
      const prefix = mcpRefPrefix(name);
      const baseRefs = mcpEntryRefs(cfg.base[name]);
      const others = mcpConfigRefs(cfg.servers, name);
      void unsetQuietly([...mcpEntryRefs(cfg.user[name])].filter((ref) => ref.startsWith(prefix) && !baseRefs.has(ref) && !others.has(ref)));
      // Restoring discards unsaved edits too; the next snapshot rebuilds the draft.
      if (ui.draft?.target === name) ui.draft = editDraftFor(name);
      ui.notice = { tone: 'success', key: 'mcp_restored' };
    }
    publish();
  };

  const confirmDelete = async () => {
    const confirm = ui.confirm;
    if (!confirm || confirm.busy) return;
    const name = confirm.name;
    const cfg = readConfig();
    const entry = cfg.servers[name] ?? cfg.user[name];
    ui.confirm = { ...confirm, busy: true, error: null };
    publish();
    let problem = null;
    try {
      if (!(await form.mutate([{ op: 'unset', path: ['servers', name] }]))) problem = refused;
    } catch (error) {
      problem = failure(error);
    }
    if (disposed) return;
    if (problem) {
      ui.confirm = { ...confirm, busy: false, error: problem };
      publish();
      return;
    }
    const prefix = mcpRefPrefix(name);
    const others = mcpConfigRefs(cfg.servers, name);
    // The OAuth grant and its token reference go through the Host, which also revokes the refresh token.
    void rpc('auth-forget', { server: name }).catch(() => {});
    const oauthRef = mcpOAuthRef(name);
    void unsetQuietly([...mcpEntryRefs(entry)].filter((ref) => ref.startsWith(prefix) && ref !== oauthRef && !others.has(ref)));
    const { [name]: _auth, ...restAuth } = authUi;
    authUi = restAuth;
    probeAborts.get(name)?.abort();
    probeAborts.delete(name);
    const { [name]: _probe, ...restProbes } = probes;
    const { [name]: _tools, ...restTools } = tools;
    probes = restProbes;
    tools = restTools;
    ui.confirm = null;
    if (ui.draft?.target === name) ui.draft = null;
    ui.view = { kind: 'list' };
    ui.opener = MCP_ADD_OPENER;
    ui.notice = { tone: 'success', key: 'mcp_deleted', values: { name } };
    publish();
  };

  const importBatch = async () => {
    const batch = ui.batch;
    if (!batch || batch.saving) return;
    const cfg = readConfig();
    if (cfg.status !== 'ready' || !cfg.writable) {
      ui.batch = { ...batch, error: { key: 'mcp_readOnlyConfig' } };
      publish();
      return;
    }
    const chosen = batch.items.filter((item) => item.include && !item.problem && (!item.exists || item.mode === 'overwrite'));
    const skipped = batch.items.filter((item) => item.include && !item.problem && item.exists && item.mode !== 'overwrite').length;
    if (!chosen.length) return;
    ui.batch = { ...batch, saving: true, error: null };
    publish();
    const reserved = mcpConfigRefs(cfg.servers, null);
    const sets = [];
    const ops = [];
    for (const item of chosen) {
      const draft = mcpDraftFromParsed(item.server);
      const plan = mcpPlanSecrets(draft, item.server.name, { credInfo, reserved, allowEmpty: true });
      for (const template of plan.templates.values()) reserved.add(mcpSoleCredential(template));
      sets.push(...plan.sets);
      ops.push({ op: 'set', path: ['servers', item.server.name], value: mcpCompactEntry(mcpDraftToEntry(draft, plan.templates), { enabled: item.server.enabled }) });
    }
    let created = [];
    let problem = null;
    try {
      created = await setSecrets(sets);
    } catch (error) {
      problem = { key: 'mcp_errCredential', values: { reason: errorText(error, t) } };
    }
    if (!problem) {
      try {
        if (!(await form.mutate(ops))) problem = refused;
      } catch (error) {
        problem = { key: 'mcp_errSave', values: { reason: errorText(error, t) } };
      }
      if (problem) await unsetQuietly(created);
    }
    if (disposed) return;
    if (problem) {
      if (ui.batch) ui.batch = { ...ui.batch, saving: false, error: problem };
      publish();
      return;
    }
    ui.batch = null;
    ui.view = { kind: 'list' };
    ui.opener = MCP_ADD_OPENER;
    ui.notice = skipped
      ? { tone: 'success', key: 'mcp_importedSkipped', values: { n: chosen.length, m: skipped } }
      : { tone: 'success', key: chosen.length === 1 ? 'mcp_importedOne' : 'mcp_imported', values: { n: chosen.length } };
    publish();
  };

  // -- Navigation -------------------------------------------------------------

  const openDetail = (name) => {
    ui.justAdded = null;
    ui.view = { kind: 'detail', name };
    ui.opener = name;
    ui.notice = null;
    ui.confirm = null;
    const keep = ui.draft && ui.draft.mode === 'edit' && ui.draft.target === name && isDirty(ui.draft);
    if (!keep) ui.draft = editDraftFor(name);
    describeDraftRefs();
    publish();
  };

  const back = () => {
    const kind = ui.view.kind;
    if (kind === 'form' && ui.draft?.mode === 'add') ui.draft = null;
    if (kind === 'batch') ui.batch = null;
    if (kind === 'detail' && ui.draft) ui.draft = mcpScrubDraft(ui.draft);
    if (kind === 'add') ui.paste = '';
    if (kind !== 'detail' && !ui.opener) ui.opener = MCP_ADD_OPENER;
    ui.justAdded = null;
    ui.view = { kind: 'list' };
    ui.notice = null;
    ui.confirm = null;
    publish();
  };

  /** Page unmounted: drop everything that may hold a typed secret. */
  const scrub = () => {
    ui.paste = '';
    if (ui.batch) ui.batch = null;
    if (ui.view.kind === 'batch') ui.view = { kind: 'add' };
    if (ui.draft) ui.draft = mcpScrubDraft(ui.draft);
    ui.confirm = null;
    clearTimeout(checkTimer);
    checkTimer = null;
    checkUrl = null;
    authUi = Object.fromEntries(Object.entries(authUi).map(([name, state]) => [name, { ...state, clientSecret: '', callbackUrl: '' }]));
  };

  return {
    refresh(kind) {
      if (disposed) return;
      if (kind !== 'config' && streamAbort) {
        stopStream();
        startStream();
      }
      if (kind !== 'config' && poll) {
        stopPoll();
        startPoll();
      }
      prunePending();
      syncDraft();
      describeDraftRefs();
      if (kind !== 'config' && ui.view.kind === 'detail') {
        const current = tools[ui.view.name];
        if (current) void loadTools(ui.view.name, current.key, true);
      }
      publish();
    },
    dispose() {
      disposed = true;
      stopStream();
      stopPoll();
      clearTimeout(checkTimer);
      for (const abort of probeAborts.values()) abort.abort();
      probeAborts.clear();
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      offForm?.();
    },
    face: {
      hooks: { mcp: store },
      /** Open the status stream while the page is mounted; returns the stop function. */
      watch() {
        watchers += 1;
        if (watchers === 1) {
          startStream();
          startPoll();
        }
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          watchers -= 1;
          if (watchers === 0) {
            stopStream();
            stopPoll();
            scrub();
            publish();
          }
        };
      },
      retry() {
        stopStream();
        stopPoll();
        if (watchers > 0) {
          startStream();
          startPoll();
        }
        publish();
      },
      takeOpener() {
        const opener = ui.opener;
        ui.opener = null;
        return opener;
      },
      openAdd() {
        ui.view = { kind: 'add' };
        ui.opener = MCP_ADD_OPENER;
        ui.notice = null;
        publish();
      },
      openManual() {
        ui.draft = mcpEmptyDraft();
        ui.view = { kind: 'form' };
        ui.paste = '';
        ui.notice = null;
        if (!ui.opener) ui.opener = MCP_ADD_OPENER;
        publish();
      },
      openDetail,
      back,
      setQuery(query) {
        ui.query = String(query ?? '');
        publish();
      },
      /** Text in the paste box; a real paste that is recognized opens the form or batch view at once. */
      setPaste(text, pasted) {
        ui.paste = String(text ?? '');
        if (pasted) {
          const result = mcpParsePaste(ui.paste, takenNames());
          if (result.servers.length) {
            openParsed(result);
            return;
          }
        }
        publish();
      },
      continuePaste() {
        const result = mcpParsePaste(ui.paste, takenNames());
        if (result.servers.length) openParsed(result);
      },
      dismissNotice() {
        ui.notice = null;
        publish();
      },
      setName(text) {
        editDraft((d) => {
          d.name = mcpTypeName(text);
          d.errors = dropErrors(d.errors, 'name');
        });
      },
      setTransport(transport) {
        editDraft((d) => {
          if (d.origin === 'inherited' || d.origin === 'overridden') return;
          d.transport = transport === 'streamable-http' ? 'streamable-http' : 'stdio';
          d.errors = dropErrors(dropErrors(d.errors, 'command'), 'url');
        });
      },
      setCommandLine(text) {
        editDraft((d) => {
          d.commandLine = String(text ?? '');
          d.errors = dropErrors(d.errors, 'command');
        });
      },
      setUrl(text) {
        editDraft((d) => {
          d.url = String(text ?? '');
          d.errors = dropErrors(d.errors, 'url');
        });
      },
      /** cwd | startupSec | toolCallSec */
      setField(field, value) {
        const errorField = { cwd: 'cwd', startupSec: 'startup', toolCallSec: 'toolCall' }[field];
        if (!errorField) return;
        editDraft((d) => {
          d[field] = String(value ?? '');
          d.errors = dropErrors(d.errors, errorField);
        });
      },
      setAdvancedOpen(open) {
        if (!ui.draft || ui.draft.advancedOpen === Boolean(open)) return;
        ui.draft = { ...ui.draft, advancedOpen: Boolean(open) };
        publish();
      },
      /** Paste into the command box; true when handled (the caller prevents the default paste). */
      pasteCommand(fullText) {
        if (!ui.draft) return false;
        const result = mcpParsePaste(fullText, ui.draft.mode === 'add' ? takenNames() : []);
        if (result.servers.length !== 1 || !canApply(result.servers[0])) return false;
        applyParsed(result.servers[0]);
        return true;
      },
      /** Paste into the URL box: a command (text with spaces) switches back to a local command. */
      pasteUrl(fullText) {
        if (!ui.draft) return false;
        const trimmed = String(fullText ?? '').trim();
        if (mcpIsUrl(trimmed) || !/\s/.test(trimmed)) return false;
        const result = mcpParsePaste(trimmed, ui.draft.mode === 'add' ? takenNames() : []);
        if (result.servers.length !== 1 || !canApply(result.servers[0])) return false;
        applyParsed(result.servers[0]);
        return true;
      },
      addKv(kind) {
        if (kind !== 'env' && kind !== 'headers') return;
        editDraft((d) => {
          const row = mcpRow('', '');
          d[kind] = [...d[kind], row];
          d.focus = `${kind}:${row.id}:key`;
        });
      },
      setKv(kind, id, patch) {
        if (kind !== 'env' && kind !== 'headers') return;
        const next = { ...patch };
        if ('key' in next && kind === 'env') next.key = mcpEnvKey(next.key);
        editDraft((d) => {
          d[kind] = d[kind].map((row) => {
            if (row.id !== id || row.oauth) return row;
            if (row.locked && 'key' in next) return { ...row, ...next, key: row.key };
            return { ...row, ...next };
          });
          d.errors = dropErrors(d.errors, `${kind}:${id}`);
        });
      },
      removeKv(kind, id) {
        if (kind !== 'env' && kind !== 'headers') return;
        editDraft((d) => {
          d[kind] = d[kind].filter((row) => row.id !== id || row.locked || row.oauth);
          d.errors = dropErrors(d.errors, `${kind}:${id}`);
        });
      },
      toggleSecret(kind, id) {
        if (kind !== 'env' && kind !== 'headers') return;
        editDraft((d) => {
          d[kind] = d[kind].map((row) => {
            if (row.id !== id || row.oauth) return row;
            if (row.secret) return { ...row, secret: false, value: row.value || (row.ref ? mcpTemplate(row.ref) : ''), ref: null };
            const ref = mcpSoleCredential(row.value);
            return ref ? { ...row, secret: true, ref, value: '' } : { ...row, secret: true };
          });
          d.errors = dropErrors(d.errors, `${kind}:${id}`);
        });
        describeDraftRefs();
      },
      clearFocus() {
        if (!ui.draft?.focus) return;
        ui.draft = { ...ui.draft, focus: null };
        publish();
      },
      /** Discard unsaved edits of the open server. */
      resetDraft() {
        if (!ui.draft || ui.draft.mode !== 'edit' || ui.draft.saving) return;
        const fresh = editDraftFor(ui.draft.target);
        ui.draft = fresh ? { ...fresh, advancedOpen: ui.draft.advancedOpen } : null;
        describeDraftRefs();
        publish();
      },
      submitDraft,
      setBatchItem(key, patch) {
        if (!ui.batch || ui.batch.saving) return;
        ui.batch = { ...ui.batch, error: null, items: ui.batch.items.map((item) => (item.key === key && !item.problem ? { ...item, ...patch } : item)) };
        publish();
      },
      setBatchAll(include) {
        if (!ui.batch || ui.batch.saving) return;
        ui.batch = { ...ui.batch, error: null, items: ui.batch.items.map((item) => (item.problem ? item : { ...item, include: Boolean(include) })) };
        publish();
      },
      importBatch,
      toggleEnabled,
      restart,
      probe,
      loadTools,
      restoreDefault,
      startAuth,
      /** 授权 on a card: same flow, without opening the detail. */
      authorizeFromCard(name) { void startAuth(name, { fromCard: true }); },
      completeAuth,
      cancelAuth,
      forgetAuth,
      /** clientId | clientSecret | callbackUrl */
      setAuthField(name, field, value) {
        if (field !== 'clientId' && field !== 'clientSecret' && field !== 'callbackUrl') return;
        setAuth(name, { [field]: String(value ?? ''), error: null });
      },
      /** Re-run `mcp-auth-check` for a URL (the add form's retry). */
      recheckAuth(url) { void checkAuth(String(url ?? '').trim(), true); },
      askDelete(name) {
        ui.confirm = { name, busy: false, error: null };
        publish();
      },
      cancelDelete() {
        if (!ui.confirm || ui.confirm.busy) return;
        ui.confirm = null;
        publish();
      },
      confirmDelete,
    },
  };
}

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

addDict({
  mcp_nav: 'MCP 服务器',
  mcp_title: 'MCP 服务器',
  mcp_intro: '让 Agent 调用外部工具。添加后立即连接，所有会话都能用。',
  mcp_add: '添加 MCP 服务器',
  mcp_addFirst: '添加第一个 MCP 服务器',
  mcp_pasteHint: '支持 npx / uvx / docker 等启动命令、https:// 服务器地址，以及 Claude、Cursor、VS Code 配置里的 mcpServers JSON（可一次导入多个）。',
  mcp_pastePlaceholder: '粘贴启动命令、服务器 URL 或 JSON 配置',
  mcp_pasteLabel: '启动命令、服务器 URL 或 JSON 配置',
  mcp_manual: '手动填写',
  mcp_continue: '继续',
  mcp_detectCommand: '识别为本地命令：{cmd}',
  mcp_detectUrl: '识别为远程服务器：{host}',
  mcp_detectJson: '识别为 JSON：{n} 个服务器',
  mcp_detectJsonOne: '识别为 JSON：1 个服务器',
  mcp_detectJsonEmpty: 'JSON 里没有找到服务器',
  mcp_detectJsonError: 'JSON 格式有误：{reason}',
  mcp_detectUnknown: '无法识别，请检查格式或手动填写',
  mcp_warnSse: 'DSH 只支持 Streamable HTTP，SSE 服务器可能连不上',
  mcp_search: '搜索服务器',
  mcp_noMatch: '没有匹配「{q}」的服务器',
  mcp_local: '本地',
  mcp_remote: '远程',
  mcp_inherited: '内置配置',
  mcp_overridden: '内置配置 · 已修改',
  mcp_plugin: '插件提供',
  mcp_pluginLine: '由插件注册',
  mcp_enable: '启用 {name}',
  mcp_stConnected: '已连接 · {n} 个工具',
  mcp_stConnectedOne: '已连接 · 1 个工具',
  mcp_stConnecting: '连接中…',
  mcp_stRetrying: '重试中（{attempt}/{max}）',
  mcp_stFailed: '连接失败',
  mcp_stCredentials: '需要凭据',
  mcp_stDisabled: '已停用',
  mcp_stClosed: '已断开',
  mcp_stUnknown: '状态未知',
  mcp_stLoading: '读取状态…',
  mcp_errGaveUp: '多次重试仍然失败，已停止重试',
  mcp_errUnclosed: '上一个连接没有正常关闭，请重启 DSH',
  mcp_errCleanup: '没能确认进程已经退出，请重启 DSH',
  mcp_runtimeError: '无法读取运行状态：{reason}。正在重试…',
  mcp_readOnlyConfig: '当前配置不能写入，这里只能查看。',
  mcp_configUnavailable: 'MCP 配置暂时不可用',
  mcp_connectedLine: '已连接 · {n} 个工具 · {ago}连上',
  mcp_connectedLineOne: '已连接 · 1 个工具 · {ago}连上',
  mcp_disabledLine: '已停用，Agent 现在用不到它的工具。',
  mcp_closedLine: '连接已断开。',
  mcp_retryIn: '{s} 秒后重试',
  mcp_restart: '重新连接',
  mcp_test: '测试连接',
  mcp_testing: '正在测试连接…',
  mcp_showMore: '展开全部',
  mcp_showLess: '收起',
  mcp_tools: '工具',
  mcp_toolsHint: '连接后显示工具',
  mcp_toolsFilter: '过滤工具',
  mcp_toolsEmpty: '这个服务器没有提供工具',
  mcp_toolsNoMatch: '没有匹配的工具',
  mcp_probeOk: '连接成功',
  mcp_probeTook: '用时 {d}',
  mcp_probeTools: '{n} 个工具',
  mcp_probeToolsOne: '1 个工具',
  mcp_probeTruncated: '工具太多，只列出了一部分',
  mcp_probeUnclosed: '测试连接没有正常关闭',
  mcp_probeFailConnect: '连接失败',
  mcp_probeFailList: '读取工具列表失败',
  mcp_ms: '{n} 毫秒',
  mcp_sec: '{n} 秒',
  mcp_config: '配置',
  mcp_inheritedNote: '这个服务器来自内置配置，你的修改会另存为覆盖。',
  mcp_restore: '恢复默认',
  mcp_restored: '已恢复默认配置',
  mcp_pluginNote: '由插件注册，不能在这里修改。',
  mcp_exprNote: '这个服务器的配置里有表达式，不能在这里修改。',
  mcp_delete: '删除服务器',
  mcp_deleteTitle: '删除 {name}？',
  mcp_deleteBody: '会从配置中移除它，并删除它保存在凭据库里的密钥。',
  mcp_deleteConfirm: '删除',
  mcp_deleted: '已删除 {name}',
  mcp_notFound: '找不到这个服务器，它可能已被删除。',
  mcp_subLocal: '本地命令',
  mcp_subRemote: '远程 URL',
  mcp_name: '名称',
  mcp_namePlaceholder: '名称',
  mcp_nameHint: '工具名前缀：mcp__{name}__',
  mcp_transport: '连接方式',
  mcp_tStdio: '本地命令',
  mcp_tHttp: '远程 URL',
  mcp_transportLocked: '内置服务器不能改连接方式',
  mcp_command: '命令',
  mcp_commandHint: '可以直接粘贴整条命令；开头的 KEY=VALUE 会移到环境变量。',
  mcp_argsPreview: '参数拆分预览',
  mcp_url: 'URL',
  mcp_urlHint: '只支持 Streamable HTTP；粘贴带空格的命令会切回本地命令。',
  mcp_env: '环境变量',
  mcp_headers: '请求头',
  mcp_addEnv: '添加环境变量',
  mcp_addHeader: '添加请求头',
  mcp_kvKey: '名称',
  mcp_kvValue: '值',
  mcp_kvValueOf: '{key} 的值',
  mcp_kvRemove: '删除这一行',
  mcp_kvLocked: '来自内置配置，不能删除',
  mcp_secretOn: '密钥：保存在凭据库，点击改为普通值',
  mcp_secretOff: '设为密钥',
  mcp_secretStored: '已保存在凭据库',
  mcp_secretKeep: '留空保持不变',
  mcp_secretNew: '输入密钥',
  mcp_secretMissing: '凭据库里没有这个值，请重新填写',
  mcp_secretSuggest: '这个值像是密钥，可以点锁形按钮存进凭据库',
  mcp_advanced: '高级',
  mcp_advDefault: '工作目录、超时',
  mcp_advDefaultRemote: '超时',
  mcp_cwd: '工作目录',
  mcp_default: '默认',
  mcp_startup: '启动超时（秒）',
  mcp_toolCall: '工具调用超时（秒）',
  mcp_sumCwd: '工作目录 {v}',
  mcp_sumStartup: '启动超时 {v} 秒',
  mcp_sumToolCall: '工具调用超时 {v} 秒',
  mcp_addConnect: '添加并连接',
  mcp_saveHint: '保存后会重新连接',
  mcp_saved: '已保存',
  mcp_errNameRequired: '请填写名称',
  mcp_errNameFormat: '只能用字母、数字、- 和 _，最多 32 个字符',
  mcp_errNameTaken: '已有同名的服务器',
  mcp_errCommandRequired: '请填写启动命令',
  mcp_errQuote: '有引号没有闭合',
  mcp_errUrlRequired: '请填写 URL',
  mcp_errUrlFormat: 'URL 需要以 http:// 或 https:// 开头',
  mcp_errTemplate: '${credential:名称} 的写法不正确',
  mcp_errKeyRequired: '请填写名称',
  mcp_errEnvKey: '只能用字母、数字和 _，不能以数字开头',
  mcp_errHeaderKey: '请求头名称里有无效字符',
  mcp_errKeyDuplicate: '名称重复',
  mcp_errSecretRequired: '请填写密钥的值',
  mcp_errTimeout: '请填写大于 0 的秒数',
  mcp_errRefused: '没有保存：设置拒绝了这次修改，请检查后重试。',
  mcp_errSave: '保存失败：{reason}',
  mcp_errCredential: '无法保存密钥：{reason}',
  mcp_errAction: '操作失败：{reason}',
  mcp_importTitle: '导入 MCP 服务器',
  mcp_importFound: '识别到 {n} 个服务器',
  mcp_importFoundOne: '识别到 1 个服务器',
  mcp_selectAll: '全选',
  mcp_exists: '已存在',
  mcp_skip: '跳过',
  mcp_overwrite: '覆盖',
  mcp_conflictLabel: '{name} 已存在时',
  mcp_importN: '导入 {n} 个',
  mcp_imported: '已导入 {n} 个服务器',
  mcp_importedOne: '已导入 1 个服务器',
  mcp_importedSkipped: '已导入 {n} 个服务器，跳过 {m} 个',
  mcp_problemCommand: '缺少启动命令',
  mcp_problemUrl: 'URL 无效',
  mcp_problemTemplate: '包含写法不正确的 ${credential:…}',
  mcp_problemPlugin: '插件已经注册了同名服务器',
  mcp_dismiss: '关闭提示',
  mcp_stAutoRetry: '重新连接中（{attempt}/{max}）',
  mcp_stReconnectFailed: '重连失败',
  mcp_stNeedsAuth: '需要授权',
  mcp_stAuthWaiting: '等待授权…',
  mcp_stAuthDone: '授权成功，正在连接…',
  mcp_autoRetryIn: '连接断开，{s} 秒后自动重连',
  mcp_autoRetryNow: '连接断开，正在自动重连…',
  mcp_gaveUpLine: '已自动重连 {n} 次仍失败',
  mcp_failedManual: '连接失败，不会自动重试。检查配置后点「重试」。',
  mcp_retry: '重试',
  mcp_retryNow: '立即重试',
  mcp_authorize: '授权',
  mcp_authorizeName: '授权 {name}',
  mcp_authNeeded: '这个服务器需要登录授权，授权后自动连接。',
  mcp_authTokenOnly: '服务器拒绝了请求（401），但没有提供 OAuth 授权。请在请求头里填写访问令牌，例如 Authorization: Bearer …',
  mcp_authReadOnly: '这个服务器需要授权，但它的配置不能在这里修改。',
  mcp_authChecking: '正在检查是否需要授权…',
  mcp_authOpened: '已在浏览器打开 {issuer} 的授权页，完成后会自动连接。',
  mcp_authReopen: '重新打开授权页',
  mcp_authNoRedirect: '浏览器没有跳回来？',
  mcp_authCallbackHint: '授权完成后，把浏览器地址栏里的完整地址（以 {redirect} 开头）粘贴到这里。',
  mcp_authCallbackLabel: '回调地址',
  mcp_authComplete: '完成授权',
  mcp_authExchanging: '正在获取令牌…',
  mcp_authFlowError: '授权失败：{reason}',
  mcp_reauthorize: '重新授权',
  mcp_authClientRequired: '这个授权服务器不支持自动注册客户端。请填写在它那里注册的 Client ID。',
  mcp_clientId: 'Client ID',
  mcp_clientSecret: 'Client Secret（可选）',
  mcp_errClientIdRequired: '请填写 Client ID',
  mcp_errCallbackRequired: '请粘贴回调地址',
  mcp_authSection: '授权',
  mcp_authOk: '已授权 · {issuer}',
  mcp_authIssuer: '授权服务器：{issuer}',
  mcp_authExpiresRefresh: '令牌 {time}后过期，会自动续期',
  mcp_authExpiresManual: '令牌 {time}后过期，过期后需要重新授权',
  mcp_authRenewing: '令牌正在续期',
  mcp_authNoRefresh: '过期后需要重新授权',
  mcp_authExpired: '授权已失效，请重新授权',
  mcp_authErrorState: '授权出错：{reason}',
  mcp_signOut: '退出授权',
  mcp_signedOut: '已退出 {name} 的授权',
  mcp_durMin: '{n} 分钟',
  mcp_durHour: '{n} 小时',
  mcp_durDay: '{n} 天',
  mcp_oauthManaged: '由 OAuth 授权管理',
  mcp_oauthManagedTip: 'Authorization 请求头由 OAuth 授权管理',
  mcp_checkOauth: '需要登录授权（{issuer}），添加后会打开授权页。',
  mcp_checkToken: '服务器要求访问令牌（401）：请在请求头里填写。',
  mcp_checkForbidden: '服务器拒绝访问（403）。',
  mcp_checkUnreachable: '暂时连不上：{error}。仍可添加。',
  mcp_addAuthorize: '添加并授权',
}, {
  mcp_nav: 'MCP servers',
  mcp_title: 'MCP servers',
  mcp_intro: 'Let the agent call external tools. Servers connect as soon as you add them and work in every session.',
  mcp_add: 'Add MCP server',
  mcp_addFirst: 'Add your first MCP server',
  mcp_pasteHint: 'Accepts launch commands (npx, uvx, docker…), https:// server URLs, and mcpServers JSON from Claude, Cursor, or VS Code configs (several servers at once).',
  mcp_pastePlaceholder: 'Paste a launch command, server URL, or JSON config',
  mcp_pasteLabel: 'Launch command, server URL, or JSON config',
  mcp_manual: 'Fill in manually',
  mcp_continue: 'Continue',
  mcp_detectCommand: 'Detected a local command: {cmd}',
  mcp_detectUrl: 'Detected a remote server: {host}',
  mcp_detectJson: 'Detected JSON: {n} servers',
  mcp_detectJsonOne: 'Detected JSON: 1 server',
  mcp_detectJsonEmpty: 'No servers found in this JSON',
  mcp_detectJsonError: 'Invalid JSON: {reason}',
  mcp_detectUnknown: 'Not recognized. Check the format or fill in manually.',
  mcp_warnSse: 'DSH supports only Streamable HTTP. SSE servers may not connect.',
  mcp_search: 'Search servers',
  mcp_noMatch: 'No servers match "{q}"',
  mcp_local: 'Local',
  mcp_remote: 'Remote',
  mcp_inherited: 'Built-in config',
  mcp_overridden: 'Built-in config · Modified',
  mcp_plugin: 'From a plugin',
  mcp_pluginLine: 'Registered by a plugin',
  mcp_enable: 'Enable {name}',
  mcp_stConnected: 'Connected · {n} tools',
  mcp_stConnectedOne: 'Connected · 1 tool',
  mcp_stConnecting: 'Connecting…',
  mcp_stRetrying: 'Retrying ({attempt}/{max})',
  mcp_stFailed: 'Failed to connect',
  mcp_stCredentials: 'Needs credentials',
  mcp_stDisabled: 'Disabled',
  mcp_stClosed: 'Disconnected',
  mcp_stUnknown: 'Status unknown',
  mcp_stLoading: 'Loading status…',
  mcp_errGaveUp: 'Stopped retrying after repeated failures',
  mcp_errUnclosed: 'The previous connection did not close. Restart DSH.',
  mcp_errCleanup: 'Could not confirm the process exited. Restart DSH.',
  mcp_runtimeError: 'Could not read server status: {reason}. Retrying…',
  mcp_readOnlyConfig: 'This configuration is read-only here.',
  mcp_configUnavailable: 'MCP configuration is unavailable',
  mcp_connectedLine: 'Connected {ago} · {n} tools',
  mcp_connectedLineOne: 'Connected {ago} · 1 tool',
  mcp_disabledLine: 'Disabled. The agent can’t use its tools right now.',
  mcp_closedLine: 'Disconnected.',
  mcp_retryIn: 'next retry in {s}s',
  mcp_restart: 'Reconnect',
  mcp_test: 'Test connection',
  mcp_testing: 'Testing the connection…',
  mcp_showMore: 'Show all',
  mcp_showLess: 'Show less',
  mcp_tools: 'Tools',
  mcp_toolsHint: 'Tools appear once the server connects',
  mcp_toolsFilter: 'Filter tools',
  mcp_toolsEmpty: 'This server provides no tools',
  mcp_toolsNoMatch: 'No matching tools',
  mcp_probeOk: 'Connected',
  mcp_probeTook: 'took {d}',
  mcp_probeTools: '{n} tools',
  mcp_probeToolsOne: '1 tool',
  mcp_probeTruncated: 'Too many tools; only some are listed',
  mcp_probeUnclosed: 'The test connection did not close cleanly',
  mcp_probeFailConnect: 'Could not connect',
  mcp_probeFailList: 'Could not list tools',
  mcp_ms: '{n} ms',
  mcp_sec: '{n} s',
  mcp_config: 'Configuration',
  mcp_inheritedNote: 'This server comes from the built-in configuration. Your changes are saved as an override.',
  mcp_restore: 'Restore default',
  mcp_restored: 'Restored the default configuration',
  mcp_pluginNote: 'Registered by a plugin and can’t be changed here.',
  mcp_exprNote: 'This server’s configuration uses expressions and can’t be changed here.',
  mcp_delete: 'Delete server',
  mcp_deleteTitle: 'Delete {name}?',
  mcp_deleteBody: 'This removes it from the configuration and deletes its secrets from the credential store.',
  mcp_deleteConfirm: 'Delete',
  mcp_deleted: 'Deleted {name}',
  mcp_notFound: 'This server no longer exists. It may have been deleted.',
  mcp_subLocal: 'Local command',
  mcp_subRemote: 'Remote URL',
  mcp_name: 'Name',
  mcp_namePlaceholder: 'name',
  mcp_nameHint: 'Tool name prefix: mcp__{name}__',
  mcp_transport: 'Connection',
  mcp_tStdio: 'Local command',
  mcp_tHttp: 'Remote URL',
  mcp_transportLocked: 'Built-in servers can’t change their connection type',
  mcp_command: 'Command',
  mcp_commandHint: 'Paste the whole command. Leading KEY=VALUE pairs move to environment variables.',
  mcp_argsPreview: 'Argument preview',
  mcp_url: 'URL',
  mcp_urlHint: 'Streamable HTTP only. Pasting a command with spaces switches back to a local command.',
  mcp_env: 'Environment variables',
  mcp_headers: 'Request headers',
  mcp_addEnv: 'Add environment variable',
  mcp_addHeader: 'Add header',
  mcp_kvKey: 'Name',
  mcp_kvValue: 'Value',
  mcp_kvValueOf: 'Value of {key}',
  mcp_kvRemove: 'Remove row',
  mcp_kvLocked: 'From the built-in configuration; can’t be removed',
  mcp_secretOn: 'Secret, stored in the credential store. Click to make it a plain value',
  mcp_secretOff: 'Make secret',
  mcp_secretStored: 'Saved in the credential store',
  mcp_secretKeep: 'Leave blank to keep',
  mcp_secretNew: 'Enter the secret',
  mcp_secretMissing: 'The credential store has no value for this. Enter it again.',
  mcp_secretSuggest: 'This looks like a secret. Use the lock button to keep it in the credential store.',
  mcp_advanced: 'Advanced',
  mcp_advDefault: 'Working directory, timeouts',
  mcp_advDefaultRemote: 'Timeouts',
  mcp_cwd: 'Working directory',
  mcp_default: 'Default',
  mcp_startup: 'Startup timeout (seconds)',
  mcp_toolCall: 'Tool call timeout (seconds)',
  mcp_sumCwd: 'Working directory {v}',
  mcp_sumStartup: 'Startup timeout {v}s',
  mcp_sumToolCall: 'Tool call timeout {v}s',
  mcp_addConnect: 'Add and connect',
  mcp_saveHint: 'Saving reconnects the server',
  mcp_saved: 'Saved',
  mcp_errNameRequired: 'Enter a name',
  mcp_errNameFormat: 'Use letters, digits, - and _, up to 32 characters',
  mcp_errNameTaken: 'A server with this name already exists',
  mcp_errCommandRequired: 'Enter the launch command',
  mcp_errQuote: 'A quote is not closed',
  mcp_errUrlRequired: 'Enter the URL',
  mcp_errUrlFormat: 'The URL must start with http:// or https://',
  mcp_errTemplate: 'Malformed ${credential:NAME} reference',
  mcp_errKeyRequired: 'Enter a name',
  mcp_errEnvKey: 'Use letters, digits, and _, not starting with a digit',
  mcp_errHeaderKey: 'The header name has invalid characters',
  mcp_errKeyDuplicate: 'Duplicate name',
  mcp_errSecretRequired: 'Enter the secret value',
  mcp_errTimeout: 'Enter a number of seconds greater than 0',
  mcp_errRefused: 'Not saved: Settings refused the change. Check the values and try again.',
  mcp_errSave: 'Could not save: {reason}',
  mcp_errCredential: 'Could not save the secret: {reason}',
  mcp_errAction: 'Action failed: {reason}',
  mcp_importTitle: 'Import MCP servers',
  mcp_importFound: 'Found {n} servers',
  mcp_importFoundOne: 'Found 1 server',
  mcp_selectAll: 'Select all',
  mcp_exists: 'Exists',
  mcp_skip: 'Skip',
  mcp_overwrite: 'Overwrite',
  mcp_conflictLabel: 'When {name} exists',
  mcp_importN: 'Import {n}',
  mcp_imported: 'Imported {n} servers',
  mcp_importedOne: 'Imported 1 server',
  mcp_importedSkipped: 'Imported {n} servers, skipped {m}',
  mcp_problemCommand: 'Missing launch command',
  mcp_problemUrl: 'Invalid URL',
  mcp_problemTemplate: 'Contains a malformed ${credential:…}',
  mcp_problemPlugin: 'A plugin already registers this name',
  mcp_dismiss: 'Dismiss',
  mcp_stAutoRetry: 'Reconnecting ({attempt}/{max})',
  mcp_stReconnectFailed: 'Reconnect failed',
  mcp_stNeedsAuth: 'Needs authorization',
  mcp_stAuthWaiting: 'Waiting for authorization…',
  mcp_stAuthDone: 'Authorized. Connecting…',
  mcp_autoRetryIn: 'Disconnected. Reconnecting automatically in {s}s',
  mcp_autoRetryNow: 'Disconnected. Reconnecting automatically…',
  mcp_gaveUpLine: 'Still failing after {n} automatic reconnects',
  mcp_failedManual: 'Couldn’t connect, and DSH won’t retry on its own. Check the configuration, then select Retry.',
  mcp_retry: 'Retry',
  mcp_retryNow: 'Retry now',
  mcp_authorize: 'Authorize',
  mcp_authorizeName: 'Authorize {name}',
  mcp_authNeeded: 'This server needs you to sign in. It connects automatically once authorized.',
  mcp_authTokenOnly: 'The server rejected the request (401) but doesn’t offer OAuth sign-in. Add an access token in the request headers, for example Authorization: Bearer …',
  mcp_authReadOnly: 'This server needs authorization, but its configuration can’t be changed here.',
  mcp_authChecking: 'Checking whether sign-in is required…',
  mcp_authOpened: 'Opened the {issuer} sign-in page in your browser. The server connects automatically when you finish.',
  mcp_authReopen: 'Reopen sign-in page',
  mcp_authNoRedirect: 'Browser didn’t come back here?',
  mcp_authCallbackHint: 'After you sign in, paste the full address from the browser’s address bar (it starts with {redirect}).',
  mcp_authCallbackLabel: 'Callback URL',
  mcp_authComplete: 'Finish authorization',
  mcp_authExchanging: 'Getting the token…',
  mcp_authFlowError: 'Authorization failed: {reason}',
  mcp_reauthorize: 'Authorize again',
  mcp_authClientRequired: 'This authorization server doesn’t support automatic client registration. Enter the client ID registered with it.',
  mcp_clientId: 'Client ID',
  mcp_clientSecret: 'Client secret (optional)',
  mcp_errClientIdRequired: 'Enter the client ID',
  mcp_errCallbackRequired: 'Paste the callback URL',
  mcp_authSection: 'Authorization',
  mcp_authOk: 'Authorized · {issuer}',
  mcp_authIssuer: 'Authorization server: {issuer}',
  mcp_authExpiresRefresh: 'token expires in {time} and renews automatically',
  mcp_authExpiresManual: 'token expires in {time}; authorize again after that',
  mcp_authRenewing: 'renewing the token',
  mcp_authNoRefresh: 'authorize again when the token expires',
  mcp_authExpired: 'Authorization expired. Authorize again.',
  mcp_authErrorState: 'Authorization error: {reason}',
  mcp_signOut: 'Sign out',
  mcp_signedOut: 'Signed out of {name}',
  mcp_durMin: '{n} min',
  mcp_durHour: '{n} h',
  mcp_durDay: '{n} d',
  mcp_oauthManaged: 'Managed by OAuth authorization',
  mcp_oauthManagedTip: 'OAuth authorization manages the Authorization header',
  mcp_checkOauth: 'Requires sign-in ({issuer}). The sign-in page opens after you add it.',
  mcp_checkToken: 'The server requires an access token (401). Add it in the request headers.',
  mcp_checkForbidden: 'The server denied access (403).',
  mcp_checkUnreachable: 'Can’t reach the server right now: {error}. You can still add it.',
  mcp_addAuthorize: 'Add and authorize',
});

// ---------------------------------------------------------------------------
// CSS (tokens only)
// ---------------------------------------------------------------------------

addCss(`
.${PREFIX}-mcp-stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.${PREFIX}-mcp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; margin: 0; padding: 0; list-style: none; }
.${PREFIX}-mcp-card { position: relative; gap: 4px; padding: 12px 14px; }
@media (hover: hover) { .${PREFIX}-mcp-card:hover { background: linear-gradient(var(--dsw-alias-interactive-bg-hover), var(--dsw-alias-interactive-bg-hover)), var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); } }
.${PREFIX}-mcp-card:has(.${PREFIX}-mcp-card-link:focus-visible) { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-mcp-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 22px; }
.${PREFIX}-mcp-card-link { flex: 1 1 auto; min-width: 0; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; font-weight: 500; text-align: start; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; outline: none; transition: color 120ms ease; }
.${PREFIX}-mcp-card-link::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
.${PREFIX}-mcp-card .${PREFIX}-switch { position: relative; z-index: 1; }
.${PREFIX}-mcp-card-cmd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-mcp-card-status { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-mcp-card-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-mcp-card-status[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-mcp-card-status[data-tone="idle"] { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-card-tags { flex: none; display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; max-width: 100%; margin-left: auto; }
.${PREFIX}-mcp-card-error { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-mcp-card-error[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-mcp-card[data-off] .${PREFIX}-mcp-card-link, .${PREFIX}-mcp-card[data-off] .${PREFIX}-mcp-card-cmd { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-empty-note { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }

.${PREFIX}-mcp-paste { gap: 10px; }
.${PREFIX}-mcp-paste-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; }
.${PREFIX}-mcp-detect { display: flex; align-items: center; gap: 6px; min-height: 18px; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.${PREFIX}-mcp-detect > svg { flex: none; }
.${PREFIX}-mcp-detect[hidden] { display: none; }
.${PREFIX}-mcp-detect[data-tone="ok"] { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-mcp-detect[data-tone="ok"] > svg { color: var(--dsw-alias-state-success-primary); }
.${PREFIX}-mcp-detect[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-mcp-paste-actions { display: flex; align-items: center; gap: 8px; margin-left: -10px; }

.${PREFIX}-mcp-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; margin: 0; padding: 0; list-style: none; }
.${PREFIX}-mcp-chip { max-width: 100%; padding: 0 6px; border-radius: var(--dsw-radius-xs, 4px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover)); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; line-height: 18px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.${PREFIX}-mcp-chip[data-first] { color: var(--dsw-alias-label-primary); font-weight: 500; }

.${PREFIX}-mcp-form { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.${PREFIX}-mcp-fieldset { display: flex; flex-direction: column; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
.${PREFIX}-mcp-group-label { display: inline-flex; align-items: baseline; gap: 6px; }
.${PREFIX}-mcp-kv { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.${PREFIX}-mcp-kv-row { display: grid; grid-template-columns: min(calc(var(--mcp-key-ch, 14) * 1ch + 24px), 50%) minmax(0, 1fr) 28px 28px; gap: 6px; align-items: center; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.${PREFIX}-mcp-kv-row .${PREFIX}-mcp-kv-msg { font-family: var(--dsw-font-family, inherit); }
.${PREFIX}-mcp-kv-msg { grid-column: 1 / -1; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-kv-msg[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-mcp-kv-msg[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-mcp-kv-add { align-self: flex-start; margin-left: -10px; }
.${PREFIX}-mcp-form-actions { flex-wrap: wrap; }
.${PREFIX}-mcp-form-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-form-hint[data-saved] { color: var(--dsw-alias-state-success-primary); }

.${PREFIX}-mcp-status-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-mcp-status-line .${PREFIX}-spinner { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-mcp-errtext { margin: 0; padding: 0; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; color: var(--dsw-alias-label-primary); }
.${PREFIX}-mcp-errtext[data-collapsed] { max-height: 72px; overflow: hidden; }
.${PREFIX}-mcp-link { align-self: flex-start; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.${PREFIX}-mcp-link:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 2px; border-radius: 2px; }

.${PREFIX}-mcp-tools { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); }
.${PREFIX}-mcp-tool { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 8px 12px; }
.${PREFIX}-mcp-tool + .${PREFIX}-mcp-tool { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-mcp-tool-name { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.${PREFIX}-mcp-tool-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-tools-empty { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.${PREFIX}-mcp-tool-skeleton { height: 120px; border-radius: var(--dsw-radius-lg, 10px); }

.${PREFIX}-mcp-probe { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); }
.${PREFIX}-mcp-probe[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.${PREFIX}-mcp-probe-head { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.${PREFIX}-mcp-probe-head > svg { flex: none; }
.${PREFIX}-mcp-probe[data-tone="success"] .${PREFIX}-mcp-probe-head > svg { color: var(--dsw-alias-state-success-primary); }
.${PREFIX}-mcp-probe[data-tone="error"] .${PREFIX}-mcp-probe-head { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-mcp-probe-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-probe-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }

.${PREFIX}-mcp-batch { display: flex; flex-direction: column; gap: 8px; }
.${PREFIX}-mcp-batch-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.${PREFIX}-mcp-batch-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 10px 12px; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); }
.${PREFIX}-mcp-batch-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.${PREFIX}-mcp-batch-name { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px; font-weight: 500; }
.${PREFIX}-mcp-batch-summary { min-width: 0; padding-left: 24px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-batch-problem { padding-left: 24px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-mcp-batch-side { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
.${PREFIX}-mcp-batch-row[data-disabled] .${PREFIX}-mcp-batch-name, .${PREFIX}-mcp-batch-row[data-disabled] .${PREFIX}-mcp-batch-summary { color: var(--dsw-alias-label-tertiary); }

.${PREFIX}-mcp-notice { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); animation: ${PREFIX}-fade 120ms ease-out; }
.${PREFIX}-mcp-notice > span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.${PREFIX}-mcp-notice > svg { flex: none; }
.${PREFIX}-mcp-notice[data-tone="success"] > svg { color: var(--dsw-alias-state-success-primary); }
.${PREFIX}-mcp-notice[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.${PREFIX}-mcp-notice[data-tone="error"] > svg { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-mcp-runtime-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-mcp-danger { align-items: flex-start; }
.${PREFIX}-mcp-danger .${PREFIX}-btn { margin-left: -14px; }

.${PREFIX}-mcp-card .${PREFIX}-mcp-card-action { position: relative; z-index: 1; height: 22px; padding: 0 8px; }
.${PREFIX}-mcp-detect[data-tone="info"] { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-mcp-detect[data-tone="info"] > svg { color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
a.${PREFIX}-mcp-link-btn { text-decoration: none; }
.${PREFIX}-mcp-link-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-mcp-auth-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 6px; color: var(--dsw-alias-label-primary); }
.${PREFIX}-mcp-auth-callback { display: flex; gap: 6px; align-items: center; }
.${PREFIX}-mcp-auth-callback .${PREFIX}-input { flex: 1 1 auto; }
.${PREFIX}-mcp-auth-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.${PREFIX}-mcp-auth-line .${PREFIX}-mcp-status-line { flex: 1 1 240px; min-width: 0; flex-wrap: nowrap; align-items: flex-start; }
.${PREFIX}-mcp-auth-line .${PREFIX}-dot { margin-top: 6px; }
.${PREFIX}-mcp-auth-error { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-mcp-kv-lock { display: inline-flex; justify-content: center; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-kv-row[data-oauth] .${PREFIX}-input { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-mcp-kv-row[data-oauth] .${PREFIX}-input:not(.${PREFIX}-mono) { font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, sans-serif); font-size: 13px; }
.${PREFIX}-mcp-auth-pending { display: flex; flex-direction: column; gap: 4px; }
.${PREFIX}-mcp-auth-pending .${PREFIX}-alert-actions { margin: 4px 0 2px; }

@media (prefers-reduced-motion: reduce) {
  .${PREFIX}-mcp-notice { animation: none; }
  .${PREFIX}-mcp-card-link { transition: none; }
}
`);

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function mcpMessage(t, message) { return message ? fill(t(message.key), message.values ?? {}) : ''; }
function mcpCount(t, key, n, extra = {}) { return fill(t(n === 1 ? `${key}One` : key), { n, ...extra }); }
function mcpStatusLabel(t, info) {
  if (info.label === 'mcp_stConnected') return mcpCount(t, 'mcp_stConnected', info.count);
  return fill(t(info.label), info.values ?? {});
}
function mcpErrorSummary(t, info) {
  if (info.error) return info.error;
  return info.errorKey ? t(info.errorKey) : '';
}
function mcpDuration(t, ms) {
  const value = Number(ms) || 0;
  return value < 1000 ? fill(t('mcp_ms'), { n: Math.round(value) }) : fill(t('mcp_sec'), { n: (value / 1000).toFixed(1) });
}
function mcpFieldDomId(field) { return `${PREFIX}-mcp-f-${String(field).replace(/[^A-Za-z0-9_-]/g, '-')}`; }
function mcpDomId(raw) { return String(raw).replace(/[^A-Za-z0-9_-]/g, ''); }
function mcpOriginLabel(t, origin) {
  if (origin === 'inherited') return t('mcp_inherited');
  if (origin === 'overridden') return t('mcp_overridden');
  if (origin === 'plugin') return t('mcp_plugin');
  return null;
}

function McpSectionIcon({ size = 16 }) {
  return Icon.plug(size);
}

function McpNotice({ api, notice }) {
  if (!notice) return null;
  const error = notice.tone === 'error';
  return h('div', { className: `${PREFIX}-mcp-notice`, 'data-tone': notice.tone, role: error ? 'alert' : 'status' },
    error ? Icon.warning(14) : Icon.check(14),
    h('span', null, mcpMessage(api.t, notice)),
    h(IconButton, { label: api.t('mcp_dismiss'), icon: Icon.close(12), onClick: api.dismissNotice }));
}

/** Raw error text: monospace, selectable, folded after four lines. */
function McpErrorText({ t, text }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.split('\n').length > 4 || text.length > 360;
  return h(Fragment, null,
    h('pre', { className: `${PREFIX}-mcp-errtext`, 'data-collapsed': long && !expanded ? 'true' : undefined }, text),
    long ? h('button', { type: 'button', className: `${PREFIX}-mcp-link`, 'aria-expanded': String(expanded), onClick: () => setExpanded((open) => !open) },
      t(expanded ? 'mcp_showLess' : 'mcp_showMore')) : null);
}

function McpArgChips({ t, words }) {
  return h('ul', { className: `${PREFIX}-mcp-chips`, 'aria-label': t('mcp_argsPreview') },
    words.map((word, index) => h('li', {
      key: index, className: `${PREFIX}-mcp-chip`, 'data-first': index === 0 ? 'true' : undefined, title: word,
    }, word === '' ? "''" : word)));
}

// -- List ---------------------------------------------------------------------

function McpCard({ api, server, writable, auth }) {
  const { t } = api;
  const id = mcpDomId(useId());
  const info = server.info;
  const summary = info.summary ? mcpFirstLine(mcpErrorSummary(t, info)) : '';
  const authorize = info.kind === 'auth' && server.authMode === 'oauth' && writable;
  const origin = mcpOriginLabel(t, server.origin);
  const described = [`${id}-cmd`, `${id}-meta`, summary ? `${id}-err` : null].filter(Boolean).join(' ');
  return h('li', { className: cx(`${PREFIX}-card`, `${PREFIX}-mcp-card`), 'data-off': server.enabled ? undefined : 'true' },
    h('div', { className: `${PREFIX}-mcp-card-top` },
      h(StatusDot, { tone: info.tone }),
      h('button', {
        type: 'button', className: `${PREFIX}-mcp-card-link`, 'data-mcp-card': server.name, 'aria-describedby': described,
        onClick: () => api.openDetail(server.name),
      }, server.name),
      server.origin === 'plugin' ? null : h(Switch, {
        checked: server.enabled, busy: server.pending, disabled: server.pending || !writable,
        label: fill(t('mcp_enable'), { name: server.name }), onChange: (next) => api.toggleEnabled(server.name, next),
      })),
    h('div', {
      id: `${id}-cmd`, className: cx(`${PREFIX}-mcp-card-cmd`, server.summary && `${PREFIX}-mono`), title: server.summary || undefined,
    }, server.summary || (server.origin === 'plugin' ? t('mcp_pluginLine') : '\u00a0')),
    h('div', { id: `${id}-meta`, className: `${PREFIX}-mcp-card-meta` },
      h('span', { className: `${PREFIX}-mcp-card-status`, 'data-tone': info.tone }, mcpStatusLabel(t, info)),
      authorize ? h(Button, {
        size: 'sm', className: `${PREFIX}-mcp-card-action`, busy: auth?.busy === 'start', disabled: Boolean(auth?.busy),
        'aria-label': fill(t('mcp_authorizeName'), { name: server.name }), onClick: () => api.authorizeFromCard(server.name),
      }, t('mcp_authorize')) : null,
      server.transport || origin ? h('span', { className: `${PREFIX}-mcp-card-tags` },
        server.transport ? h(Tag, { tone: 'outline' }, t(server.transport === 'stdio' ? 'mcp_local' : 'mcp_remote')) : null,
        origin ? h(Tag, { tone: 'neutral' }, origin) : null) : null),
    summary ? h('div', { id: `${id}-err`, className: `${PREFIX}-mcp-card-error`, 'data-tone': info.errorTone, title: mcpErrorSummary(t, info) }, summary) : null);
}

/** Paste box shared by the add view and the empty state. */
function McpPastePanel({ api, state, title, autoFocus }) {
  const { t } = api;
  const id = mcpDomId(useId());
  const result = useMemo(() => mcpParsePaste(state.paste), [state.paste]);
  const ready = result.servers.length > 0;
  let tone = 'muted';
  let text = '';
  if (result.kind === 'command') { tone = 'ok'; text = fill(t('mcp_detectCommand'), { cmd: result.label }); }
  else if (result.kind === 'url') { tone = 'ok'; text = fill(t('mcp_detectUrl'), { host: result.label }); }
  else if (result.kind === 'json' && ready) { tone = 'ok'; text = mcpCount(t, 'mcp_detectJson', result.servers.length); }
  else if (result.kind === 'json') { tone = 'warn'; text = t('mcp_detectJsonEmpty'); }
  else if (result.kind === 'unknown' && result.json) { tone = 'warn'; text = fill(t('mcp_detectJsonError'), { reason: result.reason }); }
  else if (result.kind === 'unknown') { text = t('mcp_detectUnknown'); }
  const sse = ready && (result.warnings ?? []).includes('sse');
  return h('section', { className: cx(`${PREFIX}-module`, `${PREFIX}-mcp-paste`), 'aria-labelledby': title ? `${id}-title` : undefined },
    title ? h('h3', { id: `${id}-title`, className: `${PREFIX}-mcp-paste-title` }, title) : null,
    h(TextArea, {
      mono: true, minRows: 4, maxRows: 16, value: state.paste, autoFocus, 'data-mcp-add': '',
      placeholder: t('mcp_pastePlaceholder'), 'aria-label': t('mcp_pasteLabel'), 'aria-describedby': `${id}-detect`,
      disabled: !state.config.writable,
      onValue: (value) => api.setPaste(value, false),
      onPaste: (event) => {
        const pasted = event.clipboardData?.getData('text/plain') ?? '';
        if (!pasted) return;
        const node = event.currentTarget;
        const start = node.selectionStart ?? node.value.length;
        const end = node.selectionEnd ?? node.value.length;
        event.preventDefault();
        api.setPaste(node.value.slice(0, start) + pasted + node.value.slice(end), true);
      },
      onKeyDown: (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && ready) {
          event.preventDefault();
          api.continuePaste();
        }
      },
    }),
    h('p', { id: `${id}-detect`, className: `${PREFIX}-mcp-detect`, 'data-tone': tone, 'aria-live': 'polite', hidden: !text },
      tone === 'ok' ? Icon.check(12) : null, text),
    !state.paste.trim() ? h('p', { className: `${PREFIX}-mcp-detect`, 'data-tone': 'muted' }, t('mcp_pasteHint')) : null,
    sse ? h('p', { className: `${PREFIX}-mcp-detect`, 'data-tone': 'warn' }, Icon.warning(12), t('mcp_warnSse')) : null,
    h('div', { className: `${PREFIX}-mcp-paste-actions` },
      h(Button, { variant: 'ghost', size: 'sm', onClick: api.openManual, disabled: !state.config.writable }, t('mcp_manual')),
      ready ? h('div', { className: `${PREFIX}-actions-end` },
        h(Button, { variant: 'primary', size: 'sm', onClick: api.continuePaste }, t('mcp_continue'))) : null));
}

function McpListView({ api, state }) {
  const { t } = api;
  const rootRef = useRef(null);
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setPatient(false), 1500);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const opener = api.takeOpener();
    if (!opener || !rootRef.current) return;
    const selector = opener === MCP_ADD_OPENER ? '[data-mcp-add]' : `[data-mcp-card="${CSS.escape(opener)}"]`;
    rootRef.current.querySelector(selector)?.focus();
  }, []);
  const { config, servers, runtime } = state;
  let content;
  if (config.status === 'unavailable') {
    content = h(LoadError, { message: t('mcp_configUnavailable'), onRetry: api.retry, t });
  } else if (config.status !== 'ready' || (servers.length === 0 && patient && (runtime.status === 'idle' || runtime.status === 'loading'))) {
    content = h('div', { className: `${PREFIX}-mcp-grid`, 'aria-busy': 'true', 'aria-label': t('c_loading') },
      h('div', { className: `${PREFIX}-skeleton` }), h('div', { className: `${PREFIX}-skeleton` }));
  } else if (servers.length === 0) {
    content = h(McpPastePanel, { api, state, title: t('mcp_addFirst'), autoFocus: false });
  } else {
    const query = state.query.trim().toLowerCase();
    const shown = query ? servers.filter((server) => server.name.toLowerCase().includes(query) || server.summary.toLowerCase().includes(query)) : servers;
    content = h(Fragment, null,
      servers.length > 6 ? h(SearchInput, { value: state.query, onValue: api.setQuery, placeholder: t('mcp_search'), t }) : null,
      shown.length
        ? h('ul', { className: `${PREFIX}-mcp-grid` }, shown.map((server) => h(McpCard, {
          key: server.name, api, server, writable: config.writable, auth: state.auth[server.name],
        })))
        : h('p', { className: `${PREFIX}-mcp-empty-note`, role: 'status' }, fill(t('mcp_noMatch'), { q: state.query.trim() })),
      config.writable ? h('button', { type: 'button', className: `${PREFIX}-add-row`, 'data-mcp-add': '', onClick: api.openAdd },
        Icon.plus(14), h('span', null, t('mcp_add'))) : null);
  }
  return h('div', { ref: rootRef, className: `${PREFIX}-mcp-stack` },
    h(PageHeader, { title: t('mcp_title'), intro: t('mcp_intro') }),
    h(McpNotice, { api, notice: state.notice }),
    runtime.error ? h('p', { className: `${PREFIX}-mcp-runtime-error`, role: 'status' }, fill(t('mcp_runtimeError'), { reason: runtime.error })) : null,
    config.status === 'ready' && !config.writable ? h(Alert, { tone: 'info' }, t('mcp_readOnlyConfig')) : null,
    content);
}

function McpAddView({ api, state }) {
  const { t } = api;
  return h(Fragment, null,
    h(BackBar, { label: t('mcp_title'), onBack: api.back, t }),
    h('h2', { className: `${PREFIX}-page-title` }, t('mcp_add')),
    h(McpPastePanel, { api, state, autoFocus: true }));
}

// -- Batch import ---------------------------------------------------------------

function McpBatchView({ api, state }) {
  const { t } = api;
  const batch = state.batch;
  const selectable = batch.items.filter((item) => !item.problem);
  const allOn = selectable.length > 0 && selectable.every((item) => item.include);
  const someOn = selectable.some((item) => item.include);
  const count = batch.items.filter((item) => item.include && !item.problem && (!item.exists || item.mode === 'overwrite')).length;
  return h(Fragment, null,
    h(BackBar, { label: t('mcp_title'), onBack: api.back, t }),
    h(DetailTitle, { title: t('mcp_importTitle'), subtitle: mcpCount(t, 'mcp_importFound', batch.items.length) }),
    batch.warnings.includes('sse') ? h(Alert, { tone: 'warn' }, t('mcp_warnSse')) : null,
    h('div', { className: `${PREFIX}-mcp-batch` },
      selectable.length > 1 ? h(Checkbox, {
        checked: allOn, indeterminate: !allOn && someOn, disabled: batch.saving, label: t('mcp_selectAll'), onChange: api.setBatchAll,
      }) : null,
      h('ul', { className: `${PREFIX}-mcp-batch-list` }, batch.items.map((item) => {
        const { server } = item;
        return h('li', { key: item.key, className: `${PREFIX}-mcp-batch-row`, 'data-disabled': item.problem ? 'true' : undefined },
          h('div', { className: `${PREFIX}-mcp-batch-main` },
            h(Checkbox, {
              checked: item.include && !item.problem, disabled: Boolean(item.problem) || batch.saving,
              label: h('span', { className: `${PREFIX}-mcp-batch-name` }, server.name),
              onChange: (include) => api.setBatchItem(item.key, { include }),
            }),
            item.summary ? h('span', { className: cx(`${PREFIX}-mcp-batch-summary`, `${PREFIX}-mono`), title: item.summary }, item.summary) : null,
            item.problem ? h('span', { className: `${PREFIX}-mcp-batch-problem` }, t(item.problem)) : null),
          h('div', { className: `${PREFIX}-mcp-batch-side` },
            h(Tag, { tone: 'outline' }, t(server.transport === 'stdio' ? 'mcp_local' : 'mcp_remote')),
            item.exists ? h(Tag, { tone: 'warn' }, t('mcp_exists')) : null,
            item.exists && !item.problem ? h(Segmented, {
              size: 'sm', label: fill(t('mcp_conflictLabel'), { name: server.name }), value: item.mode,
              disabled: !item.include || batch.saving,
              options: [{ value: 'skip', label: t('mcp_skip') }, { value: 'overwrite', label: t('mcp_overwrite') }],
              onChange: (mode) => api.setBatchItem(item.key, { mode }),
            }) : null));
      }))),
    batch.error ? h('p', { className: `${PREFIX}-field-error`, role: 'alert' }, mcpMessage(t, batch.error)) : null,
    h('div', { className: `${PREFIX}-actions` },
      h('div', { className: `${PREFIX}-actions-end` },
        h(Button, { onClick: api.back, disabled: batch.saving }, t('c_cancel')),
        h(Button, { variant: 'primary', busy: batch.saving, disabled: count === 0, onClick: api.importBatch }, fill(t('mcp_importN'), { n: count })))));
}

// -- Form -----------------------------------------------------------------------

function McpKvEditor({ api, draft, kind, credInfo }) {
  const { t } = api;
  const rows = draft[kind];
  const errors = draft.errors;
  const keyCh = Math.min(40, Math.max(12, ...rows.map((row) => row.key.length + 1)));
  return h('div', { className: `${PREFIX}-mcp-kv`, style: { '--mcp-key-ch': keyCh } },
    rows.map((row) => {
      const base = `${kind}:${row.id}`;
      if (row.oauth) {
        return h('div', { key: row.id, className: `${PREFIX}-mcp-kv-row`, 'data-oauth': 'true', title: t('mcp_oauthManagedTip') },
          h(TextInput, { id: mcpFieldDomId(`${base}:key`), mono: true, value: row.key, readOnly: true, 'aria-label': t('mcp_kvKey') }),
          h(TextInput, { id: mcpFieldDomId(`${base}:value`), value: t('mcp_oauthManaged'), readOnly: true, 'aria-label': fill(t('mcp_kvValueOf'), { key: row.key }) }),
          h('span', { className: `${PREFIX}-mcp-kv-lock`, 'aria-hidden': true }, Icon.lock(14)),
          h('span', null));
      }
      const keyError = errors[`${base}:key`];
      const valueError = errors[`${base}:value`];
      const info = row.ref ? credInfo[row.ref] : undefined;
      const stored = row.secret && row.ref && mcpObject(info).configured === true;
      const missing = row.secret && row.ref && info && info.configured === false && !row.value;
      let placeholder = t('mcp_kvValue');
      if (row.secret) placeholder = stored ? t('mcp_secretStored') : row.ref && !missing ? t('mcp_secretKeep') : (row.example || t('mcp_secretNew'));
      else if (row.example) placeholder = row.example;
      const suggest = !row.secret && row.value && !row.value.includes('${') && mcpIsSecretKey(row.key);
      const message = keyError ?? valueError;
      return h('div', { key: row.id, className: `${PREFIX}-mcp-kv-row` },
        h(TextInput, {
          id: mcpFieldDomId(`${base}:key`), mono: true, value: row.key, placeholder: t('mcp_kvKey'), 'aria-label': t('mcp_kvKey'),
          invalid: Boolean(keyError), readOnly: row.locked, title: row.locked ? `${row.key} · ${t('mcp_kvLocked')}` : row.key || undefined,
          onValue: (key) => api.setKv(kind, row.id, { key }),
        }),
        h(TextInput, {
          id: mcpFieldDomId(`${base}:value`), mono: true, value: row.value, placeholder,
          type: row.secret ? 'password' : 'text', autoComplete: row.secret ? 'new-password' : 'off',
          'aria-label': row.key ? fill(t('mcp_kvValueOf'), { key: row.key }) : t('mcp_kvValue'),
          title: row.secret && row.ref ? mcpTemplate(row.ref) : undefined, invalid: Boolean(valueError),
          onValue: (value) => api.setKv(kind, row.id, { value }),
        }),
        h(IconButton, {
          label: row.secret ? t('mcp_secretOn') : t('mcp_secretOff'), icon: row.secret ? Icon.lock(14) : Icon.unlock(14),
          pressed: row.secret, onClick: () => api.toggleSecret(kind, row.id),
        }),
        h(IconButton, {
          label: row.locked ? t('mcp_kvLocked') : t('mcp_kvRemove'), icon: Icon.trash(14), tone: 'danger', disabled: row.locked,
          onClick: () => api.removeKv(kind, row.id),
        }),
        message ? h('p', { className: `${PREFIX}-mcp-kv-msg`, 'data-tone': 'error', role: 'alert' }, mcpMessage(t, message))
          : missing ? h('p', { className: `${PREFIX}-mcp-kv-msg`, 'data-tone': 'warn' }, t('mcp_secretMissing'))
            : suggest ? h('p', { className: `${PREFIX}-mcp-kv-msg` }, t('mcp_secretSuggest')) : null);
    }),
    h(Button, {
      variant: 'ghost', size: 'sm', icon: Icon.plus(12), className: `${PREFIX}-mcp-kv-add`, onClick: () => api.addKv(kind),
    }, t(kind === 'env' ? 'mcp_addEnv' : 'mcp_addHeader')));
}

/** What `mcp-auth-check` found for the add form's URL. */
function McpAuthCheckLine({ t, check }) {
  if (!check) return null;
  if (check.status === 'loading') {
    return h('p', { className: `${PREFIX}-mcp-detect`, role: 'status' }, h(Spinner, { size: 12 }), t('mcp_authChecking'));
  }
  if (check.kind === 'oauth') return h('p', { className: `${PREFIX}-mcp-detect`, 'data-tone': 'info', role: 'status' }, Icon.lock(12), fill(t('mcp_checkOauth'), { issuer: check.issuer }));
  if (check.kind === 'token') return h('p', { className: `${PREFIX}-mcp-detect`, 'data-tone': 'warn', role: 'status' }, Icon.warning(12), t('mcp_checkToken'));
  if (check.kind === 'forbidden') return h('p', { className: `${PREFIX}-mcp-detect`, 'data-tone': 'warn', role: 'status' }, Icon.warning(12), t('mcp_checkForbidden'));
  if (check.kind === 'unreachable') return h('p', { className: `${PREFIX}-mcp-detect`, role: 'status' }, fill(t('mcp_checkUnreachable'), { error: check.error || t('c_unknownError') }));
  return null;
}

/** The add / edit form. `mode` add shows the name field and "Add and connect". */
function McpServerForm({ api, state, draft, mode }) {
  const { t } = api;
  const formRef = useRef(null);
  const groupId = mcpDomId(useId());
  const [savedVisible, setSavedVisible] = useState(false);
  useEffect(() => {
    if (!draft.focus) return;
    const node = formRef.current?.querySelector(`#${CSS.escape(mcpFieldDomId(draft.focus))}`);
    api.clearFocus();
    node?.focus();
  }, [draft.focus]);
  useEffect(() => {
    if (!draft.savedAt) return undefined;
    setSavedVisible(true);
    const timer = setTimeout(() => setSavedVisible(false), 2400);
    return () => clearTimeout(timer);
  }, [draft.savedAt]);
  const errors = draft.errors;
  const error = (field) => (errors[field] ? mcpMessage(t, errors[field]) : undefined);
  const split = useMemo(() => mcpShellSplit(draft.commandLine), [draft.commandLine]);
  const stdio = draft.transport === 'stdio';
  const kind = stdio ? 'env' : 'headers';
  const inherited = draft.origin === 'inherited' || draft.origin === 'overridden';
  const disabled = draft.saving || !state.config.writable;
  const summary = mcpAdvancedSummary(draft);
  const summaryText = summary.length ? summary.map((part) => fill(t(part.key), part.values)).join(' · ') : t(stdio ? 'mcp_advDefault' : 'mcp_advDefaultRemote');
  const pasteHandler = (handle) => (event) => {
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (!pasted) return;
    const node = event.currentTarget;
    const start = node.selectionStart ?? node.value.length;
    const end = node.selectionEnd ?? node.value.length;
    if (handle(node.value.slice(0, start) + pasted + node.value.slice(end))) event.preventDefault();
  };
  const fieldId = (field) => mcpFieldDomId(field);
  const kvCount = draft[kind].length;
  return h('form', {
    ref: formRef, className: `${PREFIX}-mcp-form`, noValidate: true,
    onSubmit: (event) => { event.preventDefault(); api.submitDraft(); },
    onKeyDown: (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        api.submitDraft();
      }
    },
  },
  h('fieldset', { className: `${PREFIX}-mcp-fieldset`, disabled },
    mode === 'add' ? h(Field, {
      label: t('mcp_name'), htmlFor: fieldId('name'), required: true, error: error('name'), t,
      hint: fill(t('mcp_nameHint'), { name: draft.name || t('mcp_namePlaceholder') }),
    }, h(TextInput, {
      id: fieldId('name'), mono: true, value: draft.name, maxLength: 32, placeholder: 'github', invalid: Boolean(errors.name),
      onValue: api.setName,
    })) : null,
    h(Field, { label: t('mcp_transport'), hint: inherited ? t('mcp_transportLocked') : undefined, t },
      h(Segmented, {
        label: t('mcp_transport'), value: draft.transport, onChange: api.setTransport, disabled: inherited || disabled,
        options: [
          { value: 'stdio', label: t('mcp_tStdio'), icon: Icon.terminal(14) },
          { value: 'streamable-http', label: t('mcp_tHttp'), icon: Icon.globe(14) },
        ],
      })),
    stdio
      ? h(Field, {
        label: t('mcp_command'), htmlFor: fieldId('command'), required: true, error: error('command'), t,
        hint: draft.commandLine.trim() ? undefined : t('mcp_commandHint'),
      },
      h(TextInput, {
        id: fieldId('command'), mono: true, value: draft.commandLine, invalid: Boolean(errors.command),
        placeholder: 'npx -y @modelcontextprotocol/server-github', onValue: api.setCommandLine,
        onPaste: pasteHandler(api.pasteCommand),
      }),
      split.words.length > 1 || (split.words.length === 1 && /\s/.test(split.words[0])) ? h(McpArgChips, { t, words: split.words }) : null)
      : h(Field, { label: t('mcp_url'), htmlFor: fieldId('url'), required: true, error: error('url'), hint: t('mcp_urlHint'), t },
        h(TextInput, {
          id: fieldId('url'), mono: true, value: draft.url, inputMode: 'url', invalid: Boolean(errors.url),
          placeholder: 'https://mcp.example.com/mcp', onValue: api.setUrl, onPaste: pasteHandler(api.pasteUrl),
        }),
        mode === 'add' ? h(McpAuthCheckLine, { t, check: draft.auth }) : null),
    h('div', { className: `${PREFIX}-field`, role: 'group', 'aria-labelledby': `${groupId}-kv` },
      h('div', { className: `${PREFIX}-field-head` },
        h('span', { id: `${groupId}-kv`, className: cx(`${PREFIX}-field-label`, `${PREFIX}-mcp-group-label`) },
          t(stdio ? 'mcp_env' : 'mcp_headers'),
          kvCount ? h('span', { className: `${PREFIX}-count` }, String(kvCount)) : null)),
      h(McpKvEditor, { api, draft, kind, credInfo: state.credInfo })),
    h(Disclosure, { title: t('mcp_advanced'), summary: summaryText, open: draft.advancedOpen, onToggle: api.setAdvancedOpen },
      stdio ? h(Field, { label: t('mcp_cwd'), htmlFor: fieldId('cwd'), error: error('cwd'), t },
        h(TextInput, {
          id: fieldId('cwd'), mono: true, value: draft.cwd, placeholder: t('mcp_default'), invalid: Boolean(errors.cwd),
          onValue: (value) => api.setField('cwd', value),
        })) : null,
      h('div', { className: `${PREFIX}-row-fields` },
        h(Field, { label: t('mcp_startup'), htmlFor: fieldId('startup'), error: error('startup'), t },
          h(TextInput, {
            id: fieldId('startup'), value: draft.startupSec, inputMode: 'decimal', placeholder: '30', invalid: Boolean(errors.startup),
            onValue: (value) => api.setField('startupSec', value),
          })),
        h(Field, { label: t('mcp_toolCall'), htmlFor: fieldId('toolCall'), error: error('toolCall'), t },
          h(TextInput, {
            id: fieldId('toolCall'), value: draft.toolCallSec, inputMode: 'decimal', placeholder: t('mcp_default'), invalid: Boolean(errors.toolCall),
            onValue: (value) => api.setField('toolCallSec', value),
          })))),
    draft.saveError ? h('p', { className: `${PREFIX}-field-error`, role: 'alert' }, mcpMessage(t, draft.saveError)) : null,
    h('div', { className: cx(`${PREFIX}-actions`, `${PREFIX}-mcp-form-actions`) },
      mode === 'edit' ? h('span', { className: `${PREFIX}-mcp-form-hint`, 'data-saved': savedVisible && !draft.dirty ? 'true' : undefined, role: 'status' },
        savedVisible && !draft.dirty ? t('mcp_saved') : t('mcp_saveHint')) : null,
      h('div', { className: `${PREFIX}-actions-end` },
        h(Button, { onClick: mode === 'add' ? api.back : api.resetDraft, disabled: mode === 'edit' && !draft.dirty }, t('c_cancel')),
        h(Button, { type: 'submit', variant: 'primary', busy: draft.saving, disabled: mode === 'edit' && !draft.dirty },
          mode === 'add' ? t(draft.auth?.authorizeOnAdd ? 'mcp_addAuthorize' : 'mcp_addConnect') : t('c_save'))))));
}

function McpFormView({ api, state }) {
  const { t } = api;
  const draft = state.draft;
  return h(Fragment, null,
    h(BackBar, { label: t('mcp_title'), onBack: api.back, t }),
    h(DetailTitle, { title: t('mcp_add') }),
    draft.warnings.includes('sse') ? h(Alert, { tone: 'warn' }, t('mcp_warnSse')) : null,
    h(McpServerForm, { api, state, draft, mode: 'add' }));
}

// -- Detail -----------------------------------------------------------------------

function McpProbeResult({ t, probe }) {
  if (probe.status === 'running') {
    return h('p', { className: `${PREFIX}-mcp-status-line`, role: 'status' }, h(Spinner, { size: 12 }), t('mcp_testing'));
  }
  if (probe.status === 'error') {
    return h('div', { className: `${PREFIX}-mcp-probe`, 'data-tone': 'error', role: 'alert' },
      h('div', { className: `${PREFIX}-mcp-probe-head` }, Icon.warning(14), h('span', null, t('mcp_probeFailConnect'))),
      h(McpErrorText, { t, text: probe.error ?? '' }));
  }
  const result = mcpObject(probe.result);
  const took = fill(t('mcp_probeTook'), { d: mcpDuration(t, result.durationMs) });
  const unclosed = result.closeConfirmed === false
    ? h('p', { className: `${PREFIX}-mcp-probe-note`, 'data-tone': 'warn' }, t('mcp_probeUnclosed')) : null;
  if (result.ok !== true) {
    return h('div', { className: `${PREFIX}-mcp-probe`, 'data-tone': 'error', role: 'alert' },
      h('div', { className: `${PREFIX}-mcp-probe-head` }, Icon.warning(14),
        h('span', null, `${t(result.stage === 'list' ? 'mcp_probeFailList' : 'mcp_probeFailConnect')} · ${took}`)),
      result.message ? h(McpErrorText, { t, text: mcpStr(result.message) }) : null,
      unclosed);
  }
  const names = mcpArr(result.toolNames);
  const info = mcpObject(result.serverInfo);
  const identity = [mcpStr(info.name), mcpStr(info.version)].filter(Boolean).join(' ');
  return h('div', { className: `${PREFIX}-mcp-probe`, 'data-tone': 'success', role: 'status' },
    h('div', { className: `${PREFIX}-mcp-probe-head` }, Icon.check(14),
      h('span', null, [t('mcp_probeOk'), identity, mcpCount(t, 'mcp_probeTools', names.length), took].filter(Boolean).join(' · '))),
    names.length ? h('ul', { className: `${PREFIX}-mcp-chips` }, names.map((name) => h('li', { key: name, className: `${PREFIX}-mcp-chip` }, name))) : null,
    result.truncated ? h('p', { className: `${PREFIX}-mcp-probe-note` }, t('mcp_probeTruncated')) : null,
    unclosed);
}

function McpStatusBlock({ api, server, info, now, auth }) {
  const { t } = api;
  const status = server.status;
  const retryButton = (labelKey) => h(Button, {
    size: 'sm', icon: Icon.refresh(12), busy: server.busy === 'restart', disabled: Boolean(server.busy),
    onClick: () => api.restart(server.name),
  }, t(labelKey));
  if (!server.enabled) return h('p', { className: `${PREFIX}-mcp-status-line` }, t('mcp_disabledLine'));
  if (!mcpIsObject(status) || info.tone === 'busy') {
    const waiting = info.tone === 'busy' || info.label === 'mcp_stLoading';
    return h('p', { className: `${PREFIX}-mcp-status-line`, role: 'status' }, waiting ? h(Spinner, { size: 12 }) : null, mcpStatusLabel(t, info));
  }
  if (status.state === 'connected') {
    const n = Number(status.toolCount) || 0;
    const ago = typeof status.connectedAt === 'number' ? formatAgo(status.connectedAt, now, t) : t('c_justNow');
    return h('p', { className: `${PREFIX}-mcp-status-line` }, h(StatusDot, { tone: 'success' }),
      fill(t(n === 1 ? 'mcp_connectedLineOne' : 'mcp_connectedLine'), { n, ago }));
  }
  if (info.kind === 'auth') {
    const text = mcpErrorSummary(t, info);
    if (server.authMode === 'oauth') {
      return h(Alert, {
        tone: 'warn', title: t('mcp_authNeeded'),
        actions: h(Button, {
          variant: 'primary', size: 'sm', icon: Icon.lock(12), busy: auth?.busy === 'start' || auth?.busy === 'header', disabled: Boolean(auth?.busy),
          onClick: () => api.startAuth(server.name),
        }, t('mcp_authorize')),
      }, auth?.error ? h('span', { role: 'alert', className: `${PREFIX}-mcp-auth-error` }, mcpMessage(t, auth.error)) : null);
    }
    return h(Alert, {
      tone: 'warn', title: t(server.authMode === 'token' ? 'mcp_authTokenOnly' : 'mcp_authReadOnly'),
      actions: retryButton('mcp_retry'),
    }, text ? h(McpErrorText, { t, text }) : null);
  }
  if (!info.block) {
    return h('div', { className: `${PREFIX}-mcp-status-line` },
      h('span', null, info.closed ? t('mcp_closedLine') : mcpStatusLabel(t, info)), retryButton('mcp_restart'));
  }
  let title = mcpStatusLabel(t, info);
  let action = 'mcp_restart';
  if (info.kind === 'retrying') {
    const seconds = Math.ceil((Number(info.nextAt) - now) / 1000);
    title = seconds > 0 ? fill(t('mcp_autoRetryIn'), { s: seconds }) : t('mcp_autoRetryNow');
    action = 'mcp_retryNow';
  } else if (info.kind === 'gave-up') {
    title = fill(t('mcp_gaveUpLine'), { n: info.attempts });
    action = 'mcp_retry';
  } else if (info.kind === 'failed') {
    title = t('mcp_failedManual');
    action = 'mcp_retry';
  } else if (info.kind === 'dsh-retrying' && typeof info.nextAt === 'number') {
    const seconds = Math.ceil((info.nextAt - now) / 1000);
    if (seconds > 0 && seconds < 3600) title = `${title} · ${fill(t('mcp_retryIn'), { s: seconds })}`;
  }
  const text = mcpErrorSummary(t, info);
  return h(Alert, {
    tone: info.tone === 'error' ? 'error' : 'warn', title,
    actions: retryButton(action),
  }, text ? h(McpErrorText, { t, text }) : null);
}

/**
 * The authorization flow in the detail's status area: client ID entry when the
 * server needs one, the pending flow (reopen link, cancel, paste-the-callback),
 * token exchange, and a failed flow.
 */
function McpAuthFlowPanel({ api, server, auth }) {
  const { t } = api;
  const name = server.name;
  const id = mcpDomId(useId());
  const flow = auth.flow;
  const error = auth.error ? h('p', { className: `${PREFIX}-field-error`, role: 'alert' }, mcpMessage(t, auth.error)) : null;
  const active = flow && (flow.status === 'pending' || flow.status === 'exchanging');
  if (auth.clientRequired && !active) {
    const submit = (event) => { if (event.key === 'Enter') { event.preventDefault(); api.startAuth(name); } };
    return h(Alert, {
      tone: 'info', title: t('mcp_authClientRequired'),
      actions: h(Fragment, null,
        h(Button, { variant: 'primary', size: 'sm', icon: Icon.lock(12), busy: auth.busy === 'start', disabled: Boolean(auth.busy), onClick: () => api.startAuth(name) }, t('mcp_authorize')),
        h(Button, { size: 'sm', disabled: Boolean(auth.busy), onClick: () => api.cancelAuth(name) }, t('c_cancel'))),
    },
    h('div', { className: `${PREFIX}-mcp-auth-fields` },
      h(Field, { label: t('mcp_clientId'), htmlFor: `${id}-cid`, required: true, t },
        h(TextInput, { id: `${id}-cid`, mono: true, value: auth.clientId, autoFocus: true, onValue: (value) => api.setAuthField(name, 'clientId', value), onKeyDown: submit })),
      h(Field, { label: t('mcp_clientSecret'), htmlFor: `${id}-cs`, t },
        h(TextInput, { id: `${id}-cs`, mono: true, type: 'password', autoComplete: 'new-password', value: auth.clientSecret, onValue: (value) => api.setAuthField(name, 'clientSecret', value), onKeyDown: submit }))),
    error);
  }
  if (!flow) return null;
  if (flow.status === 'error') {
    return h(Alert, {
      tone: 'error', title: fill(t('mcp_authFlowError'), { reason: flow.error || t('c_unknownError') }),
      actions: h(Button, { variant: 'primary', size: 'sm', icon: Icon.lock(12), busy: auth.busy === 'start', disabled: Boolean(auth.busy), onClick: () => api.startAuth(name) }, t('mcp_reauthorize')),
    }, error);
  }
  if (flow.status === 'exchanging') {
    return h('p', { className: `${PREFIX}-mcp-status-line`, role: 'status' }, h(Spinner, { size: 12 }), t('mcp_authExchanging'));
  }
  if (flow.status !== 'pending') return null;
  const issuer = mcpObject(server.host.auth).issuer || mcpUrlHost(flow.authUrl);
  // Actions sit right under the message; the paste-the-callback fallback comes last.
  return h(Alert, { tone: 'info', title: fill(t('mcp_authOpened'), { issuer }) },
    h('div', { className: `${PREFIX}-mcp-auth-pending` },
      h('div', { className: `${PREFIX}-alert-actions` },
        flow.authUrl ? h('a', {
          className: cx(`${PREFIX}-btn`, `${PREFIX}-mcp-link-btn`), 'data-variant': 'secondary', 'data-size': 'sm',
          href: flow.authUrl, target: '_blank', rel: 'noopener noreferrer',
        }, Icon.globe(12), h('span', null, t('mcp_authReopen'))) : null,
        h(Button, { size: 'sm', busy: auth.busy === 'cancel', disabled: Boolean(auth.busy), onClick: () => api.cancelAuth(name) }, t('c_cancel'))),
  h(Disclosure, { title: t('mcp_authNoRedirect') },
    h('p', { className: `${PREFIX}-mcp-detect` }, fill(t('mcp_authCallbackHint'), { redirect: flow.redirectUri || 'http://localhost' })),
    h('div', { className: `${PREFIX}-mcp-auth-callback` },
      h(TextInput, {
        mono: true, value: auth.callbackUrl, placeholder: `${flow.redirectUri || 'http://localhost'}?code=…`, 'aria-label': t('mcp_authCallbackLabel'),
        onValue: (value) => api.setAuthField(name, 'callbackUrl', value),
        onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); api.completeAuth(name); } },
      }),
      h(Button, { size: 'sm', busy: auth.busy === 'complete', disabled: Boolean(auth.busy), onClick: () => api.completeAuth(name) }, t('mcp_authComplete')))),
  error));
}

/** 授权 section of an authorized server: who, how long, re-authorize / sign out. */
function McpAuthSection({ api, server, auth, now }) {
  const { t } = api;
  const headingId = `${mcpDomId(useId())}-auth`;
  const grant = mcpObject(server.host.auth);
  const issuer = mcpStr(grant.issuer);
  const busy = Boolean(auth?.busy);
  const actions = h(Fragment, null,
    h(Button, { size: 'sm', icon: Icon.lock(12), busy: auth?.busy === 'start', disabled: busy, onClick: () => api.startAuth(server.name) }, t('mcp_reauthorize')),
    h(Button, { size: 'sm', variant: 'ghost', busy: auth?.busy === 'forget', disabled: busy, onClick: () => api.forgetAuth(server.name) }, t('mcp_signOut')));
  let body;
  if (grant.state === 'expired' || grant.state === 'error') {
    body = h(Alert, {
      tone: 'warn',
      title: grant.state === 'expired' ? t('mcp_authExpired') : fill(t('mcp_authErrorState'), { reason: mcpStr(grant.error) || t('c_unknownError') }),
      actions,
    }, issuer ? fill(t('mcp_authIssuer'), { issuer }) : null);
  } else {
    const until = mcpUntil(grant.expiresAt, now);
    const unit = until ? fill(t(until.unit === 'min' ? 'mcp_durMin' : until.unit === 'hour' ? 'mcp_durHour' : 'mcp_durDay'), { n: until.n }) : '';
    let expiry = '';
    if (typeof grant.expiresAt === 'number') {
      if (!until) expiry = grant.canRefresh ? t('mcp_authRenewing') : t('mcp_authExpired');
      else expiry = fill(t(grant.canRefresh ? 'mcp_authExpiresRefresh' : 'mcp_authExpiresManual'), { time: unit });
    } else if (!grant.canRefresh) {
      expiry = t('mcp_authNoRefresh');
    }
    body = h('div', { className: `${PREFIX}-mcp-auth-line` },
      h('span', { className: `${PREFIX}-mcp-status-line` }, h(StatusDot, { tone: 'success' }),
        h('span', null, [fill(t('mcp_authOk'), { issuer: issuer || '—' }), expiry].filter(Boolean).join(' · '))),
      h('span', { className: `${PREFIX}-actions-end` }, actions));
  }
  return h('section', { className: `${PREFIX}-section`, 'aria-labelledby': headingId },
    h(SectionHeading, { id: headingId, title: t('mcp_authSection') }),
    body);
}

function McpToolsSection({ api, server, state }) {
  const { t } = api;
  const headingId = `${mcpDomId(useId())}-tools`;
  const [filter, setFilter] = useState('');
  const status = server.status;
  const name = server.name;
  const connected = server.enabled && mcpIsObject(status) && status.state === 'connected';
  const key = connected ? `${status.connectedAt}:${status.toolCount}` : null;
  useEffect(() => { if (key) api.loadTools(name, key); }, [name, key]);
  const entry = state.tools[name];
  const probe = state.probes[name];
  let count;
  let body;
  if (connected) {
    count = entry?.status === 'ready' ? entry.items.length : Number(status.toolCount) || 0;
    if (!entry || (entry.status === 'loading' && !entry.items.length)) {
      body = h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-mcp-tool-skeleton`), 'aria-busy': 'true', 'aria-label': t('c_loading') });
    } else if (entry.status === 'error') {
      body = h(LoadError, { message: entry.error, onRetry: () => api.loadTools(name, key, true), t });
    } else {
      const items = entry.items;
      const query = filter.trim().toLowerCase();
      const shown = query ? items.filter((tool) => tool.name.toLowerCase().includes(query) || mcpStr(tool.description).toLowerCase().includes(query)) : items;
      body = h(Fragment, null,
        items.length > 8 ? h(SearchInput, { value: filter, onValue: setFilter, placeholder: t('mcp_toolsFilter'), t }) : null,
        items.length === 0 ? h('p', { className: `${PREFIX}-mcp-empty-note` }, t('mcp_toolsEmpty'))
          : shown.length === 0 ? h('p', { className: `${PREFIX}-mcp-empty-note`, role: 'status' }, t('mcp_toolsNoMatch'))
            : h('ul', { className: `${PREFIX}-mcp-tools` }, shown.map((tool) => {
              const line = mcpFirstLine(tool.description);
              return h('li', { key: tool.name, className: `${PREFIX}-mcp-tool` },
                h('span', { className: cx(`${PREFIX}-mcp-tool-name`, `${PREFIX}-mono`) }, tool.name),
                line ? h('span', { className: `${PREFIX}-mcp-tool-desc`, title: mcpStr(tool.description) }, line) : null);
            })));
    }
  } else {
    body = h('div', { className: `${PREFIX}-mcp-tools-empty` },
      h('span', { className: `${PREFIX}-mcp-empty-note` }, t('mcp_toolsHint')),
      h(Button, { size: 'sm', icon: Icon.play(12), busy: probe?.status === 'running', onClick: () => api.probe(name) }, t('mcp_test')));
  }
  return h('section', { className: `${PREFIX}-section`, 'aria-labelledby': headingId },
    h(SectionHeading, { id: headingId, title: t('mcp_tools'), count }),
    body,
    probe ? h(McpProbeResult, { t, probe }) : null);
}

function McpDetailView({ api, state, name }) {
  const { t } = api;
  const server = state.servers.find((item) => item.name === name);
  // Countdowns tick every second only while a retry is scheduled.
  const ticking = server?.info?.kind === 'retrying' || server?.info?.kind === 'dsh-retrying';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : 15000);
    return () => clearInterval(timer);
  }, [ticking]);
  const configHeading = `${mcpDomId(useId())}-config`;
  const back = h(BackBar, { label: t('mcp_title'), onBack: api.back, t });
  if (!server) {
    return h(Fragment, null, back, h(DetailTitle, { title: name }),
      state.justAdded === name
        ? h('div', { className: `${PREFIX}-skeleton`, 'aria-busy': 'true', 'aria-label': t('c_loading') })
        : h('p', { className: `${PREFIX}-mcp-empty-note` }, t('mcp_notFound')));
  }
  const info = server.info;
  const auth = state.auth[name] ?? {};
  const flow = auth.flow;
  const flowShown = Boolean(flow && (flow.status === 'pending' || flow.status === 'exchanging' || flow.status === 'error'));
  const panel = flowShown || (auth.clientRequired && server.enabled) ? h(McpAuthFlowPanel, { api, server, auth }) : null;
  // The flow panel replaces the "needs authorization" alert; on a working server it sits under the status line.
  const authErrorShown = Boolean(panel) || (info.kind === 'auth' && server.authMode === 'oauth');
  const statusArea = panel && (info.kind === 'auth' || info.kind === 'auth-flow')
    ? panel
    : h(Fragment, null, h(McpStatusBlock, { api, server, info, now, auth }), panel,
      !authErrorShown && auth.error ? h('p', { className: `${PREFIX}-field-error`, role: 'alert' }, mcpMessage(t, auth.error)) : null);
  const draft = state.draft && state.draft.mode === 'edit' && state.draft.target === name ? state.draft : null;
  const writable = state.config.writable;
  const inherited = server.origin === 'inherited' || server.origin === 'overridden';
  const subtitle = [
    server.transport ? t(server.transport === 'stdio' ? 'mcp_subLocal' : 'mcp_subRemote') : null,
    mcpOriginLabel(t, server.origin),
  ].filter(Boolean).join(' · ');
  let configBody;
  if (server.origin === 'plugin') configBody = h('p', { className: `${PREFIX}-mcp-empty-note` }, t('mcp_pluginNote'));
  else if (server.readOnly) configBody = h('p', { className: `${PREFIX}-mcp-empty-note` }, t('mcp_exprNote'));
  else if (!draft) configBody = h('div', { className: `${PREFIX}-skeleton`, 'aria-busy': 'true', 'aria-label': t('c_loading') });
  else {
    configBody = h(Fragment, null,
      inherited ? h(Alert, {
        tone: 'info',
        actions: server.origin === 'overridden' && writable ? h(Button, {
          size: 'sm', busy: server.busy === 'restore', disabled: Boolean(server.busy), onClick: () => api.restoreDefault(name),
        }, t('mcp_restore')) : null,
      }, t('mcp_inheritedNote')) : null,
      !writable ? h(Alert, { tone: 'info' }, t('mcp_readOnlyConfig')) : null,
      h(McpServerForm, { api, state, draft, mode: 'edit' }));
  }
  const confirm = state.confirm && state.confirm.name === name ? state.confirm : null;
  return h(Fragment, null,
    back,
    h(DetailTitle, {
      title: name,
      subtitle: subtitle || undefined,
      trailing: server.origin === 'plugin' ? null : h(Switch, {
        checked: server.enabled, busy: server.pending, disabled: server.pending || !writable,
        label: fill(t('mcp_enable'), { name }), onChange: (next) => api.toggleEnabled(name, next),
      }),
    }),
    h(McpNotice, { api, notice: state.notice }),
    statusArea,
    h(McpToolsSection, { api, server, state }),
    server.transport === 'streamable-http' && mcpIsObject(server.host.auth) ? h(McpAuthSection, { api, server, auth, now }) : null,
    h('section', { className: `${PREFIX}-section`, 'aria-labelledby': configHeading },
      h(SectionHeading, { id: configHeading, title: t('mcp_config') }),
      configBody),
    server.origin === 'user' && writable ? h('section', { className: cx(`${PREFIX}-section`, `${PREFIX}-mcp-danger`) },
      h(Button, { variant: 'danger', icon: Icon.trash(14), onClick: () => api.askDelete(name) }, t('mcp_delete'))) : null,
    h(ConfirmDialog, {
      open: Boolean(confirm),
      title: fill(t('mcp_deleteTitle'), { name }),
      body: t('mcp_deleteBody'),
      confirmLabel: t('mcp_deleteConfirm'),
      cancelLabel: t('c_cancel'),
      danger: true,
      busy: Boolean(confirm?.busy),
      error: confirm?.error ? mcpMessage(t, confirm.error) : null,
      onConfirm: api.confirmDelete,
      onCancel: api.cancelDelete,
    }));
}

// -- Section --------------------------------------------------------------------

/** Settings section for MCP servers. Props: `t`, the controller face, and `useMcp(selector)`. */
function McpSection(props) {
  const state = props.useMcp((snapshot) => snapshot);
  const watchRef = useRef(props.watch);
  watchRef.current = props.watch;
  useEffect(() => watchRef.current(), []);
  const view = state.view;
  let viewKey = 'list';
  let body;
  if (view.kind === 'detail') {
    viewKey = `detail:${view.name}`;
    body = h(McpDetailView, { api: props, state, name: view.name });
  } else if (view.kind === 'form' && state.draft && state.draft.mode === 'add') {
    viewKey = 'form';
    body = h(McpFormView, { api: props, state });
  } else if (view.kind === 'batch' && state.batch) {
    viewKey = 'batch';
    body = h(McpBatchView, { api: props, state });
  } else if (view.kind === 'add') {
    viewKey = 'add';
    body = h(McpAddView, { api: props, state });
  } else {
    body = h(McpListView, { api: props, state });
  }
  return h('div', { className: `${PREFIX}-root` }, h(Styles), h(ViewFrame, { viewKey }, body));
}
