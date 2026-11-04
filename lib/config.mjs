// Generic conductor configuration: parse `.env.qa` (plain KEY=value lines)
// into the settings the CORE needs. There are no app defaults here: a
// consuming platform passes its own `defaults` (and any keys it must insist
// on as `required`) and reads its app-specific keys (image repo, database
// identity, ...) from the returned raw `env` map, as this repository's
// self-QA (qa/self.mjs) reads its own.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { normalizeLogins } from './identity.mjs'
import {
  COOKIE_NAMES_RULE, RESERVED_COOKIE_RULE, hostPort, isCookieName, isLoopbackHost, isReservedCookieName, requireFetchMetadata, webOrigin,
} from './net.mjs'

// Where the harness is served under its origin. Fixed: public/index.html and
// public/harness.js load and call /qa/... .
export const HARNESS_PATH = '/qa'

// QA_EXPOSURE / cfg.exposure. `tailscale`: fronted by tailscale serve on this
// host, so every server answers only QA_ALLOWED_LOGINS and must listen on
// loopback. `none`: no identity gate (0.2's behaviour).
export const EXPOSURE_MODES = ['none', 'tailscale']

// QA_EXPOSURE_INTERVAL_MINUTES / cfg.exposureIntervalMinutes: the minutes
// between the conductor's exposure reconcile passes. At most 35791, the
// largest whole number of minutes whose milliseconds fit setInterval's
// 2^31-1 limit: above it Node fires every 1 ms, and the loop would run the
// front door's CLI back to back. Fractions are fine.
export const MAX_EXPOSURE_INTERVAL_MINUTES = 35791

export function isExposureInterval(minutes) {
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_EXPOSURE_INTERVAL_MINUTES
}

// The rule both loadConfig and startConductor state when they refuse one.
export const EXPOSURE_INTERVAL_RULE = `must be a number of minutes above 0 and at most ${MAX_EXPOSURE_INTERVAL_MINUTES} (the longest a timer can wait)`

// The hostname of an http(s) origin, or null for anything else.
function originHostname(value) {
  try { return new URL(webOrigin(value)).hostname } catch { return null }
}

// The exposure mode for a layout that names none: tailscale when anything
// the conductor answers to or listens on is off loopback, since it is then
// meant to be reached from another machine; else none. The inputs are the
// harness origin as resolved at start (null, on port 0 or off loopback,
// adds nothing: the bind host counts on its own), both pane origins (a
// missing or unparseable one counts), the public host and every allowed
// host, which widen the Host allowlist, and the bind host. `because` names
// the first one off loopback, for error messages, else null. The public
// host goes first, since the derived origins come from it.
export function defaultExposure({ harnessOrigin = null, paneOrigins, publicHost = null, allowedHosts = [], host = '127.0.0.1' } = {}) {
  const inputs = []
  if (publicHost) inputs.push([`QA_PUBLIC_HOST=${publicHost}`, publicHost])
  if (harnessOrigin != null) inputs.push([`QA_HARNESS_ORIGIN=${harnessOrigin}`, originHostname(harnessOrigin)])
  for (const [role, key] of [['base', 'QA_BASE_ORIGIN'], ['pr', 'QA_PR_ORIGIN']]) {
    const value = paneOrigins?.[role]
    const hostname = originHostname(value)
    const shown = value == null ? `${key} (unset)` : hostname === null ? `${key}=${JSON.stringify(String(value))}` : `${key}=${value}`
    inputs.push([shown, hostname])
  }
  for (const entry of allowedHosts ?? []) {
    // a blank entry matches no Host, so it widens nothing
    if (String(entry).trim()) inputs.push([`the QA_ALLOWED_HOSTS entry ${entry}`, String(entry).trim()])
  }
  inputs.push([`QA_BIND_HOST=${host}`, host])
  const first = inputs.find(([, name]) => !isLoopbackHost(name))
  return first ? { mode: 'tailscale', because: first[0] } : { mode: 'none', because: null }
}

// The harness origin when none is configured: :8444 on the public host, else
// the loopback address the harness listens on, else null (on port 0 the
// conductor derives it from the bound port; off loopback it can't be known).
export function defaultHarnessOrigin({ publicHost, host, port }) {
  if (publicHost) return webOrigin(`https://${publicHost}:8444`, 'the harness origin derived from QA_PUBLIC_HOST')
  if (isLoopbackHost(host) && port > 0) return new URL(`http://${hostPort(host, port)}`).origin
  return null
}

