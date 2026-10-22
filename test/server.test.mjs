// Integration tests for startConductor over real HTTP (ephemeral ports) with
// fake adapters — no docker, no network beyond loopback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { startConductor } from '../lib/server.mjs'
import { createGithub } from '../lib/github.mjs'
import { createCapability, paneCookieName } from '../lib/capability.mjs'
import { createPaneProxy } from '../lib/proxy.mjs'
import { defaultHarnessOrigin } from '../lib/config.mjs'
import { webOrigin } from '../lib/net.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Every world enrols one browser up front, through startConductor's
// `capability` seam, so a test that isn't about the capability talks to the
// conductor as the harness page does: api(), raw(), sseEvents() and paneFetch()
// add that browser's token on the harness port and its pane cookie on the pane
// ports. raw(port, { cap: false }) sends neither, as PR code would.
const CAPS = new Map() // listening port -> () => headers to add
const capFor = port => CAPS.get(port)?.() ?? {}

function withCap(port, headers) {
  const add = capFor(port)
  const out = { ...headers }
  if (add['x-qa-cap'] !== undefined && !Object.hasOwn(out, 'x-qa-cap')) out['x-qa-cap'] = add['x-qa-cap']
  if (add.cookie !== undefined) out.cookie = out.cookie ? `${out.cookie}; ${add.cookie}` : add.cookie
  return out
}

// Fake adapter set. `ensureBuilt` for a PR listed in `hang` blocks until the
// test releases it — modelling a boot stuck waiting on a GHCR image. The
// startup sweep blocks on `sweepGate` when given, then fails if `sweepFails`;
// `provisioner` overrides members (`{ sweep: undefined }` removes the sweep).
// `exposure` is passed as adapters.exposure (see fakeExposure). The logger
// records every line, then throws on one that matches `logThrowsOn`.
// Each pane "app" is a real loopback server, so the pane proxies can be
// exercised.
// `enrolled: false` passes no capability store, so the conductor makes its
// own, and enrols no browser up front. `platform` is what the conductor takes
// process.platform to be (linux, whatever runs the tests). `appHits` records every request a pane
// app gets.
function makeWorld({
  hang = {}, failAt = null, sweepGate = null, sweepFails = false, provisioner: provisionerOverrides = {},
  cfg: cfgOverrides = {}, readBaseEnv: readBaseEnvOverride = null, exposure = null, logThrowsOn = null, enrolled = true, platform = 'linux',
  pacing = { retryGapMs: 0, enrolWaitMs: 0 },
} = {}) {
  const calls = []
  const appHits = []
  // '/page' answers HTML, so the proxy injects the bridge; '/cookie' echoes
  // the Cookie header the app got; '/set?<pair>' sets that cookie; anything
  // else is text.
  const app = name => http.createServer((req, res) => {
    appHits.push([name, req.method, req.url])
    if (req.url === '/cookie') return res.end(req.headers.cookie ?? '(none)')
    if (req.url.startsWith('/set?')) res.setHeader('set-cookie', `${req.url.slice('/set?'.length)}; Path=/; HttpOnly`)
    if (req.url === '/page') res.setHeader('content-type', 'text/html')
    res.end(req.url === '/page' ? `<head></head>${name}` : name)
  })
  const apps = { base: app('pane-base'), pr: app('pane-pr') }
  for (const s of Object.values(apps)) s.listen(0, '127.0.0.1')
  const appPort = role => apps[role].address().port
  const provisioner = {
    provisionDatabase: async ({ paneRef }) => {
      calls.push(['provisionDatabase', paneRef.role])
      return { dsn: `dsn-${paneRef.role}`, db: { dsn: `dsn-${paneRef.role}`, query: async () => '1' } }
    },
    reserveServices: async ({ paneRef }) => ({ app: { url: `http://127.0.0.1:${appPort(paneRef.role)}`, port: appPort(paneRef.role) } }),
    launchServices: async () => { if (failAt === 'launchServices') throw new Error('launch failed') },
    waitHealthy: async () => {},
    teardown: async ({ paneRef }) => { calls.push(['teardown', paneRef.role]) },
    sweep: async () => {
      calls.push(['sweep'])
      if (sweepGate) await sweepGate.promise
      if (sweepFails) throw new Error('docker unavailable')
      calls.push(['sweep-done'])
    },
    logs: async ({ paneRef, stage, lines }) => { calls.push(['logs', paneRef.role, stage, lines]); return 'tail-lines' },
    ...provisionerOverrides,
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
    ...(exposure ? { exposure } : {}),
  }
  // Ungated: these https origins would otherwise put it in tailscale mode.
  const cfg = {
    publicHost: 'h.ts.net', operatorEmail: 'op@example.com', idleMinutes: 30,
    ports: { harness: 0, base: 0, pr: 0 },
    paneOrigins: { base: 'https://h.ts.net:8443', pr: 'https://h.ts.net:10000' },
    verdictLabels: { accept: 'ok', reject: 'nope' },
    exposure: 'none',
    ...cfgOverrides,
  }
  const github = {
    listOpenPrs: async () => [{ number: 7, title: 't', headRef: 'r', author: 'a', headSha: 'abc' }],
    prHead: async () => 'abc',
    postComment: async pr => { calls.push(['comment', pr]); return 'https://c' },
    setQaLabel: async (pr, label) => { calls.push(['label', pr, label]) },
  }
  const fsx = { readFile: async () => 'x' }
  const readBaseEnv = readBaseEnvOverride ?? (async () => { calls.push(['readBaseEnv']); return { A: '1' } })
  const logLines = []
  const errorLines = []
  const lines = [] // both, in order
  const record = into => (...a) => {
    const line = a.join(' ')
    into.push(line)
    lines.push(line)
    if (logThrowsOn?.test(line)) throw new Error('the logger failed')
  }
  const quiet = { log: record(logLines), error: record(errorLines) }
  const capability = enrolled ? createCapability() : undefined
  const conductor = startConductor({ cfg, github, fsx, adapters, readBaseEnv, log: quiet, platform, pacing, ...(enrolled ? { capability } : {}) })
  if (exposure) exposure.servers = conductor.servers
  // The enrolled browser's token, and its pane cookie under the name the
  // conductor reads: the harness origin as the conductor resolves it, in its
  // plain and __Host- forms (the scheme of a pane origin assigned later).
  const token = enrolled ? capability.enrol() : null
  const harnessOrigin = () => (cfg.harnessOrigin != null
    ? webOrigin(cfg.harnessOrigin)
    : defaultHarnessOrigin({ publicHost: cfg.publicHost, host: cfg.host ?? '127.0.0.1', port: conductor.servers.harness.address()?.port ?? 0 }))
  const paneCookie = () => {
    const name = paneCookieName(harnessOrigin(), 'http://x')
    const value = capability.paneToken(token)
    return `${name}=${value}; __Host-${name}=${value}`
  }
  if (enrolled) {
    for (const [name, server] of Object.entries(conductor.servers)) {
      server.once('listening', () => {
        const port = server.address().port
        CAPS.set(port, name === 'harness' ? () => ({ 'x-qa-cap': token }) : () => ({ cookie: paneCookie() }))
        server.once('close', () => CAPS.delete(port))
      })
    }
  }
  const closeApps = () => { for (const s of Object.values(apps)) s.close() }
  // stop() leaves open connections alone; an idle keep-alive socket fetch()
  // opened would hold the test process up to its 4s idle timeout.
  const c = {
    ...conductor,
    stop() {
      conductor.stop()
      for (const s of Object.values(conductor.servers)) s.closeAllConnections()
      closeApps()
    },
  }
  return { c, conductor, closeApps, calls, appHits, adapters, github, cfg, logLines, errorLines, lines, capability, token, harnessOrigin, paneCookie }
}

async function proxyPort(server) {
  if (!server.listening) await new Promise(r => server.once('listening', r))
  return server.address().port
}

async function harnessPort(c) {
  return proxyPort(c.servers.harness)
}

async function allPorts(c) {
  return {
    harness: await harnessPort(c),
    base: await proxyPort(c.servers.baseProxy),
    pr: await proxyPort(c.servers.prProxy),
  }
}

// POSTs always carry a JSON content type (the harness requires it). `headers`
// adds to them, e.g. ALLOWED on a gated conductor.
async function api(port, method, path, body, headers = {}) {
  const post = method === 'POST'
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: withCap(port, { ...(post ? { 'content-type': 'application/json' } : {}), ...headers }), body: post ? JSON.stringify(body ?? {}) : undefined,
  })
  return res.json()
}

// A GET of a pane, as the enrolled browser.
const paneFetch = (port, path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: capFor(port) })

// A request with full control over the headers (fetch cannot set Host). The
// enrolled browser's capability is added unless `cap` is false.
function raw(port, { method = 'GET', path = '/', headers = {}, body = null, cap = true } = {}) {
  const sent = cap ? withCap(port, headers) : headers
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: sent, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

// Collect server-sent events until `until(events)` holds.
async function sseEvents(port, until, ms = 3000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  const events = []
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/progress`, { headers: capFor(port), signal: ac.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended')
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)))
      }
      if (until(events)) return events
    }
  } finally {
    clearTimeout(timer)
    ac.abort()
  }
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
    // The explicit /api/teardown, then the cleanup once the cancelled boot
    // had settled, tore the panes down, both before the newer session
    // provisioned; the stale boot's failure must not add another teardown.
    const newer = calls.findIndex(x => x[0] === 'provisionDatabase')
    assert.deepEqual(calls.slice(0, newer).filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr', 'base', 'pr'])
    assert.deepEqual(calls.slice(newer).filter(x => x[0] === 'teardown'), [])
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
    // no github.prInfo: the prHead fallback
    assert.deepEqual(seen, [{ number: 7, headSha: 'abc' }])
  } finally { c.stop() }
})

test('pane proxies 503 without a session, route to the reserved ports once ready, 503 after teardown', async () => {
  const { c } = makeWorld()
  try {
    const port = await harnessPort(c)
    const base = await proxyPort(c.servers.baseProxy)
    const pr = await proxyPort(c.servers.prProxy)
    assert.equal((await paneFetch(base, '/x')).status, 503)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.equal(await (await paneFetch(base, '/x')).text(), 'pane-base')
    assert.equal(await (await paneFetch(pr, '/x')).text(), 'pane-pr')
    await api(port, 'POST', '/api/teardown')
    assert.equal((await paneFetch(pr, '/x')).status, 503)
  } finally { c.stop() }
})

test('pane origins come from config; verdict uses the configured labels', async () => {
  const { c, calls } = makeWorld()
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.equal(st.panes.baseOrigin, 'https://h.ts.net:8443')
    assert.equal(st.panes.prOrigin, 'https://h.ts.net:10000')
    const prev = await api(port, 'GET', '/api/verdict/preview?verdict=reject')
    assert.deepEqual([prev.applies, prev.removes], ['nope', 'ok'])
    assert.match(prev.body, /qa-conductor-verdict/)
    await api(port, 'POST', '/api/verdict', { verdict: 'accept', notes: '' })
    assert.deepEqual(calls.find(x => x[0] === 'label'), ['label', 7, 'ok'])
  } finally { c.stop() }
})

test('a failed boot surfaces provisioner.logs for the failing pane, read before teardown', async () => {
  const { c, calls } = makeWorld({ failAt: 'launchServices' })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
    assert.equal(st.error.step, 'starting')
    await waitFor(() => calls.some(x => x[0] === 'logs'))
    // the base pane launches first, so it is the one that failed
    assert.deepEqual(calls.find(x => x[0] === 'logs'), ['logs', 'base', 'starting', 40])
    const seq = calls.map(x => x[0])
    assert.ok(seq.indexOf('logs') < seq.indexOf('teardown'), 'the tail is read while the pane still exists')
    assert.equal(calls.filter(x => x[0] === 'logs').length, 1, 'no second read after teardown')
  } finally { c.stop() }
})

// --- 0.2.0: listen host ---------------------------------------------------------

test('all three servers bind 127.0.0.1 by default and log host:port', async () => {
  const { c, logLines } = makeWorld()
  try {
    for (const name of ['harness', 'baseProxy', 'prProxy']) {
      const port = await proxyPort(c.servers[name])
      assert.equal(c.servers[name].address().address, '127.0.0.1', name)
      assert.ok(logLines.some(l => l.includes(`127.0.0.1:${port}`)), `${name} log line names host:port`)
    }
  } finally { c.stop() }
})

// --- 0.2.0: browser-request hardening ------------------------------------------

test('a Host header outside the allowlist gets 421 on all three servers', async () => {
  const { c } = makeWorld()
  try {
    for (const name of ['harness', 'baseProxy', 'prProxy']) {
      const port = await proxyPort(c.servers[name])
      const res = await raw(port, { path: '/', headers: { host: `rebound.attacker.example:${port}` } })
      assert.equal(res.status, 421, name)
    }
    const port = await harnessPort(c)
    assert.equal((await raw(port, { method: 'POST', path: '/api/teardown', headers: { host: 'attacker.example', 'content-type': 'application/json' }, body: '{}' })).status, 421)
  } finally { c.stop() }
})

// A request target the URL parser rejects used to reject the async handler
// before the Host check ran, crashing the conductor.
test('an unparseable request target gets 421/400 and the harness stays up', async () => {
  const { c } = makeWorld()
  try {
    const port = await harnessPort(c)
    assert.equal((await raw(port, { path: '//x:99999', headers: { host: 'attacker.example' } })).status, 421)
    for (const path of ['//', '//x:99999', '//a%20b']) {
      assert.equal((await raw(port, { path })).status, 400, path)
    }
    assert.equal((await raw(port, { path: '/api/state' })).status, 200)
  } finally { c.stop() }
})

test('allowed Hosts: loopback, the public host, the pane origin hosts, the harness origin host, QA_ALLOWED_HOSTS', async () => {
  const { c, cfg } = makeWorld({
    cfg: {
      allowedHosts: ['qa.corp.example'], harnessOrigin: 'https://harness.example:8445',
      paneOrigins: { base: 'https://harness.example:8443', pr: 'https://harness.example:10000' },
    },
  })
  try {
    const port = await harnessPort(c)
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'h.ts.net', 'H.TS.NET:443', 'qa.corp.example', 'harness.example', 'HARNESS.example:8445']) {
      assert.equal((await raw(port, { path: '/api/state', headers: { host } })).status, 200, host)
    }
    // pane origins are read per request (a platform may assign them after start)
    assert.equal((await raw(port, { path: '/api/state', headers: { host: 'late.example' } })).status, 421)
    cfg.paneOrigins = { base: 'http://late.example:4101', pr: 'http://127.0.0.1:4102' }
    assert.equal((await raw(port, { path: '/api/state', headers: { host: 'late.example' } })).status, 200)
    const base = await proxyPort(c.servers.baseProxy)
    assert.equal((await raw(base, { path: '/', headers: { host: 'late.example:4101' } })).status, 503, 'proxies share the allowlist')
    assert.equal((await raw(base, { path: '/', headers: { host: 'harness.example' } })).status, 503)
  } finally { c.stop() }
})

// PR code in a pane runs in the reviewer's browser, and so does any page the
// reviewer has open: only the harness page itself may use the API. Another
// page can't read the answers, but its writes would run, and each read of
// /api/prs or /api/build-status spends GitHub API calls on the conductor's
// token.
test('every /api/* request from another page gets 403, reads and the event stream included; the page itself and non-browser clients pass', async () => {
  const { c, calls, github } = makeWorld()
  try {
    const port = await harnessPort(c)
    const host = `127.0.0.1:${port}`
    const hits = []
    github.listOpenPrs = async () => { hits.push('listOpenPrs'); return [] }
    github.prHead = async () => { hits.push('prHead'); return 'abc' }
    const json = { 'content-type': 'application/json' }
    const post = (path, headers) => raw(port, { method: 'POST', path, headers: { host, ...json, ...headers }, body: '{"pr":7,"verdict":"accept"}' })
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      // sec-fetch-site wins over a matching origin
      { 'sec-fetch-site': 'cross-site', origin: `http://${host}` },
      // a pane's page: another port of the same host
      { 'sec-fetch-site': 'same-site', origin: 'https://h.ts.net:10000' },
      { origin: 'http://attacker.example' },
      { origin: `http://127.0.0.1:${port + 1}` },
      { origin: 'null' },
      { origin: 'not a url' },
    ]) {
      // the check covers every /api/* request, routed or not
      for (const path of ['/api/teardown', '/qa/api/teardown', '/qa/api/session', '/qa/api/verdict', '/api/nope']) {
        const res = await post(path, headers)
        assert.equal(res.status, 403, `${path} ${JSON.stringify(headers)}`)
        assert.match(res.body, /cross-site request refused/)
      }
    }
    const reads = [
      '/qa/api/prs', '/api/prs', '/qa/api/build-status?pr=7', '/qa/api/state', '/qa/api/progress',
      '/qa/api/verdict/preview?verdict=accept', '/qa/api/nope',
    ]
    for (const headers of [
      // <img src="http://127.0.0.1:3100/qa/api/prs"> on another site
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      // fetch(url, { mode: 'no-cors' }) from a pane
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' },
      // new EventSource(url) from a pane
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: 'https://h.ts.net:10000' },
      // a link or window.open to the API
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      // an older browser's CORS read: Origin alone
      { origin: 'https://evil.example' },
    ]) {
      for (const path of reads) {
        const res = await raw(port, { path, headers: { host, ...headers } })
        assert.equal(res.status, 403, `${path} ${JSON.stringify(headers)}`)
        assert.match(res.body, /cross-site request refused/)
      }
    }
    assert.deepEqual(hits, [])
    assert.equal(calls.some(x => x[0] === 'teardown' || x[0] === 'ensureBuilt' || x[0] === 'comment'), false, 'a refused request does nothing')

    // the harness page's own fetches, the operator's own navigation, and curl
    for (const headers of [
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-site': 'none' },
      { origin: `http://${host}` },
      {},
    ]) {
      assert.equal((await post('/api/teardown', headers)).status, 200, JSON.stringify(headers))
      assert.equal((await raw(port, { path: '/qa/api/prs', headers: { host, ...headers } })).status, 200, JSON.stringify(headers))
    }
    assert.deepEqual(hits, ['listOpenPrs', 'listOpenPrs', 'listOpenPrs', 'listOpenPrs'])
    // the harness page at the harness origin's own host:port
    const own = { origin: 'https://h.ts.net:8444', host: 'h.ts.net:8444' }
    assert.equal((await raw(port, { method: 'POST', path: '/qa/api/session', body: '{"pr":7}', headers: { ...json, ...own } })).status, 202)
    // (the stream sends its headers with its first event, so a session runs)
    const stream = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/qa/api/progress', headers: withCap(port, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }) }, res => { res.destroy(); resolve(res) }).on('error', reject)
    })
    assert.equal(stream.statusCode, 200)
    // the page itself still opens from a link on any site
    for (const path of ['/qa', '/qa/harness.js']) {
      const res = await raw(port, { path, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
      assert.equal(res.status, 200, path)
    }
  } finally { c.stop() }
})

// A page at another port of the harness's hostname is same-origin with the
// handler that served it. If that handler proxies to the harness too (a stale
// tailscale serve mount), only the host:port check keeps the page out.
test('a browser /api/* request whose Host is another port of the harness hostname gets 403 not the harness origin; loopback Hosts and curl pass', async () => {
  const { c, calls } = makeWorld()
  try {
    const port = await harnessPort(c)
    for (const host of ['h.ts.net:8446', 'h.ts.net', 'h.ts.net:8443']) {
      for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { origin: `https://${host}` }]) {
        // the refusal names the harness origin, for the harness page's banner
        const read = await raw(port, { path: '/qa/api/state', headers: { host, ...headers } })
        assert.deepEqual([read.status, JSON.parse(read.body)], [403, { error: 'not the harness origin', harnessOrigin: 'https://h.ts.net:8444' }], `${host} ${JSON.stringify(headers)}`)
        const write = await raw(port, { method: 'POST', path: '/qa/api/teardown', body: '{}', headers: { host, 'content-type': 'application/json', ...headers } })
        assert.equal(write.status, 403, `${host} ${JSON.stringify(headers)}`)
      }
    }
    assert.equal(calls.some(x => x[0] === 'teardown'), false)
    // the harness origin itself
    assert.equal((await raw(port, { path: '/qa/api/state', headers: { host: 'h.ts.net:8444', 'sec-fetch-site': 'same-origin' } })).status, 200)
    assert.equal((await raw(port, { path: '/qa/api/state', headers: { host: 'H.TS.NET:8444', 'sec-fetch-site': 'same-origin' } })).status, 200)
    assert.equal((await raw(port, { path: '/qa/api/state', headers: { host: 'h.ts.net:8444', origin: 'https://h.ts.net:8444' } })).status, 200)
    // loopback Hosts: the harness opened at localhost, and nested demos
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal((await raw(port, { path: '/qa/api/state', headers: { host, 'sec-fetch-site': 'same-origin' } })).status, 200, host)
    }
    // curl through any handler
    assert.equal((await raw(port, { path: '/qa/api/state', headers: { host: 'h.ts.net:8446' } })).status, 200)
    // the page itself is not an API route
    assert.equal((await raw(port, { path: '/qa/', headers: { host: 'h.ts.net:8446', 'sec-fetch-site': 'none' } })).status, 200)
  } finally { c.stop() }
})

test('/api/state reports the harness origin', async () => {
  for (const [cfg, want] of [
    [{}, () => 'https://h.ts.net:8444'],
    [{ harnessOrigin: 'https://Q.example:8445/qa/', paneOrigins: { base: 'https://q.example:8443', pr: 'https://q.example:10000' } }, () => 'https://q.example:8445'],
    [{ publicHost: null }, port => `http://127.0.0.1:${port}`],
  ]) {
    const { c } = makeWorld({ cfg })
    try {
      const port = await harnessPort(c)
      assert.equal((await api(port, 'GET', '/api/state')).harnessOrigin, want(port), JSON.stringify(cfg))
    } finally { c.stop() }
  }
})

// A `::1` bind derives http://[::1]:<port>, and a CSP source can't name an
// IPv6 literal: no harness could frame the panes.
test('an IPv6-literal harness origin is logged as an error naming a localhost origin to use', async () => {
  const { c, logLines, errorLines } = makeWorld({ cfg: { harnessOrigin: 'http://[::1]:3100', paneOrigins: { base: 'http://[::1]:3101', pr: 'http://[::1]:3102' } } })
  try {
    const { base } = await allPorts(c)
    assert.ok(logLines.includes('[qa] harness at http://[::1]:3100/qa/'), logLines.join('\n'))
    assert.ok(
      errorLines.includes('[qa] the harness origin http://[::1]:3100 is an IPv6 literal, which frame-ancestors cannot name: the panes will stay blank; set QA_HARNESS_ORIGIN=http://localhost:3100, and both pane origins on localhost too'),
      errorLines.join('\n'),
    )
    assert.equal((await raw(base, { path: '/x' })).headers['content-security-policy'], "frame-ancestors 'self'")
  } finally { c.stop() }
})

// --- 0.3.0: frame locks ----------------------------------------------------------

const HARNESS_FRAME = { 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'strict-origin-when-cross-origin' }
const frameHeaders = res => Object.fromEntries(Object.keys(HARNESS_FRAME).map(k => [k, res.headers[k]]))

