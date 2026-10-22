// The data checks' pure engine (lib/data-diff.mjs, #8): what a pane's
// snapshot keeps, and masks; what changed between two snapshots of one pane;
// where the PR pane's changes depart from the base pane's; and which of them
// are destructive. No I/O.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LIMITS, SECRET_NAME, createMasker, diffSnapshots, divergence, flagChanges, sanitizeSnapshot, trustOf, validateRules,
} from '../lib/data-diff.mjs'

const KEY = Buffer.alloc(32, 7)
const masker = (rules = {}, key = KEY) => createMasker({ key, rules: validateRules(rules) })
const snap = (collections, rules = {}, limits) => sanitizeSnapshot({ collections }, { masker: masker(rules), rules: validateRules(rules), limits })

test('the limits, and the names that look secret', () => {
  assert.deepEqual(LIMITS, { maxRows: 10_000, maxBytes: 32 * 1024 * 1024, maxCollections: 1_000, timeoutMs: 30_000 })
  assert.ok(Object.isFrozen(LIMITS))
  for (const name of ['password', 'pass_hash', 'apiKey', 'api_key', 'client_secret', 'reset_token', 'otp', 'salt', 'private_key', 'session_id', 'card_number', 'ssn', 'iban', 'pw', 'user_pw', 'wifi-psk', 'auth', '_auth']) {
    assert.match(name, SECRET_NAME, name)
  }
  for (const name of ['email', 'name', 'id', 'quantity', 'topic', 'author', 'auth_provider', 'pwr', 'key']) assert.doesNotMatch(name, SECRET_NAME, name)
})

test('validateRules: data only, every list optional, names exact or with * globs; anything else throws', () => {
  assert.deepEqual(validateRules(undefined), { exclude: [], volatile: [], classify: [], softDelete: [], destructive: [] })
  const ok = validateRules({
    exclude: ['schema_migrations', 'auth.*'],
    volatile: [{ collection: '*', fields: ['updated_at'] }, { collection: 'sessions', fields: ['expires'], mode: 'presence' }],
    classify: [{ collection: 'users', fields: ['email'], as: 'pii' }],
    softDelete: [{ collection: 'orders', field: 'deleted_at' }],
    destructive: [{ collection: 'carts', maxChanged: 5, allowDeletes: true }],
  })
  assert.deepEqual(ok.volatile.map(v => v.mode), ['ignore', 'presence'])
  assert.deepEqual(ok.destructive, [{ collection: 'carts', maxChanged: 5, allowDeletes: true }])
  for (const [bad, re] of [
    [{ exclude: 'x' }, /exclude must be an array of collection names/],
    [{ exclude: [7] }, /exclude must be an array of collection names/],
    [{ exclude: [''] }, /exclude must be an array of collection names/],
    [{ volatile: {} }, /volatile must be an array/],
    [{ volatile: [null] }, /volatile\[0\]\.collection must be a collection name/],
    [{ volatile: [{ collection: 'x' }] }, /volatile\[0\]\.fields must be an array of field names/],
    [{ volatile: [{ collection: 'x', fields: ['a'], mode: 'drop' }] }, /volatile\[0\]\.mode must be ignore or presence/],
    [{ classify: [{ collection: 'x', fields: ['a'], as: 'public' }] }, /classify\[0\]\.as must be secret or pii/],
    [{ softDelete: [{ collection: 'x' }] }, /softDelete\[0\]\.field must be a field name/],
    [{ destructive: [{ collection: 'x', maxChanged: -1 }] }, /destructive\[0\]\.maxChanged must be a non-negative integer/],
    [{ destructive: [{ collection: 'x', allowDeletes: 'yes' }] }, /destructive\[0\]\.allowDeletes must be a boolean/],
    [{ keyOf: () => 'x' }, /unknown data rule: keyOf/],
    ['rules', /rules must be an object/],
    [[], /rules must be an object/],
  ]) assert.throws(() => validateRules(bad), re, JSON.stringify(bad))
  // a glob stands for any run of characters, and nothing else in it is special
  const s = snap({ 'auth.users': { key: null, rows: [] }, 'authXusers': { key: null, rows: [] }, 'a.b': { key: null, rows: [] } }, { exclude: ['auth.*'] })
  assert.deepEqual(Object.keys(s.collections), ['a.b', 'authXusers'])
})

// Owner decision B: values are shown, but a secret-looking or `secret`
// field keeps only a digest (so the harness can say it changed), and a
// `pii` one a fingerprint, its type and its length.
test('sanitizeSnapshot masks secret-looking and classified fields, fingerprints pii, and cuts long values', () => {
  const rules = { exclude: ['schema_*'], classify: [{ collection: 'users', fields: ['email'], as: 'pii' }, { collection: 'users', fields: ['note'], as: 'secret' }] }
  const out = snap({
    users: {
      key: ['id'], fields: ['id', 'email', 'password_hash', 'note', 'bio', 'prefs', 'score', 'big', 'blob', 'gone'],
      rows: [{
        id: 1, email: 'jane@example.org', password_hash: '$2b$10$abc', note: 'SECRET note', bio: 'x'.repeat(300),
        prefs: { theme: 'dark', api_key: 'sk-live-123' }, score: Infinity, big: 12n, blob: Buffer.from('raw bytes'), gone: null,
      }],
      count: 1,
    },
    schema_migrations: { key: null, rows: [{ v: 1 }] },
  }, rules)
  assert.deepEqual(out.problems, [])
  assert.deepEqual(Object.keys(out.collections), ['users'])
  const [row] = out.collections.users.rows
  assert.equal(row.id, 1)
  assert.deepEqual(Object.keys(row.email).sort(), ['fp', 'len', 't', 'type'])
  assert.deepEqual([row.email.t, row.email.type, row.email.len], ['pii', 'string', 16])
  assert.match(row.email.fp, /^[0-9a-f]{8}$/)
  assert.deepEqual(Object.keys(row.password_hash).sort(), ['d', 't'])
  assert.equal(row.password_hash.t, 'secret')
  assert.match(row.password_hash.d, /^[0-9a-f]{16}$/)
  assert.equal(row.note.t, 'secret')
  assert.deepEqual([row.bio.t, row.bio.s, row.bio.len], ['long', 'x'.repeat(200), 300])
  assert.match(row.bio.d, /^[0-9a-f]{16}$/)
  // a secret-looking key inside a JSON value is masked too
  assert.equal(row.prefs.t, 'json')
  assert.match(row.prefs.s, /^\{"theme":"dark","api_key":"\[secret [0-9a-f]{8}\]"\}$/)
  assert.equal(row.score, null)
  assert.equal(snap({ d: { key: null, rows: [{ when: new Date('nope') }] } }).collections.d.rows[0].when, null, 'an invalid date is no date')
  assert.equal(row.big, '12')
  assert.deepEqual([row.blob.t, row.blob.len], ['blob', 9])
  assert.match(row.blob.d, /^[0-9a-f]{16}$/)
  assert.equal(row.gone, null, 'a value that is not set says so, whatever its field')
  assert.doesNotMatch(JSON.stringify(out), /jane|example|\$2b|SECRET note|sk-live|raw bytes/)
  // the same value fingerprints alike under the same key, and differently under another
  const again = snap({ users: { key: ['id'], rows: [{ id: 2, email: 'jane@example.org' }] } }, rules)
  assert.equal(again.collections.users.rows[0].email.fp, row.email.fp)
  const other = sanitizeSnapshot({ collections: { users: { key: ['id'], rows: [{ id: 2, email: 'jane@example.org' }] } } }, { masker: masker(rules, Buffer.alloc(32, 8)), rules: validateRules(rules) })
  assert.notEqual(other.collections.users.rows[0].email.fp, row.email.fp)
  // a secret or pii value that isn't set shows as unset, so clearing one is
  // seen; one that is set never shows
  const unset = snap({ t: { key: ['id'], rows: [null, '', [], {}, 'x'].map((token, id) => ({ id, token, email: token })) } }, { classify: [{ collection: 't', fields: ['email'], as: 'pii' }] })
  assert.deepEqual(unset.collections.t.rows.map(r => r.token?.t ?? r.token), [null, '', 'json', 'json', 'secret'])
  assert.deepEqual(unset.collections.t.rows.map(r => r.email?.t ?? r.email), [null, '', 'json', 'json', 'pii'])
})

test('sanitizeSnapshot never throws, and copes with values that are not plain JSON', () => {
  const circular = { a: 1 }
  circular.self = circular
  const out = snap({ odd: { key: ['id'], rows: [{ id: 1, c: circular, f: () => 1, d: new Date(0), u: undefined }] } })
  const [row] = out.collections.odd.rows
  assert.equal(row.c.t, 'json')
  assert.equal(row.f, null)
  assert.equal(row.d, '1970-01-01T00:00:00.000Z')
  assert.equal(row.u, null)
})

test('sanitizeSnapshot keeps at most maxRows a collection and maxBytes in all, with the true count, and says what it refused', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i }))
  const out = snap({ big: { key: ['id'], rows }, told: { key: ['id'], rows: rows.slice(0, 3), count: 900, truncated: true } }, {}, { maxRows: 10 })
  assert.deepEqual([out.collections.big.rows.length, out.collections.big.count, out.collections.big.truncated], [10, 12, true])
  assert.deepEqual([out.collections.told.count, out.collections.told.truncated], [900, true])
  // the byte budget is shared fairly: the first collection gets half, the
  // last what is left (each key's JSON, ["id"], is charged too)
  const bytes = snap({ a: { key: ['id'], rows: [{ id: 1, s: 'x'.repeat(50) }] }, b: { key: ['id'], rows: [{ id: 1, s: 'y'.repeat(50) }] } }, {}, { maxBytes: 100 })
  assert.deepEqual([bytes.collections.a.truncated, bytes.collections.a.rows.length, bytes.collections.a.count, bytes.collections.b.truncated, bytes.collections.b.rows.length], [true, 0, 1, false, 1])
  // anything that isn't a snapshot is an empty one, with a problem
  for (const bad of [null, 'x', { collections: [] }, { collections: null }]) {
    const s = sanitizeSnapshot(bad, { masker: masker(), rules: validateRules({}) })
    assert.deepEqual([s.collections, s.problems.length], [{}, 1], JSON.stringify(bad))
  }
  const partly = snap({ a: { rows: 'x' }, b: { key: ['id'], rows: [{ id: 1 }, 'row', null, { id: 2 }] } })
  assert.deepEqual(Object.keys(partly.collections), ['b'])
  assert.deepEqual(partly.problems, ['a: rows must be an array', 'b: 2 rows are not objects'])
  assert.equal(partly.collections.b.rows.length, 2)
  // a key its rows don't all have, or that two rows share, can't be trusted: none
  assert.equal(snap({ c: { key: ['id'], rows: [{ id: 1 }, { other: 2 }] } }).collections.c.key, null)
  assert.equal(snap({ c: { key: ['id'], rows: [{ id: 1 }, { id: 1 }] } }).collections.c.key, null)
  assert.deepEqual(snap({ c: { key: ['a', 'b'], rows: [{ a: 1, b: 1 }, { a: 1, b: 2 }] } }).collections.c.key, ['a', 'b'])
})

const users = (rows, extra = {}) => ({ key: ['id'], fields: ['id', 'name', 'topic', 'updated_at'], rows, ...extra })

test('diffSnapshots: inserted, updated field by field, and deleted rows, by key; volatile fields never count', () => {
  const rules = { volatile: [{ collection: '*', fields: ['updated_at'] }] }
  const before = snap({ users: users([{ id: 1, name: 'a', topic: 'billing', updated_at: 1 }, { id: 2, name: 'b', topic: 'x', updated_at: 1 }]) }, rules)
  const after = snap({ users: users([{ id: 1, name: 'a', topic: '', updated_at: 2 }, { id: 3, name: 'c', topic: 'y', updated_at: 2 }]) }, rules)
  const u = diffSnapshots(before, after).collections.users
  assert.deepEqual([u.status, u.countBefore, u.countAfter, u.truncated], ['changed', 2, 2, false])
  assert.deepEqual(u.inserted, [{ key: '[3]', row: { id: 3, name: 'c', topic: 'y' } }])
  assert.deepEqual(u.deleted, [{ key: '[2]', row: { id: 2, name: 'b', topic: 'x' } }])
  assert.deepEqual(u.updated, [{ key: '[1]', fields: [{ field: 'topic', before: 'billing', after: '' }] }])
  // nothing changed but the volatile field: the same
  const same = diffSnapshots(before, snap({ users: users([{ id: 1, name: 'a', topic: 'billing', updated_at: 9 }, { id: 2, name: 'b', topic: 'x', updated_at: 9 }]) }, rules))
  assert.equal(same.collections.users.status, 'same')
  // a secret that changed shows only that it did
  const s = rows => snap({ accounts: { key: ['id'], rows } })
  const pw = diffSnapshots(s([{ id: 1, password: 'old' }]), s([{ id: 1, password: 'new' }])).collections.accounts.updated[0].fields[0]
  assert.deepEqual([pw.field, pw.before.t, pw.after.t, pw.before.d === pw.after.d], ['password', 'secret', 'secret', false])
})

test('diffSnapshots: presence-only fields count only when set or cleared; unkeyed collections diff as multisets', () => {
  const rules = { volatile: [{ collection: 'sessions', fields: ['token_expires'], mode: 'presence' }] }
  const s = rows => snap({ sessions: { key: ['id'], rows } }, rules)
  assert.equal(diffSnapshots(s([{ id: 1, token_expires: 10 }]), s([{ id: 1, token_expires: 20 }])).collections.sessions.status, 'same')
  const cleared = diffSnapshots(s([{ id: 1, token_expires: 10 }]), s([{ id: 1, token_expires: null }]))
  assert.deepEqual(cleared.collections.sessions.updated, [{ key: '[1]', fields: [{ field: 'token_expires', before: true, after: false }] }])

  const bag = rows => snap({ log: { key: null, rows } })
  const m = diffSnapshots(bag([{ a: 1 }, { a: 1 }, { a: 2 }]), bag([{ a: 1 }, { a: 3 }])).collections.log
  assert.deepEqual([m.inserted.map(r => r.row), m.deleted.map(r => r.row), m.updated], [[{ a: 3 }], [{ a: 1 }, { a: 2 }], []])
  assert.deepEqual([m.inserted[0].key, m.deleted[0].key], [null, null])
})

test('diffSnapshots: a truncated collection reports only its count; added and dropped collections, and added and dropped fields', () => {
  const big = (count, extra) => snap({ big: { key: ['id'], rows: [{ id: 1 }], count, truncated: true, ...extra } })
  const t = diffSnapshots(big(500), big(480)).collections.big
  assert.deepEqual([t.status, t.truncated, t.inserted, t.deleted, t.updated, t.countBefore, t.countAfter], ['changed', true, [], [], [], 500, 480])
  assert.equal(diffSnapshots(big(500), big(500)).collections.big.status, 'unknown', 'no claim either way past the count')
  const before = snap({ a: { key: ['id'], fields: ['id', 'x'], rows: [{ id: 1, x: 1 }] }, gone: { key: ['id'], rows: [{ id: 1 }] } })
  const after = snap({ a: { key: ['id'], fields: ['id', 'y'], rows: [{ id: 1, y: 0 }] }, fresh: { key: ['id'], rows: [{ id: 7 }] } })
  const d = diffSnapshots(before, after).collections
  assert.deepEqual([d.gone.status, d.gone.countBefore, d.gone.countAfter], ['dropped', 1, 0])
  assert.deepEqual([d.fresh.status, d.fresh.inserted], ['added', [{ key: '[7]', row: { id: 7 } }]])
  // a field that comes or goes with the schema is named once, not as an update to every row
  assert.deepEqual([d.a.status, d.a.fieldsDropped, d.a.fieldsAdded, d.a.updated], ['changed', ['x'], ['y'], []])
  // a key that changed: the rows diff as a multiset
  const rekeyed = diffSnapshots(snap({ k: { key: ['id'], rows: [{ id: 1, n: 'a' }] } }), snap({ k: { key: ['n'], rows: [{ id: 1, n: 'a' }] } })).collections.k
  assert.deepEqual([rekeyed.status, rekeyed.key, rekeyed.keyLost, rekeyed.inserted, rekeyed.deleted], ['changed', null, true, [], []], 'no key used, and the key it had is lost')
})

