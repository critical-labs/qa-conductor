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
  // once ready has run, a span with neither pane's data says so, red
  assert.deepEqual([v.boot.complete, v.boot.base, v.boot.pr, v.boot.flags.map(f => [f.kind, f.reason]), v.boot.flagsCount], [false, null, null, [['unreadable', 'neither']], { red: 1, amber: 0 }])
  assert.equal(v.session, null)
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
  assert.match(after.errors.boot.pr, /; its baseline is the snapshot at \d{4}-\d\d-\d\dT[\d:.]+Z$/, 'and says the baseline came')
  assert.doesNotMatch(after.errors.boot.pr, /will be/)
  assert.deepEqual([after.session.complete, after.session.pr], [false, null], 'that snapshot was its baseline, not a comparison')
  assert.deepEqual(after.session.flags.map(f => [f.kind, f.severity, f.reason]), [['unreadable', 'red', 'baseline']], 'red, but not for a read that failed')
  // the next snapshot compares
  await capture.snapshot()
  assert.equal(capture.view({}).session.pr.collections.saved_carts.status, 'same')
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
  assert.deepEqual(v.session.flags, [{ collection: null, kind: 'unreadable', severity: 'red', shared: false, pr: 1, base: 0, reason: 'failed' }])
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
  // about 1.1 s alone; room for a full suite running beside it
  assert.ok(took < 10_000, `${Math.round(took)} ms`)
  const v = JSON.parse(json)
  const t0 = v.boot.pr.collections.t000
  assert.deepEqual([t0.fieldsAdded.length <= 50, t0.counts.fieldsAdded], [true, 1_600])
  assert.equal(v.session.pr.collections.t000.counts.fieldsDropped, 1_600)
  // one column-dropped flag a table (#35), with its count
  assert.deepEqual(v.session.flagsCount, { red: 100, amber: 0 })
  assert.ok(v.session.flags.every(f => f.kind === 'column-dropped' && f.count === 1_600))
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
test('an answer that fails to build, even without its lists, is cached as a failure for its state', async (t) => {
  const { capture, signal } = await readyCapture()
  await capture.ready({ signal })
  const stringify = t.mock.method(JSON, 'stringify', () => { throw new RangeError('Invalid string length') })
  assert.throws(() => capture.viewJson({}), RangeError)
  assert.throws(() => capture.viewJson({}), RangeError)
  assert.equal(stringify.mock.callCount(), 2, 'once with its lists, once without, and then not again')
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
  assert.deepEqual([v.boot.aligned, v.boot.complete], [false, false], 'its window ends later than the base pane\'s')
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

// --- Round 3 of #36's review --------------------------------------------------------

// The review's first medium: each listed collection's name and key weren't
// charged to the budget, so wide keys made the answer hundreds of MB, or
// too big to build at all. Now each entry is charged, the listing stops
// when the budget runs out and says so, and #35 caps keys and names.
test('wide keys can\'t make the answer big: each collection\'s entry counts against the budget, and listing stops, said so', async () => {
  const keyOf = t => Array.from({ length: 32 }, (_, i) => `${String(t).padStart(3, '0')}_${'k'.repeat(190)}_${i}`)
  const tables = n => Object.fromEntries(Array.from({ length: n }, (_, t) => [`t${String(t).padStart(3, '0')}_${'n'.repeat(190)}`, { key: keyOf(t), rows: [] }]))
  let state = {}
  const { capture, signal } = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }) })
  state = tables(1_000) // the PR's migration: 1,000 empty tables with 32-field keys of 200-character names
  await capture.ready({ signal })
  await capture.snapshot()
  const json = capture.viewJson({})
  assert.ok(json.length < 4.5 * 1024 * 1024, `${json.length} characters`)
  const v = JSON.parse(json)
  assert.equal(v.boot.pr.collectionsCount, 1_000)
  assert.ok(Object.keys(v.boot.pr.collections).length < 1_000)
  assert.equal(v.boot.pr.cut, true, 'the listing stopped, said so')
  // a key of more than 32 fields, or a name over 200 characters, never
  // reaches the answer at all (#35)
  state = { wide: { key: Array.from({ length: 2_000 }, (_, i) => `c${i}`), rows: [] }, ['x'.repeat(2_000)]: { key: ['id'], rows: [] } }
  await capture.snapshot()
  const w = capture.view({})
  assert.deepEqual(w.problems.pr, ['1 collection with a name over 200 characters was left out', 'wide: a key of 2000 fields is more than 32, so its rows are compared without one'])
})

// An answer still too big to build is built again without its lists: the
// badge still counts, and the first red flags still show.
test('an answer too big to build falls back to one without lists: its counts, its first red flags and a red unlisted flag', async (t) => {
  const { capture, signal, stores } = await readyCapture()
  stores.pr.saved_carts.rows = [] // the PR's migration
  await capture.ready({ signal })
  const real = JSON.stringify
  const stringify = t.mock.method(JSON, 'stringify', (value, ...rest) => {
    if (value && value.available && value.boot && !value.boot.unlisted) throw new RangeError('Invalid string length')
    return real(value, ...rest)
  })
  const v = JSON.parse(capture.viewJson({}))
  stringify.mock.restore()
  assert.deepEqual([v.boot.unlisted, v.boot.base, v.boot.pr, v.boot.divergence], [true, null, null, null])
  assert.deepEqual(v.boot.flags.map(f => [f.collection, f.kind, f.severity]), [[null, 'unlisted', 'red'], ['saved_carts', 'delete', 'red'], ['saved_carts', 'emptied', 'red']])
  assert.deepEqual(v.boot.flagsCount, { red: 3, amber: 0 })
  assert.deepEqual(v.errors, NO_ERRORS)
})

