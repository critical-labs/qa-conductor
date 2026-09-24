// Conductor configuration: parse `.env.qa` (plain KEY=value lines) into a
// typed config object. Ports are fixed constants — tailscale serve mounts
// them, so they are not tunable per-env.
//
// Everything below the required-secrets block is a DEFAULT with an env
// override. The point of centralizing these — the postgres credential triple,
// the service-database list, the image repo/registry identity, the docker
// network + label — is that they were previously duplicated across
// docker.mjs, session.mjs, github.mjs and server.mjs (the pg triple alone
// lived in 6+ call sites). One source of truth here is the precondition for
// ever lifting this conductor out of homefree: a second consumer sets these
// via env instead of forking the code.

import { readFileSync } from 'node:fs'

// homefree's seven service databases. Also duplicated (as a shell string) in
// the platform's backup.sh / restore-rc.sh / restore-prod.sh — those are prod
// backup tooling that does not move into an extracted package; unifying the
// two lists is tracked separately. `idp` is load-bearing beyond seeding: the
// magic-link auto-login mints into it.
const DEFAULT_DATABASES = ['idp', 'userdb', 'homedb', 'socialdb', 'addressdb', 'emaildb', 'admindb']

function splitList(value, fallback) {
  if (!value) return fallback
  const items = value.split(',').map(s => s.trim()).filter(Boolean)
  return items.length ? items : fallback
}

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

  const imageRepo = env.QA_IMAGE_REPO || 'ghcr.io/238855/homefree-app'
  const repo = env.QA_REPO || '238855/homefree'

  return {
    githubToken: env.GITHUB_QA_TOKEN,
    operatorEmail: env.QA_OPERATOR_EMAIL,
    repo,
    idleMinutes: env.QA_IDLE_MINUTES ? Number(env.QA_IDLE_MINUTES) : 30,
    ports: { harness: 3100, base: 3101, pr: 3102 },
    composeDir: env.QA_COMPOSE_DIR || '/compose-dir',
    publicHost: env.QA_PUBLIC_HOST || 'qa-host.example.ts.net',
    // Registry/image identity. `imageRepo` is the full GHCR app-image ref;
    // packageName is its last path segment (the GHCR package to list versions
    // of), and ghcrUser is the namespace docker logs in as (GHCR namespace ==
    // GitHub repo owner today).
    imageRepo,
    packageName: env.QA_IMAGE_PACKAGE || imageRepo.slice(imageRepo.lastIndexOf('/') + 1),
    ghcrUser: env.QA_GHCR_USER || repo.split('/')[0],
    // Postgres identity for the throwaway pane databases. `image` is the
    // postgres server image; user/password/db are the superuser triple the
    // pane containers boot with AND the source prod container is cloned as.
    postgres: {
      image: env.QA_POSTGRES_IMAGE || 'postgres:16',
      user: env.QA_POSTGRES_USER || 'homefree',
      password: env.QA_POSTGRES_PASSWORD || 'qa',
      db: env.QA_POSTGRES_DB || 'postgres',
    },
    databases: splitList(env.QA_DATABASES, DEFAULT_DATABASES),
    // Docker network the pane containers share, and the label every
    // conductor-owned container/network carries (used by the teardown sweep).
    network: env.QA_NETWORK || 'qa-session',
    label: env.QA_LABEL || 'homefree-qa-session',
    blob: {
      bucket: env.QA_BLOB_S3_BUCKET || '',
      accessKeyId: env.QA_BLOB_S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.QA_BLOB_S3_SECRET_ACCESS_KEY || '',
      endpoint: env.QA_BLOB_S3_ENDPOINT || '',
    },
  }
}
