import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { createDocker } from '../lib/docker.mjs'
import { makeExecFileFn } from '../lib/exec.mjs'

function recordingExec(stdoutByIndex = []) {
  const calls = []
  let i = 0
  const fn = async (file, args) => {
    calls.push([file, ...args])
    const result = stdoutByIndex[i++]
    if (result instanceof Error) throw result
    return { stdout: result ?? '' }
  }
  fn.calls = calls
  return fn
}

test('run passes raw argv to docker and returns stdout', async () => {
  const exec = recordingExec(['out\n'])
  const docker = createDocker({ execFileFn: exec })
  const out = await docker.run(['ps', '-a'])
  assert.deepEqual(exec.calls, [['docker', 'ps', '-a']])
  assert.equal(out, 'out\n')
})

// The env each call was given, beside its argv.
function envRecordingExec() {
  const calls = []
  const fn = async (file, args, opts = {}) => {
    calls.push({ argv: [file, ...args], env: opts.env ?? null })
    return { stdout: '' }
  }
  fn.calls = calls
  return fn
}

test('runPg builds the exact docker run argv, and passes the password in the CLI\'s env, never argv', async () => {
  const exec = envRecordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.runPg('qa-pg-base', 'qa-session-base')
  assert.deepEqual(exec.calls[0].argv, [
    'docker', 'run', '-d',
    '--name', 'qa-pg-base',
    '--network', 'qa-session-base',
    '--label', 'qa-conductor-session',
    '-e', 'POSTGRES_USER=qa',
    // no value: docker takes it from its own environment
    '-e', 'POSTGRES_PASSWORD',
    '-e', 'POSTGRES_DB=postgres',
    // A password over TCP, whatever the image's own ENV says (some bake in
    // trust); md5 uses SCRAM where the stored password is SCRAM.
    '-e', 'POSTGRES_HOST_AUTH_METHOD=md5',
    'postgres:16',
  ])
  assert.equal(exec.calls[0].env.POSTGRES_PASSWORD, 'qa')
})

test('runPg keeps the conductor\'s whole env for the CLI, with its password over any POSTGRES_PASSWORD there, and returns docker\'s output', async t => {
  // HOME, PATH and DOCKER_HOST must reach the CLI, or the container could go
  // to another daemon than its network; a CI host often sets POSTGRES_PASSWORD.
  const saved = { DOCKER_HOST: process.env.DOCKER_HOST, POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD }
  process.env.DOCKER_HOST = 'unix:///run/qa-test.sock'
  process.env.POSTGRES_PASSWORD = 'from-the-host'
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const calls = []
  const docker = createDocker({ execFileFn: async (file, args, opts) => { calls.push(opts.env); return { stdout: 'c0ffee\n' } } })
  assert.equal(await docker.runPg('qa-pg-pr', 'qa-session-pr', { password: 'per-call' }), 'c0ffee\n')
  assert.equal(calls[0].POSTGRES_PASSWORD, 'per-call')
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'POSTGRES_PASSWORD') assert.equal(calls[0][key], value, key)
  }
})

test('runPg takes a per-call password, which wins over createDocker\'s postgres.password', async () => {
  const exec = envRecordingExec()
  const docker = createDocker({ execFileFn: exec, postgres: { password: 'hunter2' } })
  await docker.runPg('qa-pg-pr', 'qa-session-pr', { password: 'a1b2c3' })
  await docker.runPg('qa-pg-base', 'qa-session-base')
  assert.equal(exec.calls[0].env.POSTGRES_PASSWORD, 'a1b2c3')
  assert.equal(exec.calls[1].env.POSTGRES_PASSWORD, 'hunter2')
  for (const { argv } of exec.calls) assert.ok(!argv.some(a => a.includes('a1b2c3') || a.includes('hunter2')), argv.join(' '))
})