// The review's second medium: the PR's migration deletes 15 of 20 users and
// adds 10,999 empty tables that sort first. The user's flags, and users
// itself, must be in the answer.
test('10,999 padding tables can\'t push a real delete out of the answer: its flags lead, and users is listed in the diff and divergence', async () => {
  const users = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `u${i}` })) })
  const base = { users: users(20) }
  let pr = base
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }) })
  const padding = Object.fromEntries(Array.from({ length: 10_999 }, (_, i) => [`a${String(i).padStart(5, '0')}`, { key: ['id'], rows: [] }]))
  pr = { ...padding, users: { key: ['id'], rows: users(20).rows.slice(15) } }
  await capture.ready({ signal })
  const boot = capture.view({}).boot
  assert.deepEqual(boot.flags.slice(0, 2).map(f => [f.collection, f.kind, f.severity]), [['users', 'delete', 'red'], ['users', 'mass-change', 'red']])
  assert.equal(boot.pr.collections.users.counts.deleted, 15)
  assert.equal(boot.divergence.collections.users.status, 'pr-only')
  assert.equal(boot.base.collections.users.status, 'same')
  // the padding's own flag: one, for the collections only the PR pane has
  assert.deepEqual(boot.flagsCount, { red: 3, amber: 0 })
  assert.deepEqual([boot.flags[2].collection, boot.flags[2].kind, boot.flags[2].collections], [null, 'unverified', 10_000])
})

