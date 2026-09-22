// Conductor configuration: parse `.env.qa` (plain KEY=value lines) into a
// typed config object. Ports are fixed constants — tailscale serve mounts
// them, so they are not tunable per-env.

import { readFileSync } from 'node:fs'

export function loadConfig(envFilePath) {
  const env = {}
  for (const line of readFileSync(envFilePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }

  if (!env.GITHUB_QA_TOKEN) throw new Error(`GITHUB_QA_TOKEN missing in ${envFilePath}`)
  if (!env.QA_OPERATOR_EMAIL) throw new Error(`QA_OPERATOR_EMAIL missing in ${envFilePath}`)

  return {
    githubToken: env.GITHUB_QA_TOKEN,
    operatorEmail: env.QA_OPERATOR_EMAIL,
    repo: env.QA_REPO || '238855/homefree',
    idleMinutes: env.QA_IDLE_MINUTES ? Number(env.QA_IDLE_MINUTES) : 30,
    ports: { harness: 3100, base: 3101, pr: 3102 },
    composeDir: env.QA_COMPOSE_DIR || '/compose-dir',
    blob: {
      bucket: env.QA_BLOB_S3_BUCKET || '',
      accessKeyId: env.QA_BLOB_S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.QA_BLOB_S3_SECRET_ACCESS_KEY || '',
      endpoint: env.QA_BLOB_S3_ENDPOINT || '',
    },
  }
}