test('runPg refuses a password that is empty or not a string, before running docker', async () => {
  for (const password of ['', null, 42]) {
    const exec = envRecordingExec()
    const docker = createDocker({ execFileFn: exec })
    await assert.rejects(docker.runPg('qa-pg-base', 'qa-session-base', { password }), /password/, String(password))
    assert.equal(exec.calls.length, 0)
  }
  const exec = envRecordingExec()
  await assert.rejects(createDocker({ execFileFn: exec, postgres: { password: '' } }).runPg('p', 'n'), /password/)
  assert.equal(exec.calls.length, 0)
})

// Through the real execFile: the password reaches the CLI's env, and a failed
// run's error, which the harness shows every viewer, doesn't carry it.
test('a failed runPg through makeExecFileFn: the CLI got the password in its env, and the error never holds it', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-runpg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stub = path.join(dir, 'docker')
  // The stub writes beside itself ("$0.seen"), so no path goes into its source.
  writeFileSync(stub, '#!/bin/sh\nprintf %s "$POSTGRES_PASSWORD" > "$0.seen"\necho "docker: Error response from daemon: Conflict." >&2\nexit 125\n', { mode: 0o755 })
  const real = makeExecFileFn()
  const docker = createDocker({ execFileFn: (cmd, args, opts) => real(cmd === 'docker' ? stub : cmd, args, opts) })
  const password = 'f00dfeedcafe0123456789abcdef0123456789abcdef0123'
  const err = await docker.runPg('qa-pg-base', 'qa-session-base', { password }).then(() => assert.fail('should reject'), e => e)
  assert.equal(readFileSync(`${stub}.seen`, 'utf8'), password)
  assert.match(err.message, /Conflict/)
  for (const text of [err.message, err.stderr, err.stdout, String(err.cause?.cmd), err.cause?.message, JSON.stringify(err), inspect(err, { showHidden: true, depth: 5 })]) {
    assert.ok(!String(text).includes(password), `no password in: ${text}`)
  }
})

test('runMigrate names its container when given a name', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.runMigrate('ghcr.io/x/app:migrate-pr-7-abc', 'qa-session-pr', '/compose/.env.qa-pr', { name: 'qa-migrate-pr' })
  assert.deepEqual(exec.calls, [[
    'docker', 'run', '--rm',
    '--name', 'qa-migrate-pr',
    '--network', 'qa-session-pr',
    '--label', 'qa-conductor-session',
    '--env-file', '/compose/.env.qa-pr',
    'ghcr.io/x/app:migrate-pr-7-abc',
  ]])
})

test('createDocker threads a custom postgres identity and label through argv', async () => {
  const exec = recordingExec(['', 'accepting\n', '1\n', 'accepting\n', '1\n'])
  const docker = createDocker({
    execFileFn: exec,
    label: 'widget-qa-session',
    postgres: { image: 'postgres:15', user: 'widget', password: 'hunter2', db: 'maindb' },
  })
  await docker.runPg('widget-pg', 'widget-qa')
  assert.deepEqual(exec.calls[0], [
    'docker', 'run', '-d',
    '--name', 'widget-pg',
    '--network', 'widget-qa',
    '--label', 'widget-qa-session',
    '-e', 'POSTGRES_USER=widget',
    '-e', 'POSTGRES_PASSWORD',
    '-e', 'POSTGRES_DB=maindb',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=md5',
    'postgres:15',
  ])
  // readiness probes use the custom superuser + db
  await docker.waitHealthyPg('widget-pg', {})
  assert.deepEqual(exec.calls[1], ['docker', 'exec', 'widget-pg', 'pg_isready', '-U', 'widget'])
  assert.deepEqual(exec.calls[2], ['docker', 'exec', 'widget-pg', 'psql', '-U', 'widget', '-d', 'maindb', '-c', 'SELECT 1'])
})

