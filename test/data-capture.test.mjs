// A session's data capture (lib/data-capture.mjs, #8): the probes the
// optional inspector opens, one per pane, and the snapshots taken through
// them: seeded (S0) right after each pane's seed, ready (S1) once both panes
// are up, and on demand. An inspector that throws, hangs or returns
// nonsense never fails anything: its pane says why it has no data.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDataCapture } from '../lib/data-capture.mjs'
import { validateRules } from '../lib/data-diff.mjs'

const ref = role => ({ role, slug: `qa-7-${role}`, publicOrigin: `http://127.0.0.1:${role === 'base' ? 1 : 2}` })

// One store per pane, which the test changes between snapshots. The probe
// reads it as the inspector would. `snapshot(role, signal, stores)` may stand in.
function fakeInspector({ open, snapshot } = {}) {
  const stores = { base: null, pr: null }
  const calls = []
  const inspector = {
    async open({ paneRef, db, databases, signal }) {
      calls.push(['open', paneRef.role, db, databases, signal instanceof AbortSignal])
      if (open) return open(paneRef.role)
      stores[paneRef.role] = db
      return {
        async snapshot({ limits, signal: s }) {
          calls.push(['snapshot', paneRef.role, typeof limits.maxRows, s instanceof AbortSignal])
          if (snapshot) return snapshot(paneRef.role, s, stores)
          return { collections: structuredClone(stores[paneRef.role]) }
        },
        async close() { calls.push(['close', paneRef.role]) },
      }
    },
  }
  return { inspector, stores, calls }
}

const carts = rows => ({ saved_carts: { key: ['id'], fields: ['id', 'owner'], rows } })
const seed = () => carts([{ id: 1, owner: 'jane@example.org' }, { id: 2, owner: 'li@example.org' }])
const rules = validateRules({ classify: [{ collection: 'saved_carts', fields: ['owner'], as: 'pii' }] })
const NO_ERRORS = { boot: { base: null, pr: null }, session: { base: null, pr: null } }

async function readyCapture(opts = {}) {
  const events = []
  const fake = fakeInspector(opts)
  const capture = createDataCapture({ inspector: fake.inspector, rules, onCapture: e => events.push(e), ...opts.capture })
  const signal = new AbortController().signal
  for (const role of ['base', 'pr']) await capture.seeded({ paneRef: ref(role), db: seed(), databases: ['shop'], signal })
  return { capture, events, signal, ...fake }
}

test('seeded opens a probe for the pane with its db and takes S0; ready takes S1 and the boot span', async () => {
  const { capture, events, signal, stores, calls } = await readyCapture()
  assert.deepEqual(calls.slice(0, 2), [['open', 'base', stores.base, ['shop'], true], ['snapshot', 'base', 'number', true]])
  // a migration in the PR pane deleted a saved cart between S0 and S1
  stores.pr.saved_carts.rows.pop()
  await capture.ready({ signal })
  const view = capture.view({ isolation: { verdict: 'isolated' } })
  assert.deepEqual([view.available, view.active, view.trust], [true, true, 'trusted'])
  assert.equal(view.boot.complete, true)
  assert.deepEqual([view.boot.base.collections.saved_carts.status, view.boot.pr.collections.saved_carts.status], ['same', 'changed'])
  assert.equal(view.boot.divergence.collections.saved_carts.status, 'pr-only')
  assert.deepEqual(view.boot.flags.map(f => [f.collection, f.kind, f.severity]), [['saved_carts', 'delete', 'red']])
  assert.equal(view.session, null, 'no session span before a snapshot')
  assert.deepEqual(view.errors, NO_ERRORS)
  assert.equal(typeof view.baselineAt, 'number')
  assert.deepEqual([view.rebaselined, view.comparedAt], [false, null])
  // events are value-free, and only for the boot's phases
  assert.deepEqual(events, [
    { pane: 'base', phase: 'seeded', ok: true }, { pane: 'pr', phase: 'seeded', ok: true },
    { pane: 'base', phase: 'ready', ok: true }, { pane: 'pr', phase: 'ready', ok: true },
  ])
  assert.doesNotMatch(JSON.stringify(view), /example\.org|jane|li@/)
})

