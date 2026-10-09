// The Docker Provisioner keeps the panes apart: each pane's containers join a
// network of their own, and each pane's database has a password of its own
// that only that pane's DSN carries. These tests boot a real session over the
// real Docker wrapper, with a recording execFileFn in place of the docker CLI
// (argv and env), and a recording fsx in place of the env files. No Docker
// daemon runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocker } from '../lib/docker.mjs'
import { createDockerProvisioner } from '../lib/adapters/provisioner-docker.mjs'
import { bootSession, migrateImageFor, teardownSession } from '../lib/session.mjs'

const BASE_IMG = 'ghcr.io/x/app:1.0.0-rc.38'
const PR_IMG = 'ghcr.io/x/app:pr-7-abcdef123456'
const WORK = '/work'
const PASSWORD = /^[0-9a-f]{48}$/

// Every docker CLI call, with the env it was given; image inspect answers, so
// nothing is pulled. `answer(args)` may return an Error for a call to reject
// with, or a string for its stdout.
function recordingExec({ answer = () => null } = {}) {
  const calls = []
  const fn = async (file, args, opts = {}) => {
    calls.push({ file, args, env: opts.env ?? null })
    const out = answer(args)
    if (out instanceof Error) throw out
    return { stdout: out ?? '' }
  }
  fn.calls = calls
  return fn
}

function recordingFs() {
  const files = new Map()
  const removed = []
  return {
    files,
    removed,
    writeFile: async (path, text, opts) => { files.set(path, { text, mode: opts?.mode }) },
    unlink: async path => { removed.push(path) },
  }
}

// The real wrapper, with its health waits answered at once (they poll with
// sleeps); every other member runs as written.
function makeDocker(exec) {
  const docker = createDocker({ execFileFn: exec })
  return Object.assign(docker, { waitHealthyPg: async () => {}, waitHealthyApp: async () => {} })
}

function makeSession({ provisionerOptions = {}, answer } = {}) {
  const exec = recordingExec({ answer })
  const fsx = recordingFs()
  const provisioner = createDockerProvisioner({ docker: makeDocker(exec), fsx, workDir: WORK, ...provisionerOptions })
  const dsns = {}
  const deps = {
    adapters: {
      provisioner,
      build: {
        migrationStrategy: 'one-shot-image',
        ensureBuilt: async () => {},
        resolveBaseImages: async () => ({ services: { app: BASE_IMG }, migrate: { image: migrateImageFor(BASE_IMG) } }),
        resolvePrImages: async () => ({ services: { app: PR_IMG }, migrate: { image: migrateImageFor(PR_IMG) } }),
      },
      seed: { databases: ['app'], seedPane: async () => {} },
      envTransform: {
        derivePaneEnv: ({ pane }) => {
          dsns[pane.ref.role] = pane.dsn
          return { app: { DATABASE_URL: pane.dsn } }
        },
      },
      auth: { requiresDb: false, establishSession: async ({ pane }) => ({ landingUrl: `/login-${pane.ref.role}`, cookies: [] }) },
    },
    env: { operatorEmail: 'op@example.com', paneOrigins: { base: 'http://127.0.0.1:3101', pr: 'http://127.0.0.1:3102' } },
    onProgress: () => {},
  }
  return { exec, fsx, provisioner, dsns, deps }
}

const docker = exec => exec.calls.filter(c => c.file === 'docker')
const runs = exec => docker(exec).filter(c => c.args[0] === 'run')
const valueOf = (args, flag) => {
  const at = args.indexOf(flag)
  return at === -1 ? null : args[at + 1]
}
// Which pane a docker run belongs to: its container name, else (a migrate
// run has none) the pane env file it reads.
const roleOf = args => {
  const name = valueOf(args, '--name') ?? valueOf(args, '--env-file')
  return /-(base|pr)$/.exec(name)?.[1] ?? null
}
const pgPassword = (exec, role) => {
  const call = runs(exec).find(c => valueOf(c.args, '--name') === `qa-pg-${role}`)
  return call.env?.POSTGRES_PASSWORD
}

