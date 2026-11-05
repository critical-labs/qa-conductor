// Pure helpers of the harness UI script. harness.js is a plain browser script
// with the same CommonJS export guard bridge.js uses; the package declares
// "type": "module", so evaluate it through the CJS wrapper shape instead of
// require(). `window` stays undefined, which keeps the UI IIFE inert.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const harnessPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'harness.js')
const cjsModule = { exports: {} }
new Function('module', 'exports', readFileSync(harnessPath, 'utf8'))(cjsModule, cjsModule.exports)
const { esc, isHttpsUrl, LABELS, harnessOriginNotice, buildSummary, buildFromEvent, inviteFromHash, isCapabilityRefusal, isolationLabel, hasVerdictLabel, reviewQueue } = cjsModule.exports
// safeHref, mdParse, mdRender and renderPrContext: test/pr-context.test.mjs
const harnessSrc = readFileSync(harnessPath, 'utf8')

test('the CJS guard exports the pure helpers only', () => {
  assert.deepEqual(Object.keys(cjsModule.exports).sort(), ['LABELS', 'buildFromEvent', 'buildSummary', 'esc', 'harnessOriginNotice', 'hasVerdictLabel', 'inviteFromHash', 'isCapabilityRefusal', 'isHttpsUrl', 'isolationLabel', 'mdParse', 'mdRender', 'renderPrContext', 'reviewQueue', 'safeHref'])
})

test('hasVerdictLabel: either verdict label, whatever its case; nothing else', () => {
  const v = { accept: 'qa-approved', reject: 'qa-changes-requested' }
  assert.equal(hasVerdictLabel({ labels: ['bug', 'QA-Approved'] }, v), true)
  assert.equal(hasVerdictLabel({ labels: ['qa-changes-requested'] }, v), true)
  for (const pr of [{ labels: ['bug'] }, { labels: [] }, {}, null, { labels: 'qa-approved' }]) assert.equal(hasVerdictLabel(pr, v), false, JSON.stringify(pr))
  assert.equal(hasVerdictLabel({ labels: ['qa-approved'] }, undefined), false)
})

const VERDICTS = { accept: 'qa-approved', reject: 'qa-changes-requested' }

test('reviewQueue: no verdict label (whatever its case), blocked out and counted, built first then oldest, undated after dated, skipped last in skip order, done excluded', () => {
  const prs = [
    { number: 1, imageStatus: 'built', createdAt: '2026-10-03T00:00:00Z', labels: ['bug'] },
    { number: 2, imageStatus: 'none', createdAt: '2026-10-01T00:00:00Z', labels: [] },
    { number: 3, imageStatus: 'building', createdAt: '2026-10-02T00:00:00Z', labels: [] },
    { number: 4, imageStatus: 'built', createdAt: '2026-10-01T00:00:00Z', labels: ['QA-Approved'] },
    { number: 5, imageStatus: 'blocked', createdAt: '2026-10-01T00:00:00Z', labels: [] },
    { number: 6, imageStatus: 'built', createdAt: '2026-10-02T00:00:00Z', labels: [] },
    { number: 7, imageStatus: 'built', labels: [] },
  ]
  const { queue, blocked } = reviewQueue(prs, { verdictLabels: VERDICTS, skipped: [6], done: [2] })
  assert.deepEqual(queue.map(p => p.number), [1, 7, 3, 6])
  assert.equal(blocked, 1)
  // nothing skipped or done: the whole order
  assert.deepEqual(reviewQueue(prs, { verdictLabels: VERDICTS }).queue.map(p => p.number), [6, 1, 7, 3, 2])
  // the other verdict label keeps a PR out too, and a list without labels is all waiting
  assert.deepEqual(reviewQueue([{ number: 9, labels: ['qa-changes-requested'] }, { number: 8 }], { verdictLabels: VERDICTS }).queue.map(p => p.number), [8])
  // several skipped come back in the order they were skipped
  assert.deepEqual(reviewQueue(prs, { verdictLabels: VERDICTS, skipped: [3, 1] }).queue.map(p => p.number), [6, 7, 2, 3, 1])
})

test('reviewQueue: nothing to walk gives an empty queue, and bad input is just empty', () => {
  assert.deepEqual(reviewQueue([], { verdictLabels: VERDICTS }), { queue: [], blocked: 0, notForReview: 0 })
  assert.deepEqual(reviewQueue(null, { verdictLabels: VERDICTS }), { queue: [], blocked: 0, notForReview: 0 })
  assert.deepEqual(reviewQueue([{ number: 'x' }, null, { number: 5, imageStatus: 'blocked' }], {}), { queue: [], blocked: 1, notForReview: 0 })
})

// The BuildConvention's eligible(pr) marks a PR review: false: it is left out
// and counted apart from those that can't boot. A verdict or a done PR isn't
// counted at all, and review: true or no field at all is queued as before.
test('reviewQueue: a PR marked review false is left out and counted as not for review, apart from blocked', () => {
  const prs = [
    { number: 1, imageStatus: 'built', labels: [], review: true },
    { number: 2, imageStatus: 'none', labels: [], review: false, skipReason: 'docs only' },
    { number: 3, imageStatus: 'blocked', labels: [], review: false, skipReason: 'draft' },
    { number: 4, imageStatus: 'blocked', labels: [] },
    { number: 5, imageStatus: 'none', labels: ['qa-approved'], review: false },
    { number: 6, imageStatus: 'none', labels: [], review: false },
    { number: 7, imageStatus: 'none', labels: [] },
  ]
  assert.deepEqual(reviewQueue(prs, { verdictLabels: VERDICTS, done: [6] }), { queue: [prs[0], prs[6]], blocked: 1, notForReview: 2 })
})

test('isolationLabel: nothing before a verdict, else what it says, its reasons as the title', () => {
  assert.equal(isolationLabel(null), null)
  assert.equal(isolationLabel(undefined), null)
  assert.deepEqual(isolationLabel({ verdict: 'isolated', reasons: [] }), { text: 'isolated', warn: false, title: 'The PR pane can\'t reach the base pane, so the base pane shows what the base did' })
  assert.deepEqual(isolationLabel({ verdict: 'reachable', reasons: ['a', 'b'] }), { text: 'not isolated', warn: true, title: 'a; b' })
  assert.deepEqual(isolationLabel({ verdict: 'unknown', reasons: ['c'] }), { text: 'isolation unknown', warn: true, title: 'c' })
  assert.deepEqual(isolationLabel({ verdict: 'shared-host', reasons: ['d'] }), { text: 'shared host', warn: true, title: 'd' })
  assert.deepEqual(isolationLabel({ verdict: 'bogus', reasons: [] }), { text: 'isolation unknown', warn: true, title: '' })
  // strict mode, said beside the verdict
  const STRICT = 'QA_REQUIRE_ISOLATION=1 refuses a session that isn\'t isolated'
  assert.deepEqual(isolationLabel({ verdict: 'reachable', reasons: ['a'] }, true), { text: 'not isolated · strict', warn: true, title: `a — ${STRICT}` })
  assert.deepEqual(isolationLabel({ verdict: 'bogus', reasons: [] }, true), { text: 'isolation unknown · strict', warn: true, title: STRICT })
  assert.equal(isolationLabel({ verdict: 'isolated', reasons: [] }, true).text, 'isolated · strict')
  assert.equal(isolationLabel(null, true), null)
  // a verdict named like an Object member is just unknown
  for (const verdict of ['constructor', 'toString', '__proto__']) {
    assert.deepEqual(isolationLabel({ verdict, reasons: [] }), { text: 'isolation unknown', warn: true, title: '' }, verdict)
  }
})

test('isCapabilityRefusal: a 403 marked by its header or, the header dropped, by its body', () => {
  assert.equal(isCapabilityRefusal(403, 'capability', {}), true)
  assert.equal(isCapabilityRefusal(403, null, { refusal: 'capability' }), true)
  for (const [status, header, body] of [[403, null, {}], [403, 'identity', {}], [403, null, { refusal: 'identity' }], [401, 'capability', { refusal: 'capability' }], [403, null, null], [403, null, 'capability']]) {
    assert.equal(isCapabilityRefusal(status, header, body), false, JSON.stringify([status, header, body]))
  }
})

test('inviteFromHash reads an invite link\'s ticket from the fragment, and nothing else', () => {
  assert.equal(inviteFromHash('#enrol=abc_DEF-123'), 'abc_DEF-123')
  for (const hash of [undefined, '', '#', '#/', '#/pr/7', '#enrol=', '#enrol=a b', '#enrol=abc&x=1', '#x=1&enrol=abc', '#ENROL=abc', '#enrol=<x>']) {
    assert.equal(inviteFromHash(hash), null, String(hash))
  }
})