test('snapshot gives the session span against the baseline; rebaseline makes now the baseline; neither is an event', async () => {
  const { capture, events, signal, stores } = await readyCapture()
  await capture.ready({ signal })
  stores.base.saved_carts.rows.splice(0, 2)
  stores.pr.saved_carts.rows.splice(0, 2)
  assert.equal(await capture.snapshot(), undefined)
  const view = capture.view({ isolation: { verdict: 'shared-host' } })
  assert.equal(view.trust, 'advisory')
  assert.equal(view.session.divergence.collections.saved_carts.status, 'both')
  assert.deepEqual(view.session.flags.map(f => [f.kind, f.severity, f.base, f.shared]), [['delete', 'red', 2, true], ['emptied', 'red', 1, true]])
  assert.deepEqual(capture.view({ isolation: { verdict: 'isolated' } }).session.flags.map(f => f.severity), ['amber', 'amber'])
  assert.equal(typeof view.comparedAt, 'number')
  await capture.snapshot({ rebaseline: true })
  const after = capture.view({ isolation: null })
  assert.deepEqual([after.rebaselined, after.session, after.comparedAt], [true, null, null])
  stores.pr.saved_carts.rows.push({ id: 9, owner: 'x@example.org' })
  await capture.snapshot()
  assert.deepEqual(capture.view({}).session.pr.collections.saved_carts.inserted.map(r => r.key), ['[9]'])
  assert.equal(events.length, 4, 'Snapshot now and Re-baseline send no events')
})

