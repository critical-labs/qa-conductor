// The data checks' pure engine (#8): what a pane's snapshot keeps, what
// changed between two snapshots of one pane, where the PR pane's changes
// depart from the base pane's, and which of them are destructive. No I/O:
// the conductor takes snapshots through the optional inspector seam and keeps
// them in memory for the session. Exported as ./data-diff, so an inspector's
// author can check their snapshots against it.
//
// Values are shown to the gated harness, masked where they may be secret. A
// field whose name looks secret, or that a rule classifies `secret`, keeps
// only a digest, which says whether it changed. One classified `pii` keeps a
// fingerprint, its type and its length. Digests and fingerprints are HMACs
// under a key made for the session, the same for both panes, so equal
// values compare equal across them, and nothing outlives the session.
//
// Collection and field names are the store's, so any string: every object
// keyed by one is written and read as an own property, so `__proto__` or
// `constructor` is a name like any other.

import { createHmac } from 'node:crypto'

// What a snapshot may hold: rows per collection, bytes per pane snapshot,
// and how long the inspector may take. These bound what is kept, not the
// work on the conductor's event loop: masking scales with the raw data a
// PR's store holds (README, Hostile PR data and the conductor's
// responsiveness).
export const LIMITS = Object.freeze({ maxRows: 10_000, maxBytes: 32 * 1024 * 1024, maxCollections: 1_000, timeoutMs: 30_000 })
export const SECRET_NAME = /pass|pwd|secret|token|salt|hash|otp|api[-_]?key|access[-_]?key|signing[-_]?key|client[-_]?key|encryption[-_]?key|master[-_]?key|ssh[-_]?key|private|session|card|cvv|cvc|ssn|iban|authori[sz]ation|bearer|jwt|cookie|credential|signature|dsn|(?:database|mongo|redis|amqp|postgres(?:ql)?|mysql)[-_]?ur[il]|connection[-_]?string|mnemonic|seed[-_]?phrase|recovery[-_]?code|backup[-_]?code|pin[-_]?code|(?:^|[-_])(?:pin|pw|psk)(?:[-_]|$)|^_?auth$/i
// The longest a string, or an object's JSON, is kept whole.
const MAX_TEXT = 200
// The longest string read as JSON, and how deep JSON held in strings is
// read: past either, a string is kept as text, masked whole if a
// secret-looking key shows in it.
const HELD_JSON_MAX = 256 * 1024
const HELD_JSON_DEPTH = 3
// How many collections' classes the masker remembers before it starts again,
// and how many fields' in all; a name longer than CACHED_NAME is worked out
// each time, never remembered.
const CLASS_CACHE = 1_000
const FIELD_CACHE = 50_000
const CACHED_NAME = 128
// The longest collection name kept (a longer one is left out, said so), and
// the most fields a key or a collection's declared fields may have.
const MAX_NAME = 200
const MAX_KEY_FIELDS = 32
const MAX_FIELDS = 2_000
// Past maxCollections, how many more collections (times maxCollections) are
// kept as counts alone before the rest are left out.
const COUNTED_COLLECTIONS = 10
// More than this many rows changed, or this share of a collection of at
// least MASS_MIN_ROWS, is a mass change.
const MASS_ROWS = 20
const MASS_SHARE = 0.2
const MASS_MIN_ROWS = 5

const own = (obj, name) => (obj && Object.hasOwn(obj, name) ? obj[name] : undefined)
function put(obj, name, value) {
  Object.defineProperty(obj, name, { value, enumerable: true, writable: true, configurable: true })
  return value
}

// --- Rules ---------------------------------------------------------------------

const RULE_LISTS = ['exclude', 'volatile', 'classify', 'softDelete', 'destructive']
const ENTRY_FIELDS = {
  volatile: ['collection', 'fields', 'mode'],
  classify: ['collection', 'fields', 'as'],
  softDelete: ['collection', 'field'],
  destructive: ['collection', 'maxChanged', 'allowDeletes'],
}
const isName = v => typeof v === 'string' && v.length > 0 && v.length <= 200
const isNames = v => Array.isArray(v) && v.every(isName)

// The inspector's `rules`, checked, with defaults: plain data, every list
// optional. A collection name in a rule matches exactly, or with `*`
// standing for any run of characters.
export function validateRules(rules) {
  if (rules === undefined || rules === null) rules = {}
  if (typeof rules !== 'object' || Array.isArray(rules)) throw new Error('rules must be an object')
  for (const key of Object.keys(rules)) if (!RULE_LISTS.includes(key)) throw new Error(`unknown data rule: ${key}`)
  const exclude = rules.exclude ?? []
  if (!isNames(exclude)) throw new Error('exclude must be an array of collection names')
  const each = (name, check) => {
    const list = rules[name] ?? []
    if (!Array.isArray(list)) throw new Error(`${name} must be an array`)
    return list.map((e, i) => {
      const at = `${name}[${i}]`
      if (!e || typeof e !== 'object' || !isName(e.collection)) throw new Error(`${at}.collection must be a collection name`)
      const stray = Object.keys(e).find(k => !ENTRY_FIELDS[name].includes(k))
      if (stray !== undefined) throw new Error(`${at} has a field no rule has: ${stray}`)
      return check(e, at)
    })
  }
  const fieldsOf = (e, at) => {
    if (!isNames(e.fields)) throw new Error(`${at}.fields must be an array of field names`)
    return [...e.fields]
  }
  return {
    exclude: [...exclude],
    volatile: each('volatile', (e, at) => {
      const fields = fieldsOf(e, at)
      if (e.mode !== undefined && e.mode !== 'ignore' && e.mode !== 'presence') throw new Error(`${at}.mode must be ignore or presence`)
      return { collection: e.collection, fields, mode: e.mode ?? 'ignore' }
    }),
    classify: each('classify', (e, at) => {
      const fields = fieldsOf(e, at)
      if (e.as !== 'secret' && e.as !== 'pii') throw new Error(`${at}.as must be secret or pii`)
      return { collection: e.collection, fields, as: e.as }
    }),
    softDelete: each('softDelete', (e, at) => {
      if (!isName(e.field)) throw new Error(`${at}.field must be a field name`)
      return { collection: e.collection, field: e.field }
    }),
    destructive: each('destructive', (e, at) => {
      if (e.maxChanged !== undefined && !(Number.isSafeInteger(e.maxChanged) && e.maxChanged >= 0)) throw new Error(`${at}.maxChanged must be a non-negative integer`)
      if (e.allowDeletes !== undefined && typeof e.allowDeletes !== 'boolean') throw new Error(`${at}.allowDeletes must be a boolean`)
      return { collection: e.collection, maxChanged: e.maxChanged ?? null, allowDeletes: e.allowDeletes === true }
    }),
  }
}

