// The PR pane's forwarder (lib/forwarder.mjs, #32): the inbound forward to
// the PR app, and the egress proxy that lets the PR pane out only to hosts on
// its allowlist, at public addresses. Run here on loopback, with the DNS
// lookup and the outgoing connection faked: a public address the check
// passes is then routed to a local server, so nothing leaves this machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { blockedAddress, checkTarget, createForwarder, parseAllowlist } from '../lib/forwarder.mjs'

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
  assert.deepEqual(parseAllowlist(['API.Example.com.', '*.example.net:8443', '93.184.216.34', '[2606:4700::1111]:443']), [
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
  const echo = net.createServer(socket => socket.pipe(socket))
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
  return { forwardPort, proxyPort, appPort, echoPort, connects, logged, fwd, close }
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
test('run as the container runs it: ready from its config, and a bad config exits 1', BOUNDED, async () => {
  const source = readFileSync(SOURCE, 'utf8')
  const run = env => spawn(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const app = http.createServer((req, res) => res.end('pr app'))
  const appPort = await listening(app)
  const s = net.createServer()
  const port = await listening(s)
  s.close()
  const child = run({ PANE_FORWARDER: JSON.stringify({ host: '127.0.0.1', forward: { listen: port, to: `127.0.0.1:${appPort}` }, proxy: null }) })
  try {
    let out = ''
    child.stdout.on('data', c => { out += c })
    for (let i = 0; i < 200 && !out.includes('qa-forwarder ready'); i++) await new Promise(r => setTimeout(r, 25))
    assert.match(out, /qa-forwarder ready/)
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'pr app')
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
    let err = ''
    bad.stderr.on('data', c => { err += c })
    const code = await exited(bad)
    assert.equal(code, 1, err)
    assert.match(err, re)
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
    await once(ok.socket, 'close')
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
  await once(withHead.socket, 'close')
  assert.equal(after, '')
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
