// PR-QA conductor core: harness UI/API + pane proxies, composed over the five
// adapter seams. This module owns NO app, infra or registry policy: a
// consuming platform constructs {cfg, github, fsx, adapters, readBaseEnv} and
// calls startConductor. Containers, env files and log tails belong to the
// Provisioner; PR readiness belongs to the BuildConvention (describePrs);
// origins, ports and verdict labels are config. `github` is used for the PR
// list, PR head/trust lookups and the verdict comment + label.
//
// Browser-facing hardening (defence in depth, not a trust boundary):
// - in tailscale mode (cfg.exposure, else derived as loadConfig does), all
//   three servers answer only Tailscale-User-Login values in
//   cfg.allowedLogins (403 before anything else runs) and must listen on
//   loopback, so tailscale serve on this host is the only way in;
// - all three servers listen on cfg.host (loopback by default) and answer 421
//   to a Host header outside the allowlist, so a DNS-rebound page can't reach
//   them;
// - every /api/* request must come from the harness page itself, at the
//   harness origin's host:port (403), and POST bodies must be JSON (415), so
//   another page in the reviewer's browser can't drive or read the API;
// - no other page may frame the harness, only the harness origin (plus
//   cfg.frameAncestors) may frame a pane, and the pane proxies refuse other
//   pages' requests (lib/request-guard.mjs);
// - every /api/* route but POST /api/enrol, and every pane request, needs an
//   enrolled browser's capability (lib/capability.mjs), 403 otherwise. A
//   browser enrols only while no PR code can be running (enrolmentShut), or
//   with an invite from one that has, so PR code that reaches loopback gets
//   nowhere, whatever headers it sends.
//
// The harness origin is cfg.harnessOrigin, else derived as loadConfig does:
// :8444 on cfg.publicHost, else the loopback address the harness listens on
// (per request, so a harness on port 0 uses its bound port).
//
// An optional sixth adapter, adapters.exposure (lib/exposure.mjs), lets the
// conductor publish itself: a reconcile loop keeps its three mounts on the
// front door, and GET /api/exposure reports the last pass. Only a gated
// conductor may have one.
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { MARK_TYPES, createActionLog } from './action-log.mjs'
import { createDataCapture } from './data-capture.mjs'
import { validateRules } from './data-diff.mjs'
import { CAP_HEADER, ENTER_ROUTE, REFUSAL_CAPABILITY, createCapability, paneCookieName } from './capability.mjs'
import {
  defaultExposure, defaultHarnessOrigin, EXPOSURE_INTERVAL_RULE, EXPOSURE_MODES, HARNESS_PATH, isExposureInterval,
} from './config.mjs'
import { mountsFor, reconcileExposure } from './exposure.mjs'
import { identityGate, normalizeLogins } from './identity.mjs'
import { combine, declared, declaredBuild, floors, fromCheck } from './isolation.mjs'
import { cookieNames, hostPort, isLoopbackHost, requireFetchMetadata, webOrigin } from './net.mjs'
import { createPaneProxy, isAllowedHost, misdirected, panePolicy } from './proxy.mjs'
import { isHarnessHost, isSameOriginRequest } from './request-guard.mjs'
import { formatVerdict } from './verdict.mjs'
import { waitOn } from './wait.mjs'
import {
  createSession, reduce, touch, isIdle, bootSession, teardownSession, PANE_STAGES,
} from './session.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PUBLIC_DIR = path.join(HERE, '..', 'public')
const DEFAULT_HOST = '127.0.0.1'
// Harness POST routes whose body must be JSON. A cross-site HTML form can't
// send that type, and a cross-site fetch() with it needs a CORS preflight.
const JSON_ROUTES = new Set(['/api/session', '/api/verdict', '/api/teardown', '/api/enrol', '/api/invite', '/api/pane-entry', '/api/actions/mark', '/api/data/snapshot'])
// The largest JSON body a POST may send. The harness's are tiny.
const MAX_BODY = 64 * 1024
// The harness page starts sessions and posts verdicts in one click, so no
// other page may frame it (clickjacking); a browser that ignores
// frame-ancestors still honours X-Frame-Options. The Referrer-Policy pins
// what the panes' Referer check relies on: the harness origin, sent on its
// iframe loads and new tabs whatever the browser's default.
const HARNESS_FRAME_HEADERS = {
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
}