// Each glob compiled once.
const GLOBS = new Map()
function globMatch(pattern, name) {
  if (!pattern.includes('*')) return pattern === name
  let re = GLOBS.get(pattern)
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's')
    GLOBS.set(pattern, re)
  }
  return re.test(name)
}
const rulesFor = (list, collection) => list.filter(r => globMatch(r.collection, collection))
// A collection's own destructive rule, else the first glob that matches it.
const destructiveRule = (rules, name) => rules.destructive.find(r => r.collection === name)
  ?? rulesFor(rules.destructive, name)[0]
  ?? { maxChanged: null, allowDeletes: false }
const softFields = (rules, name) => new Set(rulesFor(rules.softDelete, name).map(r => r.field))

// --- Cells ----------------------------------------------------------------------

const isBytes = v => ArrayBuffer.isView(v) || v instanceof ArrayBuffer
const bytesOf = v => (ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.from(v))

// A value that counts as set: not null, undefined, '', [] or {}, nor an
// empty Set or Map.
function isSet(value) {
  if (value === null || value === undefined || value === '') return false
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  if (isBytes(value)) return value.byteLength > 0
  if (value instanceof Set || value instanceof Map) return value.size > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

// A value as a snapshot keeps it, a "cell":
// - null, a boolean, a finite number, or a string of at most MAX_TEXT
//   characters (a bigint becomes its digits, a date its ISO string);
// - { t: 'json', s }: an object or array, or a string holding one, as
//   JSON, with any value under a secret-looking key masked;
// - { t: 'long', s, len, d }: a longer string, or JSON, cut, with a digest;
// - { t: 'blob', len, d }: bytes;
// - { t: 'secret', d }: a secret value: only whether it changed shows;
// - { t: 'pii', fp, type, len }: personal data, as a fingerprint.
// A value that isn't set (null, '', [] or {}) is kept as it is, whatever
// its field, so clearing one shows. A softDelete field is never masked.
// Cells compare equal exactly when their JSON does.
export function createMasker({ key, rules }) {
  const mac = (text, n) => createHmac('sha256', key).update(text).digest('hex').slice(0, n)
  // collection -> field -> class, for at most CLASS_CACHE collections and
  // FIELD_CACHE fields in all: collection and field names are the store's,
  // and a PR's can be many
  const classes = new Map()
  let fieldsCached = 0
  // 'secret', 'pii', 'plain' (a softDelete field) or null. A secret-looking
  // name, or any `secret` rule, wins over `pii`.
  function classOf(collection, field) {
    const cacheable = collection.length <= CACHED_NAME
    let fields = cacheable ? classes.get(collection) : undefined
    if (!fields) {
      fields = { soft: softFields(rules, collection), classify: rulesFor(rules.classify, collection), known: new Map() }
      if (cacheable) {
        if (classes.size >= CLASS_CACHE) { classes.clear(); fieldsCached = 0 }
        classes.set(collection, fields)
      }
    }
    if (fields.known.has(field)) return fields.known.get(field)
    let as = null
    if (fields.soft.has(field)) as = 'plain'
    else {
      const said = fields.classify.filter(r => r.fields.includes(field)).map(r => r.as)
      as = SECRET_NAME.test(field) || said.includes('secret') ? 'secret' : said.includes('pii') ? 'pii' : null
    }
    if (cacheable && field.length <= CACHED_NAME && fieldsCached < FIELD_CACHE) { fields.known.set(field, as); fieldsCached++ }
    return as
  }
  // A secret-looking key somewhere in text that isn't (or can't be read as)
  // JSON: `"password": …`, `\"password\": …`, `&quot;password&quot;: …`,
  // `api_key=…`, `user[password]=…`, `<password>…`. Looked for at word
  // starts only, never inside a run of backslashes, so the scan is linear,
  // and in the first HELD_JSON_MAX characters: a cell shows at most its
  // first MAX_TEXT.
  const secretKeyIn = s => {
    const head = s.length > HELD_JSON_MAX ? s.slice(0, HELD_JSON_MAX) : s
    if (/[:=]|%3[ad]/i.test(head)) {
      for (const m of head.matchAll(KEY_IN_TEXT)) {
        if (SECRET_NAME.test(m[1])) return true
        // a key read from inside an escape (`%26pin=`, `\npw=`): the name
        // past the escape's hex digits or letter, for names that are words.
        // A match may start at an escape's letter (a backslash is no word
        // character), or right after a percent-escape's hex digits
        const before = head[m.index - 1]
        const past = before === '%' ? m[1].replace(/^[0-9a-f]{2}/i, '') : before === '\\' ? m[1].replace(/^[nrt]/, '') : null
        if (past !== null && past !== m[1] && SECRET_NAME.test(past)) return true
      }
    }
    if (head.includes('<')) for (const m of head.matchAll(TAG_IN_TEXT)) if (SECRET_NAME.test(m[1])) return true
    if (head.includes('-')) {
      for (const m of head.matchAll(FLAG_IN_TEXT)) if (SECRET_NAME.test(m[1])) return true
      if (MYSQL_P.test(head) || PEM_KEY.test(head)) return true
    }
    return false
  }
  // Credentials in a URL, and an Authorization scheme's value, in text kept
  // as text: replaced by a digest, the rest kept. In the first
  // HELD_JSON_MAX characters, as above.
  const maskInText = (s, where) => {
    const head = s.length > HELD_JSON_MAX ? s.slice(0, HELD_JSON_MAX) : s
    const hidden = (tag, value) => `[secret ${mac(`${tag}:${where}\u0000${value}`, 8)}]`
    // In this order: a URL's credentials and a scheme's value first (as
    // before round 6), then an element's value, before a DSN's rule, whose
    // password may hold '>' and so could otherwise run past the element's
    const withUrls = head.replace(URL_USERINFO, (_, scheme, user, pw, token) => {
      if (token !== undefined) return `${scheme}${hidden('u', token)}@`
      // a user that is a token: one that looks like it, or one with no
      // password or GitHub's x-oauth-basic beside it
      const oauth = /^x-oauth-basic$/i.test(pw)
      const userShown = user !== '' && (tokenLike(user) || pw === '' || oauth) ? hidden('u', user) : user
      return `${scheme}${userShown}:${pw === '' || oauth ? pw : hidden('u', pw)}@`
    })
    const masked = authValues(withUrls, value => hidden('a', value))
      // an element whose key, name, id or type looks secret: its value
      .replace(ATTR_TAG, tag => ([...tag.matchAll(ATTR_NAME)].some(m => SECRET_NAME.test(m[2] ?? m[3] ?? m[4]))
        ? tag.replace(ATTR_VALUE, (_, name, eq, dq, sq, bare) => {
          const value = dq ?? sq ?? bare
          const q = dq !== undefined ? '"' : sq !== undefined ? "'" : ''
          return `${name}${eq}${q}${hidden('x', value)}${q}`
        })
        : tag))
      .replace(DSN_USERINFO, (_, user, pw, rest) => `${user}:${hidden('d', pw)}@${rest}`)
      .replace(JWT, value => hidden('j', value))
    return head === s ? masked : masked + s.slice(HELD_JSON_MAX)
  }
  // A string as kept inside JSON (or as a cell): JSON it holds is read and
  // masked too, up to HELD_JSON_DEPTH deep and HELD_JSON_MAX long, line by
  // line for NDJSON; text that can't be read so, but shows a secret-looking
  // key, is masked whole.
  function maskText(s, where, depth) {
    if (s.length <= HELD_JSON_MAX && depth < HELD_JSON_DEPTH) {
      const held = heldJson(s)
      // JSON encoded twice keeps its outer string form, masked within
      if (held !== undefined) return isTwice(s) ? JSON.stringify(toJson(held, where, depth + 1)) : toJson(held, where, depth + 1)
      if (s.includes('\n')) {
        const lines = s.split('\n')
        if (lines.some(line => heldJson(line) !== undefined)) return lines.map(line => maskText(line, where, depth)).join('\n')
      }
    }
    return secretKeyIn(s) ? `[text with a secret-looking key, ${s.length} characters, ${mac(`t:${where}\u0000${s}`, 8)}]` : maskInText(s, where)
  }
  // JSON that never throws: values under secret-looking keys masked (their
  // digests the field's), and so every value of a name and value pair
  // (`{name: 'Authorization', value}`, `{Name, Value}`, `{key, value}`,
  // `{k, v}`) and the one after a secret-looking name in a list of strings
  // (Node's rawHeaders); JSON held in strings read
  // and masked, bytes as their length, a bigint as its digits, a Set or a
  // Map as its entries, and anything unserializable said to be so.
  function toJson(value, where = '', depth = 0) {
    const secret = (k, raw) => `[secret ${mac(`j:${where}\u0000${k}\u0000${toJson(raw, where, HELD_JSON_DEPTH)}`, 8)}]`
    const replacer = function (k, v) {
      const raw = k === '' ? value : this[k]
      if (k !== '' && SECRET_NAME.test(k) && v !== null && v !== undefined) return secret(k, raw)
      if (isBytes(raw)) return `[${raw.byteLength} bytes]`
      if (raw instanceof Set || raw instanceof Map) return [...raw]
      if (Array.isArray(v) && v.some(x => typeof x === 'string' && SECRET_NAME.test(x))) {
        return v.map((x, i) => (i > 0 && typeof v[i - 1] === 'string' && SECRET_NAME.test(v[i - 1]) && x !== null && x !== undefined ? secret(v[i - 1], x) : x))
      }
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const pair = pairOf(v)
        if (pair !== null) return { ...v, ...Object.fromEntries(pair.values.map(k => [k, secret(pair.name, v[k])])) }
      }
      if (typeof v === 'bigint') return v.toString()
      if (typeof v === 'string' && k !== '') return maskText(v, where, depth)
      return v
    }
    try {
      return JSON.stringify(value, replacer) ?? 'null'
    } catch {
      return '"[unserializable]"'
    }
  }
  const text = value => (typeof value === 'string' ? value : isBytes(value) ? bytesOf(value).toString('base64') : toJson(value))
  // An object or array a string holds as JSON, else undefined. A JSON
  // string that holds one (JSON encoded twice) is read through; isTwice
  // says which a string heldJson read was.
  function heldJson(s, twice = true) {
    if (s.length > HELD_JSON_MAX) return undefined
    if (twice && /^\s*"\s*[[{]/.test(s)) {
      try {
        const inner = JSON.parse(s)
        return typeof inner === 'string' ? heldJson(inner, false) : undefined
      } catch {
        return undefined
      }
    }
    if (!/^\s*[[{]/.test(s)) return undefined
    try {
      const v = JSON.parse(s)
      return v !== null && typeof v === 'object' ? v : undefined
    } catch {
      return undefined
    }
  }
  function plain(value, where) {
    if (value === null || value === undefined) return null
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function' || typeof value === 'symbol') return null
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
    if (isBytes(value)) return { t: 'blob', len: value.byteLength, d: mac(`b:${text(value)}`, 16) }
    if (typeof value === 'string') {
      const held = heldJson(value)
      if (held === undefined) {
        // text, NDJSON's included: kept as text, masked where it must be
        const shown = maskText(value, where, 0)
        return shown.length <= MAX_TEXT ? shown : { t: 'long', s: shown.slice(0, MAX_TEXT), len: shown.length, d: mac(`l:${value}`, 16) }
      }
      // JSON encoded twice says so, so re-encoding a column shows
      if (isTwice(value)) return { ...cellOfJsonText(toJson(held, where, 0)), enc: 2 }
      value = held
    }
    return cellOfJsonText(toJson(value, where, 0))
  }
  const cellOfJsonText = s => (s.length <= MAX_TEXT ? { t: 'json', s } : { t: 'long', s: s.slice(0, MAX_TEXT), len: s.length, d: mac(`l:${s}`, 16) })
  // `secret`: the field is a name and value pair's value (pairOf), so
  // secret whatever its name, unless it is a softDelete field
  function cell(collection, field, value, secret = false) {
    const named = classOf(collection, field)
    const as = secret && named !== 'plain' ? 'secret' : named
    if (as === null || as === 'plain' || !isSet(value)) return plain(value, `${collection}\u0000${field}`)
    if (as === 'secret') return { t: 'secret', d: mac(`s:${collection}\u0000${field}\u0000${text(value)}`, 16) }
    const type = Array.isArray(value) ? 'array' : typeof value
    return { t: 'pii', fp: mac(`p:${text(value)}`, 8), type, len: text(value).length }
  }
  return { cell, cached: () => classes.size, cachedFields: () => fieldsCached }
}

// A key in text: at a word start, or right after a percent-escape
// (`x%3dpassword=`, `%26pin%3D`), maybe quoted (an escaped quote, a backtick, one HTML-escaped
// in any case, or one percent-encoded) or in brackets, then up to 32
// spaces and ':' or '=' (or their percent-encodings). A match never starts
// inside a run of backslashes, so a long run is read once, not once from
// each of its backslashes; a key right after a single one
// (`\npassword=`, `C:\x\api_key=`) still counts. A tag's name, with a
// namespace, before whitespace, '/' or '>': `<password>`, `<wsse:Password
// Type="…">`; its attributes aren't read, so a '<' in one doesn't matter.
// A command-line flag (`--password x`, `--db-token=x`), a MySQL client's
// `-p<password>`, and a PEM or PGP private key.
const QUOTE = String.raw`(?:\\*["'\x60]|&(?:quot|apos|#0{0,4}3[49]|#x0{0,4}2[27]);|%2[27])`
const KEY_IN_TEXT = new RegExp(String.raw`(?:(?<![\w.-])|(?<=%[0-9a-f]{2}))(?<!\\(?=\\))${QUOTE}?([\w.-]{1,128})${QUOTE}?\]?\s{0,32}(?:[:=]|%3[ad])`, 'gi')
const TAG_IN_TEXT = /<(?:[\w.-]{1,64}:)?([\w.-]{1,128})(?=[\s/>])/g
const FLAG_IN_TEXT = /(?<!\S)--?([a-z][\w-]{0,63})(?=[\s=])/gi
const MYSQL_P = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,256}?\s-p[^\s-]/i
const PEM_KEY = /-----BEGIN [A-Z ]{0,64}PRIVATE KEY(?: BLOCK)?-----/
// Values in text kept as text, each replaced by a digest:
// - a URL's userinfo: a password (the user may be empty, the password
//   hold '@'), or a token alone (16 characters or more); the user too when
//   it looks like a token, or has no password, or GitHub's x-oauth-basic;
// - an Authorization scheme's value, in any case, that looks like a token
//   (authToken);
// - a Go DSN's password (`user:pw@tcp(…)`, `@tcp6(`, `@unix(`, any
//   network, or `@/`), up to its last '@', a ':' included;
// - a JWT;
// - the value attribute of an element whose key, name, id or type looks
//   secret, quoted either way or not (`<add key="DbPassword" value="…"/>`,
//   `<input type=password value=…>`).
// Each scans a bounded stretch from where it starts (the DSN's, up to 256
// characters from every `word:`: its cost is the README's, Hostile PR data).
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)(?:([^\s/:@]{0,256}):([^\s/]{0,256})|([^\s/:@]{16,256}))@/gi
const AUTH_VALUE = /\b(bearer|basic|token)\s{1,4}([A-Za-z0-9._~+/=-]{8,})/gi
const DSN_USERINFO = /(?<![\w.-])([\w.-]{1,64}):([^\s/]{1,256})@((?:[a-z][\w-]{0,31})?\(|\/)/gi
const JWT = /(?<![\w-])eyJ[\w-]{4,}\.eyJ[\w-]{4,}\.[\w-]{4,}/g
const ATTR_TAG = /<[\w:.-]{1,64}\s[^<>]{0,1024}>/g
const ATTR_NAME = /\b(key|name|id|type)\s*=\s*(?:"([^"<>]{1,128})"|'([^'<>]{1,128})'|([^\s"'<>=\x60]{1,128}))/gi
const ATTR_VALUE = /\b(value)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>=\x60]+))/gi
// A user that looks like a token: a known prefix, or 16 characters with a
// digit.
const tokenLike = s => /^(?:gh[pousr]_|github_pat_|glpat-|xox[abpr]-|sk_live_|sk-)/.test(s) || (s.length >= 16 && /\d/.test(s))
// Each Authorization scheme's value in text that looks like a token,
// replaced by `hide(value)`. One that doesn't is passed over by the
// scheme's name only, so its text can still hold the next scheme (`Bearer
// //bearer <token>`).
function authValues(text, hide) {
  const re = new RegExp(AUTH_VALUE.source, 'gi')
  let out = ''
  let last = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const [whole, scheme, value] = m
    if (authToken(scheme, value)) {
      out += `${text.slice(last, m.index)}${scheme} ${hide(value)}`
      last = m.index + whole.length
    } else re.lastIndex = m.index + scheme.length
  }
  return out + text.slice(last)
}
// An Authorization value that looks like a token: a digit in it, or 16
// characters; for Basic, base64 too (user:password encoded: a length of 4s,
// and a digit, '+', '/', '=' or a capital past the first letter), so prose
// such as "Basic introduction" is left be.
const authToken = (scheme, value) => /\d/.test(value) || value.length >= 16
  || (/^basic$/i.test(scheme) && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && /[0-9+/=]|.[A-Z]/.test(value))