// After the opening quote, that quote followed by a # (whitespace between or
// not): the value's closing quote, then a comment.
const COMMENT_AFTER_QUOTE = { '"': /"\s*#/, "'": /'\s*#/ }

// KEY=value lines; blank lines and lines starting with # are skipped. A value
// in a matching pair of double or single quotes loses them, and nothing in
// it is unescaped or expanded. A comment after a value is refused, not kept:
// a # after whitespace in an unquoted value, or after a quoted value's
// closing quote. Kept, it would make a token or login fail far from this
// file, or worse, a comment that ends in a quote would read as the end of
// one quoted value and add what it names to a list (QA_ALLOWED_LOGINS="a"
// # "b, c" allowing c). The error never shows the value, which may be a token.
export function parseEnvFile(envFilePath) {
  const env = {}
  readFileSync(envFilePath, 'utf8').split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eq = trimmed.indexOf('=')
    if (eq === -1) return
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    const where = `${envFilePath}:${i + 1}: ${key}`
    const quote = COMMENT_AFTER_QUOTE[value[0]] ? value[0] : null
    if (quote && COMMENT_AFTER_QUOTE[quote].test(value.slice(1))) {
      throw new Error(`${where} has a comment after its quoted value, and .env.qa takes comments only on lines of their own: move it`)
    }
    const quoted = quote !== null && value.length > 1 && value.endsWith(quote)
    if (!quoted && /\s#/.test(trimmed.slice(eq + 1))) {
      throw new Error(
        `${where} has an inline comment, and .env.qa takes comments only on lines of their own: ` +
          'move it, or quote the value if the # is part of it',
      )
    }
    env[key] = quoted ? value.slice(1, -1) : value
  })
  return env
}

const num = (value, fallback) => (value ? Number(value) : fallback)

// A yes/no key: 1 or true, 0 or false (any case), unset or empty for no; null
// for anything else.
function flag(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === '' || v === '0' || v === 'false') return false
  if (v === '1' || v === 'true') return true
  return null
}

const list = value => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean)

// The harness and the panes each act for the operator, so none may be
// same-origin with another: a pane's page (PR code) would then drive the
// harness API or the other pane. Throws naming the first pair that collides.
function checkDistinct(origins, envFilePath) {
  const seen = new Map()
  for (const [name, origin] of Object.entries(origins)) {
    if (origin === null) continue
    if (seen.has(origin)) {
      throw new Error(
        `the harness and the two panes must be three different origins, but the ${seen.get(origin)} and ${name} are both ${origin} ` +
          `in ${envFilePath} (QA_HARNESS_ORIGIN, QA_BASE_ORIGIN, QA_PR_ORIGIN)`,
      )
    }
    seen.set(origin, name)
  }
}

// QA_EXPOSURE, else the default for this layout. `explicit` and `because`
// say why, for the errors below.
function exposureOf(value, layout, envFilePath) {
  if (!value) return { ...defaultExposure(layout), explicit: false }
  if (!EXPOSURE_MODES.includes(value)) {
    throw new Error(`QA_EXPOSURE must be none or tailscale, got ${JSON.stringify(value)} in ${envFilePath}`)
  }
  return { mode: value, because: null, explicit: true }
}

// The identity gate trusts Tailscale-User-Login only because nothing but
// tailscale serve on this host can reach a loopback listener; on any other
// address a client could send its own. And an empty allowlist would refuse
// everyone. The bind is checked first, so its error names the way out too.
function checkTailscale({ explicit, because }, host, allowedLogins, envFilePath) {
  const avoid = 'set QA_EXPOSURE=none if another front door authenticates'
  if (!isLoopbackHost(host)) {
    const why = explicit ? 'QA_EXPOSURE=tailscale is set' : `QA_EXPOSURE defaults to tailscale because ${because} is not loopback`
    throw new Error(
      `${why}, so QA_BIND_HOST must be a loopback address: tailscale serve on this host is the only supported front ` +
        `(got ${JSON.stringify(host)} in ${envFilePath}; use 127.0.0.1, ::1 or localhost), or ${avoid}`,
    )
  }
  if (allowedLogins.length === 0) {
    const reason = explicit ? 'set' : `${because} is not loopback`
    throw new Error(
      `QA_ALLOWED_LOGINS is empty in ${envFilePath} and QA_EXPOSURE is tailscale (${reason}): the harness and both panes would refuse everyone. ` +
        'Set it to the comma-separated Tailscale logins allowed in (to find one, run `tailscale whois <device tailnet ip>`), ' +
        `or ${avoid}.`,
    )
  }
}

