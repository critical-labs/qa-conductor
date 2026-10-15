import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { createDocker, errorLine } from '../lib/docker.mjs'
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
    // ping-style raw sockets (crafted packets) are no pane's business
    '--cap-drop', 'NET_RAW',
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
    '--cap-drop', 'NET_RAW',
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
    '--cap-drop', 'NET_RAW',
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
    '--cap-drop', 'NET_RAW',
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
    '--cap-drop', 'NET_RAW',
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

// What makeExecFileFn rejects with: the CLI's stderr in `stderr`, and after
// a "Command failed" line in the message.
const dockerFailure = stderr => Object.assign(new Error(`docker rm: Command failed: docker …\n${stderr}`), { stderr })
// What Podman may write to stderr before its error, which says nothing of
// it: the podman-docker shim's banner on every call, and rootless Podman's
// logger warnings, in its pipe format and its TTY one.
const SHIM_BANNER = 'Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.'
const LOGRUS_PIPE = 'time="2026-10-15T10:00:00Z" level=warning msg="The cgroupv2 manager is set to systemd but there is no systemd user session available"'
const LOGRUS_TTY = 'WARN[0000] Using cgroups-v1 which is deprecated in favor of cgroups-v2 with Podman v5 and will be removed in a future version.'

test('rmForce removes all names in one call, and tolerates only names already gone', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.rmForce(['qa-app-base', 'qa-pg-base'])
  assert.deepEqual(exec.calls, [['docker', 'rm', '-f', '-v', 'qa-app-base', 'qa-pg-base']])

  // docker rm exits 1 when any name is missing, having removed the others
  for (const err of [
    new Error('No such container'),
    dockerFailure('Error response from daemon: No such container: qa-migrate-base\n'),
    dockerFailure('Error: No such container: a\nError: No such container: b\n'),
    // Podman's wording, after what it may write first: the podman-docker
    // shim's banner, and its logger's warnings (as a pipe, then a TTY, gets them)
    dockerFailure('Error: no container with name or ID "a" found: no such container\n'),
    dockerFailure(`${SHIM_BANNER}\nError: no container with name or ID "a" found: no such container\n`),
    dockerFailure(`${LOGRUS_PIPE}\nError: no container with name or ID "a" found: no such container\n`),
    dockerFailure(`${LOGRUS_TTY}\nError: no container with name or ID "a" found: no such container\n`),
  ]) {
    await createDocker({ execFileFn: recordingExec([err]) }).rmForce(['a', 'b'])
  }
  // anything else means a container may still be up: the conductor must know
  for (const err of [
    dockerFailure('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n'),
    dockerFailure('Error response from daemon: No such container: a\nError response from daemon: cannot remove container "/b": could not kill: permission denied\n'),
    new Error('spawn docker ENOENT'),
    // Podman's logger's errors are kept (its warnings aren't)
    dockerFailure('ERRO[0000] cannot kill container b: permission denied\nError: no container with name or ID "a" found: no such container\n'),
    dockerFailure('time="2026-10-15T10:00:00Z" level=error msg="cleaning up container b"\nError: no container with name or ID "a" found: no such container\n'),
  ]) {
    await assert.rejects(createDocker({ execFileFn: recordingExec([err]) }).rmForce(['a', 'b']), e => e === err, err.message)
  }
})

// The isolation probe's calls: what the runtime is, where things are on the
// panes' networks, and the probe container itself.
test('runtime, endpoint, networkGateways, containerAddresses and runProbe build exact argv', async () => {
  const exec = recordingExec([
    'Client: Docker Engine - Community\nServer: Docker Engine - Community\n', 'Ubuntu 24.04.1 LTS\n', 'unix:///var/run/docker.sock\n',
    '172.20.0.1 fd00:20::1 \n', '172.19.0.2 fd00:19::2 \n', 'listener 10.0.2.2\nprobe done\n',
  ])
  const docker = createDocker({ execFileFn: exec, postgres: { image: 'postgres:15' } })
  assert.deepEqual(await docker.runtime(), { version: 'Client: Docker Engine - Community\nServer: Docker Engine - Community\n', os: 'Ubuntu 24.04.1 LTS', osError: null })
  assert.equal(await docker.endpoint(), 'unix:///var/run/docker.sock')
  assert.deepEqual(await docker.networkGateways('qa-session-pr'), ['172.20.0.1', 'fd00:20::1'])
  // a dual-stack network gives each container an IPv6 address too
  assert.deepEqual(await docker.containerAddresses('qa-pg-base'), ['172.19.0.2', 'fd00:19::2'])
  assert.equal(await docker.runProbe('qa-probe-pr', 'qa-session-pr', 'echo hi', ['3100', '/x']), 'listener 10.0.2.2\nprobe done\n')
  assert.deepEqual(exec.calls, [
    ['docker', 'version'],
    ['docker', 'info', '--format', '{{.OperatingSystem}}'],
    ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    ['docker', 'network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}', 'qa-session-pr'],
    ['docker', 'inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}', 'qa-pg-base'],
    // gone when it ends, labelled for the sweep, no capabilities, no ports and
    // no mounts: it only connects out
    ['docker', 'run', '--rm', '--name', 'qa-probe-pr', '--network', 'qa-session-pr', '--label', 'qa-conductor-session', '--cap-drop', 'ALL', '--entrypoint', 'bash', 'postgres:15', '-c', 'echo hi', 'probe', '3100', '/x'],
  ])
  await assert.rejects(docker.runProbe('qa probe', 'qa-session-pr', 'x', []), /unsafe container name/)
})

