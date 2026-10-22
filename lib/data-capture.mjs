// A session's data capture (#8): the probes the optional inspector seam
// (adapters.inspector) opens, one per pane, and the snapshots taken through
// them. The conductor makes one per boot (lib/server.mjs), bootSession
// calls `seeded` right after each pane's seed and `ready` once both panes
// are up (lib/session.mjs), and the harness asks for more through the API.
// In memory only, dropped with the session.
//
// - seeded (S0): a pane's data before any of the PR's code has run on it;
// - ready (S1): both panes' data once migrations ran and the reviewer is
//   signed in: the baseline. S0 → S1 is the boot span. A pane whose ready
//   read failed keeps its S0, and its first later snapshot is its baseline,
//   so the boot span is never lost;
// - now (Sn): "Snapshot now". The baseline → Sn is the session span. A
//   re-baseline makes now the baseline instead, after a manual sign-in, say:
//   both panes or neither.
//
// An inspector that throws, hangs past limits.timeoutMs or returns nonsense
// never fails the boot or the session: its pane says why it has no data,
// and a call that times out is signalled to stop. An aborted boot calls the
// inspector no more. A late probe is closed unused. Nothing here logs or
// broadcasts a value: onCapture gets the pane, the phase and whether it
// worked, for the boot's two phases only.

import { randomBytes } from 'node:crypto'

import { LIMITS, createMasker, diffSnapshots, divergence, flagChanges, sanitizeSnapshot, trustOf } from './data-diff.mjs'

const PANES = ['base', 'pr']
// How long closing a probe may take: it holds up a teardown.
const CLOSE_MS = 5_000
// What one answer lists: of a collection's rows, changes and fields, at most
// LISTED of each; at most LISTED_COLLECTIONS collections a diff, flagged and
// changed ones first; at most LISTED_FLAGS flags a span, red first, with
// `unverified` ones past LISTED_UNVERIFIED folded into one; at most
// LISTED_PROBLEMS problems a pane; and at most VIEW_BYTES of all those lists
// and the collections' own entries (name, key, counts), half for each span.
// The counts are whole. An error's text is cut at ERROR_TEXT.
const LISTED = 50
const LISTED_COLLECTIONS = 1_000
const LISTED_FLAGS = 500
const LISTED_UNVERIFIED = 20
const LISTED_PROBLEMS = 50
const VIEW_BYTES = 4 * 1024 * 1024
const ERROR_TEXT = 500
// When the answer can't be built with its lists: the first red flags only.
const FALLBACK_FLAGS = 20
// A span whose PR pane has no diff: its changes are unknown. `reason` says
// why: its read failed (`failed`), neither pane could be read (`neither`),
// or this snapshot became its baseline, so there is nothing yet to compare
// it with (`baseline`).
const unreadable = reason => ({ collection: null, kind: 'unreadable', severity: 'red', shared: false, pr: 1, base: 0, reason })
// An answer built without its lists: its details couldn't be listed.
const unlisted = () => ({ collection: null, kind: 'unlisted', severity: 'red', shared: false, pr: 1, base: 0 })

const conflict = message => Object.assign(new Error(message), { status: 409 })
// What errors.boot promises a pane whose ready read failed, until its
// baseline comes.
const LATE = 'its baseline will be its first later snapshot'
const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

function messageOf(err) {
  let text
  try {
    text = String(err?.message ?? err)
  } catch {
    return 'an error that is not an Error'
  }
  return text.length > ERROR_TEXT ? `${text.slice(0, ERROR_TEXT)}…` : text
}