test('createDocker partial postgres override fills the rest from defaults', async () => {
  const exec = envRecordingExec()
  const docker = createDocker({ execFileFn: exec, postgres: { user: 'widget' } })
  await docker.runPg('p', 'n')
  const { argv, env } = exec.calls[0]
  assert.ok(argv.includes('POSTGRES_USER=widget'))
  assert.equal(env.POSTGRES_PASSWORD, 'qa') // default retained
  // keys set to undefined (an unset env var, say) keep their defaults too
  const unset = envRecordingExec()
  await createDocker({ execFileFn: unset, postgres: { image: undefined, user: undefined, password: undefined, db: undefined } }).runPg('p', 'n')
  assert.ok(unset.calls[0].argv.includes('postgres:16') && unset.calls[0].argv.includes('POSTGRES_USER=qa') && unset.calls[0].argv.includes('POSTGRES_DB=postgres'), unset.calls[0].argv.join(' '))
  assert.equal(unset.calls[0].env.POSTGRES_PASSWORD, 'qa')
  assert.ok(argv.includes('POSTGRES_DB=postgres')) // default retained
  assert.ok(argv.includes('postgres:16')) // default image retained
  assert.ok(argv.includes('qa-conductor-session')) // default label retained
})

test('cloneDb and psql use the configured superuser', async () => {
  const exec = recordingExec(['', ''])
  const docker = createDocker({ execFileFn: exec, postgres: { user: 'widget', db: 'maindb' } })
  await docker.cloneDb('widget-db-1', 'widget-pg', 'core')
  assert.deepEqual(exec.calls[0], ['docker', 'exec', 'widget-pg', 'psql', '-U', 'widget', '-d', 'maindb', '-c', 'CREATE DATABASE core'])
  assert.equal(exec.calls[1][0], 'sh')
  assert.ok(exec.calls[1][2].includes('pg_dump -U widget'))
  assert.ok(exec.calls[1][2].includes('psql -q -U widget -d core'))
})

test('runApp builds the exact docker run argv with loopback port mapping', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.runApp('qa-app-pr', 'ghcr.io/x/app:pr-7-abc', 'qa-session', '/compose/.env.qa-pr', 3112)
  assert.deepEqual(exec.calls, [[
    'docker', 'run', '-d',
    '--name', 'qa-app-pr',
    '--network', 'qa-session',
    '--label', 'qa-conductor-session',
    '--env-file', '/compose/.env.qa-pr',
    '-p', '127.0.0.1:3112:3000',
    'ghcr.io/x/app:pr-7-abc',
  ]])
})

test('runMigrate builds the exact docker run argv', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.runMigrate('ghcr.io/x/app:migrate-pr-7-abc', 'qa-session', '/compose/.env.qa-pr')
  assert.deepEqual(exec.calls, [[
    'docker', 'run', '--rm',
    '--network', 'qa-session',
    '--label', 'qa-conductor-session',
    '--env-file', '/compose/.env.qa-pr',
    'ghcr.io/x/app:migrate-pr-7-abc',
  ]])
})

test('waitHealthyPg needs two consecutive isready+query probes', async () => {
  const exec = recordingExec([
    new Error('not ready'),      // attempt 1: pg_isready fails
    new Error('not ready'),      // attempt 2: pg_isready fails
    'accepting connections\n',   // attempt 3: pg_isready ok
    '1\n',                       // attempt 3: SELECT 1 ok (1st consecutive)
    'accepting connections\n',   // attempt 4: pg_isready ok
    '1\n',                       // attempt 4: SELECT 1 ok (2nd consecutive -> done)
  ])
  const sleeps = []
  const sleepFn = async (ms) => sleeps.push(ms)
  const docker = createDocker({ execFileFn: exec })
  await docker.waitHealthyPg('qa-pg-base', { retries: 5, sleepFn })
  assert.equal(exec.calls.length, 6)
  assert.deepEqual(exec.calls[0], ['docker', 'exec', 'qa-pg-base', 'pg_isready', '-U', 'qa'])
  assert.deepEqual(exec.calls[3], ['docker', 'exec', 'qa-pg-base', 'psql', '-U', 'qa', '-d', 'postgres', '-c', 'SELECT 1'])
  assert.equal(sleeps.length, 3)
})