// The panes answer only a browser holding their cookie, which a one-time
// ticket sets: a frame loaded at a pane URL directly would get a 403.
test('the harness loads a pane frame only through a pane-entry ticket, and sends its token on every API call and the event stream', () => {
  const assignments = [...harnessSrc.matchAll(/Frame'\)\.src = ([^\n;]+)|frameOf\([^)]*\)\.src = ([^\n;]+)/g)].map(m => (m[1] ?? m[2]).trim())
  assert.deepEqual(assignments, ['url'], 'one assignment, in enterPane')
  assert.match(harnessSrc, /'x-qa-cap': token/)
  assert.match(harnessSrc, /new EventSource\(`\/qa\/api\/progress\?cap=\$\{encodeURIComponent\(/)
})

test('buildFromEvent reads an SSE build event as buildRun\'s shape, conclusion included', () => {
  const url = 'https://github.com/acme/widget/actions/runs/7'
  const ev = { at: 1, kind: 'build', runUrl: url, runStatus: 'completed', runConclusion: 'failure', message: null }
  assert.deepEqual(buildFromEvent(ev), { url, status: 'completed', conclusion: 'failure', message: null })
  assert.equal(buildSummary(buildFromEvent(ev)), 'Build ended: failure')
})

test('buildSummary: the message, else the run\'s status, naming a conclusion other than success', () => {
  const url = 'https://github.com/acme/widget/actions/runs/7'
  assert.equal(buildSummary({ message: 'installing dependencies for #7 (abc1234)…', status: 'in_progress' }), 'installing dependencies for #7 (abc1234)…')
  assert.equal(buildSummary({}), 'Build started')
  assert.equal(buildSummary({ url, status: 'queued' }), 'Build queued')
  assert.equal(buildSummary({ url }), 'Build in progress')
  assert.equal(buildSummary({ url, status: 'completed' }), 'Build complete')
  assert.equal(buildSummary({ url, status: 'completed', conclusion: 'success' }), 'Build complete')
  assert.equal(buildSummary({ url, status: 'completed', conclusion: 'failure' }), 'Build ended: failure')
  assert.equal(buildSummary({ url, status: 'completed', conclusion: 'timed_out' }), 'Build ended: timed out')
  // a conclusion before completion (not GitHub's way) says nothing new
  assert.equal(buildSummary({ url, status: 'in_progress', conclusion: 'failure' }), 'Build in_progress')
})

test('harnessOriginNotice: null at the configured origin or with none configured, else the configured origin + /qa/', () => {
  assert.equal(harnessOriginNotice('http://127.0.0.1:4100', 'http://127.0.0.1:4100'), null)
  for (const unset of [null, undefined, '']) assert.equal(harnessOriginNotice(unset, 'http://localhost:4100'), null, String(unset))
  assert.equal(harnessOriginNotice('http://127.0.0.1:4100', 'http://localhost:4100'), 'http://127.0.0.1:4100/qa/')
  assert.equal(harnessOriginNotice('https://h.ts.net:8444', 'https://h.ts.net:8446'), 'https://h.ts.net:8444/qa/')
})

// "Open in new tab" must send the harness origin as the Referer the panes
// check: rel="noopener" keeps it, and noreferrer would get every new tab a
// 403 cross-site navigation refused.
// An embedding page (QA_HARNESS_FRAME_ANCESTORS) gets a hook to style for.
test('the page marks its body framed when it is not the top window, and never throws on a cross-origin top', () => {
  assert.match(harnessSrc, /let framed = false\n\s*try \{ framed = window\.self !== window\.top \} catch \{ framed = true \}\n\s*document\.body\.classList\.toggle\('framed', framed\)/)
})

test('the "Open in new tab" links keep the Referer: rel="noopener", never noreferrer', () => {
  const html = readFileSync(join(dirname(harnessPath), 'index.html'), 'utf8')
  for (const id of ['baseOpen', 'prOpen']) {
    const tag = html.match(new RegExp(`<a\\b[^>]*\\bid="${id}"[^>]*>`))?.[0]
    assert.ok(tag, id)
    assert.match(tag, /\brel="noopener"/, id)
    assert.doesNotMatch(tag, /noreferrer/i, id)
  }
})

test('esc escapes markup and both quote characters', () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  assert.equal(esc(null), '')
})

test('isHttpsUrl accepts only https links (case-insensitive scheme)', () => {
  assert.equal(isHttpsUrl('https://github.com/acme/widget/actions/runs/1'), true)
  assert.equal(isHttpsUrl('HTTPS://github.com/x'), true)
  for (const bad of ['javascript:alert(1)', 'http://x', ' https://x', 'data:text/html,x', '', null, undefined, 42]) {
    assert.equal(isHttpsUrl(bad), false, String(bad))
  }
})

test('LABELS names every boot step generically', () => {
  assert.deepEqual(LABELS, {
    'ensuring-image': 'Building',
    cloning: 'Preparing data',
    migrating: 'Migrating',
    starting: 'Starting',
  })
})


// --- #29: the harness page against a stand-in browser ----------------------------
// harness.js run against a stand-in browser: every element is a recording
// stub, fetch answers from `routes` (an answer, or a function of the request's
// body and headers; `ticks` holds an answer back that many turns), and the
// test reads what the page did: its API calls, EventSource URLs, frame srcs,
// history edits and stored token.

function fakeBrowser({ hash = '#/', stored = null, routes = {}, elements = {}, clock = null, session = new Map(), sessionThrows = false }) {
  const log = [] // ['fetch', method, path, headers, body] | ['replace', url] | ['source', url] | ['set', id, prop, value]
  const listeners = []
  const intervals = [] // { fn, ms }, in the order set; none ever runs by itself
  const store = new Map(stored === null ? [] : [['qa-cap', stored]])
  const sources = [] // every EventSource the page opened, to feed events to
  const sessionStorage = sessionThrows
    ? { getItem() { throw new Error('storage off') }, setItem() { throw new Error('storage off') }, removeItem() { throw new Error('storage off') } }
    : { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, String(v)), removeItem: k => session.delete(k) }
  const els = new Map(Object.entries(elements))
  const stub = name => {
    const props = {}
    return new Proxy(function () {}, {
      get(_, k) {
        if (Object.hasOwn(props, k)) return props[k]
        if (k === 'then') return undefined
        if (k === Symbol.iterator) return function* () {}
        if (k === Symbol.toPrimitive) return () => ''
        if (k === 'length') return 0
        if (k === 'matches') return false
        if (k === 'dataset' || k === 'style') return (props[k] = {})
        if (k === 'addEventListener') return (type, fn) => listeners.push([name, type, fn])
        // one element per selector, as a DOM that doesn't change gives
        if (k === 'querySelector') {
          const found = new Map()
          return (props[k] = sel => { if (!found.has(sel)) found.set(sel, stub(`${name} ${sel}`)); return found.get(sel) })
        }
        return (props[k] = stub(`${name}.${String(k)}`))
      },
      set(_, k, v) { props[k] = v; log.push(['set', name, k, v]); return true },
      apply() { return stub(`${name}()`) },
    })
  }
  const byId = id => { if (!els.has(id)) els.set(id, stub(id)); return els.get(id) }
  const location = { hash, pathname: '/qa/', search: '', origin: 'https://h.ts.net:8444' }
  const globals = {
    window: { addEventListener: (type, fn) => listeners.push(['window', type, fn]), matchMedia: () => stub('mq') },
    document: {
      getElementById: byId, querySelector: sel => stub(sel), querySelectorAll: () => [], createElement: t => stub(`<${t}>`),
      createTextNode: () => stub('#text'), addEventListener: (type, fn) => listeners.push(['document', type, fn]), body: stub('body'),
    },
    fetch: async (url, opts = {}) => {
      const method = opts.method ?? 'GET'
      const path = String(url).split('?')[0]
      log.push(['fetch', method, path, { ...(opts.headers ?? {}) }, opts.body ? JSON.parse(opts.body) : null, String(url)])
      const answer = routes[`${method} ${path}`]
      const out = typeof answer === 'function' ? answer(opts.body ? JSON.parse(opts.body) : null, opts.headers ?? {}) : (answer ?? { status: 404 })
      const { status = 200, body = {}, headers = {}, ticks = 0 } = out
      for (let i = 0; i < ticks; i++) await new Promise(r => setImmediate(r))
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
    },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    sessionStorage,
    EventSource: class { static CLOSED = 2; constructor(url) { log.push(['source', url]); this.readyState = 0; sources.push(this) } close() {} },
    history: { replaceState: (_s, _t, url) => { log.push(['replace', url]); location.hash = `#${String(url).split('#')[1] ?? ''}` } },
    location,
    navigator: {},
    ...(clock ? { performance: { now: () => clock.perf() }, Date: class extends Date { static now() { return clock.wall() } } } : {}),
    setTimeout: () => 0,
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    clearInterval: () => {},
  }
  const names = Object.keys(globals)
  new Function(...names, 'module', harnessSrc)(...names.map(n => globals[n]), undefined)
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }
  return { log, listeners, store, session, sources, byId, location, settle, intervals }
}

const CAPTURE = { status: 403, body: { error: 'this browser is not enrolled' }, headers: { 'x-qa-refusal': 'capability' } }
const PANES = { base: 'https://h.ts.net:8443/login-base', pr: 'https://h.ts.net:10000/login-pr', baseOrigin: 'https://h.ts.net:8443', prOrigin: 'https://h.ts.net:10000' }
const entryRoute = body => ({ body: { url: `${body.role === 'base' ? PANES.baseOrigin : PANES.prOrigin}/__qa/enter?t=ticket-${body.role}-${body.to.length}` } })

test('the harness sends its token on every API call, and loads each pane only through a pane-entry ticket that carries no token', async () => {
  const b = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, panes: PANES, harnessOrigin: 'https://h.ts.net:8444' } },
      'POST /qa/api/pane-entry': entryRoute,
    },
  })
  await b.settle()
  const fetches = b.log.filter(e => e[0] === 'fetch')
  assert.ok(fetches.length >= 3, JSON.stringify(fetches))
  for (const [, method, path, headers] of fetches) assert.equal(headers['x-qa-cap'], 'tok-1', `${method} ${path}`)
  const entries = () => b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/pane-entry').map(e => e[4])
  assert.deepEqual(entries(), [{ role: 'base', to: PANES.base }, { role: 'pr', to: PANES.pr }])
  const srcs = () => b.log.filter(e => e[0] === 'set' && /Frame$/.test(e[1]) && e[2] === 'src').map(e => [e[1], e[3]])
  assert.deepEqual(srcs(), [['baseFrame', `${PANES.baseOrigin}/__qa/enter?t=ticket-base-${PANES.base.length}`], ['prFrame', `${PANES.prOrigin}/__qa/enter?t=ticket-pr-${PANES.pr.length}`]])

  // reload and re-sync go through a new ticket too
  const [, , onPaneRow] = b.listeners.find(([name, type]) => name === '#paneRow' && type === 'click')
  onPaneRow({ target: { closest: () => ({ dataset: { act: 'reload', pane: 'base' } }) } })
  b.byId('resyncBtn').onclick()
  b.byId('resyncLeft').onclick()
  await b.settle()
  assert.deepEqual(entries().slice(2).map(e => e.role), ['base', 'pr', 'base'])
  assert.equal(srcs().length, 5)
  for (const [frame, src] of srcs()) assert.match(src, /^https:\/\/h\.ts\.net:(8443|10000)\/__qa\/enter\?t=ticket-/, frame)
  for (const e of entries()) assert.doesNotMatch(JSON.stringify(e), /tok-1/, 'no token in a pane URL')
})

