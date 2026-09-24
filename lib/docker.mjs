// Docker CLI wrappers for QA sessions. All effects go through the injected
// execFileFn (promisified child_process.execFile shape: resolves { stdout }),
// so tests assert exact argv without touching docker.

const SAFE_NAME = /^[a-z0-9_-]+$/i
const DEFAULT_LABEL = 'homefree-qa-session'
const DEFAULT_POSTGRES = { image: 'postgres:16', user: 'homefree', password: 'qa', db: 'postgres' }

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assertSafe(value, what) {
  if (!SAFE_NAME.test(value)) throw new Error(`unsafe ${what}: ${JSON.stringify(value)}`)
}

// `label` and `postgres` default to homefree's values so the conductor keeps
// working unconfigured; a consuming app overrides them via loadConfig -> here.
export function createDocker({ execFileFn, label = DEFAULT_LABEL, postgres = DEFAULT_POSTGRES }) {
  const pg = { ...DEFAULT_POSTGRES, ...postgres }
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

    async runPg(name, network) {
      return run([
        'run', '-d',
        '--name', name,
        '--network', network,
        '--label', label,
        '-e', `POSTGRES_USER=${pg.user}`,
        '-e', `POSTGRES_PASSWORD=${pg.password}`,
        '-e', `POSTGRES_DB=${pg.db}`,
        pg.image,
      ])
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

    async runMigrate(image, network, envFile) {
      return run([
        'run', '--rm',
        '--network', network,
        '--label', label,
        '--env-file', envFile,
        image,
      ])
    },

    async runApp(name, image, network, envFile, hostPort) {
      return run([
        'run', '-d',
        '--name', name,
        '--network', network,
        '--label', label,
        '--env-file', envFile,
        '-p', `127.0.0.1:${hostPort}:3000`,
        image,
      ])
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

    async rmForce(names) {
      if (!names.length) return
      try {
        await run(['rm', '-f', '-v', ...names])
      } catch {
        // teardown is idempotent: already-gone containers are fine
      }
    },

    async createNetwork(name) {
      return run(['network', 'create', '--label', label, name])
    },

    async rmNetwork(name) {
      try {
        await run(['network', 'rm', name])
      } catch {
        // already gone
      }
    },

    async sweepQaContainers() {
      const out = await run(['ps', '-aq', '--filter', `label=${label}`])
      const ids = out.split('\n').map((s) => s.trim()).filter(Boolean)
      if (ids.length) await this.rmForce(ids)
      return ids
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
