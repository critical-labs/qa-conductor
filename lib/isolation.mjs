// The per-session isolation verdict: whether the PR pane can reach the base
// pane, so a base-vs-PR comparison (#8) knows whether the base pane shows only
// what the base did. Pure: the conductor (lib/server.mjs) gathers the parts.
//
// A verdict is one of VERDICTS, best to worst:
// - isolated: the Provisioner's check found no way from the PR pane to the
//   base pane, and nothing about the runtime says otherwise;
// - unknown: nothing could tell, or a check failed;
// - reachable: the PR pane can reach the base pane's containers or ports;
// - shared-host: both panes run as one user on one host (the process
//   Provisioner): there is nothing to check.
// Only `isolated` lets the base pane's changes excuse a PR change.

import { isLoopbackHost } from './net.mjs'

export const VERDICTS = ['isolated', 'unknown', 'reachable', 'shared-host']

// What the runtime says before any check: never better than these, whatever
// a check finds. `host` is the address the conductor listens on (default
// 127.0.0.1), `platform` process.platform's value. `containers: false` (a
// Provisioner that runs none) leaves out what only containers' VMs say, and
// so does `internal: true` (#32): the PR pane is on a network with no route
// off itself, and the check's probe speaks for the VM's forwarding.
export function floors({ host = '127.0.0.1', platform, containers = true, internal = false }) {
  const out = []
  if (platform === 'darwin' && containers && internal !== true) {
    out.push({
      verdict: 'reachable',
      reason: 'on macOS, containers run in a VM that forwards the host\'s loopback (Docker Desktop, Podman machine), where the base app is published',
    })
  }
  if (!isLoopbackHost(host)) {
    out.push({ verdict: 'reachable', reason: `the conductor listens on ${host}, which containers can reach` })
  } else if (host !== '127.0.0.1') {
    // A probe reaches the conductor to show it reaches the host's loopback;
    // the Docker Provisioner publishes the pane apps on 127.0.0.1, and a
    // runtime may forward that address alone, so a probe that misses the
    // conductor on any other loopback address (127.0.0.2, ::1) proves
    // nothing about them.
    out.push({
      verdict: 'unknown',
      reason: `the conductor listens on ${host}, not on 127.0.0.1 where the pane apps are published, so a probe of it can't speak for their ports`,
    })
  }
  return out
}

// A Provisioner's `isolation` member, before anything runs: 'shared-host'
// declares the verdict, a function is a check still to run (null), and
// anything else, none included, leaves it unknown.
export function declared(provisioner) {
  const isolation = provisioner?.isolation
  if (typeof isolation === 'function') return null
  if (isolation === 'shared-host') return { verdict: 'shared-host', reasons: ['both panes run as one user on this host'] }
  if (isolation === undefined || isolation === null) return { verdict: 'unknown', reasons: ['the Provisioner has no isolation check'] }
  return { verdict: 'unknown', reasons: [`the Provisioner declares isolation ${JSON.stringify(isolation)}, which only a check can show`] }
}

// A BuildConvention's `isolation`: 'shared-host' when it runs the PR's code
// on this host to build it (an install step, before any check can run); else
// none (null). Any other value is unknown: only that one means something.
export function declaredBuild(build) {
  const isolation = build?.isolation
  if (isolation === undefined || isolation === null) return null
  if (isolation === 'shared-host') return { verdict: 'shared-host', reasons: ['the BuildConvention runs the PR\'s code on this host to build it (an install step)'] }
  return { verdict: 'unknown', reasons: [`the BuildConvention declares isolation ${JSON.stringify(isolation)}; only "shared-host" means something there`] }
}

// A check's result as { verdict, reasons }: one of VERDICTS, with its string
// reasons. Anything else is unknown, and a verdict other than isolated with
// no reason gets one.
export function fromCheck(result) {
  const verdict = result?.verdict
  if (!VERDICTS.includes(verdict)) return { verdict: 'unknown', reasons: ['the isolation check gave no verdict'] }
  const reasons = Array.isArray(result.reasons) ? result.reasons.filter(reason => typeof reason === 'string') : []
  if (verdict !== 'isolated' && reasons.length === 0) return { verdict, reasons: ['the isolation check gave no reason'] }
  return { verdict, reasons: verdict === 'isolated' ? [] : reasons }
}

// The worst of these parts, each { verdict, reasons } or a floor's
// { verdict, reason }, with every reason given against isolation. It fails
// closed: no part, or a verdict it doesn't know, is never isolated.
export function combine(parts) {
  if (parts.length === 0) return { verdict: 'unknown', reasons: ['nothing said whether the PR pane is isolated'] }
  const UNKNOWN = VERDICTS.indexOf('unknown')
  let rank = 0
  const reasons = []
  for (const part of parts) {
    const known = VERDICTS.indexOf(part.verdict)
    rank = Math.max(rank, known === -1 ? UNKNOWN : known)
    if (part.verdict === 'isolated') continue
    const given = (part.reasons ?? [part.reason]).filter(reason => typeof reason === 'string' && reason)
    reasons.push(...(given.length || known !== -1 ? given : [`a part gave the verdict ${JSON.stringify(part.verdict)}`]))
  }
  return { verdict: VERDICTS[rank], reasons }
}
