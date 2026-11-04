import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultExposure, loadConfig, parseEnvFile } from '../lib/config.mjs'

function envFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-config-'))
  const path = join(dir, '.env.qa')
  writeFileSync(path, lines.join('\n'))
  return path
}

// A public host puts the conductor in tailscale mode, which needs an allowlist.
const REQUIRED = [
  'GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@example.com', 'QA_REPO=acme/widget', 'QA_PUBLIC_HOST=w.ts.net',
  'QA_ALLOWED_LOGINS=alice@github',
]

test('parseEnvFile: KEY=value lines, comments/blanks ignored, values may contain =', () => {
  assert.deepEqual(parseEnvFile(envFile(['# c', '', '   ', 'A=1', 'B=x=y=='])), { A: '1', B: 'x=y==' })
})

// A shell or dotenv habit must not end up inside a value: a quoted token or
// login would never match, and the error would show up far from the file.
test('parseEnvFile: a value in a matching pair of quotes loses them, and nothing inside is unescaped', () => {
  assert.deepEqual(parseEnvFile(envFile([
    'A="x y"', "B='x'", 'C="a # b"', 'D=""', "E=''", 'F="a"b"', 'G="\\n $PATH"',
    'H="unbalanced', "I='mixed\"", 'J=x"y"', 'K="', '  L = " padded "  ',
  ])), {
    A: 'x y', B: 'x', C: 'a # b', D: '', E: '', F: 'a"b', G: '\\n $PATH',
    H: '"unbalanced', I: "'mixed\"", J: 'x"y"', K: '"', L: ' padded ',
  })
  // so a quoted loopback bind is loopback, and a quoted login matches
  const c = loadConfig(envFile([...withoutLogins(REQUIRED), 'QA_BIND_HOST="127.0.0.1"', "QA_ALLOWED_LOGINS='alice@github'"]))
  assert.equal(c.host, '127.0.0.1')
  assert.deepEqual(c.allowedLogins, ['alice@github'])
})

test('parseEnvFile: an inline comment is refused, naming the file, line and key but never the value', () => {
  const refused = (lines, why) => {
    for (const line of lines) {
      const file = envFile(['# the token', line])
      assert.throws(() => parseEnvFile(file), err => {
        assert.equal(err.message, `${file}:2: GITHUB_QA_TOKEN ${why}`)
        assert.doesNotMatch(err.message.slice(file.length), /s3|cret|mine/)
        return true
      }, JSON.stringify(line))
      assert.throws(() => loadConfig(file), /:2: GITHUB_QA_TOKEN has /)
    }
  }
  refused(
    ['GITHUB_QA_TOKEN=s3cret # mine', 'GITHUB_QA_TOKEN=s3cret\t# mine', 'GITHUB_QA_TOKEN= # s3cret', 'GITHUB_QA_TOKEN=s3cret # "mine"'],
    'has an inline comment, and .env.qa takes comments only on lines of their own: move it, or quote the value if the # is part of it',
  )
  // After a quoted value, a # starts a comment however the comment ends: one
  // that ends in a quote must not make the line read as one quoted value.
  refused(
    [
      'GITHUB_QA_TOKEN="s3cret" # mine', 'GITHUB_QA_TOKEN="s3cret" # "mine"', "GITHUB_QA_TOKEN='s3cret'\t# 'mine'",
      'GITHUB_QA_TOKEN="s3cret"# mine', 'GITHUB_QA_TOKEN="s3cret"#"mine"', 'GITHUB_QA_TOKEN=\'s3cret\' # "mine"',
      'GITHUB_QA_TOKEN="s3 # cret" # mine',
    ],
    'has a comment after its quoted value, and .env.qa takes comments only on lines of their own: move it',
  )
  // A # with no space before it is part of an unquoted value, as it always
  // was, and inside quotes one is part of the value unless it follows the quote.
  assert.deepEqual(parseEnvFile(envFile(['A=x#y', 'B=#x', 'C="x#y"', 'D=\'x "#" y\''])), { A: 'x#y', B: '#x', C: 'x#y', D: 'x "#" y' })
})

// Kept, a comment that ends in a quote would join a quoted list's value and
// add what it names: carol, or evil.example to the Host allowlist.
test('loadConfig: a comment after a quoted list never adds entries to it', () => {
  for (const line of [
    'QA_ALLOWED_LOGINS="alice@github" # later: "bob@github, carol@github"',
    "QA_ALLOWED_LOGINS='alice@github' # 'carol@github'",
    'QA_ALLOWED_HOSTS="localhost" # was "old.example, evil.example"',
  ]) {
    const file = envFile([...REQUIRED, line])
    assert.throws(() => loadConfig(file), /:6: QA_ALLOWED_(LOGINS|HOSTS) has a comment after its quoted value/, line)
  }
})

