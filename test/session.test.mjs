import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSession, reduce, touch, isIdle, parseEnv, renderEnv,
  migrateImageFor, bootSession, teardownSession, ROLES,
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
  assert.equal(migrateImageFor('ghcr.io/x/widget-app:1.0.0-rc.38'), 'ghcr.io/x/widget-app:migrate-1.0.0-rc.38')
  assert.equal(migrateImageFor('ghcr.io/x/widget-app:pr-7-abc'), 'ghcr.io/x/widget-app:migrate-pr-7-abc')
})

// --- bootSession: v3 orchestrator over the five adapter seams --------------

const BASE_IMG = 'ghcr.io/x/app:1.0.0-rc.38'
const PR_IMG = 'ghcr.io/x/app:pr-7-abcdef123456'
const ORIGINS = { base: 'https://h.ts.net:8443', pr: 'https://h.ts.net:10000' }

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
        provisionDatabase: rec('provisionDatabase', ({ paneRef }) => ({
          dsn: `dsn-${paneRef.role}`,
          db: { dsn: `dsn-${paneRef.role}`, query: async () => '1' },
        })),
        reserveServices: rec('reserveServices', ({ paneRef }) => ({ app: { url: `http://127.0.0.1:311${paneRef.role === 'base' ? 1 : 2}`, port: paneRef.role === 'base' ? 3111 : 3112 } })),
        runMigrate: rec('runMigrate'),
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
      // derivePaneEnv is pure, and sync here (an async one is awaited too) — record manually.
      envTransform: { derivePaneEnv: ({ prodEnv, pane }) => { calls.push(['derivePaneEnv', { prodEnv, pane }]); return { app: { DSN: pane.dsn } } } },
      auth: {
        requiresDb,
        ...(envContributions ? { envContributions: () => envContributions } : {}),
        establishSession: rec('establishSession', ({ pane }) => ({ landingUrl: `login-${pane.ref.role}`, cookies: [] })),
      },
    },
    readBaseEnv: async () => ({ APP_DOMAIN: 'widget.example' }),
    env: { operatorEmail: 'op@example.com', paneOrigins: ORIGINS },
    onProgress: step => calls.push(['progress', step]),
    ...(withOnBuild ? { onBuild: p => calls.push(['onBuild', p]) } : {}),
  }
  return { deps, calls, getSubscribed: () => subscribed }
}

test('bootSession happy path: seam order, tags, loginUrls, upstreams', async () => {
  const { deps, calls } = makeDeps()
  const out = await bootSession(deps, 7)
  assert.equal(out.baseTag, BASE_IMG)
  assert.equal(out.prTag, PR_IMG)
  assert.deepEqual(out.loginUrls, { base: { landingUrl: 'login-base', cookies: [] }, pr: { landingUrl: 'login-pr', cookies: [] } })
  // the pane proxies route to each pane's reserved primary-service port
  assert.deepEqual(out.upstreams, { base: 3111, pr: 3112 })
  // progress order
  assert.deepEqual(calls.filter(c => c[0] === 'progress').map(c => c[1]), ['ensuring-image', 'cloning', 'migrating', 'starting'])
  // per pane: provision -> seed -> reserve, with the configured public origin
  const seq = calls.map(c => c[0])
  const iProv = seq.indexOf('provisionDatabase')
  assert.deepEqual(seq.slice(iProv, iProv + 3), ['provisionDatabase', 'seedPane', 'reserveServices'])
  assert.deepEqual(calls.filter(c => c[0] === 'provisionDatabase').map(c => c[1].paneRef.publicOrigin), [ORIGINS.base, ORIGINS.pr])
  // seed gets the provisioner's db handle and the declared databases
  const seedCall = calls.find(c => c[0] === 'seedPane')[1]
  assert.equal(seedCall.db.dsn, 'dsn-base')
  assert.deepEqual(seedCall.databases, ['idp', 'userdb'])
  // migrate runs through the provisioner with the pane's env map
  const migs = calls.filter(c => c[0] === 'runMigrate')
  assert.deepEqual(migs.map(c => [c[1].paneRef.role, c[1].migrate.image]), [
    ['base', migrateImageFor(BASE_IMG)], ['pr', migrateImageFor(PR_IMG)],
  ])
  assert.deepEqual(migs[0][1].env, { app: { DSN: 'dsn-base' } })
  // launch receives the service map, env map, and reservation
  const launches = calls.filter(c => c[0] === 'launchServices')
  assert.deepEqual(launches[0][1].services, { app: BASE_IMG })
  assert.deepEqual(launches[0][1].env, { app: { DSN: 'dsn-base' } })
  assert.equal(launches[0][1].reserved.app.port, 3111)
  assert.equal(calls.filter(c => c[0] === 'waitHealthy').length, 2)
})

