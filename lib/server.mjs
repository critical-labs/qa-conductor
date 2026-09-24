// PR-QA conductor core: harness UI/API + pane proxies, composed over the five
// frozen adapter seams (spike adapters-v3). This module owns NO app policy —
// a consuming platform constructs {cfg, github, docker, fsx, adapters} and
// calls startConductor. (Known residual coupling, tracked for extraction
// Stage 2: enrichedPrs/build-status endpoints assume the pr-<N>-<sha12> tag
// scheme, and the verdict endpoints assume the qa-approved/-changes-requested
// label pair — both belong behind the BuildConvention/verdict surface.)
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createPaneProxy } from './proxy.mjs'
import { formatVerdict } from './verdict.mjs'
import {
  createSession, reduce, touch, isIdle, bootSession, teardownSession, PANES,
} from './session.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PUBLIC_DIR = path.join(HERE, '..', 'public')

export function startConductor({ cfg, github, docker, fsx, adapters, publicDir = DEFAULT_PUBLIC_DIR, log = console }) {
  const PUBLIC_HOST = cfg.publicHost

  let session = createSession()
let buildRun = null
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
    baseOrigin: `https://${PUBLIC_HOST}:${PANES.base.publicPort}`,
    prOrigin: `https://${PUBLIC_HOST}:${PANES.pr.publicPort}`,
  }
}

function sessionDeps() {
  return {
    adapters,
    docker,
    fsx,
    env: {
      composeDir: cfg.composeDir,
      operatorEmail: cfg.operatorEmail,
      publicHost: PUBLIC_HOST,
      ghcrUser: cfg.ghcrUser,
      ghcrToken: cfg.githubToken,
    },
    onProgress: step => {
      session = reduce(session, { type: 'step', step })
      broadcast({ kind: 'step', step })
    },
    onBuild: ({ runUrl, runStatus }) => {
      buildRun = { url: runUrl, status: runStatus }
      broadcast({ kind: 'build', runUrl, runStatus })
    },
  }
}

async function startBoot(pr) {
  progressLog.length = 0
  buildRun = null
  broadcast({ kind: 'step', step: 'ensuring-image' })
  try {
    const out = await bootSession(sessionDeps(), pr)
    session = reduce(session, { type: 'tags', baseTag: out.baseTag, prTag: out.prTag })
    session = reduce(session, { type: 'ready', now: Date.now(), tokens: out.loginUrls })
    broadcast({ kind: 'ready', pr, panes: paneUrls(out.loginUrls), baseTag: out.baseTag, prTag: out.prTag })
  } catch (err) {
    const step = session.status
    session = reduce(session, { type: 'error', step, message: String(err.message ?? err) })
    const logTail = await tailForStep(step).catch(() => '')
    broadcast({ kind: 'error', step, message: session.error?.message, logTail, runUrl: buildRun?.url ?? null })
  }
}

// Best-effort container log tail for a failed boot step.
function tailForStep(step) {
  const container = step === 'cloning' ? PANES.pr.pg : step === 'migrating' ? PANES.pr.pg : step === 'starting' ? PANES.pr.app : null
  if (!container) return Promise.resolve('')
  return docker.logsTail(container, 40)
}

async function doTeardown() {
  session = reduce(session, { type: 'teardown' })
  await teardownSession({ provisioner: adapters.provisioner, fsx, composeDir: cfg.composeDir }, null).catch(() => {})
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

// Enrich the open-PR list with image status (one GHCR pagination) and, for
// PRs without an image, a best-effort in-flight build lookup.
async function enrichedPrs() {
  const prs = await github.listOpenPrs()
  let tags = new Set()
  try { tags = new Set(await github.listPrImageTags()) } catch { /* leave empty → all 'none' */ }
  const enriched = prs.map(pr => {
    const short = (pr.headSha || '').slice(0, 12)
    const imageTag = `pr-${pr.number}-${short}`
    const built = short && tags.has(imageTag)
    return { number: pr.number, title: pr.title, headRef: pr.headRef, author: pr.author, imageTag, imageStatus: built ? 'built' : 'none', runUrl: null }
  })
  const unbuilt = enriched.filter(p => p.imageStatus === 'none').slice(0, 8)
  await Promise.all(unbuilt.map(async p => {
    try {
      const run = await github.findPreviewRun(p.number)
      if (run && run.status !== 'completed') { p.imageStatus = 'building'; p.runUrl = run.url }
    } catch { /* ignore */ }
  }))
  return enriched
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
      let exists = false; let tag = null; let run = null
      try {
        const head = await github.prHead(pr)
        tag = `pr-${pr}-${head.slice(0, 12)}`
        exists = await github.ghcrTagExists(tag)
        if (!exists) { const r = await github.findPreviewRun(pr); if (r) run = { url: r.url, status: r.status, startedAt: r.startedAt } }
      } catch { /* return what we have */ }
      return json(res, 200, { tag, exists, run })
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
      const applies = verdict === 'accept' ? 'qa-approved' : 'qa-changes-requested'
      const removes = verdict === 'accept' ? 'qa-changes-requested' : 'qa-approved'
      return json(res, 200, { body, applies, removes })
    }
    if (req.method === 'POST' && p === '/api/verdict') {
      const { verdict, notes } = await readBody(req)
      if (session.pr == null) return json(res, 409, { error: 'no session' })
      if (verdict !== 'accept' && verdict !== 'reject') return json(res, 400, { error: 'verdict must be accept|reject' })
      const durationMin = session.startedAt ? Math.round((Date.now() - session.startedAt) / 60000) : 0
      const body = formatVerdict({ verdict, notes: notes ?? '', pr: session.pr, baseTag: session.baseTag, prTag: session.prTag, durationMin })
      const url2 = await github.postComment(session.pr, body)
      await github.setQaLabel(session.pr, verdict === 'accept' ? 'qa-approved' : 'qa-changes-requested')
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
  const baseProxy = http.createServer(createPaneProxy({ upstreamPort: PANES.base.hostPort, bridgePath, onActivity, httpMod: http }))
  const prProxy = http.createServer(createPaneProxy({ upstreamPort: PANES.pr.hostPort, bridgePath, onActivity, httpMod: http }))

  const reaper = setInterval(() => {
    if (isIdle(session, Date.now(), cfg.idleMinutes * 60_000)) {
      log.log('[qa] idle session — tearing down')
      doTeardown().catch(err => log.error('[qa] teardown failed:', err.message))
    }
  }, 60_000)

  docker.sweepQaContainers()
    .then(() => log.log('[qa] startup sweep complete'))
    .catch(err => log.error('[qa] startup sweep failed:', err.message))

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