// The harness page's Content-Security-Policy. Beyond frame-ancestors: it
// loads everything from itself (default-src), runs only its own scripts (it
// has no inline one), styles from itself and inline, loads no plugin, takes
// no <base>, submits no form, and frames only the panes' origins. Its Data
// and Actions panels (#8) show text PR code controls; they draw it as text,
// and this is the second line. A pane origin that isn't one yet (a demo's
// placeholder) or is an IPv6 literal, which a CSP source can't express,
// frames any http(s) origin instead, rather than none.
function harnessPolicy(paneOrigins) {
  const directives = [
    "frame-ancestors 'self'", "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ]
  const frames = []
  for (const value of Object.values(paneOrigins ?? {})) {
    let origin
    try { origin = webOrigin(value) } catch { origin = null }
    if (origin === null || new URL(origin).hostname.startsWith('[')) {
      frames.length = 0
      break
    }
    frames.push(origin)
  }
  directives.push(`frame-src ${frames.length ? [...new Set(frames)].join(' ') : 'http: https:'}`)
  return directives.join('; ')
}

function isJsonRequest(headers) {
  return String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
}

// cfg.host, the address all three servers listen on. listen() takes an IPv6
// literal bare (::1); in brackets it would pass the loopback check below,
// then fail to listen and take the process down. loadConfig unwraps it.
function startHost(cfg) {
  const host = cfg.host ?? DEFAULT_HOST
  if (/^\[.*\]$/.test(host)) {
    throw new Error(`startConductor: cfg.host is a listen address, which takes an IPv6 literal without brackets: use ${JSON.stringify(host.slice(1, -1))}, not ${JSON.stringify(host)}`)
  }
  return host
}

// The harness origin as configured, or as derivable at start, after checking
// the origins in cfg. Throws on what would otherwise fail open: a harness
// origin or extra frame ancestor that isn't an http(s) origin, a harness or
// pane origin set at start that browsers send no Fetch Metadata to (plain
// http off loopback: the request guards would take other pages for curl),
// and a harness origin equal to a pane origin (PR code would be same-origin
// with the harness). Equal pane origins are left to loadConfig: the demo's
// placeholders are equal until its proxies listen.
function startHarnessOrigin(cfg, host) {
  const configured = cfg.harnessOrigin == null ? null : webOrigin(cfg.harnessOrigin, 'cfg.harnessOrigin')
  for (const value of [].concat(cfg.frameAncestors ?? [])) webOrigin(value, 'cfg.frameAncestors')
  // A derived origin is https or loopback.
  if (configured !== null) requireFetchMetadata(configured, 'cfg.harnessOrigin', 'harness API guard')
  const origin = configured ?? defaultHarnessOrigin({ publicHost: cfg.publicHost, host, port: cfg.ports.harness })
  for (const [role, value] of Object.entries(cfg.paneOrigins ?? {})) {
    let pane
    try { pane = webOrigin(value) } catch { continue } // not an origin yet: nothing to check
    requireFetchMetadata(pane, `cfg.paneOrigins.${role}`, 'pane request guard')
    if (pane === origin) {
      throw new Error(`startConductor: the harness origin ${origin} is also the ${role} pane's origin; the harness and each pane need an origin of their own`)
    }
  }
  return origin
}

// cfg.exposure, else the default loadConfig would give this layout, fixed at
// start: a cfg whose non-loopback origins arrive later must set it. Throws on
// an unknown mode, and on tailscale mode off loopback, where anything that
// reaches the port could send its own Tailscale-User-Login. `because` names
// what made a defaulted mode tailscale, for the startup log; else null.
function startExposure(cfg, host, startOrigin) {
  const fallback = defaultExposure({
    harnessOrigin: startOrigin, paneOrigins: cfg.paneOrigins,
    publicHost: cfg.publicHost, allowedHosts: cfg.allowedHosts ?? [], host,
  })
  const mode = cfg.exposure ?? fallback.mode
  if (!EXPOSURE_MODES.includes(mode)) {
    throw new Error(`startConductor: cfg.exposure must be 'none' or 'tailscale', got ${JSON.stringify(mode)}`)
  }
  if (mode === 'tailscale' && !isLoopbackHost(host)) {
    const why = cfg.exposure == null ? `exposure defaults to tailscale because ${fallback.because} is not loopback` : "cfg.exposure is 'tailscale'"
    throw new Error(
      `startConductor: ${why}, so cfg.host must be a loopback address: tailscale serve on this host is the only supported front ` +
        `(got ${JSON.stringify(host)}), or set exposure: 'none' if another front door authenticates`,
    )
  }
  return { mode, because: cfg.exposure == null ? fallback.because : null }
}

// Why the pane cookie can't reach this pane, or null when it can. The cookie
// is SameSite=Strict, so a pane framed by a page on another site never gets
// it, and with no public suffix list at hand, one hostname is the only layout
// known to be one site. A null harness origin can frame no pane anyway.
function layoutProblem(harnessOrigin, paneOrigin, role) {
  if (harnessOrigin === null || new URL(harnessOrigin).hostname === new URL(paneOrigin).hostname) return null
  return (
    `the harness origin ${harnessOrigin} and the ${role} pane's origin ${paneOrigin} are on different hosts, ` +
    'and the pane cookie never reaches a pane framed from another site: serve the harness and both panes on one hostname'
  )
}

// Throws on pane origins set at start that the pane cookie can't reach from
// the harness origin, as known at start. Equal pane origins are placeholders
// (the demo's, until its proxies listen), and a value that isn't an origin
// yet is skipped: both are checked each time the harness enters a pane.
function startLayout(harnessOrigin, paneOrigins) {
  if (harnessOrigin === null) return
  const panes = []
  for (const role of ['base', 'pr']) {
    try { panes.push([role, webOrigin(paneOrigins?.[role])]) } catch { /* not an origin yet */ }
  }
  if (panes.length === 2 && panes[0][1] === panes[1][1]) return
  for (const [role, pane] of panes) {
    const problem = layoutProblem(harnessOrigin, pane, role)
    if (problem !== null) throw new Error(`startConductor: ${problem}`)
  }
}

// `to` as a path on the pane at `paneOrigin` (path, query and fragment), or
// null when it leads anywhere else. A relative `to` is resolved against the
// pane's root; the URL parser decides, so `//x` and `/\x` are other hosts. A
// path on the pane that starts with `//` gets `/.` before it: as a Location,
// `//x` would name the host x.
function panePath(to, paneOrigin) {
  if (typeof to !== 'string') return null
  let url
  try { url = new URL(to, `${paneOrigin}/`) } catch { return null }
  if (url.origin !== paneOrigin) return null
  return `${url.pathname.startsWith('//') ? '/.' : ''}${url.pathname}${url.search}${url.hash}`
}

// What a failed teardown left up, for the log.
const teardownFailures = failed => failed.map(f => `${f.role}: ${f.message}`).join(', ')

// The optional inspector's rules, checked, or null with no inspector: one
// that can't open a probe, or whose rules aren't valid, throws at start.
function startInspector(adapters) {
  const inspector = adapters.inspector ?? null
  if (inspector === null) return null
  if (typeof inspector !== 'object' || typeof inspector.open !== 'function') {
    throw new Error('startConductor: adapters.inspector must be an object with an open() function')
  }
  try {
    return validateRules(inspector.rules)
  } catch (err) {
    throw new Error(`startConductor: adapters.inspector.rules: ${err.message}`)
  }
}

// adapters.exposure, if any, and the milliseconds between its passes. Only a
// gated conductor may publish itself: in none mode, anyone a mount reaches
// would reach the API and the panes. The interval is held to loadConfig's
// rule, so a code-built cfg can't make the loop fire every 1 ms (above
// 2^31-1 ms, setInterval does).
function startExposureAdapter(adapters, mode, cfg) {
  const adapter = adapters.exposure ?? null
  if (adapter !== null && mode !== 'tailscale') {
    throw new Error('adapters.exposure needs QA_EXPOSURE=tailscale: an ungated conductor must not publish itself')
  }
  const minutes = cfg.exposureIntervalMinutes ?? 5
  if (!isExposureInterval(minutes)) {
    const shown = typeof minutes === 'string' ? JSON.stringify(minutes) : String(minutes)
    throw new Error(`startConductor: cfg.exposureIntervalMinutes ${EXPOSURE_INTERVAL_RULE}, got ${shown}`)
  }
  return { adapter, intervalMs: minutes * 60_000 }
}

// A Mount as plain data. The adapter is platform code, so what it reports is
// copied before /api/exposure serializes it or state() clones it, keeping
// only the Mount type's own values: a string, or an integer port. Anything
// else (a URL object as the target, a function, a Symbol) becomes null, since
// structuredClone throws on some of those and JSON drops or garbles others.
const stringOrNull = v => (typeof v === 'string' ? v : null)
const plainMount = m => ({
  name: stringOrNull(m?.name), host: stringOrNull(m?.host), port: Number.isInteger(m?.port) ? m.port : null,
  path: stringOrNull(m?.path), target: stringOrNull(m?.target),
})
const mountKey = m => `${m.port}${m.path} -> ${m.target}`

// How a try to enrol paces the sweep or teardown it runs again: at most one
// such run every RETRY_GAP_MS, so tries in a loop (anything on loopback may
// send them) can't keep the Provisioner busy. A try waits up to
// ENROL_WAIT_MS for a sweep or teardown in flight, the one it started
// included, before it answers, so the try that starts one can enrol.
const RETRY_GAP_MS = 5_000
const ENROL_WAIT_MS = 3_000

// `capability` is the store of enrolled browsers (createCapability() from
// lib/capability.mjs), for tests; by default a fresh one, so a restart
// revokes every browser. `pacing` ({ retryGapMs, enrolWaitMs, now }) is for
// tests too. `platform` is process.platform, for the isolation verdict's
// floors (lib/isolation.mjs).
export function startConductor({
  cfg, github, fsx, adapters, readBaseEnv, publicDir = DEFAULT_PUBLIC_DIR, log = console, capability: caps = createCapability(),
  // a clock that only goes forward: the wall clock may stand or step back
  pacing: { retryGapMs = RETRY_GAP_MS, enrolWaitMs = ENROL_WAIT_MS, now = () => performance.now() } = {},
  platform = process.platform,
}) {
  const host = startHost(cfg)
  const startOrigin = startHarnessOrigin(cfg, host)
  const { mode: exposure, because } = startExposure(cfg, host, startOrigin)
  const { adapter: exposureAdapter, intervalMs: exposureIntervalMs } = startExposureAdapter(adapters, exposure, cfg)
  const inspectorRules = startInspector(adapters)
  // The browser cookies both pane proxies pass to the pane apps, checked
  // here so a bad value throws before the startup sweep runs.
  const forwardClientCookies = cookieNames(cfg.forwardClientCookies, 'startConductor: cfg.forwardClientCookies')
  startLayout(startOrigin, cfg.paneOrigins)
  // In tailscale mode every server answers only these logins
  // (lib/identity.mjs); an empty list refuses everyone. The gate wraps each
  // whole server handler, so no route runs for an unidentified request.
  // Nothing registers an 'upgrade' listener, so upgrades reach it too.
  const allowedLogins = normalizeLogins(cfg.allowedLogins)
  const gate = exposure === 'tailscale' ? handler => identityGate(handler, allowedLogins) : handler => handler
  if (exposure === 'tailscale') {
    // A cfg that names no mode says what gated it: a pane origin left unset
    // at start counts as off loopback, which a code-built cfg may not expect.
    const why = because ? ` (exposure defaults to tailscale because ${because} is not loopback)` : ''
    const n = allowedLogins.length
    log.log(`[qa] identity gate on${why}: ${n} allowed login${n === 1 ? '' : 's'}`)
    if (n === 0) {
      log.error("[qa] QA_ALLOWED_LOGINS is empty: every request will be refused; set cfg.allowedLogins, or exposure: 'none' if another front door authenticates")
    }
    // Gated, but published by someone else (a deploy script, say).
    if (exposureAdapter === null) log.log('[qa] exposure: tailscale serve mounts are managed outside the conductor')
  } else {
    log.log('[qa] identity gate off (QA_EXPOSURE=none)')
  }
  let session = createSession()
let buildRun = null
// AbortController for the in-flight boot. Teardown/takeover abort it so a
// stale boot can never write state or tear down a newer session's panes.
let bootAbort = null
// Each pane's reserved primary-service port for the ready session; the pane
// proxies route to it and answer 503 while it is null.
let upstreams = { base: null, pr: null }
const sseClients = new Map() // open event stream -> its browser's record
const progressLog = []
// Set by shutdown(): writes are refused, no boot starts, and a server whose
// listen completes afterwards closes at once.
let closing = false

// Remove orphans a previous conductor run left behind (e.g. a deploy restarted
// the conductor mid-session), if the Provisioner can. Boots wait for it: a
// session started while the sweep is still running would otherwise collide
// with the orphans' fixed names, or have its fresh containers and network
// removed by the sweep. Never rejects (a sweep that throws synchronously, or
// rejects with a non-Error, included), so a failed sweep doesn't block boots.
// It does keep enrolment shut, since an orphan may be running PR code, until
// it runs again and succeeds: retrySweep, when a browser tries to enrol with
// no session running. No timeout.
let sweeping = false
let sweepFailed = false
function runSweep() {
  sweeping = true
  return (async () => adapters.provisioner.sweep())()
    .then(() => log.log('[qa] startup sweep complete'), err => {
      sweepFailed = true
      log.error('[qa] startup sweep failed:', err?.message ?? String(err))
      log.error("[qa] new browsers can't enrol until the startup sweep succeeds; it runs again when one tries with no session running")
    })
    .catch(() => {}) // a logger that throws
    .finally(() => { sweeping = false })
}
let startupSweep = typeof adapters.provisioner.sweep === 'function' ? runSweep() : Promise.resolve()

// A boot waits for this pass as for the first, though none can start with it:
// it runs only with no session up and nothing in flight. True when it ran.
function retrySweep() {
  if (!sweepFailed || sweeping || closing || bootsInFlight > 0 || cleanup !== null) return false
  if (session.status !== 'idle' && session.status !== 'error') return false
  sweepFailed = false
  log.log('[qa] running the startup sweep again')
  startupSweep = runSweep()
  return true
}

// --- The enrolment window ---------------------------------------------------
// A browser may enrol only while no PR code can be running. That is from the
// moment a boot starts until a teardown that began once every boot had
// settled succeeds. Boots a teardown or takeover aborted count too: one may
// still be inside a Provisioner call that starts PR code after the teardown
// ran.
let bootsInFlight = 0 // started and not yet settled, aborted ones included
let ran = 0 // boots that reached bootSession and have settled
let cleanAt = 0 // `ran` when a teardown last left no pane running
let cleanup = null // the teardown after the last boot settled, in flight

// Why a browser may not enrol now, or null when it may. A try to enrol first
// runs a failed sweep, or a failed teardown, again (tryAgain), so the last two
// reasons stand only while that can't start.
function enrolmentShut() {
  if (closing) return 'the conductor is shutting down'
  if (sweeping) return 'the startup cleanup is still running'
  if (session.status === 'ready') return 'a session is running'
  if (session.status === 'tearing-down') return 'a session is ending'
  if (session.status !== 'idle' && session.status !== 'error') return 'a session is booting'
  if (bootsInFlight > 0) return 'a cancelled boot is still stopping'
  if (cleanup !== null) return 'cleaning up after the last boot'
  if (sweepFailed) return 'the startup cleanup failed: a try to enrol runs it again, at most once every few seconds'
  if (cleanAt !== ran) return 'the last teardown failed: a try to enrol runs it again, at most once every few seconds'
  return null
}

// A try to enrol with no session running runs again what failed: the sweep,
// which removes every pane, else the teardown after the last boot. At most
// one such run every retryGapMs, counted from its start and from its end.
let lastRetry = -Infinity
function tryAgain() {
  if (now() - lastRetry < retryGapMs) return
  const run = retrySweep() ? startupSweep : !sweeping && maybeCleanup() ? cleanup : null
  if (run === null) return
  // The gap runs from the start and again from the end: a run that took
  // longer than the gap to fail isn't run again the moment it has. Neither
  // run ever rejects.
  lastRetry = now()
  run.then(() => { lastRetry = now() })
}

// Resolves once no sweep or teardown (the startup sweep, a cleanup, or one a
// reviewer or the idle reaper started) is in flight, or after enrolWaitMs in
// all, or once `res` closes. One may follow another: a teardown's cleanup.
async function settling(res) {
  const until = now() + enrolWaitMs
  let waited = null
  for (;;) {
    const pending = sweeping ? startupSweep : cleanup ?? tearing
    const left = until - now()
    if (pending === null || pending === waited || left <= 0 || res.destroyed) return
    waited = pending
    await waitOn(pending, left, res)
  }
}

// Once the last boot in flight has settled, with no session up, tear the
// panes down if no teardown has since that boot ran: whatever it started
// after the last teardown goes now. A boot waits for this as for the sweep,
// since both remove panes by their fixed names, so none runs meanwhile; one
// that settled since would leave `ran` past `at`. Never rejects. True when it
// started one.
function maybeCleanup() {
  if (closing || cleanup !== null || bootsInFlight > 0 || cleanAt === ran) return false
  if (session.status !== 'idle' && session.status !== 'error') return false
  const at = ran
  cleanup = teardownSession({ provisioner: adapters.provisioner })
    .then(({ ok, failed }) => {
      if (ok) cleanAt = at
      if (!ok) log.error(`[qa] cleanup after the last boot failed (${teardownFailures(failed)}); new browsers can't enrol until a teardown succeeds`)
    })
    .catch(() => {}) // a logger that throws
    .finally(() => { cleanup = null })
  return true
}

function broadcast(event) {
  const stamped = { at: Date.now(), ...event }
  progressLog.push(stamped)
  const line = `data: ${JSON.stringify(stamped)}\n\n`
  for (const [res, browser] of sseClients) {
    // a stream is checked as it opens; its browser may be pushed out since
    if (caps.holds(browser)) { res.write(line); continue }
    sseClients.delete(res)
    res.end()
  }
}

// The origin viewers open the harness at. Without one at start, a loopback
// harness derives it from its bound port once listening; until then, and off
// loopback with no public host, it is null.
function harnessOrigin() {
  if (startOrigin !== null) return startOrigin
  return defaultHarnessOrigin({ publicHost: null, host, port: harness.listening ? harness.address().port : 0 })
}

// Hostnames (beyond loopback) the servers answer to. Read per request: a
// platform may assign cfg.paneOrigins after the proxies are listening.
function allowedHostnames() {
  const out = []
  if (cfg.publicHost) out.push(cfg.publicHost)
  const harnessAt = harnessOrigin()
  if (harnessAt) out.push(new URL(harnessAt).hostname)
  for (const origin of Object.values(cfg.paneOrigins ?? {})) {
    try { out.push(new URL(origin).hostname) } catch { /* not a URL: contributes nothing */ }
  }
  return out.concat(cfg.allowedHosts ?? [])
}

// loginUrls are each pane's establishSession result. The core reads only its
// landingUrl, which the harness loads in the pane's frame: a sign-in link,
// say, whose response sets the session cookie the proxy's jar keeps.
function paneUrls(loginUrls) {
  return {
    base: loginUrls.base.landingUrl,
    pr: loginUrls.pr.landingUrl,
    baseOrigin: cfg.paneOrigins.base,
    prOrigin: cfg.paneOrigins.pr,
  }
}

// `lastStep` is the step this boot already broadcast (startBoot sends
// ensuring-image before the sweep wait). A repeat isn't sent again: the
// harness times each step, and the boot, from its step event's `at`.
function sessionDeps(signal, lastStep = null) {
  return {
    signal,
    adapters,
    readBaseEnv,
    env: { operatorEmail: cfg.operatorEmail, paneOrigins: cfg.paneOrigins },
    onProgress: step => {
      if (signal.aborted) return
      session = reduce(session, { type: 'step', step })
      if (step === lastStep) return
      lastStep = step
      broadcast({ kind: 'step', step })
    },
    // Build progress: a CI run (runUrl/runStatus/runConclusion) and/or a
    // plain-text message.
    onBuild: ({ runUrl = null, runStatus = null, runConclusion = null, message = null } = {}) => {
      if (signal.aborted) return
      buildRun = { url: runUrl, status: runStatus, conclusion: runConclusion, message }
      broadcast({ kind: 'build', runUrl, runStatus, runConclusion, message })
    },
    checkIsolation: ({ stage }) => checkIsolation(stage, signal),
  }
}

// --- The isolation verdict ----------------------------------------------------
// Whether the PR pane can reach the base pane (lib/isolation.mjs): the
// Provisioner's declaration, or its check once both databases exist, never
// better than the runtime's floors. QA_REQUIRE_ISOLATION refuses a session
// that isn't isolated: as it starts when that is known then (a declaration,
// no check, a floor), else before anything of the PR's runs.
const runtimeFloors = floors({ host, platform })
let isolation = null // this session's verdict, once known
// The ready session's action log (#8), null otherwise: made at ready, gone
// at the next boot and at teardown, as the jars are. A request binds it as
// it starts, so a late one lands in its own session's.
let actions = null
// The ready session's data capture (#8), with an inspector, null otherwise:
// made for each boot, the session's at ready, and closed at the next boot
// and at teardown. Values in it reach only GET /api/data. `booting` is the
// in-flight boot's, which a teardown closes too.
let data = null
let booting = null
// The closes of boots that settled without becoming the session (failed,
// superseded or cancelled), which the next boot and teardown wait for.
const closingBoots = new Set()
// The probe's canary while a check runs: the harness answers its path, and
// only that, with its `expect`, before the identity gate (canaryRoute).
let canary = null

function recordIsolation(verdict) {
  isolation = { verdict: verdict.verdict, reasons: verdict.reasons, checkedAt: Date.now() }
  broadcast({ kind: 'isolation', verdict: isolation.verdict, reasons: isolation.reasons })
}

function refuseUnlessIsolated(verdict) {
  if (!cfg.requireIsolation || verdict.verdict === 'isolated') return
  throw new Error(`QA_REQUIRE_ISOLATION=1 refuses a session whose PR pane isn't isolated from the base pane (${verdict.verdict}: ${verdict.reasons.join('; ')})`)
}

// What is known before any check: the Provisioner's declaration (null when
// it has a check to run), a BuildConvention's, and the floors that apply.
function knownIsolation() {
  const decl = declared(adapters.provisioner)
  // A BuildConvention that runs the PR's code on this host to build it does
  // so in ensureBuilt, before any check: known at the start, whatever a
  // check later finds.
  const build = declaredBuild(adapters.build)
  // A Provisioner that runs no container gets no floor about containers.
  const floorsNow = decl?.verdict === 'shared-host' ? floors({ host, platform, containers: false }) : runtimeFloors
  return { decl, build, known: [...(build ? [build] : []), ...floorsNow] }
}

// Strict mode is set in the env file alone: say so, and say when nothing
// could ever pass it here.
if (cfg.requireIsolation) {
  log.log('[qa] QA_REQUIRE_ISOLATION on: a session whose PR pane isn\'t isolated from the base pane is refused')
  const { decl, known } = knownIsolation()
  const now = decl === null && known.length === 0 ? null : combine([...(decl ? [decl] : []), ...known])
  if (now !== null && now.verdict !== 'isolated') {
    log.error(`[qa] QA_REQUIRE_ISOLATION=1 refuses every session here (${now.verdict}: ${now.reasons.join('; ')})`)
  }
}

async function checkIsolation(stage, signal) {
  if (signal.aborted) return
  const { decl, build, known } = knownIsolation()
  if (stage === 'start') {
    if (decl === null && known.length === 0) return // the check decides
    const now = combine([...(decl ? [decl] : []), ...known])
    // with a check to come, say so now only if it won't run, or can't help
    if (decl !== null || build !== null || (cfg.requireIsolation && now.verdict !== 'isolated')) recordIsolation(now)
    return refuseUnlessIsolated(now)
  }
  if (decl !== null) return // declared: recorded at the start
  const nonce = randomBytes(16).toString('hex')
  const mine = { path: `/__qa/canary/${nonce}`, expect: `qa-canary ${nonce}` }
  canary = mine
  let result
  try {
    result = fromCheck(await adapters.provisioner.isolation({ signal, canary: { port: harness.address()?.port ?? cfg.ports.harness, ...mine } }))
  } catch (err) {
    if (signal.aborted) throw err
    result = { verdict: 'unknown', reasons: [`the isolation check failed: ${err?.message ?? String(err)}`] }
  } finally {
    if (canary === mine) canary = null
  }
  if (signal.aborted) return // superseded: the verdict is no session's
  const verdict = combine([result, ...known])
  recordIsolation(verdict)
  refuseUnlessIsolated(verdict)
}

// Answers the running check's canary path, and nothing else, before the
// identity gate: the probe has no login, and a container that reaches this
// port at a host address reaches the host's loopback.
const canaryRoute = handler => (req, res) => {
  if (canary !== null && req.method === 'GET' && req.url === canary.path) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(`${canary.expect}\n`)
  }
  return handler(req, res)
}

// A boot is counted from here until it settles, synchronously, so the
// enrolment window shuts before POST /api/session answers.
function startBoot(pr) {
  if (closing) return
  bootsInFlight++
  const others = bootsInFlight - 1
  runBoot(pr).then(
    outcome => bootSettled(outcome, others),
    () => bootSettled({ ran: true, tornDown: false }, others),
  )
}

// A failed boot tore its own panes down after its last step. When that
// worked, and no other boot was in flight as it started, nothing it or any
// other boot started is left: a boot that starts meanwhile aborts this one,
// whose error then says nothing of its teardown.
function bootSettled({ ran: didRun, tornDown }, others) {
  bootsInFlight--
  if (didRun) {
    ran++
    if (tornDown && others === 0) cleanAt = ran
  }
  maybeCleanup()
}

// Resolves to { ran, tornDown }: whether bootSession ran, and whether it
// failed and tore both panes down itself.
async function runBoot(pr) {
  bootAbort?.abort()
  const ac = new AbortController()
  bootAbort = ac
  // Detach the panes, with fresh jars and pane cookies, before booting: a session replaced
  // without a teardown (the same PR opened again, or another opened after an
  // error) must not stay reachable, cookies and all, while the new one boots.
  upstreams = { base: null, pr: null }
  freshPanes()
  actions = null
  // the last session's probes close before this boot goes on
  const closingCapture = endCapture()
  progressLog.length = 0
  buildRun = null
  isolation = null
  broadcast({ kind: 'step', step: 'ensuring-image' })
  const deps = sessionDeps(ac.signal, 'ensuring-image')
  // This boot's data capture: the session's once ready, else closed as the
  // boot settles. Its events say only which pane and phase, and whether it worked.
  const capture = inspectorRules === null ? null : createDataCapture({
    inspector: adapters.inspector,
    rules: inspectorRules,
    onCapture: ({ pane, phase, ok }) => { if (!ac.signal.aborted) broadcast({ kind: 'capture', pane, phase, ok }) },
  })
  deps.capture = capture
  booting = capture
  let started = false
  try {
    // Say so while the startup sweep holds the boot back, and once it's done,
    // so the message isn't left standing while the build runs.
    const waited = sweeping
    if (waited) deps.onBuild({ message: 'waiting for startup cleanup…' })
    await closingCapture
    await startupSweep
    if (ac.signal.aborted) return { ran: false } // torn down or taken over while waiting
    if (waited) deps.onBuild({ message: 'startup cleanup done' })
    await cleanup
    if (ac.signal.aborted) return { ran: false }
    started = true
    const out = await bootSession(deps, pr)
    if (ac.signal.aborted) return { ran: true } // superseded: result belongs to no session
    session = reduce(session, { type: 'tags', baseTag: out.baseTag, prTag: out.prTag })
    session = reduce(session, { type: 'ready', now: Date.now(), tokens: out.loginUrls })
    // This session's apps start from empty jars, and its panes take new pane
    // cookies, even when the last session was never torn down (the same PR
    // opened again). Its action log starts empty, before any request can
    // reach a pane.
    freshPanes()
    actions = createActionLog()
    data = capture
    booting = null
    upstreams = { base: out.upstreams?.base ?? null, pr: out.upstreams?.pr ?? null }
    broadcast({ kind: 'ready', pr, panes: paneUrls(out.loginUrls), baseTag: out.baseTag, prTag: out.prTag, isolation })
    return { ran: true }
  } catch (err) {
    if (ac.signal.aborted) return { ran: started } // superseded: must not touch the current session
    const step = session.status
    // A build error may carry the CI run that failed (createGithub's
    // awaitPreviewImage sets one): show it, so the run and its conclusion are
    // the last build progress, even from a BuildConvention that never
    // reported the run itself. A later stage's error says nothing about the build.
    const run = step === 'ensuring-image' ? failedRun(err) : null
    if (run) deps.onBuild({ runUrl: run.url, runStatus: run.status, runConclusion: run.conclusion })
    session = reduce(session, { type: 'error', step, message: String(err.message ?? err) })
    // bootSession read the failing pane's tail before tearing down; a
    // BuildConvention may attach one too. Else ask the Provisioner now.
    const logTail = typeof err?.logTail === 'string' ? err.logTail : await tailForStep(step).catch(() => '')
    broadcast({ kind: 'error', step, message: session.error?.message, logTail, runUrl: buildRun?.url ?? null })
    return { ran: started, tornDown: err?.tornDown === true }
  } finally {
    // superseded, failed or cancelled: its probes go now, and the next boot
    // waits for them (endCapture)
    if (booting === capture) booting = null
    if (capture !== null && data !== capture) closingBoots.add(capture.close().catch(() => {}))
  }
}

// Closes the session's data capture and the in-flight boot's, if any, and
// lets them go. Resolves once their probes are closed (each within a few
// seconds); never rejects.
function endCapture() {
  const ending = [data, booting].filter(c => c !== null)
  data = null
  booting = null
  const settling = [...closingBoots]
  closingBoots.clear()
  return Promise.all([...ending.map(c => c.close().catch(() => {})), ...settling])
}

// The run an error names as `err.run: {url, status, conclusion}`, its string
// fields only, or null when it names no url or status.
function failedRun(err) {
  const run = err?.run
  if (!run || typeof run !== 'object') return null
  const text = v => (typeof v === 'string' ? v : null)
  const out = { url: text(run.url), status: text(run.status), conclusion: text(run.conclusion) }
  return out.url || out.status ? out : null
}

// Best-effort log tail for a failed pane stage, if the Provisioner offers one.
// async so a synchronous logs() (return or throw) still yields a promise.
async function tailForStep(step) {
  if (!PANE_STAGES.includes(step) || typeof adapters.provisioner.logs !== 'function') return ''
  const tail = await adapters.provisioner.logs({ paneRef: { role: 'pr' }, stage: step, lines: 40 })
  return typeof tail === 'string' ? tail : ''
}

// A teardown that succeeds leaves clean what had run when it began (`at`).
// A boot it aborted, or one started meanwhile, that runs PR code settles to
// a `ran` past that, so maybeCleanup tears down again once it has; while it
// is in flight, enrolment stays shut anyway. `tearing` is the latest one in
// flight, settled or not as it did, for a try to enrol to wait on.
let tearing = null
function doTeardown() {
  const done = runTeardown()
  const settled = done.then(() => {}, () => {}).finally(() => { if (tearing === settled) tearing = null })
  tearing = settled
  return done
}

async function runTeardown() {
  const at = ran
  bootAbort?.abort()
  bootAbort = null
  upstreams = { base: null, pr: null }
  freshPanes()
  actions = null
  const closingCapture = endCapture()
  isolation = null // the verdict was that session's
  session = reduce(session, { type: 'teardown' })
  // the probes close before the panes they read go
  await closingCapture
  const { ok, failed } = await teardownSession({ provisioner: adapters.provisioner })
  if (ok) cleanAt = at
  session = reduce(session, { type: 'torn-down' })
  buildRun = null
  broadcast({ kind: 'torn-down' })
  maybeCleanup()
  if (!ok) log.error(`[qa] teardown failed (${teardownFailures(failed)}); new browsers can't enrol until a teardown succeeds`)
}

function sessionSummary() {
  return { pr: session.pr, status: session.status, startedAt: session.startedAt, lastActivity: session.lastActivity }
}

// A POST's JSON body as an object, {} when it is empty, not JSON or not an
// object. Rejects with a 413 error past MAX_BODY bytes, declared or sent,
// buffering no more: POST /api/enrol reads one before any capability check.
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) return reject(bodyTooLarge())
    const chunks = []
    let size = 0
    let over = false
    req.on('data', chunk => {
      if (over) return // dropped, unread, until the 413 closes the connection
      size += chunk.length
      if (size <= MAX_BODY) return chunks.push(chunk)
      over = true
      chunks.length = 0
      reject(bodyTooLarge())
    })
    req.on('end', () => {
      if (over) return
      let value
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { value = {} }
      resolve(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    })
    req.on('error', reject)
  })
}