// A string JSON encoded twice: a JSON string literal holding an object or
// array.
const isTwice = s => /^\s*"/.test(s)
// A name and value pair's own keys, in their usual spellings: `name`,
// `key`, `field` or `k` for the name, `value`, `val` or `v` for the value, in
// any case. Any name-like key may name it (`{key: 'mail.smtp', name:
// 'Password', value}`), and every value key is masked. `name` or `key` with `value`, all
// lower case or all capitalized, is a pair whatever else the object holds (a
// HAR cookie has 8 keys, an SSM Parameter 7); the looser spellings only in a
// small object, of at most 6 keys.
const PAIR_NAMES = new Set(['name', 'key', 'field', 'k'])
const PAIR_VALUES = new Set(['value', 'val', 'v'])
const isText = (obj, k) => Object.hasOwn(obj, k) && typeof obj[k] === 'string'
function pairOf(obj) {
  const keys = Object.keys(obj)
  const strict = ((isText(obj, 'name') || isText(obj, 'key')) && Object.hasOwn(obj, 'value'))
    || ((isText(obj, 'Name') || isText(obj, 'Key')) && Object.hasOwn(obj, 'Value'))
  if (!strict && keys.length > 6) return null
  let name = null
  const values = []
  for (const k of keys) {
    const lower = k.toLowerCase()
    if (PAIR_NAMES.has(lower)) {
      if (name === null && typeof obj[k] === 'string' && SECRET_NAME.test(obj[k])) name = obj[k]
    } else if (PAIR_VALUES.has(lower) && obj[k] !== null && obj[k] !== undefined) values.push(k)
  }
  return name !== null && values.length > 0 ? { name, values } : null
}