test('an inspector that throws, hangs or returns nonsense fails nothing: its pane says why', async () => {
  // open throws for base, returns no probe for pr
  const bad = await readyCapture({ open: role => { if (role === 'base') throw new Error('no route to db'); return { nope: true } } })
  await bad.capture.ready({ signal: bad.signal })
  const v = bad.capture.view({})
  assert.match(v.errors.boot.base, /the inspector's open failed: no route to db/)
  assert.match(v.errors.boot.pr, /the inspector's open gave no probe/)
  assert.deepEqual([v.boot, v.session], [null, null])
  assert.deepEqual(bad.events.map(e => e.ok), [false, false])
  await assert.rejects(bad.capture.snapshot(), { status: 409, message: /neither pane has a probe/ })

  // snapshots that throw, or give no collections
  const broken = await readyCapture({ snapshot: role => { if (role === 'base') throw new Error('relation "x" does not exist'); return 'nonsense' } })
  const w = broken.capture.view({})
  assert.match(w.errors.boot.base, /the seeded snapshot failed: relation "x" does not exist/)
  assert.equal(w.errors.boot.pr, null)
  assert.deepEqual(w.problems.pr, ['the snapshot has no collections object'])
  assert.deepEqual(broken.events.map(e => [e.pane, e.ok]), [['base', false], ['pr', true]])
})

// An incomplete span still flags the pane it has, red, and says it is
// incomplete: the missing pane excuses nothing.
test('a pane with no data leaves the other pane\'s flags, red, with nothing to excuse them', async () => {
  let rows = [{ id: 1, owner: 'a@example.org' }, { id: 2, owner: 'b@example.org' }]
  const { capture, signal } = await readyCapture({
    open: role => {
      if (role === 'base') throw new Error('no route to db')
      return { snapshot: () => ({ collections: carts(rows) }) }
    },
  })
  rows = rows.slice(1) // the PR's migration deletes one
  await capture.ready({ signal })
  const boot = capture.view({ isolation: { verdict: 'isolated' } }).boot
  assert.deepEqual([boot.complete, boot.base, boot.divergence], [false, null, null])
  assert.deepEqual(boot.flags.map(f => [f.collection, f.kind, f.severity, f.shared]), [['saved_carts', 'delete', 'red', false]])
})

// A call that times out is signalled to stop, so retries don't pile up.
test('a hanging open or snapshot times out and is told to stop; a probe that comes too late is closed', async () => {
  let release
  const late = new Promise(resolve => { release = resolve })
  const closed = []
  let running = 0
  const stopped = []
  const { capture } = await readyCapture({
    capture: { limits: { timeoutMs: 20 } },
    open: role => (role === 'base' ? late : {
      snapshot: ({ signal }) => new Promise(() => { running++; signal.addEventListener('abort', () => { running--; stopped.push(signal.reason?.message) }) }),
      close: () => closed.push('pr'),
    }),
  })
  const v = capture.view({})
  assert.match(v.errors.boot.base, /the inspector's open failed: timed out after 20 ms/)
  assert.match(v.errors.boot.pr, /the seeded snapshot failed: timed out after 20 ms/)
  for (let i = 0; i < 3; i++) await capture.snapshot().catch(() => {})
  assert.deepEqual([running, stopped.length], [0, 4], 'each timed-out read was told to stop')
  assert.match(stopped[0], /timed out after 20 ms/)
  release({ snapshot: () => ({ collections: {} }), close: () => closed.push('base') })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(closed, ['base'], 'the late probe is closed, and never used')
  await capture.close()
  assert.deepEqual(closed, ['base', 'pr'])
})

test('an aborted boot calls the inspector no more', async () => {
  const fake = fakeInspector()
  const capture = createDataCapture({ inspector: fake.inspector, rules })
  const ac = new AbortController()
  await capture.seeded({ paneRef: ref('base'), db: seed(), databases: [], signal: ac.signal })
  ac.abort()
  await capture.seeded({ paneRef: ref('pr'), db: seed(), databases: [], signal: ac.signal })
  await capture.ready({ signal: ac.signal })
  assert.deepEqual(fake.calls.map(c => c.slice(0, 2)), [['open', 'base'], ['snapshot', 'base']])
  // an abort while a snapshot runs ends the wait, and tells the read to stop
  let toldToStop = false
  const hung = createDataCapture({ inspector: { open: () => ({ snapshot: ({ signal }) => new Promise(() => { signal.addEventListener('abort', () => { toldToStop = true }) }) }) }, rules })
  const ac2 = new AbortController()
  const pending = hung.seeded({ paneRef: ref('base'), db: null, databases: [], signal: ac2.signal })
  await new Promise(resolve => setImmediate(resolve))
  ac2.abort()
  await pending
  assert.match(hung.view({}).errors.boot.base, /aborted/)
  assert.equal(toldToStop, true)
})

// The review's case: the PR's migration deletes every saved cart, then the
// PR pane's ready read fails. The boot span must still show it.
test('a pane whose ready read failed keeps its S0: its first later snapshot is its baseline, its boot span shows, and its error stays', async () => {
  let failPrReady = true
  let call = 0
  const { capture, signal, stores } = await readyCapture({
    snapshot: (role, _, st) => {
      call++
      if (role === 'pr' && failPrReady && call > 2) throw new Error('timed out')
      return { collections: structuredClone(st[role]) }
    },
  })
  assert.deepEqual(capture.view({}).errors.boot, { base: null, pr: null }, 'both seeded reads worked')
  stores.pr.saved_carts.rows = [] // the PR's migration
  await capture.ready({ signal })
  const before = capture.view({ isolation: { verdict: 'isolated' } })
  assert.match(before.errors.boot.pr, /the ready snapshot failed: timed out; its baseline will be its first later snapshot/)
  assert.deepEqual([before.boot.complete, before.boot.pr], [false, null])
  failPrReady = false
  await capture.snapshot()
  const after = capture.view({ isolation: { verdict: 'isolated' } })
  // its boot span is S0 to that later snapshot, the base pane's S0 to ready: windows that differ
  assert.deepEqual([after.boot.complete, after.boot.aligned, after.boot.pr.collections.saved_carts.status], [false, false, 'changed'])
  assert.deepEqual(after.boot.flags.map(f => [f.kind, f.severity]), [['delete', 'red'], ['emptied', 'red']])
  assert.match(after.errors.boot.pr, /the ready snapshot failed/, 'a later success doesn\'t erase why')
  assert.deepEqual([after.session.complete, after.session.pr], [false, null], 'that snapshot was its baseline, not a comparison')
})

// A failed read never leaves the last one standing in for it, and a
// re-baseline is both panes or neither.
test('a pane whose Snapshot now fails has no session span, not a stale one; a re-baseline is both panes or neither', async () => {
  let failPr = false
  const { capture, signal, stores } = await readyCapture({
    snapshot: (role, _, st) => { if (role === 'pr' && failPr) throw new Error('busy'); return { collections: structuredClone(st[role]) } },
  })
  await capture.ready({ signal })
  await capture.snapshot()
  assert.equal(capture.view({}).session.complete, true)
  stores.pr.saved_carts.rows = []
  failPr = true
  await capture.snapshot()
  const v = capture.view({})
  assert.deepEqual([v.session.complete, v.session.pr, v.session.flags.map(f => f.kind)], [false, null, ['unreadable']])
  assert.match(v.errors.session.pr, /the now snapshot failed: busy/)
  // a re-baseline with one read failing changes no baseline
  const at = v.baselineAt
  await capture.snapshot({ rebaseline: true })
  const r = capture.view({})
  assert.deepEqual([r.baselineAt, r.rebaselined], [at, false])
  assert.match(r.errors.session.pr, /the baseline snapshot failed: busy/)
  failPr = false
  await capture.snapshot()
  const back = capture.view({})
  assert.deepEqual(back.session.flags.map(f => f.kind), ['delete', 'emptied'], 'against the old baseline, not a mismatched one')
  assert.equal(back.errors.session.pr, null)
})

test('close closes each probe once, drops the snapshots, and a snapshot racing it answers 409 at once', async () => {
  const { capture, calls, signal } = await readyCapture()
  await capture.ready({ signal })
  await capture.close()
  await capture.close()
  assert.deepEqual(calls.filter(c => c[0] === 'close').map(c => c[1]), ['base', 'pr'])
  assert.deepEqual(capture.view({}), { available: true, active: true, closed: true })
  await assert.rejects(capture.snapshot(), { status: 409, message: /the session ended/ })
  await capture.seeded({ paneRef: ref('base'), db: seed(), databases: [], signal })
  assert.equal(calls.filter(c => c[0] === 'open').length, 2, 'a closed capture opens nothing')

  const waiting = []
  const slow = createDataCapture({
    inspector: { open: () => ({ snapshot: () => new Promise(resolve => waiting.push(resolve)), close: () => {} }) },
    rules,
    limits: { timeoutMs: 10_000 },
  })
  const answer = async () => {
    while (waiting.length === 0) await new Promise(resolve => setImmediate(resolve))
    waiting.shift()({ collections: {} })
  }
  const seededDone = slow.seeded({ paneRef: ref('base'), db: null, databases: [], signal })
  await answer()
  await seededDone
  const racing = slow.snapshot()
  while (waiting.length === 0) await new Promise(resolve => setImmediate(resolve))
  await slow.close()
  const soon = new Promise((resolve, reject) => setTimeout(() => reject(new Error('still waiting for the probe')), 1_000))
  await assert.rejects(Promise.race([racing, soon]), { status: 409, message: /the session ended/ })
  await answer()
})

test('concurrent snapshots share one run; a re-baseline while one runs answers 409', async () => {
  let runs = 0
  const { capture, signal } = await readyCapture({ snapshot: () => { runs++; return { collections: {} } } })
  await capture.ready({ signal })
  runs = 0
  const [a, b] = [capture.snapshot(), capture.snapshot()]
  const c = capture.snapshot({ rebaseline: true })
  await Promise.all([a, b])
  await assert.rejects(c, { status: 409, message: /a snapshot is already being taken/ })
  assert.equal(runs, 2, 'one per pane')
  await capture.snapshot({ rebaseline: true })
  assert.equal(runs, 4, 'once the first is done, another may start')
})

// One answer lists rows and changes in part, with whole counts, and is
// built once for each state.
test('the view lists at most 50 rows and changes a list, with whole counts; viewJson is built once for each state and trust', async (t) => {
  const many = n => carts(Array.from({ length: n }, (_, i) => ({ id: i + 1, owner: 'o' })))
  let clock = 1_000
  const { capture, signal, stores } = await readyCapture({ snapshot: (role, _, st) => ({ collections: structuredClone(st[role]) }), capture: { now: () => (clock += 1_000) } })
  stores.base = many(120)
  stores.pr = many(120)
  // a seed of 120 rows for both, read at ready
  await capture.ready({ signal })
  stores.pr = many(0)
  await capture.snapshot()
  const v = capture.view({})
  const pr = v.session.pr.collections.saved_carts
  assert.deepEqual([pr.deleted.length, pr.counts.deleted], [50, 120])
  const once = capture.viewJson({})
  const stringify = t.mock.method(JSON, 'stringify')
  assert.equal(capture.viewJson({}), once, 'the same answer')
  assert.equal(stringify.mock.callCount(), 0, 'not built again')
  stringify.mock.restore()
  assert.notEqual(capture.viewJson({ isolation: { verdict: 'isolated' } }), once, 'another trust, another answer')
  assert.equal(capture.viewJson({}), once, 'the answer for this trust again')
  // the same rows read again: only when it was compared changes
  await capture.snapshot()
  assert.notEqual(capture.viewJson({}), once, 'a new snapshot, a new answer')
  assert.deepEqual(JSON.parse(capture.viewJson({})), JSON.parse(JSON.stringify(capture.view({}))))
})

// --- Round 2 of #36's review --------------------------------------------------------

// The review's case: the base pane's ready read fails, the reviewer acts in
// both panes, then takes a snapshot. The base pane's late S1 makes its boot
// span longer than the PR pane's: the two windows differ, so the span says
// so, and nothing in the base's longer window can excuse a PR change.
test('a pane whose S1 came late makes its spans unaligned: incomplete, and nothing excused, even trusted', async () => {
  let failBaseReady = true
  let call = 0
  let clock = 1_000
  const { capture, signal, stores } = await readyCapture({
    snapshot: (role, _, st) => {
      call++
      if (role === 'base' && failBaseReady && call > 2) throw new Error('lock timeout')
      return { collections: structuredClone(st[role]) }
    },
    capture: { now: () => (clock += 1_000) },
  })
  stores.pr.saved_carts.rows = [] // the PR's migration
  await capture.ready({ signal })
  // the reviewer empties the base pane's carts too, before the first snapshot
  stores.base.saved_carts.rows = []
  failBaseReady = false
  await capture.snapshot()
  const v = capture.view({ isolation: { verdict: 'isolated' } })
  assert.deepEqual([v.boot.complete, v.boot.aligned], [false, false])
  assert.deepEqual(v.boot.flags.map(f => [f.kind, f.severity, f.shared]), [['delete', 'red', true], ['emptied', 'red', true]], 'the same change, but over another window: red')
  assert.equal(typeof v.baselines.base, 'number')
  assert.ok(v.baselines.base > v.baselines.pr, 'the base pane\'s baseline is later')
  // its session span is unaligned too, until a re-baseline
  stores.pr.saved_carts.rows = [{ id: 7, owner: 'x' }]
  stores.base.saved_carts.rows = [{ id: 7, owner: 'x' }]
  await capture.snapshot()
  const s = capture.view({ isolation: { verdict: 'isolated' } }).session
  assert.deepEqual([s.complete, s.aligned], [false, false])
  await capture.snapshot({ rebaseline: true })
  stores.pr.saved_carts.rows = []
  stores.base.saved_carts.rows = []
  await capture.snapshot()
  const after = capture.view({ isolation: { verdict: 'isolated' } })
  assert.deepEqual([after.session.complete, after.session.aligned], [true, true])
  assert.deepEqual(after.session.flags.map(f => [f.kind, f.severity]), [['delete', 'amber'], ['emptied', 'amber']])
  assert.deepEqual([after.boot.complete, after.boot.aligned], [false, false], 'a re-baseline never moves the boot span')
})

// #37's review: the PR can make its own read fail (a lock on its database).
// A span with no PR pane then says its changes are unreadable, red, rather
// than listing no flags.
test('a span whose PR pane couldn\'t be read has a red unreadable flag, never no flags', async () => {
  let failPr = false
  const { capture, signal } = await readyCapture({
    snapshot: (role, _, st) => { if (role === 'pr' && failPr) throw new Error('lock timeout'); return { collections: structuredClone(st[role]) } },
  })
  await capture.ready({ signal })
  failPr = true
  await capture.snapshot()
  const v = capture.view({ isolation: { verdict: 'isolated' } })
  assert.deepEqual(v.session.flags, [{ collection: null, kind: 'unreadable', severity: 'red', shared: false, pr: 1, base: 0 }])
  assert.equal(v.session.flagsCount.red, 1)
  // and a boot span whose PR pane has no S0: a hanging open
  const hung = await readyCapture({ capture: { limits: { timeoutMs: 20 } }, open: role => (role === 'pr' ? new Promise(() => {}) : { snapshot: () => ({ collections: {} }) }) })
  await hung.capture.ready({ signal: hung.signal })
  const boot = hung.capture.view({}).boot
  assert.deepEqual([boot.complete, boot.pr, boot.flags.map(f => [f.collection, f.kind, f.severity])], [false, null, [[null, 'unreadable', 'red']]])
})

// The review's case: 100 tables of 1,600 columns added, then dropped. Every
// list an answer gives is cut, within a byte budget per span, with whole
// counts; the flags are listed in part, red first, with their counts.
test('the answer is bounded: field lists, flags and collections are listed in part within each span\'s share, with whole counts', async () => {
  const cols = Array.from({ length: 1_600 }, (_, i) => `column_with_a_rather_long_name_${String(i).padStart(4, '0')}`)
  const tables = (fields, n = 100) => Object.fromEntries(Array.from({ length: n }, (_, t) => [`t${String(t).padStart(3, '0')}`, { key: ['id'], fields: ['id', ...fields], rows: [{ id: 1 }] }]))
  let state = tables([])
  const { capture, signal } = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }) })
  state = tables(cols)
  await capture.ready({ signal })
  state = tables([])
  await capture.snapshot()
  const started = performance.now()
  const json = capture.viewJson({})
  const took = performance.now() - started
  assert.ok(json.length < 8 * 1024 * 1024, `${json.length} bytes`)
  assert.ok(took < 5_000, `${Math.round(took)} ms`)
  const v = JSON.parse(json)
  const t0 = v.boot.pr.collections.t000
  assert.deepEqual([t0.fieldsAdded.length <= 50, t0.counts.fieldsAdded], [true, 1_600])
  assert.equal(v.session.pr.collections.t000.counts.fieldsDropped, 1_600)
  assert.ok(v.session.flags.length <= 500, String(v.session.flags.length))
  assert.deepEqual(v.session.flagsCount, { red: 160_000, amber: 0 })
  // a span's share of the budget is its own: the session lists still show
  assert.ok(v.session.pr.collections.t000.fieldsDropped.length > 0)
})

