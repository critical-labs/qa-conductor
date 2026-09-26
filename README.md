# qa-conductor

A side-by-side PR-QA harness. For a pull request it boots two copies of your app: **base** (what's live now) and **PR** (the branch). Each runs against its own clone of real data, behind proxies that mirror scrolling and navigation between the two panes. A reviewer drives both at once and posts a verdict (a comment plus a label) back to the PR.

The conductor owns the choreography: session state, cancellation, the harness UI and API, the pane proxies and the verdict. Everything about *your* app and infrastructure comes from five adapters you supply.

> **Status: 0.x, pre-release.** The interface may still change while a second consumer is integrated. Install from git; nothing is published to npm yet.

## Install

```sh
npm install github:critical-labs/qa-conductor#v0.1.0
```

Node ≥ 22. There are no runtime dependencies. While the repo is private, installing needs a GitHub credential that can read it.

## Use

```js
import fs from 'node:fs'
import { startConductor } from '@critical-labs/qa-conductor'
import { loadConfig } from '@critical-labs/qa-conductor/config'
import { createGithub } from '@critical-labs/qa-conductor/github'

const cfg = loadConfig('/path/to/.env.qa', { defaults: { QA_REPO: 'acme/widget' } })
const github = createGithub({ token: cfg.githubToken, repo: cfg.repo, qaLabels: [cfg.verdictLabels.accept, cfg.verdictLabels.reject] })

startConductor({
  cfg,
  github,
  fsx: { readFile: p => fs.promises.readFile(p) },   // serves the harness UI files
  adapters: { provisioner, build, seed, envTransform, auth },
  readBaseEnv: async () => ({ /* the env the pane env is derived from */ }),
})
```

`startConductor` serves the harness on `cfg.ports.harness` and one proxy per pane on `cfg.ports.base` / `cfg.ports.pr`. It returns `{ servers, stop() }`.

Put your own TLS/auth front door in front of these ports (homefree uses `tailscale serve`). `cfg.paneOrigins` must be the URLs viewers actually reach the panes at.

## The five seams

A boot runs these seams in order: `ensureBuilt` → per pane (`provisionDatabase` → `seedPane` → `reserveServices`) → `derivePaneEnv` (+ `runMigrate`) → `launchServices` → `waitHealthy` → `establishSession`.

| Seam | Members | Owns |
|---|---|---|
| **Provisioner** | `provisionDatabase({paneRef, databases}) → {dsn, db}`, `reserveServices({paneRef, services}) → {name: {url, port}}`, `launchServices({paneRef, services, env, reserved})`, `waitHealthy({services})`, `teardown({paneRef})`; optional `runMigrate({paneRef, migrate, env})`, `sweep()`, `logs({paneRef, stage, lines})` | Where panes run: databases, processes or containers, ports, env at rest, cleanup |
| **BuildConvention** | `migrationStrategy` (`'one-shot-image' \| 'on-boot' \| 'none'`), `ensureBuilt(pr, {signal})`, `resolvePrImages(pr)`, `resolveBaseImages()` → `{services: {name: ref}, migrate?}`; optional `subscribeBuild(cb)`, `describePrs(prs) → [{number, status: 'built'\|'building'\|'none', runUrl}]` | What gets run for base and PR, and whether it's ready |
| **Seed** | `databases`, `seedPane({paneRef, db, databases})` | Where each pane's data comes from and how it moves |
| **EnvTransform** | `derivePaneEnv({prodEnv, pane}) → {service: env}` (pure) | Pointing a pane at its own DB and origin, and neutralizing side effects (email, payments, storage) |
| **AuthBootstrap** | `requiresDb`, `establishSession({pane, operator, db?}) → {landingUrl, cookies?, replay?}`; optional `envContributions()` | Getting the reviewer logged in to each pane |

The optional members degrade gracefully when absent:
- With no `sweep`, nothing is cleaned up at startup.
- With no `logs`, failures show no log tail.
- With no `describePrs`, every PR shows as `none`.

The one exception: a build that declares `one-shot-image` migrations with a Provisioner that can't `runMigrate` fails the boot with a clear error.

**Built in:** `adapters/provisioner-docker` is a Provisioner for docker-sibling deployments. It creates the pane postgres containers, one app container per pane, `0600` env files under `workDir`, registry login and a labelled-orphan sweep. The `docker`, `github` and `exec` modules are the effect wrappers it and the reference adapters use.

**Reference consumer:** homefree's platform adapters (Docker + GHCR + `pg_dump` from the prod database + a magic-link login).

## Configuration

`loadConfig(path, { defaults })` reads `KEY=value` lines. File values override `defaults`, and the raw map is returned as `cfg.env` so a platform can read its own keys.

| Key | Default | |
|---|---|---|
| `GITHUB_QA_TOKEN` | *(required)* | PR list, head lookups, verdict comment + label |
| `QA_OPERATOR_EMAIL` | *(required)* | the reviewer, passed to `establishSession` |
| `QA_REPO` | *(required)* | `owner/name` |
| `QA_PUBLIC_HOST` | *(required)* | default host for the pane origins |
| `QA_HARNESS_PORT` / `QA_BASE_PROXY_PORT` / `QA_PR_PROXY_PORT` | `3100` / `3101` / `3102` | listen ports |
| `QA_BASE_ORIGIN` / `QA_PR_ORIGIN` | `https://<host>:8443` / `:10000` | public pane origins |
| `QA_LABEL_ACCEPT` / `QA_LABEL_REJECT` | `qa-approved` / `qa-changes-requested` | verdict label pair |
| `QA_IDLE_MINUTES` | `30` | idle sessions are torn down |

## HTTP API (harness port)

| | |
|---|---|
| `GET /` | harness UI |
| `GET /api/state` | session status, tags, pane login URLs + origins |
| `GET /api/prs` | open PRs with build readiness |
| `GET /api/build-status?pr=N` | `{pr, status, exists, runUrl}` |
| `GET /api/progress` | server-sent boot progress |
| `POST /api/session` `{pr, takeover?}` | boot a session (one at a time; `takeover` replaces the current one) |
| `GET /api/verdict/preview?verdict=accept\|reject&notes=` | the comment + labels that would be posted |
| `POST /api/verdict` `{verdict, notes}` | post the verdict comment and set the label |
| `POST /api/teardown` | tear down the session (cancels an in-flight boot) |

While no session is ready, the pane proxies answer `503`.

## Develop

```sh
npm test
```

The suite runs on `node:test` with injected effects, so it needs no Docker, network or GitHub.
