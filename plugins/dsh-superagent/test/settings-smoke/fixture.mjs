import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const load = createRequire(process.env.SMOKE_INSTALL)
const dshVersion = load(process.env.SMOKE_INSTALL).version
assert.ok(['0.2.2-rc.3','0.2.2-rc.5'].includes(dshVersion), dshVersion)
const { HostConnectionService } = await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-client-connection')))
const before = { enabled: false, profile: '', managed: true, tenantId: '', recipientId: '', pollIntervalMinutes:1, historyCount:10, historyMinutes:5, allowPrivateChats:false }
const after = { ...before, cliPath:process.env.SMOKE_CLI_PATH, enabled: true, profile: 'smoke-offline', managed: false, pollIntervalMinutes:3, historyCount:6, historyMinutes:12 }

async function verify(ctx, connection) {
  assert.equal(ctx.get('webServer'), undefined)
  assert.equal(ctx.get('credentials'), undefined)
  const route = connection.createSharedFetchHandler('/api')
  const call = async (name, payload = {}) => {
    const res = await route.fetch(new Request('http://localhost/api/pcmid/superagent/' + name, {
      method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'settings-smoke', payload }),
    }), connection.browserPeer)
    assert.equal(res.status, 200, name)
    const { result } = await res.json()
    return result
  }
  const settings = async () => {
    const response = await call('settingsSnapshot')
    assert.equal(response.ok, true, JSON.stringify(response.error))
    assert.deepEqual(Object.keys(response.value).sort(), ['helpers','releaseRequired','revision','roleModels','source','team'])
    assert.ok(response.value.source.settings)
    return response.value.source.settings
  }
  const { version, ...initial } = await settings()
  assert.ok(typeof version === 'string' && version.length)
  const requests=ctx.get('superagentRequests')
  assert.deepEqual(Object.keys(requests).sort(),['requestAccess'])
  await assert.rejects(requests.requestAccess({profile:'smoke-offline',managed:false,tenantId:'demo',
    recipientId:'ou_example',chatId:'oc_example',threadId:'om_example'}),{code:'source-unconfigured'})
  const editor = ctx.get('configEditor')
  const entry = editor.entries().find(e => e.options.id === 'pcmid-superagent')
  const mounted = entry.fiber.uid
  assert.ok(mounted, 'expected an active production plugin')
  if (process.env.SMOKE_STEP === 'save') {
    assert.deepEqual(initial, before)
    const setup=(await call('settingsSnapshot')).value
    assert.deepEqual(setup.team,{lead:'superagent-lead',develop:'superagent-develop',answer:'superagent-answer'})
    assert.deepEqual(setup.roleModels,{},'do not add a Codex provider to another profile')
    assert.equal(setup.releaseRequired,true)
    assert.deepEqual((await call('setReleasePolicy',{required:false})).value,{releaseRequired:false})
    const denied=await call('setPrivateChats',{version,allowPrivateChats:true})
    assert.equal(denied.error.code,'source-unconfigured','private chat reads need a bound, authorized account')
    const path=await call('setCliPath',{version,cliPath:after.cliPath})
    assert.equal(path.ok,true,JSON.stringify(path.error))
    const timing=await call('setPollInterval',{version:path.value.version,pollIntervalMinutes:3})
    assert.equal(timing.ok,true)
    const limits=await call('setHistoryLimits',{version:timing.value.version,historyCount:after.historyCount,historyMinutes:after.historyMinutes})
    assert.equal(limits.ok,true,JSON.stringify(limits.error))
    const saved = await call('saveFeishu', { version:limits.value.version, enabled: after.enabled, profile: after.profile, managed: after.managed })
    assert.equal(saved.ok, true, JSON.stringify(saved.error))
    assert.equal(entry.fiber.uid, mounted, 'volatile save must not restart the plugin')
    const { version: nextVersion, ...visible } = await settings()
    assert.notEqual(nextVersion, version)
    assert.deepEqual(visible, after)
    const stale = await call('saveFeishu', { version, enabled: false, profile: 'not-saved', managed: false })
    assert.equal(stale.ok, false, 'old settings cannot overwrite the saved identity')
    assert.equal(stale.error.code, 'scope-changed')
    assert.deepEqual(await settings(), { ...after, version: nextVersion })
  } else {
    assert.deepEqual(initial,after)
    assert.equal((await call('settingsSnapshot')).value.releaseRequired,false)
  }
  assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), { provider: 'unused', model: 'keep-model' })
  assert.equal(editor.entries().find(e => e.options.id === 'pcmid-superagent').fiber.uid, mounted)
  console.log('PASS ' + process.env.SMOKE_STEP + ': DSH ' + dshVersion + ' native configEditor → production owner route; retained unrelated settings; no login')
}

export const inject = ['appReady','appExit']
export function apply(ctx) {
  const connection = new HostConnectionService(ctx, [], new Proxy({}, { get() { throw Error('No browser authentication') } }))
  ctx.effect(() => ctx.appReady.onReady(() => {
    const guard = setTimeout(() => { console.error('Settings smoke timed out'); ctx.appExit(1) }, 12_000)
    verify(ctx, connection).then(() => ctx.appExit(0), err => { console.error(err); ctx.appExit(1) }).finally(() => clearTimeout(guard))
  }))
}
