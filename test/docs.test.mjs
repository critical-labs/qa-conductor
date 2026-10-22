// The README is the published package's reference: an npm consumer reads it,
// not the source. So every entry point package.json exports, the bin, and
// every env file key the published code reads must be in it, and the names
// it says an entry point exports must be exactly the ones it does: a name it
// leaves out would read as internal, and a later release could drop it. What
// a consumer copies from it must work: its examples' imports, its sample
// .env.qa files and its links.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../lib/config.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8')

// The lines of the README section under this heading, up to the next heading
// of the same or a higher level. A # line in a code block, such as a
// comment in a sample .env.qa, is no heading.
function section(heading) {
  const lines = README.split('\n')
  const at = lines.indexOf(heading)
  assert.ok(at >= 0, `the README has a "${heading}" heading`)
  const level = heading.indexOf(' ')
  let fenced = false
  const end = lines.findIndex((line, i) => {
    if (/^ *```/.test(line)) fenced = !fenced
    return i > at && !fenced && /^#+ /.test(line) && line.indexOf(' ') <= level
  })
  return lines.slice(at + 1, end === -1 ? undefined : end)
}

// A table row's cells, without the outer pipes.
const cells = row => row.replace(/^\|/, '').replace(/\|$/, '').split(' | ').map(cell => cell.trim())
const codeSpans = text => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1])

// Every file the package publishes from a files entry, recursively.
function published(dir = '') {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(dir, entry.name)
    return entry.isDirectory() ? published(rel) : [rel]
  })
}

test('the README\'s entry points are exactly package.json\'s exports and bin, and each row lists exactly the names its entry point exports', async () => {
  const lines = section('### Entry points')
  const rows = lines.filter(line => line.startsWith(`| \`${pkg.name}`))
  const documented = new Map(rows.map(row => {
    const [entry, names] = cells(row)
    return [`.${codeSpans(entry)[0].slice(pkg.name.length)}`, codeSpans(names)]
  }))
  assert.deepEqual([...documented.keys()].sort(), Object.keys(pkg.exports).sort(), 'one row per export, and no other')
  for (const [subpath, names] of documented) {
    if (subpath === './package.json') continue
    // By the package's own name, so the exports map is what resolves it.
    const mod = await import(`${pkg.name}${subpath.slice(1)}`)
    assert.deepEqual([...names].sort(), Object.keys(mod).sort(), `the ${subpath} row lists every name it exports, and no other`)
  }
  for (const bin of Object.keys(pkg.bin)) {
    assert.ok(lines.some(line => line.includes(`\`${bin}\``)), `the bin ${bin} is listed with the entry points`)
  }
})

test('every env file key the published code reads has a Configuration row', () => {
  const rows = section('## Configuration').filter(line => line.startsWith('| `'))
  const documented = new Set(rows.flatMap(row => codeSpans(cells(row)[0])))
  const read = new Set()
  for (const dir of pkg.files) {
    for (const file of published(dir)) {
      for (const [key] of readFileSync(path.join(ROOT, file), 'utf8').matchAll(/\b(?:QA_[A-Z0-9_]+|GITHUB_QA_TOKEN)\b/g)) read.add(key)
    }
  }
  // QA_ENV_FILE is the process environment's, and names the env file itself.
  read.delete('QA_ENV_FILE')
  for (const key of ['QA_HARNESS_ORIGIN', 'QA_EXPOSURE', 'QA_TAILSCALE_BIN']) assert.ok(read.has(key), `the scan finds ${key}`)
  for (const key of [...read].sort()) assert.ok(documented.has(key), `${key} has a row in the Configuration table`)
})

// Fenced code blocks of this language in a markdown text, list items' too,
// without their indent.
const codeBlocks = (text, lang) =>
  [...text.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)^\\1\`\`\`$`, 'gm'))]
    .map(([, indent, body]) => body.split('\n').map(line => line.slice(indent.length)).join('\n'))

