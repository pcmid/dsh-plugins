// Pure helpers of client/10-mcp.js: shell words, paste detection, names,
// secrets, validation, the settings mutations a save produces, and the status
// mapping with the Host supervisor and OAuth state.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPart } from './load-part.mjs'

const m = loadPart(['10-mcp.js'], [
  'mcpShellSplit', 'mcpShellQuote', 'mcpShellJoin', 'mcpExtractEnv', 'mcpCommandFromText',
  'mcpStripJsonc', 'mcpParseJsonLoose', 'mcpParsePaste',
  'mcpNormalizeName', 'mcpTypeName', 'mcpUniqueName', 'mcpNameFromCommand', 'mcpNameFromUrl',
  'mcpIsSecretKey', 'mcpCredentialRef', 'mcpRefPrefix', 'mcpSoleCredential', 'mcpTemplateProblem', 'mcpTemplateRefs', 'mcpEntryRefs',
  'mcpMapPlaceholder', 'mcpSecToMs', 'mcpMsToSec',
  'mcpDraftFromParsed', 'mcpDraftFromEntry', 'mcpEmptyDraft', 'mcpDraftSignature', 'mcpValidateDraft',
  'mcpPlanSecrets', 'mcpDraftToEntry', 'mcpCompactEntry', 'mcpEntryOps', 'mcpSettleDraft', 'mcpScrubDraft',
  'mcpAdvancedSummary', 'mcpStatusInfo', 'mcpBatchProblem',
  'mcpIsAuthError', 'mcpOAuthRef', 'mcpOAuthTemplate', 'mcpIsOAuthHeader', 'mcpEntryUsesOAuth', 'mcpAuthHeaderOps', 'mcpMergeFlow', 'mcpUntil',
])

// Values cross the VM boundary; compare them as plain JSON.
const plain = value => JSON.parse(JSON.stringify(value))
const words = text => plain(m.mcpShellSplit(text).words)

test('shell split: quotes, escapes, continuations, comments', () => {
  assert.deepEqual(words('npx -y @modelcontextprotocol/server-github'), ['npx', '-y', '@modelcontextprotocol/server-github'])
  assert.deepEqual(words(`node '/Users/me/My Files/server.js' --name "a \\"b\\" c"`), ['node', '/Users/me/My Files/server.js', '--name', 'a "b" c'])
  assert.deepEqual(words('echo a\\ b'), ['echo', 'a b'])
  assert.deepEqual(words('npx -y \\\n  @scope/pkg \\\r\n  --flag'), ['npx', '-y', '@scope/pkg', '--flag'])
  assert.deepEqual(words('cmd "multi\\\nline"'), ['cmd', 'multiline'])
  assert.deepEqual(words("say 'it''s'"), ['say', 'its'])
  assert.deepEqual(words('run "" x'), ['run', '', 'x'])
  assert.deepEqual(words('run # trailing comment\nnext'), ['run', 'next'])
  assert.deepEqual(words('C:\\Tools\\server.exe --stdio'), ['C:\\Tools\\server.exe', '--stdio'])
  assert.deepEqual(words('a\u00a0b'), ['a', 'b'])
  assert.equal(m.mcpShellSplit("bad 'quote").error, 'quote')
  assert.deepEqual(plain(m.mcpShellSplit('one\ntwo three').lines), [['one'], ['two', 'three']])
})

test('shell quote / join round-trips', () => {
  assert.equal(m.mcpShellQuote('plain-arg_1.0'), 'plain-arg_1.0')
  assert.equal(m.mcpShellQuote(''), "''")
  assert.equal(m.mcpShellQuote('has space'), "'has space'")
  assert.equal(m.mcpShellQuote("it's"), `"it's"`)
  assert.equal(m.mcpShellQuote('${credential:X}'), "'${credential:X}'")
  const samples = [
    ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/Users/me/My Documents'],
    ['node', "it's \"quoted\" $HOME `x`", '', 'C:\\Path With\\Spaces', '--opt=a b'],
    ['FOO=bar', 'x'],
    ['uvx', 'line\nbreak', '~/x', '#hash', 'tab\there'],
  ]
  for (const sample of samples) assert.deepEqual(words(m.mcpShellJoin(sample)), sample)
})

test('env extraction and command blocks', () => {
  assert.deepEqual(plain(m.mcpExtractEnv(['A=1', 'B=x=y', 'npx', 'C=3'])), { env: [['A', '1'], ['B', 'x=y']], words: ['npx', 'C=3'] })
  assert.deepEqual(plain(m.mcpExtractEnv(['env', 'A=1', 'run'])), { env: [['A', '1']], words: ['run'] })
  const block = m.mcpCommandFromText('export GITHUB_TOKEN=abc\n$ TOKEN2=def npx -y @x/server-y')
  assert.deepEqual(plain(block), { env: [['GITHUB_TOKEN', 'abc'], ['TOKEN2', 'def']], words: ['npx', '-y', '@x/server-y'] })
  assert.equal(m.mcpCommandFromText('bad "quote'), null)
})

