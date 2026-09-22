import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocker } from '../lib/docker.mjs'

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

test('runPg builds the exact docker run argv', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.runPg('qa-pg-base', 'qa-session')
  assert.deepEqual(exec.calls, [[
    'docker', 'run', '-d',
    '--name', 'qa-pg-base',
    '--network', 'qa-session',
    '--label', 'homefree-qa-session',
    '-e', 'POSTGRES_USER=homefree',
    '-e', 'POSTGRES_PASSWORD=qa',
    '-e', 'POSTGRES_DB=postgres',
    'postgres:16',
  ]])
})

test('runApp builds the exact docker run argv with loopback port mapping', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.runApp('qa-app-pr', 'ghcr.io/x/app:pr-7-abc', 'qa-session', '/compose/.env.qa-pr', 3112)
  assert.deepEqual(exec.calls, [[
    'docker', 'run', '-d',
    '--name', 'qa-app-pr',
    '--network', 'qa-session',
    '--label', 'homefree-qa-session',
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
    '--label', 'homefree-qa-session',
    '--env-file', '/compose/.env.qa-pr',
    'ghcr.io/x/app:migrate-pr-7-abc',
  ]])
})

test('waitHealthyPg polls pg_isready until it succeeds', async () => {
  const exec = recordingExec([
    new Error('not ready'),
    new Error('not ready'),
    'accepting connections\n',
  ])
  const sleeps = []
  const sleepFn = async (ms) => sleeps.push(ms)
  const docker = createDocker({ execFileFn: exec })
  await docker.waitHealthyPg('qa-pg-base', { retries: 5, sleepFn })
  assert.equal(exec.calls.length, 3)
  assert.deepEqual(exec.calls[0], ['docker', 'exec', 'qa-pg-base', 'pg_isready', '-U', 'homefree'])
  assert.equal(sleeps.length, 2)
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

test('cloneDb creates the target db then pipes pg_dump into psql via one sh -c', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await docker.cloneDb('homefree-db-1', 'qa-pg-base', 'idp')
  assert.deepEqual(exec.calls, [
    ['docker', 'exec', 'qa-pg-base', 'psql', '-U', 'homefree', '-d', 'postgres', '-c', 'CREATE DATABASE idp'],
    ['sh', '-c', 'docker exec homefree-db-1 pg_dump -U homefree --clean --if-exists idp | docker exec -i qa-pg-base psql -q -U homefree -d idp'],
  ])
})

test('cloneDb tolerates already-exists on CREATE DATABASE', async () => {
  const exec = recordingExec([new Error('ERROR:  database "idp" already exists')])
  const docker = createDocker({ execFileFn: exec })
  await docker.cloneDb('homefree-db-1', 'qa-pg-base', 'idp')
  assert.equal(exec.calls.length, 2)
  assert.equal(exec.calls[1][0], 'sh')
})

test('cloneDb rethrows other CREATE DATABASE failures', async () => {
  const exec = recordingExec([new Error('connection refused')])
  const docker = createDocker({ execFileFn: exec })
  await assert.rejects(docker.cloneDb('homefree-db-1', 'qa-pg-base', 'idp'), /connection refused/)
  assert.equal(exec.calls.length, 1)
})

test('cloneDb rejects names that fail the safe-name pattern', async () => {
  const exec = recordingExec()
  const docker = createDocker({ execFileFn: exec })
  await assert.rejects(docker.cloneDb('bad;name', 'qa-pg-base', 'idp'), /unsafe/)
  await assert.rejects(docker.cloneDb('homefree-db-1', 'a b', 'idp'), /unsafe/)
  await assert.rejects(docker.cloneDb('homefree-db-1', 'qa-pg-base', 'idp; DROP'), /unsafe/)
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
    'docker', 'exec', 'qa-pg-base', 'psql', '-U', 'homefree', '-d', 'idp', '-t', '-A', '-c', 'SELECT 42',
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
    ['docker', 'network', 'create', '--label', 'homefree-qa-session', 'qa-session'],
    ['docker', 'network', 'rm', 'qa-session'],
  ])

  const failing = recordingExec([new Error('network not found')])
  const docker2 = createDocker({ execFileFn: failing })
  await docker2.rmNetwork('gone')
})

test('sweepQaContainers lists by label then force-removes', async () => {
  const exec = recordingExec(['abc123\ndef456\n', ''])
  const docker = createDocker({ execFileFn: exec })
  const ids = await docker.sweepQaContainers()
  assert.deepEqual(exec.calls, [
    ['docker', 'ps', '-aq', '--filter', 'label=homefree-qa-session'],
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
  const image = await docker.inspectImageOf('homefree-app-1')
  assert.deepEqual(exec.calls, [[
    'docker', 'inspect', '--format', '{{.Config.Image}}', 'homefree-app-1',
  ]])
  assert.equal(image, 'ghcr.io/x/app:1.2.3-rc.4')
})