// fn(signal)'s result, or a rejection once `ms` pass or `parent` aborts.
// The signal fn gets aborts then too, so the call can stop.
function bounded(fn, ms, parent) {
  return new Promise((resolve, reject) => {
    if (parent?.aborted) return reject(aborted())
    const own = new AbortController()
    const signal = parent ? AbortSignal.any([parent, own.signal]) : own.signal
    let done = false
    const finish = (settle, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
      settle(value)
    }
    const onAbort = () => finish(reject, aborted())
    const timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms} ms`)
      own.abort(err)
      finish(reject, err)
    }, ms)
    parent?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => fn(signal)).then(value => finish(resolve, value), err => finish(reject, err))
  })
}

// At most `most` of a list, while `budget.left` bytes last. `cut` says the
// budget, not the count, stopped it.
function within(list, most, budget) {
  const out = []
  let cut = false
  for (const item of list.slice(0, most)) {
    const size = JSON.stringify(item).length
    if (size > budget.left) { cut = true; break }
    budget.left -= size
    out.push(item)
  }
  return { out, cut }
}
// At most LISTED_COLLECTIONS of a diff's collections, by rank (lowest
// first), then in name order: a PR's padding, empty or kept as counts,
// can't push a flagged or changed collection out.
function chosen(collections, rank) {
  return Object.keys(collections)
    .map(name => [rank(name, collections[name]), name])
    .sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
    .slice(0, LISTED_COLLECTIONS)
    .map(([, name]) => name)
}
const putOwn = (obj, name, value) => Object.defineProperty(obj, name, { enumerable: true, writable: true, configurable: true, value })
// What a collection's entry costs before its lists: its name, and its
// fields but the lists (its key among them), with room for the counts.
const ENTRY_EXTRA = 200
const entrySize = (name, rest) => JSON.stringify(name).length + JSON.stringify(rest).length + ENTRY_EXTRA
// A collection a diff changed, past its status: rows, fields or key.
const rowsChanged = c => c.inserted.length + c.updated.length + c.deleted.length + c.fieldsDropped.length + c.fieldsAdded.length > 0 || c.keyLost
// A diff as an answer lists it: each collection's entry, and its rows,
// changes and fields cut, with whole counts beside them, and `cut` on a
// collection the budget cut. Collections with a red flag come first, then
// changed rows, then an amber flag, then any other change. When the budget
// runs out, no more are listed, and the diff says `cut: true`.
// `flagged` maps a collection to the most severe of its flags.
const rankOf = (flagged, name, moved, changed) => (flagged.get(name) === 'red' ? 0 : moved ? 1 : flagged.has(name) ? 2 : changed ? 3 : 4)
function listed(diff, budget, flagged) {
  if (!diff) return diff
  const collections = {}
  let stopped = false
  const rank = (name, c) => rankOf(flagged, name, rowsChanged(c), c.status !== 'same')
  for (const name of chosen(diff.collections, rank)) {
    const c = diff.collections[name]
    const { inserted, updated, deleted, fieldsDropped, fieldsAdded, ...rest } = c
    const size = entrySize(name, rest)
    if (size > budget.left) { stopped = true; break }
    budget.left -= size
    let cut = false
    const part = list => {
      const got = within(list, LISTED, budget)
      cut ||= got.cut
      return got.out
    }
    const value = {
      ...rest,
      inserted: part(inserted), updated: part(updated), deleted: part(deleted),
      fieldsDropped: part(fieldsDropped), fieldsAdded: part(fieldsAdded),
      counts: { inserted: inserted.length, updated: updated.length, deleted: deleted.length, fieldsDropped: fieldsDropped.length, fieldsAdded: fieldsAdded.length },
    }
    if (cut) value.cut = true
    putOwn(collections, name, value)
  }
  return { collections, collectionsCount: Object.keys(diff.collections).length, ...(stopped ? { cut: true } : {}) }
}
function listedDivergence(div, budget, flagged) {
  if (!div) return div
  const collections = {}
  let stopped = false
  const moved = c => c.changes.length > 0 || [c.counts.base, c.counts.pr].some(n => n.inserted + n.updated + n.deleted > 0)
  const rank = (name, c) => rankOf(flagged, name, moved(c), c.status !== 'same')
  for (const name of chosen(div.collections, rank)) {
    const { changes, ...rest } = div.collections[name]
    const size = entrySize(name, rest)
    if (size > budget.left) { stopped = true; break }
    budget.left -= size
    const { out, cut } = within(changes, LISTED, budget)
    putOwn(collections, name, { ...rest, changes: out, changesCount: changes.length, ...(cut ? { cut: true } : {}) })
  }
  return { collections, collectionsCount: Object.keys(div.collections).length, ...(stopped ? { cut: true } : {}) }
}
// A span's flags as an answer lists them, in the engine's order (the base
// pane's collections first, destructive kinds before `unverified`), red
// first. Past LISTED_UNVERIFIED red `unverified` flags of named collections,
// the rest are one flag in their place (`folded`, with how many and the
// first five names). At most LISTED_FLAGS in all, within the budget.
function listedFlags(flags, budget) {
  const out = []
  const rest = []
  let named = 0
  let foldAt = -1
  for (const f of flags) {
    if (f.severity !== 'red') continue
    if (f.kind === 'unverified' && f.collection !== null && ++named > LISTED_UNVERIFIED) {
      if (foldAt === -1) foldAt = out.length
      rest.push(f.collection)
      continue
    }
    out.push(f)
  }
  if (rest.length) out.splice(foldAt, 0, { collection: null, kind: 'unverified', severity: 'red', shared: false, pr: rest.length, base: 0, collections: rest.length, names: rest.slice(0, 5), folded: true })
  return within([...out, ...flags.filter(f => f.severity !== 'red')], LISTED_FLAGS, budget).out
}
// At most LISTED_PROBLEMS of a pane's problems.
const listedProblems = problems => problems.slice(0, LISTED_PROBLEMS)

// inspector: { open, rules? }; rules: validated (validateRules). key: the
// session's HMAC key, fresh by default.
export function createDataCapture({ inspector, rules, limits = {}, key = randomBytes(32), now = Date.now, onCapture = () => {}, viewBytes = VIEW_BYTES }) {
  const lim = { ...LIMITS, ...limits }
  const masker = createMasker({ key, rules })
  const probes = { base: null, pr: null }
  // why a pane has no data: for the boot span (an open, seeded or ready
  // read that failed: never erased), and for the latest session read
  const errors = { boot: { base: null, pr: null }, session: { base: null, pr: null } }
  const seeded = { base: null, pr: null } // S0, until the pane has a baseline
  const baseline = { base: null, pr: null } // S1
  const latest = { base: null, pr: null } // Sn, from the latest run
  const boot = { base: null, pr: null } // S0 → S1 per pane
  // Each run (ready, Snapshot now, Re-baseline) is numbered. A pane's
  // baseline and boot span name the run they came from, and when, so a span
  // knows whether both panes' windows match.
  let runs = 0
  let readyRun = null
  const baseRun = { base: null, pr: null }
  const bootRun = { base: null, pr: null }
  const baseAt = { base: null, pr: null }
  // a pane whose baseline came from the latest Snapshot now, late: it has
  // no session span yet
  const fresh = { base: false, pr: false }
  let baselineAt = null
  let rebaselined = false
  let latestAt = null
  let closed = false
  let inFlight = null // { rebaseline, promise }
  const life = new AbortController() // aborted by close
  // a version for each change of what view() shows, and the answer cached
  let version = 0
  let cached = null // { id, json }

  const report = (pane, phase, ok) => {
    try { onCapture({ pane, phase, ok }) } catch { /* a listener's bug fails nothing */ }
  }

  // A pane's snapshot through its probe, sanitized, or null with why.
  async function take(pane, phase, signal) {
    const probe = probes[pane]
    try {
      const raw = await bounded(s => probe.snapshot({ limits: { maxRows: lim.maxRows, maxBytes: lim.maxBytes, timeoutMs: lim.timeoutMs }, signal: s }), lim.timeoutMs, signal)
      return { snap: { at: now(), ...sanitizeSnapshot(raw, { masker, rules, limits: lim }) }, error: null }
    } catch (err) {
      return { snap: null, error: `the ${phase} snapshot failed: ${messageOf(err)}` }
    }
  }

  // A pane has a baseline, from run `run` at `at`: its boot span, from its
  // S0, if it has one, and only the first time.
  function settle(pane, snap, run, at) {
    baseline[pane] = snap
    baseRun[pane] = run
    baseAt[pane] = at
    if (seeded[pane]) {
      boot[pane] = diffSnapshots(seeded[pane], snap)
      bootRun[pane] = run
    }
    seeded[pane] = null
    // a promised late baseline has come: say when
    if (errors.boot[pane]?.endsWith(LATE)) errors.boot[pane] = `${errors.boot[pane].slice(0, -LATE.length)}its baseline is the snapshot at ${new Date(at).toISOString()}`
  }

  // Right after a pane's seed: open its probe, with the db the Provisioner
  // gave, and take S0.
  async function seededPane({ paneRef, db, databases, signal }) {
    const pane = paneRef.role
    if (closed || signal?.aborted || !PANES.includes(pane)) return
    let opening
    let probe
    try {
      probe = await bounded(s => { opening = Promise.resolve().then(() => inspector.open({ paneRef, db, databases, signal: s })); return opening }, lim.timeoutMs, signal)
    } catch (err) {
      // a probe that comes after all is closed, unused
      opening?.then(late => closeProbe(late), () => {})
      errors.boot[pane] = `the inspector's open failed: ${messageOf(err)}`
      version++
      return report(pane, 'seeded', false)
    }
    if (!probe || typeof probe.snapshot !== 'function') {
      errors.boot[pane] = "the inspector's open gave no probe (an object with snapshot())"
      version++
      return report(pane, 'seeded', false)
    }
    if (closed) return closeProbe(probe)
    probes[pane] = probe
    if (signal?.aborted) return
    const { snap, error } = await take(pane, 'seeded', signal)
    seeded[pane] = snap
    errors.boot[pane] = error
    version++
    report(pane, 'seeded', snap !== null)
  }

  // Both panes are up: take S1, and the boot span where S0 and S1 exist.
  async function ready({ signal }) {
    if (closed || signal?.aborted) return
    const panes = PANES.filter(pane => probes[pane] !== null)
    const reads = await Promise.all(panes.map(pane => take(pane, 'ready', signal)))
    if (closed || signal?.aborted) return
    const run = ++runs
    readyRun = run
    const at = now()
    panes.forEach((pane, i) => {
      const { snap, error } = reads[i]
      if (snap) settle(pane, snap, run, at)
      else {
        // kept beside any earlier reason, and a boot span promised only
        // when there is an S0 to make one from
        const why = seeded[pane] ? `${error}; ${LATE}` : `${error}; it has no seeded snapshot, so no boot span`
        errors.boot[pane] = errors.boot[pane] ? `${errors.boot[pane]}; ${why}` : why
      }
      report(pane, 'ready', snap !== null)
    })
    // the baseline's time, only when a pane has its baseline from ready
    if (reads.some(r => r.snap)) baselineAt = at
    version++
  }

  // Snapshot now, or re-baseline. Concurrent calls of one kind share a run;
  // one of the other kind meanwhile is refused (409), as is one after the
  // session ended, and one in flight when it ends.
  // - now: each pane's snapshot is its latest, or none when its read
  //   failed; a pane with no baseline yet takes it as its baseline;
  // - re-baseline: both panes' snapshots become the baseline, or, when
  //   either read fails, neither does.
  function snapshot({ rebaseline = false } = {}) {
    if (closed) return Promise.reject(conflict('the session ended'))
    if (inFlight) return inFlight.rebaseline === rebaseline ? inFlight.promise : Promise.reject(conflict('a snapshot is already being taken'))
    const panes = PANES.filter(pane => probes[pane] !== null)
    if (panes.length === 0) return Promise.reject(conflict('neither pane has a probe: the inspector failed to open'))
    const phase = rebaseline ? 'baseline' : 'now'
    const promise = (async () => {
      const reads = await Promise.all(panes.map(pane => take(pane, phase, life.signal)))
      if (closed) throw conflict('the session ended while the snapshot was taken')
      const run = ++runs
      const at = now()
      panes.forEach((pane, i) => { errors.session[pane] = reads[i].error })
      if (rebaseline) {
        if (reads.every(r => r.snap)) {
          panes.forEach((pane, i) => { settle(pane, reads[i].snap, run, at); fresh[pane] = false })
          baselineAt = at
          rebaselined = true
          latest.base = null
          latest.pr = null
          latestAt = null
        }
      } else {
        // A pane with no baseline yet (its ready read failed) takes this one:
        // its windows then differ from the other pane's, which its spans say
        // until a re-baseline.
        panes.forEach((pane, i) => {
          const { snap } = reads[i]
          fresh[pane] = Boolean(snap && !baseline[pane])
          if (fresh[pane]) { settle(pane, snap, run, at); latest[pane] = null } else latest[pane] = snap
        })
        latestAt = at
      }
      version++
    })().finally(() => { inFlight = null })
    inFlight = { rebaseline, promise }
    return promise
  }

  // What the Data view shows: the boot and session spans, each pane's diff
  // (its rows, changes and fields listed in part, its counts whole), their
  // divergence and the PR's flags, trusted or advisory by the session's
  // isolation verdict.
  // - A span is complete when both panes are in it over the same window.
  // - Its windows differ (`aligned: false`) when one pane's baseline came
  //   from a later run (its ready read failed): then nothing in the base
  //   pane can excuse a PR change. A boot span is aligned only when both
  //   panes' baselines came from the ready run itself.
  // - A span whose PR pane has no diff has one red `unreadable` flag, and
  //   so does one with neither pane's, once a run has happened: its changes
  //   are unknown, never none.
  // - Without `lists` (an answer too big to build), a span keeps its counts
  //   and first red flags, after a red `unlisted` one, and lists nothing.
  function view({ isolation } = {}, { lists = true } = {}) {
    if (closed) return { available: true, active: true, closed: true }
    const trust = trustOf(isolation)
    const span = (base, pr, aligned, why) => {
      if (!base && !pr && why === null) return null
      // each span its own share of the budget
      const budget = { left: Math.floor(viewBytes / 2) }
      const flags = pr ? flagChanges(base ?? { collections: {} }, pr, rules, { trusted: trust === 'trusted' && aligned }) : [unreadable(base ? why ?? 'failed' : 'neither')]
      const red = flags.filter(f => f.severity === 'red').length
      const complete = Boolean(base && pr) && aligned
      if (!lists) {
        return { complete, aligned, unlisted: true, flags: [unlisted(), ...flags.filter(f => f.severity === 'red').slice(0, FALLBACK_FLAGS)], flagsCount: { red: red + 1, amber: flags.length - red }, base: null, pr: null, divergence: null }
      }
      // the flags first, then the PR pane's diff and the divergence, then
      // the base pane's diff, while the span's budget lasts
      const flagged = new Map()
      for (const f of flags) if (f.collection !== null && flagged.get(f.collection) !== 'red') flagged.set(f.collection, f.severity)
      const listedFlagsOut = listedFlags(flags, budget)
      const prOut = listed(pr, budget, flagged)
      const divOut = base && pr ? listedDivergence(divergence(base, pr), budget, flagged) : null
      const baseOut = listed(base, budget, flagged)
      return { complete, aligned, flags: listedFlagsOut, flagsCount: { red, amber: flags.length - red }, base: baseOut, pr: prOut, divergence: divOut }
    }
    const sessionOf = pane => (baseline[pane] && latest[pane] ? diffSnapshots(baseline[pane], latest[pane]) : null)
    const newest = pane => latest[pane] ?? baseline[pane] ?? seeded[pane]
    const both = (pair, runOf) => !(pair.base && pair.pr) || runOf.base === runOf.pr
    const bootAligned = !(boot.base && boot.pr) || (bootRun.base === readyRun && bootRun.pr === readyRun)
    const session = { base: sessionOf('base'), pr: sessionOf('pr') }
    const problemsOf = pane => newest(pane)?.problems ?? []
    return {
      available: true,
      active: true,
      trust,
      baselineAt,
      baselines: { ...baseAt },
      rebaselined,
      comparedAt: latestAt,
      errors: { boot: { ...errors.boot }, session: { ...errors.session } },
      problems: { base: listedProblems(problemsOf('base')), pr: listedProblems(problemsOf('pr')) },
      problemsCount: { base: problemsOf('base').length, pr: problemsOf('pr').length },
      boot: span(boot.base, boot.pr, bootAligned, runs > 0 ? 'failed' : null),
      session: latestAt === null ? null : span(session.base, session.pr, both(session, baseRun), fresh.pr ? 'baseline' : 'failed'),
    }
  }

  // view() as JSON, built once for each state and trust; one too big to
  // build is built again without its lists (a red `unlisted` flag says
  // so), and one that still fails fails again at once, until the state
  // changes.
  function viewJson({ isolation } = {}) {
    const id = `${version} ${closed} ${trustOf(isolation)}`
    if (cached?.id !== id) {
      try {
        cached = { id, json: JSON.stringify(view({ isolation })) }
      } catch {
        try {
          cached = { id, json: JSON.stringify(view({ isolation }, { lists: false })) }
        } catch (error) {
          cached = { id, error }
        }
      }
    }
    if (cached.error) throw cached.error
    return cached.json
  }

  async function closeProbe(probe) {
    if (!probe || typeof probe.close !== 'function') return
    try { await bounded(() => probe.close(), CLOSE_MS) } catch { /* it had its chance */ }
  }

  // Ends the capture: an in-flight snapshot is dropped, each probe closed
  // once, and every snapshot let go. A probe's close frees the conductor's
  // side only, and never touches the store.
  async function close() {
    if (closed) return
    closed = true
    life.abort()
    cached = null
    const open = PANES.map(pane => probes[pane])
    for (const pane of PANES) {
      probes[pane] = null
      seeded[pane] = baseline[pane] = latest[pane] = boot[pane] = null
    }
    await Promise.all(open.map(closeProbe))
  }

  return { seeded: seededPane, ready, snapshot, view, viewJson, close }
}
