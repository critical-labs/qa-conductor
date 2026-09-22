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

export function paneEnv(prodEnv, pane, { publicHost, blob }) {
  const env = { ...prodEnv }
  const origin = `https://${publicHost}:${pane.publicPort}`
  env.CI_POSTGRES_URL = `postgresql://homefree:qa@${pane.pg}:5432`
  env.POSTGRES_USER = 'homefree'
  env.POSTGRES_PASSWORD = 'qa'
  env.POSTGRES_DB = 'postgres'
  env.APP_DOMAIN = publicHost
  env.WEB_CLIENT_URL = origin
  env.WEBAUTHN_RP_ID = publicHost
  env.WEBAUTHN_EXPECTED_ORIGINS = origin
  env.AUTH_REFRESH_ORIGIN = 'http://127.0.0.1:3000'
  env.EMAIL_ADAPTER = 'console'
  // QA media Space, never the prod bucket: override when configured, else strip
  // so uploads fail visibly instead of polluting homefree-media.
  for (const k of Object.keys(env)) if (k.startsWith('BLOB_S3_')) delete env[k]
  if (blob?.bucket) {
    env.BLOB_S3_BUCKET = blob.bucket
    env.BLOB_S3_ENDPOINT = blob.endpoint
    env.BLOB_S3_ACCESS_KEY_ID = blob.accessKeyId
    env.BLOB_S3_SECRET_ACCESS_KEY = blob.secretAccessKey
  }
  return env
}

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

// deps: { github, docker, mint, fsx: {readFile, writeFile, unlink}, env:
//   { composeDir, imageRepo, operatorEmail, publicHost, blob }, onProgress }
export async function bootSession(deps, prNumber) {
  const { github, docker, mint, fsx, env, onProgress } = deps
  const created = { containers: [], network: false, envFiles: [] }
  try {
    onProgress('ensuring-image')
    const sha = await github.prHead(prNumber)
    const prTag = `pr-${prNumber}-${sha.slice(0, 12)}`
    if (!(await github.ghcrTagExists(prTag))) {
      await github.dispatchPreviewBuild(prNumber)
      await github.awaitPreviewImage(prNumber, sha)
    }
    // The migrate image is pushed after the app image in the same build; wait
    // for it too so runMigrate can't race a half-pushed build (bounded ~6 min).
    const sleepFn = deps.sleepFn ?? (ms => new Promise(r => setTimeout(r, ms)))
    for (let i = 0; !(await github.ghcrTagExists(`migrate-${prTag}`)); i++) {
      if (i >= 24) throw new Error(`migrate image migrate-${prTag} not in GHCR after build`)
      await sleepFn(15000)
    }
    let baseImage = null
    try {
      const rc = parseEnv(await fsx.readFile(`${env.composeDir}/.env.image.rc`))
      baseImage = rc.APP_IMAGE || null
    } catch { /* fall through */ }
    if (!baseImage) baseImage = `${env.imageRepo}:${await github.latestRcTag()}`
    const prImage = `${env.imageRepo}:${prTag}`

    onProgress('cloning')
    await docker.createNetwork(NETWORK)
    created.network = true
    for (const pane of Object.values(PANES)) {
      await docker.runPg(pane.pg, NETWORK)
      created.containers.push(pane.pg)
      await docker.waitHealthyPg(pane.pg, {})
      for (const db of DBS) await docker.cloneDb('homefree-db-1', pane.pg, db)
    }

    const prodEnv = parseEnv(await fsx.readFile(`${env.composeDir}/.env`))
    for (const pane of Object.values(PANES)) {
      const path = `${env.composeDir}/${pane.envFile}`
      await fsx.writeFile(path, renderEnv(paneEnv(prodEnv, pane, env)), { mode: 0o600 })
      created.envFiles.push(path)
    }

    onProgress('migrating')
    await docker.runMigrate(migrateImageFor(baseImage), NETWORK, `${env.composeDir}/${PANES.base.envFile}`)
    await docker.runMigrate(migrateImageFor(prImage), NETWORK, `${env.composeDir}/${PANES.pr.envFile}`)

    onProgress('starting')
    await docker.runApp(PANES.base.app, baseImage, NETWORK, `${env.composeDir}/${PANES.base.envFile}`, PANES.base.hostPort)
    created.containers.push(PANES.base.app)
    await docker.runApp(PANES.pr.app, prImage, NETWORK, `${env.composeDir}/${PANES.pr.envFile}`, PANES.pr.hostPort)
    created.containers.push(PANES.pr.app)
    await docker.waitHealthyApp(PANES.base.hostPort, {})
    await docker.waitHealthyApp(PANES.pr.hostPort, {})

    const tokens = {
      base: await mint({ docker, dbContainer: PANES.base.pg, email: env.operatorEmail }),
      pr: await mint({ docker, dbContainer: PANES.pr.pg, email: env.operatorEmail }),
    }
    return { baseTag: baseImage, prTag: prImage, tokens, created }
  } catch (err) {
    await teardownSession(deps, created).catch(() => {})
    throw err
  }
}

export async function teardownSession({ docker, fsx }, created) {
  const names = created?.containers?.length
    ? created.containers
    : [PANES.base.app, PANES.pr.app, PANES.base.pg, PANES.pr.pg]
  await docker.rmForce(names)
  await docker.rmNetwork(NETWORK).catch(() => {})
  const files = created?.envFiles ?? []
  for (const f of files) await fsx.unlink(f).catch(() => {})
}
