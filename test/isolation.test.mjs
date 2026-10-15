// The isolation verdict's pure parts (lib/isolation.mjs): the runtime
// floors, a Provisioner's declaration or check, and how they combine.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VERDICTS, combine, declared, declaredBuild, floors, fromCheck } from '../lib/isolation.mjs'

test('the verdicts, best to worst', () => {
  assert.deepEqual(VERDICTS, ['isolated', 'unknown', 'reachable', 'shared-host'])
})

test('floors: macOS, a bind off loopback, and a bind a probe of the IPv4 loopback can\'t speak for', () => {
  assert.deepEqual(floors({ host: '127.0.0.1', platform: 'linux' }), [])
  assert.deepEqual(floors({ host: undefined, platform: 'linux' }), [], 'the default bind is 127.0.0.1')
  assert.deepEqual(floors({ host: '127.0.0.1', platform: 'darwin' }), [{
    verdict: 'reachable',
    reason: 'on macOS, containers run in a VM that forwards the host\'s loopback (Docker Desktop, Podman machine), where the base app is published',
  }])
  for (const host of ['0.0.0.0', '192.168.1.5', '::']) {
    assert.deepEqual(floors({ host, platform: 'linux' }), [{ verdict: 'reachable', reason: `the conductor listens on ${host}, which containers can reach` }], host)
  }
  // Every loopback bind but 127.0.0.1: a runtime may forward only
  // 127.0.0.1, where the pane apps are, so a probe that misses the
  // conductor on 127.0.0.2 proves nothing about them.
  for (const host of ['127.0.0.2', '127.1.2.3', '::1', 'localhost']) {
    assert.deepEqual(floors({ host, platform: 'linux' }), [{
      verdict: 'unknown',
      reason: `the conductor listens on ${host}, not on 127.0.0.1 where the pane apps are published, so a probe of it can't speak for their ports`,
    }], host)
  }
  assert.equal(floors({ host: '0.0.0.0', platform: 'darwin' }).length, 2)
  // where no container runs (shared-host), macOS's VM says nothing
  assert.deepEqual(floors({ host: '127.0.0.1', platform: 'darwin', containers: false }), [])
  assert.equal(floors({ host: '0.0.0.0', platform: 'darwin', containers: false }).length, 1)
  // the PR pane on an internal network (#32): the probe speaks for the VM's
  // forwarding, so only the bind's floors remain
  assert.deepEqual(floors({ host: '127.0.0.1', platform: 'darwin', internal: true }), [])
  assert.deepEqual(floors({ host: '0.0.0.0', platform: 'darwin', internal: true }), [{ verdict: 'reachable', reason: 'the conductor listens on 0.0.0.0, which containers can reach' }])
  assert.equal(floors({ host: '127.0.0.1', platform: 'darwin', internal: 'yes' }).length, 1, 'only true')
})

test('a BuildConvention that runs the PR\'s code on this host to build it declares shared-host', () => {
  assert.deepEqual(declaredBuild({ isolation: 'shared-host' }), {
    verdict: 'shared-host', reasons: ['the BuildConvention runs the PR\'s code on this host to build it (an install step)'],
  })
  for (const build of [{}, null, undefined, { isolation: undefined }]) assert.equal(declaredBuild(build), null, JSON.stringify(build))
  assert.deepEqual(declaredBuild({ isolation: 'isolated' }), {
    verdict: 'unknown', reasons: ['the BuildConvention declares isolation "isolated"; only "shared-host" means something there'],
  })
})

test('a Provisioner\'s declaration: shared-host, none (unknown), or a check still to run (null)', () => {
  assert.deepEqual(declared({ isolation: 'shared-host' }), { verdict: 'shared-host', reasons: ['both panes run as one user on this host'] })
  assert.deepEqual(declared({}), { verdict: 'unknown', reasons: ['the Provisioner has no isolation check'] })
  assert.deepEqual(declared({ isolation: 'isolated' }), { verdict: 'unknown', reasons: ['the Provisioner declares isolation "isolated", which only a check can show'] })
  assert.equal(declared({ isolation: async () => ({}) }), null)
})

test('a check\'s result: a known verdict with string reasons, else unknown', () => {
  assert.deepEqual(fromCheck({ verdict: 'isolated', reasons: [] }), { verdict: 'isolated', reasons: [] })
  assert.deepEqual(fromCheck({ verdict: 'reachable', reasons: ['a', 2, 'b'] }), { verdict: 'reachable', reasons: ['a', 'b'] })
  assert.deepEqual(fromCheck({ verdict: 'isolated' }), { verdict: 'isolated', reasons: [] })
  // a check that says shared-host is taken at its word: never better
  assert.deepEqual(fromCheck({ verdict: 'shared-host', reasons: ['one user'] }), { verdict: 'shared-host', reasons: ['one user'] })
  for (const bad of [null, undefined, 'isolated', {}, { verdict: 'bogus' }]) {
    assert.deepEqual(fromCheck(bad), { verdict: 'unknown', reasons: ['the isolation check gave no verdict'] }, JSON.stringify(bad))
  }
  // an isolated verdict's reasons are dropped: none counts against it
  assert.deepEqual(fromCheck({ verdict: 'isolated', reasons: ['x'] }), { verdict: 'isolated', reasons: [] })
  assert.deepEqual(fromCheck({ verdict: 'unknown' }), { verdict: 'unknown', reasons: ['the isolation check gave no reason'] })
  assert.deepEqual(fromCheck({ verdict: 'reachable', reasons: [] }), { verdict: 'reachable', reasons: ['the isolation check gave no reason'] })
  assert.deepEqual(fromCheck(null), { verdict: 'unknown', reasons: ['the isolation check gave no verdict'] })
})

test('combining: the worst verdict, and every reason that isn\'t isolated\'s', () => {
  assert.deepEqual(combine([{ verdict: 'isolated', reasons: [] }]), { verdict: 'isolated', reasons: [] })
  assert.deepEqual(combine([{ verdict: 'isolated', reasons: [] }, { verdict: 'reachable', reason: 'floor' }]), { verdict: 'reachable', reasons: ['floor'] })
  assert.deepEqual(
    combine([{ verdict: 'unknown', reasons: ['probe'] }, { verdict: 'reachable', reason: 'floor' }, { verdict: 'unknown', reason: 'other' }]),
    { verdict: 'reachable', reasons: ['probe', 'floor', 'other'] },
  )
  assert.deepEqual(combine([{ verdict: 'shared-host', reasons: ['host'] }, { verdict: 'reachable', reason: 'floor' }]), { verdict: 'shared-host', reasons: ['host', 'floor'] })
  // nothing to go on, or a verdict it doesn't know: never isolated
  assert.deepEqual(combine([]), { verdict: 'unknown', reasons: ['nothing said whether the PR pane is isolated'] })
  assert.deepEqual(combine([{ verdict: 'isolated', reasons: [] }, { verdict: 'bogus', reasons: [] }]), { verdict: 'unknown', reasons: ['a part gave the verdict "bogus"'] })
  assert.deepEqual(combine([{ verdict: 'bogus', reason: 'why' }, { verdict: 'reachable', reason: 'floor' }]), { verdict: 'reachable', reasons: ['why', 'floor'] })
})
