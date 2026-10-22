// The PR pane's forwarder (lib/forwarder.mjs, #32): the inbound forward to
// the PR app, and the egress proxy that lets the PR pane out only to hosts on
// its allowlist, at public addresses. Run here on loopback, with the DNS
// lookup and the outgoing connection faked: a public address the check
// passes is then routed to a local server, so nothing leaves this machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { EventEmitter, once } from 'node:events'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { blockedAddress, checkTarget, createForwarder, idleTimer, parseAllowlist } from '../lib/forwarder.mjs'

const SOURCE = fileURLToPath(new URL('../lib/forwarder.mjs', import.meta.url))
// What a test on sockets or a child may take before it fails, rather than
// hang the run: a broken forwarder can leave a connection, or a child, open.
const BOUNDED = { timeout: 10_000 }

test('blockedAddress: only public addresses pass; every address a runtime gives the host is refused', () => {
  // just outside the CGNAT block (100.64.0.0/10) on either side: public
  for (const ip of ['100.63.255.254', '100.128.0.1', '8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '[2606:4700::1111]']) {
    assert.equal(blockedAddress(ip), null, ip)
  }
  const refused = [
    ['127.0.0.1', 'loopback'], ['127.255.0.9', 'loopback'], ['::1', 'unspecified, loopback or IPv4-compatible'], ['::', 'unspecified, loopback or IPv4-compatible'],
    ['10.1.2.3', 'private'], ['172.17.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.65.254', 'private'], ['192.168.127.254', 'private'],
    ['169.254.169.254', 'link-local (cloud metadata)'], ['100.64.0.1', 'shared (CGNAT, Tailscale)'],
    ['0.0.0.0', 'unspecified'], ['224.0.0.1', 'multicast'], ['255.255.255.255', 'reserved'], ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'benchmarking'], ['fd00:20::3', 'unique local'], ['fe80::1', 'link-local'], ['fe80::1%eth0', 'link-local'],
    ['ff02::1', 'multicast'], ['2001:db8::1', 'documentation'], ['64:ff9b::7f00:1', 'NAT64'], ['2002:7f00:1::', '6to4'],
    ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::ffff:169.254.169.254', 'link-local (cloud metadata)'],
    ['::ffff:192.168.65.254', 'private'], ['0:0:0:0:0:ffff:10.0.0.1', 'private'], ['::127.0.0.1', 'unspecified, loopback or IPv4-compatible'],
    ['3fff::1', 'documentation'], ['4000::1', 'not global unicast'], ['host.docker.internal', 'not an IP address'], ['1.2.3', 'not an IP address'], [undefined, 'not an IP address'],
  ]
  for (const [ip, kind] of refused) assert.equal(blockedAddress(ip), kind, String(ip))
})

test('parseAllowlist: host names, *.domains and public addresses, each with an optional port; anything else throws', () => {
  assert.deepEqual(parseAllowlist(undefined), [])
  const parsed = parseAllowlist(['API.Example.com.', '*.example.net:8443', '93.184.216.34', '[2606:4700::1111]:443'])
  // the ports' counts first, so a wrong default fails fast rather than in a huge diff
  assert.deepEqual(parsed.map(r => r.ports.length), [2, 1, 2, 1])
  assert.deepEqual(parsed, [
    { host: 'api.example.com', wildcard: false, ports: [80, 443] },
    { host: 'example.net', wildcard: true, ports: [8443] },
    { host: '93.184.216.34', wildcard: false, ports: [80, 443] },
    { host: '2606:4700::1111', wildcard: false, ports: [443] },
  ])
  for (const [bad, re] of [
    ['api.example.com', /must be an array/],
    [[7], /egress\[0\] must be a string/],
    [['*'], /must be a host name/],
    [['*.com'], /must be a host name/],
    [['localhost'], /must be a host name/],
    [['exa mple.com'], /must be a host name/],
    [['example.com:0'], /bad port/],
    [['example.com:99999'], /bad port/],
    [['example.com:http'], /bad port/],
    [['http://example.com'], /bad port|must be a host name/],
    [['example.com/path'], /must be a host name/],
    [['user@example.com'], /must be a host name/],
    [['127.0.0.1'], /127\.0\.0\.1 is loopback, which is always refused/],
    [['192.168.65.254:3100'], /is private, which is always refused/],
    [['*.10.0.0.1'], /takes no wildcard|must be a host name/],
    [['1.2.3.4.5'], /must be a host name/],
  ]) assert.throws(() => parseAllowlist(bad), re, JSON.stringify(bad))
})

const lookupOf = table => async host => {
  if (!Object.hasOwn(table, host)) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' })
  return table[host].map(address => ({ address, family: net.isIP(address) }))
}

test('checkTarget: a listed host at public addresses only, on a listed port; it names the address it checked', async () => {
  const rules = parseAllowlist(['api.example.com', '*.example.net', 'hooks.example.org:8443', '93.184.216.34'])
  const lookup = lookupOf({
    'api.example.com': ['93.184.216.34', '2606:4700::1111'],
    'a.example.net': ['1.1.1.1'],
    'b.example.net': ['1.1.1.1', '10.0.0.5'], // one private answer refuses all
    'hooks.example.org': ['8.8.8.8'],
    'rebound.example.net': ['127.0.0.1'],
  })
  const cases = [
    [['api.example.com', 443], { address: '93.184.216.34' }],
    [['API.EXAMPLE.COM.', 80], { address: '93.184.216.34' }],
    [['a.example.net', 443], { address: '1.1.1.1' }],
    [['hooks.example.org', 8443], { address: '8.8.8.8' }],
    [['93.184.216.34', 443], { address: '93.184.216.34' }],
    [['api.example.com', 22], { refused: 'api.example.com:22 is not on the allowlist' }],
    [['hooks.example.org', 443], { refused: 'hooks.example.org:443 is not on the allowlist' }],
    [['example.net', 443], { refused: 'example.net:443 is not on the allowlist' }],
    [['evil.example', 443], { refused: 'evil.example:443 is not on the allowlist' }],
    [['b.example.net', 443], { refused: 'b.example.net resolves to 10.0.0.5, which is private' }],
    [['rebound.example.net', 443], { refused: 'rebound.example.net resolves to 127.0.0.1, which is loopback' }],
    [['c.example.net', 443], { refused: 'c.example.net does not resolve (ENOTFOUND)' }],
    [['127.0.0.1', 3100], { refused: '127.0.0.1 is loopback' }],
    [['host.docker.internal', 3100], { refused: 'host.docker.internal:3100 is not on the allowlist' }],
    [['192.168.65.254', 443], { refused: '192.168.65.254 is private' }],
    [['169.254.169.254', 80], { refused: '169.254.169.254 is link-local (cloud metadata)' }],
    [['[::1]', 443], { refused: '::1 is unspecified, loopback or IPv4-compatible' }],
    [['8.8.8.8', 443], { refused: '8.8.8.8:443 is not on the allowlist' }],
    [['api.example.com', NaN], { refused: 'no valid port' }],
    [['', 443], { refused: 'not a host name' }],
  ]
  for (const [[host, port], want] of cases) assert.deepEqual(await checkTarget(rules, host, port, lookup), want, `${host}:${port}`)
  // the empty list lets nothing out
  assert.deepEqual(await checkTarget([], 'api.example.com', 443, lookup), { refused: 'api.example.com:443 is not on the allowlist' })
  assert.deepEqual(await checkTarget(rules, 'api.example.com', 443, async () => []), { refused: 'api.example.com does not resolve' })
})

// --- On loopback --------------------------------------------------------------------