const bodyTooLarge = () => Object.assign(new Error('request body too large'), { status: 413 })

function json(res, status, body, headers = {}) {
  sendJson(res, status, JSON.stringify(body), headers)
}
function sendJson(res, status, buf, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(buf), ...headers })
  res.end(buf)
}
// What a session's capture is answered with: nothing of it kept by a cache.
const NO_STORE = { 'cache-control': 'no-store' }

async function serveStatic(res, file, type) {
  try {
    const buf = await fsx.readFile(path.join(publicDir, file))
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(buf)
  } catch {
    res.writeHead(404).end('not found')
  }
}

// Build readiness per PR from the BuildConvention, if it can describe it.
// Failures and a missing describePrs degrade to 'none' (the picker still works).
async function describePrs(prs) {
  if (typeof adapters.build.describePrs !== 'function') return new Map()
  try {
    return new Map((await adapters.build.describePrs(prs)).map(d => [d.number, d]))
  } catch {
    return new Map()
  }
}

// The open-PR list, enriched with build readiness. `reason` explains a
// 'blocked' status (e.g. an untrusted head) in plain text.
async function enrichedPrs() {
  const prs = await github.listOpenPrs()
  const readiness = await describePrs(prs)
  return prs.map(pr => ({
    number: pr.number, title: pr.title, headRef: pr.headRef, author: pr.author,
    imageStatus: readiness.get(pr.number)?.status ?? 'none',
    runUrl: readiness.get(pr.number)?.runUrl ?? null,
    reason: readiness.get(pr.number)?.reason ?? null,
  }))
}

