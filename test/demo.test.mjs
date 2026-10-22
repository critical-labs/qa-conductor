// Demo mode end to end: a real startConductor over the demo's fixtures and
// fake adapters, on ephemeral loopback ports with speed 0 (no delays). The
// only network is the loopback servers the demo itself starts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter, once } from 'node:events'

import { startDemo } from '../demo/index.mjs'
import { runDemoCli, parseDemoEnv } from '../demo/server.mjs'
import { DEMO_PRS } from '../demo/fixtures.mjs'
import { createDemoGithub } from '../demo/fake-github.mjs'
import { createDemoBuild, makePause } from '../demo/fake-adapters.mjs'

function captureLog() {
  const lines = []
  const push = (...args) => lines.push(args.join(' '))
  return { lines, log: { log: push, info: push, warn: push, error: push } }
}

// The demo starts idle, so a browser enrols as the harness page does, on its
// first call: each harness port's token is kept, and taken again when a
// demo that reused the port refuses it.
const TOKENS = new Map()

async function enrol(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(res.status, 200, 'the demo starts with enrolment open')
  TOKENS.set(port, (await res.json()).token)
  return TOKENS.get(port)
}

const capHeader = async port => ({ 'x-qa-cap': TOKENS.get(port) ?? await enrol(port) })

async function api(port, method, path, body) {
  const post = method === 'POST'
  const call = async () => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(post ? { 'content-type': 'application/json' } : {}), ...await capHeader(port) },
    body: post ? JSON.stringify(body ?? {}) : undefined,
  })
  let res = await call()
  if (res.status === 403 && res.headers.get('x-qa-refusal') === 'capability') {
    TOKENS.delete(port)
    res = await call()
  }
  return { status: res.status, body: await res.json() }
}

// The pane cookie, as the harness gets it for its iframes: a pane-entry
// ticket, redeemed at the pane's /__qa/enter. Both panes take the one cookie.
async function paneCookie(demo) {
  const { status, body } = await api(demo.ports.harness, 'POST', '/api/pane-entry', { role: 'base', to: '/' })
  assert.equal(status, 200, JSON.stringify(body))
  const url = new URL(body.url)
  const res = await get(demo.ports.base, url.pathname + url.search)
  assert.equal(res.status, 303)
  return res.headers['set-cookie'][0].split(';')[0]
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

const state = async port => (await api(port, 'GET', '/api/state')).body

async function bootToReady(port, pr) {
  assert.equal((await api(port, 'POST', '/api/session', { pr })).status, 202)
  return waitFor(async () => { const s = await state(port); return s.status === 'ready' && s })
}

// Reads /api/progress (which replays the current boot's events) until `pred`
// matches an event.
async function progressEvent(port, pred, ms = 5000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/progress`, { headers: await capHeader(port), signal: ac.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error('progress stream ended')
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '))
        buf = buf.slice(i + 2)
        if (!line) continue
        const event = JSON.parse(line.slice('data: '.length))
        if (pred(event)) return event
      }
    }
  } finally {
    clearTimeout(timer)
    ac.abort()
  }
}

const serverHandles = () => process.getActiveResourcesInfo().filter(r => r === 'TCPServerWrap').length
const refused = url => fetch(url).then(() => false, () => true)
// Closed server handles are released a loop turn later; count from a quiet state.
async function settledServerHandles() {
  await new Promise(r => setTimeout(r, 20))
  return serverHandles()
}

// --- startDemo end to end -------------------------------------------------------

test('everything listens on 127.0.0.1: harness on `port`, pane proxies on ephemeral ports', async () => {
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    const { harness, base, pr } = demo.ports
    for (const p of [harness, base, pr]) assert.ok(Number.isInteger(p) && p > 0)
    assert.equal(new Set([harness, base, pr]).size, 3)
    assert.equal((await fetch(`http://127.0.0.1:${harness}/`)).status, 200)
    // loopback only: nothing answers on the IPv6 loopback (a wildcard bind would)
    for (const p of [harness, base, pr]) assert.ok(await refused(`http://[::1]:${p}/`), `port ${p} is not wildcard-bound`)
    // the pane origins were assigned once the proxies listened
    const s = await bootToReady(harness, 101)
    assert.equal(s.panes.baseOrigin, `http://127.0.0.1:${base}`)
    assert.equal(s.panes.prOrigin, `http://127.0.0.1:${pr}`)
  } finally { await demo.stop() }
})