test('JSONC cleanup', () => {
  const text = `{
    // line comment with "quote"
    "a": "http://x//not-a-comment", /* block */
    "b": [1, 2,],
  }`
  assert.deepEqual(JSON.parse(m.mcpStripJsonc(text)), { a: 'http://x//not-a-comment', b: [1, 2] })
  assert.deepEqual(plain(m.mcpParseJsonLoose('"gh": { "command": "npx" },')).value, { gh: { command: 'npx' } })
  assert.ok(m.mcpParseJsonLoose('{ "a": ').error)
})

test('names: normalize, type, unique', () => {
  assert.equal(m.mcpNormalizeName('My Server!!'), 'my-server')
  assert.equal(m.mcpNormalizeName('--__x__--'), 'x')
  assert.equal(m.mcpNormalizeName('a'.repeat(40)), 'a'.repeat(32))
  assert.equal(m.mcpTypeName('My-'), 'my-')
  assert.equal(m.mcpUniqueName('github', ['github']), 'github-2')
  assert.equal(m.mcpUniqueName('github', ['github', 'github-2']), 'github-3')
  assert.equal(m.mcpUniqueName('a'.repeat(32), ['a'.repeat(32)]), `${'a'.repeat(30)}-2`)
  assert.equal(m.mcpUniqueName('fresh', new Set(['other'])), 'fresh')
  assert.equal(m.mcpUniqueName('', []), 'server')
})

test('names derived from commands and URLs', () => {
  const cases = {
    'npx -y @modelcontextprotocol/server-github': 'github',
    'uvx mcp-server-fetch': 'fetch',
    'uvx xxx-mcp': 'xxx',
    'npx -y firecrawl-mcp': 'firecrawl',
    'npx -y @upstash/context7-mcp@latest': 'context7',
    'npx -y @playwright/mcp@latest': 'playwright',
    'docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server': 'github',
    'node /path/to/tiny-mcp.mjs workspace-tools': 'tiny',
    'python -m mcp_server_time': 'time',
    'github-mcp-server stdio': 'github',
    'uvx --from git+https://github.com/oraios/serena serena start-mcp-server': 'serena',
    'npx -y mcp-remote https://mcp.linear.app/sse': 'linear',
    'pnpm dlx @scope/server-weather': 'weather',
  }
  for (const [command, name] of Object.entries(cases)) assert.equal(m.mcpNameFromCommand(words(command)), name, command)
  assert.equal(m.mcpNameFromUrl('https://mcp.notion.com/mcp'), 'notion')
  assert.equal(m.mcpNameFromUrl('https://api.githubcopilot.com/mcp/'), 'githubcopilot')
  assert.equal(m.mcpNameFromUrl('http://localhost:3000/mcp'), 'localhost')
  assert.equal(m.mcpNameFromUrl('http://127.0.0.1:8080/mcp'), 'local')
})

test('paste: command with leading env and secret detection', () => {
  const result = plain(m.mcpParsePaste('GITHUB_TOKEN=ghp_123 DEBUG=1 npx -y @modelcontextprotocol/server-github', ['github']))
  assert.equal(result.kind, 'command')
  assert.equal(result.label, 'npx')
  assert.equal(result.servers.length, 1)
  const [server] = result.servers
  assert.equal(server.name, 'github-2')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.command, 'npx')
  assert.deepEqual(server.args, ['-y', '@modelcontextprotocol/server-github'])
  assert.deepEqual(server.env, { GITHUB_TOKEN: 'ghp_123', DEBUG: '1' })
  const draft = plain(m.mcpDraftFromParsed(server))
  assert.equal(draft.commandLine, 'npx -y @modelcontextprotocol/server-github')
  assert.deepEqual(draft.env.map(row => [row.key, row.secret]), [['GITHUB_TOKEN', true], ['DEBUG', false]])
})

test('paste: URL and unknown text', () => {
  const url = plain(m.mcpParsePaste('https://mcp.notion.com/mcp'))
  assert.equal(url.kind, 'url')
  assert.equal(url.label, 'mcp.notion.com')
  assert.equal(url.servers[0].name, 'notion')
  assert.equal(url.servers[0].transport, 'streamable-http')
  assert.equal(m.mcpParsePaste('   ').kind, 'empty')
  assert.equal(m.mcpParsePaste('{ broken').kind, 'unknown')
  assert.equal(m.mcpParsePaste('{ broken').json, true)
  assert.equal(m.mcpParsePaste('a "b').kind, 'unknown')
  assert.equal(m.mcpParsePaste('{"x": 1}').kind, 'json')
  assert.equal(m.mcpParsePaste('{"x": 1}').servers.length, 0)
})

