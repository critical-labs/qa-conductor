// Session state machine + boot/teardown pipeline for PR-QA previews.
// Pure reducer (unit-tested) + an orchestration function whose effectful
// collaborators (the five adapters, readBaseEnv) are injected.

// The two side-by-side panes. Everything else about a pane (containers,
// ports, env files, public origins) belongs to the Provisioner or to config.
export const ROLES = ['base', 'pr']

const ACTIVE = ['ensuring-image', 'cloning', 'migrating', 'starting', 'ready', 'tearing-down']
const STEPS = ['ensuring-image', 'cloning', 'migrating', 'starting']

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
//   readBaseEnv? — async () => env map the pane env is derived from (homefree:
//                  the prod stack's .env). Default: {}.
//   onProgress, onBuild?
//   signal?     — AbortSignal. The caller aborts it when the session is torn down
//             or taken over. bootSession checks it between stages and threads
//             it into build.ensureBuilt(pr, {signal}) so long build waits exit.
// Build progress is surfaced through build.subscribeBuild when the adapter
// offers it; a missing hook is a no-op (the #186 pattern).
//
// Returns { baseTag, prTag, loginUrls, upstreams }: upstreams are each pane's
// reserved primary-service port (`app`, else the first service), which the
// pane proxies route to.
//
// An ABORTED boot never tears down: whoever aborted it already did, and a
// newer session may now own the deterministic pane resources. (2026-09-25
// incident: a stale boot stuck in ensureBuilt survived /api/teardown, then its
// failure path destroyed the next session's containers.)
export async function bootSession(deps, prNumber) {
  const { adapters, env, readBaseEnv = async () => ({}), onProgress, onBuild, signal } = deps
  const { provisioner, build, seed, envTransform, auth } = adapters
  const checkpoint = () => {
    if (signal?.aborted) throw Object.assign(new Error('boot aborted'), { name: 'AbortError' })
  }
  try {
    onProgress('ensuring-image')
    if (onBuild && typeof build.subscribeBuild === 'function') build.subscribeBuild(onBuild)
    await build.ensureBuilt(prNumber, { signal })
    checkpoint()
    const imagesByRole = { base: await build.resolveBaseImages(), pr: await build.resolvePrImages(prNumber) }

    checkpoint()
    onProgress('cloning')
    const panes = []
    for (const role of ROLES) {
      const ref = { role, slug: `qa-${prNumber}-${role}`, publicOrigin: env.paneOrigins[role] }
      const { dsn, db } = await provisioner.provisionDatabase({ paneRef: ref, databases: seed.databases })
      await seed.seedPane({ paneRef: ref, db, databases: seed.databases })
      const services = await provisioner.reserveServices({ paneRef: ref, services: imagesByRole[role].services })
      panes.push({ ref, dsn, db, services, publicOrigin: ref.publicOrigin })
    }

    checkpoint()
    onProgress('migrating')
    const prodEnv = await readBaseEnv()
    const authEnv = typeof auth.envContributions === 'function' ? auth.envContributions() : {}
    for (const pane of panes) {
      pane.env = mergeEnv(envTransform.derivePaneEnv({ prodEnv, pane }), authEnv)
      const { migrate } = imagesByRole[pane.ref.role]
      if (build.migrationStrategy === 'one-shot-image' && migrate) {
        if (typeof provisioner.runMigrate !== 'function') {
          throw new Error('build uses one-shot-image migrations but the provisioner has no runMigrate')
        }
        await provisioner.runMigrate({ paneRef: pane.ref, migrate, env: pane.env })
      }
    }

    checkpoint()
    onProgress('starting')
    for (const pane of panes) {
      await provisioner.launchServices({
        paneRef: pane.ref,
        services: imagesByRole[pane.ref.role].services,
        env: pane.env,
        reserved: pane.services,
      })
    }
    for (const pane of panes) await provisioner.waitHealthy({ services: pane.services })

    checkpoint()
    const loginUrls = {}
    for (const pane of panes) {
      const args = { pane, operator: env.operatorEmail, ...(auth.requiresDb ? { db: pane.db } : {}) }
      loginUrls[pane.ref.role] = await auth.establishSession(args)
    }
    const upstreams = {}
    for (const pane of panes) upstreams[pane.ref.role] = pane.services[primaryService(pane.services)]?.port ?? null
    const tag = role => imagesByRole[role].services[primaryService(imagesByRole[role].services)]
    return { baseTag: tag('base'), prTag: tag('pr'), loginUrls, upstreams }
  } catch (err) {
    if (!signal?.aborted) await teardownSession({ provisioner }).catch(() => {})
    throw err
  }
}

// The service a pane's proxy fronts and whose image identifies the pane.
function primaryService(services) {
  return 'app' in services ? 'app' : Object.keys(services)[0]
}

function mergeEnv(perService, contributions) {
  const out = { ...perService }
  for (const [svc, extra] of Object.entries(contributions)) out[svc] = { ...(out[svc] ?? {}), ...extra }
  return out
}

export async function teardownSession({ provisioner }) {
  // The Provisioner removes everything it created for each pane (containers,
  // network, env files, managed branches); teardown is idempotent for panes
  // that never came up.
  for (const role of ROLES) {
    await provisioner.teardown({ paneRef: { role } }).catch(() => {})
  }
}