// Keys the core cannot run without. QA_PUBLIC_HOST joins them only when it is
// needed to derive a pane origin that wasn't given explicitly.
function requiredKeys(env, extra) {
  const keys = new Set(['GITHUB_QA_TOKEN', 'QA_REPO', ...extra])
  if (!(env.QA_BASE_ORIGIN && env.QA_PR_ORIGIN)) keys.add('QA_PUBLIC_HOST')
  return keys
}

export function loadConfig(envFilePath, { defaults = {}, required = [] } = {}) {
  const env = { ...defaults, ...parseEnvFile(envFilePath) }
  for (const key of requiredKeys(env, required)) {
    if (!env[key]) throw new Error(`${key} missing in ${envFilePath}`)
  }
  const publicHost = env.QA_PUBLIC_HOST || null
  // listen() takes an IPv6 literal bare: `[::1]`, as a URL writes it, is ::1.
  // Left bracketed, it would pass every loopback check and then fail to listen.
  const host = (env.QA_BIND_HOST || '127.0.0.1').replace(/^\[(.*)\]$/, '$1')
  const ports = {
    harness: num(env.QA_HARNESS_PORT, 3100),
    base: num(env.QA_BASE_PROXY_PORT, 3101),
    pr: num(env.QA_PR_PROXY_PORT, 3102),
  }
  const paneOrigins = {
    base: env.QA_BASE_ORIGIN
      ? webOrigin(env.QA_BASE_ORIGIN, 'QA_BASE_ORIGIN')
      : webOrigin(`https://${publicHost}:8443`, 'QA_BASE_ORIGIN (derived from QA_PUBLIC_HOST)'),
    pr: env.QA_PR_ORIGIN
      ? webOrigin(env.QA_PR_ORIGIN, 'QA_PR_ORIGIN')
      : webOrigin(`https://${publicHost}:10000`, 'QA_PR_ORIGIN (derived from QA_PUBLIC_HOST)'),
  }
  const harnessOrigin = env.QA_HARNESS_ORIGIN
    ? webOrigin(env.QA_HARNESS_ORIGIN, 'QA_HARNESS_ORIGIN')
    : defaultHarnessOrigin({ publicHost, host, port: ports.harness })
  if (harnessOrigin === null && !(isLoopbackHost(host) && ports.harness === 0)) {
    throw new Error(
      `QA_HARNESS_ORIGIN missing in ${envFilePath}: with QA_BIND_HOST=${host} and no QA_PUBLIC_HOST, ` +
        'the origin viewers open the harness at cannot be derived (for example https://qa.example.com:8444)',
    )
  }
  // The derived origins are https or loopback; an explicit one may be neither.
  if (harnessOrigin !== null) requireFetchMetadata(harnessOrigin, 'QA_HARNESS_ORIGIN', 'harness API guard')
  requireFetchMetadata(paneOrigins.base, 'QA_BASE_ORIGIN', 'pane request guard')
  requireFetchMetadata(paneOrigins.pr, 'QA_PR_ORIGIN', 'pane request guard')
  checkDistinct({ harness: harnessOrigin, base: paneOrigins.base, pr: paneOrigins.pr }, envFilePath)
  const frameAncestors = list(env.QA_FRAME_ANCESTORS).map(v => webOrigin(v, 'QA_FRAME_ANCESTORS'))
  // Origins that may frame the harness itself (an admin page that embeds
  // it, say). Each may then frame the panes through it, so they join the
  // panes' policy too. Empty: only the harness origin may frame it.
  const harnessFrameAncestors = list(env.QA_HARNESS_FRAME_ANCESTORS).map(v => webOrigin(v, 'QA_HARNESS_FRAME_ANCESTORS'))
  const allowedHosts = list(env.QA_ALLOWED_HOSTS)
  const exposure = exposureOf(env.QA_EXPOSURE, { harnessOrigin, paneOrigins, publicHost, allowedHosts, host }, envFilePath)
  const allowedLogins = normalizeLogins(list(env.QA_ALLOWED_LOGINS))
  if (exposure.mode === 'tailscale') checkTailscale(exposure, host, allowedLogins, envFilePath)
  const exposureIntervalMinutes = num(env.QA_EXPOSURE_INTERVAL_MINUTES, 5)
  if (!isExposureInterval(exposureIntervalMinutes)) {
    throw new Error(`QA_EXPOSURE_INTERVAL_MINUTES ${EXPOSURE_INTERVAL_RULE}, got ${JSON.stringify(env.QA_EXPOSURE_INTERVAL_MINUTES)} in ${envFilePath}`)
  }
  const forwardClientCookies = [...new Set(list(env.QA_FORWARD_CLIENT_COOKIES))]
  const badCookie = forwardClientCookies.find(name => !isCookieName(name))
  if (badCookie !== undefined) {
    throw new Error(`QA_FORWARD_CLIENT_COOKIES must be comma-separated ${COOKIE_NAMES_RULE}, got ${JSON.stringify(badCookie)} in ${envFilePath}`)
  }
  // The harness's look: a stylesheet served at /qa/theme.css after the
  // page's own, the page title and the header brand. A relative stylesheet
  // path is taken from the env file's directory.
  const theme = {
    css: env.QA_THEME_CSS ? path.resolve(path.dirname(envFilePath), env.QA_THEME_CSS) : null,
    title: env.QA_TITLE || null,
    brand: env.QA_BRAND || null,
  }
  const requireIsolation = flag(env.QA_REQUIRE_ISOLATION)
  if (requireIsolation === null) {
    throw new Error(`QA_REQUIRE_ISOLATION must be 1 or 0 (true or false), got ${JSON.stringify(env.QA_REQUIRE_ISOLATION)} in ${envFilePath}`)
  }
  const reservedCookie = forwardClientCookies.find(isReservedCookieName)
  if (reservedCookie !== undefined) {
    throw new Error(`QA_FORWARD_CLIENT_COOKIES can't name ${JSON.stringify(reservedCookie)}: ${RESERVED_COOKIE_RULE}, in ${envFilePath}`)
  }

  return {
    env,
    githubToken: env.GITHUB_QA_TOKEN,
    // The GHCR token, for createGithub({ packagesToken }) (package version
    // listings) and a platform's registry login. A fine-grained
    // GITHUB_QA_TOKEN cannot call the Packages API, so QA_GHCR_TOKEN (a
    // classic PAT with read:packages) can take those over. Unset,
    // GITHUB_QA_TOKEN does both.
    ghcrToken: env.QA_GHCR_TOKEN || env.GITHUB_QA_TOKEN,
    operatorEmail: env.QA_OPERATOR_EMAIL || null,
    repo: env.QA_REPO,
    publicHost,
    idleMinutes: num(env.QA_IDLE_MINUTES, 30),
    theme,
    // The address all three servers listen on. Loopback by default, and
    // always in tailscale mode: in none mode the API is unauthenticated, and
    // a pane proxy is a signed-in pane session either way.
    host,
    // Extra Host-header hostnames the servers answer to, beyond loopback, the
    // public host and the pane origins (DNS-rebinding defence).
    allowedHosts,
    // 'tailscale' (the identity gate is on) or 'none'; see EXPOSURE_MODES.
    exposure: exposure.mode,
    // Tailscale logins (as tailscale serve reports them, e.g. alice@github)
    // allowed in when the identity gate is on. Empty refuses everyone, so
    // tailscale mode requires some.
    allowedLogins,
    // Minutes between exposure reconcile passes, when the platform passes
    // an Exposure adapter (adapters.exposure); see MAX_EXPOSURE_INTERVAL_MINUTES.
    exposureIntervalMinutes,
    // Listen ports: the harness UI/API and the two pane proxies.
    ports,
    // The external origin a viewer reaches each pane at: the TLS terminator in
    // front of the pane proxies. Defaults match a tailscale-serve layout.
    paneOrigins,
    // The origin viewers open the harness at (its page is HARNESS_PATH/ under
    // it). Only it, the panes themselves and frameAncestors may frame a pane,
    // a navigation into a pane from another site must come from it, and the
    // mirror bridge talks only to it. null: derived from the bound port.
    harnessOrigin,
    // Extra origins allowed to frame the panes, for a harness that is itself
    // framed (self-QA's inner demos). CSP only: no Referer or bridge trust.
    frameAncestors,
    harnessFrameAncestors,
    // The browser cookies, by name, the pane proxies pass to the pane apps
    // beside each pane's own jar. Empty: none. Cookies ignore ports, so any
    // page on the panes' hostname can set these, the other pane included.
    forwardClientCookies,
    // Refuse a session whose PR pane isn't isolated from the base pane
    // (lib/isolation.mjs), before the PR's code runs: at the start of the
    // boot when that is known then (a BuildConvention whose install step
    // runs it, say), else once the check has run, before any migrate or app.
    requireIsolation,
    verdictLabels: {
      accept: env.QA_LABEL_ACCEPT || 'qa-approved',
      reject: env.QA_LABEL_REJECT || 'qa-changes-requested',
    },
  }
}