test('paste: JSON container shapes', () => {
  const body = { command: 'npx', args: ['-y', 'a-mcp'] }
  const shapes = [
    { mcpServers: { one: body, two: { url: 'https://two.dev/mcp' } } },
    { mcp: { servers: { one: body, two: { url: 'https://two.dev/mcp' } } } },
    { servers: { one: body, two: { type: 'http', url: 'https://two.dev/mcp' } } },
    { one: body, two: { serverUrl: 'https://two.dev/mcp' } },
  ]
  for (const shape of shapes) {
    const result = plain(m.mcpParsePaste(JSON.stringify(shape), ['one']))
    assert.equal(result.kind, 'json')
    assert.deepEqual(result.servers.map(s => [s.name, s.transport]), [['one', 'stdio'], ['two', 'streamable-http']], JSON.stringify(shape))
  }
  // A single unnamed config gets a derived name, renamed away from existing names.
  const single = plain(m.mcpParsePaste('{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_TOKEN": ""}}', ['github']))
  assert.equal(single.servers.length, 1)
  assert.equal(single.servers[0].name, 'github-2')
  const remote = plain(m.mcpParsePaste('{"url": "https://mcp.notion.com/mcp", "headers": {"Authorization": "Bearer x"}}'))
  assert.equal(remote.servers[0].name, 'notion')
  assert.deepEqual(remote.servers[0].headers, { Authorization: 'Bearer x' })
  // JSONC with comments and trailing commas.
  const jsonc = plain(m.mcpParsePaste('{\n  // servers\n  "mcpServers": {\n    "fs": { "command": "npx", "args": ["-y", "x",], },\n  },\n}'))
  assert.deepEqual(jsonc.servers.map(s => s.name), ['fs'])
})

test('paste: type / transport variants and SSE warning', () => {
  const types = { stdio: 'stdio', http: 'streamable-http', 'streamable-http': 'streamable-http', streamableHttp: 'streamable-http', sse: 'streamable-http' }
  for (const [type, transport] of Object.entries(types)) {
    const raw = transport === 'stdio' ? { type, command: 'srv' } : { type, url: 'https://x.dev/mcp' }
    const result = plain(m.mcpParsePaste(JSON.stringify({ mcpServers: { s: raw } })))
    assert.equal(result.servers[0].transport, transport, type)
    assert.deepEqual(result.warnings, type === 'sse' ? ['sse'] : [], type)
  }
  const viaTransport = plain(m.mcpParsePaste(JSON.stringify({ transport: 'streamable-http', url: 'https://a.dev/mcp' })))
  assert.equal(viaTransport.servers[0].transport, 'streamable-http')
  // OpenCode style: command array, environment, type local / remote.
  const opencode = plain(m.mcpParsePaste(JSON.stringify({ mcp: { gh: { type: 'local', command: ['npx', '-y', 'gh-mcp'], environment: { A: '1' } }, r: { type: 'remote', url: 'https://r.dev/mcp' } } })))
  assert.deepEqual(opencode.servers.map(s => [s.name, s.transport, s.command, s.args]), [['gh', 'stdio', 'npx', ['-y', 'gh-mcp']], ['r', 'streamable-http', '', []]])
  assert.deepEqual(opencode.servers[0].env, { A: '1' })
  // A command string with spaces and no args is split.
  const inline = plain(m.mcpParsePaste('{"command": "npx -y foo-mcp"}'))
  assert.deepEqual([inline.servers[0].command, inline.servers[0].args, inline.servers[0].name], ['npx', ['-y', 'foo-mcp'], 'foo'])
})