test('bootSession: readBaseEnv supplies prodEnv to derivePaneEnv; missing readBaseEnv means {}', async () => {
  const { deps, calls } = makeDeps()
  await bootSession(deps, 7)
  assert.deepEqual(calls.find(c => c[0] === 'derivePaneEnv')[1].prodEnv, { APP_DOMAIN: 'widget.example' })
  const bare = makeDeps()
  delete bare.deps.readBaseEnv
  await bootSession(bare.deps, 7)
  assert.deepEqual(bare.calls.find(c => c[0] === 'derivePaneEnv')[1].prodEnv, {})
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
})

test('bootSession fails clearly when one-shot migration is required but the provisioner cannot run it', async () => {
  const { deps, calls } = makeDeps()
  delete deps.adapters.provisioner.runMigrate
  await assert.rejects(() => bootSession(deps, 7), /runMigrate/)
  assert.deepEqual(calls.filter(c => c[0] === 'teardown').map(c => c[1].paneRef.role), ['base', 'pr'])
})

test('bootSession merges auth envContributions into the pane env', async () => {
  const { deps, calls } = makeDeps({ envContributions: { app: { DEV_LOGIN_BYPASS: '1' } } })
  await bootSession(deps, 7)
  const launch = calls.find(c => c[0] === 'launchServices')[1]
  assert.deepEqual(launch.env, { app: { DSN: 'dsn-base', DEV_LOGIN_BYPASS: '1' } })
})

test('bootSession: the primary service is `app`, else the first service', async () => {
  const { deps } = makeDeps({ migrationStrategy: 'on-boot' })
  deps.adapters.build.resolvePrImages = async () => ({ services: { web: 'w', api: 'a' }, migrate: null })
  deps.adapters.build.resolveBaseImages = async () => ({ services: { web: 'w0', api: 'a0' }, migrate: null })
  deps.adapters.provisioner.reserveServices = async ({ paneRef }) => ({
    web: { url: 'u', port: paneRef.role === 'base' ? 4001 : 5001 },
    api: { url: 'u', port: 4002 },
  })
  const out = await bootSession(deps, 7)
  assert.equal(out.baseTag, 'w0')
  assert.equal(out.prTag, 'w')
  assert.deepEqual(out.upstreams, { base: 4001, pr: 5001 })
})

test('bootSession wires onBuild through build.subscribeBuild', async () => {
  const { deps, getSubscribed } = makeDeps({ withOnBuild: true })
  await bootSession(deps, 7)
  assert.equal(typeof getSubscribed(), 'function')

  const without = makeDeps()
  await bootSession(without.deps, 7)
  assert.equal(without.getSubscribed(), null)
})

test('bootSession failure mid-boot tears down both panes, then rethrows', async () => {
  const { deps, calls } = makeDeps({ failAt: 'launchServices' })
  await assert.rejects(() => bootSession(deps, 7), /fail:launchServices/)
  assert.deepEqual(calls.filter(c => c[0] === 'teardown').map(c => c[1].paneRef.role), ['base', 'pr'])
})

test('teardownSession tears down every role via the provisioner, tolerating errors', async () => {
  const calls = []
  const provisioner = { teardown: async a => { calls.push(a.paneRef.role); throw new Error('already gone') } }
  await teardownSession({ provisioner }) // resolves despite failing
  assert.deepEqual(calls, ROLES)
  assert.deepEqual(ROLES, ['base', 'pr'])
})

