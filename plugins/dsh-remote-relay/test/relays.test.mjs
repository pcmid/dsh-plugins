// Relay lists: the host stays on every relay, pairing codes carry them in priority order, devices
// connect through the first relay that answers and learn later changes from the handshake.
// Needs two running openchamber-relay instances.
// Usage: RELAY_URL=ws://127.0.0.1:18788/ws RELAY_URL_2=ws://127.0.0.1:18789/ws \
//   node --import ./test/hooks.mjs --test test/relays.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { decodePairing, encodePairing, normalizeRelayList } from '../launcher/tunnel.js'
import { fakeContext, startFakeGui, until } from './harness.mjs'

const relayA = process.env.RELAY_URL ?? 'ws://127.0.0.1:18788/ws'
const relayB = process.env.RELAY_URL_2 ?? 'ws://127.0.0.1:18789/ws'
// Nothing listens here, so connecting fails at once.
const deadRelay = 'ws://127.0.0.1:9/ws'

test('pairing codes carry every relay in order, and older decoders read the first', () => {
  const offer = { relayUrls: ['relay-a.example', 'wss://relay-b.example/tunnel'], serverId: 'x'.repeat(43), pairingId: 'pairing1', secret: 'A'.repeat(22), hostName: 'h', expiresAt: Date.now() + 60_000 }
  const code = encodePairing(offer)
  const decoded = decodePairing(code)
  assert.deepEqual(decoded.relayUrls, ['wss://relay-a.example/ws', 'wss://relay-b.example/tunnel'])
  assert.equal(decoded.relayUrl, 'wss://relay-a.example/ws')
  assert.equal(new URLSearchParams(code).get('r'), 'relay-a.example')
  assert.deepEqual(normalizeRelayList(['a.example', 'wss://a.example/ws', 'ftp://bad', '']), ['wss://a.example/ws'])
})

test('the host serves every relay and devices fall over to the next one', async () => {
  const gui = await startFakeGui()
  const settings = { enabled: true, relays: [relayA, relayB, 'ftp://not-a-relay'], relayUrl: '', launcherUrl: '', hostName: 'multi', pairingMinutes: 5 }
  const host = fakeContext(gui.origin, settings)
  const viewer = fakeContext('http://127.0.0.1:1', { enabled: false, relays: [], relayUrl: '', launcherUrl: '', hostName: 'viewer', pairingMinutes: 5 })
  try {
    apply(host.ctx, host.config)
    apply(viewer.ctx, viewer.config)
    let status = await until(async () => {
      const value = (await host.call('status')).value
      return value.relays.filter((relay) => relay.state === 'online').length === 2 && value
    }, 'both relays online')
    assert.equal(status.control.state, 'online')
    assert.deepEqual(status.relays.map((relay) => relay.state), ['online', 'online', 'invalid'])
    assert.match(status.relayError, /Unsupported relay scheme/)

    const pairing = (await host.call('pair')).value.pairing
    assert.deepEqual(decodePairing(pairing.code).relayUrls, [relayA, relayB])
    const added = (await viewer.call('remote-add', { code: `dsh-remote://pair#${pairing.code}`, name: 'laptop' })).value
    const remoteRecord = () => viewer.records.get('remote-relay/remotes').payload.remotes[0]
    assert.deepEqual(remoteRecord().relayUrls, [relayA, relayB])

    await viewer.call('remote-open', { id: added.added })
    let remote = await until(async () => { const value = (await viewer.call('remotes')).value.remotes[0]; return value.state === 'connected' && value }, 'tunnel connected')
    assert.equal(remote.via, new URL(relayA).host)
    assert.deepEqual(remote.relays, [new URL(relayA).host, new URL(relayB).host])
    // Latency is end to end, measured by the tunnel's pings on both sides, not a relay round trip.
    remote = await until(async () => { const value = (await viewer.call('remotes')).value.remotes[0]; return typeof value.latencyMs === 'number' && value }, 'device-side latency')
    const hostSide = await until(async () => {
      const value = (await host.call('status')).value
      return typeof value.devices[0].links[0]?.latencyMs === 'number' && value
    }, 'host-side latency')
    assert.deepEqual(hostSide.devices[0].links.map((link) => link.relay), [new URL(relayA).host])
    assert.deepEqual(hostSide.relays.map((relay) => relay.devices), [1, 0, 0])

    const probe = (await viewer.call('remote-probe', { id: added.added })).value
    assert.deepEqual(probe.results.map((result) => [result.host, result.current]), [[new URL(relayA).host, true], [new URL(relayB).host, false]])
    for (const result of probe.results) assert.equal(typeof result.ms, 'number', JSON.stringify(result))
    // One relay at a time, so the dialog fills in each row as it arrives.
    const single = (await viewer.call('remote-probe', { id: added.added, relayUrl: relayB })).value.results
    assert.deepEqual(single.map((result) => [result.host, result.current, typeof result.ms]), [[new URL(relayB).host, false, 'number']])
    assert.equal((await viewer.call('remote-probe', { id: added.added, relayUrl: 'wss://elsewhere.example/ws' })).error.code, 'remote-relay/not-found')
    assert.deepEqual([remote.relayUrls, remote.currentRelay, remote.preferredRelay], [[relayA, relayB], relayA, null])

    // Choosing a relay answers at once with the stored choice; the open tunnel moves in the background
    // and later connections keep using that relay first.
    const pinned = (await viewer.call('remote-relay-pin', { id: added.added, relayUrl: relayB })).value
    assert.equal(pinned.remotes[0].preferredRelay, relayB)
    assert.equal(remoteRecord().preferredRelay, relayB)
    remote = await until(async () => { const value = (await viewer.call('remotes')).value.remotes[0]; return value.currentRelay === relayB && value }, 'tunnel moved to the chosen relay')
    assert.deepEqual([remote.via, remote.preferred], [new URL(relayB).host, new URL(relayB).host])
    await viewer.call('remote-close', { id: added.added })
    await viewer.call('remote-open', { id: added.added })
    remote = await until(async () => { const value = (await viewer.call('remotes')).value.remotes[0]; return value.state === 'connected' && value }, 'reconnected through the pinned relay')
    assert.equal(remote.via, new URL(relayB).host)
    assert.equal((await viewer.call('remote-relay-pin', { id: added.added, relayUrl: 'wss://elsewhere.example/ws' })).error.code, 'remote-relay/not-found')
    // Unpinning keeps the open tunnel where it is.
    await viewer.call('remote-relay-pin', { id: added.added, relayUrl: null })
    assert.equal(remoteRecord().preferredRelay, undefined)
    assert.equal((await viewer.call('remotes')).value.remotes[0].via, new URL(relayB).host)

    // The host moves its first relay to one that is down; the device learns the new list on its
    // next handshake and connects through the relay that still answers.
    settings.relays = [deadRelay, relayB]
    host.volatileUpdate()
    viewer.ctx.logger.info = () => {}
    await viewer.call('remote-close', { id: added.added })
    await viewer.call('remote-open', { id: added.added })
    remote = await until(async () => { const value = (await viewer.call('remotes')).value.remotes[0]; return value.state === 'connected' && value }, 'reconnected')
    assert.equal(remote.via, new URL(relayB).host)
    await until(() => remoteRecord().relayUrls.length === 2 && remoteRecord().relayUrls[0] === deadRelay, 'stored relay list')
    assert.equal(remoteRecord().relayUrl, deadRelay)

    status = (await host.call('status')).value
    assert.deepEqual(status.relays.map((relay) => relay.state).slice(1), ['online'])
    const dead = (await viewer.call('remote-probe', { id: added.added })).value.results
    assert.equal(dead[0].ms, null)
    assert.equal(dead[1].current, true)
  } finally {
    viewer.dispose()
    host.dispose()
    gui.close()
  }
})