// One answer's byte budget is per span: the boot span's rows can't empty the
// session span's lists, and a list the budget cut says so.
test('each span has its own share of the byte budget, and a list cut by it says so', async () => {
  let state = { audit: { key: ['id'], rows: [] }, saved: { key: ['id'], rows: [{ id: 1 }, { id: 2 }, { id: 3 }] } }
  const { capture, signal } = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }), capture: { viewBytes: 8_000 } })
  // the PR's migration writes wide rows: the boot span
  state = { ...state, audit: { key: ['id'], rows: Array.from({ length: 50 }, (_, i) => ({ id: i, text: 'w'.repeat(190) })) } }
  await capture.ready({ signal })
  // the reviewer deletes the saved carts: the session span
  state = { ...state, saved: { key: ['id'], rows: [] } }
  await capture.snapshot()
  const v = capture.view({})
  const audit = v.boot.pr.collections.audit
  assert.ok(audit.inserted.length < 50, String(audit.inserted.length))
  assert.deepEqual([audit.counts.inserted, audit.cut], [50, true])
  for (const pane of ['base', 'pr']) assert.deepEqual(v.session[pane].collections.saved.deleted.map(r => r.key), ['[1]', '[2]', '[3]'], pane)
  assert.equal(v.session.pr.collections.saved.cut, undefined, 'not cut')
  assert.deepEqual(v.session.divergence.collections.saved.changes.map(c => c.key), ['[1]', '[2]', '[3]'])
})

