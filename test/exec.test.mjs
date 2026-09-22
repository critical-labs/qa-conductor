import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeExecFileFn } from '../lib/exec.mjs'

test('resolves the { stdout } shape createDocker destructures', async () => {
  const execFileFn = makeExecFileFn()
  const out = await execFileFn('node', ['-e', "process.stdout.write('hello')"])
  assert.deepEqual(out, { stdout: 'hello' })
  // the exact consumption pattern used by docker.mjs run()
  const { stdout } = out
  assert.equal(stdout.split('\n')[0], 'hello')
})

test('rejects with command, message and stderr on failure', async () => {
  const execFileFn = makeExecFileFn()
  await assert.rejects(
    () => execFileFn('node', ['-e', "process.stderr.write('boom'); process.exit(3)"]),
    err => err.message.includes('node') && err.message.includes('boom'),
  )
})
