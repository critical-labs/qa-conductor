// The PR pane's forwarder (#32): the one way into, and out of, a PR pane on
// an internal network, where its containers have no route off their network.
// The Docker Provisioner runs this file, as it is, in a container that joins
// both the PR pane's internal network and an ordinary one:
// `node --input-type=module -e <this file>`, with its config as JSON in
// PANE_FORWARDER. So it imports nothing but Node's own modules.
//
// - Inbound: it listens on `forward.listen` and pipes each connection to
//   `forward.to` (the PR app), which the Provisioner publishes on the host's
//   loopback in the app's place.
// - Egress: an HTTP proxy on `proxy.listen`. HTTPS goes through CONNECT and
//   is never intercepted; plain HTTP is forwarded. A request goes out only
//   to a host on the allowlist, every address of which is public, and to the
//   address that was checked, so a second DNS answer can't swap it.
//   Loopback, private, link-local (cloud metadata), CGNAT (Tailscale),
//   unique-local, multicast and the like are always refused, listed or not:
//   among them every address a container runtime gives the host. The list is
//   empty by default: no egress at all.
// - What that guarantees is per address, not per host: inside a tunnel it
//   doesn't inspect, SNI and the Host header can name any site served from a
//   listed name's addresses. So don't list a name on a shared CDN's
//   addresses unless every site there may be reached.
//
// Exported for tests: the allowlist, the address check and createForwarder.

import net from 'node:net'
import http from 'node:http'
import dns from 'node:dns/promises'

// Without a port, an allowlist entry admits these.
const DEFAULT_PORTS = [80, 443]

// --- Addresses -------------------------------------------------------------------

const V4 = [
  ['0.0.0.0', 8, 'unspecified'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'shared (CGNAT, Tailscale)'],
  ['127.0.0.0', 8, 'loopback'], ['169.254.0.0', 16, 'link-local (cloud metadata)'], ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'special-purpose'], ['192.0.2.0', 24, 'documentation'], ['192.88.99.0', 24, 'special-purpose'],
  ['192.168.0.0', 16, 'private'], ['198.18.0.0', 15, 'benchmarking'], ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'], ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved'],
]
const V6 = [
  ['::', 96, 'unspecified, loopback or IPv4-compatible'], ['64:ff9b::', 96, 'NAT64'], ['64:ff9b:1::', 48, 'NAT64'],
  ['100::', 64, 'discard'], ['2001::', 23, 'special-purpose'], ['2001:db8::', 32, 'documentation'], ['2002::', 16, '6to4'],
  ['3fff::', 20, 'documentation'],
  ['fc00::', 7, 'unique local'], ['fe80::', 10, 'link-local'], ['fec0::', 10, 'site-local'], ['ff00::', 8, 'multicast'],
]
const ranges = (list, type) => list.map(([address, prefix, kind]) => {
  const block = new net.BlockList()
  block.addSubnet(address, prefix, type)
  return [block, kind]
})
const BLOCKED_V4 = ranges(V4, 'ipv4')
const BLOCKED_V6 = ranges(V6, 'ipv6')
const GLOBAL_V6 = ranges([['2000::', 3, 'global']], 'ipv6')[0][0]