test('every import in the README\'s examples names something its entry point exports', async () => {
  let checked = 0
  for (const block of codeBlocks(README, 'js')) {
    for (const [, names, specifier] of block.matchAll(/^import \{([^}]+)\} from '(@critical-labs\/qa-conductor[^']*)'/gm)) {
      const mod = await import(specifier)
      for (const name of names.split(',').map(entry => entry.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        assert.ok(Object.hasOwn(mod, name), `${specifier} exports ${name}`)
        checked++
      }
    }
  }
  assert.ok(checked >= 10, `checked ${checked} imported names`)
})

// A consumer starts from these: each must load, the local one with no
// identity gate and the tailnet one behind it.
test('the README\'s sample .env.qa files load: the local one ungated, the tailnet one gated', () => {
  const samples = codeBlocks(section('### Sample `.env.qa` files').join('\n'), 'ini')
  assert.equal(samples.length, 2, 'a local sample and a tailnet sample')
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-readme-'))
  const [local, tailnet] = samples.map((text, i) => {
    const file = path.join(dir, `.env.qa-${i}`)
    writeFileSync(file, text)
    return loadConfig(file)
  })
  assert.equal(local.exposure, 'none')
  assert.equal(local.host, '127.0.0.1')
  assert.equal(local.harnessOrigin, 'http://127.0.0.1:3100')
  assert.deepEqual(local.paneOrigins, { base: 'http://127.0.0.1:3101', pr: 'http://127.0.0.1:3102' })
  assert.equal(tailnet.exposure, 'tailscale')
  assert.equal(tailnet.host, '127.0.0.1')
  assert.equal(tailnet.harnessOrigin, 'https://qa-box.tail1234.ts.net:8444')
  assert.deepEqual(tailnet.paneOrigins, { base: 'https://qa-box.tail1234.ts.net:8443', pr: 'https://qa-box.tail1234.ts.net:10000' })
  assert.ok(tailnet.allowedLogins.length > 0, 'the tailnet sample lets someone in')
})

// The anchors GitHub gives a markdown text's headings: lowercased, without
// punctuation other than - and _, spaces as -, and -1, -2... on a repeat.
function anchors(text) {
  const out = new Set()
  const seen = new Map()
  for (const [, heading] of withoutCode(text).matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-')
    const n = seen.get(slug) ?? 0
    seen.set(slug, n + 1)
    out.add(n ? `${slug}-${n}` : slug)
  }
  return out
}

// A markdown text without its fenced code blocks.
const withoutCode = text => text.replace(/^( *)```[^\n]*\n[\s\S]*?^\1```$/gm, '')

test('every relative link in the README, CHANGELOG, CONTRIBUTING.md and SECURITY.md reaches a file, and every anchor a heading', () => {
  let checked = 0
  for (const doc of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    assert.ok(existsSync(path.join(ROOT, doc)), `${doc} exists`)
    const prose = withoutCode(readFileSync(path.join(ROOT, doc), 'utf8')).replace(/`[^`\n]*`/g, '')
    for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z+.-]*:/i.test(target)) continue // https:, mailto:
      const [file, anchor] = target.split('#')
      const linked = file ? path.join(path.dirname(doc), file) : doc
      assert.ok(existsSync(path.join(ROOT, linked)), `${doc} links to ${linked}, which exists`)
      if (anchor !== undefined) {
        assert.ok(anchors(readFileSync(path.join(ROOT, linked), 'utf8')).has(anchor), `${doc} links to #${anchor}, a heading in ${linked}`)
      }
      checked++
    }
  }
  assert.ok(checked >= 20, `checked ${checked} links`)
  // The README points at the other two, so the npm page leads to them.
  assert.match(README, /\]\(CONTRIBUTING\.md\)/)
  assert.match(README, /\]\(SECURITY\.md\)/)
})