const canon = value => JSON.stringify(value)
const sizeOf = value => Buffer.byteLength(canon(value))
const isEmptyCell = c => c === null || c === '' || (c?.t === 'json' && (c.s === '[]' || c.s === '{}'))
// A softDelete field that says "not deleted".
const isUnsetCell = c => c === null || c === false || c === 0 || c === ''

// --- Snapshots ------------------------------------------------------------------

// A probe's snapshot as the conductor keeps it: excluded collections gone,
// every value a cell, volatile fields dropped (or kept as whether they are
// set), at most maxRows rows a collection and maxBytes in all, each with its
// true count. A collection with fewer rows than its count is truncated. One
// whose rows don't all have its key fields, or share a key, has no key.
// Anything malformed, or that throws as it is read, is a problem, never a
// throw. `omitted` counts the collections given but not kept (left out, or
// unreadable; not those whose names are too long), or is null when the
// snapshot couldn't be read at all: the diff then never takes a collection
// missing from it for added or dropped.
export function sanitizeSnapshot(raw, { masker, rules, limits }) {
  const { maxRows = LIMITS.maxRows, maxBytes = LIMITS.maxBytes, maxCollections = LIMITS.maxCollections } = limits ?? {}
  const problems = []
  const collections = {}
  let names
  let given
  try {
    given = raw?.collections
    if (!given || typeof given !== 'object' || Array.isArray(given)) return { collections, problems: ['the snapshot has no collections object'], omitted: null }
    names = Object.keys(given).filter(name => !rules.exclude.some(p => globMatch(p, name))).sort()
  } catch (err) {
    return { collections, problems: [`the snapshot could not be read: ${String(err?.message ?? err)}`], omitted: null }
  }
  const total = names.length
  // a name longer than MAX_NAME is left out: no answer has to carry it
  const long = names.filter(name => name.length > MAX_NAME).length
  if (long) {
    problems.push(`${long} collection${long === 1 ? '' : 's'} with a name over ${MAX_NAME} characters ${long === 1 ? 'was' : 'were'} left out`)
    names = names.filter(name => name.length <= MAX_NAME)
  }
  const rowsOf = name => { try { const rows = own(given, name)?.rows; return Array.isArray(rows) ? rows.length : 0 } catch { return 0 } }
  // Past maxCollections, collections are kept by rows, most first, so a PR
  // can't push one out with many small ones. Those past it are kept as their
  // counts alone (truncated, so flagged unverified), up to
  // COUNTED_COLLECTIONS times as many; only past those is one left out, and
  // said so by name.
  const counted = new Map()
  if (names.length > maxCollections) {
    const byRows = names.map(name => [rowsOf(name), name]).sort((x, y) => y[0] - x[0] || (x[1] < y[1] ? -1 : 1)).map(([, name]) => name)
    const stubs = byRows.slice(maxCollections, maxCollections * (1 + COUNTED_COLLECTIONS))
    const out = byRows.slice(maxCollections * (1 + COUNTED_COLLECTIONS))
    const listed = list => (list.length <= 5 ? list.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${list.slice(0, 5).join(', ')} and ${list.length - 5} more`)
    for (const name of stubs) counted.set(name, stubOf(own(given, name)))
    problems.push(`${stubs.length} collections past the first ${maxCollections} by rows are kept as counts only: ${listed([...stubs].sort())}`)
    if (out.length) problems.push(`${out.length} collections past those were left out: ${listed([...out].sort())}`)
    const full = new Set(byRows.slice(0, maxCollections))
    names = names.filter(name => full.has(name) || counted.has(name))
  }
  // The byte budget is shared fairly: collections with the fewest rows go
  // first, and each may use at most an equal share of what is left, so one
  // collection (a PR's padding, say) can't starve the others. A collection
  // past its share is cut short, so only its count is compared.
  const order = names.filter(name => !counted.has(name)).map(name => [rowsOf(name), name]).sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : 1)).map(([, name]) => name)
  let left = maxBytes
  const kept = new Map()
  order.forEach((name, i) => {
    const budget = Math.floor(left / (order.length - i))
    try {
      const out = sanitizeCollection(name, own(given, name), { masker, rules, maxRows, budget, problems })
      if (out === null) return
      left -= out.size
      kept.set(name, out.collection)
    } catch (err) {
      problems.push(`${name}: could not be read: ${String(err?.message ?? err)}`)
    }
  })
  let n = 0
  for (const name of names) {
    if (kept.has(name)) { put(collections, name, kept.get(name)); n++ } else if (counted.has(name)) { put(collections, name, counted.get(name)); n++ }
  }
  // those left out for their length don't count: no name the diff sees
  // can be one of them, so they make no other collection maybe left out
  return { collections, problems, omitted: total - long - n }
}

// A collection kept as its count alone: no rows, truncated.
function stubOf(c) {
  let count = 0
  try {
    const rows = Array.isArray(c?.rows) ? c.rows.length : 0
    count = Math.max(Number.isSafeInteger(c?.count) && c.count >= 0 ? c.count : 0, rows)
  } catch { /* a count of 0 */ }
  return { key: null, fields: null, rows: [], count, truncated: true }
}

function sanitizeCollection(name, c, { masker, rules, maxRows, budget, problems }) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.rows)) {
    problems.push(`${name}: rows must be an array`)
    return null
  }
  const volatile = rulesFor(rules.volatile, name)
  const drop = new Set(volatile.filter(r => r.mode === 'ignore').flatMap(r => r.fields))
  const presence = new Set(volatile.filter(r => r.mode === 'presence').flatMap(r => r.fields))
  const counted = Number.isSafeInteger(c.count) && c.count >= 0 ? c.count : null
  if (c.truncated === true && counted === null) problems.push(`${name}: truncated without a count`)
  const count = Math.max(counted ?? 0, c.rows.length)
  let truncated = c.truncated === true || c.rows.length > maxRows || count > c.rows.length
  // The key and the declared fields: at most MAX_KEY_FIELDS (else no key)
  // and MAX_FIELDS (else only the count is kept), and charged to the
  // collection's bytes like its rows (else only the count is kept).
  let named = isNames(c.key) ? c.key.filter(f => !drop.has(f)) : []
  if (named.length > MAX_KEY_FIELDS) {
    problems.push(`${name}: a key of ${named.length} fields is more than ${MAX_KEY_FIELDS}, so its rows are compared without one`)
    named = []
  }
  const fields = isNames(c.fields) ? c.fields.filter(f => !drop.has(f)) : null
  const countOnly = { size: 0, collection: { key: null, fields: null, rows: [], count, truncated: true } }
  if (fields && fields.length > MAX_FIELDS) {
    problems.push(`${name}: ${fields.length} declared fields are more than ${MAX_FIELDS}, so it is kept as its count`)
    return countOnly
  }
  let size = sizeOf(named) + sizeOf(fields)
  if (size > budget) {
    problems.push(`${name}: its key and declared fields don't fit its share of the bytes, so it is kept as its count`)
    return countOnly
  }
  const rows = []
  let bad = 0
  for (const r of c.rows.slice(0, maxRows)) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { bad++; continue }
    const row = {}
    // a row that is a name and value pair (a settings table's `{key:
    // 'smtp_password', value}`): its value fields are secret, but never one
    // of the collection's key fields, which must keep matching rows
    const pair = pairOf(r)
    for (const field of Object.keys(r).sort()) {
      if (drop.has(field)) continue
      const paired = pair !== null && pair.values.includes(field) && !named.includes(field)
      put(row, field, presence.has(field) ? isSet(r[field]) : masker.cell(name, field, r[field], paired))
    }
    const bytes = sizeOf(row)
    if (size + bytes > budget) { truncated = true; break }
    size += bytes
    rows.push(row)
  }
  if (bad) problems.push(`${name}: ${bad} row${bad === 1 ? ' is' : 's are'} not ${bad === 1 ? 'an object' : 'objects'}`)
  const unique = new Set(rows.map(row => keyOf(named, row))).size === rows.length
  const key = named.length > 0 && unique && rows.every(row => named.every(f => Object.hasOwn(row, f))) ? named : null
  return { size, collection: { key, fields, rows, count, truncated } }
}