test('/api/prs returns the fixtures with their statuses', async () => {
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    const { status, body } = await api(demo.ports.harness, 'GET', '/api/prs')
    assert.equal(status, 200)
    assert.deepEqual(body.prs.map(p => [p.number, p.imageStatus]), [
      [101, 'built'], [102, 'built'], [103, 'building'], [104, 'none'], [105, 'blocked'], [106, 'built'],
    ])
    assert.deepEqual(body.prs.map(p => [p.title, p.headRef, p.author]), DEMO_PRS.map(p => [p.title, p.headRef, p.author]))
    // cores that pass `reason` through (0.2.0) show why #105 can't boot
    const blocked = body.prs.find(p => p.number === 105)
    if ('reason' in blocked) assert.match(blocked.reason, /fork/)
    const bs = await api(demo.ports.harness, 'GET', '/api/build-status?pr=105')
    assert.equal(bs.body.status, 'blocked')
    assert.equal(bs.body.exists, false)
    assert.equal((await api(demo.ports.harness, 'GET', '/api/build-status?pr=101')).body.exists, true)
  } finally { await demo.stop() }
})

test('a good PR reaches ready, and both pane proxies serve distinguishable pages', async () => {
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    const s = await bootToReady(demo.ports.harness, 101)
    assert.equal(s.pr, 101)
    assert.equal(s.baseTag, 'main@demo123')
    assert.equal(s.prTag, '#101@abc1234')
    // the demo's panes are this process's own servers: one host, one user
    assert.equal(s.isolation.verdict, 'shared-host')
    assert.equal(s.panes.base, `http://127.0.0.1:${demo.ports.base}/`)
    assert.equal(s.panes.pr, `http://127.0.0.1:${demo.ports.pr}/`)

    const cookie = await paneCookie(demo)
    const page = async (role, path) => {
      const res = await fetch(`http://127.0.0.1:${demo.ports[role]}${path}`, { headers: { cookie } })
      assert.equal(res.status, 200, `${role} ${path}`)
      return res.text()
    }
    const [base, pr] = [await page('base', '/'), await page('pr', '/')]
    assert.match(base, /<h1[^>]*>.*Acme Widgets</s)
    assert.match(pr, /<h1[^>]*>.*Acme Widget Studio</s)
    assert.doesNotMatch(base, /Acme Widget Studio/)
    assert.match(base, /--accent: #1d4ed8/)
    assert.match(pr, /--accent: #9333ea/)
    assert.match(base, /main@demo123/)
    assert.match(pr, /#101@abc1234/)
    for (const html of [base, pr]) {
      assert.ok(html.includes(`<script src="/__qa/bridge.js" data-harness="http://127.0.0.1:${demo.ports.harness}"></script>`), 'served through the pane proxy')
      for (const href of ['/products', '/guide', '/contact', '/cart']) assert.ok(html.includes(`href="${href}"`), href)
    }

    // several pages, long scrolling content, and a PR-only control
    const guide = await page('base', '/guide')
    assert.ok((guide.match(/<p>/g) ?? []).length >= 30, 'the guide scrolls')
    const [baseProducts, prProducts] = [await page('base', '/products'), await page('pr', '/products')]
    assert.equal((baseProducts.match(/href="\/products\/[a-z-]+"/g) ?? []).length, 24)
    assert.doesNotMatch(baseProducts, /id="sort"/)
    assert.match(prProducts, /id="sort"/)
    assert.match(await page('pr', '/products/gizmo-pro'), /Add to cart/)

    // the contact form posts, redirects on the pane origin, and echoes safely
    const posted = await fetch(`http://127.0.0.1:${demo.ports.pr}/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ name: 'Ada <b>', email: 'ada@example.com', topic: 'order', message: 'Where is my gizmo?' }),
      redirect: 'manual',
    })
    assert.equal(posted.status, 303)
    const thanks = await page('pr', posted.headers.get('location'))
    assert.match(thanks, /Thanks, Ada &lt;b&gt;/)
    assert.match(thanks, /mail delivery is off/i)
  } finally { await demo.stop() }
})

// #8's data checks end to end: #106's "Empty cart" also deletes the saved
// carts, which the base's doesn't. The demo's panes share one host, so the
// comparison is advisory: every destructive change is red, and divergence
// shows which was the PR's alone.
test('#106: "Empty cart" deletes the saved carts too, which the data checks flag red as the PR\'s alone', async () => {
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    assert.deepEqual((await state(demo.ports.harness)).data, { available: true })
    await bootToReady(demo.ports.harness, 106)
    const cookie = await paneCookie(demo)
    const post = (role, path, form) => fetch(`http://127.0.0.1:${demo.ports[role]}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(form), redirect: 'manual',
    })
    for (const role of ['base', 'pr']) {
      const cart = await (await fetch(`http://127.0.0.1:${demo.ports[role]}/cart`, { headers: { cookie } })).text()
      assert.match(cart, /Saved for later/, `${role}: the seeded saved carts show`)
      assert.equal((await post(role, '/cart', { slug: 'gizmo-pro', qty: '2' })).status, 303)
      assert.equal((await post(role, '/cart/clear', {})).status, 303)
    }
    const { status, body } = await api(demo.ports.harness, 'POST', '/api/data/snapshot', {})
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.trust, 'advisory')
    assert.deepEqual(body.boot.flags, [], 'the boot changed nothing')
    const v = body.session.divergence.collections
    // the cart was filled and emptied in both: no net change
    assert.deepEqual([v.saved_carts.status, v.cart_items.status, v.messages.status], ['pr-only', 'same', 'same'])
    assert.deepEqual(body.session.flags.map(f => [f.collection, f.kind, f.severity, f.pr, f.base]), [['saved_carts', 'delete', 'red', 3, 0], ['saved_carts', 'emptied', 'red', 1, 0]])
    // the saved carts' owners are fingerprints
    const owner = body.session.pr.collections.saved_carts.deleted[0].row.owner
    assert.equal(owner.t, 'pii')
    assert.doesNotMatch(JSON.stringify(body), /@example\.com/)
  } finally { await demo.stop() }
})

