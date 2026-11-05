import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createGithub } from '../lib/github.mjs'

const TOKEN = 'test-token'
const REPO = 'acme/widget'
const PACKAGE = 'widget-app'
const API = 'https://api.github.com'

// `headers` is optional: most fakes have none, as the client must tolerate.
function response(status, body, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    ...(headers ? { headers: { get: name => headers[name.toLowerCase()] ?? null } } : {}),
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

function makeFetch(responder) {
  const calls = []
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options })
    return responder(url, options, calls.length)
  }
  return { calls, fetchFn }
}

function assertGithubHeaders(options) {
  assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28')
  assert.equal(options.headers.Accept, 'application/vnd.github+json')
}

function version(id, tags, updatedAt) {
  return { id, updated_at: updatedAt, metadata: { container: { tags } } }
}

test('listOpenPrs fetches open PRs and maps the fields, including the trust data and whether each is a draft', async () => {
  const { calls, fetchFn } = makeFetch(() =>
    response(200, [
      {
        number: 41, title: 'Add widgets', author_association: 'MEMBER', user: { login: 'alice' },
        head: { sha: 'abc123', ref: 'feat/widgets', repo: { full_name: 'acme/widget', owner: { login: 'acme' } } },
        labels: [{ name: 'qa-approved' }, { name: 'bug' }], created_at: '2026-10-01T10:00:00Z', draft: true,
      },
      {
        number: 42, title: 'Fix bug', author_association: 'CONTRIBUTOR', user: { login: 'bob' },
        head: { sha: 'def456', ref: 'fix/bug', repo: { full_name: 'bob/widget', owner: { login: 'bob' } } },
        labels: [], created_at: '2026-10-02T10:00:00Z',
      },
      // a PR whose head repository was deleted: GitHub sends head.repo = null
      { number: 43, title: 'Orphan', author_association: 'NONE', user: { login: 'eve' }, head: { sha: 'fed789', ref: 'x', repo: null } },
    ]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  const prs = await gh.listOpenPrs()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/pulls?state=open&per_page=50`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
  assert.deepEqual(prs, [
    { number: 41, title: 'Add widgets', headSha: 'abc123', headRef: 'feat/widgets', author: 'alice', labels: ['qa-approved', 'bug'], createdAt: '2026-10-01T10:00:00Z', isDraft: true, authorAssociation: 'MEMBER', headRepo: 'acme/widget', headOwner: 'acme' },
    { number: 42, title: 'Fix bug', headSha: 'def456', headRef: 'fix/bug', author: 'bob', labels: [], createdAt: '2026-10-02T10:00:00Z', isDraft: false, authorAssociation: 'CONTRIBUTOR', headRepo: 'bob/widget', headOwner: 'bob' },
    // no labels and no created_at in the answer: an empty list and null
    { number: 43, title: 'Orphan', headSha: 'fed789', headRef: 'x', author: 'eve', labels: [], createdAt: null, isDraft: false, authorAssociation: 'NONE', headRepo: null, headOwner: null },
  ])
})

// For a BuildConvention's eligible(pr): which files a PR changes, in one call.
test('listPrFiles reads one page of a PR\'s changed files and says whether that was all of them', async () => {
  const names = n => Array.from({ length: n }, (_, i) => ({ filename: `docs/${i}.md`, status: 'modified' }))
  let page = [{ filename: 'README.md', status: 'modified' }, { filename: 'docs/a.md', status: 'added' }, { filename: 'old/b.md', status: 'renamed', previous_filename: 'b.md' }]
  const { calls, fetchFn } = makeFetch(() => response(200, page))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  assert.deepEqual(await gh.listPrFiles(41), { files: ['README.md', 'docs/a.md', 'old/b.md'], complete: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/pulls/41/files?per_page=100`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
  // a full page may have more behind it
  page = names(100)
  const full = await gh.listPrFiles(42)
  assert.equal(full.files.length, 100)
  assert.equal(full.complete, false)
  assert.equal(calls.length, 2, 'still one call')
})

test('listPrFiles throws on an error answer', async () => {
  const { fetchFn } = makeFetch(() => response(404, { message: 'Not Found' }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  await assert.rejects(gh.listPrFiles(41), /github GET \/repos\/acme\/widget\/pulls\/41\/files\?per_page=100 -> 404/)
})

test('prInfo returns the PR trust data from GET /pulls/{num}', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, {
    number: 41, draft: true, author_association: 'COLLABORATOR', user: { login: 'alice' },
    head: { sha: 'feedfacecafe0123456789abcdef0123456789ab', ref: 'feat', repo: { full_name: 'alice/widget', owner: { login: 'alice' } } },
  }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  const info = await gh.prInfo(41)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/pulls/41`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
  assert.deepEqual(info, {
    number: 41,
    headSha: 'feedfacecafe0123456789abcdef0123456789ab',
    author: 'alice',
    authorAssociation: 'COLLABORATOR',
    isDraft: true,
    headRepo: 'alice/widget',
    headOwner: 'alice',
  })
})

test('prInfo: a deleted head repository gives null headRepo and headOwner', async () => {
  const { fetchFn } = makeFetch(() => response(200, {
    number: 9, draft: false, author_association: 'NONE', user: { login: 'eve' }, head: { sha: 'a'.repeat(40), ref: 'x', repo: null },
  }))
  const info = await createGithub({ token: TOKEN, repo: REPO, fetchFn }).prInfo(9)
  assert.equal(info.headRepo, null)
  assert.equal(info.headOwner, null)
  assert.equal(info.isDraft, false)
  assert.equal(info.author, 'eve')
})

test('prInfo throws on a non-2xx response', async () => {
  const { fetchFn } = makeFetch(() => response(404, { message: 'Not Found' }))
  await assert.rejects(createGithub({ token: TOKEN, repo: REPO, fetchFn }).prInfo(9), /404/)
})

test('authorPermission returns the top-level permission for a login', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, { permission: 'write', role_name: 'maintain', user: { login: 'alice' } }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  assert.equal(await gh.authorPermission('alice'), 'write')
  assert.equal(calls[0].url, `${API}/repos/${REPO}/collaborators/alice/permission`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
})

test('authorPermission encodes the login into the path', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, { permission: 'none' }))
  assert.equal(await createGithub({ token: TOKEN, repo: REPO, fetchFn }).authorPermission('a/../b'), 'none')
  assert.equal(calls[0].url, `${API}/repos/${REPO}/collaborators/a%2F..%2Fb/permission`)
})

test('authorPermission throws on a non-2xx response', async () => {
  const { fetchFn } = makeFetch(() => response(403, { message: 'Must have push access to view collaborator permission.' }))
  await assert.rejects(createGithub({ token: TOKEN, repo: REPO, fetchFn }).authorPermission('alice'), /403/)
})

test('non-2xx responses throw with status and body snippet', async () => {
  const { fetchFn } = makeFetch(() => response(500, { message: 'kaboom' }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await assert.rejects(gh.listOpenPrs(), (err) => {
    assert.match(err.message, /500/)
    assert.match(err.message, /kaboom/)
    return true
  })
})

test('prHead fetches the PR and returns head sha', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, { number: 41, head: { sha: 'feedfacecafe0123456789abcdef0123456789ab' } }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  const sha = await gh.prHead(41)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/pulls/41`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
  assert.equal(sha, 'feedfacecafe0123456789abcdef0123456789ab')
})

test('ghcrTagExists returns true when a version carries the tag', async () => {
  const { calls, fetchFn } = makeFetch(() =>
    response(200, [version(1, ['1.4.0-rc.9'], '2026-09-01T00:00:00Z'), version(2, ['pr-41-abcdefabcdef'], '2026-09-02T00:00:00Z')]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  assert.equal(await gh.ghcrTagExists('pr-41-abcdefabcdef'), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/user/packages/container/widget-app/versions?per_page=100&page=1`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
})

test('ghcrTagExists targets the configured package name', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, [version(1, ['pr-9-abc'], '2026-09-01T00:00:00Z')]))
  const gh = createGithub({ token: TOKEN, repo: 'acme/widget', fetchFn, packageName: 'widget-app' })
  await gh.ghcrTagExists('pr-9-abc')
  assert.equal(calls[0].url, `${API}/user/packages/container/widget-app/versions?per_page=100&page=1`)
})

test('ghcrTagExists paginates until a short page, false when absent', async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => version(i, [`other-${i}`], '2026-09-01T00:00:00Z'))
  const { calls, fetchFn } = makeFetch((url) =>
    url.endsWith('page=1') ? response(200, fullPage) : response(200, [version(200, ['still-not-it'], '2026-09-01T00:00:00Z')]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  assert.equal(await gh.ghcrTagExists('pr-7-000000000000'), false)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${API}/user/packages/container/widget-app/versions?per_page=100&page=1`)
  assert.equal(calls[1].url, `${API}/user/packages/container/widget-app/versions?per_page=100&page=2`)
})

test('ghcrTagExists finds the tag on a later page', async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => version(i, [`other-${i}`], '2026-09-01T00:00:00Z'))
  const { calls, fetchFn } = makeFetch((url) =>
    url.endsWith('page=1') ? response(200, fullPage) : response(200, [version(200, ['pr-7-000000000000'], '2026-09-01T00:00:00Z')]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  assert.equal(await gh.ghcrTagExists('pr-7-000000000000'), true)
  assert.equal(calls.length, 2)
})

const RC_VERSIONS = [
  version(1, ['1.4.0-rc.12'], '2026-09-10T00:00:00Z'),
  version(2, ['pr-41-abcdefabcdef'], '2026-09-21T00:00:00Z'),
  version(3, ['1.4.0-rc.15'], '2026-09-20T00:00:00Z'),
  version(4, ['2.0.0-rc.3'], '2026-09-22T00:00:00Z'),
  version(5, ['latest', '1.3.0-rc.2'], '2026-09-01T00:00:00Z'),
]

test('latestRcTag picks the newest rc tag (any version line by default)', async () => {
  const { fetchFn } = makeFetch(() => response(200, RC_VERSIONS))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  assert.equal(await gh.latestRcTag(), '2.0.0-rc.3')
})

test('latestRcTag honours a configured rc tag pattern', async () => {
  const { fetchFn } = makeFetch(() => response(200, RC_VERSIONS))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE, rcTagPattern: /^1\..*-rc\.\d+$/ })
  assert.equal(await gh.latestRcTag(), '1.4.0-rc.15')
})

test('GHCR helpers require a packageName; non-GHCR calls do not', async () => {
  const { fetchFn } = makeFetch(() => response(200, []))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  await assert.rejects(gh.ghcrTagExists('x'), /packageName is required/)
  await assert.rejects(gh.latestRcTag(), /packageName is required/)
  assert.deepEqual(await gh.listOpenPrs(), [])
})

test('preview workflow and ref are configurable', async () => {
  const { calls, fetchFn } = makeFetch(() => response(204, ''))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, previewWorkflow: 'preview.yml', previewRef: 'trunk' })
  await gh.dispatchPreviewBuild(41)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/actions/workflows/preview.yml/dispatches`)
  assert.deepEqual(JSON.parse(calls[0].options.body), { ref: 'trunk', inputs: { pr: '41' } })
})

test('latestRcTag returns null when no rc tag exists', async () => {
  const { fetchFn } = makeFetch(() => response(200, [version(1, ['pr-41-abcdefabcdef'], '2026-09-21T00:00:00Z')]))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  assert.equal(await gh.latestRcTag(), null)
})

test('dispatchPreviewBuild POSTs the workflow dispatch', async () => {
  const { calls, fetchFn } = makeFetch(() => response(204, ''))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await gh.dispatchPreviewBuild(41)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/actions/workflows/pr-preview.yml/dispatches`)
  assert.equal(calls[0].options.method, 'POST')
  assertGithubHeaders(calls[0].options)
  assert.deepEqual(JSON.parse(calls[0].options.body), { ref: 'main', inputs: { pr: '41' } })
})

