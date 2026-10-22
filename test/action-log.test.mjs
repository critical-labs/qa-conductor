// The session's action log (lib/action-log.mjs): what each pane's proxy
// forwarded, and the marks the harness posts for the actions each pane's
// bridge reports, mirrored or not. Value-free by construction: no header,
// cookie, body or query value ever enters it, and paths lose what looks like
// a token, an email address or a long number.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MARK_TYPES, createActionLog, monotonicNow, sanitizeMethod, sanitizePath } from '../lib/action-log.mjs'

test('sanitizePath keeps the shape of a path and drops every value in it', () => {
  const cases = [
    ['/', '/'],
    ['/cart', '/cart'],
    ['/orders/42/items', '/orders/42/items'],
    // query values go, keys that look like names stay
    ['/search?q=hello&page=2', '/search?q=…&page=…'],
    ['/login?token=abc123&next=/x', '/login?token=…&next=…'],
    ['/x?', '/x'],
    ['/x?=v&&b=2', '/x?b=…'],
    // a query part with no `=` is usually the value itself
    ['/x?a', '/x?…'],
    ['/x?SECRETBAREVALUE&page=2', '/x?…&page=…'],
    // a key that is itself a value is masked too
    ['/x?eyJhbGciOiJIUzI1NiJ9=1', '/x?…=…'],
    ['/x?a%20b=1', '/x?…=…'],
    // segments that look like values
    ['/reset/9f86d081884c7d659a2feaa0c55ad015', '/reset/:token'],
    ['/hex/deadbeefcafebabe', '/hex/:token'],
    ['/invite/AbC123xYz789QwErTy00', '/invite/:token'],
    ['/invite/aB3dE6gH9jK2mN5p', '/invite/:token'], // 16 characters
    ['/b64/AbCdEfGhIjKlMnOpQrSt', '/b64/:token'], // mixed case, no digit
    ['/users/jane.doe@example.org/edit', '/users/:email/edit'],
    ['/users/jane.doe%40example.org', '/users/:email'],
    ['/users/bob%40ex.io%zz', '/users/:email'], // an escape that doesn't decode
    ['/users/alice＠example.com', '/users/:email'], // a fullwidth @
    ['/session/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', '/session/:token'],
    ['/phone/5551234567', '/phone/:number'],
    ['/phone/+15551234567', '/phone/:number'],
    ['/phone/555-123-4567', '/phone/:number'],
    ['/card/4111-1111-1111-1111', '/card/:number'],
    ['/ssn/123-45-6789', '/ssn/:number'],
    ['/code/12345678', '/code/:number'], // 8 digits
    ['/code/1234567', '/code/:number'], // 7
    ['/orders/123456', '/orders/123456'], // 6: an id, kept
    ['/2026/10/15/post', '/2026/10/15/post'],
    ['/products/widget-classic', '/products/widget-classic'],
    ['/guide/internationalization-guide', '/guide/internationalization-guide'],
    // seven digits or more anywhere in a segment, with one separator at most between two
    ['/u/5551234567.json', '/u/:number'],
    ['/acct/ACCT9876543210', '/acct/:number'],
    ['/ssn/ssn-123-45-6789', '/ssn/:number'],
    ['/patients/MRN1234567', '/patients/:number'],
    ['/cards/4111_1111_1111_1111', '/cards/:number'],
    ['/cards/4111+1111+1111+1111', '/cards/:number'],
    ['/cards/4111%2F1111%2F1111%2F1111', '/cards/:number'],
    ['/phone/555,123,4567', '/phone/:number'],
    ['/phone/(555) 123-4567', '/phone/:number'],
    ['/phone/５５５１２３４５６７', '/phone/:number'], // fullwidth digits
    ['/v/12-34-56', '/v/12-34-56'], // six
    // decoded until it stops changing
    ['/u/bob%2540gmail.com', '/u/:email'],
    ['/u/a%252540b.co', '/u/:email'],
    ['/users/bob﹫gmail.com', '/users/:email'], // a small-form @
    ['/users/bob%EF%B9%ABgmail.com', '/users/:email'],
    ['/x/token%3Dabc123', '/x/token=…'],
    ['/x/token%253Dabc', '/x/token=…'], // twice
    ['/x/token%25253Dabc', '/x/token=…'], // three times
    ['/users/bob%25EF%25B9%25ABgmail.com', '/users/:email'],
    // a JWT with no digit, too short for the other rules
    ['/s/eyJhbGci.eyJz.abc', '/s/:token'],
    // 24 letters or more in a row: no word is that long
    ['/reset/xkcdcorrecthorsebatterystaple', '/reset/:token'],
    ['/api/keys/key_abcdefghijklmnopqrstuvwx', '/api/keys/:token'],
    ['/k/ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF', '/k/:token'],
    // up to four separators between digits
    ['/phone/555%20-%20123%20-%204567', '/phone/:number'],
    ['/card/4111 - 1111 - 1111 - 1111', '/card/:number'],
    ['/ssn/123 - 45 - 6789', '/ssn/:number'],
    ['/phone/555..123..4567', '/phone/:number'],
    ['/phone/555--123--4567', '/phone/:number'],
    ['/phone/(555)%20%20123%20%204567', '/phone/:number'],
    ['/phone/555 -- 123 -- 4567', '/phone/:number'],
    ['/phone/555....123....4567', '/phone/:number'],
    ['/v/1.....2.....3.....4.....5.....6.....7', '/v/1.....2.....3.....4.....5.....6.....7'], // five: kept
    // one escape that doesn't decode stops only itself
    ['/u/a%EF%BC%A0b.co%', '/u/:email'],
    ['/u/a%EF%B9%ABb.co%', '/u/:email'],
    ['/x/token%3Dabc123%', '/x/token=…'],
    ['/x/token%3Dabc%25', '/x/token=…'],
    ['/u/bob%2540gmail.com%', '/u/:email'],
    ['/x/a%3D%E0', '/x/…=…'],
    // the raw checks, where a bad escape in the run stops it decoding
    ['/u/jos%E9%40x.io', '/u/:email'],
    ['/u/jos%E9%2540x.io', '/u/:email'],
    ['/x/a%253D%E0', '/x/…=…'],
    ['/x/k%3d%E0', '/x/…=…'],
    ['/u/a%ef%bc%a0b', '/u/:email'],
    // a key=value segment keeps the key
    ['/x/token=abc', '/x/token=…'],
    ['/x/apikey=sk_live_short;v=2', '/x/apikey=…'],
    ['/x/eyJhbGciOiJIUzI1NiJ9=1', '/x/…=…'],
    // an absolute-form target loses its userinfo, host and query values
    ['http://u:p@h.example/a?b=1', '/a?b=…'],
    // a fragment never reaches a server, but nothing of it is kept either
    ['/a#secret', '/a'],
  ]
  for (const [url, want] of cases) assert.equal(sanitizePath(url), want, url)
  // at most 200 characters
  const long = sanitizePath(`/${'ab/'.repeat(200)}`)
  assert.equal(long.length, 200)
  assert.ok(long.endsWith('…'))
  // anything not a string is the root
  for (const bad of [undefined, null, 42]) assert.equal(sanitizePath(bad), '/')
})