test('QA_HARNESS_FRAME_ANCESTORS: comma-separated origins that may frame the harness; none by default; a non-origin throws', () => {
  const base = ['GITHUB_QA_TOKEN=t', 'QA_REPO=o/r', 'QA_PUBLIC_HOST=h.ts.net', 'QA_ALLOWED_LOGINS=a@github']
  assert.deepEqual(loadConfig(envFile(base)).harnessFrameAncestors, [])
  assert.deepEqual(loadConfig(envFile([...base, 'QA_HARNESS_FRAME_ANCESTORS=https://h.ts.net:8444, https://admin.example'])).harnessFrameAncestors, ['https://h.ts.net:8444', 'https://admin.example'])
  assert.throws(() => loadConfig(envFile([...base, 'QA_HARNESS_FRAME_ANCESTORS=h.ts.net:8444'])), /QA_HARNESS_FRAME_ANCESTORS/)
})

test('theme keys: a stylesheet path resolved from the env file\'s directory, a title and a brand; none by default', () => {
  const base = ['GITHUB_QA_TOKEN=t', 'QA_REPO=o/r', 'QA_PUBLIC_HOST=h.ts.net', 'QA_ALLOWED_LOGINS=a@github']
  assert.deepEqual(loadConfig(envFile(base)).theme, { css: null, title: null, brand: null })
  const file = envFile([...base, 'QA_THEME_CSS=theme/acme.css', 'QA_TITLE=Acme QA', 'QA_BRAND=Acme'])
  const cfg = loadConfig(file)
  assert.equal(cfg.theme.css, path.join(path.dirname(file), 'theme', 'acme.css'))
  assert.deepEqual([cfg.theme.title, cfg.theme.brand], ['Acme QA', 'Acme'])
  assert.equal(loadConfig(envFile([...base, 'QA_THEME_CSS=/abs/t.css'])).theme.css, '/abs/t.css')
})

test('generic defaults: ports, pane origins from public host, verdict labels', () => {
  const c = loadConfig(envFile(REQUIRED))
  assert.equal(c.githubToken, 'tok')
  assert.equal(c.operatorEmail, 'op@example.com')
  assert.equal(c.repo, 'acme/widget')
  assert.equal(c.publicHost, 'w.ts.net')
  assert.equal(c.idleMinutes, 30)
  assert.deepEqual(c.ports, { harness: 3100, base: 3101, pr: 3102 })
  assert.deepEqual(c.paneOrigins, { base: 'https://w.ts.net:8443', pr: 'https://w.ts.net:10000' })
  assert.deepEqual(c.verdictLabels, { accept: 'qa-approved', reject: 'qa-changes-requested' })
  // the raw map is exposed so a platform can read its own keys
  assert.equal(c.env.QA_REPO, 'acme/widget')
})

test('overrides: ports, origins, labels, idle minutes (a number)', () => {
  const c = loadConfig(envFile([...REQUIRED,
    'QA_HARNESS_PORT=4100', 'QA_BASE_PROXY_PORT=4101', 'QA_PR_PROXY_PORT=4102',
    'QA_BASE_ORIGIN=http://127.0.0.1:4101', 'QA_PR_ORIGIN=http://127.0.0.1:4102',
    'QA_LABEL_ACCEPT=ok', 'QA_LABEL_REJECT=nope', 'QA_IDLE_MINUTES=15']))
  assert.deepEqual(c.ports, { harness: 4100, base: 4101, pr: 4102 })
  assert.deepEqual(c.paneOrigins, { base: 'http://127.0.0.1:4101', pr: 'http://127.0.0.1:4102' })
  assert.deepEqual(c.verdictLabels, { accept: 'ok', reject: 'nope' })
  assert.equal(c.idleMinutes, 15)
})

test('platform defaults fill gaps; file values win', () => {
  // the default public host puts it in tailscale mode, so it needs logins
  const c = loadConfig(envFile(['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@example.com', 'QA_REPO=file/wins', 'QA_ALLOWED_LOGINS=alice@github']),
    { defaults: { QA_REPO: 'default/repo', QA_PUBLIC_HOST: 'd.ts.net' } })
  assert.equal(c.repo, 'file/wins')
  assert.equal(c.publicHost, 'd.ts.net')
})

test('no app defaults: each required key is enforced', () => {
  for (const missing of ['GITHUB_QA_TOKEN', 'QA_REPO', 'QA_PUBLIC_HOST']) {
    const lines = REQUIRED.filter(l => !l.startsWith(`${missing}=`))
    assert.throws(() => loadConfig(envFile(lines)), new RegExp(missing))
  }
})

test('QA_OPERATOR_EMAIL is optional: operatorEmail is null when unset', () => {
  const c = loadConfig(envFile(REQUIRED.filter(l => !l.startsWith('QA_OPERATOR_EMAIL='))))
  assert.equal(c.operatorEmail, null)
})

test('QA_PUBLIC_HOST is required only when the two pane origins are not both set', () => {
  const noHost = REQUIRED.filter(l => !l.startsWith('QA_PUBLIC_HOST='))
  const c = loadConfig(envFile([...noHost, 'QA_BASE_ORIGIN=http://127.0.0.1:3101', 'QA_PR_ORIGIN=http://127.0.0.1:3102']))
  assert.equal(c.publicHost, null)
  assert.deepEqual(c.paneOrigins, { base: 'http://127.0.0.1:3101', pr: 'http://127.0.0.1:3102' })
  // one origin alone still needs the host to derive the other
  assert.throws(() => loadConfig(envFile([...noHost, 'QA_BASE_ORIGIN=http://127.0.0.1:3101'])), /QA_PUBLIC_HOST/)
  assert.throws(() => loadConfig(envFile([...noHost, 'QA_PR_ORIGIN=http://127.0.0.1:3102'])), /QA_PUBLIC_HOST/)
})