// Past 20 red unverified flags of named collections, the rest are one.
test('red unverified flags past 20 are folded into one, in their place, with how many and the first five names', async () => {
  const names = Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, '0')}`)
  const base = Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }] }]))
  // the PR pane has a table of its own too
  let pr = { ...base, tmp: { key: ['id'], rows: [] } }
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }), capture: { limits: { maxRows: 1 } } })
  await capture.ready({ signal })
  // the PR alone writes a second row to each: cut short in its pane only;
  // and it drops its own table, a red flag the engine lists after them
  pr = Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }]))
  await capture.snapshot()
  const s = capture.view({}).session
  assert.equal(s.flagsCount.red, 31)
  assert.deepEqual(s.flags.slice(0, 20).map(f => f.collection), names.slice(0, 20))
  assert.deepEqual(s.flags[20], { collection: null, kind: 'unverified', severity: 'red', shared: false, pr: 10, base: 0, collections: 10, names: names.slice(20, 25), folded: true })
  assert.deepEqual([s.flags[21].collection, s.flags[21].kind], ['tmp', 'dropped'], 'the fold stands where the folded ones were')
  assert.equal(s.flags.length, 22)
})

// Changed rows rank before an amber flag: 1,050 collections cut short alike
// in both panes (amber) can't push out a collection whose rows changed.
test('a diff lists changed rows before collections with only an amber flag', async () => {
  const names = Array.from({ length: 1_050 }, (_, i) => `a${String(i).padStart(4, '0')}`)
  let state = { ...Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }])), zz: { key: ['id'], rows: [] } }
  const { capture, signal } = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }), capture: { limits: { maxRows: 1, maxCollections: 2_000 } } })
  await capture.ready({ signal })
  state = { ...state, zz: { key: ['id'], rows: [{ id: 1 }] } }
  await capture.snapshot()
  const s = capture.view({}).session
  assert.equal(s.flagsCount.amber, 1_050)
  assert.equal(s.pr.collections.zz.counts.inserted, 1)
  assert.equal(Object.keys(s.pr.collections)[0], 'zz')
})

// A flagged collection is listed before one that only changed.
test('a diff lists its flagged collections first, before ones that only changed', async () => {
  const names = Array.from({ length: 1_050 }, (_, i) => `a${String(i).padStart(4, '0')}`)
  let state = { ...Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [] }])), zz: { key: ['id'], rows: [{ id: 1 }, { id: 2 }] } }
  const { capture, signal } = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }), capture: { limits: { maxCollections: 2_000 } } })
  await capture.ready({ signal })
  // both panes insert a row in each a… and delete one of zz's: advisory, red
  state = { ...Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }] }])), zz: { key: ['id'], rows: [{ id: 1 }] } }
  await capture.snapshot()
  const s = capture.view({}).session
  assert.equal(s.pr.collections.zz.counts.deleted, 1)
  assert.equal(Object.keys(s.pr.collections)[0], 'zz')
  assert.deepEqual([Object.keys(s.pr.collections).length, s.pr.collectionsCount], [1_000, 1_051])
  assert.equal(s.divergence.collections.zz.status, 'both')
})

// The review's first low: both panes' ready reads fail, so both take their
// baseline from one Snapshot now. Their boot spans then run past ready, into
// the session, and the base's action there must not excuse the PR's migration.
test('when both ready reads fail, the boot span is unaligned, so nothing in it is excused, and baselineAt stays unset', async () => {
  let failReady = true
  let call = 0
  const { capture, signal, stores } = await readyCapture({
    snapshot: (role, _, st) => { call++; if (failReady && call > 2) throw new Error('lock timeout'); return { collections: structuredClone(st[role]) } },
  })
  stores.pr.saved_carts.rows = [] // the PR's migration
  await capture.ready({ signal })
  assert.equal(capture.view({}).baselineAt, null, 'no pane has a baseline from ready')
  stores.base.saved_carts.rows = [] // the reviewer's mirrored action
  failReady = false
  await capture.snapshot()
  const v = capture.view({ isolation: { verdict: 'isolated' } })
  assert.deepEqual([v.boot.aligned, v.boot.complete], [false, false])
  assert.deepEqual(v.boot.flags.map(f => [f.kind, f.severity]), [['delete', 'red'], ['emptied', 'red']])
  assert.equal(v.baselineAt, null)
  assert.equal(v.baselines.base, v.baselines.pr)
})

// The review's second low: neither pane could be read for a span after a
// snapshot. It is a span with a red flag, not null.
test('a span neither pane could be read for, after a snapshot, is unreadable and red, not null', async () => {
  let hang = false
  const { capture, signal } = await readyCapture({
    capture: { limits: { timeoutMs: 20 } },
    snapshot: (role, _, st) => (hang ? new Promise(() => {}) : { collections: structuredClone(st[role]) }),
  })
  await capture.ready({ signal })
  hang = true
  await capture.snapshot()
  const s = capture.view({}).session
  assert.deepEqual([s.complete, s.base, s.pr, s.divergence, s.flags.map(f => [f.kind, f.severity, f.reason]), s.flagsCount], [false, null, null, null, [['unreadable', 'red', 'neither']], { red: 1, amber: 0 }])
})

// Mutants round 3 let live: the divergence's own cut and count, and every
// list counted against its span's half of the budget.
test('a divergence lists 50 changes with the whole changesCount, and every list, divergence and flags too, stays within its span\'s half', async () => {
  const many = n => carts(Array.from({ length: n }, (_, i) => ({ id: i + 1, owner: 'o' })))
  const { capture, signal, stores } = await readyCapture()
  stores.base = many(120)
  stores.pr = many(120)
  await capture.ready({ signal })
  stores.base = many(0)
  stores.pr = many(0)
  await capture.snapshot()
  const d = capture.view({}).session.divergence.collections.saved_carts
  assert.deepEqual([d.changes.length, d.changesCount, d.cut], [50, 120, undefined])

  // a span's lists, its divergence's among them, within half of viewBytes
  const size = span => JSON.stringify({ flags: span.flags, base: span.base, pr: span.pr, divergence: span.divergence }).length
  let state = { wide: { key: ['id'], rows: [] } }
  const wide = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }), capture: { viewBytes: 40_000 } })
  state = { wide: { key: ['id'], rows: Array.from({ length: 50 }, (_, i) => ({ id: i, text: 'w'.repeat(190) })) } }
  await wide.capture.ready({ signal: wide.signal })
  const boot = wide.capture.view({}).boot
  assert.ok(size(boot) <= 20_000 + 500, String(size(boot)))
  assert.equal(boot.pr.collections.wide.counts.inserted, 50)
  const dw = boot.divergence.collections.wide
  assert.deepEqual([dw.changesCount, dw.cut, dw.changes.length < 50], [50, true, true])

  // flags count against it too
  const names = Array.from({ length: 300 }, (_, i) => `c${String(i).padStart(3, '0')}`)
  let fl = Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }]))
  const flagged = await readyCapture({ snapshot: () => ({ collections: structuredClone(fl) }), capture: { viewBytes: 40_000 } })
  fl = Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }] }]))
  await flagged.capture.ready({ signal: flagged.signal })
  const fb = flagged.capture.view({}).boot
  assert.equal(fb.flagsCount.red, 300)
  assert.ok(fb.flags.length < 300, String(fb.flags.length))
  assert.ok(size(fb) <= 20_000 + 500, String(size(fb)))
  assert.equal(fb.pr.cut, true)
})

// A pane's problems are listed in part, with their count.
test('an answer lists at most 50 problems a pane, with the whole count; an error\'s text is cut at 500 characters', async () => {
  const bad = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`b${String(i).padStart(2, '0')}`, { rows: 'x' }]))
  const { capture, signal } = await readyCapture({ snapshot: role => { if (role === 'base') throw new Error('e'.repeat(2_000)); return { collections: bad } } })
  await capture.ready({ signal })
  const v = capture.view({})
  assert.deepEqual([v.problems.pr.length, v.problemsCount.pr, v.problemsCount.base], [50, 80, 0])
  assert.match(v.errors.boot.base, /^the seeded snapshot failed: e{500}…;/)
  assert.doesNotMatch(v.errors.boot.base, /e{501}/)
})

// --- Round 4 of #36's review --------------------------------------------------------

// The review's first medium: 600 renamed columns on earlier-named seeded
// tables pushed the users delete out of the 500 flags listed.
test('a delete is listed before column and mass-change flags, and its collection before theirs, within and past the caps', async () => {
  const cols = prefix => Array.from({ length: 30 }, (_, i) => `${prefix}${i}`)
  const tables = prefix => Object.fromEntries(Array.from({ length: 20 }, (_, t) => [`a${String(t).padStart(3, '0')}`, { key: ['id'], fields: ['id', ...cols(prefix)], rows: [{ id: 1 }] }]))
  const users = n => ({ key: ['id'], fields: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const base = { ...tables('old_'), users: users(20) }
  let pr = base
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }), capture: { viewBytes: 200_000 } })
  pr = { ...tables('new_'), users: users(5) } // the PR's migration
  await capture.ready({ signal })
  const boot = capture.view({}).boot
  // 20 column-dropped flags (one a table, #35), and users's delete and
  // mass-change
  assert.equal(boot.flagsCount.red, 22)
  assert.deepEqual([boot.flags[0].collection, boot.flags[0].kind], ['users', 'delete'])
  assert.equal(Object.keys(boot.pr.collections)[0], 'users', 'its rows listed first')
  // the engine's fieldsBefore isn't listed
  assert.equal(Object.hasOwn(boot.pr.collections.users, 'fieldsBefore'), false)
  // and in the answer too big to build: among the first red flags
  const fallback = capture.view({}, { lists: false }).boot
  assert.deepEqual([fallback.flags[1].collection, fallback.flags[1].kind], ['users', 'delete'])
  assert.deepEqual([fallback.flags.length, fallback.flags.every(f => f.severity === 'red')], [21, true], 'only red flags, at most 20 after the unlisted one')
})

// The review's second shape: 100 seeded tables with 6 renamed columns each
// and a rewritten text column (a mass change), beside a users delete, left
// users out of every list.
test('a delete beside 100 tables with renamed columns and a rewritten text column leads the flags and every list', async () => {
  const rows = (text, n = 30) => Array.from({ length: n }, (_, i) => ({ id: i + 1, text }))
  const tables = (prefix, text) => Object.fromEntries(Array.from({ length: 100 }, (_, t) => [`a${String(t).padStart(3, '0')}`, { key: ['id'], fields: ['id', 'text', ...Array.from({ length: 6 }, (_, i) => `${prefix}${i}`)], rows: rows(text) }]))
  const users = n => ({ key: ['id'], fields: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const base = { ...tables('old_', 'x'.repeat(100)), users: users(20) }
  let pr = base
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }) })
  pr = { ...tables('new_', 'y'.repeat(100)), users: users(5) }
  await capture.ready({ signal })
  const boot = capture.view({}).boot
  assert.equal(boot.flagsCount.red, 202)
  assert.deepEqual([boot.flags[0].collection, boot.flags[0].kind], ['users', 'delete'])
  assert.equal(Object.keys(boot.pr.collections)[0], 'users')
  assert.equal(boot.pr.collections.users.counts.deleted, 15)
  assert.equal(Object.keys(boot.divergence.collections)[0], 'users')
  const fallback = capture.view({}, { lists: false }).boot
  assert.deepEqual([fallback.flags[1].collection, fallback.flags[1].kind], ['users', 'delete'])
})

// The review's second medium: 1,000 tables the PR made at boot and drops in
// the session ranked with users by name, and pushed its rows out.
test('a seeded collection\'s flagged rows are listed before the PR\'s own flagged tables, in the diff and the divergence', async () => {
  const users = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const base = { users: users(20) }
  const padding = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`a${String(i).padStart(5, '0')}`, users(2)]))
  let pr = base
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }), capture: { limits: { maxCollections: 2_000 } } })
  pr = { ...base, ...padding } // the PR's migration
  await capture.ready({ signal })
  pr = { users: users(5) } // the session drops them, and deletes users
  await capture.snapshot()
  const s = capture.view({ isolation: { verdict: 'isolated' } }).session
  assert.equal(s.flagsCount.red, 1_002)
  assert.equal(Object.keys(s.pr.collections)[0], 'users')
  assert.equal(s.pr.collections.users.counts.deleted, 15)
  assert.equal(Object.keys(s.divergence.collections)[0], 'users')
  assert.equal(s.divergence.collections.users.status, 'pr-only')
})

// A low: the PR diff's padding no longer starves the divergence's and the
// base diff's flagged entries: the lists go by rank across all three.
test('the lists go by rank across the PR diff, the divergence and the base diff, so padding in one can\'t starve another\'s flagged entry', async () => {
  // round 5's shape: the PR deletes 15 of 20 users while 45 of its own wide
  // tables (50 rows of 200 characters) are emptied: all red, and their rows
  // fill the span's budget many times over
  const users = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const wide = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, text: 'w'.repeat(200) }))
  const own = rows => Object.fromEntries(Array.from({ length: 45 }, (_, t) => [`a${String(t).padStart(2, '0')}`, { key: ['id'], rows }]))
  const base = { users: users(20) }
  let pr = base
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }), capture: { viewBytes: 200_000 } })
  pr = { ...base, ...own(wide) }
  await capture.ready({ signal })
  pr = { ...own([]), users: users(5) }
  await capture.snapshot()
  const s = capture.view({}).session
  for (const list of ['pr', 'divergence', 'base']) assert.ok(Object.hasOwn(s[list].collections, 'users'), `${list} lists users`)
  assert.equal(s.pr.cut, true, 'the PR\'s own tables are what got cut')
  assert.equal(Object.keys(s.pr.collections).length < 46, true)
  // a list that listed everything says no cut, though another was cut
  assert.equal(s.base.cut, undefined)

  // the same with the wide tables seeded (zNN: after users by name), all
  // in the first tier: users's entry in each list still comes before any
  // wide table's, though its first flag isn't the first
  const seededWide = Object.fromEntries(Array.from({ length: 45 }, (_, t) => [`z${String(t).padStart(2, '0')}`, { key: ['id'], rows: wide }]))
  const base2 = { users: users(20), ...seededWide }
  let pr2 = base2
  const two = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base2 : pr2) }), capture: { viewBytes: 200_000 } })
  await two.capture.ready({ signal: two.signal })
  pr2 = { users: users(5), ...Object.fromEntries(Object.keys(seededWide).map(n => [n, { key: ['id'], rows: [] }])) }
  await two.capture.snapshot()
  const s2 = two.capture.view({}).session
  for (const list of ['pr', 'divergence', 'base']) assert.equal(Object.keys(s2[list].collections)[0], 'users', list)
  assert.equal(s2.pr.cut, true)
})

// A low: the budget is in bytes, not characters: text outside ASCII takes
// up to three bytes a character.
test('the budget counts bytes: an answer of non-ASCII text stays within it', async () => {
  // 60 tables of 50 rows of 200 characters, three bytes each in UTF-8: far
  // more than a span's 100,000 bytes, whatever is counted
  const text = '数据'.repeat(100)
  const tables = rows => Object.fromEntries(Array.from({ length: 60 }, (_, t) => [`t${String(t).padStart(2, '0')}`, { key: ['id'], rows }]))
  let state = tables([])
  const { capture, signal } = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }), capture: { viewBytes: 200_000 } })
  state = tables(Array.from({ length: 50 }, (_, id) => ({ id, text })))
  await capture.ready({ signal })
  const json = capture.viewJson({})
  assert.ok(Buffer.byteLength(json) < 200_000 + 20_000, `${Buffer.byteLength(json)} bytes`)
})

// The nit: the reason says what happened to the PR pane first.
test('the unreadable flag\'s reason is the PR pane\'s: baseline when both panes\' baselines came from this snapshot, failed when only the base was read', async () => {
  let failReady = true
  let failBase = false
  let call = 0
  const { capture, signal } = await readyCapture({
    snapshot: (role, _, st) => {
      call++
      if (failReady && call > 2) throw new Error('lock timeout')
      if (failBase && role === 'base') throw new Error('busy')
      return { collections: structuredClone(st[role]) }
    },
  })
  await capture.ready({ signal })
  failReady = false
  await capture.snapshot() // both baselines from this snapshot
  assert.deepEqual(capture.view({}).session.flags.map(f => [f.kind, f.reason]), [['unreadable', 'baseline']])
})

// Mutants round 4 let live.
test('the flags are listed before the lists; the divergence ranks counts-only changes and says when it was cut; an empty added collection ranks before unchanged ones', async () => {
  // a span whose lists would fill the budget still lists its flags (M28)
  const names = Array.from({ length: 300 }, (_, i) => `c${String(i).padStart(3, '0')}`)
  let fl = Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1, text: 'w'.repeat(150) }, { id: 2, text: 'w'.repeat(150) }] }]))
  const flagged = await readyCapture({ snapshot: () => ({ collections: structuredClone(fl) }), capture: { viewBytes: 60_000 } })
  fl = Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1, text: 'w'.repeat(150) }] }]))
  await flagged.capture.ready({ signal: flagged.signal })
  const fb = flagged.capture.view({}).boot
  assert.ok(fb.flags.length >= 100, String(fb.flags.length))
  // the divergence: a collection whose counts alone moved (cut short) ranks
  // before unchanged padding (M22, M23), and says cut when it stops (M4)
  const padding = Object.fromEntries(Array.from({ length: 1_050 }, (_, i) => [`a${String(i).padStart(4, '0')}`, { key: ['id'], rows: [{ id: 1 }] }]))
  let state = { ...padding, zz: { key: ['id'], rows: [1, 2, 3].map(id => ({ id })), count: 9, truncated: true } }
  const div = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }), capture: { limits: { maxCollections: 2_000 } } })
  await div.capture.ready({ signal: div.signal })
  state = { ...padding, zz: { key: ['id'], rows: [1, 2, 3].map(id => ({ id })), count: 7, truncated: true } }
  await div.capture.snapshot()
  const d = div.capture.view({ isolation: { verdict: 'isolated' } }).session
  assert.equal(Object.keys(d.divergence.collections)[0], 'zz')
  const small = await readyCapture({ snapshot: () => ({ collections: structuredClone(state) }), capture: { limits: { maxCollections: 2_000 }, viewBytes: 20_000 } })
  await small.capture.ready({ signal: small.signal })
  state = { ...padding, zz: { key: ['id'], rows: [1, 2, 3].map(id => ({ id })), count: 9, truncated: true } }
  await small.capture.snapshot()
  assert.equal(small.capture.view({}).session.divergence.cut, true)
  // an empty added collection ranks before unchanged ones past 1,000 (M18)
  let st = { ...padding }
  const ranks = await readyCapture({ snapshot: () => ({ collections: structuredClone(st) }), capture: { limits: { maxCollections: 2_000 } } })
  await ranks.capture.ready({ signal: ranks.signal })
  st = { ...padding, zz_added: { key: ['id'], rows: [] } }
  await ranks.capture.snapshot()
  assert.ok(Object.hasOwn(ranks.capture.view({ isolation: { verdict: 'isolated' } }).session.pr.collections, 'zz_added'))
  // past 1,050 collections with only an amber flag (cut short alike in both
  // panes), a collection whose fields alone changed (M24, M25), and one
  // whose divergence moved only in its counts (M22, M23), rank as changed
  const amber = Object.fromEntries(Array.from({ length: 1_050 }, (_, i) => [`a${String(i).padStart(4, '0')}`, { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }]))
  let at = { ...amber, zz_fields: { key: ['id'], fields: ['id'], rows: [{ id: 1 }] }, zz_bag: { key: null, rows: [] } }
  const moved = await readyCapture({ snapshot: () => ({ collections: structuredClone(at) }), capture: { limits: { maxCollections: 2_000, maxRows: 1 } } })
  await moved.capture.ready({ signal: moved.signal })
  at = { ...amber, zz_fields: { key: ['id'], fields: ['id', 'b'], rows: [{ id: 1 }] }, zz_bag: { key: null, rows: [{ v: 1 }] } }
  await moved.capture.snapshot()
  const m = moved.capture.view({ isolation: { verdict: 'isolated' } }).session
  assert.equal(m.flagsCount.amber, 1_050)
  assert.ok(Object.hasOwn(m.pr.collections, 'zz_fields'), 'fields alone changed')
  assert.ok(Object.hasOwn(m.divergence.collections, 'zz_bag'), 'counts alone moved')
})

test('the PR-only summary keeps its count past 20 folded flags; one pane\'s failed ready read still sets baselineAt', async () => {
  // 25 named unverified flags and the PR-only summary (M30)
  const names = Array.from({ length: 25 }, (_, i) => `c${String(i).padStart(2, '0')}`)
  const base = Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }] }]))
  let pr = base
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }), capture: { limits: { maxRows: 1 } } })
  await capture.ready({ signal })
  pr = { ...Object.fromEntries(names.map(n => [n, { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }])), own1: { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }, own2: { key: ['id'], rows: [{ id: 1 }, { id: 2 }] } }
  await capture.snapshot()
  const flags = capture.view({}).session.flags
  const summary = flags.find(f => f.collection === null && !f.folded)
  assert.deepEqual([summary.collections, summary.names], [2, ['own1', 'own2']])
  assert.equal(flags.find(f => f.folded).collections, 5)
  // M44
  let failPr = false
  const one = await readyCapture({ snapshot: (role, _, st) => { if (role === 'pr' && failPr) throw new Error('busy'); return { collections: structuredClone(st[role]) } } })
  failPr = true
  await one.capture.ready({ signal: one.signal })
  assert.equal(typeof one.capture.view({}).baselineAt, 'number')
})

// --- Round 5 of #36's review --------------------------------------------------------

const people = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, email: `u${i}@example.org` })) })
const ownTables = (n, rows) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${String(i).padStart(4, '0')}`, { key: ['id'], rows: Array.from({ length: rows }, (_, j) => ({ id: j + 1 })) }]))