// The harness starts sessions and posts verdicts in one click, so a page that
// framed it could trick the operator into clicking (clickjacking). The
// Referrer-Policy keeps the harness origin in the Referer the panes check,
// whatever a browser's default.
test('every harness response forbids framing by other pages and sets the Referrer-Policy, 403s, 421s, 400s and errors included', async () => {
  const { c } = makeWorld()
  try {
    const port = await harnessPort(c)
    const cases = [
      [{ path: '/qa' }, 200],
      [{ path: '/qa/harness.js' }, 200],
      [{ path: '/qa/api/state' }, 200],
      [{ path: '/qa/api/build-status?pr=x' }, 400],
      [{ path: '/qa/api/verdict/preview?verdict=accept' }, 409],
      [{ path: '/qa/nope' }, 404],
      [{ method: 'POST', path: '/qa/api/teardown', headers: { 'sec-fetch-site': 'same-site' } }, 403],
      [{ path: '/qa/api/state', headers: { host: 'h.ts.net:8446', 'sec-fetch-site': 'same-origin' } }, 403],
      [{ method: 'POST', path: '/qa/api/teardown', headers: { 'content-type': 'text/plain' } }, 415],
      [{ method: 'POST', path: '/qa/api/session', body: '{}', headers: { 'content-type': 'application/json' } }, 400],
      [{ path: '/qa', headers: { host: 'attacker.example' } }, 421],
      [{ path: '//x:99999' }, 400],
    ]
    for (const [r, status] of cases) {
      const res = await raw(port, r)
      const label = `${r.method ?? 'GET'} ${r.path} ${JSON.stringify(r.headers ?? {})}`
      assert.equal(res.status, status, label)
      assert.deepEqual(frameHeaders(res), HARNESS_FRAME, label)
    }
    // the progress stream never ends (and sends its headers with the first
    // event): start a session, then check the stream's headers and hang up
    await api(port, 'POST', '/api/session', { pr: 7 })
    const stream = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/qa/api/progress', headers: capFor(port) }, res => { res.destroy(); resolve(res) }).on('error', reject)
    })
    assert.equal(stream.headers['content-type'], 'text/event-stream')
    assert.deepEqual(frameHeaders(stream), HARNESS_FRAME)
  } finally { c.stop() }
})

test('a harness 500 forbids framing too', async () => {
  const { c, github } = makeWorld()
  try {
    const port = await harnessPort(c)
    github.listOpenPrs = async () => { throw new Error('github down') }
    const res = await raw(port, { path: '/qa/api/prs' })
    assert.equal(res.status, 500)
    assert.deepEqual(frameHeaders(res), HARNESS_FRAME)
  } finally { c.stop() }
})

// The pane proxies sign every request in as the operator, so they too must
// tell the pane's own pages from others, and only the harness may frame them
// (as its Referer shows: frame-ancestors stops only the render).
test('both panes refuse other pages\' writes and subresource loads, and only the harness, at the origin derived from its bound port, may frame them', async () => {
  const { c } = makeWorld({ cfg: { publicHost: null } })
  try {
    const { harness, base, pr } = await allPorts(c)
    const HARNESS = `http://127.0.0.1:${harness}`
    await api(harness, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(harness, 'GET', '/api/state')).status === 'ready')
    for (const port of [base, pr]) {
      const other = port === base ? pr : base
      for (const site of ['same-site', 'cross-site']) {
        const res = await raw(port, { method: 'POST', path: '/x', body: '{}', headers: { 'sec-fetch-site': site, origin: HARNESS } })
        assert.equal(res.status, 403, `${port} ${site}`)
        assert.doesNotMatch(res.body, /pane-/)
      }
      const own = await raw(port, { method: 'POST', path: '/x', body: '{}', headers: { 'sec-fetch-site': 'same-origin' } })
      assert.equal(own.status, 200)
      // another page's <img> or no-cors fetch, and another page's frame
      for (const headers of [
        { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
        { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' },
        { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', referer: `http://127.0.0.1:${other}/` },
        { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', referer: `http://localhost:${harness}/` },
      ]) {
        const res = await raw(port, { path: '/page', headers })
        assert.equal(res.status, 403, `${port} ${JSON.stringify(headers)}`)
        assert.doesNotMatch(res.body, /pane-/)
        assert.equal(res.headers['content-security-policy'], `frame-ancestors 'self' ${HARNESS}`)
      }
      // the harness loading the pane in its iframe
      const page = await raw(port, {
        path: '/page',
        headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', referer: `${HARNESS}/` },
      })
      assert.equal(page.status, 200)
      assert.equal(page.headers['content-security-policy'], `frame-ancestors 'self' ${HARNESS}`)
      assert.equal(page.headers['x-content-type-options'], 'nosniff')
      assert.match(page.body, new RegExp(`<script src="/__qa/bridge\\.js" data-harness="${HARNESS}"></script></head>pane-`))
    }
  } finally { c.stop() }
})

test('a derived harness origin frames the panes and is logged', async () => {
  const { c, logLines, errorLines } = makeWorld({ cfg: { publicHost: null, frameAncestors: ['https://outer.example:8444'] } })
  try {
    const { harness, base, pr } = await allPorts(c)
    const origin = `http://127.0.0.1:${harness}`
    assert.ok(logLines.includes(`[qa] harness at ${origin}/qa/`), logLines.join('\n'))
    for (const port of [base, pr]) {
      assert.equal((await raw(port, { path: '/x' })).headers['content-security-policy'], `frame-ancestors 'self' ${origin} https://outer.example:8444`)
    }
    assert.equal(errorLines.some(l => /harness origin/.test(l)), false, errorLines.join('\n'))
  } finally { c.stop() }
  // a configured origin is logged as it is
  const configured = makeWorld()
  try {
    await harnessPort(configured.c)
    assert.ok(configured.logLines.includes('[qa] harness at https://h.ts.net:8444/qa/'), configured.logLines.join('\n'))
  } finally { configured.c.stop() }
})

// Off loopback, with no public host and no harness origin (a hand-built cfg:
// loadConfig refuses this one), nothing can name the harness origin.
test('with no harness origin startup logs an error, /api/state reports null, and only a pane may frame itself', async () => {
  const { c, logLines, errorLines } = makeWorld({ cfg: { publicHost: null, host: '0.0.0.0' } })
  try {
    const { harness, base, pr } = await allPorts(c)
    assert.ok(
      errorLines.includes('[qa] no harness origin (set QA_HARNESS_ORIGIN): only a pane can frame itself and the mirror is off'),
      errorLines.join('\n'),
    )
    assert.equal(logLines.some(l => l.startsWith('[qa] harness at')), false, logLines.join('\n'))
    assert.equal((await api(harness, 'GET', '/api/state')).harnessOrigin, null)
    await api(harness, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(harness, 'GET', '/api/state')).status === 'ready')
    for (const port of [base, pr]) {
      const page = await raw(port, { path: '/page' })
      assert.equal(page.headers['content-security-policy'], "frame-ancestors 'self'")
      // the bridge gets no harness to talk to
      assert.match(page.body, /<script src="\/__qa\/bridge\.js"><\/script><\/head>pane-/)
      // and no Referer admits a navigation from another site
      for (const referer of [undefined, 'http://127.0.0.1:1/']) {
        const headers = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', ...(referer ? { referer } : {}) }
        assert.equal((await raw(port, { path: '/page', headers })).status, 403, String(referer))
      }
    }
  } finally { c.stop() }
})

test('a pane 421 carries the pane frame-ancestors', async () => {
  const { c } = makeWorld()
  try {
    const { base, pr } = await allPorts(c)
    for (const port of [base, pr]) {
      const res = await raw(port, { path: '/x', headers: { host: 'attacker.example' } })
      assert.equal(res.status, 421)
      assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self' https://h.ts.net:8444")
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.equal(res.headers['x-frame-options'], undefined)
    }
  } finally { c.stop() }
})

// --- 0.3.0: start-time origin checks ---------------------------------------------

// startConductor for a check that must throw before anything starts. Should
// a check regress, the conductor it starts is stopped at once, so the test
// fails instead of its servers and reaper holding the process open.
function startOnly(cfgOverrides, adapterOverrides = {}) {
  const c = startConductor({
    cfg: {
      publicHost: 'h.ts.net', ports: { harness: 0, base: 0, pr: 0 }, idleMinutes: 30,
      paneOrigins: { base: 'https://h.ts.net:8443', pr: 'https://h.ts.net:10000' }, verdictLabels: { accept: 'ok', reject: 'nope' },
      ...cfgOverrides,
    },
    github: {},
    fsx: {},
    adapters: { provisioner: { sweep: () => { throw new Error('ran') } }, build: {}, ...adapterOverrides },
    log: { log() {}, error() {} },
  })
  c.stop()
  return c
}

test('startConductor refuses a cfg.harnessOrigin or cfg.frameAncestors entry that is not an http(s) origin', () => {
  for (const bad of ['h.ts.net:8444', 'file:///x', 'data:text/html,x', '*', 'https://a;b', '', 42]) {
    assert.throws(() => startOnly({ harnessOrigin: bad }), /cfg\.harnessOrigin must be an origin/, String(bad))
    assert.throws(() => startOnly({ frameAncestors: ['https://ok.example', bad] }), /cfg\.frameAncestors must be an origin/, String(bad))
  }
  assert.throws(() => startOnly({ publicHost: 'h.ts.net;x' }), /must be an origin/)
})

// Browsers send Fetch Metadata only to https and loopback origins. Without it,
// another page's <img> or <iframe> GET carries neither Sec-Fetch-Site nor
// Origin, and the guards take it for curl.
test('startConductor refuses a plain-http harness or pane origin off loopback', async () => {
  assert.throws(() => startOnly({ harnessOrigin: 'http://box.lan:3100' }), /^Error: cfg\.harnessOrigin http:\/\/box\.lan:3100: browsers send no Sec-Fetch-\* headers .*the harness API guard/)
  assert.throws(() => startOnly({ paneOrigins: { base: 'http://box.lan:3101', pr: 'https://h.ts.net:10000' } }), /^Error: cfg\.paneOrigins\.base http:\/\/box\.lan:3101: .*the pane request guard/)
  assert.throws(() => startOnly({ paneOrigins: { base: 'https://h.ts.net:8443', pr: 'http://192.168.1.5:3102/' } }), /^Error: cfg\.paneOrigins\.pr http:\/\/192\.168\.1\.5:3102: /)
  // https anywhere, and http on loopback, start
  for (const cfg of [
    { harnessOrigin: 'https://box.lan:3100', paneOrigins: { base: 'https://box.lan:3101', pr: 'https://box.lan:3102' } },
    { publicHost: null, harnessOrigin: 'http://localhost:3100', paneOrigins: { base: 'http://localhost:3101', pr: 'http://localhost:3102' } },
    { publicHost: null, harnessOrigin: 'http://127.0.0.1:3100', paneOrigins: { base: 'http://127.0.0.1:3101', pr: 'http://127.0.0.1:3102' } },
    { publicHost: null, harnessOrigin: 'http://[::1]:3100', paneOrigins: { base: 'http://[::1]:3101', pr: 'http://[::1]:3102' } },
  ]) {
    const { c } = makeWorld({ cfg })
    try {
      assert.equal((await api(await harnessPort(c), 'GET', '/api/state')).status, 'idle', JSON.stringify(cfg))
    } finally { c.stop() }
  }
})

test('startConductor refuses a harness origin, explicit or derived from publicHost, equal to a pane origin; equal pane placeholders start', async () => {
  assert.throws(() => startOnly({ harnessOrigin: 'https://H.TS.NET:8443/qa/' }), /harness origin https:\/\/h\.ts\.net:8443 is also the base pane's origin/)
  assert.throws(() => startOnly({ paneOrigins: { base: 'https://h.ts.net:8443', pr: 'https://h.ts.net:8444/' } }), /harness origin https:\/\/h\.ts\.net:8444 is also the pr pane's origin/)
  // derived from a fixed loopback port
  assert.throws(() => startOnly({ publicHost: null, ports: { harness: 3100, base: 0, pr: 0 }, paneOrigins: { base: 'http://127.0.0.1:3100', pr: 'x' } }), /base pane/)

  // the demo's placeholders are equal until its proxies listen; an
  // unparseable pane origin is skipped here
  for (const paneOrigins of [{ base: 'http://127.0.0.1', pr: 'http://127.0.0.1' }, { base: 'not a url', pr: 'https://h:10000' }]) {
    const { c } = makeWorld({ cfg: { publicHost: null, paneOrigins } })
    try {
      const port = await harnessPort(c)
      assert.equal((await api(port, 'GET', '/api/state')).status, 'idle', JSON.stringify(paneOrigins))
    } finally { c.stop() }
  }
})

// --- 0.3.1: the browser's own cookies ----------------------------------------------
// Cookies ignore ports: on a hostname the panes share with another app, the
// browser sends both panes that app's cookies, and those the other pane's
// scripts set.

test('the pane apps get no browser cookie unless cfg.forwardClientCookies names it', async () => {
  for (const [forwardClientCookies, want] of [[undefined, '(none)'], [[], '(none)'], [false, '(none)'], [['locale'], 'locale=fr']]) {
    const { c } = makeWorld({ cfg: { forwardClientCookies } })
    try {
      const port = await harnessPort(c)
      await api(port, 'POST', '/api/session', { pr: 7 })
      await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
      for (const server of ['baseProxy', 'prProxy']) {
        const res = await raw(await proxyPort(c.servers[server]), { path: '/cookie', headers: { cookie: 'rc_session=secret; planted=1; locale=fr' } })
        assert.deepEqual([res.status, res.body], [200, want], `${server} ${JSON.stringify(forwardClientCookies)}`)
      }
    } finally { c.stop() }
  }
})

// Each proxy's jar lasts as long as the conductor, and a provisioner may
// give the next session's app the same port: here every session's pane is
// the same app server, so a cookie left in a jar would reach it.
test('a session\'s pane apps never get the cookies an earlier session\'s apps set', async () => {
  const { c } = makeWorld()
  try {
    const port = await harnessPort(c)
    const panes = { base: await proxyPort(c.servers.baseProxy), pr: await proxyPort(c.servers.prProxy) }
    const cookieOf = async role => (await raw(panes[role], { path: '/cookie' })).body
    const open = async (body) => {
      assert.equal((await api(port, 'POST', '/api/session', body)).ok, true, JSON.stringify(body))
      await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    }
    const plant = async (pr) => {
      for (const role of ['base', 'pr']) {
        assert.equal((await raw(panes[role], { path: `/set?from_pr=${pr}` })).status, 200)
        assert.equal(await cookieOf(role), `from_pr=${pr}`, `${role} #${pr}`)
      }
    }
    const assertEmpty = async (how) => {
      for (const role of ['base', 'pr']) assert.equal(await cookieOf(role), '(none)', `${role} after ${how}`)
    }
    await open({ pr: 7 })
    await plant(7)
    await api(port, 'POST', '/api/teardown')
    await open({ pr: 8 })
    await assertEmpty('a teardown')
    await plant(8)
    await open({ pr: 9, takeover: true })
    await assertEmpty('a takeover')
    await plant(9)
    // the same PR opened again: no teardown, and the old apps serve until the new ones are ready
    assert.equal((await api(port, 'POST', '/api/session', { pr: 9 })).ok, true)
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    await assertEmpty('the same PR opened again')
  } finally { c.stop() }
})

// A boot that replaces a session without a teardown (the same PR opened again,
// or another opened after an error) must not leave the previous session's app
// or jar reachable while it runs: the new app may be a newer head commit on
// the same host port.
test('a new boot detaches both panes until it is ready', async () => {
  const hang = {}
  const { c } = makeWorld({ hang })
  try {
    const port = await harnessPort(c)
    const pr = await proxyPort(c.servers.prProxy)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.equal((await raw(pr, { path: '/set?from_pr=7' })).status, 200)
    hang[7] = deferred()
    assert.equal((await api(port, 'POST', '/api/session', { pr: 7 })).ok, true)
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status !== 'ready')
    assert.equal((await raw(pr, { path: '/cookie' })).status, 503, 'no app behind the pane while it boots')
    hang[7].resolve()
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.equal((await raw(pr, { path: '/cookie' })).body, '(none)')
  } finally { c.stop() }
})

test('startConductor refuses a cfg.forwardClientCookies that is not false or an array of cookie names, before anything starts', () => {
  let swept = false
  const provisioner = { sweep: () => { swept = true } }
  for (const bad of [true, '*', 'locale', ['*'], ['sess*'], ['a b'], [42]]) {
    assert.throws(
      () => startOnly({ forwardClientCookies: bad }, { provisioner }),
      /^Error: startConductor: cfg\.forwardClientCookies must be false or an array of cookie names \(RFC 6265 tokens; no wildcards: list each name\), got /,
      JSON.stringify(bad),
    )
  }
  assert.equal(swept, false, 'refused before the startup sweep')
})

// --- 0.3.0: the Tailscale identity gate ------------------------------------------

// tailscale serve in front, and the allowlist loadConfig requires there.
const GATED = { exposure: 'tailscale', allowedLogins: ['alice@github'] }
// What tailscale serve adds for a request from an allowed user's own device.
const ALLOWED = { 'tailscale-user-login': 'alice@github' }
const UPGRADE = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }
const LOOPBACK_PANES = { base: 'http://127.0.0.1:3101', pr: 'http://127.0.0.1:3102' }
// Pane origins not assigned yet, as the demo starts with them.
const PLACEHOLDERS = { base: 'http://127.0.0.1', pr: 'http://127.0.0.1' }

test('the harness refuses every route without an allowed identity, leaking nothing', async () => {
  const { c, calls } = makeWorld({ cfg: GATED })
  try {
    const port = await harnessPort(c)
    const requests = [
      { path: '/qa' }, { path: '/qa/harness.js' }, { path: '/qa/api/state' }, { path: '/api/state' },
      { path: '/qa/api/prs' }, { path: '/qa/api/progress' }, { path: '/qa/api/verdict/preview?verdict=accept' },
      { path: '/qa/api/nope' },
      { method: 'POST', path: '/qa/api/session', headers: { 'content-type': 'application/json' }, body: '{"pr":7}' },
      { method: 'POST', path: '/qa/api/verdict', headers: { 'content-type': 'application/json' }, body: '{"verdict":"accept"}' },
      { method: 'POST', path: '/qa/api/teardown' },
      { path: '/qa/api/state', headers: UPGRADE },
      // before the Host check and the URL parse, too
      { path: '/qa/api/state', headers: { host: 'attacker.example' } },
      { path: '//x:99999' },
    ]
    for (const identity of [{}, { 'tailscale-user-login': 'mallory@github' }]) {
      for (const r of requests) {
        const res = await raw(port, { ...r, headers: { ...r.headers, ...identity } })
        assert.equal(res.status, 403, `${r.method ?? 'GET'} ${r.path} ${JSON.stringify(identity)}`)
        assert.match(res.headers['content-type'], /^text\/plain/)
        assert.doesNotMatch(res.body, /login-|status|idle|ok|nope/)
      }
    }
    // nothing ran on the refused writes
    assert.equal((await api(port, 'GET', '/api/state', undefined, ALLOWED)).status, 'idle')
    assert.deepEqual(calls.filter(x => !x[0].startsWith('sweep')), [])
  } finally { c.stop() }
})

// What the expose CLI probes for before it publishes a port: the gate's 403,
// marked X-QA-Refusal: identity, on each of the three. A none-mode conductor
// marks no response, so the CLI refuses to publish it.
test('in tailscale mode every port\'s refusal carries X-QA-Refusal: identity; in none mode no response does', async () => {
  const gated = makeWorld({ cfg: GATED })
  const open = makeWorld()
  try {
    const probes = async c => {
      const ports = await allPorts(c)
      return Promise.all([[ports.harness, '/qa/api/state'], [ports.base, '/'], [ports.pr, '/']].map(([port, path]) => raw(port, { path })))
    }
    for (const res of await probes(gated.c)) {
      assert.equal(res.status, 403)
      assert.equal(res.headers['x-qa-refusal'], 'identity')
    }
    for (const res of await probes(open.c)) assert.equal(res.headers['x-qa-refusal'], undefined, String(res.status))
  } finally {
    gated.c.stop()
    open.c.stop()
  }
})

test('both pane proxies refuse every route, the bridge and upgrades without an allowed identity', async () => {
  const { c } = makeWorld({ cfg: GATED })
  try {
    const { harness, base, pr } = await allPorts(c)
    await api(harness, 'POST', '/api/session', { pr: 7 }, ALLOWED)
    await waitFor(async () => (await api(harness, 'GET', '/api/state', undefined, ALLOWED)).status === 'ready')
    for (const port of [base, pr]) {
      for (const identity of [{}, { 'tailscale-user-login': 'mallory@github' }]) {
        for (const r of [{ path: '/x' }, { path: '/__qa/bridge.js' }, { method: 'POST', path: '/api/x', body: '{}' }, { path: '/x', headers: UPGRADE }, { path: '/x', headers: { host: 'attacker.example' } }]) {
          const res = await raw(port, { ...r, headers: { ...r.headers, ...identity } })
          assert.equal(res.status, 403, `${port} ${r.path} ${JSON.stringify(identity)}`)
          assert.doesNotMatch(res.body, /pane-|bridge/)
        }
      }
    }
    assert.equal((await raw(base, { path: '/x', headers: ALLOWED })).body, 'pane-base')
    assert.equal((await raw(pr, { path: '/x', headers: ALLOWED })).body, 'pane-pr')
  } finally { c.stop() }
})

test('an allowed identity is served on all three, matched ignoring case', async () => {
  const { c } = makeWorld({ cfg: { ...GATED, allowedLogins: ['bob@example.com', 'Alice@github '] } })
  try {
    const { harness, base, pr } = await allPorts(c)
    const res = await raw(harness, { path: '/qa/api/state', headers: { 'tailscale-user-login': 'Alice@GitHub' } })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).status, 'idle')
    assert.equal((await raw(base, { path: '/x', headers: { 'tailscale-user-login': 'bob@example.com' } })).status, 503)
    assert.equal((await raw(pr, { path: '/x', headers: { 'tailscale-user-login': 'BOB@example.com' } })).status, 503)
  } finally { c.stop() }
})

// tailscale serve stamps every request from the reviewer's device with the
// reviewer's login, those PR code makes in the reviewer's browser included.
// The gate says which device; only the API guard, the Host allowlist and the
// pane guard say which page, so an allowed identity must not skip them.
test('with an allowed identity, another page\'s writes, a foreign Host, another host:port and a cross-site pane navigation are still refused', async () => {
  const { c, calls } = makeWorld({ cfg: GATED })
  try {
    const { harness, base, pr } = await allPorts(c)
    const session = headers => raw(harness, {
      method: 'POST', path: '/qa/api/session', body: '{"pr":7}', headers: { 'content-type': 'application/json', ...ALLOWED, ...headers },
    })
    // a pane's page, another site, and a page whose Origin isn't a URL
    for (const headers of [
      { 'sec-fetch-site': 'same-site', origin: 'https://h.ts.net:10000' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      { origin: 'not a url' },
    ]) {
      const res = await session(headers)
      assert.deepEqual([res.status, JSON.parse(res.body)], [403, { error: 'cross-site request refused' }], JSON.stringify(headers))
    }
    // a page at another port of the harness hostname
    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { origin: 'https://h.ts.net:9999' }]) {
      const res = await session({ host: 'h.ts.net:9999', ...headers })
      assert.deepEqual([res.status, JSON.parse(res.body).error], [403, 'not the harness origin'], JSON.stringify(headers))
    }
    assert.equal(calls.some(x => x[0] === 'ensureBuilt'), false, 'a refused write starts no boot')
    // a DNS-rebound page, on all three servers
    for (const port of [harness, base, pr]) {
      assert.equal((await raw(port, { path: '/qa/api/state', headers: { ...ALLOWED, host: 'attacker.example' } })).status, 421, String(port))
    }

    // the harness page itself starts the session
    assert.equal((await session({ host: 'h.ts.net:8444', 'sec-fetch-site': 'same-origin' })).status, 202)
    await waitFor(async () => (await api(harness, 'GET', '/api/state', undefined, ALLOWED)).status === 'ready')
    const navigate = { ...ALLOWED, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    for (const port of [base, pr]) {
      // a link or window.open on another site, which the harness did not make
      for (const referer of [undefined, 'https://evil.example/']) {
        const res = await raw(port, { path: '/page', headers: { ...navigate, ...(referer ? { referer } : {}) } })
        assert.equal(res.status, 403, `${port} ${referer}`)
        assert.match(res.body, /cross-site navigation refused/)
        assert.doesNotMatch(res.body, /pane-/)
      }
      // the harness opening the pane
      assert.equal((await raw(port, { path: '/page', headers: { ...navigate, referer: 'https://h.ts.net:8444/qa/' } })).status, 200, String(port))
    }
  } finally { c.stop() }
})

