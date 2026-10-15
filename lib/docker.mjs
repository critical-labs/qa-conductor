// Docker CLI wrappers for QA sessions. All effects go through the injected
// execFileFn (promisified child_process.execFile shape: resolves { stdout }),
// so tests assert exact argv without touching docker.

const SAFE_NAME = /^[a-z0-9_-]+$/i
const DEFAULT_LABEL = 'qa-conductor-session'
const DEFAULT_POSTGRES = { image: 'postgres:16', user: 'qa', password: 'qa', db: 'postgres' }

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Every pane container runs without raw sockets: a pane has no use for
// crafted packets, which on some setups can reach ports published on the
// host's loopback. It costs ping-style tools inside the container.
const NO_RAW = ['--cap-drop', 'NET_RAW']

function assertSafe(value, what) {
  if (!SAFE_NAME.test(value)) throw new Error(`unsafe ${what}: ${JSON.stringify(value)}`)
}

// Lines a CLI writes to stderr that say nothing of the failure: the
// "Command failed" line makeExecFileFn puts first in a message, the
// podman-docker shim's banner (on every call), and Podman's logger's
// warnings and notes (WARN[0000] … on a TTY, time="…" level=warning … in a
// pipe). Its errors (ERRO, level=error) are kept.
const NOISE = [
  /^(docker \S+: )?Command failed/i,
  /^Emulate Docker CLI using podman\./,
  /^(WARN|INFO|DEBU)\[\d+\] /,
  /^time="[^"]*" level=(warning|info|debug) /,
]

// True when a docker CLI failure says only that what it was asked to remove
// doesn't exist: every error line it wrote matches `missing`, and there is
// one. makeExecFileFn puts the CLI's stderr in `stderr`; without one, the
// message is read.
function onlyMissing(err, missing) {
  const lines = saying(err)
  return lines.length > 0 && lines.every(line => missing.test(line))
}