async function listening(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

const free = async () => { const s = net.createServer(); const p = await listening(s); s.close(); return p }

// A forwarder whose outgoing connections go to loopback: port 80 to an HTTP
// app that says what it got, anything else to an echo server, unless
// `connect` says otherwise. It records the address each was meant for.
// Everything closes with the test, even one that timed out (t.after).
async function world(t, { allow = [], lookup = lookupOf({ 'api.example.com': ['93.184.216.34'] }), connect = null, timeouts, app: appHandler = null } = {}) {
  // a reset from the forwarder is expected of some tests
  const echo = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket) })
  const app = http.createServer(appHandler ?? ((req, res) => res.end(JSON.stringify({ url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] ?? null, conn: req.headers['proxy-connection'] ?? null, headers: req.headers }))))
  const [echoPort, appPort] = [await listening(echo), await listening(app)]
  const connects = []
  const logged = []
  const [forwardPort, proxyPort] = [await free(), await free()]
  const fwd = await createForwarder({
    host: '127.0.0.1',
    forward: { listen: forwardPort, to: `127.0.0.1:${appPort}` },
    proxy: { listen: proxyPort, allow },
    timeouts,
  }, {
    lookup,
    connect: (port, address) => { connects.push([address, port]); return connect ? connect(port, address, { appPort, echoPort }) : net.connect({ port: port === 80 ? appPort : echoPort, host: '127.0.0.1' }) },
    log: line => logged.push(line),
  })
  const close = async () => { await fwd.close(); echo.close(); app.closeAllConnections?.(); app.close() }
  t?.after(close)
  return { forwardPort, proxyPort, appPort, echoPort, connects, logged, fwd, close, appServer: app }
}

// A raw CONNECT: the status line, and the socket once it answered.
function connectVia(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    let buf = ''
    socket.on('data', function first(chunk) {
      buf += chunk.toString()
      if (!buf.includes('\r\n\r\n')) return
      socket.off('data', first)
      resolve({ status: Number(buf.split(' ')[1]), head: buf, socket })
    })
    socket.on('error', reject)
  })
}

test('the inbound forward pipes each connection to the PR app', BOUNDED, async (t) => {
  const w = await world(t)
  try {
    const res = await fetch(`http://127.0.0.1:${w.forwardPort}/api/health?x=1`)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(await res.text()).url, '/api/health?x=1')
  } finally { await w.close() }
})

test('CONNECT goes through to a listed host at the address checked, and nowhere else; refusals say why and are logged', BOUNDED, async (t) => {
  const w = await world(t, { allow: ['api.example.com'] })
  try {
    const ok = await connectVia(w.proxyPort, 'api.example.com:443')
    assert.equal(ok.status, 200)
    ok.socket.write('ping')
    const [echoed] = await once(ok.socket, 'data')
    assert.equal(echoed.toString(), 'ping')
    ok.socket.destroy()
    assert.deepEqual(w.connects, [['93.184.216.34', 443]])
    for (const target of ['evil.example:443', 'host.docker.internal:3100', '127.0.0.1:3100', '192.168.65.254:3100', '[::1]:3100', '169.254.169.254:80', 'api.example.com:22']) {
      const no = await connectVia(w.proxyPort, target)
      assert.equal(no.status, 403, target)
      assert.match(no.head, /X-QA-Egress: refused/, target)
      no.socket.destroy()
    }
    assert.equal(w.connects.length, 1, 'no refused target was connected to')
    assert.equal(w.logged.length, 7)
    assert.match(w.logged[0], /^qa-egress refused evil\.example:443: evil\.example:443 is not on the allowlist$/)
  } finally { await w.close() }
})

test('plain http goes through for a listed host, without the proxy\'s own headers; anything but an absolute http:// request is refused', BOUNDED, async (t) => {
  const w = await world(t, { allow: ['api.example.com'] })
  try {
    const via = (path, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: w.proxyPort, path, headers: { host: 'api.example.com', ...headers } }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })
    const ok = await via('http://api.example.com/v1/things?a=1', { 'proxy-authorization': 'Basic c2VjcmV0', 'proxy-connection': 'keep-alive' })
    assert.equal(ok.status, 200)
    const got = JSON.parse(ok.body)
    assert.deepEqual([got.url, got.host, got.auth, got.conn], ['/v1/things?a=1', 'api.example.com', null, null])
    assert.deepEqual(w.connects, [['93.184.216.34', 80]])
    for (const [path, status] of [['http://evil.example/', 403], ['http://127.0.0.1:3100/qa/api/state', 403], ['/qa/api/state', 400], ['https://api.example.com/', 400]]) {
      const no = await via(path)
      assert.equal(no.status, status, path)
      assert.equal(no.headers['x-qa-egress'], 'refused', path)
    }
    assert.equal(w.connects.length, 1)
  } finally { await w.close() }
})

test('a host that a second DNS answer would turn private is connected to at the address checked', BOUNDED, async (t) => {
  let answers = 0
  const flipping = async () => (answers++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }])
  const w = await world(t, { allow: ['api.example.com'], lookup: flipping })
  try {
    const ok = await connectVia(w.proxyPort, 'api.example.com:443')
    assert.equal(ok.status, 200)
    ok.socket.destroy()
    assert.deepEqual([answers, w.connects], [1, [['93.184.216.34', 443]]])
  } finally { await w.close() }
})