// Base and PR start from one seed and get the same mirrored actions: where
// their changes differ is where the PR's data behaviour departs from base's.
test('divergence: by key, each change is in both, the PR only, the base only, or differs; without a key, by count', () => {
  const s = rows => snap({ carts: { key: ['id'], rows } })
  const seed = s([{ id: 1, n: 1 }, { id: 2, n: 1 }, { id: 3, n: 1 }, { id: 4, n: 1 }])
  const base = diffSnapshots(seed, s([{ id: 2, n: 2 }, { id: 3, n: 5 }, { id: 4, n: 1 }, { id: 9, n: 1 }]))
  const pr = diffSnapshots(seed, s([{ id: 2, n: 2 }, { id: 3, n: 6 }, { id: 9, n: 2 }]))
  const v = divergence(base, pr).collections.carts
  assert.equal(v.status, 'differs')
  assert.deepEqual(v.changes.map(c => [c.kind, c.key, c.status]), [
    ['delete', '[1]', 'both'],
    ['update', '[2]', 'both'],
    ['update', '[3]', 'differs'],
    ['delete', '[4]', 'pr-only'],
    ['insert', '[9]', 'differs'],
  ])
  assert.deepEqual(v.changes[2].base, [{ field: 'n', before: 1, after: 5 }])
  assert.deepEqual(v.changes[3].base, null)
  const nothing = diffSnapshots(seed, seed)
  assert.equal(divergence(nothing, pr).collections.carts.status, 'pr-only')
  assert.equal(divergence(base, nothing).collections.carts.status, 'base-only')
  assert.equal(divergence(base, base).collections.carts.status, 'both')
  assert.equal(divergence(nothing, nothing).collections.carts.status, 'same')
  const mixed = divergence(diffSnapshots(seed, s([{ id: 2, n: 1 }, { id: 3, n: 1 }, { id: 4, n: 1 }])), diffSnapshots(seed, s([{ id: 1, n: 1 }, { id: 3, n: 1 }, { id: 4, n: 1 }])))
  assert.equal(mixed.collections.carts.status, 'differs', 'each did something the other didn\'t')

  const bag = rows => snap({ log: { key: null, rows } })
  const b0 = bag([])
  const lv = divergence(diffSnapshots(b0, bag([{ a: 1 }])), diffSnapshots(b0, bag([{ a: 1 }, { a: 2 }]))).collections.log
  assert.deepEqual([lv.status, lv.changes], ['differs', []])
  assert.deepEqual(lv.counts, { base: { inserted: 1, updated: 0, deleted: 0 }, pr: { inserted: 2, updated: 0, deleted: 0 } })
  assert.equal(divergence(diffSnapshots(b0, b0), diffSnapshots(b0, bag([{ a: 1 }]))).collections.log.status, 'pr-only')
  assert.equal(divergence(diffSnapshots(b0, bag([{ a: 1 }])), diffSnapshots(b0, bag([{ a: 1 }]))).collections.log.status, 'both')
  // a collection only one pane dropped, or added
  const two = snap({ x: { key: ['id'], rows: [{ id: 1 }] }, y: { key: ['id'], rows: [] } })
  const prDropped = divergence(diffSnapshots(two, two), diffSnapshots(two, snap({ y: { key: ['id'], rows: [] } }))).collections
  assert.deepEqual([prDropped.x.status, prDropped.y.status], ['pr-only', 'same'])
  const bothAdded = divergence(diffSnapshots(two, snap({ ...two.collections, z: { key: ['id'], rows: [] } })), diffSnapshots(two, snap({ ...two.collections, z: { key: ['id'], rows: [] } })))
  assert.equal(bothAdded.collections.z.status, 'both')
})

test('flagChanges: deletes, emptied and dropped collections, dropped fields, mass changes and cleared fields; red when only the PR did it', () => {
  const ruleSet = { softDelete: [{ collection: 'orders', field: 'deleted_at' }] }
  const rules = validateRules(ruleSet)
  const s = collections => snap(collections, ruleSet)
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, topic: 't', deleted_at: null }))
  const seedCollections = {
    saved_carts: { key: ['id'], rows: rows(3) },
    cart_items: { key: ['id'], rows: rows(2) },
    orders: { key: ['id'], rows: rows(2) },
    messages: { key: ['id'], fields: ['id', 'topic', 'deleted_at'], rows: rows(1) },
    big: { key: ['id'], rows: rows(30) },
    doomed: { key: ['id'], rows: rows(1) },
  }
  const seed = s(seedCollections)
  const base = diffSnapshots(seed, s({ ...seedCollections, cart_items: { key: ['id'], rows: [] } }))
  const pr = diffSnapshots(seed, s({
    saved_carts: { key: ['id'], rows: [] },
    cart_items: { key: ['id'], rows: [] },
    orders: { key: ['id'], rows: [{ id: 1, topic: 't', deleted_at: 5 }, { id: 2, topic: 't', deleted_at: null }] },
    messages: { key: ['id'], fields: ['id', 'deleted_at'], rows: [{ id: 1, deleted_at: null }] },
    big: { key: ['id'], rows: rows(30).map(r => ({ ...r, topic: 'u' })) },
  }))
  const flags = flagChanges(base, pr, rules, { trusted: true })
  // red first; what loses data before a column or a mass change
  assert.deepEqual(flags.map(f => [f.collection, f.kind, f.severity, f.pr, f.base]), [
    ['doomed', 'dropped', 'red', 1, 0],
    ['orders', 'delete', 'red', 1, 0],
    ['saved_carts', 'delete', 'red', 3, 0],
    ['saved_carts', 'emptied', 'red', 1, 0],
    ['big', 'mass-change', 'red', 30, 0],
    ['messages', 'column-dropped', 'red', 1, 0],
    ['cart_items', 'delete', 'amber', 2, 2],
    ['cart_items', 'emptied', 'amber', 1, 1],
  ])
  // a collection's dropped columns are one flag, with their number and the first five
  assert.deepEqual(flags.filter(f => f.kind === 'column-dropped').map(f => [f.count, f.fields, 'field' in f]), [[1, ['topic'], false]])
  // a cleared field is amber at most, and names the field
  const cleared = flagChanges(diffSnapshots(seed, seed), diffSnapshots(seed, s({ ...seedCollections, messages: { key: ['id'], fields: ['id', 'topic', 'deleted_at'], rows: [{ id: 1, topic: '', deleted_at: null }] } })), rules, { trusted: false })
  assert.deepEqual(cleared.map(f => [f.collection, f.kind, f.severity, f.field, f.pr]), [['messages', 'cleared', 'amber', 'topic', 1]])
  for (const empty of [null, [], {}]) {
    const c = flagChanges(diffSnapshots(seed, seed), diffSnapshots(seed, s({ ...seedCollections, messages: { key: ['id'], fields: ['id', 'topic', 'deleted_at'], rows: [{ id: 1, topic: empty, deleted_at: null }] } })), rules, { trusted: true })
    assert.deepEqual(c.map(f => f.kind), ['cleared'], JSON.stringify(empty))
  }
  // advisory (the PR pane may reach the base): the base's changes excuse nothing
  const advisory = flagChanges(base, pr, rules, { trusted: false })
  assert.deepEqual(advisory.filter(f => f.collection === 'cart_items').map(f => [f.severity, f.base]), [['red', 2], ['red', 1]])
  // per-collection rules: deletes allowed, a threshold of its own
  const allowed = flagChanges(base, pr, validateRules({ destructive: [{ collection: 'saved_carts', allowDeletes: true }, { collection: 'big', maxChanged: 50 }] }), { trusted: true })
  assert.equal(allowed.some(f => f.collection === 'saved_carts' && f.kind === 'delete'), false)
  assert.equal(allowed.some(f => f.collection === 'saved_carts' && f.kind === 'emptied'), true, 'emptying is still flagged')
  assert.equal(allowed.some(f => f.collection === 'big'), false, '30 of 30 is over 20%, but the rule says up to 50 rows')
})

test('flagChanges: the mass-change thresholds, and a truncated collection\'s fall in count', () => {
  const rows = (n, topic = 't') => Array.from({ length: n }, (_, i) => ({ id: i + 1, topic }))
  const s = (n, changed, total = n) => snap({ c: { key: ['id'], rows: [...rows(changed, 'u'), ...rows(n).slice(changed)].slice(0, total) } })
  const massOf = (n, changed) => flagChanges(diffSnapshots(s(n, 0), s(n, 0)), diffSnapshots(s(n, 0), s(n, changed)), validateRules({}), { trusted: true }).filter(f => f.kind === 'mass-change')
  assert.equal(massOf(100, 20).length, 0, '20 rows of 100: not over either threshold')
  assert.equal(massOf(200, 21).length, 1, 'over 20 rows')
  assert.equal(massOf(10, 2).length, 0, '20% of 10 rows: not over')
  assert.equal(massOf(10, 3).length, 1, 'over 20% of 10 rows')
  assert.equal(massOf(4, 4).length, 0, 'a collection of fewer than 5 rows: only the 20-row threshold')
  const big = (count) => snap({ big: { key: ['id'], rows: [{ id: 1 }], count, truncated: true } })
  const fall = flagChanges(diffSnapshots(big(500), big(500)), diffSnapshots(big(500), big(470)), validateRules({}), { trusted: true })
  assert.deepEqual(fall.map(f => [f.kind, f.pr, f.severity]), [['delete', 30, 'red'], ['mass-change', 30, 'red'], ['unverified', 1, 'red']])
})

test('trustOf: only an isolated session\'s base pane can excuse a PR change', () => {
  assert.equal(trustOf({ verdict: 'isolated', reasons: [] }), 'trusted')
  for (const v of [{ verdict: 'unknown' }, { verdict: 'reachable' }, { verdict: 'shared-host' }, { verdict: 'ISOLATED' }, null, undefined, 'isolated']) {
    assert.equal(trustOf(v), 'advisory', JSON.stringify(v))
  }
})

// --- What a self-review found ---------------------------------------------------

const none = validateRules({})
const kindsOf = (flags, kind) => flags.filter(f => f.kind === kind)

// The base excuses only what it did too: the same rows, the same fields. A
// count of the same kind isn't enough.
test('a flag is amber only when the base made the same change: the same rows, the same fields', () => {
  const s = ids => snap({ orders: { key: ['id'], fields: ['id'], rows: ids.map(id => ({ id })) } })
  const seed = s([1, 2, 3, 4, 5, 6])
  const deletes = (baseIds, prIds) => kindsOf(flagChanges(diffSnapshots(seed, s(baseIds)), diffSnapshots(seed, s(prIds)), none, { trusted: true }), 'delete')
  assert.deepEqual(deletes([1, 2, 3, 4, 5], [1, 2, 3, 4, 6]).map(f => [f.severity, f.pr, f.base]), [['red', 1, 1]], 'base deleted 6, the PR 5')
  assert.deepEqual(deletes([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]).map(f => f.severity), ['amber'])
  assert.deepEqual(deletes([2, 3, 4, 5, 6], [3, 4, 5, 6]).map(f => [f.severity, f.pr, f.base]), [['red', 2, 1]], 'the PR deleted more')
  // without a key, as multisets
  const bag = rows => snap({ log: { key: null, rows } })
  const b0 = bag([{ a: 1 }, { a: 2 }])
  const bagDeletes = (b, p) => kindsOf(flagChanges(diffSnapshots(b0, bag(b)), diffSnapshots(b0, bag(p)), none, { trusted: true }), 'delete').map(f => f.severity)
  assert.deepEqual(bagDeletes([{ a: 2 }], [{ a: 2 }]), ['amber'])
  assert.deepEqual(bagDeletes([{ a: 2 }], [{ a: 1 }]), ['red'])
  // truncated: by count
  const big = count => snap({ big: { key: ['id'], rows: [{ id: 1 }], count, truncated: true } })
  const truncated = (b, p) => kindsOf(flagChanges(diffSnapshots(big(100), big(b)), diffSnapshots(big(100), big(p)), none, { trusted: true }), 'delete').map(f => f.severity)
  assert.deepEqual(truncated(90, 95), ['amber'])
  assert.deepEqual(truncated(95, 90), ['red'])
  // dropped columns, one flag a collection: shared only when the base
  // dropped every one of them
  const cols = fields => snap({ users: { key: ['id'], fields, rows: [{ id: 1 }] } })
  const c0 = cols(['id', 'email', 'legacy'])
  const dropped = flagChanges(diffSnapshots(c0, cols(['id', 'email'])), diffSnapshots(c0, cols(['id'])), none, { trusted: true })
  assert.deepEqual(dropped.map(f => [f.kind, f.fields, f.count, f.severity, f.base]), [['column-dropped', ['email', 'legacy'], 2, 'red', 1]])
  const alike = flagChanges(diffSnapshots(c0, cols(['id'])), diffSnapshots(c0, cols(['id'])), none, { trusted: true })
  assert.deepEqual(alike.map(f => [f.kind, f.severity]), [['column-dropped', 'amber']])
  // the first five by name, whatever the declared order
  const w0 = cols(['id', 'g', 'f', 'e', 'd', 'c', 'b', 'a'])
  const wide = flagChanges(diffSnapshots(w0, w0), diffSnapshots(w0, cols(['id'])), none, { trusted: true })
  assert.deepEqual(wide.map(f => [f.count, f.fields]), [[7, ['a', 'b', 'c', 'd', 'e']]])
  // a mass change of other rows
  const many = topics => snap({ notes: { key: ['id'], rows: topics.map((topic, i) => ({ id: i + 1, topic })) } })
  const n0 = many(Array(60).fill('t'))
  const first = many([...Array(30).fill('u'), ...Array(30).fill('t')])
  const last = many([...Array(30).fill('t'), ...Array(30).fill('u')])
  const mass = b => kindsOf(flagChanges(diffSnapshots(n0, b), diffSnapshots(n0, first), none, { trusted: true }), 'mass-change').map(f => f.severity)
  assert.deepEqual(mass(first), ['amber'])
  assert.deepEqual(mass(last), ['red'])
})

test('only trusted: true trusts the base', () => {
  const s = rows => snap({ c: { key: ['id'], rows } })
  const seed = s([{ id: 1 }])
  const gone = diffSnapshots(seed, s([]))
  for (const trusted of ['advisory', 'trusted', 1, {}, undefined]) {
    assert.deepEqual(flagChanges(gone, gone, none, { trusted }).map(f => f.severity), ['red', 'red'], String(trusted))
  }
  assert.deepEqual(flagChanges(gone, gone, none, { trusted: true }).map(f => f.severity), ['amber', 'amber'])
})

