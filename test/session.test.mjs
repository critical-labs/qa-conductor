import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSession, reduce, touch, isIdle, parseEnv, renderEnv,
  migrateImageFor, bootSession, teardownSession, PANES,
} from '../lib/session.mjs'

test('reducer walks the happy path and enforces single session', () => {
  let s = createSession()
  assert.equal(s.status, 'idle')
  s = reduce(s, { type: 'open', pr: 7 })
  assert.equal(s.status, 'ensuring-image')
  assert.equal(s.pr, 7)
  // a second open while active is ignored
  assert.equal(reduce(s, { type: 'open', pr: 9 }).pr, 7)
  s = reduce(s, { type: 'step', step: 'cloning' })
  s = reduce(s, { type: 'step', step: 'migrating' })
  s = reduce(s, { type: 'step', step: 'starting' })
  s = reduce(s, { type: 'ready', now: 1000, tokens: { base: 'a', pr: 'b' } })
  assert.equal(s.status, 'ready')
  assert.equal(s.startedAt, 1000)
  s = reduce(s, { type: 'teardown' })
  assert.equal(s.status, 'tearing-down')
  s = reduce(s, { type: 'torn-down' })
  assert.equal(s.status, 'idle')
})

test('reducer: error from active states, re-open after error, ready only from starting', () => {
  let s = reduce(createSession(), { type: 'open', pr: 3 })
  s = reduce(s, { type: 'error', step: 'cloning', message: 'boom' })
  assert.equal(s.status, 'error')
  assert.deepEqual(s.error, { step: 'cloning', message: 'boom' })
  s = reduce(s, { type: 'open', pr: 4 })
  assert.equal(s.status, 'ensuring-image')
  assert.equal(reduce(s, { type: 'ready', now: 1 }).status, 'ensuring-image')
  assert.equal(reduce(createSession(), { type: 'error', step: 'x', message: 'y' }).status, 'idle')
})

test('touch + isIdle', () => {
  let s = reduce(createSession(), { type: 'open', pr: 1 })
  s = { ...s, status: 'ready' }
  s = touch(s, 5000)
  assert.equal(isIdle(s, 5000 + 60_000, 30 * 60_000), false)
  assert.equal(isIdle(s, 5000 + 31 * 60_000, 30 * 60_000), true)
  assert.equal(isIdle({ ...s, status: 'cloning' }, 9e9, 1), false)
})

test('parseEnv / renderEnv round trip, comments ignored', () => {
  const env = parseEnv('# c\nA=1\n\nB=x=y\n')
  assert.deepEqual(env, { A: '1', B: 'x=y' })
  assert.equal(renderEnv(env), 'A=1\nB=x=y\n')
})

test('migrateImageFor', () => {
  assert.equal(migrateImageFor('ghcr.io/x/homefree-app:1.0.0-rc.38'), 'ghcr.io/x/homefree-app:migrate-1.0.0-rc.38')
  assert.equal(migrateImageFor('ghcr.io/x/homefree-app:pr-7-abc'), 'ghcr.io/x/homefree-app:migrate-pr-7-abc')
})

// --- bootSession: v3 orchestrator over the five adapter seams --------------

const BASE_IMG = 'ghcr.io/x/app:1.0.0-rc.38'
const PR_IMG = 'ghcr.io/x/app:pr-7-abcdef123456'