test('waitHealthyPg resets the streak when the temporary init server drops', async () => {
  const exec = recordingExec([
    'accepting connections\n',   // attempt 1: temporary initdb server answers
    '1\n',                       //            ...and even runs a query
    new Error('shutting down'),  // attempt 2: entrypoint restart gap -> reset
    'accepting connections\n',   // attempt 3: real server up
    '1\n',
    'accepting connections\n',   // attempt 4: still up -> done
    '1\n',
  ])
  const docker = createDocker({ execFileFn: exec })
  await docker.waitHealthyPg('qa-pg-base', { retries: 6, sleepFn: async () => {} })
  assert.equal(exec.calls.length, 7)
})

test('waitHealthyPg throws after exhausting retries', async () => {
  const exec = recordingExec([new Error('no'), new Error('no'), new Error('no')])
  const docker = createDocker({ execFileFn: exec })
  await assert.rejects(
    docker.waitHealthyPg('qa-pg-base', { retries: 3, sleepFn: async () => {} }),
    /qa-pg-base/,
  )
  assert.equal(exec.calls.length, 3)
})

test('login pipes the token via child env and stdin, never argv', async () => {
  const calls = []
  const execFileFn = async (file, args, opts) => {
    calls.push([file, args, opts])
    return { stdout: '' }
  }
  const docker = createDocker({ execFileFn })
  await docker.login('238855', 'sekret-tok')
  const [cmd, args, opts] = calls[0]
  assert.equal(cmd, 'sh')
  assert.ok(args[1].includes('docker login ghcr.io'))
  assert.ok(!args.join(' ').includes('sekret-tok'))
  assert.equal(opts.env.GHCR_TOKEN, 'sekret-tok')
  assert.equal(opts.env.GHCR_USER, '238855')
})

test('login merges the parent env so HOME survives (credential goes to the right place)', async () => {
  const calls = []
  const execFileFn = async (file, args, opts) => { calls.push([file, args, opts]); return { stdout: '' } }
  const docker = createDocker({ execFileFn })
  await docker.login('238855', 'tok')
  const opts = calls[0][2]
  // asserts we spread process.env rather than replacing it: PATH (always set) is present
  assert.ok('PATH' in opts.env)
  assert.equal(opts.env.GHCR_TOKEN, 'tok')
})

test('ensureImage no-ops when the image is already present', async () => {
  const exec = recordingExec(['{}\n']) // image inspect succeeds
  const docker = createDocker({ execFileFn: exec })
  await docker.ensureImage('ghcr.io/x/app:pr-1-abc')
  assert.deepEqual(exec.calls, [['docker', 'image', 'inspect', 'ghcr.io/x/app:pr-1-abc']])
})

test('ensureImage pulls, retrying with a relogin on transient denied', async () => {
  const exec = recordingExec([
    new Error('No such image'), // inspect fails -> not present
    new Error('denied'),        // pull attempt 1 fails
    'pulled\n',                 // pull attempt 2 succeeds
  ])
  const docker = createDocker({ execFileFn: exec })
  let relogins = 0
  await docker.ensureImage('ghcr.io/x/app:pr-1-abc', { sleepFn: async () => {}, relogin: async () => { relogins++ } })
  assert.equal(relogins, 1)
  assert.deepEqual(exec.calls[1], ['docker', 'pull', 'ghcr.io/x/app:pr-1-abc'])
  assert.deepEqual(exec.calls[2], ['docker', 'pull', 'ghcr.io/x/app:pr-1-abc'])
})