// An IPv6 address as its eight 16-bit groups, or null.
function groups6(ip) {
  let text = ip
  // a dotted IPv4 tail as two groups
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null
    const b = dotted[2].split('.').map(Number)
    text = `${dotted[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const part = s => (s === '' ? [] : s.split(':').map(h => (/^[0-9a-f]{1,4}$/i.test(h) ? Number.parseInt(h, 16) : NaN)))
  const head = part(halves[0])
  const rest = halves.length === 2 ? part(halves[1]) : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const all = [...head, ...Array(missing).fill(0), ...rest]
  return all.every(g => Number.isInteger(g)) ? all : null
}

// Why an address must not be connected to, or null for a public one. Only
// a global unicast IPv6 address (2000::/3) can be public; an IPv4-mapped one
// is judged as its IPv4 address. The address is taken as written: callers
// canonicalize it first (canonicalHost).
export function blockedAddress(address) {
  const ip = String(address ?? '').replace(/^\[|\]$/g, '').split('%')[0]
  if (net.isIPv4(ip)) return BLOCKED_V4.find(([block]) => block.check(ip, 'ipv4'))?.[1] ?? null
  if (!net.isIPv6(ip)) return 'not an IP address'
  const g = groups6(ip)
  if (g === null) return 'not an IP address'
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return blockedAddress(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`)
  }
  const found = BLOCKED_V6.find(([block]) => block.check(ip, 'ipv6'))
  if (found) return found[1]
  return GLOBAL_V6.check(ip, 'ipv6') ? null : 'not global unicast'
}

// --- Names ------------------------------------------------------------------------

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
// At least two labels. (A name whose last label is numeric never gets here:
// canonicalHost reads it as IPv4, or refuses it.)
const isHostname = h => h.length <= 253 && h.split('.').length >= 2 && h.split('.').every(l => LABEL.test(l))
// Names that only ever name this host or a private network: never listed.
const PRIVATE_NAMES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa', 'lan', 'intranet', 'invalid', 'onion']
const isPrivateName = h => PRIVATE_NAMES.some(n => h === n || h.endsWith(`.${n}`))