// A child's exit code, or a failure once `ms` pass; the child is killed then.
function exited(child, ms = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the child did not exit within ${ms} ms`)) }, ms)
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
}

// As the container runs it: the file as given to node -e, its config in
// PANE_FORWARDER. A bad config exits 1, so the Provisioner finds no forwarder.
// Every line goes to stdout, a refusal's too: triage's tail (`docker logs`
// through logsTail) reads stdout only.
test('run as the container runs it: ready from its config, its refusals and a bad config\'s error on stdout, and a bad config exits 1', BOUNDED, async () => {
  const source = readFileSync(SOURCE, 'utf8')
  const run = env => spawn(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const app = http.createServer((req, res) => res.end('pr app'))
  const appPort = await listening(app)
  const [port, proxyPort] = [await free(), await free()]
  const child = run({ PANE_FORWARDER: JSON.stringify({ host: '127.0.0.1', forward: { listen: port, to: `127.0.0.1:${appPort}` }, proxy: { listen: proxyPort, allow: [] } }) })
  try {
    let out = ''
    let err = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    for (let i = 0; i < 200 && !out.includes('qa-forwarder ready'); i++) await new Promise(r => setTimeout(r, 25))
    assert.match(out, /qa-forwarder ready/)
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'pr app')
    const refused = await connectVia(proxyPort, 'evil.example:443')
    refused.socket.destroy()
    assert.equal(refused.status, 403)
    for (let i = 0; i < 200 && !out.includes('qa-egress refused'); i++) await new Promise(r => setTimeout(r, 25))
    assert.match(out, /^qa-egress refused evil\.example:443: evil\.example:443 is not on the allowlist$/m)
    assert.equal(err, '')
  } finally { child.kill(); app.close() }
  // a free port each bad config would listen on, were it taken as good
  const spare = net.createServer()
  const sparePort = await listening(spare)
  spare.close()
  for (const [env, re] of [
    [{ PANE_FORWARDER: 'not json' }, /PANE_FORWARDER is not JSON/],
    [{ PANE_FORWARDER: JSON.stringify({ host: '127.0.0.1', proxy: { listen: sparePort, allow: ['127.0.0.1'] } }) }, /127\.0\.0\.1 is loopback, which is always refused/],
    [{ PANE_FORWARDER: JSON.stringify({ host: '127.0.0.1', forward: { listen: sparePort, to: 'nowhere' } }) }, /forward needs listen/],
  ]) {
    const bad = run(env)
    let out = ''
    bad.stdout.on('data', c => { out += c })
    const code = await exited(bad)
    assert.equal(code, 1, out)
    assert.match(out, re)
  }
  // imported, as by these tests, it starts nothing
  assert.equal(process.env.PANE_FORWARDER, undefined)
})

// The conductor imports the file too (the Docker Provisioner checks the
// allowlist with it): a PANE_FORWARDER in the conductor's own env must not
// start a forwarder there. Only the file run as given to node -e runs.
test('imported, it runs nothing, even with PANE_FORWARDER set', BOUNDED, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', 'await import(process.env.FORWARDER_URL); console.log("imported")'], {
    env: { PATH: process.env.PATH, FORWARDER_URL: new URL('../lib/forwarder.mjs', import.meta.url).href, PANE_FORWARDER: JSON.stringify({ proxy: { listen: 3128, allow: ['127.0.0.1'] } }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', c => { out += c })
  child.stderr.on('data', c => { err += c })
  assert.equal(await exited(child), 0, err)
  assert.equal(out.trim(), 'imported')
  assert.doesNotMatch(err, /qa-forwarder/)
})

// --- The review of #39 ---------------------------------------------------------------

// CGNAT addresses other than the placeholder are built here, so no file
// holds one (test/hygiene.test.mjs).
const cgnat = (b, c, d) => [100, b, c, d].join('.')

const waitUntil = async (check, ms = 3_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// A request through the proxy: its status, headers and body, or a rejection
// when the answer is cut.
function viaProxy(proxyPort, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('error', reject)
      res.on('aborted', () => reject(new Error('aborted')))
      res.on('end', () => (res.complete ? resolve({ status: res.statusCode, headers: res.headers, body }) : reject(new Error('aborted'))))
    })
    req.on('error', reject)
    req.end()
  })
}

// From the review's extra tests: each kills a mutant that would open egress.
test('an exact host is no suffix, every DNS answer is checked, a wildcard keeps its port, and ranges hold at their far edges', async () => {
  const rules = parseAllowlist(['api.example.com', '*.example.net'])
  const lookup = lookupOf({ 'evilapi.example.com': ['1.1.1.1'], 'x.api.example.com': ['1.1.1.1'], 'a.example.net': ['1.1.1.1'], 'first.example.net': ['10.0.0.5', '1.1.1.1'], 'last.example.net': ['1.1.1.1', '10.0.0.5'] })
  for (const [h, p] of [['evilapi.example.com', 443], ['x.api.example.com', 443], ['a.example.net', 22], ['first.example.net', 443], ['last.example.net', 443]]) {
    assert.ok((await checkTarget(rules, h, p, lookup)).refused, `${h}:${p}`)
  }
  assert.throws(() => parseAllowlist(['example.com:65536']), /bad port/)
  for (const ip of [
    cgnat(127, 255, 255), cgnat(100, 100, 100), '0.1.2.3', '0.255.255.255', '192.0.0.170', '192.0.0.255', '192.88.99.1', '192.0.2.255', '198.51.100.7', '203.0.113.7',
    '198.19.255.255', '240.0.0.1', '255.255.255.254',
    '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:1ff:ffff::1', '1::1', '1fff:ffff::1', '4000::1', 'fe80::1', 'febf::1', 'fec0::1', 'fdff::1', '64:ff9b::1.2.3.4', '2002:808:808::1', '100::1',
  ]) {
    assert.notEqual(blockedAddress(ip), null, ip)
  }
  // just outside: public
  for (const ip of ['100.63.255.254', '100.128.0.1', '1.0.0.0', '192.0.1.1', '192.88.98.255', '198.17.255.255', '198.20.0.1', '223.255.255.254', '2001:200::1', '2000::1', '3ffe::1', '2404:6800::1']) {
    assert.equal(blockedAddress(ip), null, ip)
  }
})

// What canonical means: an entry or a target as the URL parser has it, so a
// private address in another form is still refused, and so is a name that
// only this host or its network has.
test('entries and targets are compared as the URL parser has them: hex IPv4, names only this host has, IPv6 in brackets', async () => {
  for (const [bad, re] of [
    [['0x7f.0x0.0x0.0x1'], /127\.0\.0\.1 is loopback, which is always refused/],
    [['0x7f.1'], /127\.0\.0\.1 is loopback/],
    [['foo.localhost'], /foo\.localhost is a name only this host or its network has/],
    [['*.localhost'], /localhost is a name only this host or its network has|must be a host name/],
    [['host.docker.internal'], /host\.docker\.internal is a name only this host or its network has/],
    [['metadata.google.internal'], /is a name only this host or its network has/],
    [['printer.local'], /is a name only this host or its network has/],
    [['2606:4700::1111'], /an IPv6 address goes in brackets/],
    [['2606:4700::1111:443'], /an IPv6 address goes in brackets/],
    [['[fe80::1%eth0]'], /must be a host name/],
  ]) assert.throws(() => parseAllowlist(bad), re, JSON.stringify(bad))
  assert.deepEqual(parseAllowlist(['[2606:4700:0:0:0:0:0:1111]', 'Ünïcode.example']).map(r => r.host), ['2606:4700::1111', new URL('http://Ünïcode.example/').hostname])
  const rules = parseAllowlist(['[2606:4700::1111]:443'])
  assert.deepEqual(await checkTarget(rules, '[2606:4700:0::1111]', 443, async () => []), { address: '2606:4700::1111' })
  assert.deepEqual(await checkTarget(rules, '0x7f.1', 443, async () => []), { refused: '127.0.0.1 is loopback' })
})

// The review's medium: a tunnel the idle timeout ends must end on the PR's
// side too, or each one held a connection open.
test('a CONNECT tunnel that goes idle is closed on both sides, and no connection is left', BOUNDED, async (t) => {
  const w = await world(t, { allow: ['api.example.com'], timeouts: { idleMs: 100 } })
  const proxy = w.fwd.servers[1]
  for (let i = 0; i < 3; i++) {
    const ok = await connectVia(w.proxyPort, 'api.example.com:443')
    assert.equal(ok.status, 200)
    // an idle cut is a reset, never a clean end
    let code = null
    ok.socket.on('error', err => { code = err.code })
    await new Promise(resolve => ok.socket.once('close', resolve))
    assert.equal(code, 'ECONNRESET')
  }
  await waitUntil(async () => (await new Promise(resolve => proxy.getConnections((_, n) => resolve(n)))) === 0)
  // and closed from either side: the client's end ends the upstream
  const ok = await connectVia(w.proxyPort, 'api.example.com:443')
  ok.socket.end()
  await waitUntil(async () => (await new Promise(resolve => proxy.getConnections((_, n) => resolve(n)))) === 0)
})

// An upstream's status outside 100–999 crashed the forwarder; now it is a 502.
test('a listed upstream answering with a status outside 100–999 gets a 502, and the forwarder stays up', BOUNDED, async (t) => {
  const bad = net.createServer(socket => socket.once('data', () => socket.end('HTTP/1.1 000 Nope\r\nContent-Length: 0\r\n\r\n')))
  const badPort = await listening(bad)
  t.after(() => bad.close())
  const w = await world(t, { allow: ['api.example.com'], connect: () => net.connect({ port: badPort, host: '127.0.0.1' }) })
  const res = await viaProxy(w.proxyPort, 'http://api.example.com/x')
  assert.deepEqual([res.status, res.headers['x-qa-egress']], [502, 'failed'])
  const again = await fetch(`http://127.0.0.1:${w.forwardPort}/`)
  assert.equal(again.status, 200, 'the inbound forward still answers')
})

// A socket test with the production connect and lookup: only the address
// checked is dialled.
test('with the production lookup and connect, the forwarder dials the address it checked, and only that', BOUNDED, async (t) => {
  const dnsPromises = (await import('node:dns/promises')).default
  const echo = net.createServer(socket => socket.pipe(socket))
  const echoPort = await listening(echo)
  t.after(() => echo.close())
  const looked = []
  t.mock.method(dnsPromises, 'lookup', async (host, opts) => { looked.push([host, opts]); return [{ address: '93.184.216.34', family: 4 }] })
  const realConnect = net.connect
  const dialled = []
  t.mock.method(net, 'connect', (opts, ...rest) => {
    if (opts?.host === '93.184.216.34') { dialled.push([opts.host, opts.port]); return realConnect({ host: '127.0.0.1', port: echoPort }) }
    return realConnect(opts, ...rest)
  })
  const proxyPort = await free()
  const fwd = await createForwarder({ host: '127.0.0.1', proxy: { listen: proxyPort, allow: ['api.example.com'] } }, { log: () => {} })
  t.after(() => fwd.close())
  const ok = await connectVia(proxyPort, 'api.example.com:443')
  assert.equal(ok.status, 200)
  ok.socket.destroy()
  assert.deepEqual(looked, [['api.example.com', { all: true, verbatim: true }]])
  assert.deepEqual(dialled, [['93.184.216.34', 443]])
})