test('ensureImage throws after exhausting pull retries', async () => {
  const exec = recordingExec([new Error('nope'), new Error('denied'), new Error('denied'), new Error('denied')])
  const docker = createDocker({ execFileFn: exec })
  await assert.rejects(
    docker.ensureImage('ghcr.io/x/app:pr-1-abc', { retries: 3, sleepFn: async () => {} }),
    /failed after 3 attempts/,
  )
})

test('cloneDb creates the target db then pipes pg_dump into psql via one sh -c', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.cloneDb('prod-db', 'qa-pg-base', 'idp')
  assert.deepEqual(exec.calls, [
    ['docker', 'exec', 'qa-pg-base', 'psql', '-U', 'qa', '-d', 'postgres', '-c', 'CREATE DATABASE idp'],
    ['sh', '-c', 'docker exec prod-db pg_dump -U qa --clean --if-exists idp | docker exec -i qa-pg-base psql -q -U qa -d idp'],
  ])
})

test('createDatabase issues CREATE and returns; tolerates already-exists', async () => {
  const ok = recordingExec([''])
  const docker = createDocker({ execFileFn: ok })
  await docker.createDatabase('qa-pg-base', 'idp')
  assert.deepEqual(ok.calls, [['docker', 'exec', 'qa-pg-base', 'psql', '-U', 'qa', '-d', 'postgres', '-c', 'CREATE DATABASE idp']])

  const exists = recordingExec([new Error('ERROR:  database "idp" already exists')])
  const docker2 = createDocker({ execFileFn: exists })
  await docker2.createDatabase('qa-pg-base', 'idp') // resolves, no throw
  assert.equal(exists.calls.length, 1)
})

test('createDatabase retries transient connection errors then succeeds', async () => {
  const exec = recordingExec([new Error('connection to server on socket failed'), ''])
  const sleeps = []
  const docker = createDocker({ execFileFn: exec })
  await docker.createDatabase('qa-pg-base', 'idp', { sleepFn: async ms => sleeps.push(ms) })
  assert.equal(exec.calls.length, 2)
  assert.equal(sleeps.length, 1)
})

test('pipeDump runs one sh -c pg_dump|psql and validates names', async () => {
  const exec = recordingExec([''])
  const docker = createDocker({ execFileFn: exec })
  await docker.pipeDump('prod-db', 'qa-pg-base', 'idp')
  assert.equal(exec.calls[0][0], 'sh')
  assert.equal(exec.calls[0][2], 'docker exec prod-db pg_dump -U qa --clean --if-exists idp | docker exec -i qa-pg-base psql -q -U qa -d idp')
  await assert.rejects(docker.pipeDump('bad;name', 'qa-pg-base', 'idp'), /unsafe/)
})

test('cloneDb tolerates already-exists on CREATE DATABASE', async () => {
  const exec = recordingExec([new Error('ERROR:  database "idp" already exists')])
  const docker = createDocker({ execFileFn: exec })
  await docker.cloneDb('prod-db', 'qa-pg-base', 'idp')
  assert.equal(exec.calls.length, 2)
  assert.equal(exec.calls[1][0], 'sh')
})

test('cloneDb rethrows non-transient CREATE DATABASE failures immediately', async () => {
  const exec = recordingExec([new Error('ERROR:  permission denied to create database')])
  const docker = createDocker({ execFileFn: exec })
  await assert.rejects(docker.cloneDb('prod-db', 'qa-pg-base', 'idp'), /permission denied/)
  assert.equal(exec.calls.length, 1)
})

test('cloneDb retries CREATE DATABASE through the postgres restart window', async () => {
  const exec = recordingExec([
    new Error('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed'),
    '',   // CREATE DATABASE succeeds on retry
    '',   // pg_dump | psql pipeline
  ])
  const sleeps = []
  const docker = createDocker({ execFileFn: exec })
  await docker.cloneDb('prod-db', 'qa-pg-base', 'idp', { sleepFn: async (ms) => sleeps.push(ms) })
  assert.equal(exec.calls.length, 3)
  assert.equal(exec.calls[2][0], 'sh')
  assert.equal(sleeps.length, 1)
})