test('masking: JSON kept as text, more secret-looking names, secret over pii, and values nested in JSON', () => {
  const out = snap({
    s: {
      key: ['id'],
      rows: [{
        id: 1,
        settings: '{"api_key":"sk-live-AAA","theme":"dark"}',
        broken: '{"api_key": no',
        nested: { n: 12n, bytes: new Uint8Array([1, 2, 3]), buf: Buffer.from('xyz'), when: new Date('nope') },
        password: 'hunter2',
        list: ['a@example.org'],
      }],
    },
  }, { classify: [{ collection: 's', fields: ['password', 'list'], as: 'pii' }] })
  const [row] = out.collections.s.rows
  assert.equal(row.settings.t, 'json')
  assert.match(row.settings.s, /^\{"api_key":"\[secret [0-9a-f]{8}\]","theme":"dark"\}$/)
  assert.match(row.broken, /^\[text with a secret-looking key, 14 characters, [0-9a-f]{8}\]$/, 'not JSON, but a secret-looking key shows: masked whole')
  assert.match(row.nested.s, /"n":"12"/)
  assert.match(row.nested.s, /"bytes":"\[3 bytes\]"/)
  assert.match(row.nested.s, /"buf":"\[3 bytes\]"/)
  assert.match(row.nested.s, /"when":null/)
  assert.equal(row.password.t, 'secret', 'a secret-looking name stays secret whatever classify says')
  assert.deepEqual([row.list.t, row.list.type], ['pii', 'array'])
  assert.doesNotMatch(JSON.stringify(out), /sk-live|hunter2|example\.org/)
  for (const name of ['authorization', 'cookie', 'credentials', 'pwd', 'cvv', 'jwt', 'bearer', 'access_key', 'aws_access_key_id', 'signing_key', 'client_key', 'dsn', 'database_url', 'signature', 'pin', 'pin_code']) {
    assert.match(name, SECRET_NAME, name)
  }
  for (const name of ['author_id', 'shipping', 'mapping', 'opinion']) assert.doesNotMatch(name, SECRET_NAME, name)
  // a secret's digest is its field's: the same value in two fields doesn't match
  const two = snap({ k: { key: ['id'], rows: [{ id: 1, token: 'same', api_key: 'same' }] } })
  assert.notEqual(two.collections.k.rows[0].token.d, two.collections.k.rows[0].api_key.d)
  // bytes digest by their contents, wherever they sit in memory
  const pooled = Buffer.from('abc')
  const fresh = new Uint8Array([97, 98, 99])
  const b = snap({ k: { key: ['id'], rows: [{ id: 1, x: pooled }, { id: 2, x: fresh }] } })
  assert.equal(b.collections.k.rows[0].x.d, b.collections.k.rows[1].x.d)
})

test('clearing a secret or pii value is seen; a soft delete is seen however it is stored, and never masked', () => {
  const rules = { classify: [{ collection: 'u', fields: ['email'], as: 'pii' }], softDelete: [{ collection: 'u', field: 'is_deleted' }, { collection: 'u', field: 'discarded' }, { collection: 'u', field: 'deleted_at' }] }
  const s = rows => snap({ u: { key: ['id'], rows } }, rules)
  const seed = s([1, 2, 3].map(id => ({ id, password_hash: 'h', email: 'a@example.org', is_deleted: 0, discarded: false, deleted_at: null })))
  // one row deleted each way the field can say so
  const now = s([
    { id: 1, password_hash: '', email: '', is_deleted: 1, discarded: false, deleted_at: null },
    { id: 2, password_hash: 'h', email: 'a@example.org', is_deleted: 0, discarded: true, deleted_at: null },
    { id: 3, password_hash: 'h', email: 'a@example.org', is_deleted: 0, discarded: false, deleted_at: 7 },
  ])
  const flags = flagChanges(diffSnapshots(seed, seed), diffSnapshots(seed, now), validateRules(rules), { trusted: true })
  assert.deepEqual(flags.map(f => [f.kind, f.field ?? null, f.pr]), [['delete', null, 3], ['cleared', 'email', 1], ['cleared', 'password_hash', 1]])
  assert.equal(now.collections.u.rows[1].discarded, true, 'a soft-delete field shows as it is')
  // undeleting is no clearing
  const undone = s([{ id: 1, password_hash: 'h', email: 'a@example.org', is_deleted: 0, discarded: false, deleted_at: null }])
  const was = s([{ id: 1, password_hash: 'h', email: 'a@example.org', is_deleted: 0, discarded: false, deleted_at: 5 }])
  assert.deepEqual(flagChanges(diffSnapshots(was, was), diffSnapshots(was, undone), validateRules(rules), { trusted: true }), [])
})

test('a schema change without a key is no change to every row; the key a diff names is the one it used', () => {
  const bag = (fields, rows) => snap({ log: { key: null, fields, rows } })
  const before = bag(['a'], Array.from({ length: 30 }, (_, i) => ({ a: i })))
  const after = bag(['a', 'b'], Array.from({ length: 30 }, (_, i) => ({ a: i, b: 0 })))
  const d = diffSnapshots(before, after).collections.log
  assert.deepEqual([d.status, d.inserted.length, d.deleted.length, d.fieldsAdded], ['changed', 0, 0, ['b']])
  assert.deepEqual(flagChanges(diffSnapshots(before, before), diffSnapshots(before, after), none, { trusted: true }), [])
  // a seed whose key can't be trusted (two rows share it) diffs as a multiset, and says so
  const dup = rows => snap({ c: { key: ['id'], rows } })
  const seed = dup([{ id: 1, n: 1 }, { id: 1, n: 2 }, { id: 2, n: 1 }, { id: 3, n: 1 }])
  const base = diffSnapshots(seed, dup([{ id: 1, n: 1 }, { id: 2, n: 1 }, { id: 3, n: 1 }]))
  const pr = diffSnapshots(seed, dup([{ id: 1, n: 1 }]))
  assert.equal(pr.collections.c.key, null)
  const v = divergence(base, pr).collections.c
  assert.deepEqual([v.status, v.counts.base.deleted, v.counts.pr.deleted], ['differs', 1, 3])
})

test('a truncated collection never claims nothing changed', () => {
  const big = (count, extra = {}) => snap({ big: { key: ['id'], rows: [{ id: 1 }], count, truncated: true, ...extra } })
  const t = diffSnapshots(big(500), big(500)).collections.big
  assert.deepEqual([t.status, t.truncated], ['unknown', true])
  const v = divergence(diffSnapshots(big(500), big(500)), diffSnapshots(big(500), big(500))).collections.big
  assert.deepEqual([v.status, v.truncated], ['unknown', true])
  const counted = divergence(diffSnapshots(big(100), big(90)), diffSnapshots(big(100), big(80))).collections.big
  assert.deepEqual([counted.status, counted.counts.base.deleted, counted.counts.pr.deleted], ['differs', 10, 20])
  // a schema change still shows
  const fields = f => big(500, { fields: f })
  const cols = divergence(diffSnapshots(fields(['id', 'x']), fields(['id', 'x'])), diffSnapshots(fields(['id', 'x']), fields(['id']))).collections.big
  assert.equal(cols.status, 'pr-only')
  // more rows counted than given is truncated; truncated with no count is a problem
  const short = snap({ a: { key: ['id'], rows: [{ id: 1 }], count: 5 }, b: { key: ['id'], rows: [{ id: 1 }], truncated: true } })
  assert.deepEqual([short.collections.a.truncated, short.collections.b.truncated], [true, true])
  assert.deepEqual(short.problems, ['b: truncated without a count'])
})

test('divergence: a collection one pane dropped while the other changed it differs; both added unlike rows differ; a field dropped in the PR only', () => {
  const s = collections => snap(collections)
  const seed = s({ x: { key: ['id'], fields: ['id', 'y'], rows: [{ id: 1, y: 1 }, { id: 2, y: 1 }] } })
  const v1 = divergence(diffSnapshots(seed, s({})), diffSnapshots(seed, s({ x: { key: ['id'], fields: ['id', 'y'], rows: [{ id: 1, y: 1 }] } }))).collections.x
  assert.equal(v1.status, 'differs')
  const added = rows => s({ ...seed.collections, z: { key: ['id'], rows } })
  assert.equal(divergence(diffSnapshots(seed, added([{ id: 1, n: 1 }])), diffSnapshots(seed, added([{ id: 1, n: 2 }]))).collections.z.status, 'differs')
  const v2 = divergence(diffSnapshots(seed, seed), diffSnapshots(seed, s({ x: { key: ['id'], fields: ['id'], rows: [{ id: 1 }, { id: 2 }] } }))).collections.x
  assert.deepEqual([v2.status, v2.changes.map(c => [c.kind, c.field, c.status])], ['pr-only', [['field-dropped', 'y', 'pr-only']]])
})

test('names that Object.prototype has are ordinary names', () => {
  const odd = { constructor: { key: ['id'], rows: [{ id: 1 }] }, toString: { key: null, rows: [] } }
  Object.defineProperty(odd, '__proto__', { value: { key: ['id'], rows: [JSON.parse('{"id":1,"__proto__":"x"}')] }, enumerable: true })
  const before = snap({})
  const after = sanitizeSnapshot({ collections: odd }, { masker: masker(), rules: none })
  assert.deepEqual(Object.keys(after.collections).sort(), ['__proto__', 'constructor', 'toString'])
  assert.equal(Object.hasOwn(after.collections.__proto__.rows[0], '__proto__'), true)
  const d = diffSnapshots(before, after).collections
  assert.deepEqual([d.constructor.status, d.toString.status], ['added', 'added'])
  assert.deepEqual(diffSnapshots(after, before).collections.constructor.status, 'dropped')
  const fields = diffSnapshots(snap({ c: { key: ['id'], rows: [{ id: 1 }] } }), snap({ c: { key: ['id'], rows: [{ id: 1, constructor: 1 }] } })).collections.c.updated
  assert.deepEqual(fields, [{ key: '[1]', fields: [{ field: 'constructor', before: null, after: 1 }] }])
})

test('rules: an exact destructive rule wins over a glob, and an entry with a field no rule has is refused', () => {
  const rules = validateRules({ destructive: [{ collection: '*', allowDeletes: true }, { collection: 'orders', maxChanged: 0 }] })
  const s = ids => snap({ orders: { key: ['id'], rows: ids.map(id => ({ id })) } })
  const flags = flagChanges(diffSnapshots(s([1, 2]), s([1, 2])), diffSnapshots(s([1, 2]), s([1])), rules, { trusted: true })
  assert.deepEqual(flags.map(f => f.kind), ['delete', 'mass-change'], 'orders\' own rule: deletes not allowed, and any change is mass')
  for (const [bad, re] of [
    [{ destructive: [{ collection: 'x', allowDelete: true }] }, /destructive\[0\] has a field no rule has: allowDelete/],
    [{ volatile: [{ collection: 'x', fields: ['a'], mood: 'ignore' }] }, /volatile\[0\] has a field no rule has: mood/],
  ]) assert.throws(() => validateRules(bad), re)
})

test('the thresholds\' edges, and volatile fields leave the key and the declared fields too', () => {
  const rows = (n, changed) => Array.from({ length: n }, (_, i) => ({ id: i + 1, topic: i < changed ? 'u' : 't' }))
  const s = (n, changed) => snap({ c: { key: ['id'], rows: rows(n, changed) } })
  const mass = (n, changed, rules = none) => kindsOf(flagChanges(diffSnapshots(s(n, 0), s(n, 0)), diffSnapshots(s(n, 0), s(n, changed)), rules, { trusted: true }), 'mass-change').length
  assert.equal(mass(5, 2), 1, '2 of 5 is over 20% of a collection of 5')
  assert.equal(mass(30, 30, validateRules({ destructive: [{ collection: 'c', maxChanged: 30 }] })), 0, 'up to maxChanged is no mass change')
  assert.equal(mass(30, 30, validateRules({ destructive: [{ collection: 'c', maxChanged: 29 }] })), 1)
  const v = snap({ c: { key: ['id', 'updated_at'], fields: ['id', 'updated_at', 'n'], rows: [{ id: 1, updated_at: 1, n: 1 }] } }, { volatile: [{ collection: 'c', fields: ['updated_at'] }] })
  assert.deepEqual([v.collections.c.key, v.collections.c.fields], [['id'], ['id', 'n']])
  // two cleared fields, in field order
  // the first row clears b, the second a: flags in field order all the same
  const two = (r1, r2) => snap({ m: { key: ['id'], rows: [{ id: 1, ...r1 }, { id: 2, ...r2 }] } })
  const full = two({ a: 'y', b: 'x' }, { a: 'y', b: 'x' })
  const cleared = flagChanges(diffSnapshots(full, full), diffSnapshots(full, two({ a: 'y', b: '' }, { a: '', b: 'x' })), none, { trusted: true })
  assert.deepEqual(cleared.map(f => f.field), ['a', 'b'])
  // a presence field that holds a date is set
  const p = snap({ d: { key: ['id'], rows: [{ id: 1, at: new Date(0) }] } }, { volatile: [{ collection: 'd', fields: ['at'], mode: 'presence' }] })
  assert.equal(p.collections.d.rows[0].at, true)
})

test('sanitizeSnapshot survives limits of null and rows that throw when read', () => {
  const hostile = { id: 1 }
  Object.defineProperty(hostile, 'boom', { enumerable: true, get() { throw new Error('getter') } })
  const out = sanitizeSnapshot({ collections: { ok: { key: ['id'], rows: [{ id: 1 }] }, bad: { key: ['id'], rows: [hostile] } } }, { masker: masker(), rules: none, limits: null })
  assert.deepEqual(Object.keys(out.collections), ['ok'])
  assert.deepEqual(out.problems, ['bad: could not be read: getter'])
})

// --- What the review of #35 found -------------------------------------------------

// A PR can't hide what it did by making its snapshot too big to keep: a
// collection cut short in the PR pane only is a red flag of its own, and
// divergence won't set its count beside the base's rows.
test('a PR that forces its snapshot over maxRows is flagged unverified, red, and divergence says unknown', () => {
  const users = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, email: `u${i}` }))
  const limits = { maxRows: 20 }
  const seed = snap({ users: { key: ['id'], rows: users(10) } }, {}, limits)
  const junk = Array.from({ length: 21 }, (_, i) => ({ id: 1_000 + i, email: 'junk' }))
  const pr = diffSnapshots(seed, snap({ users: { key: ['id'], rows: junk } }, {}, limits))
  const base = diffSnapshots(seed, seed)
  for (const trusted of [true, false]) {
    const flags = flagChanges(base, pr, none, { trusted })
    assert.deepEqual(flags.filter(f => f.kind === 'unverified').map(f => [f.collection, f.severity, f.shared]), [['users', 'red', false]], String(trusted))
  }
  assert.equal(divergence(base, pr).collections.users.status, 'unknown')
})

// The byte budget is shared fairly: a collection a PR adds, that sorts first
// and is huge, can't starve the ones it means to hide changes in.
test('a padding collection can\'t use up the byte budget: the real collection is kept whole, and its mass update flagged', () => {
  const users = (n, role) => Array.from({ length: n }, (_, i) => ({ id: i + 1, role }))
  const limits = { maxBytes: 4_000 }
  const seed = snap({ users: { key: ['id'], rows: users(40, 'member') } }, {}, limits)
  const padding = { aaa_padding: { key: ['id'], rows: Array.from({ length: 30 }, (_, i) => ({ id: i, pad: 'p'.repeat(200) })) } }
  const after = snap({ ...padding, users: { key: ['id'], rows: users(40, 'admin') } }, {}, limits)
  assert.deepEqual([after.collections.users.truncated, after.collections.users.rows.length], [false, 40])
  assert.equal(after.collections.aaa_padding.truncated, true, 'the padding is what gets cut')
  const flags = flagChanges(diffSnapshots(seed, seed), diffSnapshots(seed, after), none, { trusted: false })
  // the padding, which only the PR pane has, is folded into one flag after the base's collections
  assert.deepEqual(flags.map(f => [f.collection, f.kind, f.severity]), [['users', 'mass-change', 'red'], [null, 'unverified', 'red']])
  assert.deepEqual([flags[1].collections, flags[1].names], [1, ['aaa_padding']])
  // more collections than the limit: those past it, by rows, are kept as counts, said so
  const many = sanitizeSnapshot({ collections: Object.fromEntries([['a', 1], ['b', 3], ['c', 2]].map(([n, k]) => [n, { key: null, rows: Array(k).fill({ v: 1 }) }])) }, { masker: masker(), rules: none, limits: { maxCollections: 2 } })
  assert.deepEqual([Object.keys(many.collections), many.collections.a, many.problems], [['a', 'b', 'c'], { key: null, fields: null, rows: [], count: 1, truncated: true }, ['1 collections past the first 2 by rows are kept as counts only: a']])
})

