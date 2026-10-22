// The Docker Provisioner's internal network (#32) on a real container
// runtime, not the fake `docker` the unit tests use. CI's docker-integration
// job runs it on Linux, against Docker Engine and against Podman.
//
// It creates and removes the qa-* containers and networks on the runtime's
// host, builds a small app image, and pulls postgres:16, node:22-alpine and
// busybox. So it runs only when asked: QA_DOCKER_IT=1. Asked, it fails
// rather than skips when the runtime doesn't answer. QA_DOCKER_IT_CLI names
// the command to drive, words split on spaces (default `docker`). CI's
// Podman leg drives the docker CLI against Podman's Docker-compatible
// socket, so `docker version` names Podman, as for any Podman user of this
// Provisioner who points the docker CLI there.
//
// Run it only where no conductor is running: the container names are fixed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDocker } from '../../lib/docker.mjs'
import { makeExecFileFn } from '../../lib/exec.mjs'
import { createDockerProvisioner, dockerEngineMajor } from '../../lib/adapters/provisioner-docker.mjs'
import { startConductor } from '../../lib/server.mjs'
import { createCapability } from '../../lib/capability.mjs'

const ASKED = process.env.QA_DOCKER_IT === '1'
const [CLI, ...CLI_ARGS] = (process.env.QA_DOCKER_IT_CLI || 'docker').split(' ').filter(Boolean)
const APP_IMAGE = 'qa-it-app:local'
const FALLBACK_IMAGE = 'busybox:1.36'
const LONG = { timeout: 15 * 60_000 }

// The provisioner's `docker` calls, through the CLI asked for.
const base = makeExecFileFn()
const execFileFn = (cmd, args, opts) => base(cmd === 'docker' ? CLI : cmd, cmd === 'docker' ? [...CLI_ARGS, ...args] : args, opts)
const cli = async (...args) => (await execFileFn('docker', args, { timeout: 5 * 60_000 })).stdout
// A command's exit, not its output: true when it succeeded.
const succeeds = (...args) => cli(...args).then(() => true, () => false)

const version = await cli('version').then(out => out, err => err)
const answers = typeof version === 'string'
const PODMAN = answers && /podman/i.test(version)
// Docker Engine 28 and later: the PR pane's internal network has an
// isolated gateway, so the host's 0.0.0.0 services aren't reachable either
const ISOLATED_GATEWAY = answers && (dockerEngineMajor(version) ?? 0) >= 28
const firstLine = err => String(err?.message ?? err).split('\n')[0]
const skip = ASKED
  ? false
  : `QA_DOCKER_IT=1 isn't set${answers ? '' : `, and no container runtime answers here (\`${[CLI, ...CLI_ARGS].join(' ')} version\`: ${firstLine(version)})`}: this test creates and removes the qa-* containers and networks on the runtime's host, so it runs only when asked (CI's docker-integration job asks)`

const quiet = { log() {}, error() {}, warn() {} }
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

// A small app: /api/health answers 200, anything else its role.
async function buildApp(dir) {
  writeFileSync(path.join(dir, 'server.mjs'), [
    "import http from 'node:http'",
    "http.createServer((req, res) => res.end(req.url === '/api/health' ? 'ok' : `app ${process.env.ROLE}`)).listen(3000, '0.0.0.0')",
    '',
  ].join('\n'))
  writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22-alpine\nCOPY server.mjs /server.mjs\nCMD ["node", "/server.mjs"]\n')
  await cli('build', '-q', '-t', APP_IMAGE, dir)
}

// What the runtime still has of the conductor: labelled containers, and the
// panes' networks.
async function leftovers() {
  const containers = (await cli('ps', '-aq', '--filter', 'label=qa-conductor-session')).split('\n').filter(Boolean)
  const networks = (await cli('network', 'ls', '--format', '{{.Name}}')).split('\n').filter(name => /^qa-session-(base|pr|pr-edge)$/.test(name.trim()))
  return { containers, networks }
}

// A command run in the PR (or base) pane's app container, as PR code would.
// `direct` drops the proxy env the PR pane gets, so it tests the network,
// not the forwarder's refusals.
const NO_PROXY_ENV = 'unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY;'
const inPane = (role, ...args) => succeeds('exec', `qa-app-${role}`, ...args)
const direct = (role, command) => succeeds('exec', `qa-app-${role}`, 'sh', '-c', `${NO_PROXY_ENV} ${command}`)
const outOf = (role, ...args) => cli('exec', `qa-app-${role}`, ...args)

// A raw CONNECT through the forwarder's proxy, from inside the PR pane: the
// status line and X-QA-Egress, or the error.
const connectVia = target => outOf('pr', 'node', '-e', `
const s = require('net').connect(3128, 'qa-egress', () => s.write('CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n'))
let head = ''
s.setTimeout(15000, () => { console.log('timeout'); s.destroy() })
s.on('data', d => { head += d; if (head.includes('\\r\\n\\r\\n')) { console.log(head.split('\\r\\n')[0] + ' | ' + ((/x-qa-egress: *(\\w+)/i.exec(head) || [])[1] || '-')); s.destroy() } })
s.on('error', e => console.log('error ' + e.code))
`).then(out => out.trim())

const gatewayOf = async network => (await cli('network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}', network)).trim().split(/\s+/).filter(Boolean)

test('a real runtime answers', { skip }, () => {
  assert.equal(answers, true, `QA_DOCKER_IT=1, but \`${[CLI, ...CLI_ARGS].join(' ')} version\` failed: ${firstLine(version)}`)
})