test('required: a platform can re-require keys; token and repo stay required', () => {
  const noEmail = REQUIRED.filter(l => !l.startsWith('QA_OPERATOR_EMAIL='))
  assert.throws(() => loadConfig(envFile(noEmail), { required: ['QA_OPERATOR_EMAIL'] }), /QA_OPERATOR_EMAIL/)
  assert.equal(loadConfig(envFile(REQUIRED), { required: ['QA_OPERATOR_EMAIL'] }).operatorEmail, 'op@example.com')
  // a re-required key may come from the platform defaults
  assert.equal(loadConfig(envFile(noEmail), { required: ['QA_OPERATOR_EMAIL'], defaults: { QA_OPERATOR_EMAIL: 'd@x' } }).operatorEmail, 'd@x')
  // `required` adds to the core keys; it cannot waive them
  for (const missing of ['GITHUB_QA_TOKEN', 'QA_REPO']) {
    const lines = REQUIRED.filter(l => !l.startsWith(`${missing}=`))
    assert.throws(() => loadConfig(envFile(lines), { required: [] }), new RegExp(missing))
  }
})

// A fine-grained GITHUB_QA_TOKEN cannot call the Packages API; a classic PAT
// with read:packages in QA_GHCR_TOKEN takes the GHCR calls over.
test('the GHCR token is QA_GHCR_TOKEN, falling back to GITHUB_QA_TOKEN', () => {
  assert.equal(loadConfig(envFile(REQUIRED)).ghcrToken, 'tok')
  assert.equal(loadConfig(envFile([...REQUIRED, 'QA_GHCR_TOKEN='])).ghcrToken, 'tok')
  const c = loadConfig(envFile([...REQUIRED, 'QA_GHCR_TOKEN=ghcr-tok']))
  assert.equal(c.ghcrToken, 'ghcr-tok')
  assert.equal(c.githubToken, 'tok', 'the repo token is unchanged')
})

test('listens on 127.0.0.1, or on the loopback address QA_BIND_HOST names', () => {
  assert.equal(loadConfig(envFile(REQUIRED)).host, '127.0.0.1')
  assert.equal(loadConfig(envFile([...REQUIRED, 'QA_BIND_HOST='])).host, '127.0.0.1')
  assert.equal(loadConfig(envFile([...REQUIRED, 'QA_BIND_HOST=::1'])).host, '::1')
  for (const host of ['127.0.0.2', 'localhost']) {
    assert.equal(loadConfig(envFile([...REQUIRED, `QA_BIND_HOST=${host}`])).host, host)
  }
  // listen() takes no brackets: `[::1]` passed the tailscale bind check, then
  // failed to listen
  const c = loadConfig(envFile([...REQUIRED, 'QA_BIND_HOST=[::1]']))
  assert.deepEqual([c.host, c.exposure], ['::1', 'tailscale'])
})

test('QA_ALLOWED_HOSTS: comma-separated, trimmed, empties dropped; default none', () => {
  assert.deepEqual(loadConfig(envFile(REQUIRED)).allowedHosts, [])
  const c = loadConfig(envFile([...REQUIRED, 'QA_ALLOWED_HOSTS= qa.example.com ,, host.docker.internal,']))
  assert.deepEqual(c.allowedHosts, ['qa.example.com', 'host.docker.internal'])
})

// The pane proxies send the pane apps only their own jar's cookies; these
// names are the browser cookies a consumer opts in to passing through.
test('QA_FORWARD_CLIENT_COOKIES: comma-separated cookie names, trimmed, empties dropped; default none; a wildcard or a name that is not a token throws', () => {
  assert.deepEqual(loadConfig(envFile(REQUIRED)).forwardClientCookies, [])
  assert.deepEqual(loadConfig(envFile([...REQUIRED, 'QA_FORWARD_CLIENT_COOKIES='])).forwardClientCookies, [])
  const c = loadConfig(envFile([...REQUIRED, 'QA_FORWARD_CLIENT_COOKIES= csrftoken ,, __Host-locale,csrftoken']))
  assert.deepEqual(c.forwardClientCookies, ['csrftoken', '__Host-locale'], 'listed once each')
  for (const [value, shown] of [['*', '*'], ['csrftoken, *', '*'], ['sess*', 'sess*'], ['a b', 'a b'], ['a=b', 'a=b'], ['a;b', 'a;b'], ['locale, "sid"', '"sid"'], ['séance', 'séance']]) {
    const file = envFile([...REQUIRED, `QA_FORWARD_CLIENT_COOKIES=${value}`])
    assert.throws(() => loadConfig(file), err => {
      assert.equal(err.message, `QA_FORWARD_CLIENT_COOKIES must be comma-separated cookie names (RFC 6265 tokens; no wildcards: list each name), got ${JSON.stringify(shown)} in ${file}`)
      return true
    }, value)
  }
})