// Any seam member may return its result or a promise of it (README, Types).
// A teardown that returned no promise, or threw before returning one, used
// to end teardownSession at the base pane, leaving the PR pane up.
test('teardownSession tears down every pane whether teardown returns, throws or rejects', async () => {
  const outcomes = {
    'returns a value': () => undefined,
    'throws synchronously': () => { throw new Error('sync') },
    rejects: async () => { throw new Error('async') },
    'rejects with a non-Error': () => Promise.reject('gone'),
  }
  for (const [name, outcome] of Object.entries(outcomes)) {
    const roles = []
    await teardownSession({ provisioner: { teardown: ({ paneRef }) => { roles.push(paneRef.role); return outcome() } } })
    assert.deepEqual(roles, ROLES, name)
  }
  // and so does a failed boot, which tears down through it
  const { deps, calls } = makeDeps({ failAt: 'launchServices' })
  deps.adapters.provisioner.teardown = ({ paneRef }) => { calls.push(['teardown', { paneRef }]) }
  await assert.rejects(() => bootSession(deps, 7), /fail:launchServices/)
  assert.deepEqual(calls.filter(c => c[0] === 'teardown').map(c => c[1].paneRef.role), ['base', 'pr'])
})

// Spread unawaited, a promise is {}: the panes would get none of its env, no
// DSN or origin, and none of the EnvTransform's side-effect neutralisation.
test('bootSession awaits derivePaneEnv and envContributions, so either may be async', async () => {
  const { deps, calls } = makeDeps({ envContributions: { app: { DEV_LOGIN_BYPASS: '1' } } })
  const { envTransform, auth } = deps.adapters
  const derive = envTransform.derivePaneEnv
  const contribute = auth.envContributions
  envTransform.derivePaneEnv = async args => derive(args)
  auth.envContributions = async () => contribute()
  await bootSession(deps, 7)
  const want = [{ app: { DSN: 'dsn-base', DEV_LOGIN_BYPASS: '1' } }, { app: { DSN: 'dsn-pr', DEV_LOGIN_BYPASS: '1' } }]
  assert.deepEqual(calls.filter(c => c[0] === 'runMigrate').map(c => c[1].env), want)
  assert.deepEqual(calls.filter(c => c[0] === 'launchServices').map(c => c[1].env), want)
})

test('bootSession: a subscribeBuild that rejects fails the boot, and tears it down', async () => {
  const { deps, calls } = makeDeps({ withOnBuild: true })
  deps.adapters.build.subscribeBuild = async () => { throw new Error('no build feed') }
  await assert.rejects(() => bootSession(deps, 7), /no build feed/)
  assert.equal(calls.some(c => c[0] === 'ensureBuilt'), false)
  assert.deepEqual(calls.filter(c => c[0] === 'teardown').map(c => c[1].paneRef.role), ['base', 'pr'])
})

// --- cancellation (2026-09-25 stale-boot incident) -------------------------

test('bootSession: an abort between stages stops the boot and does NOT tear down', async () => {
  const ac = new AbortController()
  const { deps, calls } = makeDeps()
  deps.signal = ac.signal
  // abort while ensureBuilt is "running", before any pane work
  deps.adapters.build.ensureBuilt = async (pr, opts) => { calls.push(['ensureBuilt', pr, opts]); ac.abort() }
  await assert.rejects(() => bootSession(deps, 7), err => err.name === 'AbortError')
  assert.equal(calls.find(c => c[0] === 'ensureBuilt')[2].signal, ac.signal, 'signal threaded into ensureBuilt')
  assert.equal(calls.some(c => c[0] === 'provisionDatabase'), false, 'no pane work after abort')
  assert.equal(calls.some(c => c[0] === 'teardown'), false, 'aborted boot must not tear down')
})

test('bootSession: an abort while a pane database is provisioned stops the boot before its Seed runs', async () => {
  const ac = new AbortController()
  const { deps, calls } = makeDeps()
  deps.signal = ac.signal
  // A Provisioner that returns normally although the abort landed during it
  // (a docker call in flight can't be interrupted): the Seed would write into
  // whatever database now has that pane's name, possibly the next session's.
  const provision = deps.adapters.provisioner.provisionDatabase
  deps.adapters.provisioner.provisionDatabase = async args => { const out = await provision(args); ac.abort(); return out }
  await assert.rejects(() => bootSession(deps, 7), err => err.name === 'AbortError')
  assert.equal(calls.some(c => c[0] === 'seedPane'), false, 'no Seed after the abort')
  assert.equal(calls.some(c => c[0] === 'teardown'), false)
})