test('sanitizeMethod keeps a method of capitals, and nothing else', () => {
  for (const m of ['GET', 'POST', 'DELETE', 'PROPFIND']) assert.equal(sanitizeMethod(m), m)
  for (const m of ['get', 'GE T', 'X'.repeat(13), '', undefined, '<img>']) assert.equal(sanitizeMethod(m), 'OTHER', String(m))
})

function clock(start = 1_000) {
  let t = start
  return { now: () => t, tick: ms => { t += ms } }
}

test('record keeps only the value-free fields, sanitized, and numbers every entry in one sequence with the marks', () => {
  const c = clock()
  const log = createActionLog({ now: c.now })
  const entry = log.record('base', {
    at: 990, method: 'POST', path: '/cart/clear?csrf=s3cr3t', status: 303, ms: 12, bytes: 0, aborted: false,
    headers: { cookie: 'sid=1' }, body: 'x=1', authorization: 'Bearer abc',
  })
  assert.deepEqual(entry, { seq: 1, pane: 'base', at: 990, method: 'POST', path: '/cart/clear?csrf=…', status: 303, ms: 12, bytes: 0, aborted: false })
  const mark = log.mark('pr', 'click')
  assert.deepEqual(mark, { seq: 2, pane: 'pr', at: 1_000, type: 'click' })
  // numbers are numbers, whatever came in
  const odd = log.record('pr', { at: 'x', method: 'get', path: 7, status: '200', ms: -1, bytes: Infinity })
  assert.deepEqual(odd, { seq: 3, pane: 'pr', at: 1_000, method: 'OTHER', path: '/', status: 0, ms: 0, bytes: 0, aborted: false })
  // only the two panes
  assert.throws(() => log.record('qa', { at: 1, method: 'GET', path: '/' }), /pane must be base or pr/)
})