test('awaitPreviewImage polls for pr-<num>-<sha12> and resolves when present', async () => {
  const sha = 'a'.repeat(40)
  const tag = `pr-41-${'a'.repeat(12)}`
  let attempts = 0
  const { fetchFn } = makeFetch(() => {
    attempts += 1
    return attempts < 3 ? response(200, []) : response(200, [version(9, [tag], '2026-09-22T00:00:00Z')])
  })
  const sleeps = []
  const sleepFn = async (ms) => sleeps.push(ms)
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await gh.awaitPreviewImage(41, sha, { timeoutMs: 900000, pollMs: 15000, sleepFn })
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [15000, 15000])
})

test('awaitPreviewImage throws after timeoutMs of polling', async () => {
  const { fetchFn } = makeFetch(() => response(200, []))
  const sleeps = []
  const sleepFn = async (ms) => sleeps.push(ms)
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await assert.rejects(gh.awaitPreviewImage(41, 'b'.repeat(40), { timeoutMs: 45000, pollMs: 15000, sleepFn }), /timed out/)
  assert.deepEqual(sleeps, [15000, 15000, 15000])
})

test('findPreviewRun returns the newest run by created_at with mapped fields', async () => {
  const { calls, fetchFn } = makeFetch(() =>
    response(200, {
      workflow_runs: [
        {
          html_url: 'https://github.com/acme/widget/actions/runs/1',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-09-20T00:00:00Z',
          run_started_at: '2026-09-20T00:01:00Z',
          display_title: 'old preview',
          head_branch: 'main',
        },
        {
          html_url: 'https://github.com/acme/widget/actions/runs/2',
          status: 'in_progress',
          conclusion: null,
          created_at: '2026-09-22T00:00:00Z',
          run_started_at: '2026-09-22T00:01:00Z',
          display_title: 'newest preview',
          head_branch: 'main',
        },
      ],
    }),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  const run = await gh.findPreviewRun(41)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/actions/workflows/pr-preview.yml/runs?per_page=10`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
  assert.deepEqual(run, {
    url: 'https://github.com/acme/widget/actions/runs/2',
    status: 'in_progress',
    conclusion: null,
    startedAt: '2026-09-22T00:01:00Z',
  })
})

test('findPreviewRun prefers a run referencing the PR over a newer unrelated run', async () => {
  const { fetchFn } = makeFetch(() =>
    response(200, [
      {
        html_url: 'https://github.com/acme/widget/actions/runs/3',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-09-22T00:00:00Z',
        run_started_at: '2026-09-22T00:00:30Z',
        display_title: 'unrelated build',
        head_branch: 'main',
      },
      {
        html_url: 'https://github.com/acme/widget/actions/runs/4',
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-09-21T00:00:00Z',
        run_started_at: '2026-09-21T00:00:30Z',
        display_title: 'preview for pull request',
        head_branch: 'pr-41',
      },
    ]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  const run = await gh.findPreviewRun(41)
  assert.equal(run.url, 'https://github.com/acme/widget/actions/runs/4')
  assert.equal(run.conclusion, 'failure')
  assert.equal(run.startedAt, '2026-09-21T00:00:30Z')
})

test('findPreviewRun falls back to created_at and null conclusion when fields are missing', async () => {
  const { fetchFn } = makeFetch(() =>
    response(200, [
      { html_url: 'https://github.com/acme/widget/actions/runs/5', status: 'queued', created_at: '2026-09-23T00:00:00Z' },
    ]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  const run = await gh.findPreviewRun(41)
  assert.deepEqual(run, {
    url: 'https://github.com/acme/widget/actions/runs/5',
    status: 'queued',
    conclusion: null,
    startedAt: '2026-09-23T00:00:00Z',
  })
})

test('findPreviewRun returns null when there are no runs', async () => {
  const { fetchFn } = makeFetch(() => response(200, { workflow_runs: [] }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  assert.equal(await gh.findPreviewRun(41), null)
})

test('listPrImageTags flattens and dedups tags across one paginated walk', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) =>
    i === 0
      ? version(i, ['pr-41-aaaaaaaaaaaa', 'shared-tag'], '2026-09-01T00:00:00Z')
      : version(i, [`other-${i}`], '2026-09-01T00:00:00Z'),
  )
  const page2 = [
    version(200, ['pr-42-bbbbbbbbbbbb', 'shared-tag'], '2026-09-02T00:00:00Z'),
    version(201, ['pr-43-cccccccccccc'], '2026-09-02T00:00:00Z'),
  ]
  const { calls, fetchFn } = makeFetch((url) =>
    url.endsWith('page=1') ? response(200, page1) : response(200, page2),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  const tags = await gh.listPrImageTags()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${API}/user/packages/container/widget-app/versions?per_page=100&page=1`)
  assert.equal(calls[1].url, `${API}/user/packages/container/widget-app/versions?per_page=100&page=2`)
  assert.ok(tags.includes('pr-41-aaaaaaaaaaaa'))
  assert.ok(tags.includes('pr-42-bbbbbbbbbbbb'))
  assert.ok(tags.includes('pr-43-cccccccccccc'))
  assert.equal(tags.filter((t) => t === 'shared-tag').length, 1)
})

