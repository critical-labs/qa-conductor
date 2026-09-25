// Session state machine + boot/teardown pipeline for PR-QA previews.
// Pure reducer (unit-tested) + an orchestration function whose effectful
// collaborators (github, docker, mint, fsx) are injected.

export const NETWORK = 'qa-session'
export const DBS = ['idp', 'userdb', 'homedb', 'socialdb', 'addressdb', 'emaildb', 'admindb']
export const PANES = {
  base: { pg: 'qa-pg-base', app: 'qa-app-base', hostPort: 3111, envFile: '.env.qa-base', publicPort: 8443 },
  pr: { pg: 'qa-pg-pr', app: 'qa-app-pr', hostPort: 3112, envFile: '.env.qa-pr', publicPort: 10000 },
}

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

// paneEnv moved to lib/adapters/env-homefree.mjs (the EnvTransform seam) —
// the derivation is app policy, not conductor mechanics.

export function renderEnv(env) {
  return `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

// Derive the migrate image for an app image tag:
//   ghcr.io/x/homefree-app:1.0.0-rc.38   -> ghcr.io/x/homefree-app:migrate-1.0.0-rc.38
//   ghcr.io/x/homefree-app:pr-7-abc123   -> ghcr.io/x/homefree-app:migrate-pr-7-abc123
export function migrateImageFor(appImage) {
  const i = appImage.lastIndexOf(':')
  return `${appImage.slice(0, i)}:migrate-${appImage.slice(i + 1)}`
}

// --- boot + teardown ------------------------------------------------------

// v3 orchestrator (extraction Stage 1a): composes the five frozen seams
// (spike/adapters-v3.mjs). deps:
//   adapters: { provisioner, build, seed, envTransform, auth }
//   docker  — core-retained for registry login and the one-shot migrate run
//             (core-owned for homefree per the frozen interface)
//   fsx     — { readFile, writeFile, unlink }
//   env     — { composeDir, operatorEmail, publicHost, ghcrUser?, ghcrToken? }
//   onProgress, onBuild?
//   signal? — AbortSignal. The caller aborts it when the session is torn down
//             or taken over. bootSession checks it between stages and threads
//             it into build.ensureBuilt(pr, {signal}) so long GHCR waits exit.
// Build progress is surfaced through build.subscribeBuild when the adapter
// offers it; a missing hook is a no-op (the #186 pattern).
//
// An ABORTED boot never tears down: whoever aborted it already did, and a
// newer session may now own the deterministic pane container names. (2026-09-25
// incident: a stale boot stuck in ensureBuilt survived /api/teardown, then its
// failure path destroyed the next session's containers.)
export async function bootSession(deps, prNumber) {
  const { adapters, docker, fsx, env, onProgress, onBuild, signal } = deps
  const { provisioner, build, seed, envTransform, auth } = adapters
  const checkpoint = () => {
    if (signal?.aborted) throw Object.assign(new Error('boot aborted'), { name: 'AbortError' })
  }
  try {
    onProgress('ensuring-image')
    // Fresh GHCR login every boot: pane pulls must not depend on a stale
    // manually-seeded host credential (bit us live: expired token -> pull 401).
    if (env.ghcrToken) await docker.login(env.ghcrUser, env.ghcrToken)
    if (onBuild && typeof build.subscribeBuild === 'function') build.subscribeBuild(onBuild)
    await build.ensureBuilt(prNumber, { signal })
    checkpoint()
    const imagesByRole = { base: await build.resolveBaseImages(), pr: await build.resolvePrImages(prNumber) }

    checkpoint()
    onProgress('cloning')
    const panes = []
    for (const [role, cfg] of Object.entries(PANES)) {
      const ref = { role, slug: `qa-${prNumber}-${role}`, publicOrigin: `https://${env.publicHost}:${cfg.publicPort}` }
      const { dsn, db } = await provisioner.provisionDatabase({ paneRef: ref, databases: seed.databases })
      await seed.seedPane({ paneRef: ref, db, databases: seed.databases })
      const services = await provisioner.reserveServices({ paneRef: ref, services: imagesByRole[role].services })
      panes.push({ ref, dsn, db, services, publicOrigin: ref.publicOrigin, envFile: `${env.composeDir}/${cfg.envFile}` })
    }

    checkpoint()
    onProgress('migrating')
    const prodEnv = parseEnv(await fsx.readFile(`${env.composeDir}/.env`))
    const authEnv = typeof auth.envContributions === 'function' ? auth.envContributions() : {}
    const ensureOpts = env.ghcrToken ? { relogin: () => docker.login(env.ghcrUser, env.ghcrToken) } : {}
    for (const pane of panes) {
      const derived = envTransform.derivePaneEnv({ prodEnv, pane })
      pane.env = mergeEnv(derived, authEnv)
      // The core materializes the pane env file: the one-shot migrate below and
      // the Provisioner's launch both read it, and teardown must scrub it.
      await fsx.writeFile(pane.envFile, renderEnv(pane.env.app), { mode: 0o600 })
      const { migrate } = imagesByRole[pane.ref.role]
      if (build.migrationStrategy === 'one-shot-image' && migrate) {
        await docker.ensureImage(migrate.image, ensureOpts)
        await docker.runMigrate(migrate.image, provisioner.network ?? NETWORK, pane.envFile)
      }
    }

    checkpoint()
    onProgress('starting')
    for (const pane of panes) {
      await provisioner.launchServices({
        paneRef: pane.ref,
        services: imagesByRole[pane.ref.role].services,
        envFiles: { app: pane.envFile },
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
    return { baseTag: imagesByRole.base.services.app, prTag: imagesByRole.pr.services.app, loginUrls }
  } catch (err) {
    if (!signal?.aborted) {
      await teardownSession({ provisioner, fsx, composeDir: env.composeDir }, null).catch(() => {})
    }
    throw err
  }
}

function mergeEnv(perService, contributions) {
  const out = { ...perService }
  for (const [svc, extra] of Object.entries(contributions)) out[svc] = { ...(out[svc] ?? {}), ...extra }
  return out
}

export async function teardownSession({ provisioner, fsx, composeDir }, _created) {
  // Provisioner owns removing everything it created (containers + network),
  // per pane; teardown is idempotent for panes that never came up.
  for (const role of Object.keys(PANES)) {
    await provisioner.teardown({ paneRef: { role } }).catch(() => {})
  }
  // Always remove the deterministic pane env files: they carry prod-derived
  // secrets and must not linger at rest between sessions.
  if (composeDir) {
    for (const pane of Object.values(PANES)) {
      await fsx.unlink(`${composeDir}/${pane.envFile}`).catch(() => {})
    }
  }
}