// The podman-docker shim's `docker info` has no .OperatingSystem: the
// runtime is still known from `docker version`.
test('runtime keeps what docker version said when docker info fails, and fails only when version does', async () => {
  const infoFails = dockerFailure('Error: template: info:1:2: executing "info" at <.OperatingSystem>: can\'t evaluate field OperatingSystem in type *define.Info\n')
  const shim = createDocker({ execFileFn: recordingExec(['Client: Podman Engine\nVersion: 5.2.0\n', infoFails]) })
  const out = await shim.runtime()
  assert.deepEqual([out.version, out.os, out.osError], ['Client: Podman Engine\nVersion: 5.2.0\n', null, infoFails])
  const down = dockerFailure('Cannot connect to the Docker daemon\n')
  await assert.rejects(createDocker({ execFileFn: recordingExec([down]) }).runtime(), e => e === down)
})

// A wedged daemon must not hold the boot at the probe for ever. The docker
// CLI passes SIGTERM on to the container, whose bash, as PID 1, ignores it:
// so SIGKILL. And a teardown's abort stops it too.
test('runProbe gives docker run a timeout, 30 s unless told otherwise, then SIGKILL, and the boot\'s signal', async () => {
  const opts = []
  const exec = async (file, args, o) => { opts.push(o ?? null); return { stdout: 'probe done\n' } }
  const docker = createDocker({ execFileFn: exec })
  const { signal } = new AbortController()
  await docker.runProbe('qa-probe-pr', 'qa-session-pr', 'x', [])
  await docker.runProbe('qa-probe-pr', 'qa-session-pr', 'x', [], { timeoutMs: 50, signal })
  assert.deepEqual(opts, [{ timeout: 30_000, killSignal: 'SIGKILL' }, { timeout: 50, killSignal: 'SIGKILL', signal }])
})

// What docker said, for a reason a person reads: the first line that says
// something, past the shim's banner and the logger's warnings, else the
// first line there is.
test('errorLine reads past the lines that say nothing of the failure', () => {
  assert.equal(errorLine(dockerFailure(`${SHIM_BANNER}\n${LOGRUS_TTY}\nError: cannot connect to Podman\n`)), 'Error: cannot connect to Podman')
  assert.equal(errorLine(new Error('docker run: Command failed: docker run …\nno bash')), 'no bash')
  assert.equal(errorLine(new Error('docker run: Command failed: exec: "bash": not found')), 'docker run: Command failed: exec: "bash": not found')
  assert.equal(errorLine(new Error('plain')), 'plain')
  assert.equal(errorLine(dockerFailure(`${SHIM_BANNER}\n`)), SHIM_BANNER)
  assert.equal(errorLine('a string'), 'a string')
  assert.equal(errorLine(new Error('')), 'no detail')
})

test('rmForce with no names makes no call', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.rmForce([])
  assert.equal(exec.calls.length, 0)
})

test('createNetwork and rmNetwork build exact argv; rmNetwork tolerates only a network already gone', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.createNetwork('qa-session')
  await docker.rmNetwork('qa-session')
  assert.deepEqual(exec.calls, [
    ['docker', 'network', 'create', '--label', 'qa-conductor-session', 'qa-session'],
    ['docker', 'network', 'rm', 'qa-session'],
  ])

  for (const err of [
    new Error('network not found'),
    dockerFailure('Error response from daemon: network qa-session-base not found\n'),
    dockerFailure('Error: No such network: qa-session-base\n'),
    // Podman: its own CLI (or the podman-docker shim), then the docker CLI
    // against Podman's compat API, bare and wrapped
    dockerFailure('Error: unable to find network with name or ID qa-session-base: network not found\n'),
    dockerFailure('Error response from daemon: network not found\n'),
    dockerFailure('Error response from daemon: unable to find network with name or ID qa-session-base: network not found\n'),
    dockerFailure(`${SHIM_BANNER}\nError: unable to find network with name or ID qa-session-base: network not found\n`),
    dockerFailure(`${LOGRUS_PIPE}\n${LOGRUS_TTY}\nError: unable to find network with name or ID qa-session-base: network not found\n`),
  ]) {
    await createDocker({ execFileFn: recordingExec([err]) }).rmNetwork('gone')
  }
  // what Podman writes first is no failure, but no answer either: only the
  // lines after it say whether the network is gone
  for (const err of [
    dockerFailure(`${SHIM_BANNER}\n`),
    dockerFailure(`${LOGRUS_PIPE}\n`),
    dockerFailure(`${SHIM_BANNER}\n${LOGRUS_TTY}\nError: "qa-session-pr" has associated containers with it. Use -f to forcibly delete containers and pods: network is being used\n`),
    dockerFailure('time="2026-10-15T10:00:00Z" level=error msg="network not found"\nError: network qa-session-pr is in use\n'),
    // Podman's logger's errors are kept, so they say something went wrong,
    // however "already gone" the rest reads
    dockerFailure('time="2026-10-15T10:00:00Z" level=error msg="failed to tear down the network namespace"\nError: No such network: qa-session-pr\n'),
    dockerFailure('ERRO[0000] failed to tear down the network namespace\nError: unable to find network with name or ID qa-session-pr: network not found\n'),
  ]) {
    await assert.rejects(createDocker({ execFileFn: recordingExec([err]) }).rmNetwork('qa-session-pr'), e => e === err, err.stderr)
  }
  // still in use (a container that didn't come down), or no daemon, or
  // anything that merely mentions a missing network on the way
  for (const err of [
    dockerFailure('Error response from daemon: error while removing network: network qa-session-pr id 3f2 has active endpoints\n'),
    dockerFailure('Error: "qa-session-pr" has associated containers with it. Use -f to forcibly delete containers and pods: network is being used\n'),
    dockerFailure('Error: network not found in the cache: removing qa-session-pr: device or resource busy\n'),
    dockerFailure('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n'),
  ]) {
    await assert.rejects(createDocker({ execFileFn: recordingExec([err]) }).rmNetwork('qa-session-pr'), e => e === err, err.message)
  }
})