// The plain-HTTP path, as a proxy: the Host its target names, no
// connection-only header either way, and bounded waits.
test('plain http: the target\'s Host, no connection-only header either way, a bounded connect and idle, and a cut answer cut', BOUNDED, async (t) => {
  let seen = null
  const w = await world(t, {
    allow: ['api.example.com', 'slow.example.com', 'cut.example.com', 'never.example.com:81'],
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    timeouts: { connectMs: 150, idleMs: 150 },
    app: (req, res) => {
      seen = req.headers
      if (req.url === '/slow') { res.writeHead(200, { 'content-length': '10' }); res.write('12345'); return }
      if (req.url === '/cut') { res.writeHead(200, { 'content-length': '10' }); res.write('12345'); setTimeout(() => res.socket.destroy(), 20); return }
      res.writeHead(200, { connection: 'x-up', 'x-up': 'secret', 'keep-alive': 'timeout=99', 'proxy-authenticate': 'Basic', 'x-kept': 'yes' })
      res.end('ok')
    },
    // port 81: a connect that never completes
    connect: (port, address, { appPort }) => {
      if (port !== 81) return net.connect({ port: appPort, host: '127.0.0.1' })
      const stuck = new net.Socket()
      stuck.connecting = true
      return stuck
    },
  })
  const ok = await viaProxy(w.proxyPort, 'http://api.example.com/x', { host: 'evil.example', connection: 'x-custom, keep-alive', 'x-custom': 'drop me', te: 'trailers', 'proxy-authorization': 'Basic x', 'x-end': 'kept' })
  assert.equal(ok.status, 200)
  assert.equal(seen.host, 'api.example.com')
  for (const name of ['x-custom', 'te', 'proxy-authorization']) assert.equal(seen[name], undefined, name)
  assert.equal(seen['x-end'], 'kept')
  for (const name of ['x-up', 'proxy-authenticate']) assert.equal(ok.headers[name], undefined, name)
  assert.notEqual(ok.headers['keep-alive'], 'timeout=99', 'the upstream\'s own, not passed on (the proxy may send its own)')
  assert.equal(ok.headers['x-kept'], 'yes')
  // a connect that never completes
  const never = await viaProxy(w.proxyPort, 'http://never.example.com:81/')
  assert.deepEqual([never.status, never.headers['x-qa-egress']], [502, 'failed'])
  // an answer that stops coming, and one cut partway: the client's ends too
  for (const path of ['/slow', '/cut']) {
    const host = path === '/slow' ? 'slow' : 'cut'
    await assert.rejects(viaProxy(w.proxyPort, `http://${host}.example.com${path}`), /aborted|socket hang up|ECONNRESET/, path)
  }
})

// CONNECT: bytes sent with the request reach the host; a failure before the
// 200 is a 502 `failed`; after it, the tunnel just ends.
test('CONNECT: the bytes sent with it go through, a failure before the 200 is a 502 failed, and after it only ends the tunnel', BOUNDED, async (t) => {
  let upstreamOf = null
  const w = await world(t, {
    allow: ['api.example.com', 'down.example.com'],
    lookup: async host => [{ address: host === 'down.example.com' ? '93.184.216.35' : '93.184.216.34', family: 4 }],
    connect: (port, address, { echoPort }) => {
      if (address === '93.184.216.35') return net.connect({ port: 1, host: '127.0.0.1' }) // nothing listens there
      const socket = net.connect({ port: echoPort, host: '127.0.0.1' })
      upstreamOf = socket
      return socket
    },
  })
  const withHead = await new Promise((resolve, reject) => {
    const socket = net.connect(w.proxyPort, '127.0.0.1', () => socket.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\nhello'))
    let buf = ''
    socket.on('data', chunk => { buf += chunk; if (buf.includes('hello')) resolve({ buf, socket }) })
    socket.on('error', reject)
  })
  assert.match(withHead.buf, /^HTTP\/1\.1 200 Connection Established\r\n\r\nhello$/)
  // the host goes away after the 200: no 502 written into the tunnel
  let after = ''
  withHead.socket.on('data', c => { after += c })
  upstreamOf.destroy(new Error('gone'))
  let code = null
  withHead.socket.on('error', err => { code = err.code })
  await new Promise(resolve => withHead.socket.once('close', resolve))
  assert.deepEqual([after, code], ['', 'ECONNRESET'], 'no 502 written into the tunnel: a reset')
  const down = await connectVia(w.proxyPort, 'down.example.com:443')
  assert.equal(down.status, 502)
  assert.match(down.head, /X-QA-Egress: failed/)
  down.socket.destroy()
})

// The inbound forward: a client that ends its side still gets the answer;
// an app that's down closes the client; close() ends what is open.
test('the inbound forward: a half-closed client still gets its answer, an app that is down closes it, and close() ends every connection', BOUNDED, async (t) => {
  const w = await world(t)
  const answer = await new Promise((resolve, reject) => {
    const socket = net.connect(w.forwardPort, '127.0.0.1', () => socket.end('GET /half HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
    let buf = ''
    socket.on('data', c => { buf += c })
    socket.on('end', () => resolve(buf))
    socket.on('error', reject)
  })
  assert.match(answer, /^HTTP\/1\.1 200/)
  assert.match(answer, /"url":"\/half"/)
  // the app down
  const downPort = await free()
  const lonely = await createForwarder({ host: '127.0.0.1', forward: { listen: await free(), to: `127.0.0.1:${downPort}` } })
  t.after(() => lonely.close())
  const port = lonely.servers[0].address().port
  const closed = await new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('close', () => resolve(true))
    socket.on('error', () => {})
  })
  assert.equal(closed, true)
  // close() with a tunnel and a forward connection open
  const w2 = await world(null, { allow: ['api.example.com'] })
  const tunnel = await connectVia(w2.proxyPort, 'api.example.com:443')
  const held = net.connect(w2.forwardPort, '127.0.0.1')
  await once(held, 'connect')
  const closing = w2.close()
  await Promise.race([closing, new Promise((_, reject) => setTimeout(() => reject(new Error('close() hung')), 2_000))])
  tunnel.socket.destroy()
  held.destroy()
})

test('a config is checked whole before anything listens: neither forward nor proxy, or a bad part, throws and listens nowhere', BOUNDED, async () => {
  for (const config of [{}, [], 'x', null, { forward: null, proxy: null }]) {
    await assert.rejects(createForwarder(config), /the config must be an object with forward, proxy or both/, JSON.stringify(config))
  }
  const port = await free()
  await assert.rejects(createForwarder({ host: '127.0.0.1', forward: { listen: port, to: '127.0.0.1:1' }, proxy: { listen: await free(), allow: ['127.0.0.1'] } }), /always refused/)
  // the forward's port was never taken
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
  probe.close()
})

test('a refusal\'s log line brackets an IPv6 host, quotes a host it can\'t read, and is bounded', BOUNDED, async (t) => {
  const w = await world(t, { allow: ['api.example.com'] })
  for (const target of ['[::1]:443', `${'a'.repeat(400)}.example:443`, 'a%zz:443']) {
    const no = await connectVia(w.proxyPort, target)
    no.socket.destroy()
  }
  assert.equal(w.logged[0], 'qa-egress refused [::1]:443: ::1 is unspecified, loopback or IPv4-compatible')
  assert.ok(w.logged[1].length <= 301, String(w.logged[1].length))
  assert.match(w.logged[2], /^qa-egress refused "a%zz":443: not a host name$/)
})

// --- Round 2 of #39's review -----------------------------------------------------------

const MiB4 = 4 * 1024 * 1024
// A server that sends `bytes` to each connection, then closes it.
async function sender(t, bytes) {
  const payload = Buffer.alloc(bytes, 0x61)
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('error', () => {})
    socket.end(payload)
  })
  const port = await listening(server)
  t.after(() => { server.close() })
  return { port }
}
// Reads a socket to its end, pausing first; resolves to the bytes read, past
// `skip` bytes of header.
function readAll(socket, { pauseMs = 500, skipHeader = false } = {}) {
  return new Promise((resolve, reject) => {
    let total = 0
    let header = skipHeader ? '' : null
    socket.pause()
    setTimeout(() => socket.resume(), pauseMs)
    socket.on('data', chunk => {
      if (header !== null) {
        header += chunk.toString('latin1')
        const end = header.indexOf('\r\n\r\n')
        if (end === -1) return
        total += Buffer.byteLength(header.slice(end + 4), 'latin1')
        header = null
        return
      }
      total += chunk.length
    })
    socket.on('end', () => resolve(total))
    socket.on('error', reject)
  })
}

