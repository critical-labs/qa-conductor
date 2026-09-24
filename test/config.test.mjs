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
      'QA_OPERATOR_EMAIL=op@homefree.local',
      '# QA_REPO=commented/out',
    ].join('\n'),
  )
  const config = loadConfig(path)
  assert.deepEqual(config, {
    githubToken: 'ghp_abc123',
    operatorEmail: 'op@homefree.local',
    repo: '238855/homefree',
    idleMinutes: 30,
    ports: { harness: 3100, base: 3101, pr: 3102 },
    composeDir: '/compose-dir',
    publicHost: 'qa-host.example.ts.net',
    imageRepo: 'ghcr.io/238855/homefree-app',
    packageName: 'homefree-app',
    ghcrUser: '238855',
    postgres: { image: 'postgres:16', user: 'homefree', password: 'qa', db: 'postgres' },
    databases: ['idp', 'userdb', 'homedb', 'socialdb', 'addressdb', 'emaildb', 'admindb'],
    network: 'qa-session',
    label: 'homefree-qa-session',
    blob: { bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: '' },
  })
})

test('centralized identity fields derive from imageRepo/repo and are env-overridable', () => {
  // defaults: packageName is the last segment of imageRepo, ghcrUser is repo owner
  const defaults = loadConfig(envFile(['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@homefree.local'].join('\n')))
  assert.equal(defaults.packageName, 'homefree-app')
  assert.equal(defaults.ghcrUser, '238855')

  // overrides: a second consumer sets everything via env, no code fork
  const overridden = loadConfig(envFile([
    'GITHUB_QA_TOKEN=tok',
    'QA_OPERATOR_EMAIL=op@homefree.local',
    'QA_REPO=acme/widget',
    'QA_IMAGE_REPO=ghcr.io/acme/widget-app',
    'QA_POSTGRES_IMAGE=postgres:15',
    'QA_POSTGRES_USER=widget',
    'QA_POSTGRES_PASSWORD=hunter2',
    'QA_POSTGRES_DB=maindb',
    'QA_DATABASES=core, billing ,audit',
    'QA_NETWORK=widget-qa',
    'QA_LABEL=widget-qa-session',
    'QA_PUBLIC_HOST=widget.example.ts.net',
  ].join('\n')))
  assert.equal(overridden.imageRepo, 'ghcr.io/acme/widget-app')
  assert.equal(overridden.packageName, 'widget-app')
  assert.equal(overridden.ghcrUser, 'acme')
  assert.deepEqual(overridden.postgres, { image: 'postgres:15', user: 'widget', password: 'hunter2', db: 'maindb' })
  // comma list is trimmed and split
  assert.deepEqual(overridden.databases, ['core', 'billing', 'audit'])
  assert.equal(overridden.network, 'widget-qa')
  assert.equal(overridden.label, 'widget-qa-session')
  assert.equal(overridden.publicHost, 'widget.example.ts.net')
})

test('QA_IMAGE_PACKAGE and QA_GHCR_USER override the derived identity fields', () => {
  const config = loadConfig(envFile([
    'GITHUB_QA_TOKEN=tok',
    'QA_OPERATOR_EMAIL=op@homefree.local',
    'QA_IMAGE_REPO=registry.example.com/team/app',
    'QA_IMAGE_PACKAGE=custom-package',
    'QA_GHCR_USER=custom-user',
  ].join('\n')))
  assert.equal(config.packageName, 'custom-package')
  assert.equal(config.ghcrUser, 'custom-user')
})

test('QA_DATABASES falls back to the default list when blank', () => {
  const config = loadConfig(envFile(['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@homefree.local', 'QA_DATABASES=   '].join('\n')))
  assert.deepEqual(config.databases, ['idp', 'userdb', 'homedb', 'socialdb', 'addressdb', 'emaildb', 'admindb'])
})

test('explicit values override defaults, values may contain =', () => {
  const path = envFile(
    [
      'GITHUB_QA_TOKEN=tok',
      'QA_OPERATOR_EMAIL=op@homefree.local',
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
  const path = envFile(['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@homefree.local', 'QA_IDLE_MINUTES=15'].join('\n'))
  const config = loadConfig(path)
  assert.equal(typeof config.idleMinutes, 'number')
  assert.equal(config.idleMinutes, 15)
})

test('ports are fixed constants', () => {
  const path = envFile(['GITHUB_QA_TOKEN=tok', 'QA_OPERATOR_EMAIL=op@homefree.local'].join('\n'))
  assert.deepEqual(loadConfig(path).ports, { harness: 3100, base: 3101, pr: 3102 })
})

test('throws when GITHUB_QA_TOKEN is missing', () => {
  const path = envFile('QA_OPERATOR_EMAIL=op@homefree.local\n')
  assert.throws(() => loadConfig(path), /GITHUB_QA_TOKEN/)
})

test('throws when QA_OPERATOR_EMAIL is missing', () => {
  const path = envFile('GITHUB_QA_TOKEN=tok\n')
  assert.throws(() => loadConfig(path), /QA_OPERATOR_EMAIL/)
})