test('listPrImageTags returns an empty array when there are no versions', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, []))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  assert.deepEqual(await gh.listPrImageTags(), [])
  assert.equal(calls.length, 1)
})

test('postComment POSTs the body and returns html_url', async () => {
  const { calls, fetchFn } = makeFetch(() => response(201, { html_url: 'https://github.com/acme/widget/pull/41#issuecomment-1' }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  const url = await gh.postComment(41, 'QA verdict body')
  assert.equal(calls[0].url, `${API}/repos/${REPO}/issues/41/comments`)
  assert.equal(calls[0].options.method, 'POST')
  assertGithubHeaders(calls[0].options)
  assert.deepEqual(JSON.parse(calls[0].options.body), { body: 'QA verdict body' })
  assert.equal(url, 'https://github.com/acme/widget/pull/41#issuecomment-1')
})

test('setQaLabel adds the label and deletes the opposite', async () => {
  const { calls, fetchFn } = makeFetch((url, options) =>
    options.method === 'POST' ? response(200, [{ name: 'qa-approved' }]) : response(200, []),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await gh.setQaLabel(41, 'qa-approved')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/issues/41/labels`)
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].options.body), { labels: ['qa-approved'] })
  assert.equal(calls[1].url, `${API}/repos/${REPO}/issues/41/labels/qa-changes-requested`)
  assert.equal(calls[1].options.method, 'DELETE')
  assertGithubHeaders(calls[1].options)
})

test('setQaLabel qa-changes-requested removes qa-approved', async () => {
  const { calls, fetchFn } = makeFetch((url, options) =>
    options.method === 'POST' ? response(200, [{ name: 'qa-changes-requested' }]) : response(200, []),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await gh.setQaLabel(41, 'qa-changes-requested')
  assert.deepEqual(JSON.parse(calls[0].options.body), { labels: ['qa-changes-requested'] })
  assert.equal(calls[1].url, `${API}/repos/${REPO}/issues/41/labels/qa-approved`)
})

test('setQaLabel honours a configured label pair and removes its opposite', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, []))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, qaLabels: ['ok', 'nope'] })
  await gh.setQaLabel(41, 'ok')
  assert.deepEqual(JSON.parse(calls[0].options.body), { labels: ['ok'] })
  assert.equal(calls[1].url, `${API}/repos/${REPO}/issues/41/labels/nope`)
  await assert.rejects(gh.setQaLabel(41, 'qa-approved'), /unknown QA label/)
})

test('setQaLabel tolerates 404 when the opposite label is absent', async () => {
  const { calls, fetchFn } = makeFetch((url, options) =>
    options.method === 'POST' ? response(200, [{ name: 'qa-approved' }]) : response(404, { message: 'Label does not exist' }),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await gh.setQaLabel(41, 'qa-approved')
  assert.equal(calls.length, 2)
})

test('setQaLabel throws when the opposite-label delete fails with non-404', async () => {
  const { fetchFn } = makeFetch((url, options) =>
    options.method === 'POST' ? response(200, [{ name: 'qa-approved' }]) : response(500, { message: 'server error' }),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await assert.rejects(gh.setQaLabel(41, 'qa-approved'), /500/)
})

test('setQaLabel rejects an unknown label', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, []))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  await assert.rejects(gh.setQaLabel(41, 'qa-something-else'), /label/)
  assert.equal(calls.length, 0)
})

test('awaitPreviewImage stops promptly when its signal is aborted', async () => {
  const ac = new AbortController()
  let polls = 0
  const { fetchFn } = makeFetch(() => { polls++; return response(200, []) })
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  const sleepFn = async () => { if (polls >= 2) ac.abort() }
  await assert.rejects(
    gh.awaitPreviewImage(41, 'abcdefabcdef0000', { sleepFn, signal: ac.signal, timeoutMs: 1e9 }),
    err => err.name === 'AbortError',
  )
  assert.equal(polls, 2)
})

// A fine-grained PAT cannot call the Packages API, so the package versions
// listing can take its own token (a classic PAT with read:packages).
test('packagesToken authorizes only the package versions listing; token every repo call', async () => {
  const sha = 'a'.repeat(40)
  const { calls, fetchFn } = makeFetch((url, options) => {
    if (url.startsWith(`${API}/user/packages/`)) return response(200, [version(1, ['1.4.0-rc.1', `pr-41-${sha.slice(0, 12)}`], '2026-09-01T00:00:00Z')])
    if (url.endsWith('/dispatches')) return response(204, '')
    if (url.includes('/runs?')) return response(200, { workflow_runs: [] })
    if (url.includes('/pulls/')) return response(200, { number: 41, head: { sha } })
    if (url.endsWith('/comments')) return response(201, { html_url: 'https://github.com/acme/widget/pull/41#issuecomment-1' })
    if (options.method === 'DELETE') return response(404, { message: 'Label does not exist' })
    return response(200, [])
  })
  const gh = createGithub({ token: 'repo-token', packagesToken: 'packages-token', repo: REPO, fetchFn, packageName: 'app' })

  await gh.listOpenPrs()
  await gh.prHead(41)
  await gh.dispatchPreviewBuild(41)
  await gh.findPreviewRun(41)
  await gh.postComment(41, 'QA verdict body')
  await gh.setQaLabel(41, 'qa-approved')
  const repoCalls = calls.length
  await gh.ghcrTagExists('pr-41-000000000000')
  await gh.latestRcTag()
  await gh.listPrImageTags()
  await gh.awaitPreviewImage(41, sha, { sleepFn: async () => {} })

  assert.equal(repoCalls, 7)
  assert.equal(calls.length, 11)
  for (const [i, { url, options }] of calls.entries()) {
    const packages = url.startsWith(`${API}/user/packages/container/app/versions?`)
    assert.equal(packages, i >= repoCalls, url)
    assert.equal(options.headers.Authorization, `Bearer ${packages ? 'packages-token' : 'repo-token'}`, `${options.method} ${url}`)
  }
})

test('without a packagesToken, token authorizes the package versions listing too', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, []))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: 'app' })
  await gh.listPrImageTags()
  await gh.listOpenPrs()
  assert.deepEqual(calls.map(c => c.options.headers.Authorization), [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
})

// --- a failed preview run ends the image wait -----------------------------------

// GitHub's clock when it accepted the dispatch: the response's Date header.
const DISPATCHED_AT = 'Wed, 07 Oct 2026 12:00:00 GMT'
const PREVIEW_SHA = 'c'.repeat(40)
const PREVIEW_TAG = `pr-41-${'c'.repeat(12)}`
const RUN_URL = id => `https://github.com/acme/widget/actions/runs/${id}`

// A workflow run as GitHub lists it. By default, a run the dispatch started two
// seconds after DISPATCHED_AT, of a workflow with no run-name: its title is the
// workflow's name, so it doesn't name the PR.
function previewRun(id, { status = 'in_progress', conclusion = null, createdAt = '2026-10-07T12:00:02Z', name = 'PR Preview Images', title = name, headBranch = 'main', event = 'workflow_dispatch' } = {}) {
  return {
    id, html_url: RUN_URL(id), status, conclusion, event,
    created_at: createdAt, run_started_at: createdAt,
    display_title: title, head_branch: headBranch, name,
  }
}

// GitHub for the preview flow. `tags(poll)` and `runs(poll)` say what GHCR and
// the runs listing hold at the nth package poll (1-based). `date` is the
// dispatch response's Date header (null: none); setDispatchDate changes it.
function previewWorld({ tags = () => [], runs = () => [], date = DISPATCHED_AT, runsStatus = 200 } = {}) {
  let polls = 0
  let dispatchDate = date
  const { calls, fetchFn } = makeFetch((url, options) => {
    if (url.endsWith('/dispatches')) return response(204, '', dispatchDate ? { date: dispatchDate } : undefined)
    if (url.startsWith(`${API}/user/packages/`)) {
      polls += 1
      return response(200, [version(1, tags(polls), '2026-10-07T12:00:00Z')])
    }
    if (url.includes('/runs?')) return runsStatus === 200 ? response(200, { workflow_runs: runs(polls) }) : response(runsStatus, { message: 'boom' })
    throw new Error(`unexpected ${options.method} ${url}`)
  })
  const sleeps = []
  const sleepFn = async ms => { sleeps.push(ms) }
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  return {
    gh, calls, sleeps, sleepFn,
    polls: () => polls,
    runCalls: () => calls.filter(c => c.url.includes('/runs?')),
    setDispatchDate: d => { dispatchDate = d },
  }
}

for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
  test(`awaitPreviewImage rejects within one poll of the dispatched run concluding ${conclusion}, naming the conclusion and the run`, async () => {
    const w = previewWorld({ runs: poll => [previewRun(7, poll < 3 ? {} : { status: 'completed', conclusion })] })
    await w.gh.dispatchPreviewBuild(41)
    await assert.rejects(
      w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }),
      { message: `preview build failed (conclusion: ${conclusion}): ${RUN_URL(7)}` },
    )
    // concluded by the third poll, which ended the wait without another sleep
    assert.equal(w.polls(), 3)
    assert.deepEqual(w.sleeps, [15000, 15000])
    const [lookup] = w.runCalls()
    assert.equal(lookup.url, `${API}/repos/${REPO}/actions/workflows/pr-preview.yml/runs?event=workflow_dispatch&per_page=10`)
    assert.equal(lookup.options.method, 'GET')
    assertGithubHeaders(lookup.options)
  })
}

test('a run created in the same second as the dispatch is the dispatch\'s run', async () => {
  const w = previewWorld({ runs: () => [previewRun(7, { status: 'completed', conclusion: 'failure', createdAt: '2026-10-07T12:00:00Z' })] })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), /preview build failed \(conclusion: failure\)/)
  assert.equal(w.polls(), 1)
})

