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
  fsx,
  renderEnv,
  composeDir,
  network = 'qa-session',
  postgres = { user: 'homefree', password: 'qa', db: 'postgres' },
  // per-role loopback host ports the app container publishes on
  hostPorts = { base: 3111, pr: 3112 },
}) {
  const pgName = role => `qa-pg-${role}`
  const appName = role => `qa-app-${role}`

  return {
    async provisionDatabase({ paneRef, databases }) {
      await docker.createNetwork(network).catch(() => {}) // idempotent; shared across panes
      const pg = pgName(paneRef.role)
      await docker.runPg(pg, network)
      await docker.waitHealthyPg(pg, {})
      for (const d of databases) await docker.createDatabase(pg, d)
      const dsn = `postgresql://${postgres.user}:${postgres.password}@${pg}:5432`
      // query handle = docker-exec psql; the topology stays inside this adapter.
      const db = { dsn, query: sql => docker.psql(pg, postgres.db, sql) }
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

    async launchServices({ paneRef, services, env, reserved }) {
      for (const [name, image] of Object.entries(services)) {
        const path = `${composeDir}/.env.qa-${paneRef.role}`
        await fsx.writeFile(path, renderEnv(env[name]), { mode: 0o600 })
        await docker.runApp(appName(paneRef.role), image, network, path, reserved[name].port)
      }
    },

    async waitHealthy({ services }) {
      for (const svc of Object.values(services)) if (svc.port) await docker.waitHealthyApp(svc.port, {})
    },

    async teardown({ paneRef }) {
      await docker.rmForce([appName(paneRef.role), pgName(paneRef.role)])
    },
  }
}