test('the event stream carries the token as ?cap=', async () => {
  const b = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok/2',
    routes: { 'GET /qa/api/state': { body: { status: 'starting', pr: 7 } } },
  })
  await b.settle()
  assert.deepEqual(b.log.filter(e => e[0] === 'source').map(e => e[1]), ['/qa/api/progress?cap=tok%2F2'])
})

test('an invite link leaves the URL before its ticket is used, and a refused one keeps the token this browser has', async () => {
  const ticket = 'T'.repeat(43)
  const fresh = fakeBrowser({
    hash: `#enrol=${ticket}`,
    routes: {
      'POST /qa/api/enrol': body => (body.invite === ticket ? { body: { token: 'tok-new' } } : CAPTURE),
      'GET /qa/api/state': { body: { status: 'idle' } },
      'GET /qa/api/prs': { body: { prs: [], session: null } },
    },
  })
  await fresh.settle()
  const firstReplace = fresh.log.findIndex(e => e[0] === 'replace')
  const enrolCall = fresh.log.findIndex(e => e[0] === 'fetch' && e[2] === '/qa/api/enrol')
  assert.ok(firstReplace !== -1 && firstReplace < enrolCall, 'replaceState before the enrol call')
  assert.doesNotMatch(fresh.log[firstReplace][1], new RegExp(ticket))
  assert.doesNotMatch(fresh.location.hash, new RegExp(ticket))
  assert.deepEqual(fresh.log[enrolCall][4], { invite: ticket })
  assert.equal(fresh.store.get('qa-cap'), 'tok-new')

  // an invite already spent, opened in a browser that is enrolled
  const spent = fakeBrowser({
    hash: `#enrol=${ticket}`,
    stored: 'tok-old',
    routes: { 'POST /qa/api/enrol': CAPTURE },
  })
  await spent.settle()
  assert.equal(spent.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/enrol').length, 1)
  assert.equal(spent.store.get('qa-cap'), 'tok-old')
})


// What reaches a harness nested in a pane (self-QA): the outer pane proxy
// drops X-QA-Refusal, so the refusal says so in its body too.
test('a refusal marked only in its body still makes the harness enrol again', async () => {
  const b = fakeBrowser({
    stored: 'tok-old',
    routes: {
      'GET /qa/api/state': (_, headers) => (headers['x-qa-cap'] === 'tok-new' ? { body: { status: 'idle' } } : { status: 403, body: { error: 'this browser is not enrolled', refusal: 'capability' } }),
      'POST /qa/api/enrol': { body: { token: 'tok-new' } },
      'GET /qa/api/prs': { body: { prs: [], session: null } },
    },
  })
  await b.settle()
  assert.equal(b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/enrol').length, 1)
  assert.equal(b.store.get('qa-cap'), 'tok-new')
})

// A restart revoked the token while the session view made three calls with
// it: the first refusal enrols the browser again, and a later refusal of the
// old token must not drop the new one.
test('a late refusal of a token the harness has already replaced leaves the new one alone', async () => {
  let states = 0
  const b = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': (_, headers) => {
        if (++states === 1) return { body: { status: 'ready', pr: 7, panes: PANES } }
        return headers['x-qa-cap'] === 'tok-2' ? { body: { status: 'idle' } } : { ...CAPTURE, ticks: 8 }
      },
      'POST /qa/api/pane-entry': (body, headers) => (headers['x-qa-cap'] === 'tok-2' ? entryRoute(body) : CAPTURE),
      'POST /qa/api/enrol': { body: { token: 'tok-2' } },
      'GET /qa/api/prs': { body: { prs: [], session: null } },
    },
  })
  await b.settle()
  assert.equal(b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/enrol').length, 1)
  assert.equal(b.store.get('qa-cap'), 'tok-2')
  assert.equal(b.byId('enrol').hidden, true, 'no enrolment view')
})

// A pane at a path that starts with // (which its bridge may report) is
// reloaded and re-synced at that path on its own origin, never at //host.
test('reload and re-sync ask for the pane path on the pane origin', async () => {
  const b = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, panes: PANES } },
      'POST /qa/api/pane-entry': entryRoute,
    },
  })
  await b.settle()
  const [, , onMessage] = b.listeners.find(([name, type]) => name === 'window' && type === 'message')
  onMessage({ origin: PANES.prOrigin, data: { qa: 1, kind: 'nav', href: '//evil.example/x?y=1' } })
  onMessage({ origin: PANES.baseOrigin, data: { qa: 1, kind: 'nav', href: '/products' } })
  b.byId('resyncLeft').onclick()
  b.byId('resyncBtn').onclick()
  const [, , onPaneRow] = b.listeners.find(([name, type]) => name === '#paneRow' && type === 'click')
  onPaneRow({ target: { closest: () => ({ dataset: { act: 'reload', pane: 'base' } }) } })
  await b.settle()
  const tos = b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/pane-entry').map(e => e[4]).slice(2)
  assert.deepEqual(tos, [
    { role: 'base', to: `${PANES.baseOrigin}//evil.example/x?y=1` },
    { role: 'pr', to: `${PANES.prOrigin}//evil.example/x?y=1` },
    { role: 'base', to: `${PANES.baseOrigin}//evil.example/x?y=1` },
  ])
})