test('a failed run created before the dispatch does not end the wait, even one that names the PR', async () => {
  const stale = () => [
    previewRun(5, { status: 'completed', conclusion: 'failure', createdAt: '2026-10-07T11:59:59Z', title: 'Preview #41' }),
    previewRun(4, { status: 'completed', conclusion: 'failure', createdAt: '2026-10-07T11:40:00Z' }),
  ]
  const w = previewWorld({ runs: stale, tags: poll => (poll >= 3 ? [PREVIEW_TAG] : []) })
  await w.gh.dispatchPreviewBuild(41)
  assert.equal(await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), PREVIEW_TAG)
  assert.deepEqual(w.sleeps, [15000, 15000])
  assert.equal(w.runCalls().length, 2) // looked on each poll the tag was missing

  const never = previewWorld({ runs: stale })
  await never.gh.dispatchPreviewBuild(41)
  await assert.rejects(
    never.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: never.sleepFn, timeoutMs: 30000 }),
    { message: `timed out after 30000ms waiting for GHCR tag ${PREVIEW_TAG}` },
  )
})

test('dispatching again makes the earlier dispatch\'s failed run stale', async () => {
  const w = previewWorld({
    runs: () => [previewRun(7, { status: 'completed', conclusion: 'failure' })],
    tags: poll => (poll >= 4 ? [PREVIEW_TAG] : []),
  })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), /preview build failed \(conclusion: failure\)/)
  w.setDispatchDate('Wed, 07 Oct 2026 12:05:00 GMT')
  await w.gh.dispatchPreviewBuild(41)
  assert.equal(await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), PREVIEW_TAG)
})