function makeDeps({ failAt = null, migrationStrategy = 'one-shot-image', requiresDb = true, envContributions = null, withOnBuild = false } = {}) {
  const calls = []
  const rec = (name, impl) => async (...args) => {
    calls.push([name, ...args])
    if (failAt === name) throw new Error(`fail:${name}`)
    return impl ? impl(...args) : undefined
  }
  let subscribed = null
  const deps = {
    adapters: {
      provisioner: {
        network: 'qa-session',
        provisionDatabase: rec('provisionDatabase', ({ paneRef }) => ({
          dsn: `dsn-${paneRef.role}`,
          db: { dsn: `dsn-${paneRef.role}`, query: async () => '1' },
        })),
        reserveServices: rec('reserveServices', ({ paneRef }) => ({ app: { url: `http://127.0.0.1:311${paneRef.role === 'base' ? 1 : 2}`, port: paneRef.role === 'base' ? 3111 : 3112 } })),
        launchServices: rec('launchServices'),
        waitHealthy: rec('waitHealthy'),
        teardown: rec('teardown'),
      },
      build: {
        migrationStrategy,
        subscribeBuild: cb => { subscribed = cb },
        ensureBuilt: rec('ensureBuilt'),
        resolveBaseImages: rec('resolveBaseImages', () => ({ services: { app: BASE_IMG }, migrate: { image: migrateImageFor(BASE_IMG) } })),
        resolvePrImages: rec('resolvePrImages', () => ({ services: { app: PR_IMG }, migrate: { image: migrateImageFor(PR_IMG) } })),
      },
      seed: { databases: ['idp', 'userdb'], seedPane: rec('seedPane') },
      // derivePaneEnv is PURE (sync) per the frozen contract — record manually.
      envTransform: { derivePaneEnv: ({ prodEnv, pane }) => { calls.push(['derivePaneEnv', { prodEnv, pane }]); return { app: { DSN: pane.dsn } } } },
      auth: {
        requiresDb,
        ...(envContributions ? { envContributions: () => envContributions } : {}),
        establishSession: rec('establishSession', ({ pane }) => ({ landingUrl: `login-${pane.ref.role}`, cookies: [] })),
      },
    },
    docker: { login: rec('login'), ensureImage: rec('ensureImage'), runMigrate: rec('runMigrate') },
    fsx: {
      readFile: rec('readFile', p => { if (p.endsWith('/.env')) return 'APP_DOMAIN=homefree.cloud\n'; throw new Error('ENOENT') }),
      writeFile: rec('writeFile'),
      unlink: rec('unlink'),
    },
    env: { composeDir: '/cd', operatorEmail: 'op@homefree.local', publicHost: 'h.ts.net', ghcrUser: 'u', ghcrToken: 't' },
    onProgress: step => calls.push(['progress', step]),
    ...(withOnBuild ? { onBuild: p => calls.push(['onBuild', p]) } : {}),
  }
  return { deps, calls, getSubscribed: () => subscribed }
}

test('bootSession happy path: seam order, tags, loginUrls', async () => {
  const { deps, calls } = makeDeps()
  const out = await bootSession(deps, 7)
  assert.equal(out.baseTag, BASE_IMG)
  assert.equal(out.prTag, PR_IMG)
  assert.deepEqual(out.loginUrls, { base: { landingUrl: 'login-base', cookies: [] }, pr: { landingUrl: 'login-pr', cookies: [] } })
  // progress order
  assert.deepEqual(calls.filter(c => c[0] === 'progress').map(c => c[1]), ['ensuring-image', 'cloning', 'migrating', 'starting'])
  // registry login happens before any image work
  assert.equal(calls.findIndex(c => c[0] === 'login') < calls.findIndex(c => c[0] === 'ensureBuilt'), true)
  // per pane: provision -> seed -> reserve
  const seq = calls.map(c => c[0])
  const iProv = seq.indexOf('provisionDatabase')
  assert.deepEqual(seq.slice(iProv, iProv + 3), ['provisionDatabase', 'seedPane', 'reserveServices'])
  // seed gets the provisioner's db handle and the declared databases
  const seedCall = calls.find(c => c[0] === 'seedPane')[1]
  assert.equal(seedCall.db.dsn, 'dsn-base')
  assert.deepEqual(seedCall.databases, ['idp', 'userdb'])
  // env derived from pane.dsn, written 0600 to the pane env file, then migrate
  const writes = calls.filter(c => c[0] === 'writeFile')
  assert.deepEqual(writes.map(c => c[1]), ['/cd/.env.qa-base', '/cd/.env.qa-pr'])
  assert.equal(writes[0][2], 'DSN=dsn-base\n')
  assert.deepEqual(writes[0][3], { mode: 0o600 })
  const migs = calls.filter(c => c[0] === 'runMigrate')
  assert.deepEqual(migs.map(c => [c[1], c[2], c[3]]), [
    [migrateImageFor(BASE_IMG), 'qa-session', '/cd/.env.qa-base'],
    [migrateImageFor(PR_IMG), 'qa-session', '/cd/.env.qa-pr'],
  ])
  // migrate images are ensured before running
  assert.deepEqual(calls.filter(c => c[0] === 'ensureImage').map(c => c[1]), [migrateImageFor(BASE_IMG), migrateImageFor(PR_IMG)])
  // launch receives the service map, env file hint, and reservation
  const launches = calls.filter(c => c[0] === 'launchServices')
  assert.deepEqual(launches[0][1].services, { app: BASE_IMG })
  assert.deepEqual(launches[0][1].envFiles, { app: '/cd/.env.qa-base' })
  assert.equal(launches[0][1].reserved.app.port, 3111)
  assert.equal(calls.filter(c => c[0] === 'waitHealthy').length, 2)
})

