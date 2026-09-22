import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../lib/config.mjs'

function envFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-config-'))
  const path = join(dir, '.env.qa')
  writeFileSync(path, contents)
  return path
}

test('parses KEY=value lines, ignores blanks and comments, applies defaults', () => {
  const path = envFile(
    [
      '# this is a comment',
      '',
      'GITHUB_QA_TOKEN=ghp_abc123',
      '   ',
      'QA_OPERATOR_EMAIL=op@example.com',
      '# QA_REPO=commented/out',
    ].join('\n'),
  )
  const config = loadConfig(path)
  assert.deepEqual(config, {
    githubToken: 'ghp_abc123',
    operatorEmail: 'op@example.com',
    repo: '238855/homefree',
    idleMinutes: 30,
    ports: { harness: 3100, base: 3101, pr: 3102 },
    composeDir: '/compose-dir',
    blob: { bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: '' },
  })
})

test('explicit values override defaults, values may contain =', () => {
  const path = envFile(
    [
      'GITHUB_QA_TOKEN=tok',
      'QA_OPERATOR_EMAIL=op@example.com',
      'QA_REPO=someone/other',
      'QA_IDLE_MINUTES=45',
      'QA_COMPOSE_DIR=/opt/homefree/platforms/digital-ocean-inprocess-postgres',
      'QA_BLOB_S3_BUCKET=homefree-media-qa',
      'QA_BLOB_S3_ACCESS_KEY_ID=AKIAEXAMPLE',
      'QA_BLOB_S3_SECRET_ACCESS_KEY=s3cr3t==',
      'QA_BLOB_S3_ENDPOINT=https://ams3.digitaloceanspaces.com',
    ].join('\n'),
  )
  const config = loadConfig(path)
  assert.equal(config.repo, 'someone/other')
  assert.equal(config.idleMinutes, 45)
  assert.equal(config.composeDir, '/opt/homefree/platforms/digital-ocean-inprocess-postgres')
  assert.deepEqual(config.blob, {
    bucket: 'homefree-media-qa',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 's3cr3t==',
    endpoint: 'https://ams3.digitaloceanspaces.com',
  })
})

test('idleMinutes is a number, not a string', () => {
  const path = envFile(['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@example.com', 'QA_IDLE_MINUTES=15'].join('\n'))
  const config = loadConfig(path)
  assert.equal(typeof config.idleMinutes, 'number')
  assert.equal(config.idleMinutes, 15)
})

test('ports are fixed constants', () => {
  const path = envFile(['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@example.com'].join('\n'))
  assert.deepEqual(loadConfig(path).ports, { harness: 3100, base: 3101, pr: 3102 })
})

test('throws when GITHUB_QA_TOKEN is missing', () => {
  const path = envFile('QA_OPERATOR_EMAIL=op@example.com\n')
  assert.throws(() => loadConfig(path), /GITHUB_QA_TOKEN/)
})

test('throws when QA_OPERATOR_EMAIL is missing', () => {
  const path = envFile('GITHUB_QA_TOKEN=tok\n')
  assert.throws(() => loadConfig(path), /QA_OPERATOR_EMAIL/)
})