// --- Diff -----------------------------------------------------------------------

function keyOf(key, row) {
  return canon(key.map(f => own(row, f) ?? null))
}
const namesOf = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()

// What changed in each collection between two sanitized snapshots of one
// pane. A row is matched by its key; with no key, or a different one, the
// collection is a multiset of rows, and its `key` is null. A collection
// truncated on either side reports only its count: `unknown` when that
// didn't change. A field the collection's declared fields gained or lost is
// named once, not as an update to every row. A collection missing from a
// snapshot that left some out (`omitted`) may only have been left out: it
// is `unknown`, truncated, with `omitted` saying which side, never added
// or dropped.
const mayOmit = snapshot => snapshot.omitted !== undefined && snapshot.omitted !== 0
export function diffSnapshots(before, after) {
  const collections = {}
  for (const name of namesOf(before.collections, after.collections)) {
    const b = own(before.collections, name)
    const a = own(after.collections, name)
    if (!a) { put(collections, name, mayOmit(after) ? omittedChange(b, null, 'after') : changeOf('dropped', b, null, b.key)); continue }
    if (!b && mayOmit(before)) { put(collections, name, omittedChange(null, a, 'before')); continue }
    if (!b) {
      const out = changeOf('added', null, a, a.key)
      if (!a.truncated) out.inserted = a.rows.map(row => ({ key: a.key ? keyOf(a.key, row) : null, row }))
      put(collections, name, out)
      continue
    }
    const key = b.key && a.key && canon(b.key) === canon(a.key) ? b.key : null
    const out = changeOf('same', b, a, key)
    // a key the before snapshot had and the after one hasn't (two rows now
    // share it, say): its rows are compared as a multiset, which turns updates
    // into deletes and inserts. A collection cut short has only its count.
    out.keyLost = Boolean(b.key) && key === null && !out.truncated
    if (b.fields && a.fields) {
      const had = new Set(b.fields)
      const has = new Set(a.fields)
      out.fieldsDropped = b.fields.filter(f => !has.has(f))
      out.fieldsAdded = a.fields.filter(f => !had.has(f))
    }
    const schema = new Set([...out.fieldsDropped, ...out.fieldsAdded])
    if (out.truncated) {
      out.status = b.count !== a.count || schema.size ? 'changed' : 'unknown'
    } else {
      if (key) diffKeyed(out, key, b.rows, a.rows, schema)
      else diffBag(out, b.rows, a.rows, schema)
      if (out.inserted.length || out.deleted.length || out.updated.length || schema.size || b.count !== a.count || out.keyLost) out.status = 'changed'
    }
    put(collections, name, out)
  }
  return { collections }
}