test('the internal network on a real runtime: isolated, nothing out of the PR pane but through the allowlist, and nothing left after', { skip, ...LONG }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa-it-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await buildApp(dir)
  // Two canaries on the host. One on its loopback, as the conductor listens
  // by default: the PR pane must not reach it. One on every address, as a
  // conductor off loopback listens: whether the PR pane reaches it is
  // found out directly, and the probe must say the same.
  const canaryOn = async (address, name) => {
    const canary = { path: `/__qa/canary/${name}`, expect: `qa-canary ${name}` }
    const server = http.createServer((req, res) => res.end(req.url === canary.path ? canary.expect : 'not the canary'))
    await new Promise(resolve => server.listen(0, address, resolve))
    t.after(() => server.close())
    return { ...canary, port: server.address().port }
  }
  const canary = await canaryOn('127.0.0.1', 'loopback')
  const wide = await canaryOn('0.0.0.0', 'wide')
  const hostPorts = { base: await freePort(), pr: await freePort() }
  const docker = createDocker({ execFileFn })
  const provisioner = createDockerProvisioner({ docker, fsx: fs, workDir: dir, hostPorts, internal: { egress: ['1.1.1.1:443'] }, log: quiet })
  const signal = new AbortController().signal
  // A sweep on a clean host succeeds: "not found" is no failure, whatever
  // the CLI adds after it (the runners' docker CLI adds "exit status 1")
  await provisioner.sweep()
  await provisioner.sweep()
  assert.deepEqual(await leftovers(), { containers: [], networks: [] })
  t.after(async () => {
    for (const role of ['base', 'pr']) await provisioner.teardown({ paneRef: { role } }).catch(() => {})
    await provisioner.sweep().catch(() => {})
  })

  // The boot, as the core runs it: both databases, the check, then the apps.
  for (const role of ['base', 'pr']) await provisioner.provisionDatabase({ paneRef: { role }, databases: ['it'], signal })
  const verdict = await provisioner.isolation({ signal, canary })
  assert.deepEqual(verdict, { verdict: 'isolated', reasons: [], internal: true })
  for (const role of ['base', 'pr']) {
    const services = { app: APP_IMAGE }
    const reserved = await provisioner.reserveServices({ paneRef: { role }, services })
    await provisioner.launchServices({ paneRef: { role }, services, env: { app: { ROLE: role } }, reserved, signal })
    await provisioner.waitHealthy({ services: reserved })
  }
  // the PR app, on the host's loopback, through the forwarder
  const health = await fetch(`http://127.0.0.1:${hostPorts.pr}/`).then(r => r.text())
  assert.equal(health, 'app pr')
  // the leftovers check's positive control: it sees the panes while they're up
  const up = await leftovers()
  assert.ok(up.containers.length >= 5, `the labelled containers: ${up.containers.join(', ')}`)
  assert.deepEqual([...up.networks].sort(), ['qa-session-base', 'qa-session-pr', 'qa-session-pr-edge'])
  // the gateway mode the runtime gave the internal network
  const gatewayMode = PODMAN ? '' : (await cli('network', 'inspect', '--format', '{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}', 'qa-session-pr')).trim()
  t.diagnostic(`docker version says Engine ${dockerEngineMajor(version) ?? 'none'}; the internal network's IPv4 gateway mode: ${gatewayMode || 'unset'}`)
  assert.equal(gatewayMode === 'isolated', ISOLATED_GATEWAY)

  // The host's loopback, at every gateway: the PR pane gets nothing.
  const prGateways = await gatewayOf('qa-session-pr')
  const gateways = [...new Set([...await gatewayOf('qa-session-base'), ...prGateways, ...(PODMAN ? [] : ['172.17.0.1'])])]
  const fetchIn = (role, ip, c) => direct(role, `wget -q -T 3 -O - http://${ip}:${c.port}${c.path}`)
  for (const ip of gateways) assert.equal(await fetchIn('pr', ip, canary), false, `the PR pane reached the host's loopback at ${ip}`)

  // A host service on every address (0.0.0.0). The base pane reaches it
  // (the method works). On Docker Engine 28 and later the PR pane's
  // internal network has an isolated gateway, so the PR pane reaches it
  // nowhere, and the probe says isolated. Elsewhere (Podman, older Engines)
  // the bridge keeps the host's address: the PR pane reaches it there, at
  // its own network's gateway and nowhere else, and the probe must find it
  // and name it.
  const [baseGateway] = await gatewayOf('qa-session-base')
  assert.equal(await fetchIn('base', baseGateway, wide), true, `the control: the base pane reaches the host's every-address canary at ${baseGateway}`)
  const reached = []
  for (const ip of gateways) if (await fetchIn('pr', ip, wide)) reached.push(ip)
  const wideVerdict = await provisioner.isolation({ signal, canary: wide })
  t.diagnostic(`a host service on every address, from the PR pane: reached at ${reached.join(', ') || 'none'}; the probe says ${wideVerdict.verdict}`)
  if (ISOLATED_GATEWAY) {
    assert.deepEqual(reached, [], 'the isolated gateway: no host address to reach')
    assert.deepEqual(wideVerdict, { verdict: 'isolated', reasons: [], internal: true })
  } else {
    assert.ok(reached.length > 0 && reached.every(ip => prGateways.includes(ip)), `the PR pane reached the every-address canary at its own gateway (${prGateways.join(', ')}) only: ${reached.join(', ') || 'nowhere'}`)
    assert.equal(wideVerdict.verdict, 'reachable', JSON.stringify(wideVerdict))
    assert.equal(wideVerdict.internal, true)
    assert.ok(reached.some(ip => wideVerdict.reasons.some(r => r.includes(`${ip}:${wide.port}`))), JSON.stringify(wideVerdict.reasons))
  }
  // and with only loopback listeners, as the conductor binds by default, it
  // is isolated again
  assert.deepEqual(await provisioner.isolation({ signal, canary }), { verdict: 'isolated', reasons: [], internal: true })

  // The base pane's database: the base app reaches it, the PR app doesn't.
  const baseDb = (await cli('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', 'qa-pg-base')).trim().split(/\s+/).filter(Boolean)
  assert.ok(baseDb.length > 0)
  assert.equal(await inPane('base', 'nc', '-z', '-w', '3', 'qa-pg-base', '5432'), true, 'the control: the base app reaches its database')
  for (const ip of baseDb) assert.equal(await inPane('pr', 'nc', '-z', '-w', '3', ip, '5432'), false, `the PR pane reached the base database at ${ip}`)

  // No direct route out: a public address the base pane reaches (the
  // control) the PR pane doesn't, over IPv4, and over IPv6 where the
  // runner has it
  assert.equal(await inPane('base', 'nc', '-z', '-w', '3', '1.1.1.1', '443'), true, 'the control: the base pane reaches 1.1.1.1:443 directly')
  assert.equal(await inPane('pr', 'nc', '-z', '-w', '3', '1.1.1.1', '443'), false, 'the PR pane reached 1.1.1.1:443 directly')
  if (await inPane('base', 'nc', '-z', '-w', '3', '2606:4700:4700::1111', '443')) {
    assert.equal(await inPane('pr', 'nc', '-z', '-w', '3', '2606:4700:4700::1111', '443'), false, 'the PR pane reached [2606:4700:4700::1111]:443 directly')
  } else t.diagnostic('no IPv6 route from the base pane: the IPv6 direct check proves nothing here')

  // Cloud metadata, directly, with the base pane as its control
  if (await inPane('base', 'nc', '-z', '-w', '3', '169.254.169.254', '80')) {
    assert.equal(await inPane('pr', 'nc', '-z', '-w', '3', '169.254.169.254', '80'), false, 'the PR pane reached 169.254.169.254:80')
  } else t.diagnostic('169.254.169.254:80 is out of the base pane\'s reach too: the metadata check proves nothing here')

  // DNS, as the app's own resolver does it: the names the pane needs
  // resolve, outside names don't
  const lookup = name => outOf('pr', 'node', '-e', `require('dns').lookup(${JSON.stringify(name)}, (e, a) => console.log(e ? 'error ' + e.code : 'address ' + a))`).then(out => out.trim())
  for (const name of ['qa-egress', 'qa-pg-pr']) assert.match(await lookup(name), /^address /, `${name} resolves in the PR pane`)
  const outside = await lookup('example.com')
  assert.match(outside, /^error /, `an outside name resolved from the PR pane: ${outside}`)
  // and as nslookup asks the configured server directly
  const asked = await outOf('pr', 'sh', '-c', 'nslookup example.com 2>&1; true')
  assert.match(asked, /Server:|timed out|no servers could be reached/i, `nslookup ran:\n${asked}`)
  assert.doesNotMatch(asked, /Name:\s+example\.com/, `nslookup resolved an outside name from the PR pane:\n${asked}`)
  assert.equal((await cli('inspect', '--format', '{{json .HostConfig.Dns}}', 'qa-app-pr')).trim(), '["192.0.2.1"]')
  // On Podman a --dns replaces its own DNS, so the names the pane needs are
  // in its hosts file
  if (PODMAN) {
    const extra = JSON.parse(await cli('inspect', '--format', '{{json .HostConfig.ExtraHosts}}', 'qa-app-pr'))
    for (const name of ['qa-pg-pr', 'qa-egress']) assert.ok(extra.some(entry => entry.startsWith(`${name}:`)), `${name} in ${JSON.stringify(extra)}`)
  }

  // The proxy: a host off the list, and metadata, are refused; a listed
  // address is let through (200 with the internet, as CI has, 502 `failed`
  // without).
  assert.equal(await connectVia('example.com:443'), 'HTTP/1.1 403 Forbidden | refused')
  assert.equal(await connectVia('169.254.169.254:80'), 'HTTP/1.1 403 Forbidden | refused')
  const listed = await connectVia('1.1.1.1:443')
  t.diagnostic(`the listed address through the proxy: ${listed}`)
  assert.match(listed, process.env.CI === 'true' ? /^HTTP\/1\.1 200 Connection Established \| -$/ : /^HTTP\/1\.1 (200 Connection Established \| -|502 Bad Gateway \| failed)$/, listed)

  // Teardown leaves nothing, before any sweep; and the sweep after it is fine.
  for (const role of ['base', 'pr']) await provisioner.teardown({ paneRef: { role } })
  assert.deepEqual(await leftovers(), { containers: [], networks: [] })
  await provisioner.sweep()
  assert.deepEqual(await leftovers(), { containers: [], networks: [] })
})

