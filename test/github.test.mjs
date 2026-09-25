import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createGithub } from '../lib/github.mjs'

const TOKEN = 'test-token'
const REPO = '238855/homefree'
const API = 'https://api.github.com'

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
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

test('listOpenPrs fetches open PRs and maps the fields', async () => {
  const { calls, fetchFn } = makeFetch(() =>
    response(200, [
      { number: 41, title: 'Add widgets', head: { sha: 'abc123', ref: 'feat/widgets' }, user: { login: 'alice' } },
      { number: 42, title: 'Fix bug', head: { sha: 'def456', ref: 'fix/bug' }, user: { login: 'bob' } },
    ]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  const prs = await gh.listOpenPrs()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/pulls?state=open&per_page=50`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
  assert.deepEqual(prs, [
    { number: 41, title: 'Add widgets', headSha: 'abc123', headRef: 'feat/widgets', author: 'alice' },
    { number: 42, title: 'Fix bug', headSha: 'def456', headRef: 'fix/bug', author: 'bob' },
  ])
})

test('non-2xx responses throw with status and body snippet', async () => {
  const { fetchFn } = makeFetch(() => response(500, { message: 'kaboom' }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  await assert.rejects(gh.listOpenPrs(), (err) => {
    assert.match(err.message, /500/)
    assert.match(err.message, /kaboom/)
    return true
  })
})

test('prHead fetches the PR and returns head sha', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, { number: 41, head: { sha: 'feedfacecafe0123456789abcdef0123456789ab' } }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
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
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  assert.equal(await gh.ghcrTagExists('pr-41-abcdefabcdef'), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/user/packages/container/homefree-app/versions?per_page=100&page=1`)
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
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  assert.equal(await gh.ghcrTagExists('pr-7-000000000000'), false)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${API}/user/packages/container/homefree-app/versions?per_page=100&page=1`)
  assert.equal(calls[1].url, `${API}/user/packages/container/homefree-app/versions?per_page=100&page=2`)
})

test('ghcrTagExists finds the tag on a later page', async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => version(i, [`other-${i}`], '2026-09-01T00:00:00Z'))
  const { calls, fetchFn } = makeFetch((url) =>
    url.endsWith('page=1') ? response(200, fullPage) : response(200, [version(200, ['pr-7-000000000000'], '2026-09-01T00:00:00Z')]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  assert.equal(await gh.ghcrTagExists('pr-7-000000000000'), true)
  assert.equal(calls.length, 2)
})

test('latestRcTag picks the rc tag with the newest updated_at', async () => {
  const { fetchFn } = makeFetch(() =>
    response(200, [
      version(1, ['1.4.0-rc.12'], '2026-09-10T00:00:00Z'),
      version(2, ['pr-41-abcdefabcdef'], '2026-09-21T00:00:00Z'),
      version(3, ['1.4.0-rc.15'], '2026-09-20T00:00:00Z'),
      version(4, ['2.0.0-rc.3'], '2026-09-22T00:00:00Z'),
      version(5, ['latest', '1.3.0-rc.2'], '2026-09-01T00:00:00Z'),
    ]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  assert.equal(await gh.latestRcTag(), '1.4.0-rc.15')
})

test('latestRcTag returns null when no rc tag exists', async () => {
  const { fetchFn } = makeFetch(() => response(200, [version(1, ['pr-41-abcdefabcdef'], '2026-09-21T00:00:00Z')]))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  assert.equal(await gh.latestRcTag(), null)
})

test('dispatchPreviewBuild POSTs the workflow dispatch', async () => {
  const { calls, fetchFn } = makeFetch(() => response(204, ''))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
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
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  await gh.awaitPreviewImage(41, sha, { timeoutMs: 900000, pollMs: 15000, sleepFn })
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [15000, 15000])
})

test('awaitPreviewImage throws after timeoutMs of polling', async () => {
  const { fetchFn } = makeFetch(() => response(200, []))
  const sleeps = []
  const sleepFn = async (ms) => sleeps.push(ms)
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  await assert.rejects(gh.awaitPreviewImage(41, 'b'.repeat(40), { timeoutMs: 45000, pollMs: 15000, sleepFn }), /timed out/)
  assert.deepEqual(sleeps, [15000, 15000, 15000])
})

test('findPreviewRun returns the newest run by created_at with mapped fields', async () => {
  const { calls, fetchFn } = makeFetch(() =>
    response(200, {
      workflow_runs: [
        {
          html_url: 'https://github.com/238855/homefree/actions/runs/1',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-09-20T00:00:00Z',
          run_started_at: '2026-09-20T00:01:00Z',
          display_title: 'old preview',
          head_branch: 'main',
        },
        {
          html_url: 'https://github.com/238855/homefree/actions/runs/2',
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
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  const run = await gh.findPreviewRun(41)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/repos/${REPO}/actions/workflows/pr-preview.yml/runs?per_page=10`)
  assert.equal(calls[0].options.method, 'GET')
  assertGithubHeaders(calls[0].options)
  assert.deepEqual(run, {
    url: 'https://github.com/238855/homefree/actions/runs/2',
    status: 'in_progress',
    conclusion: null,
    startedAt: '2026-09-22T00:01:00Z',
  })
})