// An answer that fails to build is cached too, so every read doesn't build it again.
test('an answer that fails to build is cached as a failure for its state', async (t) => {
  const { capture, signal } = await readyCapture()
  await capture.ready({ signal })
  const stringify = t.mock.method(JSON, 'stringify', () => { throw new RangeError('Invalid string length') })
  assert.throws(() => capture.viewJson({}), RangeError)
  assert.throws(() => capture.viewJson({}), RangeError)
  assert.equal(stringify.mock.callCount(), 1)
  stringify.mock.restore()
})

// errors.boot keeps every reason, and says a boot span is coming only when
// it can: there is an S0.
test('errors.boot keeps the seeded read\'s reason after the ready read fails too, and promises no boot span without an S0', async () => {
  const { capture, signal } = await readyCapture({ snapshot: role => { if (role === 'pr') throw new Error(`relation "saved_carts" does not exist (${role})`); return { collections: {} } } })
  await capture.ready({ signal })
  const why = capture.view({}).errors.boot.pr
  assert.match(why, /^the seeded snapshot failed: relation "saved_carts" does not exist \(pr\); the ready snapshot failed: .+; it has no seeded snapshot, so no boot span$/)
  assert.doesNotMatch(why, /its baseline will be/)
})

// Behaviour the round-1 answer claimed and no test held.
test('a late pane gets its boot span from a re-baseline too, and a re-baseline never moves an earlier boot span', async () => {
  let failPr = true
  let call = 0
  const { capture, signal, stores } = await readyCapture({
    snapshot: (role, _, st) => { call++; if (role === 'pr' && failPr && call > 2) throw new Error('busy'); return { collections: structuredClone(st[role]) } },
  })
  stores.pr.saved_carts.rows.pop()
  await capture.ready({ signal })
  failPr = false
  await capture.snapshot({ rebaseline: true })
  const v = capture.view({})
  assert.equal(v.boot.pr.collections.saved_carts.counts.deleted, 1, 'the late pane\'s boot span, from the re-baseline')
  stores.base.saved_carts.rows.pop()
  await capture.snapshot({ rebaseline: true })
  assert.equal(capture.view({}).boot.base.collections.saved_carts.status, 'same', 'the base pane\'s boot span stays S0 to its ready read')
})