test('the README\'s Contents link every second-level heading after it, in order', () => {
  const headings = [...withoutCode(README).matchAll(/^## (.+)$/gm)].map(match => match[1])
  assert.equal(headings[0], 'Contents')
  const linked = [...section('## Contents').join('\n').matchAll(/\]\(#([^)]+)\)/g)].map(match => match[1])
  const want = headings.slice(1).map(heading => [...anchors(`## ${heading}`)][0])
  assert.deepEqual(linked.filter(anchor => want.includes(anchor)), want)
})

// The README's sandbox-exec profile, run as written, on a Mac: each port it
// names is refused over IPv4, IPv6, localhost, IPv4-mapped IPv6 and other
// spellings of loopback, another port isn't, and a parameter left out keeps
// the profile from loading. QA_SANDBOX_ROUNDS (3 by default; CI's job asks
// for 30) repeats every try, so one pass means something. The profile's
// parameters are the ones the README's wiring passes and its check names.
// Elsewhere it is skipped, and so is it where sandbox-exec can't nest (this
// process already runs in a sandbox), unless QA_REQUIRE_SANDBOX=1 asks for
// it, as CI's macos-sandbox job does: then it fails instead.
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const REQUIRE_SANDBOX = process.env.QA_REQUIRE_SANDBOX === '1'
const runSandbox = async (args, opts = {}) => {
  const { execFile } = await import('node:child_process')
  return new Promise(resolve => execFile(SANDBOX_EXEC, args, { timeout: 15_000, ...opts }, (err, stdout, stderr) => resolve({ code: typeof err?.code === 'number' ? err.code : err ? -1 : 0, stdout, stderr })))
}
async function whyNoSandbox() {
  if (process.platform !== 'darwin') return 'not macOS'
  if (!existsSync(SANDBOX_EXEC)) return `no ${SANDBOX_EXEC}`
  // sandbox-exec can't nest: under a sandbox already, applying a profile
  // fails with exit 71
  const probe = await runSandbox(['-p', '(version 1)(allow default)', '/usr/bin/true'])
  if (probe.code === 71 && /sandbox_apply: Operation not permitted/.test(probe.stderr)) return 'sandbox-exec can\'t nest, and this process already runs in a sandbox'
  return null
}
// Decided in the test, not as the file loads: the probe can take a while,
// and a test registered late would be cut off by --test-force-exit.
test('the README\'s sandbox-exec profile shuts the ports it names, over IPv4, IPv6, localhost and IPv4-mapped IPv6, and no other; a parameter left out keeps it from loading', { timeout: 120_000 }, async (t) => {
  const noSandbox = await whyNoSandbox()
  if (noSandbox && !REQUIRE_SANDBOX) return t.skip(noSandbox)
  if (noSandbox) assert.fail(`QA_REQUIRE_SANDBOX=1, but ${noSandbox}`)
  const net = await import('node:net')
  const { rmSync } = await import('node:fs')
  const lines = section('#### A `sandbox-exec` profile for the process Provisioner (macOS)')
  const text = lines.join('\n')
  const open = lines.indexOf('```scheme')
  assert.ok(open >= 0, 'the section has a scheme block')
  const profile = lines.slice(open + 1, lines.indexOf('```', open + 1)).join('\n')
  // The profile's parameters, the wiring's and the check's: the same names
  const names = [...profile.matchAll(/\(param "([A-Z_]+)"\)/g)].map(m => m[1])
  assert.deepEqual(names, ['HARNESS', 'BASE_PROXY', 'PR_PROXY', 'BASE_APP', 'BASE_DB'])
  const conductorPorts = Object.keys(JSON.parse(/const conductorPorts = (\{[^}]*\})/.exec(text)[1].replace(/'/g, '"').replace(/(\w+):/g, '"$1":')))
  const basePorts = [...text.matchAll(/basePorts\.([A-Z_]+) =/g)].map(m => m[1])
  assert.deepEqual([...conductorPorts, ...basePorts].sort(), [...names].sort(), 'the wiring passes every parameter the profile names')
  const checked = [...text.matchAll(/-D ([A-Z_]+)=/g)].map(m => m[1])
  assert.deepEqual([...new Set(checked)].sort(), [...names].sort(), 'the check names every parameter')

  const dir = mkdtempSync(path.join(tmpdir(), 'qa-sbx-'))
  const file = path.join(dir, 'pr-pane.sb')
  writeFileSync(file, profile)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // one port on both loopback addresses: IPv4 first, then the same on ::1
  const listen = (host, port) => new Promise((resolve, reject) => {
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.end('hi') })
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
  const servers = []
  t.after(() => { for (const server of servers) server.close() })
  const both = async () => {
    for (let i = 0; i < 20; i++) {
      const v4 = await listen('127.0.0.1', 0)
      const v6 = await listen('::1', v4.address().port).catch(() => null)
      if (v6) { servers.push(v4, v6); return v4.address().port }
      v4.close()
    }
    throw new Error('no port free on both 127.0.0.1 and ::1')
  }
  const ports = {}
  for (const name of [...names, 'OTHER']) ports[name] = await both()
  const HOSTS = ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1', '::ffff:7f00:1', '127.1', '0.0.0.0']
  const tries = [...names, 'OTHER'].flatMap(name => HOSTS.map(host => [`${name} over ${host}`, host, ports[name]]))
  const rounds = Number(process.env.QA_SANDBOX_ROUNDS) || 3
  // Every try, `rounds` times, one round after another. Each outcome; for
  // one that broke the rule, what it reached (address and port), the
  // addresses Node tried in turn (localhost's fallback from ::1 to
  // 127.0.0.1, say), the round and its place in it, and what localhost
  // resolves to: CI's macOS 14 once connected over localhost to a named
  // port, so a failure says how
  const client = `
    const net = require('net')
    const [tries, rounds] = JSON.parse(process.argv[1])
    const out = {}
    const odd = []
    const one = (round, seq, [name, host, port]) => new Promise(resolve => {
      const socket = net.connect({ host, port })
      const record = outcome => {
        const want = name.startsWith('OTHER') ? 'connected' : 'EPERM'
        if (out[name] === undefined || out[name] === want) out[name] = outcome
        if (outcome !== want) odd.push({ name, round, seq, port, outcome, remote: socket.remoteAddress ? socket.remoteAddress + ':' + socket.remotePort : null, tried: socket.autoSelectFamilyAttemptedAddresses ?? null })
        socket.destroy()
        resolve()
      }
      socket.on('connect', () => record('connected'))
      socket.on('error', err => record(err.code ?? String(err)))
    })
    ;(async () => {
      for (let round = 0; round < rounds; round++) await Promise.all(tries.map((t, seq) => one(round, seq, t)))
      require('dns').lookup('localhost', { all: true }, (err, list) => console.log(JSON.stringify({ out, odd: odd.slice(0, 20), oddCount: odd.length, localhost: err ? err.code : list.map(a => a.address) })))
    })()`
  const flags = names.flatMap(name => ['-D', `${name}=${ports[name]}`])
  const got = await runSandbox([...flags, '-f', file, process.execPath, '-e', client, JSON.stringify([tries, rounds])], { timeout: 90_000 })
  assert.equal(got.code, 0, got.stderr)
  const { out, odd, oddCount, localhost } = JSON.parse(got.stdout)
  assert.deepEqual(out, Object.fromEntries(tries.map(([name]) => [name, name.startsWith('OTHER') ? 'connected' : 'EPERM'])), JSON.stringify({ rounds, oddCount, odd, localhost, ports }))
  assert.equal(oddCount, 0, JSON.stringify({ rounds, odd, localhost, ports }))
  // another of the host's addresses, not loopback: a named port is refused
  // there too, before any connect, so it needs no listener. (An unnamed
  // port there isn't tried: with nothing listening, a firewall may hold
  // the connect.)
  const { networkInterfaces } = await import('node:os')
  const own = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)
  if (own) {
    const away = names.map(name => [`${name} at ${own.address}`, own.address, ports[name]])
    const there = await runSandbox([...flags, '-f', file, process.execPath, '-e', client, JSON.stringify([away, 1])])
    assert.equal(there.code, 0, there.stderr)
    assert.deepEqual(JSON.parse(there.stdout).out, Object.fromEntries(away.map(([name]) => [name, 'EPERM'])))
  } else t.diagnostic('this host has no address but loopback: the profile\'s other-address case is untried')
  // a parameter left out: the profile doesn't load, and nothing runs
  const missing = await runSandbox([...flags.slice(0, -2), '-f', file, '/usr/bin/true'])
  assert.equal(missing.code, 65, missing.stderr)
  assert.match(missing.stderr, /string-append/)
})