// A count stands for rows only when both sides have only counts: the base's
// known rows never excuse a PR's cut-short count.
test('a trusted session never excuses a PR delete by count when only the PR side is cut short', () => {
  const orders = ids => ({ orders: { key: ['id'], rows: ids.map(id => ({ id })) } })
  const limits = { maxRows: 12 }
  const seed = snap(orders([1, 2, 3, 4, 5]), {}, limits)
  const base = diffSnapshots(seed, snap(orders([1, 2, 3, 5]), {}, limits)) // deletes 4
  const pr = diffSnapshots(seed, snap(orders([1, 2, 4, 5, 10, 11, 12, 13, 14, 15, 16, 17, 18]), {}, limits)) // deletes 3, and cuts itself short
  assert.equal(pr.collections.orders.truncated, true)
  const flags = flagChanges(base, pr, none, { trusted: true })
  assert.deepEqual(flags.map(f => [f.kind, f.severity, f.shared]), [['unverified', 'red', false]], 'the count rose: no delete by count, but unverified')
  // the base deletes two known rows, the PR's cut-short count falls by two:
  // the same count, but not the same rows, so not shared
  const baseTwo = diffSnapshots(seed, snap(orders([1, 2, 3]), {}, limits))
  const fell = diffSnapshots(seed, snap(orders([1, 2, 4]), {}, { maxRows: 2 }))
  const both = flagChanges(baseTwo, fell, none, { trusted: true })
  assert.deepEqual(both.filter(f => f.kind === 'delete').map(f => [f.severity, f.shared, f.pr, f.base]), [['red', false, 2, 2]], 'a cut-short fall in count against known rows')
  assert.equal(divergence(base, pr).collections.orders.status, 'unknown')
  // both cut short, the count the same: only listed, amber (and `unknown` in divergence)
  const big = count => snap({ big: { key: ['id'], rows: [{ id: 1 }], count, truncated: true } })
  assert.deepEqual(flagChanges(diffSnapshots(big(500), big(500)), diffSnapshots(big(500), big(500)), none, { trusted: true }).map(f => [f.kind, f.severity]), [['unverified', 'amber']])
})

test('the byte budget goes to the collections with the fewest rows first, so small ones leave more for the big', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, v: 'x'.repeat(10) }))
  const out = snap({ aaa_users: { key: ['id'], rows: rows(40) }, b: { key: ['id'], rows: rows(1) }, c: { key: ['id'], rows: rows(1) } }, {}, { maxBytes: 1_500 })
  assert.deepEqual(['aaa_users', 'b', 'c'].map(n => out.collections[n].truncated), [false, false, false])
})

// shared says whether the base made the same change, whatever the trust:
// the wrong row, or more rows, is not the same change.
test('flags say whether the base made the same change: the wrong row or more rows is not shared', () => {
  const s = ids => snap({ c: { key: ['id'], rows: ids.map(id => ({ id })) } })
  const seed = s([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  const without = (...gone) => s(seed.collections.c.rows.map(r => r.id).filter(id => !gone.includes(id)))
  const baseDeletes1 = diffSnapshots(seed, without(1))
  for (const trusted of [true, false]) {
    const wrongRow = flagChanges(baseDeletes1, diffSnapshots(seed, without(2)), none, { trusted }).find(f => f.kind === 'delete')
    assert.deepEqual([wrongRow.severity, wrongRow.shared, wrongRow.base], ['red', false, 1], `wrong row, trusted ${trusted}`)
    const overDelete = flagChanges(baseDeletes1, diffSnapshots(seed, without(1, 2, 3, 4)), none, { trusted }).find(f => f.kind === 'delete')
    assert.deepEqual([overDelete.severity, overDelete.shared], ['red', false], `over-delete, trusted ${trusted}`)
    const same = flagChanges(baseDeletes1, diffSnapshots(seed, without(1)), none, { trusted }).find(f => f.kind === 'delete')
    assert.deepEqual([same.severity, same.shared], [trusted ? 'amber' : 'red', true], `the same row, trusted ${trusted}`)
  }
})

test('a mass change of other fields on the same rows is not the base\'s', () => {
  const rows = field => Array.from({ length: 30 }, (_, i) => ({ id: i + 1, topic: 't', role: 'member', ...(field ? { [field]: 'x' } : {}) }))
  const s = field => snap({ c: { key: ['id'], rows: rows(field) } })
  const seed = s(null)
  const flags = flagChanges(diffSnapshots(seed, s('topic')), diffSnapshots(seed, s('role')), none, { trusted: true })
  assert.deepEqual(flags.map(f => [f.kind, f.severity, f.shared]), [['mass-change', 'red', false]])
  const same = flagChanges(diffSnapshots(seed, s('role')), diffSnapshots(seed, s('role')), none, { trusted: true })
  assert.deepEqual(same.map(f => [f.kind, f.severity]), [['mass-change', 'amber']])
})

test('a key the PR\'s rows no longer bear out is flagged, even where deletes are allowed', () => {
  const rules = validateRules({ destructive: [{ collection: 'c', allowDeletes: true }] })
  const s = rows => snap({ c: { key: ['id'], rows } })
  const seed = s([{ id: 1, name: 'a' }, { id: 2, name: 'b' }])
  const pr = diffSnapshots(seed, s([{ id: 1, name: '' }, { id: 1, name: 'b' }]))
  assert.equal(pr.collections.c.keyLost, true)
  assert.deepEqual(flagChanges(diffSnapshots(seed, seed), pr, rules, { trusted: true }).map(f => [f.kind, f.severity]), [['key-lost', 'red']])
})

test('masking reaches JSON in nested strings and NDJSON, secret-looking keys in text, and more secret-looking names', () => {
  const out = snap({
    logs: {
      key: ['id'],
      rows: [{
        id: 1,
        request: { path: '/login', body: '{"password":"hunter2","user":"a"}' },
        events: ['{"api_key":"sk-live-AAA"}'],
        line: '{"token":"tok-123"}\n{"x":1}',
        raw: 'user=a password: hunter3 ok',
        deep: { a: '{"b":"{\\"c\\":\\"{\\\\\\"secret\\\\\\":\\\\\\"s4\\\\\\"}\\"}"}' },
        headers: { 'X-Api-Key': 'sk-live-BBB', 'Content-Type': 'json' },
        nums: { pin: 1234 },
        sets: new Set(['a', 'b']),
        maps: new Map([['k', 'v']]),
      }],
    },
  })
  const text = JSON.stringify(out)
  assert.doesNotMatch(text, /hunter2|hunter3|sk-live|tok-123|1234|s4/)
  const [row] = out.collections.logs.rows
  assert.match(row.request.s, /"body":"\{\\"password\\":\\"\[secret [0-9a-f]{8}\]\\",\\"user\\":\\"a\\"\}"/)
  assert.match(row.line, /^\{"token":"\[secret [0-9a-f]{8}\]"\}\n\{"x":1\}$/)
  assert.match(row.raw, /^\[text with a secret-looking key, 27 characters, [0-9a-f]{8}\]$/)
  assert.match(row.headers.s, /"Content-Type":"json"/)
  assert.deepEqual([row.sets.s, row.maps.s], ['["a","b"]', '[["k","v"]]'])
  for (const name of ['X-Api-Key', 'api-key', 'x-access-key', 'database_uri', 'mongo_uri', 'connection_string', 'encryption_key', 'master_key', 'mnemonic', 'seed_phrase', 'recovery_codes', 'pinCode', 'pin_code']) {
    assert.match(name, SECRET_NAME, name)
  }
  // too long to read as JSON: kept as text, masked whole when a secret-looking key shows
  const big = `{"password":"${'x'.repeat(300 * 1024)}"}`
  const huge = snap({ c: { key: ['id'], rows: [{ id: 1, blob: big, fine: `{"a":"${'y'.repeat(300 * 1024)}"}` }] } }).collections.c.rows[0]
  assert.match(huge.blob, /^\[text with a secret-looking key, \d+ characters, [0-9a-f]{8}\]$/)
  assert.deepEqual([huge.fine.t, huge.fine.len], ['long', 300 * 1024 + 8])
})

test('a nested secret\'s digest is its collection\'s and field\'s; the same pii fingerprints alike in two tables; a soft delete set again is no delete', () => {
  const s = snap({
    a: { key: ['id'], rows: [{ id: 1, x: { token: 'same' }, y: { token: 'same' }, email: 'jo@example.org' }] },
    b: { key: ['id'], rows: [{ id: 1, x: { token: 'same' }, email: 'jo@example.org' }] },
  }, { classify: [{ collection: '*', fields: ['email'], as: 'pii' }] })
  const digest = cell => /\[secret ([0-9a-f]{8})\]/.exec(cell.s)[1]
  const [ra] = s.collections.a.rows
  const [rb] = s.collections.b.rows
  assert.equal(new Set([digest(ra.x), digest(ra.y), digest(rb.x)]).size, 3)
  assert.equal(ra.email.fp, rb.email.fp)
  const rules = { softDelete: [{ collection: 'o', field: 'deleted_at' }] }
  const o = at => snap({ o: { key: ['id'], rows: [{ id: 1, deleted_at: at }] } }, rules)
  assert.deepEqual(flagChanges(diffSnapshots(o(5), o(5)), diffSnapshots(o(5), o(7)), validateRules(rules), { trusted: true }), [])
})

test('the masker\'s memory of collections is bounded, and names with NUL in them don\'t collide', () => {
  const m = masker({ classify: [{ collection: 'a\u0000b', fields: ['c'], as: 'pii' }] })
  assert.equal(m.cell('a\u0000b', 'c', 'v').t, 'pii')
  assert.equal(m.cell('a', 'b\u0000c', 'v'), 'v')
  for (let i = 0; i < 1_500; i++) m.cell(`c${i}`, 'f', 'v')
  assert.ok(m.cached() <= 1_000, String(m.cached()))
  // a snapshot whose collections can't be listed is a problem, not a throw
  const hostile = new Proxy({}, { ownKeys() { throw new Error('nope') } })
  assert.deepEqual(sanitizeSnapshot({ collections: hostile }, { masker: masker(), rules: none }).problems, ['the snapshot could not be read: nope'])
})

// --- Round 2 of #35's review --------------------------------------------------------

// The review's case: a PR's migration adds 1,000 one-row collections that
// sort first. The collections past maxCollections are now chosen by rows,
// most first, and kept as counts, never left out unsaid.
test('padding collections can\'t push a collection out of the PR\'s snapshots: the biggest are kept, the rest as counts, and a wipe still shows', () => {
  const people = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `p${i}` })) })
  const pad = rowsEach => Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`aaa${String(i).padStart(4, '0')}`, people(rowsEach)]))
  const seed = snap({ users: people(50) })
  const base = diffSnapshots(seed, seed)
  // one-row padding: users, the biggest, is kept whole
  const s1 = snap({ ...pad(1), users: people(50) })
  assert.deepEqual([s1.collections.users.truncated, s1.collections.users.rows.length], [false, 50])
  const sn = snap({ ...pad(1), users: people(0) })
  const wiped = flagChanges(diffSnapshots(seed, seed), diffSnapshots(s1, sn), none, { trusted: true }).filter(f => f.collection === 'users')
  // emptied, users has the fewest rows, and is kept as its count: still red
  // cut short in the PR pane only: its unverified flag stands with what loses rows
  assert.deepEqual(wiped.map(f => [f.kind, f.severity]), [['delete', 'red'], ['emptied', 'red'], ['unverified', 'red'], ['mass-change', 'red']])
  assert.match(s1.problems[0], /^1 collections past the first 1000 by rows are kept as counts only: aaa\d{4}$/)

  // padding bigger than users: users is kept as its count, and a wipe is
  // still red, with nothing excused
  const t1 = snap({ ...pad(2), users: people(1) })
  assert.deepEqual(t1.collections.users, { key: null, fields: null, rows: [], count: 1, truncated: true })
  const tn = snap({ ...pad(2), users: people(0) })
  const pr = diffSnapshots(t1, tn)
  for (const trusted of [true, false]) {
    const flags = flagChanges(base, pr, none, { trusted }).filter(f => f.collection === 'users')
    assert.deepEqual(flags.map(f => [f.kind, f.severity]), [['delete', 'red'], ['emptied', 'red'], ['unverified', 'red']], String(trusted))
  }
  // even unchanged, a collection the PR pane keeps as a count alone is unverified
  assert.deepEqual(flagChanges(base, diffSnapshots(t1, t1), none, { trusted: true }).map(f => [f.collection, f.kind, f.severity]), [['users', 'unverified', 'red']])
})