// The review's second medium: a span with no base diff (the base pane's
// read failed, or its baseline came late) took every collection for the
// PR's own, so the PR's 1,000 dropped tables hid users's delete.
test('without a base diff, a seeded collection is still told from the PR\'s own: its flags, lists and fallback come first', async () => {
  // which of the base pane's reads fail; whether the PR's tables were there
  // before its seed (so its boot span doesn't show them added)
  const shapes = {
    'base read failed': { boot: false, now: true, older: false },
    'base read failed, the PR\'s tables older than its seed': { boot: false, now: true, older: true },
    'base baseline late': { boot: true, now: false, older: false },
    'base never read': { boot: true, now: true, older: false },
  }
  for (const [shape, { boot, now, older }] of Object.entries(shapes)) {
    const base = { users: people(20) }
    let pr = { users: people(20), ...(older ? ownTables(1_000, 2) : {}) }
    let failBase = boot
    const { capture, signal } = await readyCapture({
      snapshot: role => {
        if (role === 'base' && failBase) throw new Error('lock timeout')
        return { collections: structuredClone(role === 'base' ? base : pr) }
      },
      capture: { limits: { maxCollections: 2_000 } },
    })
    pr = { users: people(20), ...ownTables(1_000, 2) }
    await capture.ready({ signal })
    failBase = now
    pr = { users: people(5) }
    await capture.snapshot()
    const s = capture.view({}).session
    assert.equal(s.base, null, shape)
    assert.equal(s.flagsCount.red, 1_002, shape)
    assert.deepEqual([s.flags[0].collection, s.flags[0].kind], ['users', 'delete'], shape)
    assert.equal(Object.keys(s.pr.collections)[0], 'users', shape)
    const fallback = capture.view({}, { lists: false }).session
    assert.deepEqual([fallback.flags[1].collection, fallback.flags[1].kind], ['users', 'delete'], shape)
  }
})