// The describePrs item for one PR: with trust data when github can give it.
async function prForDescribe(pr) {
  if (typeof github.prInfo !== 'function') return { number: pr, headSha: await github.prHead(pr) }
  const { headSha, author, authorAssociation, headRepo, headOwner } = await github.prInfo(pr)
  return { number: pr, headSha, author, authorAssociation, headRepo, headOwner }
}

// Refusals that apply before any harness route runs (the Host check runs
// earlier still, before the URL is parsed). Returns true when the request was
// answered.
function refused(req, res, p) {
  // Every API request, reads and the event stream too, must come from the
  // harness page itself: another page can't read the answers, but its writes
  // would run, and each /api/prs or /api/build-status spends GitHub API calls
  // on the conductor's token. The page itself (/ and /harness.js) stays open
  // to any navigation.
  if (p.startsWith('/api/')) {
    if (!isSameOriginRequest(req.headers)) {
      json(res, 403, { error: 'cross-site request refused' })
      return true
    }
    // The harness page shows its banner from harnessOrigin. No other page can
    // read the answer, and the origin is no secret: every pane sends it.
    if (!isHarnessHost(req.headers, harnessOrigin())) {
      json(res, 403, { error: 'not the harness origin', harnessOrigin: harnessOrigin() })
      return true
    }
  }
  const write = req.method !== 'GET' && req.method !== 'HEAD'
  // A write accepted during shutdown could start a boot nothing tears down.
  if (write && closing) {
    json(res, 503, { error: 'shutting down' })
    return true
  }
  if (req.method === 'POST' && JSON_ROUTES.has(p) && !isJsonRequest(req.headers)) {
    json(res, 415, { error: 'content-type must be application/json' })
    return true
  }
  return false
}