const EMPTY_LOGINS = "[qa] QA_ALLOWED_LOGINS is empty: every request will be refused; set cfg.allowedLogins, or exposure: 'none' if another front door authenticates"

test('with no allowed logins every request is refused, and startup says so', async () => {
  for (const allowedLogins of [[], undefined, [' ']]) {
    const { c, errorLines } = makeWorld({ cfg: { ...GATED, allowedLogins } })
    try {
      const { harness, base, pr } = await allPorts(c)
      for (const port of [harness, base, pr]) assert.equal((await raw(port, { path: '/', headers: ALLOWED })).status, 403)
      assert.ok(errorLines.includes(EMPTY_LOGINS), errorLines.join('\n'))
    } finally { c.stop() }
  }
})

test('refused requests do not count as pane activity', async () => {
  const { c } = makeWorld({ cfg: GATED })
  try {
    const { harness, base } = await allPorts(c)
    const before = (await api(harness, 'GET', '/api/state', undefined, ALLOWED)).lastActivity
    await new Promise(r => setTimeout(r, 5))
    assert.equal((await raw(base, { path: '/x' })).status, 403)
    assert.equal((await api(harness, 'GET', '/api/state', undefined, ALLOWED)).lastActivity, before)
  } finally { c.stop() }
})

// Is a request with no Tailscale identity served? On all three servers alike.
async function gated(c) {
  const ports = Object.values(await allPorts(c))
  const statuses = []
  for (const port of ports) statuses.push((await raw(port, { path: '/qa/api/state' })).status)
  assert.equal(new Set(statuses.map(s => s === 403)).size, 1, `all three agree: ${statuses}`)
  return statuses[0] === 403
}

// A cfg built in code, with no `exposure`, resolves the mode as loadConfig
// does: any address it answers to or listens on that is off loopback means
// it is meant to be reached from another machine.
test('a cfg without exposure is gated when an origin is not loopback and not when all are', async () => {
  const loopback = { exposure: undefined, publicHost: null, paneOrigins: LOOPBACK_PANES, allowedLogins: ['alice@github'] }
  for (const [cfg, want] of [
    [loopback, false],
    [{ ...loopback, harnessOrigin: 'http://localhost:3100', paneOrigins: { base: 'http://localhost:3101', pr: 'http://localhost:3102' }, allowedHosts: ['localhost'] }, false],
    // pane origins still placeholders, so the harness origin decides
    [{ ...loopback, harnessOrigin: 'https://h.ts.net:8444', paneOrigins: PLACEHOLDERS }, true],
    [{ ...loopback, paneOrigins: { ...LOOPBACK_PANES, pr: 'https://h.ts.net:10000' } }, true],
    [{ ...loopback, paneOrigins: { pr: LOOPBACK_PANES.pr } }, true],
    [{ ...loopback, paneOrigins: { ...LOOPBACK_PANES, base: 'not yet' } }, true],
    [{ ...loopback, allowedHosts: ['box.ts.net'] }, true],
    // makeWorld's https layout
    [{ exposure: undefined, allowedLogins: ['alice@github'] }, true],
  ]) {
    const { c } = makeWorld({ cfg })
    try {
      assert.equal(await gated(c), want, JSON.stringify(cfg))
    } finally { c.stop() }
  }
})

test('a cfg without exposure, with publicHost and loopback pane origins, is gated (the derived harness origin counts)', async () => {
  // loopback placeholders: pane origins on another host than the harness's
  // can't start once set (the pane cookie wouldn't reach them)
  const { c } = makeWorld({ cfg: { exposure: undefined, publicHost: 'h.ts.net', paneOrigins: PLACEHOLDERS, allowedLogins: ['alice@github'] } })
  try {
    assert.equal(await gated(c), true)
    const { harness } = await allPorts(c)
    assert.equal((await api(harness, 'GET', '/api/state', undefined, ALLOWED)).harnessOrigin, 'https://h.ts.net:8444')
  } finally { c.stop() }
})

test('tailscale mode on a non-loopback host, or an unknown mode, refuses to start', async () => {
  const loopback = { publicHost: null, paneOrigins: LOOPBACK_PANES, harnessOrigin: 'http://127.0.0.1:3100', allowedLogins: ['alice@github'] }
  for (const [cfg, why] of [
    [{ ...loopback, exposure: 'tailscale', host: '0.0.0.0' }, "cfg.exposure is 'tailscale'"],
    // a non-loopback bind alone makes the default tailscale
    [{ ...loopback, host: '0.0.0.0' }, 'exposure defaults to tailscale because QA_BIND_HOST=0.0.0.0 is not loopback'],
    [{ ...loopback, host: '::' }, 'exposure defaults to tailscale because QA_BIND_HOST=:: is not loopback'],
    [{ host: '192.168.1.5', allowedLogins: ['alice@github'] }, 'exposure defaults to tailscale because QA_PUBLIC_HOST=h.ts.net is not loopback'],
  ]) {
    assert.throws(() => startOnly(cfg), err => {
      assert.ok(err.message.startsWith(`startConductor: ${why}, so cfg.host must be a loopback address: tailscale serve on this host is the only supported front (got ${JSON.stringify(cfg.host)})`), err.message)
      assert.ok(err.message.endsWith(", or set exposure: 'none' if another front door authenticates"), err.message)
      return true
    }, JSON.stringify(cfg))
  }
  for (const exposure of ['Tailscale', 'off', '', 0, true, {}]) {
    assert.throws(() => startOnly({ ...loopback, exposure }), /^Error: startConductor: cfg\.exposure must be 'none' or 'tailscale', got /, JSON.stringify(exposure))
  }
  // none mode still binds anywhere (behind another front door), and
  // tailscale mode any loopback address (not 127.0.0.2: macOS has only .1)
  for (const [cfg, want] of [[{ exposure: 'none', host: '0.0.0.0' }, ['0.0.0.0']], [{ ...GATED, host: 'localhost' }, ['127.0.0.1', '::1']]]) {
    const { c } = makeWorld({ cfg })
    try {
      await harnessPort(c)
      assert.ok(want.includes(c.servers.harness.address().address), JSON.stringify(cfg))
    } finally { c.stop() }
  }
})

// `[::1]` passed the tailscale bind check as loopback, then listen() failed
// with ENOTFOUND, which nothing handled: the process crashed.
test('a bracketed cfg.host refuses to start, in either mode', () => {
  for (const cfg of [GATED, { exposure: 'none' }, { exposure: undefined }, { publicHost: null, paneOrigins: LOOPBACK_PANES, ports: { harness: 3100, base: 0, pr: 0 } }]) {
    for (const [host, bare] of [['[::1]', '::1'], ['[::]', '::']]) {
      assert.throws(
        () => startOnly({ ...cfg, host }),
        { message: `startConductor: cfg.host is a listen address, which takes an IPv6 literal without brackets: use "${bare}", not "${host}"` },
        `${host} ${JSON.stringify(cfg)}`,
      )
    }
  }
})

test('the identity 403 carries the harness frame headers on the harness, and the pane policy on each pane', async () => {
  const { c } = makeWorld({ cfg: GATED })
  try {
    const { harness, base, pr } = await allPorts(c)
    for (const path of ['/qa', '/qa/api/state']) {
      const res = await raw(harness, { path })
      assert.equal(res.status, 403)
      assert.deepEqual(frameHeaders(res), HARNESS_FRAME, path)
      assert.equal(res.headers['cache-control'], 'no-store')
    }
    for (const port of [base, pr]) {
      const res = await raw(port, { path: '/x' })
      assert.equal(res.status, 403)
      assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self' https://h.ts.net:8444")
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.equal(res.headers['x-frame-options'], undefined)
    }
  } finally { c.stop() }
})

test('startup says whether the gate is on', async () => {
  for (const [cfg, logged, errored] of [
    [GATED, '[qa] identity gate on: 1 allowed login', null],
    [{ ...GATED, allowedLogins: ['alice@github', 'bob@github', ''] }, '[qa] identity gate on: 2 allowed logins', null],
    [{ ...GATED, allowedLogins: [] }, '[qa] identity gate on: 0 allowed logins', EMPTY_LOGINS],
    [{}, '[qa] identity gate off (QA_EXPOSURE=none)', null],
    [{ exposure: undefined, publicHost: null, paneOrigins: LOOPBACK_PANES }, '[qa] identity gate off (QA_EXPOSURE=none)', null],
    // a defaulted mode says why, a pane origin left unset at start included
    [
      { exposure: undefined, publicHost: null, paneOrigins: { pr: LOOPBACK_PANES.pr } },
      '[qa] identity gate on (exposure defaults to tailscale because QA_BASE_ORIGIN (unset) is not loopback): 0 allowed logins', EMPTY_LOGINS,
    ],
    [
      { exposure: undefined, allowedLogins: ['alice@github'] },
      '[qa] identity gate on (exposure defaults to tailscale because QA_PUBLIC_HOST=h.ts.net is not loopback): 1 allowed login', null,
    ],
  ]) {
    const { c, logLines, errorLines } = makeWorld({ cfg })
    try {
      await allPorts(c)
      assert.ok(logLines.includes(logged), `${JSON.stringify(cfg)}\n${logLines.join('\n')}`)
      assert.equal(logLines.filter(l => l.startsWith('[qa] identity gate')).length, 1, logLines.join('\n'))
      assert.deepEqual(errorLines.filter(l => /QA_ALLOWED_LOGINS/.test(l)), errored ? [errored] : [], JSON.stringify(cfg))
    } finally { c.stop() }
  }
})

test('POST /api/session, /api/verdict and /api/teardown require application/json (else 415)', async () => {
  const { c, calls } = makeWorld()
  try {
    const port = await harnessPort(c)
    const post = (path, contentType, body = '{}') => raw(port, { method: 'POST', path, headers: contentType ? { 'content-type': contentType } : {}, body })
    for (const path of ['/api/session', '/api/verdict', '/api/teardown', '/qa/api/teardown']) {
      for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
        assert.equal((await post(path, type)).status, 415, `${path} ${type}`)
      }
    }
    assert.equal(calls.some(x => x[0] === 'teardown' || x[0] === 'ensureBuilt'), false)
    assert.equal((await post('/api/teardown', 'Application/JSON; charset=utf-8')).status, 200)
    assert.equal((await post('/api/session', 'application/json', JSON.stringify({ pr: 7 }))).status, 202)
  } finally { c.stop() }
})

// --- 0.2.0: generic build progress ----------------------------------------------

test('a build progress message reaches SSE and /api/state', async () => {
  const hang = { 7: deferred() }
  const { c, adapters } = makeWorld({ hang })
  let notify = null
  adapters.build.subscribeBuild = cb => { notify = cb }
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(() => notify)
    notify({ message: 'installing dependencies for #7 (abc1234)…' })
    const events = await sseEvents(port, evs => evs.some(e => e.kind === 'build'))
    const ev = events.find(e => e.kind === 'build')
    assert.deepEqual({ ...ev, at: undefined }, { at: undefined, kind: 'build', runUrl: null, runStatus: null, runConclusion: null, message: 'installing dependencies for #7 (abc1234)…' })
    assert.deepEqual((await api(port, 'GET', '/api/state')).buildRun, { url: null, status: null, conclusion: null, message: 'installing dependencies for #7 (abc1234)…' })

    notify({ runUrl: 'https://github.com/acme/widget/actions/runs/1', runStatus: 'in_progress' })
    assert.deepEqual((await api(port, 'GET', '/api/state')).buildRun, { url: 'https://github.com/acme/widget/actions/runs/1', status: 'in_progress', conclusion: null, message: null })
  } finally { c.stop() }
})

test('a run\'s conclusion reaches SSE and /api/state beside its status', async () => {
  const RUN = 'https://github.com/acme/widget/actions/runs/7'
  const hang = { 7: deferred() }
  const { c, adapters } = makeWorld({ hang })
  let notify = null
  adapters.build.subscribeBuild = cb => { notify = cb }
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(() => notify)
    notify({ runUrl: RUN, runStatus: 'completed', runConclusion: 'failure' })
    const events = await sseEvents(port, evs => evs.some(e => e.kind === 'build'))
    const ev = events.find(e => e.kind === 'build')
    assert.deepEqual({ ...ev, at: undefined }, { at: undefined, kind: 'build', runUrl: RUN, runStatus: 'completed', runConclusion: 'failure', message: null })
    assert.deepEqual((await api(port, 'GET', '/api/state')).buildRun, { url: RUN, status: 'completed', conclusion: 'failure', message: null })
  } finally { c.stop() }
})

// A BuildConvention built on createGithub's preview helpers, end to end: the
// dispatched run fails, the boot fails at ensuring-image without waiting out
// the image timeout, and buildRun ends on the run's conclusion.
test('a preview run that fails ends the boot at ensuring-image, and buildRun keeps its conclusion', async () => {
  const RUN = 'https://github.com/acme/widget/actions/runs/7'
  let run = { status: 'queued', conclusion: null }
  const reply = (status, body, headers = {}) => ({ ok: true, status, headers: new Headers(headers), json: async () => body, text: async () => '' })
  const fetchFn = async url => {
    if (url.endsWith('/dispatches')) return reply(204, null, { date: 'Wed, 07 Oct 2026 12:00:00 GMT' })
    if (url.includes('/user/packages/')) return reply(200, [])
    if (url.includes('/runs?')) {
      return reply(200, { workflow_runs: [{ html_url: RUN, event: 'workflow_dispatch', created_at: '2026-10-07T12:00:03Z', name: 'Preview', display_title: 'Preview', head_branch: 'main', ...run }] })
    }
    throw new Error(`unexpected ${url}`)
  }
  const gh = createGithub({ token: 't', repo: 'acme/widget', fetchFn, packageName: 'widget' })
  const { c, adapters } = makeWorld()
  let onBuild = null
  let sleeps = 0
  adapters.build.subscribeBuild = cb => { onBuild = cb }
  adapters.build.ensureBuilt = async (pr, { signal } = {}) => {
    await gh.dispatchPreviewBuild(pr)
    await gh.awaitPreviewImage(pr, 'a'.repeat(40), {
      signal,
      sleepFn: async () => { if (++sleeps === 2) run = { status: 'completed', conclusion: 'failure' } },
      onRun: r => onBuild({ runUrl: r.url, runStatus: r.status, runConclusion: r.conclusion }),
    })
  }
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
    assert.deepEqual(st.error, { step: 'ensuring-image', message: `preview build failed (conclusion: failure): ${RUN}` })
    assert.deepEqual(st.buildRun, { url: RUN, status: 'completed', conclusion: 'failure', message: null })
    assert.equal(sleeps, 2) // the poll after the run concluded ended the wait
  } finally { c.stop() }
})

// The same, for a BuildConvention written before onRun: it surfaced one
// findPreviewRun snapshot right after dispatching, before GitHub listed the
// new run, so the snapshot is an older run. The failure's err.run still lands
// in buildRun, and the error's run link is the run that failed.
test('a failed preview run reaches buildRun and the error event through err.run, with no onRun', async () => {
  const OLD = 'https://github.com/acme/widget/actions/runs/3'
  const RUN = 'https://github.com/acme/widget/actions/runs/7'
  let polls = 0
  const reply = (status, body, headers = {}) => ({ ok: true, status, headers: new Headers(headers), json: async () => body, text: async () => '' })
  const fetchFn = async url => {
    if (url.endsWith('/dispatches')) return reply(204, null, { date: 'Wed, 07 Oct 2026 12:00:00 GMT' })
    if (url.includes('/user/packages/')) { polls += 1; return reply(200, []) }
    if (url.includes('/runs?')) {
      const old = { id: 3, html_url: OLD, event: 'workflow_dispatch', created_at: '2026-10-07T11:00:00Z', name: 'Preview', display_title: 'Preview', head_branch: 'main', status: 'completed', conclusion: 'failure' }
      const ours = { id: 7, html_url: RUN, event: 'workflow_dispatch', created_at: '2026-10-07T12:00:03Z', name: 'Preview', display_title: 'Preview', head_branch: 'main', status: 'completed', conclusion: 'failure' }
      return reply(200, { workflow_runs: polls === 0 ? [old] : [ours, old] })
    }
    throw new Error(`unexpected ${url}`)
  }
  const gh = createGithub({ token: 't', repo: 'acme/widget', fetchFn, packageName: 'widget' })
  const { c, adapters } = makeWorld()
  let onBuild = null
  adapters.build.subscribeBuild = cb => { onBuild = cb }
  adapters.build.ensureBuilt = async (pr, { signal } = {}) => {
    await gh.dispatchPreviewBuild(pr)
    const run = await gh.findPreviewRun(pr)
    onBuild({ runUrl: run.url, runStatus: run.status })
    await gh.awaitPreviewImage(pr, 'a'.repeat(40), { signal, sleepFn: async () => {} })
  }
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
    assert.deepEqual(st.error, { step: 'ensuring-image', message: `preview build failed (conclusion: failure): ${RUN}` })
    assert.deepEqual(st.buildRun, { url: RUN, status: 'completed', conclusion: 'failure', message: null })
    const events = await sseEvents(port, evs => evs.some(e => e.kind === 'error'))
    const builds = events.filter(e => e.kind === 'build').map(e => [e.runUrl, e.runStatus, e.runConclusion])
    assert.deepEqual(builds, [[OLD, 'completed', null], [RUN, 'completed', 'failure']])
    const error = events.find(e => e.kind === 'error')
    assert.equal(error.runUrl, RUN)
    assert.ok(events.indexOf(error) > events.findLastIndex(e => e.kind === 'build'), 'the run is broadcast before the error')
  } finally { c.stop() }
})

test('an ensureBuilt error\'s run updates buildRun only with string fields, and only when it names a run', async () => {
  for (const [run, want] of [
    [{ url: 'https://github.com/acme/widget/actions/runs/9', status: 'completed', conclusion: 'cancelled', extra: 1 }, { url: 'https://github.com/acme/widget/actions/runs/9', status: 'completed', conclusion: 'cancelled', message: null }],
    [{ url: 42, status: 'completed', conclusion: { x: 1 } }, { url: null, status: 'completed', conclusion: null, message: null }],
    ['not an object', { url: null, status: null, conclusion: null, message: 'before' }],
    [{ conclusion: 'failure' }, { url: null, status: null, conclusion: null, message: 'before' }],
  ]) {
    const { c, adapters } = makeWorld()
    adapters.build.subscribeBuild = cb => { adapters.notify = cb }
    adapters.build.ensureBuilt = async () => {
      adapters.notify({ message: 'before' })
      throw Object.assign(new Error('build failed'), { run })
    }
    try {
      const port = await harnessPort(c)
      await api(port, 'POST', '/api/session', { pr: 7 })
      const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
      assert.deepEqual(st.buildRun, want, JSON.stringify(run))
    } finally { c.stop() }
  }
})

test('a run on an error from a later stage than the build is not taken for the build\'s', async () => {
  const { c, adapters } = makeWorld()
  adapters.build.subscribeBuild = cb => { adapters.notify = cb }
  adapters.build.ensureBuilt = async () => { adapters.notify({ message: 'built' }) }
  adapters.provisioner.launchServices = async () => {
    throw Object.assign(new Error('launch failed'), { run: { url: 'https://example.com/runs/1', status: 'completed', conclusion: 'failure' } })
  }
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
    assert.equal(st.error.step, 'starting')
    assert.deepEqual(st.buildRun, { url: null, status: null, conclusion: null, message: 'built' })
  } finally { c.stop() }
})

// --- 0.2.0: blocked readiness ---------------------------------------------------

test('/api/prs passes a blocked reason through', async () => {
  const { c, adapters } = makeWorld()
  try {
    const port = await harnessPort(c)
    adapters.build.describePrs = async prs => prs.map(p => ({ number: p.number, status: 'blocked', reason: "head branch is in @eve's fork (eve/widget), not the author's", runUrl: null }))
    const row = (await api(port, 'GET', '/api/prs')).prs[0]
    assert.equal(row.imageStatus, 'blocked')
    assert.equal(row.reason, "head branch is in @eve's fork (eve/widget), not the author's")
  } finally { c.stop() }
})

test('/api/build-status uses github.prInfo when available and adds reason only when blocked', async () => {
  const { c, adapters, github } = makeWorld()
  github.prInfo = async num => ({
    number: num, headSha: 'abc', author: 'eve', authorAssociation: 'CONTRIBUTOR', isDraft: false, headRepo: 'eve/widget', headOwner: 'eve',
  })
  try {
    const port = await harnessPort(c)
    let seen = null
    adapters.build.describePrs = async prs => { seen = prs; return [{ number: 7, status: 'blocked', reason: 'not trusted', runUrl: null }] }
    assert.deepEqual(await api(port, 'GET', '/api/build-status?pr=7'), { pr: 7, status: 'blocked', exists: false, runUrl: null, reason: 'not trusted' })
    assert.deepEqual(seen, [{ number: 7, headSha: 'abc', author: 'eve', authorAssociation: 'CONTRIBUTOR', headRepo: 'eve/widget', headOwner: 'eve' }])

    adapters.build.describePrs = async () => [{ number: 7, status: 'built', reason: 'ignored', runUrl: null }]
    assert.deepEqual(await api(port, 'GET', '/api/build-status?pr=7'), { pr: 7, status: 'built', exists: true, runUrl: null })
  } finally { c.stop() }
})

// --- 0.2.0: failure log tails ---------------------------------------------------

