// Docker Provisioner adapter: the built-in Provisioner that runs each pane as
// containers (a postgres one and an app one) on the host's Docker daemon.
//
// It owns everything docker: the pane pg containers, each pane's network, the
// app containers, registry auth, the one-shot migrate run, the pane env files
// (mode 0600, under workDir), the startup orphan sweep and the failure log
// tails. The conductor core never touches docker. A managed-Postgres or
// process-based deployment provides a peer provisioner; the core and the other
// four seams are identical either way.
//
// The panes are kept apart: each pane's containers join a network of their
// own, so the PR pane's app can neither resolve nor reach the base pane's
// containers, and each pane's database gets a password of its own, drawn per
// boot, which only that pane's DSN carries. The core needs no shared network:
// it reaches the apps through their host ports and the databases through
// `docker exec`.
//
// Single-service per pane: each pane runs its services as `qa-app-<role>`
// with one env file; multi-service docker panes are a follow-up when a
// consumer needs them.
//
// Effects are injected (docker wrappers, fsx) so this is unit-tested against a
// recording docker mock with no real containers.

import { randomBytes } from 'node:crypto'
import { renderEnv } from '../session.mjs'

// A string names both networks by prefix (`<prefix>-base`, `<prefix>-pr`);
// `{ base, pr }` names them outright. Refused, since each would undo the
// isolation:
// - two panes on one network;
// - Docker's or Podman's own networks and network modes, which put a pane on
//   the host or beside other containers, and another container's
//   (`container:<name>`);
// - a name of lowercase hex digits, which Docker also reads as the start of a
//   network id (ids are lowercase), so `network rm` or `run --network` could
//   find some other network.
const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const OWN_NETWORKS = new Set([
  'host', 'bridge', 'none', 'default', 'ingress', 'docker_gwbridge',
  'podman', 'private', 'pasta', 'slirp4netns', 'podman-default-kube-network',
])
const idLike = name => /^[0-9a-f]+$/.test(name)
const networkName = name => typeof name === 'string' && NETWORK_NAME.test(name) && !OWN_NETWORKS.has(name) && !idLike(name)

function paneNetworks(network) {
  const networks = typeof network === 'string' && network
    ? { base: `${network}-base`, pr: `${network}-pr` }
    : { base: network?.base, pr: network?.pr }
  if (!networkName(networks.base) || !networkName(networks.pr) || networks.base === networks.pr) {
    throw new Error('network must be a prefix or { base, pr }: two different network names of letters, digits, _, . and -, not lowercase hex digits alone, and none of Docker\'s or Podman\'s own')
  }
  return Object.freeze(networks)
}

const aborted = () => Object.assign(new Error('boot aborted'), { name: 'AbortError' })

// An explicit password is shared by both panes; anything but a non-empty
// string without control characters (a line break would reach the env file)
// is a mistake. undefined means none.
function explicitPassword(password) {
  if (password !== undefined && (typeof password !== 'string' || password === '' || /[\0-\x1f\x7f]/.test(password))) {
    throw new Error('postgres.password must be a non-empty string without control characters; leave it out for a password per pane')
  }
  return password
}