test('the header chip shows the session\'s isolation verdict, with its reasons as the title, and none while idle', async () => {
  const chip = b => Object.fromEntries(b.log.filter(e => e[0] === 'set' && e[1] === 'isolationChip').map(e => [e[2], e[3]]))
  const ready = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, panes: PANES, isolation: { verdict: 'reachable', reasons: ['a', 'b'] } } },
      'POST /qa/api/pane-entry': entryRoute,
    },
  })
  await ready.settle()
  const shown = chip(ready)
  assert.deepEqual([shown.hidden, shown.textContent, shown.title], [false, 'not isolated', 'a; b'])
  const idle = fakeBrowser({
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': { body: { status: 'idle', isolation: { verdict: 'isolated', reasons: [] } } },
      'GET /qa/api/prs': { body: { prs: [], session: null } },
    },
  })
  await idle.settle()
  assert.equal(chip(idle).hidden, true)

  // strict mode, as /api/state says it, beside the verdict
  const strict = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, panes: PANES, requireIsolation: true, isolation: { verdict: 'isolated', reasons: [] } } },
      'POST /qa/api/pane-entry': entryRoute,
    },
  })
  await strict.settle()
  assert.equal(chip(strict).textContent, 'isolated · strict')
})

// #prList as the DOM has it, so far as the picker uses it: setting its text
// detaches every row, and a row is shown only while it is appended.
function fakeList(text = 'Loading…') {
  const list = {
    text, children: [], listeners: [], texts: [],
    appendChild(child) { child.parentNode = list; list.children.push(child); return child },
    get textContent() { return list.text },
    set textContent(value) { for (const child of list.children) child.parentNode = null; list.children = []; list.text = String(value); list.texts.push(list.text) },
    addEventListener(type, fn) { list.listeners.push([type, fn]) },
    querySelectorAll: () => [],
  }
  return list
}

// A restart revokes every token. The picker's ↻ then gets a refusal, the
// browser enrols again, and the picker must show the rows, not the refusal.
test('after a restart, refreshing the picker enrols the browser again and shows the PRs', async () => {
  let token = 'tok-1'
  const prList = fakeList()
  const prs = [{ number: 7, title: 'a', imageStatus: 'built' }, { number: 8, title: 'b', imageStatus: 'built' }]
  const enrolled = answer => (_, headers) => (headers['x-qa-cap'] === token ? answer : CAPTURE)
  const b = fakeBrowser({
    stored: 'tok-1',
    elements: { prList },
    routes: {
      'GET /qa/api/state': enrolled({ body: { status: 'idle' } }),
      'GET /qa/api/prs': enrolled({ body: { prs, session: null } }),
      'POST /qa/api/enrol': () => ({ body: { token } }),
    },
  })
  await b.settle()
  assert.deepEqual(prList.children.map(row => row.dataset.pr), [7, 8])
  assert.equal(prList.textContent, '')

  token = 'tok-2' // the conductor restarted
  b.byId('refreshBtn').onclick()
  await b.settle()
  assert.equal(b.store.get('qa-cap'), 'tok-2')
  assert.equal(b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/enrol').length, 1)
  assert.deepEqual(prList.children.map(row => row.dataset.pr), [7, 8])
  assert.equal(prList.textContent, '', 'no refusal left in the list')
  assert.ok(prList.children.every(row => row.parentNode === prList))
  assert.ok(!prList.texts.some(text => /Failed|not enrolled/.test(text)), `never told it isn't enrolled: ${JSON.stringify(prList.texts)}`)
})

// Text that stood in for the rows (an error, "No open PRs.") goes once there
// are rows again, and the rows it detached come back.
test('the picker brings back its rows after an error or an empty list stood in for them', async () => {
  let answer = { body: { prs: [{ number: 7, title: 'a' }], session: null } }
  const prList = fakeList()
  const b = fakeBrowser({
    stored: 'tok-1',
    elements: { prList },
    routes: { 'GET /qa/api/state': { body: { status: 'idle' } }, 'GET /qa/api/prs': () => answer },
  })
  await b.settle()
  const shown = () => [prList.textContent, prList.children.map(row => row.dataset.pr)]
  assert.deepEqual(shown(), ['', [7]])
  answer = { status: 502, body: { error: 'GitHub is down' } }
  b.byId('refreshBtn').onclick(); await b.settle()
  assert.deepEqual(shown(), ['Failed to load PRs: GitHub is down', []])
  answer = { body: { prs: [{ number: 7, title: 'a' }, { number: 9, title: 'c' }], session: null } }
  b.byId('refreshBtn').onclick(); await b.settle()
  assert.deepEqual(shown(), ['', [7, 9]])
  answer = { body: { prs: [], session: null } }
  b.byId('refreshBtn').onclick(); await b.settle()
  assert.deepEqual(shown(), ['No open PRs.', []])
  answer = { body: { prs: [{ number: 9, title: 'c' }], session: null } }
  b.byId('refreshBtn').onclick(); await b.settle()
  assert.deepEqual(shown(), ['', [9]])
})

// Open QA on a picker row: the delegated click, as the picker gets it. Once
// the click is handled, the button is detached, as a re-render of the row
// (a re-enrolment's, say) leaves it.
function clickOpen(prList, num) {
  const row = { attrs: {}, err: {}, setAttribute(k, v) { row.attrs[k] = v }, removeAttribute(k) { delete row.attrs[k] }, querySelector: () => row.err }
  let attached = true
  const btn = { dataset: { open: String(num) }, closest: sel => (sel === '.pr' && attached ? row : null) }
  row.btn = btn
  const [, onClick] = prList.listeners.find(([type]) => type === 'click')
  onClick({ target: { closest: () => btn } })
  attached = false
  return row
}

// A restart revoked the token, and with it any session: Open QA's refused
// POST /api/session enrols the browser again, then is sent once more.
test('after a restart, Open QA enrols the browser again and asks for the session once more, with the new token', async () => {
  for (const retryRefused of [false, true]) {
    let token = 'tok-1'
    const sessions = []
    const prList = fakeList()
    const enrolled = answer => (_, headers) => (headers['x-qa-cap'] === token ? answer : CAPTURE)
    const b = fakeBrowser({
      stored: 'tok-1',
      elements: { prList },
      routes: {
        'GET /qa/api/state': enrolled({ body: { status: 'idle' } }),
        'GET /qa/api/prs': enrolled({ body: { prs: [{ number: 7, title: 'a' }], session: null } }),
        'POST /qa/api/enrol': () => ({ body: { token } }),
        'POST /qa/api/session': (body, headers) => {
          sessions.push([headers['x-qa-cap'], body])
          return headers['x-qa-cap'] === token && !retryRefused ? { status: 202, body: { ok: true } } : CAPTURE
        },
      },
    })
    await b.settle()
    token = 'tok-2' // the conductor restarted
    const row = clickOpen(prList, 7)
    await b.settle()
    assert.deepEqual(sessions, [['tok-1', { pr: 7 }], ['tok-2', { pr: 7 }]], 'once more, and only once')
    if (!retryRefused) {
      assert.equal(b.location.hash, '#/pr/7/boot')
    } else {
      // a token refused just after it was given: the row says so, and the
      // enrolment view takes over
      assert.equal(b.location.hash, '#/')
      assert.equal(row.err.textContent, 'this browser is not enrolled')
      assert.equal(row.attrs['aria-busy'], undefined)
      assert.equal(b.byId('enrol').hidden, false)
    }
  }
})

// Any other refusal is the row's error, as before.
// After a restart someone else's session already runs, so the window is
// shut: the browser can't enrol again, and Open QA isn't sent once more.
test('Open QA after a restart whose re-enrolment is refused shows why, and asks once', async () => {
  let token = 'tok-1'
  const sessions = []
  const prList = fakeList()
  const enrolled = answer => (_, headers) => (headers['x-qa-cap'] === token ? answer : CAPTURE)
  const shut = { status: 403, body: { error: 'enrolment is closed: a session is running', reason: 'a session is running', refusal: 'capability' }, headers: { 'x-qa-refusal': 'capability' } }
  let open = true
  const b = fakeBrowser({
    stored: 'tok-1',
    elements: { prList },
    routes: {
      'GET /qa/api/state': enrolled({ body: { status: 'idle' } }),
      'GET /qa/api/prs': enrolled({ body: { prs: [{ number: 7, title: 'a' }], session: null } }),
      'POST /qa/api/enrol': () => (open ? { body: { token } } : shut),
      'POST /qa/api/session': (body, headers) => { sessions.push(headers['x-qa-cap']); return headers['x-qa-cap'] === token ? { status: 202, body: { ok: true } } : CAPTURE },
    },
  })
  await b.settle()
  token = 'tok-2' // the conductor restarted
  open = false // and a session started before this browser came back
  const row = clickOpen(prList, 7)
  await b.settle()
  assert.deepEqual(sessions, ['tok-1'], 'not sent again')
  assert.equal(b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/enrol').length, 1)
  assert.equal(b.byId('enrol').hidden, false)
  assert.equal(b.byId('enrolReason').textContent, 'Enrolment is closed: a session is running.')
  assert.equal(row.err.textContent, 'this browser is not enrolled')
  assert.equal(row.attrs['aria-busy'], undefined)
  assert.equal(b.location.hash, '#/')
})

test('Open QA refused for another reason shows it on the row and asks once', async () => {
  const sessions = []
  const prList = fakeList()
  const b = fakeBrowser({
    stored: 'tok-1',
    elements: { prList },
    routes: {
      'GET /qa/api/state': { body: { status: 'idle' } },
      'GET /qa/api/prs': { body: { prs: [{ number: 7, title: 'a' }], session: null } },
      'POST /qa/api/session': body => { sessions.push(body); return { status: 503, body: { error: 'shutting down' } } },
    },
  })
  await b.settle()
  const row = clickOpen(prList, 7)
  await b.settle()
  assert.equal(sessions.length, 1)
  assert.equal(row.err.textContent, 'shutting down')
  assert.equal(b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/enrol').length, 0)
})

// A second restart, or 32 newer browsers, refuses the token the browser got
// a moment ago, while the view after enrolling is still being drawn.
test('a token refused while the view after enrolling is drawn shows the enrolment view', async () => {
  let good = 'tok-1'
  const prList = fakeList()
  const enrolled = answer => (_, headers) => (headers['x-qa-cap'] === good ? answer : CAPTURE)
  const b = fakeBrowser({
    stored: 'tok-1',
    elements: { prList },
    routes: {
      'GET /qa/api/state': enrolled({ body: { status: 'idle' } }),
      'GET /qa/api/prs': enrolled({ body: { prs: [{ number: 7, title: 'a' }], session: null } }),
      'POST /qa/api/enrol': () => ({ body: { token: 'tok-2' } }),
    },
  })
  await b.settle()
  good = 'nobody' // a restart, and tok-2 refused as soon as it is given
  b.byId('refreshBtn').onclick()
  await b.settle()
  assert.equal(b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/enrol').length, 1, 'no loop')
  assert.equal(b.store.get('qa-cap'), undefined)
  assert.equal(b.byId('enrol').hidden, false)
})

// "End #8 and open #9", refused by a restart: once enrolled again, the try
// once more must not end a session someone started meanwhile.
test('a takeover a restart refused is sent again without takeover, so a new session gets the conflict card', async () => {
  let token = 'tok-1'
  const sessions = []
  const prList = fakeList()
  const conflictSlot = { children: [], innerHTML: '', appendChild(child) { conflictSlot.children.push(child); return child } }
  const enrolled = answer => (_, headers) => (headers['x-qa-cap'] === token ? answer : CAPTURE)
  const running = { pr: 8, status: 'ready' }
  const b = fakeBrowser({
    stored: 'tok-1',
    elements: { prList, conflictSlot },
    routes: {
      'GET /qa/api/state': enrolled({ body: { status: 'idle' } }),
      'GET /qa/api/prs': enrolled({ body: { prs: [{ number: 9, title: 'c' }], session: null } }),
      'POST /qa/api/enrol': () => ({ body: { token } }),
      'POST /qa/api/session': (body, headers) => {
        sessions.push([headers['x-qa-cap'], body])
        if (headers['x-qa-cap'] !== token) return CAPTURE
        return body.takeover ? { status: 202, body: { ok: true } } : { status: 409, body: { error: 'session already active', session: running } }
      },
    },
  })
  await b.settle()
  clickOpen(prList, 9)
  await b.settle()
  const card = conflictSlot.children.at(-1)
  assert.ok(card, 'the conflict card')
  token = 'tok-2' // the conductor restarted, and someone opened #8 again since
  const takeover = card.querySelector('[data-takeover]')
  takeover.onclick() // arm
  takeover.onclick() // confirm
  await b.settle()
  assert.deepEqual(sessions.slice(1), [['tok-1', { pr: 9, takeover: true }], ['tok-2', { pr: 9 }]])
  assert.equal(conflictSlot.children.length, 2, 'a new conflict card, rather than #8 ended unseen')
})

test('a takeover refused for another reason says so, rather than failing unseen', async () => {
  const prList = fakeList()
  const conflictSlot = { children: [], innerHTML: '', appendChild(child) { conflictSlot.children.push(child); return child } }
  const b = fakeBrowser({
    stored: 'tok-1',
    elements: { prList, conflictSlot },
    routes: {
      'GET /qa/api/state': { body: { status: 'idle' } },
      'GET /qa/api/prs': { body: { prs: [{ number: 9, title: 'c' }], session: null } },
      'POST /qa/api/session': body => (body.takeover ? { status: 503, body: { error: 'shutting down' } } : { status: 409, body: { error: 'session already active', session: { pr: 8, status: 'ready' } } }),
    },
  })
  await b.settle()
  clickOpen(prList, 9)
  await b.settle()
  const takeover = conflictSlot.children.at(-1).querySelector('[data-takeover]')
  takeover.onclick(); takeover.onclick()
  await b.settle()
  assert.equal(b.byId('announcerAssertive').textContent, "Couldn't open #9: shutting down")
})

// While one Open QA is on its way (a restart's re-enrolment included), the
// redrawn rows take no other.
test('a click on another row while an Open QA is on its way does nothing', async () => {
  let token = 'tok-1'
  const prList = fakeList()
  const enrolled = answer => (_, headers) => (headers['x-qa-cap'] === token ? answer : CAPTURE)
  const b = fakeBrowser({
    stored: 'tok-1',
    elements: { prList },
    routes: {
      'GET /qa/api/state': enrolled({ body: { status: 'idle' } }),
      'GET /qa/api/prs': enrolled({ body: { prs: [{ number: 7, title: 'a' }, { number: 8, title: 'b' }], session: null } }),
      'POST /qa/api/enrol': () => ({ body: { token }, ticks: 6 }),
      'POST /qa/api/session': (_, headers) => (headers['x-qa-cap'] === token ? { status: 202, body: { ok: true } } : CAPTURE),
    },
  })
  await b.settle()
  token = 'tok-2'
  clickOpen(prList, 7)
  for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r))
  const other = clickOpen(prList, 8)
  assert.deepEqual([other.attrs['aria-busy'], other.btn.textContent], [undefined, undefined])
  await b.settle()
  assert.deepEqual([other.attrs['aria-busy'], other.btn.textContent], [undefined, undefined])
  assert.equal(b.location.hash, '#/pr/7/boot')
})

// A browser showing a session learns it ended, or was opened again (by
// another browser, say), on its next idle poll: the new session's panes
// take new pane cookies, so it enters them again.
test('a session view whose session ended or was opened again elsewhere notices on its next idle poll', async () => {
  let state = { status: 'ready', pr: 7, panes: PANES, startedAt: 1000, lastActivity: 1000, idleMinutes: 30 }
  const b = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': () => ({ body: state }),
      'GET /qa/api/prs': { body: { prs: [], session: null } },
      'POST /qa/api/pane-entry': entryRoute,
    },
  })
  await b.settle()
  const entries = () => b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/pane-entry').length
  const poll = async () => { b.intervals.filter(i => i.ms === 60000).at(-1).fn(); await b.settle() }
  assert.equal(entries(), 2)
  await poll()
  assert.equal(entries(), 2, 'the same session: nothing to do')
  state = { ...state, startedAt: 2000 }
  await poll()
  assert.equal(entries(), 4, 'opened again: both panes entered again')
  assert.equal(b.location.hash, '#/pr/7')
  state = { status: 'idle', pr: null }
  await poll()
  assert.equal(entries(), 4)
  assert.equal(b.location.hash, '#/', 'ended: back to the picker')
})

