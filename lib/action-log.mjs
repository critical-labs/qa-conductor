// A QA session's action log (#8): what each pane's proxy forwarded to its
// app, and the marks the harness posts for the actions each pane's bridge
// reports, mirrored or not, so a reviewer sees which requests each action
// set off. Pure apart from the clock: the conductor (lib/server.mjs) keeps
// one per session, in memory, and drops it with the session.
//
// Value-free by construction. An entry keeps the method, the path, the
// status, the time it took and the bytes sent back: never a header, a
// cookie, a body or a query value. Paths lose every segment that looks like
// a value (a token, an email address, a long number), since a pane's paths
// carry what its app put there. Marks keep the pane and the kind of action:
// never the element, the text or what was typed. A mark comes from the
// pane's own bridge, which PR code can drive, so it is labelled as reported
// by that pane.

import { randomBytes } from 'node:crypto'

const PANES = ['base', 'pr']
export const MARK_TYPES = ['click', 'submit', 'change', 'enter']
// What the proxies say when they refuse a request before forwarding it.
const REFUSALS = new Set([
  'cross-site request refused', 'cross-site framing refused', 'cross-site navigation refused', 'capability', 'misdirected',
])
const MAX_PATH = 200
const QUERY_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/
// Seven digits or more, each joined to the next by at most four
// separators: `555 - 123 - 4567`, `(555)  123  4567` and `555 -- 123 -- 4567`
// too. Masking a little too much is fine here.
const DIGIT_RUN = /\p{Nd}(?:[^\p{L}\p{Nd}]{0,4}\p{Nd}){6,}/u

// The clock requests and marks are stamped with: the wall clock at the
// process's start, then monotonic, so a step back of the system clock never
// reorders them.
export const monotonicNow = () => performance.timeOrigin + performance.now()

// A segment decoded until it stops changing, at most three times: a value
// encoded twice is still seen. Each run of escapes decodes on its own, so
// one that doesn't decode (a stray `%`, a lone `%E0`) stops only itself.
const decodeRuns = s => s.replace(/(?:%[0-9a-f]{2})+/gi, run => {
  try { return decodeURIComponent(run) } catch { return run }
})
function decoded(segment) {
  let s = segment
  for (let i = 0; i < 3; i++) {
    const next = decodeRuns(s)
    if (next === s) break
    s = next
  }
  return s
}

// A key as shown: itself when it looks like a name and not like a value.
const shownKey = key => (QUERY_KEY.test(key) && maskSegment(key) === key ? key : '…')

// What a path segment shows: itself, or what kind of value it held. A
// heuristic: what looks like an email address, a key=value pair, a JWT, a
// number of seven digits or more (a phone, a card, an account), hex, a long
// mix of letters and digits, or a run of 24 letters or more goes; a short
// code or token can slip through.
function maskSegment(segment) {
  if (segment === '') return segment
  const s = decoded(segment)
  if (/[@＠﹫]/.test(s) || /%(?:25)*40/i.test(segment)) return ':email'
  const eq = s.indexOf('=')
  if (eq !== -1) return `${shownKey(s.slice(0, eq))}=…` // key=value, matrix parameters included
  if (/%(?:25)*3d/i.test(segment)) return '…=…' // an `=` in an escape that didn't decode
  if (/^eyJ[\w-]*\.[\w-]*\.[\w-]*$/.test(s)) return ':token' // a JWT
  if (DIGIT_RUN.test(s)) return ':number'
  if (/^[0-9a-f]{16,}$/i.test(s)) return ':token' // hex
  if (s.length >= 16 && /[A-Za-z]/.test(s) && /\d/.test(s)) return ':token'
  if (s.length >= 20 && /[a-z]/.test(s) && /[A-Z]/.test(s)) return ':token' // base64-like
  if (/[A-Za-z]{24,}/.test(s)) return ':token' // no word is that long
  return segment
}

// A request target as the log shows it: the path with its value-like
// segments masked, then the query's keys with every value dropped, at most
// MAX_PATH characters. A key that doesn't look like a name, or looks like a
// value, is masked too, and so is a query part with no `=`, which is
// usually a value itself.
export function sanitizePath(url) {
  if (typeof url !== 'string') return '/'
  let target = url.split('#')[0]
  if (!target.startsWith('/')) {
    try {
      const u = new URL(target)
      target = u.pathname + u.search
    } catch {
      return '/'
    }
  }
  const at = target.indexOf('?')
  const path = (at === -1 ? target : target.slice(0, at)).split('/').map(maskSegment).join('/')
  const parts = at === -1 ? [] : target.slice(at + 1).split('&').filter(Boolean)
  const query = parts
    .map(part => {
      const eq = part.indexOf('=')
      if (eq === -1) return '…'
      return eq === 0 ? null : `${shownKey(part.slice(0, eq))}=…`
    })
    .filter(part => part !== null)
    .join('&')
  const out = query ? `${path}?${query}` : path
  return out.length > MAX_PATH ? `${out.slice(0, MAX_PATH - 1)}…` : out
}

export function sanitizeMethod(method) {
  return typeof method === 'string' && /^[A-Z]{1,12}$/.test(method) ? method : 'OTHER'
}