export function createDockerProvisioner({
  docker,
  fsx,
  // directory the pane env files are written to (must be readable by the
  // docker daemon's `--env-file` path resolution, i.e. the conductor's cwd view)
  workDir,
  // the prefix of each pane's network, or { base, pr }
  network = 'qa-session',
  // The superuser in each pane's DSN; match createDocker's user and db. Leave
  // password out: each pane's database then gets its own, drawn per boot. An
  // explicit password is used for both panes. (createDocker's password never
  // reaches a pane: this provisioner always passes runPg one.)
  postgres = {},
  // per-role loopback host ports the app container publishes on
  hostPorts = { base: 3111, pr: 3112 },
  // registry credentials: log in before pulls, relogin on pull retry
  registry = null,
}) {
  const networks = paneNetworks(network)
  // Keys set to undefined (an unset env var, say) keep their defaults.
  const given = Object.fromEntries(Object.entries(postgres ?? {}).filter(([, value]) => value !== undefined))
  const pgUser = { user: 'qa', db: 'postgres', ...given }
  const sharedPassword = explicitPassword(pgUser.password)
  const ensureOpts = registry ? { relogin: () => docker.login(registry.user, registry.token) } : {}
  const login = async () => {
    if (registry) await docker.login(registry.user, registry.token)
  }
  const pgName = role => `qa-pg-${role}`
  const appName = role => `qa-app-${role}`
  const migrateName = role => `qa-migrate-${role}`
  const networkOf = role => {
    if (!Object.hasOwn(networks, role)) throw new Error(`no network for role ${JSON.stringify(role)}: base or pr`)
    return networks[role]
  }
  // `network create` failed: carry on only if a network of that very name
  // exists (one teardown failed to remove). Other "already exists" errors, and
  // a name that only prefixes another network's id, don't count.
  const reuseNetwork = async (net, err) => {
    if (!/already exists|already used/.test(`${err.message ?? ''}\n${err.stderr ?? ''}`)) throw err
    const found = await docker.run(['network', 'inspect', '--format', '{{.Name}}', net]).catch(() => null)
    if (found?.trim() !== net) throw err
  }
  const envFile = role => `${workDir}/.env.qa-${role}`
  // The env carries prod-derived secrets: owner-only, and scrubbed on teardown
  // and at startup.
  const writeEnv = async (role, env) => {
    const path = envFile(role)
    await fsx.writeFile(path, renderEnv(env ?? {}), { mode: 0o600 })
    return path
  }
  // A teardown or takeover aborts the boot but can't stop a docker call in
  // flight, such as a pull. So before each step that creates or changes
  // something (a network, a container, an env file), stop if the boot was
  // aborted meanwhile: the next session may own this role's pane by now.
  const live = signal => {
    if (signal?.aborted) throw aborted()
  }

  return {
    networks,

    async provisionDatabase({ paneRef, databases, signal }) {
      const net = networkOf(paneRef.role)
      live(signal)
      // One left over is reused; any other failure, such as no address pool
      // left, stops the boot here.
      await docker.createNetwork(net).catch(err => reuseNetwork(net, err))
      const pg = pgName(paneRef.role)
      const password = sharedPassword ?? randomBytes(24).toString('hex')
      // Pulled first, so the container isn't created minutes later, after an
      // abort, by a `docker run` that had to pull.
      live(signal)
      await docker.ensurePgImage(ensureOpts)
      live(signal)
      await docker.runPg(pg, net, { password })
      await docker.waitHealthyPg(pg, {})
      for (const d of databases) {
        live(signal)
        await docker.createDatabase(pg, d)
      }
      // The core seeds this database next: not if the boot was aborted.
      live(signal)
      const dsn = `postgresql://${encodeURIComponent(pgUser.user)}:${encodeURIComponent(password)}@${pg}:5432`
      // query handle = docker-exec psql; the topology stays inside this adapter.
      // query takes an optional {database} so adapters can target a specific
      // logical DB (an app's sign-in tables may live in a database of their own).
      const db = { dsn, query: (sql, { database } = {}) => docker.psql(pg, database ?? pgUser.db, sql) }
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

    // One-shot migration: run the migrate image on the pane's network with
    // the same env the app will get. Pulls explicitly (retry + relogin) so a
    // transient registry hiccup can't half-fail a docker run.
    async runMigrate({ paneRef, migrate, env, signal }) {
      const net = networkOf(paneRef.role)
      live(signal)
      await login()
      live(signal)
      await docker.ensureImage(migrate.image, ensureOpts)
      live(signal)
      const file = await writeEnv(paneRef.role, env.app ?? Object.values(env)[0])
      live(signal)
      await docker.runMigrate(migrate.image, net, file, { name: migrateName(paneRef.role) })
    },

    async launchServices({ paneRef, services, env, reserved, signal }) {
      const net = networkOf(paneRef.role)
      live(signal)
      await login()
      for (const [name, image] of Object.entries(services)) {
        live(signal)
        await docker.ensureImage(image, ensureOpts)
        live(signal)
        const file = await writeEnv(paneRef.role, env[name])
        live(signal)
        await docker.runApp(appName(paneRef.role), image, net, file, reserved[name].port)
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

    // Startup: remove both panes' env files (which hold an earlier run's env
    // and passwords; first, so a daemon that isn't up yet doesn't keep them),
    // labelled orphans, both panes' networks, and the one shared network
    // earlier versions made under the prefix's name. That one goes only if
    // it carries the conductor's label, as theirs did, and Docker can't take
    // the name for one of its own or for an id's start.
    async sweep() {
      for (const role of ['base', 'pr']) await fsx.unlink(envFile(role)).catch(() => {})
      await docker.sweepQaContainers()
      await docker.rmNetwork(networks.base)
      await docker.rmNetwork(networks.pr)
      if (typeof network === 'string' && networkName(network)) await docker.rmLabelledNetwork(network)
    },

    async teardown({ paneRef }) {
      // The migrate run too, which a teardown during migrating finds still
      // running: it would keep the network alive.
      await docker.rmForce([appName(paneRef.role), migrateName(paneRef.role), pgName(paneRef.role)])
      // This pane's own network; rmNetwork tolerates one already gone.
      await docker.rmNetwork(networkOf(paneRef.role))
      await fsx.unlink(envFile(paneRef.role)).catch(() => {})
    },
  }
}