// #8: each action a pane's bridge reports becomes a mark in the session's
// action log: the pane and the kind of action, never the element or a value.
test('a click, submit, change or Enter a pane reports is marked, value-free, mirrored or not, at most one of each kind a pane each 100 ms', async () => {
  const b = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, panes: PANES } },
      'POST /qa/api/pane-entry': entryRoute,
      'POST /qa/api/actions/mark': { body: { recorded: true } },
    },
  })
  await b.settle()
  const [, , onMessage] = b.listeners.find(([name, type]) => name === 'window' && type === 'message')
  const marks = () => b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/actions/mark').map(e => e[4])
  const event = (origin, data) => onMessage({ origin, data: { qa: 1, kind: 'event', selector: '#card-number', value: '4111 SECRET', ...data } })
  event(PANES.baseOrigin, { type: 'click' })
  event(PANES.baseOrigin, { type: 'submit' }) // the submit the click set off: another kind
  event(PANES.baseOrigin, { type: 'click' }) // the same kind within 100 ms
  event(PANES.prOrigin, { type: 'submit' })
  await new Promise(r => setTimeout(r, 110))
  // after a gap, on its own: not an action
  event(PANES.baseOrigin, { type: 'keydown', key: 'Escape' })
  await new Promise(r => setTimeout(r, 110))
  event(PANES.baseOrigin, { type: 'input' }) // nor this
  event(PANES.baseOrigin, { type: 'scroll' })
  event(PANES.baseOrigin, { type: 'keydown', key: 'Enter' })
  await new Promise(r => setTimeout(r, 110))
  b.byId('mirrorBtn').onclick() // mirroring off: still marked
  event(PANES.prOrigin, { type: 'change' })
  // a message from anywhere else is no pane's
  event('https://evil.example', { type: 'click' })
  onMessage({ origin: PANES.prOrigin, data: { qa: 1, kind: 'nav', href: '/x' } })
  await b.settle()
  assert.deepEqual(marks(), [
    { pane: 'base', type: 'click' }, { pane: 'base', type: 'submit' }, { pane: 'pr', type: 'submit' }, { pane: 'base', type: 'enter' }, { pane: 'pr', type: 'change' },
  ])
  assert.doesNotMatch(JSON.stringify(b.log.filter(e => e[0] === 'fetch')), /SECRET|card-number/)
})