test('bootSession passes db to establishSession only when auth.requiresDb', async () => {
  const withDb = makeDeps({ requiresDb: true })
  await bootSession(withDb.deps, 7)
  assert.equal(withDb.calls.find(c => c[0] === 'establishSession')[1].db.dsn, 'dsn-base')

  const noDb = makeDeps({ requiresDb: false })
  await bootSession(noDb.deps, 7)
  assert.equal('db' in noDb.calls.find(c => c[0] === 'establishSession')[1], false)
})

test('bootSession skips the migrate step entirely for on-boot strategies', async () => {
  const { deps, calls } = makeDeps({ migrationStrategy: 'on-boot' })
  await bootSession(deps, 7)
  assert.equal(calls.filter(c => c[0] === 'runMigrate').length, 0)
  assert.equal(calls.filter(c => c[0] === 'ensureImage').length, 0)
})

test('bootSession merges auth envContributions into the written pane env', async () => {
  const { deps, calls } = makeDeps({ envContributions: { app: { DEV_LOGIN_BYPASS: '1' } } })
  await bootSession(deps, 7)
  const firstWrite = calls.find(c => c[0] === 'writeFile')
  assert.equal(firstWrite[2], 'DSN=dsn-base\nDEV_LOGIN_BYPASS=1\n')
})

test('bootSession wires onBuild through build.subscribeBuild', async () => {
  const { deps, getSubscribed } = makeDeps({ withOnBuild: true })
  await bootSession(deps, 7)
  assert.equal(typeof getSubscribed(), 'function')

  const without = makeDeps()
  await bootSession(without.deps, 7)
  assert.equal(without.getSubscribed(), null)
})

test('bootSession failure mid-boot tears down both panes and env files, then rethrows', async () => {
  const { deps, calls } = makeDeps({ failAt: 'launchServices' })
  await assert.rejects(() => bootSession(deps, 7), /fail:launchServices/)
  assert.deepEqual(calls.filter(c => c[0] === 'teardown').map(c => c[1].paneRef.role), ['base', 'pr'])
  assert.deepEqual(calls.filter(c => c[0] === 'unlink').map(c => c[1]).sort(), ['/cd/.env.qa-base', '/cd/.env.qa-pr'])
})

test('teardownSession tears down each pane via the provisioner and scrubs env files, tolerating errors', async () => {
  const calls = []
  const provisioner = { teardown: async a => { calls.push(['teardown', a.paneRef.role]); throw new Error('already gone') } }
  const fsx = { unlink: async p => { calls.push(['unlink', p]); throw new Error('ENOENT') } }
  await teardownSession({ provisioner, fsx, composeDir: '/cd' }, null) // resolves despite both failing
  assert.deepEqual(calls, [
    ['teardown', 'base'], ['teardown', 'pr'],
    ['unlink', `/cd/${PANES.base.envFile}`], ['unlink', `/cd/${PANES.pr.envFile}`],
  ])
})
