// Demo mode: a real startConductor over fixture PRs and fake adapters, so the
// whole harness UI can be exercised with no GitHub, containers or databases.
//
// Everything binds 127.0.0.1: the harness on `port`, the two pane proxies and
// the two pane apps on ephemeral ports. `cfg` is built here rather than by
// loadConfig; the pane origins depend on the proxies' ephemeral ports, so they
// are filled in once the proxies listen (the core reads them at session time).
// The demo is always ungated (exposure 'none'; see demoConfig).
//
// startDemo({ port = 4100, speed = 1, log = console, harnessOrigin = null, frameAncestors = [] })
//   => { stop(), ports: { harness, base, pr } }
// `speed` scales the fake build and boot delays; 0 means none.
// `harnessOrigin` is where viewers open the harness; without one the core
// derives it from the bound port (http://127.0.0.1:<port>). `frameAncestors`
// adds origins that may frame the panes. Self-QA runs each pane as a demo
// whose harness is seen at the outer pane's origin, inside the outer harness,
// and passes both.

import fs from 'node:fs'
import { once } from 'node:events'

import { startConductor } from '../lib/server.mjs'
import { DEMO_REPO } from './fixtures.mjs'
import { createDemoGithub } from './fake-github.mjs'
import {
  createDemoBuild, createDemoInspector, createDemoProvisioner, createDemoSeed, demoAuth, demoEnvTransform, makePause,
} from './fake-adapters.mjs'

export const DEMO_HOST = '127.0.0.1'

function demoConfig(port, { harnessOrigin, frameAncestors }) {
  return {
    env: {},
    githubToken: null,
    repo: DEMO_REPO,
    operatorEmail: 'reviewer@example.com',
    host: DEMO_HOST,
    publicHost: null,
    allowedHosts: [],
    idleMinutes: 30,
    ports: { harness: port, base: 0, pr: 0 },
    // Placeholders until the proxies listen; startDemo fills in their ports.
    paneOrigins: { base: `http://${DEMO_HOST}`, pr: `http://${DEMO_HOST}` },
    harnessOrigin,
    frameAncestors,
    // Always ungated, whatever the harness origin. The demo binds loopback;
    // nested in self-QA it sits behind the outer conductor's identity gate,
    // and that outer pane proxy strips Tailscale-* headers, so the demo could
    // never see a login anyway.
    exposure: 'none',
    verdictLabels: { accept: 'qa-approved', reject: 'qa-changes-requested' },
  }
}

function checkOptions(port, speed) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`startDemo: port must be an integer 0-65535, got ${port}`)
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) throw new Error(`startDemo: speed must be a number >= 0, got ${speed}`)
}

// Resolves once `server` has bound, rejecting on a listen error. Must be
// called in the tick the listen started, or the 'listening' event is missed.
function whenListening(server) {
  return server.listening ? Promise.resolve() : once(server, 'listening')
}

// A core that predates cfg.host binds every interface, synchronously. Close
// those servers before the event loop can accept a connection on them, then
// bind them again on loopback. With a core that honours cfg.host, a no-op.
async function moveToLoopback(servers, portOf) {
  const wide = servers.filter(s => s.address()?.address !== DEMO_HOST)
  for (const s of wide) s.close()
  await Promise.all(wide.map(s => {
    s.listen(portOf(s), DEMO_HOST)
    return once(s, 'listening')
  }))
}

// Closes whatever is still listening. closeAllConnections ends SSE streams
// and idle keep-alive sockets, which close() would otherwise wait for.
function closeServers(servers) {
  for (const s of servers) {
    if (s.listening) s.close()
    s.closeAllConnections()
  }
}

export async function startDemo({ port = 4100, speed = 1, log = console, harnessOrigin = null, frameAncestors = [] } = {}) {
  checkOptions(port, speed)
  // Aborted by stop(): cancels every fake delay and blocks new pane apps.
  const life = new AbortController()
  const pause = makePause({ speed, lifetime: life.signal })
  const cfg = demoConfig(port, { harnessOrigin, frameAncestors })
  const github = createDemoGithub({ log })
  const provisioner = createDemoProvisioner({ pause, lifetime: life.signal, host: DEMO_HOST })
  const adapters = {
    provisioner,
    build: createDemoBuild({ pause }),
    seed: createDemoSeed({ pause }),
    envTransform: demoEnvTransform,
    auth: demoAuth,
    // a core older than the data checks (#8) ignores it
    inspector: createDemoInspector(),
  }
  const conductor = startConductor({
    cfg,
    github,
    fsx: { readFile: p => fs.promises.readFile(p) },
    adapters,
    readBaseEnv: async () => ({ APP_NAME: 'widgets', MAIL: 'smtp://mail.internal:587' }),
    log,
  })
  const { harness, baseProxy, prProxy } = conductor.servers
  const servers = [harness, baseProxy, prProxy]
  const listening = servers.map(whenListening)

  try {
    await Promise.all(listening)
    await moveToLoopback(servers, s => (s === harness ? port : 0))
  } catch (err) {
    life.abort()
    closeServers(servers)
    conductor.stop() // clears the idle reaper
    throw err
  }
  // Attached now, so stop() can wait for closes the core itself starts.
  const serversClosed = Promise.all(servers.map(s => new Promise(resolve => s.once('close', resolve))))

  const ports = { harness: harness.address().port, base: baseProxy.address().port, pr: prProxy.address().port }
  // In place, so any holder of the paneOrigins object sees the real ports.
  cfg.paneOrigins.base = `http://${DEMO_HOST}:${ports.base}`
  cfg.paneOrigins.pr = `http://${DEMO_HOST}:${ports.pr}`
  log.log(`[demo] harness: http://${DEMO_HOST}:${ports.harness}/  (pane proxies on :${ports.base} and :${ports.pr}, speed ${speed})`)

  let stopping = null
  async function shutdown() {
    life.abort()
    try {
      // 0.2 cores tear the session down and close their servers in shutdown();
      // older ones only have stop(), which does neither fully.
      if (typeof conductor.shutdown === 'function') await conductor.shutdown()
      else conductor.stop()
    } finally {
      closeServers(servers)
      await serversClosed
      await provisioner.close()
    }
    log.log('[demo] stopped')
  }

  return {
    ports,
    stop() {
      stopping ??= shutdown()
      return stopping
    },
  }
}
