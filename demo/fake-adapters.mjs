// Demo adapters: the five seams faked in-process, so demo mode drives the real
// conductor with no GitHub, builds, containers or databases.
//
// - build: checkout-and-install style progress messages and delays, readiness
//   from the fixtures, and a trust-gate refusal for the blocked PR.
// - provisioner: an in-memory "database" per pane (the pane app's store:
//   its cart, messages and saved carts), and one pane app per pane served by
//   an in-process HTTP server on an ephemeral 127.0.0.1 port. The port is
//   bound in reserveServices, the app starts in launchServices, and teardown
//   closes it. #104's PR app crashes on start, so waitHealthy fails and
//   logs() returns the crash.
// - seed: three saved carts in each pane's store.
// - inspector: reads each pane's store, for the data checks (#8). #106's PR
//   app empties the saved carts with the cart, which they flag.
// - envTransform, auth: trivial versions (the pane apps have no login).
//
// Every delay goes through `pause`: scaled by the demo speed (0 = none), and
// cancelled both by the boot's signal and by the demo's lifetime signal, so
// stopping the demo mid-boot leaves no timers or servers behind.

import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

import { DEMO_BASE, DEMO_PRS, DEMO_REPO, appSpecFor, baseLabel, crashTail, findPr, prLabel } from './fixtures.mjs'
import { createPaneApp, createStore } from './pane-app.mjs'

const abortError = () => Object.assign(new Error('demo step aborted'), { name: 'AbortError' })

function throwIfAborted(...signals) {
  if (signals.some(s => s?.aborted)) throw abortError()
}

// pause(ms, signal?) waits ms × speed.
export function makePause({ speed = 1, lifetime = null } = {}) {
  return async (ms, signal) => {
    throwIfAborted(lifetime, signal)
    const wait = ms * speed
    if (wait <= 0) return
    const signals = [lifetime, signal].filter(Boolean)
    await sleep(wait, undefined, signals.length ? { signal: AbortSignal.any(signals) } : {})
  }
}

// --- BuildConvention -----------------------------------------------------------

export function createDemoBuild({ prs = DEMO_PRS, repo = DEMO_REPO, pause = makePause() } = {}) {
  const status = new Map(prs.map(p => [p.number, p.status]))
  let listener = null

  function progress(message, signal) {
    if (signal?.aborted || !listener) return
    try { listener({ message }) } catch { /* a listener's bug must not fail the build */ }
  }

  function fixture(number) {
    const pr = findPr(number, prs)
    if (!pr) throw new Error(`PR #${number} is not one of the demo fixtures`)
    return pr
  }

  async function ensureBuilt(number, { signal } = {}) {
    const pr = fixture(number)
    if (pr.status === 'blocked') throw new Error(`PR #${number} by @${pr.author} is not from a trusted source: ${pr.reason}`)
    const sha7 = pr.headSha.slice(0, 7)
    const previous = status.get(number)
    if (previous === 'none') status.set(number, 'building')
    try {
      progress(`fetching ${repo}…`, signal)
      await pause(400, signal)
      progress(`base (${DEMO_BASE.sha7}) already built`, signal)
      if (previous === 'built') return progress(`#${number} (${sha7}) already built`, signal)
      if (previous === 'building') {
        progress(`#${number} (${sha7}) is already building; waiting for it…`, signal)
        await pause(2000, signal)
      } else {
        progress(`checking out #${number} (${sha7})…`, signal)
        await pause(600, signal)
        progress(`installing dependencies for #${number} (${sha7})…`, signal)
        await pause(1800, signal)
      }
    } catch (err) {
      if (previous === 'none') status.set(number, 'none')
      throw err
    }
    status.set(number, 'built')
    progress(`#${number} (${sha7}) built`, signal)
  }

  return {
    migrationStrategy: 'on-boot',
    // The conductor subscribes on every boot; only the latest boot listens.
    subscribeBuild(cb) { listener = cb },
    ensureBuilt,
    // The service ref doubles as the label, so pre-0.2 cores (which show the
    // ref) and 0.2 cores (which show `label`) display the same thing.
    async resolveBaseImages() {
      const label = baseLabel()
      return { services: { app: label }, migrate: null, label }
    },
    async resolvePrImages(number) {
      const label = prLabel(fixture(number))
      return { services: { app: label }, migrate: null, label }
    },
    async describePrs(items) {
      return items.map(({ number }) => {
        const pr = findPr(number, prs)
        if (!pr) return { number, status: 'none', runUrl: null }
        if (pr.status === 'blocked') return { number, status: 'blocked', reason: pr.reason, runUrl: null }
        return { number, status: status.get(number), runUrl: null }
      })
    },
  }
}