// Past the counts kept too, a collection is left out, said so. Then the
// PR pane's diff lacks a collection the base pane's has: unverified, and
// divergence can't say `same`.
test('a collection the PR pane\'s diff lacks while the base pane\'s has it is unverified, and divergence says unknown', () => {
  const many = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${String(i).padStart(2, '0')}`, { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }]))
  const limits = { maxCollections: 2 }
  const seed = snap({ users: { key: ['id'], rows: [{ id: 1 }] } }, {}, limits)
  const padded = snap({ ...many(25), users: { key: ['id'], rows: [{ id: 1 }] } }, {}, limits)
  assert.equal(Object.hasOwn(padded.collections, 'users'), false)
  assert.deepEqual(padded.problems, [
    '20 collections past the first 2 by rows are kept as counts only: c02, c03, c04, c05, c06 and 15 more',
    '4 collections past those were left out: c22, c23, c24 and users',
  ])
  const base = diffSnapshots(seed, seed)
  const pr = diffSnapshots(padded, padded)
  for (const trusted of [true, false]) {
    const flags = flagChanges(base, pr, none, { trusted }).filter(f => f.collection === 'users')
    assert.deepEqual(flags.map(f => [f.kind, f.severity, f.shared]), [['unverified', 'red', false]], String(trusted))
  }
  assert.equal(divergence(base, pr).collections.users.status, 'unknown')
  // the other way about, a collection the PR added: the PR's own
  const added = diffSnapshots(seed, snap({ users: { key: ['id'], rows: [{ id: 1 }] }, extra: { key: ['id'], rows: [{ id: 1 }] } }, {}, limits))
  assert.equal(divergence(base, added).collections.extra.status, 'pr-only')
})

// A regression the round-1 fix made: a Set or Map is set when it has
// entries, so one in a secret-looking, classify-secret or pii field is
// masked like any other value.
test('a Set or Map with entries is set: in a secret or pii field it is masked, and an empty one is kept as it is', () => {
  const rules = { classify: [{ collection: 'c', fields: ['vault'], as: 'secret' }, { collection: 'c', fields: ['emails'], as: 'pii' }] }
  const [row] = snap({
    c: {
      key: ['id'],
      rows: [{
        id: 1, recovery_codes: new Set(['RC-1111', 'RC-2222']), vault: new Map([['k', 'vault-secret']]), emails: new Set(['jane@example.org']), empty: new Set(), tokens: new Map(),
      }],
    },
  }, rules).collections.c.rows
  assert.doesNotMatch(JSON.stringify(row), /RC-1111|vault-secret|jane@example/)
  assert.deepEqual([row.recovery_codes.t, row.vault.t, row.emails.t, row.emails.type], ['secret', 'secret', 'pii', 'object'])
  assert.deepEqual([row.empty, row.tokens], [{ t: 'json', s: '[]' }, { t: 'json', s: '[]' }])
  // the entries decide the digest: another code is another digest
  const again = snap({ c: { key: ['id'], rows: [{ id: 1, recovery_codes: new Set(['RC-1111', 'RC-3333']) }] } }, rules).collections.c.rows[0]
  assert.notEqual(again.recovery_codes.d, row.recovery_codes.d)
})

// The text scan is linear: a secret-looking key is looked for at word
// starts only, in text that has a ':' or '=', and in its first 256 KB, which
// is far past the 200 characters a cell shows.
test('scanning text for secret-looking keys is linear: a 10 MB cell, and 50 NDJSON ones, are read in well under the old 11 s', () => {
  // long words, then an '=': the old scan tried 64 lengths at every position
  const keyish = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1 '.repeat(150_000) + 'k=v'
  const ndjson = Array.from({ length: 1_000 }, (_, i) => `{"n":${i},"msg":"${'m'.repeat(200)}"}`).join('\n')
  const started = performance.now()
  const out = snap({ c: { key: ['id'], rows: [{ id: 1, a: keyish }, ...Array.from({ length: 50 }, (_, i) => ({ id: i + 2, log: ndjson }))] } })
  const took = performance.now() - started
  // about 1.2 s alone; under half the old 11 s, with room for a loaded runner
  assert.ok(took < 5_000, `${Math.round(took)} ms`)
  assert.equal(out.collections.c.rows[0].a.t, 'long')
  // a key past the first 256 KB isn't looked for: a cell shows only its first 200 characters
  const far = snap({ c: { key: ['id'], rows: [{ id: 1, t: `${'x '.repeat(150 * 1024)}password=hunter7` }] } }).collections.c.rows[0]
  assert.deepEqual([far.t.t, far.t.s], ['long', 'x '.repeat(100)])
  // text with no ':' or '=' is never scanned for keys, however long
  const bare = snap({ c: { key: ['id'], rows: [{ id: 1, b: 'x'.repeat(20 * 1024 * 1024) }] } }).collections.c.rows[0]
  assert.deepEqual([bare.b.t, bare.b.len], ['long', 20 * 1024 * 1024])
})

// Keys written with escaped quotes, double-encoded JSON, form parameters
// and XML are found too.
test('text masking finds keys in escaped quotes, double-encoded JSON, brackets and XML', () => {
  const cases = {
    escaped: 'level=info body="{\\"password\\":\\"hunter2\\"}"',
    double: JSON.stringify(JSON.stringify({ password: 'hunter3', user: 'a' })),
    form: 'user[name]=a&user[password]=hunter4',
    xml: '<login><user>a</user><password>hunter5</password></login>',
    single: "{'api_key': 'sk-live-CCC'}",
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...cases }] } }).collections.c.rows
  assert.doesNotMatch(JSON.stringify(row), /hunter|sk-live/)
  // double-encoded JSON is read as the JSON it holds
  assert.match(row.double.s, /^\{"password":"\[secret [0-9a-f]{8}\]","user":"a"\}$/)
  for (const field of ['escaped', 'form', 'xml', 'single']) assert.match(row[field], /^\[text with a secret-looking key, \d+ characters, [0-9a-f]{8}\]$/, field)
  // `key=` text needs a secret-looking key, at a word's start
  const [plainRow] = snap({ c: { key: ['id'], rows: [{ id: 1, a: 'token=abc', b: 'mytoken=abc', c: 'topic=abc', d: 'no keys here' }] } }).collections.c.rows
  assert.match(plainRow.a, /^\[text with a secret-looking key/)
  assert.match(plainRow.b, /^\[text with a secret-looking key/)
  assert.deepEqual([plainRow.c, plainRow.d], ['topic=abc', 'no keys here'])
  // a long key, up to 128 characters
  const [longRow] = snap({ c: { key: ['id'], rows: [{ id: 1, a: `${'k'.repeat(100)}_password=hunter8` }] } }).collections.c.rows
  assert.match(longRow.a, /^\[text with a secret-looking key/)
})

// The masker's memory is bounded in all, not per collection.
test('the masker remembers at most 50,000 fields in all', () => {
  const m = masker()
  for (let c = 0; c < 1_000; c++) for (let f = 0; f < 100; f++) m.cell(`c${c}`, `field_${f}_${c}`, 'v')
  assert.ok(m.cachedFields() <= 50_000, String(m.cachedFields()))
  assert.ok(m.cached() <= 1_000)
  // what it can't remember it still works out
  assert.equal(m.cell('c999', 'password_new', 'x').t, 'secret')
  // starting again, it remembers again
  m.cell('c1000', 'f', 'v')
  assert.equal(m.cachedFields(), 1)
})

test('more secrets: names, URL credentials, Bearer values, name and value pairs, and raw header lists', () => {
  for (const name of ['ssh_key', 'sshKey', 'redis_url', 'REDIS_URL', 'backup_codes', 'backup_code', 'amqp_url', 'postgres_url', 'signing-key', 'client-key', 'pin', 'user-pin']) {
    assert.match(name, SECRET_NAME, name)
  }
  for (const name of ['spinner', 'pinned', 'url', 'site_url', 'backup']) assert.doesNotMatch(name, SECRET_NAME, name)
  const [row] = snap({
    c: {
      key: ['id'],
      rows: [{
        id: 1,
        origin: 'postgres://app:pw-hunter6@db.internal:5432/app',
        note: 'then Bearer eyJhbGciOiJIUzI1NiJ9abcdef was sent',
        har: { headers: [{ name: 'Authorization', value: 'Bearer sk-live-DDD' }, { name: 'Accept', value: 'text/html' }] },
        kv: [{ key: 'api_key', value: 'sk-live-EEE' }],
        raw: { rawHeaders: ['Host', 'example.org', 'Cookie', 'sid=s3cr3t'] },
      }],
    },
  }).collections.c.rows
  const text = JSON.stringify(row)
  assert.doesNotMatch(text, /pw-hunter6|eyJhbGciOiJIUzI1NiJ9abcdef|sk-live|s3cr3t/)
  assert.match(row.origin, /^postgres:\/\/app:\[secret [0-9a-f]{8}\]@db\.internal:5432\/app$/)
  assert.match(row.note, /^then Bearer \[secret [0-9a-f]{8}\] was sent$/)
  assert.match(row.har.s, /"text\/html"/, 'a pair whose name isn\'t secret-looking is kept')
  assert.match(row.raw.s, /"Host","example\.org","Cookie","\[secret [0-9a-f]{8}\]"/)
})

// The same fields changed to other values are another change: the base
// setting role to editor doesn't excuse the PR setting it to admin.
test('a mass change of the same field to other values is not the base\'s', () => {
  const s = role => snap({ c: { key: ['id'], rows: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, role })) } })
  const seed = s('member')
  const other = flagChanges(diffSnapshots(seed, s('editor')), diffSnapshots(seed, s('admin')), none, { trusted: true })
  assert.deepEqual(other.map(f => [f.kind, f.severity, f.shared]), [['mass-change', 'red', false]])
  const same = flagChanges(diffSnapshots(seed, s('admin')), diffSnapshots(seed, s('admin')), none, { trusted: true })
  assert.deepEqual(same.map(f => [f.kind, f.severity, f.shared]), [['mass-change', 'amber', true]])
})

// Cut short in both panes with no change in count: nothing can be seen,
// which the flags say, amber.
test('a collection cut short in both panes with its count unchanged is listed as unverified, amber; with its count changed alike, red unless trusted', () => {
  const big = count => snap({ big: { key: ['id'], rows: [{ id: 1 }], count, truncated: true } })
  for (const trusted of [true, false]) {
    assert.deepEqual(flagChanges(diffSnapshots(big(500), big(500)), diffSnapshots(big(500), big(500)), none, { trusted }).map(f => [f.kind, f.severity, f.shared]), [['unverified', 'amber', true]], String(trusted))
  }
  const fell = flagChanges(diffSnapshots(big(500), big(490)), diffSnapshots(big(500), big(490)), none, { trusted: false })
  assert.deepEqual(fell.map(f => [f.kind, f.severity, f.shared]), [['delete', 'red', true], ['unverified', 'red', true]], 'untrusted: nothing excused')
})

// Mutants the round-1 tests let live.
test('the byte budget is shared out as it is used, so the total stays within maxBytes', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, v: 'x'.repeat(50) }))
  const collections = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, { key: ['id'], rows: rows(100 + i) }]))
  const out = snap(collections, {}, { maxBytes: 20_000 })
  const total = Object.values(out.collections).reduce((n, c) => n + c.rows.reduce((m, r) => m + Buffer.byteLength(JSON.stringify(r)), 0), 0)
  assert.ok(total <= 20_000, String(total))
})

test('nested secrets under different keys in one field get different digests; the same pii fingerprints alike under different field names', () => {
  const s = snap({
    users: { key: ['id'], rows: [{ id: 1, x: { token: 'same', secret: 'same' }, email: 'jo@example.org' }] },
    orders: { key: ['id'], rows: [{ id: 1, customer_email: 'jo@example.org' }] },
  }, { classify: [{ collection: 'users', fields: ['email'], as: 'pii' }, { collection: 'orders', fields: ['customer_email'], as: 'pii' }] })
  const digests = [...s.collections.users.rows[0].x.s.matchAll(/\[secret ([0-9a-f]{8})\]/g)].map(m => m[1])
  assert.equal(new Set(digests).size, 2)
  assert.equal(s.collections.users.rows[0].email.fp, s.collections.orders.rows[0].customer_email.fp)
})

// #36's review: a migration that adds 1,600 columns to each of many tables,
// then drops them. Comparing the declared fields is linear in them.
test('comparing declared fields is linear: 50 tables of 1,600 columns added and dropped compare in well under a second each way', () => {
  const cols = Array.from({ length: 1_600 }, (_, i) => `column_with_a_rather_long_name_${String(i).padStart(4, '0')}`)
  const at = fields => snap(Object.fromEntries(Array.from({ length: 50 }, (_, t) => [`t${t}`, { key: ['id'], fields: ['id', ...fields], rows: [{ id: 1 }] }])))
  const narrow = at([])
  const wide = at(cols)
  const started = performance.now()
  const added = diffSnapshots(narrow, wide)
  const dropped = diffSnapshots(wide, narrow)
  const div = divergence(added, dropped)
  const flags = flagChanges(added, dropped, none, { trusted: true })
  const took = performance.now() - started
  assert.ok(took < 2_000, `${Math.round(took)} ms`)
  assert.equal(added.collections.t0.fieldsAdded.length, 1_600)
  assert.equal(div.collections.t0.changes.length, 3_200)
  assert.deepEqual(flags.filter(f => f.kind === 'column-dropped').map(f => f.count), Array(50).fill(1_600))
})

// --- Round 3 of #35's review --------------------------------------------------------

// The review's high: a match could start at every backslash of a run, and
// each read the rest of the run, so 256 KB of backslashes before an '=' took
// 48 s. A match no longer starts inside a run.
test('the key scan is linear in runs of backslashes: 256 KB of them before an = or a quote, and in JSON, take well under a second', () => {
  const cells = {
    eq: '\\'.repeat(256 * 1024 - 1) + '=',
    quote: `${('\\'.repeat(4_096) + '"').repeat(60)}=`,
    pairs: `${'\\a'.repeat(128 * 1024)}=`,
    inJson: JSON.stringify({ msg: `${'\\'.repeat(64 * 1024)}=x` }),
  }
  const started = performance.now()
  const out = snap({ c: { key: ['id'], rows: [{ id: 1, ...cells }] } })
  const took = performance.now() - started
  assert.ok(took < 1_000, `${Math.round(took)} ms`)
  assert.deepEqual(['eq', 'quote', 'pairs', 'inJson'].map(f => out.collections.c.rows[0][f].t), ['long', 'long', 'long', 'long'])
  // a key right after a single backslash still counts, and so does one in
  // escaped or HTML-escaped quotes, or with a space before its ':'
  const keys = {
    newline: 'log line\\npassword=hunter2',
    path: 'C:\\Users\\x\\api_key=abc123',
    escaped: 'x=\\"password\\": 1',
    html: '{&quot;password&quot;: &quot;hunter9&quot;}',
    apos: '&#39;token&#39;: &#39;abc&#39;',
    spaced: 'password : hunter10',
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...keys }] } }).collections.c.rows
  for (const field of Object.keys(keys)) assert.match(row[field], /^\[text with a secret-looking key, \d+ characters, [0-9a-f]{8}\]$/, field)
})

// The review's first medium: 11,000 padding collections pushed users past
// the counts kept in the PR pane's first snapshot, and the click dropped the
// padding and wiped users, which then read as added, with no flag. A
// snapshot now says how many it left out, and a collection missing from one
// that left some out is unknown, so unverified, never added or dropped.
test('a collection a PR snapshot left out reads as unknown, so unverified and red, never added or dropped', () => {
  const people = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, role: 'member' })) })
  const pad = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`aaa${String(i).padStart(2, '0')}`, people(3)]))
  const limits = { maxCollections: 2 }
  const seed = snap({ users: people(2) }, {}, limits)
  const base = diffSnapshots(seed, seed)
  const s1 = snap({ ...pad, users: people(2) }, {}, limits)
  assert.equal(Object.hasOwn(s1.collections, 'users'), false)
  assert.equal(s1.omitted, 4)
  assert.equal(seed.omitted, 0)
  // the click drops the padding and wipes users, or updates every row
  for (const [what, sn] of [['wiped', snap({ users: people(0) }, {}, limits)], ['updated', snap({ users: { key: ['id'], rows: [1, 2, 3].map(id => ({ id, role: 'admin' })) } }, {}, limits)]]) {
    const pr = diffSnapshots(s1, sn)
    const u = pr.collections.users
    assert.deepEqual([u.status, u.omitted, u.truncated, u.countBefore, u.inserted], ['unknown', 'before', true, null, []], what)
    for (const trusted of [true, false]) {
      const flags = flagChanges(base, pr, none, { trusted })
      assert.deepEqual(flags.filter(f => f.collection === 'users').map(f => [f.kind, f.severity, f.shared]), [['unverified', 'red', false]], `${what}, trusted ${trusted}`)
      assert.equal(flags[0].collection, 'users', 'the base pane has it: listed first')
    }
    assert.equal(divergence(base, pr).collections.users.status, 'unknown', what)
  }
  // the other way: users in S1, left out of Sn by padding the click adds
  const kept = snap({ users: people(2) }, {}, limits)
  const out = diffSnapshots(kept, snap({ ...pad, users: people(2) }, {}, limits)).collections.users
  assert.deepEqual([out.status, out.omitted, out.countBefore, out.countAfter], ['unknown', 'after', 2, null])
  // a snapshot that couldn't be read at all left out how many it held
  const unreadable = sanitizeSnapshot({ collections: null }, { masker: masker(), rules: none })
  assert.equal(unreadable.omitted, null)
  assert.deepEqual(diffSnapshots(kept, unreadable).collections.users.status, 'unknown')
  // a collection given but unreadable counts as left out too
  assert.equal(snap({ a: { rows: 'x' }, b: { key: ['id'], rows: [{ id: 1 }] } }).omitted, 1)
})

// The review's second medium: each count-only stub of a collection only the
// PR pane has raised its own red flag, in name order, so 10,000 of them
// buried users' flags in a list cut at 500. They are now one flag, and the
// base pane's collections come first.
test('the unverified flags of collections only the PR pane has are folded into one, after the base pane\'s collections', () => {
  const people = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, role: 'member' })) })
  const pad = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`aaa${String(i).padStart(2, '0')}`, { key: ['id'], rows: [] }]))
  const limits = { maxCollections: 2 }
  const seed = snap({ users: people(50) }, {}, limits)
  const s1 = snap({ ...pad, users: people(50) }, {}, limits)
  const sn = snap({ ...pad, users: people(1) }, {}, limits)
  for (const trusted of [true, false]) {
    const flags = flagChanges(diffSnapshots(seed, seed), diffSnapshots(s1, sn), none, { trusted })
    assert.deepEqual(flags.map(f => [f.collection, f.kind, f.severity]), [['users', 'delete', 'red'], ['users', 'mass-change', 'red'], [null, 'unverified', 'red']], String(trusted))
    assert.deepEqual([flags[2].collections, flags[2].pr, flags[2].names], [20, 20, ['aaa01', 'aaa02', 'aaa03', 'aaa04', 'aaa05']])
  }
  // the order: red first; the base pane's collections before the PR's own;
  // what loses rows (and a base collection the PR alone cut short) before
  // unverified and cleared; then by name
  const rules = validateRules({})
  const at = (users, orders, extra) => snap({ users: { key: ['id'], rows: users }, orders: { key: ['id'], rows: orders }, ...extra }, {}, { maxRows: 3 })
  const u = [{ id: 1, note: 'x' }, { id: 2, note: 'y' }]
  const o = [{ id: 1 }, { id: 2 }]
  const before = at(u, o, { aaa_tmp: { key: ['id'], rows: [{ id: 1 }] }, aaa_big: { key: ['id'], rows: [] } })
  const after = at([{ id: 1, note: '' }], [...o, { id: 3 }, { id: 4 }], { aaa_big: { key: ['id'], rows: [1, 2, 3, 4].map(id => ({ id })) } })
  const ordered = flagChanges(diffSnapshots(at(u, o), at(u, o)), diffSnapshots(before, after), rules, { trusted: true })
  assert.deepEqual(ordered.map(f => [f.collection, f.kind, f.severity]), [
    ['orders', 'unverified', 'red'],
    ['users', 'delete', 'red'],
    ['aaa_tmp', 'dropped', 'red'],
    [null, 'unverified', 'red'],
    ['users', 'cleared', 'amber'],
  ])
})

// A low: JSON text encoded twice read the same as plain JSON text, so a
// migration that re-encoded a whole column showed nothing.
test('JSON text encoded twice says so: re-encoding a column is 30 updates and a mass change, and inside JSON it keeps its string form', () => {
  const plainJson = JSON.stringify({ theme: 'dark', n: 1 })
  const s = value => snap({ prefs: { key: ['id'], rows: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, value })) } })
  const seed = s(plainJson)
  const twice = s(JSON.stringify(plainJson))
  assert.deepEqual(twice.collections.prefs.rows[0].value, { t: 'json', s: plainJson, enc: 2 })
  const pr = diffSnapshots(seed, twice)
  assert.equal(pr.collections.prefs.updated.length, 30)
  assert.deepEqual(flagChanges(diffSnapshots(seed, seed), pr, none, { trusted: true }).map(f => [f.kind, f.severity]), [['mass-change', 'red']])
  // nested in JSON: the outer string form is kept, its secrets masked within
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, a: { v: plainJson }, b: { v: JSON.stringify(plainJson) }, c: { v: JSON.stringify(JSON.stringify({ password: 'hunter11' })) } }] } }).collections.c.rows
  assert.notEqual(row.a.s, row.b.s)
  assert.doesNotMatch(JSON.stringify(row), /hunter11/)
  assert.match(row.c.s, /\[secret [0-9a-f]{8}\]/)
})

// A low: value masking missed common forms, and masked prose after "Basic".
test('more values masked: URLs with an empty user, an @ in the password or a token alone, any-case schemes, Name/Value pairs, XML with a namespace or attributes', () => {
  const values = {
    redis: 'redis://:redis-pw-9@cache:6379/0',
    at: 'postgres://app:p@ss-word-9@db/app',
    // a token-shaped userinfo, built at run time so no scanner takes it for one
    repo: `https://${['gh', 'p_'].join('')}${'A'.repeat(36)}@github.com/o/r.git`,
    lower: 'sent bearer abcdefghij123456 then',
    upper: 'sent BEARER abcdefghij123457 then',
    basic: 'header Basic dXNlcjpwYXNzd29yZDE= ok',
    tok: 'with Token tk_live_00000000ab here',
    aws: [{ Name: 'db-password', Value: 'aws-secret-1' }, { Key: 'api_token', Value: 'aws-secret-2' }],
    kv: { k: 'password', v: 'kv-secret-3' },
    field: { field: 'client_secret', val: 'kv-secret-4' },
    wsse: '<wsse:Password Type="PasswordText">soap-secret-5</wsse:Password>',
    attr: '<password type="text">soap-secret-6</password>',
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...values }] } }).collections.c.rows
  assert.doesNotMatch(JSON.stringify(row), /redis-pw|ss-word|p_AAAA|abcdefghij|dXNlcjpw|tk_live|aws-secret|kv-secret|soap-secret/)
  assert.match(row.redis, /^redis:\/\/:\[secret [0-9a-f]{8}\]@cache:6379\/0$/)
  assert.match(row.at, /^postgres:\/\/app:\[secret [0-9a-f]{8}\]@db\/app$/)
  assert.match(row.repo, /^https:\/\/\[secret [0-9a-f]{8}\]@github\.com\/o\/r\.git$/)
  assert.match(row.lower, /^sent bearer \[secret [0-9a-f]{8}\] then$/)
  assert.match(row.basic, /^header Basic \[secret [0-9a-f]{8}\] ok$/)
  // prose after a scheme's name, and a short user alone, are left be
  const [prose] = snap({ c: { key: ['id'], rows: [{ id: 1, a: 'Basic introduction to the topic', b: 'Token expired again', c: 'ssh://git@github.com/o/r.git' }] } }).collections.c.rows
  assert.deepEqual([prose.a, prose.b, prose.c], ['Basic introduction to the topic', 'Token expired again', 'ssh://git@github.com/o/r.git'])
})