// A host as compared: as the URL parser has it, so lowercase, punycode, with
// no trailing dot, an IPv4 address in any form (`0x7f.1`) as dotted decimal,
// and an IPv6 one compressed, without brackets. null when it is none, an
// IPv6 address with a zone, or anything the parse would do more than
// normalise: userinfo, a path, a query or a fragment (`a@b`, `host/path`,
// `#x`), a backslash, whitespace, an escape, or a slash that only looks like
// one (U+2044, U+2215, U+29F5). So `api.example.com@evil.org` is refused,
// never read as evil.org. A CONNECT target is never percent-decoded either:
// one with an escape is refused, though the plain-HTTP path's URL parse
// decodes its host.
const NOT_A_HOST = /[@/?#\\%\s\u2044\u2215\u29f5]/
function canonicalHost(raw) {
  let h = String(raw ?? '')
  const bracketed = /^\[([^\]]*)\]$/.exec(h)
  if (bracketed) h = bracketed[1]
  if (h === '' || NOT_A_HOST.test(h)) return null
  try {
    if (h.includes(':')) return net.isIPv6(h) ? new URL(`http://[${h}]/`).hostname.slice(1, -1) : null
    const url = new URL(`http://${h}/`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.hostname.replace(/\.$/, '') || null
  } catch {
    return null
  }
}

// `host:port` (a CONNECT target, or an entry) split, IPv6 in brackets; port
// null when there is none. `bracketed` says the host was. Nothing is trimmed:
// whitespace makes it no host.
function splitHostPort(text) {
  const s = String(text ?? '')
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (bracket) return { host: bracket[1], port: bracket[2] === undefined ? null : Number(bracket[2]), bracketed: true }
  const colon = s.lastIndexOf(':')
  if (colon !== -1 && s.indexOf(':') === colon) return { host: s.slice(0, colon), port: /^\d+$/.test(s.slice(colon + 1)) ? Number(s.slice(colon + 1)) : NaN, bracketed: false }
  return { host: s, port: null, bracketed: false }
}
const isPort = p => Number.isInteger(p) && p >= 1 && p <= 65535

// --- The allowlist ---------------------------------------------------------------

// The allowlist's entries, checked: `api.example.com` (that host only),
// `*.example.com` (any host under it, not itself), or a public IP address
// (an IPv6 one in brackets), each with an optional `:port`. Without a port,
// 80 and 443. Anything else throws, so a typo never opens more than meant: a
// private address in any form, a name only this host or its network has
// (`localhost`, `*.internal`), a bad port, a URL or anything with userinfo,
// a path, a query, a fragment or whitespace (`github.com/myorg` would
// otherwise admit all of github.com). A wildcard is as wide as written:
// `*.github.io` admits every site under it.
export function parseAllowlist(entries) {
  if (entries === undefined || entries === null) return []
  if (!Array.isArray(entries)) throw new Error('the egress allowlist must be an array of hosts')
  return entries.map((entry, i) => {
    if (typeof entry !== 'string') throw new Error(`egress[${i}] must be a string`)
    const { host: raw, port, bracketed } = splitHostPort(entry)
    if (port !== null && !isPort(port)) throw new Error(`egress[${i}] has a bad port: ${JSON.stringify(entry)}`)
    const wildcard = raw.startsWith('*.')
    const given = wildcard ? raw.slice(2) : raw
    if (given.includes(':') && !bracketed) throw new Error(`egress[${i}]: an IPv6 address goes in brackets: ${JSON.stringify(entry)}`)
    const name = canonicalHost(given)
    if (name !== null && net.isIP(name)) {
      if (wildcard) throw new Error(`egress[${i}]: an IP address takes no wildcard: ${JSON.stringify(entry)}`)
      const blocked = blockedAddress(name)
      if (blocked) throw new Error(`egress[${i}]: ${name} is ${blocked}, which is always refused`)
    } else if (name === null || !isHostname(name)) {
      throw new Error(`egress[${i}] must be a host name, *.domain or a public IP address, with an optional :port: ${JSON.stringify(entry)}`)
    } else if (isPrivateName(name)) {
      throw new Error(`egress[${i}]: ${name} is a name only this host or its network has, which is always refused`)
    }
    return { host: name, wildcard, ports: port === null ? DEFAULT_PORTS : [port] }
  })
}

const listed = (rules, host, port) => rules.some(r => r.ports.includes(port) && (r.wildcard ? host.endsWith(`.${r.host}`) : host === r.host))

// Whether a request may go to host:port, and to which address: { address }
// or { refused: reason }. `lookup(host)` resolves to every address of host.
// The host is compared as the URL parser has it.
export async function checkTarget(rules, host, port, lookup) {
  if (!isPort(port)) return { refused: 'no valid port' }
  const name = canonicalHost(host)
  if (name === null) return { refused: 'not a host name' }
  if (net.isIP(name)) {
    const blocked = blockedAddress(name)
    if (blocked) return { refused: `${name} is ${blocked}` }
    return listed(rules, name, port) ? { address: name } : { refused: `${name}:${port} is not on the allowlist` }
  }
  if (!isHostname(name)) return { refused: 'not a host name' }
  if (!listed(rules, name, port)) return { refused: `${name}:${port} is not on the allowlist` }
  let addresses
  try {
    addresses = (await lookup(name)).map(a => (typeof a === 'string' ? a : a.address))
  } catch (err) {
    return { refused: `${name} does not resolve (${err?.code ?? 'error'})` }
  }
  if (addresses.length === 0) return { refused: `${name} does not resolve` }
  for (const address of addresses) {
    const blocked = blockedAddress(address)
    if (blocked) return { refused: `${name} resolves to ${address}, which is ${blocked}` }
  }
  return { address: addresses[0] }
}

// --- The servers -----------------------------------------------------------------

// Headers that are the connection's own, never passed on (RFC 9110 §7.6.1),
// and so is any header a Connection header names.
const HOP_BY_HOP = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function endToEnd(headers) {
  const named = new Set(String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  const out = {}
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase()) && !named.has(k.toLowerCase())) out[k] = v
  return out
}