test('bootSession: a failure after abort skips teardown; a non-aborted failure tears down', async () => {
  const ac = new AbortController()
  const aborted = makeDeps()
  aborted.deps.signal = ac.signal
  aborted.deps.adapters.provisioner.launchServices = async () => { ac.abort(); throw new Error('boom') }
  await assert.rejects(() => bootSession(aborted.deps, 7), /boom/)
  assert.equal(aborted.calls.some(c => c[0] === 'teardown'), false)

  const live = makeDeps({ failAt: 'launchServices' })
  live.deps.signal = new AbortController().signal
  await assert.rejects(() => bootSession(live.deps, 7), /fail:launchServices/)
  assert.deepEqual(live.calls.filter(c => c[0] === 'teardown').map(c => c[1].paneRef.role), ['base', 'pr'])
})

// --- display label ------------------------------------------------------------

test('bootSession: a resolve* label overrides the primary service ref as the tag', async () => {
  const { deps } = makeDeps({ migrationStrategy: 'on-boot' })
  // a process consumer whose service refs are local paths
  deps.adapters.build.resolveBaseImages = async () => ({ services: { app: '/cache/worktrees/aaa' }, migrate: null, label: 'main@aaaaaaa' })
  deps.adapters.build.resolvePrImages = async () => ({ services: { app: '/cache/worktrees/bbb' }, migrate: null, label: '#7@bbbbbbb' })
  const out = await bootSession(deps, 7)
  assert.equal(out.baseTag, 'main@aaaaaaa')
  assert.equal(out.prTag, '#7@bbbbbbb')
})

test('bootSession: without a label the tag falls back to the primary service ref', async () => {
  const { deps } = makeDeps()
  deps.adapters.build.resolveBaseImages = async () => ({ services: { app: BASE_IMG }, migrate: null, label: 'rc-38' })
  // PR side has no label
  const out = await bootSession(deps, 7)
  assert.equal(out.baseTag, 'rc-38')
  assert.equal(out.prTag, PR_IMG)
})

// --- cancellation reaches the Provisioner ------------------------------------

test('bootSession passes signal to every Provisioner call', async () => {
  const ac = new AbortController()
  const { deps, calls } = makeDeps()
  deps.signal = ac.signal
  await bootSession(deps, 7)
  for (const name of ['provisionDatabase', 'reserveServices', 'runMigrate', 'launchServices', 'waitHealthy']) {
    const made = calls.filter(c => c[0] === name)
    assert.equal(made.length, 2, `${name} runs once per pane`)
    for (const c of made) assert.equal(c[1].signal, ac.signal, `${name} receives the boot signal`)
  }
})

test('bootSession checks for an abort between panes while provisioning', async () => {
  const ac = new AbortController()
  const { deps, calls } = makeDeps()
  deps.signal = ac.signal
  const reserve = deps.adapters.provisioner.reserveServices
  deps.adapters.provisioner.reserveServices = async args => {
    const out = await reserve(args)
    if (args.paneRef.role === 'base') ac.abort() // teardown lands while base is provisioning
    return out
  }
  await assert.rejects(() => bootSession(deps, 7), err => err.name === 'AbortError')
  assert.deepEqual(calls.filter(c => c[0] === 'provisionDatabase').map(c => c[1].paneRef.role), ['base'], 'pr pane never provisioned')
  assert.equal(calls.some(c => c[0] === 'teardown'), false)
})

test('bootSession checks for an abort before each launch and before waiting for health', async () => {
  const betweenLaunches = new AbortController()
  const a = makeDeps()
  a.deps.signal = betweenLaunches.signal
  a.deps.adapters.provisioner.launchServices = async args => { a.calls.push(['launchServices', args]); betweenLaunches.abort() }
  await assert.rejects(() => bootSession(a.deps, 7), err => err.name === 'AbortError')
  assert.deepEqual(a.calls.filter(c => c[0] === 'launchServices').map(c => c[1].paneRef.role), ['base'], 'pr pane never launched')

  const afterLaunches = new AbortController()
  const b = makeDeps()
  b.deps.signal = afterLaunches.signal
  b.deps.adapters.provisioner.launchServices = async args => {
    b.calls.push(['launchServices', args])
    if (args.paneRef.role === 'pr') afterLaunches.abort()
  }
  await assert.rejects(() => bootSession(b.deps, 7), err => err.name === 'AbortError')
  assert.equal(b.calls.filter(c => c[0] === 'launchServices').length, 2)
  assert.equal(b.calls.some(c => c[0] === 'waitHealthy'), false, 'no health wait after abort')
})

// --- failure log tails are read before teardown ------------------------------

function withLogs(made, tail = 'last lines') {
  made.deps.adapters.provisioner.logs = async args => { made.calls.push(['logs', args]); return tail }
  return made
}