// --- Provisioner ---------------------------------------------------------------

export function createDemoProvisioner({
  pause = makePause(),
  lifetime = null,
  host = '127.0.0.1',
  appSpec = appSpecFor,
  httpMod = http,
  logLines = 200,
} = {}) {
  // role -> { apps: Map<service, { server, port, handler }>, log, generation }
  const panes = { base: newPane(), pr: newPane() }

  function newPane() {
    return { apps: new Map(), log: [], generation: 0, store: createStore() }
  }
  function paneOf(role) {
    if (!panes[role]) throw new Error(`unknown pane role: ${role}`)
    return panes[role]
  }
  function record(pane, line) {
    pane.log.push(line)
    if (pane.log.length > logLines) pane.log.splice(0, pane.log.length - logLines)
  }
  function appOnPort(port) {
    for (const pane of Object.values(panes)) for (const app of pane.apps.values()) if (app.port === port) return app
    return null
  }
  async function closeServer(server) {
    if (!server.listening) return
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  }

  async function provisionDatabase({ paneRef, signal }) {
    throwIfAborted(lifetime, signal)
    const pane = paneOf(paneRef.role)
    pane.log = [] // a new boot starts a fresh log
    record(pane, '[db] creating database widgets (in memory)')
    // a fresh database for each boot, which the pane app keeps its data in
    pane.store = createStore()
    await pause(500, signal)
    // `db` is opaque to the core; here the seed writes to its store and this
    // pane's log, and the inspector reads the store.
    return { dsn: null, db: { name: 'widgets', store: pane.store, note: line => record(pane, `[db] ${line}`) } }
  }

  async function reserveServices({ paneRef, services, signal }) {
    const pane = paneOf(paneRef.role)
    const generation = pane.generation
    const out = {}
    for (const name of Object.keys(services)) {
      throwIfAborted(lifetime, signal)
      const previous = pane.apps.get(name)
      if (previous) await closeServer(previous.server)
      const app = { server: null, port: null, handler: null }
      // Bound now so the port is really ours; it answers 503 until launched.
      app.server = httpMod.createServer((req, res) => {
        if (app.handler) return app.handler(req, res)
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('starting')
      })
      app.server.listen(0, host)
      await once(app.server, 'listening')
      if (pane.generation !== generation || lifetime?.aborted || signal?.aborted) {
        // Torn down, or the demo stopped, while binding: don't leak the server.
        await closeServer(app.server)
        throw abortError()
      }
      app.port = app.server.address().port
      pane.apps.set(name, app)
      out[name] = { url: `http://${host}:${app.port}`, port: app.port }
    }
    return out
  }

  async function launchServices({ paneRef, services, env, signal }) {
    const pane = paneOf(paneRef.role)
    for (const [name, ref] of Object.entries(services)) {
      throwIfAborted(lifetime, signal)
      const app = pane.apps.get(name)
      if (!app) throw new Error(`${name}: no reserved port; call reserveServices first`)
      const spec = appSpec(ref)
      const say = line => record(pane, `[${name}] ${line}`)
      await pause(400, signal)
      if (spec.crashes) {
        for (const line of crashTail(spec.label)) say(line)
        await closeServer(app.server) // the process is gone, and its port with it
        continue
      }
      say(`widgets 0.4.0 (${spec.label}) starting`)
      say('migrations: 7 applied, 0 pending (run on boot)')
      app.handler = createPaneApp({
        variant: spec.variant, label: spec.label, env: env?.[name] ?? {}, log: say, store: pane.store, clearsSavedCarts: spec.clearsSavedCarts,
      })
      say(`listening on http://${host}:${app.port}`)
    }
  }

  async function waitHealthy({ services, signal }) {
    for (const [name, { port }] of Object.entries(services)) {
      if (!port) continue
      await pause(300, signal)
      if (!appOnPort(port)?.handler) throw new Error(`${name} on port ${port} exited with code 1 before it became healthy`)
    }
  }

  async function logs({ paneRef, lines = 40 }) {
    return paneOf(paneRef.role).log.slice(-lines).join('\n')
  }

  // Keeps the pane's log, so a failed boot's tail can still be read afterwards.
  async function teardown({ paneRef }) {
    const pane = paneOf(paneRef.role)
    pane.generation++
    const apps = [...pane.apps.values()]
    pane.apps.clear()
    await Promise.all(apps.map(app => closeServer(app.server)))
  }

  return {
    provisionDatabase, reserveServices, launchServices, waitHealthy, logs, teardown,
    // the pane apps are this process's own servers
    isolation: 'shared-host',
    // Demo-only: closes every pane app, for a core whose stop() doesn't tear down.
    async close() {
      await Promise.all(Object.keys(panes).map(role => teardown({ paneRef: { role } })))
    },
  }
}

