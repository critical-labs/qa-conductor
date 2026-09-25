// Generic conductor configuration: parse `.env.qa` (plain KEY=value lines)
// into the settings the CORE needs. There are no app defaults here: a
// consuming platform passes its own `defaults` and reads its app-specific
// keys (image repo, database identity, ...) from the returned raw `env` map.
// See the homefree platform's config-homefree.mjs for the reference reader.

import { readFileSync } from 'node:fs'

export function parseEnvFile(envFilePath) {
  const env = {}
  for (const line of readFileSync(envFilePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

const num = (value, fallback) => (value ? Number(value) : fallback)

export function loadConfig(envFilePath, { defaults = {} } = {}) {
  const env = { ...defaults, ...parseEnvFile(envFilePath) }
  for (const key of ['GITHUB_QA_TOKEN', 'QA_OPERATOR_EMAIL', 'QA_REPO', 'QA_PUBLIC_HOST']) {
    if (!env[key]) throw new Error(`${key} missing in ${envFilePath}`)
  }
  const publicHost = env.QA_PUBLIC_HOST

  return {
    env,
    githubToken: env.GITHUB_QA_TOKEN,
    operatorEmail: env.QA_OPERATOR_EMAIL,
    repo: env.QA_REPO,
    publicHost,
    idleMinutes: num(env.QA_IDLE_MINUTES, 30),
    // Listen ports: the harness UI/API and the two pane proxies.
    ports: {
      harness: num(env.QA_HARNESS_PORT, 3100),
      base: num(env.QA_BASE_PROXY_PORT, 3101),
      pr: num(env.QA_PR_PROXY_PORT, 3102),
    },
    // The external origin a viewer reaches each pane at: the TLS terminator in
    // front of the pane proxies. Defaults match a tailscale-serve layout.
    paneOrigins: {
      base: env.QA_BASE_ORIGIN || `https://${publicHost}:8443`,
      pr: env.QA_PR_ORIGIN || `https://${publicHost}:10000`,
    },
    verdictLabels: {
      accept: env.QA_LABEL_ACCEPT || 'qa-approved',
      reject: env.QA_LABEL_REJECT || 'qa-changes-requested',
    },
  }
}
