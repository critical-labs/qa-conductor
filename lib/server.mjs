// PR-QA conductor core: harness UI/API + pane proxies, composed over the five
// adapter seams. This module owns NO app, infra or registry policy: a
// consuming platform constructs {cfg, github, fsx, adapters, readBaseEnv} and
// calls startConductor. Containers, env files and log tails belong to the
// Provisioner; PR readiness belongs to the BuildConvention (describePrs);
// origins, ports and verdict labels are config. `github` is used for the PR
// list, PR head lookups and the verdict comment + label.
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createPaneProxy } from './proxy.mjs'
import { formatVerdict } from './verdict.mjs'
import {
  createSession, reduce, touch, isIdle, bootSession, teardownSession,
} from './session.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PUBLIC_DIR = path.join(HERE, '..', 'public')
// Boot stages that run against a provisioned pane (log tails make sense).
const PANE_STAGES = ['cloning', 'migrating', 'starting']

export function startConductor({ cfg, github, fsx, adapters, readBaseEnv, publicDir = DEFAULT_PUBLIC_DIR, log = console }) {
  let session = createSession()
let buildRun = null
// AbortController for the in-flight boot. Teardown/takeover abort it so a
// stale boot can never write state or tear down a newer session's panes.
let bootAbort = null
// Each pane's reserved primary-service port for the ready session; the pane
// proxies route to it and answer 503 while it is null.
let upstreams = { base: null, pr: null }
const sseClients = new Set()
const progressLog = []

function broadcast(event) {
  const stamped = { at: Date.now(), ...event }
  progressLog.push(stamped)
  const line = `data: ${JSON.stringify(stamped)}\n\n`
  for (const res of sseClients) res.write(line)
}

// loginUrls are per-pane SessionResults from the AuthBootstrap adapter; the
// landingUrl carries the magic-link token (homefree's degenerate case — no
// cookies/replay needed by the proxy yet).
function paneUrls(loginUrls) {
  return {
    base: loginUrls.base.landingUrl,
    pr: loginUrls.pr.landingUrl,
    baseOrigin: cfg.paneOrigins.base,
    prOrigin: cfg.paneOrigins.pr,
  }
}

function sessionDeps(signal) {
  return {
    signal,
    adapters,
    readBaseEnv,
    env: { operatorEmail: cfg.operatorEmail, paneOrigins: cfg.paneOrigins },
    onProgress: step => {
      if (signal.aborted) return
      session = reduce(session, { type: 'step', step })
      broadcast({ kind: 'step', step })
    },
    onBuild: ({ runUrl, runStatus }) => {
      if (signal.aborted) return
      buildRun = { url: runUrl, status: runStatus }
      broadcast({ kind: 'build', runUrl, runStatus })
    },
  }
}

async function startBoot(pr) {
  bootAbort?.abort()
  const ac = new AbortController()
  bootAbort = ac
  progressLog.length = 0
  buildRun = null
  broadcast({ kind: 'step', step: 'ensuring-image' })
  try {
    const out = await bootSession(sessionDeps(ac.signal), pr)
    if (ac.signal.aborted) return // superseded: result belongs to no session
    session = reduce(session, { type: 'tags', baseTag: out.baseTag, prTag: out.prTag })
    session = reduce(session, { type: 'ready', now: Date.now(), tokens: out.loginUrls })
    upstreams = { base: out.upstreams?.base ?? null, pr: out.upstreams?.pr ?? null }
    broadcast({ kind: 'ready', pr, panes: paneUrls(out.loginUrls), baseTag: out.baseTag, prTag: out.prTag })
  } catch (err) {
    if (ac.signal.aborted) return // superseded: must not touch the current session
    const step = session.status
    session = reduce(session, { type: 'error', step, message: String(err.message ?? err) })
    const logTail = await tailForStep(step).catch(() => '')
    broadcast({ kind: 'error', step, message: session.error?.message, logTail, runUrl: buildRun?.url ?? null })
  }
}

// Best-effort log tail for a failed pane stage, if the Provisioner offers one.
function tailForStep(step) {
  if (!PANE_STAGES.includes(step) || typeof adapters.provisioner.logs !== 'function') return Promise.resolve('')
  return adapters.provisioner.logs({ paneRef: { role: 'pr' }, stage: step, lines: 40 })
}

async function doTeardown() {
  bootAbort?.abort()
  bootAbort = null
  upstreams = { base: null, pr: null }
  session = reduce(session, { type: 'teardown' })
  await teardownSession({ provisioner: adapters.provisioner }).catch(() => {})
  session = reduce(session, { type: 'torn-down' })
  buildRun = null
  broadcast({ kind: 'torn-down' })
}

function sessionSummary() {
  return { pr: session.pr, status: session.status, startedAt: session.startedAt, lastActivity: session.lastActivity }
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

function json(res, status, body) {
  const buf = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(buf) })
  res.end(buf)
}

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