test('cloneDb gives up on transient errors after exhausting retries', async () => {
  const transient = () => new Error('connection to server at "localhost" failed')
  const exec = recordingExec([transient(), transient(), transient()])
  const docker = createDocker({ execFileFn: exec })
  await assert.rejects(
    docker.cloneDb('prod-db', 'qa-pg-base', 'idp', { retries: 3, sleepFn: async () => {} }),
    /connection to server/,
  )
  assert.equal(exec.calls.length, 3)
})

test('cloneDb rejects names that fail the safe-name pattern', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await assert.rejects(docker.cloneDb('bad;name', 'qa-pg-base', 'idp'), /unsafe/)
  await assert.rejects(docker.cloneDb('prod-db', 'a b', 'idp'), /unsafe/)
  await assert.rejects(docker.cloneDb('prod-db', 'qa-pg-base', 'idp; DROP'), /unsafe/)
  assert.equal(exec.calls.length, 0)
})

test('waitHealthyApp polls /api/health until 200', async () => {
  const statuses = [503, 503, 200]
  const urls = []
  const fetchFn = async (url) => {
    urls.push(url)
    return { status: statuses[urls.length - 1] }
  }
  const docker = createDocker({ execFileFn: recordingExec() })
  await docker.waitHealthyApp(3111, { retries: 5, sleepFn: async () => {}, fetchFn })
  assert.equal(urls.length, 3)
  assert.equal(urls[0], 'http://127.0.0.1:3111/api/health')
})

test('waitHealthyApp survives fetch rejections and throws after retries', async () => {
  const fetchFn = async () => {
    throw new Error('ECONNREFUSED')
  }
  const docker = createDocker({ execFileFn: recordingExec() })
  await assert.rejects(
    docker.waitHealthyApp(3111, { retries: 2, sleepFn: async () => {}, fetchFn }),
    /3111/,
  )
})

test('psql builds the exact docker exec argv and returns stdout', async () => {
  const exec = recordingExec(['42\n'])
  const docker = createDocker({ execFileFn: exec })
  const out = await docker.psql('qa-pg-base', 'idp', 'SELECT 42')
  assert.deepEqual(exec.calls, [[
    'docker', 'exec', 'qa-pg-base', 'psql', '-U', 'qa', '-d', 'idp', '-t', '-A', '-c', 'SELECT 42',
  ]])
  assert.equal(out, '42\n')
})

test('rmForce removes all names in one call and tolerates errors', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.rmForce(['qa-app-base', 'qa-pg-base'])
  assert.deepEqual(exec.calls, [['docker', 'rm', '-f', '-v', 'qa-app-base', 'qa-pg-base']])

  const failing = recordingExec([new Error('No such container')])
  const docker2 = createDocker({ execFileFn: failing })
  await docker2.rmForce(['gone'])
})

test('rmForce with no names makes no call', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.rmForce([])
  assert.equal(exec.calls.length, 0)
})

test('createNetwork and rmNetwork build exact argv; rmNetwork tolerates errors', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.createNetwork('qa-session')
  await docker.rmNetwork('qa-session')
  assert.deepEqual(exec.calls, [
    ['docker', 'network', 'create', '--label', 'qa-conductor-session', 'qa-session'],
    ['docker', 'network', 'rm', 'qa-session'],
  ])

  const failing = recordingExec([new Error('network not found')])
  const docker2 = createDocker({ execFileFn: failing })
  await docker2.rmNetwork('gone')
})