test('err.logTail reaches the SSE error event (pane stage and build stage)', async () => {
  const pane = makeWorld({ failAt: 'launchServices' })
  try {
    const port = await harnessPort(pane.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const events = await sseEvents(port, evs => evs.some(e => e.kind === 'error'))
    const err = events.find(e => e.kind === 'error')
    assert.deepEqual([err.step, err.message, err.logTail], ['starting', 'launch failed', 'tail-lines'])
  } finally { pane.c.stop() }

  const build = makeWorld()
  build.adapters.build.ensureBuilt = async () => {
    throw Object.assign(new Error('install failed for #7 (abc1234): pnpm exited 1'), { logTail: 'ERR_PNPM_FETCH_404' })
  }
  try {
    const port = await harnessPort(build.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const events = await sseEvents(port, evs => evs.some(e => e.kind === 'error'))
    const err = events.find(e => e.kind === 'error')
    assert.deepEqual([err.step, err.logTail], ['ensuring-image', 'ERR_PNPM_FETCH_404'])
    assert.equal(build.calls.some(x => x[0] === 'logs'), false)
  } finally { build.c.stop() }
})

// A readBaseEnv failure leaves no role, so bootSession attaches no tail and the
// server asks the Provisioner itself. logs() may be synchronous.
test('the fallback log tail tolerates a synchronous logs(), returning or throwing', async () => {
  const cases = [
    [() => 'tail', 'tail'],
    [() => { throw new Error('container gone') }, ''],
    [() => ({ not: 'a string' }), ''],
  ]
  for (const [logs, want] of cases) {
    const w = makeWorld({ readBaseEnv: async () => { throw new Error('x') } })
    w.adapters.provisioner.logs = logs
    try {
      const port = await harnessPort(w.c)
      await api(port, 'POST', '/api/session', { pr: 7 })
      const events = await sseEvents(port, evs => evs.some(e => e.kind === 'error'))
      const err = events.find(e => e.kind === 'error')
      assert.deepEqual([err.step, err.message, err.logTail], ['migrating', 'x', want])
      assert.equal((await api(port, 'GET', '/api/state')).status, 'error', 'the harness is still up')
    } finally { w.c.stop() }
  }
})

// --- 0.2.0: shutdown -------------------------------------------------------------

test('shutdown() aborts the boot, tears down both panes, ends SSE and closes all three servers', async () => {
  const hang = { 9: deferred() }
  const { conductor, closeApps, calls } = makeWorld({ hang })
  try {
    const port = await proxyPort(conductor.servers.harness)
    for (const s of [conductor.servers.baseProxy, conductor.servers.prProxy]) await proxyPort(s)
    await api(port, 'POST', '/api/session', { pr: 9 })
    await waitFor(() => calls.some(x => x[0] === 'ensureBuilt' && x[1] === 9))

    // an open SSE client must not hold the harness open
    const res = await fetch(`http://127.0.0.1:${port}/api/progress`)
    const reader = res.body.getReader()
    await reader.read()

    await conductor.shutdown()
    assert.deepEqual(calls.filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr'])
    for (const name of ['harness', 'baseProxy', 'prProxy']) assert.equal(conductor.servers[name].listening, false, name)
    for (;;) {
      const ended = await reader.read().then(r => r.done, () => true)
      if (ended) break
    }
    // the aborted boot's late failure is ignored; a second shutdown is a no-op
    hang[9].reject(new Error('late'))
    await conductor.shutdown()
    assert.equal(calls.filter(x => x[0] === 'teardown').length, 2)
  } finally { closeApps() }
})

// Regression: a POST accepted while shutdown() awaited the (slow) teardown
// started a boot that nothing aborted, provisioning after the servers closed.
test('once shutdown() begins, writes get 503 and no boot starts', async () => {
  const { conductor, closeApps, calls, adapters } = makeWorld()
  adapters.provisioner.teardown = async ({ paneRef }) => {
    calls.push(['teardown', paneRef.role])
    await new Promise(r => setTimeout(r, 100))
  }
  try {
    const port = await proxyPort(conductor.servers.harness)
    for (const s of [conductor.servers.baseProxy, conductor.servers.prProxy]) await proxyPort(s)
    const done = conductor.shutdown()
    await waitFor(() => calls.some(x => x[0] === 'teardown'))
    const post = await raw(port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr: 7 }) })
    assert.equal(post.status, 503)
    assert.equal((await raw(port, { path: '/api/state' })).status, 200, 'reads still answer')
    await done
    await new Promise(r => setTimeout(r, 50))
    assert.equal(calls.some(x => x[0] === 'ensureBuilt'), false, 'no boot after shutdown')
  } finally { closeApps() }
})

test('a takeover whose teardown overlaps shutdown() starts no boot', async () => {
  const { conductor, closeApps, calls, adapters } = makeWorld()
  try {
    const port = await proxyPort(conductor.servers.harness)
    for (const s of [conductor.servers.baseProxy, conductor.servers.prProxy]) await proxyPort(s)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    adapters.provisioner.teardown = async ({ paneRef }) => {
      calls.push(['teardown', paneRef.role])
      await new Promise(r => setTimeout(r, 100))
    }
    const takeover = raw(port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr: 8, takeover: true }) })
    await waitFor(() => calls.some(x => x[0] === 'teardown'))
    await conductor.shutdown()
    assert.equal((await takeover).status, 503)
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(calls.filter(x => x[0] === 'ensureBuilt').map(x => x[1]), [7], 'the takeover never booted')
  } finally { closeApps() }
})

test('shutdown() right after start still closes every server', async () => {
  const { conductor, closeApps } = makeWorld()
  try {
    await conductor.shutdown()
    await new Promise(r => setTimeout(r, 20))
    for (const name of ['harness', 'baseProxy', 'prProxy']) assert.equal(conductor.servers[name].listening, false, name)
  } finally { closeApps() }
})

// --- 0.2.1: boots wait for the startup sweep ------------------------------------

// A restart mid-session leaves orphans, which the startup sweep removes (the
// docker Provisioner: every labelled container, then the network). A boot that
// raced it could have its fresh containers and network removed mid-boot.
const WAITING = 'waiting for startup cleanup…'
const buildMessages = events => events.filter(e => e.kind === 'build').map(e => e.message)

test('a boot waits for the startup sweep before building or provisioning', async () => {
  const sweepGate = deferred()
  const { c, calls } = makeWorld({ sweepGate })
  try {
    const port = await harnessPort(c)
    await waitFor(() => calls.some(x => x[0] === 'sweep'))
    assert.deepEqual(await api(port, 'POST', '/api/session', { pr: 7 }), { ok: true })
    await new Promise(r => setTimeout(r, 50))
    assert.equal(calls.some(x => x[0] === 'ensureBuilt' || x[0] === 'provisionDatabase'), false, 'nothing runs before the sweep settles')
    assert.equal((await api(port, 'GET', '/api/state')).status, 'ensuring-image')

    sweepGate.resolve()
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    const order = calls.map(x => x[0])
    assert.ok(order.indexOf('sweep-done') < order.indexOf('ensureBuilt'))
    assert.ok(order.indexOf('sweep-done') < order.indexOf('provisionDatabase'))
  } finally { c.stop() }
})

test('a failed startup sweep is logged and the boot waiting on it still reaches ready', async () => {
  const sweepGate = deferred()
  const { c, errorLines } = makeWorld({ sweepGate, sweepFails: true })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    sweepGate.resolve() // the sweep now rejects
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.equal(st.error, null)
    assert.ok(errorLines.some(l => l.includes('startup sweep failed') && l.includes('docker unavailable')))

    await api(port, 'POST', '/api/teardown')
    await api(port, 'POST', '/api/session', { pr: 7 })
    const second = await sseEvents(port, evs => evs.some(e => e.kind === 'ready'))
    assert.deepEqual(buildMessages(second), [], 'a failed sweep is settled: later boots show no cleanup message')
  } finally { c.stop() }
})

test('a sweep that rejects with a non-Error is logged and blocks no boot', async () => {
  const sweepGate = deferred()
  const { c, errorLines } = makeWorld({ provisioner: { sweep: async () => { await sweepGate.promise; throw undefined } } })
  const settled = async port => waitFor(async () => {
    const s = await api(port, 'GET', '/api/state')
    return (s.status === 'ready' || s.status === 'error') && s
  })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    sweepGate.resolve() // the sweep now rejects, with a boot waiting on it
    const st = await settled(port)
    assert.deepEqual([st.status, st.error], ['ready', null])
    assert.ok(errorLines.some(l => l.includes('startup sweep failed: undefined')))

    await api(port, 'POST', '/api/teardown')
    await api(port, 'POST', '/api/session', { pr: 7 })
    const second = await settled(port)
    assert.deepEqual([second.status, second.error], ['ready', null], 'later boots are not blocked either')
  } finally { c.stop() }
})

test('a sweep that throws synchronously neither stops the conductor nor blocks boots', async () => {
  const { c, errorLines } = makeWorld({ provisioner: { sweep: () => { throw new Error('no docker socket') } } })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.ok(errorLines.some(l => l.includes('startup sweep failed') && l.includes('no docker socket')))
  } finally { c.stop() }
})

test('a teardown while a boot waits for the sweep leaves the session idle; the boot never resumes', async () => {
  const sweepGate = deferred()
  const { c, calls } = makeWorld({ sweepGate })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await api(port, 'POST', '/api/teardown')
    assert.equal((await api(port, 'GET', '/api/state')).status, 'idle')

    sweepGate.resolve()
    await waitFor(() => calls.some(x => x[0] === 'sweep-done'))
    await new Promise(r => setTimeout(r, 50))
    const st = await api(port, 'GET', '/api/state')
    assert.deepEqual([st.status, st.pr, st.error, st.buildRun], ['idle', null, null, null])
    assert.equal(calls.some(x => x[0] === 'ensureBuilt' || x[0] === 'provisionDatabase'), false)
    // it ran no PR code, so no cleanup follows it
    assert.equal(calls.filter(x => x[0] === 'teardown').length, 2)
    const events = await sseEvents(port, evs => evs.some(e => e.kind === 'torn-down'))
    assert.deepEqual(buildMessages(events), [WAITING], 'no cleanup-done message for a torn-down boot')
  } finally { c.stop() }
})

test('a takeover while a boot waits for the sweep boots only the new PR', async () => {
  const sweepGate = deferred()
  const { c, calls } = makeWorld({ sweepGate })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 1 })
    assert.deepEqual(await api(port, 'POST', '/api/session', { pr: 2, takeover: true }), { ok: true })
    sweepGate.resolve()
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.deepEqual([st.pr, st.prTag], [2, 'img:pr-2'])
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(calls.filter(x => x[0] === 'ensureBuilt').map(x => x[1]), [2], 'the taken-over boot never resumed')
  } finally { c.stop() }
})

test('with no provisioner.sweep a boot starts at once, with no cleanup message', async () => {
  const { c, calls, logLines } = makeWorld({ provisioner: { sweep: undefined } })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    assert.ok(calls.some(x => x[0] === 'ensureBuilt'), 'the boot was building before POST /api/session answered')
    const events = await sseEvents(port, evs => evs.some(e => e.kind === 'ready'))
    assert.deepEqual(buildMessages(events), [])
    assert.equal(logLines.some(l => l.includes('sweep')), false)
  } finally { c.stop() }
})

test('the harness shows the sweep wait only while the sweep is pending', async () => {
  const sweepGate = deferred()
  const { c } = makeWorld({ sweepGate })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const waiting = await sseEvents(port, evs => evs.some(e => e.kind === 'build'))
    const ev = waiting.find(e => e.kind === 'build')
    assert.deepEqual({ ...ev, at: undefined }, { at: undefined, kind: 'build', runUrl: null, runStatus: null, runConclusion: null, message: WAITING })
    assert.deepEqual((await api(port, 'GET', '/api/state')).buildRun, { url: null, status: null, conclusion: null, message: WAITING })

    // once the sweep settles the message is replaced before the boot moves on
    sweepGate.resolve()
    const first = await sseEvents(port, evs => evs.some(e => e.kind === 'ready'))
    assert.deepEqual(buildMessages(first), [WAITING, 'startup cleanup done'])
    const seq = first.map(e => (e.kind === 'step' ? e.step : e.message ?? e.kind))
    assert.ok(seq.indexOf('startup cleanup done') < seq.indexOf('cloning'))
    // one ensuring-image step: the harness times the step and the boot from it
    assert.equal(first.filter(e => e.kind === 'step' && e.step === 'ensuring-image').length, 1)

    // the sweep has settled: a later boot shows no cleanup message at all
    await api(port, 'POST', '/api/teardown')
    await api(port, 'POST', '/api/session', { pr: 7 })
    const second = await sseEvents(port, evs => evs.some(e => e.kind === 'ready'))
    assert.deepEqual(buildMessages(second), [])
    assert.equal((await api(port, 'GET', '/api/state')).buildRun, null)
  } finally { c.stop() }
})

// --- 0.3.0: the exposure reconcile loop ------------------------------------------

// A fake Exposure adapter. By default `ensure` writes every mount it is given
// and `check` finds nothing drifted; a test passes its own to script a pass,
// each called with the mounts and the pass number (1 for the first ensure).
// `calls` records each call with its mounts and, for ensure, whether all
// three servers were listening by then.
function fakeExposure({ ensure = mounts => ({ added: mounts, ok: [] }), check = () => ({ ok: true, drift: [] }) } = {}) {
  const fake = {
    calls: [],
    servers: null, // set by makeWorld
    ensures: () => fake.calls.filter(([fn]) => fn === 'ensure').length,
    ensure: async mounts => {
      fake.calls.push(['ensure', mounts, fake.servers !== null && Object.values(fake.servers).every(s => s.listening)])
      return ensure(mounts, fake.ensures())
    },
    check: async mounts => {
      fake.calls.push(['check', mounts])
      return check(mounts, fake.ensures())
    },
  }
  return fake
}

// The mounts makeWorld's layout declares: the harness at the origin derived
// from its public host, each pane at its own origin, all on the bound ports.
function mountsAt(ports) {
  const target = port => `http://127.0.0.1:${port}`
  return [
    { name: 'harness', host: 'h.ts.net', port: 8444, path: '/qa', target: target(ports.harness) },
    { name: 'base', host: 'h.ts.net', port: 8443, path: '/', target: target(ports.base) },
    { name: 'pr', host: 'h.ts.net', port: 10000, path: '/', target: target(ports.pr) },
  ]
}

const exposureLines = lines => lines.filter(l => l.startsWith('[qa] exposure'))
const mountedLine = (verb, m) => `[qa] exposure ${verb} ${m.port}${m.path} -> ${m.target}`
const UNMANAGED = { managed: false, ok: null, checkedAt: null, drift: [], added: [], error: null }
const MANAGED_OUTSIDE = '[qa] exposure: tailscale serve mounts are managed outside the conductor'

test('the first reconcile runs after all three servers listen: harness 8444 /qa, base 8443 /, pr 10000 /, targets on the bound ports', async t => {
  // On an IP host all three bind within a tick of each other, so hold the
  // last one (the PR pane proxy; makeWorld's two apps listen first) back.
  const listen = net.Server.prototype.listen
  let n = 0
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    if (++n !== 5) return listen.apply(this, args)
    setTimeout(() => listen.apply(this, args), 50)
    return this
  })
  const exposure = fakeExposure()
  const { c, lines } = makeWorld({ cfg: GATED, exposure })
  try {
    const state = await c.exposure.ready
    const mounts = mountsAt(await allPorts(c))
    assert.deepEqual(exposure.calls, [['ensure', mounts, true], ['check', mounts]])
    assert.equal(state.ok, true)
    assert.deepEqual(exposureLines(lines), [...mounts.map(m => mountedLine('mounted', m)), '[qa] exposure ok'])
  } finally { c.stop() }
})

test('GET /api/exposure reports mode, managed, ok, checkedAt, drift, added and error', async () => {
  // a pass that writes the harness mount, then finds the PR pane's handler
  // pointing elsewhere
  const exposure = fakeExposure({
    ensure: mounts => ({ added: [mounts[0]], ok: mounts.slice(1) }),
    check: mounts => ({ ok: false, drift: [{ mount: mounts[2], actual: 'http://127.0.0.1:9' }] }),
  })
  const before = Date.now()
  const { c } = makeWorld({ cfg: GATED, exposure })
  try {
    await c.exposure.ready
    const ports = await allPorts(c)
    const mounts = mountsAt(ports)
    const calls = exposure.calls.length
    const res = await raw(ports.harness, { path: '/qa/api/exposure', headers: ALLOWED })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /^application\/json/)
    const body = JSON.parse(res.body)
    assert.ok(body.checkedAt >= before && body.checkedAt <= Date.now(), String(body.checkedAt))
    assert.deepEqual({ ...body, checkedAt: 0 }, {
      mode: 'tailscale', managed: true, ok: false, checkedAt: 0,
      drift: [{ mount: mounts[2], actual: 'http://127.0.0.1:9' }], added: [mounts[0]], error: null,
    })
    assert.deepEqual(c.exposure.state(), body, 'state() is the same report')
    assert.deepEqual(JSON.parse((await raw(ports.harness, { path: '/api/exposure', headers: ALLOWED })).body), body)
    assert.equal(exposure.calls.length, calls, 'read-only: it never calls the adapter')
    // state() is a copy
    c.exposure.state().drift.length = 0
    assert.equal(c.exposure.state().drift.length, 1)

    // behind the identity gate, the Host check and the API guard
    assert.equal((await raw(ports.harness, { path: '/qa/api/exposure' })).status, 403)
    assert.equal((await raw(ports.harness, { path: '/qa/api/exposure', headers: { ...ALLOWED, host: 'attacker.example' } })).status, 421)
    const crossSite = await raw(ports.harness, { path: '/qa/api/exposure', headers: { ...ALLOWED, 'sec-fetch-site': 'same-site', origin: 'https://h.ts.net:10000' } })
    assert.deepEqual([crossSite.status, JSON.parse(crossSite.body).error], [403, 'cross-site request refused'])
    const elsewhere = await raw(ports.harness, { path: '/qa/api/exposure', headers: { ...ALLOWED, host: 'h.ts.net:9999', 'sec-fetch-site': 'same-origin' } })
    assert.deepEqual([elsewhere.status, JSON.parse(elsewhere.body).error], [403, 'not the harness origin'])
  } finally { c.stop() }

  // with no adapter: unmanaged, never checked
  for (const [cfg, mode] of [[{}, 'none'], [GATED, 'tailscale']]) {
    const { c: w } = makeWorld({ cfg })
    try {
      const { harness } = await allPorts(w)
      assert.deepEqual(JSON.parse((await raw(harness, { path: '/qa/api/exposure', headers: ALLOWED })).body), { mode, ...UNMANAGED })
    } finally { w.stop() }
  }
})

test('an exposure failure is recorded and logged once, and a session still boots to ready', async () => {
  let failure = 'tailscale: connection refused'
  const exposure = fakeExposure({ ensure: () => { throw new Error(failure) } })
  const { c, lines } = makeWorld({ cfg: GATED, exposure })
  try {
    const state = await c.exposure.ready
    assert.deepEqual([state.ok, state.error, state.drift, state.added], [false, failure, [], []])
    assert.equal(typeof state.checkedAt, 'number')
    await c.exposure.reconcile()
    await c.exposure.reconcile()
    assert.equal(exposure.ensures(), 3)
    assert.deepEqual(exposureLines(lines), ['[qa] exposure failed: tailscale: connection refused'])

    // the conductor is unaffected
    const { harness } = await allPorts(c)
    assert.equal((await api(harness, 'POST', '/api/session', { pr: 7 }, ALLOWED)).ok, true)
    await waitFor(async () => (await api(harness, 'GET', '/api/state', undefined, ALLOWED)).status === 'ready')

    // another failure is news
    failure = 'tailscale: timed out'
    await c.exposure.reconcile()
    assert.deepEqual(exposureLines(lines).slice(1), ['[qa] exposure failed: tailscale: timed out'])
  } finally { c.stop() }

  // a layout no front door can publish is recorded the same way, and no
  // adapter call is made
  const unused = fakeExposure()
  // assigned once started, as a platform may: set at start, pane origins on
  // another host than the harness's would refuse to start
  const { c: w, errorLines, cfg: late } = makeWorld({ cfg: { ...GATED, paneOrigins: PLACEHOLDERS }, exposure: unused })
  late.paneOrigins = LOOPBACK_PANES
  try {
    const state = await w.exposure.ready
    assert.equal(state.ok, false)
    assert.match(state.error, /^the base pane origin \(QA_BASE_ORIGIN\) http:\/\/127\.0\.0\.1:3101 is not https/)
    assert.deepEqual(unused.calls, [])
    assert.deepEqual(exposureLines(errorLines), [`[qa] exposure failed: ${state.error}`])
  } finally { w.stop() }

  // a check that says not ok, naming no drift, is never logged as ok
  const vague = fakeExposure({ check: () => ({ ok: false, drift: [] }) })
  const v = makeWorld({ cfg: GATED, exposure: vague })
  try {
    assert.equal((await v.c.exposure.ready).ok, false)
    assert.deepEqual(exposureLines(v.lines).slice(-1), ['[qa] exposure drift remains: (the adapter named no mount)'])
  } finally { v.c.stop() }
})

// The adapter is platform code. A value no Mount holds (a URL object as the
// target, a function, a Symbol) once made structuredClone throw inside the
// loop, and the unhandled rejection took the whole process down.
test('an adapter that reports values no Mount holds can\'t take the conductor down', async () => {
  const exposure = fakeExposure({
    ensure: mounts => ({ added: mounts.map(m => ({ ...m, target: new URL(m.target), extra: () => {} })), ok: [] }),
    check: mounts => ({
      ok: false,
      drift: [{ mount: { ...mounts[0], name: Symbol('harness'), port: 8444n, path: () => '/qa' }, actual: new URL('http://127.0.0.1:9') }],
    }),
  })
  const { c } = makeWorld({ cfg: GATED, exposure })
  try {
    const state = await c.exposure.ready
    const ports = await allPorts(c)
    const mounts = mountsAt(ports)
    // only the Mount type's own values survive: a string, or an integer port
    assert.deepEqual(state.added, mounts.map(m => ({ ...m, target: null })))
    assert.deepEqual(state.drift, [{ mount: { ...mounts[0], name: null, port: null, path: null }, actual: null }])
    const res = await raw(ports.harness, { path: '/qa/api/exposure', headers: ALLOWED })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), state)
    assert.deepEqual(c.exposure.state(), state)
    await c.exposure.reconcile()
    assert.equal(exposure.ensures(), 2, 'the loop runs on')
  } finally { c.stop() }

  // a logger that throws can't either: the pass is still recorded, and the
  // next one runs
  const loud = fakeExposure()
  const w = makeWorld({ cfg: GATED, exposure: loud, logThrowsOn: /^\[qa\] exposure/ })
  try {
    assert.equal((await w.c.exposure.ready).ok, true)
    assert.equal((await w.c.exposure.reconcile()).ok, true)
    assert.equal(loud.ensures(), 2)
    const { harness } = await allPorts(w.c)
    assert.equal((await raw(harness, { path: '/qa/api/exposure', headers: ALLOWED })).status, 200)
  } finally { w.c.stop() }
})

test('every exposureIntervalMinutes another pass runs (default 5; an override is honoured)', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const [cfg, ms] of [[GATED, 5 * 60_000], [{ ...GATED, exposureIntervalMinutes: 0.5 }, 30_000], [{ ...GATED, exposureIntervalMinutes: 90 }, 90 * 60_000]]) {
    const exposure = fakeExposure()
    const { c } = makeWorld({ cfg, exposure })
    try {
      await c.exposure.ready
      assert.equal(exposure.ensures(), 1)
      t.mock.timers.tick(ms - 1)
      assert.equal(exposure.ensures(), 1, `nothing before ${ms} ms`)
      t.mock.timers.tick(1)
      assert.equal(exposure.ensures(), 2, `a pass at ${ms} ms`)
      await c.exposure.reconcile() // joins the pass the tick started
      t.mock.timers.tick(ms)
      assert.equal(exposure.ensures(), 3)
      await c.exposure.reconcile()
      assert.equal(exposure.ensures(), 3)
    } finally { c.stop() }
  }
})

test('a tick while a pass hangs starts no second one', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const release = deferred()
  const exposure = fakeExposure({
    ensure: async (mounts, pass) => {
      if (pass === 1) await release.promise
      return { added: [], ok: mounts }
    },
  })
  const { c } = makeWorld({ cfg: GATED, exposure })
  try {
    await waitFor(() => exposure.ensures() === 1)
    const inFlight = c.exposure.reconcile()
    assert.equal(c.exposure.reconcile(), inFlight, 'reconcile() joins the pass in flight')
    for (let i = 0; i < 3; i++) t.mock.timers.tick(5 * 60_000)
    assert.equal(exposure.ensures(), 1, 'no second pass while the first hangs')
    assert.equal(c.exposure.state().checkedAt, null)

    release.resolve()
    assert.equal((await inFlight).ok, true)
    assert.equal((await c.exposure.ready).ok, true)
    t.mock.timers.tick(5 * 60_000)
    assert.equal(exposure.ensures(), 2, 'the next tick runs a pass')
  } finally { c.stop() }
})