// The review's medium: the upstream's close destroyed the client socket,
// dropping what was still queued for a slow reader, which then saw a clean
// end with the tail missing.
test('a slow reader gets every byte an upstream sends before it closes, through a tunnel and through the half-closed forward', { timeout: 30_000 }, async (t) => {
  const upstream = await sender(t, MiB4)
  // the tunnel
  const w = await world(t, { allow: ['api.example.com'], connect: () => net.connect({ port: upstream.port, host: '127.0.0.1' }) })
  for (let i = 0; i < 3; i++) {
    const socket = net.connect(w.proxyPort, '127.0.0.1', () => socket.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'))
    assert.equal(await readAll(socket, { skipHeader: true }), MiB4, `tunnel run ${i}`)
  }
  // the inbound forward, its client half-closed as soon as it sent
  const fwd = await createForwarder({ host: '127.0.0.1', forward: { listen: await free(), to: `127.0.0.1:${upstream.port}` } })
  t.after(() => fwd.close())
  const port = fwd.servers[0].address().port
  for (let i = 0; i < 3; i++) {
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => socket.end('GET / HTTP/1.0\r\n\r\n'))
    assert.equal(await readAll(socket), MiB4, `forward run ${i}`)
  }
})

// The review's second medium: the URL parse turned malformed entries into
// other hosts. Anything the parse would do more than normalise is refused,
// for entries and CONNECT targets alike.
test('an entry or a CONNECT target with userinfo, a path, a query, a fragment, a backslash or whitespace is refused, never rewritten', async () => {
  for (const entry of [
    'api.example.com@evil.org', '*.example.com@evil.org', '93.184.216.34@evil.org', 'evil.org\\@api.example.com', 'a.example.com@b.evil.org:8443',
    'user@example.com', 'user@', 'github.com/myorg', 'registry.npmjs.org/@myscope', 'example.com/', 'api.example.com#prod', 'api.example.com?x=1', '#', '?',
    '93.184.216.0/24', '8.8.8.8/32', 'api.example.com\t', '\tapi.example.com', 'api .example.com', 'api.example.com\\x',
  ]) {
    assert.throws(() => parseAllowlist([entry]), /must be a host name|bad port/, JSON.stringify(entry))
  }
  const rules = parseAllowlist(['api.example.com', 'evil.org'])
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  for (const host of ['user@api.example.com', 'api.example.com@evil.org', 'evil.org\\@api.example.com', 'api.example.com/x', 'api.example.com#x', 'api.example.com?x']) {
    assert.deepEqual(await checkTarget(rules, host, 443, lookup), { refused: 'not a host name' }, host)
  }
})

// Abandoned requests: a PR that goes away during the lookup, or before any
// answer, takes nothing with it to the listed host.
test('a request the PR abandons, during the lookup or before an answer, leaves no connection to the listed host', BOUNDED, async (t) => {
  // accepts and reads, never answers
  const holder = net.createServer(socket => { socket.on('error', () => {}); socket.resume() })
  const holderPort = await listening(holder)
  t.after(() => holder.close())
  const held = () => new Promise(resolve => holder.getConnections((_, n) => resolve(n)))
  const slowLookup = async () => { await new Promise(resolve => setTimeout(resolve, 150)); return [{ address: '93.184.216.34', family: 4 }] }
  const w = await world(t, { allow: ['api.example.com'], lookup: slowLookup, connect: () => net.connect({ port: holderPort, host: '127.0.0.1' }) })
  // CONNECT: the PR resets while the name is looked up
  for (let i = 0; i < 5; i++) {
    const socket = net.connect(w.proxyPort, '127.0.0.1', () => {
      socket.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n')
      setTimeout(() => socket.resetAndDestroy(), 30)
    })
    socket.on('error', () => {})
    await once(socket, 'close')
  }
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.deepEqual([w.connects.length, await held()], [0, 0], 'never dialled')
  // plain HTTP: the PR goes away before the host answers
  for (let i = 0; i < 5; i++) {
    const req = http.request({ host: '127.0.0.1', port: w.proxyPort, path: 'http://api.example.com/x' })
    req.on('error', () => {})
    req.end()
    await new Promise(resolve => setTimeout(resolve, 250)) // past the lookup: dialled, waiting
    req.destroy()
  }
  await waitUntil(async () => (await held()) === 0)
})

// Paths round 2's tests left out.
test('CONNECT: a connect that never completes is a 502 failed; a PR reset after the 200 ends the upstream', BOUNDED, async (t) => {
  const echo = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket) })
  const echoPort = await listening(echo)
  t.after(() => echo.close())
  const w = await world(t, {
    allow: ['api.example.com', 'stuck.example.com'],
    lookup: async host => [{ address: host === 'stuck.example.com' ? '93.184.216.35' : '93.184.216.34', family: 4 }],
    timeouts: { connectMs: 150 },
    connect: (port, address) => {
      if (address !== '93.184.216.35') return net.connect({ port: echoPort, host: '127.0.0.1' })
      const stuck = new net.Socket()
      stuck.connecting = true
      return stuck
    },
  })
  const stuck = await connectVia(w.proxyPort, 'stuck.example.com:443')
  assert.equal(stuck.status, 502)
  assert.match(stuck.head, /X-QA-Egress: failed/)
  stuck.socket.destroy()
  const ok = await connectVia(w.proxyPort, 'api.example.com:443')
  assert.equal(ok.status, 200)
  await waitUntil(async () => (await new Promise(resolve => echo.getConnections((_, n) => resolve(n)))) === 1)
  ok.socket.resetAndDestroy()
  await waitUntil(async () => (await new Promise(resolve => echo.getConnections((_, n) => resolve(n)))) === 0)
})

test('a forwarder whose proxy port is taken rejects, and frees the forward port it had listened on', BOUNDED, async () => {
  const busy = net.createServer()
  const busyPort = await listening(busy)
  const forwardPort = await free()
  try {
    await assert.rejects(createForwarder({ host: '127.0.0.1', forward: { listen: forwardPort, to: '127.0.0.1:1' }, proxy: { listen: busyPort, allow: [] } }), /EADDRINUSE/)
    const again = net.createServer()
    await new Promise((resolve, reject) => { again.once('error', reject); again.listen(forwardPort, '127.0.0.1', resolve) })
    again.close()
  } finally { busy.close() }
})

// The same, made certain: the client stops reading, the forwarder's socket to
// it has bytes queued past a full kernel buffer, and only then does the
// listed host close. Every queued byte must still arrive.
// open(t) → { client (paused, past any head; `pre` bytes of data already
// read), serverSide() (the forwarder's socket to the client), peer (the
// listed host's or the app's side, writable) }
async function tailAtClose(open) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const { client, serverSide, peer, pre = 0 } = await open()
  let received = pre
  let sent = 0
  // what the forwarder has handed the client's socket of the host's bytes,
  // queued ones included (bytesWritten counts those)
  const offset = serverSide().bytesWritten
  const handed = () => serverSide().bytesWritten - offset
  const send = n => { peer.write(Buffer.alloc(n, 0x62)); sent += n }
  // every byte sent so far has reached the client's socket, or `ms` passed
  const through = async (ms = 2_000) => {
    for (const end = Date.now() + ms; handed() < sent && Date.now() < end;) await sleep(2)
  }
  // fill the kernel's buffers until the forwarder has to queue
  for (let i = 0; serverSide().writableLength === 0; i++) {
    if (i > 2_000) throw new Error('the kernel buffers never filled')
    send(64 * 1024)
    await sleep(5)
  }
  // read, a little at a time, until every byte sent has been handed on and
  // nothing is queued: the kernel's buffers stay nearly full
  for (let stable = 0; stable < 3;) {
    const chunk = client.read()
    if (chunk !== null) received += chunk.length
    await sleep(10)
    stable = handed() === sent && serverSide().writableLength === 0 && peer.writableLength === 0 ? stable + 1 : 0
  }
  // then a little at a time, each step handed on before the next, until a
  // few bytes are queued: fewer than the high-water mark, so nothing holds
  // the end back
  for (let i = 0; serverSide().writableLength === 0; i++) {
    if (i > 4_000) throw new Error('nothing queued')
    send(4 * 1024)
    await through()
  }
  assert.ok(serverSide().writableLength < 16 * 1024, String(serverSide().writableLength))
  peer.end()
  await sleep(150) // the forwarder sees the end, and the close
  await new Promise((resolve, reject) => {
    client.on('data', chunk => { received += chunk.length })
    client.on('end', resolve)
    client.on('error', reject)
    client.resume()
  }).catch(() => {})
  return { sent, received }
}

