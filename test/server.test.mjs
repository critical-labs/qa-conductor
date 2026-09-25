// Integration tests for startConductor over real HTTP (ephemeral ports) with
// fake adapters — no docker, no network beyond loopback.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startConductor } from '../lib/server.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Fake adapter set. `ensureBuilt` for a PR listed in `hang` blocks until the
// test releases it — modelling a boot stuck waiting on a GHCR image.
function makeWorld({ hang = {} } = {}) {
  const calls = []
  const provisioner = {
    network: 'qa-session',
    provisionDatabase: async ({ paneRef }) => ({ dsn: `dsn-${paneRef.role}`, db: { dsn: `dsn-${paneRef.role}`, query: async () => '1' } }),
    reserveServices: async ({ paneRef }) => ({ app: { url: 'http://127.0.0.1:1', port: paneRef.role === 'base' ? 3111 : 3112 } }),
    launchServices: async () => {},
    waitHealthy: async () => {},
    teardown: async ({ paneRef }) => { calls.push(['teardown', paneRef.role]) },
  }
  const build = {
    migrationStrategy: 'on-boot',
    ensureBuilt: async (pr, { signal } = {}) => {
      calls.push(['ensureBuilt', pr])
      if (hang[pr]) {
        // honour abort like the real adapter does, else wait for release
        await Promise.race([
          hang[pr].promise,
          new Promise((_, rej) => signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
        ])
      }
    },
    resolveBaseImages: async () => ({ services: { app: 'img:base' }, migrate: null }),
    resolvePrImages: async pr => ({ services: { app: `img:pr-${pr}` }, migrate: null }),
  }
  const adapters = {
    provisioner,
    build,
    seed: { databases: ['idp'], seedPane: async () => {} },
    envTransform: { derivePaneEnv: ({ pane }) => ({ app: { DSN: pane.dsn } }) },
    auth: { requiresDb: false, establishSession: async ({ pane }) => ({ landingUrl: `login-${pane.ref.role}`, cookies: [] }) },
  }
  const cfg = {
    publicHost: 'h.ts.net', composeDir: '/cd', operatorEmail: 'op@homefree.local',
    ghcrUser: 'u', githubToken: null, idleMinutes: 30,
    ports: { harness: 0, base: 0, pr: 0 },
  }
  const docker = { login: async () => {}, sweepQaContainers: async () => [], logsTail: async () => '' }
  const fsx = { readFile: async () => 'A=1\n', writeFile: async () => {}, unlink: async () => {} }
  const quiet = { log: () => {}, error: () => {} }
  const c = startConductor({ cfg, github: {}, docker, fsx, adapters, log: quiet })
  return { c, calls }
}

async function harnessPort(c) {
  if (!c.servers.harness.listening) await new Promise(r => c.servers.harness.once('listening', r))
  return c.servers.harness.address().port
}

async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

test('happy path: a session boots to ready with pane login urls', async () => {
  const { c } = makeWorld()
  try {
    const port = await harnessPort(c)
    assert.deepEqual(await api(port, 'POST', '/api/session', { pr: 7 }), { ok: true })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.equal(st.pr, 7)
    assert.equal(st.panes.base, 'login-base')
    assert.equal(st.panes.pr, 'login-pr')
  } finally { c.stop() }
})

// Regression (2026-09-25 incident): a boot stuck in ensureBuilt survived
// /api/teardown; when it later failed, its catch path tore down the NEWER
// session's deterministically-named containers and wrote its error into the
// newer session's state.
test('teardown cancels an in-flight boot; the stale boot never touches a newer session', async () => {
  const hang = { 205: deferred() }
  const { c, calls } = makeWorld({ hang })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 205 })
    await waitFor(() => calls.some(x => x[0] === 'ensureBuilt' && x[1] === 205))

    await api(port, 'POST', '/api/teardown') // must abort the pending 205 boot
    await api(port, 'POST', '/api/session', { pr: 235 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')

    // The stale boot's wait now fails (even if something released it late).
    hang[205].reject(new Error('timed out waiting for GHCR tag pr-205'))
    await new Promise(r => setTimeout(r, 50))

    const st = await api(port, 'GET', '/api/state')
    assert.equal(st.status, 'ready', 'newer session must still be ready')
    assert.equal(st.pr, 235)
    assert.equal(st.error, null)
    // Only the explicit /api/teardown tore panes down (once per role); the
    // stale boot's failure must not add another teardown.
    assert.deepEqual(calls.filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr'])
  } finally { c.stop() }
})

test('takeover also cancels the in-flight boot', async () => {
  const hang = { 1: deferred() }
  const { c, calls } = makeWorld({ hang })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 1 })
    await waitFor(() => calls.some(x => x[0] === 'ensureBuilt' && x[1] === 1))
    await api(port, 'POST', '/api/session', { pr: 2, takeover: true })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.equal(st.pr, 2)
    hang[1].resolve() // a late success of the stale boot must be ignored too
    await new Promise(r => setTimeout(r, 50))
    const after = await api(port, 'GET', '/api/state')
    assert.equal(after.pr, 2)
    assert.equal(after.status, 'ready')
    assert.equal(after.prTag, 'img:pr-2', 'stale boot must not overwrite the newer session tags')
    // and the stale boot must not have gone on to provision/launch anything
    assert.equal(calls.filter(x => x[0] === 'ensureBuilt').length, 2)
  } finally { c.stop() }
})