test('each pane\'s containers join only that pane\'s network, and the two networks differ', async () => {
  const s = makeSession()
  await bootSession(s.deps, 7)
  const byRole = { base: new Set(), pr: new Set() }
  for (const { args } of runs(s.exec)) {
    const role = roleOf(args)
    assert.ok(role, `every docker run belongs to a pane: ${args.join(' ')}`)
    assert.equal(args.filter(a => a === '--network').length, 1, `one --network: ${args.join(' ')}`)
    byRole[role].add(valueOf(args, '--network'))
  }
  assert.deepEqual([...byRole.base], ['qa-session-base'])
  assert.deepEqual([...byRole.pr], ['qa-session-pr'])
  // postgres, the migrate run and the app, for each pane
  assert.equal(runs(s.exec).length, 6)
  // By image too, since the image is what holds PR code: each pane's images
  // run on its own network, with its own env file.
  const byImage = runs(s.exec).filter(c => !/^qa-pg-/.test(valueOf(c.args, '--name'))).map(c => [c.args.at(-1), valueOf(c.args, '--network'), valueOf(c.args, '--env-file')])
  assert.deepEqual(byImage, [
    [migrateImageFor(BASE_IMG), 'qa-session-base', `${WORK}/.env.qa-base`],
    [migrateImageFor(PR_IMG), 'qa-session-pr', `${WORK}/.env.qa-pr`],
    [BASE_IMG, 'qa-session-base', `${WORK}/.env.qa-base`],
    [PR_IMG, 'qa-session-pr', `${WORK}/.env.qa-pr`],
  ])
  // No container joins a second network afterwards: a boot creates networks, and nothing else.
  for (const { args } of docker(s.exec)) {
    if (args[0] === 'network') assert.equal(args[1], 'create', args.join(' '))
  }
  const created = docker(s.exec).filter(c => c.args[0] === 'network' && c.args[1] === 'create').map(c => c.args.at(-1))
  assert.deepEqual(created, ['qa-session-base', 'qa-session-pr'])
  assert.deepEqual(s.provisioner.networks, { base: 'qa-session-base', pr: 'qa-session-pr' })
  assert.ok(Object.isFrozen(s.provisioner.networks), 'networks can\'t be pointed at one network afterwards')
})

test('each pane\'s database gets its own password, never in argv, and only its own pane\'s DSN and env file carry it', async () => {
  const s = makeSession()
  await bootSession(s.deps, 7)
  const base = pgPassword(s.exec, 'base')
  const pr = pgPassword(s.exec, 'pr')
  assert.match(base, PASSWORD)
  assert.match(pr, PASSWORD)
  assert.notEqual(base, pr)
  // The value goes in the docker CLI's env, under a bare -e POSTGRES_PASSWORD.
  for (const role of ['base', 'pr']) {
    const { args, env } = runs(s.exec).find(c => valueOf(c.args, '--name') === `qa-pg-${role}`)
    assert.ok(args.includes('POSTGRES_PASSWORD'), 'a bare -e POSTGRES_PASSWORD')
    assert.ok(env.PATH !== undefined || process.env.PATH === undefined, 'the CLI keeps the conductor\'s env')
  }
  for (const { args } of s.exec.calls) {
    for (const secret of [base, pr]) assert.ok(!args.join(' ').includes(secret), `no password in argv: ${args.join(' ')}`)
  }
  // Only the postgres runs get a password in their env.
  for (const c of s.exec.calls) {
    if (c.env?.POSTGRES_PASSWORD === undefined) continue
    assert.ok(c.file === 'docker' && c.args[0] === 'run' && /^qa-pg-/.test(valueOf(c.args, '--name')), 'only runPg passes a password')
  }
  assert.equal(s.dsns.base, `postgresql://qa:${base}@qa-pg-base:5432`)
  assert.equal(s.dsns.pr, `postgresql://qa:${pr}@qa-pg-pr:5432`)
  const baseEnv = s.fsx.files.get(`${WORK}/.env.qa-base`)
  const prEnv = s.fsx.files.get(`${WORK}/.env.qa-pr`)
  assert.equal(baseEnv.mode, 0o600)
  assert.equal(prEnv.mode, 0o600)
  assert.ok(baseEnv.text.includes(base) && !baseEnv.text.includes(pr), 'the base env file holds the base password only')
  assert.ok(prEnv.text.includes(pr) && !prEnv.text.includes(base), 'the PR env file holds the PR password only')
})