test('a failed pane stage reads the failing pane\'s log tail BEFORE tearing down', async () => {
  const made = withLogs(makeDeps({ failAt: 'waitHealthy' }), 'app crashed: EADDRINUSE')
  const err = await bootSession(made.deps, 7).then(() => assert.fail('should reject'), e => e)
  assert.match(err.message, /fail:waitHealthy/)
  assert.equal(err.logTail, 'app crashed: EADDRINUSE')
  assert.equal(err.failedRole, 'base')
  const seq = made.calls.map(c => c[0])
  assert.ok(seq.indexOf('logs') !== -1 && seq.indexOf('logs') < seq.indexOf('teardown'), 'logs read before teardown')
  assert.deepEqual(made.calls.find(c => c[0] === 'logs')[1], { paneRef: { role: 'base' }, stage: 'starting', lines: 40 })
})

test('the failing role and stage are tracked per pane', async () => {
  const made = withLogs(makeDeps())
  const reserve = made.deps.adapters.provisioner.reserveServices
  made.deps.adapters.provisioner.reserveServices = async args => {
    if (args.paneRef.role === 'pr') throw new Error('no free port')
    return reserve(args)
  }
  const err = await bootSession(made.deps, 7).then(() => assert.fail('should reject'), e => e)
  assert.equal(err.failedRole, 'pr')
  assert.deepEqual(made.calls.find(c => c[0] === 'logs')[1], { paneRef: { role: 'pr' }, stage: 'cloning', lines: 40 })
})

test('a build failure reads no pane logs and keeps a BuildConvention\'s own logTail', async () => {
  const made = withLogs(makeDeps())
  made.deps.adapters.build.ensureBuilt = async () => { throw Object.assign(new Error('install failed'), { logTail: 'npm ERR! 404' }) }
  const err = await bootSession(made.deps, 7).then(() => assert.fail('should reject'), e => e)
  assert.equal(err.logTail, 'npm ERR! 404')
  assert.equal(err.failedRole, null)
  assert.equal(made.calls.some(c => c[0] === 'logs'), false)
  assert.deepEqual(made.calls.filter(c => c[0] === 'teardown').map(c => c[1].paneRef.role), ['base', 'pr'])
})

test('log tail: an error that already carries one keeps it; a failing logs() is tolerated', async () => {
  const own = withLogs(makeDeps())
  own.deps.adapters.provisioner.launchServices = async () => { throw Object.assign(new Error('boom'), { logTail: 'own tail' }) }
  const e1 = await bootSession(own.deps, 7).then(() => assert.fail('should reject'), e => e)
  assert.equal(e1.logTail, 'own tail')

  const broken = makeDeps({ failAt: 'launchServices' })
  broken.deps.adapters.provisioner.logs = async () => { throw new Error('container gone') }
  const e2 = await bootSession(broken.deps, 7).then(() => assert.fail('should reject'), e => e)
  assert.match(e2.message, /fail:launchServices/, 'the boot error is not masked')
  assert.equal(e2.logTail, undefined)
  assert.deepEqual(broken.calls.filter(c => c[0] === 'teardown').map(c => c[1].paneRef.role), ['base', 'pr'])
})

test('an aborted boot reads no logs', async () => {
  const ac = new AbortController()
  const made = withLogs(makeDeps())
  made.deps.signal = ac.signal
  made.deps.adapters.provisioner.launchServices = async () => { ac.abort(); throw new Error('boom') }
  await assert.rejects(() => bootSession(made.deps, 7), /boom/)
  assert.equal(made.calls.some(c => c[0] === 'logs'), false)
  assert.equal(made.calls.some(c => c[0] === 'teardown'), false)
})

test('a boot aborted while its failure log tail is being read does not tear down', async () => {
  const ac = new AbortController()
  const made = makeDeps({ failAt: 'launchServices' })
  made.deps.signal = ac.signal
  made.deps.adapters.provisioner.logs = async () => {
    made.calls.push(['logs'])
    await new Promise(r => setTimeout(r, 5))
    ac.abort()
    return 'tail'
  }
  await assert.rejects(() => bootSession(made.deps, 7), /fail:launchServices/)
  assert.equal(made.calls.some(c => c[0] === 'logs'), true)
  assert.equal(made.calls.some(c => c[0] === 'teardown'), false, 'an ABORTED boot never tears down')
})