test('each pane keeps its last maxEntries requests, counting the ones it dropped', () => {
  const log = createActionLog({ now: () => 1, maxEntries: 3 })
  for (let i = 0; i < 5; i++) log.record('base', { at: i, method: 'GET', path: `/p${i}`, status: 200 })
  log.record('pr', { at: 9, method: 'GET', path: '/q', status: 200 })
  const out = log.read(0)
  assert.deepEqual(out.requests.map(r => r.path), ['/p2', '/p3', '/p4', '/q'])
  assert.deepEqual(out.dropped, { base: 2, pr: 0 })
})

// A click and the submit it sets off, or a change on blur and the click
// that caused it, come within milliseconds: each kind has its own 100 ms.
test('marks are value-free, one of each kind per pane per 100 ms, and at most maxMarks a pane', () => {
  const c = clock()
  const log = createActionLog({ now: c.now, maxMarks: 4 })
  assert.deepEqual(MARK_TYPES, ['click', 'submit', 'change', 'enter'])
  assert.ok(log.mark('base', 'change'))
  c.tick(60)
  assert.ok(log.mark('base', 'click'), 'another kind, 60 ms later')
  c.tick(1)
  assert.ok(log.mark('base', 'submit'), 'and the submit the click set off')
  assert.equal(log.mark('base', 'submit'), null, 'the same kind within 100 ms')
  assert.ok(log.mark('pr', 'submit'), 'the other pane has its own')
  c.tick(100)
  assert.ok(log.mark('base', 'enter'))
  c.tick(100)
  assert.equal(log.mark('base', 'click'), null, 'over maxMarks for the base pane')
  assert.deepEqual(log.read(0).marksDropped, { base: 2, pr: 0 })
  assert.throws(() => log.mark('base', 'keyup'), /type must be one of click, submit, change, enter/)
  assert.throws(() => log.mark('both', 'click'), /pane must be base or pr/)
})

// PR code can post bridge messages: it can use up the PR pane's marks for as
// long as it keeps posting, never the base pane's, and a pause refills them.
test('each pane\'s marks come from a budget that refills: using up the PR pane\'s leaves the base pane\'s alone, and a pause refills it', () => {
  const c = clock()
  const log = createActionLog({ now: c.now, maxMarks: 3, markRefillMs: 1_000 })
  assert.deepEqual(MARK_TYPES.map(type => log.mark('pr', type) !== null), [true, true, true, false])
  assert.ok(log.mark('base', 'click'), 'the base pane has its own')
  c.tick(999)
  assert.equal(log.mark('pr', 'click'), null, 'not quite one mark refilled')
  c.tick(1)
  assert.ok(log.mark('pr', 'click'), 'one refilled')
  assert.equal(log.mark('pr', 'submit'), null)
  c.tick(10_000)
  assert.deepEqual(MARK_TYPES.map(type => log.mark('pr', type) !== null), [true, true, true, false], 'never more than maxMarks at once')
  assert.deepEqual(log.read(0).marksDropped, { base: 0, pr: 4 })
  // the default: 2,000, and one more a second
  const d = clock()
  const dflt = createActionLog({ now: d.now })
  let made = 0
  for (let i = 0; i < 2_100; i++) { if (dflt.mark('pr', MARK_TYPES[i % 4])) made++; if (i % 4 === 3) d.tick(100) }
  assert.equal(made, 2_000 + Math.floor((2_100 / 4 - 1) * 100 / 1_000))
})