test('paste: placeholders become credentials or blanks to fill', () => {
  assert.deepEqual(plain(m.mcpMapPlaceholder('${GITHUB_TOKEN}')), { value: '${credential:GITHUB_TOKEN}' })
  assert.deepEqual(plain(m.mcpMapPlaceholder('${env:API_KEY}')), { value: '${credential:API_KEY}' })
  assert.deepEqual(plain(m.mcpMapPlaceholder('Bearer ${TOKEN}')), { value: 'Bearer ${credential:TOKEN}' })
  assert.deepEqual(plain(m.mcpMapPlaceholder('$TOKEN')), { value: '${credential:TOKEN}' })
  assert.deepEqual(plain(m.mcpMapPlaceholder('${input:api_key}')), { value: '', placeholder: true, example: '${input:api_key}' })
  assert.deepEqual(plain(m.mcpMapPlaceholder('<YOUR_TOKEN>')), { value: '', placeholder: true, example: '<YOUR_TOKEN>' })
  assert.deepEqual(plain(m.mcpMapPlaceholder('plain')), { value: 'plain' })
  const result = plain(m.mcpParsePaste(JSON.stringify({ mcpServers: { gh: { command: 'npx', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', KEY: '<your-key>' } } } })))
  const draft = plain(m.mcpDraftFromParsed(result.servers[0]))
  assert.deepEqual(draft.env.map(row => [row.key, row.value, row.secret, row.ref, row.example]), [
    ['GITHUB_TOKEN', '', true, 'GITHUB_TOKEN', ''],
    ['KEY', '', true, null, '<your-key>'],
  ])
})

test('paste: claude / codex mcp add', () => {
  const http = plain(m.mcpParsePaste('claude mcp add --transport http notion https://mcp.notion.com/mcp'))
  assert.deepEqual([http.kind, http.servers[0].name, http.servers[0].transport, http.servers[0].url], ['url', 'notion', 'streamable-http', 'https://mcp.notion.com/mcp'])
  const stdio = plain(m.mcpParsePaste('claude mcp add github -e GITHUB_TOKEN=abc -- npx -y @modelcontextprotocol/server-github'))
  assert.deepEqual([stdio.kind, stdio.servers[0].name, stdio.servers[0].command, stdio.servers[0].args], ['command', 'github', 'npx', ['-y', '@modelcontextprotocol/server-github']])
  assert.deepEqual(stdio.servers[0].env, { GITHUB_TOKEN: 'abc' })
  const header = plain(m.mcpParsePaste('claude mcp add -t http -H "Authorization: Bearer t" api https://api.dev/mcp'))
  assert.deepEqual(header.servers[0].headers, { Authorization: 'Bearer t' })
  const codex = plain(m.mcpParsePaste('codex mcp add docs --url https://docs.dev/mcp'))
  assert.deepEqual([codex.servers[0].name, codex.servers[0].url], ['docs', 'https://docs.dev/mcp'])
})

test('paste: several servers keep names (unique within the batch)', () => {
  const result = plain(m.mcpParsePaste(JSON.stringify({ mcpServers: { 'GitHub Server': { command: 'a' }, 'github-server': { command: 'b' } } }), ['github-server']))
  assert.deepEqual(result.servers.map(s => s.name), ['github-server', 'github-server-2'])
})

test('secret keys, credential refs, templates', () => {
  for (const key of ['GITHUB_TOKEN', 'API_KEY', 'CLIENT_SECRET', 'DB_PASSWORD', 'Authorization', 'X-Api-Key', 'GOOGLE_CREDENTIALS']) assert.ok(m.mcpIsSecretKey(key), key)
  for (const key of ['DEBUG', 'PORT', 'AUTH_URL', 'KEY_PATH', 'Content-Type']) assert.ok(!m.mcpIsSecretKey(key), key)
  assert.equal(m.mcpCredentialRef('github', 'GITHUB_TOKEN'), 'MCP_GITHUB_GITHUB_TOKEN')
  assert.equal(m.mcpCredentialRef('my-srv', 'x-api-key'), 'MCP_MY_SRV_X_API_KEY')
  assert.equal(m.mcpCredentialRef('a', 'k', ['MCP_A_K']), 'MCP_A_K_2')
  assert.equal(m.mcpCredentialRef('a', 'k', new Set(['MCP_A_K', 'MCP_A_K_2'])), 'MCP_A_K_3')
  assert.equal(m.mcpRefPrefix('my.srv'), 'MCP_MY_SRV_')
  assert.equal(m.mcpSoleCredential('${credential:ABC_1}'), 'ABC_1')
  assert.equal(m.mcpSoleCredential('Bearer ${credential:ABC}'), null)
  assert.equal(m.mcpTemplateProblem('Bearer ${credential:ABC}'), false)
  assert.equal(m.mcpTemplateProblem('${credential:1BAD}'), true)
  assert.equal(m.mcpTemplateProblem('${credential:OPEN'), true)
  assert.equal(m.mcpTemplateProblem('${credential:A} and ${credential:}'), true)
  assert.equal(m.mcpTemplateProblem('${OTHER}'), false)
  assert.deepEqual(plain(m.mcpTemplateRefs('${credential:A}:${credential:B}')), ['A', 'B'])
  assert.deepEqual([...m.mcpEntryRefs({ command: 'x', args: ['${credential:A}'], env: { K: '${credential:B}' }, headers: { H: 'Bearer ${credential:C}' }, url: '' })], ['A', 'B', 'C'])
})

test('timeouts: seconds ↔ milliseconds', () => {
  assert.equal(m.mcpSecToMs('60'), 60000)
  assert.equal(m.mcpSecToMs('2.5'), 2500)
  assert.equal(m.mcpSecToMs('0'), null)
  assert.equal(m.mcpSecToMs('-1'), null)
  assert.equal(m.mcpSecToMs('abc'), null)
  assert.equal(m.mcpSecToMs('9999999'), null)
  assert.equal(m.mcpMsToSec(2500), '2.5')
  assert.equal(m.mcpMsToSec(60000), '60')
})

test('validation mirrors the Host rules, first error first', () => {
  const draft = { ...m.mcpEmptyDraft(), name: 'Bad Name', commandLine: '' }
  let errors = plain(m.mcpValidateDraft(draft, { taken: [] }))
  assert.deepEqual(Object.keys(errors), ['name', 'command'])
  assert.equal(errors.name.key, 'mcp_errNameFormat')
  errors = plain(m.mcpValidateDraft({ ...draft, name: 'github', commandLine: 'npx x' }, { taken: ['github'] }))
  assert.deepEqual(errors, { name: { key: 'mcp_errNameTaken' } })
  errors = plain(m.mcpValidateDraft({ ...draft, name: 'ok', commandLine: 'npx "open' }))
  assert.equal(errors.command.key, 'mcp_errQuote')
  errors = plain(m.mcpValidateDraft({ ...draft, name: 'ok', transport: 'streamable-http', url: 'ftp://x' }))
  assert.equal(errors.url.key, 'mcp_errUrlFormat')
  const rows = [
    { id: 'a', key: '', value: 'v', secret: false, ref: null },
    { id: 'b', key: 'DUP', value: '${credential:9}', secret: false, ref: null },
    { id: 'c', key: 'DUP', value: '', secret: true, ref: null },
    { id: 'd', key: '', value: '', secret: false, ref: null },
  ]
  errors = plain(m.mcpValidateDraft({ ...draft, name: 'ok', commandLine: 'x', env: rows, startupSec: '0' }))
  assert.deepEqual(Object.keys(errors), ['env:a:key', 'env:b:value', 'env:c:key', 'env:c:value', 'startup'])
  assert.equal(errors['env:c:key'].key, 'mcp_errKeyDuplicate')
  assert.equal(errors['env:c:value'].key, 'mcp_errSecretRequired')
})

test('save: new server writes a complete, transport-only entry with secrets as templates', () => {
  const parsed = plain(m.mcpParsePaste('GITHUB_TOKEN=ghp_1 npx -y @modelcontextprotocol/server-github')).servers[0]
  const draft = m.mcpDraftFromParsed(parsed)
  draft.url = 'https://leftover.dev'
  draft.startupSec = '60'
  const plan = m.mcpPlanSecrets(draft, 'github', { reserved: ['MCP_GITHUB_GITHUB_TOKEN'] })
  assert.deepEqual(plain(plan.sets), [{ ref: 'MCP_GITHUB_GITHUB_TOKEN_2', value: 'ghp_1' }])
  const next = m.mcpDraftToEntry(draft, plan.templates)
  const ops = plain(m.mcpEntryOps('github', 'new', undefined, undefined, undefined, next, { enabled: true }))
  assert.deepEqual(ops, [{ op: 'set', path: ['servers', 'github'], value: {
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: '${credential:MCP_GITHUB_GITHUB_TOKEN_2}' }, startupTimeoutMs: 60000,
    reconnect: { enabled: false },
  } }])
  assert.ok(!JSON.stringify(ops).includes('ghp_1'))
  // HTTP entries carry no stdio fields; a disabled import stays disabled.
  const http = m.mcpDraftFromParsed(plain(m.mcpParsePaste('https://mcp.notion.com/mcp')).servers[0])
  http.commandLine = 'leftover'
  const httpEntry = plain(m.mcpCompactEntry(m.mcpDraftToEntry(http), { enabled: false }))
  assert.deepEqual(httpEntry, { transport: 'streamable-http', url: 'https://mcp.notion.com/mcp', enabled: false, reconnect: { enabled: false } })
})

test('save: user-added edit keeps closeTimeoutMs and its reconnect settings, with DSH reconnect off', () => {
  const entry = { transport: 'stdio', command: 'npx', args: ['a'], env: { TOKEN: '${credential:MCP_S_TOKEN}' }, cwd: '', url: '', headers: {}, enabled: true, startupTimeoutMs: 30000 }
  const draft = m.mcpDraftFromEntry('s', entry, 'user')
  assert.equal(draft.commandLine, 'npx a')
  assert.deepEqual(plain(draft.env.map(row => [row.key, row.value, row.secret, row.ref])), [['TOKEN', '', true, 'MCP_S_TOKEN']])
  assert.equal(m.mcpDraftSignature(draft), draft.baseline)
  draft.env = draft.env.map(row => ({ ...row, value: 'new-secret' }))
  draft.commandLine = 'npx b'
  const plan = m.mcpPlanSecrets(draft, 's', { credInfo: { MCP_S_TOKEN: { configured: true, writable: true } } })
  assert.deepEqual(plain(plan.sets), [{ ref: 'MCP_S_TOKEN', value: 'new-secret' }])
  const ops = plain(m.mcpEntryOps('s', 'user', entry, { ...entry, reconnect: { maxAttempts: 3 }, closeTimeoutMs: 900 }, undefined, m.mcpDraftToEntry(draft, plan.templates), { reconnect: { maxAttempts: 3 }, closeTimeoutMs: 900 }))
  assert.deepEqual(ops, [{ op: 'set', path: ['servers', 's'], value: {
    transport: 'stdio', command: 'npx', args: ['b'], env: { TOKEN: '${credential:MCP_S_TOKEN}' }, closeTimeoutMs: 900, reconnect: { maxAttempts: 3, enabled: false },
  } }])
  // A foreign or read-only reference is not overwritten: a fresh MCP_ ref takes the value.
  const foreign = m.mcpDraftFromEntry('s', { ...entry, env: { TOKEN: '${credential:SHARED}' } }, 'user')
  foreign.env = foreign.env.map(row => ({ ...row, value: 'v' }))
  assert.deepEqual(plain(m.mcpPlanSecrets(foreign, 's', { credInfo: { SHARED: { configured: true, writable: true } } }).sets), [{ ref: 'MCP_S_TOKEN', value: 'v' }])
  const settled = plain(m.mcpSettleDraft(foreign, m.mcpPlanSecrets(foreign, 's').templates))
  assert.deepEqual(settled.env.map(row => [row.value, row.ref]), [['', 'MCP_S_TOKEN']])
})

test('save: inherited edits write only changed paths', () => {
  const base = { transport: 'stdio', command: 'npx', args: ['srv'], env: { A: '1', B: '2' } }
  const current = { ...base, cwd: '', url: '', headers: {}, enabled: true, startupTimeoutMs: 30000 }
  const draft = m.mcpDraftFromEntry('srv', current, 'inherited', base)
  assert.deepEqual(plain(draft.env.map(row => row.locked)), [true, true])
  draft.env = [...draft.env.map(row => (row.key === 'A' ? { ...row, value: '9' } : row)), { id: 'n', key: 'C', value: '3', secret: false, ref: null }]
  draft.startupSec = '45'
  const ops = plain(m.mcpEntryOps('srv', 'inherited', current, undefined, base, m.mcpDraftToEntry(draft)))
  assert.deepEqual(ops, [
    { op: 'set', path: ['servers', 'srv', 'env', 'A'], value: '9' },
    { op: 'set', path: ['servers', 'srv', 'env', 'C'], value: '3' },
    { op: 'set', path: ['servers', 'srv', 'startupTimeoutMs'], value: 45000 },
    { op: 'set', path: ['servers', 'srv', 'reconnect', 'enabled'], value: false },
  ])
  // Removing a user-only key unsets it; clearing a user-only timeout unsets it, a base one resets to the default.
  const user = { env: { C: '3' }, toolCallTimeoutMs: 5000 }
  const overridden = { ...current, env: { A: '1', B: '2', C: '3' }, toolCallTimeoutMs: 5000 }
  const edit = m.mcpDraftFromEntry('srv', overridden, 'overridden', base)
  edit.env = edit.env.filter(row => row.key !== 'C')
  edit.toolCallSec = ''
  assert.deepEqual(plain(m.mcpEntryOps('srv', 'overridden', overridden, user, base, m.mcpDraftToEntry(edit))), [
    { op: 'unset', path: ['servers', 'srv', 'env', 'C'] },
    { op: 'unset', path: ['servers', 'srv', 'toolCallTimeoutMs'] },
    { op: 'set', path: ['servers', 'srv', 'reconnect', 'enabled'], value: false },
  ])
  // An override that already turned reconnect off is not written again.
  const off = { ...overridden, reconnect: { enabled: false, maxAttempts: 10 } }
  const edit3 = m.mcpDraftFromEntry('srv', off, 'overridden', base)
  edit3.cwd = '/w'
  assert.deepEqual(plain(m.mcpEntryOps('srv', 'overridden', off, user, base, m.mcpDraftToEntry(edit3))), [
    { op: 'set', path: ['servers', 'srv', 'cwd'], value: '/w' },
  ])
  const baseTimeout = { ...base, toolCallTimeoutMs: 5000 }
  const edit2 = m.mcpDraftFromEntry('srv', { ...current, toolCallTimeoutMs: 5000 }, 'inherited', baseTimeout)
  edit2.toolCallSec = ''
  assert.deepEqual(plain(m.mcpEntryOps('srv', 'inherited', { ...current, toolCallTimeoutMs: 5000 }, undefined, baseTimeout, m.mcpDraftToEntry(edit2))), [
    { op: 'set', path: ['servers', 'srv', 'toolCallTimeoutMs'], value: 60000 },
    { op: 'set', path: ['servers', 'srv', 'reconnect', 'enabled'], value: false },
  ])
  // Nothing changed → no ops.
  const same = m.mcpDraftFromEntry('srv', current, 'inherited', base)
  assert.deepEqual(plain(m.mcpEntryOps('srv', 'inherited', current, undefined, base, m.mcpDraftToEntry(same))), [])
})

test('batch import plans secrets for empty placeholders too', () => {
  const server = plain(m.mcpParsePaste(JSON.stringify({ mcpServers: { a: { command: 'x', env: { API_KEY: '${input:k}' } }, b: { command: 'y' } } }))).servers[0]
  const draft = m.mcpDraftFromParsed(server)
  const plan = m.mcpPlanSecrets(draft, 'a', { allowEmpty: true })
  assert.deepEqual(plain(plan.sets), [])
  assert.deepEqual(plain(m.mcpDraftToEntry(draft, plan.templates).env), { API_KEY: '${credential:MCP_A_API_KEY}' })
  assert.equal(m.mcpBatchProblem({ ...server, command: '' }, new Set()), 'mcp_problemCommand')
  assert.equal(m.mcpBatchProblem(server, new Set(['a'])), 'mcp_problemPlugin')
  assert.equal(m.mcpBatchProblem(server, new Set()), null)
})

test('scrubbing removes typed secret values only', () => {
  const draft = m.mcpEmptyDraft()
  draft.env = [{ id: 'a', key: 'T', value: 's3cret', secret: true, ref: null }, { id: 'b', key: 'P', value: 'plain', secret: false, ref: null }]
  assert.deepEqual(plain(m.mcpScrubDraft(draft).env.map(row => row.value)), ['', 'plain'])
})

test('advanced summary lists non-default values only', () => {
  const draft = m.mcpEmptyDraft()
  assert.deepEqual(plain(m.mcpAdvancedSummary(draft)), [])
  assert.deepEqual(plain(m.mcpAdvancedSummary({ ...draft, cwd: '~/proj', startupSec: '60', toolCallSec: '' })), [
    { key: 'mcp_sumCwd', values: { v: '~/proj' } },
    { key: 'mcp_sumStartup', values: { v: '60' } },
  ])
  assert.deepEqual(plain(m.mcpAdvancedSummary({ ...draft, startupSec: '30' })), [])
})

test('status presentation', () => {
  assert.equal(m.mcpStatusInfo({ state: 'connected', toolCount: 3, connectedAt: 1 }, true, 'ready').label, 'mcp_stConnected')
  assert.equal(m.mcpStatusInfo({ state: 'connected', toolCount: 3 }, false, 'ready').label, 'mcp_stDisabled')
  assert.equal(m.mcpStatusInfo({ state: 'disabled' }, true, 'ready').tone, 'busy')
  const failed = plain(m.mcpStatusInfo({ state: 'failed', reason: 'gave-up', lastError: 'boom' }, true, 'ready'))
  assert.deepEqual([failed.tone, failed.error, failed.errorKey, failed.summary], ['error', 'boom', 'mcp_errGaveUp', true])
  const cleanup = plain(m.mcpStatusInfo({ state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } }, true, 'ready'))
  assert.deepEqual([cleanup.error, cleanup.errorKey], [null, 'mcp_errCleanup'])
  assert.equal(m.mcpStatusInfo({ state: 'waiting-credentials', lastError: 'x' }, true, 'ready').tone, 'warn')
  assert.equal(m.mcpStatusInfo({ state: 'reconnecting', attempt: 2, maxAttempts: 5, nextRetryAtMs: 0, lastError: 'e' }, true, 'ready').values.attempt, 2)
  assert.equal(m.mcpStatusInfo(null, true, 'loading').label, 'mcp_stLoading')
  assert.equal(m.mcpStatusInfo(null, true, 'ready').label, 'mcp_stUnknown')
})

test('auth errors use the Host supervisor pattern', () => {
  for (const text of ['HTTP 401', 'Server returned 401 Unauthorized', 'requires authorization', 'unauthorised', 'error=invalid_token', 'Unauthorized'])
    assert.ok(m.mcpIsAuthError(text), text)
  for (const text of ['', 'ECONNREFUSED', 'HTTP 4010', 'port 14010', 'forbidden (403)', 'authorization_pending'])
    assert.ok(!m.mcpIsAuthError(text), text)
})

test('OAuth references, templates, and the managed Authorization header', () => {
  assert.equal(m.mcpOAuthRef('my-srv.1'), 'MCP_MY_SRV_1_OAUTH')
  assert.equal(m.mcpOAuthTemplate('notion'), 'Bearer ${credential:MCP_NOTION_OAUTH}')
  assert.ok(m.mcpIsOAuthHeader('notion', 'Authorization', 'Bearer ${credential:MCP_NOTION_OAUTH}'))
  assert.ok(m.mcpIsOAuthHeader('notion', 'authorization', 'Bearer ${credential:MCP_NOTION_OAUTH}'))
  assert.ok(m.mcpIsOAuthHeader('notion', 'Authorization', 'Bearer ${credential:HOST_GIVEN}', 'Bearer ${credential:HOST_GIVEN}'))
  assert.ok(!m.mcpIsOAuthHeader('notion', 'Authorization', 'Bearer ${credential:MCP_OTHER_OAUTH}'))
  assert.ok(!m.mcpIsOAuthHeader('notion', 'X-Auth', 'Bearer ${credential:MCP_NOTION_OAUTH}'))
  assert.ok(!m.mcpIsOAuthHeader('notion', 'Authorization', '${credential:MCP_NOTION_OAUTH}'))
  const http = { transport: 'streamable-http', url: 'https://n.dev/mcp', headers: { Authorization: 'Bearer ${credential:MCP_NOTION_OAUTH}' } }
  assert.ok(m.mcpEntryUsesOAuth('notion', http))
  assert.ok(!m.mcpEntryUsesOAuth('other', http))
  assert.ok(!m.mcpEntryUsesOAuth('notion', { ...http, transport: 'stdio' }))
  // The edit draft shows the managed header as a read-only row.
  const draft = plain(m.mcpDraftFromEntry('notion', { ...http, headers: { ...http.headers, 'X-Team': 'a' } }, 'user'))
  assert.deepEqual(draft.headers.map(row => [row.key, Boolean(row.oauth)]), [['Authorization', true], ['X-Team', false]])
  assert.deepEqual(plain(m.mcpValidateDraft(draft)), {})
})

test('authorization header writes: one batch with reconnect off, minimal for inherited entries', () => {
  const template = 'Bearer ${credential:MCP_N_OAUTH}'
  assert.deepEqual(plain(m.mcpAuthHeaderOps('n', { transport: 'streamable-http', url: 'u', headers: {}, reconnect: { enabled: true } }, template)), [
    { op: 'set', path: ['servers', 'n', 'headers', 'Authorization'], value: template },
    { op: 'set', path: ['servers', 'n', 'reconnect', 'enabled'], value: false },
  ])
  // An existing header keeps its spelling; reconnect already off is not rewritten.
  assert.deepEqual(plain(m.mcpAuthHeaderOps('n', { headers: { authorization: 'Bearer old' }, reconnect: { enabled: false } }, template)), [
    { op: 'set', path: ['servers', 'n', 'headers', 'authorization'], value: template },
  ])
  assert.deepEqual(plain(m.mcpAuthHeaderOps('n', { headers: { Authorization: template } }, template)), [])
  // Without a template from the Host the local naming is used.
  assert.equal(plain(m.mcpAuthHeaderOps('n', {}))[0].value, template)
})

test('flow merge and expiry wording', () => {
  const local = { flowId: 'f1', status: 'done', startedAt: 10 }
  assert.equal(m.mcpMergeFlow(local, { flowId: 'f1', status: 'pending', startedAt: 10 }).status, 'done')
  assert.equal(m.mcpMergeFlow({ ...local, status: 'pending' }, { flowId: 'f1', status: 'exchanging', startedAt: 10 }).status, 'exchanging')
  assert.equal(m.mcpMergeFlow(local, { flowId: 'f2', status: 'pending', startedAt: 20 }).flowId, 'f2')
  assert.equal(m.mcpMergeFlow(null, null), null)
  assert.deepEqual(plain(m.mcpUntil(1000 + 5 * 60000, 1000)), { unit: 'min', n: 5 })
  assert.deepEqual(plain(m.mcpUntil(3 * 3600000, 0)), { unit: 'hour', n: 3 })
  assert.deepEqual(plain(m.mcpUntil(5 * 86400000, 0)), { unit: 'day', n: 5 })
  assert.equal(m.mcpUntil(0, 1000), null)
  assert.equal(m.mcpUntil(undefined, 0), null)
})

test('status mapping with the Host supervisor and authorization (auth-retry §5)', () => {
  const failed = (lastError) => ({ state: 'failed', reason: 'reconnect-disabled', lastError })
  const info = (status, extra, enabled = true) => plain(m.mcpStatusInfo(status, enabled, 'ready', extra))
  // Scheduled automatic reconnect.
  let i = info(failed('socket hang up'), { host: { armed: true, retry: { attempt: 2, max: 10, nextAt: 5000, lastError: 'x' } } })
  assert.deepEqual([i.kind, i.tone, i.label, i.values, i.nextAt, i.error], ['retrying', 'warn', 'mcp_stAutoRetry', { attempt: 2, max: 10 }, 5000, 'socket hang up'])
  // Gave up.
  i = info(failed('boom'), { host: { armed: false, gaveUp: { attempts: 10, at: 1 } } })
  assert.deepEqual([i.kind, i.tone, i.label, i.attempts, i.error], ['gave-up', 'error', 'mcp_stReconnectFailed', 10, 'boom'])
  // Authorization failure, from the error text or the Host's note.
  i = info(failed('Streamable HTTP error: 401 Unauthorized'), {})
  assert.deepEqual([i.kind, i.tone, i.label, i.summary ?? false], ['auth', 'warn', 'mcp_stNeedsAuth', false])
  assert.equal(info(failed(''), { host: { authFailure: { lastError: 'invalid_token', at: 1 } } }).kind, 'auth')
  assert.equal(info({ state: 'failed', reason: 'gave-up', lastError: 'HTTP 401' }, {}).kind, 'auth')
  // A scheduled retry wins over an auth-looking error; auth wins over an old give-up.
  assert.equal(info(failed('401'), { host: { retry: { attempt: 1, max: 3, nextAt: 1 } } }).kind, 'retrying')
  assert.equal(info(failed('401'), { host: { gaveUp: { attempts: 3, at: 1 } } }).kind, 'auth')
  // First failure: manual retry only.
  i = info(failed('spawn npx ENOENT'), { host: { armed: false } })
  assert.deepEqual([i.kind, i.tone, i.label, i.error, i.errorKey ?? null], ['failed', 'error', 'mcp_stFailed', 'spawn npx ENOENT', null])
  // waiting-credentials is "needs authorization" only when the entry sends its OAuth token.
  assert.equal(info({ state: 'waiting-credentials', lastError: 'missing MCP_N_OAUTH' }, { oauth: true }).kind, 'auth')
  assert.equal(info({ state: 'waiting-credentials', lastError: 'missing X' }, { oauth: false }).kind, 'credentials')
  // DSH's own reconnecting stays as it was.
  assert.equal(info({ state: 'reconnecting', attempt: 1, maxAttempts: 10, nextRetryAtMs: 9, lastError: '401' }, {}).kind, 'dsh-retrying')
  // Flows: waiting while pending, "connecting" right after it finished, nothing on a connected server.
  assert.deepEqual([info(failed('401'), { flow: { status: 'pending' } }).label, info(failed('401'), { flow: { status: 'exchanging' } }).kind], ['mcp_stAuthWaiting', 'auth-flow'])
  assert.equal(info({ state: 'waiting-credentials', lastError: '' }, { oauth: true, flow: { status: 'done' }, flowDone: true }).label, 'mcp_stAuthDone')
  assert.equal(info({ state: 'connected', toolCount: 2, connectedAt: 1 }, { flow: { status: 'pending' } }).kind, 'connected')
  assert.equal(info({ state: 'connecting', attempt: 1 }, { flow: { status: 'done' }, flowDone: true }).kind, 'connecting')
  // Disabled wins over everything.
  assert.equal(info(failed('401'), { flow: { status: 'pending' } }, false).kind, 'disabled')
})
