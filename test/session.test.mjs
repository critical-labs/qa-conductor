import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSession, reduce, touch, isIdle, parseEnv, paneEnv, renderEnv,
  migrateImageFor, bootSession, teardownSession, PANES, DBS, NETWORK,
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

test('paneEnv overrides hosts/db/auth/email and swaps blob to QA space', () => {
  const prod = { APP_DOMAIN: 'homefree.cloud', CI_POSTGRES_URL: 'x', BLOB_S3_BUCKET: 'homefree-media', BLOB_S3_ACCESS_KEY_ID: 'k', RESEND_API_KEY: 'r' }
  const env = paneEnv(prod, PANES.pr, {
    publicHost: 'h.ts.net',
    blob: { bucket: 'homefree-media-qa', endpoint: 'https://e', accessKeyId: 'qk', secretAccessKey: 'qs' },
  })
  assert.equal(env.CI_POSTGRES_URL, 'postgresql://homefree:qa@qa-pg-pr:5432')
  assert.equal(env.WEB_CLIENT_URL, 'https://h.ts.net:10000')
  assert.equal(env.WEBAUTHN_RP_ID, 'h.ts.net')
  assert.equal(env.AUTH_REFRESH_ORIGIN, 'http://127.0.0.1:3000')
  assert.equal(env.EMAIL_ADAPTER, 'console')
  assert.equal(env.BLOB_S3_BUCKET, 'homefree-media-qa')
  assert.equal(env.BLOB_S3_ACCESS_KEY_ID, 'qk')
  assert.equal(env.RESEND_API_KEY, 'r')
})

test('paneEnv strips prod blob entirely when no QA space configured', () => {
  const env = paneEnv({ BLOB_S3_BUCKET: 'homefree-media', BLOB_S3_SECRET_ACCESS_KEY: 's' }, PANES.base, { publicHost: 'h', blob: { bucket: '' } })
  assert.equal(env.BLOB_S3_BUCKET, undefined)
  assert.equal(env.BLOB_S3_SECRET_ACCESS_KEY, undefined)
})

test('migrateImageFor', () => {
  assert.equal(migrateImageFor('ghcr.io/x/homefree-app:1.0.0-rc.38'), 'ghcr.io/x/homefree-app:migrate-1.0.0-rc.38')
  assert.equal(migrateImageFor('ghcr.io/x/homefree-app:pr-7-abc'), 'ghcr.io/x/homefree-app:migrate-pr-7-abc')
})

function makeDeps({ tagExists = true, failAt = null } = {}) {
  const calls = []
  const rec = (name, impl) => async (...args) => {
    calls.push([name, ...args])
    if (failAt === name) throw new Error(`fail:${name}`)
    return impl ? impl(...args) : undefined
  }
  const files = {
    '/cd/.env.image.rc': 'APP_IMAGE=ghcr.io/238855/homefree-app:1.0.0-rc.38\nMIGRATE_IMAGE=m\n',
    '/cd/.env': 'APP_DOMAIN=homefree.cloud\nRESEND_API_KEY=r\n',
  }
  let tagCalls = 0
  const deps = {
    sleepFn: rec('sleep'),
    github: {
      prHead: rec('prHead', () => 'abcdef123456ffff'),
      // First call checks the app tag; later calls (migrate wait) succeed so
      // the dispatch-path test terminates without sleeping.
      ghcrTagExists: rec('ghcrTagExists', () => tagExists || ++tagCalls > 1),
      dispatchPreviewBuild: rec('dispatch'),
      awaitPreviewImage: rec('await'),
      latestRcTag: rec('latestRcTag', () => '1.0.0-rc.99'),
    },
    docker: {
      createNetwork: rec('createNetwork'),
      runPg: rec('runPg'),
      waitHealthyPg: rec('waitHealthyPg'),
      cloneDb: rec('cloneDb'),
      runMigrate: rec('runMigrate'),
      runApp: rec('runApp'),
      waitHealthyApp: rec('waitHealthyApp'),
      rmForce: rec('rmForce'),
      rmNetwork: rec('rmNetwork'),
    },
    mint: rec('mint', ({ dbContainer }) => `tok-${dbContainer}`),
    fsx: {
      readFile: rec('readFile', p => {
        if (!(p in files)) throw new Error('ENOENT')
        return files[p]
      }),
      writeFile: rec('writeFile'),
      unlink: rec('unlink'),
    },
    env: { composeDir: '/cd', imageRepo: 'ghcr.io/238855/homefree-app', operatorEmail: 'op@x.com', publicHost: 'h.ts.net', blob: { bucket: '' } },
    onProgress: step => calls.push(['progress', step]),
  }
  return { deps, calls }
}

