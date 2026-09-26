// Docker Provisioner adapter: the built-in Provisioner for docker-sibling
// deployments.
//
// It owns everything docker: the pane pg containers, the shared network, the
// app containers, registry auth, the one-shot migrate run, the pane env files
// (mode 0600, under workDir), the startup orphan sweep and the failure log
// tails. The conductor core never touches docker. A managed-Postgres or
// process-based deployment provides a peer provisioner; the core and the other
// four seams are identical either way.
//
// Single-service per pane: each pane runs its services as `qa-app-<role>`
// with one env file; multi-service docker panes are a follow-up when a
// consumer needs them.
//
// Effects are injected (docker wrappers, fsx) so this is unit-tested against a
// recording docker mock with no real containers.

import { renderEnv } from '../session.mjs'

export function createDockerProvisioner({
  docker,
  fsx,
  // directory the pane env files are written to (must be readable by the
  // docker daemon's `--env-file` path resolution, i.e. the conductor's cwd view)
  workDir,
  network = 'qa-session',
  postgres = { user: 'qa', password: 'qa', db: 'postgres' },
  // per-role loopback host ports the app container publishes on
  hostPorts = { base: 3111, pr: 3112 },
  // registry credentials: log in before pulls, relogin on pull retry
  registry = null,
}) {
  const ensureOpts = registry ? { relogin: () => docker.login(registry.user, registry.token) } : {}
  const login = async () => {
    if (registry) await docker.login(registry.user, registry.token)
  }
  const pgName = role => `qa-pg-${role}`
  const appName = role => `qa-app-${role}`
  const envFile = role => `${workDir}/.env.qa-${role}`
  // The env carries prod-derived secrets: owner-only, and scrubbed on teardown.
  const writeEnv = async (role, env) => {
    const path = envFile(role)
    await fsx.writeFile(path, renderEnv(env ?? {}), { mode: 0o600 })
    return path
  }

  return {
    network,

    async provisionDatabase({ paneRef, databases }) {
      await docker.createNetwork(network).catch(() => {}) // idempotent; shared across panes
      const pg = pgName(paneRef.role)
      await docker.runPg(pg, network)
      await docker.waitHealthyPg(pg, {})
      for (const d of databases) await docker.createDatabase(pg, d)
      const dsn = `postgresql://${postgres.user}:${postgres.password}@${pg}:5432`
      // query handle = docker-exec psql; the topology stays inside this adapter.
      // query takes an optional {database} so adapters can target a specific
      // logical DB (homefree's magic_links lives in `idp`, not the admin DB).
      const db = { dsn, query: (sql, { database } = {}) => docker.psql(pg, database ?? postgres.db, sql) }
      return { dsn, db }
    },

    async reserveServices({ paneRef, services }) {
      // Docker host ports are deterministic per role, so reservation is pure:
      // assign the loopback url/port without starting anything.
      const port = hostPorts[paneRef.role]
      const out = {}
      for (const name of Object.keys(services)) out[name] = { url: `http://127.0.0.1:${port}`, port }
      return out
    },

    // One-shot migration: run the migrate image on the pane network with the
    // same env the app will get. Pulls explicitly (retry + relogin) so a
    // transient registry hiccup can't half-fail a docker run.
    async runMigrate({ paneRef, migrate, env }) {
      await login()
      await docker.ensureImage(migrate.image, ensureOpts)
      const file = await writeEnv(paneRef.role, env.app ?? Object.values(env)[0])
      await docker.runMigrate(migrate.image, network, file)
    },

    async launchServices({ paneRef, services, env, reserved }) {
      await login()
      for (const [name, image] of Object.entries(services)) {
        await docker.ensureImage(image, ensureOpts)
        const file = await writeEnv(paneRef.role, env[name])
        await docker.runApp(appName(paneRef.role), image, network, file, reserved[name].port)
      }
    },

    async waitHealthy({ services }) {
      for (const svc of Object.values(services)) if (svc.port) await docker.waitHealthyApp(svc.port, {})
    },

    // Failure triage: the app container once it exists, the pg container before.
    async logs({ paneRef, stage, lines = 40 }) {
      const container = stage === 'starting' ? appName(paneRef.role) : pgName(paneRef.role)
      return docker.logsTail(container, lines)
    },

    // Startup: remove labelled orphans (and the network) from a previous run.
    async sweep() {
      await docker.sweepQaContainers()
      await docker.rmNetwork(network)
    },

    async teardown({ paneRef }) {
      await docker.rmForce([appName(paneRef.role), pgName(paneRef.role)])
      // Shared across panes; removal succeeds once the last pane is gone and
      // is tolerated (rmNetwork swallows already-gone/in-use) otherwise.
      await docker.rmNetwork(network)
      await fsx.unlink(envFile(paneRef.role)).catch(() => {})
    },
  }
}
