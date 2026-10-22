// Session state machine + boot/teardown pipeline for PR-QA previews.
// Pure reducer (unit-tested) + an orchestration function whose effectful
// collaborators (the five adapters, readBaseEnv) are injected.

// The two side-by-side panes. Everything else about a pane (containers,
// ports, env files, public origins) belongs to the Provisioner or to config.
export const ROLES = ['base', 'pr']

const ACTIVE = ['ensuring-image', 'cloning', 'migrating', 'starting', 'ready', 'tearing-down']
const STEPS = ['ensuring-image', 'cloning', 'migrating', 'starting']
// Boot stages that run against a provisioned pane, where a log tail makes sense.
export const PANE_STAGES = ['cloning', 'migrating', 'starting']

export function createSession() {
  return {
    status: 'idle',
    pr: null,
    baseTag: null,
    prTag: null,
    startedAt: null,
    lastActivity: 0,
    error: null,
    tokens: null,
  }
}

export function reduce(s, event) {
  switch (event.type) {
    case 'open':
      if (s.status !== 'idle' && s.status !== 'error') return s
      return { ...createSession(), status: 'ensuring-image', pr: event.pr }
    case 'step':
      if (!ACTIVE.includes(s.status) || !STEPS.includes(event.step)) return s
      return { ...s, status: event.step }
    case 'tags':
      return { ...s, baseTag: event.baseTag ?? s.baseTag, prTag: event.prTag ?? s.prTag }
    case 'ready':
      if (s.status !== 'starting') return s
      return { ...s, status: 'ready', startedAt: event.now, lastActivity: event.now, tokens: event.tokens }
    case 'error':
      if (s.status === 'idle') return s
      return { ...s, status: 'error', error: { step: event.step, message: event.message } }
    case 'teardown':
      if (s.status === 'idle') return s
      return { ...s, status: 'tearing-down' }
    case 'torn-down':
      return createSession()
    default:
      return s
  }
}

export function touch(s, now) {
  return { ...s, lastActivity: now }
}

export function isIdle(s, now, idleMs) {
  return s.status === 'ready' && now - s.lastActivity > idleMs
}

// --- env-file derivation --------------------------------------------------

export function parseEnv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    out[t.slice(0, i)] = t.slice(i + 1)
  }
  return out
}

// Deriving a pane's env is app policy: it lives in the consumer's EnvTransform.