test('a run that concludes success keeps the wait going until the image appears', async () => {
  const w = previewWorld({
    runs: poll => [previewRun(7, poll < 2 ? {} : { status: 'completed', conclusion: 'success' })],
    tags: poll => (poll >= 5 ? [PREVIEW_TAG] : []),
  })
  await w.gh.dispatchPreviewBuild(41)
  assert.equal(await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), PREVIEW_TAG)
  assert.equal(w.polls(), 5)
  assert.deepEqual(w.sleeps, [15000, 15000, 15000, 15000])
})

test('awaitPreviewImage looks up no runs for a PR this client did not dispatch', async () => {
  const failed = () => [previewRun(7, { status: 'completed', conclusion: 'failure', createdAt: new Date(Date.now() + 60_000).toISOString(), title: 'Preview #41' })]
  const w = previewWorld({ runs: failed })
  await w.gh.dispatchPreviewBuild(42)
  await assert.rejects(
    w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, timeoutMs: 30000 }),
    { message: `timed out after 30000ms waiting for GHCR tag ${PREVIEW_TAG}` },
  )
  assert.equal(w.runCalls().length, 0)
})

test('awaitPreviewImage looks up no runs once the tag is there', async () => {
  const w = previewWorld({ tags: () => [PREVIEW_TAG], runs: () => [previewRun(7, { status: 'completed', conclusion: 'failure' })] })
  await w.gh.dispatchPreviewBuild(41)
  assert.equal(await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), PREVIEW_TAG)
  assert.equal(w.runCalls().length, 0)
})