test('measuring hears relays the host added, with or without an open tunnel', async () => {
  const gui = await startFakeGui()
  const settings = { enabled: true, relays: [relayA], relayUrl: '', launcherUrl: '', hostName: 'grows', pairingMinutes: 5 }
  const host = fakeContext(gui.origin, settings)
  const viewer = fakeContext('http://127.0.0.1:1', { enabled: false, relays: [], relayUrl: '', launcherUrl: '', hostName: 'viewer', pairingMinutes: 5 })
  const online = (count) => until(async () => (await host.call('status')).value.relays.filter((relay) => relay.state === 'online').length === count, `${count} relays online`)
  const listed = async () => (await viewer.call('remotes')).value.remotes[0].relayUrls
  try {
    apply(host.ctx, host.config)
    apply(viewer.ctx, viewer.config)
    viewer.ctx.logger.info = () => {}
    await online(1)
    const pairing = (await host.call('pair')).value.pairing
    const id = (await viewer.call('remote-add', { code: pairing.code, name: 'laptop' })).value.added
    assert.deepEqual(await listed(), [relayA])

    // Connected: the open tunnel only learned [A] when it connected; measuring A asks the host again.
    await viewer.call('remote-open', { id })
    await until(async () => (await viewer.call('remotes')).value.remotes[0].state === 'connected', 'tunnel connected')
    settings.relays = [relayA, relayB]
    host.volatileUpdate()
    await online(2)
    const current = (await viewer.call('remote-probe', { id, relayUrl: relayA })).value.results[0]
    assert.equal(current.current, true)
    await until(async () => (await listed()).length === 2, 'list learned over the open tunnel')
    assert.deepEqual(await listed(), [relayA, relayB])
    assert.deepEqual(viewer.records.get('remote-relay/remotes').payload.remotes[0].relayUrls, [relayA, relayB])
    // The open tunnel stays where it is.
    assert.equal((await viewer.call('remotes')).value.remotes[0].currentRelay, relayA)

    // Not connected: a measurement's own handshake carries the list.
    await viewer.call('remote-close', { id })
    settings.relays = [relayB, relayA]
    host.volatileUpdate()
    await online(2)
    const probed = (await viewer.call('remote-probe', { id, relayUrl: relayA })).value.results[0]
    assert.equal(typeof probed.ms, 'number', JSON.stringify(probed))
    assert.deepEqual(await listed(), [relayB, relayA])
    assert.equal((await viewer.call('remotes')).value.remotes[0].state, 'idle')
  } finally {
    viewer.dispose()
    host.dispose()
    gui.close()
  }
})
