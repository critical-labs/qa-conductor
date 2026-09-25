// Integration tests for startConductor over real HTTP (ephemeral ports) with
// fake adapters — no docker, no network beyond loopback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startConductor } from '../lib/server.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Fake adapter set. `ensureBuilt` for a PR listed in `hang` blocks until the
// test releases it — modelling a boot stuck waiting on a GHCR image. Each pane
// "app" is a real loopback server, so the pane proxies can be exercised.
function makeWorld({ hang = {}, failAt = null } = {}) {
  const calls = []
  const apps = {
    base: http.createServer((req, res) => res.end('pane-base')),
    pr: http.createServer((req, res) => res.end('pane-pr')),
  }
  for (const s of Object.values(apps)) s.listen(0, '127.0.0.1')
  const appPort = role => apps[role].address().port
  const provisioner = {
    provisionDatabase: async ({ paneRef }) => ({ dsn: `dsn-${paneRef.role}`, db: { dsn: `dsn-${paneRef.role}`, query: async () => '1' } }),
    reserveServices: async ({ paneRef }) => ({ app: { url: `http://127.0.0.1:${appPort(paneRef.role)}`, port: appPort(paneRef.role) } }),
    launchServices: async () => { if (failAt === 'launchServices') throw new Error('launch failed') },
    waitHealthy: async () => {},
    teardown: async ({ paneRef }) => { calls.push(['teardown', paneRef.role]) },
    sweep: async () => { calls.push(['sweep']) },
    logs: async ({ paneRef, stage, lines }) => { calls.push(['logs', paneRef.role, stage, lines]); return 'tail-lines' },
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
    publicHost: 'h.ts.net', operatorEmail: 'op@homefree.local', idleMinutes: 30,
    ports: { harness: 0, base: 0, pr: 0 },
    paneOrigins: { base: 'https://h:8443', pr: 'https://h:10000' },
    verdictLabels: { accept: 'ok', reject: 'nope' },
  }
  const github = {
    listOpenPrs: async () => [{ number: 7, title: 't', headRef: 'r', author: 'a', headSha: 'abc' }],
    prHead: async () => 'abc',
    postComment: async pr => { calls.push(['comment', pr]); return 'https://c' },
    setQaLabel: async (pr, label) => { calls.push(['label', pr, label]) },
  }
  const fsx = { readFile: async () => 'x' }
  const readBaseEnv = async () => { calls.push(['readBaseEnv']); return { A: '1' } }
  const quiet = { log: () => {}, error: () => {} }
  const conductor = startConductor({ cfg, github, fsx, adapters, readBaseEnv, log: quiet })
  const c = { ...conductor, stop() { conductor.stop(); for (const s of Object.values(apps)) s.close() } }
  return { c, calls, adapters }
}

async function proxyPort(server) {
  if (!server.listening) await new Promise(r => server.once('listening', r))
  return server.address().port
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

// --- Stage 2 B: the core reaches infra only through the seams --------------

test('startup calls provisioner.sweep; a provisioner without sweep is fine', async () => {
  const { c, calls } = makeWorld()
  try {
    await harnessPort(c)
    await waitFor(() => calls.some(x => x[0] === 'sweep'))
  } finally { c.stop() }
})

test('the pane env is derived from readBaseEnv', async () => {
  const { c, calls } = makeWorld()
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.equal(calls.filter(x => x[0] === 'readBaseEnv').length, 1)
  } finally { c.stop() }
})

test('/api/prs merges build.describePrs readiness; absent describePrs means none', async () => {
  const { c, adapters } = makeWorld()
  try {
    const port = await harnessPort(c)
    const before = (await api(port, 'GET', '/api/prs')).prs[0]
    assert.equal(before.imageStatus, 'none')
    assert.equal(before.title, 't')
    adapters.build.describePrs = async prs => prs.map(p => ({ number: p.number, status: 'building', runUrl: 'run' }))
    const after = (await api(port, 'GET', '/api/prs')).prs[0]
    assert.deepEqual([after.number, after.imageStatus, after.runUrl], [7, 'building', 'run'])
  } finally { c.stop() }
})

test('/api/build-status asks describePrs about the PR head', async () => {
  const { c, adapters } = makeWorld()
  try {
    const port = await harnessPort(c)
    assert.deepEqual(await api(port, 'GET', '/api/build-status?pr=7'), { pr: 7, status: 'none', exists: false, runUrl: null })
    let seen = null
    adapters.build.describePrs = async prs => { seen = prs; return [{ number: 7, status: 'built', runUrl: null }] }
    assert.deepEqual(await api(port, 'GET', '/api/build-status?pr=7'), { pr: 7, status: 'built', exists: true, runUrl: null })
    assert.deepEqual(seen, [{ number: 7, headSha: 'abc' }])
  } finally { c.stop() }
})

test('pane proxies 503 without a session, route to the reserved ports once ready, 503 after teardown', async () => {
  const { c } = makeWorld()
  try {
    const port = await harnessPort(c)
    const base = await proxyPort(c.servers.baseProxy)
    const pr = await proxyPort(c.servers.prProxy)
    assert.equal((await fetch(`http://127.0.0.1:${base}/x`)).status, 503)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.equal(await (await fetch(`http://127.0.0.1:${base}/x`)).text(), 'pane-base')
    assert.equal(await (await fetch(`http://127.0.0.1:${pr}/x`)).text(), 'pane-pr')
    await api(port, 'POST', '/api/teardown')
    assert.equal((await fetch(`http://127.0.0.1:${pr}/x`)).status, 503)
  } finally { c.stop() }
})

test('pane origins come from config; verdict uses the configured labels', async () => {
  const { c, calls } = makeWorld()
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.equal(st.panes.baseOrigin, 'https://h:8443')
    assert.equal(st.panes.prOrigin, 'https://h:10000')
    const prev = await api(port, 'GET', '/api/verdict/preview?verdict=reject')
    assert.deepEqual([prev.applies, prev.removes], ['nope', 'ok'])
    assert.match(prev.body, /qa-conductor-verdict/)
    await api(port, 'POST', '/api/verdict', { verdict: 'accept', notes: '' })
    assert.deepEqual(calls.find(x => x[0] === 'label'), ['label', 7, 'ok'])
  } finally { c.stop() }
})

test('a failed boot surfaces provisioner.logs for the failing pane stage', async () => {
  const { c, calls } = makeWorld({ failAt: 'launchServices' })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
    assert.equal(st.error.step, 'starting')
    await waitFor(() => calls.some(x => x[0] === 'logs'))
    assert.deepEqual(calls.find(x => x[0] === 'logs'), ['logs', 'pr', 'starting', 40])
  } finally { c.stop() }
})