test('the ready event says when a pane\'s ready read failed; an aborted ready changes nothing; open() gets the timed signal', async () => {
  const { capture, events, signal } = await readyCapture({ snapshot: (role, _, st) => { if (role === 'pr' && events.length >= 2) throw new Error('busy'); return { collections: structuredClone(st[role]) } } })
  await capture.ready({ signal })
  assert.deepEqual(events.slice(2), [{ pane: 'base', phase: 'ready', ok: true }, { pane: 'pr', phase: 'ready', ok: false }])

  // aborted while its reads run: nothing of it is kept
  let hold = false
  const aborted = await readyCapture({ snapshot: (role, _, st) => (hold ? new Promise(() => {}) : { collections: structuredClone(st[role]) }) })
  hold = true
  const ac = new AbortController()
  const running = aborted.capture.ready({ signal: ac.signal })
  await new Promise(resolve => setImmediate(resolve))
  ac.abort()
  await running
  const after = aborted.capture.view({})
  assert.deepEqual([after.baselineAt, after.boot, after.errors], [null, null, NO_ERRORS])

  let given = null
  const timed = createDataCapture({ inspector: { open: ({ signal: s }) => { given = s; return new Promise(() => {}) } }, rules, limits: { timeoutMs: 20 } })
  await timed.seeded({ paneRef: ref('base'), db: null, databases: [], signal: new AbortController().signal })
  assert.equal(given.aborted, true)
  assert.match(String(given.reason?.message), /timed out after 20 ms/)
})