// The enrolled browser a harness request comes from, by its X-QA-Cap header,
// or null. The event stream also takes the token as ?cap=, since EventSource
// can't send a header; no other route does.
function enrolledBrowser(req, url, p) {
  const header = req.headers[CAP_HEADER]
  if (typeof header === 'string') return caps.browser(header)
  return req.method === 'GET' && p === '/api/progress' ? caps.browser(url.searchParams.get('cap')) : null
}

// A 403 for want of the capability, marked X-QA-Refusal: capability, and in
// the body too: a pane proxy in front, as self-QA nests a harness in an outer
// pane, drops that header. The body names the harness origin, for the banner
// of a harness opened at another.
function refuseCapability(res, body) {
  const buf = JSON.stringify({ ...body, refusal: REFUSAL_CAPABILITY, harnessOrigin: harnessOrigin() })
  res.writeHead(403, {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(buf), 'cache-control': 'no-store', 'x-qa-refusal': REFUSAL_CAPABILITY,
  })
  res.end(buf)
}

// Who enrolled a browser, for the log: the Tailscale login in tailscale mode.
const enroller = req => (exposure === 'tailscale' ? `${String(req.headers['tailscale-user-login'] ?? '').trim()}; ` : '')

// Set before any handler runs, so every harness response carries them: the
// identity gate's 403s, the 421s and other 403s, errors and the event stream.
// No harness response sets its own Content-Security-Policy to merge with.
const harnessHeaders = handler => (req, res) => {
  for (const [name, value] of Object.entries(HARNESS_FRAME_HEADERS)) res.setHeader(name, value)
  // per request: a platform may assign cfg.paneOrigins once the proxies listen
  res.setHeader('content-security-policy', harnessPolicy(cfg.paneOrigins))
  return handler(req, res)
}