test('every boot draws new passwords, and each boot\'s DSNs carry that boot\'s', async () => {
  const s = makeSession()
  const dsns = []
  for (let boot = 0; boot < 2; boot++) {
    await bootSession(s.deps, 7)
    dsns.push(s.dsns.base, s.dsns.pr)
  }
  const passwords = runs(s.exec).filter(c => /^qa-pg-/.test(valueOf(c.args, '--name') ?? '')).map(c => c.env.POSTGRES_PASSWORD)
  assert.equal(passwords.length, 4)
  assert.equal(new Set(passwords).size, 4)
  assert.deepEqual(dsns.map(dsn => new URL(dsn).password), passwords)
})

test('teardown removes each pane\'s own network, and sweep removes both and the shared one earlier versions made', async () => {
  const s = makeSession()
  await bootSession(s.deps, 7)
  const before = docker(s.exec).length
  await teardownSession({ provisioner: s.provisioner })
  const teardown = docker(s.exec).slice(before).map(c => c.args.join(' '))
  // The migrate run is named too, so a teardown during migrating removes it,
  // and with it the last endpoint that would keep the network alive.
  assert.deepEqual(runs(s.exec).filter(c => c.args.includes('--rm')).map(c => valueOf(c.args, '--name')), ['qa-migrate-base', 'qa-migrate-pr'])
  assert.deepEqual(teardown, [
    'rm -f -v qa-app-base qa-migrate-base qa-pg-base',
    'network rm qa-session-base',
    'rm -f -v qa-app-pr qa-migrate-pr qa-pg-pr',
    'network rm qa-session-pr',
  ])
  assert.deepEqual(s.fsx.removed, [`${WORK}/.env.qa-base`, `${WORK}/.env.qa-pr`])

  // The shared network 0.3.1 made carries the conductor's label: sweep
  // removes a network of the prefix's name only then, never one of yours.
  const labelled = names => args => args[0] === 'network' && args[1] === 'ls' ? names : null
  const swept = recordingExec({ answer: labelled('qa-session\nqa-session-base\n') })
  const sweptFs = recordingFs()
  const fresh = createDockerProvisioner({ docker: makeDocker(swept), fsx: sweptFs, workDir: WORK })
  await fresh.sweep()
  assert.deepEqual(docker(swept).map(c => c.args.join(' ')), [
    'ps -aq --filter label=qa-conductor-session',
    'network rm qa-session-base',
    'network rm qa-session-pr',
    'network ls --filter label=qa-conductor-session --format {{.Name}}',
    'network rm qa-session',
  ])
  // The env files an earlier run left behind hold its passwords.
  assert.deepEqual(sweptFs.removed, [`${WORK}/.env.qa-base`, `${WORK}/.env.qa-pr`])
  const yours = recordingExec({ answer: labelled('qa-session-base\nqa-session-x\n') })
  await createDockerProvisioner({ docker: makeDocker(yours), fsx: recordingFs(), workDir: WORK }).sweep()
  assert.ok(!docker(yours).some(c => c.args.join(' ') === 'network rm qa-session'), 'an unlabelled network of that name is left alone')

  // A prefix Docker could take for one of its own networks, or for the start
  // of a network id, is fine for the pane networks, but sweep leaves that
  // name itself alone.
  for (const prefix of ['host', 'bridge', 'cafe']) {
    const exec = recordingExec({ answer: labelled(`${prefix}\n`) })
    const p = createDockerProvisioner({ docker: makeDocker(exec), fsx: recordingFs(), workDir: WORK, network: prefix })
    assert.deepEqual(p.networks, { base: `${prefix}-base`, pr: `${prefix}-pr` })
    await p.sweep()
    assert.deepEqual(docker(exec).map(c => c.args.join(' ')).slice(1), [`network rm ${prefix}-base`, `network rm ${prefix}-pr`], prefix)
  }

  // The env files go first, and a missing one is fine: a daemon that isn't up
  // yet fails the sweep, but not before the passwords are gone.
  const down = recordingExec({ answer: args => args[0] === 'ps' ? Object.assign(new Error('docker ps: Command failed'), { stderr: 'Cannot connect to the Docker daemon' }) : null })
  const enoent = { ...recordingFs(), removed: [] }
  enoent.unlink = async file => { enoent.removed.push(file); throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }) }
  await assert.rejects(createDockerProvisioner({ docker: makeDocker(down), fsx: enoent, workDir: WORK }).sweep(), /docker ps/)
  assert.deepEqual(enoent.removed, [`${WORK}/.env.qa-base`, `${WORK}/.env.qa-pr`])
  await createDockerProvisioner({ docker: makeDocker(recordingExec()), fsx: enoent, workDir: WORK }).sweep()
})