// A failure's text, as lines: docker's stderr when there is one (the message
// repeats the whole command line), else the message.
function failureLines(err) {
  const text = typeof err?.stderr === 'string' && err.stderr.trim() ? err.stderr : String(err?.message ?? err ?? '')
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

// Those of its lines that say something of the failure.
const saying = err => failureLines(err).filter(line => !NOISE.some(noise => noise.test(line)))

// One line of a docker CLI failure, for a reason a person reads: the first
// that says something of it, else the first there is.
export function errorLine(err) {
  return saying(err)[0] ?? failureLines(err)[0] ?? 'no detail'
}

// `label` marks every conductor-owned container/network (the startup sweep
// removes whatever carries it); `postgres` is the pane database identity.
// A consuming app that clones a real database passes its own superuser here.
export function createDocker({ execFileFn, label = DEFAULT_LABEL, postgres = DEFAULT_POSTGRES }) {
  // Keys set to undefined (an unset env var, say) keep their defaults.
  const pg = { ...DEFAULT_POSTGRES, ...Object.fromEntries(Object.entries(postgres ?? {}).filter(([, value]) => value !== undefined)) }
  async function run(argv) {
    const { stdout } = await execFileFn('docker', argv)
    return stdout
  }

  return {
    run,

    // Log the daemon into GHCR with the conductor's own token so pane image
    // pulls never depend on a manually-seeded (and expiring) host credential.
    // Token travels via the child env, never argv. Merge (not replace) the
    // parent env so HOME survives — docker login writes ~/.docker/config.json,
    // and docker pull/run must read the SAME HOME or the credential is lost.
    async login(user, token) {
      assertSafe(user, 'registry user')
      // biome-ignore lint/nursery/noProcessEnv: must inherit HOME so docker login/pull share a config
      const parentEnv = globalThis.process?.env ?? {}
      await execFileFn('sh', ['-c', 'printf %s "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin'], {
        env: { ...parentEnv, GHCR_USER: user, GHCR_TOKEN: token },
      })
    },

    async imagePresent(image) {
      try {
        await run(['image', 'inspect', image])
        return true
      } catch {
        return false
      }
    },

    // Make an image local before it's run. No-op if already present; otherwise
    // pull with retries, re-logging-in before each retry so a transient
    // registry 'denied' (seen live — same token pulls fine seconds later)
    // self-heals instead of killing the boot.
    async ensureImage(image, { retries = 3, sleepFn = defaultSleep, relogin } = {}) {
      if (await this.imagePresent(image)) return
      let lastErr
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          await run(['pull', image])
          return
        } catch (err) {
          lastErr = err
          if (relogin) await relogin().catch(() => {})
          await sleepFn(3000)
        }
      }
      throw new Error(`pull ${image} failed after ${retries} attempts: ${lastErr?.message ?? ''}`)
    },

    // The pane database image, made local before runPg, so `docker run` never
    // pulls it inside the call that creates the container (a caller can stop
    // between the two).
    async ensurePgImage(opts = {}) {
      return this.ensureImage(pg.image, opts)
    },

    // The superuser password travels in the docker CLI's env, never argv: a
    // bare `-e POSTGRES_PASSWORD` makes docker copy it from there, as login
    // does with the token. A per-call password (the Docker Provisioner draws
    // one per pane) wins over postgres.password.
    async runPg(name, network, { password = pg.password } = {}) {
      // An empty one would reach the container as POSTGRES_PASSWORD=, which
      // postgres refuses only after the health wait gives up.
      if (typeof password !== 'string' || password === '') throw new Error('runPg needs a non-empty string password')
      // biome-ignore lint/nursery/noProcessEnv: the CLI must keep HOME, PATH and DOCKER_HOST
      const parentEnv = globalThis.process?.env ?? {}
      const { stdout } = await execFileFn('docker', [
        'run', '-d',
        '--name', name,
        '--network', network,
        '--label', label,
        ...NO_RAW,
        '-e', `POSTGRES_USER=${pg.user}`,
        '-e', 'POSTGRES_PASSWORD',
        '-e', `POSTGRES_DB=${pg.db}`,
        // Overrides the image's own ENV, which can say trust; the official
        // entrypoint writes `host all all all <this>` into pg_hba.conf. md5
        // rather than scram-sha-256: it also asks for an md5-stored password
        // (postgres 13's default), and it uses SCRAM where the stored
        // password is SCRAM (the default from 14 on). Kept only for 13, which
        // is end-of-life: move to scram-sha-256 once upstream drops md5.
        '-e', 'POSTGRES_HOST_AUTH_METHOD=md5',
        pg.image,
      ], { env: { ...parentEnv, POSTGRES_PASSWORD: password } })
      return stdout
    },

    // postgres:16's entrypoint starts a TEMPORARY server during initdb, stops
    // it, then starts the real one. pg_isready can pass against the temporary
    // server, so require two consecutive successful probes (with a real query)
    // separated by a beat — the shutdown gap fails one of them and resets.
    async waitHealthyPg(name, { retries = 30, sleepFn = defaultSleep } = {}) {
      let consecutive = 0
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          await run(['exec', name, 'pg_isready', '-U', pg.user])
          await run(['exec', name, 'psql', '-U', pg.user, '-d', pg.db, '-c', 'SELECT 1'])
          consecutive += 1
          if (consecutive >= 2) return
        } catch {
          consecutive = 0
          if (attempt === retries) break
        }
        await sleepFn(1000)
      }
      throw new Error(`postgres ${name} not ready after ${retries} attempts`)
    },

    // CREATE DATABASE in a pane pg container, tolerating already-exists and
    // retrying through the postgres-init restart window. Extracted from cloneDb
    // so the Provisioner seam can own DB creation while the Seed seam owns data
    // movement (extraction Stage 1). cloneDb keeps its behavior by composing the
    // two.
    async createDatabase(toContainer, db, { retries = 10, sleepFn = defaultSleep } = {}) {
      assertSafe(toContainer, 'container name')
      assertSafe(db, 'database name')
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          await run(['exec', toContainer, 'psql', '-U', pg.user, '-d', pg.db, '-c', `CREATE DATABASE ${db}`])
          return
        } catch (err) {
          const detail = `${err.message ?? ''}\n${err.stderr ?? ''}`
          if (detail.includes('already exists')) return
          // Connection refusals can still occur in the entrypoint's restart
          // window; retry those instead of failing the whole boot.
          const transient = detail.includes('connection to server') || detail.includes('the database system is starting up')
          if (!transient || attempt === retries) throw err
          await sleepFn(1000)
        }
      }
    },

    // Copy one database from a source container into a pane container via a
    // host-side pg_dump|psql pipe. This is a docker-topology detail the Seed
    // adapter owns; kept here as the shared movement primitive.
    async pipeDump(fromContainer, toContainer, db) {
      assertSafe(fromContainer, 'container name')
      assertSafe(toContainer, 'container name')
      assertSafe(db, 'database name')
      const pipeline =
        `docker exec ${fromContainer} pg_dump -U ${pg.user} --clean --if-exists ${db}` +
        ` | docker exec -i ${toContainer} psql -q -U ${pg.user} -d ${db}`
      await execFileFn('sh', ['-c', pipeline])
    },

    async cloneDb(fromContainer, toContainer, db, opts = {}) {
      // Validate all three up front so a bad source is rejected before any exec.
      assertSafe(fromContainer, 'container name')
      assertSafe(toContainer, 'container name')
      assertSafe(db, 'database name')
      await this.createDatabase(toContainer, db, opts)
      await this.pipeDump(fromContainer, toContainer, db)
    },

    // A name lets a teardown remove a run still in flight.
    async runMigrate(image, network, envFile, { name } = {}) {
      return run([
        'run', '--rm',
        ...(name ? ['--name', name] : []),
        '--network', network,
        '--label', label,
        ...NO_RAW,
        '--env-file', envFile,
        image,
      ])
    },

    // hostPort null publishes nothing: on an internal network (#32) the
    // forwarder publishes the app's port in its place.
    async runApp(name, image, network, envFile, hostPort) {
      return run([
        'run', '-d',
        '--name', name,
        '--network', network,
        '--label', label,
        ...NO_RAW,
        '--env-file', envFile,
        ...(hostPort === null ? [] : ['-p', `127.0.0.1:${hostPort}:3000`]),
        image,
      ])
    },

    // The PR pane's forwarder (lib/forwarder.mjs, #32), on `network`, an
    // ordinary one: `source` run with node, its config in PANE_FORWARDER. It
    // publishes its port 3000, which it pipes to the PR app, on the host's
    // loopback. No capabilities, a read-only root, no privilege gain, not
    // root, and no mounts.
    async runForwarder(name, image, network, { hostPort, config, source }) {
      assertSafe(name, 'container name')
      return run([
        'run', '-d',
        '--name', name,
        '--network', network,
        '--label', label,
        '--cap-drop', 'ALL', '--read-only', '--security-opt', 'no-new-privileges', '--user', 'node',
        '-p', `127.0.0.1:${hostPort}:3000`,
        '-e', `PANE_FORWARDER=${JSON.stringify(config)}`,
        '--entrypoint', 'node',
        image,
        '--input-type=module', '-e', source,
      ])
    },

    // A running container joins another network, under `alias` there too.
    async connectNetwork(network, container, { alias }) {
      assertSafe(container, 'container name')
      return run(['network', 'connect', '--alias', alias, network, container])
    },

    async waitHealthyApp(hostPort, { retries = 60, sleepFn = defaultSleep, fetchFn = fetch } = {}) {
      const url = `http://127.0.0.1:${hostPort}/api/health`
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await fetchFn(url)
          if (res.status === 200) return
        } catch {
          // app not listening yet
        }
        if (attempt < retries) await sleepFn(1000)
      }
      throw new Error(`app on port ${hostPort} not healthy after ${retries} attempts`)
    },

    async psql(container, db, sql) {
      return run(['exec', container, 'psql', '-U', pg.user, '-d', db, '-t', '-A', '-c', sql])
    },

    // Teardown is idempotent: a name already gone is fine. Any other failure
    // (no daemon, a container it can't kill) rejects, since a pane may still
    // be up: the conductor must not take it for gone.
    async rmForce(names) {
      if (!names.length) return
      try {
        await run(['rm', '-f', '-v', ...names])
      } catch (err) {
        if (!onlyMissing(err, /no such container/i)) throw err
      }
    },

    // `internal`: a network with no route off itself (#32).
    async createNetwork(name, { internal = false } = {}) {
      return run(['network', 'create', '--label', label, ...(internal ? ['--internal'] : []), name])
    },

    // Whether a network is internal, as Docker and Podman report it.
    async networkInternal(name) {
      return (await run(['network', 'inspect', '--format', '{{.Internal}}', name])).trim() === 'true'
    },

    // Likewise: only a network already gone is fine. One still in use (a
    // container that didn't come down) rejects. Docker Engine says "No such
    // network: <n>" or "network <n> not found"; Podman ends its line in
    // "network not found", through its own CLI ("unable to find network with
    // name or ID <n>: network not found") or its compat API ("Error response
    // from daemon: network not found").
    async rmNetwork(name) {
      try {
        await run(['network', 'rm', name])
      } catch (err) {
        if (!onlyMissing(err, /no such network|network \S+ not found|(?:^|: )network not found$/i)) throw err
      }
    },

    // Removes a network of exactly that name only when it carries the label,
    // so one the conductor didn't create is left alone. Resolves whether it
    // tried.
    async rmLabelledNetwork(name) {
      let names
      try {
        names = (await run(['network', 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}'])).split('\n').map(s => s.trim())
      } catch {
        return false
      }
      if (!names.includes(name)) return false
      await this.rmNetwork(name)
      return true
    },

    async sweepQaContainers() {
      const out = await run(['ps', '-aq', '--filter', `label=${label}`])
      const ids = out.split('\n').map((s) => s.trim()).filter(Boolean)
      if (ids.length) await this.rmForce(ids)
      return ids
    },

    // What the daemon is, for the isolation check: `docker version`'s text
    // (Podman's says so) and `docker info`'s operating system (Docker
    // Desktop's says so).
    // `docker version`, which names Podman behind the podman-docker shim,
    // and `docker info`'s OperatingSystem, which names Docker Desktop. The
    // shim's info has no OperatingSystem, so its failure is kept (`osError`,
    // with `os` null) rather than losing what version said; only version's
    // failure rejects.
    async runtime() {
      const version = await run(['version'])
      try {
        return { version, os: (await run(['info', '--format', '{{.OperatingSystem}}'])).trim(), osError: null }
      } catch (err) {
        return { version, os: null, osError: err }
      }
    },

    // A network's gateways, and a container's addresses on its networks.
    async networkGateways(name) {
      return (await run(['network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}', name])).split(/\s+/).filter(Boolean)
    },

    // Its IPv6 addresses too, on a dual-stack network: Docker Engine before
    // 27 doesn't isolate IPv6 between networks unless ip6tables is on.
    async containerAddresses(name) {
      return (await run(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}', name])).split(/\s+/).filter(Boolean)
    },

    // Where the CLI's daemon is: the current context's endpoint, which
    // DOCKER_HOST and DOCKER_CONTEXT set (unix://, npipe://, tcp://, ssh://).
    async endpoint() {
      return (await run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).trim()
    },

    // A throwaway container on `network`, from the postgres image (local by
    // now), that runs a bash `script` with `args` and is gone when it ends:
    // labelled for the sweep, with no capabilities, ports or mounts. It only
    // connects out. Resolves with its stdout. The docker CLI gets at most
    // `timeoutMs`, then SIGKILL: it would pass a SIGTERM on to the
    // container, whose bash, as PID 1, ignores it. `signal` (a boot's) stops
    // it too. Either way the container may outlive the CLI: the caller
    // removes it.
    async runProbe(name, network, script, args, { timeoutMs = 30_000, signal } = {}) {
      assertSafe(name, 'container name')
      const { stdout } = await execFileFn('docker', [
        'run', '--rm', '--name', name, '--network', network, '--label', label, '--cap-drop', 'ALL',
        '--entrypoint', 'bash', pg.image, '-c', script, 'probe', ...args,
      ], { timeout: timeoutMs, killSignal: 'SIGKILL', ...(signal ? { signal } : {}) })
      return stdout
    },

    async inspectImageOf(container) {
      const out = await run(['inspect', '--format', '{{.Config.Image}}', container])
      return out.trim()
    },

    // Tail a container's recent log lines for triage. docker logs writes to
    // both stdout and stderr, but the run() wrapper only surfaces stdout;
    // that's acceptable here — return whatever stdout the exec yields.
    async logsTail(name, n = 40) {
      assertSafe(name, 'container name')
      const result = await execFileFn('docker', ['logs', '--tail', String(n), name])
      return result.stdout || ''
    },
  }
}