// Likewise for each pane, so a response the proxy doesn't make itself (the
// identity gate's 403) still carries the pane's frame policy. The proxy's own
// responses send the policy through writeHead, whose headers take precedence.
const paneHeaders = handler => (req, res) => {
  res.setHeader('content-security-policy', panePolicy(harnessOrigin(), cfg.frameAncestors ?? []))
  res.setHeader('x-content-type-options', 'nosniff')
  return handler(req, res)
}

const harness = http.createServer(harnessHeaders(canaryRoute(gate(async (req, res) => {
  if (!isAllowedHost(req.headers.host, allowedHostnames())) return misdirected(res)
  // A request target like `//x:99999` is not a parseable URL; left uncaught it
  // rejects this async handler and takes the process down.
  let url
  try { url = new URL(req.url, 'http://x') } catch { return json(res, 400, { error: 'bad request target' }) }
  // tailscale serve --set-path may or may not strip the /qa prefix; accept both.
  const p = url.pathname.replace(/^\/qa(?=\/|$)/, '') || '/'
  try {
    if (refused(req, res, p)) return
    if (req.method === 'POST' && p === '/api/enrol') {
      const { invite } = await readBody(req)
      if (invite !== undefined) {
        const token = caps.redeemInvite(invite)
        if (token === null) return refuseCapability(res, { error: 'this invite link has expired or was already used' })
        log.log(`[qa] a browser enrolled with an invite (${enroller(req)}${caps.size()} enrolled)`)
        return json(res, 200, { token })
      }
      tryAgain()
      await settling(res)
      const reason = enrolmentShut()
      if (reason !== null) return refuseCapability(res, { error: `enrolment is closed: ${reason}`, reason })
      const token = caps.enrol()
      log.log(`[qa] a browser enrolled (${enroller(req)}${caps.size()} enrolled)`)
      return json(res, 200, { token })
    }
    // Every other API route, read or write, the event stream and routes
    // that don't exist included, needs an enrolled browser.
    const browser = p.startsWith('/api/') ? enrolledBrowser(req, url, p) : null
    if (p.startsWith('/api/') && browser === null) {
      return refuseCapability(res, { error: 'this browser is not enrolled: open the harness to enrol it' })
    }
    if (req.method === 'GET' && p === '/') return await serveStatic(res, 'index.html', 'text/html; charset=utf-8')
    if (req.method === 'GET' && p === '/harness.js') return await serveStatic(res, 'harness.js', 'text/javascript')
    if (req.method === 'POST' && p === '/api/invite') {
      const origin = harnessOrigin()
      if (origin === null) return json(res, 409, { error: 'no harness origin to invite a browser to (set QA_HARNESS_ORIGIN)' })
      const { ticket, expiresAt } = caps.invite()
      return json(res, 200, { url: `${origin}${HARNESS_PATH}/#enrol=${ticket}`, expiresAt })
    }
    // A one-time link that sets the pane cookie, for the harness to load the
    // pane in its iframe at `to`.
    if (req.method === 'POST' && p === '/api/pane-entry') {
      const { role, to = '/' } = await readBody(req)
      if (role !== 'base' && role !== 'pr') return json(res, 400, { error: 'role must be base or pr' })
      let pane
      try { pane = webOrigin(cfg.paneOrigins?.[role]) } catch { return json(res, 409, { error: `the ${role} pane has no origin yet` }) }
      const problem = layoutProblem(harnessOrigin(), pane, role)
      if (problem !== null) return json(res, 409, { error: problem })
      const path = panePath(to, pane)
      if (path === null) return json(res, 400, { error: `to must be a path on the ${role} pane` })
      return json(res, 200, { url: `${pane}${ENTER_ROUTE}?t=${caps.enter(browser, role, path)}` })
    }
    if (req.method === 'GET' && p === '/api/state') {
      return json(res, 200, {
        status: session.status, pr: session.pr, error: session.error,
        baseTag: session.baseTag, prTag: session.prTag,
        startedAt: session.startedAt, lastActivity: session.lastActivity, idleMinutes: cfg.idleMinutes,
        buildRun,
        panes: session.status === 'ready' && session.tokens ? paneUrls(session.tokens) : null,
        isolation,
        requireIsolation: Boolean(cfg.requireIsolation),
        data: { available: inspectorRules !== null },
        harnessOrigin: harnessOrigin(),
      })
    }
    // The ready session's data checks, with values (masked where they may be
    // secret): for the harness only, never the event stream, a log or GitHub.
    // Reading them is no activity.
    if (req.method === 'GET' && p === '/api/data') {
      if (inspectorRules === null) return json(res, 200, { available: false }, NO_STORE)
      if (data === null) return json(res, 200, { available: true, active: false }, NO_STORE)
      // built once for each state, however many read it
      return sendJson(res, 200, data.viewJson({ isolation }), NO_STORE)
    }
    // Snapshot now, or re-baseline (`rebaseline: true`): an explicit action,
    // so activity. Answers with the data checks, as GET /api/data does; 409
    // when the session ends meanwhile.
    if (req.method === 'POST' && p === '/api/data/snapshot') {
      const { rebaseline = false } = await readBody(req)
      if (typeof rebaseline !== 'boolean') return json(res, 400, { error: 'rebaseline must be true or false' })
      if (inspectorRules === null) return json(res, 409, { error: 'the conductor has no inspector' })
      const mine = data
      if (mine === null) return json(res, 409, { error: 'no session is ready' })
      session = touch(session, Date.now())
      try {
        await mine.snapshot({ rebaseline })
      } catch (err) {
        return json(res, err?.status === 409 ? 409 : 500, { error: String(err?.message ?? err) })
      }
      if (data !== mine) return json(res, 409, { error: 'the session ended while the snapshot was taken' })
      return sendJson(res, 200, mine.viewJson({ isolation }), NO_STORE)
    }
    // The ready session's action log, after a sequence number. Reading it is
    // no activity: an open Actions view mustn't keep the session alive.
    if (req.method === 'GET' && p === '/api/actions') {
      const after = Number(url.searchParams.get('after') ?? 0)
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const out = (actions ?? createActionLog()).read(after, { limit })
      return json(res, 200, { active: actions !== null, ...out, log: actions === null ? null : out.log }, NO_STORE)
    }
    // A mark for an action the harness relayed from a pane's bridge: the pane
    // and the kind of action, nothing more. No activity either: PR code can
    // post bridge messages.
    if (req.method === 'POST' && p === '/api/actions/mark') {
      const { pane, type } = await readBody(req)
      if (pane !== 'base' && pane !== 'pr') return json(res, 400, { error: 'pane must be base or pr' })
      if (!MARK_TYPES.includes(type)) return json(res, 400, { error: `type must be one of ${MARK_TYPES.join(', ')}` })
      if (actions === null) return json(res, 409, { error: 'no session is ready' })
      return json(res, 200, { recorded: actions.mark(pane, type) !== null }, NO_STORE)
    }
    if (req.method === 'GET' && p === '/api/prs') {
      const prs = await enrichedPrs()
      return json(res, 200, { prs, session: sessionSummary() })
    }
    // The last reconcile pass, as recorded: it never calls the front door.
    if (req.method === 'GET' && p === '/api/exposure') return json(res, 200, exposureView())
    if (req.method === 'GET' && p === '/api/build-status') {
      const pr = Number(url.searchParams.get('pr'))
      if (!Number.isInteger(pr)) return json(res, 400, { error: 'pr required' })
      let d = null
      try {
        d = (await describePrs([await prForDescribe(pr)])).get(pr) ?? null
      } catch { /* return what we have */ }
      const status = d?.status ?? 'none'
      const body = { pr, status, exists: status === 'built', runUrl: d?.runUrl ?? null }
      // Only a blocked status adds a field, so the shape is otherwise unchanged.
      if (status === 'blocked') body.reason = String(d.reason ?? '')
      return json(res, 200, body)
    }
    if (req.method === 'GET' && p === '/api/progress') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      for (const e of progressLog) res.write(`data: ${JSON.stringify(e)}\n\n`)
      sseClients.set(res, browser)
      req.on('close', () => sseClients.delete(res))
      return
    }
    if (req.method === 'POST' && p === '/api/session') {
      const { pr, takeover } = await readBody(req)
      if (!Number.isInteger(pr)) return json(res, 400, { error: 'pr (number) required' })
      const active = session.status !== 'idle' && session.status !== 'error'
      if (active && session.pr !== pr && !takeover) {
        return json(res, 409, { error: `session already active (pr #${session.pr}, ${session.status})`, session: sessionSummary() })
      }
      if (active && takeover) await doTeardown()
      // shutdown() may have begun while the takeover teardown ran
      if (closing) return json(res, 503, { error: 'shutting down' })
      session = reduce(session, { type: 'open', pr })
      startBoot(pr)
      return json(res, 202, { ok: true })
    }
    if (req.method === 'GET' && p === '/api/verdict/preview') {
      if (session.pr == null) return json(res, 409, { error: 'no session' })
      const verdict = url.searchParams.get('verdict')
      if (verdict !== 'accept' && verdict !== 'reject') return json(res, 400, { error: 'verdict must be accept|reject' })
      const notes = url.searchParams.get('notes') ?? ''
      const durationMin = session.startedAt ? Math.round((Date.now() - session.startedAt) / 60000) : 0
      const body = formatVerdict({ verdict, notes, pr: session.pr, baseTag: session.baseTag, prTag: session.prTag, durationMin })
      const { accept, reject } = cfg.verdictLabels
      const applies = verdict === 'accept' ? accept : reject
      const removes = verdict === 'accept' ? reject : accept
      return json(res, 200, { body, applies, removes })
    }
    if (req.method === 'POST' && p === '/api/verdict') {
      const { verdict, notes } = await readBody(req)
      if (session.pr == null) return json(res, 409, { error: 'no session' })
      if (verdict !== 'accept' && verdict !== 'reject') return json(res, 400, { error: 'verdict must be accept|reject' })
      const durationMin = session.startedAt ? Math.round((Date.now() - session.startedAt) / 60000) : 0
      const body = formatVerdict({ verdict, notes: notes ?? '', pr: session.pr, baseTag: session.baseTag, prTag: session.prTag, durationMin })
      const url2 = await github.postComment(session.pr, body)
      await github.setQaLabel(session.pr, verdict === 'accept' ? cfg.verdictLabels.accept : cfg.verdictLabels.reject)
      return json(res, 200, { url: url2 })
    }
    if (req.method === 'POST' && p === '/api/teardown') {
      await doTeardown()
      return json(res, 200, { ok: true })
    }
    res.writeHead(404).end('not found')
  } catch (err) {
    // the rest of an oversized body is left unread: close the connection on it
    if (err?.status === 413) res.setHeader('connection', 'close')
    json(res, err?.status === 413 ? 413 : 500, { error: String(err?.message ?? err) })
  }
}))))

  const onActivity = () => { session = touch(session, Date.now()) }
  const bridgePath = path.join(publicDir, 'bridge.js')
  // Each pane proxy's handler, whose jar holds the cookies its app set.
  const paneHandlers = {}
  const paneProxy = (role) => {
    paneHandlers[role] = createPaneProxy({
      upstreamPort: () => upstreams[role],
      bridgePath,
      onActivity,
      httpMod: http,
      allowedHosts: allowedHostnames,
      harnessOrigin,
      frameAncestors: cfg.frameAncestors ?? [],
      forwardClientCookies,
      // The action log of the session a request starts in, if one is ready.
      recorder: () => {
        const log = actions
        return log === null ? null : entry => log.record(role, entry)
      },
      onRefused: reason => actions?.refused(role, reason),
      // One pane cookie per browser, which both panes take: on one hostname
      // the browser sends each pane both anyway.
      capability: {
        cookieName: () => paneCookieName(harnessOrigin(), cfg.paneOrigins?.[role]),
        admits: value => caps.admitsPane(value),
        enter: ticket => {
          const out = caps.redeemEnter(ticket, role)
          return out && { to: out.to, value: out.paneToken }
        },
      },
    })
    return http.createServer(paneHeaders(gate(paneHandlers[role])))
  }
  // When a session is torn down, when the next boots and when it is ready:
  // - a jar outlives the session whose app filled it: emptied, so no PR's
  //   app gets the cookies another session's app set;
  // - every browser gets a new pane token, so a pane cookie an app may have
  //   seen (on plain-http loopback, cookies ignore ports) dies with its
  //   session. The harness enters each pane afresh once a session is ready.
  function freshPanes() {
    for (const handler of Object.values(paneHandlers)) handler.clearJar()
    caps.rotatePanes()
  }
  const baseProxy = paneProxy('base')
  const prProxy = paneProxy('pr')
  const servers = { harness, baseProxy, prProxy }

  const reaper = setInterval(() => {
    if (isIdle(session, Date.now(), cfg.idleMinutes * 60_000)) {
      log.log('[qa] idle session — tearing down')
      doTeardown().catch(err => log.error('[qa] teardown failed:', err.message))
    }
  }, 60_000)

  // --- Exposure: the reconcile loop -------------------------------------------
  // With an adapter, the conductor owns its front-door mounts. It reconciles
  // once all three servers listen, so the targets are the bound ports, then
  // every exposureIntervalMinutes on an unref()ed timer. One pass at a time,
  // so a hung CLI never stacks processes; none once stop() or shutdown()
  // begins, and neither waits for one in flight. Nothing ever removes a
  // mount. A pass never throws: its result is recorded for /api/exposure and
  // state(), and logged only when it changes.
  let exposureState = { mode: exposure, managed: exposureAdapter !== null, ok: null, checkedAt: null, drift: [], added: [], error: null }
  const exposureView = () => structuredClone(exposureState)
  let exposureStarted = false // all three servers are listening
  let exposureEnded = false // stop() or shutdown() began
  let exposureTimer = null
  let reconciling = null // the pass in flight
  let exposureStatus = null // the last ok / drift / failed line
  // Mounts this conductor has had in place, so a rewrite of one is a restore.
  const mountsInPlace = new Set()
  let resolveExposureReady
  const exposureReady = new Promise(resolve => { resolveExposureReady = resolve })
  if (exposureAdapter === null) resolveExposureReady(exposureView())

  // mountsFor runs every pass: a platform may assign cfg.paneOrigins after
  // start. Its throw is a layout no front door can publish, recorded like an
  // adapter error (reconcileExposure never rejects).
  async function exposurePass() {
    const ports = { harness: harness.address()?.port, base: baseProxy.address()?.port, pr: prProxy.address()?.port }
    let mounts = []
    let result
    try {
      mounts = mountsFor({ ...cfg, harnessOrigin: harnessOrigin() }, { ports })
    } catch (err) {
      result = { ok: false, checkedAt: Date.now(), drift: [], added: [], error: String(err.message).replace(/^exposure: /, '') }
    }
    result ??= await reconcileExposure(exposureAdapter, mounts)
    recordExposure(mounts, result)
  }

  function recordExposure(mounts, result) {
    const added = result.added.map(plainMount)
    const drift = result.drift.map(d => ({ mount: plainMount(d?.mount), actual: typeof d?.actual === 'string' ? d.actual : null }))
    exposureState = { mode: exposure, managed: true, ok: result.ok === true, checkedAt: result.checkedAt, drift, added, error: result.error }
    for (const m of added) {
      log.log(`[qa] exposure ${mountsInPlace.has(mountKey(m)) ? 'restored' : 'mounted'} ${mountKey(m)}`)
      mountsInPlace.add(mountKey(m))
    }
    // ensure wrote every mount that wasn't in place, or failed: after an
    // error-free pass, all of them were.
    if (result.error === null) for (const m of mounts) mountsInPlace.add(mountKey(m))
    const status = result.error !== null ? `failed: ${result.error}`
      : exposureState.ok ? 'ok'
        : `drift remains: ${[...new Set(drift.map(d => `${d.mount.port}${d.mount.path}`))].join(', ') || '(the adapter named no mount)'}`
    if (status === exposureStatus) return
    exposureStatus = status
    if (status === 'ok') log.log('[qa] exposure ok')
    else log.error(`[qa] exposure ${status}`)
  }

  // One pass, or the one in flight. Before the servers listen there are no
  // targets yet: that is the first pass, so it returns `ready`, which waits
  // for it (or settles when stop() or shutdown() begins first).
  function reconcileNow() {
    if (exposureAdapter === null || exposureEnded) return Promise.resolve(exposureView())
    if (!exposureStarted) return exposureReady
    // A pass rejects only when the platform's logger throws, and then there
    // is nowhere to report it; the next tick tries again.
    reconciling ??= exposurePass().catch(() => {}).then(() => {
      reconciling = null
      return exposureView()
    })
    return reconciling
  }

  // The loop's own calls end their chains, so nothing a pass does can become
  // an unhandled rejection, which would take the process down.
  function beginReconcileLoop() {
    exposureStarted = true
    if (exposureAdapter === null || exposureEnded) return
    reconcileNow().then(resolveExposureReady, () => resolveExposureReady(exposureState))
    exposureTimer = setInterval(() => { reconcileNow().catch(() => {}) }, exposureIntervalMs)
    exposureTimer.unref()
  }

  // `ready` settles here when no pass has: before the servers listen, or
  // with the first pass still in flight.
  function endExposure() {
    exposureEnded = true
    clearInterval(exposureTimer)
    resolveExposureReady(exposureView())
  }

  let listening = 0
  function listen(server, port, label) {
    server.listen(port, host, () => {
      if (closing) return server.close()
      log.log(`[qa] ${label} on ${hostPort(host, server.address().port)}`)
      if (server === harness) logHarnessOrigin()
      if (++listening === Object.keys(servers).length) beginReconcileLoop()
    })
  }

  function logHarnessOrigin() {
    const origin = harnessOrigin()
    if (origin) log.log(`[qa] harness at ${origin}${HARNESS_PATH}/`)
    else log.error('[qa] no harness origin (set QA_HARNESS_ORIGIN): only a pane can frame itself and the mirror is off')
    // panePolicy leaves an IPv6 literal out (a CSP source can't name one), so
    // no harness could frame the panes. A `::1` bind derives one.
    const hostname = origin ? new URL(origin).hostname : ''
    if (hostname.startsWith('[')) {
      log.error(
        `[qa] the harness origin ${origin} is an IPv6 literal, which frame-ancestors cannot name: ` +
          `the panes will stay blank; set QA_HARNESS_ORIGIN=${origin.replace(hostname, 'localhost')}, and both pane origins on localhost too`,
      )
    }
  }
  listen(harness, cfg.ports.harness, 'harness')
  listen(baseProxy, cfg.ports.base, 'base pane proxy')
  listen(prProxy, cfg.ports.pr, 'pr pane proxy')

  // Stop accepting, drop keep-alive and SSE sockets, resolve once closed.
  function closeServer(server) {
    return new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  let shuttingDown = null
  async function shutdown() {
    closing = true
    clearInterval(reaper)
    endExposure()
    await doTeardown()
    // closing keeps new boots out; this catches any that slipped in anyway.
    if (bootAbort) await doTeardown()
    for (const res of sseClients.keys()) res.end()
    sseClients.clear()
    await Promise.all(Object.values(servers).map(closeServer))
  }

  return {
    servers,
    stop() {
      clearInterval(reaper)
      endExposure()
      harness.close()
      baseProxy.close()
      prProxy.close()
    },
    // Graceful exit for CLIs (call it on SIGINT/SIGTERM): tears the session
    // down (aborting an in-flight boot) and closes all three servers.
    shutdown() {
      shuttingDown ??= shutdown()
      return shuttingDown
    },
    // The reconcile loop. `ready` resolves with the state after the first
    // pass, or as it stands once stop() or shutdown() begins first (at once
    // with no adapter); state() is the last pass, as GET /api/exposure
    // reports it; reconcile() runs a pass now, or joins the one in flight,
    // and before the servers listen returns `ready`.
    exposure: {
      ready: exposureReady,
      state: exposureView,
      reconcile: reconcileNow,
    },
  }
}