function changeOf(status, b, a, key) {
  return {
    status,
    key,
    inserted: [],
    updated: [],
    deleted: [],
    fieldsDropped: [],
    fieldsAdded: [],
    countBefore: b ? b.count : 0,
    countAfter: a ? a.count : 0,
    truncated: Boolean(b?.truncated || a?.truncated),
    keyLost: false,
    omitted: null,
    // the before snapshot's declared fields, for flagChanges: which dropped
    // columns the base pane declares too
    fieldsBefore: b?.fields ?? null,
  }
}

// A collection one snapshot may have left out: its count there is unknown.
function omittedChange(b, a, side) {
  return { ...changeOf('unknown', b, a, null), countBefore: b ? b.count : null, countAfter: a ? a.count : null, truncated: true, omitted: side }
}

function diffKeyed(out, key, beforeRows, afterRows, schema) {
  const was = new Map(beforeRows.map(row => [keyOf(key, row), row]))
  const now = new Map(afterRows.map(row => [keyOf(key, row), row]))
  for (const [k, row] of now) if (!was.has(k)) out.inserted.push({ key: k, row })
  for (const [k, row] of was) {
    const next = now.get(k)
    if (!next) { out.deleted.push({ key: k, row }); continue }
    const fields = []
    for (const field of namesOf(row, next)) {
      if (schema.has(field)) continue
      const x = own(row, field) ?? null
      const y = own(next, field) ?? null
      if (canon(x) !== canon(y)) fields.push({ field, before: x, after: y })
    }
    if (fields.length) out.updated.push({ key: k, fields })
  }
}

// Without a key: rows as a multiset, compared without the fields the
// schema gained or lost.
function diffBag(out, beforeRows, afterRows, schema) {
  const shape = row => canon(Object.keys(row).filter(f => !schema.has(f)).map(f => [f, row[f]]))
  const bag = rows => {
    const m = new Map()
    for (const row of rows) {
      const c = shape(row)
      const list = m.get(c)
      if (list) list.push(row)
      else m.set(c, [row])
    }
    return m
  }
  const was = bag(beforeRows)
  const now = bag(afterRows)
  for (const [c, rows] of now) for (const row of rows.slice((was.get(c) ?? []).length)) out.inserted.push({ key: null, row })
  for (const [c, rows] of was) for (const row of rows.slice((now.get(c) ?? []).length)) out.deleted.push({ key: null, row })
}

// --- Divergence -----------------------------------------------------------------

// Where the PR pane's changes depart from the base pane's, collection by
// collection. Matched by key, each change (and each field the schema gained
// or lost) is in both panes alike, the PR's only, the base's only, or
// differs between them. Without a common key, or truncated, the counts of
// inserted, updated and deleted rows are compared, with the schema's
// changes. A collection's status sums its changes up: `same`, `both`,
// `pr-only`, `base-only` or `differs`, or `unknown` for a truncated one
// whose counts show nothing.
export function divergence(baseDiff, prDiff) {
  const collections = {}
  for (const name of namesOf(baseDiff.collections, prDiff.collections)) {
    const b = own(baseDiff.collections, name) ?? null
    const p = own(prDiff.collections, name) ?? null
    const counts = { base: countsOf(b), pr: countsOf(p) }
    const truncated = Boolean(b?.truncated || p?.truncated)
    // truncated on one side only: the other's rows and this one's count
    // can't be set side by side. Nor can a collection the PR pane's
    // snapshots don't show at all.
    const oneSided = Boolean(b && p && b.truncated !== p.truncated) || Boolean(b && !p)
    const keyed = b && p && b.key && p.key && canon(b.key) === canon(p.key) && !truncated
    const schema = b && p ? schemaChanges(b, p) : []
    let changes = schema
    let status
    if (keyed) {
      changes = [...schema, ...keyedChanges(b, p)]
      status = sumUp(changes.map(c => c.status))
    } else {
      status = oneSided ? 'unknown' : sumUp([...schema.map(c => c.status), byCounts(counts)])
      if (truncated && status === 'same') status = 'unknown'
    }
    const lifeOf = d => (d?.status === 'added' || d?.status === 'dropped' ? d.status : null)
    const lb = lifeOf(b)
    const lp = lifeOf(p)
    if (lb !== null || lp !== null) {
      const life = sideBySide(lb, lp)
      // the other pane changed what this one dropped or added: they differ
      const otherChanged = life === 'pr-only' ? b?.status === 'changed' : life === 'base-only' ? p?.status === 'changed' : false
      status = life === 'both' ? (status === 'differs' ? 'differs' : 'both') : otherChanged ? 'differs' : life
    }
    // a side whose snapshot may have left it out says nothing either way
    if (b?.omitted || p?.omitted) status = 'unknown'
    put(collections, name, { status, truncated, changes, counts })
  }
  return { collections }
}