test('a topology that can\'t be set up falls back, and QA_REQUIRE_ISOLATION=1 refuses the session: never better than unknown, egress not restricted', { skip, ...LONG }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa-it-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await buildApp(dir)
  await cli('pull', '-q', FALLBACK_IMAGE)
  const docker = createDocker({ execFileFn })
  // An image with no node: the forwarder can't start, so the topology falls back.
  const provisioner = createDockerProvisioner({ docker, fsx: fs, workDir: dir, hostPorts: { base: await freePort(), pr: await freePort() }, internal: { image: FALLBACK_IMAGE }, log: quiet })
  const capability = createCapability()
  const token = capability.enrol()
  const conductor = startConductor({
    cfg: {
      publicHost: 'h.ts.net', operatorEmail: 'op@example.com', idleMinutes: 30, ports: { harness: 0, base: 0, pr: 0 },
      paneOrigins: { base: 'https://h.ts.net:8443', pr: 'https://h.ts.net:10000' }, verdictLabels: { accept: 'ok', reject: 'nope' },
      exposure: 'none', requireIsolation: true,
    },
    github: { listOpenPrs: async () => [{ number: 7, title: 't', headRef: 'r', author: 'a', headSha: 'abc' }], prHead: async () => 'abc', postComment: async () => 'https://c', setQaLabel: async () => {} },
    fsx: { readFile: async () => 'x' },
    adapters: {
      provisioner,
      build: { migrationStrategy: 'on-boot', ensureBuilt: async () => {}, resolveBaseImages: async () => ({ services: { app: APP_IMAGE }, migrate: null }), resolvePrImages: async () => ({ services: { app: APP_IMAGE }, migrate: null }) },
      seed: { databases: ['it'], seedPane: async () => {} },
      envTransform: { derivePaneEnv: () => ({ app: {} }) },
      auth: { requiresDb: false, establishSession: async ({ pane }) => ({ landingUrl: `login-${pane.ref.role}`, cookies: [] }) },
    },
    readBaseEnv: async () => ({}),
    log: quiet,
    platform: 'linux',
    capability,
  })
  t.after(async () => {
    conductor.stop()
    for (const role of ['base', 'pr']) await provisioner.teardown({ paneRef: { role } }).catch(() => {})
    await provisioner.sweep().catch(() => {})
  })
  const harness = conductor.servers.harness
  if (!harness.listening) await new Promise(resolve => harness.once('listening', resolve))
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${harness.address().port}${p}`, {
      method,
      headers: { 'x-qa-cap': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.json()
  }
  await api('POST', '/api/session', { pr: 7 })
  let state
  for (const end = Date.now() + 10 * 60_000; Date.now() < end;) {
    state = await api('GET', '/api/state')
    if (state.status === 'error' || state.status === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  assert.equal(state.status, 'error', JSON.stringify(state.error ?? state.status))
  // never better than unknown: on Podman, whose networks don't keep the panes
  // apart, it is reachable
  const want = PODMAN ? 'reachable' : 'unknown'
  assert.match(state.error.message, new RegExp(`^QA_REQUIRE_ISOLATION=1 refuses a session whose PR pane isn't isolated from the base pane \\(${want}: .*egress isn't restricted: the PR pane's internal network couldn't be set up \\(`))
  assert.equal(state.isolation.verdict, want)
  await api('POST', '/api/teardown', {})
  for (const role of ['base', 'pr']) await provisioner.teardown({ paneRef: { role } })
  await provisioner.sweep()
  assert.deepEqual(await leftovers(), { containers: [], networks: [] })
})