test('when the listed host closes with bytes still queued for a client that isn\'t reading, every byte still arrives: tunnel and forward', { timeout: 30_000 }, async (t) => {
  // the tunnel
  let peerOf = null
  const peerServer = net.createServer({ allowHalfOpen: true }, socket => { socket.on('error', () => {}); peerOf = socket })
  const peerPort = await listening(peerServer)
  t.after(() => peerServer.close())
  const w = await world(t, { allow: ['api.example.com'], connect: () => net.connect({ port: peerPort, host: '127.0.0.1' }) })
  let tunnelSide = null
  w.fwd.servers[1].prependListener('connect', (req, socket) => { tunnelSide = socket })
  const tunnel = await tailAtClose(async () => {
    const client = net.connect(w.proxyPort, '127.0.0.1', () => client.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'))
    client.on('error', () => {})
    let head = Buffer.alloc(0)
    await new Promise(resolve => {
      const onData = chunk => {
        head = Buffer.concat([head, chunk])
        if (!head.includes('\r\n\r\n')) return
        client.off('data', onData)
        client.pause()
        resolve()
      }
      client.on('data', onData)
    })
    while (peerOf === null) await new Promise(resolve => setTimeout(resolve, 5))
    return { client, serverSide: () => tunnelSide, peer: peerOf, pre: head.length - head.indexOf('\r\n\r\n') - 4 }
  })
  assert.equal(tunnel.received, tunnel.sent, `tunnel: ${tunnel.sent - tunnel.received} bytes lost`)

  // the forward, its client half-closed
  let appOf = null
  const app = net.createServer({ allowHalfOpen: true }, socket => { socket.on('error', () => {}); appOf = socket })
  const appPort = await listening(app)
  t.after(() => app.close())
  const fwd = await createForwarder({ host: '127.0.0.1', forward: { listen: await free(), to: `127.0.0.1:${appPort}` } })
  t.after(() => fwd.close())
  let forwardSide = null
  fwd.servers[0].prependListener('connection', socket => { forwardSide = socket })
  const forward = await tailAtClose(async () => {
    const client = net.connect({ port: fwd.servers[0].address().port, host: '127.0.0.1', allowHalfOpen: true }, () => client.end('GET / HTTP/1.0\r\n\r\n'))
    client.on('error', () => {})
    client.pause()
    while (appOf === null) await new Promise(resolve => setTimeout(resolve, 5))
    return { client, serverSide: () => forwardSide, peer: appOf }
  })
  assert.equal(forward.received, forward.sent, `forward: ${forward.sent - forward.received} bytes lost`)
})

// More of the abandoned cases: a plain-HTTP client gone during the lookup
// gets nothing dialled; a PR that resets with bytes still queued for the
// host ends the upstream at once; one that closes while the upstream is
// still connecting ends it once it connects.
test('a PR gone during the lookup, a reset with bytes queued for the host, and a close before the host answered the connect each end the upstream', BOUNDED, async (t) => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  // plain HTTP, gone during a 150 ms lookup
  const slowLookup = async () => { await sleep(150); return [{ address: '93.184.216.34', family: 4 }] }
  const w = await world(t, { allow: ['api.example.com'], lookup: slowLookup })
  for (let i = 0; i < 3; i++) {
    const req = http.request({ host: '127.0.0.1', port: w.proxyPort, path: 'http://api.example.com/x' })
    req.on('error', () => {})
    req.end()
    await sleep(30)
    req.destroy()
  }
  await sleep(300)
  assert.equal(w.connects.length, 0, 'never dialled')

  // CONNECT, reset with bytes queued for a host that isn't reading
  const holder = net.createServer(socket => { socket.on('error', () => {}) }) // never reads
  const holderPort = await listening(holder)
  t.after(() => holder.close())
  let upstreamSocket = null
  const r = await world(t, { allow: ['api.example.com'], connect: () => (upstreamSocket = net.connect({ port: holderPort, host: '127.0.0.1' })) })
  const ok = await connectVia(r.proxyPort, 'api.example.com:443')
  assert.equal(ok.status, 200)
  for (let i = 0; i < 400 && upstreamSocket.writableLength === 0; i++) { ok.socket.write(Buffer.alloc(64 * 1024)); await sleep(2) }
  assert.ok(upstreamSocket.writableLength > 0, 'bytes queued for the host')
  ok.socket.resetAndDestroy()
  await waitUntil(() => upstreamSocket.destroyed, 1_000)

  // CONNECT, closed while the host's connect is still pending
  const echo = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket) })
  const echoPort = await listening(echo)
  t.after(() => echo.close())
  const late = await world(t, {
    allow: ['api.example.com'],
    connect: () => {
      const socket = new net.Socket()
      setTimeout(() => socket.connect({ port: echoPort, host: '127.0.0.1' }), 200)
      return socket
    },
  })
  const gone = net.connect(late.proxyPort, '127.0.0.1', () => gone.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'))
  gone.on('error', () => {})
  await sleep(50)
  gone.destroy()
  await sleep(400) // the host's connect has come and gone
  await waitUntil(async () => (await new Promise(resolve => echo.getConnections((_, n) => resolve(n)))) === 0, 1_000)
})

// --- Carried from #39's round 3 ----------------------------------------------------------

// Reads a socket slowly: a chunk, then `gapMs` paused; resolves to the bytes
// read past any head, at its end.
function readSlowly(socket, { gapMs = 100, skipHeader = false } = {}) {
  return new Promise((resolve, reject) => {
    let total = 0
    let header = skipHeader ? '' : null
    socket.on('data', chunk => {
      if (header !== null) {
        header += chunk.toString('latin1')
        const end = header.indexOf('\r\n\r\n')
        if (end !== -1) { total += Buffer.byteLength(header.slice(end + 4), 'latin1'); header = null }
      } else total += chunk.length
      socket.pause()
      setTimeout(() => socket.resume(), gapMs)
    })
    socket.on('end', () => resolve(total))
    socket.on('error', reject)
  })
}