// A low: field names were cached however long, so 16 KB names grew the
// cache by 16 MB a snapshot.
test('the masker never caches a name over 128 characters', () => {
  const m = masker()
  for (let i = 0; i < 1_000; i++) assert.equal(m.cell('c', `${'f'.repeat(16 * 1024)}${i}`, 'v'), 'v')
  assert.equal(m.cachedFields(), 0)
  m.cell('c', 'f'.repeat(128), 'v')
  assert.equal(m.cachedFields(), 1)
  const before = m.cached()
  assert.equal(m.cell('c'.repeat(129), 'password', 'x').t, 'secret', 'worked out all the same')
  assert.equal(m.cached(), before)
})

// #36's review: a collection's name, key and declared fields were never
// charged to any budget. They are capped, and charged to its bytes.
test('long names are left out; a key of more than 32 fields, more than 2,000 declared fields, or a key and fields over the share of bytes are cut, said so', () => {
  const long = 'n'.repeat(201)
  const out = snap({ [long]: { key: ['id'], rows: [{ id: 1 }] }, ['m'.repeat(200)]: { key: ['id'], rows: [{ id: 1 }] } })
  // left out, said so, and not counted in `omitted`: no name the diff sees
  // can be one of them
  assert.deepEqual([Object.keys(out.collections), out.omitted, out.problems], [['m'.repeat(200)], 0, ['1 collection with a name over 200 characters was left out']])
  const wide = n => Array.from({ length: n }, (_, i) => `f${i}`)
  const row = Object.fromEntries(wide(33).map(f => [f, 1]))
  const k = snap({ k32: { key: wide(32), rows: [row] }, k33: { key: wide(33), rows: [row] } })
  assert.deepEqual([k.collections.k32.key.length, k.collections.k33.key], [32, null])
  assert.deepEqual(k.problems, ['k33: a key of 33 fields is more than 32, so its rows are compared without one'])
  const f = snap({ ok: { key: ['f0'], fields: wide(2_000), rows: [row] }, over: { key: ['f0'], fields: wide(2_001), rows: [row], count: 1 } })
  assert.equal(f.collections.ok.fields.length, 2_000)
  assert.deepEqual(f.collections.over, { key: null, fields: null, rows: [], count: 1, truncated: true })
  assert.deepEqual(f.problems, ['over: 2001 declared fields are more than 2000, so it is kept as its count'])
  const tight = snap({ t: { key: ['id'], fields: wide(100), rows: [{ id: 1 }] } }, {}, { maxBytes: 200 })
  assert.deepEqual([tight.collections.t.truncated, tight.collections.t.fields, tight.problems], [true, null, ['t: its key and declared fields don\'t fit its share of the bytes, so it is kept as its count']])
})

// Mutants round 3 let live.
test('a count-only collection keeps the inspector\'s count; a cut-short collection the PR dropped is no unverified; counts that start apart aren\'t shared', () => {
  const many = sanitizeSnapshot({ collections: { a: { key: null, rows: Array(5).fill({ v: 1 }) }, b: { key: null, rows: [{ v: 1 }, { v: 2 }], count: 1_000_000 } } }, { masker: masker(), rules: none, limits: { maxCollections: 1 } })
  assert.deepEqual(many.collections.b, { key: null, fields: null, rows: [], count: 1_000_000, truncated: true })
  const big = count => snap({ big: { key: ['id'], rows: [{ id: 1 }], count, truncated: true } })
  const gone = flagChanges(diffSnapshots(big(500), big(500)), diffSnapshots(big(500), snap({})), none, { trusted: true })
  assert.deepEqual(gone.map(f => [f.kind, f.severity]), [['dropped', 'red']])
  const apart = flagChanges(diffSnapshots(big(100), big(90)), diffSnapshots(big(200), big(90)), none, { trusted: true }).find(f => f.kind === 'unverified')
  assert.deepEqual([apart.severity, apart.shared], ['red', false])
})

test('comparing two wide declared field lists is linear in diffSnapshots too: 50 tables of 2,000 columns, one apart, in well under a second', () => {
  const cols = tag => ['id', ...Array.from({ length: 1_999 }, (_, i) => `column_with_a_rather_long_name_${String(i).padStart(4, '0')}${i === 1_998 ? tag : ''}`)]
  const at = tag => snap(Object.fromEntries(Array.from({ length: 50 }, (_, t) => [`t${t}`, { key: ['id'], fields: cols(tag), rows: [{ id: 1 }] }])))
  const a = at('a')
  const b = at('b')
  const started = performance.now()
  const d = diffSnapshots(a, b)
  const took = performance.now() - started
  assert.ok(took < 500, `${Math.round(took)} ms`)
  assert.deepEqual([d.collections.t0.fieldsDropped.length, d.collections.t0.fieldsAdded.length], [1, 1])
})

// Mutants of this round's own code that the tests above let live.
test('a collection a snapshot may have left out: no delete read from its unknown count, never shared, no counts guessed, unknown even beside one the base added', () => {
  const people = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const pad = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`aaa${String(i).padStart(2, '0')}`, people(3)]))
  const limits = { maxCollections: 2 }
  // left out of Sn: an unverified, and no delete read from a count it hasn't
  const kept = snap({ users: people(2) }, {}, limits)
  const lost = diffSnapshots(kept, snap({ ...pad, users: people(2) }, {}, limits))
  assert.deepEqual(flagChanges(diffSnapshots(kept, kept), lost, none, { trusted: true }).filter(f => f.collection === 'users').map(f => [f.kind, f.severity]), [['unverified', 'red']])
  // both panes alike: still never shared, so red even trusted
  const s1 = snap({ ...pad, users: people(2) }, {}, limits)
  const both = diffSnapshots(s1, snap({ users: people(2) }, {}, limits))
  const flag = flagChanges(both, both, none, { trusted: true }).find(f => f.collection === 'users')
  assert.deepEqual([flag.kind, flag.severity, flag.shared], ['unverified', 'red', false])
  // divergence guesses no counts for it, and says unknown even where the
  // base pane added the collection
  const fresh = snap({}, {}, limits)
  const baseAdded = diffSnapshots(fresh, snap({ users: people(2) }, {}, limits))
  assert.equal(baseAdded.collections.users.status, 'added')
  const v = divergence(baseAdded, both).collections.users
  assert.deepEqual([v.status, v.counts.pr], ['unknown', { inserted: 0, updated: 0, deleted: 0 }])
})

test('a scheme\'s value with a digit in it is masked from 8 characters; one without, from 16', () => {
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, a: 'with Bearer abc12345 then', b: 'with Token abcdefgh then', c: 'with Basic abcdefghijklmnop then' }] } }).collections.c.rows
  assert.match(row.a, /^with Bearer \[secret [0-9a-f]{8}\] then$/)
  assert.equal(row.b, 'with Token abcdefgh then')
  assert.match(row.c, /^with Basic \[secret [0-9a-f]{8}\] then$/)
})

// --- For #36's round 4 --------------------------------------------------------------

// #36's review: flagChanges merged each cleared field's items with a spread
// copy, quadratic in the rows: 10,000 rows with 20 fields cleared took 2.8 s,
// and 100 fields 22 s.
test('flagging many cleared fields is linear: 10,000 rows with 40 fields cleared flag in well under the quadratic 20 s', () => {
  const fields = Array.from({ length: 40 }, (_, i) => `f${i}`)
  const at = value => snap({ t: { key: ['id'], rows: Array.from({ length: 10_000 }, (_, id) => ({ id, ...Object.fromEntries(fields.map(f => [f, value])) })) } })
  const before = at('x')
  const after = at('')
  const pr = diffSnapshots(before, after)
  const base = diffSnapshots(before, before)
  const started = performance.now()
  const flags = flagChanges(base, pr, none, { trusted: true })
  const took = performance.now() - started
  // about 0.1 s alone; the spread copy took over 20 s
  assert.ok(took < 3_000, `${Math.round(took)} ms`)
  assert.equal(flags.filter(f => f.kind === 'cleared').length, 40)
  assert.ok(flags.filter(f => f.kind === 'cleared').every(f => f.pr === 10_000))
})

// #36's review: a refactor that renames 30 columns in each of 20 earlier-named
// seeded tables put 600 column-dropped flags ahead of the users delete.
test('what loses data is listed before column and mass-change flags, across collections', () => {
  const tables = fields => Object.fromEntries(Array.from({ length: 20 }, (_, t) => [`a${String(t).padStart(3, '0')}`, { key: ['id'], fields: ['id', ...fields], rows: [{ id: 1 }] }]))
  const cols = prefix => Array.from({ length: 30 }, (_, i) => `${prefix}${i}`)
  const users = n => ({ users: { key: ['id'], fields: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) } })
  const seed = snap({ ...tables(cols('old_')), ...users(20) })
  const pr = diffSnapshots(seed, snap({ ...tables(cols('new_')), ...users(5) }))
  const flags = flagChanges(diffSnapshots(seed, seed), pr, none, { trusted: true })
  assert.deepEqual(flags.filter(f => f.kind === 'column-dropped').map(f => f.count), Array(20).fill(30))
  assert.deepEqual([flags[0].collection, flags[0].kind], ['users', 'delete'])
  const firstColumn = flags.findIndex(f => f.kind === 'column-dropped')
  const lastLoss = flags.findLastIndex(f => ['delete', 'emptied', 'dropped', 'key-lost'].includes(f.kind))
  assert.ok(lastLoss < firstColumn, `${lastLoss} < ${firstColumn}`)
})

// --- Round 4 of #35's review --------------------------------------------------------

