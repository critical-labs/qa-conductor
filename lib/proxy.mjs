// Pane proxy for QA sessions. Fronts one pane's app container:
//
// - Holds the pane's cookies in a server-side jar. Cookies ignore ports, so
//   two app versions behind one tailnet hostname would collide in the
//   browser; pane Set-Cookie headers are absorbed here and never forwarded.
// - Injects the mirror bridge <script> into text/html responses and serves
//   the bridge file at /__qa/bridge.js (read per request, no cache).
// - Stamps activity (onActivity) for the idle reaper.
// - Rewrites absolute http://127.0.0.1:<upstreamPort> Locations to relative
//   so redirects stay on the pane's public origin.

import http from 'node:http'
import { readFile } from 'node:fs/promises'

const BRIDGE_ROUTE = '/__qa/bridge.js'
const BRIDGE_TAG = '<script src="/__qa/bridge.js"></script>'

// Parse one Set-Cookie header into { name, value, remove }. A cookie is a
// removal when Max-Age <= 0, Expires is in the past (Max-Age wins when both
// are present, per RFC 6265), or the value is empty / the conventional
// 'deleted' sentinel.
export function parseSetCookie(header) {
  const [pair, ...attrs] = String(header).split(';')
  const eq = pair.indexOf('=')
  const name = (eq === -1 ? pair : pair.slice(0, eq)).trim()
  const value = eq === -1 ? '' : pair.slice(eq + 1).trim()
  let maxAge = null
  let expires = null
  for (const attr of attrs) {
    const i = attr.indexOf('=')
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
    const v = i === -1 ? '' : attr.slice(i + 1).trim()
    if (key === 'max-age') maxAge = Number(v)
    else if (key === 'expires') expires = Date.parse(v)
  }
  let remove = value === '' || value === 'deleted'
  if (maxAge !== null && !Number.isNaN(maxAge)) {
    if (maxAge <= 0) remove = true
  } else if (expires !== null && !Number.isNaN(expires) && expires <= Date.now()) {
    remove = true
  }
  return { name, value, remove }
}

function mergeCookieHeader(clientCookie, jar) {
  const merged = new Map()
  if (clientCookie) {
    for (const part of String(clientCookie).split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      merged.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }
  for (const [name, value] of jar) merged.set(name, value)
  return [...merged].map(([name, value]) => `${name}=${value}`).join('; ')
}

function upstreamHeaders(req, jar) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase()
    if (k === 'host' || k === 'accept-encoding' || k === 'cookie') continue
    if (k === 'connection' || k === 'keep-alive' || k === 'proxy-connection') continue
    headers[k] = value
  }
  headers['accept-encoding'] = 'identity'
  const cookie = mergeCookieHeader(req.headers.cookie, jar)
  if (cookie) headers.cookie = cookie
  return headers
}

function responseHeaders(upRes, upstreamPort) {
  const headers = {}
  for (const [key, value] of Object.entries(upRes.headers)) {
    const k = key.toLowerCase()
    if (k === 'set-cookie' || k === 'transfer-encoding' || k === 'connection' || k === 'keep-alive') {
      continue
    }
    headers[k] = value
  }
  const origin = `http://127.0.0.1:${upstreamPort}`
  if (typeof headers.location === 'string' && headers.location.startsWith(origin)) {
    const rest = headers.location.slice(origin.length)
    if (rest === '') headers.location = '/'
    else if (rest.startsWith('/')) headers.location = rest
    else if (rest.startsWith('?') || rest.startsWith('#')) headers.location = `/${rest}`
    // anything else (e.g. a longer port sharing the prefix) is left untouched
  }
  return headers
}

function injectBridge(body) {
  const html = body.toString('utf8')
  const match = /<\/head>/i.exec(html)
  const injected = match
    ? html.slice(0, match.index) + BRIDGE_TAG + html.slice(match.index)
    : BRIDGE_TAG + html
  return Buffer.from(injected, 'utf8')
}

function serveBridge(bridgePath, res) {
  readFile(bridgePath).then(
    (content) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': content.length })
      res.end(content)
    },
    () => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('bridge script not found')
    },
  )
}

export function createPaneProxy({ upstreamPort, bridgePath, onActivity = () => {}, httpMod = http }) {
  const jar = new Map()
  // A number, or a function resolved per request: the conductor points the
  // pane at whatever port the Provisioner reserved for the running session.
  const portOf = typeof upstreamPort === 'function' ? upstreamPort : () => upstreamPort

  return function handler(req, res) {
    const pathname = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && pathname === BRIDGE_ROUTE) {
      serveBridge(bridgePath, res)
      return
    }

    onActivity()

    const port = portOf()
    if (!port) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('503: no QA session is running on this pane')
      return
    }

    const upReq = httpMod.request(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req, jar),
      },
      (upRes) => {
        const rawSetCookies = upRes.headers['set-cookie'] ?? []
        for (const raw of Array.isArray(rawSetCookies) ? rawSetCookies : [rawSetCookies]) {
          const { name, value, remove } = parseSetCookie(raw)
          if (!name) continue
          if (remove) jar.delete(name)
          else jar.set(name, value)
        }

        const headers = responseHeaders(upRes, port)
        const isHtml = /^text\/html\b/i.test(upRes.headers['content-type'] ?? '')
        if (!isHtml) {
          res.writeHead(upRes.statusCode ?? 502, headers)
          upRes.pipe(res)
          return
        }

        const chunks = []
        upRes.on('data', (chunk) => chunks.push(chunk))
        upRes.on('end', () => {
          const body = injectBridge(Buffer.concat(chunks))
          headers['content-length'] = body.length
          res.writeHead(upRes.statusCode ?? 502, headers)
          res.end(body)
        })
      },
    )

    upReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('502: QA pane upstream unavailable')
    })

    req.pipe(upReq)
  }
}