// Backpressure from a slow reader is no idleness: a tunnel that keeps
// moving, however slowly, isn't cut by the idle timer. Its idle period is a
// second: the kernel's buffers can hold a steady reader's bytes out of the
// forwarder's sight for longer than 300 ms. The reader takes a chunk every
// 300 ms, slow enough that a timer which ignores backpressure (as main's
// did) cuts it, or ends it short. The timer's own rules are tested with
// stand-ins, below.
test('a slow but steady reader isn\'t cut by the idle timer: a tunnel and a plain-HTTP answer deliver every byte', { timeout: 60_000 }, async (t) => {
  const MiB2 = 2 * 1024 * 1024
  const upstream = await sender(t, MiB2)
  const w = await world(t, {
    allow: ['api.example.com'],
    timeouts: { idleMs: 1000 },
    connect: (port, address, { appPort }) => net.connect({ port: port === 80 ? appPort : upstream.port, host: '127.0.0.1' }),
    app: (req, res) => { res.writeHead(200, { 'content-length': String(MiB2) }); res.end(Buffer.alloc(MiB2, 0x63)) },
  })
  const socket = net.connect(w.proxyPort, '127.0.0.1', () => socket.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'))
  assert.equal(await readSlowly(socket, { skipHeader: true, gapMs: 300 }), MiB2, 'the tunnel')
  const plain = net.connect(w.proxyPort, '127.0.0.1', () => plain.write('GET http://api.example.com/big HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n'))
  assert.equal(await readSlowly(plain, { skipHeader: true, gapMs: 300 }), MiB2, 'the plain-HTTP answer')
})

// A reset on one side reaches the other as a reset, never a clean end: a
// close-delimited stream would read as complete.
test('a host or an app that resets mid-stream gives the PR ECONNRESET, through a tunnel and through the forward', BOUNDED, async (t) => {
  const resetter = net.createServer(socket => {
    socket.on('error', () => {})
    socket.write(Buffer.alloc(64 * 1024, 0x64), () => setTimeout(() => socket.resetAndDestroy(), 50))
  })
  const resetterPort = await listening(resetter)
  t.after(() => resetter.close())
  const errorOf = socket => new Promise(resolve => {
    socket.on('data', () => {})
    socket.on('error', err => resolve(err.code))
    socket.on('end', () => resolve('a clean end'))
  })
  const w = await world(t, { allow: ['api.example.com'], connect: () => net.connect({ port: resetterPort, host: '127.0.0.1' }) })
  const tunnel = net.connect(w.proxyPort, '127.0.0.1', () => tunnel.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'))
  assert.equal(await errorOf(tunnel), 'ECONNRESET')
  const fwd = await createForwarder({ host: '127.0.0.1', forward: { listen: await free(), to: `127.0.0.1:${resetterPort}` } })
  t.after(() => fwd.close())
  const client = net.connect(fwd.servers[0].address().port, '127.0.0.1')
  assert.equal(await errorOf(client), 'ECONNRESET')
})

// A host that closes cleanly ends the PR's side of the tunnel too, even a PR
// that keeps its own side open: the forwarder holds nothing for it. (The
// inbound forward is half-open both ways by design: an app's FIN reaches the
// client as a FIN, and the client may still send.)
test('a host that closes cleanly ends the forwarder\'s side of the tunnel, even when the PR keeps its own side open', BOUNDED, async (t) => {
  const upstream = await sender(t, 1024)
  const connections = server => new Promise(resolve => server.getConnections((_, n) => resolve(n)))
  const w = await world(t, { allow: ['api.example.com'], connect: () => net.connect({ port: upstream.port, host: '127.0.0.1' }) })
  const tunnel = net.connect({ port: w.proxyPort, host: '127.0.0.1', allowHalfOpen: true }, () => tunnel.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n'))
  tunnel.on('data', () => {})
  await once(tunnel, 'end')
  await waitUntil(async () => (await connections(w.fwd.servers[1])) === 0)
  tunnel.destroy()
})

// A PR that leaves partway through a plain-HTTP answer frees the upstream.
test('a PR that leaves partway through a plain-HTTP answer frees its upstream', BOUNDED, async (t) => {
  let appSockets = 0
  const w = await world(t, {
    allow: ['api.example.com'],
    app: (req, res) => { appSockets++; res.writeHead(200, { 'content-length': '100000' }); res.write('x'.repeat(1000)) }, // and never more
  })
  const connections = () => new Promise(resolve => w.fwd.servers[1].getConnections((_, n) => resolve(n)))
  const socket = net.connect(w.proxyPort, '127.0.0.1', () => socket.write('GET http://api.example.com/part HTTP/1.1\r\nHost: api.example.com\r\n\r\n'))
  await once(socket, 'data')
  socket.destroy()
  await waitUntil(async () => (await connections()) === 0)
  // the app's side of it is gone too
  const appConnections = () => new Promise(resolve => w.appServer.getConnections((_, n) => resolve(n)))
  await waitUntil(async () => (await appConnections()) === 0)
  assert.equal(appSockets, 1)
})

test('more entries and targets that must be refused: a bare userinfo, slashes, an escape, a newline, lookalike slashes; and forward.to with whitespace', BOUNDED, async () => {
  for (const entry of ['@evil.org', '/evil.org', '//evil.org', '\\evil.org', 'api.example.com%2e', 'api.exa\nmple.com', 'github.com⁄myorg', 'github.com∕myorg', 'github.com⧵myorg']) {
    assert.throws(() => parseAllowlist([entry]), /must be a host name/, JSON.stringify(entry))
  }
  const rules = parseAllowlist(['api.example.com'])
  assert.deepEqual(await checkTarget(rules, '@api.example.com', 443, async () => [{ address: '93.184.216.34', family: 4 }]), { refused: 'not a host name' })
  for (const to of [' 127.0.0.1:3000', '127.0.0.1:3000 ', '127.0.0.1 :3000']) {
    await assert.rejects(createForwarder({ host: '127.0.0.1', forward: { listen: await free(), to } }), /forward needs listen/, JSON.stringify(to))
  }
})

// A plain-HTTP answer cut partway through: a client whose answer is
// close-delimited (HTTP/1.0, so no chunks) would read a clean end as the
// whole answer, so it gets a reset.
test('a plain-HTTP answer cut partway reaches an HTTP/1.0 client as ECONNRESET, never a clean end', BOUNDED, async (t) => {
  const w = await world(t, {
    allow: ['api.example.com'],
    app: (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('x'.repeat(1000)); setTimeout(() => res.socket.destroy(), 50) },
  })
  const client = net.connect(w.proxyPort, '127.0.0.1', () => client.write('GET http://api.example.com/cut HTTP/1.0\r\nHost: api.example.com\r\n\r\n'))
  let got = ''
  const outcome = await new Promise(resolve => {
    client.on('data', chunk => { got += chunk })
    client.on('error', err => resolve(err.code))
    client.on('end', () => resolve('a clean end'))
  })
  assert.doesNotMatch(got, /transfer-encoding|content-length/i, 'close-delimited')
  assert.equal(outcome, 'ECONNRESET')
})

// The other way: a PR that resets its side of a tunnel reaches the host as a
// reset too, never as a clean end of what it sent.
test('a PR that resets mid-tunnel reaches the host as ECONNRESET, never a clean end', BOUNDED, async (t) => {
  let settle
  const outcome = new Promise(resolve => { settle = resolve })
  const host = net.createServer(socket => {
    socket.on('data', () => {})
    socket.on('error', err => settle(err.code))
    socket.on('end', () => settle('a clean end'))
  })
  const hostPort = await listening(host)
  t.after(() => host.close())
  const w = await world(t, { allow: ['api.example.com'], connect: () => net.connect({ port: hostPort, host: '127.0.0.1' }) })
  const ok = await connectVia(w.proxyPort, 'api.example.com:443')
  assert.equal(ok.status, 200)
  ok.socket.write('partway')
  await new Promise(resolve => setTimeout(resolve, 50))
  ok.socket.resetAndDestroy()
  assert.equal(await outcome, 'ECONNRESET')
})

// The other way: a PR uploading to a slow host is waiting on the host's
// backpressure, not idle, so its side of the tunnel isn't cut either. The
// host reads slowly for two seconds, then all it can: the upload is far more
// than the kernel's buffers hold, so the forwarder is still handing bytes
// over when the host speeds up. (Bytes already in those buffers move where
// no timer sees them: a host that reads them slower than one idle period
// can still be cut.)
test('a PR uploading to a slow but steady host isn\'t cut by the idle timer: every byte arrives', { timeout: 30_000 }, async (t) => {
  const BIG = 16 * 1024 * 1024
  let received
  const got = new Promise(resolve => { received = resolve })
  const host = net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('error', () => {})
    // one chunk every 100 ms for two seconds, then all it can
    const start = Date.now()
    let total = 0
    socket.on('data', chunk => {
      total += chunk.length
      if (total >= BIG) return received(total)
      if (Date.now() - start > 2000) return
      socket.pause()
      setTimeout(() => socket.resume(), 100)
    })
    socket.on('close', () => received(total))
  })
  const hostPort = await listening(host)
  t.after(() => host.close())
  const w = await world(t, { allow: ['api.example.com'], timeouts: { idleMs: 1000 }, connect: () => net.connect({ port: hostPort, host: '127.0.0.1' }) })
  const ok = await connectVia(w.proxyPort, 'api.example.com:443')
  assert.equal(ok.status, 200)
  ok.socket.on('error', () => {})
  ok.socket.on('data', () => {})
  ok.socket.write(Buffer.alloc(BIG, 0x75))
  assert.equal(await got, BIG)
  ok.socket.destroy()
})

// The idle timer's rules, with stand-in sockets on real timers: what moved is
// what the test says moved.
function fakeSocket() {
  const s = new EventEmitter()
  Object.assign(s, { bytesRead: 0, bytesWritten: 0, writableLength: 0, _handle: { writeQueueSize: 0 }, paused: false, writableNeedDrain: false, destroyed: false, timer: null })
  s.isPaused = () => s.paused
  s.setTimeout = ms => { clearTimeout(s.timer); s.timer = setTimeout(() => s.emit('timeout'), ms) }
  s.stop = () => { clearTimeout(s.timer); s.destroyed = true }
  return s
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function watched(ms, opts) {
  const [socket, peer] = [fakeSocket(), fakeSocket()]
  const cuts = []
  const start = Date.now()
  idleTimer(socket, peer, ms, () => { cuts.push(Date.now()); socket.stop() }, opts)
  return { socket, peer, cuts, start, stop: () => { socket.stop(); peer.stop() } }
}

test('idleTimer: a socket where nothing moves is cut once, after ms and the grace', async (t) => {
  const w = watched(100)
  t.after(w.stop)
  await sleep(450)
  assert.equal(w.cuts.length, 1)
  const at = w.cuts[0] - w.start
  assert.ok(at >= 195 && at < 400, `cut at ${at} ms`)
})

test('idleTimer: a socket waiting on a peer that moved since its last look is spared, and cut once the peer has stopped', async (t) => {
  // the peer moves once, before the first look and never in a grace
  const w = watched(200, { graceMs: 20, waiting: () => true })
  t.after(w.stop)
  await sleep(50)
  w.peer._handle.writeQueueSize -= 1000
  await sleep(700)
  assert.equal(w.cuts.length, 1, 'cut in the end: the listener outlasts the re-arm')
  const at = w.cuts[0] - w.start
  assert.ok(at >= 395 && at < 650, `spared at the first look, cut at the second: ${at} ms`)
})

test('idleTimer: a paused socket whose peer keeps moving is never cut, however many times it is re-armed', async (t) => {
  const w = watched(100, { graceMs: 20 })
  t.after(w.stop)
  w.socket.paused = true
  for (let i = 0; i < 16; i++) { await sleep(60); w.peer.bytesWritten += 1000 }
  assert.deepEqual(w.cuts, [], 'not cut while the peer moves')
  const stopped = Date.now()
  await sleep(500)
  assert.equal(w.cuts.length, 1, 'cut once the peer stopped')
  assert.ok(w.cuts[0] - stopped < 400, `within twice ms and the grace: ${w.cuts[0] - stopped} ms`)
})

test('idleTimer: each side waiting on the other, with nothing moving, is still cut', async (t) => {
  const w = watched(100, { waiting: () => true })
  t.after(w.stop)
  await sleep(500)
  assert.equal(w.cuts.length, 1)
})

test('idleTimer: a stalled event loop isn\'t idleness: I/O that was due when the timer fired, and lands in the grace, spares the socket', async (t) => {
  const w = watched(100)
  t.after(w.stop)
  await sleep(50)
  // the loop stalls past the timer's deadline, outside the timers phase as
  // a long callback would; the next turn runs the late timer first, and
  // what moved meanwhile shows only after it, as I/O does
  await new Promise(resolve => setImmediate(resolve))
  const until = Date.now() + 200
  while (Date.now() < until);
  setImmediate(() => { w.socket.bytesRead += 1000 })
  // past the grace (it ends 100 ms after the late timer), before the next look
  await sleep(160)
  assert.deepEqual(w.cuts, [], 'spared')
  await sleep(500)
  assert.equal(w.cuts.length, 1, 'and cut once nothing moves')
})

test('idleTimer: a socket gone during the grace isn\'t cut', async (t) => {
  const w = watched(100)
  t.after(w.stop)
  await sleep(150)
  w.socket.destroyed = true
  await sleep(250)
  assert.deepEqual(w.cuts, [])
})

// An idle cut resets the host's side too, not only the PR's.
test('a tunnel cut for idleness reaches the host as ECONNRESET too', BOUNDED, async (t) => {
  let settle
  const outcome = new Promise(resolve => { settle = resolve })
  const host = net.createServer(socket => {
    socket.on('data', () => {})
    socket.on('error', err => settle(err.code))
    socket.on('end', () => settle('a clean end'))
  })
  const hostPort = await listening(host)
  t.after(() => host.close())
  const w = await world(t, { allow: ['api.example.com'], timeouts: { idleMs: 100 }, connect: () => net.connect({ port: hostPort, host: '127.0.0.1' }) })
  const ok = await connectVia(w.proxyPort, 'api.example.com:443')
  assert.equal(ok.status, 200)
  ok.socket.on('error', () => {})
  assert.equal(await outcome, 'ECONNRESET')
})

// --- Round 2 of #40's review ---------------------------------------------------------

// The PR's side of a plain-HTTP answer had no timer once the host was done:
// a PR that stopped reading near the end held it for ever, at answer sizes
// where the last of it no longer fits the kernel's buffers (around 850 KB on
// loopback). A sweep of sizes there, every one let go once nothing moves.
test('a plain-HTTP answer the host has finished, to a PR that never reads, is closed once nothing moves: no connection is held', { timeout: 30_000 }, async (t) => {
  const w = await world(t, {
    allow: ['api.example.com'],
    timeouts: { idleMs: 300 },
    app: (req, res) => {
      const size = Number(req.url.split('/').at(-1))
      res.writeHead(200, { 'content-length': String(size) })
      res.end(Buffer.alloc(size, 0x62))
    },
  })
  const sizes = Array.from({ length: 24 }, (_, i) => 800_000 + i * 8_192)
  const clients = await Promise.all(sizes.map(async size => {
    const c = net.connect(w.proxyPort, '127.0.0.1')
    c.on('error', () => {})
    await once(c, 'connect')
    c.pause() // never reads
    c.write(`GET http://api.example.com/${size} HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n`)
    return c
  }))
  t.after(() => { for (const c of clients) c.destroy() })
  const connections = server => new Promise(resolve => server.getConnections((_, n) => resolve(n)))
  // every answer is done on the host's side well before the PR's is let go
  await waitUntil(async () => (await connections(w.appServer)) === 0, 10_000)
  await waitUntil(async () => (await connections(w.fwd.servers[1])) === 0, 10_000)
})

// A host that fails after the headers: a close-delimited answer (HTTP/1.0)
// would read a clean end as complete, so the PR gets a reset. Both ways it
// fails: a reset from the host, and a host that stalls past idleMs.
test('a plain-HTTP host that resets or stalls after the headers gives an HTTP/1.0 client ECONNRESET, never a clean end', BOUNDED, async (t) => {
  const w = await world(t, {
    allow: ['api.example.com'],
    timeouts: { idleMs: 300 },
    app: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('x'.repeat(1000))
      if (req.url.endsWith('/reset')) setTimeout(() => res.socket.resetAndDestroy(), 50)
      // else: never another byte
    },
  })
  for (const path of ['reset', 'stall']) {
    const client = net.connect(w.proxyPort, '127.0.0.1', () => client.write(`GET http://api.example.com/${path} HTTP/1.0\r\nHost: api.example.com\r\n\r\n`))
    let got = ''
    const outcome = await new Promise(resolve => {
      client.on('data', chunk => { got += chunk })
      client.on('error', err => resolve(err.code))
      client.on('end', () => resolve('a clean end'))
    })
    assert.match(got, /^HTTP\/1\.1 200/, path)
    assert.doesNotMatch(got, /transfer-encoding|content-length/i, `${path}: close-delimited`)
    assert.equal(outcome, 'ECONNRESET', path)
  }
})

// The inbound forward, the other way round from the app's reset: a client
// that resets partway through its request reaches the app as a reset too.
test('a client that resets mid-request through the inbound forward reaches the app as ECONNRESET, never a clean end', BOUNDED, async (t) => {
  let settle
  const outcome = new Promise(resolve => { settle = resolve })
  const app = net.createServer(socket => {
    socket.on('data', () => {})
    socket.on('error', err => settle(err.code))
    socket.on('end', () => settle('a clean end'))
  })
  const appPort = await listening(app)
  t.after(() => app.close())
  const fwd = await createForwarder({ host: '127.0.0.1', forward: { listen: await free(), to: `127.0.0.1:${appPort}` } })
  t.after(() => fwd.close())
  const client = net.connect(fwd.servers[0].address().port, '127.0.0.1')
  client.on('error', () => {})
  await once(client, 'connect')
  client.write('POST /upload HTTP/1.1\r\nHost: app\r\nContent-Length: 100000\r\n\r\n')
  client.write('y'.repeat(1000), () => setTimeout(() => client.resetAndDestroy(), 50))
  assert.equal(await outcome, 'ECONNRESET')
})

// A listed host that takes the request and never answers: after idleMs the
// PR gets a 502 `failed`, never a reset (the PR-side timer is armed only
// once the answer's headers are written).
test('a plain-HTTP host that accepts the request but never answers gets the PR a 502 failed after idleMs', BOUNDED, async (t) => {
  const silent = net.createServer(socket => { socket.on('error', () => {}); socket.on('data', () => {}) })
  const silentPort = await listening(silent)
  t.after(() => silent.close())
  const w = await world(t, { allow: ['api.example.com'], timeouts: { idleMs: 300 }, connect: () => net.connect({ port: silentPort, host: '127.0.0.1' }) })
  const out = await viaProxy(w.proxyPort, 'http://api.example.com/slow')
  assert.deepEqual([out.status, out.headers['x-qa-egress']], [502, 'failed'])
})