export function renderEnv(env) {
  return `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

// Derive the migrate companion image for an app image tag (a helper for
// BuildConventions that publish `migrate-<tag>` images):
//   ghcr.io/x/app:1.0.0-rc.38   -> ghcr.io/x/app:migrate-1.0.0-rc.38
//   ghcr.io/x/app:pr-7-abc123   -> ghcr.io/x/app:migrate-pr-7-abc123
export function migrateImageFor(appImage) {
  const i = appImage.lastIndexOf(':')
  return `${appImage.slice(0, i)}:migrate-${appImage.slice(i + 1)}`
}

// --- boot + teardown ------------------------------------------------------

// v3 orchestrator: composes the five seams. The core owns ordering,
// cancellation and failure cleanup; it never touches docker, the filesystem
// or a registry. deps:
//   adapters    — { provisioner, build, seed, envTransform, auth }
//   env         — { operatorEmail, paneOrigins: { base, pr } }
//   readBaseEnv? — async () => env map the pane env is derived from (say,
//                  production's env file). Default: {}.
//   onProgress, onBuild?
//   checkIsolation? — async ({ stage, signal }): the conductor's isolation
//             verdict. Called with stage 'start' as the boot starts, before
//             the build, and 'panes' once both panes' databases exist and
//             before either is seeded, migrated or launched. A throw fails
//             the boot there.
//   capture?    — the data checks' capture (lib/data-capture.mjs), from an
//             optional inspector: capture.seeded({paneRef, db, databases,
//             signal}) right after each pane's seedPane, with the same db,
//             before anything of the PR's runs on it, and
//             capture.ready({signal}) once every pane is signed in, before
//             the boot returns. It never fails the boot, and an aborted boot
//             calls it no more.
//   signal?     — AbortSignal. The caller aborts it when the session is torn down
//             or taken over. bootSession checks it between stages, between
//             panes, between provisionDatabase and the Seed, before each
//             launch and before each sign-in. It threads it into
//             build.ensureBuilt(pr, {signal}), every Provisioner call
//             (provisionDatabase, reserveServices, runMigrate, launchServices,
//             waitHealthy), seed.seedPane and auth.establishSession, so long
//             waits exit and a Seed or sign-in can stop between its steps.
//             Adapters may ignore it.
// Build progress is surfaced through build.subscribeBuild when the adapter
// offers it; a missing hook is a no-op.
//
// Every seam member's result is awaited, so any may be async: spread
// unawaited, an async derivePaneEnv or envContributions would leave the panes
// without its env, side-effect neutralisation included.
//
// Returns { baseTag, prTag, loginUrls, upstreams }: upstreams are each pane's
// reserved primary-service port (`app`, else the first service), which the
// pane proxies route to. A tag is the resolve* result's `label` when it gives
// one, else the primary service's ref.
//
// A failed (not aborted) boot annotates the error before tearing down: the
// failing pane's log tail as `err.logTail` (read while the pane still exists)
// and its role as `err.failedRole`; then, once it has torn both panes down,
// `err.tornDown`: true when both teardowns succeeded.
//
// An ABORTED boot never tears down: whoever aborted it already did, and a
// newer session may now own the deterministic pane resources. (2026-09-25
// incident: a stale boot stuck in ensureBuilt survived /api/teardown, then its
// failure path destroyed the next session's containers.)
export async function bootSession(deps, prNumber) {
  const { adapters, env, readBaseEnv = async () => ({}), onProgress, onBuild, signal, checkIsolation, capture = null } = deps
  const { provisioner, build, seed, envTransform, auth } = adapters
  const checkpoint = () => {
    if (signal?.aborted) throw Object.assign(new Error('boot aborted'), { name: 'AbortError' })
  }
  // The data checks are a reviewer's aid: whatever happens to them, the boot goes on.
  const quietly = async run => {
    if (capture === null || signal?.aborted) return
    try { await run() } catch { /* the capture says why its pane has no data */ }
  }
  // Where the boot is, so a failure can name its pane and read that pane's logs.
  let stage = null
  let role = null
  const enter = next => { stage = next; role = null; onProgress(next) }
  try {
    enter('ensuring-image')
    if (checkIsolation) await checkIsolation({ stage: 'start', signal })
    if (onBuild && typeof build.subscribeBuild === 'function') await build.subscribeBuild(onBuild)
    await build.ensureBuilt(prNumber, { signal })
    checkpoint()
    const imagesByRole = { base: await build.resolveBaseImages(), pr: await build.resolvePrImages(prNumber) }

    checkpoint()
    enter('cloning')
    const panes = []
    for (const r of ROLES) {
      checkpoint()
      role = r
      const ref = { role, slug: `qa-${prNumber}-${role}`, publicOrigin: env.paneOrigins[role] }
      const { dsn, db } = await provisioner.provisionDatabase({ paneRef: ref, databases: seed.databases, signal })
      panes.push({ ref, dsn, db, publicOrigin: ref.publicOrigin })
    }
    // Both databases exist, nothing has been copied into them yet, and
    // nothing of the PR's has run: the moment to check whether the PR pane
    // can reach the base pane. A strict refusal here copies no data.
    if (checkIsolation) {
      checkpoint()
      role = null
      await checkIsolation({ stage: 'panes', signal })
    }
    for (const pane of panes) {
      // An abort during provisioning, or the check, may have handed this
      // pane's name to the next session: don't seed whatever database now
      // answers to it.
      checkpoint()
      role = pane.ref.role
      // The signal too, so a Seed can stop between its steps.
      await seed.seedPane({ paneRef: pane.ref, db: pane.db, databases: seed.databases, signal })
      await quietly(() => capture.seeded({ paneRef: pane.ref, db: pane.db, databases: seed.databases, signal }))
      checkpoint()
      pane.services = await provisioner.reserveServices({ paneRef: pane.ref, services: imagesByRole[role].services, signal })
    }

    checkpoint()
    enter('migrating')
    const prodEnv = await readBaseEnv()
    const authEnv = typeof auth.envContributions === 'function' ? await auth.envContributions() : {}
    for (const pane of panes) {
      role = pane.ref.role
      pane.env = mergeEnv(await envTransform.derivePaneEnv({ prodEnv, pane }), authEnv)
      const { migrate } = imagesByRole[pane.ref.role]
      if (build.migrationStrategy === 'one-shot-image' && migrate) {
        if (typeof provisioner.runMigrate !== 'function') {
          throw new Error('build uses one-shot-image migrations but the provisioner has no runMigrate')
        }
        await provisioner.runMigrate({ paneRef: pane.ref, migrate, env: pane.env, signal })
      }
    }

    checkpoint()
    enter('starting')
    for (const pane of panes) {
      checkpoint()
      role = pane.ref.role
      await provisioner.launchServices({
        paneRef: pane.ref,
        services: imagesByRole[pane.ref.role].services,
        env: pane.env,
        reserved: pane.services,
        signal,
      })
    }
    checkpoint()
    for (const pane of panes) {
      role = pane.ref.role
      await provisioner.waitHealthy({ services: pane.services, signal })
    }

    checkpoint()
    const loginUrls = {}
    for (const pane of panes) {
      // A sign-in may write the pane's database: not after an abort.
      checkpoint()
      role = pane.ref.role
      const args = { pane, operator: env.operatorEmail, signal, ...(auth.requiresDb ? { db: pane.db } : {}) }
      loginUrls[pane.ref.role] = await auth.establishSession(args)
    }
    await quietly(() => capture.ready({ signal }))
    const upstreams = {}
    for (const pane of panes) upstreams[pane.ref.role] = pane.services[primaryService(pane.services)]?.port ?? null
    return { baseTag: displayTag(imagesByRole.base), prTag: displayTag(imagesByRole.pr), loginUrls, upstreams }
  } catch (err) {
    if (!signal?.aborted) {
      await annotateFailure(err, { provisioner, stage, role })
      // The log read is async (docker logs): an abort that lands during it
      // means a newer session may own the deterministic panes now.
      if (!signal?.aborted) {
        const { ok } = await teardownSession({ provisioner })
        if (err && typeof err === 'object') err.tornDown = ok
      }
    }
    throw err
  }
}

// Attach the failing pane's log tail and role to a boot error. Runs BEFORE
// teardown, because a Provisioner's logs usually die with its pane. An error
// that already carries a tail (e.g. a BuildConvention's install output) keeps
// it, and a failing logs() never masks the boot error.
async function annotateFailure(err, { provisioner, stage, role }) {
  if (!err || typeof err !== 'object') return
  const wantsTail = PANE_STAGES.includes(stage) && role && typeof err.logTail !== 'string'
  if (wantsTail && typeof provisioner.logs === 'function') {
    try {
      const tail = await provisioner.logs({ paneRef: { role }, stage, lines: 40 })
      if (typeof tail === 'string') err.logTail = tail
    } catch { /* no tail */ }
  }
  err.failedRole = role
}

// The service a pane's proxy fronts and whose image identifies the pane.
function primaryService(services) {
  return 'app' in services ? 'app' : Object.keys(services)[0]
}

// What the header and the verdict comment call a pane: the BuildConvention's
// label when it gives one (needed when refs are paths or objects), else the
// primary service's ref.
function displayTag(images) {
  if (typeof images.label === 'string' && images.label) return images.label
  return images.services[primaryService(images.services)]
}

function mergeEnv(perService, contributions) {
  const out = { ...perService }
  for (const [svc, extra] of Object.entries(contributions)) out[svc] = { ...(out[svc] ?? {}), ...extra }
  return out
}

// Resolves to { ok, failed }: ok when every pane's teardown resolved, else
// failed names each pane whose teardown threw or rejected, with its message.
// Never rejects.
export async function teardownSession({ provisioner }) {
  // The Provisioner removes everything it created for each pane (containers,
  // network, env files, managed branches); teardown is idempotent for panes
  // that never came up. A teardown that throws, rejects or returns no promise
  // never stops the next pane's.
  const failed = []
  for (const role of ROLES) {
    try {
      await provisioner.teardown({ paneRef: { role } })
    } catch (err) {
      // it failed: the next pane goes regardless
      failed.push({ role, message: errorMessage(err) })
    }
  }
  return { ok: failed.length === 0, failed }
}

function errorMessage(err) {
  try {
    return String(err?.message ?? err)
  } catch {
    return 'an error that is not an Error'
  }
}
