// Host routing of session.create: which requests get the workspace preset,
// and how the override sits on the Session controller.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { lookup, normalizePath, overrideCreate, routeRequest } from '../route.js'

const WORKSPACES = { w1: '/projects/alpha', w2: '/projects/beta' }

function deps({ workspaces = { '/projects/alpha': 'ptc' }, problems = {} } = {}) {
  const warnings = []
  return {
    warnings,
    workspaces: () => workspaces,
    workspacePath: id => WORKSPACES[id],
    problem: async preset => problems[preset],
    warn: message => { warnings.push(message) },
  }
}

describe('normalizePath / lookup', () => {
  it('ignores trailing separators but keeps roots', () => {
    assert.equal(normalizePath('/a/b/'), '/a/b')
    assert.equal(normalizePath('/'), '/')
    assert.equal(normalizePath('C:\\'), 'C:\\')
    assert.equal(normalizePath('C:\\work\\'), 'C:\\work')
  })

  it('finds the stored key for a directory', () => {
    assert.deepEqual(lookup({ '/a/b/': 'ptc' }, '/a/b'), { key: '/a/b/', preset: 'ptc' })
    assert.equal(lookup({ '/a/b': '' }, '/a/b'), undefined)
    assert.equal(lookup(undefined, '/a/b'), undefined)
    assert.equal(lookup(['ptc'], '/a/b'), undefined)
  })
})

describe('routeRequest', () => {
  it('adds the workspace preset to a request that names none', async () => {
    const request = { workspaceId: 'w1', sessionId: 's1' }
    assert.deepEqual(await routeRequest(request, deps()), { workspaceId: 'w1', sessionId: 's1', agentPreset: 'ptc' })
    assert.deepEqual(request, { workspaceId: 'w1', sessionId: 's1' })
  })

  it('matches a cwd request by directory', async () => {
    assert.deepEqual(await routeRequest({ cwd: '/projects/alpha/' }, deps()), { cwd: '/projects/alpha/', agentPreset: 'ptc' })
  })

  it('keeps an explicit preset', async () => {
    const request = { workspaceId: 'w1', agentPreset: 'standard' }
    assert.equal(await routeRequest(request, deps()), request)
  })

  it('leaves other workspaces and unknown ids alone', async () => {
    for (const request of [{ workspaceId: 'w2' }, { workspaceId: 'gone' }, {}]) {
      assert.equal(await routeRequest(request, deps()), request)
    }
  })

  it('falls back to the global default when the preset cannot compose', async () => {
    const d = deps({ problems: { ptc: 'Unknown agent preset: ptc' } })
    const request = { workspaceId: 'w1' }
    assert.equal(await routeRequest(request, d), request)
    assert.match(d.warnings[0], /"ptc" for \/projects\/alpha is unavailable.*Unknown agent preset/)
  })
})

describe('overrideCreate', () => {
  class Controller {
    constructor() { this.calls = [] }
    async create(request) {
      this.calls.push({ request, self: this })
      return { sessionId: 's', ...request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset } }
    }
  }

  it('routes calls through the class method with the caller as receiver, and restores it', async () => {
    const service = new Controller()
    const warnings = []
    const dispose = overrideCreate(service, async request => ({ ...request, agentPreset: 'ptc' }), m => warnings.push(m))
    assert.ok(Object.hasOwn(service, 'create'))
    const view = Object.create(service)
    assert.deepEqual(await service.create.call(view, { workspaceId: 'w1' }), { sessionId: 's', agentPreset: 'ptc' })
    assert.equal(service.calls[0].self, view)
    dispose()
    assert.ok(!Object.hasOwn(service, 'create'))
    assert.deepEqual(await service.create({ workspaceId: 'w1' }), { sessionId: 's' })
    assert.deepEqual(warnings, [])
  })

  it('forwards the original request when routing throws', async () => {
    const service = new Controller()
    const warnings = []
    overrideCreate(service, async () => { throw new Error('boom') }, m => warnings.push(m))
    assert.deepEqual(await service.create({ workspaceId: 'w1' }), { sessionId: 's' })
    assert.match(warnings[0], /routing failed.*boom/)
  })

  it('warns and does nothing without a create method', () => {
    const warnings = []
    const service = {}
    overrideCreate(service, async r => r, m => warnings.push(m))()
    assert.ok(!Object.hasOwn(service, 'create'))
    assert.match(warnings[0], /create is missing/)
  })
})