test('network as a prefix or as { base, pr }; two panes on one network are refused', async () => {
  const prefixed = makeSession({ provisionerOptions: { network: 'widget-qa' } })
  await bootSession(prefixed.deps, 7)
  assert.deepEqual(prefixed.provisioner.networks, { base: 'widget-qa-base', pr: 'widget-qa-pr' })
  assert.deepEqual(new Set(runs(prefixed.exec).map(c => `${roleOf(c.args)} ${valueOf(c.args, '--network')}`)), new Set(['base widget-qa-base', 'pr widget-qa-pr']))

  const named = makeSession({ provisionerOptions: { network: { base: 'blue', pr: 'green' } } })
  await bootSession(named.deps, 7)
  assert.deepEqual(new Set(runs(named.exec).map(c => `${roleOf(c.args)} ${valueOf(c.args, '--network')}`)), new Set(['base blue', 'pr green']))
  const swept = recordingExec()
  await createDockerProvisioner({ docker: makeDocker(swept), fsx: recordingFs(), workDir: WORK, network: { base: 'blue', pr: 'green' } }).sweep()
  assert.deepEqual(docker(swept).map(c => c.args.join(' ')).slice(1), ['network rm blue', 'network rm green'])

  for (const network of [
    { base: 'one', pr: 'one' }, { base: 'one' }, { base: '', pr: 'two' }, '', 7, null,
    // Docker's and Podman's own networks and modes would put a pane on the
    // host or beside other containers.
    { base: 'host', pr: 'two' }, { base: 'one', pr: 'bridge' }, { base: 'none', pr: 'two' }, { base: 'one', pr: 'default' },
    { base: 'podman', pr: 'two' }, { base: 'one', pr: 'ingress' }, { base: 'docker_gwbridge', pr: 'two' }, { base: 'one', pr: 'container:qa-app-base' },
    { base: 'private', pr: 'two' }, { base: 'one', pr: 'pasta' }, { base: 'slirp4netns', pr: 'two' }, { base: 'one', pr: 'podman-default-kube-network' },
    // Lowercase hex: Docker would read it as the start of some other network's id.
    { base: 'a', pr: 'two' }, { base: 'one', pr: '1' }, { base: 'cafe', pr: 'two' },
    { base: 'one', pr: 'two words' }, '-dash', 'a/b',
  ]) {
    assert.throws(() => createDockerProvisioner({ docker: makeDocker(recordingExec()), fsx: recordingFs(), workDir: WORK, network }), /network/, JSON.stringify(network))
  }
  // Network ids are lowercase, so an uppercase name can't be taken for one.
  assert.deepEqual(createDockerProvisioner({ docker: makeDocker(recordingExec()), fsx: recordingFs(), workDir: WORK, network: { base: 'CAFE', pr: 'DB' } }).networks, { base: 'CAFE', pr: 'DB' })
  // a role other than base or pr has no network
  const s = makeSession()
  await assert.rejects(s.provisioner.provisionDatabase({ paneRef: { role: 'other' }, databases: [] }), /role/)
  assert.equal(docker(s.exec).length, 0)
})