test('refusals count per pane by reason, and nothing else of them is kept', () => {
  const log = createActionLog({ now: () => 1 })
  log.refused('base', 'cross-site framing refused')
  log.refused('base', 'cross-site framing refused')
  log.refused('pr', 'capability')
  log.refused('pr', 'something the PR made up <img src=x>')
  assert.deepEqual(log.read(0).refused, { base: { 'cross-site framing refused': 2 }, pr: { capability: 1, other: 1 } })
})

// One sequence numbers requests and marks alike, and a read gives the next
// of them, at most `limit`: a reader that reads on until `more` is false has
// had everything, in order, and nothing is ever given again.
test('a read gives the requests and marks after a sequence number, in order, at most `limit` together', () => {
  const c = clock(0)
  const log = createActionLog({ now: c.now })
  log.record('base', { at: 0, method: 'GET', path: '/', status: 200 }) // 1
  c.tick(1_000)
  const click = log.mark('base', 'click') // 2
  log.record('base', { at: 800, method: 'POST', path: '/cart/clear', status: 303 }) // 3
  log.record('pr', { at: 650, method: 'POST', path: '/cart/clear', status: 303 }) // 4
  c.tick(2_000)
  const submit = log.mark('pr', 'submit') // 5
  const all = log.read(0)
  assert.deepEqual([all.seq, all.more], [5, false])
  assert.deepEqual(all.requests.map(r => [r.seq, r.pane, r.path]), [[1, 'base', '/'], [3, 'base', '/cart/clear'], [4, 'pr', '/cart/clear']])
  assert.deepEqual(all.marks, [click, submit])
  assert.equal(all.requests.some(r => 'mark' in r), false, 'which action a request came from is the reader\'s to work out')
  const page = log.read(0, { limit: 2 })
  assert.deepEqual([page.requests.map(r => r.seq), page.marks.map(m => m.seq), page.seq, page.more], [[1], [2], 2, true])
  const rest = log.read(page.seq, { limit: 2 })
  assert.deepEqual([rest.requests.map(r => r.seq), rest.marks.map(m => m.seq), rest.seq, rest.more], [[3, 4], [], 4, true])
  const last = log.read(rest.seq, { limit: 2 })
  assert.deepEqual([last.requests, last.marks.map(m => m.seq), last.seq, last.more], [[], [5], 5, false])
  // nothing new: the cursor stays
  assert.deepEqual([log.read(5).seq, log.read(5).requests, log.read(5).marks, log.read(9).seq], [5, [], [], 9])
  for (const bad of [undefined, 'x', -1, 1.5]) assert.equal(log.read(bad).requests.length, 3, String(bad))
  // the default and the most: 2,000
  for (let i = 0; i < 2_500; i++) log.record('pr', { at: 10, method: 'GET', path: '/x', status: 200 })
  assert.equal(log.read(0).requests.length + log.read(0).marks.length, 2_000)
  assert.equal(log.read(0, { limit: 9_999 }).requests.length + log.read(0, { limit: 9_999 }).marks.length, 2_000)
  // a limit that isn't one is the most
  for (const limit of [0, -1]) assert.equal(log.read(0, { limit }).requests.length + log.read(0, { limit }).marks.length, 2_000, String(limit))
})

