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
// With `internal` (#32), the PR pane's network is internal: no route off
// itself, to the host or to the base pane. A forwarder (lib/forwarder.mjs)
// on an ordinary network, joined to the internal one as `qa-egress`,
// publishes the PR app on the host's loopback and is its only way out: an
// HTTP proxy that lets it out only to the hosts on the allowlist. If any of
// that can't be set up, the PR pane runs as it would without `internal`.
//
// Effects are injected (docker wrappers, fsx) so this is unit-tested against a
// recording docker mock with no real containers.

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { errorLine } from '../docker.mjs'
import { parseAllowlist } from '../forwarder.mjs'
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

// --- #32: the PR pane on an internal network -------------------------------------

const FORWARDER_IMAGE = 'node:22-alpine'
// The forwarder's name on the internal network, and its proxy's port.
const EGRESS = { alias: 'qa-egress', port: 3128 }
const FORWARDER = 'qa-fwd-pr'

// `internal`: off (undefined, null, false), true (no egress at all), or
// { egress: the allowlist, image: the forwarder's }. The allowlist is
// checked now, so a typo never opens more than meant.
function internalOption(internal) {
  if (internal === undefined || internal === null || internal === false) return null
  const given = internal === true ? {} : internal
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('internal must be true, or { egress, image }')
  for (const key of Object.keys(given)) {
    if (key !== 'egress' && key !== 'image') throw new Error(`internal has no option ${JSON.stringify(key)}: egress or image`)
  }
  try {
    parseAllowlist(given.egress)
  } catch (err) {
    throw new Error(`internal: ${err.message}`)
  }
  const image = given.image ?? FORWARDER_IMAGE
  if (typeof image !== 'string' || image === '' || /\s/.test(image)) throw new Error(`internal.image must be an image name: ${JSON.stringify(image)}`)
  return Object.freeze({ egress: Object.freeze([...(given.egress ?? [])]), image })
}