const failure = stderr => Object.assign(new Error('docker network: Command failed'), { stderr })
const createFails = stderr => args => args[0] === 'network' && args[1] === 'create' ? failure(stderr) : null

test('a pane network that already exists by that very name is reused; any other failure to create one fails the boot', async () => {
  // Docker says so, and an inspect by name finds that very network.
  const exists = makeSession({
    answer: args => createFails('Error response from daemon: network with name qa-session-base already exists')(args)
      ?? (args[0] === 'network' && args[1] === 'inspect' ? `${args.at(-1)}\n` : null),
  })
  await bootSession(exists.deps, 7)
  assert.equal(runs(exists.exec).length, 6)
  assert.deepEqual(docker(exists.exec).filter(c => c.args[0] === 'network' && c.args[1] === 'inspect').map(c => c.args.join(' ')), [
    'network inspect --format {{.Name}} qa-session-base',
    'network inspect --format {{.Name}} qa-session-pr',
  ])

  for (const [why, answer] of [
    ['no address pool left', createFails('Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network')],
    // Another "already exists", and no network of that name.
    ['an iptables chain', args => createFails('Error response from daemon: Chain already exists')(args) ?? (args[1] === 'inspect' ? failure('Error: No such network: qa-session-base') : null)],
    // Only a network whose id starts with the name.
    ['another network\'s id', args => createFails('Error response from daemon: network with name qa-session-base already exists')(args) ?? (args[1] === 'inspect' ? 'some-other-network\n' : null)],
    // A failure that isn't about the name, though such a network exists.
    ['an unrelated failure', args => createFails('permission denied while trying to connect to the Docker daemon socket')(args) ?? (args[1] === 'inspect' ? `${args.at(-1)}\n` : null)],
  ]) {
    const s = makeSession({ answer })
    await assert.rejects(s.provisioner.provisionDatabase({ paneRef: { role: 'base' }, databases: [] }), err => err.message === 'docker network: Command failed', why)
    assert.equal(runs(s.exec).length, 0, `${why}: no container starts without its network`)
  }
})