// The throttle runs on a monotonic clock: the wall clock stepping back an
// hour holds no mark back, and the first mark goes at once, however soon
// after the page loaded.
test('the mark throttle runs on a monotonic clock', async () => {
  let perf = 50
  let wall = 1_000_000_000
  const b = fakeBrowser({
    hash: '#/pr/7',
    stored: 'tok-1',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, panes: PANES } },
      'POST /qa/api/pane-entry': entryRoute,
      'POST /qa/api/actions/mark': { body: { recorded: true } },
    },
    clock: { perf: () => perf, wall: () => wall },
  })
  await b.settle()
  const [, , onMessage] = b.listeners.find(([name, type]) => name === 'window' && type === 'message')
  const marks = () => b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/actions/mark')
  const click = () => onMessage({ origin: PANES.baseOrigin, data: { qa: 1, kind: 'event', type: 'click' } })
  click() // 50 ms after the page started
  perf += 150
  wall -= 3_600_000
  click() // 150 ms on, the wall clock an hour back
  perf += 50
  click() // 50 ms on: held back
  await b.settle()
  assert.equal(marks().length, 2)
})

// --- Change Review (#/review) -----------------------------------------------
// The walk over the PRs still waiting for a verdict, against the stand-in
// browser: what it posts, what it stores, and which view it shows.

const sessions = b => b.log.filter(e => e[0] === 'fetch' && e[1] === 'POST' && e[2] === '/qa/api/session').map(e => e[4])
const posts = (b, path) => b.log.filter(e => e[0] === 'fetch' && e[1] === 'POST' && e[2] === path).length
const reviewStored = b => JSON.parse(b.session.get('qa-review') ?? 'null')
const VERDICT_STATE = { verdictLabels: { accept: 'qa-approved', reject: 'qa-changes-requested' } }
const QUEUE_PRS = [
  { number: 4, title: 'done already', imageStatus: 'built', labels: ['qa-approved'], createdAt: '2026-10-01T00:00:00Z' },
  { number: 7, title: 'seven', imageStatus: 'built', labels: [], createdAt: '2026-10-02T00:00:00Z' },
  { number: 8, title: 'eight', imageStatus: 'none', labels: [], createdAt: '2026-10-03T00:00:00Z' },
]
// Two clicks within the confirm window, as a reviewer skips.
const confirmClick = btn => { btn.onclick(); return btn.onclick() }

test('#/review boots the queue head, keeps the hash, and shows the strip', async () => {
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': { body: { status: 'idle', ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: null } },
      'POST /qa/api/session': { status: 202, body: { ok: true } },
    },
  })
  await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }], 'the labelled PR is left out, the built one goes first')
  assert.equal(b.location.hash, '#/review')
  assert.ok(!b.log.some(e => e[0] === 'replace'), 'no hash edit: the boot view sits under the strip')
  assert.equal(b.byId('reviewNum').textContent, '#7')
  assert.equal(b.byId('reviewTitle').textContent, 'seven')
  assert.equal(b.byId('reviewCount').textContent, '1 of 2')
  assert.equal(b.byId('reviewNext').textContent, 'next #8')
  assert.equal(b.byId('reviewStrip').hidden, false)
  assert.equal(b.byId('boot').hidden, false)
})

test('a verdict in Change Review records the PR as done and opens the next with takeover, with no "Verdict posted" page', async () => {
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, startedAt: 1, panes: PANES, ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: { pr: 7, status: 'ready' } } },
      'POST /qa/api/prebuild': body => ({ body: { pr: body.pr, started: true, reason: null } }),
      'POST /qa/api/pane-entry': entryRoute,
      'GET /qa/api/verdict/preview': { body: { body: 'preview', applies: 'qa-approved', removes: 'qa-changes-requested' } },
      'POST /qa/api/verdict': { body: { url: 'https://github.example/pull/7#c1' } },
      'POST /qa/api/session': { status: 202, body: { ok: true } },
    },
  })
  await b.settle()
  assert.deepEqual(sessions(b), [], 'the running session on a queued PR is resumed, not reopened')
  assert.equal(b.byId('session').hidden, false)
  assert.equal(b.byId('reviewBar').hidden, false, 'the compact bar belongs to the session view')
  // the next PR (#8, unbuilt) is warmed as soon as the session is up
  assert.deepEqual(b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/prebuild').map(e => e[4]), [{ pr: 8 }])
  assert.equal(b.byId('reviewNext').textContent, 'next #8 · warming')

  await b.byId('acceptBtn').onclick(); await b.settle()
  await b.byId('postBtn').onclick(); await b.settle()
  assert.equal(posts(b, '/qa/api/verdict'), 1)
  assert.deepEqual(sessions(b), [{ pr: 8, takeover: true }], 'the next PR replaces the finished one')
  assert.deepEqual(reviewStored(b), { skipped: [], done: [7], reviewed: 1 })
  assert.ok(!b.log.some(e => e[0] === 'replace' && /verdict/.test(e[1])), 'no #/pr/7/verdict')
  assert.ok(b.log.some(e => e[0] === 'set' && e[1] === 'reviewPosted' && e[2] === 'textContent' && e[3] === ''), 'the note is rebuilt from text nodes')
  assert.equal(b.byId('reviewCount').textContent, '2 of 2')
  assert.equal(b.byId('reviewNext').textContent, 'last one')
})

test('Skip sends the current PR to the back for this visit, ends its session and opens the next', async () => {
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': { body: { status: 'idle', ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: null } },
      'POST /qa/api/session': { status: 202, body: { ok: true } },
      'POST /qa/api/teardown': { body: { ok: true } },
    },
  })
  await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }])
  await confirmClick(b.byId('skipBtn')); await b.settle()
  assert.equal(posts(b, '/qa/api/teardown'), 1)
  assert.deepEqual(sessions(b), [{ pr: 7 }, { pr: 8 }])
  assert.deepEqual(reviewStored(b), { skipped: [7], done: [], reviewed: 0 })
  assert.equal(b.byId('reviewNext').textContent, 'next #7', 'the skipped PR comes back at the end')
  // skipping the last one brings the skipped PR round again
  await confirmClick(b.byId('skipBtn')); await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }, { pr: 8 }, { pr: 7 }])
  assert.deepEqual(reviewStored(b), { skipped: [7, 8], done: [], reviewed: 0 }, 'in the order they were skipped')
})

test('an empty queue ends the walk\'s own last session and shows Queue clear, with the blocked count', async () => {
  const prs = [QUEUE_PRS[0], { number: 9, title: 'nine', imageStatus: 'blocked', reason: 'fork', labels: [] }]
  const session = new Map([['qa-review', JSON.stringify({ skipped: [], done: [4], reviewed: 1 })]])
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok', session,
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 4, startedAt: 1, panes: PANES, ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs, session: { pr: 4, status: 'ready' } } },
      'POST /qa/api/teardown': { body: { ok: true } },
    },
  })
  await b.settle()
  assert.equal(posts(b, '/qa/api/teardown'), 1)
  assert.deepEqual(sessions(b), [])
  assert.equal(b.byId('queueClear').hidden, false)
  assert.equal(b.byId('queueClearBlocked').hidden, false)
  assert.equal(b.byId('queueClearBlocked').textContent, "1 can't boot and is left out.")
  assert.equal(b.byId('reviewCount').textContent, '1 of 1 done')
  // #4's label is in the list now, so the cover for it is dropped
  assert.deepEqual(reviewStored(b), { skipped: [], done: [], reviewed: 1 })
})