// The open-PR list, enriched with build readiness.
async function enrichedPrs() {
  const prs = await github.listOpenPrs()
  const readiness = await describePrs(prs)
  return prs.map(pr => ({
    number: pr.number, title: pr.title, headRef: pr.headRef, author: pr.author,
    imageStatus: readiness.get(pr.number)?.status ?? 'none',
    runUrl: readiness.get(pr.number)?.runUrl ?? null,
  }))
}

const harness = http.createServer(async (req, res) => {
  // tailscale serve --set-path may or may not strip the /qa prefix; accept both.
  const url = new URL(req.url, 'http://x')
  const p = url.pathname.replace(/^\/qa(?=\/|$)/, '') || '/'
  try {
    if (req.method === 'GET' && p === '/') return await serveStatic(res, 'index.html', 'text/html; charset=utf-8')
    if (req.method === 'GET' && p === '/harness.js') return await serveStatic(res, 'harness.js', 'text/javascript')
    if (req.method === 'GET' && p === '/api/state') {
      return json(res, 200, {
        status: session.status, pr: session.pr, error: session.error,
        baseTag: session.baseTag, prTag: session.prTag,
        startedAt: session.startedAt, lastActivity: session.lastActivity, idleMinutes: cfg.idleMinutes,
        buildRun,
        panes: session.status === 'ready' && session.tokens ? paneUrls(session.tokens) : null,
      })
    }
    if (req.method === 'GET' && p === '/api/prs') {
      const prs = await enrichedPrs()
      return json(res, 200, { prs, session: sessionSummary() })
    }
    if (req.method === 'GET' && p === '/api/build-status') {
      const pr = Number(url.searchParams.get('pr'))
      if (!Number.isInteger(pr)) return json(res, 400, { error: 'pr required' })
      let d = null
      try {
        d = (await describePrs([{ number: pr, headSha: await github.prHead(pr) }])).get(pr) ?? null
      } catch { /* return what we have */ }
      const status = d?.status ?? 'none'
      return json(res, 200, { pr, status, exists: status === 'built', runUrl: d?.runUrl ?? null })
    }
    if (req.method === 'GET' && p === '/api/progress') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      for (const e of progressLog) res.write(`data: ${JSON.stringify(e)}\n\n`)
      sseClients.add(res)
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
    json(res, 500, { error: String(err.message ?? err) })
  }
})

  const onActivity = () => { session = touch(session, Date.now()) }
  const bridgePath = path.join(publicDir, 'bridge.js')
  const baseProxy = http.createServer(createPaneProxy({ upstreamPort: () => upstreams.base, bridgePath, onActivity, httpMod: http }))
  const prProxy = http.createServer(createPaneProxy({ upstreamPort: () => upstreams.pr, bridgePath, onActivity, httpMod: http }))

  const reaper = setInterval(() => {
    if (isIdle(session, Date.now(), cfg.idleMinutes * 60_000)) {
      log.log('[qa] idle session — tearing down')
      doTeardown().catch(err => log.error('[qa] teardown failed:', err.message))
    }
  }, 60_000)

  // Remove orphans a previous conductor run left behind, if the Provisioner can.
  if (typeof adapters.provisioner.sweep === 'function') {
    adapters.provisioner.sweep()
      .then(() => log.log('[qa] startup sweep complete'))
      .catch(err => log.error('[qa] startup sweep failed:', err.message))
  }

  harness.listen(cfg.ports.harness, () => log.log(`[qa] harness on :${cfg.ports.harness}`))
  baseProxy.listen(cfg.ports.base, () => log.log(`[qa] base pane proxy on :${cfg.ports.base}`))
  prProxy.listen(cfg.ports.pr, () => log.log(`[qa] pr pane proxy on :${cfg.ports.pr}`))

  return {
    servers: { harness, baseProxy, prProxy },
    stop() {
      clearInterval(reaper)
      harness.close()
      baseProxy.close()
      prProxy.close()
    },
  }
}