test('an explicit postgres password is used for both panes, and other postgres keys keep their defaults', async () => {
  const s = makeSession({ provisionerOptions: { postgres: { password: 'hunter2' } } })
  await bootSession(s.deps, 7)
  assert.equal(pgPassword(s.exec, 'base'), 'hunter2')
  assert.equal(pgPassword(s.exec, 'pr'), 'hunter2')
  assert.equal(s.dsns.base, 'postgresql://qa:hunter2@qa-pg-base:5432')
  assert.equal(s.dsns.pr, 'postgresql://qa:hunter2@qa-pg-pr:5432')
  // the networks still keep them apart
  assert.deepEqual(s.provisioner.networks, { base: 'qa-session-base', pr: 'qa-session-pr' })
  // a postgres option without user or db keeps 'qa' and 'postgres'
  const { db } = await s.provisioner.provisionDatabase({ paneRef: { role: 'base' }, databases: [] })
  await db.query('SELECT 1')
  assert.deepEqual(docker(s.exec).at(-1).args, ['exec', 'qa-pg-base', 'psql', '-U', 'qa', '-d', 'postgres', '-t', '-A', '-c', 'SELECT 1'])

  // The old default, given explicitly, is an explicit password like any other.
  const qa = makeSession({ provisionerOptions: { postgres: { user: 'qa', password: 'qa', db: 'postgres' } } })
  await bootSession(qa.deps, 7)
  assert.deepEqual([pgPassword(qa.exec, 'base'), pgPassword(qa.exec, 'pr')], ['qa', 'qa'])

  // An explicit password must be a non-empty string with no control
  // characters (a line break would reach the env file); undefined means none.
  for (const password of ['', 42, false, null, 'two\nlines', 'tab\there', 'nul\0']) {
    assert.throws(() => createDockerProvisioner({ docker: makeDocker(recordingExec()), fsx: recordingFs(), workDir: WORK, postgres: { password } }), /postgres\.password/, JSON.stringify(password))
  }
  const unset = makeSession({ provisionerOptions: { postgres: { password: undefined } } })
  await bootSession(unset.deps, 7)
  assert.notEqual(pgPassword(unset.exec, 'base'), pgPassword(unset.exec, 'pr'))

  // The DSN encodes the user and password, so a URL parser reads them back.
  const odd = makeSession({ provisionerOptions: { postgres: { user: 'qa:user', password: 'p@ss:w/rd#1%?$&+,' } } })
  await bootSession(odd.deps, 7)
  assert.equal(pgPassword(odd.exec, 'base'), 'p@ss:w/rd#1%?$&+,')
  assert.equal(odd.dsns.base, 'postgresql://qa%3Auser:p%40ss%3Aw%2Frd%231%25%3F%24%26%2B%2C@qa-pg-base:5432')
  const url = new URL(odd.dsns.base)
  assert.deepEqual([decodeURIComponent(url.username), decodeURIComponent(url.password), url.host], ['qa:user', 'p@ss:w/rd#1%?$&+,', 'qa-pg-base:5432'])

  // postgres: null is no postgres at all.
  const none = makeSession({ provisionerOptions: { postgres: null } })
  await bootSession(none.deps, 7)
  assert.match(none.dsns.base, /^postgresql:\/\/qa:[0-9a-f]{48}@qa-pg-base:5432$/)

  // Keys present but undefined (an unset env var, say) keep their defaults.
  const unsetKeys = makeSession({ provisionerOptions: { postgres: { user: undefined, db: undefined, password: undefined } } })
  await bootSession(unsetKeys.deps, 7)
  assert.match(unsetKeys.dsns.base, /^postgresql:\/\/qa:[0-9a-f]{48}@qa-pg-base:5432$/)
  const { db: unsetDb } = await unsetKeys.provisioner.provisionDatabase({ paneRef: { role: 'base' }, databases: [] })
  await unsetDb.query('SELECT 1')
  assert.deepEqual(docker(unsetKeys.exec).at(-1).args.slice(5, 7), ['-d', 'postgres'])

  const widget = makeSession({ provisionerOptions: { postgres: { user: 'widget', db: 'maindb' } } })
  await bootSession(widget.deps, 7)
  assert.match(widget.dsns.base, /^postgresql:\/\/widget:[0-9a-f]{48}@qa-pg-base:5432$/)
  assert.match(widget.dsns.pr, /^postgresql:\/\/widget:[0-9a-f]{48}@qa-pg-pr:5432$/)
  assert.notEqual(pgPassword(widget.exec, 'base'), pgPassword(widget.exec, 'pr'))
  // db.query uses the provisioner's db by default
  const { db: widgetDb } = await widget.provisioner.provisionDatabase({ paneRef: { role: 'pr' }, databases: [] })
  await widgetDb.query('SELECT 1')
  assert.deepEqual(docker(widget.exec).at(-1).args.slice(0, 6), ['exec', 'qa-pg-pr', 'psql', '-U', 'qa', '-d'])
  assert.equal(docker(widget.exec).at(-1).args[6], 'maindb')
})