const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 502: 'Bad Gateway' }
// `X-QA-Egress` says `refused` (the forwarder said no) or `failed` (the host
// couldn't be reached), on both paths.
function answer(socket, status, kind, reason) {
  const text = `${reason}\n`
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nX-QA-Egress: ${kind}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`)
}

// A failure or an idle cut reaches the other side as a reset, never a clean
// end, which a close-delimited stream would read as complete. A socket still
// connecting, or with no handle, is simply destroyed.
function reset(socket) {
  if (!socket || socket.destroyed) return
  if (socket.connecting || !socket._handle || typeof socket.resetAndDestroy !== 'function') return socket.destroy()
  try {
    socket.resetAndDestroy()
  } catch {
    socket.destroy()
  }
}

// What has moved on a socket: bytes read, bytes queued to write, what is
// still queued, and what has yet to reach the kernel.
const movedOn = socket => (socket ? `${socket.bytesRead}/${socket.bytesWritten}/${socket.writableLength}/${socket._handle?.writeQueueSize ?? ''}` : '')
const GRACE_MS = 250

// `socket` is cut once nothing moves. Its own timer fires after `ms` with no
// I/O on it; then it is spared, and the timer re-armed, when:
// - it is only waiting on the other side (`waiting`: paused by backpressure,
//   or `peer` still draining what it was given), and `peer` has moved since
//   the last look; or
// - either side moves within a short grace: a stalled event loop fires
//   timers before the I/O that was due.
// So a tunnel waiting on a slow but steady reader isn't cut, a tunnel where
// nothing moves is cut within `ms` and the grace, and one where each side
// waits on the other, within twice `ms` and the grace. The listener stays
// across re-arms. (Bytes already in the kernel's buffers move where no
// timer sees them.) Exported for its tests.
export function idleTimer(socket, peer, ms, cut, { waiting = () => socket.isPaused() || Boolean(peer?.writableNeedDrain), graceMs = Math.min(ms, GRACE_MS) } = {}) {
  let peerSeen = movedOn(peer)
  socket.on('timeout', () => {
    const peerNow = movedOn(peer)
    const peerMoved = peerNow !== peerSeen
    peerSeen = peerNow
    if (waiting() && peerMoved) return socket.setTimeout(ms)
    const before = `${movedOn(socket)} ${peerNow}`
    setTimeout(() => {
      if (socket.destroyed) return
      peerSeen = movedOn(peer)
      if (`${movedOn(socket)} ${peerSeen}` !== before) return socket.setTimeout(ms)
      cut()
    }, graceMs).unref()
  })
  socket.setTimeout(ms)
}

const defaultLookup = host => dns.lookup(host, { all: true, verbatim: true })
const defaultConnect = (port, address) => net.connect({ port, host: address })
const LOG_MAX = 300

// The config, checked whole before anything listens: { forward?: { listen,
// to: 'host:port' }, proxy?: { listen, allow }, host?, timeouts?: {
// connectMs, idleMs } }, with at least one of forward and proxy.
function checkConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('the config must be an object with forward, proxy or both')
  const { forward = null, proxy = null, host = '0.0.0.0', timeouts = {} } = config
  if (!forward && !proxy) throw new Error('the config must be an object with forward, proxy or both')
  if (typeof host !== 'string' || !net.isIP(host)) throw new Error('host must be an IP address to listen on')
  let to = null
  if (forward) {
    to = splitHostPort(forward.to)
    if (!to.host || /\s/.test(String(forward.to)) || !isPort(to.port) || !isPort(forward.listen)) throw new Error('forward needs listen (a port) and to (host:port)')
  }
  let rules = null
  if (proxy) {
    rules = parseAllowlist(proxy.allow)
    if (!isPort(proxy.listen)) throw new Error('proxy needs listen (a port)')
  }
  const ms = (v, d) => (Number.isSafeInteger(v) && v > 0 ? v : d)
  return { forward: forward && { listen: forward.listen, to }, proxy: proxy && { listen: proxy.listen, rules }, host, connectMs: ms(timeouts?.connectMs, 10_000), idleMs: ms(timeouts?.idleMs, 5 * 60_000) }
}

// config as checkConfig says; lookup, connect and log are for tests.
// Allowlist entries and CONNECT targets get no trimming: whitespace is an
// error, never something to read past.
// Resolves once every server listens. close() ends every connection.
export async function createForwarder(config, { lookup = defaultLookup, connect = defaultConnect, log = line => console.error(line) } = {}) {
  const { forward, proxy, host, connectMs, idleMs } = checkConfig(config)
  const servers = []
  // every connection in and out, so close() can end them
  const sockets = new Set()
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket }
  const opened = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })

  if (forward) {
    // half-open both ways, so a client that ends its request still gets the answer
    const server = net.createServer({ allowHalfOpen: true }, client => {
      const upstream = track(net.connect({ host: forward.to.host, port: forward.to.port, allowHalfOpen: true }))
      // A side that fails ends the other at once. The app closing ends the
      // client once what is queued for it is written (destroySoon), so a slow
      // reader still gets the tail. The client closing ends the app's side at
      // once: nothing here waits on a PR app that stops reading.
      client.on('error', () => reset(upstream))
      upstream.on('error', () => reset(client))
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroySoon())
      client.pipe(upstream).pipe(client)
    })
    server.on('connection', track)
    servers.push(server)
  }

  if (proxy) {
    const say = (hostName, port, reason) => {
      const name = canonicalHost(hostName)
      const where = name === null ? JSON.stringify(String(hostName ?? '').slice(0, 100)) : name.includes(':') ? `[${name}]` : name
      const line = `qa-egress refused ${where}:${port}: ${reason}`
      log(line.length > LOG_MAX ? `${line.slice(0, LOG_MAX)}…` : line)
    }
    const decide = async (hostName, port) => {
      const out = await checkTarget(proxy.rules, hostName, port, lookup)
      if (out.refused) say(hostName, port, out.refused)
      return out
    }
    const server = http.createServer(async (req, res) => {
      // a client gone while the name was looked up: nothing is dialled
      let gone = false
      res.on('close', () => { gone = true })
      // only proxy requests, and only plain http: HTTPS goes through CONNECT
      let target
      try { target = new URL(req.url) } catch { target = null }
      if (!target || target.protocol !== 'http:') {
        res.writeHead(400, { 'x-qa-egress': 'refused', 'content-type': 'text/plain' })
        return res.end('only absolute http:// requests; HTTPS goes through CONNECT\n')
      }
      const port = target.port ? Number(target.port) : 80
      const out = await decide(target.hostname, port)
      if (gone) return
      if (out.refused) {
        res.writeHead(403, { 'x-qa-egress': 'refused', 'content-type': 'text/plain' })
        return res.end(`${out.refused}\n`)
      }
      let upRes = null
      const failed = () => {
        if (res.headersSent) return reset(res.socket)
        res.writeHead(502, { 'x-qa-egress': 'failed', 'content-type': 'text/plain' })
        res.end('the host could not be reached\n')
      }
      const headers = endToEnd(req.headers)
      headers.host = target.host
      const upstream = http.request({
        method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false,
        createConnection: () => track(connect(port, out.address)),
      }, answerOf => {
        upRes = answerOf
        if (!(upRes.statusCode >= 100 && upRes.statusCode <= 999)) { upRes.destroy(); upstream.destroy(); return failed() }
        res.writeHead(upRes.statusCode, endToEnd(upRes.headers))
        // From here the PR's side is bounded too: once the host is done, a
        // PR that stops reading near the end would hold it with nothing
        // else to time it out. Node holds a socket's timeout off while
        // what is queued on it still moves, so a slow reader isn't cut.
        res.setTimeout(idleMs, () => reset(res.socket))
        upRes.pipe(res)
        // an answer cut partway through is cut for the client too, as a reset
        upRes.on('close', () => { if (!upRes.complete) reset(res.socket) })
      })
      // a connect that never completes is bounded, and so is an idle answer
      const connecting = setTimeout(() => upstream.destroy(new Error('timed out')), connectMs)
      upstream.on('socket', socket => { if (socket.pending) socket.once('connect', () => clearTimeout(connecting)); else clearTimeout(connecting) })
      // idle, but not while the answer only waits on a slow client that
      // still reads
      upstream.on('socket', socket => idleTimer(socket, res.socket, idleMs, () => upstream.destroy(new Error('idle')), { waiting: () => Boolean(upRes?.isPaused() || res.writableNeedDrain) }))
      upstream.on('error', () => { clearTimeout(connecting); failed() })
      upstream.on('close', () => clearTimeout(connecting))
      // a client gone before its answer is done takes the upstream with it
      res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
      req.pipe(upstream)
    })
    server.on('connect', async (req, socket, head) => {
      // A PR side that fails ends the upstream at once, with a reset, and one
      // that closes ends it once what is queued is written. Both are set
      // before the lookup. One that resets during it gets nothing dialled;
      // one that leaves with a FIN is dialled, then torn down at once.
      let upstream = null
      socket.on('error', () => reset(upstream))
      socket.on('close', () => upstream?.destroySoon())
      const { host: hostName, port } = splitHostPort(req.url)
      const out = await decide(hostName, port)
      if (socket.destroyed) return
      if (out.refused) return answer(socket, 403, 'refused', out.refused)
      upstream = track(connect(port, out.address))
      let open = false
      const connecting = setTimeout(() => upstream.destroy(new Error('timed out')), connectMs)
      upstream.once('connect', () => {
        clearTimeout(connecting)
        open = true
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        // a tunnel through which nothing moves ends both sides. One timer,
        // on the PR's side, sees it all: every byte either way is read or
        // written there, and what the host's side drains counts as its peer
        idleTimer(socket, upstream, idleMs, () => { reset(socket); reset(upstream) })
        upstream.pipe(socket).pipe(upstream)
      })
      // before the 200 a failure is answered; after it, the tunnel ends: at
      // once on an error, else once what is queued for the PR is written
      upstream.on('error', () => { clearTimeout(connecting); if (!open && !socket.destroyed) answer(socket, 502, 'failed', 'the host could not be reached'); else if (open) reset(socket) })
      upstream.on('close', () => { clearTimeout(connecting); if (open) socket.destroySoon() })
    })
    server.on('connection', track)
    servers.push(server)
  }

  // every server listens only once the whole config is known to be good
  const ports = [forward?.listen, proxy?.listen]
  try {
    for (const [i, server] of servers.entries()) await opened(server, ports.filter(Boolean)[i])
  } catch (err) {
    await Promise.all(servers.map(server => new Promise(resolve => (server.listening ? server.close(() => resolve()) : resolve()))))
    throw err
  }

  return {
    servers,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return Promise.all(servers.map(s => new Promise(resolve => { if (!s.listening) return resolve(); s.close(() => resolve()) })))
    },
  }
}

// Run in the container: the config from PANE_FORWARDER. A bad one exits 1.
// The Provisioner, finding no forwarder ready, then puts the PR pane on an
// ordinary network, and its isolation verdict says egress isn't restricted.
// Every line goes to stdout, refusals included: triage's log tail
// (`logsTail`) reads stdout only.
// Only when run as given to node -e ([eval]): imported, by the conductor
// say, it starts nothing, whatever its env.
if (typeof process !== 'undefined' && process.env.PANE_FORWARDER && /\[eval\d*\]$/.test(import.meta.url)) {
  let config
  try {
    config = JSON.parse(process.env.PANE_FORWARDER)
  } catch {
    console.log('qa-forwarder: PANE_FORWARDER is not JSON')
    process.exit(1)
  }
  createForwarder(config, { log: line => console.log(line) }).then(
    () => console.log('qa-forwarder ready'),
    err => { console.log(`qa-forwarder: ${err.message}`); process.exit(1) },
  )
}