const count = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0)

function assertPane(pane) {
  if (!PANES.includes(pane)) throw new Error('pane must be base or pr')
}

// The most a read gives: requests and marks together.
export const MAX_READ = 2_000

// One sequence numbers every request and mark, in the order they were
// recorded (a request when it ends), and a read gives the next of them,
// requests and marks alike, at most `limit`: so a reader that reads on from
// its cursor until `more` is false has had everything, in order.
//
// maxEntries requests per pane, a ring: the oldest go first, counted in
// `dropped`. Marks: at most one of each kind per pane every markGapMs (a
// click and the submit it sets off come within milliseconds), from a budget
// per pane of maxMarks that refills one mark every markRefillMs. PR code can
// post bridge messages: it can use up its own pane's budget for as long as
// it keeps posting, never the base pane's. The marks kept are a ring of
// keptMarks per pane. Those refused or no longer kept are counted per pane
// in `marksDropped`.
//
// Which action a request came from is the reader's to work out, from the
// marks it has: README's HTTP API says how. A mark may come after the
// request it set off, so the log never has to give a request again.
export function createActionLog({
  now = monotonicNow, maxEntries = 5_000, maxMarks = 2_000, keptMarks = 4 * maxMarks, markRefillMs = 1_000, markGapMs = 100,
} = {}) {
  // which log a reader is reading: a new session's starts its seq again
  const id = randomBytes(8).toString('hex')
  let seq = 0
  const entries = { base: [], pr: [] }
  const dropped = { base: 0, pr: 0 }
  const refusals = { base: {}, pr: {} }
  // per pane; in time order across both: a clock that steps back is held at
  // the last mark's time
  const marks = { base: [], pr: [] }
  let lastAt = -Infinity
  const lastMark = new Map() // `${pane} ${type}` -> the clock's time
  // in milliseconds of refill: a mark costs markRefillMs
  const full = maxMarks * markRefillMs
  const budget = { base: { left: full, at: null }, pr: { left: full, at: null } }
  const marksDropped = { base: 0, pr: 0 }

  function record(pane, exchange = {}) {
    assertPane(pane)
    const entry = {
      seq: ++seq,
      pane,
      at: Number.isFinite(exchange.at) ? exchange.at : now(),
      method: sanitizeMethod(exchange.method),
      path: sanitizePath(exchange.path),
      status: Number.isInteger(exchange.status) && exchange.status >= 100 && exchange.status <= 999 ? exchange.status : 0,
      ms: count(exchange.ms),
      bytes: count(exchange.bytes),
      aborted: exchange.aborted === true,
    }
    const ring = entries[pane]
    ring.push(entry)
    if (ring.length > maxEntries) { ring.shift(); dropped[pane]++ }
    return entry
  }

  function refused(pane, reason) {
    assertPane(pane)
    const key = REFUSALS.has(reason) ? reason : 'other'
    refusals[pane][key] = (refusals[pane][key] ?? 0) + 1
  }

  // Whether the pane's budget has a mark left at time t, taking it if so.
  function spend(pane, t) {
    const b = budget[pane]
    if (b.at !== null && t > b.at) b.left = Math.min(full, b.left + (t - b.at))
    b.at = b.at === null ? t : Math.max(b.at, t)
    if (b.left < markRefillMs) return false
    b.left -= markRefillMs
    return true
  }

  function mark(pane, type) {
    assertPane(pane)
    if (!MARK_TYPES.includes(type)) throw new Error(`type must be one of ${MARK_TYPES.join(', ')}`)
    const t = now()
    const kind = `${pane} ${type}`
    if (t - (lastMark.get(kind) ?? -Infinity) < markGapMs || !spend(pane, t)) { marksDropped[pane]++; return null }
    lastMark.set(kind, t)
    lastAt = Math.max(t, lastAt)
    const m = { seq: ++seq, pane, at: lastAt, type }
    const ring = marks[pane]
    ring.push(m)
    if (ring.length > keptMarks) { ring.shift(); marksDropped[pane]++ }
    return m
  }

  // What came after sequence number `after`: at most `limit` requests and
  // marks together (MAX_READ at most), in sequence order; `more` when there
  // are others, and `seq`, where to read on from. `log` names this log: a
  // new session's is another, whose seq starts again.
  function read(after, { limit = MAX_READ } = {}) {
    const from = Number.isSafeInteger(after) && after >= 0 ? after : 0
    const most = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_READ) : MAX_READ
    const fresh = [...entries.base, ...entries.pr, ...marks.base, ...marks.pr].filter(e => e.seq > from).sort((a, b) => a.seq - b.seq)
    const page = fresh.slice(0, most)
    const more = fresh.length > page.length
    return {
      log: id,
      seq: more ? page.at(-1).seq : Math.max(from, seq),
      more,
      requests: page.filter(e => 'method' in e).map(e => ({ ...e })),
      marks: page.filter(e => 'type' in e).map(e => ({ ...e })),
      dropped: { ...dropped },
      refused: { base: { ...refusals.base }, pr: { ...refusals.pr } },
      marksDropped: { ...marksDropped },
    }
  }

  return { record, refused, mark, read }
}
