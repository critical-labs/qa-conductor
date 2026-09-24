// Docker Provisioner adapter (extraction Stage 1a).
//
// Implements the frozen Provisioner seam (spike/adapters-v3.mjs) over the
// existing docker wrappers. This is where homefree's docker-sibling topology
// LIVES now: pane pg containers, the shared network, app containers, and the
// docker-exec query handle — so no other adapter touches docker. A managed-
// Postgres deployment would provide a peer provisioner returning a network DSN
// instead; the core and the other four seams are identical either way.
//
// Effects are injected (docker wrappers, fsx, renderEnv) so this is unit-tested
// against a recording docker mock with no real containers.

export function createDockerProvisioner({
  docker,
  network = 'qa-session',
  postgres = { user: 'homefree', password: 'qa', db: 'postgres' },
  // per-role loopback host ports the app container publishes on
  hostPorts = { base: 3111, pr: 3112 },
  // registry credentials for image pulls; enables relogin-on-retry
  registry = null,
}) {
  const ensureOpts = registry ? { relogin: () => docker.login(registry.user, registry.token) } : {}
  const pgName = role => `qa-pg-${role}`
  const appName = role => `qa-app-${role}`

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
      // Freeze amendment (implementation-discovered, backward compatible):
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

    // The core materializes env files before migration runs (migrate needs the
    // same env), so launchServices receives the file path as a docker-side hint
    // alongside the canonical env map. Pulls explicitly (retry + relogin) so a
    // transient registry hiccup can't half-fail a docker run.
    async launchServices({ paneRef, services, envFiles, reserved }) {
      for (const [name, image] of Object.entries(services)) {
        await docker.ensureImage(image, ensureOpts)
        await docker.runApp(appName(paneRef.role), image, network, envFiles[name], reserved[name].port)
      }
    },

    async waitHealthy({ services }) {
      for (const svc of Object.values(services)) if (svc.port) await docker.waitHealthyApp(svc.port, {})
    },

    async teardown({ paneRef }) {
      await docker.rmForce([appName(paneRef.role), pgName(paneRef.role)])
      // Shared across panes; removal succeeds once the last pane is gone and
      // is tolerated (rmNetwork swallows already-gone/in-use) otherwise.
      await docker.rmNetwork(network)
    },
  }
}