test('after stop() or shutdown() a tick runs nothing', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval')
  const clearIntervalSpy = t.mock.method(globalThis, 'clearInterval')
  for (const end of ['stop', 'shutdown']) {
    const exposure = fakeExposure()
    const { c, conductor } = makeWorld({ cfg: GATED, exposure })
    try {
      await c.exposure.ready
      const loop = setIntervalSpy.mock.calls.findLast(call => call.arguments[1] === 5 * 60_000).result
      if (end === 'stop') conductor.stop()
      else await conductor.shutdown()
      assert.ok(clearIntervalSpy.mock.calls.some(call => call.arguments[0] === loop), `${end} clears the loop's timer`)
      t.mock.timers.tick(3 * 5 * 60_000)
      const state = await c.exposure.reconcile()
      assert.equal(exposure.ensures(), 1, `${end}: no pass after it, from a tick or reconcile()`)
      assert.equal(state.ok, true, `${end}: the last report stands`)
    } finally { c.stop() }
  }

  // shutdown() doesn't wait for a pass in flight, and ready settles
  const release = deferred()
  const hung = fakeExposure({ ensure: async mounts => { await release.promise; return { added: [], ok: mounts } } })
  const w = makeWorld({ cfg: GATED, exposure: hung })
  try {
    await waitFor(() => hung.ensures() === 1)
    await w.conductor.shutdown()
    assert.equal((await w.c.exposure.ready).checkedAt, null)
    t.mock.timers.tick(3 * 5 * 60_000)
    assert.equal(hung.ensures(), 1)
  } finally { release.resolve(); w.closeApps() }

  // ready settles even when shutdown() runs before the servers listen
  const early = fakeExposure()
  const e = makeWorld({ cfg: GATED, exposure: early })
  try {
    await e.conductor.shutdown()
    assert.deepEqual(await e.c.exposure.ready, { mode: 'tailscale', ...UNMANAGED, managed: true })
    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(early.calls, [])
  } finally { e.closeApps() }
})

test('a mount that drifts back is logged as restored', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  // pass 1 writes all three; pass 2 rewrites the PR pane's handler, which
  // had gone; passes 3 and 4 find a handler that shadows the harness, which
  // ensure leaves alone; pass 5 finds everything in place
  const shadowed = [3, 4]
  const exposure = fakeExposure({
    ensure: (mounts, pass) => ({ added: pass === 1 ? mounts : pass === 2 ? [mounts[2]] : [], ok: [] }),
    check: (mounts, pass) => (shadowed.includes(pass)
      ? { ok: false, drift: [{ mount: mounts[0], actual: '/qa/ -> http://127.0.0.1:9' }, { mount: mounts[0], actual: '/qa/api (not a proxy)' }] }
      : { ok: true, drift: [] }),
  })
  const { c, lines, errorLines } = makeWorld({ cfg: GATED, exposure })
  const tick = async () => {
    t.mock.timers.tick(5 * 60_000)
    await c.exposure.reconcile()
  }
  try {
    await c.exposure.ready
    const mounts = mountsAt(await allPorts(c))
    assert.deepEqual(exposureLines(lines), [...mounts.map(m => mountedLine('mounted', m)), '[qa] exposure ok'])
    await tick()
    assert.deepEqual(exposureLines(lines).slice(4), [mountedLine('restored', mounts[2])], 'still ok: no second ok line')
    await tick()
    await tick()
    assert.deepEqual(exposureLines(lines).slice(5), ['[qa] exposure drift remains: 8444/qa'], 'once, and once per mount')
    assert.ok(errorLines.includes('[qa] exposure drift remains: 8444/qa'))
    await tick()
    await tick()
    assert.deepEqual(exposureLines(lines).slice(6), ['[qa] exposure ok'])
  } finally { c.stop() }

  // a mount first written on a later pass is mounted, not restored
  const partial = fakeExposure({
    ensure: (mounts, pass) => {
      if (pass === 1) throw Object.assign(new Error('could not mount 10000/'), { added: mounts.slice(0, 2) })
      return { added: [mounts[2]], ok: mounts.slice(0, 2) }
    },
  })
  const w = makeWorld({ cfg: GATED, exposure: partial })
  try {
    await w.c.exposure.ready
    const mounts = mountsAt(await allPorts(w.c))
    await w.c.exposure.reconcile()
    await w.c.exposure.reconcile()
    assert.deepEqual(exposureLines(w.lines), [
      mountedLine('mounted', mounts[0]), mountedLine('mounted', mounts[1]), '[qa] exposure failed: could not mount 10000/',
      mountedLine('mounted', mounts[2]), '[qa] exposure ok',
      mountedLine('restored', mounts[2]),
    ])
  } finally { w.c.stop() }

  // a restart onto mounts already in place (a fixed-port deploy): pass 1
  // writes nothing, so a mount that goes later and comes back is restored
  const deployed = fakeExposure({ ensure: (mounts, pass) => ({ added: pass === 2 ? [mounts[1]] : [], ok: [] }) })
  const d = makeWorld({ cfg: GATED, exposure: deployed })
  try {
    await d.c.exposure.ready
    const mounts = mountsAt(await allPorts(d.c))
    await d.c.exposure.reconcile()
    assert.deepEqual(exposureLines(d.lines), ['[qa] exposure ok', mountedLine('restored', mounts[1])])
  } finally { d.c.stop() }
})

// A platform may assign cfg.paneOrigins after start, so no pass reuses the
// mounts an earlier one derived.
test('every pass derives the mounts afresh from cfg', async () => {
  const exposure = fakeExposure()
  const { c, cfg } = makeWorld({ cfg: GATED, exposure })
  try {
    await c.exposure.ready
    const ports = await allPorts(c)
    cfg.paneOrigins = { ...cfg.paneOrigins, pr: 'https://h:10001' }
    await c.exposure.reconcile()
    const ensures = exposure.calls.filter(([fn]) => fn === 'ensure')
    assert.equal(ensures.length, 2)
    assert.deepEqual(ensures[1][1][2], { name: 'pr', host: 'h', port: 10001, path: '/', target: `http://127.0.0.1:${ports.pr}` })
  } finally { c.stop() }
})

// Before the servers listen there are no targets to mount, so reconcile()
// runs nothing of its own: it returns `ready`, the first pass.
test('reconcile() before the servers listen returns ready, and runs no pass of its own', async () => {
  const exposure = fakeExposure()
  const { c, lines } = makeWorld({ cfg: GATED, exposure })
  try {
    const early = c.exposure.reconcile()
    assert.equal(early, c.exposure.ready)
    assert.equal((await early).ok, true)
    assert.equal(exposure.ensures(), 1)
    assert.deepEqual(exposureLines(lines).filter(l => l.startsWith('[qa] exposure failed')), [])
  } finally { c.stop() }
})

test('an adapter with QA_EXPOSURE=none refuses to start', () => {
  const message = 'adapters.exposure needs QA_EXPOSURE=tailscale: an ungated conductor must not publish itself'
  // set, or defaulted from a loopback layout
  for (const cfg of [{ exposure: 'none' }, { exposure: undefined, publicHost: null, paneOrigins: LOOPBACK_PANES }]) {
    const exposure = fakeExposure()
    assert.throws(() => startOnly(cfg, { exposure }), { message }, JSON.stringify(cfg))
    assert.deepEqual(exposure.calls, [])
  }
  // none mode without one, and tailscale mode with one, start
  startOnly({ exposure: 'none' }, { exposure: null })
  startOnly(GATED, { exposure: fakeExposure() })
})

test('tailscale mode without an adapter: managed false, the managed-outside line, no timer', async t => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval')
  const delays = () => setIntervalSpy.mock.calls.map(call => call.arguments[1])
  for (const [cfg, mode, outside] of [[GATED, 'tailscale', true], [{}, 'none', false]]) {
    setIntervalSpy.mock.resetCalls()
    const { c, logLines } = makeWorld({ cfg })
    try {
      await allPorts(c)
      const state = await c.exposure.ready
      assert.deepEqual(state, { mode, ...UNMANAGED })
      assert.deepEqual(await c.exposure.reconcile(), state, 'reconcile() runs nothing')
      assert.equal(logLines.includes(MANAGED_OUTSIDE), outside, mode)
      assert.deepEqual(delays(), [60_000], `${mode}: only the idle reaper`)
    } finally { c.stop() }
  }
  // with an adapter, the loop's timer is the only other one
  setIntervalSpy.mock.resetCalls()
  const { c, logLines } = makeWorld({ cfg: GATED, exposure: fakeExposure() })
  try {
    await c.exposure.ready
    assert.deepEqual(delays(), [60_000, 5 * 60_000])
    assert.equal(logLines.includes(MANAGED_OUTSIDE), false)
  } finally { c.stop() }
})

test('startConductor refuses exposureIntervalMinutes 0, -1, NaN and 35792', async () => {
  for (const bad of [0, -1, NaN, 35792, Infinity, '5', true]) {
    assert.throws(() => startOnly({ exposureIntervalMinutes: bad }), err => {
      assert.match(err.message, /^startConductor: cfg\.exposureIntervalMinutes must be a number of minutes above 0 and at most 35791 \(the longest a timer can wait\), got /)
      return true
    }, String(bad))
  }
  // in any mode, with an adapter or without
  assert.throws(() => startOnly({ ...GATED, exposureIntervalMinutes: -1 }, { exposure: fakeExposure() }), /cfg\.exposureIntervalMinutes/)
  for (const minutes of [35791, 0.5, undefined, null]) {
    const { c } = makeWorld({ cfg: { ...GATED, exposureIntervalMinutes: minutes }, exposure: fakeExposure() })
    try {
      assert.equal((await c.exposure.ready).ok, true, String(minutes))
    } finally { c.stop() }
  }
})

// --- #29: the per-browser capability ---------------------------------------------

// raw(), but it resolves at the response's headers and hangs up: an event
// stream it admitted would otherwise never end.
function rawHead(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      const chunks = []
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
      if (res.headers['content-type'] === 'text/event-stream') { res.destroy(); return done() }
      res.on('data', c => chunks.push(c))
      res.on('end', done)
    })
    // a server that took an upgrade (101) answers here, not as a response
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: '' }) })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

const JSON_TYPE = { 'content-type': 'application/json' }

// PR code that reaches the conductor's listeners on loopback (through Docker
// Desktop's host.docker.internal, Podman machine's host.containers.internal, or as a process
// pane) can send whatever the harness page would: a loopback Host, an allowed
// login, Fetch Metadata and the harness Origin. Only the capability, which it
// can't get, keeps it out.
function prCode(port, origin, gated) {
  const as = { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', origin, ...(gated ? ALLOWED : {}) }
  return (r = {}) => rawHead(port, { ...r, headers: { ...as, ...(r.headers ?? {}) } })
}

const API_ROUTES = [
  { path: '/api/state' }, { path: '/api/prs' }, { path: '/api/exposure' }, { path: '/api/build-status?pr=7' },
  { path: '/api/progress' }, { path: '/api/verdict/preview?verdict=accept' }, { path: '/api/nope' },
  { method: 'POST', path: '/api/session', body: '{"pr":8,"takeover":true}' },
  { method: 'POST', path: '/api/verdict', body: '{"verdict":"accept","notes":"x"}' },
  { method: 'POST', path: '/api/teardown', body: '{}' },
  { method: 'POST', path: '/api/invite', body: '{}' },
  { method: 'POST', path: '/api/pane-entry', body: '{"role":"base","to":"/"}' },
  // the action log (#8)
  { path: '/api/actions' }, { path: '/api/actions?after=0' },
  { method: 'POST', path: '/api/actions/mark', body: '{"pane":"base","type":"click"}' },
  // the window is shut while a session runs
  { method: 'POST', path: '/api/enrol', body: '{}' },
  // a CORS preflight, and a HEAD
  { method: 'OPTIONS', path: '/api/session', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-qa-cap' } },
  { method: 'HEAD', path: '/api/state' },
  // a websocket upgrade, which a later 'upgrade' listener must check too
  { path: '/api/state', headers: UPGRADE }, { path: '/api/progress', headers: UPGRADE },
]

test('PR code on loopback gets 403 X-QA-Refusal: capability from every API route, the event stream, both panes, the bridge and the pane entry, in none and tailscale modes', async () => {
  for (const mode of ['none', 'tailscale']) {
    const gated = mode === 'tailscale'
    const w = makeWorld({ cfg: gated ? GATED : {} })
    const login = gated ? ALLOWED : {}
    try {
      const { harness, base, pr } = await allPorts(w.c)
      await api(harness, 'POST', '/api/session', { pr: 7 }, login)
      const before = await waitFor(async () => { const s = await api(harness, 'GET', '/api/state', undefined, login); return s.status === 'ready' && s })
      const hits = w.appHits.length
      const calls = w.calls.length
      await new Promise(r => setTimeout(r, 5))
      const origin = w.harnessOrigin()
      const paneToken = w.capability.paneToken(w.token)
      const check = (res, label) => {
        assert.equal(res.status, 403, label)
        assert.equal(res.headers['x-qa-refusal'], 'capability', label)
        assert.equal(res.headers['cache-control'], 'no-store', label)
        assert.equal(res.headers['set-cookie'], undefined, label)
        assert.equal(res.headers['access-control-allow-origin'], undefined, label)
        assert.doesNotMatch(res.body, /login-|pane-|"token"|enrol=/, label)
      }
      const toHarness = prCode(harness, origin, gated)
      // no key, a guessed one, and a pane token in the harness's place
      for (const key of [{}, { 'x-qa-cap': 'guess' }, { 'x-qa-cap': paneToken }, { cookie: `${paneCookieName(origin, w.cfg.paneOrigins.base)}=${paneToken}` }]) {
        for (const r of API_ROUTES) {
          for (const prefix of ['', '/qa']) {
            const headers = { ...key, ...(r.method === 'POST' ? JSON_TYPE : {}), ...r.headers }
            check(await toHarness({ ...r, path: prefix + r.path, headers }), `${mode} ${r.method ?? 'GET'} ${prefix}${r.path} ${JSON.stringify(key)}`)
          }
        }
      }
      // the event stream's own key, which EventSource sends in the URL
      for (const q of ['?cap=', '?cap=guess', `?cap=${paneToken}`]) check(await toHarness({ path: `/qa/api/progress${q}` }), `${mode} progress${q}`)

      // both panes: no cookie, a guessed one, and the harness token as the cookie
      const name = paneCookieName(origin, w.cfg.paneOrigins.base)
      for (const port of [base, pr]) {
        const toPane = prCode(port, origin, gated)
        for (const cookie of [undefined, `${name}=guess`, `${name}=${w.token}`, `qa-x=${paneToken}`]) {
          for (const r of [
            { path: '/page' }, { path: '/cookie' }, { method: 'POST', path: '/x', body: '{}' }, { method: 'OPTIONS', path: '/x' }, { method: 'HEAD', path: '/page' },
            { path: '/__qa/bridge.js' }, { path: '/__qa/enter' }, { path: '/__qa/enter?t=guess' }, { path: `/__qa/enter?t=${w.token}` }, { path: `/__qa/enter?t=${paneToken}` },
            { path: '/page', headers: UPGRADE }, { path: '/__qa/enter?t=guess', headers: UPGRADE },
          ]) {
            check(await toPane({ ...r, headers: { ...r.headers, ...(cookie ? { cookie } : {}) } }), `${mode} ${port} ${r.method ?? 'GET'} ${r.path} ${r.headers ? 'upgrade ' : ''}${cookie}`)
          }
        }
      }

      // nothing ran: no app request, no adapter or GitHub call, no activity
      assert.deepEqual(w.appHits.slice(hits), [], mode)
      assert.deepEqual(w.calls.slice(calls), [], mode)
      const after = await api(harness, 'GET', '/api/state', undefined, login)
      assert.deepEqual([after.status, after.pr, after.lastActivity], ['ready', 7, before.lastActivity], mode)
    } finally { w.c.stop() }
  }
})

// What a browser gets from POST /api/enrol (no capability): 'open' with a
// token that works, or the reason enrolment is shut.
async function enrolment(port, body = {}) {
  const res = await raw(port, { method: 'POST', path: '/qa/api/enrol', cap: false, headers: JSON_TYPE, body: JSON.stringify(body) })
  const parsed = JSON.parse(res.body)
  if (res.status === 200) {
    assert.match(parsed.token, /^[A-Za-z0-9_-]{43}$/)
    const state = await raw(port, { path: '/qa/api/state', cap: false, headers: { 'x-qa-cap': parsed.token } })
    assert.equal(state.status, 200, 'the new token opens the API')
    return 'open'
  }
  assert.deepEqual([res.status, res.headers['x-qa-refusal'], parsed.error], [403, 'capability', `enrolment is closed: ${parsed.reason}`])
  return parsed.reason
}

const BOOTING = 'a session is booting'
const RUNNING = 'a session is running'
const ENDING = 'a session is ending'
const STOPPING = 'a cancelled boot is still stopping'
const CLEANING = 'cleaning up after the last boot'

test('a browser enrols while no PR code can run: idle, and once a session has ended cleanly', async () => {
  const hang = { 7: deferred() }
  const slow = deferred()
  const { c, calls, adapters } = makeWorld({ hang })
  try {
    const port = await harnessPort(c)
    await waitFor(() => calls.some(x => x[0] === 'sweep-done'))
    assert.equal(await enrolment(port), 'open')
    assert.equal(await enrolment(port), 'open', 'and again')
    // a body that names an invite is about that invite, whatever the window
    for (const invite of ['', null, 0, false]) {
      const res = await raw(port, { method: 'POST', path: '/qa/api/enrol', cap: false, headers: JSON_TYPE, body: JSON.stringify({ invite }) })
      assert.deepEqual([res.status, JSON.parse(res.body).error], [403, 'this invite link has expired or was already used'], JSON.stringify(invite))
    }

    await api(port, 'POST', '/api/session', { pr: 7 })
    assert.equal(await enrolment(port), BOOTING)
    hang[7].resolve()
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.equal(await enrolment(port), RUNNING)

    adapters.provisioner.teardown = async ({ paneRef }) => { calls.push(['teardown', paneRef.role]); await slow.promise }
    const ending = api(port, 'POST', '/api/teardown')
    await waitFor(() => calls.some(x => x[0] === 'teardown'))
    assert.equal(await enrolment(port), ENDING)
    slow.resolve()
    await ending
    assert.equal(await enrolment(port), 'open')
    assert.equal(calls.filter(x => x[0] === 'teardown').length, 2, 'one teardown: the session had settled')
  } finally { c.stop() }
})

const SWEEPING = 'the startup cleanup is still running'

test('enrolment stays shut until the startup sweep succeeds; a failed one runs again when a browser tries to enrol with no session running', async () => {
  const sweepGate = deferred()
  const ok = makeWorld({ sweepGate })
  try {
    const port = await harnessPort(ok.c)
    assert.equal(await enrolment(port), SWEEPING)
    sweepGate.resolve()
    await waitFor(() => ok.calls.some(x => x[0] === 'sweep-done'))
    assert.equal(await enrolment(port), 'open')
  } finally { ok.c.stop() }

  // A daemon not up yet when the conductor starts (Docker Desktop still
  // starting): the next try, once it is, succeeds.
  let sweeps = 0
  const late = makeWorld({ provisioner: { sweep: async () => { if (++sweeps === 1) throw new Error('docker unavailable') } } })
  try {
    const port = await harnessPort(late.c)
    await waitFor(() => late.errorLines.some(l => l.includes('startup sweep failed')))
    assert.ok(late.errorLines.includes("[qa] new browsers can't enrol until the startup sweep succeeds; it runs again when one tries with no session running"), late.errorLines.join('\n'))
    assert.equal(await enrolment(port), SWEEPING, 'the try started it again')
    await waitFor(async () => (await enrolment(port)) === 'open')
    assert.equal(sweeps, 2)
    assert.ok(late.logLines.includes('[qa] running the startup sweep again'), late.logLines.join('\n'))
  } finally { late.c.stop() }

  // One that keeps failing keeps enrolment shut, and isn't run again while a
  // session runs: boots still do, and a clean teardown alone doesn't reopen it.
  const failed = makeWorld({ sweepFails: true })
  try {
    const port = await harnessPort(failed.c)
    await waitFor(() => failed.errorLines.some(l => l.includes('startup sweep failed')))
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.equal(await enrolment(port), RUNNING)
    assert.equal(failed.calls.filter(x => x[0] === 'sweep').length, 1, 'not while a session runs')
    await api(port, 'POST', '/api/teardown')
    assert.equal(await enrolment(port), SWEEPING)
    await waitFor(() => failed.calls.filter(x => x[0] === 'sweep').length === 2)
    await waitFor(() => failed.errorLines.filter(l => l.includes('startup sweep failed')).length === 2)
    assert.equal(await enrolment(port), SWEEPING, 'and again')
  } finally { failed.c.stop() }
})

// What a front door in between, a pane proxy (self-QA puts each inner
// harness in an outer pane), leaves of a refusal: the body, not the header.
test('a capability refusal says so in its JSON body too, beside the header, with the harness origin', async () => {
  const { c } = makeWorld({ hang: { 7: deferred() } })
  const proxy = http.createServer(createPaneProxy({ upstreamPort: () => c.servers.harness.address().port, bridgePath: '/nonexistent', httpMod: http }))
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    proxy.listen(0, '127.0.0.1')
    await new Promise(r => proxy.once('listening', r))
    const marked = { refusal: 'capability', harnessOrigin: 'https://h.ts.net:8444' }
    const cases = [
      [{ path: '/qa/api/state' }, { error: 'this browser is not enrolled: open the harness to enrol it', ...marked }],
      [{ method: 'POST', path: '/qa/api/enrol', headers: JSON_TYPE, body: '{}' }, { error: `enrolment is closed: ${BOOTING}`, reason: BOOTING, ...marked }],
      [{ method: 'POST', path: '/qa/api/enrol', headers: JSON_TYPE, body: '{"invite":"guess"}' }, { error: 'this invite link has expired or was already used', ...marked }],
    ]
    for (const [r, body] of cases) {
      const direct = await raw(port, { ...r, cap: false })
      assert.deepEqual([direct.status, direct.headers['x-qa-refusal'], JSON.parse(direct.body)], [403, 'capability', body], r.path)
      const through = await raw(proxy.address().port, { ...r, cap: false })
      assert.deepEqual([through.status, through.headers['x-qa-refusal'], JSON.parse(through.body)], [403, undefined, body], `${r.path} through a pane proxy`)
    }
  } finally {
    proxy.close()
    c.stop()
  }
})

// A boot a teardown aborted may still be inside a Provisioner call that starts
// PR code once the teardown is done: enrolment waits for it to settle, and for
// a teardown after that.
test('after a teardown, enrolment waits for the cancelled boot to settle and a cleanup teardown to succeed', async () => {
  const launched = deferred()
  const gate = deferred()
  const { c, calls } = makeWorld({ provisioner: { launchServices: async () => { launched.resolve(); await gate.promise } } })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await launched.promise
    await api(port, 'POST', '/api/teardown')
    assert.equal((await api(port, 'GET', '/api/state')).status, 'idle')
    assert.equal(await enrolment(port), STOPPING)
    assert.deepEqual(calls.filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr'])

    gate.resolve() // the boot goes on, starts the app, then sees the abort
    await waitFor(() => calls.filter(x => x[0] === 'teardown').length === 4)
    await waitFor(async () => (await enrolment(port)) === 'open')
    const seq = calls.map(x => x[0])
    assert.deepEqual(seq.slice(seq.lastIndexOf('teardown') - 1), ['teardown', 'teardown'], 'the cleanup ran after the boot settled')
  } finally { c.stop() }
})

test('a teardown that fails shuts enrolment until one succeeds: the cleanup tries it again, and so does each try to enrol', async () => {
  let failing = 3
  const { c, calls, errorLines } = makeWorld({
    provisioner: {
      teardown: async ({ paneRef }) => {
        calls.push(['teardown', paneRef.role])
        if (paneRef.role === 'pr' && failing > 0) { failing--; throw new Error('docker is down') }
      },
    },
  })
  const teardowns = () => calls.filter(x => x[0] === 'teardown').length
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    await api(port, 'POST', '/api/teardown')
    // the teardown failed, and so did the cleanup after it
    await waitFor(() => teardowns() === 4)
    await waitFor(() => errorLines.filter(l => l.includes('failed (pr: docker is down)')).length === 2)
    for (const what of ['teardown', 'cleanup after the last boot']) {
      assert.ok(errorLines.includes(`[qa] ${what} failed (pr: docker is down); new browsers can't enrol until a teardown succeeds`), errorLines.join('\n'))
    }
    // a try to enrol runs it again: it fails once more, then works
    assert.equal(await enrolment(port), CLEANING)
    await waitFor(() => teardowns() === 6)
    await waitFor(async () => (await enrolment(port)) === 'open')
    assert.equal(teardowns(), 8)
  } finally { c.stop() }
})