test('bootSession happy path: order, tags, tokens', async () => {
  const { deps, calls } = makeDeps()
  const out = await bootSession(deps, 7)
  assert.equal(out.prTag, 'ghcr.io/238855/homefree-app:pr-7-abcdef123456')
  assert.equal(out.baseTag, 'ghcr.io/238855/homefree-app:1.0.0-rc.38')
  assert.deepEqual(out.tokens, { base: 'tok-qa-pg-base', pr: 'tok-qa-pg-pr' })
  // no build dispatched when the tag exists
  assert.ok(!calls.some(c => c[0] === 'dispatch'))
  // 7 dbs x 2 panes cloned from the prod db container
  const clones = calls.filter(c => c[0] === 'cloneDb')
  assert.equal(clones.length, DBS.length * 2)
  assert.ok(clones.every(c => c[1] === 'homefree-db-1'))
  // migrate ran with derived migrate images, base first
  const migs = calls.filter(c => c[0] === 'runMigrate')
  assert.equal(migs[0][1], 'ghcr.io/238855/homefree-app:migrate-1.0.0-rc.38')
  assert.equal(migs[1][1], 'ghcr.io/238855/homefree-app:migrate-pr-7-abcdef123456')
  // progress order
  const steps = calls.filter(c => c[0] === 'progress').map(c => c[1])
  assert.deepEqual(steps, ['ensuring-image', 'cloning', 'migrating', 'starting'])
})

test('bootSession waits for the migrate tag when it lags the app tag', async () => {
  const { deps, calls } = makeDeps()
  const answers = [true, false, false, true] // app tag, then migrate polls
  deps.github.ghcrTagExists = async () => answers.shift()
  await bootSession(deps, 7)
  const sleeps = calls.filter(c => c[0] === 'sleep')
  assert.equal(sleeps.length, 2)
  assert.equal(sleeps[0][1], 15000)
})

test('bootSession dispatches + awaits the build when the tag is missing', async () => {
  const { deps, calls } = makeDeps({ tagExists: false })
  await bootSession(deps, 7)
  assert.ok(calls.some(c => c[0] === 'dispatch'))
  assert.ok(calls.some(c => c[0] === 'await'))
})

test('bootSession failure mid-boot tears down what was created and rethrows', async () => {
  const { deps, calls } = makeDeps({ failAt: 'runMigrate' })
  await assert.rejects(() => bootSession(deps, 7), /fail:runMigrate/)
  assert.ok(calls.some(c => c[0] === 'rmForce'))
  assert.ok(calls.some(c => c[0] === 'rmNetwork'))
  assert.ok(calls.some(c => c[0] === 'unlink'))
})

test('teardownSession without created falls back to all known names', async () => {
  const { deps, calls } = makeDeps()
  await teardownSession(deps, null)
  const rm = calls.find(c => c[0] === 'rmForce')
  assert.deepEqual(rm[1], [PANES.base.app, PANES.pr.app, PANES.base.pg, PANES.pr.pg])
  assert.ok(calls.some(c => c[0] === 'rmNetwork' && c[1] === NETWORK))
})
