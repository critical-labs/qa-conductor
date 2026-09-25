import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig, parseEnvFile } from '../lib/config.mjs'

function envFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-config-'))
  const path = join(dir, '.env.qa')
  writeFileSync(path, lines.join('\n'))
  return path
}

const REQUIRED = ['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@homefree.local', 'QA_REPO=acme/widget', 'QA_PUBLIC_HOST=w.ts.net']

test('parseEnvFile: KEY=value lines, comments/blanks ignored, values may contain =', () => {
  assert.deepEqual(parseEnvFile(envFile(['# c', '', '   ', 'A=1', 'B=x=y=='])), { A: '1', B: 'x=y==' })
})

test('generic defaults: ports, pane origins from public host, verdict labels', () => {
  const c = loadConfig(envFile(REQUIRED))
  assert.equal(c.githubToken, 'tok')
  assert.equal(c.operatorEmail, 'op@homefree.local')
  assert.equal(c.repo, 'acme/widget')
  assert.equal(c.publicHost, 'w.ts.net')
  assert.equal(c.idleMinutes, 30)
  assert.deepEqual(c.ports, { harness: 3100, base: 3101, pr: 3102 })
  assert.deepEqual(c.paneOrigins, { base: 'https://w.ts.net:8443', pr: 'https://w.ts.net:10000' })
  assert.deepEqual(c.verdictLabels, { accept: 'qa-approved', reject: 'qa-changes-requested' })
  // the raw map is exposed so a platform can read its own keys
  assert.equal(c.env.QA_REPO, 'acme/widget')
})

test('overrides: ports, origins, labels, idle minutes (a number)', () => {
  const c = loadConfig(envFile([...REQUIRED,
    'QA_HARNESS_PORT=4100', 'QA_BASE_PROXY_PORT=4101', 'QA_PR_PROXY_PORT=4102',
    'QA_BASE_ORIGIN=http://127.0.0.1:4101', 'QA_PR_ORIGIN=http://127.0.0.1:4102',
    'QA_LABEL_ACCEPT=ok', 'QA_LABEL_REJECT=nope', 'QA_IDLE_MINUTES=15']))
  assert.deepEqual(c.ports, { harness: 4100, base: 4101, pr: 4102 })
  assert.deepEqual(c.paneOrigins, { base: 'http://127.0.0.1:4101', pr: 'http://127.0.0.1:4102' })
  assert.deepEqual(c.verdictLabels, { accept: 'ok', reject: 'nope' })
  assert.equal(c.idleMinutes, 15)
})

test('platform defaults fill gaps; file values win', () => {
  const c = loadConfig(envFile(['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@homefree.local', 'QA_REPO=file/wins']),
    { defaults: { QA_REPO: 'default/repo', QA_PUBLIC_HOST: 'd.ts.net' } })
  assert.equal(c.repo, 'file/wins')
  assert.equal(c.publicHost, 'd.ts.net')
})

test('no app defaults: each required key is enforced', () => {
  for (const missing of ['GITHUB_QA_TOKEN', 'QA_OPERATOR_EMAIL', 'QA_REPO', 'QA_PUBLIC_HOST']) {
    const lines = REQUIRED.filter(l => !l.startsWith(`${missing}=`))
    assert.throws(() => loadConfig(envFile(lines)), new RegExp(missing))
  }
})