test('migrate: true waits for migrate-<tag> too, and resolves with the app tag', async () => {
  const both = [PREVIEW_TAG, `migrate-${PREVIEW_TAG}`]
  const w = previewWorld({ tags: poll => (poll < 2 ? [] : poll < 4 ? [PREVIEW_TAG] : both) })
  assert.equal(await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, migrate: true }), PREVIEW_TAG)
  assert.equal(w.polls(), 4)

  // without it, the app image alone ends the wait, as before
  const appOnly = previewWorld({ tags: () => [PREVIEW_TAG] })
  assert.equal(await appOnly.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: appOnly.sleepFn }), PREVIEW_TAG)
  assert.equal(appOnly.polls(), 1)

  const lagging = previewWorld({ tags: () => [PREVIEW_TAG] })
  await assert.rejects(
    lagging.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: lagging.sleepFn, migrate: true, timeoutMs: 15000 }),
    { message: `timed out after 15000ms waiting for GHCR tag migrate-${PREVIEW_TAG}` },
  )
})

test('migrate: true finds the two tags on different package versions and pages', async () => {
  const filler = Array.from({ length: 98 }, (_, i) => version(100 + i, [`pr-9-${String(i).padStart(12, '0')}`], '2026-10-01T00:00:00Z'))
  const page1 = [version(1, [PREVIEW_TAG], '2026-10-07T12:01:00Z'), ...filler, version(2, ['latest'], '2026-10-07T12:00:00Z')]
  const page2 = [version(3, [`migrate-${PREVIEW_TAG}`], '2026-10-07T12:02:00Z')]
  const { calls, fetchFn } = makeFetch(url => response(200, url.endsWith('&page=1') ? page1 : page2))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn, packageName: PACKAGE })
  assert.equal(await gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: async () => {}, migrate: true }), PREVIEW_TAG)
  assert.equal(calls.length, 2) // one walk of both pages
})

test('migrate: true: the run\'s conclusion ends the wait for the migrate image too', async () => {
  const w = previewWorld({
    tags: () => [PREVIEW_TAG], // the app image was pushed; the migrate image never is
    runs: poll => [previewRun(7, poll < 2 ? {} : { status: 'completed', conclusion: 'failure' })],
  })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(
    w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, migrate: true }),
    { message: `preview build failed (conclusion: failure): ${RUN_URL(7)}` },
  )
  assert.equal(w.polls(), 2)
})