// A torn-down or taken-over session aborts its boot, but a boot may be in the
// middle of a pull that takes minutes. Once that returns, the stale boot must
// not write the next session's env file or start a container on its network.
test('an aborted boot starts no container and writes no env file once it was aborted, even mid-pull', async () => {
  for (const [stage, image] of [['migrate', migrateImageFor(PR_IMG)], ['app', PR_IMG]]) {
    const controller = new AbortController()
    // The pull of that image is where the abort lands.
    const s = makeSession({
      answer: args => {
        if (args[0] === 'image' && args[1] === 'inspect' && args[2] === image) controller.abort()
        return null
      },
    })
    s.deps.signal = controller.signal
    await assert.rejects(bootSession(s.deps, 7), err => err.name === 'AbortError', stage)
    const prRuns = runs(s.exec).filter(c => roleOf(c.args) === 'pr' && !/^qa-pg-/.test(valueOf(c.args, '--name')))
    const after = stage === 'migrate' ? [] : [migrateImageFor(PR_IMG)]
    assert.deepEqual(prRuns.map(c => c.args.at(-1)), after, `${stage}: no PR run after the abort`)
    if (stage === 'migrate') assert.ok(!s.fsx.files.has(`${WORK}/.env.qa-pr`), 'no PR env file written after the abort')
  }
  // Already aborted: no call at all, not a registry login, not a pull, and
  // no env file.
  const controller = new AbortController()
  controller.abort()
  const s = makeSession({ provisionerOptions: { registry: { user: 'acme-bot', token: 't0ken' } } })
  for (const call of steps(controller.signal)) await assert.rejects(call(s.provisioner), err => err.name === 'AbortError')
  assert.deepEqual(s.exec.calls, [])
  assert.equal(s.fsx.files.size, 0)

  // Aborted while the step before runs: nothing after it happens.
  const PG_RUN = args => args[0] === 'run' && valueOf(args, '--name') === 'qa-pg-base'
  const LOGIN = args => args[0] === '-c' && args[1].includes('docker login')
  for (const [when, step, abortOn, after, options] of [
    ['the network is created', 0, args => args[0] === 'network' && args[1] === 'create', c => c.args[0] === 'run' || c.args[0] === 'image'],
    // The postgres image is pulled before its container is created, so an
    // abort can land between the two.
    ['the postgres image is pulled', 0, args => args[0] === 'image' && args[2] === 'postgres:16', c => c.args[0] === 'run'],
    ['postgres starts', 0, PG_RUN, c => c.args[0] === 'exec' && c.args.includes('CREATE DATABASE app')],
    // The last step: the call still rejects, so the core never seeds it.
    ['the last database is created', 0, args => args.includes('CREATE DATABASE app'), () => false],
    ['the registry login for the migrate image', 1, LOGIN, c => c.args[0] === 'image' || c.write, { registry: { user: 'acme-bot', token: 't0ken' } }],
    ['the registry login for the app image', 2, LOGIN, c => c.args[0] === 'image' || c.write, { registry: { user: 'acme-bot', token: 't0ken' } }],
    ['the migrate image is pulled', 1, args => args[0] === 'image', c => c.args[0] === 'run' || c.write],
    ['the migrate env file is written', 1, args => args[0] === 'write', c => c.args[0] === 'run'],
    ['the app image is pulled', 2, args => args[0] === 'image', c => c.args[0] === 'run' || c.write],
    ['the app env file is written', 2, args => args[0] === 'write', c => c.args[0] === 'run'],
  ]) {
    const ctl = new AbortController()
    const log = []
    const s2 = makeSession({ provisionerOptions: options, answer: args => { log.push({ args, after: ctl.signal.aborted }); if (abortOn(args)) ctl.abort(); return null } })
    const write = s2.fsx.writeFile
    s2.fsx.writeFile = async (file, text, opts) => {
      log.push({ args: ['write', file], write: true, after: ctl.signal.aborted })
      await write(file, text, opts)
      if (abortOn(['write'])) ctl.abort()
    }
    await assert.rejects(steps(ctl.signal)[step](s2.provisioner), err => err.name === 'AbortError', when)
    assert.ok(ctl.signal.aborted, `${when}: the abort happened`)
    assert.deepEqual(log.filter(c => c.after && after(c)).map(c => c.args.join(' ')), [], `${when}: nothing after the abort`)
  }
})

// The three provisioner steps that create or change something, for the base pane.
function steps(signal) {
  return [
    p => p.provisionDatabase({ paneRef: { role: 'base' }, databases: ['app'], signal }),
    p => p.runMigrate({ paneRef: { role: 'base' }, migrate: { image: migrateImageFor(BASE_IMG) }, env: { app: {} }, signal }),
    p => p.launchServices({ paneRef: { role: 'base' }, services: { app: BASE_IMG }, env: { app: {} }, reserved: { app: { port: 3111 } }, signal }),
  ]
}