// --- Seed, EnvTransform, AuthBootstrap ------------------------------------------

// The saved carts each pane starts with.
export const SAVED_CARTS = [
  { name: 'Workshop restock', items: 4, owner: 'ada@example.com' },
  { name: 'Birthday kit', items: 2, owner: 'grace@example.com' },
  { name: 'Spares', items: 7, owner: 'linus@example.com' },
]

export function createDemoSeed({ pause = makePause() } = {}) {
  return {
    databases: ['widgets'],
    async seedPane({ db, signal }) {
      await pause(600, signal)
      if (db?.store) for (const cart of SAVED_CARTS) db.store.saved_carts.push({ id: db.store.nextId++, ...cart })
      db?.note?.('seeded 24 products and 3 saved carts from fixtures')
    },
  }
}

// Reads a pane's store, as an inspector would read its database: each table
// with its key and columns. Who sent a message, and who owns a saved cart,
// is personal data.
export function createDemoInspector() {
  const table = (rows, fields) => ({ key: ['id'], fields, rows: rows.map(row => ({ ...row })), count: rows.length })
  return {
    rules: {
      classify: [
        { collection: 'messages', fields: ['name', 'email', 'message'], as: 'pii' },
        { collection: 'saved_carts', fields: ['owner'], as: 'pii' },
      ],
    },
    open({ db }) {
      const store = db?.store
      if (!store) throw new Error('this pane has no demo store')
      return {
        snapshot: () => ({
          collections: {
            cart_items: table(store.cart_items, ['id', 'slug', 'qty']),
            messages: table(store.messages, ['id', 'name', 'email', 'topic', 'message', 'newsletter']),
            saved_carts: table(store.saved_carts, ['id', 'name', 'items', 'owner']),
          },
        }),
      }
    },
  }
}

// Each pane gets its own origin, and mail is switched off, as a real one would.
export const demoEnvTransform = {
  derivePaneEnv: ({ prodEnv, pane }) => ({
    app: { APP_NAME: prodEnv.APP_NAME ?? 'widgets', PUBLIC_ORIGIN: pane.publicOrigin, MAIL: 'off' },
  }),
}

// The pane apps have no login, so a session is just the landing page.
export const demoAuth = {
  requiresDb: false,
  establishSession: async ({ pane }) => ({ landingUrl: `${pane.publicOrigin}/` }),
}