// The review's third medium: an amber-only seeded collection (a cleared
// field) was pushed out of every list by the PR's own red tables.
test('an amber-only seeded collection is listed before the PR\'s own red tables, in the flags and every list', async () => {
  const base = { users: people(20) }
  let pr = { users: people(20) }
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }), capture: { limits: { maxCollections: 2_000 }, viewBytes: 200_000 } })
  pr = { users: people(20), ...ownTables(1_000, 2) }
  await capture.ready({ signal })
  const cleared = people(20)
  for (const r of cleared.rows.slice(0, 4)) r.email = null
  pr = { users: cleared }
  await capture.snapshot()
  const s = capture.view({}).session
  assert.deepEqual(s.flagsCount, { red: 1_000, amber: 1 })
  assert.deepEqual([s.flags[0].collection, s.flags[0].kind, s.flags[0].severity], ['users', 'cleared', 'amber'])
  assert.equal(Object.keys(s.pr.collections)[0], 'users')
  assert.equal(Object.keys(s.divergence.collections)[0], 'users')
  // the base pane's users, unchanged there, still comes before the PR's
  // own red tables, which overrun the budget
  assert.deepEqual(Object.keys(s.base.collections), ['users'])
  assert.equal(s.pr.cut, true)
})

// A low: key-lost flags on many seeded tables sorted with the deletes.
test('what loses rows is listed before a lost key, among the seeded collections', async () => {
  const keyed = key => Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${String(i).padStart(3, '0')}`, { key: [key], rows: [{ id: 1, uuid: 'a' }, { id: 2, uuid: 'a' }] }]))
  const base = { ...keyed('id'), users: people(20) }
  let pr = base
  const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base : pr) }) })
  pr = { ...keyed('uuid'), users: people(5) } // the PR's migration
  await capture.ready({ signal })
  const boot = capture.view({}).boot
  assert.ok(boot.flags.some(f => f.kind === 'key-lost'))
  assert.deepEqual([boot.flags[0].collection, boot.flags[0].kind], ['users', 'delete'])
  assert.equal(Object.keys(boot.pr.collections)[0], 'users')

  // a seeded collection the PR's snapshot cut short where the base pane's
  // isn't stands with what loses rows too: before a lost key
  const small = { key: ['id'], rows: [{ id: 1, uuid: 'a' }, { id: 2, uuid: 'a' }] }
  const base2 = { aa: small, zz: small }
  let pr2 = base2
  const two = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? base2 : pr2) }), capture: { limits: { maxRows: 5 } } })
  pr2 = { aa: { ...small, key: ['uuid'] }, zz: { key: ['id'], rows: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, uuid: 'a' })) } }
  await two.capture.ready({ signal: two.signal })
  const flags2 = two.capture.view({}).boot.flags.map(f => [f.collection, f.kind])
  assert.deepEqual(flags2, [['zz', 'unverified'], ['aa', 'key-lost']])
})

// The review's surviving mutants, M11 and M24.
test('the fallback lists red flags only; a collection whose key alone was lost ranks with changed rows', async () => {
  // M11: a span with red and amber flags lists only the red in its fallback
  const two = rows => ({ orders: { key: ['id'], rows }, carts: { key: ['id'], rows } })
  let baseState = two([{ id: 1 }, { id: 2 }])
  let prState = { ...baseState, own: { key: ['id'], rows: [{ id: 1 }, { id: 2 }] } }
  const mixed = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? baseState : prState) }) })
  await mixed.capture.ready({ signal: mixed.signal })
  // the same deletes in both panes (amber, trusted), and one of the PR's own (red)
  baseState = two([{ id: 1 }])
  prState = { ...two([{ id: 1 }]), own: { key: ['id'], rows: [{ id: 1 }] } }
  await mixed.capture.snapshot()
  const fb = mixed.capture.view({ isolation: { verdict: 'isolated' } }, { lists: false }).session
  assert.deepEqual(fb.flagsCount, { red: 2, amber: 2 })
  assert.deepEqual(fb.flags.map(f => [f.collection, f.kind]), [[null, 'unlisted'], ['own', 'delete']])

  // M24: in the base pane, zz lost its key, its rows the same: it moved,
  // so it ranks before aa, whose only mark is the PR's amber flag
  const keyed = { zz: { key: ['id'], rows: [{ id: 1, uuid: 'a' }, { id: 2, uuid: 'a' }] }, aa: { key: ['id'], rows: [{ id: 1, email: 'x@example.org' }] } }
  let b = keyed
  let p = keyed
  const lost = await readyCapture({ snapshot: role => ({ collections: structuredClone(role === 'base' ? b : p) }) })
  await lost.capture.ready({ signal: lost.signal })
  b = { ...keyed, zz: { ...keyed.zz, key: ['uuid'] } }
  p = { ...keyed, aa: { key: ['id'], rows: [{ id: 1, email: null }] } }
  await lost.capture.snapshot()
  const s = lost.capture.view({}).session
  assert.equal(s.base.collections.zz.keyLost, true)
  assert.deepEqual(s.flags.map(f => [f.collection, f.kind]), [['aa', 'cleared']])
  assert.deepEqual(Object.keys(s.base.collections), ['zz', 'aa'])
})

// The review's N12, and its N4 and N7 (an entry of the divergence not
// charged, or skipped where listing should stop): at every budget from
// small to whole, each list is a prefix of its order, a list that stops
// short says cut (and one that doesn't, doesn't), and the span stays
// within its share.
test('at every budget, each list lists a prefix of its order, says cut exactly when short, and the span stays within its share', async () => {
  // names long and short in turn; the PR inserts a row in the long ones,
  // the base pane in the short ones. So the divergence's entry for a long
  // one (after the PR diff's) is followed by its entry for a short one
  // (before the base diff's), which is smaller: one that doesn't fit is
  // followed by one that would
  const names = Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, '0')}${i % 2 ? 'x'.repeat(150) : ''}`)
  const rows = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const before = Object.fromEntries(names.map(n => [n, rows(3)]))
  const long = names.filter((_, i) => i % 2)
  const short = names.filter((_, i) => i % 2 === 0)
  const prAfter = { ...before, ...Object.fromEntries(long.map(n => [n, rows(4)])) }
  const baseAfter = { ...before, ...Object.fromEntries(short.map(n => [n, rows(4)])) }
  const at = async viewBytes => {
    let state = { base: before, pr: before }
    const { capture, signal } = await readyCapture({ snapshot: role => ({ collections: structuredClone(state[role]) }), capture: { viewBytes } })
    await capture.ready({ signal })
    state = { base: baseAfter, pr: prAfter }
    await capture.snapshot()
    return capture.view({}).session
  }
  const whole = await at(10_000_000)
  const order = Object.fromEntries(['pr', 'divergence', 'base'].map(l => [l, Object.keys(whole[l].collections)]))
  // N12: equal ranks go by name
  assert.deepEqual(order.pr, [...long, ...short])
  assert.deepEqual(order.divergence, names)
  assert.deepEqual(order.base, [...short, ...long])
  const size = span => Buffer.byteLength(JSON.stringify({ flags: span.flags, base: span.base, pr: span.pr, divergence: span.divergence }))
  let cuts = 0
  for (let viewBytes = 2_000; viewBytes < 34_000; viewBytes += 71) {
    const s = await at(viewBytes)
    for (const l of ['pr', 'divergence', 'base']) {
      const listed = Object.keys(s[l].collections)
      assert.deepEqual(listed, order[l].slice(0, listed.length), `${l} at ${viewBytes}`)
      assert.equal(s[l].cut === true, listed.length < order[l].length, `${l} at ${viewBytes}`)
      if (s[l].cut) cuts++
    }
    assert.ok(size(s) <= Math.floor(viewBytes / 2) + 500, `${size(s)} bytes at ${viewBytes}`)
  }
  assert.ok(cuts > 100, String(cuts))
})