function countsOf(d) {
  if (!d || d.omitted) return { inserted: 0, updated: 0, deleted: 0 }
  if (d.truncated) return { inserted: Math.max(0, d.countAfter - d.countBefore), updated: 0, deleted: Math.max(0, d.countBefore - d.countAfter) }
  return { inserted: d.inserted.length, updated: d.updated.length, deleted: d.deleted.length }
}

function byCounts({ base, pr }) {
  const n = c => c.inserted + c.updated + c.deleted
  if (canon(base) === canon(pr)) return n(pr) ? 'both' : 'same'
  if (n(base) === 0) return 'pr-only'
  if (n(pr) === 0) return 'base-only'
  return 'differs'
}

// Two things each pane did (or null, didn't): which pane did it, or whether
// they differ.
function sideBySide(base, pr) {
  if (base === null && pr === null) return 'same'
  if (base === null) return 'pr-only'
  if (pr === null) return 'base-only'
  return base === pr ? 'both' : 'differs'
}

function sumUp(statuses) {
  const seen = new Set(statuses.filter(s => s !== 'same'))
  if (seen.size === 0) return 'same'
  if (seen.has('differs') || (seen.has('pr-only') && seen.has('base-only'))) return 'differs'
  if (seen.has('pr-only')) return 'pr-only'
  if (seen.has('base-only')) return 'base-only'
  return 'both'
}

// Linear in the fields: each list read once into a set.
function schemaChanges(b, p) {
  const out = []
  for (const [kind, list] of [['field-dropped', 'fieldsDropped'], ['field-added', 'fieldsAdded']]) {
    const inBase = new Set(b[list])
    const inPr = new Set(p[list])
    for (const field of [...new Set([...inBase, ...inPr])].sort()) {
      const status = sideBySide(inBase.has(field) ? kind : null, inPr.has(field) ? kind : null)
      out.push({ kind, key: null, field, status, base: null, pr: null })
    }
  }
  return out
}

function keyedChanges(b, p) {
  const changesOf = d => {
    const m = new Map()
    for (const r of d.deleted) m.set(r.key, { kind: 'delete', value: null })
    for (const r of d.inserted) m.set(r.key, { kind: 'insert', value: r.row })
    for (const u of d.updated) m.set(u.key, { kind: 'update', value: u.fields })
    return m
  }
  const bm = changesOf(b)
  const pm = changesOf(p)
  const out = []
  for (const key of [...new Set([...bm.keys(), ...pm.keys()])].sort()) {
    const x = bm.get(key) ?? null
    const y = pm.get(key) ?? null
    const status = sideBySide(x && canon(x), y && canon(y))
    out.push({ kind: (y ?? x).kind, key, status, base: x ? x.value : null, pr: y ? y.value : null })
  }
  return out
}

// --- Flags ----------------------------------------------------------------------

const KINDS = ['delete', 'emptied', 'dropped', 'column-dropped', 'mass-change', 'key-lost', 'unverified', 'cleared']
// What loses rows, a collection or its key: listed first. A dropped
// column loses data too, but is one flag a collection whatever the PR's
// padding, so it comes next, with mass changes.
const LOSES_ROWS = new Set(['delete', 'emptied', 'dropped', 'key-lost'])