test('PRs not for review are left out of the walk and counted apart, in the strip and on Queue clear', async () => {
  const prs = [
    { number: 7, title: 'seven', imageStatus: 'built', labels: [] },
    { number: 8, title: 'docs', imageStatus: 'none', labels: [], review: false, skipReason: 'docs only' },
    { number: 9, title: 'draft', imageStatus: 'blocked', reason: 'fork', labels: [], review: false, skipReason: 'draft' },
    { number: 10, title: 'fork', imageStatus: 'blocked', reason: 'fork', labels: [] },
  ]
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': { body: { status: 'idle', ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs, session: null } },
      'POST /qa/api/session': { status: 202, body: { ok: true } },
    },
  })
  await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }])
  assert.equal(b.byId('reviewNext').textContent, 'last one')
  assert.equal(b.byId('reviewBlocked').textContent, "1 can't boot · 2 not for review")

  for (const [list, want] of [
    [prs.slice(1), "1 can't boot and is left out. 2 not for review are left out; open them from the pull requests."],
    [[prs[1]], '1 not for review is left out; open it from the pull requests.'],
  ]) {
    const c = fakeBrowser({
      hash: '#/review', stored: 'tok',
      routes: {
        'GET /qa/api/state': { body: { status: 'idle', ...VERDICT_STATE } },
        'GET /qa/api/prs': { body: { prs: list, session: null } },
      },
    })
    await c.settle()
    assert.deepEqual(sessions(c), [])
    assert.equal(c.byId('queueClear').hidden, false)
    assert.equal(c.byId('queueClearBlocked').hidden, false)
    assert.equal(c.byId('queueClearBlocked').textContent, want)
  }
})

// A PR not for review is still in the picker, and says so, so a person can
// open it by hand.
test('the picker lists a PR not for review, with its reason, and opens it', async () => {
  const prList = fakeList()
  const prs = [
    { number: 7, title: 'a', imageStatus: 'built' },
    { number: 8, title: 'b', imageStatus: 'none', review: false, skipReason: 'type <chore>' },
  ]
  const b = fakeBrowser({
    stored: 'tok',
    elements: { prList },
    routes: {
      'GET /qa/api/state': { body: { status: 'idle' } },
      'GET /qa/api/prs': { body: { prs, session: null } },
    },
  })
  await b.settle()
  assert.deepEqual(prList.children.map(row => row.dataset.pr), [7, 8])
  const [seven, eight] = prList.children
  assert.ok(!/not for review/.test(seven.innerHTML), seven.innerHTML)
  assert.ok(eight.innerHTML.includes('not for review: type &lt;chore&gt;'), eight.innerHTML)
  assert.ok(eight.innerHTML.includes('data-open="8"'), 'it still opens')
})

// A session the reviewer opened from the picker, on a PR the queue is done
// with, is theirs: the walk asks before ending it, even with nothing to open.
test('an empty queue never ends a session the walk did not open: it is held, with End as a confirmed click', async () => {
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 4, startedAt: 1, panes: PANES, ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs: [QUEUE_PRS[0]], session: { pr: 4, status: 'ready' } } },
      'POST /qa/api/teardown': { body: { ok: true } },
    },
  })
  await b.settle()
  assert.equal(posts(b, '/qa/api/teardown'), 0)
  assert.equal(b.byId('reviewHold').hidden, false)
  assert.equal(b.byId('holdHeading').textContent, "A session is running on #4, which isn't in the queue")
  assert.equal(b.byId('holdPrimary').textContent, 'End #4')
  assert.equal(b.byId('holdResume').hidden, false)
  await confirmClick(b.byId('holdPrimary')); await b.settle()
  assert.equal(posts(b, '/qa/api/teardown'), 1)
  assert.equal(b.byId('queueClear').hidden, false)
})

// The loop the design avoids: a session that ends by itself (the idle
// teardown) while the walk is on it must not boot again on its own.
test('a session that ends under the walk is held for Continue, not booted again', async () => {
  let st = { status: 'idle', ...VERDICT_STATE }
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': () => ({ body: st }),
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: null } },
      'POST /qa/api/session': { status: 202, body: { ok: true } },
    },
  })
  await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }])
  assert.equal(b.sources.length, 1, 'the boot view follows the progress stream')
  // the conductor tears the session down (idle) and says so on the stream
  b.sources[0].onmessage({ data: JSON.stringify({ kind: 'torn-down' }) }); await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }], 'no boot by itself')
  assert.equal(b.byId('reviewHold').hidden, false)
  assert.equal(b.byId('holdHeading').textContent, 'The session for #7 has ended')
  assert.equal(b.byId('holdResume').hidden, true)
  b.byId('holdPrimary').onclick(); await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }, { pr: 7 }], 'Continue opens it again')
})

// Leaving review mode forgets where the walk was: a later visit starts from
// the queue head rather than holding for a PR that has no session.
test('Stop forgets the walk\'s place, so the next visit opens the head without a hold', async () => {
  let st = { status: 'ready', pr: 7, startedAt: 1, panes: PANES, ...VERDICT_STATE }
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': () => ({ body: st }),
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: null } },
      'POST /qa/api/pane-entry': entryRoute,
      'POST /qa/api/session': { status: 202, body: { ok: true } },
    },
  })
  await b.settle()
  b.byId('stopBtn').onclick(); await b.settle()
  assert.equal(b.location.hash, '#/')
  // the session ended meanwhile; the reviewer comes back
  st = { status: 'idle', ...VERDICT_STATE }
  b.location.hash = '#/review'
  for (const [who, type, fn] of b.listeners) if (who === 'window' && type === 'hashchange') fn()
  await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }])
  assert.equal(b.byId('reviewHold').hidden, true)
})

test('a failed queue read keeps the running session and says so in the strip, with Try again', async () => {
  let fail = true
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, startedAt: 1, panes: PANES, ...VERDICT_STATE } },
      'GET /qa/api/prs': () => (fail ? { status: 500, body: { error: 'github down' } } : { body: { prs: QUEUE_PRS, session: { pr: 7, status: 'ready' } } }),
      'POST /qa/api/pane-entry': entryRoute,
      'POST /qa/api/teardown': { body: { ok: true } },
    },
  })
  await b.settle()
  assert.equal(posts(b, '/qa/api/teardown'), 0)
  assert.equal(b.byId('session').hidden, false)
  assert.equal(b.byId('reviewError').hidden, false)
  assert.equal(b.byId('reviewErrorText').textContent, "Couldn't load the queue: github down")
  fail = false
  b.byId('reviewRetry').onclick(); await b.settle()
  assert.equal(b.byId('reviewError').hidden, true)
  assert.equal(b.byId('reviewCount').textContent, '1 of 2')
})

test('the walk goes on in memory where session storage throws', async () => {
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok', sessionThrows: true,
    routes: {
      'GET /qa/api/state': { body: { status: 'idle', ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: null } },
      'POST /qa/api/session': { status: 202, body: { ok: true } },
      'POST /qa/api/teardown': { body: { ok: true } },
    },
  })
  await b.settle()
  await confirmClick(b.byId('skipBtn')); await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }, { pr: 8 }])
})

test('Stop leaves Change Review for the picker and keeps the session; a session on a PR outside the queue is held, not ended', async () => {
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 7, startedAt: 1, panes: PANES, ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: { pr: 7, status: 'ready' } } },
      'POST /qa/api/pane-entry': entryRoute,
      'POST /qa/api/teardown': { body: { ok: true } },
    },
  })
  await b.settle()
  b.byId('stopBtn').onclick(); await b.settle()
  assert.equal(b.location.hash, '#/')
  assert.equal(posts(b, '/qa/api/teardown'), 0)

  // a session on a PR the queue doesn't hold (reviewed from the picker, say)
  const held = fakeBrowser({
    hash: '#/review', stored: 'tok',
    routes: {
      'GET /qa/api/state': { body: { status: 'ready', pr: 42, startedAt: 1, panes: PANES, ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: { pr: 42, status: 'ready' } } },
      'POST /qa/api/teardown': { body: { ok: true } },
      'POST /qa/api/session': { status: 202, body: { ok: true } },
    },
  })
  await held.settle()
  assert.equal(held.byId('reviewHold').hidden, false)
  assert.equal(held.byId('holdHeading').textContent, "A session is running on #42, which isn't in the queue")
  assert.equal(posts(held, '/qa/api/teardown'), 0)
  assert.deepEqual(sessions(held), [])
  await confirmClick(held.byId('holdPrimary')); await held.settle()
  assert.deepEqual(sessions(held), [{ pr: 7, takeover: true }])
})


// --- the PR context pane ---------------------------------------------------------
// A side pane (an overlay below 900 px) with the PR's description, comments,
// reviews and checks. Closed by default; the header's button or `c` toggles
// it, and whether it is open lives in the tab's session storage.