const SWEEP_FAILED = 'the startup cleanup failed: a try to enrol runs it again, at most once every few seconds'
const TEARDOWN_FAILED = 'the last teardown failed: a try to enrol runs it again, at most once every few seconds'

// Anything on loopback may try to enrol: tries in a loop must not keep the
// Provisioner sweeping or tearing down back to back.
test('tries to enrol run a failed sweep or teardown again at most once every five seconds', async () => {
  let t = 1_000_000
  const swept = makeWorld({ sweepFails: true, pacing: { now: () => t, enrolWaitMs: 0 } })
  const sweeps = () => swept.calls.filter(x => x[0] === 'sweep').length
  try {
    const port = await harnessPort(swept.c)
    await waitFor(() => swept.errorLines.some(l => l.includes('startup sweep failed')))
    assert.equal(await enrolment(port), SWEEPING, 'the first try runs it again')
    await waitFor(() => swept.errorLines.filter(l => l.includes('startup sweep failed')).length === 2)
    for (let i = 0; i < 5; i++) assert.equal(await enrolment(port), SWEEP_FAILED)
    t += 4_999
    assert.equal(await enrolment(port), SWEEP_FAILED)
    assert.equal(sweeps(), 2, 'none again within five seconds')
    t += 1
    assert.equal(await enrolment(port), SWEEPING)
    assert.equal(sweeps(), 3)
  } finally { swept.c.stop() }

  const torn = makeWorld({
    provisioner: { teardown: async ({ paneRef }) => { torn.calls.push(['teardown', paneRef.role]); if (paneRef.role === 'pr') throw new Error('docker is down') } },
    pacing: { now: () => t, enrolWaitMs: 0 },
  })
  const teardowns = () => torn.calls.filter(x => x[0] === 'teardown').length
  try {
    const port = await harnessPort(torn.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    await api(port, 'POST', '/api/teardown')
    await waitFor(() => torn.errorLines.filter(l => l.includes('failed (pr: docker is down)')).length === 2)
    assert.equal(await enrolment(port), CLEANING)
    await waitFor(() => torn.errorLines.filter(l => l.includes('failed (pr: docker is down)')).length === 3)
    for (let i = 0; i < 5; i++) assert.equal(await enrolment(port), TEARDOWN_FAILED)
    assert.equal(teardowns(), 6)
    t += 5_000
    assert.equal(await enrolment(port), CLEANING)
    assert.equal(teardowns(), 8)
  } finally { torn.c.stop() }
})

// The try that runs a failed sweep or teardown again, or finds one running,
// waits for it a moment, so it can enrol once that succeeds.
test('a try to enrol waits up to three seconds for the sweep or teardown in flight', async () => {
  let sweeps = 0
  const second = deferred()
  const swept = makeWorld({ provisioner: { sweep: async () => { if (++sweeps === 1) throw new Error('docker unavailable'); await second.promise } }, pacing: {} })
  try {
    const port = await harnessPort(swept.c)
    await waitFor(() => swept.errorLines.some(l => l.includes('startup sweep failed')))
    const trying = enrolment(port)
    await waitFor(() => sweeps === 2)
    await new Promise(r => setTimeout(r, 100))
    second.resolve()
    assert.equal(await trying, 'open', 'the try that ran it again enrols')
  } finally { swept.c.stop() }

  let failing = 2
  const cleared = deferred()
  const torn = makeWorld({
    provisioner: {
      teardown: async ({ paneRef }) => {
        if (paneRef.role !== 'pr') return
        if (failing > 0) { failing--; throw new Error('docker is down') }
        await cleared.promise
      },
    },
    pacing: {},
  })
  try {
    const port = await harnessPort(torn.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    await api(port, 'POST', '/api/teardown')
    await waitFor(() => torn.errorLines.filter(l => l.includes('failed (pr: docker is down)')).length === 2)
    const trying = enrolment(port)
    await new Promise(r => setTimeout(r, 100))
    cleared.resolve()
    assert.equal(await trying, 'open')
  } finally { torn.c.stop() }

  // no longer than enrolWaitMs, with the sweep still running
  const stuck = makeWorld({ sweepGate: deferred(), pacing: { enrolWaitMs: 150 } })
  try {
    const port = await harnessPort(stuck.c)
    const began = Date.now()
    assert.equal(await enrolment(port), SWEEPING)
    const took = Date.now() - began
    assert.ok(took >= 140 && took < 2_000, `${took} ms`)
  } finally { stuck.c.stop() }

  // a teardown the reviewer (or the idle reaper) started
  const ended = deferred()
  let tearing = false
  const own = makeWorld({ provisioner: { teardown: async ({ paneRef }) => { if (paneRef.role === 'pr' && tearing) await ended.promise } }, pacing: {} })
  try {
    const port = await harnessPort(own.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    tearing = true
    const torn = api(port, 'POST', '/api/teardown')
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'tearing-down')
    const trying = enrolment(port)
    await new Promise(r => setTimeout(r, 100))
    ended.resolve()
    assert.equal(await trying, 'open')
    await torn
  } finally { own.c.stop() }
})

// The wait must not hold the process up: shutdown() or stop() may come
// while a try to enrol waits.
test('a try to enrol that waits keeps no timer that holds the process', async () => {
  const w = makeWorld({ sweepGate: deferred(), pacing: { enrolWaitMs: 60_000 } })
  try {
    const port = await harnessPort(w.c)
    const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
    const taken = new Promise(resolve => w.c.servers.harness.on('request', req => { if (req.url.endsWith('/api/enrol')) setTimeout(resolve, 20) }))
    const before = timers()
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/qa/api/enrol', headers: JSON_TYPE, agent: false })
    req.on('error', () => {})
    req.end('{}')
    await taken
    assert.equal(timers(), before)
    req.destroy()
  } finally { w.c.stop() }
})

// A try whose client went away stops waiting then: it must not wait on, and
// enrol a browser nobody holds once the sweep is done.
test('a try to enrol whose client goes away mid-wait enrols nobody once the sweep is done', async () => {
  const sweepGate = deferred()
  const w = makeWorld({ sweepGate, pacing: { enrolWaitMs: 60_000 } })
  try {
    const port = await harnessPort(w.c)
    const enrolled = w.capability.size()
    let closed
    const gone = new Promise(resolve => { closed = resolve })
    const taken = new Promise(resolve => w.c.servers.harness.on('request', (req, res) => {
      if (req.url.endsWith('/api/enrol')) { res.on('close', closed); setTimeout(resolve, 20) }
    }))
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/qa/api/enrol', headers: JSON_TYPE, agent: false })
    req.on('error', () => {})
    req.end('{}')
    await taken
    req.destroy()
    await gone
    sweepGate.resolve()
    await waitFor(() => w.calls.some(x => x[0] === 'sweep-done'))
    await new Promise(r => setTimeout(r, 50))
    assert.equal(w.capability.size(), enrolled)
  } finally { w.c.stop() }
})

// One wait may follow another: a reviewer's teardown that fails starts a
// cleanup teardown, and a try that began during the first waits for the
// second too, within the same three seconds.
test('a try to enrol made during a failing teardown waits for the cleanup after it, and enrols', async () => {
  let pr = 0
  const first = deferred()
  const second = deferred()
  const w = makeWorld({
    provisioner: {
      teardown: async ({ paneRef }) => {
        if (paneRef.role !== 'pr') return
        pr++
        if (pr === 1) { await first.promise; throw new Error('docker is down') }
        if (pr === 2) await second.promise
      },
    },
    pacing: {},
  })
  try {
    const port = await harnessPort(w.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    const torn = api(port, 'POST', '/api/teardown')
    await waitFor(() => pr === 1)
    const trying = enrolment(port)
    await new Promise(r => setTimeout(r, 50))
    first.resolve() // the teardown fails; its cleanup starts and holds
    await waitFor(() => pr === 2)
    await new Promise(r => setTimeout(r, 50))
    second.resolve()
    assert.equal(await trying, 'open')
    await torn
  } finally { w.c.stop() }
})

// The gap runs from when a retried run settles too: a sweep that takes
// longer than the gap to fail isn't run again the moment it has.
test('a slow retried sweep that fails isn\'t run again until the gap has passed since it failed', async () => {
  let t = 1_000_000
  let sweeps = 0
  const w = makeWorld({
    // the time passes while it runs, after it started
    provisioner: { sweep: async () => { sweeps++; await null; if (sweeps > 1) t += 6_000; throw new Error('docker unavailable') } },
    pacing: { now: () => t, enrolWaitMs: 0 },
  })
  const failures = () => w.errorLines.filter(l => l.includes('startup sweep failed')).length
  try {
    const port = await harnessPort(w.c)
    await waitFor(() => failures() === 1)
    assert.equal(await enrolment(port), SWEEPING)
    await waitFor(() => failures() === 2)
    assert.equal(await enrolment(port), SWEEP_FAILED, 'it took 6 s to fail, but failed just now')
    assert.equal(sweeps, 2)
    t += 5_000
    assert.equal(await enrolment(port), SWEEPING)
    assert.equal(sweeps, 3)
  } finally { w.c.stop() }
})

// Date.now can stand still or step back (NTP, a laptop's sleep); the
// spacing must still run out.
test('retry spacing runs on a clock that only goes forward', async () => {
  const wall = Date.now
  // a wall clock that stands still, then steps back an hour; set before the
  // conductor starts, so whatever it reads as the time is this
  let wallAt = wall()
  Date.now = () => wallAt
  const w = makeWorld({ sweepFails: true, pacing: { retryGapMs: 50, enrolWaitMs: 0 } })
  const sweeps = () => w.calls.filter(x => x[0] === 'sweep').length
  const failures = () => w.errorLines.filter(l => l.includes('startup sweep failed')).length
  try {
    const port = await harnessPort(w.c)
    await waitFor(() => failures() === 1)
    assert.equal(await enrolment(port), SWEEPING)
    await waitFor(() => failures() === 2)
    assert.equal(await enrolment(port), SWEEP_FAILED)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(await enrolment(port), SWEEPING, 'the gap ran out though the wall clock stood still')
    await waitFor(() => failures() === 3)
    wallAt -= 3_600_000
    await new Promise(r => setTimeout(r, 80))
    assert.equal(await enrolment(port), SWEEPING, 'and though it stepped back')
    assert.equal(sweeps(), 4)
  } finally {
    Date.now = wall
    w.c.stop()
  }
})

test('a failed boot that tore its panes down leaves enrolment open; one whose teardown failed gets a cleanup first', async () => {
  const clean = makeWorld({ failAt: 'launchServices' })
  try {
    const port = await harnessPort(clean.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'error')
    assert.equal(await enrolment(port), 'open')
    assert.deepEqual(clean.calls.filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr'], 'no second teardown')
  } finally { clean.c.stop() }

  let failing = 1
  const dirty = makeWorld({
    failAt: 'launchServices',
    provisioner: {
      teardown: async ({ paneRef }) => {
        dirty.calls.push(['teardown', paneRef.role])
        if (failing > 0) { failing--; throw new Error('busy') }
      },
    },
  })
  try {
    const port = await harnessPort(dirty.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'error')
    await waitFor(async () => (await enrolment(port)) === 'open')
    assert.deepEqual(dirty.calls.filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr', 'base', 'pr'])
  } finally { dirty.c.stop() }
})

// The harness page: enrol, then enter each pane through a one-time ticket that
// sets the pane cookie, which the proxy never passes on to the app.
test('the browser flow: enrol, a pane-entry ticket, 303 with the pane cookie, and the request reaches the app without it', async () => {
  for (const [layout, cfg, secure] of [
    ['tailnet https', {}, true],
    ['loopback http', { publicHost: null, harnessOrigin: 'http://127.0.0.1:3100', paneOrigins: LOOPBACK_PANES }, false],
  ]) {
    const w = makeWorld({ cfg, enrolled: false })
    try {
      const { harness, base, pr } = await allPorts(w.c)
      const origin = w.harnessOrigin()
      const enrolled = await raw(harness, { method: 'POST', path: '/qa/api/enrol', headers: JSON_TYPE, body: '{}' })
      const { token } = JSON.parse(enrolled.body)
      const cap = { 'x-qa-cap': token }
      assert.equal((await api(harness, 'POST', '/api/session', { pr: 7 }, cap)).ok, true)
      const st = await waitFor(async () => { const s = await api(harness, 'GET', '/api/state', undefined, cap); return s.status === 'ready' && s })

      const entry = async (role, to) => {
        const res = await raw(harness, { method: 'POST', path: '/qa/api/pane-entry', headers: { ...JSON_TYPE, ...cap }, body: JSON.stringify({ role, to }) })
        assert.equal(res.status, 200, `${layout} ${res.body}`)
        const url = new URL(JSON.parse(res.body).url)
        assert.equal(url.origin, w.cfg.paneOrigins[role], layout)
        assert.equal(url.pathname, '/__qa/enter')
        assert.match(url.searchParams.get('t'), /^[A-Za-z0-9_-]{43}$/)
        return url.pathname + url.search
      }
      // the harness loading a pane in its iframe
      const frame = role => ({ host: new URL(w.cfg.paneOrigins[role]).host, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', referer: `${origin}/` })
      const enterPath = await entry('base', st.panes.base)
      const entered = await raw(base, { path: enterPath, cap: false, headers: frame('base') })
      assert.equal(entered.status, 303, layout)
      assert.equal(entered.headers.location, '/login-base')
      const name = paneCookieName(origin, w.cfg.paneOrigins.base)
      assert.equal(name.startsWith('__Host-qa-'), secure, layout)
      const [setCookie] = entered.headers['set-cookie']
      assert.match(setCookie, new RegExp(`^${name}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}$`), layout)
      const cookie = setCookie.split(';')[0]
      assert.notEqual(cookie.split('=')[1], token, 'the pane cookie is not the harness token')

      // the redirect's next hop, and the app never sees the pane cookie
      const landing = await raw(base, { path: '/login-base', cap: false, headers: { ...frame('base'), cookie } })
      assert.deepEqual([landing.status, landing.body], [200, 'pane-base'], layout)
      const echoed = await raw(base, { path: '/cookie', cap: false, headers: { host: frame('base').host, 'sec-fetch-site': 'same-origin', cookie: `rc_session=secret; ${cookie}` } })
      assert.deepEqual([echoed.status, echoed.body], [200, '(none)'], layout)
      // cookies ignore ports: the PR pane admits the same cookie
      const prPage = await raw(pr, { path: '/x', cap: false, headers: { host: new URL(w.cfg.paneOrigins.pr).host, 'sec-fetch-site': 'same-origin', cookie } })
      assert.deepEqual([prPage.status, prPage.body], [200, 'pane-pr'], layout)

      // a ticket works once, and only on its own pane
      const again = await raw(base, { path: enterPath, cap: false, headers: frame('base') })
      assert.deepEqual([again.status, again.headers['x-qa-refusal'], again.headers['set-cookie']], [403, 'capability', undefined], layout)
      const prTicket = await entry('base', '/')
      const elsewhere = await raw(pr, { path: prTicket, cap: false, headers: frame('pr') })
      assert.deepEqual([elsewhere.status, elsewhere.headers['set-cookie']], [403, undefined], layout)
      assert.equal((await raw(base, { path: prTicket, cap: false, headers: frame('base') })).status, 403, 'spent on the wrong pane')
      const own = await raw(pr, { path: await entry('pr', `${w.cfg.paneOrigins.pr}/deep/link?q=1#frag`), cap: false, headers: frame('pr') })
      assert.deepEqual([own.status, own.headers.location], [303, '/deep/link?q=1#frag'], layout)
    } finally { w.c.stop() }
  }
})

test('POST /api/pane-entry takes base or pr, and a path on that pane; a pane origin on another host gets 409', async () => {
  const { c, cfg } = makeWorld()
  try {
    const port = await harnessPort(c)
    const entry = body => raw(port, { method: 'POST', path: '/qa/api/pane-entry', headers: JSON_TYPE, body: JSON.stringify(body) })
    for (const role of [undefined, 'nope', 'harness', 1]) {
      const res = await entry({ role, to: '/' })
      assert.deepEqual([res.status, JSON.parse(res.body)], [400, { error: 'role must be base or pr' }], String(role))
    }
    for (const to of [42, '//evil.example/x', '/\\evil.example/x', 'https://evil.example/', 'javascript:alert(1)', 'https://h.ts.net:10000/x', 'http://h.ts.net:8443/x']) {
      const res = await entry({ role: 'base', to })
      assert.deepEqual([res.status, JSON.parse(res.body)], [400, { error: 'to must be a path on the base pane' }], String(to))
    }
    for (const to of [undefined, '/', '/a?b', 'a', 'https://H.TS.NET:8443/a?b']) {
      assert.equal((await entry({ role: 'base', to })).status, 200, String(to))
    }
    // A path on the pane that starts with `//` (one a pane's bridge can report,
    // or one that normalizes to it) still lands on the pane: a Location of
    // `//x` would name another host.
    const base = await proxyPort(c.servers.baseProxy)
    for (const to of ['https://h.ts.net:8443//evil.example/x', 'https://h.ts.net:8443/\\evil.example/x', '/.//evil.example/x', '/%2e//evil.example/x', '/a/..//evil.example/x']) {
      const res = await entry({ role: 'base', to })
      assert.equal(res.status, 200, to)
      const url = new URL(JSON.parse(res.body).url)
      const entered = await raw(base, { path: url.pathname + url.search, cap: false, headers: { host: 'h.ts.net:8443' } })
      assert.equal(entered.status, 303, to)
      const landing = new URL(entered.headers.location, 'https://h.ts.net:8443/__qa/enter')
      assert.deepEqual([landing.origin, landing.pathname], ['https://h.ts.net:8443', '//evil.example/x'], `${to} -> ${entered.headers.location}`)
    }
    cfg.paneOrigins = { ...cfg.paneOrigins, base: 'https://other.ts.net:8443' }
    const moved = await entry({ role: 'base', to: '/' })
    assert.equal(moved.status, 409)
    assert.match(JSON.parse(moved.body).error, /^the harness origin https:\/\/h\.ts\.net:8444 and the base pane's origin https:\/\/other\.ts\.net:8443 are on different hosts/)
    cfg.paneOrigins = { ...cfg.paneOrigins, base: 'not yet' }
    assert.deepEqual(JSON.parse((await entry({ role: 'base', to: '/' })).body), { error: 'the base pane has no origin yet' })
  } finally { c.stop() }
})

test('an invite enrols one more browser, even while a session runs, once', async () => {
  const { c, token } = makeWorld({ hang: { 7: deferred() } })
  try {
    const port = await harnessPort(c)
    const res = await raw(port, { method: 'POST', path: '/qa/api/invite', headers: JSON_TYPE, body: '{}' })
    assert.equal(res.status, 200)
    const { url, expiresAt } = JSON.parse(res.body)
    const [, ticket] = url.match(/^https:\/\/h\.ts\.net:8444\/qa\/#enrol=([A-Za-z0-9_-]{43})$/)
    assert.ok(Math.abs(expiresAt - (Date.now() + 10 * 60_000)) < 5000)
    assert.notEqual(ticket, token)

    await api(port, 'POST', '/api/session', { pr: 7 })
    assert.equal(await enrolment(port), BOOTING)
    assert.equal(await enrolment(port, { invite: ticket }), 'open')
    for (const invite of [ticket, 'guess', 42, token]) {
      const again = await raw(port, { method: 'POST', path: '/qa/api/enrol', cap: false, headers: JSON_TYPE, body: JSON.stringify({ invite }) })
      assert.deepEqual([again.status, again.headers['x-qa-refusal'], JSON.parse(again.body).error], [403, 'capability', 'this invite link has expired or was already used'], String(invite))
    }
  } finally { c.stop() }

  // with no harness origin there is nowhere to send the invitee
  const nowhere = makeWorld({ cfg: { publicHost: null, host: '0.0.0.0' } })
  try {
    const res = await raw(await harnessPort(nowhere.c), { method: 'POST', path: '/qa/api/invite', headers: JSON_TYPE, body: '{}' })
    assert.deepEqual([res.status, JSON.parse(res.body).error], [409, 'no harness origin to invite a browser to (set QA_HARNESS_ORIGIN)'])
  } finally { nowhere.c.stop() }
})

// A stream is checked as it opens. One whose browser is pushed out of the
// enrolled 32 later must not go on getting events, `ready`'s pane URLs
// among them.
test('the event stream of a browser pushed out of the enrolled ends before the next event', async () => {
  const w = makeWorld({ enrolled: false })
  try {
    const { harness } = await allPorts(w.c)
    const enrol = async () => JSON.parse((await raw(harness, { method: 'POST', path: '/qa/api/enrol', cap: false, headers: JSON_TYPE, body: '{}' })).body).token
    const first = await enrol()
    let text = ''
    // An idle stream sends no byte until its first event, so wait for the
    // conductor to have taken the request instead.
    const taken = new Promise(resolve => w.c.servers.harness.on('request', req => { if (req.url.includes('/api/progress')) setImmediate(resolve) }))
    const ended = new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: harness, path: `/qa/api/progress?cap=${first}`, agent: false }, res => {
        res.on('data', c => { text += c })
        res.on('end', () => resolve(res.statusCode))
      }).on('error', reject)
    })
    await taken
    let last
    for (let i = 0; i < 32; i++) last = await enrol()
    assert.equal((await raw(harness, { path: '/qa/api/state', cap: false, headers: { 'x-qa-cap': first } })).status, 403, 'pushed out')
    // a browser still enrolled, whose stream goes on
    let kept = ''
    const keptStream = new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: harness, path: `/qa/api/progress?cap=${last}`, agent: false }, res => {
        res.on('data', c => { kept += c; if (kept.includes('"step"')) { req.destroy(); resolve() } })
      })
      req.on('error', err => { if (!kept.includes('"step"')) reject(err) })
    })
    await raw(harness, { method: 'POST', path: '/qa/api/session', cap: false, headers: { ...JSON_TYPE, 'x-qa-cap': last }, body: '{"pr":7}' })
    let timer
    const outcome = await Promise.race([ended, new Promise(r => { timer = setTimeout(() => r('still open'), 2000) })])
    clearTimeout(timer)
    assert.equal(outcome, 200, 'it was open, and has ended')
    assert.equal(text, '', 'no event reached it')
    await keptStream
    assert.match(kept, /"kind":"step"/)
  } finally { w.c.stop() }
})

test('the event stream takes the token as ?cap=, and no other route does', async () => {
  const { c, token } = makeWorld()
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const stream = await rawHead(port, { path: `/qa/api/progress?cap=${token}`, headers: { 'sec-fetch-site': 'same-origin' } })
    assert.deepEqual([stream.status, stream.headers['content-type']], [200, 'text/event-stream'])
    for (const r of [
      { path: `/qa/api/state?cap=${token}` },
      { method: 'POST', path: `/qa/api/teardown?cap=${token}`, headers: JSON_TYPE, body: '{}' },
      // the stream's own path, but not a GET
      { method: 'POST', path: `/qa/api/progress?cap=${token}`, headers: JSON_TYPE, body: '{}' },
      // a header, even a wrong one, is what counts
      { path: `/qa/api/progress?cap=${token}`, headers: { 'x-qa-cap': 'guess' } },
      { path: `/qa/api/progress?cap=${token}`, headers: { 'x-qa-cap': '' } },
    ]) {
      const res = await rawHead(port, { ...r, headers: { 'sec-fetch-site': 'same-origin', ...r.headers } })
      assert.deepEqual([res.status, res.headers['x-qa-refusal']], [403, 'capability'], `${r.method ?? 'GET'} ${r.path} ${JSON.stringify(r.headers ?? {})}`)
    }
  } finally { c.stop() }
})