// The PR pane's destructive changes, from its diff and the base pane's over
// the same span:
// - delete: rows gone, or newly soft-deleted (a softDelete field set);
// - emptied: a collection whose count fell to 0;
// - dropped: a collection gone;
// - column-dropped: declared fields gone, one flag per collection, with
//   `count`, and the first five in `fields`: first those the base pane's
//   before snapshot declares too (by name; `seeded` counts them), then the
//   PR's own. So many can't push another flag out of a capped list, nor
//   padding columns hide a seeded one;
// - mass-change: more than 20 rows updated or deleted, or more than 20% of
//   a collection of at least 5 (or past a destructive rule's maxChanged);
// - key-lost: a collection whose key the after snapshot no longer bears out
//   (two rows share it), so its rows were compared without one;
// - unverified: a collection the PR pane's snapshot cut short where the base
//   pane's didn't, a cut-short one whose count changed, one a PR snapshot
//   may have left out, or one the base pane's diff has and the PR pane's
//   lacks: what happened past the cut can't be seen, so it is never taken
//   for nothing. One cut short in both panes with no change in count is
//   listed too, amber whatever the trust. Those only the PR pane has (the
//   base pane's diff lacks them) are folded into one flag, with `collection`
//   null, `collections` their number and `names` the first five;
// - cleared: a value set before, null, '', [] or {} now, per field.
// `shared` says the base made the same change: the same rows by key (or the
// same rows, without one), with the same fields changed to the same values,
// the same field, or for two cut-short collections the same count change,
// no fewer rows. A count stands for rows only when both sides have only
// counts. A flag is amber when it is shared and the session is trusted
// (`trusted: true`, its isolation verdict `isolated`), else red; a cleared
// field is amber at most. A destructive rule's allowDeletes lets a
// collection's deletes go unflagged, not its emptying.
// The order: red first; within a severity, collections the base pane has
// before those only the PR pane has; then what loses rows, a collection or
// its key (delete, emptied, dropped, key-lost, and the unverified flag of a
// base-pane collection the PR's snapshots may have left out, or cut short
// where the base pane's didn't), then column-dropped and mass-change, then
// other unverified flags and cleared; then by collection, kind and field.
// So a collection's dropped columns, one flag, or many mass changes can't
// push a delete out of a capped list.
export function flagChanges(baseDiff, prDiff, rules, { trusted }) {
  const base = tally(baseDiff, rules)
  const pr = tally(prDiff, rules)
  const flags = []
  for (const [name, kinds] of pr) {
    for (const [id, mine] of kinds) {
      const theirs = base.get(name)?.get(id)
      const shared = theirs !== undefined && (mine.items === null && theirs.items === null
        ? mine.n <= theirs.n
        : mine.items !== null && theirs.items !== null && includes(theirs.items, mine.items))
      const severity = mine.kind === 'cleared' || (trusted === true && shared) ? 'amber' : 'red'
      // a collection's dropped columns: those the base pane declares too
      // (its seeded columns) first, with their own count, then the PR's own
      let columns = {}
      if (mine.kind === 'column-dropped') {
        const declared = new Set(own(baseDiff.collections, name)?.fieldsBefore ?? [])
        const seeded = mine.items.filter(f => declared.has(f)).sort()
        const others = mine.items.filter(f => !declared.has(f)).sort()
        columns = { count: mine.n, seeded: seeded.length, fields: [...seeded, ...others].slice(0, 5) }
      }
      flags.push({ collection: name, kind: mine.kind, severity, shared, pr: mine.n, base: theirs?.n ?? 0, ...(mine.field === null ? {} : { field: mine.field }), ...columns })
    }
  }
  // cut short in the PR pane only, or cut short with its count changed, or
  // maybe left out; cut short in both with no change, only listed, amber.
  // Those the base pane's diff lacks are the PR's own: one flag for them all
  const prOnly = []
  for (const name of Object.keys(prDiff.collections)) {
    const c = own(prDiff.collections, name)
    if (!c.truncated || c.status === 'dropped') continue
    const b = own(baseDiff.collections, name)
    if (b === undefined) { prOnly.push(name); continue }
    const changed = c.countBefore !== c.countAfter
    const shared = !c.omitted && !b.omitted && Boolean(b.truncated) && b.countBefore === c.countBefore && b.countAfter === c.countAfter
    const severity = (b.truncated && !changed) || (trusted === true && shared) ? 'amber' : 'red'
    flags.push({ collection: name, kind: 'unverified', severity, shared, pr: 1, base: b.truncated ? 1 : 0 })
  }
  if (prOnly.length) {
    prOnly.sort()
    flags.push({ collection: null, kind: 'unverified', severity: 'red', shared: false, pr: prOnly.length, base: 0, collections: prOnly.length, names: prOnly.slice(0, 5) })
  }
  // in the base pane's diff, but not the PR pane's: its snapshots don't
  // show it (left out past the counts kept, say)
  for (const name of Object.keys(baseDiff.collections)) {
    if (!Object.hasOwn(prDiff.collections, name)) flags.push({ collection: name, kind: 'unverified', severity: 'red', shared: false, pr: 1, base: 0 })
  }
  const prOwn = f => (f.collection === null || !Object.hasOwn(baseDiff.collections, f.collection) ? 1 : 0)
  // a base-pane collection the PR's snapshots may have left out, or cut
  // short where the base pane's didn't (a PR's padding can push it into a
  // count): its drop or wipe can't be seen, so its unverified flag stands
  // with what loses rows
  const leftOut = f => {
    if (f.kind !== 'unverified' || typeof f.collection !== 'string') return false
    const c = own(prDiff.collections, f.collection)
    const b = own(baseDiff.collections, f.collection)
    return c === undefined || Boolean(c.omitted) || (Boolean(c.truncated) && b !== undefined && !b.truncated)
  }
  // what loses rows, a collection or the key, before what changes it in
  // bulk (a column, a mass change), before what can't be seen or is cleared
  const late = f => (LOSES_ROWS.has(f.kind) || leftOut(f) ? 0 : f.kind === 'unverified' || f.kind === 'cleared' ? 2 : 1)
  const byName = (x, y) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1)
  const order = (x, y) => (x.severity === y.severity ? 0 : x.severity === 'red' ? -1 : 1)
    || prOwn(x) - prOwn(y)
    || late(x) - late(y)
    || byName(x.collection, y.collection)
    || KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind)
    || String(x.field).localeCompare(String(y.field))
  return flags.sort(order)
}

// Whether a multiset holds every item of another.
function includes(all, some) {
  const left = new Map()
  for (const item of all) left.set(item, (left.get(item) ?? 0) + 1)
  for (const item of some) {
    const n = left.get(item) ?? 0
    if (n === 0) return false
    left.set(item, n - 1)
  }
  return true
}

// collection -> `kind` or `kind field` -> { kind, field, n, items }, where
// items name what the change touched (keys, or rows without a key), or are
// null when only a count is known.
function tally(diff, rules) {
  const out = new Map()
  for (const name of Object.keys(diff.collections)) {
    const c = own(diff.collections, name)
    const rule = destructiveRule(rules, name)
    const soft = softFields(rules, name)
    const kinds = new Map()
    const add = (kind, field, n, items) => {
      if (!n) return
      const id = field === null ? kind : `${kind} ${field}`
      const was = kinds.get(id)
      // in place: a spread copy each time made this quadratic in a field's rows
      let merged = null
      if (!was) merged = items
      else if (was.items !== null && items !== null) { merged = was.items; for (const item of items) merged.push(item) }
      kinds.set(id, { kind, field, n: (was?.n ?? 0) + n, items: merged })
    }
    out.set(name, kinds)
    if (c.status === 'dropped') { add('dropped', null, 1, [name]); continue }
    if (c.omitted) continue
    const rowId = r => (r.key !== null ? r.key : canon(r.row))
    const softly = c.updated.filter(u => u.fields.some(f => soft.has(f.field) && isUnsetCell(f.before) && !isUnsetCell(f.after)))
    const hard = c.truncated ? Math.max(0, c.countBefore - c.countAfter) : c.deleted.length
    const gone = c.truncated ? null : [...c.deleted.map(rowId), ...softly.map(u => u.key)]
    if (!rule.allowDeletes) add('delete', null, hard + softly.length, gone)
    if (c.countBefore > 0 && c.countAfter === 0) add('emptied', null, 1, ['emptied'])
    add('column-dropped', null, c.fieldsDropped.length, [...c.fieldsDropped])
    const changed = c.updated.length + hard
    const mass = rule.maxChanged !== null
      ? changed > rule.maxChanged
      : changed > MASS_ROWS || (c.countBefore >= MASS_MIN_ROWS && changed > c.countBefore * MASS_SHARE)
    // a row with which of its fields changed, and to what: the same rows with
    // other fields changed, or the same fields set to other values, are
    // another change
    const updateId = u => `${u.key} ${u.fields.map(f => `${f.field}=${canon(f.after)}`).sort().join(',')}`
    if (mass) add('mass-change', null, changed, c.truncated ? null : [...c.updated.map(updateId), ...c.deleted.map(rowId)])
    if (c.keyLost) add('key-lost', null, 1, ['key-lost'])
    for (const u of c.updated) {
      for (const f of u.fields) if (!soft.has(f.field) && !isEmptyCell(f.before) && isEmptyCell(f.after)) add('cleared', f.field, 1, [u.key])
    }
  }
  return out
}

// Whether a session's base pane can excuse a PR change: only when its
// isolation verdict is `isolated`. Otherwise the comparison is advisory.
// flagChanges takes it as `trusted: trustOf(isolation) === 'trusted'`.
export function trustOf(isolation) {
  return isolation?.verdict === 'isolated' ? 'trusted' : 'advisory'
}
