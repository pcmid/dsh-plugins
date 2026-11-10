import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAdapter } from '../index.js'
import { projectRequest } from '../protocol.js'

test('installed Codex accepts the actual initialize/start/inject/empty-turn protocol', { timeout: 30000 }, async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'dsh-codex-smoke-'))
  await writeFile(join(codexHome, 'config.toml'), [
    'model_provider="fixture"', 'model="fixture-model"',
    '[model_providers.fixture]', 'name="Fixture"', 'wire_api="responses"',
    'base_url="http://127.0.0.1:1/v1"', 'requires_openai_auth=false',
  ].join('\n'))
  const adapter = new CodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', codexHome, timeoutMs: 20000 })
  let instance
  try {
    instance = await adapter.open()
    const options = { model: 'fixture-model', tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Fixture system instructions' }] },
        { role: 'developer', content: [{ type: 'text', text: 'Fixture developer instructions' }] },
        { role: 'user', content: [{ type: 'text', text: 'Read the notes' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'Notes returned by DSH' }] },
      ] }
    const started = await adapter.startStep(instance, options, projectRequest(options))
    assert.equal(typeof started.threadId, 'string')
    assert.equal(typeof started.turnId, 'string')
    // No model service is reachable: this test validates the local protocol, not inference.
  } finally {
    if (instance) await adapter.close(instance)
    await rm(codexHome, { recursive: true, force: true })
  }
})