test('findPreviewRun prefers a run referencing the PR over a newer unrelated run', async () => {
  const { fetchFn } = makeFetch(() =>
    response(200, [
      {
        html_url: 'https://github.com/238855/homefree/actions/runs/3',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-09-22T00:00:00Z',
        run_started_at: '2026-09-22T00:00:30Z',
        display_title: 'unrelated build',
        head_branch: 'main',
      },
      {
        html_url: 'https://github.com/238855/homefree/actions/runs/4',
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-09-21T00:00:00Z',
        run_started_at: '2026-09-21T00:00:30Z',
        display_title: 'preview for pull request',
        head_branch: 'pr-41',
      },
    ]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  const run = await gh.findPreviewRun(41)
  assert.equal(run.url, 'https://github.com/238855/homefree/actions/runs/4')
  assert.equal(run.conclusion, 'failure')
  assert.equal(run.startedAt, '2026-09-21T00:00:30Z')
})

test('findPreviewRun falls back to created_at and null conclusion when fields are missing', async () => {
  const { fetchFn } = makeFetch(() =>
    response(200, [
      { html_url: 'https://github.com/238855/homefree/actions/runs/5', status: 'queued', created_at: '2026-09-23T00:00:00Z' },
    ]),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  const run = await gh.findPreviewRun(41)
  assert.deepEqual(run, {
    url: 'https://github.com/238855/homefree/actions/runs/5',
    status: 'queued',
    conclusion: null,
    startedAt: '2026-09-23T00:00:00Z',
  })
})

test('findPreviewRun returns null when there are no runs', async () => {
  const { fetchFn } = makeFetch(() => response(200, { workflow_runs: [] }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
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
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  const tags = await gh.listPrImageTags()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${API}/user/packages/container/homefree-app/versions?per_page=100&page=1`)
  assert.equal(calls[1].url, `${API}/user/packages/container/homefree-app/versions?per_page=100&page=2`)
  assert.ok(tags.includes('pr-41-aaaaaaaaaaaa'))
  assert.ok(tags.includes('pr-42-bbbbbbbbbbbb'))
  assert.ok(tags.includes('pr-43-cccccccccccc'))
  assert.equal(tags.filter((t) => t === 'shared-tag').length, 1)
})

test('listPrImageTags returns an empty array when there are no versions', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, []))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  assert.deepEqual(await gh.listPrImageTags(), [])
  assert.equal(calls.length, 1)
})

test('postComment POSTs the body and returns html_url', async () => {
  const { calls, fetchFn } = makeFetch(() => response(201, { html_url: 'https://github.com/238855/homefree/pull/41#issuecomment-1' }))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  const url = await gh.postComment(41, 'QA verdict body')
  assert.equal(calls[0].url, `${API}/repos/${REPO}/issues/41/comments`)
  assert.equal(calls[0].options.method, 'POST')
  assertGithubHeaders(calls[0].options)
  assert.deepEqual(JSON.parse(calls[0].options.body), { body: 'QA verdict body' })
  assert.equal(url, 'https://github.com/238855/homefree/pull/41#issuecomment-1')
})

test('setQaLabel adds the label and deletes the opposite', async () => {
  const { calls, fetchFn } = makeFetch((url, options) =>
    options.method === 'POST' ? response(200, [{ name: 'qa-approved' }]) : response(200, []),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
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
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
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
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  await gh.setQaLabel(41, 'qa-approved')
  assert.equal(calls.length, 2)
})

test('setQaLabel throws when the opposite-label delete fails with non-404', async () => {
  const { fetchFn } = makeFetch((url, options) =>
    options.method === 'POST' ? response(200, [{ name: 'qa-approved' }]) : response(500, { message: 'server error' }),
  )
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  await assert.rejects(gh.setQaLabel(41, 'qa-approved'), /500/)
})

test('setQaLabel rejects an unknown label', async () => {
  const { calls, fetchFn } = makeFetch(() => response(200, []))
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  await assert.rejects(gh.setQaLabel(41, 'qa-something-else'), /label/)
  assert.equal(calls.length, 0)
})

test('awaitPreviewImage stops promptly when its signal is aborted', async () => {
  const ac = new AbortController()
  let polls = 0
  const { fetchFn } = makeFetch(() => { polls++; return response(200, []) })
  const gh = createGithub({ token: TOKEN, repo: REPO, fetchFn })
  const sleepFn = async () => { if (polls >= 2) ac.abort() }
  await assert.rejects(
    gh.awaitPreviewImage(41, 'abcdefabcdef0000', { sleepFn, signal: ac.signal, timeoutMs: 1e9 }),
    err => err.name === 'AbortError',
  )
  assert.equal(polls, 2)
})