test('onRun hears the dispatched run each time its status or conclusion changes, the failing conclusion included', async () => {
  const states = [null, { status: 'queued' }, { status: 'queued' }, {}, {}, { status: 'completed', conclusion: 'failure' }]
  const w = previewWorld({ runs: poll => (states[poll - 1] ? [previewRun(7, states[poll - 1])] : []) })
  const heard = []
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(
    w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, onRun: run => { heard.push(run) } }),
    /preview build failed \(conclusion: failure\)/,
  )
  const seen = (status, conclusion = null) => ({ url: RUN_URL(7), status, conclusion, startedAt: '2026-10-07T12:00:02Z' })
  assert.deepEqual(heard, [seen('queued'), seen('in_progress'), seen('completed', 'failure')])
})

test('an onRun that throws or rejects does not change the wait', async () => {
  for (const onRun of [() => { throw new Error('ui gone') }, async () => { throw new Error('ui gone') }]) {
    const w = previewWorld({
      runs: poll => [previewRun(7, poll < 2 ? {} : { status: 'completed', conclusion: 'success' })],
      tags: poll => (poll >= 3 ? [PREVIEW_TAG] : []),
    })
    await w.gh.dispatchPreviewBuild(41)
    assert.equal(await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, onRun }), PREVIEW_TAG)
  }
})

test('a runs lookup that fails does not end the wait', async () => {
  const w = previewWorld({ runsStatus: 500, tags: poll => (poll >= 3 ? [PREVIEW_TAG] : []) })
  await w.gh.dispatchPreviewBuild(41)
  assert.equal(await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), PREVIEW_TAG)
  assert.equal(w.runCalls().length, 2)
})

test('several runs since the dispatch, none naming the PR: none of them ends the wait', async () => {
  const w = previewWorld({
    runs: () => [
      previewRun(8, { status: 'completed', conclusion: 'failure', createdAt: '2026-10-07T12:00:03Z' }),
      previewRun(7, { status: 'completed', conclusion: 'failure', createdAt: '2026-10-07T12:00:02Z' }),
    ],
  })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, timeoutMs: 30000 }), /^Error: timed out/)
})

test('a lone run since the dispatch whose title names something else is not the dispatch\'s run', async () => {
  const w = previewWorld({ runs: () => [previewRun(9, { status: 'completed', conclusion: 'failure', title: 'Preview #99' })] })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, timeoutMs: 30000 }), /^Error: timed out/)
})

test('the earliest run since the dispatch that names the PR is the dispatch\'s run, whatever else started', async () => {
  const ours = poll => previewRun(8, { title: 'Preview #41', createdAt: '2026-10-07T12:00:04Z', ...(poll < 2 ? {} : { status: 'completed', conclusion: 'cancelled' }) })
  const w = previewWorld({
    runs: poll => [
      previewRun(10, { title: 'Preview #41', createdAt: '2026-10-07T12:00:09Z' }),
      ours(poll),
      previewRun(9, { status: 'completed', conclusion: 'failure', createdAt: '2026-10-07T12:00:01Z', title: 'Preview #99' }),
    ],
  })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(
    w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }),
    { message: `preview build failed (conclusion: cancelled): ${RUN_URL(8)}` },
  )
  assert.equal(w.polls(), 2)
})

test('a run another event started is never the dispatch\'s run', async () => {
  const w = previewWorld({ runs: () => [previewRun(7, { status: 'completed', conclusion: 'failure', event: 'pull_request', title: 'Preview #41' })] })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, timeoutMs: 30000 }), /^Error: timed out/)
})

test('without a Date header on the dispatch response, the local clock marks the dispatch', async () => {
  const failedAt = offsetMs => () => [previewRun(7, { status: 'completed', conclusion: 'failure', createdAt: new Date(Date.now() + offsetMs).toISOString() })]
  const stale = previewWorld({ date: null, runs: failedAt(-60_000) })
  await stale.gh.dispatchPreviewBuild(41)
  await assert.rejects(stale.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: stale.sleepFn, timeoutMs: 15000 }), /^Error: timed out/)

  const fresh = previewWorld({ date: null, runs: failedAt(60_000) })
  await fresh.gh.dispatchPreviewBuild(41)
  await assert.rejects(fresh.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: fresh.sleepFn }), /preview build failed \(conclusion: failure\)/)
})

// GitHub reports created_at to the second, so the local fallback truncates to
// the second too: a run created later in the dispatch's own second counts.
test('without a Date header, the local clock marks the dispatch to the second', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-07T12:00:00.700Z') })
  const w = previewWorld({ date: null, runs: () => [previewRun(7, { status: 'completed', conclusion: 'failure', createdAt: '2026-10-07T12:00:00Z' })] })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), { message: `preview build failed (conclusion: failure): ${RUN_URL(7)}` })
})

test('onRun hears it when the run taken for the dispatch\'s changes', async () => {
  // At first the only run since the dispatch, with no run-name, is taken for
  // ours; once a run whose run-name names the PR is listed, that one is.
  const w = previewWorld({
    runs: poll => [
      ...(poll >= 2 ? [previewRun(8, { title: 'Preview #41', createdAt: '2026-10-07T12:00:03Z' })] : []),
      previewRun(9, { createdAt: '2026-10-07T12:00:01Z' }),
    ],
    tags: poll => (poll >= 3 ? [PREVIEW_TAG] : []),
  })
  const heard = []
  await w.gh.dispatchPreviewBuild(41)
  await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, onRun: run => { heard.push(run.url) } })
  assert.deepEqual(heard, [RUN_URL(9), RUN_URL(8)])
})