// `promise`, or UNSETTLED once `ms` have passed, whichever comes first. A
// late rejection is nobody's to handle. The timer is cleared as soon as
// either comes, and a boot's abort settles the run (runProbe's signal).
const UNSETTLED = Symbol('unsettled')
function settledWithin(promise, ms) {
  let timer
  const late = new Promise(resolve => { timer = setTimeout(resolve, ms, UNSETTLED) })
  promise.catch(() => {})
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// Where a runtime gives a container the host, and so maybe the host's
// loopback: Docker Desktop's names and addresses, Podman's name, Lima's
// (colima, Rancher Desktop on Linux) name and fixed address, Rancher
// Desktop's name, gvproxy's (Podman machine), slirp4netns's, pasta's mapped
// gateway, and the default bridge's gateway. The PR network's own gateways
// join them.
const HOST_ADDRESSES = [
  'host.docker.internal', 'gateway.docker.internal', 'host.containers.internal', 'host.lima.internal', 'host.rancher-desktop.internal',
  '192.168.65.254', '192.168.65.2', '192.168.127.254', '192.168.5.2', '10.0.2.2', '169.254.1.2', '172.17.0.1',
]

// What the probe says on stderr, exiting 3, when its image lacks a tool it
// needs or has one that works otherwise.
const PROBE_NEEDS = 'the probe needs timeout, grep and cat, and a timeout that takes its seconds first'

// The isolation probe, run with bash in the postgres image on the PR pane's
// network: `probe <port> <path> <expect> <host>… -- <address:port>… --
// <own address:port>… [-- <proxy host:port> <target>…]`.
// - It checks its tools first, and stops (exit 3) when one is missing or
//   works otherwise: a failure inside the probing would go unseen, every
//   connect "failing".
// - For each host, an HTTP GET of <path> on <port>, which this conductor's
//   harness answers with <expect> (so another server there doesn't count):
//   `listener <host>`.
// - For each address, a TCP connect: `open <address:port>`.
// - For each own address (the PR pane's database), the same: `self
//   <address:port>`, its positive control. A probe that reaches nothing,
//   not even that, has shown nothing.
// - With a proxy (the forwarder's, on an internal network), a CONNECT
//   through it to each target: `proxied <target>` when it answers 200,
//   `refused <target>` when it answers otherwise, and nothing when it doesn't
//   answer at all.
// All at once, each in at most 3 seconds, then `probe done`.
const PROBE_SCRIPT = [
  'port=$1 path=$2 expect=$3',
  'shift 3',
  `need() { echo '${PROBE_NEEDS}' >&2; exit 3; }`,
  'command -v timeout >/dev/null && command -v grep >/dev/null && command -v cat >/dev/null || need',
  'timeout 3 true 2>/dev/null || need',
  'printf \'%s\\n\' "$expect" | cat | grep -qF -- "$expect" 2>/dev/null || need',
  'hosts=() targets=() selves=() vias=() part=0',
  'for a in "$@"; do',
  '  if [ "$a" = -- ]; then part=$((part + 1))',
  '  elif [ "$part" = 0 ]; then hosts+=("$a")',
  '  elif [ "$part" = 1 ]; then targets+=("$a")',
  '  elif [ "$part" = 2 ]; then selves+=("$a")',
  '  else vias+=("$a")',
  '  fi',
  'done',
  'listener() {',
  '  if timeout 3 bash -c \'exec 3<>"/dev/tcp/$1/$2" || exit 1; printf "GET %s HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n" "$3" >&3; cat <&3\' _ "$1" "$port" "$path" 2>/dev/null | grep -qF -- "$expect"; then',
  '    echo "listener $1"',
  '  fi',
  '}',
  'connects() {',
  '  if timeout 3 bash -c \'exec 3<>"/dev/tcp/$1/$2"\' _ "${1%:*}" "${1##*:}" 2>/dev/null; then',
  '    echo "$2 $1"',
  '  fi',
  '}',
  'proxy=${vias[0]:-}',
  'via() {',
  '  local line',
  '  line=$(timeout 3 bash -c \'exec 3<>"/dev/tcp/$1/$2" || exit 1; printf "CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n" "$3" "$3" >&3; IFS= read -r line <&3; printf "%s\\n" "$line"\' _ "${proxy%:*}" "${proxy##*:}" "$1" 2>/dev/null)',
  '  case "$line" in',
  '    "HTTP/1."?" 200"*) echo "proxied $1" ;;',
  '    HTTP/*) echo "refused $1" ;;',
  '  esac',
  '}',
  'for h in "${hosts[@]}"; do listener "$h" & done',
  'for t in "${targets[@]}"; do connects "$t" open & done',
  'for t in "${selves[@]}"; do connects "$t" self & done',
  'for t in "${vias[@]:1}"; do via "$t" & done',
  'wait',
  'echo "probe done"',
].join('\n')

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
  // how long the isolation probe's docker run may take, in all
  probeTimeoutMs = 30_000,
  // the PR pane on an internal network (#32): true, or { egress, image }
  internal = null,
}) {
  const networks = paneNetworks(network)
  const inside = internalOption(internal)
  // the forwarder's ordinary network, beside the PR pane's internal one
  const edge = `${networks.pr}-edge`
  if (inside && edge === networks.base) throw new Error(`the PR pane's edge network, ${edge}, is the base pane's`)
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
  // the isolation probe, on the PR pane's network
  const probeName = 'qa-probe-pr'
  // This boot's internal topology, once provisionDatabase set it up or fell
  // back: { up: true } or { up: false, failure }.
  let topology = null
  const internalUp = () => inside !== null && topology?.up === true
  let forwarderSource = null
  // The PR pane's proxy settings, which win over the EnvTransform's there.
  const proxyEnv = () => {
    const url = `http://${EGRESS.alias}:${EGRESS.port}`
    const none = ['localhost', '127.0.0.1', '::1', pgName('pr'), appName('pr')].join(',')
    return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: none, no_proxy: none, NODE_USE_ENV_PROXY: '1' }
  }
  const paneEnv = (role, env) => (role === 'pr' && internalUp() ? { ...(env ?? {}), ...proxyEnv() } : env)
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

  // The PR pane's internal network, the forwarder's ordinary one, and the
  // forwarder on it, then joined to the internal one as qa-egress. Any step
  // that fails undoes them all, and the pane gets an ordinary network, as
  // without `internal`. An internal network left over is reused only when it
  // is internal.
  const internalNetwork = async signal => {
    const net = networks.pr
    try {
      live(signal)
      await docker.createNetwork(edge).catch(err => reuseNetwork(edge, err))
      live(signal)
      await docker.createNetwork(net, { internal: true }).catch(async err => {
        await reuseNetwork(net, err)
        if (!(await docker.networkInternal(net))) throw new Error(`a network ${net} exists that isn't internal`)
      })
      live(signal)
      await docker.ensureImage(inside.image, ensureOpts)
      forwarderSource ??= await readFile(new URL('../forwarder.mjs', import.meta.url), 'utf8')
      const config = {
        host: '0.0.0.0',
        forward: { listen: 3000, to: `${appName('pr')}:3000` },
        proxy: { listen: EGRESS.port, allow: inside.egress },
      }
      live(signal)
      await docker.runForwarder(FORWARDER, inside.image, edge, { hostPort: hostPorts.pr, config, source: forwarderSource })
      live(signal)
      await docker.connectNetwork(net, FORWARDER, { alias: EGRESS.alias })
      return { up: true }
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      await docker.rmForce([FORWARDER]).catch(() => {})
      await docker.rmNetwork(net).catch(() => {})
      await docker.rmNetwork(edge).catch(() => {})
      live(signal)
      await docker.createNetwork(net).catch(e => reuseNetwork(net, e))
      return { up: false, failure: errorLine(err) }
    }
  }

  // Whether the PR pane can reach the base pane (README, Security), checked
  // once both panes' databases exist, before either is seeded and before
  // the PR's migrate or app runs. The runtime first: Podman doesn't keep
  // its networks apart, and Docker Desktop forwards the host's loopback,
  // where the base app is published. Then a probe on the PR pane's network: can it reach this
  // conductor at an address that leads to the host's loopback (`canary`:
  // the harness port, a path, and what the harness answers there), or the
  // base pane's database? Its own pane's database is its positive control:
  // a probe that can't reach even that has shown nothing. Anything it can't
  // tell is unknown, never isolated.
  const check = async ({ signal, canary, up }) => {
    // An address:port target's family: an address with a colon of its own
    // is IPv6.
    const familyOf = target => (target.slice(0, target.lastIndexOf(':')).includes(':') ? 'IPv6' : 'IPv4')
    // The probe's output: its hits, the address families its control hit
    // over, and whether it finished.
    const readProbe = text => {
      const lines = typeof text === 'string' ? text.split('\n').map(line => line.trim()) : []
      const hits = []
      const vouched = new Set()
      let answered = false // the forwarder's proxy answered a CONNECT
      for (const line of lines) {
        const [kind, where] = line.split(' ')
        if (kind === 'listener' && where) hits.push(`the PR pane reached this conductor at ${where}:${canary.port}, so it can reach the host's loopback, where the base app is published`)
        if (kind === 'open' && where) hits.push(`the PR pane reached the base pane's database at ${where}`)
        if (kind === 'self' && where) vouched.add(familyOf(where))
        if (kind === 'proxied' && where) hits.push(`the PR pane got through the forwarder's proxy to ${where}`)
        if ((kind === 'proxied' || kind === 'refused') && where) answered = true
      }
      return { hits, vouched, answered, done: lines.includes('probe done') }
    }
    // reachable when the runtime already says so, else unknown, saying why
    const found = []
    const cannotTell = reason => ({ verdict: found.length ? 'reachable' : 'unknown', reasons: [...found, reason] })
    let runtime
    try {
      runtime = await docker.runtime()
    } catch (err) {
      return cannotTell(`could not tell the container runtime: ${errorLine(err)}`)
    }
    // Known from `docker version` alone, behind the podman-docker shim too,
    // whose info and network formats differ.
    if (/podman/i.test(runtime.version) && !up) return { verdict: 'reachable', reasons: ['Podman\'s networks don\'t keep one pane\'s containers from the other\'s'] }
    if (runtime.osError) return cannotTell(`could not tell the container runtime: ${errorLine(runtime.osError)}`)
    // The probe speaks for this host's loopback only when the daemon runs
    // here: one on another host publishes the pane apps there.
    let endpoint
    try {
      endpoint = await docker.endpoint()
    } catch (err) {
      return cannotTell(`could not tell where the Docker daemon runs: ${errorLine(err)}`)
    }
    if (!/^(unix|npipe):\/\//i.test(endpoint)) {
      let where = 'an unknown endpoint'
      try { const u = new URL(endpoint); where = `${u.protocol}//${u.hostname}` } catch { /* shown as unknown */ }
      return cannotTell(`the Docker daemon is at ${where}, which may not be this host, so the probe can't speak for this host's loopback`)
    }
    if (/docker desktop/i.test(runtime.os) && !up) found.push('Docker Desktop forwards host.docker.internal to the host\'s loopback, where the base app is published')
    // every address each database has, on every network it joined
    const databaseOf = async role => {
      const addresses = await docker.containerAddresses(pgName(role))
      if (addresses.length === 0) throw new Error(`${pgName(role)} has none`)
      return addresses
    }
    let gateways
    let baseAddresses
    let ownDbs
    try {
      gateways = await docker.networkGateways(networks.pr)
      baseAddresses = await databaseOf('base')
      ownDbs = (await databaseOf('pr')).map(address => `${address}:5432`)
    } catch (err) {
      return cannotTell(`could not find the panes' addresses: ${errorLine(err)}`)
    }
    const baseDbs = baseAddresses.map(address => `${address}:5432`)
    const hosts = [...new Set([...HOST_ADDRESSES, ...gateways])]
    // through the forwarder's proxy too: each host at the harness port, and
    // the base database, as CONNECT targets (an IPv6 address in brackets)
    const target = (address, port) => (address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`)
    const proxy = `${EGRESS.alias}:${EGRESS.port}`
    const vias = up ? ['--', proxy, ...hosts.map(host => target(host, canary.port)), ...baseAddresses.map(address => target(address, 5432))] : []
    // docker run killed at probeTimeoutMs, or not settled a little after
    // (an exec that ignores its timeout): the container may still be up
    const timedOut = async () => {
      await docker.rmForce([probeName]).catch(() => {})
      const within = probeTimeoutMs >= 1000 ? `${Math.round(probeTimeoutMs / 1000)} s` : `${probeTimeoutMs} ms`
      return cannotTell(`the probe didn't finish within ${within}, so it can't say what the PR pane reaches`)
    }
    let out
    try {
      live(signal)
      const run = docker.runProbe(probeName, networks.pr, PROBE_SCRIPT, [String(canary.port), canary.path, canary.expect, ...hosts, '--', ...baseDbs, '--', ...ownDbs, ...vias], { timeoutMs: probeTimeoutMs, signal })
      out = await settledWithin(run, probeTimeoutMs + Math.min(2000, probeTimeoutMs))
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      // what it found before it failed or was killed still counts
      found.push(...readProbe(err?.stdout).hits)
      if (err?.killed) return timedOut()
      return cannotTell(`the probe couldn't run: ${errorLine(err)}`)
    }
    if (out === UNSETTLED) return timedOut()
    const { hits, vouched, answered, done } = readProbe(out)
    found.push(...hits)
    if (!done) return cannotTell('the probe didn\'t finish, so it can\'t say what the PR pane reaches')
    // no answer from the proxy: its misses prove nothing
    if (up && !answered) return cannotTell(`the probe got no answer from the forwarder's proxy at ${proxy}, so it can't say what the proxy lets through`)
    // A hit shows itself. A miss means something only once the control
    // hit over the same address family: an IPv4 hit says nothing of IPv6.
    if (hits.length === 0) {
      const unvouched = [...new Set(baseDbs.map(familyOf))].filter(family => !vouched.has(family)).sort()
      if (unvouched.length) {
        const own = family => ownDbs.filter(t => familyOf(t) === family).join(', ') || 'no address'
        const reasons = unvouched.map(family => `the probe couldn't reach the PR pane's own database over ${family} (${own(family)}), so its ${family} misses prove nothing`)
        return { verdict: found.length ? 'reachable' : 'unknown', reasons: [...found, ...reasons] }
      }
    }
    return found.length ? { verdict: 'reachable', reasons: found } : { verdict: 'isolated', reasons: [] }
  }

  return {
    networks,
    // the PR pane is meant for an internal network: until the check's result
    // says `internal: true`, nothing is taken for it (lib/isolation.mjs)
    internal: inside !== null,

    async provisionDatabase({ paneRef, databases, signal }) {
      const net = networkOf(paneRef.role)
      live(signal)
      if (paneRef.role === 'pr' && inside) {
        topology = null
        topology = await internalNetwork(signal)
      } else {
        // One left over is reused; any other failure, such as no address
        // pool left, stops the boot here.
        await docker.createNetwork(net).catch(err => reuseNetwork(net, err))
      }
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
      // A Seed or sign-in still running when the boot is aborted can't write
      // through it: by then the next session may own this pane's name.
      const db = {
        dsn,
        query: async (sql, { database } = {}) => {
          live(signal)
          return docker.psql(pg, database ?? pgUser.db, sql)
        },
      }
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
      const file = await writeEnv(paneRef.role, paneEnv(paneRef.role, env.app ?? Object.values(env)[0]))
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
        const file = await writeEnv(paneRef.role, paneEnv(paneRef.role, env[name]))
        live(signal)
        // on an internal network, the forwarder publishes the app's port
        await docker.runApp(appName(paneRef.role), image, net, file, paneRef.role === 'pr' && internalUp() ? null : reserved[name].port)
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
    // Each step runs whatever the one before did; the first failure rejects
    // once all have run. A daemon that isn't up fails at `docker ps`, before
    // anything else can.
    async sweep() {
      for (const role of ['base', 'pr']) await fsx.unlink(envFile(role)).catch(() => {})
      await docker.sweepQaContainers().then(() => {}, err => err).then(async containers => {
        const failures = [containers]
        for (const name of [networks.base, networks.pr, ...(inside ? [edge] : [])]) failures.push(await docker.rmNetwork(name).then(() => {}, err => err))
        if (typeof network === 'string' && networkName(network)) failures.push(await docker.rmLabelledNetwork(network).then(() => {}, err => err))
        const failure = failures.find(err => err !== undefined)
        if (failure !== undefined) throw failure
      })
    },

    // Whether the PR pane can reach the base pane: check, below. With the
    // internal topology up, the runtime's own reasons (Podman's networks,
    // Docker Desktop's forwarding) are what it is for, so the probe decides,
    // and it also asks the forwarder's proxy for every address it tries
    // directly. The result then says `internal: true`. One that fell back
    // says why, when the verdict isn't isolated.
    async isolation({ signal, canary }) {
      live(signal)
      const up = internalUp()
      const out = await check({ signal, canary, up })
      if (up) return { ...out, internal: true }
      if (inside && topology && !topology.up && out.verdict !== 'isolated') {
        out.reasons.push(`the PR pane's internal network couldn't be set up (${topology.failure}), so it runs on an ordinary network`)
      }
      return out
    },

    // Rejects when a container or the network may still be up, after trying
    // every step: the conductor opens enrolment only once a teardown left no
    // pane running (README, Security).
    async teardown({ paneRef }) {
      // The migrate run too, which a teardown during migrating finds still
      // running: it would keep the network alive. And the PR pane's probe.
      // With `internal`, the PR pane's forwarder and its edge network too.
      const withForwarder = paneRef.role === 'pr' && inside !== null
      const names = [appName(paneRef.role), migrateName(paneRef.role), ...(paneRef.role === 'pr' ? [probeName] : []), ...(withForwarder ? [FORWARDER] : []), pgName(paneRef.role)]
      const containers = await docker.rmForce(names).then(() => {}, err => err)
      // This pane's own network; rmNetwork tolerates one already gone.
      const net = await docker.rmNetwork(networkOf(paneRef.role)).then(() => {}, err => err)
      const edgeNet = withForwarder ? await docker.rmNetwork(edge).then(() => {}, err => err) : undefined
      await fsx.unlink(envFile(paneRef.role)).catch(() => {})
      const failure = containers ?? net ?? edgeNet
      if (failure !== undefined) throw failure
    },
  }
}
