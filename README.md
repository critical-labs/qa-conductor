# qa-conductor

A side-by-side PR-QA harness. For a pull request it boots two copies of your app: **base** (what's live now) and **PR** (the branch). Each runs against its own clone of real data, behind proxies that mirror scrolling and navigation between the two panes. A reviewer drives both at once and posts a verdict (a comment plus a label) back to the PR.

The conductor owns the choreography: session state, cancellation, the harness UI and API, the pane proxies and the verdict. Everything about *your* app and infrastructure comes from five adapters you supply, plus an optional sixth, [Exposure](#exposure-optional), through which the conductor publishes itself on a front door such as `tailscale serve`.

> **Status: 0.x.** The interface may still change: a 0.x minor version may break it, and so may a patch release when a fix needs to. Read the migration notes in [CHANGELOG.md](CHANGELOG.md) before upgrading, and to choose when that happens, install with `--save-exact`: the `^` range npm saves by default takes patch releases.

## Contents

- [Try it](#try-it), [Requirements](#requirements), [Install](#install)
- [Quickstart: QA your own app](#quickstart-qa-your-own-app)
- [Use](#use), with the [Entry points](#entry-points)
- [Using the harness](#using-the-harness)
- [Security](#security)
- [The seams](#the-seams): [Types](#types), [Contracts](#contracts-between-the-seams), the built-in [`build-worktree`](#built-in-adaptersbuild-worktree-git-worktree-buildconvention), [`provisioner-process`](#built-in-adaptersprovisioner-process-process-provisioner) and [`provisioner-docker`](#built-in-adaptersprovisioner-docker-docker-provisioner), the [Effect wrappers](#effect-wrappers), and [Exposure](#exposure-optional)
- [Configuration](#configuration): [The env file](#the-env-file), [Sample `.env.qa` files](#sample-envqa-files), [Tokens](#tokens), [Keys](#keys), [A `cfg` built in code](#a-cfg-built-in-code)
- [HTTP API](#http-api-harness-port), [Expose CLI](#expose-cli), [Demo](#demo)
- [Known limits](#known-limits)
- [Contributing](#contributing), [Reporting a vulnerability](#reporting-a-vulnerability), [License](#license)

## Try it

```sh
git clone https://github.com/critical-labs/qa-conductor
cd qa-conductor
npm run demo        # then open http://127.0.0.1:4100/
```

The demo runs the real conductor against fixture PRs and fake adapters, so it needs nothing but Node: no GitHub token, containers or databases. `demo/` is in the repository, not in the npm package. More in [Demo](#demo).

## Requirements

- **Node 22 or later.** The package has no runtime dependencies.
- **Linux or macOS.** Windows isn't supported: the process Provisioner signals process groups and reads `ps`, and the Docker one runs `sh`.
- **The tools each built-in adapter runs**, on the conductor's `PATH`:
  - `adapters/build-worktree`: `git`, with worktree support;
  - `adapters/provisioner-process`: `ps`, and to tell one boot of the machine from the next, `/proc/sys/kernel/random/boot_id` on Linux or `sysctl` on macOS;
  - `adapters/provisioner-docker` and `./docker`: the `docker` CLI and `sh`, and a Docker daemon the conductor's user may use;
  - `adapters/exposure-tailscale` and the [expose CLI](#expose-cli): a `tailscale` CLI no older than the daemon (on macOS, the app's bundled one), run by a user the daemon lets change `tailscale serve` (on Linux, root or the user `tailscale set --operator` names).
- **No TypeScript declarations yet.** The package is plain JavaScript (ES modules); the [Types](#types) below describe what the adapters exchange.

## Install

```sh
npm install @critical-labs/qa-conductor
```

To pin a git tag instead: `npm install github:critical-labs/qa-conductor#v0.3.1`.

## Quickstart: QA your own app

This script is a whole conductor for an app that runs from a checkout with one `node` command and needs no database. It QAs `acme/widget`'s pull requests on this machine: each pane is a git worktree, `main` and the PR head, running `node server.js` on a port of its own. It is this repository's own self-QA, [`qa/self.mjs`](qa/self.mjs), cut down.

1. Create `.env.qa` beside it, readable by you alone, since it holds a token, and keep it out of git:
   ```sh
   (umask 077 && touch .env.qa)
   echo .env.qa >> .gitignore
   ```
   Then put in it a GitHub token for the repository (see [Tokens](#tokens)) and the repository's name:
   ```
   GITHUB_QA_TOKEN=<token>
   QA_REPO=acme/widget
   ```
2. Save this as `qa.mjs`:
   ```js
   import fs from 'node:fs'
   import os from 'node:os'
   import path from 'node:path'
   import { startConductor } from '@critical-labs/qa-conductor'
   import { loadConfig } from '@critical-labs/qa-conductor/config'
   import { createGithub } from '@critical-labs/qa-conductor/github'
   import { createWorktreeBuild } from '@critical-labs/qa-conductor/adapters/build-worktree'
   import { createProcessProvisioner } from '@critical-labs/qa-conductor/adapters/provisioner-process'

   // Panes on loopback: nothing outside this machine reaches them, so no identity gate.
   const cfg = loadConfig('.env.qa', {
     defaults: { QA_BASE_ORIGIN: 'http://127.0.0.1:3101', QA_PR_ORIGIN: 'http://127.0.0.1:3102' },
   })
   const github = createGithub({ token: cfg.githubToken, repo: cfg.repo, qaLabels: [cfg.verdictLabels.accept, cfg.verdictLabels.reject] })
   const cacheDir = path.join(os.homedir(), '.cache/qa-conductor', cfg.repo.replace('/', '-'))

   const conductor = startConductor({
     cfg,
     github,
     fsx: { readFile: p => fs.promises.readFile(p) },
     adapters: {
       // main and each PR head in a git worktree, a PR only once it passes the trust gate
       build: createWorktreeBuild({
         repo: cfg.repo,
         cacheDir: path.join(cacheDir, 'build'),
         github,
         servicesFor: dir => ({ app: dir }),
         install: { cmd: 'npm', args: ['ci', '--ignore-scripts'] },
       }),
       // `node server.js` in each worktree, as a process group on 127.0.0.1
       provisioner: createProcessProvisioner({
         stateDir: path.join(cacheDir, 'state'),
         command: ({ ref }) => ({ cmd: process.execPath, args: ['server.js'], cwd: ref }),
       }),
       seed: { databases: [], seedPane: async () => {} },
       envTransform: { derivePaneEnv: ({ pane }) => ({ app: { PORT: String(pane.services.app.port) } }) },
       auth: { requiresDb: false, establishSession: async ({ pane }) => ({ landingUrl: `${pane.publicOrigin}/` }) },
     },
   })

   for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
     process.on(sig, () => conductor.shutdown().then(() => process.exit(0)))
   }
   ```
3. Run `npm install @critical-labs/qa-conductor` beside it, then `node qa.mjs`, open `http://127.0.0.1:3100/qa/`, and open a PR. Ctrl-C tears both panes down.

What the pieces do, and what to change for your app:
- **The trust gate.** A PR boots only when its author has write access to the repository and its head is in the repository or the author's own fork, since booting it runs its code as you. See [`adapters/build-worktree`](#built-in-adaptersbuild-worktree-git-worktree-buildconvention).
- **Install and launch.** The install runs with `--ignore-scripts`. The server must be started directly, not through `npm run` or `npx` (the [launch contract](#built-in-adaptersprovisioner-process-process-provisioner)), and must listen on the `PORT` the EnvTransform gives it, on `127.0.0.1`. It counts as up once `/` answers below `500`.
- **No data, no sign-in.** The Seed clones nothing and the AuthBootstrap lands each pane on `/`. To give each pane its own copy of a database, pass the Provisioner a `database` and write a `seedPane`; to sign the reviewer in, return a sign-in URL from `establishSession`. [The seams](#the-seams) has the contracts.
- **Other devices.** To open the harness from another machine, read [Security](#security), then [Configuration](#configuration)'s tailnet sample.

## Use

```js
import fs from 'node:fs'
import { startConductor } from '@critical-labs/qa-conductor'
import { loadConfig } from '@critical-labs/qa-conductor/config'
import { createGithub } from '@critical-labs/qa-conductor/github'

const cfg = loadConfig('/path/to/.env.qa', { defaults: { QA_REPO: 'acme/widget' } })
const github = createGithub({ token: cfg.githubToken, repo: cfg.repo, qaLabels: [cfg.verdictLabels.accept, cfg.verdictLabels.reject] })

const conductor = startConductor({
  cfg,
  github,
  fsx: { readFile: p => fs.promises.readFile(p) },   // serves the harness UI files
  adapters: { provisioner, build, seed, envTransform, auth },   // and optionally exposure
  readBaseEnv: async () => ({ /* the env the pane env is derived from */ }),
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => conductor.shutdown().then(() => process.exit(0)))
}
```

`startConductor` takes:

| Option | Default | |
|---|---|---|
| `cfg` | *(required)* | the configuration, from `loadConfig` or built in code (see [Configuration](#configuration)) |
| `github` | *(required)* | what the core calls on GitHub: `createGithub(...)`, or anything with the [members the core uses](#effect-wrappers) |
| `fsx` | *(required)* | `{ readFile(path) }`, which serves the harness UI files from `publicDir` |
| `adapters` | *(required)* | `{ provisioner, build, seed, envTransform, auth }`, plus `exposure` if you want one ([The seams](#the-seams)) |
| `readBaseEnv` | `async () => ({})` | the env the panes' env is derived from, such as production's: passed to `derivePaneEnv` as `prodEnv` at each boot |
| `publicDir` | the package's `public/` | the directory with the harness UI's `index.html` and `harness.js` and the panes' `bridge.js` |
| `log` | `console` | where the `[qa]` lines go: `log.log` and `log.error` |

It serves the harness on `cfg.ports.harness` and one proxy per pane on `cfg.ports.base` / `cfg.ports.pr`, all on `cfg.host` (**`127.0.0.1` by default**). It returns `{ servers, stop(), shutdown(), exposure }`:
- `shutdown()` is the graceful exit. It stops the idle reaper and the [exposure loop](#exposure-optional), refuses harness writes from then on (`503`, so no new boot can start), tears the session down (aborting an in-flight boot and tearing down both panes), ends the progress streams, closes every connection and resolves once all three servers are closed. Call it from your signal handlers; calling it again is a no-op.
- `stop()` only stops the reaper and the exposure loop, and asks the servers to close.
- `exposure` is the exposure loop's handle, `{ ready, state(), reconcile() }`. `ready` resolves with the state after the first pass, or as it stands when `stop()` or `shutdown()` begins first (at once with no Exposure adapter). `state()` is the last pass, as `GET /api/exposure` reports it. `reconcile()` runs a pass now, or joins the one in flight; before all three servers listen there are no targets to mount yet, so it returns `ready`.

`cfg.paneOrigins` must be the URLs viewers actually reach the panes at, and `cfg.harnessOrigin` the one they open the harness at (see [Configuration](#configuration)). To reach the harness from anywhere but the machine it runs on, read [Security](#security) first, then either:
- put `tailscale serve --https` on the same host in front of these ports, in tailscale mode (`QA_EXPOSURE=tailscale`, the default for any layout that isn't loopback throughout): every server then answers only the Tailscale logins in `QA_ALLOWED_LOGINS`, and listens on loopback. Pass an [Exposure adapter](#exposure-optional) and the conductor sets up and keeps those mounts itself; or
- put another TLS front door that authenticates viewers in front of them, and set `QA_EXPOSURE=none`.

### Entry points

| Import | Exports | |
|---|---|---|
| `@critical-labs/qa-conductor` | `startConductor` | the conductor: harness, pane proxies, sessions, the exposure loop ([Use](#use)) |
| `@critical-labs/qa-conductor/config` | `loadConfig`, `parseEnvFile`, `defaultExposure`, `defaultHarnessOrigin`, `isExposureInterval`, `EXPOSURE_MODES`, `EXPOSURE_INTERVAL_RULE`, `MAX_EXPOSURE_INTERVAL_MINUTES`, `HARNESS_PATH` | reading `.env.qa` into `cfg` ([Configuration](#configuration)), and the rules it checks |
| `@critical-labs/qa-conductor/session` | `bootSession`, `teardownSession`, `createSession`, `reduce`, `touch`, `isIdle`, `ROLES`, `PANE_STAGES`, `parseEnv`, `renderEnv`, `migrateImageFor` | the boot sequence and session state the conductor runs, and helpers for adapters: parsing and rendering env file text, and the `migrate-<tag>` image beside an app image |
| `@critical-labs/qa-conductor/github` | `createGithub` | the GitHub [effect wrapper](#effect-wrappers) |
| `@critical-labs/qa-conductor/docker` | `createDocker` | the Docker [effect wrapper](#effect-wrappers) |
| `@critical-labs/qa-conductor/exec` | `makeExecFileFn` | the `execFile` [effect wrapper](#effect-wrappers) |
| `@critical-labs/qa-conductor/identity` | `normalizeLogins`, `refusalReason`, `isAllowed`, `identityGate`, `isIdentityRefusal` | the [Tailscale identity gate](#security) |
| `@critical-labs/qa-conductor/exposure` | `mountsFor`, `reconcileExposure`, `runExpose` | one [exposure](#exposure-optional) pass, outside a conductor |
| `@critical-labs/qa-conductor/proxy` | `createPaneProxy`, `panePolicy`, `parseSetCookie`, `isAllowedHost`, `requestHostname`, `misdirected` | the pane proxy, and the [Host allowlist](#security) check every server runs |
| `@critical-labs/qa-conductor/verdict` | `formatVerdict`, `postVerdict` | the verdict comment and label |
| `@critical-labs/qa-conductor/adapters/provisioner-docker` | `createDockerProvisioner` | a Provisioner that runs each pane as containers on the host's Docker daemon |
| `@critical-labs/qa-conductor/adapters/provisioner-process` | `createProcessProvisioner` | a Provisioner for local process groups |
| `@critical-labs/qa-conductor/adapters/build-worktree` | `createWorktreeBuild`, `trustDecision` | a BuildConvention that runs PRs from git worktrees, behind a trust gate |
| `@critical-labs/qa-conductor/adapters/exposure-tailscale` | `createTailscaleExposure` | an Exposure adapter on `tailscale serve` |
| `@critical-labs/qa-conductor/package.json` | *(the manifest)* | |

Each row lists every name its entry point exports, and no other entry point is exported. The package also installs one bin, `qa-conductor-expose`, the [expose CLI](#expose-cli), for operators.

## Using the harness

Open the harness at its origin, under `/qa/`, as startup logs it (`[qa] harness at <origin>/qa/`); anywhere else it shows a banner that links there. Then:

- **Pull requests.** The picker lists the open PRs, at most the 50 most recently opened, with each one's build status: `ready — opens in seconds`, `building…`, `needs build` or `can't boot: <reason>`. **↻** reloads the list and **Open QA** boots a PR. One session runs at a time: opening another PR offers **Resume** for the running one, or **End #N and open #M** to take over.
- **Boot.** The four steps, Building, Preparing data, Migrating and Starting, each timed, with the BuildConvention's messages under the first. **Cancel boot** tears the boot down. A failed boot shows the error and the failing pane's log tail, with **Retry boot**.
- **Mirror** (`m`) replays each click, key and form value from one pane in the other. Its **⌄** menu turns scroll mirroring off and on (`s`).
- **Re-sync →** (`r`) reloads the PR pane at the base pane's path, and its **⌄** menu the base pane at the PR pane's. A dot on it says the panes are at different paths.
- **375**, **768** and **Full** (`1`, `2`, `3`) set both panes' width.
- **auto-end** counts down to the idle teardown, `QA_IDLE_MINUTES` after the last interaction, and turns amber for the last five minutes.
- **End session** (`e`) tears the session down once you click it again within three seconds.
- **Each pane's bar** has a dot (amber while signing in, green while the pane's bridge reports, grey after 10 seconds of silence), the pane's path, a count of interactions the other pane couldn't replay (click it to clear), and buttons to copy the path, reload the pane and open it in a new tab.
- **Verdict** (`v`) opens the drawer: notes, kept in the browser as a draft for each PR, then **Accept** or **Reject**, a preview of the comment and the label change, and **Post to PR #N**. After posting: **End session**, **Keep session open** or **Back to pull requests**.
- **`?`** lists the keyboard shortcuts, which work while the harness, not a pane, has the focus. `Esc` closes the drawer or the list, or cancels an end-session click. Below 900 pixels wide, the panes become **BASE** and **PR** tabs.

## Security

**The trust gate is the only real boundary between a PR's code and the reviewer's machine.** Booting a PR runs its code. A BuildConvention that checks out and installs PRs must refuse untrusted ones in `ensureBuilt`, before any git call. **Env scrubbing and loopback binding are defence in depth**, not a boundary.

The conductor's own defences in depth:
- **Tailscale identity gate.** In tailscale mode (`QA_EXPOSURE=tailscale`), the harness and both pane proxies answer `403` to any request whose `Tailscale-User-Login` isn't in `QA_ALLOWED_LOGINS` (matched ignoring case), before anything else runs. The gate wraps each whole server, so no route, present or future, runs for such a request, upgrades included, and the `403` still carries the harness frame lock or the pane's frame policy. `tailscale serve` sets that header from the device the request came from, strips any copy the client sent, and sets none for tagged devices, which are refused. An empty allowlist refuses everyone, so `loadConfig` refuses one in tailscale mode (`startConductor` only logs an error). The gate's `403` carries `X-QA-Refusal: identity`, so a client can tell it from any other `403` without reading the body: the [expose CLI](#expose-cli) publishes a port only once that port answers with it, and `isIdentityRefusal(res)` from `./identity` recognises it. The pane proxies drop an `X-QA-Refusal` the pane app sends, so PR code can't make an ungated pane look gated. The pane proxies drop every `Tailscale-*` header before the pane app sees the request. Other front-door headers pass through, such as `X-Forwarded-For`, which `tailscale serve` sets to the viewer's tailnet address: the pane app, PR code included, still sees which device is viewing.

  `QA_EXPOSURE` defaults to `tailscale` when anything the conductor answers to or listens on is off loopback: the harness origin, either pane origin, `QA_PUBLIC_HOST`, a `QA_ALLOWED_HOSTS` entry or `QA_BIND_HOST` (see [Configuration](#configuration)). Loopback layouts, such as `npm run qa` and the demo, stay ungated with no config.

  **The gate trusts the header from anything that can reach loopback on this host.** That is why tailscale mode requires a loopback bind: on any other address, a client could send its own login. It also means the gate keeps out other devices, not code on this one. With `provisioner-process`, the pane processes run PR code on the same host, as the same user, so they can reach loopback and send any login they like: in tailscale mode the gate does not protect against PR code, and only the BuildConvention's trust gate does. Containers don't change that everywhere. On native Linux Docker, a container on a bridge network can't reach the host's loopback, but Docker Desktop (through `host.docker.internal`) and some rootless runtimes forward to it, and there a container pane can send any login too.

  **The gate works only behind `tailscale serve --https`**, which sets `Tailscale-User-Login` and drops any copy the client sent. Never put Funnel in front of the conductor, which opens it to the internet, nor `tailscale serve --tcp` or `--tls-terminated-tcp`, which pass the client's bytes through unchanged, so a header it writes itself reaches the gate. And never put `tailscale serve` in front of a conductor in none mode (`QA_EXPOSURE=none`): with no gate, every device on the tailnet gets in.
- **Loopback by default.** All three servers listen on `QA_BIND_HOST`, default `127.0.0.1`, and tailscale mode refuses any other address (`loadConfig` and `startConductor` throw). In none mode, anything other than loopback exposes an unauthenticated API that returns pane login URLs and posts verdicts with `GITHUB_QA_TOKEN`. A pane proxy *is* an authenticated pane session, because the proxy holds the pane's cookie jar. Widen the bind only in none mode, behind a firewall or an authenticating front door, and have viewers reach the harness and the panes over https (a plain-http origin must be loopback, see the pane request guard below).
- **Host allowlist.** Every server checks the `Host` header before routing (the harness does so before it even parses the request target) and answers `421` unless its hostname (port ignored, `[]` stripped) is `127.0.0.1`, `localhost`, `::1`, `QA_PUBLIC_HOST`, the hostname of the harness origin or of either pane origin, or an entry in `QA_ALLOWED_HOSTS`. This defeats DNS rebinding. A front door must pass the viewer's `Host` through, or rewrite it to a loopback `Host`. A rewritten `Host` that is allowed but not loopback (`qa-conductor:3100` behind nginx, say) clears this check, but every browser `/api/*` call then gets `403 not the harness origin` (see [Same-origin API](#security)).
- **Pane request guard.** The proxy holds each pane's cookie jar, so every request that reaches a pane acts as the reviewer, and the reviewer's browser sends requests for any page they have open. Loopback and the Host allowlist don't stop that. So a pane answers `403` to:
  - a write, a preflight, a CORS read or a WebSocket that doesn't come from the pane's own pages (`sec-fetch-site` `same-origin` or `none`, else an `Origin` whose host is the request's `Host`);
  - a subresource load (`<img>`, `<script>`, a no-cors fetch) from another site;
  - a navigation from another site, into a frame or top-level, unless its `Referer` is the harness origin, as it is for the harness's own iframes and "Open in new tab" links. A redirect the app answers such a navigation with keeps that `Referer` for the next hop, unless the redirect's own `Referrer-Policy` drops it, so the proxy removes that header from a redirect that stays on the pane.

  `same-site` counts as another site: on loopback every other port is same-site, and so is every host in a tailnet. A request the guard admits gets the whole jar.

  The guard works from Fetch Metadata (`sec-fetch-site`, `sec-fetch-mode`, `sec-fetch-dest`), which browsers send only to https and loopback origins. A request without it (curl, an older browser) is judged by its `Origin` alone, and another page's `<img>`, `<iframe>` or link sends no `Origin`. Over plain http on any other host, the guard couldn't tell those from curl, so `loadConfig` and `startConductor` refuse an `http:` harness or pane origin whose host isn't loopback (`127.0.0.0/8`, `::1`, `localhost`).

  **The guard keeps out other pages, not the panes' own apps.** A pane's app sees the harness's navigations, and when it answers one with a redirect, the next hop keeps the harness `Referer` wherever it goes. So the PR pane's app can redirect the harness's frame, or a new tab, to any URL of the base pane, which serves it with the reviewer's session. The trust gate is the boundary against PR code.
- **The pane apps get only their jar's cookies.** A pane proxy keeps the app's cookies in its jar and never passes the app's `Set-Cookie` on to the browser. Nor does it pass the browser's own `Cookie` header on to the app. Cookies ignore ports, so that header carries every cookie for the pane's hostname: another app's on another port, its session among them, and any the other pane's scripts set with `document.cookie`. And the app runs PR code. An app that reads a cookie its own scripts set (a locale, say) gets it only when `QA_FORWARD_CLIENT_COOKIES` names it. The jar's value wins on a name both have, and any page on the hostname, the other pane included, can set that cookie. So such a cookie passes only when its value is an RFC 6265 cookie-value. A browser sends back whatever a page wrote, so a value with a space, a comma, a backslash or a stray double quote could hide another cookie (`locale=fr, sid=evil`) for a lenient parser to read, and the proxy drops it. The jar's cookies come first in the header the app gets. And each jar holds one session's cookies: the conductor gives both panes fresh jars when a session is torn down, when the next one starts booting and when it is ready, and detaches both panes while a session boots, so no PR's app gets the cookies an earlier session's app set.

  **The panes' pages still share the browser's cookies with every app on their hostname.** A pane's scripts (PR code) run there, so they can read that hostname's cookies that aren't `HttpOnly`, and set cookies the browser then sends to every app on it. They can also send those apps requests that carry their cookies, `HttpOnly` and `SameSite=Strict` ones included (a form post, a `no-cors` fetch), because every port of the hostname, and every host in a tailnet, is same-site: PR code can act on the reviewer's session in another app without reading it. Serve the panes on a hostname no other app uses. That stops the cookie sharing, not those requests, so another app the reviewer is signed in to must not rely on `SameSite` alone against the panes.
- **Pane frame lock.** Every pane response, the proxy's own `403`, `421`, `502` and `503` included, carries `Content-Security-Policy: frame-ancestors 'self' <harness origin> <QA_FRAME_ANCESTORS…>` and `X-Content-Type-Options: nosniff`. The policy replaces the app's own `frame-ancestors` directive (its other directives are kept), and the app's `X-Frame-Options` is dropped. A value that isn't an http(s) origin is left out, and so is an IPv6 literal, which a CSP source can't express.
- **The mirror bridge talks only to the harness.** The proxy puts the harness origin on the script tag it injects (`data-harness`). The bridge posts only to its parent frame at that origin, applies replays only from its parent at that origin, and does nothing without one. So a page that frames a pane, the PR pane included, can neither hear nor drive its bridge. **The PR pane's code can still drive the base pane through the harness**, as mirroring does: while the mirror is on, the harness replays in the base pane every interaction the PR pane posts to it (a click, a key or a value on any selector), and PR code can post those itself.
- **Harness frame lock.** Every harness response, errors and refusals included, carries `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: strict-origin-when-cross-origin`. No other page can frame the harness to trick a click that starts a session or posts a verdict, and the harness's frame loads and new tabs always send its origin as the `Referer` the panes check.
- **Open the harness at its origin.** The panes trust exactly one harness origin, `QA_HARNESS_ORIGIN`, which startup logs as `[qa] harness at <origin>/qa/`. Opened anywhere else that reaches it (`localhost` for `127.0.0.1`, or another front-door port), the harness shows a banner linking to that origin, and the panes answer `403`. The harness and the panes may still use different hosts: only the URL the harness itself is opened at must match. An IPv6 literal can't be that origin, since a CSP source can't name one: with a `::1` bind, set `QA_HARNESS_ORIGIN=http://localhost:<port>` (startup logs an error until you do).
- **Same-origin API.** Every harness `/api/*` request, reads and the progress stream included, gets `403 cross-site request refused` when `sec-fetch-site` is present and isn't `same-origin` or `none`, or, absent that, when `Origin` is present and its host isn't the request's `Host`. Another page can't read the answers, but its writes would run, and each read of `/api/prs` spends GitHub API calls. A browser (a request with either header) must also reach the API at the harness origin's host and port, else it gets `403 not the harness origin` (its body names `harnessOrigin`, for the banner): a page served by another front-door handler that proxies to the harness, such as a stale `tailscale serve` mount on another port, is same-origin with that handler. Loopback `Host`s are exempt from that second check, and non-browser clients, which send neither header, from both. Like the pane guard, this needs Fetch Metadata: over plain http off loopback, another page's `<script src>` GET sends neither header and passes as a non-browser client.
- **JSON bodies.** `POST /api/session`, `/api/verdict` and `/api/teardown` require `content-type: application/json` (else `415`). A cross-site form can't send that type, and a cross-site `fetch()` with it needs a CORS preflight the harness never grants.
- **Inert rendering.** The harness UI renders PR titles, build messages, blocked reasons, errors and log tails as text, and links a build run only when its URL is `https://`.

## The seams

A boot runs these five seams in order: `ensureBuilt` → per pane (`provisionDatabase` → `seedPane` → `reserveServices`) → `derivePaneEnv` (+ `runMigrate`) → `launchServices` → `waitHealthy` → `establishSession`. A sixth, [Exposure](#exposure-optional), is optional and outside the boot: it publishes the conductor itself. The shapes they pass each other are under [Types](#types).

| Seam | Members | Owns |
|---|---|---|
| **Provisioner** | `provisionDatabase({paneRef, databases, signal}) → {dsn, db}`, `reserveServices({paneRef, services, signal}) → {name: {url, port}}`, `launchServices({paneRef, services, env, reserved, signal})`, `waitHealthy({services, signal})`, `teardown({paneRef})`; optional `runMigrate({paneRef, migrate, env, signal})`, `sweep()`, `logs({paneRef, stage, lines}) → string` (or a promise of one) | Where panes run: databases, processes or containers, ports, env at rest, cleanup |
| **BuildConvention** | `migrationStrategy` (`'one-shot-image' \| 'on-boot' \| 'none'`), `ensureBuilt(pr, {signal})`, `resolvePrImages(pr)`, `resolveBaseImages()` → `{services: {name: ref}, migrate?, label?}`; optional `subscribeBuild(cb)` with `cb({runUrl?, runStatus?, runConclusion?, message?})`, `describePrs(prs) → [{number, status: 'built'\|'building'\|'none'\|'blocked', runUrl, reason?}]` | What gets run for base and PR, whether it's ready, and whether it may run at all |
| **Seed** | `databases`, `seedPane({paneRef, db, databases})` | Where each pane's data comes from and how it moves |
| **EnvTransform** | `derivePaneEnv({prodEnv, pane}) → {service: env}` (pure) | Pointing a pane at its own DB and origin, and neutralizing side effects (email, payments, storage) |
| **AuthBootstrap** | `requiresDb`, `establishSession({pane, operator, db?}) → {landingUrl}`; optional `envContributions() → {service: env}` | Getting the reviewer logged in to each pane |

The optional members degrade gracefully when absent:
- With no `sweep`, nothing is cleaned up at startup.
- With no `logs`, failures show no log tail.
- With no `describePrs`, every PR shows as `none`.

The one exception: a build that declares `one-shot-image` migrations with a Provisioner that can't `runMigrate` fails the boot with a clear error.

### Types

What the seams pass each other. Any method above may return its result or a promise of it: the core awaits each one.

- **PaneRef**: `{ role, slug, publicOrigin }` during a boot. `role` is `'base'` or `'pr'`, `slug` is `qa-<pr>-<role>`, and `publicOrigin` is the pane's origin from `cfg.paneOrigins`. `teardown` and `logs` get only `{ role }`, since they also run outside a boot.
- **ImageSet**: `{ services: { name: ref }, migrate?: { image }, label? }`, from `resolveBaseImages()` and `resolvePrImages(pr)`. A `ref` is whatever the Provisioner launches, such as an image name or a checkout directory.
- **Reserved**: `{ name: { url, port } }`, from `reserveServices`: where each service will listen. **Only the primary service is proxied**, `app` when there is one, else the first: the pane proxy forwards to `127.0.0.1:<port>` of that service, so it must listen there. Any other service is the app's own business.
- **Pane**: `{ ref, dsn, db, services, publicOrigin, env }`. `ref` is the PaneRef, `dsn` and `db` come from `provisionDatabase`, `services` is the Reserved map, and `env` is the pane's env. `derivePaneEnv` gets the pane before it has an `env`; `establishSession` gets it whole.
- **PaneEnv**: `{ service: { KEY: value } }`, from `derivePaneEnv`. **EnvContributions**, the same shape from `auth.envContributions()`, is merged over it service by service. `runMigrate` and `launchServices` get the result as `env`.
- **SessionResult**: `{ landingUrl }`, from `establishSession`: the URL the harness loads in the pane's frame. The core reads nothing else from it, so a session cookie must reach the pane's jar as a `Set-Cookie` the landing URL answers with (see below).
- **BuildEvent**: `{ runUrl?, runStatus?, runConclusion?, message? }`, what `subscribeBuild`'s callback gets.
- **Readiness**: `{ number, status, runUrl, reason? }`, one per PR from `describePrs`, with `status` one of `'built'`, `'building'`, `'none'` and `'blocked'`.

### Contracts between the seams

- **`db` is opaque to the core.** Whatever `provisionDatabase` returns as `db` is passed unchanged to `seedPane` and (when `requiresDb`) to `establishSession`. Its shape is a contract among a consumer's own adapters.
- **Cancellation (`signal`).** Teardown and takeover abort the in-flight boot. The core checks the signal between stages, at the top of each pane's provisioning, between `provisionDatabase` and the Seed, before each `launchServices` and before the `waitHealthy` loop. It also passes the signal to `ensureBuilt` and to every Provisioner call above, so a long wait can stop early. Provisioners may ignore it. The Docker one checks it before each step that creates or changes something, but still finishes a wait or a Docker call already running. An aborted boot never tears anything down, even when the abort lands while its failure log tail is being read: whoever aborted it already did.
- **Startup sweep.** The conductor calls `sweep()` once, at startup. A boot started before it settles waits for it before `ensureBuilt`, so the sweep can't remove the new session's panes. While it waits, the harness shows `waiting for startup cleanup…` under the first boot step, then `startup cleanup done`, and counts the wait in that step's time and the boot's. There is no timeout. A failed sweep is logged and doesn't block boots, even one that throws synchronously or rejects with something other than an `Error`. A teardown or takeover during the wait cancels the waiting boot, as it would at any other point.
- **Build progress.** `subscribeBuild(cb)` payloads are `{runUrl?, runStatus?, runConclusion?, message?}`. The harness shows `message` (plain text, e.g. `installing dependencies for #12 (abc1234)…`) under the first boot step, else a summary of the run's status that names a `completed` run's conclusion when it isn't `success` (`Build ended: failure`), and links the run when `runUrl` is `https://`. `/api/state` returns the latest as `buildRun: {url, status, conclusion, message}`. A boot that fails at `ensuring-image` with an error that carries `run: {url, status, conclusion}`, as `awaitPreviewImage`'s does, gets that run as its last build event before the error, so `buildRun` and the error's run link show the run that failed. Only string fields are kept, and only when there is a `url` or a `status`.
- **`blocked`.** `describePrs` may report a PR as `blocked`, with a plain-text `reason` (for example, an untrusted author or a head branch in someone else's fork). The picker shows it as `can't boot: <reason>`. Opening the PR is still allowed, because `ensureBuilt` is the real gate. `describePrs` receives `listOpenPrs()` items, or for `/api/build-status` an item built from `github.prInfo(pr)` (`{number, headSha, author, authorAssociation, headRepo, headOwner}`), falling back to `{number, headSha}` from `prHead` when `github` has no `prInfo`.
- **Display `label`.** `resolveBaseImages` / `resolvePrImages` may return a `label` string, used as the pane's tag instead of the primary service's ref (`app`, else the first service). The label appears in the harness header and in the **public** verdict comment. Consumers whose service refs are local paths or objects must set one, so no path or object leaks into the PR. It must not contain `:`.
- **Failure log tails.** When a boot fails at a pane stage (`cloning`, `migrating`, `starting`), the core calls `logs({paneRef: {role}, stage, lines: 40})` for the failing pane *before* tearing the panes down, and attaches the result to the error as `err.logTail` (with the pane's role as `err.failedRole`). An error that already carries a string `logTail` keeps it, so a BuildConvention can attach its own tail to an `ensuring-image` failure (for example, installer output). The harness shows the tail under the error.
- **Landing flows stay on the pane origin (AuthBootstrap).** The harness loads each `landingUrl` as given; the bridge learns the harness origin from the proxy, not from the URL. A pane serves a navigation from another site only when its `Referer` is the harness origin, so a sign-in step on another site, such as an external identity provider's form, comes back with that site's `Referer` and is refused. Keep landing flows on the pane origin. Redirects within it are fine, whatever their `Referrer-Policy`: the proxy drops that header from a redirect that stays on the pane, so the next hop still carries the harness `Referer`.
- **Sessions live in the jar (AuthBootstrap).** The pane app gets the cookies its own responses set this session, which the proxy keeps, and not the browser's. So the session must reach the jar in a `Set-Cookie`: have the `landingUrl`, or a redirect it makes, set it server-side. A session cookie the app's scripts write can't be kept apart for two panes on one hostname, `QA_FORWARD_CLIENT_COOKIES` or not. Cookies ignore ports, so both panes' pages write the same browser cookie, whichever pane signs in last overwrites it, and both proxies would pass that one value on: one pane's app would get the other pane's session (see [Security](#security)).

**Reference consumers:** this repository's self-QA ([`qa/self.mjs`](qa/self.mjs): `build-worktree` and `provisioner-process`, described in [CONTRIBUTING.md](CONTRIBUTING.md#qa-this-repos-own-pull-requests)), the demo's fake adapters ([`demo/fake-adapters.mjs`](demo/fake-adapters.mjs)), and agent-identity's [`packages/qa`](https://github.com/critical-labs/agent-identity/tree/main/packages/qa), a 0.2-era consumer that seeds each pane's DynamoDB Local from a redacted snapshot.

### Built in: `adapters/build-worktree` (git-worktree BuildConvention)

A BuildConvention for apps that run a PR from its source rather than from CI-built images. It fetches the base branch and the PR head into a bare repository, checks each SHA out into its own git worktree, optionally installs dependencies, and hands each worktree directory to your Provisioner through `servicesFor`.

```js
import os from 'node:os'
import path from 'node:path'
import { createWorktreeBuild } from '@critical-labs/qa-conductor/adapters/build-worktree'

const build = createWorktreeBuild({
  repo: 'acme/widget',
  cacheDir: path.join(os.homedir(), '.cache/qa-conductor/acme-widget'),
  github,                                          // needs prInfo(num) and authorPermission(login)
  servicesFor: (dir, { role, sha }) => ({ app: dir }),
  install: { cmd: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'] },
})
```

| Option | Default | |
|---|---|---|
| `cloneUrl` | `https://github.com/<repo>.git` | must not contain credentials (construction throws); for a private repo, configure a git credential helper |
| `install` | `null` (no install) | `{ cmd, args, env? }`, run in the worktree |
| `baseRef` | `'main'` | the branch the base pane runs |
| `trust` | `{ logins: [], associations: ['OWNER', 'MEMBER', 'COLLABORATOR'], requirePush: true, allowForks: true }` | see below; omitted keys keep their defaults. `logins` and `associations` must be arrays of strings (split a comma-separated env value first); anything else throws at construction |
| `keep` | `6` | the newest `keep` builds survive pruning; the two SHAs just built are never removed, even when they fall outside that number |
| `migrationStrategy` | `'on-boot'` | |

How it works:
- **Layout under `cacheDir`.** The bare repository is `repo.git`, created on first use, and each checkout is `worktrees/<sha>`. Markers live at `built/<sha>.json`, outside the checkouts, so a PR's committed files can't supply one. A marker records a fingerprint of the install command, args and env keys. If it doesn't match, or the checkout is gone, the marker is dropped and the SHA is rebuilt from a clean checkout.
- **The cache must be yours alone.** `cacheDir`, `built/` and `worktrees/` are created `0700`. Each build refuses to run unless each of them is a real directory (not a symlink), owned by the current user, and not writable by group or others: anyone who can write there can plant a marker and a tree for the base SHA.
- **One build at a time** per instance. A second caller waits, then runs its own build, re-checking the markers.
- **Progress** goes to `subscribeBuild` as `{ message }` (`fetching acme/widget…`, `installing dependencies for #12 (1a2b3c4)…`, `#12 (1a2b3c4) already built`). Each `ensureBuilt` reports to the subscriber that was current when it was called, and says nothing more once its signal aborts. An install failure's error carries a `logTail`: the last 40 lines of its output, at most 8 KB.
- **`resolvePrImages` / `resolveBaseImages`** return `servicesFor(dir, …)`, `migrate: null`, and a `label` such as `#12@1a2b3c4` or `main@9f8e7d6`, which never contains a path.
- **`describePrs`** reports `blocked` (with a reason) for a PR that fails the trust gate, then `building`, `built` or `none`.
- **Pruning** runs after each build and is best-effort. The newest `keep` builds are kept, and the two SHAs just built are never removed, even when they fall outside that number. Every other checkout is removed, including ones whose build never finished.

**Security.** This adapter checks out and installs a PR's code on the reviewer's machine, as the reviewer, and your Provisioner then runs it. **The trust gate is the only real boundary between a PR's code and the reviewer's machine. Env scrubbing and loopback binding are defence in depth.**
- **The trust gate.** `ensureBuilt` refuses a PR, before any git call, unless all of these hold:
  - its author is in `trust.logins`, or has an association in `trust.associations` **and**, when `requirePush` is set (the default), `write` or `admin` permission on the repo;
  - its head repository still exists;
  - its head branch is in the repo itself or in the author's own fork, not in someone else's fork. With `allowForks: false`, only the repo itself.
- **Association isn't access.** `author_association` alone is not an access check. `COLLABORATOR` includes read-only outside collaborators, and `MEMBER` includes org members with no push access. That's why `requirePush` defaults on.
- **The gate vouches for the author, not for every commit.** It checks who opened the PR and where its head lives, not who pushed the head commit. Anyone with push access to the author's fork (collaborators they added, bots or Actions with write access to it) can move the head, and the moved head passes as the author's. Set `allowForks: false` to require heads in the repo itself, where everyone who can push has write access to the repo.
- **Only the gated SHA runs.** Only the exact SHA that passed the gate is ever checked out or installed. If the head moves between the check and the fetch, the new SHA is gated again, or the build fails with `head moved during fetch; retry`.
- **It fails closed.** Any error while checking (a GitHub error, a missing field) refuses the PR, and a malformed `trust` config throws at construction.
- **Defence in depth, not a sandbox.**
  - The installer's environment is exactly `PATH`, `HOME` and `install.env`, so credentials in environment variables (such as `GITHUB_QA_TOKEN`) don't reach it. Files under `HOME` do: it can read `~/.npmrc` tokens, `~/.config/gh`, `~/.git-credentials` and `~/.ssh`.
  - git runs with hooks disabled and prompts off.
  - A PR that passes the gate still runs with the reviewer's full user access. Code it runs (install scripts, a package manager it selects, the server your Provisioner launches) can rewrite this cache, including markers and other checkouts such as the base, like anything else the reviewer can write.
- **Skip install scripts.** Install with `--ignore-scripts` (with pnpm, also `--ignore-pnpmfile`) so dependency lifecycle scripts and pnpmfiles don't run.

### Built in: `adapters/provisioner-process` (process Provisioner)

A Provisioner for local processes. It runs each pane's services, and optionally a per-pane database, as process groups on `127.0.0.1`, with a scrubbed env, a pidfile and a start-time-checked orphan sweep. Its launch contract is below.

```js
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createProcessProvisioner } from '@critical-labs/qa-conductor/adapters/provisioner-process'

const ddbDir = '/opt/dynamodb-local'   // where DynamoDBLocal.jar is unpacked

// Resolves once something accepts connections on the port.
async function waitForPort(port, { signal }) {
  while (!signal.aborted) {
    const open = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true) })
      socket.on('error', () => resolve(false))
    })
    if (open) return
    await sleep(250)
  }
}

const provisioner = createProcessProvisioner({
  stateDir: path.join(os.homedir(), '.cache/qa-conductor/acme-widget'),  // holds pids.json
  // `ref` is the service's entry from the BuildConvention, e.g. a checkout directory
  command: ({ name, ref, port, env, paneRef }) => ({
    cmd: path.join(ref, 'node_modules/.bin/tsx'),
    args: ['packages/api/src/dev.ts'],
    cwd: ref,
    env: { HOST: '127.0.0.1', PORT: String(port) },
  }),
  database: {                                  // optional: one per pane
    command: ({ paneRef, port }) => ({ cmd: '/usr/bin/java', args: ['-jar', 'DynamoDBLocal.jar', '-inMemory', '-port', String(port)], cwd: ddbDir }),
    ready: ({ port, signal }) => waitForPort(port, { signal }),
    handle: ({ paneRef, port }) => ({ dsn: `http://127.0.0.1:${port}`, db: { endpoint: `http://127.0.0.1:${port}` } }),
  },
  healthPath: '/ui/',                          // or (serviceName) => path; default '/'
  healthy: status => status === 200,           // default: status < 500
})
```

The other options are `healthTimeoutMs` (60000, per service), `host` (`127.0.0.1`: the address in reserved urls, health checks and the free-port lookup), `graceMs` (5000, from SIGTERM to SIGKILL), `logLines` (200 per pane) and `log` (`console`). Every effect is injectable: `spawnFn`, `killFn`, `freePortFn`, `fetchFn`, `fsx`, `psFn`, `pgroupFn`, `bootIdFn`, `sleepFn`, `nowFn`, `onExitFn` and `baseEnv`.

**Launch contract.** `command` and `database.command` must start the server binary **directly**, never through a package manager (`pnpm dev`, `pnpm exec`, `npm run`, `npx`). The child has no TTY and only `PATH` plus the env you declare, and the package manager on that `PATH` may not be the one that ran `install`: pnpm 10 and later verify dependencies before run/exec and, with no TTY, fail or reinstall. So use, for example, `{ cmd: join(dir, 'node_modules/.bin/tsx'), args: ['packages/api/src/dev.ts'], cwd: dir }` or `{ cmd: process.execPath, args: ['demo/server.mjs'], cwd: dir }`. The process you start is the server: if it exits, the pane has failed.

- **Env.** A service gets exactly `{ PATH, ...env[name], ...spec.env }`: the conductor's `PATH`, the pane env from your EnvTransform, then the command's own `env`. The database gets `{ PATH, ...spec.env }`. Nothing else is inherited: no credentials, and no `HOME` unless you declare it.
- **Ports.** `reserveServices` picks a free port per service on `host`, and never hands out a port another pane or service still holds. Nothing starts until `launchServices`. Your command must make the server listen on that port, bound to `host`.
- **Health.** `waitHealthy` polls `<url><healthPath>` until `healthy(status)`, for up to `healthTimeoutMs`. A process that exits first fails the boot at once, with its log tail. `healthy(status)` gets the service's own response status: redirects aren't followed (an app often redirects to its public origin, the pane proxy, which answers `503` until the boot is done), so under the default `status < 500` a `3xx` counts as up. A strict predicate such as `status === 200` needs a `healthPath` that doesn't redirect.
- **Logs.** Each pane keeps its last `logLines` lines of stdout and stderr, prefixed `[name]`, and `logs()` returns the tail. The buffer survives teardown, and resets when the pane's next boot starts.
- **Teardown** signals process **groups**, never bare pids, because a wrapper may exit at once while its server lives on. Services go first, then the database: SIGTERM, then SIGKILL after `graceMs`. A group that survives SIGKILL is logged and left for the next sweep. Once a leader has exited, its pid can be reissued, so teardown checks it with `ps` first: a pid held by another process means our group is gone, and it isn't signalled.
- **Crash cleanup.** Each process is recorded in `<stateDir>/pids.json` with its start time from `ps` and the boot it ran in. The directory must be a real directory owned by you and not writable by group or others (it's created `0700`; one that others could write to is refused, since its contents may be planted), and `pids.json` must be a regular file owned by you (written `0600`). `sweep()`, which the conductor runs at startup, kills the groups a previous run left behind. It skips any pid that now belongs to another process, drops entries from an earlier boot without signalling anything, and leaves in place entries it can't check (no start time). Give each conductor its own `stateDir`. A `process.on('exit')` hook SIGKILLs every live group; signals don't run it, so call the conductor's `shutdown()` from your signal handlers.
- There's no `runMigrate`: process consumers migrate on boot.

**Security.** A PR's code runs as your user, on your machine. The trust gate is the only real boundary between a PR's code and the reviewer's machine: the BuildConvention must refuse to build a PR it doesn't trust. Env scrubbing and loopback binding are defence in depth. The Tailscale identity gate is no boundary against PR code either: a pane process can reach the conductor on loopback and send any `Tailscale-User-Login` it likes (see [Security](#security)).

### Built in: `adapters/provisioner-docker` (Docker Provisioner)

A Provisioner that runs each pane as two containers on the host's Docker daemon, a postgres one and an app one. It writes each pane's env to an owner-only file for `docker run --env-file`, logs in to the registry, runs one-shot migrations, and at startup removes the containers, networks and env files an earlier run left behind.

It keeps the panes apart:
- **A network per pane.** Each pane's containers join a network of their own. On Docker Engine with its default iptables rules, the PR pane's containers can then neither resolve nor reach the base pane's. The conductor needs no shared network: it reaches the apps through their host ports and the databases through `docker exec`.
- **A database password per pane, drawn for each boot,** unless you set `postgres.password`. Only that pane's `dsn` carries it. So a PR that reached the other pane's database still couldn't sign in. That holds for an image that sets its database up from `POSTGRES_PASSWORD` and `POSTGRES_HOST_AUTH_METHOD`, as the official `postgres` image does. `createDocker`'s `postgres.image`, under [Effect wrappers](#effect-wrappers), says which don't.

Its limits, below, say what the networks and passwords don't separate, and [Known limits](#known-limits) what no Provisioner separates.

```js
import fs from 'node:fs'
import { createDocker } from '@critical-labs/qa-conductor/docker'
import { makeExecFileFn } from '@critical-labs/qa-conductor/exec'
import { createDockerProvisioner } from '@critical-labs/qa-conductor/adapters/provisioner-docker'

const provisioner = createDockerProvisioner({
  docker: createDocker({ execFileFn: makeExecFileFn() }),
  fsx: fs.promises,
  workDir: '/var/lib/qa-conductor',
  registry: { user: 'acme-bot', token: cfg.ghcrToken },
})
```

| Option | Default | |
|---|---|---|
| `docker` | *(required)* | a `createDocker(...)` ([Effect wrappers](#effect-wrappers)) |
| `fsx` | *(required)* | `{ writeFile, unlink }`, such as `fs.promises`: writes the env files, mode `0600`, and removes them at teardown and at startup |
| `workDir` | *(required)* | the directory the env files go in, as `.env.qa-base` and `.env.qa-pr`. The `docker` CLI reads them by path, so it must see the same directory |
| `network` | `'qa-session'` | each pane's Docker network: a prefix, so `qa-session-base` and `qa-session-pr`, or `{ base, pr }` to name both. A network name must be letters, digits, `_`, `.` and `-`, and not lowercase hex digits alone, which Docker would also read as the start of a network id. Two panes on one network, or one of Docker's or Podman's own networks or modes (`host`, `bridge`, `none`, `default`, `ingress`, `docker_gwbridge`, `podman`, `private`, `pasta`, `slirp4netns`, `podman-default-kube-network`, `container:<name>`), throw |
| `postgres` | `{ user: 'qa', db: 'postgres' }` | the superuser in the `dsn` it returns, and the database `db.query` uses by default: match `createDocker`'s `user` and `db`. Keys you leave out, or set to `undefined`, keep these values. Leave `password` out, and each pane's database gets its own, 48 random hex characters drawn for each boot. A `password` you give must be a non-empty string with no control characters. Both panes use it, so the PR pane's `dsn` also opens the base pane's database, and only the networks keep them apart. Either password holds only with an image that enforces it: see `createDocker`'s `postgres.image` |
| `hostPorts` | `{ base: 3111, pr: 3112 }` | the loopback host port each pane's app container is published on |
| `registry` | `null` | `{ user, token }`: log in to `ghcr.io` before pulling, and again before each retry |

For each pane:
- `provisionDatabase` creates the pane's network, pulls the postgres image if it's missing, and starts `qa-pg-<role>` on the network, with the pane's password. It waits until the database answers twice in a row, creates each of the Seed's `databases`, and returns the `dsn` `postgresql://<user>:<password>@qa-pg-<role>:5432`, with the user and password percent-encoded, and a `db` of `{ dsn, query(sql, { database }) }`, which runs `psql` in the container. A pane network left over from an earlier run is reused.
- `runMigrate` runs `migrate.image` once as `qa-migrate-<role>`, on the pane's network, with the pane's `app` env (else its first service's), and removes the container after.
- `launchServices` pulls each image that's missing (three tries), then runs it as `qa-app-<role>` on the pane's network, with its port `3000` published on `127.0.0.1:<hostPorts[role]>`.
- `waitHealthy` polls `http://127.0.0.1:<port>/api/health` until it answers `200`, for up to a minute.
- `logs` tails the app container at `starting`, else the postgres one.
- `teardown` removes the pane's containers (a migrate run still in flight among them) and their volumes, then its network and its env file.
- `sweep` removes both env files, which hold an earlier run's env and passwords, then every container with `createDocker`'s `label` and both panes' networks. When `network` is a prefix, it also removes the network of that very name, which both panes shared in 0.3.1 and earlier, but only if it carries the label, as that network did. It leaves the name alone when it is one of Docker's or Podman's own, or lowercase hex digits alone.

The provisioner also has `networks`, `{ base, pr }` (frozen): the two network names.

Its limits:
- **One service per pane.** Every service would run as `qa-app-<role>` with the same env file.
- **Fixed names and ports.** The containers, the networks and the host ports are the same on every run, so run one conductor per Docker host.
- **The host's loopback.** The panes' apps are published there, and the conductor listens there by default. Where a container can reach the host's loopback (such as Docker Desktop, through `host.docker.internal`, and some rootless runtimes), the PR pane's app can reach all of them:
  - the base pane's app, on its host port;
  - the base pane's proxy, which signs every request in as the operator, so PR code can still change the base pane's data through the base app;
  - the harness API.

  It still can't reach the base pane's database directly: that has no host port.
- **A conductor off loopback.** With a non-loopback `QA_BIND_HOST` (none mode only), a container on any runtime, native Linux Docker Engine included, can reach the harness and the base pane's proxy through its network's gateway or the host's address, unless a host firewall drops that traffic.
- **Other runtimes.** The networks keep the panes apart because Docker Engine's default iptables rules isolate one network from another. A daemon run with `"iptables": false` doesn't, nor do Podman's networks, which it creates without `isolate=true`. There, PR code can reach the base pane's containers by address, though not by name. The per-pane password still keeps it out of the base pane's database, unless you set `postgres.password`, or the image doesn't enforce it (see `createDocker`'s `postgres.image`).
- **The app's side:** listen on port `3000` in the container, and answer `GET /api/health` with `200`.
- **The registry login is to `ghcr.io` only.**
- **`signal`.** Each step that creates or changes something (the network, a container, an env file) first checks `signal`, so an aborted boot stops there. A teardown doesn't wait for a Docker call already running, such as a pull: the aborted boot stops at its next step once that call returns. A `docker run` that had already started can, rarely, still land in the next session's pane of the same role.

### Effect wrappers

**`github`.** The core calls only these, so anything that has them will do:
- `listOpenPrs()` → `[{ number, title, headSha, headRef, author, authorAssociation, headRepo, headOwner }]`, for the picker;
- `prInfo(num)` → `{ number, headSha, author, authorAssociation, isDraft, headRepo, headOwner }`, or without it `prHead(num)` → `headSha`, for `/api/build-status`;
- `postComment(num, body)` → the comment's URL, and `setQaLabel(num, label)`, for the verdict.

`adapters/build-worktree` also needs `prInfo` and `authorPermission(login)`. `createGithub(options)` makes one on GitHub's REST API:

| Option | Default | |
|---|---|---|
| `token` | *(required)* | every call but the package listing ([Tokens](#tokens)) |
| `repo` | *(required)* | `owner/name` |
| `qaLabels` | `['qa-approved', 'qa-changes-requested']` | the accept and reject labels, `[cfg.verdictLabels.accept, cfg.verdictLabels.reject]`: `setQaLabel` adds one and removes the other |
| `packagesToken` | `token` | the GHCR package version listing only (`cfg.ghcrToken`) |
| `packageName` | `null` | the container package the GHCR helpers read; they throw without it |
| `rcTagPattern` | `/-rc\.\d+$/` | which tags `latestRcTag()` counts as release candidates |
| `previewWorkflow` | `'pr-preview.yml'` | the workflow `dispatchPreviewBuild(num)` runs, with the input `pr`, and whose runs `findPreviewRun(num)` and `awaitPreviewImage` read |
| `previewRef` | `'main'` | the ref that workflow is dispatched on |
| `fetchFn` | `fetch` | |

- `listOpenPrs()` returns at most the 50 most recently opened PRs: it reads one page.
- `headRepo` (`owner/name`) and `headOwner` are `null` when the head repository was deleted.
- `authorPermission(login)` returns the login's `admin`, `write`, `read` or `none` permission on the repo, and throws on a non-2xx response. `author_association` alone is no access check: `COLLABORATOR` includes read-only outside collaborators.
- The GHCR and preview-build helpers are for a BuildConvention that runs CI-built images: `ghcrTagExists(tag)`, `latestRcTag()`, `listPrImageTags()`, `awaitPreviewImage(num, sha, { timeoutMs, pollMs, signal, migrate, onRun })`, `dispatchPreviewBuild(num)` and `findPreviewRun(num)`. They read a package that the token's own user owns, not an organization's.
- `awaitPreviewImage` polls every `pollMs` (15000) for up to `timeoutMs` (900000) for the tag `pr-<num>-<the sha's first 12 characters>`, and with `migrate: true` for its `migrate-<tag>` companion too, then resolves with the tag.
  - **The dispatched run.** The first wait for a PR that starts after this client's `dispatchPreviewBuild(num)` resolves also looks up the run that dispatch started, on each poll that misses a tag. The wait claims the dispatch as it starts, so the dispatch arms no other wait. If that run completes with any conclusion but `success`, the wait rejects at once with `preview build failed (conclusion: <conclusion>): <run url>`, and the error carries the run as `err.run`. A `success` keeps the wait polling, since GHCR can lag the run.
  - **Which run is the dispatch's.** Only `workflow_dispatch` runs created in or after the second the dispatch was accepted count, so a run created in an earlier second never does. The time comes from the dispatch response's `Date` header (GitHub's clock), else the local clock. Of those runs, the dispatch's is the earliest whose `run-name` names the PR. Failing that, it is the only one, if that run has no `run-name`, since its title is then just the workflow's name. A workflow whose `run-name` holds the PR number, such as `run-name: Preview #${{ inputs.pr }}`, lets the run be told apart even when other dispatches run at the same time.
  - **Otherwise it just polls GHCR.** That happens while the run can't be told apart, after a failed lookup, and in every other wait for the PR, such as one for a build this client didn't dispatch.
  - **`onRun(run)`** hears the run, in `findPreviewRun`'s shape `{url, status, conclusion, startedAt}`, each time the run taken for the dispatch's changes, or its status or conclusion does. A throw or rejection in `onRun` is ignored. Pass `onRun` on to the `subscribeBuild` callback as `runUrl`, `runStatus` and `runConclusion`, and `buildRun` follows the run while the wait lasts. Without it, the core still shows a failed run, from `err.run` (see [Build progress](#contracts-between-the-seams)).

**`docker`.** `createDocker({ execFileFn, label, postgres })` runs the `docker` CLI for the Docker Provisioner, and for a Seed that copies databases between containers:

| Option | Default | |
|---|---|---|
| `execFileFn` | *(required)* | `makeExecFileFn()` from `./exec`. Your own must pass `opts.env` on to the child, since `login` and `runPg` put secrets there. It must also reject with docker's stderr in the error's `message` or `stderr`, as `makeExecFileFn` does: that is how the Docker Provisioner tells a pane network that already exists from a real failure |
| `label` | `'qa-conductor-session'` | put on every container and network it creates; `sweepQaContainers()` removes whatever carries it |
| `postgres` | `{ image: 'postgres:16', user: 'qa', password: 'qa', db: 'postgres' }` | the pane database containers; keys you leave out, or set to `undefined`, keep these values. The image's entrypoint must set its database up from `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, and write `POSTGRES_HOST_AUTH_METHOD` into `pg_hba.conf`, as the official `postgres` image's does. An image whose data directory is already initialised ignores them all, and keeps its own password and `pg_hba.conf`: set the provisioner's `postgres.password` to that password, which both panes then share. If that `pg_hba.conf`, or the entrypoint, lets TCP connections in without a password (`trust`), the panes' passwords protect nothing |

`runPg(name, network, { password })` starts a database container, with `password` as its superuser's. `postgres.password` is only the default for a call that passes none: the Docker Provisioner always passes its own. The password reaches `docker run` through the CLI's environment (a bare `-e POSTGRES_PASSWORD`), never its argv, which other local users can read. A password that is empty or not a string throws.

It also passes `-e POSTGRES_HOST_AUTH_METHOD=md5`. That overrides an image's own `ENV`, which may say `trust` (as `cimg/postgres`'s does), and the official entrypoint writes it into `pg_hba.conf` for TCP connections. `md5` uses SCRAM where the stored password is SCRAM, as it is by default from postgres 14 on.

Its members are `run(argv)`, `login(user, token)` (to `ghcr.io`, with the token in the environment, never in argv), `imagePresent`, `ensureImage(image, { retries, relogin })`, `ensurePgImage(opts)` (the same, for `postgres.image`), `runPg`, `waitHealthyPg`, `createDatabase`, `pipeDump(from, to, db)` and `cloneDb(from, to, db)` (a host-side `pg_dump | psql` between two containers), `runMigrate`, `runApp`, `waitHealthyApp`, `psql`, `rmForce`, `createNetwork`, `rmNetwork`, `rmLabelledNetwork(name)` (only a network of exactly that name that carries `label`), `sweepQaContainers`, `inspectImageOf` and `logsTail`. `login`, `createDatabase`, `pipeDump`, `cloneDb` and `logsTail` throw on a name that isn't letters, digits, `_` and `-`.

**`exec`.** `makeExecFileFn({ maxBuffer })` returns an `execFileFn(cmd, args, opts)` that runs `execFile` with `maxBuffer` (default 64 MB, which `opts` can override) and resolves `{ stdout }`. It rejects with an Error whose message is `<cmd> <first arg>: <execFile's message>`, then, on the next line, up to 2000 characters of stderr. The original error is its `cause`, and it also carries the whole `stdout` and `stderr` and the exit `code`.

### Exposure (optional)

An Exposure adapter publishes the conductor's three servers on a front door, such as `tailscale serve`, and reports when they drift. It is optional, and **the core never constructs one**: a platform builds it and passes it as `adapters.exposure`, as it does the other adapters. Only a gated conductor may have one: in none mode, `startConductor` throws `adapters.exposure needs QA_EXPOSURE=tailscale: an ungated conductor must not publish itself`.

```js
import { createTailscaleExposure } from '@critical-labs/qa-conductor/adapters/exposure-tailscale'
import { makeExecFileFn } from '@critical-labs/qa-conductor/exec'

const conductor = startConductor({
  cfg,                                                  // in tailscale mode
  github, fsx, readBaseEnv,
  adapters: { provisioner, build, seed, envTransform, auth, exposure: createTailscaleExposure({ execFileFn: makeExecFileFn() }) },
})
const state = await conductor.exposure.ready          // { mode, managed, ok, checkedAt, drift, added, error }
```

**The reconcile loop.** With an adapter, the conductor owns its mounts:
- It reconciles once all three servers listen, so the targets are the bound ports, then every `QA_EXPOSURE_INTERVAL_MINUTES` (`cfg.exposureIntervalMinutes`, default 5) on an `unref()`ed timer. Each pass derives the mounts afresh with `mountsFor`, since `cfg.paneOrigins` may be assigned after start, then runs `reconcileExposure`.
- One pass runs at a time. A tick while a pass is still running, on a hung CLI say, starts nothing, so CLI processes never stack.
- Once `stop()` or `shutdown()` begins, no pass runs and the timer is cleared. Neither waits for a pass in flight. Nothing ever removes a mount, so after a stop the front door answers `502` until the conductor is back.
- Nothing a pass does takes the conductor down. Each mount it writes is logged as `[qa] exposure mounted <port><path> -> <target>`, or `restored` when this conductor had it in place before. `[qa] exposure failed: …`, `[qa] exposure drift remains: <port><path>, …` and `[qa] exposure ok` are logged only when they change.
- `GET /api/exposure` and `conductor.exposure.state()` report the last pass as `{ mode, managed, ok, checkedAt, drift, added, error }`. Neither calls the front door. The mounts in `drift` and `added` are copied from what the adapter returned, keeping only the Mount type's values: a field that isn't a string (for `port`, an integer), such as a `URL` object as the `target`, is reported as `null`.
- So a deploy needn't touch the mounts: the restarted conductor's first pass restores any that are missing or wrong.

In tailscale mode without an adapter, the mounts are someone else's, such as a deploy script's: startup logs `[qa] exposure: tailscale serve mounts are managed outside the conductor`, and `/api/exposure` reports `managed: false`. In none mode it reports `managed: false` too.

To run a pass yourself, outside a conductor, use the [expose CLI](#expose-cli) from a shell, or from code:

```js
import { mountsFor, reconcileExposure } from '@critical-labs/qa-conductor/exposure'

const exposure = createTailscaleExposure({ execFileFn: makeExecFileFn() })
const result = await reconcileExposure(exposure, mountsFor(cfg), { checkOnly: true })   // { ok, checkedAt, drift, added, error }
```

The contract:
- **`Mount = { name, host, port, path, target }`**, one each for `harness`, `base` and `pr`.
  - `host` and `port` are the mount's public side: the hostname and port of its own origin (`cfg.harnessOrigin`, or the pane's in `cfg.paneOrigins`). A port-less https origin means `443`.
  - **`host` is not `cfg.host`.** `cfg.host` is the address the conductor binds, and only `target` uses it.
  - `path` is `/qa` for the harness and `/` for each pane.
  - `target` is `http://<cfg.host>:<listen port>`, with brackets for IPv6.
- **`Drift = { mount, actual }`**: `actual` is the proxy target the front door serves at that mount over https now, or `null` when there is none: nothing at that path, no https on the port, or a handler that isn't a proxy. A mount also drifts once for each other handler that takes some of its requests, and `actual` then names that handler, as `<path> -> <target>` or `<path> (not a proxy)`.
- **`ensure(mounts) → Promise<{ added: Mount[], ok: Mount[] }>`** creates the missing or mismatched mounts, and only those: `added` lists the mounts it wrote, `ok` the ones already in place. **`check(mounts) → Promise<{ ok: boolean, drift: Drift[] }>`** changes nothing. Either rejects on failure. An `ensure` that fails part way may list the mounts it did write on its error, as `added`.
- **An adapter owns exactly the `(port, path)` pairs it is given**, and never touches another handler.

`mountsFor(cfg, { ports = cfg.ports })` derives the mounts from the origins viewers open, so the URL a viewer sees and the mount behind it can't disagree. Pass the bound ports when `cfg.ports` holds `0`. It throws on a layout no front door can publish:
- no harness origin;
- a missing or unparseable pane origin;
- an origin that isn't https, or is on port `0`;
- two mounts on one port, which would share an origin;
- a listen port that isn't an integer from 1 to 65535.

`reconcileExposure(exposure, mounts, { checkOnly })` runs `ensure` then `check`, or only `check` with `checkOnly`. It resolves `{ ok, checkedAt, drift, added, error }` and never rejects, whatever the adapter throws: a failure comes back as `ok: false` with its message in `error`, and `added` still lists what `ensure` wrote. It doesn't check that the targets are gated, so to publish a conductor from outside it, call `runExpose`, which does.

`runExpose({ cfg, exposure, checkOnly = false, log = console, fetchFn, probeTimeoutMs = 5000 })` is the [expose CLI](#expose-cli)'s pass: `mountsFor(cfg)` then `reconcileExposure`, printed through `log`, resolving the CLI's exit code (`0`, `1` or `2`). A `cfg` without `exposure` or `harnessOrigin` resolves both as `startConductor` does. Without `checkOnly`, it first asks each target whether it is a gated conductor, and writes nothing unless all three are (see the [expose CLI](#expose-cli)). It gives each target up to `probeTimeoutMs`, a whole number of milliseconds from 1 to 2147483647 (anything else returns `2`).
- **`fetchFn`** takes fetch's arguments and must return fetch's `status`, `headers.get` and `body.cancel`. It defaults to plain HTTP over `node:http`, because `fetch` refuses some ports (`6000` and `10080`, among others) that a conductor may listen on, and may read a proxy from the environment.
- **The conductor's own loop doesn't ask:** it publishes only itself, and only in tailscale mode.

**Built in: `adapters/exposure-tailscale`.** `createTailscaleExposure({ execFileFn, bin = 'tailscale', socket = null, timeoutMs = 30000 })` drives `tailscale serve` on the host it runs on:
- `check` runs `tailscale serve status --json`. A mount is in place when its port serves https and its path proxies to its target (one trailing `/` ignored). It reads the status entry for the mount's `host:port`, else the first entry on that port.
- tailscaled hands a request to the deepest handler path that holds it, so a handler under a mount's path takes some of its requests: `/qa/` or `/qa/api` beside the harness's `/qa`, or any other path on a pane's port. `check` reports each one that doesn't proxy to the mount's target as drift.
- `ensure` reads the same status, then runs `tailscale serve --bg --https=<port> [--set-path=<path>] <target>` for each mount whose own handler is missing or points elsewhere, and only those. `--set-path` is left out for `/`. A handler that shadows a mount stays drift until you remove it: `ensure` never writes or removes it. A mount that fails doesn't stop the others, and `ensure` then rejects, naming each failure, with the mounts it did write as the error's `added`.
- Every call goes through `execFileFn` (`makeExecFileFn()` from `./exec`) with a `timeoutMs` timeout. With `socket` set, `--socket=<socket>` comes before the subcommand, for a CLI whose daemon's socket is somewhere else, such as one mounted into a container.
- `bin` is the CLI to run, and it should be no older than the daemon. On macOS, the `tailscale` on `PATH` may lag behind the app's daemon: use the app's bundled CLI, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

**What it never touches.** It never runs `tailscale serve reset` or `off`, so it never removes a handler, and it never changes one at a `(port, path)` it wasn't given:
- Another app's `/` handler on the harness's port stays beside the harness's `/qa`, since `tailscale serve` keeps a port's other paths. Give the harness a port of its own all the same: that app's pages would share the harness origin, so the panes and the harness API would take them for the harness.
- The flip side: a declared `(port, path)` is the conductor's. A pane origin on a port where another app serves `/` replaces that app's handler.
- **A changed origin or port leaves the old handler behind.** It keeps proxying to the conductor until you remove it with `tailscale serve --https=<old port> [--set-path=<path>] off`. Until then, browsers that reach the harness through it get `403 not the harness origin` from its API (see [Same-origin API](#security)), but the old URL still answers.

## Configuration

`loadConfig(path, { defaults, required = [] })` reads an env file, `.env.qa` by convention, into `cfg`. File values override `defaults`, and the raw map is returned as `cfg.env` so a platform can read its own keys. `required` lists extra keys the platform insists on (a platform may re-require `QA_OPERATOR_EMAIL`, say); it can't waive the core's.

### The env file

- One `KEY=value` per line. Blank lines, lines that start with `#` and lines with no `=` are skipped. Spaces around the key and the value are dropped, and a later line wins.
- A value in a matching pair of double or single quotes loses them. Nothing is unescaped or expanded, quoted or not: `$HOME` stays `$HOME`.
- No `export`: `export KEY=value` sets a key named `export KEY`, which nothing reads.
- No comment after a value: a `#` after a space or a tab in an unquoted value throws, naming the file, the line and the key, and so does a `#` after a quoted value's closing quote (`KEY="value" # note`), with a space between or not. Put the comment on a line of its own. A value with a space or a tab before a `#` needs quotes (`KEY="a # b"` is `a # b`), and inside them a `#` mustn't follow the quote character, which would read as the closing quote.
- **It holds a token.** Keep it out of git (`echo .env.qa >> .gitignore`) and readable by you alone: create it with `(umask 077 && touch .env.qa)`, or `chmod 600` it.

### Sample `.env.qa` files

On one machine, with everything on loopback and no identity gate:

```ini
GITHUB_QA_TOKEN=<token>
QA_REPO=acme/widget
# With both pane origins set, QA_PUBLIC_HOST isn't needed.
# The harness is at http://127.0.0.1:3100/qa/.
QA_BASE_ORIGIN=http://127.0.0.1:3101
QA_PR_ORIGIN=http://127.0.0.1:3102
```

On a tailnet, behind `tailscale serve` on the conductor's machine, `qa-box.tail1234.ts.net`:

```ini
GITHUB_QA_TOKEN=<token>
QA_REPO=acme/widget
# The harness is at https://qa-box.tail1234.ts.net:8444/qa/, the panes at :8443 and :10000.
QA_PUBLIC_HOST=qa-box.tail1234.ts.net
# Who may open them: Tailscale logins, as tailscale whois shows them.
QA_ALLOWED_LOGINS=alice@github,bob@example.com
```

That layout is tailscale mode: every server listens on loopback and answers only those logins (see [Security](#security)). The platform's [Exposure adapter](#exposure-optional) mounts the three servers on `tailscale serve`, or you do, with `tailscale serve --bg --https=8444 --set-path=/qa http://127.0.0.1:3100`, `tailscale serve --bg --https=8443 http://127.0.0.1:3101` and `tailscale serve --bg --https=10000 http://127.0.0.1:3102`.

### Tokens

`GITHUB_QA_TOKEN` reads the open PRs and posts each verdict, as the token's owner. Use a fine-grained personal access token with:
- **Repository access:** only the repository under QA.
- **Pull requests: read.** The PR list, and each PR's head and author.
- **Issues: read and write.** The verdict comment and label.
- **Metadata: read**, which GitHub grants with any other permission. It also covers the author's permission, which the trust gate checks.

Some built-ins need more than this token:
- `adapters/build-worktree` fetches with plain `git` over https, so a private repository needs a git credential helper that can read it.
- `createGithub`'s GHCR helpers list container package versions, which a fine-grained token can't. Set `QA_GHCR_TOKEN` to a classic token with `read:packages`, and pass `createGithub` the `packageName`.
- A BuildConvention that dispatches preview builds with `createGithub`'s `dispatchPreviewBuild`, and reads their runs with `findPreviewRun` or `awaitPreviewImage`, needs Actions: read and write.

### Keys

| Key | `cfg` | Default | |
|---|---|---|---|
| `GITHUB_QA_TOKEN` | `githubToken` | *(required)* | PR list, head and trust lookups, verdict comment + label ([Tokens](#tokens)) |
| `QA_GHCR_TOKEN` | `ghcrToken` | `GITHUB_QA_TOKEN` | for `createGithub({ packagesToken })`, with its `packageName`: the GHCR package version listing, which a fine-grained token can't call (use a classic PAT with `read:packages`), and a platform's registry login |
| `QA_REPO` | `repo` | *(required)* | `owner/name` |
| `QA_OPERATOR_EMAIL` | `operatorEmail` | `null` | the reviewer, passed to `establishSession` |
| `QA_PUBLIC_HOST` | `publicHost` | *(required unless both pane origins are set)*, else `null` | default host for the harness and pane origins; always an allowed `Host` |
| `QA_BIND_HOST` | `host` | `127.0.0.1` | the address all three servers listen on (`[::1]` is read as `::1`); must be loopback in tailscale mode (see [Security](#security)) |
| `QA_ALLOWED_HOSTS` | `allowedHosts` | *(none)* | extra comma-separated hostnames (no ports) the servers answer to |
| `QA_EXPOSURE` | `exposure` | `tailscale` if any address the conductor answers to or listens on is off loopback (see below), else `none` | `tailscale`: fronted by `tailscale serve --https` on this host, so the identity gate is on and the bind must be loopback. `none`: no gate (0.2's behaviour), for loopback or another authenticating front door. Anything else throws |
| `QA_ALLOWED_LOGINS` | `allowedLogins` | *(none)* | comma-separated Tailscale logins (as `tailscale whois` shows them, e.g. `alice@github`) allowed in when the gate is on; trimmed and lowercased. Required in tailscale mode |
| `QA_EXPOSURE_INTERVAL_MINUTES` | `exposureIntervalMinutes` | `5` | minutes between [exposure](#exposure-optional) reconcile passes, when the platform passes an Exposure adapter. Above `0` and at most `35791`, the longest a timer can wait (above it, Node would fire every millisecond); fractions are fine |
| `QA_TAILSCALE_BIN` | *(only `cfg.env`)* | `tailscale` | the tailscale CLI the [expose CLI](#expose-cli) and this repository's self-QA run, for an env file they read. On macOS, use the app's `/Applications/Tailscale.app/Contents/MacOS/Tailscale` when the one on `PATH` is older than the daemon. The conductor never reads it: a platform passes `bin` to `createTailscaleExposure` |
| `QA_HARNESS_PORT` / `QA_BASE_PROXY_PORT` / `QA_PR_PROXY_PORT` | `ports.harness` / `ports.base` / `ports.pr` | `3100` / `3101` / `3102` | listen ports |
| `QA_HARNESS_ORIGIN` | `harnessOrigin` | `https://<QA_PUBLIC_HOST>:8444`, else `http://<QA_BIND_HOST>:<QA_HARNESS_PORT>` on a loopback bind | the origin viewers open the harness at (any path dropped); the page is under `/qa/`. Required on a non-loopback bind with no public host. On port `0` the conductor derives it from the bound port. Not an IPv6 literal: on a `::1` bind, set `http://localhost:<port>` |
| `QA_BASE_ORIGIN` / `QA_PR_ORIGIN` | `paneOrigins.base` / `paneOrigins.pr` | `https://<QA_PUBLIC_HOST>:8443` / `https://<QA_PUBLIC_HOST>:10000` | the origins viewers reach the panes at |
| `QA_FRAME_ANCESTORS` | `frameAncestors` | *(none)* | extra comma-separated origins allowed to frame the panes, for a harness nested in a pane (self-QA's inner demos). CSP only: they pass no `Referer` check, and the bridge never talks to them |
| `QA_FORWARD_CLIENT_COOKIES` | `forwardClientCookies` | *(none)* | comma-separated names of the browser's own cookies the pane proxies pass to the pane apps, beside each pane's jar, whose value wins on a name both have. Unset, the apps get only the jar's cookies (see [Security](#security)). Each must be a cookie name (an RFC 6265 token); `*` and other wildcards throw. A single quote is part of a name, so quote the whole list or nothing, never each name: `'a','b'` names `a'` and `'b`. Any page on the panes' hostname can set these cookies, the other pane's scripts included, so a value that isn't an RFC 6265 cookie-value (one with a space, a comma, a backslash or a stray double quote) isn't passed. On one hostname both pane apps get the browser's one value of each, so name only cookies both panes may share, such as a preference, never a session |
| `QA_LABEL_ACCEPT` / `QA_LABEL_REJECT` | `verdictLabels.accept` / `verdictLabels.reject` | `qa-approved` / `qa-changes-requested` | verdict label pair |
| `QA_IDLE_MINUTES` | `idleMinutes` | `30` | idle sessions are torn down |

Every origin key must be an http(s) URL with a plain hostname. It is normalized to an origin (lowercased, a default port and any path dropped), and anything else throws. An `http:` harness or pane origin must be loopback (`127.0.0.0/8`, `::1`, `localhost`): browsers send the `Sec-Fetch-*` headers the request guards rely on only to https and loopback origins (see [Security](#security)). The harness and the two panes must be three different origins: a page that is same-origin with another could act for the reviewer there.

Unset, `QA_EXPOSURE` is `none` only when all of these are loopback, and `tailscale` otherwise: the harness origin (as derived above; when none can be derived, on a loopback bind on port `0` with no `QA_HARNESS_ORIGIN` or `QA_PUBLIC_HOST`, it adds nothing), both pane origins, `QA_PUBLIC_HOST` and every `QA_ALLOWED_HOSTS` entry (both widen the `Host` allowlist), and `QA_BIND_HOST`. So a non-loopback bind alone makes the mode `tailscale`, which then refuses that bind: behind another authenticating front door, set `QA_EXPOSURE=none`. In tailscale mode, `loadConfig` throws on a non-loopback `QA_BIND_HOST` and on an empty `QA_ALLOWED_LOGINS`, and each error says why the mode is `tailscale`.

### A `cfg` built in code

A platform that builds `cfg` in code instead of with `loadConfig` must set `ports`, `paneOrigins`, `verdictLabels` and `idleMinutes`, in the shapes the table's `cfg` column shows. Without `idleMinutes`, the idle reaper silently never ends a session. The core never reads `githubToken`, `ghcrToken`, `repo` or `env`: they are for the platform's own `createGithub` and adapters. `readBaseEnv` is optional too (see [Use](#use)).

It can leave out `operatorEmail`, `publicHost`, `host` (loopback is the default), `allowedHosts`, `harnessOrigin` (derived as above), `frameAncestors`, `forwardClientCookies` (none: `false` or an array of cookie names), `exposure`, `allowedLogins` and `exposureIntervalMinutes` (`5`). Without `exposure`, `startConductor` resolves the mode as `loadConfig` does, with `defaultExposure({ harnessOrigin, paneOrigins, publicHost, allowedHosts, host })` from `./config`, where a missing or unparseable pane origin counts as off loopback. The mode is fixed at start, so a `cfg` whose non-loopback origins are assigned after start must set `exposure` itself. `startConductor` refuses an unknown `exposure`, a `host` in brackets (write `::1`, not `[::1]`), tailscale mode on a non-loopback `host`, a `harnessOrigin` or `frameAncestors` entry that isn't an http(s) origin, an `http:` harness origin or pane origin (set at start) whose host isn't loopback, a harness origin equal to a pane origin, an `exposureIntervalMinutes` that isn't a number above `0` and at most `35791`, a `forwardClientCookies` that isn't `false` or an array of cookie names, and an `adapters.exposure` in none mode. Startup logs whether the gate is on and, for a defaulted mode, what made it `tailscale`. In tailscale mode with no `allowedLogins` it logs an error, and every request is refused. The core reads `cfg.paneOrigins` per request, so it may be assigned once the proxies are listening.

## HTTP API (harness port)

| | |
|---|---|
| `GET /` | harness UI |
| `GET /api/state` | session status, tags, `buildRun: {url, status, conclusion, message}`, pane login URLs + origins, `harnessOrigin` |
| `GET /api/prs` | open PRs with build readiness (`imageStatus`, `runUrl`, `reason`) |
| `GET /api/build-status?pr=N` | `{pr, status, exists, runUrl}`, plus `reason` when `status` is `blocked` |
| `GET /api/exposure` | the last [exposure](#exposure-optional) reconcile pass: `{mode, managed, ok, checkedAt, drift, added, error}`. Read-only: it never calls the front door. With no adapter, `managed` is `false` and `ok` and `checkedAt` are `null` |
| `GET /api/progress` | server-sent boot progress (`step`, `build`, `ready`, `error` with `logTail`, `torn-down`) |
| `POST /api/session` `{pr, takeover?}` | boot a session (one at a time; `takeover` replaces the current one) |
| `GET /api/verdict/preview?verdict=accept\|reject&notes=` | the comment + labels that would be posted |
| `POST /api/verdict` `{verdict, notes}` | post the verdict comment and set the label |
| `POST /api/teardown` `{}` | tear down the session (cancels an in-flight boot) |

Every path also answers under a `/qa` prefix. In tailscale mode, a request to any of the three ports without an allowed `Tailscale-User-Login` gets `403` before anything else, a plain `curl` from the host included: a script on the host can't read `/api/exposure`, so it runs the [expose CLI](#expose-cli) with `--check` instead. Every `/api/*` request must come from the harness page itself, and a browser must reach it at the harness origin's host and port (`403`, see [Security](#security)). POSTs must be `application/json` (`415`), and a request to any of the three ports with an unrecognised `Host` gets `421`. A request target the harness can't parse as a URL gets `400`, and once `shutdown()` has begun every harness write gets `503`. While no session is ready, the pane proxies answer `503`.

## Expose CLI

```sh
npx qa-conductor-expose --check   # report drift on the conductor's tailscale serve mounts; change nothing
npx qa-conductor-expose           # put any missing or wrong mount back now
npm run expose -- --check        # in this repo: self-QA's .env.qa, through self-QA's loader
```

`qa-conductor-expose` runs one [exposure](#exposure-optional) pass from a shell, through the built-in tailscale adapter. **It is a tool for operators and debugging.** The conductor's reconcile loop owns the mounts: it sets them once its servers listen and restores them every `QA_EXPOSURE_INTERVAL_MINUTES`. So a deploy only restarts the conductor, and runs neither this CLI nor `tailscale serve`. Use the CLI to see drift, or to restore a mount now instead of at the next pass.

**A plain run publishes only a gated conductor.** Before it writes anything, it sends each target a request over loopback with no `Tailscale-User-Login`: `GET /qa/api/state` on the harness port and `GET /` on each pane port.
- **What passes:** a conductor in tailscale mode answers each with its identity gate's `403`, marked `X-QA-Refusal: identity`. The CLI checks that header, not the body text.
- **What fails:** a target that answers anything else, such as a conductor in none mode, the demo, another server, another `403`, or a redirect (which isn't followed). So does one that doesn't answer within 5 seconds, or a port where nothing listens.
- **All or nothing:** if any target fails, the CLI writes no mount, runs no `tailscale` command and exits `2`, with a line for each failing target and one saying what to do:

```
qa exposure: 127.0.0.1:3101 (base) is not a gated conductor (got 200); refusing to publish it
qa exposure: 127.0.0.1:3102 (pr) is not a gated conductor (nothing listens there); refusing to publish it
qa exposure: nothing was mounted. Start the conductor in tailscale mode on these ports first, or use --check to only report drift
```

**What the check doesn't cover:**
- **Other processes on this host.** It guards against a wrong env file or a stopped conductor, not against another process on this host, which could answer with the same header.
- **Which conductor, or which role.** It checks that each target is gated, not that the harness port holds a harness or that all three belong to one conductor.
- **Later takeovers.** It holds only at the moment the CLI writes. Neither the CLI nor the conductor ever removes a mount, so once the conductor stops, its mounts publish whatever listens on those loopback ports next, with no identity gate.
- **`--check`.** A `--check` run sends no requests to the targets.

```
qa-conductor-expose [--check] [--env FILE] [--config MODULE[#export]] [--tailscale BIN] [--socket PATH] [--help|-h]
```

- **One code path.** It runs `runExpose({ cfg, exposure, checkOnly, log })` from `./exposure`, which is the conductor loop's own pass: `mountsFor(cfg)` on the configured ports, then `reconcileExposure`, which runs `ensure` then `check` (`check` alone with `--check`). Only the check of the targets above comes first, without `--check`. So the CLI and the loop can't disagree about what should be mounted. Like the loop, it never removes a handler. It targets `cfg.ports`, so a conductor on port `0` can only be mounted by its own loop.
- **`--env FILE`** is the conductor's own env file: by default `$QA_ENV_FILE`, else `./.env.qa`. The CLI loads it with `loadConfig`, as the conductor does, so the file needs `GITHUB_QA_TOKEN` and `QA_REPO` even though exposure ignores them.
- **`--config MODULE[#export]`** loads `cfg` with a platform's own loader instead, for an env file that leans on the platform's `defaults`. It imports `MODULE`, a file path from the working directory, and calls `export` (by default, the default export) with the env file's path. For example, `--config qa/self.mjs#loadSelfQaConfig` reads this repo's self-QA `.env.qa`, and a platform's container can pass its own loader the same way. In this repo, `npm run expose` passes self-QA's loader, since self-QA is the repo's only conductor; a `--config` after `--` overrides it, since the last one wins.
- **`--tailscale BIN`** is the CLI to run: by default `QA_TAILSCALE_BIN` in the env file, else `tailscale` on `PATH`. On macOS, use the app's `/Applications/Tailscale.app/Contents/MacOS/Tailscale` when the one on `PATH` is older than the daemon. **`--socket PATH`** passes `--socket=PATH` before the subcommand, for a daemon whose socket is elsewhere, such as one mounted into a container.
- **`--help`** or **`-h`** prints the usage and exits `0` before loading anything.

It prints a line for each mount it writes (`qa exposure: mounted <port><path> -> <target>`), and one for each mount still wrong (`qa exposure: drift <port><path>: want <target>, have <actual|nothing>`). A handler under a mount's path that takes some of its requests is named as one to remove, since the CLI never removes it. Then it prints any tailscale error, and finally `qa exposure: ok (harness <origin>/qa/)` once all three mounts are in place. In none mode it prints `qa exposure: QA_EXPOSURE=none, nothing to do`, since an ungated conductor must not publish itself. Drift and errors go to stderr, everything else to stdout.

| Exit | |
|---|---|
| `0` | every mount is in place (after writing any that weren't), or `QA_EXPOSURE=none`, or `--help` |
| `1` | drift remains, or tailscale failed |
| `2` | a bad flag or a config that doesn't load, with the usage on stderr; or, as one `qa exposure:` line, a mode, bind host or mount layout the conductor can't publish, such as an unknown `QA_EXPOSURE` from a `--config` loader, tailscale mode on a bind host that isn't loopback, an `http:` origin, two mounts on one port or a listen port `0`; or, without `--check`, a target that isn't a gated conductor, with a line for each and nothing mounted |

## Demo

```sh
npm run demo            # then open http://127.0.0.1:4100/
```

Open it at `127.0.0.1`: the panes trust only the harness origin, so at `localhost` the harness shows a banner and the panes stay blank.

Demo mode runs the real conductor with fixture PRs and fake adapters, so you can try the whole harness with no GitHub, containers or databases. Everything listens on `127.0.0.1`: the harness on `PORT` (default `4100`), and the pane proxies and the two in-process pane apps on free ports. The demo is always ungated (`exposure: 'none'`), whatever its harness origin: it binds loopback, and nested in self-QA it sits behind the outer conductor's gate. `QA_DEMO_SPEED` scales the fake build and boot delays (default `1`; `0` makes them instant). Ctrl-C (or SIGTERM/SIGHUP) stops it.

- **#101, #102** are built and open in seconds. **#103** is mid-build. **#104** builds, then its app crashes at *starting*, with a log tail. **#105** is refused by the trust gate (its head is in someone else's fork).
- The PR pane is visibly different from the base: a new heading, a purple accent and an extra sort control on *Products*. Both panes have several pages, forms and long pages, for trying mirroring.
- Verdicts go to an in-memory GitHub fake and are printed to the console. Nothing leaves the machine.

`demo/` is not published with the package. From code, `startDemo({ port, speed, log, harnessOrigin, frameAncestors })` in `demo/index.mjs` returns `{ stop(), ports }`. Without a `harnessOrigin` the core derives `http://127.0.0.1:<port>`. `QA_HARNESS_ORIGIN` and `QA_FRAME_ANCESTORS` set the last two from `npm run demo`.

## Known limits

- **One page of PRs.** The picker lists at most the 50 most recently opened PRs.
- **Mounts outlive the conductor.** Nothing removes a `tailscale serve` mount, so once the conductor stops, its mounts publish whatever listens on those loopback ports next, with no identity gate. The expose CLI refuses to write a mount for a target that isn't a gated conductor, but nothing stops another process taking the port later ([Expose CLI](#expose-cli)).
- **The panes' pages share the browser's cookies with every app on their hostname**, and can send those apps same-site requests that carry them. Serve the panes on a hostname no other app uses ([Security](#security)).
- **The identity gate keeps out other devices, not PR code** on the same host: a pane process, or a container pane outside native Linux Docker, can send any login ([Security](#security)).
- **A harness that shares an origin with another app** shares its trust. Give the harness a port of its own.
- **Browsers without Fetch Metadata** are judged by `Origin` alone, which is why an `http:` origin must be loopback.
- **An IPv6-literal harness origin** can't be named in `frame-ancestors`: on a `::1` bind, set `QA_HARNESS_ORIGIN=http://localhost:<port>`.
- **`X-Forwarded-For` reaches the pane apps**, so PR code sees which tailnet address is viewing.
- **The Docker Provisioner** runs one service per pane, with fixed container names and host ports, and logs in to `ghcr.io` only ([its section](#built-in-adaptersprovisioner-docker-docker-provisioner)). **The GHCR helpers** read packages a user owns, not an organization's.
- **The PR pane can still reach parts of the base pane.**
  - **With the Docker Provisioner,** each pane has its own network and its own database password, so on Docker Engine with its default iptables rules PR code can't reach the base pane's database directly. These gaps remain ([its section](#built-in-adaptersprovisioner-docker-docker-provisioner)):
    - where containers can reach the host's loopback (such as Docker Desktop, and some rootless runtimes), PR code can still reach the base pane's app, the base pane's proxy, which signs it in as the operator, and the harness;
    - with a non-loopback `QA_BIND_HOST`, it can reach the harness and the base pane's proxy on any runtime;
    - without Docker Engine's default iptables rules (`"iptables": false`, or Podman), it can reach the base pane's containers by address;
    - where the networks don't keep the panes apart, PR code can sign in to the base pane's database when the provisioner's `postgres.password` is set, since both panes use it, or when the image doesn't enforce the password ([`createDocker`'s `postgres.image`](#effect-wrappers)).
  - **With the process Provisioner,** both panes' processes run as your user on one host. So PR code can reach the base pane's database and app on loopback, its proxy and the harness, and its files and processes.
  - **With either:**
    - **One env:** both panes get the same `readBaseEnv` env, unless the EnvTransform gives each pane its own.
    - **One set of auth contributions:** `envContributions()` runs once per boot, and its values win over the EnvTransform's.
    - **What follows:** the PR pane holds the base app's secrets, and the address of any service the Provisioner doesn't create, such as a cache or a bucket. Through a service both panes use, PR code can change what the base pane reads. Give each pane its own value for every secret and stateful service you can.
    - **The mirror:** while it is on, PR code can drive the base pane through the harness ([Security](#security)).
  - The base pane is what the PR is compared with, so code that changes it, by mistake or on purpose, skews the comparison. The trust gate is still the boundary against PR code ([Security](#security)).
- **Linux and macOS only, and no TypeScript declarations yet** ([Requirements](#requirements)).

## Contributing

To work on qa-conductor itself, read [CONTRIBUTING.md](CONTRIBUTING.md): how to run the tests, the commit style, how to QA a pull request in the conductor's own harness (`npm run qa`), and how a release is cut.

## Reporting a vulnerability

Please report it privately, as [SECURITY.md](SECURITY.md) describes, never with its details in a public issue.

## License

[MIT](LICENSE)