// The review's case: 2 × limit + 1 requests in one mark's window, the mark
// after them. Reading on from 0 reaches the end, and has everything.
test('a reader that reads on from 0 until `more` is false gets everything once, however the marks fall', () => {
  for (const limit of [5, 2_000]) {
    const c = clock(1_000)
    const log = createActionLog({ now: c.now })
    for (let i = 0; i < 2 * limit + 1; i++) log.record('pr', { at: 1_000, method: 'GET', path: `/p${i}`, status: 200 })
    c.tick(100)
    log.mark('pr', 'click')
    for (let i = 0; i < limit; i++) log.record('base', { at: 1_100, method: 'GET', path: `/b${i}`, status: 200 })
    let cursor = 0
    let reads = 0
    const seen = []
    for (;;) {
      const page = log.read(cursor, { limit })
      reads++
      seen.push(...page.requests.map(r => r.seq), ...page.marks.map(m => m.seq))
      cursor = page.seq
      if (!page.more) break
      assert.ok(reads < 100, 'it ends')
    }
    assert.equal(reads, Math.ceil((3 * limit + 2) / limit))
    assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 3 * limit + 2 }, (_, i) => i + 1), `limit ${limit}`)
  }
})

// Marks are bounded however long the session: a ring per pane.
test('each pane keeps its last keptMarks marks, counting the ones it let go in marksDropped', () => {
  const c = clock()
  const log = createActionLog({ now: c.now, keptMarks: 3, maxMarks: 100 })
  for (let i = 0; i < 5; i++) { log.mark('pr', 'click'); c.tick(1_000) }
  log.mark('base', 'click')
  const out = log.read(0)
  assert.deepEqual(out.marks.map(m => [m.pane, m.seq]), [['pr', 3], ['pr', 4], ['pr', 5], ['base', 6]])
  assert.deepEqual(out.marksDropped, { base: 0, pr: 2 })
  // by default four times the budget: 8,000 a pane
  const d = clock()
  const dflt = createActionLog({ now: d.now })
  for (let i = 0; i < 8_100; i++) { dflt.mark('pr', 'click'); d.tick(1_000) }
  let kept = 0
  for (let cursor = 0, page; (page = dflt.read(cursor)) && (kept += page.marks.length, page.more); cursor = page.seq);
  assert.deepEqual([kept, dflt.read(0).marksDropped.pr], [8_000, 100])
})

// Marks stay in time order: a clock that steps back is held at the last
// mark's time.
test('a mark is never earlier than the one before it', () => {
  const c = clock(1_000)
  const log = createActionLog({ now: c.now })
  log.mark('base', 'click')
  c.tick(-200)
  assert.equal(log.mark('pr', 'click').at, 1_000)
  c.tick(500)
  assert.equal(log.mark('pr', 'submit').at, 1_300)
})

// A reader keeps a cursor: `log` tells it when the log under the cursor is
// another session's, whose seq started again.
test('every read names its log, the same for one log and another for the next', () => {
  const a = createActionLog({ now: () => 1 })
  const b = createActionLog({ now: () => 1 })
  assert.match(a.read(0).log, /^[0-9a-f]{16}$/)
  assert.equal(a.read(0).log, a.read(5).log)
  assert.notEqual(a.read(0).log, b.read(0).log)
})

// One clock that only goes forward: a step back of the system clock stops
// no mark and puts no request before its mark.
test('the default clock is monotonic: a step back of the wall clock changes nothing', async (t) => {
  let wall = Date.now()
  t.mock.method(Date, 'now', () => (wall -= 3_600_000)) // an hour back at every look
  const log = createActionLog()
  assert.ok(log.mark('base', 'click'))
  await new Promise(r => setTimeout(r, 120))
  assert.ok(log.mark('base', 'click'), 'a mark 120 ms later is recorded')
  const at = monotonicNow()
  assert.ok(Math.abs(at - (performance.timeOrigin + performance.now())) < 5)
  log.record('base', { at, method: 'GET', path: '/x', status: 200 })
  const out = log.read(0)
  assert.ok(out.requests[0].at >= out.marks[1].at, 'the request after the mark it followed')
})