test('the rejection carries the run, so a caller can show it', async () => {
  const w = previewWorld({ runs: () => [previewRun(7, { status: 'completed', conclusion: 'failure' })] })
  await w.gh.dispatchPreviewBuild(41)
  const err = await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }).catch(e => e)
  assert.match(err.message, /^preview build failed/)
  assert.deepEqual(err.run, { url: RUN_URL(7), status: 'completed', conclusion: 'failure', startedAt: '2026-10-07T12:00:02Z' })
})

// A dispatch arms the next wait for its PR only: a later wait that dispatched
// nothing (the next commit's build started some other way, say) must never be
// ended by the earlier dispatch's failed run.
for (const [how, firstTags] of [['rejected', () => []], ['resolved', () => [PREVIEW_TAG]]]) {
  test(`a dispatch arms only the next wait for its PR (that wait ${how})`, async () => {
    const nextSha = 'd'.repeat(40)
    const nextTag = `pr-41-${'d'.repeat(12)}`
    let first = true
    const w = previewWorld({
      runs: () => [previewRun(7, { status: 'completed', conclusion: 'failure' })],
      tags: poll => (first ? firstTags(poll) : poll >= 4 ? [nextTag] : []),
    })
    await w.gh.dispatchPreviewBuild(41)
    await w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }).catch(() => {})
    first = false
    const lookups = w.runCalls().length
    assert.equal(await w.gh.awaitPreviewImage(41, nextSha, { sleepFn: w.sleepFn }), nextTag)
    assert.equal(w.runCalls().length, lookups) // the second wait looked up no runs
  })
}

// The run is in progress at the first poll and has failed by the next.
const failsAfterFirstPoll = poll => [previewRun(7, poll < 2 ? {} : { status: 'completed', conclusion: 'failure' })]

test('a wait claims its dispatch as it starts: one that starts while an aborted wait sleeps is not armed', async () => {
  const ac = new AbortController()
  let wake = null
  const w = previewWorld({ runs: failsAfterFirstPoll })
  await w.gh.dispatchPreviewBuild(41)
  const first = w.gh.awaitPreviewImage(41, PREVIEW_SHA, { signal: ac.signal, sleepFn: () => new Promise(r => { wake = r }) })
  while (!wake) await new Promise(r => setImmediate(r))
  ac.abort() // teardown, while the first wait sleeps
  const lookups = w.runCalls().length
  // The PR is opened again at once, and this boot's wait dispatched nothing.
  await assert.rejects(
    w.gh.awaitPreviewImage(41, 'd'.repeat(40), { sleepFn: async () => {}, timeoutMs: 30000 }),
    /^Error: timed out/,
  )
  assert.equal(w.runCalls().length, lookups) // it looked up no runs
  wake()
  await assert.rejects(first, err => err.name === 'AbortError')
})

test('a dispatch made during a wait arms the next wait, even in the same second', async () => {
  const w = previewWorld({ runs: failsAfterFirstPoll })
  await w.gh.dispatchPreviewBuild(41)
  // While the first wait sleeps, the PR is dispatched again (the same Date).
  await assert.rejects(
    w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: () => w.gh.dispatchPreviewBuild(41) }),
    /preview build failed/,
  )
  const lookups = w.runCalls().length
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: async () => {} }), /preview build failed/)
  assert.ok(w.runCalls().length > lookups, 'the next wait was armed')
})

test('a digit in the workflow\'s name or the dispatch ref names no PR', async () => {
  // Two runs since the dispatch, neither with a run-name: no telling which is ours.
  const unnamed = { status: 'completed', conclusion: 'failure', name: 'Preview (node 41)' }
  const w = previewWorld({
    runs: () => [
      previewRun(8, { ...unnamed, createdAt: '2026-10-07T12:00:03Z', headBranch: 'release-41' }),
      previewRun(7, unnamed),
    ],
  })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, timeoutMs: 30000 }), /^Error: timed out/)

  // the only one is still the dispatch's
  const lone = previewWorld({ runs: () => [previewRun(7, unnamed)] })
  await lone.gh.dispatchPreviewBuild(41)
  await assert.rejects(lone.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: lone.sleepFn }), { message: `preview build failed (conclusion: failure): ${RUN_URL(7)}` })
})

test('of two runs created in the same second that name the PR, the lower id is the earlier', async () => {
  const at = '2026-10-07T12:00:02Z'
  const w = previewWorld({
    runs: () => [
      previewRun(12, { title: 'Preview #41', createdAt: at }),
      previewRun(11, { title: 'Preview #41', createdAt: at, status: 'completed', conclusion: 'failure' }),
    ],
  })
  await w.gh.dispatchPreviewBuild(41)
  await assert.rejects(w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn }), { message: `preview build failed (conclusion: failure): ${RUN_URL(11)}` })
})

test('an abort during the runs lookup ends the wait as an abort, not a build failure', async () => {
  const ac = new AbortController()
  const w = previewWorld({ runs: () => { ac.abort(); return [previewRun(7, { status: 'completed', conclusion: 'failure' })] } })
  await w.gh.dispatchPreviewBuild(41)
  const heard = []
  await assert.rejects(
    w.gh.awaitPreviewImage(41, PREVIEW_SHA, { sleepFn: w.sleepFn, signal: ac.signal, onRun: run => { heard.push(run) } }),
    err => err.name === 'AbortError',
  )
  assert.deepEqual(heard, [])
})
