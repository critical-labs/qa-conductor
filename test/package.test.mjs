// The npm package and its publish workflow. A tag stages whatever these
// files say, and a maintainer approves it on npmjs.com, so the things that
// would make a release wrong are pinned here: what the tarball carries, that
// every export is in it, and that the workflow stages only the tag's version
// and never publishes directly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const WORKFLOW = path.join(ROOT, '.github/workflows/publish.yml')
const TAG_CHECK = 'Check the tag matches package.json'
const CHANGELOG = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')

// The CHANGELOG's second-level headings: `## [Unreleased]` while changes
// wait for a release, then one dated `## [X.Y.Z] — YYYY-MM-DD` per release,
// newest first. Each bracketed name is a link, defined at the end of the
// file (Keep a Changelog's layout).
const changelogHeadings = () => [...CHANGELOG.matchAll(/^## (.*)$/gm)].map(match => match[1])
const RELEASE_HEADING = /^\[(\d+\.\d+\.\d+)\] — \d{4}-\d{2}-\d{2}$/
const UNRELEASED = '[Unreleased]'
const REPO_URL = 'https://github.com/critical-labs/qa-conductor'
const releases = () => changelogHeadings().map(heading => RELEASE_HEADING.exec(heading)?.[1]).filter(Boolean)

// npm packs these whatever `files` says.
const ALWAYS_PACKED = /^(package\.json|README(\.[^/]*)?|LICEN[CS]E(\.[^/]*)?|CHANGELOG(\.[^/]*)?)$/i

const rel = target => target.replace(/^\.\//, '')
const targetsOf = value =>
  typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(targetsOf) : []
const shipped = () => [
  ...targetsOf(pkg.exports),
  ...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {})),
  ...(pkg.main ? [pkg.main] : []),
].map(rel)
const inFiles = file =>
  ALWAYS_PACKED.test(file) ||
  pkg.files.some(entry => {
    const dir = rel(entry).replace(/\/$/, '')
    return file === dir || file.startsWith(`${dir}/`)
  })

// The lifecycle scripts npm runs when it packs or publishes a directory.
// Staged from a tarball, npm runs none of them. The test job's `npm pack`
// still runs prepack, prepare and postpack (with no token), and a directory
// publish would run them all with the token, so the package defines none.
const PUBLISH_SCRIPTS = ['prepublish', 'prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish']

// The workflow's lines without blank lines and full-line comments, so prose
// that names a command can't satisfy, or trip, a check meant for the commands.
// Trailing ` #` comments stay: inside a `run: |` block or quotes a `#` is not
// a YAML comment, so stripping one could hide a command, and a check that
// trips on a real comment fails safe.
const contentLines = text =>
  text
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line && !/^\s*#/.test(line))

// The lines under each top-level key, which must each appear once.
function topLevel(lines) {
  const blocks = new Map()
  let key
  for (const line of lines) {
    if (/^\S/.test(line)) {
      key = /^([\w-]+):/.exec(line)?.[1]
      assert.ok(key && !blocks.has(key), `top-level line "${line}" is a key that appears once`)
      blocks.set(key, [line])
    } else {
      assert.ok(key, `"${line}" is under a top-level key`)
      blocks.get(key).push(line)
    }
  }
  return blocks
}

// The job's steps, each as { key: [its value, ...the lines under it] }.
function jobSteps(lines) {
  const steps = []
  let key
  for (const line of lines) {
    const item = /^ {6}- (.*)$/.exec(line)
    const text = item ? item[1] : /^ {8}/.test(line) ? line.slice(8) : undefined
    assert.ok(text !== undefined && (item || steps.length), `"${line.trim()}" belongs to a step`)
    if (item) steps.push({})
    const field = /^([\w-]+):(?: (.*))?$/.exec(text)
    // At a step key's own indent, only a plain key: YAML also reads
    // `"if": false` or `if : false` as one, which the check must not take for
    // more of the previous key's value.
    assert.ok(field || !(item || /^ {8}\S/.test(line)), `"${line.trim()}" is a plain step key`)
    if (field) {
      key = field[1]
      assert.ok(!(key in steps.at(-1)), `a step sets ${key} once`)
      steps.at(-1)[key] = [field[2] ?? '']
    } else {
      assert.ok(!item, `step "${line.trim()}" starts with a key`)
      steps.at(-1)[key].push(text.trim())
    }
  }
  return steps
}

// The jobs under `jobs:`, in order, each as { header, steps }: the header maps
// each job key to [its value, ...the lines under it], and steps are
// jobSteps's.
function jobsOf(block) {
  const bodies = new Map()
  let body
  for (const line of block.slice(1)) {
    const name = /^ {2}([\w-]+):$/.exec(line)?.[1]
    if (name) {
      assert.ok(!bodies.has(name), `job ${name} appears once`)
      bodies.set(name, (body = []))
    } else {
      assert.ok(body && /^ {4}/.test(line), `"${line.trim()}" belongs to a job`)
      body.push(line)
    }
  }
  return new Map([...bodies].map(([name, lines]) => {
    const at = lines.indexOf('    steps:')
    assert.ok(at >= 0, `job ${name} has steps`)
    const header = {}
    let key
    for (const line of lines.slice(0, at)) {
      const field = /^ {4}([\w-]+):(?: (.*))?$/.exec(line)
      if (field) {
        key = field[1]
        assert.ok(!(key in header), `job ${name} sets ${key} once`)
        header[key] = [field[2] ?? '']
      } else {
        assert.ok(key && /^ {6}\S/.test(line), `"${line.trim()}" is under a key of job ${name}`)
        header[key].push(line.trim())
      }
    }
    return [name, { header, steps: jobSteps(lines.slice(at + 1)) }]
  }))
}

// npm pack names the tarball <scope>-<name>-<version>.tgz.
const TARBALL = pkg.name.replace(/^@/, '').replace('/', '-')
const ON_MAIN = 'Check the tagged commit is on main'
const ON_MAIN_EARLY = 'Check the tagged commit is on main, before the approval'
const TARBALL_CHECK = 'Check the tarball is the tag\'s version'
// `./` makes it a file: npm reads release/x.tgz as the GitHub repo release/x.tgz.
// --registry pins the default registry, which a tarball's
// publishConfig.registry would otherwise outrank; the publishConfig check
// refuses any other key there (a scoped registry, a proxy) that --registry
// would not override.
const STAGE_RUN = `npm stage publish "./release/${TARBALL}-\${GITHUB_REF_NAME#v}.tgz" --access public --registry https://registry.npmjs.org/`
// One npm, by exact version: the job that runs it holds the token. CI's
// Node 22 leg installs the same npm after the suite, then runs this file
// again, so the publishConfig check's test reads tarballs with the npm that
// stages them.
const NPM_UPGRADE = 'npm install -g --ignore-scripts npm@11.21.0'
// The publish job's scripts, whole: these two run git and ls, the
// publishConfig check below runs node with npm's own pacote, and the stage
// runs npm. None runs code from the repository.
const ON_MAIN_SCRIPT = [
  'git init --quiet "$RUNNER_TEMP/main-history"',
  'cd "$RUNNER_TEMP/main-history"',
  'git fetch --quiet --no-tags "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git" +refs/heads/main:refs/remotes/origin/main',
  'if ! git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main; then',
  '  echo "::error::$GITHUB_REF_NAME ($GITHUB_SHA) is not on main: tag a commit main has merged"',
  '  exit 1',
  'fi',
  'git rev-list --first-parent refs/remotes/origin/main > "$RUNNER_TEMP/main-first-parent"',
  'if ! grep -qxF "$GITHUB_SHA" "$RUNNER_TEMP/main-first-parent"; then',
  '  echo "::error::$GITHUB_REF_NAME ($GITHUB_SHA) was merged into main but never was main: tag main\'s merge commit"',
  '  exit 1',
  'fi',
].join('\n')
const TARBALL_CHECK_SCRIPT = [
  `want="${TARBALL}-\${GITHUB_REF_NAME#v}.tgz"`,
  'have="$(ls -A release)"',
  'if [ "$have" != "$want" ]; then',
  '  echo "::error::the test job\'s tarball is $have, not $want"',
  '  exit 1',
  'fi',
].join('\n')
// npm applies a tarball's publishConfig to the stage, any key in it: a scoped
// registry or a proxy there would send the stage, token and all, elsewhere,
// whatever --registry says. So the publish job reads the tarball's manifest the
// way the stage will: with the npm on PATH's own pacote.manifest and the same
// read options (fullMetadata, fullReadJson) npm's publish passes it. npm's
// other options only affect caching and file modes for a tarball. That npm,
// not repository code, unpacks the tarball, so no second entry, pax header or
// extra gzip member can hand npm a manifest the check didn't see. Refusal is
// the default exit code: only an exact match clears it, so a read that never
// settles fails the step too.
const PUBLISH_CONFIG_CHECK = 'Check the tarball\'s publishConfig'
const PUBLISH_CONFIG_SCRIPT = [
  'node -e \'',
  '  const path = require("node:path")',
  '  const { realpathSync } = require("node:fs")',
  '  const { isDeepStrictEqual } = require("node:util")',
  '  process.exitCode = 1',
  '  const root = path.dirname(path.dirname(realpathSync(process.argv[2])))',
  '  const pacote = require(path.join(root, "node_modules", "pacote"))',
  '  pacote.manifest(`file:${process.argv[1]}`, { fullMetadata: true, fullReadJson: true }).then(manifest => {',
  '    if (isDeepStrictEqual(manifest.publishConfig, { "access": "public", "provenance": true })) {',
  '      process.exitCode = 0',
  '      return',
  '    }',
  '    console.log("::error::the tarball publishConfig is not exactly {access: public, provenance: true}, and the rest of it would apply to the stage")',
  '  }, err => {',
  '    console.log(`::error::cannot read the tarball manifest: ${err.code ?? err.message}`)',
  '  })',
  `' "./release/${TARBALL}-\${GITHUB_REF_NAME#v}.tgz" "$(command -v npm)"`,
].join('\n')
const SHA_PINNED = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}( # \S+)?$/
// A `run: |` step's lines as jobSteps reads them.
const runLines = script => ['|', ...script.split('\n').map(line => line.trim())]

// Throws unless the workflow runs on v* tags only, in two jobs:
// - test: no secrets and no id-token; before any checkout it checks that the
//   tagged commit was main itself, then checks the tag, runs the tests and
//   packs the tarball;
// - publish: after test, behind the npm-release environment; it checks the
//   commit again, checks the tarball's name and publishConfig, then stages
//   it, the token in the stage step alone, and runs no code from the
//   repository.
// It reads the file as text, so it catches mistakes, not every way a shell
// could spell a command: the stage-only token is what refuses a plain publish.
function assertStagesOnly(text) {
  const lines = contentLines(text)
  const blocks = topLevel(lines)
  assert.deepEqual([...blocks.keys()], ['name', 'on', 'permissions', 'jobs'], 'no workflow-level env, defaults, concurrency or other key')
  assert.deepEqual(blocks.get('on'), ['on:', '  push:', '    tags: ["v*"]'], 'runs on pushed v* tags only')
  assert.deepEqual(blocks.get('permissions'), ['permissions: {}'], 'no permission at workflow level: each job asks for its own')

  const jobs = jobsOf(blocks.get('jobs'))
  assert.deepEqual([...jobs.keys()], ['test', 'publish'], 'two jobs, test and publish, and no other')
  const test = jobs.get('test')
  const publish = jobs.get('publish')
  // Any other job key could skip a job (if), hand it the token or an id-token
  // (env, secrets, permissions), or run it somewhere else (container,
  // services, defaults).
  assert.deepEqual(Object.keys(test.header), ['runs-on', 'timeout-minutes', 'permissions'], 'the test job has no env, if, environment, needs or other key')
  assert.deepEqual(test.header.permissions, ['', 'contents: read'], 'the test job reads the repository and has no id-token')
  assert.deepEqual(Object.keys(publish.header), ['needs', 'runs-on', 'timeout-minutes', 'environment', 'permissions'], 'the publish job has no env, if or other key')
  assert.deepEqual(publish.header.needs, ['test'], 'publish runs after test passes')
  assert.deepEqual(publish.header.environment, ['npm-release'], 'publish waits for approval of the npm-release environment')
  assert.deepEqual(publish.header.permissions, ['', 'contents: read', 'id-token: write'], 'id-token (provenance) in the publish job alone')
  for (const job of [test, publish]) {
    assert.deepEqual(job.header['runs-on'], ['ubuntu-latest'])
    assert.match(job.header['timeout-minutes'][0], /^\d+$/)
  }

  // Any other step key could skip a gate or let it fail (if,
  // continue-on-error), or run a step's command some other way (shell,
  // working-directory).
  assert.deepEqual(
    test.steps.map(step => Object.keys(step).join(' ')),
    ['name run', 'uses with', 'uses with', 'name run', 'run', 'run', 'uses with'],
    'test: the on-main check, checkout, setup-node, the tag check, npm test, npm pack, the upload, and nothing else',
  )
  assert.deepEqual(
    publish.steps.map(step => Object.keys(step).join(' ')),
    ['name run', 'uses with', 'run', 'uses with', 'name run', 'name run', 'name run env'],
    'publish: the on-main check, setup-node, the npm upgrade, the download, the tarball and publishConfig checks, then the stage, and nothing else',
  )
  for (const step of [...test.steps, ...publish.steps].filter(step => step.uses)) {
    assert.match(step.uses[0], SHA_PINNED, `${step.uses[0]} is pinned to a commit SHA`)
  }

  const [earlyOnMain, checkout, testNode, tagCheck, tests, pack, upload] = test.steps
  // The same check as publish's, first and before any checkout, so a tag on
  // a commit main never was fails before anyone is asked to approve it.
  assert.deepEqual(earlyOnMain.name, [ON_MAIN_EARLY])
  assert.deepEqual(earlyOnMain.run, runLines(ON_MAIN_SCRIPT), 'the early on-main check is publish\'s, word for word')
  assert.match(checkout.uses[0], /^actions\/checkout@/)
  assert.deepEqual(checkout.with, ['', 'persist-credentials: false'])
  assert.match(testNode.uses[0], /^actions\/setup-node@/)
  assert.deepEqual(testNode.with, ['', 'node-version: 22', 'package-manager-cache: false'], 'no cache a release could restore, and no registry: the test job never publishes')
  assert.deepEqual(tagCheck.name, [TAG_CHECK])
  assert.equal(tagCheck.run[0], '|')
  assert.deepEqual(tests.run, ['npm test'], 'a failing test fails the job')
  assert.deepEqual(pack.run, ['npm pack'])
  assert.match(upload.uses[0], /^actions\/upload-artifact@/)
  assert.deepEqual(upload.with, ['', 'name: tarball', `path: ${TARBALL}-*.tgz`, 'if-no-files-found: error', 'retention-days: 30'])

  const [onMain, publishNode, upgrade, download, tarballCheck, publishConfigCheck, stage] = publish.steps
  assert.deepEqual(onMain.name, [ON_MAIN])
  assert.deepEqual(onMain.run, runLines(ON_MAIN_SCRIPT), 'the on-main check runs git alone, first')
  assert.match(publishNode.uses[0], /^actions\/setup-node@/)
  assert.deepEqual(publishNode.with, ['', 'node-version: 22', 'registry-url: https://registry.npmjs.org', 'package-manager-cache: false'], 'no cache a release could restore')
  assert.deepEqual(upgrade.run, [NPM_UPGRADE], 'staged publishing needs npm 11.15 or later; this one, exactly')
  assert.match(download.uses[0], /^actions\/download-artifact@/)
  assert.deepEqual(download.with, ['', 'name: tarball', 'path: release'])
  assert.deepEqual(tarballCheck.name, [TARBALL_CHECK])
  assert.deepEqual(tarballCheck.run, runLines(TARBALL_CHECK_SCRIPT))
  assert.deepEqual(publishConfigCheck.name, [PUBLISH_CONFIG_CHECK])
  assert.deepEqual(publishConfigCheck.run, runLines(PUBLISH_CONFIG_SCRIPT), 'the publishConfig check reads the manifest with the stage\'s own npm, before the stage')
  assert.deepEqual(stage.run, [STAGE_RUN])
  assert.deepEqual(stage.env, ['', 'NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}', 'NPM_CONFIG_PROVENANCE: "true"'], 'the stage step gets the token')

  // The publishConfig check's own lines, pinned word for word above, name npm
  // (whose manifest reader they load) and publishConfig, and run no npm
  // command and no publish: the two checks below leave them out.
  const publishConfigLines = new Set(PUBLISH_CONFIG_SCRIPT.split('\n').map(line => line.trim()))
  // Across every line, block scripts included. npm expands any unambiguous
  // abbreviation (`npm pub`, `npm pu`), so every npm or npx line must be one
  // of the four the workflow needs, not just free of the word publish. (The
  // environment's name, pinned above, is a name, not a command.)
  assert.deepEqual(
    lines.filter(line => /\bnp[mx]\b/.test(line) && line !== '    environment: npm-release' && !publishConfigLines.has(line.trim())).map(line => line.trim()),
    ['- run: npm test', '- run: npm pack', `- run: ${NPM_UPGRADE}`, `run: ${STAGE_RUN}`],
    'every npm or npx command is one of the four the workflow needs',
  )
  // No third-party publish action or other publisher (pnpm, yarn): apart from
  // names, the stage command is the only line that says pub.
  assert.deepEqual(
    lines.filter(line => /pub/i.test(line) && !/^\s*(-\s+)?name:|^ {2}publish:$/.test(line) && !publishConfigLines.has(line.trim())).map(line => line.trim()),
    [`run: ${STAGE_RUN}`],
    'the stage command is the only publish',
  )
  assert.deepEqual(
    lines.filter(line => line.includes('${{')).map(line => line.trim()),
    ['NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'],
    'the token is the only expression, so it reaches the stage step alone',
  )
  // Quoted or spaced too: YAML reads `"if": false` and `if : false` as keys.
  assert.doesNotMatch(lines.join('\n'), /^\s*(-\s+)?["']?(if|continue-on-error)["']?\s*:/m, 'no gate can be skipped or allowed to fail')
}

// The `run: |` block of the step with this name, dedented.
function stepScript(yaml, name) {
  const lines = yaml.split('\n')
  const at = lines.findIndex(line => line.trim() === `- name: ${name}`)
  assert.ok(at >= 0, `the publish workflow has no step named "${name}"`)
  // Once: a second match, such as a decoy inside another step's script, could
  // stand in for the real one.
  assert.equal(lines.filter(line => line.trim() === `- name: ${name}`).length, 1, `one line names the step "${name}"`)
  const stepIndent = lines[at].indexOf('-')
  for (let i = at + 1; i < lines.length; i++) {
    const indent = lines[i].search(/\S/)
    if (indent !== -1 && indent <= stepIndent) break
    const run = /^(\s*)run: \|\s*$/.exec(lines[i])
    if (!run) continue
    const block = []
    for (const line of lines.slice(i + 1)) {
      const ind = line.search(/\S/)
      if (ind !== -1 && ind <= run[1].length) break
      block.push(line)
    }
    const strip = Math.min(...block.filter(line => line.trim()).map(line => line.search(/\S/)))
    return block.map(line => line.slice(strip)).join('\n')
  }
  assert.fail(`step "${name}" has no run: | block`)
}

test('the package is publishable: not private, public access, provenance from this repository', () => {
  assert.equal(pkg.name, '@critical-labs/qa-conductor')
  assert.notEqual(pkg.private, true, 'npm refuses to publish a private package')
  assert.equal(pkg.publishConfig?.access, 'public', 'a scoped package is restricted unless published public')
  assert.equal(pkg.publishConfig?.provenance, true)
  // npm checks the provenance statement's repository against this field.
  assert.match(pkg.repository?.url ?? '', /github\.com\/critical-labs\/qa-conductor(\.git)?$/)
})

// npm fills in homepage and bugs from repository, but only on the registry:
// spelled out, they match agent-identity's and show in the tarball too.
test('the npm page names its author, links back to the repository, and has a description that fits a search result', () => {
  assert.equal(pkg.author, 'Critical Labs')
  assert.equal(pkg.homepage, 'https://github.com/critical-labs/qa-conductor#readme')
  assert.deepEqual(pkg.bugs, { url: 'https://github.com/critical-labs/qa-conductor/issues' })
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, 'keywords')
  for (const keyword of pkg.keywords) assert.match(keyword, /^[a-z0-9-]+$/, `keyword ${keyword}`)
  assert.ok(pkg.description.length <= 130, `the description is ${pkg.description.length} characters, more than a search result shows`)
})

test('a release names one version: package.json, the CHANGELOG\'s newest release and the README\'s git-tag pin', () => {
  // A tag stages package.json's version, so the notes and the install line
  // a consumer reads must be that version's.
  const headings = changelogHeadings()
  headings.forEach((heading, i) => {
    assert.ok(RELEASE_HEADING.test(heading) || (heading === UNRELEASED && i === 0), `CHANGELOG heading "## ${heading}" is a dated version (or ${UNRELEASED}, first)`)
  })
  const versions = releases()
  for (let i = 1; i < versions.length; i++) {
    // numeric collation compares 0.10.0 and 0.9.0 field by field
    assert.ok(versions[i - 1].localeCompare(versions[i], 'en', { numeric: true }) > 0, `${versions[i - 1]} is newer than ${versions[i]}`)
  }
  assert.equal(versions[0], pkg.version, 'the newest CHANGELOG release is the package.json version')
  const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  // to the end of the code span it sits in, if any
  const pins = [...README.matchAll(/github:critical-labs\/qa-conductor#([^\s`'")]+)/g)].map(match => match[1])
  assert.ok(pins.length > 0, 'the README shows a git-tag pin')
  for (const pin of pins) assert.equal(pin, `v${pkg.version}`, 'the README\'s git-tag pin is this version\'s tag')
})

// Each heading's link shows what changed in it: Unreleased since the newest
// tag, each release since the one before, and the first release its tag.
test('every CHANGELOG heading links to its changes, and the CHANGELOG defines no other link', () => {
  const versions = releases()
  assert.ok(versions.length > 0, 'the CHANGELOG has a release')
  const want = new Map()
  if (changelogHeadings()[0] === UNRELEASED) want.set('Unreleased', `${REPO_URL}/compare/v${versions[0]}...HEAD`)
  versions.forEach((version, i) => {
    const previous = versions[i + 1]
    want.set(version, previous ? `${REPO_URL}/compare/v${previous}...v${version}` : `${REPO_URL}/releases/tag/v${version}`)
  })
  const defined = [...CHANGELOG.matchAll(/^\[([^\]]+)\]: *(\S+)$/gm)].map(match => [match[1], match[2]])
  assert.deepEqual(defined, [...want], 'one link per heading, newest first, at the end of the file')
  assert.match(CHANGELOG, /\n\n(\[[^\]]+\]: \S+\n)+$/, 'the links end the file')
})

test('every exports and bin target exists and is inside a files entry', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'without files, npm packs the whole repo')
  for (const entry of pkg.files) assert.doesNotMatch(entry, /[*?[{!]/, `files entry ${entry}: this test reads entries literally`)
  const targets = shipped()
  assert.ok(targets.includes('lib/server.mjs'), 'the main export')
  for (const target of targets) {
    assert.ok(existsSync(path.join(ROOT, target)) && statSync(path.join(ROOT, target)).isFile(), `${target} exists`)
    assert.ok(inFiles(target), `${target} is inside one of files ${JSON.stringify(pkg.files)}`)
  }
})

test('the bin is the expose CLI, run by node from npx and by npm run expose', () => {
  // No leading ./: npm pkg fix strips it, and a publish would warn that it
  // auto-corrected package.json.
  assert.deepEqual(pkg.bin, { 'qa-conductor-expose': 'bin/qa-conductor-expose.mjs' })
  // npm links a bin as is: without the #! line, npx would hand it to the shell
  for (const target of Object.values(pkg.bin)) {
    assert.match(readFileSync(path.join(ROOT, target), 'utf8'), /^#!\/usr\/bin\/env node\n/, `${target} starts with #!/usr/bin/env node`)
  }
  // In this repo it is self-QA's, the repo's only conductor: self-QA's .env.qa
  // leaves QA_REPO to its loader, so the core loadConfig would refuse it. A
  // later --config wins (test/expose-cli.test.mjs).
  assert.equal(pkg.scripts.expose, 'node bin/qa-conductor-expose.mjs --config qa/self.mjs#loadSelfQaConfig')
})

test('npm pack --dry-run packs lib/, public/ and bin/, and no test/, demo/, qa/, docs/ or .github files', { timeout: 90_000 }, async () => {
  const { stdout } = await execFileP('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const [result] = JSON.parse(stdout)
  assert.equal(result.name, pkg.name)
  assert.equal(result.version, pkg.version)
  // The name the publish workflow uploads, checks and stages.
  assert.equal(result.filename, `${TARBALL}-${pkg.version}.tgz`)
  const packed = result.files.map(file => file.path)
  assert.ok(packed.some(file => file.startsWith('lib/')), 'lib/ is packed')
  assert.ok(packed.some(file => file.startsWith('public/')), 'public/ is packed')
  assert.ok(packed.some(file => file.startsWith('bin/')), 'bin/ is packed')
  for (const file of ['package.json', 'public/index.html', 'public/harness.js', 'public/bridge.js', 'bin/qa-conductor-expose.mjs', ...shipped()]) {
    assert.ok(packed.includes(file), `${file} is packed`)
  }
  for (const file of packed) {
    assert.doesNotMatch(file, /^(test|demo|qa|docs|\.github)\//, `${file} must not be published`)
    assert.doesNotMatch(file, /(^|\/)(\.env|\.npmrc)/, `${file} must not be published`)
    assert.ok(inFiles(file), `${file} is outside files ${JSON.stringify(pkg.files)}`)
  }
})

// CONTRIBUTING.md's approver check (Releasing, step 5), word for word: the
// one inline command that starts with the SHA's shape check.
function approverCheck() {
  const text = readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8')
  const commands = [...text.slice(text.indexOf('\n## Releasing\n')).matchAll(/`(\[\[ \$sha =~ [^`]+)`/g)].map(m => m[1])
  assert.equal(commands.length, 1, 'the Releasing section has one approver check')
  return commands[0]
}

test('CONTRIBUTING\'s approver check finds a commit main itself was, and refuses one that tags or refs named main point at', { timeout: 60_000 }, async t => {
  const CANONICAL = 'https://github.com/critical-labs/qa-conductor.git'
  const doc = approverCheck()
  assert.equal(doc.split(CANONICAL).length, 2, 'it fetches from the canonical repository')
  const repo = await releaseRepo(t)
  const bare = path.join(repo.root, 'server', 'acme', 'widget.git')
  const work = path.join(repo.root, 'work')
  const git = async (cwd, ...args) => (await execFileP('git', args, { cwd, env: repo.env })).stdout.trim()
  // A commit main never was, which a tag named main, a tag named
  // origin/main and a ref named refs/main all point at.
  await git(work, 'checkout', '--quiet', '-b', 'forged', repo.tip)
  await git(work, 'commit', '--quiet', '--allow-empty', '-m', 'Merge pull request #999 from acme/release')
  const forged = await git(work, 'rev-parse', 'HEAD')
  await git(work, 'push', '--quiet', bare, `${forged}:refs/tags/main`, `${forged}:refs/tags/origin/main`)
  await git(bare, 'update-ref', 'refs/main', forged)
  const script = doc.replace(CANONICAL, pathToFileURL(bare).href)
  // Its temp repository goes in a directory of the test's own, which must be
  // empty after every run: a mktemp that honours TMPDIR (macOS's doesn't).
  const tmp = mkdtempSync(path.join(repo.root, 'tmp-'))
  const shim = mkdtempSync(path.join(repo.root, 'bin-'))
  const mktemp = (await execFileP('sh', ['-c', 'command -v mktemp'])).stdout.trim()
  writeFileSync(path.join(shim, 'mktemp'), `#!/bin/sh\nexec ${mktemp} -d "$TMPDIR/qa.XXXXXX"\n`, { mode: 0o755 })
  // A directory a shell variable of the same name already named: never removed.
  const sentinel = mkdtempSync(path.join(repo.root, 'sentinel-'))
  writeFileSync(path.join(sentinel, 'keep'), '')
  const shells = [['bash', []], ['bash', ['-o', 'pipefail']]]
  if ((await execFileP('sh', ['-c', 'command -v zsh || true'])).stdout.trim()) shells.push(['zsh', []], ['zsh', ['-o', 'pipefail']])
  else t.diagnostic('zsh not found: only the bash runs ran')
  for (const [shell, opts] of shells) {
    const run = async sha => {
      const env = { ...repo.env, PATH: `${shim}${path.delimiter}${repo.env.PATH}`, TMPDIR: tmp, qa_tmp: sentinel, sha }
      let out
      try {
        out = { code: 0, ...(await execFileP(shell, [...opts, '-c', script], { cwd: repo.root, timeout: 20_000, env })) }
      } catch (err) {
        out = err
      }
      assert.deepEqual(readdirSync(tmp), [], `${shell}: it removes its temp repository`)
      assert.ok(existsSync(path.join(sentinel, 'keep')), `${shell}: it removes nothing else`)
      return out
    }
    const how = `${shell} ${opts.join(' ')}`
    // main's first-parent line, the merge commit among them: the success
    // line alone, and exit 0
    for (const sha of [repo.first, repo.second, repo.tip]) {
      const { code, stdout } = await run(sha)
      assert.deepEqual({ code, stdout }, { code: 0, stdout: `on main: ${sha}\n` }, `${how}: ${sha}`)
    }
    // the forged commit, a merged-in or never-merged one, and anything that
    // isn't one whole lowercase SHA: the refusal line alone, which never
    // contains the success line, and a failing exit, for an agent that goes
    // by either
    // (it prints anything but hex digits in the value as `?`, so no value can
    // put a line of its own on the output)
    for (const sha of [forged, repo.merged, repo.side, repo.tip.slice(0, 7), repo.tip.toUpperCase(), '-vexyz', `${repo.tip}\n${forged}`, `x\non main: ${repo.tip}`, 'a\\nb\\cc', '']) {
      const { code, stdout } = await run(sha)
      assert.equal(stdout, `refuse: ${sha.replace(/[^0-9a-f]/g, '?')} is NOT on main\n`, `${how}: ${JSON.stringify(sha)}`)
      assert.ok(!stdout.includes('on main: '), `${how}: ${JSON.stringify(sha)} never prints the success line`)
      assert.notEqual(code, 0, `${how}: ${JSON.stringify(sha)} exits non-zero`)
    }
  }
})

// CONTRIBUTING.md's tarball check (Releasing, step 3): the one sh block in
// that section, dedented. A maintainer runs it on the machine that holds the
// tag-signing key and the npm and GitHub credentials, often from an agent's
// shell, whose stdin is no terminal.
function tarballCheck() {
  const text = readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8')
  const at = text.indexOf('\n## Releasing\n')
  assert.ok(at >= 0, 'CONTRIBUTING.md has a Releasing section')
  const blocks = [...text.slice(at).matchAll(/^( *)```sh\n([\s\S]*?)^\1```$/gm)]
  assert.equal(blocks.length, 1, 'the Releasing section has one sh block, the tarball check')
  const [, indent, body] = blocks[0]
  return body.split('\n').map(line => line.slice(indent.length)).join('\n').trimEnd()
}

// A registry that answers 404 to everything, and records what it was asked.
async function recordingRegistry(t) {
  const asked = []
  const server = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`)
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { url: `http://127.0.0.1:${server.address().port}/`, asked }
}

// Runs the tarball check from `dir` with bash, stdin no terminal, and npm's
// registry, cache, config, home and temp dirs all of the test's own.
function runTarballCheck(script, dir, registry, scratch) {
  const home = mkdtempSync(path.join(scratch, 'home-'))
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    TMPDIR: home,
    npm_config_registry: registry,
    npm_config_cache: path.join(home, '.npm'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_update_notifier: 'false',
  }
  return new Promise(resolve => {
    execFile('bash', ['-c', script], { cwd: dir, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? err.signal) : 0, stdout, stderr })
    })
  })
}

// The files npm packs, copied to a directory of their own, with package.json
// edited.
function packageCopy(scratch, name, edit) {
  const dir = path.join(scratch, name)
  for (const entry of [...pkg.files, 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true })
  }
  const json = structuredClone(pkg)
  edit(json, dir)
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(json, null, 2)}\n`)
  return dir
}

test('the release steps\' tarball check packs into a private directory, stops at the first failure and never runs npx', () => {
  const script = tarballCheck()
  // A fixed path in the shared /tmp is one another local user can plant first.
  assert.doesNotMatch(script, /\/tmp\b/, 'no fixed path in a shared temp dir')
  const dest = /^ *(\w+)="\$\(mktemp -d\)"$/m.exec(script)?.[1]
  assert.ok(dest, 'the pack destination is a fresh mktemp -d directory')
  assert.match(script, new RegExp(`^ *npm pack --pack-destination "\\$${dest}"$`, 'm'))
  assert.doesNotMatch(script, /X\.Y\.Z/, 'no version placeholder to paste unchanged')
  // Without set -e, a failed install goes on to the bin, and a check that
  // failed early can end in a success.
  assert.match(script, /^\(\n *set -e\n[\s\S]*\n\)$/, 'a ( set -e ... ) subshell, so it stops at the first failure and leaves the shell where it was')
  // npx looks a bin it can't find up on the registry, and runs what it finds.
  assert.doesNotMatch(script, /\bnpx\b|\bnpm +(exec|x)\b/, 'no npx or npm exec')
  for (const bin of Object.keys(pkg.bin)) {
    assert.match(script, new RegExp(`^ *\\./node_modules/\\.bin/${bin} --help$`, 'm'), `runs ${bin} from node_modules/.bin`)
  }
})

test('the release steps\' tarball check loads every entry point and runs the bin, fails on a tarball without either, and never asks the registry', { timeout: 240_000 }, async (t) => {
  const script = tarballCheck()
  const registry = await recordingRegistry(t)
  const scratch = mkdtempSync(path.join(tmpdir(), 'qa-tarball-check-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const USAGE = /^Usage: qa-conductor-expose /m
  const LOADS = /^every entry point loads$/m

  const noBin = packageCopy(scratch, 'no-bin', json => delete json.bin)
  const brokenExport = packageCopy(scratch, 'broken-export', (json, dir) => {
    json.exports = { ...json.exports, './broken': './lib/broken.mjs' }
    writeFileSync(path.join(dir, 'lib/broken.mjs'), 'throw new Error("this entry point fails to load")\n')
  })
  const [ok, withoutBin, withBrokenExport] = await Promise.all(
    [ROOT, noBin, brokenExport].map(dir => runTarballCheck(script, dir, registry.url, scratch)),
  )
  const shown = run => `exit ${run.code}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`

  assert.equal(ok.code, 0, shown(ok))
  assert.match(ok.stdout, LOADS, shown(ok))
  assert.match(ok.stdout, USAGE, shown(ok))

  // The case the check exists for: it must fail here, not fetch the name.
  assert.notEqual(withoutBin.code, 0, shown(withoutBin))
  assert.match(withoutBin.stdout, LOADS, shown(withoutBin))
  assert.doesNotMatch(withoutBin.stdout, USAGE, shown(withoutBin))

  // set -e: an entry point that fails to load ends the check there.
  assert.notEqual(withBrokenExport.code, 0, shown(withBrokenExport))
  assert.doesNotMatch(withBrokenExport.stdout, USAGE, `the bin ran after an entry point failed\n${shown(withBrokenExport)}`)

  assert.deepEqual(registry.asked, [], 'the check never asks the registry for anything')
})

test('nothing in the package runs with the publish token, or sends it elsewhere', () => {
  for (const script of PUBLISH_SCRIPTS) assert.equal(pkg.scripts?.[script], undefined, `package.json has no ${script} script`)
  // npm applies publishConfig to the stage, a scoped registry or proxy in it
  // included. The publish job refuses a tarball whose publishConfig is not
  // exactly this; a project .npmrc would matter to a directory publish.
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true }, 'publishConfig sets no registry, proxy or other config')
  assert.ok(!existsSync(path.join(ROOT, '.npmrc')), 'no project .npmrc')
  // The publish job's manifest check compares against this same object.
  const literal = /isDeepStrictEqual\(manifest\.publishConfig, (\{[^}]*\})\)/.exec(PUBLISH_CONFIG_SCRIPT)?.[1]
  assert.deepEqual(JSON.parse(literal), pkg.publishConfig, 'the publishConfig check expects package.json\'s publishConfig')
})

test('the publish workflow stages the tag\'s version and never publishes directly', () => {
  assert.ok(existsSync(WORKFLOW), '.github/workflows/publish.yml exists')
  assertStagesOnly(readFileSync(WORKFLOW, 'utf8'))
})

test('the workflow check refuses a publish, a skippable gate, a token or id-token outside the stage, or repository code in the publish job', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8')
  const TESTS = '      - run: npm test\n'
  const STAGE = `        run: ${STAGE_RUN}\n`
  const STAGE_NAME = '      - name: Stage publish (a maintainer approves on npmjs.com to go live)\n'
  const TOKEN = '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'
  const ON_MAIN_STEP = `      - name: ${ON_MAIN}\n`
  const FETCH = '          git fetch --quiet --no-tags "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git" +refs/heads/main:refs/remotes/origin/main\n'
  const TEST_PERMISSIONS = '    permissions:\n      contents: read\n    steps:\n'
  const ENVIRONMENT = '    environment: npm-release\n'
  const PIN = 'a'.repeat(40)
  // Each mutation edits the real workflow at an anchor that must be there.
  const replace = (from, to) => text => {
    assert.ok(text.includes(from), `the workflow has ${JSON.stringify(from)}`)
    return text.replace(from, to)
  }
  const after = (anchor, ...lines) => replace(anchor, `${anchor}${lines.map(line => `${line}\n`).join('')}`)
  // The on-main script is in both jobs: this edits its last copy, publish's.
  const replaceLast = (from, to) => text => {
    const at = text.lastIndexOf(from)
    assert.ok(at >= 0, `the workflow has ${JSON.stringify(from)}`)
    return text.slice(0, at) + to + text.slice(at + from.length)
  }
  const EARLY_STEP = `      - name: ${ON_MAIN_EARLY}\n`
  const TARBALL_STEP = `      - name: ${TARBALL_CHECK}\n`
  const PUBLISH_CONFIG_STEP = `      - name: ${PUBLISH_CONFIG_CHECK}\n`
  // A decoy copy of publish's on-main step, hidden in a heredoc at the end of
  // the tag check's script, and the real one made to pass.
  const decoyed = text => {
    const decoy = ['          cat <<\'DECOY\'', `          - name: ${ON_MAIN}`, '            run: |', ...ON_MAIN_SCRIPT.split('\n').map(line => `              ${line}`), '          DECOY']
    return replaceLast('if ! git merge-base', 'if false && ! git merge-base')(replace(TESTS, `${decoy.join('\n')}\n${TESTS}`)(text))
  }
  // The on-main step, from its name to the start of the next step.
  const onMainStep = text => {
    const start = text.indexOf(ON_MAIN_STEP)
    assert.ok(start >= 0, 'the workflow has the on-main step')
    const end = text.indexOf('\n      - ', start + ON_MAIN_STEP.length) + 1
    assert.ok(end > start, 'a step follows the on-main step')
    return text.slice(start, end)
  }
  const mutations = {
    'npm pub, which npm expands to publish': after(TESTS, '      - run: npm pub --access public', '        env:', TOKEN.trimEnd()),
    'npm pu': after(TESTS, '      - run: npm pu --access public'),
    'npx publish': after(TESTS, '      - run: npx --yes npm@11 publish'),
    'a quoted # before npm publish in a run: | block': after(TESTS, '      - run: |', '          echo "x #" && npm publish --access public'),
    // The tag check's script is the one run block not pinned word for word:
    // these lines land at its end, just before the next step.
    'npm pub in the tag check\'s script': replace(TESTS, `          npm pub --access public\n${TESTS}`),
    '"shell": node {0} on the tag check, after its script': replace(TESTS, `        "shell": node {0}\n${TESTS}`),
    'pnpm publish': after(TESTS, '      - run: pnpm publish --no-git-checks'),
    'a third-party publish action': after(TESTS, `      - uses: JS-DevTools/npm-publish@${PIN}`),
    'if: false on the tag check': after(`      - name: ${TAG_CHECK}\n`, '        if: false'),
    'continue-on-error on the tag check': after(`      - name: ${TAG_CHECK}\n`, '        continue-on-error: true'),
    'continue-on-error on the tests': after(TESTS, '        continue-on-error: true'),
    'npm test || true': replace(TESTS, '      - run: npm test || true\n'),
    'a shell that runs something else': after(STAGE, '        shell: bash -c "npm publish" {0}'),
    'the tests in the publish job, after the stage': text => replace(TESTS, '')(text) + TESTS,
    'another trigger': after('    tags: ["v*"]\n', '  workflow_dispatch:'),
    'branch pushes': after('    tags: ["v*"]\n', '    branches: ["**"]'),
    'pull requests': after('\non:\n', '  pull_request:'),
    'pull_request_target': after('\non:\n', '  pull_request_target:'),
    'contents: write': replace(TEST_PERMISSIONS, '    permissions:\n      contents: write\n    steps:\n'),
    'id-token in the test job': replace(TEST_PERMISSIONS, '    permissions:\n      contents: read\n      id-token: write\n    steps:\n'),
    'permissions at workflow level': replace('\npermissions: {}\n', '\npermissions:\n  contents: read\n  id-token: write\n'),
    'a workflow-level concurrency key': replace('\npermissions: {}\n', '\nconcurrency: publish\n\npermissions: {}\n'),
    'the token at workflow level': replace('\npermissions: {}\n', `\nenv:\n  ${TOKEN.trim()}\n\npermissions: {}\n`),
    'the token on the test job': after('    timeout-minutes: 15\n', '    env:', `      ${TOKEN.trim()}`),
    'the token on the whole publish job': after(ENVIRONMENT, '    env:', `      ${TOKEN.trim()}`),
    'the token on the tests too': after(TESTS, '        env:', TOKEN.trimEnd()),
    'the token in the tag check\'s script': replace(TESTS, `          echo "\${{ secrets.NPM_TOKEN }}"\n${TESTS}`),
    'no environment': replace(ENVIRONMENT, ''),
    'another environment': replace(ENVIRONMENT, '    environment: production\n'),
    'publish without needs': replace('    needs: test\n', ''),
    'a third job': text => `${text}\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo extra\n`,
    'a checkout in the publish job': replace(ON_MAIN_STEP, `      - uses: actions/checkout@${PIN}\n${ON_MAIN_STEP}`),
    'npm ci in the publish job': replace(STAGE_NAME, `      - run: npm ci\n${STAGE_NAME}`),
    'a repository script in the publish job': replace(STAGE_NAME, `      - run: node scripts/release.mjs\n${STAGE_NAME}`),
    'a repository script in the on-main check': after(FETCH, '          node ./scripts/check.mjs'),
    'the on-main check made to pass': replace('if ! git merge-base', 'if false && ! git merge-base'),
    'publish\'s on-main check made to pass': replaceLast('if ! git merge-base', 'if false && ! git merge-base'),
    'a repository script in publish\'s on-main check': replaceLast(FETCH, `${FETCH}          node ./scripts/check.mjs\n`),
    'no first-parent check': replace('if ! grep -qxF "$GITHUB_SHA" "$RUNNER_TEMP/main-first-parent"; then', 'if false; then'),
    'no first-parent check in publish': replaceLast('if ! grep -qxF "$GITHUB_SHA" "$RUNNER_TEMP/main-first-parent"; then', 'if false; then'),
    'no early on-main check': text => {
      const start = text.indexOf(EARLY_STEP)
      assert.ok(start >= 0, 'the workflow has the early on-main step')
      return text.slice(0, start) + text.slice(text.indexOf('\n      - ', start + EARLY_STEP.length) + 1)
    },
    '"if": false on the on-main step, quoted': after(ON_MAIN_STEP, '        "if": false'),
    'if : false on the on-main step, spaced': after(ON_MAIN_STEP, '        if : false'),
    '\'continue-on-error\': true on the tarball check, quoted': after(TARBALL_STEP, '        \'continue-on-error\': true'),
    '"shell": node {0} on the tarball check': after(TARBALL_STEP, '        "shell": node {0}'),
    'if: false on the early on-main step': after(EARLY_STEP, '        if: false'),
    'a decoy on-main step in the tag check\'s script, the real one made to pass': decoyed,
    'npm by version range': replace(NPM_UPGRADE, 'npm install -g npm@^11.15.0'),
    'no registry on the stage': replace(' --access public --registry https://registry.npmjs.org/', ' --access public'),
    'no publishConfig check': text => {
      const start = text.indexOf(PUBLISH_CONFIG_STEP)
      assert.ok(start >= 0, 'the workflow has the publishConfig check')
      return text.slice(0, start) + text.slice(text.indexOf('\n      - ', start + PUBLISH_CONFIG_STEP.length) + 1)
    },
    'the publishConfig check made to pass': replace('if (isDeepStrictEqual(manifest.publishConfig, { "access": "public", "provenance": true })) {', 'if (true) {'),
    'the publishConfig check passing by default': replace('  process.exitCode = 1\n            const root', '  process.exitCode = 0\n            const root'),
    'the publishConfig check reading the manifest with tar instead of npm': replace('pacote.manifest(`file:${process.argv[1]}`, { fullMetadata: true, fullReadJson: true })', 'Promise.resolve(JSON.parse(require("node:child_process").execSync(`tar -xzOf ${process.argv[1]} package/package.json`)))'),
    'the publishConfig check after the stage': text => {
      const start = text.indexOf(PUBLISH_CONFIG_STEP)
      const end = text.indexOf('\n      - ', start + PUBLISH_CONFIG_STEP.length) + 1
      return text.slice(0, start) + text.slice(end) + text.slice(start, end)
    },
    'the first-parent list piped into grep -q': replace(
      'git rev-list --first-parent refs/remotes/origin/main > "$RUNNER_TEMP/main-first-parent"\n          if ! grep -qxF "$GITHUB_SHA" "$RUNNER_TEMP/main-first-parent"; then',
      'if ! git rev-list --first-parent refs/remotes/origin/main | grep -qxF "$GITHUB_SHA"; then',
    ),
    'the on-main check after the stage': text => {
      const step = onMainStep(text)
      return text.replace(step, '') + step
    },
    'no on-main check': text => text.replace(onMainStep(text), ''),
    'the stage on a path npm reads as a GitHub repo': replace(`npm stage publish "./release/`, `npm stage publish "release/`),
    'a looser tarball check': replace('if [ "$have" != "$want" ]; then', 'if [ -z "$have" ]; then'),
    'the upload from anywhere': replace(`path: ${TARBALL}-*.tgz`, 'path: "*"'),
    'an action by tag, not SHA': replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7'),
    'the download by tag, not SHA': text => text.replace(/actions\/download-artifact@[0-9a-f]{40}/, 'actions/download-artifact@v8'),
  }
  for (const [what, mutate] of Object.entries(mutations)) {
    // Mutated outside assert.throws, so a missing anchor fails the test.
    const mutated = mutate(yaml)
    assert.notEqual(mutated, yaml, what)
    assert.throws(() => assertStagesOnly(mutated), assert.AssertionError, `${what} passes the check`)
  }
  // The behaviour tests read the scripts they run with stepScript: a decoy
  // copy of a step must not stand in for the real one there either.
  assert.throws(() => stepScript(decoyed(yaml), ON_MAIN), /one line names the step/)
})

test('the workflow\'s tag check passes only for v<package.json version>', { timeout: 30_000 }, async () => {
  const script = stepScript(readFileSync(WORKFLOW, 'utf8'), TAG_CHECK)
  // The tag reaches the script as the runner's env, never as a ${{ }}
  // expression spliced into shell source.
  assert.doesNotMatch(script, /\$\{\{/)
  const run = tag =>
    execFileP('bash', ['-c', script], {
      cwd: ROOT,
      timeout: 10_000,
      env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, GITHUB_REF_NAME: tag },
    })
  await run(`v${pkg.version}`)
  // The release before this one: its tag, pushed again, must not stage this.
  const previous = releases().find(version => version !== pkg.version)
  assert.ok(previous, 'the CHANGELOG has an earlier release')
  for (const tag of [`v${previous}`, 'v9.9.9', pkg.version, `v${pkg.version}-rc.1`, `v${pkg.version}.1`, `xv${pkg.version}`, '']) {
    await assert.rejects(run(tag), err => err.code === 1 && /does not match/.test(err.stdout + err.stderr), `tag "${tag}" is refused`)
  }
})

// A server-side repository for the on-main check, reached as GitHub would be,
// at $GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git, but over file://. main has
// first, second, then a merge of `merged`; `side` is a pushed branch that main
// never merged, as a PR head is. Git runs with no user or system config.
async function releaseRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-on-main-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'release test',
    GIT_AUTHOR_EMAIL: 'release@example.com',
    GIT_COMMITTER_NAME: 'release test',
    GIT_COMMITTER_EMAIL: 'release@example.com',
  }
  const git = async (cwd, ...args) => (await execFileP('git', args, { cwd, env })).stdout.trim()
  const bare = path.join(root, 'server', 'acme', 'widget.git')
  const work = path.join(root, 'work')
  mkdirSync(bare, { recursive: true })
  mkdirSync(work)
  await git(bare, 'init', '--quiet', '--bare')
  await git(work, 'init', '--quiet')
  await git(work, 'checkout', '--quiet', '-b', 'main')
  const commit = async message => {
    await git(work, 'commit', '--quiet', '--allow-empty', '-m', message)
    return git(work, 'rev-parse', 'HEAD')
  }
  const first = await commit('first')
  const second = await commit('second')
  await git(work, 'checkout', '--quiet', '-b', 'side')
  const side = await commit('side, never merged')
  await git(work, 'checkout', '--quiet', '-b', 'merged', 'main')
  const merged = await commit('merged later')
  await git(work, 'checkout', '--quiet', 'main')
  await git(work, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'merged')
  const tip = await git(work, 'rev-parse', 'HEAD')
  await git(work, 'push', '--quiet', bare, 'main', 'side')
  return { root, env, server: pathToFileURL(path.join(root, 'server')).href, first, second, side, merged, tip }
}

test('the publish job\'s on-main check passes a commit that was main itself, and stops any other with an error naming the tag', { timeout: 60_000 }, async t => {
  const script = stepScript(readFileSync(WORKFLOW, 'utf8'), ON_MAIN)
  const repo = await releaseRepo(t)
  // GitHub runs a step with no `shell:` as `bash -e {0}`; the script must also
  // hold under pipefail. The tag, SHA and URLs reach it as the runner's env,
  // never as ${{ }} expressions spliced into shell source.
  assert.doesNotMatch(script, /\$\{\{/)
  for (const shell of [['-e'], ['-e', '-o', 'pipefail']]) {
    const run = sha => execFileP('bash', [...shell, '-c', script], {
      cwd: repo.root,
      timeout: 20_000,
      env: {
        ...repo.env,
        GITHUB_SERVER_URL: repo.server,
        GITHUB_REPOSITORY: 'acme/widget',
        GITHUB_REF_NAME: 'v1.2.3',
        GITHUB_SHA: sha,
        RUNNER_TEMP: mkdtempSync(path.join(repo.root, 'runner-')),
      },
    })
    const how = `bash ${shell.join(' ')}`
    // Main's own commits, the merge commit among them: what a release tags.
    for (const sha of [repo.first, repo.second, repo.tip]) await run(sha)
    // Never merged, or unknown: not on main at all.
    for (const sha of [repo.side, 'f'.repeat(40)]) {
      await assert.rejects(run(sha), err => err.code === 1 && err.stdout.includes(`::error::v1.2.3 (${sha}) is not on main`), `${how}: ${sha}`)
    }
    // Merged, but never main itself: a release branch's own commit, or one
    // from inside a pull request.
    await assert.rejects(run(repo.merged), err => err.code === 1 && err.stdout.includes(`::error::v1.2.3 (${repo.merged}) was merged into main but never was main`), `${how}: merged`)
  }
})

test('the publish job\'s publishConfig check stages only a tarball whose publishConfig is exactly package.json\'s', { timeout: 60_000 }, async t => {
  const script = stepScript(readFileSync(WORKFLOW, 'utf8'), PUBLISH_CONFIG_CHECK)
  assert.doesNotMatch(script, /\$\{\{/)
  const scratch = mkdtempSync(path.join(tmpdir(), 'qa-publish-config-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const tgz = `${TARBALL}-${pkg.version}.tgz`
  // A release directory holding a tarball built from `entries`, in order:
  // [top-level directory, package.json text]. A directory named twice is
  // appended as a second copy of the same path. npm reads the archive with
  // its first directory stripped, so every <dir>/package.json lands as the
  // manifest, the last one winning.
  const run = async (name, entries, { npmBin = null } = {}) => {
    const dir = path.join(scratch, name)
    mkdirSync(path.join(dir, 'release'), { recursive: true })
    mkdirSync(path.join(dir, 'runner'))
    if (entries) {
      const tar = path.join(dir, 'archive.tar')
      for (const [i, [top, text]] of entries.entries()) {
        const src = path.join(dir, `src${i}`)
        mkdirSync(path.join(src, top), { recursive: true })
        writeFileSync(path.join(src, top, 'package.json'), text)
        await execFileP('tar', [i === 0 ? '-cf' : '-rf', tar, '-C', src, top])
      }
      await execFileP('gzip', ['-n', tar])
      await execFileP('mv', [`${tar}.gz`, path.join(dir, 'release', tgz)])
    }
    // GitHub runs the step as bash -e, with npm 11.21.0 on PATH. Here it is
    // the npm beside this node, unless npmBin names another: CI's Node 22 leg
    // runs this test again with that same npm 11.21.0 (see the next test).
    const bin = npmBin ?? path.dirname(process.execPath)
    return execFileP('bash', ['-e', '-c', script], {
      cwd: dir,
      timeout: 30_000,
      env: { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, HOME: dir, npm_config_cache: path.join(dir, 'cache'), GITHUB_REF_NAME: `v${pkg.version}`, RUNNER_TEMP: path.join(dir, 'runner') },
    })
  }
  const manifest = publishConfig => JSON.stringify({ name: pkg.name, version: pkg.version, ...(publishConfig === undefined ? {} : { publishConfig }) })
  const good = manifest({ provenance: true, access: 'public' })
  const evil = manifest({ ...pkg.publishConfig, '@critical-labs:registry': 'https://registry.example/' })
  await run('ok', [['package', good]])
  await run('a bad copy first, the good one last', [['package', evil], ['package', good]])
  for (const [name, entries] of [
    ['a scoped registry', [['package', evil]]],
    ['a registry', [['package', manifest({ ...pkg.publishConfig, registry: 'https://registry.example/' })]]],
    ['a proxy', [['package', manifest({ ...pkg.publishConfig, proxy: 'http://127.0.0.1:8080/' })]]],
    ['provenance off', [['package', manifest({ access: 'public', provenance: false })]]],
    ['restricted', [['package', manifest({ access: 'restricted', provenance: true })]]],
    ['no provenance', [['package', manifest({ access: 'public' })]]],
    ['no publishConfig', [['package', manifest(undefined)]]],
    ['a manifest that is not JSON', [['package', '{ "publishConfig": ']]],
    // The ones a check of package/package.json alone would pass:
    ['a later manifest under another directory', [['package', good], ['x', evil]]],
    ['a later copy of package/package.json', [['package', good], ['package', evil]]],
    ['no tarball', null],
  ]) {
    await assert.rejects(run(name, entries), err => err.code !== 0 && /::error::/.test(err.stdout), name)
  }
  // An npm whose manifest reader never settles: node then exits with
  // whatever exit code is set, so refusal must be the default. The stub says
  // what it was asked to read, so a stub that failed to load can't pass.
  const stub = path.join(scratch, 'stuck-npm')
  mkdirSync(path.join(stub, 'bin'), { recursive: true })
  mkdirSync(path.join(stub, 'node_modules', 'pacote'), { recursive: true })
  writeFileSync(path.join(stub, 'bin', 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  writeFileSync(path.join(stub, 'node_modules', 'pacote', 'index.js'), 'exports.manifest = spec => (console.log(`read ${spec}`), new Promise(() => {}))\n')
  await assert.rejects(
    run('a manifest read that never settles', [['package', good]], { npmBin: path.join(stub, 'bin') }),
    err => err.code === 1 && err.stdout === `read file:./release/${tgz}\n` && err.stderr === '',
    'a read that never settles',
  )
})

// CI's Node 22 leg runs the suite as publish.yml's test job does, with Node
// 22's own npm, which packs the release. Then it runs this file again with
// NPM_UPGRADE's npm, the one the publish job reads and stages tarballs with,
// so the publishConfig check's test runs against that npm on every pull
// request. The whole job is pinned, and on that second run the npm beside
// node must be NPM_UPGRADE's.
test('CI\'s Node 22 leg runs the package tests again with the npm the publish job stages with', () => {
  const ci = contentLines(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'))
  const blocks = topLevel(ci)
  assert.deepEqual([...blocks.keys()], ['name', 'on', 'permissions', 'jobs'], 'no workflow-level env, defaults or other key')
  assert.deepEqual(blocks.get('permissions'), ['permissions:', '  contents: read'])
  // The actions stay pinned by name; only their SHAs are masked.
  const jobs = blocks.get('jobs').map(line => {
    const uses = /^( +- uses: )(.*)$/.exec(line)
    if (!uses) return line
    assert.match(uses[2], SHA_PINNED, line)
    return `${uses[1]}${uses[2].replace(/@[0-9a-f]{40}/, '@<sha>')}`
  })
  assert.deepEqual(jobs, [
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 10',
    '    strategy:',
    '      matrix:',
    '        node: [22, 24]',
    '    steps:',
    '      - uses: actions/checkout@<sha> # v7.0.1',
    '        with:',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@<sha> # v7.0.0',
    '        with:',
    '          node-version: ${{ matrix.node }}',
    '      - run: npm test',
    '      - if: matrix.node == 22',
    `        run: ${NPM_UPGRADE}`,
    '      - if: matrix.node == 22',
    '        run: node --test test/package.test.mjs',
    '        env:',
    '          CI_EXPECTS_PUBLISH_NPM: "true"',
  ])
  assert.ok(readFileSync(WORKFLOW, 'utf8').includes(`      - run: ${NPM_UPGRADE}\n`), 'the publish job installs the same npm')
  if (process.env.CI_EXPECTS_PUBLISH_NPM === 'true') {
    // As the publishConfig check finds npm's root: its realpath, two levels up.
    const cli = realpathSync(path.join(path.dirname(process.execPath), 'npm'))
    const { version } = JSON.parse(readFileSync(path.join(path.dirname(path.dirname(cli)), 'package.json'), 'utf8'))
    assert.equal(`npm install -g --ignore-scripts npm@${version}`, NPM_UPGRADE, 'the npm beside node is the one the publish job installs')
  }
})

test('the publish job\'s tarball check passes only a release directory that holds the tag\'s tarball and nothing else', { timeout: 30_000 }, async t => {
  const script = stepScript(readFileSync(WORKFLOW, 'utf8'), TARBALL_CHECK)
  assert.doesNotMatch(script, /\$\{\{/)
  const scratch = mkdtempSync(path.join(tmpdir(), 'qa-tarball-name-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const want = `${TARBALL}-${pkg.version}.tgz`
  const run = (name, files) => {
    const dir = path.join(scratch, name)
    mkdirSync(dir)
    if (files) {
      mkdirSync(path.join(dir, 'release'))
      for (const file of files) writeFileSync(path.join(dir, 'release', file), 'x')
    }
    return execFileP('bash', ['-e', '-c', script], { cwd: dir, timeout: 10_000, env: { PATH: process.env.PATH, GITHUB_REF_NAME: `v${pkg.version}` } })
  }
  await run('ok', [want])
  for (const [name, files] of [
    ['another version', [`${TARBALL}-9.9.9.tgz`]],
    ['another package', [`other-${pkg.version}.tgz`]],
    ['an extra file', [want, 'extra.tgz']],
    ['empty', []],
    ['no directory', null],
  ]) {
    await assert.rejects(run(name, files), err => err.code !== 0, name)
  }
})