// What the CHANGELOG's migration note warns of: a single quote is a token
// character, so no error catches a list whose names are quoted one by one.
test('QA_FORWARD_CLIENT_COOKIES: a single quote is part of a name, so quoting each name keeps its quotes; quoting the whole list drops them', () => {
  const names = value => loadConfig(envFile([...REQUIRED, `QA_FORWARD_CLIENT_COOKIES=${value}`])).forwardClientCookies
  assert.deepEqual(names(`it's`), [`it's`])
  assert.deepEqual(names(`'a','b'`), [`a'`, `'b`])
  assert.deepEqual(names(`'a,b'`), ['a', 'b'])
  assert.deepEqual(names(`"a,b"`), ['a', 'b'])
  assert.throws(() => names(`"a","b"`), /^Error: QA_FORWARD_CLIENT_COOKIES must be comma-separated cookie names .*, got "a\\""/)
})

// The pane cookie the capability sets is the conductor's own: passed through,
// a pane app (PR code) would get the reviewer's pane capability.
test('QA_FORWARD_CLIENT_COOKIES refuses a name starting with qa-, in any case and behind a cookie prefix', () => {
  for (const name of ['qa-1f2e3d4c', 'QA-x', '__Host-qa-1', '__Secure-qa-1']) {
    const file = envFile([...REQUIRED, `QA_FORWARD_CLIENT_COOKIES=locale, ${name}`])
    assert.throws(() => loadConfig(file), err => {
      assert.equal(err.message, `QA_FORWARD_CLIENT_COOKIES can't name ${JSON.stringify(name)}: cookie names starting with qa- are the conductor's own, in ${file}`)
      return true
    }, name)
  }
  assert.deepEqual(loadConfig(envFile([...REQUIRED, 'QA_FORWARD_CLIENT_COOKIES=qa, qa_1, x-qa-1'])).forwardClientCookies, ['qa', 'qa_1', 'x-qa-1'])
})

// --- 0.3.0: the harness origin --------------------------------------------------

const NO_HOST = REQUIRED.filter(l => !l.startsWith('QA_PUBLIC_HOST='))
const LOOPBACK_PANES = ['QA_BASE_ORIGIN=http://127.0.0.1:3101', 'QA_PR_ORIGIN=http://127.0.0.1:3102']

test('the harness origin defaults to :8444 on the public host; QA_HARNESS_ORIGIN overrides it, path dropped', () => {
  assert.equal(loadConfig(envFile(REQUIRED)).harnessOrigin, 'https://w.ts.net:8444')
  const c = loadConfig(envFile([...REQUIRED, 'QA_HARNESS_ORIGIN=https://h.ts.net:8445/qa/']))
  assert.equal(c.harnessOrigin, 'https://h.ts.net:8445', 'an origin only: no path, no trailing slash')
  for (const bad of ['h.ts.net:8444', '*', 'ftp://h.ts.net']) {
    assert.throws(() => loadConfig(envFile([...REQUIRED, `QA_HARNESS_ORIGIN=${bad}`])), /QA_HARNESS_ORIGIN must be an origin/, bad)
  }
  // the public host wins over a loopback listen address
  assert.equal(loadConfig(envFile([...REQUIRED, ...LOOPBACK_PANES])).harnessOrigin, 'https://w.ts.net:8444')
})

test('without a public host the harness origin is the loopback listen address: http://127.0.0.1:3100, http://[::1]:3100; null on port 0', () => {
  const load = (...lines) => loadConfig(envFile([...NO_HOST, ...LOOPBACK_PANES, ...lines])).harnessOrigin
  assert.equal(load(), 'http://127.0.0.1:3100')
  assert.equal(load('QA_HARNESS_PORT=4100'), 'http://127.0.0.1:4100')
  assert.equal(load('QA_BIND_HOST=::1'), 'http://[::1]:3100')
  assert.equal(load('QA_BIND_HOST=[::1]'), 'http://[::1]:3100')
  assert.equal(load('QA_BIND_HOST=localhost'), 'http://localhost:3100')
  assert.equal(load('QA_BIND_HOST=127.0.0.2'), 'http://127.0.0.2:3100')
  // the conductor derives it from the bound port instead
  assert.equal(load('QA_HARNESS_PORT=0'), null)
  // an explicit origin still wins
  assert.equal(load('QA_HARNESS_ORIGIN=http://localhost:3100'), 'http://localhost:3100')
})

test('a non-loopback QA_BIND_HOST with no public host needs QA_HARNESS_ORIGIN', () => {
  for (const extra of [[], ['QA_HARNESS_PORT=0']]) {
    assert.throws(() => loadConfig(envFile([...NO_HOST, ...LOOPBACK_PANES, 'QA_BIND_HOST=0.0.0.0', ...extra])), err => {
      assert.match(err.message, /^QA_HARNESS_ORIGIN missing in /)
      assert.match(err.message, /QA_BIND_HOST=0\.0\.0\.0/)
      return true
    }, extra.join())
  }
  // (a non-loopback bind needs QA_EXPOSURE=none, behind another front door)
  const c = loadConfig(envFile([...NO_HOST, ...LOOPBACK_PANES, 'QA_BIND_HOST=0.0.0.0', 'QA_HARNESS_ORIGIN=https://box.lan:3100', 'QA_EXPOSURE=none']))
  assert.equal(c.harnessOrigin, 'https://box.lan:3100')
})

test('QA_HARNESS_ORIGIN, QA_BASE_ORIGIN and QA_PR_ORIGIN must be http(s) origins and are normalized', () => {
  for (const key of ['QA_HARNESS_ORIGIN', 'QA_BASE_ORIGIN', 'QA_PR_ORIGIN']) {
    for (const bad of ['h.ts.net:8444', '*', 'ftp://h.ts.net', 'file:///x', 'data:text/html,x', 'https://a;b', "https://a'b", 'https://a,b']) {
      assert.throws(() => loadConfig(envFile([...REQUIRED, `${key}=${bad}`])), new RegExp(`^Error: ${key} must be an origin such as https://host:8444`), `${key}=${bad}`)
    }
  }
  const c = loadConfig(envFile([...REQUIRED,
    'QA_HARNESS_ORIGIN=HTTPS://H.TS.NET:443/qa/', 'QA_BASE_ORIGIN=http://127.0.0.1:4101/', 'QA_PR_ORIGIN=https://W.ts.net:10000/login?x=1#k']))
  assert.equal(c.harnessOrigin, 'https://h.ts.net')
  assert.deepEqual(c.paneOrigins, { base: 'http://127.0.0.1:4101', pr: 'https://w.ts.net:10000' })
  // the derived defaults go through the same rule
  const derived = loadConfig(envFile([...NO_HOST, 'QA_PUBLIC_HOST=W.TS.NET']))
  assert.equal(derived.harnessOrigin, 'https://w.ts.net:8444')
  assert.deepEqual(derived.paneOrigins, { base: 'https://w.ts.net:8443', pr: 'https://w.ts.net:10000' })
  assert.throws(() => loadConfig(envFile([...NO_HOST, 'QA_PUBLIC_HOST=w.ts.net;x'])), /must be an origin/)
})

test('QA_FRAME_ANCESTORS: comma-separated origins, normalized; anything else throws', () => {
  assert.deepEqual(loadConfig(envFile(REQUIRED)).frameAncestors, [])
  const c = loadConfig(envFile([...REQUIRED, 'QA_FRAME_ANCESTORS= https://A.ts.net:8444/qa/ ,, http://127.0.0.1:3100,']))
  assert.deepEqual(c.frameAncestors, ['https://a.ts.net:8444', 'http://127.0.0.1:3100'])
  for (const bad of ['https://ok.ts.net, nope', '*', "'self'", 'https://a;b', 'file:///x']) {
    assert.throws(() => loadConfig(envFile([...REQUIRED, `QA_FRAME_ANCESTORS=${bad}`])), /^Error: QA_FRAME_ANCESTORS must be an origin/, bad)
  }
})

test('the harness and the two panes must be three different origins', () => {
  const refuses = (lines, re) => assert.throws(() => loadConfig(envFile(lines)), err => {
    assert.match(err.message, /must be three different origins/)
    assert.match(err.message, re)
    return true
  }, lines.join(' '))
  refuses([...REQUIRED, 'QA_HARNESS_ORIGIN=https://w.ts.net:8443'], /harness and base/)
  refuses([...REQUIRED, 'QA_HARNESS_ORIGIN=https://W.TS.NET:10000/'], /harness and pr/)
  refuses([...REQUIRED, 'QA_BASE_ORIGIN=https://w.ts.net:10000/'], /base and pr/)
  // the harness origin derived from the loopback listen address counts too
  refuses([...NO_HOST, 'QA_BASE_ORIGIN=http://127.0.0.1:3100', 'QA_PR_ORIGIN=http://127.0.0.1:3102'], /harness and base/)
  // on port 0 the panes are still compared with each other
  refuses([...NO_HOST, 'QA_HARNESS_PORT=0', 'QA_BASE_ORIGIN=http://127.0.0.1:3101', 'QA_PR_ORIGIN=http://127.0.0.1:3101/'], /base and pr/)
  // another port, scheme or host is another origin
  assert.ok(loadConfig(envFile([...NO_HOST, ...LOOPBACK_PANES, 'QA_HARNESS_ORIGIN=https://127.0.0.1:3101'])))
})

// Browsers send Fetch Metadata only to https and loopback origins. Without it,
// another page's <img> or <iframe> GET carries neither Sec-Fetch-Site nor
// Origin, and the guards take it for curl.
test('an http origin must be loopback: browsers send no Sec-Fetch-* headers to plain http anywhere else', () => {
  for (const [key, guard] of [['QA_HARNESS_ORIGIN', 'harness API guard'], ['QA_BASE_ORIGIN', 'pane request guard'], ['QA_PR_ORIGIN', 'pane request guard']]) {
    for (const value of ['http://box.lan:3100', 'http://192.168.1.5:3100', 'http://h.tail1234.ts.net:3100', 'http://0.0.0.0:3100']) {
      assert.throws(() => loadConfig(envFile([...REQUIRED, `${key}=${value}/`])), err => {
        assert.equal(err.message, `${key} ${value}: browsers send no Sec-Fetch-* headers to a plain-http origin off loopback, so the ${guard} can't tell other pages apart; use https or a loopback address`)
        return true
      }, `${key}=${value}`)
    }
  }
  // https anywhere; http on 127.0.0.0/8, ::1 and localhost
  const c = loadConfig(envFile([...NO_HOST, 'QA_BIND_HOST=0.0.0.0', 'QA_EXPOSURE=none',
    'QA_HARNESS_ORIGIN=https://box.lan:3100', 'QA_BASE_ORIGIN=http://localhost:3101', 'QA_PR_ORIGIN=http://[::1]:3102']))
  assert.deepEqual([c.harnessOrigin, c.paneOrigins], ['https://box.lan:3100', { base: 'http://localhost:3101', pr: 'http://[::1]:3102' }])
  assert.equal(loadConfig(envFile([...NO_HOST, ...LOOPBACK_PANES, 'QA_HARNESS_ORIGIN=http://127.0.0.2:3100'])).harnessOrigin, 'http://127.0.0.2:3100')
})

// --- 0.3.0: exposure modes and the identity gate ----------------------------------

// Everything loopback: self-QA's and agent-identity's layout.
const LOOPBACK = [...NO_HOST, ...LOOPBACK_PANES]
const withoutLogins = lines => lines.filter(l => !l.startsWith('QA_ALLOWED_LOGINS='))
const BIND_RULE = 'QA_BIND_HOST must be a loopback address: tailscale serve on this host is the only supported front'
const NONE_HINT = ', or set QA_EXPOSURE=none if another front door authenticates'

test('QA_EXPOSURE: an explicit value wins, and anything else throws. Unset, it is tailscale when any of these is not loopback: the harness origin, a pane origin, QA_PUBLIC_HOST, a QA_ALLOWED_HOSTS entry or QA_BIND_HOST. When all are loopback, it is none.', () => {
  const mode = (...lines) => loadConfig(envFile([...LOOPBACK, ...lines])).exposure
  for (const lines of [
    [], ['QA_EXPOSURE='], ['QA_BIND_HOST=::1'], ['QA_BIND_HOST=localhost'], ['QA_BIND_HOST=127.0.0.2'],
    // on port 0 the harness origin is null until it listens: it adds nothing
    ['QA_HARNESS_PORT=0'],
    ['QA_HARNESS_ORIGIN=http://localhost:3100'], ['QA_HARNESS_ORIGIN=https://127.0.0.1:3100'],
    ['QA_BASE_ORIGIN=http://[::1]:3101'], ['QA_ALLOWED_HOSTS=localhost, 127.0.0.2,[::1]'],
    ['QA_PUBLIC_HOST=localhost'],
  ]) {
    assert.equal(mode(...lines), 'none', lines.join())
  }
  for (const lines of [
    ['QA_HARNESS_ORIGIN=https://h.ts.net:8444'],
    ['QA_BASE_ORIGIN=https://h.ts.net:8443'],
    ['QA_PR_ORIGIN=https://h.ts.net:10000'],
    // the harness and pane origins it derives count too, but it counts alone
    ['QA_PUBLIC_HOST=h.ts.net'],
    ['QA_PUBLIC_HOST=h.ts.net', 'QA_HARNESS_ORIGIN=http://127.0.0.1:3100'],
    ['QA_ALLOWED_HOSTS=localhost,box.ts.net'],
  ]) {
    assert.equal(mode(...lines), 'tailscale', lines.join())
  }
  // a non-loopback bind alone makes it tailscale, which then refuses that bind
  assert.throws(
    () => mode('QA_HARNESS_ORIGIN=http://127.0.0.1:3100', 'QA_BIND_HOST=0.0.0.0'),
    err => err.message.startsWith(`QA_EXPOSURE defaults to tailscale because QA_BIND_HOST=0.0.0.0 is not loopback, so ${BIND_RULE}`),
  )
  // an explicit value wins either way
  assert.equal(mode('QA_EXPOSURE=tailscale'), 'tailscale')
  assert.equal(loadConfig(envFile([...REQUIRED, 'QA_EXPOSURE=none'])).exposure, 'none')
  assert.equal(loadConfig(envFile([...REQUIRED, 'QA_EXPOSURE=tailscale'])).exposure, 'tailscale')
  for (const bad of ['Tailscale', 'NONE', 'off', 'caddy', '0', 'true']) {
    assert.throws(() => mode(`QA_EXPOSURE=${bad}`), err => {
      assert.match(err.message, /^QA_EXPOSURE must be none or tailscale, got "/)
      assert.ok(err.message.includes(JSON.stringify(bad)), err.message)
      return true
    }, bad)
  }
  // origins are checked first, then the mode
  assert.throws(() => mode('QA_EXPOSURE=off', 'QA_HARNESS_ORIGIN=ftp://x'), /QA_HARNESS_ORIGIN must be an origin/)
})

// A hand-made `tailscale serve` in front of a loopback layout: any tailnet
// device could curl the API (non-browser clients pass the API guard), so the
// Host the servers answer to puts it in tailscale mode.
test('QA_ALLOWED_HOSTS=box.ts.net with loopback origins resolves to tailscale, and the error names it', () => {
  assert.equal(loadConfig(envFile([...LOOPBACK, 'QA_ALLOWED_HOSTS=box.ts.net'])).exposure, 'tailscale')
  const file = envFile(withoutLogins([...LOOPBACK, 'QA_ALLOWED_HOSTS=localhost,box.ts.net']))
  assert.throws(() => loadConfig(file), err => {
    assert.ok(err.message.startsWith(`QA_ALLOWED_LOGINS is empty in ${file} and QA_EXPOSURE is tailscale (the QA_ALLOWED_HOSTS entry box.ts.net is not loopback)`), err.message)
    return true
  })
  assert.throws(
    () => loadConfig(envFile([...LOOPBACK, 'QA_ALLOWED_HOSTS=box.ts.net', 'QA_BIND_HOST=0.0.0.0', 'QA_HARNESS_ORIGIN=http://127.0.0.1:3100'])),
    err => err.message.startsWith(`QA_EXPOSURE defaults to tailscale because the QA_ALLOWED_HOSTS entry box.ts.net is not loopback, so ${BIND_RULE}`),
  )
  // behind another authenticating front door
  assert.equal(loadConfig(envFile(withoutLogins([...LOOPBACK, 'QA_ALLOWED_HOSTS=box.ts.net', 'QA_EXPOSURE=none']))).exposure, 'none')
})

// The resolver loadConfig and startConductor share, for a cfg that names no mode.
test('defaultExposure: a missing or unparseable pane origin counts as non-loopback; a null harness origin adds nothing', () => {
  const panes = { base: 'http://127.0.0.1:3101', pr: 'http://localhost:3102' }
  const layout = { harnessOrigin: null, paneOrigins: panes, publicHost: null, allowedHosts: [], host: '127.0.0.1' }
  assert.deepEqual(defaultExposure(layout), { mode: 'none', because: null })
  // the demo's placeholders, before its proxies listen
  assert.deepEqual(defaultExposure({ ...layout, paneOrigins: { base: 'http://127.0.0.1', pr: 'http://127.0.0.1' } }).mode, 'none')
  assert.deepEqual(defaultExposure({ ...layout, harnessOrigin: 'http://[::1]:3100' }).mode, 'none')
  for (const [change, because] of [
    [{ paneOrigins: { pr: panes.pr } }, 'QA_BASE_ORIGIN (unset)'],
    [{ paneOrigins: { base: panes.base, pr: null } }, 'QA_PR_ORIGIN (unset)'],
    [{ paneOrigins: undefined }, 'QA_BASE_ORIGIN (unset)'],
    [{ paneOrigins: { base: 'not a url', pr: panes.pr } }, 'QA_BASE_ORIGIN="not a url"'],
    [{ paneOrigins: { base: panes.base, pr: 'file:///x' } }, 'QA_PR_ORIGIN="file:///x"'],
    // a hand-built cfg whose harness origin is derived from its public host
    [{ harnessOrigin: 'https://h.ts.net:8444' }, 'QA_HARNESS_ORIGIN=https://h.ts.net:8444'],
    [{ harnessOrigin: 'nope' }, 'QA_HARNESS_ORIGIN=nope'],
    [{ paneOrigins: { base: panes.base, pr: 'https://h.ts.net:10000' } }, 'QA_PR_ORIGIN=https://h.ts.net:10000'],
    [{ publicHost: 'h.ts.net', harnessOrigin: 'https://h.ts.net:8444' }, 'QA_PUBLIC_HOST=h.ts.net'],
    [{ allowedHosts: ['', 'localhost', 'Box.ts.net'] }, 'the QA_ALLOWED_HOSTS entry Box.ts.net'],
    [{ host: '0.0.0.0' }, 'QA_BIND_HOST=0.0.0.0'],
    [{ host: '::' }, 'QA_BIND_HOST=::'],
  ]) {
    assert.deepEqual(defaultExposure({ ...layout, ...change }), { mode: 'tailscale', because }, JSON.stringify(change))
  }
  // the bind host defaults to loopback
  assert.equal(defaultExposure({ paneOrigins: panes }).mode, 'none')
})

test('tailscale mode refuses a QA_BIND_HOST that is not loopback; none mode accepts 0.0.0.0', () => {
  // Off loopback, anyone who reaches the port can send their own
  // Tailscale-User-Login.
  for (const host of ['0.0.0.0', '::', '*', '100.64.0.1', '"127.0.0.1', '127.0.0.1.nip.io', '::ffff:127.0.0.1', 'example.com']) {
    for (const [extra, why] of [
      [[], 'QA_EXPOSURE defaults to tailscale because QA_PUBLIC_HOST=w.ts.net is not loopback'],
      [['QA_EXPOSURE=tailscale'], 'QA_EXPOSURE=tailscale is set'],
    ]) {
      // checked before the allowlist, so the hint names QA_EXPOSURE=none too
      for (const lines of [REQUIRED, withoutLogins(REQUIRED)]) {
        assert.throws(() => loadConfig(envFile([...lines, `QA_BIND_HOST=${host}`, ...extra])), err => {
          assert.ok(err.message.startsWith(`${why}, so ${BIND_RULE} (got ${JSON.stringify(host)} in `), err.message)
          assert.ok(err.message.endsWith(`; use 127.0.0.1, ::1 or localhost)${NONE_HINT}`), err.message)
          return true
        }, `${host} ${extra}`)
      }
    }
  }
  // a bracketed literal is judged unwrapped, as listen() would take it
  assert.throws(() => loadConfig(envFile([...REQUIRED, 'QA_BIND_HOST=[::]'])), err => err.message.includes(`${BIND_RULE} (got "::" in `))
  // 0.2 accepted this; none mode still does, behind another front door
  const c = loadConfig(envFile([...REQUIRED, 'QA_BIND_HOST=0.0.0.0', 'QA_EXPOSURE=none']))
  assert.deepEqual([c.host, c.exposure], ['0.0.0.0', 'none'])
})

test('tailscale mode with no QA_ALLOWED_LOGINS throws, naming the reason, tailscale whois and QA_EXPOSURE=none', () => {
  const message = (file, reason) =>
    `QA_ALLOWED_LOGINS is empty in ${file} and QA_EXPOSURE is tailscale (${reason}): the harness and both panes would refuse everyone. ` +
    'Set it to the comma-separated Tailscale logins allowed in (to find one, run `tailscale whois <device tailnet ip>`), ' +
    'or set QA_EXPOSURE=none if another front door authenticates.'
  for (const [lines, reason] of [
    [withoutLogins(REQUIRED), 'QA_PUBLIC_HOST=w.ts.net is not loopback'],
    [[...withoutLogins(REQUIRED), 'QA_ALLOWED_LOGINS= , ,'], 'QA_PUBLIC_HOST=w.ts.net is not loopback'],
    [[...withoutLogins(LOOPBACK), 'QA_EXPOSURE=tailscale'], 'set'],
    [[...withoutLogins(LOOPBACK), 'QA_PR_ORIGIN=https://h.ts.net:10000'], 'QA_PR_ORIGIN=https://h.ts.net:10000 is not loopback'],
  ]) {
    const file = envFile(lines)
    assert.throws(() => loadConfig(file), err => {
      assert.equal(err.message, message(file, reason))
      return true
    }, lines.join())
  }
  // none mode needs no allowlist
  assert.deepEqual(loadConfig(envFile(withoutLogins([...REQUIRED, 'QA_EXPOSURE=none']))).allowedLogins, [])
})

test('QA_ALLOWED_LOGINS is split, trimmed and lowercased; unset means nobody', () => {
  assert.deepEqual(loadConfig(envFile(withoutLogins(LOOPBACK))).allowedLogins, [])
  const c = loadConfig(envFile([...withoutLogins(REQUIRED), 'QA_ALLOWED_LOGINS= Alice@GitHub , ,bob@example.com']))
  assert.deepEqual(c.allowedLogins, ['alice@github', 'bob@example.com'])
})

// --- 0.3.0: the exposure reconcile interval -----------------------------------------

// 35791 minutes is the longest setInterval can wait: above 2^31-1 ms, Node
// fires every 1 ms, and the loop would run the front door's CLI back to back.
test('QA_REQUIRE_ISOLATION: 1 or true refuses a session that isn\'t isolated; unset, empty, 0 or false don\'t; anything else throws', () => {
  const load = value => loadConfig(envFile([...REQUIRED, ...(value === undefined ? [] : [`QA_REQUIRE_ISOLATION=${value}`])])).requireIsolation
  for (const value of [undefined, '', '0', 'false']) assert.equal(load(value), false, String(value))
  for (const value of ['1', 'true', 'TRUE']) assert.equal(load(value), true, value)
  for (const value of ['yes', '2', 'on']) {
    const file = envFile([...REQUIRED, `QA_REQUIRE_ISOLATION=${value}`])
    assert.throws(() => loadConfig(file), err => {
      assert.equal(err.message, `QA_REQUIRE_ISOLATION must be 1 or 0 (true or false), got ${JSON.stringify(value)} in ${file}`)
      return true
    }, value)
  }
})

test('QA_EXPOSURE_INTERVAL_MINUTES: default 5; 35791 and 0.5 are accepted; 0, -1, abc and 35792 throw', () => {
  const minutes = (...lines) => loadConfig(envFile([...REQUIRED, ...lines])).exposureIntervalMinutes
  assert.equal(minutes(), 5)
  assert.equal(minutes('QA_EXPOSURE_INTERVAL_MINUTES='), 5)
  for (const [value, want] of [['35791', 35791], ['0.5', 0.5], ['1', 1], ['60', 60]]) {
    assert.equal(minutes(`QA_EXPOSURE_INTERVAL_MINUTES=${value}`), want, value)
  }
  // in none mode too: the value is checked wherever it is set
  assert.equal(loadConfig(envFile([...LOOPBACK, 'QA_EXPOSURE_INTERVAL_MINUTES=2'])).exposureIntervalMinutes, 2)
  for (const bad of ['0', '-1', '-0', 'abc', '35792', '1e9', 'Infinity', 'NaN', '5m']) {
    const file = envFile([...REQUIRED, `QA_EXPOSURE_INTERVAL_MINUTES=${bad}`])
    assert.throws(() => loadConfig(file), err => {
      assert.equal(err.message, `QA_EXPOSURE_INTERVAL_MINUTES must be a number of minutes above 0 and at most 35791 (the longest a timer can wait), got ${JSON.stringify(bad)} in ${file}`)
      return true
    }, bad)
  }
})