// The review's high: a tag's attributes read across the next '<', so text
// dense with `<a ` backtracked about 256 characters at every '<' (110 ms a
// 256 KB cell). They stop at the next '<' now.
// Its time isn't asserted: under the owner's W28=B, a PR's data may slow
// masking, which the README documents (Hostile PR data).
test('text dense with tags is read, and tags with a namespace or attributes are found', () => {
  const a = '<a '.repeat(87_000)
  const ns = '<a:a '.repeat(52_000)
  const rows = Array.from({ length: 2 }, (_, id) => ({ id, v: a })).concat(Array.from({ length: 2 }, (_, id) => ({ id: 2 + id, v: ns })))
  const kept = snap({ c: { key: ['id'], rows } }).collections.c.rows
  assert.deepEqual([kept[0].v.t, kept[3].v.t], ['long', 'long'])
  const [attrs] = snap({ c: { key: ['id'], rows: [{ id: 1, v: '<a b="1" '.repeat(29_000) }] } }).collections.c.rows
  assert.equal(attrs.v.t, 'long')
  // tags with a namespace or attributes are still read
  const [tags] = snap({ c: { key: ['id'], rows: [{ id: 1, a: '<wsse:Password Type="PasswordText">x</wsse:Password>', b: '<token kind="a">y</token>' }] } }).collections.c.rows
  for (const f of ['a', 'b']) assert.match(tags[f], /^\[text with a secret-looking key/, f)
})

// The review's third medium: column-dropped was one flag per field, so 1,600
// columns a PR added to a seeded `accounts` and dropped at the click put
// users's delete past 1,598 flags. They are one flag now.
test('1,600 columns dropped from one collection are one flag: a users delete beside them is among the first flags', () => {
  const cols = Array.from({ length: 1_600 }, (_, i) => `c${String(i).padStart(4, '0')}`)
  const people = n => ({ key: ['id'], fields: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const s1 = snap({ accounts: { key: ['id'], fields: ['id', ...cols], rows: [{ id: 1 }] }, users: people(30) })
  const sn = snap({ accounts: { key: ['id'], fields: ['id'], rows: [{ id: 1 }] }, users: people(0) })
  const flags = flagChanges(diffSnapshots(s1, s1), diffSnapshots(s1, sn), none, { trusted: true })
  const at = flags.findIndex(f => f.collection === 'users' && f.kind === 'delete')
  assert.ok(at >= 0 && at < 10, String(at))
  const column = flags.find(f => f.kind === 'column-dropped')
  assert.deepEqual([column.collection, column.count, column.pr, column.fields], ['accounts', 1_600, 1_600, ['c0000', 'c0001', 'c0002', 'c0003', 'c0004']])
  assert.equal(flags.length, 4, JSON.stringify(flags.map(f => [f.collection, f.kind])))
})

// The review's fourth medium: the pair rule's bound of 6 keys showed a HAR
// cookie's value in clear. `name` or `key` with `value` (lower case or
// capitalized) is a pair whatever the object holds; the looser spellings
// only in a small object. Every value key is masked.
test('name and value pairs: a HAR cookie of 8 keys and an SSM Parameter of 7 are masked; loose spellings only up to 6 keys; every value key', () => {
  const values = {
    cookie: { name: 'session_id', value: 'cookie-secret-1', path: '/', domain: 'example.com', expires: '2027-01-01', httpOnly: true, secure: true, sameSite: 'Lax' },
    ssm: { Parameter: { Name: '/prod/db/password', Type: 'SecureString', Value: 'ssm-secret-2', Version: 3, LastModifiedDate: '2026-10-01', ARN: 'arn:aws:ssm:x', DataType: 'text' } },
    seven: { name: 'DB_PASSWORD', value: 'seven-secret-3', a: 1, b: 2, c: 3, d: 4, e: 5 },
    two: { name: 'password', value: 'two-secret-4', v: 'two-secret-5' },
    loose6: { k: 'api_token', v: 'loose-secret-6', a: 1, b: 2, c: 3, d: 4 },
    nulled: { name: 'password', value: null },
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...values }] } }).collections.c.rows
  assert.doesNotMatch(JSON.stringify(row), /cookie-secret|ssm-secret|seven-secret|two-secret|loose-secret/)
  // a null value is kept as it is: clearing one shows
  assert.equal(JSON.parse(row.nulled.s).value, null)
  // a loose spelling in an object of 7 keys is no pair: its value shows
  const [loose] = snap({ c: { key: ['id'], rows: [{ id: 1, o: { k: 'api_token', v: 'shown-7', a: 1, b: 2, c: 3, d: 4, e: 5 } }] } }).collections.c.rows
  assert.match(loose.o.s, /shown-7/)
  // nor is one whose name isn't a string, a list say
  const [named] = snap({ c: { key: ['id'], rows: [{ id: 1, o: { name: ['password'], value: 'shown-8' } }] } }).collections.c.rows
  assert.match(named.o.s, /shown-8/)
})

// The review's fifth medium: a collection left out for its name's length
// made every snapshot "maybe left out", so a certain drop read as unverified.
test('a collection with a name over 200 characters makes no other maybe left out: dropping users beside it is still a drop', () => {
  const people = { key: ['id'], rows: [{ id: 1 }, { id: 2 }] }
  const long = 'x'.repeat(201)
  const s1 = snap({ users: people, orders: people })
  const sn = snap({ [long]: { key: ['id'], rows: [] }, orders: people })
  const pr = diffSnapshots(s1, sn)
  assert.equal(pr.collections.users.status, 'dropped')
  assert.deepEqual(flagChanges(diffSnapshots(s1, s1), pr, none, { trusted: true }).map(f => [f.collection, f.kind, f.severity]), [['users', 'dropped', 'red']])
  assert.equal(divergence(diffSnapshots(s1, s1), pr).collections.users.status, 'pr-only')
})

// The review's lows: the mutants this round's code let live.
test('mutants: entity quotes, triple-encoded JSON, long double-encoded cells, objects as their JSON text, throwing keys, a base-side omitted collection, cleared after shared, a key-only budget, the userinfo threshold', () => {
  const masked = /^\[text with a secret-looking key, \d+ characters, [0-9a-f]{8}\]$/
  const keys = {
    apos: "&apos;token&apos;: 'abc'",
    hex: '&#x27;password&#x27;: 1',
    upper: '{&QUOT;password&QUOT;: 1}',
    hexUpper: '&#X22;password&#X22;: 1',
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...keys }] } }).collections.c.rows
  for (const f of Object.keys(keys)) assert.match(row[f], masked, f)
  // JSON text encoded three times: its secret never shows (QUOTE's run of
  // backslashes)
  const thrice = JSON.stringify(JSON.stringify(JSON.stringify({ password: 'hunter-thrice-1' })))
  const [t] = snap({ c: { key: ['id'], rows: [{ id: 1, v: thrice, w: `see ${thrice}` }] } }).collections.c.rows
  assert.doesNotMatch(JSON.stringify(t), /hunter-thrice/)
  // a long cell encoded twice says so too
  const long = JSON.stringify({ text: 'y'.repeat(300) })
  const [enc] = snap({ c: { key: ['id'], rows: [{ id: 1, once: long, twice: JSON.stringify(long) }] } }).collections.c.rows
  assert.equal(enc.once.t, 'long')
  assert.equal(enc.twice.enc, 2)
  // an object and its JSON text are the same cell
  const [same] = snap({ c: { key: ['id'], rows: [{ id: 1, a: { theme: 'dark' }, b: '{"theme":"dark"}' }] } }).collections.c.rows
  assert.deepEqual(same.a, same.b)
  // a collections object whose keys throw: unreadable, so omitted is null
  const trap = new Proxy({}, { ownKeys() { throw new Error('no keys') } })
  assert.equal(sanitizeSnapshot({ collections: trap }, { masker: masker(), rules: none }).omitted, null)
  // a collection the base pane's snapshot may have left out: divergence
  // says unknown from the base side too
  const people = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const pad = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`aaa${String(i).padStart(2, '0')}`, people(3)]))
  const limits = { maxCollections: 2 }
  const s1 = snap({ users: people(2) }, {}, limits)
  const baseLost = diffSnapshots(s1, snap({ ...pad, users: people(2) }, {}, limits))
  const prDrop = diffSnapshots(s1, snap({}, {}, limits))
  assert.equal(divergence(baseLost, prDrop).collections.users.status, 'unknown')
  // amber: a cleared field after a shared delete
  const rows = clear => ({ key: ['id'], rows: [1, 2, 3].map(id => ({ id, note: clear ? '' : 'x' })) })
  const c0 = snap({ a: rows(false), z: rows(false) })
  const gone = snap({ a: { key: ['id'], rows: [{ id: 1, note: 'x' }, { id: 2, note: 'x' }] }, z: rows(false) })
  const both = snap({ a: { key: ['id'], rows: [{ id: 1, note: 'x' }, { id: 2, note: 'x' }] }, z: rows(true) })
  const amber = flagChanges(diffSnapshots(c0, gone), diffSnapshots(c0, both), none, { trusted: true })
  assert.deepEqual(amber.map(f => [f.collection, f.kind, f.severity]), [['a', 'delete', 'amber'], ['z', 'cleared', 'amber']])
  // and after a shared mass change, though its collection sorts first
  const notes = topic => ({ key: ['id'], rows: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, topic })) })
  const m0 = snap({ a: rows(false), z: notes('t') })
  const massed = snap({ a: rows(false), z: notes('u') })
  const massCleared = snap({ a: rows(true), z: notes('u') })
  const late = flagChanges(diffSnapshots(m0, massed), diffSnapshots(m0, massCleared), none, { trusted: true })
  assert.deepEqual(late.map(f => [f.collection, f.kind, f.severity]), [['z', 'mass-change', 'amber'], ['a', 'cleared', 'amber']])
  // the key alone over the share: kept as its count
  const keyOnly = snap({ t: { key: ['k'.repeat(150)], rows: [{ id: 1 }] } }, {}, { maxBytes: 100 })
  assert.deepEqual([keyOnly.collections.t.truncated, keyOnly.collections.t.rows.length], [true, 0])
  // a count-only collection costs no bytes: the next keeps its share
  const wide = Array.from({ length: 2_001 }, (_, i) => `f${i}`)
  const shared = snap({ a: { key: null, fields: wide, rows: [{ v: 1 }] }, b: { key: null, rows: [{ v: 'z'.repeat(60) }] } }, {}, { maxBytes: 160 })
  assert.deepEqual([shared.collections.a.truncated, shared.collections.b.truncated], [true, false])
  // a token alone in a URL's userinfo: from 16 characters
  const [u] = snap({ c: { key: ['id'], rows: [{ id: 1, at15: 'https://abcdefghij12345@h/x', at16: 'https://abcdefghij123456@h/x' }] } }).collections.c.rows
  assert.equal(u.at15, 'https://abcdefghij12345@h/x')
  assert.match(u.at16, /^https:\/\/\[secret [0-9a-f]{8}\]@h\/x$/)
})

// The review's lows: values still shown in clear.
test('more values masked: a token as a URL\'s user, a short base64 Basic, Go DSNs, JWTs, and the value of an element named as a secret', () => {
  // token shapes built at run time, so no scanner takes them for real ones
  const gh = `${['gh', 'p_'].join('')}${'B'.repeat(36)}`
  const jwt = ['eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxIn0', '.c2lnbmF0dXJl'].join('')
  const values = {
    oauth: `https://${gh}:x-oauth-basic@github.com/o/r.git`,
    empty: `https://${gh}:@github.com/o/r.git`,
    userTok: 'https://abcdef0123456789:pw-secret-1@h/x',
    noPw: 'https://deployuser:@h/x',
    oauthUser: 'https://shortuser:x-oauth-basic@github.com/o/r.git',
    prefixed: `https://${['glp', 'at-'].join('')}abcdefghij:pw-secret-9@h/x`,
    basic: 'header Basic dXNlcjpwYXNz ok',
    conn: 'root:dsn-secret-2@tcp(127.0.0.1:3306)/app?parseTime=true',
    said: `was ${jwt} then`,
    add: '<add key="DbPassword" value="xml-secret-3"/>',
    input: '<input name="login" type="password" value="html-secret-4">',
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...values }] } }).collections.c.rows
  assert.doesNotMatch(JSON.stringify(row), /BBBB|abcdef0123|pw-secret|dXNlcjpwYXNz|dsn-secret|hbGciOi|xml-secret|html-secret|deployuser|shortuser|abcdefghij/)
  assert.match(row.said, /^was \[secret [0-9a-f]{8}\] then$/)
  assert.match(row.basic, /^header Basic \[secret [0-9a-f]{8}\] ok$/)
  assert.match(row.oauth, /^https:\/\/\[secret [0-9a-f]{8}\]:x-oauth-basic@github\.com\/o\/r\.git$/)
  assert.match(row.empty, /^https:\/\/\[secret [0-9a-f]{8}\]:@github\.com\/o\/r\.git$/)
  assert.match(row.conn, /^root:\[secret [0-9a-f]{8}\]@tcp\(127\.0\.0\.1:3306\)\/app\?parseTime=true$/)
  assert.match(row.add, /^<add key="DbPassword" value="\[secret [0-9a-f]{8}\]"\/>$/)
  // a plain user, prose after a scheme, and an element not named as a secret
  const [kept] = snap({ c: { key: ['id'], rows: [{ id: 1, a: 'https://app:pw@h/x', b: 'Basic introduction', c: '<input name="email" value="a@b.c">', d: 'Basic Introduction' }] } }).collections.c.rows
  assert.match(kept.a, /^https:\/\/app:\[secret [0-9a-f]{8}\]@h\/x$/)
  assert.deepEqual([kept.b, kept.c, kept.d], ['Basic introduction', '<input name="email" value="a@b.c">', 'Basic Introduction'])
})

// The review's lows: common secret shapes under neutral field names.
test('more keys in text: backticks, aligned config, percent-encoding, command-line flags, a MySQL client\'s -p, and a PEM private key', () => {
  const texts = {
    mysqlLog: 'UPDATE `users` SET `password` = \'hunter2Zq\' WHERE id = 1',
    markdown: '`password`: hunter2Zq',
    aligned: `password${' '.repeat(20)}= hunter2Zq`,
    pct: 'q=1&password%3Dhunter2Zq',
    pctJson: '%7B%22password%22%3A%22hunter2Zq%22%7D',
    flag: 'run --password hunter2Zq',
    flagEq: 'run --db-token=hunter2Zq',
    mysqlP: 'mysql -u root -phunter2Zq app',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----',
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...texts }] } }).collections.c.rows
  for (const f of Object.keys(texts)) assert.match(row[f], /^\[text with a secret-looking key, \d+ characters, [0-9a-f]{8}\]$/, f)
  // a neutral flag, and -p elsewhere, are left be
  const [kept] = snap({ c: { key: ['id'], rows: [{ id: 1, a: 'mkdir -p /tmp/x --verbose', b: 'gcc -pthread -o app' }] } }).collections.c.rows
  assert.deepEqual([kept.a, kept.b], ['mkdir -p /tmp/x --verbose', 'gcc -pthread -o app'])
})

// --- Round 5 of #35's review --------------------------------------------------------

