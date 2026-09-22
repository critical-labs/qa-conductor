// Docker CLI wrappers for QA sessions. All effects go through the injected
// execFileFn (promisified child_process.execFile shape: resolves { stdout }),
// so tests assert exact argv without touching docker.

const SAFE_NAME = /^[a-z0-9_-]+$/i
const LABEL = 'homefree-qa-session'

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assertSafe(value, what) {
  if (!SAFE_NAME.test(value)) throw new Error(`unsafe ${what}: ${JSON.stringify(value)}`)
}

export function createDocker({ execFileFn }) {
  async function run(argv) {
    const { stdout } = await execFileFn('docker', argv)
    return stdout
  }

  return {
    run,

    // Log the daemon into GHCR with the conductor's own token so pane image
    // pulls never depend on a manually-seeded (and expiring) host credential.
    // Token travels via the child env, never argv.
    async login(user, token) {
      assertSafe(user, 'registry user')
      await execFileFn('sh', ['-c', 'printf %s "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin'], {
        env: { GHCR_USER: user, GHCR_TOKEN: token, PATH: '/usr/local/bin:/usr/bin:/bin' },
      })
    },

    async runPg(name, network) {
      return run([
        'run', '-d',
        '--name', name,
        '--network', network,
        '--label', LABEL,
        '-e', 'POSTGRES_USER=homefree',
        '-e', 'POSTGRES_PASSWORD=qa',
        '-e', 'POSTGRES_DB=postgres',
        'postgres:16',
      ])
    },

    async waitHealthyPg(name, { retries = 30, sleepFn = defaultSleep } = {}) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          await run(['exec', name, 'pg_isready', '-U', 'homefree'])
          return
        } catch {
          if (attempt === retries) break
          await sleepFn(1000)
        }
      }
      throw new Error(`postgres ${name} not ready after ${retries} attempts`)
    },

    async cloneDb(fromContainer, toContainer, db) {
      assertSafe(fromContainer, 'container name')
      assertSafe(toContainer, 'container name')
      assertSafe(db, 'database name')
      try {
        await run(['exec', toContainer, 'psql', '-U', 'homefree', '-d', 'postgres', '-c', `CREATE DATABASE ${db}`])
      } catch (err) {
        const detail = `${err.message ?? ''}\n${err.stderr ?? ''}`
        if (!detail.includes('already exists')) throw err
      }
      const pipeline =
        `docker exec ${fromContainer} pg_dump -U homefree --clean --if-exists ${db}` +
        ` | docker exec -i ${toContainer} psql -q -U homefree -d ${db}`
      await execFileFn('sh', ['-c', pipeline])
    },

    async runMigrate(image, network, envFile) {
      return run([
        'run', '--rm',
        '--network', network,
        '--label', LABEL,
        '--env-file', envFile,
        image,
      ])
    },

    async runApp(name, image, network, envFile, hostPort) {
      return run([
        'run', '-d',
        '--name', name,
        '--network', network,
        '--label', LABEL,
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
      return run(['exec', container, 'psql', '-U', 'homefree', '-d', db, '-t', '-A', '-c', sql])
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
      return run(['network', 'create', '--label', LABEL, name])
    },

    async rmNetwork(name) {
      try {
        await run(['network', 'rm', name])
      } catch {
        // already gone
      }
    },

    async sweepQaContainers() {
      const out = await run(['ps', '-aq', '--filter', `label=${LABEL}`])
      const ids = out.split('\n').map((s) => s.trim()).filter(Boolean)
      if (ids.length) await this.rmForce(ids)
      return ids
    },

    async inspectImageOf(container) {
      const out = await run(['inspect', '--format', '{{.Config.Image}}', container])
      return out.trim()
    },
  }
}