// A container that keeps what is appended to it.
function fakeBox() {
  const box = {
    children: [], text: '',
    append(...xs) { box.children.push(...xs) },
    get textContent() { return box.text },
    set textContent(v) { box.children = []; box.text = String(v) },
  }
  return box
}
const CONTEXT_ANSWER = { number: 7, title: 'seven', body: 'Hello', comments: { items: [], total: 0, error: null } }
const contextFetches = b => b.log.filter(e => e[0] === 'fetch' && e[2] === '/qa/api/pr-context').map(e => [new URL(e[5], 'https://h.ts.net').search, e[3]['x-qa-cap']])
// The document's keydown listener, as the harness chrome gets a key.
const press = (b, key, extra = {}) => {
  const [, , fn] = b.listeners.find(([name, type]) => name === 'document' && type === 'keydown')
  let prevented = false
  fn({ key, target: { tagName: 'BODY' }, preventDefault() { prevented = true }, ...extra })
  return prevented
}
const DIALOGS = { inviteDialog: { open: false }, shortcuts: { open: false } }
const readySession = extra => ({
  'GET /qa/api/state': { body: { status: 'ready', pr: 7, startedAt: 1, panes: PANES } },
  'POST /qa/api/pane-entry': entryRoute,
  ...extra,
})

test('the PR context pane is closed by default, and its button opens it in a session: it reads /api/pr-context for the PR with the token, and is remembered', async () => {
  const ctxBody = fakeBox()
  const b = fakeBrowser({ hash: '#/pr/7', stored: 'tok', elements: { ctxBody, ...DIALOGS }, routes: readySession({ 'GET /qa/api/pr-context': { body: CONTEXT_ANSWER } }) })
  await b.settle()
  assert.equal(b.byId('contextBtn').hidden, false, 'the button shows in a session')
  assert.equal(b.byId('prContext').hidden, true, 'closed by default: it covers nothing')
  assert.deepEqual(contextFetches(b), [], 'nothing read until it opens')

  b.byId('contextBtn').onclick(); await b.settle()
  assert.equal(b.byId('prContext').hidden, false)
  assert.deepEqual(contextFetches(b), [['?pr=7', 'tok']])
  assert.equal(b.session.get('qa-context'), 'open')
  assert.equal(ctxBody.children.length, 1, 'the rendered context')
  assert.equal(b.byId('ctxStatus').hidden, true)
  assert.ok(b.log.some(e => e[0] === 'set' && e[1] === 'prContext' && e[2] === 'hidden' && e[3] === false))

  b.byId('ctxClose').onclick(); await b.settle()
  assert.equal(b.byId('prContext').hidden, true)
  assert.equal(b.session.get('qa-context'), 'closed')
  // opened again soon after, it shows what it read; ↻ reads it again
  b.byId('contextBtn').onclick(); await b.settle()
  assert.equal(contextFetches(b).length, 1)
  b.byId('ctxRefresh').onclick(); await b.settle()
  assert.equal(contextFetches(b).length, 2)
})

test('`c` toggles the PR context pane in a session or a boot, but not with a modifier, in a text field, or on the picker', async () => {
  const b = fakeBrowser({ hash: '#/pr/7', stored: 'tok', elements: { ...DIALOGS }, routes: readySession({ 'GET /qa/api/pr-context': { body: CONTEXT_ANSWER } }) })
  await b.settle()
  assert.equal(press(b, 'c', { metaKey: true }), false, 'Cmd-C copies')
  assert.equal(press(b, 'c', { ctrlKey: true }), false)
  assert.equal(press(b, 'c', { target: { tagName: 'TEXTAREA' } }), false, 'typing notes')
  assert.equal(b.byId('prContext').hidden, true)
  assert.equal(press(b, 'c'), true)
  await b.settle()
  assert.equal(b.byId('prContext').hidden, false)
  assert.equal(contextFetches(b).length, 1)
  press(b, 'c'); await b.settle()
  assert.equal(b.byId('prContext').hidden, true)

  const boot = fakeBrowser({ hash: '#/pr/7', stored: 'tok', elements: { ...DIALOGS }, routes: { 'GET /qa/api/state': { body: { status: 'starting', pr: 7 } }, 'GET /qa/api/pr-context': { body: CONTEXT_ANSWER } } })
  await boot.settle()
  assert.equal(boot.byId('contextBtn').hidden, false, 'a boot has its PR too')
  press(boot, 'c'); await boot.settle()
  assert.deepEqual(contextFetches(boot).map(f => f[0]), ['?pr=7'])

  const picker = fakeBrowser({ stored: 'tok', elements: { ...DIALOGS }, routes: { 'GET /qa/api/state': { body: { status: 'idle' } }, 'GET /qa/api/prs': { body: { prs: [], session: null } } } })
  await picker.settle()
  assert.equal(picker.byId('contextBtn').hidden, true)
  assert.equal(press(picker, 'c'), false)
  assert.deepEqual(contextFetches(picker), [])
})

test('a tab that left the pane open opens it again for the next PR, Change Review included, without a click', async () => {
  const session = new Map([['qa-context', 'open']])
  const b = fakeBrowser({
    hash: '#/review', stored: 'tok', session, elements: { ...DIALOGS },
    routes: {
      'GET /qa/api/state': { body: { status: 'idle', ...VERDICT_STATE } },
      'GET /qa/api/prs': { body: { prs: QUEUE_PRS, session: null } },
      'POST /qa/api/session': { status: 202, body: { ok: true } },
      'GET /qa/api/pr-context': { body: CONTEXT_ANSWER },
    },
  })
  await b.settle()
  assert.deepEqual(sessions(b), [{ pr: 7 }])
  assert.equal(b.byId('prContext').hidden, false)
  assert.deepEqual(contextFetches(b).map(f => f[0]), ['?pr=7'])
})

test('a PR context GitHub refuses shows its error in the pane, with Try again, and leaves the session alone', async () => {
  let fail = true
  const b = fakeBrowser({
    hash: '#/pr/7', stored: 'tok', session: new Map([['qa-context', 'open']]), elements: { ...DIALOGS },
    routes: readySession({ 'GET /qa/api/pr-context': () => (fail ? { status: 502, body: { error: 'github GET /repos/acme/widget/pulls/7 -> 403: no' } } : { body: CONTEXT_ANSWER }) }),
  })
  await b.settle()
  assert.equal(b.byId('ctxStatus').hidden, false)
  assert.equal(b.byId('ctxStatus').textContent, "Couldn't load the PR context: github GET /repos/acme/widget/pulls/7 -> 403: no")
  assert.equal(b.byId('ctxRetry').hidden, false)
  assert.equal(posts(b, '/qa/api/teardown'), 0)
  assert.equal(b.byId('session').hidden, false)
  fail = false
  b.byId('ctxRetry').onclick(); await b.settle()
  assert.equal(b.byId('ctxStatus').hidden, true)
  assert.equal(b.byId('ctxRetry').hidden, true)
})

test('the pane is a labelled region beside the panes, and a modal dialog that Esc closes below 900 px', async () => {
  const html = readFileSync(join(dirname(harnessPath), 'index.html'), 'utf8')
  const tag = html.match(/<section\b[^>]*\bid="prContext"[^>]*>/)?.[0]
  assert.ok(tag)
  assert.match(tag, /role="region"/)
  assert.match(tag, /aria-labelledby="ctxHeading"/)
  assert.match(html, /<h2 id="ctxHeading" tabindex="-1">/)
  assert.match(html, /<button id="contextBtn"[^>]*aria-controls="prContext"[^>]*aria-expanded="false"/)
  assert.match(html, /<kbd>c<\/kbd>/)
  // the overlay form: the compact media query flips the role
  assert.match(harnessSrc, /pane\.setAttribute\('role', compact \? 'dialog' : 'region'\)/)
  assert.match(harnessSrc, /if \(compact\) pane\.setAttribute\('aria-modal', 'true'\); else pane\.removeAttribute\('aria-modal'\)/)
  // behind the overlay, the page is inert, so a screen reader's cursor stays in the dialog
  assert.match(harnessSrc, /\$\('main'\)\.inert = compact && CTX\.open/)
  for (const id of ['main', 'appHeader', 'verdictBar', 'reviewStrip']) assert.match(html, new RegExp(`id="${id}"`), id)

  const b = fakeBrowser({ hash: '#/pr/7', stored: 'tok', session: new Map([['qa-context', 'open']]), elements: { ...DIALOGS }, routes: readySession({ 'GET /qa/api/pr-context': { body: CONTEXT_ANSWER } }) })
  await b.settle()
  const [, , onPaneKey] = b.listeners.find(([name, type]) => name === 'prContext' && type === 'keydown')
  let stopped = false
  onPaneKey({ key: 'Escape', stopPropagation() { stopped = true }, preventDefault() {} })
  assert.equal(stopped, true)
  assert.equal(b.byId('prContext').hidden, true)
  assert.equal(b.session.get('qa-context'), 'closed')
})