// A GET with full control over the headers (fetch won't send a Referer).
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    }).on('error', reject)
  })
}

const iframeFrom = referer => ({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', referer })

test('pane responses let only the demo harness frame them', async () => {
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    const harness = `http://127.0.0.1:${demo.ports.harness}`
    assert.equal((await state(demo.ports.harness)).harnessOrigin, harness, 'derived from the bound port')
    const page = await get(demo.ports.harness, '/')
    assert.deepEqual([page.headers['content-security-policy'], page.headers['x-frame-options']], ["frame-ancestors 'self'", 'SAMEORIGIN'])
    await bootToReady(demo.ports.harness, 101)
    const cookie = await paneCookie(demo)
    for (const role of ['base', 'pr']) {
      const port = demo.ports[role]
      const other = demo.ports[role === 'base' ? 'pr' : 'base']
      const framed = await get(port, '/', { ...iframeFrom(`${harness}/`), cookie })
      assert.equal(framed.status, 200, role)
      assert.equal(framed.headers['content-security-policy'], `frame-ancestors 'self' ${harness}`)
      assert.equal(framed.headers['x-frame-options'], undefined)
      // the other pane, and the harness opened at localhost
      for (const referer of [`http://127.0.0.1:${other}/`, `http://localhost:${demo.ports.harness}/`]) {
        const res = await get(port, '/', iframeFrom(referer))
        assert.equal(res.status, 403, `${role} ${referer}`)
        assert.match(res.body, /cross-site framing refused/)
        assert.equal(res.headers['content-security-policy'], `frame-ancestors 'self' ${harness}`)
      }
    }
  } finally { await demo.stop() }
})

test('startDemo({ harnessOrigin, frameAncestors }) puts both in the pane policy', async () => {
  const { log } = captureLog()
  const harness = 'http://127.0.0.1:3102'
  const outer = 'http://127.0.0.1:3100'
  const demo = await startDemo({ port: 0, speed: 0, log, harnessOrigin: harness, frameAncestors: [outer] })
  try {
    assert.equal((await state(demo.ports.harness)).harnessOrigin, harness)
    const idle = await get(demo.ports.base, '/', { cookie: await paneCookie(demo) })
    assert.equal(idle.status, 503)
    assert.equal(idle.headers['content-security-policy'], `frame-ancestors 'self' ${harness} ${outer}`)
    await bootToReady(demo.ports.harness, 101)
    // a pane cookie lasts one session, so the harness enters the panes again
    const framed = await get(demo.ports.pr, '/', { ...iframeFrom(`${harness}/`), cookie: await paneCookie(demo) })
    assert.equal(framed.status, 200)
    assert.equal(framed.headers['content-security-policy'], `frame-ancestors 'self' ${harness} ${outer}`)
    assert.ok(framed.body.includes(`<script src="/__qa/bridge.js" data-harness="${harness}"></script>`))
    // the outer harness may frame the inner one's panes (CSP), but its
    // Referer admits nothing
    assert.equal((await get(demo.ports.pr, '/', iframeFrom(`${outer}/`))).status, 403)
  } finally { await demo.stop() }
})

// Nested in self-QA on a tailnet, an inner demo's harness origin is the outer
// pane's https origin, which would make the default mode tailscale. The demo
// binds loopback and sits behind the outer conductor's gate, whose pane proxy
// strips the Tailscale headers anyway.
test('a non-loopback harnessOrigin leaves the demo ungated', async () => {
  const { lines, log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log, harnessOrigin: 'https://box.ts.net:8443' })
  try {
    assert.ok(lines.includes('[qa] identity gate off (QA_EXPOSURE=none)'), lines.join('\n'))
    assert.equal((await get(demo.ports.harness, '/')).status, 200)
    assert.equal((await state(demo.ports.harness)).harnessOrigin, 'https://box.ts.net:8443')
    // Its panes are on loopback, another host than its harness's, so no
    // frame of that harness gets their cookie: the harness says why, and the
    // panes answer only a browser that has it.
    const entry = await api(demo.ports.harness, 'POST', '/api/pane-entry', { role: 'base', to: '/' })
    assert.equal(entry.status, 409)
    assert.match(entry.body.error, /^the harness origin https:\/\/box\.ts\.net:8443 and the base pane's origin http:\/\/127\.0\.0\.1:\d+ are on different hosts/)
    const pane = await get(demo.ports.base, '/')
    assert.deepEqual([pane.status, pane.headers['x-qa-refusal']], [403, 'capability'])
  } finally { await demo.stop() }
})

test('#104 fails at starting and reports the pane log tail', async () => {
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    assert.equal((await api(demo.ports.harness, 'POST', '/api/session', { pr: 104 })).status, 202)
    const error = await progressEvent(demo.ports.harness, e => e.kind === 'error')
    assert.equal(error.step, 'starting')
    assert.match(error.message, /exited with code 1/)
    assert.match(error.logTail, /TypeError: Cannot read properties of undefined/)
    assert.match(error.logTail, /#104@e42c7b1/)
    const s = await state(demo.ports.harness)
    assert.equal(s.status, 'error')
    assert.deepEqual(s.error.step, 'starting')
  } finally { await demo.stop() }
})

test('#105 is refused before any build: the trust reason reaches the boot error', async () => {
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    await api(demo.ports.harness, 'POST', '/api/session', { pr: 105 })
    const error = await progressEvent(demo.ports.harness, e => e.kind === 'error')
    assert.equal(error.step, 'ensuring-image')
    assert.match(error.message, /not from a trusted source: head branch is in @mallory's fork/)
  } finally { await demo.stop() }
})

test('a verdict POST (JSON content type) is recorded and logged', async () => {
  const { lines, log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    await bootToReady(demo.ports.harness, 101)
    const preview = await api(demo.ports.harness, 'GET', '/api/verdict/preview?verdict=reject')
    assert.deepEqual([preview.body.applies, preview.body.removes], ['qa-changes-requested', 'qa-approved'])
    const { status, body } = await api(demo.ports.harness, 'POST', '/api/verdict', { verdict: 'reject', notes: 'Heading wraps at 375px' })
    assert.equal(status, 200)
    assert.match(body.url, /^https:\/\/example\.invalid\/.*101/)
    const out = lines.join('\n')
    assert.match(out, /comment on #101[\s\S]*Heading wraps at 375px/)
    assert.match(out, /#101 labelled qa-changes-requested/)
  } finally { await demo.stop() }
})

test('stop() closes the servers, SSE streams and pane apps, so the process can exit', async () => {
  const baseline = await settledServerHandles()
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 0, log })
  try {
    await bootToReady(demo.ports.harness, 101)
    assert.equal(await settledServerHandles(), baseline + 5, 'harness, two proxies, two pane apps')
    const sse = await fetch(`http://127.0.0.1:${demo.ports.harness}/api/progress`, { headers: await capHeader(demo.ports.harness) })
    const reader = sse.body.getReader()
    await reader.read()

    await demo.stop()
    await demo.stop() // idempotent
    await assert.doesNotReject(Promise.race([
      reader.read().catch(() => ({ done: true })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SSE stream left open')), 2000)),
    ]))
    for (const p of Object.values(demo.ports)) assert.ok(await refused(`http://127.0.0.1:${p}/`), `port ${p} closed`)
    await waitFor(() => serverHandles() === baseline, 2000)
  } finally { await demo.stop() }
})

test('stop() during a slow build aborts it and leaves nothing listening', async () => {
  const baseline = await settledServerHandles()
  const { log } = captureLog()
  const demo = await startDemo({ port: 0, speed: 1, log })
  try {
    await api(demo.ports.harness, 'POST', '/api/session', { pr: 104 })
    await waitFor(async () => (await state(demo.ports.harness)).status === 'ensuring-image')
    const t0 = Date.now()
    await demo.stop()
    assert.ok(Date.now() - t0 < 1000, 'the fake build does not hold stop() up')
    await waitFor(() => serverHandles() === baseline, 2000)
  } finally { await demo.stop() }
})

test('startDemo rejects a bad port or speed', async () => {
  await assert.rejects(() => startDemo({ port: -1 }), /port/)
  await assert.rejects(() => startDemo({ port: 0, speed: -1 }), /speed/)
})

test('a harness port already in use rejects and leaves nothing listening', async () => {
  const blocker = http.createServer()
  blocker.listen(0, '127.0.0.1')
  await once(blocker, 'listening')
  const baseline = await settledServerHandles()
  try {
    await assert.rejects(() => startDemo({ port: blocker.address().port, speed: 0, log: captureLog().log }), /EADDRINUSE/)
    await waitFor(() => serverHandles() === baseline, 2000)
  } finally { blocker.close() }
})

// --- the fakes ------------------------------------------------------------------

test('demo github: PR fields, trust data, and in-memory comments and labels', async () => {
  const { lines, log } = captureLog()
  const gh = createDemoGithub({ log })
  const prs = await gh.listOpenPrs()
  assert.equal(prs.length, 6)
  for (const pr of prs) {
    assert.match(pr.headSha, /^[0-9a-f]{40}$/)
    for (const key of ['number', 'title', 'headRef', 'author', 'authorAssociation', 'headRepo', 'headOwner']) assert.ok(key in pr, key)
  }
  assert.equal(await gh.prHead(101), prs[0].headSha)
  assert.deepEqual(await gh.prInfo(105), {
    number: 105, headSha: prs[4].headSha, author: 'grace', authorAssociation: 'COLLABORATOR',
    isDraft: false, headRepo: 'mallory/widgets', headOwner: 'mallory',
  })
  assert.equal((await gh.prInfo(101)).headRepo, 'demo/widgets')
  await assert.rejects(() => gh.prInfo(999), /404/)
  assert.equal(await gh.authorPermission('ada'), 'write')

  const url = await gh.postComment(101, 'body text')
  assert.match(url, /example\.invalid/)
  assert.deepEqual(gh.comments, [{ pr: 101, body: 'body text', url }])
  await gh.setQaLabel(101, 'qa-approved')
  await gh.setQaLabel(101, 'qa-changes-requested')
  assert.deepEqual([...gh.labels.get(101)], ['qa-changes-requested'], 'the verdict labels are exclusive')
  await assert.rejects(() => gh.setQaLabel(101, 'bogus'), /unknown QA label/)
  assert.ok(lines.some(l => l.includes('comment on #101')))
})

test('demo build: progress messages, labels, readiness, the trust block and abort', async () => {
  const build = createDemoBuild({ pause: makePause({ speed: 0 }) })
  const messages = []
  build.subscribeBuild(p => messages.push(p.message))

  const statuses = async () => (await build.describePrs(DEMO_PRS)).map(d => [d.number, d.status])
  assert.deepEqual(await statuses(), [[101, 'built'], [102, 'built'], [103, 'building'], [104, 'none'], [105, 'blocked'], [106, 'built']])
  const blocked = (await build.describePrs([{ number: 105 }]))[0]
  assert.deepEqual(blocked, { number: 105, status: 'blocked', reason: "head branch is in @mallory's fork (mallory/widgets), not the author's", runUrl: null })

  await build.ensureBuilt(104)
  assert.ok(messages.some(m => m.startsWith('fetching demo/widgets')))
  assert.ok(messages.some(m => m.startsWith('installing dependencies for #104 (e42c7b1)')))
  assert.equal(messages.at(-1), '#104 (e42c7b1) built')
  assert.equal((await build.describePrs([{ number: 104 }]))[0].status, 'built')

  messages.length = 0
  await build.ensureBuilt(101)
  assert.ok(messages.includes('#101 (abc1234) already built'))

  await assert.rejects(() => build.ensureBuilt(105), /PR #105 by @grace is not from a trusted source: head branch is in @mallory's fork/)
  await assert.rejects(() => build.ensureBuilt(999), /not one of the demo fixtures/)

  assert.deepEqual(await build.resolveBaseImages(), { services: { app: 'main@demo123' }, migrate: null, label: 'main@demo123' })
  assert.deepEqual(await build.resolvePrImages(101), { services: { app: '#101@abc1234' }, migrate: null, label: '#101@abc1234' })

  // a callback that throws never breaks the build
  build.subscribeBuild(() => { throw new Error('listener bug') })
  await build.ensureBuilt(102)

  // an aborted build throws AbortError and is not left marked as building
  const slow = createDemoBuild({ pause: makePause({ speed: 1 }) })
  const ac = new AbortController()
  const pending = slow.ensureBuilt(104, { signal: ac.signal })
  ac.abort()
  await assert.rejects(pending, err => err.name === 'AbortError')
  assert.equal((await slow.describePrs([{ number: 104 }]))[0].status, 'none')
})

// --- the CLI --------------------------------------------------------------------

test('parseDemoEnv: PORT, QA_DEMO_SPEED, QA_HARNESS_ORIGIN and QA_FRAME_ANCESTORS with defaults and validation', () => {
  const none = { harnessOrigin: null, frameAncestors: [] }
  assert.deepEqual(parseDemoEnv({}), { port: 4100, speed: 1, ...none })
  assert.deepEqual(parseDemoEnv({ PORT: '0', QA_DEMO_SPEED: '0' }), { port: 0, speed: 0, ...none })
  assert.deepEqual(parseDemoEnv({ PORT: '5123', QA_DEMO_SPEED: '2.5', QA_HARNESS_ORIGIN: '', QA_FRAME_ANCESTORS: '' }), { port: 5123, speed: 2.5, ...none })
  assert.throws(() => parseDemoEnv({ PORT: 'http' }), /PORT/)
  assert.throws(() => parseDemoEnv({ PORT: '70000' }), /PORT/)
  assert.throws(() => parseDemoEnv({ QA_DEMO_SPEED: '-1' }), /QA_DEMO_SPEED/)
  // self-QA's inner demos: the outer pane's origin, and the outer harness
  assert.deepEqual(parseDemoEnv({ QA_HARNESS_ORIGIN: 'http://127.0.0.1:3102/', QA_FRAME_ANCESTORS: ' http://127.0.0.1:3100 ,, https://Outer.ts.net:8444/qa/' }), {
    port: 4100, speed: 1, harnessOrigin: 'http://127.0.0.1:3102', frameAncestors: ['http://127.0.0.1:3100', 'https://outer.ts.net:8444'],
  })
  for (const bad of ['127.0.0.1:3102', 'file:///x', '*']) {
    assert.throws(() => parseDemoEnv({ QA_HARNESS_ORIGIN: bad }), /QA_HARNESS_ORIGIN must be an origin/, bad)
    assert.throws(() => parseDemoEnv({ QA_FRAME_ANCESTORS: `http://127.0.0.1:3100,${bad}` }), /QA_FRAME_ANCESTORS must be an origin/, bad)
  }
})

function fakeProcess() {
  const proc = new EventEmitter()
  proc.exits = []
  proc.exit = code => { proc.exits.push(code) }
  return proc
}

test('runDemoCli starts the demo from the env and stops it on SIGINT, SIGTERM or SIGHUP', async () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const proc = fakeProcess()
    const started = []
    let stops = 0
    const start = async opts => { started.push(opts); return { ports: { harness: 4321, base: 1, pr: 2 }, stop: async () => { stops++ } } }
    const { lines, log } = captureLog()
    await runDemoCli({ env: { PORT: '4321', QA_DEMO_SPEED: '0' }, proc, start, log })
    assert.deepEqual(started.map(o => [o.port, o.speed, o.harnessOrigin, o.frameAncestors, o.log]), [[4321, 0, null, [], log]])
    assert.ok(lines.some(l => l.includes('http://127.0.0.1:4321/')), 'prints the harness URL')
    proc.emit(signal, signal)
    await waitFor(() => proc.exits.length > 0)
    assert.equal(stops, 1, signal)
    assert.deepEqual(proc.exits, [0])
  }
})

test('runDemoCli passes the harness origin and frame ancestors on, and prints that origin', async () => {
  const started = []
  const start = async opts => { started.push(opts); return { ports: { harness: 4321, base: 1, pr: 2 }, stop: async () => {} } }
  const { lines, log } = captureLog()
  await runDemoCli({ env: { QA_HARNESS_ORIGIN: 'http://127.0.0.1:3102', QA_FRAME_ANCESTORS: 'http://127.0.0.1:3100' }, proc: fakeProcess(), start, log })
  assert.deepEqual(started.map(o => [o.harnessOrigin, o.frameAncestors]), [['http://127.0.0.1:3102', ['http://127.0.0.1:3100']]])
  assert.ok(lines.some(l => l.includes('open http://127.0.0.1:3102/')), lines.join('\n'))
})

test('runDemoCli: a second signal while stopping exits at once', async () => {
  const proc = fakeProcess()
  const start = async () => ({ ports: { harness: 1, base: 2, pr: 3 }, stop: () => new Promise(() => {}) })
  await runDemoCli({ env: {}, proc, start, log: captureLog().log })
  proc.emit('SIGTERM', 'SIGTERM')
  proc.emit('SIGINT', 'SIGINT')
  assert.deepEqual(proc.exits, [1])
})