test('rmLabelledNetwork removes a network only when it carries the label', async () => {
  const exec = recordingExec(['qa-session-pr\nqa-session\n', ''])
  const docker = createDocker({ execFileFn: exec })
  assert.equal(await docker.rmLabelledNetwork('qa-session'), true)
  assert.deepEqual(exec.calls, [
    ['docker', 'network', 'ls', '--filter', 'label=qa-conductor-session', '--format', '{{.Name}}'],
    ['docker', 'network', 'rm', 'qa-session'],
  ])
  // A network of that name without the label, or only names that contain it,
  // are part of it, or differ only in case: left alone.
  for (const listed of ['qa-session-pr\nmy-qa-session\n', 'qa\nQA-SESSION\nsession\n']) {
    const other = recordingExec([listed])
    assert.equal(await createDocker({ execFileFn: other }).rmLabelledNetwork('qa-session'), false, JSON.stringify(listed))
    assert.equal(other.calls.length, 1)
  }
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

// --- #32: the PR pane on an internal network -------------------------------------

test('an internal network, an app with no host port, the forwarder and a network connect build exact argv', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.createNetwork('qa-session-pr', { internal: true })
  await docker.runApp('qa-app-pr', 'ghcr.io/x/app:pr-7-abc', 'qa-session-pr', '/compose/.env.qa-pr', null)
  const config = { host: '0.0.0.0', forward: { listen: 3000, to: 'qa-app-pr:3000' }, proxy: { listen: 3128, allow: ['api.example.com'] } }
  await docker.runForwarder('qa-fwd-pr', 'node:22-alpine', 'qa-session-pr-edge', { hostPort: 3112, config, source: 'console.log(1)' })
  await docker.connectNetwork('qa-session-pr', 'qa-fwd-pr', { alias: 'qa-egress' })
  assert.equal(await docker.networkInternal('qa-session-pr'), false, 'docker answered nothing')
  assert.deepEqual(exec.calls, [
    ['docker', 'network', 'create', '--label', 'qa-conductor-session', '--internal', 'qa-session-pr'],
    ['docker', 'run', '-d', '--name', 'qa-app-pr', '--network', 'qa-session-pr', '--label', 'qa-conductor-session', '--cap-drop', 'NET_RAW', '--env-file', '/compose/.env.qa-pr', 'ghcr.io/x/app:pr-7-abc'],
    [
      'docker', 'run', '-d', '--name', 'qa-fwd-pr', '--network', 'qa-session-pr-edge', '--label', 'qa-conductor-session',
      '--cap-drop', 'ALL', '--read-only', '--security-opt', 'no-new-privileges', '--user', 'node',
      '-p', '127.0.0.1:3112:3000', '-e', `PANE_FORWARDER=${JSON.stringify(config)}`,
      '--entrypoint', 'node', 'node:22-alpine', '--input-type=module', '-e', 'console.log(1)',
    ],
    ['docker', 'network', 'connect', '--alias', 'qa-egress', 'qa-session-pr', 'qa-fwd-pr'],
    ['docker', 'network', 'inspect', '--format', '{{.Internal}}', 'qa-session-pr'],
  ])
  assert.equal(await createDocker({ execFileFn: recordingExec(['true\n']) }).networkInternal('qa-session-pr'), true)
  await assert.rejects(docker.runForwarder('qa fwd', 'node:22-alpine', 'x', { hostPort: 1, config, source: '' }), /unsafe container name/)
  await assert.rejects(docker.connectNetwork('x', 'qa fwd', { alias: 'a' }), /unsafe container name/)
})