// A diff lists at most 1,000 collections, those that changed first.
test('an answer lists at most 1,000 collections a diff, the changed ones first, with the whole count', async () => {
  const names = Array.from({ length: 1_200 }, (_, i) => `c${String(i).padStart(4, '0')}`)
  let state = Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }] }]))
  const { capture, signal } = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }) })
  await capture.ready({ signal })
  // the last five change
  state = { ...state, ...Object.fromEntries(names.slice(-5).map(n => [n, { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }])) }
  await capture.snapshot()
  const pr = capture.view({}).session.pr
  assert.equal(Object.keys(pr.collections).length, 1_000)
  assert.equal(pr.collectionsCount, 1_200)
  for (const name of names.slice(-5)) assert.equal(pr.collections[name].status, 'changed', name)
  const div = capture.view({}).session.divergence
  assert.deepEqual([Object.keys(div.collections).length, div.collectionsCount], [1_000, 1_200])
  assert.equal(div.collections.c1199.status, 'both')
})

test('flagsCount counts each severity, whatever is listed', async () => {
  const { capture, signal, stores } = await readyCapture()
  await capture.ready({ signal })
  stores.base.saved_carts.rows = []
  stores.pr.saved_carts.rows = []
  await capture.snapshot()
  assert.deepEqual(capture.view({ isolation: { verdict: 'isolated' } }).session.flagsCount, { red: 0, amber: 2 })
  assert.deepEqual(capture.view({}).session.flagsCount, { red: 2, amber: 0 })
})

// The flags listed are the red first: 600 amber ones before a red one in
// name order still leave the red one listed.
test('a span lists its red flags first, so the cap never hides one behind amber ones', async () => {
  const names = Array.from({ length: 600 }, (_, i) => `a${String(i).padStart(3, '0')}`)
  const two = { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }
  const one = { key: ['id'], rows: [{ id: 1 }] }
  let base = { ...Object.fromEntries(names.map(n => [n, two])), z: two }
  let pr = base
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }) })
  await capture.ready({ signal })
  // both panes delete a row of each a…; the PR alone one of z
  base = { ...Object.fromEntries(names.map(n => [n, one])), z: two }
  pr = { ...Object.fromEntries(names.map(n => [n, one])), z: one }
  await capture.snapshot()
  const s = capture.view({ isolation: { verdict: 'isolated' } }).session
  assert.deepEqual(s.flagsCount, { red: 1, amber: 600 })
  assert.equal(s.flags.length, 500)
  assert.deepEqual([s.flags[0].collection, s.flags[0].severity], ['z', 'red'])
})