// The review's first high: a key right after a percent-encoded '=' or ':'
// wasn't read, since the escape's last character is a word character. And
// a low: names that are words (pw, pin, psk, auth) after an escape.
test('a key right after a percent-escape or a backslash escape counts, names that are words included', () => {
  const masked = /^\[text with a secret-looking key, \d+ characters, [0-9a-f]{8}\]$/
  const texts = {
    eq: 'x%3dpassword=Zq9SeCr3tVal',
    colon: 'x%3Apassword: Zq9SeCr3tVal',
    flag: 'value%3aZq9SeCr3tVal--db-token=',
    quoted: 'state%3AZq9x%22token%22%3dtoken:',
    word: 's=%7B%22pw%22%3A%22hunter2Zq%22%7D',
    amp: 'q=%26pin%3Dhunter2Zq',
    next: 'next=%2Fx%3Fa%3D1%26pw%3Dhunter2Zq',
    npmrc: 'npmrc=registry%3Dx%0A_auth%3Dhunter2Zq',
    escaped: 'registry=x\\n_auth=hunter2Zq',
    newline: 'a=1\\npw=hunter2Zq',
    tab: 'a=1\\tpsk=hunter2Zq',
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...texts }] } }).collections.c.rows
  for (const f of Object.keys(texts)) assert.match(row[f], masked, f)
  // a word that only ends in such letters is no escape's remnant
  const [kept] = snap({ c: { key: ['id'], rows: [{ id: 1, a: 'x%3dadpw=1', b: 'unpw=1' }] } }).collections.c.rows
  assert.deepEqual([kept.a, kept.b], ['x%3dadpw=1', 'unpw=1'])
  // and runs of backslashes are still read once
  const started = performance.now()
  snap({ c: { key: ['id'], rows: [{ id: 1, v: `${'\\n'.repeat(128 * 1024)}=` }] } })
  assert.ok(performance.now() - started < 1_000)
})

// The review's second high: with attributes read only up to the next '<',
// a '<' in an attribute's value kept a secret-named tag from matching.
test('a secret-named tag is masked whatever its attributes hold, a \'<\' included', () => {
  const masked = /^\[text with a secret-looking key, \d+ characters, [0-9a-f]{8}\]$/
  const texts = {
    hint: '<password hint="a<b">hunter2Zq</password>',
    ns: '<wsse:Password Type="a<b">hunter2Zq</wsse:Password>',
    title: '<secret-note title="x < y">hunter2Zq</secret-note>',
    placeholder: '<Password placeholder="<enter>" />hunter2Zq',
    bare: '<token>hunter2Zq</token>',
    slash: '<apiKey/>hunter2Zq',
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...texts }] } }).collections.c.rows
  for (const f of Object.keys(texts)) assert.match(row[f], masked, f)
  // a tag whose name only begins like one is left be
  const [kept] = snap({ c: { key: ['id'], rows: [{ id: 1, a: '<b>bold</b> and <i>it</i>' }] } }).collections.c.rows
  assert.equal(kept.a, '<b>bold</b> and <i>it</i>')
})

// The review's medium: the fold named its first five fields in sorted
// order, so five padding columns that sort first hid a seeded `email`.
test('a collection\'s dropped columns name the ones the base pane declares first, with their own count', () => {
  const pad = Array.from({ length: 5 }, (_, i) => `aa_tmp_${String(i).padStart(4, '0')}`)
  const users = fields => ({ key: ['id'], fields: ['id', ...fields], rows: [{ id: 1 }] })
  const base = snap({ users: users(['email']) })
  const prReady = snap({ users: users(['email', ...pad]) })
  const prNow = snap({ users: users([]) })
  const flags = flagChanges(diffSnapshots(base, base), diffSnapshots(prReady, prNow), none, { trusted: true })
  assert.deepEqual(flags.map(f => [f.collection, f.kind, f.severity, f.count, f.seeded, f.fields]), [['users', 'column-dropped', 'red', 6, 1, ['email', ...pad.slice(0, 4)]]])
  // the PR's own columns alone: none seeded
  const own = flagChanges(diffSnapshots(base, base), diffSnapshots(prReady, snap({ users: users(['email']) })), none, { trusted: true })
  assert.deepEqual(own.map(f => [f.count, f.seeded, f.fields[0]]), [[5, 0, 'aa_tmp_0000']])
  // a diff entry carries its before snapshot's declared fields
  assert.deepEqual(diffSnapshots(base, base).collections.users.fieldsBefore, ['id', 'email'])
})

// The review's lows.
test('name and value pairs: any name-like key may name one, and a row shaped as one has its value masked', () => {
  const values = {
    first: [{ key: 'mail.smtp', name: 'Password', value: 'pair-secret-1' }],
    k: { k: 'row-17', name: 'password', value: 'pair-secret-2' },
    later: { key: 'setting_42', name: 'SMTP password', value: 'pair-secret-3', updated: 1 },
    eight: { key: 'password', value: 'pair-secret-4', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    capital: { Key: 'api_token', Value: 'pair-secret-5', A: 1, B: 2, C: 3, D: 4, E: 5, F: 6 },
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...values }] } }).collections.c.rows
  assert.doesNotMatch(JSON.stringify(row), /pair-secret/)
  // rows of a settings table
  const settings = snap({ settings: { key: ['id'], rows: [{ id: 1, key: 'smtp_password', value: 'row-secret-6' }, { id: 2, name: 'STRIPE_SECRET_KEY', value: 'row-secret-7' }, { id: 3, key: 'site_title', value: 'Acme' }] } }).collections.settings.rows
  assert.doesNotMatch(JSON.stringify(settings), /row-secret/)
  assert.equal(settings[0].value.t, 'secret')
  assert.equal(settings[2].value, 'Acme')
  // a cleared value still shows
  const cleared = snap({ settings: { key: ['id'], rows: [{ id: 1, key: 'smtp_password', value: '' }] } }).collections.settings.rows
  assert.equal(cleared[0].value, '')
})

test('more shapes: DSN variants, attributes quoted either way or not, a flag before a tab, PGP and PKCS#8 keys, and the review\'s mutant cases', () => {
  const values = {
    goAt: 'root:p@sshunter2Zq@tcp(127.0.0.1:3306)/app',
    goBare: 'root:hunter2Zq@/app',
    goTcp6: 'root:hunter2Zq@tcp6([::1]:3306)/app',
    goUnix: 'root:hunter2Zq@unix(/tmp/mysql.sock)/app',
    cloud: 'root:hunter2Zq@cloudsql(project:region:instance)/app',
    unquoted: '<input type=password value=hunter2Zq>',
    single: "<add key='DbPassword' value='it\"shunter2Zq'/>",
    upper: "<add KEY='DbPassword' VALUE='hunter2Zq'/>",
    id: '<x id="password" value="hunter2Zq">',
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...values }] } }).collections.c.rows
  assert.doesNotMatch(JSON.stringify(row), /hunter2Zq|sshunter/)
  const masked = /^\[text with a secret-looking key, \d+ characters, [0-9a-f]{8}\]$/
  const texts = {
    tab: 'pg_dump --password\thunter2Zq',
    single: 'run -password hunter2Zq',
    pgp: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYB\n',
    pkcs8: '-----BEGIN PRIVATE KEY-----\nMIIE\n',
    ec: '-----BEGIN EC PRIVATE KEY-----\nMHcC\n',
    openssh: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n',
    dump: 'mysqldump -u root -phunter2Zq app',
    apos: '%27password%27%3A%27hunter2Zq%27',
    spaces31: `password${' '.repeat(31)}= hunter2Zq`,
  }
  const [t] = snap({ c: { key: ['id'], rows: [{ id: 1, ...texts }] } }).collections.c.rows
  for (const f of Object.keys(texts)) assert.match(t[f], masked, f)
  const [v] = snap({ c: { key: ['id'], rows: [{ id: 1, basic: 'header basic dXNlcjpwYXNz ok', oauth: 'https://shortuser:X-OAUTH-BASIC@github.com/o/r', gh: `https://${['gh', 'o_'].join('')}abc:pw@h/x`, pat: `https://${['github', '_pat_'].join('')}abc:pw@h/x`, xox: `https://${['xo', 'xb-'].join('')}abc:pw@h/x`, sk: `https://${['s', 'k-'].join('')}abc:pw@h/x` }] } }).collections.c.rows
  assert.match(v.basic, /^header basic \[secret [0-9a-f]{8}\] ok$/)
  assert.match(v.oauth, /^https:\/\/\[secret [0-9a-f]{8}\]:X-OAUTH-BASIC@github\.com/)
  for (const f of ['gh', 'pat', 'xox', 'sk']) assert.match(v[f], /^https:\/\/\[secret [0-9a-f]{8}\]:\[secret [0-9a-f]{8}\]@h\/x$/, f)
  // text of 'a:' is read (its time is the README's, Hostile PR data)
  assert.equal(snap({ c: { key: ['id'], rows: [{ id: 1, v: 'a:'.repeat(128 * 1024) }] } }).collections.c.rows[0].v.t, 'long')
})

test('flags: dropped columns of the same number but other names are the PR\'s own; a cleared field shared on one row of three isn\'t shared; what loses rows, then columns, then a left-out base collection\'s unverified with what loses rows', () => {
  const cols = fields => snap({ users: { key: ['id'], fields: ['id', ...fields], rows: [{ id: 1 }] } })
  const c0 = cols(['email', 'legacy'])
  const other = flagChanges(diffSnapshots(c0, cols(['email'])), diffSnapshots(c0, cols(['legacy'])), none, { trusted: true })
  assert.deepEqual(other.map(f => [f.kind, f.severity, f.shared]), [['column-dropped', 'red', false]])
  // cleared on 3 rows; the base cleared 1
  const notes = (clear) => snap({ t: { key: ['id'], rows: [1, 2, 3].map(id => ({ id, note: clear.includes(id) ? '' : 'x' })) } })
  const n0 = notes([])
  const cleared = flagChanges(diffSnapshots(n0, notes([1])), diffSnapshots(n0, notes([1, 2, 3])), none, { trusted: true })
  assert.deepEqual(cleared.map(f => [f.kind, f.shared, f.pr, f.base]), [['cleared', false, 3, 1]])
  // the order within the base pane's red flags
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, v: 'x' }))
  const seed = snap({ a: { key: ['id'], fields: ['id', 'v', 'old'], rows: rows(30) }, b: { key: ['id'], rows: rows(3) }, c: { key: ['id'], rows: rows(30) } })
  const after = snap({ a: { key: ['id'], fields: ['id', 'v'], rows: rows(30).map(r => ({ ...r, v: 'y' })) }, b: { key: ['id'], rows: [{ id: 1, v: 'x' }, { id: 1, v: 'x' }, { id: 3, v: 'x' }] }, c: { key: ['id'], rows: rows(30).slice(1) } })
  const kinds = flagChanges(diffSnapshots(seed, seed), diffSnapshots(seed, after), none, { trusted: true }).map(f => `${f.collection}:${f.kind}`)
  assert.ok(kinds.indexOf('b:key-lost') < kinds.indexOf('a:column-dropped'), kinds.join(' '))
  assert.ok(kinds.indexOf('c:delete') < kinds.indexOf('a:mass-change'), kinds.join(' '))
  // a base-pane collection the PR's snapshot may have left out: its
  // unverified flag stands with what loses rows, before other collections'
  // column and mass-change flags
  const people = n => ({ key: ['id'], rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
  const pad = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`aaa${String(i).padStart(2, '0')}`, people(3)]))
  const limits = { maxCollections: 2 }
  const s1 = snap({ users: people(20), zz: { key: ['id'], fields: ['id', 'v', 'old'], rows: rows(30) } }, {}, limits)
  const sn = snap({ ...pad, users: people(0), zz: { key: ['id'], fields: ['id', 'v'], rows: rows(30).map(r => ({ ...r, v: 'y' })) } }, {}, limits)
  const lost = flagChanges(diffSnapshots(s1, s1), diffSnapshots(s1, sn), none, { trusted: true }).map(f => `${f.collection}:${f.kind}`)
  assert.ok(lost.indexOf('users:unverified') >= 0 && lost.indexOf('users:unverified') < lost.indexOf('zz:column-dropped'), lost.join(' '))
  // a cut-short base-pane collection's unverified still comes after them
  const cut = snap({ big: { key: ['id'], rows: [{ id: 1 }], count: 50, truncated: true }, zz: { key: ['id'], rows: rows(30) } })
  const cutAfter = snap({ big: { key: ['id'], rows: [{ id: 1 }], count: 40, truncated: true }, zz: { key: ['id'], rows: rows(30).map(r => ({ ...r, v: 'y' })) } })
  const late = flagChanges(diffSnapshots(cut, cut), diffSnapshots(cut, cutAfter), none, { trusted: true }).map(f => `${f.collection}:${f.kind}`)
  assert.ok(late.includes('big:unverified') && late.indexOf('zz:mass-change') < late.indexOf('big:unverified'), late.join(' '))
})

// --- Round 6 of #35's review --------------------------------------------------------

// The review's highs: a DSN password holding ':' (round 5's class left ':'
// out), and a DSN match that ran past a secret element's '>'. The corpus
// test holds both; these name them.
test('a DSN password holding \':\' is masked, and a secret element\'s value is masked before any DSN rule reads past its \'>\'', () => {
  const S = 'Zq9SeCr3tVal'
  const values = {
    a: `root:pa:ss${S}@tcp(127.0.0.1:3306)/app`,
    b: `root:${S}:@tcp(db)/app`,
    c: `root::${S}@tcp(db)/app`,
    d: `<input type="password" name="pw" value="${S}" style="width:100%"><style>@media(max-width:1px){}</style>`,
    e: `<input type="hidden" name="api_token" value="${S}" style="display:none"><style>@supports(x:y){}</style>`,
    f: `<x id="secret" value="${S}" href="mailto:a@b.c">x</x>`,
  }
  const [row] = snap({ c: { key: ['id'], rows: [{ id: 1, ...values }] } }).collections.c.rows
  assert.doesNotMatch(JSON.stringify(row), new RegExp(S))
  // the element's value is masked first (the DSN rule may then mask more)
  assert.match(row.d, /^<input type="password" name="pw" value="\[secret [0-9a-f]{8}\]" style=/)
})

test('the review\'s mutant cases: a base collection the PR\'s diff lacks sorts with what loses rows; fieldsBefore is the before snapshot\'s; MYSQL in capitals; a row pair never masks a key field', () => {
  // the base pane's diff has `users`; the PR pane's lacks it
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, v: 'x' }))
  const seed = snap({ users: { key: ['id'], rows: rows(3) }, zz: { key: ['id'], fields: ['id', 'v', 'old'], rows: rows(30) } })
  const after = snap({ zz: { key: ['id'], fields: ['id', 'v'], rows: rows(30).map(r => ({ ...r, v: 'y' })) } })
  const pr = diffSnapshots(seed, after)
  delete pr.collections.users
  const kinds = flagChanges(diffSnapshots(seed, seed), pr, none, { trusted: true }).map(f => `${f.collection}:${f.kind}`)
  assert.ok(kinds.indexOf('users:unverified') >= 0 && kinds.indexOf('users:unverified') < kinds.indexOf('zz:column-dropped'), kinds.join(' '))
  // seeded columns are those the base pane's before snapshot declares
  const cols = fields => snap({ users: { key: ['id'], fields: ['id', ...fields], rows: [{ id: 1 }] } })
  const baseDiff = diffSnapshots(cols(['email', 'legacy']), cols(['email']))
  const prDiff = diffSnapshots(cols(['email', 'legacy', 'aa_pad']), cols([]))
  const [flag] = flagChanges(baseDiff, prDiff, none, { trusted: true })
  assert.deepEqual([flag.count, flag.seeded, flag.fields], [3, 2, ['email', 'legacy', 'aa_pad']])
  // a MySQL client named in capitals
  const [t] = snap({ c: { key: ['id'], rows: [{ id: 1, v: 'MYSQL -u root -phunter2Zq app' }] } }).collections.c.rows
  assert.match(t.v, /^\[text with a secret-looking key/)
  // a row pair keeps its key fields: renaming a row stays an update
  const kv = (v) => snap({ settings: { key: ['value'], rows: [{ key: 'smtp_password', value: v }] } })
  const k1 = kv('a')
  assert.equal(k1.collections.settings.rows[0].value, 'a', 'a key field is never masked')
  assert.deepEqual(k1.collections.settings.key, ['value'])
})