test('a restart revokes every token and pane cookie', async () => {
  const first = makeWorld({ enrolled: false })
  let token, cookie
  try {
    const { harness, base } = await allPorts(first.c)
    token = JSON.parse((await raw(harness, { method: 'POST', path: '/qa/api/enrol', headers: JSON_TYPE, body: '{}' })).body).token
    const entry = await raw(harness, { method: 'POST', path: '/qa/api/pane-entry', headers: { ...JSON_TYPE, 'x-qa-cap': token }, body: '{"role":"base","to":"/"}' })
    const url = new URL(JSON.parse(entry.body).url)
    const entered = await raw(base, { path: url.pathname + url.search, cap: false, headers: { host: url.host, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', referer: 'https://h.ts.net:8444/' } })
    cookie = entered.headers['set-cookie'][0].split(';')[0]
    // admitted (no session yet, so the pane has nothing to show)
    assert.equal((await raw(base, { path: '/x', cap: false, headers: { cookie } })).status, 503)
  } finally { first.c.stop() }

  const second = makeWorld({ enrolled: false })
  try {
    const { harness, base } = await allPorts(second.c)
    const state = await raw(harness, { path: '/qa/api/state', cap: false, headers: { 'x-qa-cap': token } })
    assert.deepEqual([state.status, state.headers['x-qa-refusal']], [403, 'capability'])
    const pane = await raw(base, { path: '/x', cap: false, headers: { cookie } })
    assert.deepEqual([pane.status, pane.headers['x-qa-refusal']], [403, 'capability'])
  } finally { second.c.stop() }
})

// On plain-http loopback the PR app may see the pane cookie (README,
// Security): the value must die with its session, not admit the base pane in
// every later one.
test('a pane cookie lasts one session: a teardown, a boot and a ready each give the browser a new one', async () => {
  const hang = {}
  const w = makeWorld({ enrolled: false, hang })
  try {
    const { harness, base, pr } = await allPorts(w.c)
    const token = JSON.parse((await raw(harness, { method: 'POST', path: '/qa/api/enrol', headers: JSON_TYPE, body: '{}' })).body).token
    const cap = { 'x-qa-cap': token }
    const enter = async role => {
      const entry = await raw(harness, { method: 'POST', path: '/qa/api/pane-entry', headers: { ...JSON_TYPE, ...cap }, body: JSON.stringify({ role, to: '/' }) })
      const url = new URL(JSON.parse(entry.body).url)
      const entered = await raw(role === 'base' ? base : pr, { path: url.pathname + url.search, cap: false, headers: { host: url.host, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', referer: 'https://h.ts.net:8444/' } })
      return entered.headers['set-cookie'][0].split(';')[0]
    }
    const status = async (port, cookie) => (await raw(port, { path: '/page', cap: false, headers: { cookie } })).status
    const ready = async () => waitFor(async () => (await raw(harness, { path: '/qa/api/state', cap: false, headers: cap })).body.includes('"status":"ready"'))

    await raw(harness, { method: 'POST', path: '/qa/api/session', headers: { ...JSON_TYPE, ...cap }, body: '{"pr":7}' })
    await ready()
    const first = await enter('pr')
    assert.deepEqual([await status(base, first), await status(pr, first)], [200, 200])

    await raw(harness, { method: 'POST', path: '/qa/api/teardown', headers: { ...JSON_TYPE, ...cap }, body: '{}' })
    for (const port of [base, pr]) {
      const res = await raw(port, { path: '/page', cap: false, headers: { cookie: first } })
      assert.deepEqual([res.status, res.headers['x-qa-refusal']], [403, 'capability'], 'gone with its session')
    }
    // the same browser, its harness token still good, enters the next session
    await raw(harness, { method: 'POST', path: '/qa/api/session', headers: { ...JSON_TYPE, ...cap }, body: '{"pr":8}' })
    await ready()
    const second = await enter('base')
    assert.notEqual(second, first)
    assert.deepEqual([await status(base, second), await status(base, first)], [200, 403])

    // A session replaced without a teardown (the same PR opened again): the
    // boot's start takes the cookie (403, not the booting pane's 503), and
    // one taken mid-boot lasts only until that boot is ready.
    hang[8] = deferred()
    await raw(harness, { method: 'POST', path: '/qa/api/session', headers: { ...JSON_TYPE, ...cap }, body: '{"pr":8}' })
    assert.equal(await status(base, second), 403)
    const midBoot = await enter('base')
    assert.equal(await status(base, midBoot), 503, 'admitted, with no app yet')
    // a ticket asked for mid-boot, not yet spent, is that boot's too
    const unspent = new URL(JSON.parse((await raw(harness, { method: 'POST', path: '/qa/api/pane-entry', headers: { ...JSON_TYPE, ...cap }, body: '{"role":"base","to":"/"}' })).body).url)
    hang[8].resolve()
    await ready()
    assert.equal(await status(base, midBoot), 403)
    const late = await raw(base, { path: unspent.pathname + unspent.search, cap: false, headers: { host: unspent.host, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', referer: 'https://h.ts.net:8444/' } })
    assert.deepEqual([late.status, late.headers['x-qa-refusal'], late.headers['set-cookie']], [403, 'capability', undefined])
    assert.equal(await status(base, await enter('base')), 200)
  } finally { w.c.stop() }
})

// POST /api/enrol is the one API route anyone may call, so it must not buffer
// whatever a caller sends before it decides. Every body is small JSON.
test('a JSON body over 64 KiB gets 413 without being read whole, on POST /api/enrol and every other route', async () => {
  const { c, calls } = makeWorld({ hang: { 7: deferred() } })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) })
    for (const [path, cap] of [['/qa/api/enrol', false], ['/qa/api/session', true], ['/qa/api/pane-entry', true]]) {
      // declared up front, and streamed with no Content-Length
      for (const headers of [{ ...JSON_TYPE, 'content-length': String(Buffer.byteLength(big)) }, JSON_TYPE]) {
        const res = await raw(port, { method: 'POST', path, cap, headers, body: big })
        assert.deepEqual([res.status, JSON.parse(res.body), res.headers.connection], [413, { error: 'request body too large' }, 'close'], `${path} ${JSON.stringify(headers)}`)
      }
    }
    // a declared length alone is refused before a byte is read
    const declared = await raw(port, { method: 'POST', path: '/qa/api/enrol', cap: false, headers: { ...JSON_TYPE, 'content-length': '268435456' }, body: '{}' }).catch(err => err)
    assert.equal(declared.status ?? declared.code, 413, String(declared))
    assert.deepEqual(calls.filter(x => x[0] === 'ensureBuilt').map(x => x[1]), [7], 'no takeover')
  } finally { c.stop() }
})

test('a JSON body that isn\'t an object is read as {}, never a 500', async () => {
  const { c } = makeWorld({ hang: { 7: deferred() } })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    for (const body of ['null', '[]', '1', '"x"', 'true', 'not json']) {
      const enrol = await raw(port, { method: 'POST', path: '/qa/api/enrol', cap: false, headers: JSON_TYPE, body })
      assert.deepEqual([enrol.status, enrol.headers['x-qa-refusal']], [403, 'capability'], `enrol ${body}`)
      const session = await raw(port, { method: 'POST', path: '/qa/api/session', headers: JSON_TYPE, body })
      assert.deepEqual([session.status, JSON.parse(session.body)], [400, { error: 'pr (number) required' }], `session ${body}`)
      const entry = await raw(port, { method: 'POST', path: '/qa/api/pane-entry', headers: JSON_TYPE, body })
      assert.equal(entry.status, 400, `pane-entry ${body}`)
    }
  } finally { c.stop() }
})

test('startConductor refuses a forwardClientCookies name starting with qa-, and pane origins on another host than the harness origin, before anything starts', () => {
  let swept = false
  const provisioner = { sweep: () => { swept = true } }
  for (const name of ['qa-1', 'QA-x', '__Host-qa-x', '__Secure-qa-x']) {
    assert.throws(
      () => startOnly({ forwardClientCookies: ['locale', name] }, { provisioner }),
      err => err.message === `startConductor: cfg.forwardClientCookies can't name ${JSON.stringify(name)}: cookie names starting with qa- are the conductor's own`,
      name,
    )
  }
  for (const [cfg, harness, role, pane] of [
    [{ paneOrigins: { base: 'https://other.ts.net:8443', pr: 'https://h.ts.net:10000' } }, 'https://h.ts.net:8444', 'base', 'https://other.ts.net:8443'],
    [{ paneOrigins: { base: 'https://h.ts.net:8443', pr: 'https://h.tail1234.ts.net:10000' } }, 'https://h.ts.net:8444', 'pr', 'https://h.tail1234.ts.net:10000'],
    [{ harnessOrigin: 'https://qa.example:8444' }, 'https://qa.example:8444', 'base', 'https://h.ts.net:8443'],
    [{ publicHost: null, harnessOrigin: 'http://localhost:3100', paneOrigins: LOOPBACK_PANES }, 'http://localhost:3100', 'base', 'http://127.0.0.1:3101'],
    // derived from a fixed loopback port
    [{ publicHost: null, host: '::1', ports: { harness: 3100, base: 0, pr: 0 }, paneOrigins: LOOPBACK_PANES }, 'http://[::1]:3100', 'base', 'http://127.0.0.1:3101'],
  ]) {
    assert.throws(() => startOnly(cfg, { provisioner }), err => {
      assert.equal(err.message,
        `startConductor: the harness origin ${harness} and the ${role} pane's origin ${pane} are on different hosts, ` +
        `and the pane cookie never reaches a pane framed from another site: serve the harness and both panes on one hostname`)
      return true
    }, JSON.stringify(cfg))
  }
  assert.equal(swept, false, 'refused before the startup sweep')
})

// --- #29: the enrolment window, at its edges --------------------------------------------

// The routes that hand out a capability are guarded like every other: another
// page can neither drive them nor send them a type an HTML form can.
test('POST /api/enrol, /api/invite and /api/pane-entry sit behind the same-origin, harness-host and JSON checks', async () => {
  const { c, calls, capability } = makeWorld()
  try {
    const port = await harnessPort(c)
    await waitFor(() => calls.some(x => x[0] === 'sweep-done'))
    const enrolled = capability.size()
    const host = `127.0.0.1:${port}`
    const body = '{"role":"base","to":"/"}'
    for (const path of ['/qa/api/enrol', '/qa/api/invite', '/qa/api/pane-entry']) {
      // another site's page, a pane's page, and an older browser's cross-site POST
      for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site', origin: 'https://h.ts.net:10000' }, { origin: 'https://evil.example' }]) {
        const res = await raw(port, { method: 'POST', path, headers: { host, ...JSON_TYPE, ...headers }, body })
        assert.deepEqual([res.status, JSON.parse(res.body).error], [403, 'cross-site request refused'], `${path} ${JSON.stringify(headers)}`)
      }
      // a handler at another port of the harness hostname
      const elsewhere = await raw(port, { method: 'POST', path, headers: { host: 'h.ts.net:8443', 'sec-fetch-site': 'same-origin', ...JSON_TYPE }, body })
      assert.deepEqual([elsewhere.status, JSON.parse(elsewhere.body).error], [403, 'not the harness origin'], path)
      // a type an HTML form can send
      for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded']) {
        const res = await raw(port, { method: 'POST', path, headers: type ? { 'content-type': type } : {}, body })
        assert.equal(res.status, 415, `${path} ${type}`)
      }
    }
    assert.equal(capability.size(), enrolled, 'no browser enrolled')
  } finally { c.stop() }
})

// Boot A (#7) is taken over inside launchServices; boot B (#8) starts with A
// in flight, A settles, then B fails and tears down cleanly. B's own teardown doesn't count: a
// cleanup teardown must follow once both have settled.
test('a failed boot\'s own clean teardown does not mark the panes clean when another boot was in flight as it started', async () => {
  const launchedA = deferred()
  const gateA = deferred()
  const gateB = deferred()
  let launches = 0
  const { c, calls } = makeWorld({
    provisioner: {
      launchServices: async () => {
        launches++
        if (launches === 1) { launchedA.resolve(); await gateA.promise; return }
        await gateB.promise
        throw new Error('launch failed')
      },
    },
  })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await launchedA.promise
    await api(port, 'POST', '/api/session', { pr: 8, takeover: true })
    await waitFor(() => launches === 2)
    gateA.resolve() // A starts its app after the takeover's teardown, sees the abort, settles
    await new Promise(r => setTimeout(r, 20))
    gateB.resolve() // B fails, and its own teardown succeeds
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'error')
    await waitFor(async () => (await enrolment(port)) === 'open')
    // the takeover's (2), B's own (2), and the cleanup once both had settled (2)
    assert.equal(calls.filter(x => x[0] === 'teardown').length, 6)
  } finally { c.stop() }
})

// The cancelled boot starts its app and settles while the teardown runs: that teardown may have
// missed it, so a cleanup teardown must follow before enrolment opens.
test('a cancelled boot that settles during the teardown gets a cleanup teardown before enrolment opens', async () => {
  const launched = deferred()
  const launchGate = deferred()
  const teardownGate = deferred()
  let first = true
  const { c, calls } = makeWorld({
    provisioner: {
      launchServices: async () => { launched.resolve(); await launchGate.promise },
      teardown: async ({ paneRef }) => {
        calls.push(['teardown', paneRef.role])
        if (first) { first = false; await teardownGate.promise }
      },
    },
  })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await launched.promise
    const ending = api(port, 'POST', '/api/teardown')
    await waitFor(() => calls.some(x => x[0] === 'teardown'))
    launchGate.resolve() // the boot goes on, sees the abort and settles, mid-teardown
    await new Promise(r => setTimeout(r, 20))
    teardownGate.resolve()
    await ending
    await waitFor(async () => (await enrolment(port)) === 'open')
    assert.deepEqual(calls.filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr', 'base', 'pr'], 'a cleanup ran after the boot settled')
  } finally { c.stop() }
})

// The cleanup removes the panes by their fixed names, so a boot started while
// it runs must not provision until it is done.
test('a boot waits for the cleanup teardown in flight before it builds or provisions', async () => {
  const cleanupGate = deferred()
  let teardowns = 0
  const { c, calls } = makeWorld({
    failAt: 'launchServices',
    provisioner: {
      teardown: async ({ paneRef }) => {
        teardowns++
        calls.push(['teardown', paneRef.role])
        if (teardowns === 1) throw new Error('busy') // the failed boot's own teardown fails
        if (teardowns === 3) await cleanupGate.promise // the cleanup after it hangs
      },
    },
  })
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(() => teardowns === 3)
    assert.equal((await api(port, 'POST', '/api/session', { pr: 8 })).ok, true)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(calls.some(x => x[0] === 'ensureBuilt' && x[1] === 8), false, 'held back by the cleanup')
    cleanupGate.resolve()
    await waitFor(() => calls.some(x => x[0] === 'ensureBuilt' && x[1] === 8))
    const seq = calls.filter(x => x[0] === 'teardown' || (x[0] === 'ensureBuilt' && x[1] === 8)).map(x => x[0])
    assert.deepEqual(seq.slice(0, 5), ['teardown', 'teardown', 'teardown', 'teardown', 'ensureBuilt'])
  } finally { c.stop() }
})