// The nit: the reason when only the PR's read failed is `failed`, whatever
// happened to the base pane's (case C: its read worked, as its late
// baseline; case D: both ready reads had failed).
test('the unreadable flag\'s reason is failed when only the PR\'s read failed, though the base\'s became its late baseline', async () => {
  for (const both of [false, true]) {
    let fail = { base: true, pr: both }
    const { capture, signal } = await readyCapture({ snapshot: (role, _, st) => { if (fail[role]) throw new Error('busy'); return { collections: structuredClone(st[role]) } } })
    await capture.ready({ signal })
    fail = { base: false, pr: true }
    await capture.snapshot()
    const s = capture.view({}).session
    assert.deepEqual(s.flags.map(f => [f.kind, f.reason]), [['unreadable', 'failed']], String(both))
  }
})

// The review's stall: a PR's data that is slow to mask held the event loop
// while the base pane's read was still timed, so that read timed out (and
// the span had no base diff). Every pane's raw read now comes first.
test('one pane\'s slow masking can\'t time out the other pane\'s read: every raw read settles before any is masked', async () => {
  const busy = ms => { const end = Date.now() + ms; while (Date.now() < end) { /* masking a PR's hostile data */ } }
  for (const phase of ['ready', 'snapshot']) {
    let slow = false
    const { capture, signal } = await readyCapture({
      capture: { limits: { timeoutMs: 1_000 } },
      snapshot: async (role, _, stores) => {
        if (!slow) return { collections: structuredClone(stores[role]) }
        if (role === 'pr') return { get collections() { busy(1_500); return structuredClone(stores.pr) } }
        // the base pane's answer comes as I/O does: after the timers that are due
        await new Promise(resolve => setTimeout(resolve, 100))
        await new Promise(resolve => setImmediate(resolve))
        return { collections: structuredClone(stores.base) }
      },
    })
    slow = phase === 'ready'
    await capture.ready({ signal })
    slow = true
    if (phase === 'snapshot') await capture.snapshot()
    const view = capture.view({})
    assert.deepEqual(view.errors, NO_ERRORS, phase)
    assert.ok(view[phase === 'ready' ? 'boot' : 'session'].base, phase)
  }
})