test('rmLabelledNetwork removes a network only when it carries the label', async () => {
  const exec = recordingExec(['qa-session-pr\nqa-session\n', ''])
  const docker = createDocker({ execFileFn: exec })
  assert.equal(await docker.rmLabelledNetwork('qa-session'), true)
  assert.deepEqual(exec.calls, [
    ['docker', 'network', 'ls', '--filter', 'label=qa-conductor-session', '--format', '{{.Name}}'],
    ['docker', 'network', 'rm', 'qa-session'],
  ])
  // A network of that name without the label, or only names that contain it: left alone.
  const other = recordingExec(['qa-session-pr\nmy-qa-session\n'])
  assert.equal(await createDocker({ execFileFn: other }).rmLabelledNetwork('qa-session'), false)
  assert.equal(other.calls.length, 1)
  // A daemon that can't list: nothing removed, nothing thrown.
  assert.equal(await createDocker({ execFileFn: recordingExec([new Error('daemon down')]) }).rmLabelledNetwork('qa-session'), false)
})

test('ensurePgImage makes the postgres image local, so runPg doesn\'t pull it inside docker run', async () => {
  const present = recordingExec([''])
  await createDocker({ execFileFn: present, postgres: { image: 'postgres:15' } }).ensurePgImage()
  assert.deepEqual(present.calls, [['docker', 'image', 'inspect', 'postgres:15']])
  const missing = recordingExec([new Error('No such image'), ''])
  await createDocker({ execFileFn: missing }).ensurePgImage({ sleepFn: async () => {} })
  assert.deepEqual(missing.calls, [['docker', 'image', 'inspect', 'postgres:16'], ['docker', 'pull', 'postgres:16']])
})

test('sweepQaContainers lists by label then force-removes', async () => {
  const exec = recordingExec(['abc123\ndef456\n', ''])
  const docker = createDocker({ execFileFn: exec })
  const ids = await docker.sweepQaContainers()
  assert.deepEqual(exec.calls, [
    ['docker', 'ps', '-aq', '--filter', 'label=qa-conductor-session'],
    ['docker', 'rm', '-f', '-v', 'abc123', 'def456'],
  ])
  assert.deepEqual(ids, ['abc123', 'def456'])
})

test('sweepQaContainers with nothing to sweep skips the rm', async () => {
  const exec = recordingExec(['\n'])
  const docker = createDocker({ execFileFn: exec })
  const ids = await docker.sweepQaContainers()
  assert.equal(exec.calls.length, 1)
  assert.deepEqual(ids, [])
})

test('inspectImageOf returns the trimmed image ref', async () => {
  const exec = recordingExec(['ghcr.io/x/app:1.2.3-rc.4\n'])
  const docker = createDocker({ execFileFn: exec })
  const image = await docker.inspectImageOf('prod-app')
  assert.deepEqual(exec.calls, [[
    'docker', 'inspect', '--format', '{{.Config.Image}}', 'prod-app',
  ]])
  assert.equal(image, 'ghcr.io/x/app:1.2.3-rc.4')
})

test('logsTail builds the exact docker logs argv and returns stdout', async () => {
  const exec = recordingExec(['line one\nline two\n'])
  const docker = createDocker({ execFileFn: exec })
  const out = await docker.logsTail('qa-app-pr')
  assert.deepEqual(exec.calls, [[
    'docker', 'logs', '--tail', '40', 'qa-app-pr',
  ]])
  assert.equal(out, 'line one\nline two\n')
})

test('logsTail honours a custom tail count and defaults missing stdout to empty', async () => {
  const calls = []
  const execFileFn = async (file, args) => {
    calls.push([file, ...args])
    return {} // no stdout key at all
  }
  const docker = createDocker({ execFileFn })
  const out = await docker.logsTail('qa-app-pr', 10)
  assert.deepEqual(calls, [[
    'docker', 'logs', '--tail', '10', 'qa-app-pr',
  ]])
  assert.equal(out, '')
})

test('logsTail rejects an unsafe container name without any exec call', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await assert.rejects(docker.logsTail('bad;name'), /unsafe/)
  assert.equal(exec.calls.length, 0)
})