// A boot that returned from bootSession after it was cancelled ran PR code.
test('a boot cancelled during its last sign-in still counts as having run: a cleanup teardown follows it', async () => {
  const signing = deferred()
  const signGate = deferred()
  const { c, calls, adapters } = makeWorld()
  adapters.auth.establishSession = async ({ pane }) => {
    if (pane.ref.role === 'pr') { signing.resolve(); await signGate.promise }
    return { landingUrl: `login-${pane.ref.role}`, cookies: [] }
  }
  try {
    const port = await harnessPort(c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await signing.promise
    await api(port, 'POST', '/api/teardown')
    assert.equal(await enrolment(port), STOPPING)
    signGate.resolve() // bootSession returns normally, to a boot that was cancelled
    await waitFor(async () => (await enrolment(port)) === 'open')
    assert.equal(calls.filter(x => x[0] === 'teardown').length, 4, 'the cleanup ran after the boot settled')
  } finally { c.stop() }
})

// Nothing can frame a pane then, but the route must not fail.
test('with no harness origin, POST /api/pane-entry still issues a ticket', async () => {
  const { c } = makeWorld({ cfg: { publicHost: null, host: '0.0.0.0' } })
  try {
    const res = await raw(await harnessPort(c), { method: 'POST', path: '/qa/api/pane-entry', headers: JSON_TYPE, body: '{"role":"base","to":"/"}' })
    assert.equal(res.status, 200, res.body)
    assert.match(JSON.parse(res.body).url, /^https:\/\/h\.ts\.net:8443\/__qa\/enter\?t=[A-Za-z0-9_-]{43}$/)
  } finally { c.stop() }
})

// A Provisioner that rejects with a string: bootSession can't mark it, and its
// teardown failed, so a cleanup must run before enrolment opens.
test('a boot that fails with a non-Error, and whose own teardown fails, gets a cleanup before enrolment opens', async () => {
  let failing = 1
  const w = makeWorld({
    provisioner: {
      launchServices: async () => { throw 'launch failed' }, // eslint-disable-line no-throw-literal
      teardown: async ({ paneRef }) => {
        w.calls.push(['teardown', paneRef.role])
        if (failing > 0) { failing--; throw new Error('busy') }
      },
    },
  })
  try {
    const port = await harnessPort(w.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'error')
    await waitFor(async () => (await enrolment(port)) === 'open')
    assert.deepEqual(w.calls.filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr', 'base', 'pr'])
  } finally { w.c.stop() }
})

// --- #29: the per-session isolation verdict ---------------------------------------
// Whether the PR pane can reach the base pane, so #8 knows whether to trust a
// base-vs-PR comparison: the Provisioner's check (or declaration), raised by
// the runtime floors, in /api/state and the event stream. QA_REQUIRE_ISOLATION
// refuses a session that isn't isolated, before the PR's code runs.

const isolatedCheck = calls => async ({ canary }) => {
  calls.push(['isolation', canary.port, canary.path, canary.expect])
  return { verdict: 'isolated', reasons: [] }
}

test('the verdict comes from the Provisioner\'s check, and reaches /api/state, the event stream and ready; a new boot starts without one', async () => {
  const hang = { 8: deferred() }
  const w = makeWorld({ hang })
  w.adapters.provisioner.isolation = isolatedCheck(w.calls)
  try {
    const port = await harnessPort(w.c)
    assert.equal((await api(port, 'GET', '/api/state')).isolation, null)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const events = await sseEvents(port, evs => evs.some(e => e.kind === 'ready'))
    const st = await api(port, 'GET', '/api/state')
    assert.deepEqual({ ...st.isolation, checkedAt: typeof st.isolation.checkedAt }, { verdict: 'isolated', reasons: [], checkedAt: 'number' })
    const ev = events.find(e => e.kind === 'isolation')
    assert.deepEqual([ev.verdict, ev.reasons], ['isolated', []])
    assert.deepEqual(events.find(e => e.kind === 'ready').isolation, st.isolation)
    // the check ran once both databases existed, before the panes were started
    const seq = w.calls.map(x => x[0])
    assert.ok(seq.lastIndexOf('provisionDatabase') < seq.indexOf('isolation'), seq.join(' '))
    const [, canaryPort, path, expect] = w.calls.find(x => x[0] === 'isolation')
    assert.equal(canaryPort, port)
    assert.match(path, /^\/__qa\/canary\/[0-9a-f]{32}$/)
    assert.equal(expect, `qa-canary ${path.split('/').pop()}`)

    await api(port, 'POST', '/api/session', { pr: 8, takeover: true })
    await waitFor(() => w.calls.some(x => x[0] === 'ensureBuilt' && x[1] === 8))
    assert.equal((await api(port, 'GET', '/api/state')).isolation, null, 'reset for the new boot')
  } finally { w.c.stop() }
})

test('a Provisioner that declares shared-host, has no check, or whose check fails or says nothing, gets that verdict at once or unknown', async () => {
  const cases = [
    ['shared-host', { verdict: 'shared-host', reasons: ['both panes run as one user on this host'] }],
    [undefined, { verdict: 'unknown', reasons: ['the Provisioner has no isolation check'] }],
    [async () => { throw new Error('docker went away') }, { verdict: 'unknown', reasons: ['the isolation check failed: docker went away'] }],
    [async () => ({ verdict: 'yes' }), { verdict: 'unknown', reasons: ['the isolation check gave no verdict'] }],
    [async () => ({ verdict: 'reachable', reasons: ['the PR pane reached the base pane\'s database'] }), { verdict: 'reachable', reasons: ['the PR pane reached the base pane\'s database'] }],
  ]
  for (const [isolation, want] of cases) {
    const w = makeWorld()
    if (isolation === undefined) delete w.adapters.provisioner.isolation
    else w.adapters.provisioner.isolation = isolation
    try {
      const port = await harnessPort(w.c)
      await api(port, 'POST', '/api/session', { pr: 7 })
      const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
      assert.deepEqual({ verdict: st.isolation.verdict, reasons: st.isolation.reasons }, want, String(isolation))
    } finally { w.c.stop() }
  }
})

test('the runtime floors raise the check\'s verdict: macOS, and a bind off loopback', async () => {
  for (const [opts, want] of [
    [{ platform: 'darwin' }, /^on macOS, containers run in a VM/],
    [{ cfg: { host: '0.0.0.0', publicHost: 'h.ts.net' } }, /^the conductor listens on 0\.0\.0\.0, which containers can reach$/],
  ]) {
    const w = makeWorld(opts)
    w.adapters.provisioner.isolation = isolatedCheck(w.calls)
    try {
      const port = await harnessPort(w.c)
      await api(port, 'POST', '/api/session', { pr: 7 })
      const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
      assert.equal(st.isolation.verdict, 'reachable', JSON.stringify(opts))
      assert.equal(st.isolation.reasons.length, 1)
      assert.match(st.isolation.reasons[0], want)
    } finally { w.c.stop() }
  }
})

// The probe confirms a hit is this conductor: the harness port answers the
// probe's nonce, only while the check runs, before the identity gate.
test('the harness answers the canary path only while the check runs, in none and tailscale modes', async () => {
  for (const cfg of [{}, GATED]) {
    const w = makeWorld({ cfg })
    let during = null
    w.adapters.provisioner.isolation = async ({ canary }) => {
      const hit = await raw(canary.port, { path: canary.path, cap: false })
      const wrong = await raw(canary.port, { path: canary.path.replace(/.$/, c => (c === '0' ? '1' : '0')), cap: false })
      during = { canary, hit, wrong }
      return { verdict: hit.body.includes(canary.expect) ? 'reachable' : 'isolated', reasons: ['the PR pane reached this conductor'] }
    }
    try {
      const port = await harnessPort(w.c)
      const login = cfg === GATED ? ALLOWED : {}
      await api(port, 'POST', '/api/session', { pr: 7 }, login)
      await waitFor(async () => (await api(port, 'GET', '/api/state', undefined, login)).status === 'ready')
      assert.deepEqual([during.hit.status, during.hit.body], [200, `${during.canary.expect}\n`], JSON.stringify(cfg))
      assert.notEqual(during.wrong.status, 200)
      const after = await raw(port, { path: during.canary.path, cap: false })
      assert.notEqual(after.status, 200, 'not once the check is done')
      assert.doesNotMatch(after.body, /qa-canary/)
    } finally { w.c.stop() }
  }
})

test('QA_REQUIRE_ISOLATION refuses a session that isn\'t isolated: as it starts when that is known then, else once the databases exist, before the PR\'s code', async () => {
  const strict = { requireIsolation: true }
  const refuse = verdict => new RegExp(`^QA_REQUIRE_ISOLATION=1 refuses a session whose PR pane isn't isolated from the base pane \\(${verdict}: `)
  const start = [
    [{ cfg: strict }, 'shared-host', 'shared-host'],
    [{ cfg: strict }, undefined, 'unknown'],
    [{ cfg: strict, platform: 'darwin' }, 'check', 'reachable'],
  ]
  for (const [opts, isolation, verdict] of start) {
    const w = makeWorld(opts)
    if (isolation === undefined) delete w.adapters.provisioner.isolation
    else w.adapters.provisioner.isolation = isolation === 'check' ? isolatedCheck(w.calls) : isolation
    try {
      const port = await harnessPort(w.c)
      await api(port, 'POST', '/api/session', { pr: 7 })
      const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
      assert.equal(st.error.step, 'ensuring-image')
      assert.match(st.error.message, refuse(verdict))
      assert.equal(st.isolation.verdict, verdict)
      const seq = w.calls.map(x => x[0])
      for (const later of ['ensureBuilt', 'provisionDatabase', 'isolation']) assert.equal(seq.includes(later), false, `${verdict}: ${later}`)
    } finally { w.c.stop() }
  }

  // a check that finds the base pane: refused before any migrate or launch
  const w = makeWorld({ cfg: strict })
  w.adapters.provisioner.isolation = async () => ({ verdict: 'reachable', reasons: ['the PR pane reached the base pane\'s database at 172.19.0.2:5432'] })
  w.adapters.provisioner.launchServices = async ({ paneRef }) => { w.calls.push(['launchServices', paneRef.role]) }
  try {
    const port = await harnessPort(w.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
    assert.equal(st.error.step, 'cloning')
    assert.match(st.error.message, refuse('reachable'))
    assert.match(st.error.message, /172\.19\.0\.2:5432/)
    const seq = w.calls.map(x => x[0])
    assert.ok(seq.includes('provisionDatabase'))
    assert.equal(seq.includes('launchServices'), false)
    assert.deepEqual(w.calls.filter(x => x[0] === 'teardown').map(x => x[1]), ['base', 'pr'])
  } finally { w.c.stop() }

  // an isolated session boots as ever
  const ok = makeWorld({ cfg: strict })
  ok.adapters.provisioner.isolation = isolatedCheck(ok.calls)
  try {
    const port = await harnessPort(ok.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.equal(st.isolation.verdict, 'isolated')
  } finally { ok.c.stop() }
})

// build-worktree's install step runs the PR's install scripts on this host,
// as the reviewer, in ensureBuilt: before the probe, which can't speak for
// them. A BuildConvention that does so declares it.
test('a BuildConvention that runs the PR\'s code on this host makes the verdict shared-host, and strict mode refuses before ensureBuilt', async () => {
  const want = ['shared-host', ['the BuildConvention runs the PR\'s code on this host to build it (an install step)']]
  const strict = makeWorld({ cfg: { requireIsolation: true } })
  strict.adapters.build.isolation = 'shared-host'
  strict.adapters.provisioner.isolation = isolatedCheck(strict.calls)
  try {
    const port = await harnessPort(strict.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
    assert.equal(st.error.step, 'ensuring-image')
    assert.match(st.error.message, /^QA_REQUIRE_ISOLATION=1 refuses a session whose PR pane isn't isolated from the base pane \(shared-host: the BuildConvention runs the PR's code/)
    assert.deepEqual([st.isolation.verdict, st.isolation.reasons], want)
    const seq = strict.calls.map(x => x[0])
    for (const later of ['ensureBuilt', 'provisionDatabase', 'isolation']) assert.equal(seq.includes(later), false, later)
  } finally { strict.c.stop() }

  // not strict: the session boots, and the probe can't make it better
  const loose = makeWorld()
  loose.adapters.build.isolation = 'shared-host'
  loose.adapters.provisioner.isolation = isolatedCheck(loose.calls)
  try {
    const port = await harnessPort(loose.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.deepEqual([st.isolation.verdict, st.isolation.reasons], want)
    assert.ok(loose.calls.some(x => x[0] === 'isolation'), 'the probe still ran')
  } finally { loose.c.stop() }

  // known at the start, so a build that then fails leaves it said
  const failing = makeWorld()
  failing.adapters.build.isolation = 'shared-host'
  failing.adapters.build.ensureBuilt = async () => { throw new Error('pnpm install failed') }
  failing.adapters.provisioner.isolation = isolatedCheck(failing.calls)
  try {
    const port = await harnessPort(failing.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'error' && s })
    assert.equal(st.error.step, 'ensuring-image')
    assert.deepEqual([st.isolation.verdict, st.isolation.reasons], want)
  } finally { failing.c.stop() }
})

test('a session\'s verdict goes with it: /api/state says null once it is torn down', async () => {
  const w = makeWorld()
  w.adapters.provisioner.isolation = isolatedCheck(w.calls)
  try {
    const port = await harnessPort(w.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    assert.equal((await api(port, 'GET', '/api/state')).isolation.verdict, 'isolated')
    await api(port, 'POST', '/api/teardown')
    const st = await api(port, 'GET', '/api/state')
    assert.deepEqual([st.status, st.isolation], ['idle', null])
  } finally { w.c.stop() }
})

// On macOS, a Provisioner that runs no container (the process one, the
// demo's) gets no reason about containers' VMs.
test('shared-host on macOS gives the declaration\'s reason alone', async () => {
  const w = makeWorld({ platform: 'darwin' })
  w.adapters.provisioner.isolation = 'shared-host'
  try {
    const port = await harnessPort(w.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.deepEqual([st.isolation.verdict, st.isolation.reasons], ['shared-host', ['both panes run as one user on this host']])
  } finally { w.c.stop() }
})

// --- #8: the action log -----------------------------------------------------------
// What each pane's proxy forwarded, and the marks the harness posts, for the
// running session only, with no value in them anywhere.

async function readyWorld(opts) {
  const w = makeWorld(opts)
  const ports = await allPorts(w.c)
  await api(ports.harness, 'POST', '/api/session', { pr: 7 })
  await waitFor(async () => (await api(ports.harness, 'GET', '/api/state')).status === 'ready')
  return { w, ports }
}

test('the action log keeps each forwarded request with no header, cookie, body or query value, in no answer or event', async () => {
  const { w, ports } = await readyWorld()
  try {
    const before = (await api(ports.harness, 'GET', '/api/state')).lastActivity
    await raw(ports.base, { path: '/page?token=abc123SECRETxyz', headers: { authorization: 'Bearer SECRET-bearer', cookie: 'sid=SECRET-sid' } })
    await raw(ports.pr, { method: 'POST', path: '/cart/clear', headers: { 'content-type': 'text/plain' }, body: 'card=SECRET-card' })
    await new Promise(r => setTimeout(r, 30))
    const res = await raw(ports.harness, { path: '/qa/api/actions' })
    assert.equal(res.headers['cache-control'], 'no-store')
    const log = JSON.parse(res.body)
    assert.equal(log.active, true)
    assert.deepEqual(log.requests.map(r => [r.pane, r.method, r.path, r.status]), [['base', 'GET', '/page?token=…', 200], ['pr', 'POST', '/cart/clear', 200]])
    const events = await sseEvents(ports.harness, evs => evs.some(e => e.kind === 'ready'))
    for (const text of [res.body, JSON.stringify(events), JSON.stringify(await api(ports.harness, 'GET', '/api/state'))]) {
      assert.doesNotMatch(text, /SECRET|abc123/)
    }
    assert.equal((await api(ports.harness, 'GET', '/api/state')).lastActivity > before, true, 'the pane requests were activity')
    // reading the log is not
    const active = (await api(ports.harness, 'GET', '/api/state')).lastActivity
    await new Promise(r => setTimeout(r, 5))
    await raw(ports.harness, { path: '/qa/api/actions?after=1' })
    assert.equal((await api(ports.harness, 'GET', '/api/state')).lastActivity, active)
  } finally { w.c.stop() }
})

test('marks: a pane and a kind of action, rate-limited, in one sequence with the requests; refusals only counted', async () => {
  const { w, ports } = await readyWorld()
  try {
    const mark = body => raw(ports.harness, { method: 'POST', path: '/qa/api/actions/mark', headers: JSON_TYPE, body: JSON.stringify(body) })
    const first = await mark({ pane: 'base', type: 'click', selector: '#secret-selector', value: 'SECRET-typed' })
    assert.deepEqual([first.status, JSON.parse(first.body)], [200, { recorded: true }])
    assert.equal(first.headers['cache-control'], 'no-store')
    assert.deepEqual(JSON.parse((await mark({ pane: 'base', type: 'click' })).body), { recorded: false }, 'within 100 ms')
    for (const bad of [{ pane: 'both', type: 'click' }, { pane: 'base', type: 'keyup' }, {}, { pane: 'base' }]) {
      const res = await mark(bad)
      assert.equal(res.status, 400, JSON.stringify(bad))
    }
    await raw(ports.base, { path: '/cart' })
    // another site's frame, which the guard refuses: counted, never logged
    await raw(ports.pr, { path: '/x', cap: false, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', referer: 'https://evil.example/' } })
    await new Promise(r => setTimeout(r, 30))
    const log = JSON.parse((await raw(ports.harness, { path: '/qa/api/actions' })).body)
    assert.deepEqual(log.marks.map(m => [m.pane, m.type]), [['base', 'click']])
    assert.deepEqual(Object.keys(log.marks[0]).sort(), ['at', 'pane', 'seq', 'type'])
    // the request after the mark, in one sequence
    assert.deepEqual(log.requests.map(r => [r.path, r.seq > log.marks[0].seq]), [['/cart', true]])
    assert.deepEqual(log.refused, { base: {}, pr: { 'cross-site framing refused': 1 } })
    assert.deepEqual(log.marksDropped, { base: 1, pr: 0 })
    assert.doesNotMatch(JSON.stringify(log), /SECRET/)
    // a mark is no activity: PR code can post bridge messages
    const active = (await api(ports.harness, 'GET', '/api/state')).lastActivity
    await new Promise(r => setTimeout(r, 120))
    assert.deepEqual(JSON.parse((await mark({ pane: 'pr', type: 'change' })).body), { recorded: true })
    assert.equal((await api(ports.harness, 'GET', '/api/state')).lastActivity, active)
    // the mark is the pane's that posted it, and so is a refused one
    assert.deepEqual(JSON.parse((await mark({ pane: 'pr', type: 'change' })).body), { recorded: false })
    const after = JSON.parse((await raw(ports.harness, { path: `/qa/api/actions?after=${log.seq}` })).body)
    assert.deepEqual(after.marks.map(m => [m.pane, m.type]), [['pr', 'change']])
    assert.deepEqual(after.marksDropped, { base: 1, pr: 1 })
  } finally { w.c.stop() }
})

test('the action log is the running session\'s: empty before ready, gone at a teardown and at the next boot', async () => {
  const hang = { 8: deferred() }
  const { w, ports } = await readyWorld({ hang })
  const actions = async () => JSON.parse((await raw(ports.harness, { path: '/qa/api/actions' })).body)
  const mark = () => raw(ports.harness, { method: 'POST', path: '/qa/api/actions/mark', headers: JSON_TYPE, body: '{"pane":"pr","type":"submit"}' })
  try {
    await raw(ports.base, { path: '/one' })
    await new Promise(r => setTimeout(r, 30))
    const first = (await actions()).log
    assert.equal((await actions()).requests.length, 1)
    await api(ports.harness, 'POST', '/api/teardown')
    const gone = await actions()
    assert.deepEqual([gone.active, gone.log, gone.requests, gone.marks], [false, null, [], []])
    assert.equal((await mark()).status, 409, 'no session to mark')
    // the next boot: nothing until it is ready, and nothing of the last
    await api(ports.harness, 'POST', '/api/session', { pr: 8 })
    assert.equal((await actions()).active, false)
    assert.equal((await mark()).status, 409)
    hang[8].resolve()
    await waitFor(async () => (await api(ports.harness, 'GET', '/api/state')).status === 'ready')
    const fresh = await actions()
    assert.deepEqual([fresh.active, fresh.requests, fresh.seq], [true, [], 0])
    assert.match(fresh.log, /^[0-9a-f]{16}$/)

    // the same PR opened again, with no teardown: the boot drops the log too
    await raw(ports.base, { path: '/two' })
    await new Promise(r => setTimeout(r, 30))
    assert.equal((await actions()).requests.length, 1)
    hang[8] = deferred()
    await api(ports.harness, 'POST', '/api/session', { pr: 8 })
    const booting = await actions()
    assert.deepEqual([booting.active, booting.requests], [false, []])
    hang[8].resolve()
    // a reader sees another log: its cursor is the last session's
    await waitFor(async () => (await api(ports.harness, 'GET', '/api/state')).status === 'ready')
    const next = await actions()
    assert.equal(new Set([first, fresh.log, next.log]).size, 3)
  } finally { w.c.stop() }
})

test('GET /api/actions reads on from `after`, at most `limit` requests at a time', async () => {
  const { w, ports } = await readyWorld()
  const actions = async q => JSON.parse((await raw(ports.harness, { path: `/qa/api/actions${q}` })).body)
  try {
    for (const p of ['/a', '/b', '/c']) await raw(ports.base, { path: p })
    await new Promise(r => setTimeout(r, 30))
    const page = await actions('?limit=2')
    assert.deepEqual([page.requests.map(r => r.path), page.more], [['/a', '/b'], true])
    const rest = await actions(`?after=${page.seq}&limit=2`)
    assert.deepEqual([rest.requests.map(r => r.path), rest.more], [['/c'], false])
    assert.deepEqual((await actions(`?after=${rest.seq}`)).requests, [])
  } finally { w.c.stop() }
})

// A request binds the log of the session it started in: a late answer from
// the last session's app never lands in the next session's log.
test('a request still running when its session ends is never in the next session\'s log', async () => {
  const hang = {}
  const { w, ports } = await readyWorld({ hang })
  const slowApp = http.createServer((req, res) => { if (req.url === '/slow') setTimeout(() => res.end('late'), 300); else res.end('ok') })
  await new Promise(r => slowApp.listen(0, '127.0.0.1', r))
  try {
    // point the base pane at a slow app for this request
    const slowPort = slowApp.address().port
    const original = w.adapters.provisioner.reserveServices
    w.adapters.provisioner.reserveServices = async args => (args.paneRef.role === 'base' ? { app: { url: `http://127.0.0.1:${slowPort}`, port: slowPort } } : original(args))
    await api(ports.harness, 'POST', '/api/session', { pr: 7 })
    await waitFor(async () => (await api(ports.harness, 'GET', '/api/state')).status === 'ready')
    const pending = raw(ports.base, { path: '/slow' })
    await new Promise(r => setTimeout(r, 50))
    await api(ports.harness, 'POST', '/api/session', { pr: 7 }) // the same PR again: a new session
    await waitFor(async () => (await api(ports.harness, 'GET', '/api/state')).status === 'ready')
    await pending
    await new Promise(r => setTimeout(r, 30))
    const log = JSON.parse((await raw(ports.harness, { path: '/qa/api/actions' })).body)
    assert.deepEqual(log.requests.map(r => r.path), [])
  } finally {
    slowApp.close()
    w.c.stop()
  }
})

test('POST /api/actions/mark sits behind the JSON, same-origin and shutdown checks', async () => {
  const { w, ports } = await readyWorld()
  try {
    const path = '/qa/api/actions/mark'
    const body = '{"pane":"base","type":"click"}'
    assert.equal((await raw(ports.harness, { method: 'POST', path, headers: { 'content-type': 'text/plain' }, body })).status, 415)
    assert.equal((await raw(ports.harness, { method: 'POST', path, headers: { ...JSON_TYPE, 'sec-fetch-site': 'cross-site' }, body })).status, 403)
    const closing = w.c.shutdown()
    const late = await raw(ports.harness, { method: 'POST', path, headers: JSON_TYPE, body }).catch(() => ({ status: 'closed' }))
    assert.ok([503, 'closed'].includes(late.status), String(late.status))
    await closing
  } finally { w.c.stop() }
})

// A check that ignores its signal can finish after a takeover: its verdict
// is the cancelled session's, never the new one's.
test('a superseded check\'s late verdict is never recorded for the session that replaced it', async () => {
  const late = deferred()
  let checks = 0
  const w = makeWorld()
  w.adapters.provisioner.isolation = async () => {
    if (++checks === 1) { await late.promise; return { verdict: 'isolated', reasons: [] } }
    return { verdict: 'reachable', reasons: ['the PR pane reached the base pane\'s database at 172.19.0.2:5432'] }
  }
  try {
    const port = await harnessPort(w.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    await waitFor(() => checks === 1)
    await api(port, 'POST', '/api/session', { pr: 8, takeover: true })
    await waitFor(async () => (await api(port, 'GET', '/api/state')).status === 'ready')
    late.resolve()
    await new Promise(r => setTimeout(r, 50))
    const st = await api(port, 'GET', '/api/state')
    assert.deepEqual([st.pr, st.isolation.verdict], [8, 'reachable'])
  } finally { w.c.stop() }
})

// Strict mode is set in the env file alone, so it must be seen: at startup,
// in /api/state, and as an error when nothing could ever pass it here.
test('strict mode says so at startup and in /api/state, and logs an error when every session would be refused', async () => {
  const on = '[qa] QA_REQUIRE_ISOLATION on: a session whose PR pane isn\'t isolated from the base pane is refused'
  const loose = makeWorld()
  try {
    const port = await harnessPort(loose.c)
    assert.equal((await api(port, 'GET', '/api/state')).requireIsolation, false)
    assert.equal(loose.logLines.includes(on), false)
  } finally { loose.c.stop() }

  // a check to run, on Linux on 127.0.0.1: it may pass
  const check = async () => ({ verdict: 'isolated', reasons: [] })
  const strict = makeWorld({ cfg: { requireIsolation: true }, provisioner: { isolation: check } })
  try {
    const port = await harnessPort(strict.c)
    assert.equal((await api(port, 'GET', '/api/state')).requireIsolation, true)
    assert.ok(strict.logLines.includes(on), strict.logLines.join('\n'))
    assert.equal(strict.errorLines.some(l => l.includes('refuses every session')), false)
  } finally { strict.c.stop() }

  // a code-built cfg's truthy value is enforced, so it is reported as on
  const truthy = makeWorld({ cfg: { requireIsolation: 1 }, provisioner: { isolation: check } })
  try {
    assert.equal((await api(await harnessPort(truthy.c), 'GET', '/api/state')).requireIsolation, true)
  } finally { truthy.c.stop() }

  for (const [opts, isolation, reason] of [
    [{}, 'shared-host', 'shared-host: both panes run as one user on this host'],
    [{}, undefined, 'unknown: the Provisioner has no isolation check'],
    [{ platform: 'darwin' }, check, 'reachable: on macOS, containers run in a VM'],
  ]) {
    const w = makeWorld({ cfg: { requireIsolation: true }, ...opts, ...(isolation === undefined ? {} : { provisioner: { isolation } }) })
    try {
      await harnessPort(w.c)
      assert.ok(w.errorLines.some(l => l.startsWith(`[qa] QA_REQUIRE_ISOLATION=1 refuses every session here (${reason}`)), `${reason}\n${w.errorLines.join('\n')}`)
    } finally { w.c.stop() }
  }
})

// --- #32: the PR pane on an internal network -------------------------------------
// A Provisioner that puts the PR pane on an internal network says so
// (`internal: true`), and its check's result says whether it did. Only a
// result that says so lifts macOS's floor: the probe then speaks for the
// VM's forwarding too.
test('on macOS, an internal network lifts the VM floor only when the check\'s result says the PR pane is on one', async () => {
  for (const [result, want] of [
    [{ verdict: 'isolated', reasons: [], internal: true }, ['isolated', []]],
    [{ verdict: 'reachable', reasons: ['the PR pane got through the forwarder\'s proxy to 172.19.0.2:5432'], internal: true }, ['reachable', ['the PR pane got through the forwarder\'s proxy to 172.19.0.2:5432']]],
    // it fell back to an ordinary network: the floor holds
    [{ verdict: 'isolated', reasons: [] }, ['reachable', [/^on macOS, containers run in a VM/]]],
    [{ verdict: 'isolated', reasons: [], internal: 'yes' }, ['reachable', [/^on macOS, containers run in a VM/]]],
  ]) {
    const w = makeWorld({ platform: 'darwin', provisioner: { internal: true, isolation: async () => result } })
    try {
      const port = await harnessPort(w.c)
      await api(port, 'POST', '/api/session', { pr: 7 })
      const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
      assert.equal(st.isolation.verdict, want[0], JSON.stringify(result))
      assert.equal(st.isolation.reasons.length, want[1].length, st.isolation.reasons.join(' | '))
      want[1].forEach((reason, i) => (typeof reason === 'string' ? assert.equal(st.isolation.reasons[i], reason) : assert.match(st.isolation.reasons[i], reason)))
    } finally { w.c.stop() }
  }
  // a bind off loopback holds whatever the network
  const off = makeWorld({ platform: 'darwin', cfg: { host: '0.0.0.0', publicHost: 'h.ts.net' }, provisioner: { internal: true, isolation: async () => ({ verdict: 'isolated', reasons: [], internal: true }) } })
  try {
    const port = await harnessPort(off.c)
    await api(port, 'POST', '/api/session', { pr: 7 })
    const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return s.status === 'ready' && s })
    assert.deepEqual([st.isolation.verdict, st.isolation.reasons], ['reachable', ['the conductor listens on 0.0.0.0, which containers can reach']])
  } finally { off.c.stop() }
})

// Strict mode on macOS: with a Provisioner meant for an internal network,
// the check decides, so neither startup nor the boot's start refuses.
test('strict mode on macOS waits for the check of a Provisioner meant for an internal network, and refuses one that fell back', async () => {
  for (const [result, refused] of [[{ verdict: 'isolated', reasons: [], internal: true }, false], [{ verdict: 'isolated', reasons: [] }, true]]) {
    const w = makeWorld({ platform: 'darwin', cfg: { requireIsolation: true }, provisioner: { internal: true, isolation: async () => result } })
    try {
      const port = await harnessPort(w.c)
      assert.equal(w.errorLines.some(l => l.includes('refuses every session')), false, w.errorLines.join('\n'))
      await api(port, 'POST', '/api/session', { pr: 7 })
      const st = await waitFor(async () => { const s = await api(port, 'GET', '/api/state'); return (s.status === 'ready' || s.status === 'error') && s })
      assert.equal(st.status, refused ? 'error' : 'ready', JSON.stringify(result))
      if (refused) {
        assert.equal(st.error.step, 'cloning')
        assert.match(st.error.message, /^QA_REQUIRE_ISOLATION=1 refuses a session whose PR pane isn't isolated from the base pane \(reachable: on macOS, containers run in a VM/)
      }
    } finally { w.c.stop() }
  }
})
