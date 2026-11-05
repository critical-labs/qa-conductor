// GitHub API client for the QA conductor. All effects go through the injected
// fetchFn (and sleepFn for polling) so tests never touch the network.

const API = 'https://api.github.com'

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// `packageName` is the GHCR container package the GHCR helpers (tag lookup,
// RC baseline, preview-image wait) read; only those helpers need it. The
// versions endpoint is the authed-user path (`/user/...`); GHCR-under-an-org
// would need `/orgs/{owner}/...` — a follow-up when a consumer needs it.
//
// `token` authorizes the repo calls (pulls, collaborators, workflow dispatch
// and runs, issue comments and labels). `packagesToken` authorizes only the
// package versions listing, which a fine-grained PAT cannot call: pass a
// classic PAT with read:packages there (cfg.ghcrToken). It defaults to
// `token`.
export function createGithub({
  token,
  packagesToken = token,
  repo,
  fetchFn = fetch,
  packageName = null,
  // which GHCR tags count as release candidates for latestRcTag
  rcTagPattern = /-rc\.\d+$/,
  // the workflow that builds PR preview images, and the ref it is dispatched on
  previewWorkflow = 'pr-preview.yml',
  previewRef = 'main',
  // the exclusive verdict label pair: [accept, reject]
  qaLabels = ['qa-approved', 'qa-changes-requested'],
}) {
  const packageVersionsPath = () => {
    if (!packageName) throw new Error('createGithub: packageName is required for GHCR lookups')
    return `/user/packages/container/${packageName}/versions`
  }
  async function request(method, path, body, auth = token) {
    return fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function requestOk(method, path, body, auth = token) {
    const res = await request(method, path, body, auth)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`github ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
    }
    return res
  }

  async function requestJson(method, path, body, auth = token) {
    const res = await requestOk(method, path, body, auth)
    if (res.status === 204) return null
    return res.json()
  }

  async function* packageVersions() {
    for (let page = 1; ; page++) {
      const versions = await requestJson('GET', `${packageVersionsPath()}?per_page=100&page=${page}`, undefined, packagesToken)
      for (const version of versions) yield version
      if (versions.length < 100) return
    }
  }

  function versionTags(version) {
    return version.metadata?.container?.tags ?? []
  }

  // Who opened a PR and where its head lives: the inputs a BuildConvention's
  // trust gate judges. head.repo is null when the head repository was deleted.
  function trustFields(pr) {
    return {
      authorAssociation: pr.author_association ?? null,
      headRepo: pr.head.repo?.full_name ?? null,
      headOwner: pr.head.repo?.owner?.login ?? null,
    }
  }

  async function listOpenPrs() {
    const prs = await requestJson('GET', `/repos/${repo}/pulls?state=open&per_page=50`)
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      author: pr.user.login,
      // the review queue filters on the verdict labels and orders by age
      labels: (pr.labels ?? []).map((l) => l?.name).filter((name) => typeof name === 'string' && name !== ''),
      createdAt: pr.created_at ?? null,
      // the BuildConvention's eligible(pr) may leave drafts out of review
      isDraft: Boolean(pr.draft),
      ...trustFields(pr),
    }))
  }

  // The paths a PR changes, for a BuildConvention's eligible(pr): one page of
  // at most 100, so one call per PR. `complete` is false when the page is
  // full and more may lie behind it.
  async function listPrFiles(num) {
    const files = await requestJson('GET', `/repos/${repo}/pulls/${num}/files?per_page=100`)
    const list = Array.isArray(files) ? files : []
    return {
      files: list.map((f) => f?.filename).filter((name) => typeof name === 'string' && name !== ''),
      complete: list.length < 100,
    }
  }

  async function prHead(num) {
    const pr = await requestJson('GET', `/repos/${repo}/pulls/${num}`)
    return pr.head.sha
  }

  async function prInfo(num) {
    const pr = await requestJson('GET', `/repos/${repo}/pulls/${num}`)
    const { authorAssociation, headRepo, headOwner } = trustFields(pr)
    return {
      number: pr.number,
      headSha: pr.head.sha,
      author: pr.user?.login ?? null,
      authorAssociation,
      isDraft: Boolean(pr.draft),
      headRepo,
      headOwner,
    }
  }

  // The login's effective permission on the repo: admin | write | read | none.
  // author_association alone is no access check (a read-only outside
  // collaborator is still COLLABORATOR), so trust gates ask this too.
  async function authorPermission(login) {
    const res = await requestJson('GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)
    return res.permission
  }

  async function ghcrTagExists(tag) {
    for await (const version of packageVersions()) {
      if (versionTags(version).includes(tag)) return true
    }
    return false
  }

  // The tags GHCR doesn't hold yet, in one walk of the package's versions.
  async function missingTags(tags) {
    const missing = new Set(tags)
    for await (const version of packageVersions()) {
      for (const tag of versionTags(version)) missing.delete(tag)
      if (missing.size === 0) break
    }
    return tags.filter((tag) => missing.has(tag))
  }

  async function latestRcTag() {
    let bestTag = null
    let bestUpdated = ''
    for await (const version of packageVersions()) {
      const tag = versionTags(version).find((t) => rcTagPattern.test(t))
      if (tag && (!bestTag || version.updated_at > bestUpdated)) {
        bestTag = tag
        bestUpdated = version.updated_at
      }
    }
    return bestTag
  }

  // When GitHub accepted this client's latest dispatch for each PR, in ms
  // since the epoch, so the next awaitPreviewImage for the PR can tell the run
  // it started from older ones. That wait claims it as it starts.
  const dispatchedAt = new Map()

  // GitHub's clock, from the response's Date header, so no skew with the
  // local clock enters the comparison with run timestamps (both are to the
  // second). The local clock, to the second, when the header is missing. If
  // GitHub stamps the run in an earlier second than the header, the run is
  // missed and the wait only polls GHCR: it fails safe.
  function acceptedAt(res) {
    const at = Date.parse(res.headers?.get?.('date') ?? '')
    return Number.isFinite(at) ? at : Math.floor(Date.now() / 1000) * 1000
  }

  async function dispatchPreviewBuild(num) {
    const res = await requestOk('POST', `/repos/${repo}/actions/workflows/${previewWorkflow}/dispatches`, {
      ref: previewRef,
      inputs: { pr: String(num) },
    })
    dispatchedAt.set(String(num), acceptedAt(res))
  }

  // Waits for the PR's image, and with `migrate` for its `migrate-<tag>`
  // companion too. When a dispatchPreviewBuild for the PR resolved before this
  // wait started, and no other wait claimed it, each poll that still misses a
  // tag also looks up the run that dispatch started: onRun hears it whenever its status or conclusion
  // changes, and a run that concludes anything but success ends the wait at
  // once, with the run as `err.run`. A success keeps it polling, since GHCR
  // can lag the run. A failed lookup is ignored.
  async function awaitPreviewImage(num, sha, { timeoutMs = 900000, pollMs = 15000, sleepFn = defaultSleep, signal, migrate = false, onRun } = {}) {
    const tag = `pr-${num}-${sha.slice(0, 12)}`
    let pending = migrate ? [tag, `migrate-${tag}`] : [tag]
    const waitingFor = () => `GHCR tag ${pending.join(' and ')}`
    // A cancelled boot (teardown/takeover) must stop polling promptly rather
    // than hold its wait for up to timeoutMs.
    const checkAborted = () => {
      if (signal?.aborted) throw Object.assign(new Error(`aborted waiting for ${waitingFor()}`), { name: 'AbortError' })
    }
    // One dispatch, one wait: the wait claims the PR's dispatch as it starts,
    // so a later wait that dispatched nothing (even one that starts while an
    // aborted wait still sleeps) is never ended by this dispatch's run. A
    // dispatch made during this wait arms the next one.
    const since = dispatchedAt.get(String(num))
    dispatchedAt.delete(String(num))
    let heard = null
    let waited = 0
    for (;;) {
      checkAborted()
      pending = await missingTags(pending)
      if (pending.length === 0) return tag
      const run = since === undefined ? null : await dispatchedRun(num, since).catch(() => null)
      checkAborted()
      if (run) {
        const seen = JSON.stringify([run.url, run.status, run.conclusion])
        if (seen !== heard) {
          heard = seen
          tell(onRun, run)
        }
        if (run.status === 'completed' && run.conclusion && run.conclusion !== 'success') {
          throw Object.assign(new Error(`preview build failed (conclusion: ${run.conclusion})${run.url ? `: ${run.url}` : ''}`), { run })
        }
      }
      if (waited >= timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${waitingFor()}`)
      await sleepFn(pollMs)
      waited += pollMs
    }
  }

  // Progress reporting must never fail the wait it reports on.
  function tell(listener, run) {
    if (typeof listener !== 'function') return
    try {
      const out = listener({ ...run })
      if (typeof out?.then === 'function') out.then(undefined, () => {})
    } catch { /* a broken listener is its own problem */ }
  }

  function runReferencesPr(run, num) {
    const hay = `${run.display_title ?? ''} ${run.head_branch ?? ''} ${run.name ?? ''}`
    return new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(hay)
  }

  function mapRun(run) {
    return {
      url: run.html_url,
      status: run.status,
      conclusion: run.conclusion ?? null,
      startedAt: run.run_started_at ?? run.created_at,
    }
  }

  async function previewRuns(query) {
    const data = await requestJson('GET', `/repos/${repo}/actions/workflows/${previewWorkflow}/runs?${query}`)
    return Array.isArray(data) ? data : (data?.workflow_runs ?? [])
  }

  // The run a dispatch for the PR accepted at `since` started, or null while
  // it can't be told apart. Only workflow_dispatch runs created in or after
  // the dispatch's second count, so a run from an earlier second never does.
  // A run names its PR only through a run-name: a title other than the
  // workflow's name. (A dispatched run's branch is always the dispatch ref.)
  // So: the earliest of those runs whose run-name names the PR; else, when
  // there is just one and it has no run-name, that one.
  async function dispatchedRun(num, since) {
    const runs = await previewRuns('event=workflow_dispatch&per_page=10')
    const createdAt = (run) => Date.parse(run.created_at ?? '')
    const fresh = runs
      .filter((run) => (run.event ?? 'workflow_dispatch') === 'workflow_dispatch' && createdAt(run) >= since)
      .sort((a, b) => createdAt(a) - createdAt(b) || (a.id ?? 0) - (b.id ?? 0))
    const hasRunName = (run) => typeof run.display_title === 'string' && run.display_title !== run.name
    const named = fresh.find((run) => hasRunName(run) && runReferencesPr({ display_title: run.display_title }, num))
    if (named) return mapRun(named)
    const [only] = fresh
    return fresh.length === 1 && typeof only.name === 'string' && !hasRunName(only) ? mapRun(only) : null
  }

  async function findPreviewRun(num) {
    const runs = await previewRuns('per_page=10')
    if (runs.length === 0) return null
    const byRecency = [...runs].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    const chosen = byRecency.find((run) => runReferencesPr(run, num)) ?? byRecency[0]
    return mapRun(chosen)
  }

  async function listPrImageTags() {
    const tags = new Set()
    for await (const version of packageVersions()) {
      for (const tag of versionTags(version)) tags.add(tag)
    }
    return [...tags]
  }

  async function postComment(num, body) {
    const comment = await requestJson('POST', `/repos/${repo}/issues/${num}/comments`, { body })
    return comment.html_url
  }

  async function setQaLabel(num, label) {
    if (!qaLabels.includes(label)) throw new Error(`unknown QA label: ${label}`)
    const opposite = qaLabels.find((l) => l !== label)
    await requestJson('POST', `/repos/${repo}/issues/${num}/labels`, { labels: [label] })
    const res = await request('DELETE', `/repos/${repo}/issues/${num}/labels/${encodeURIComponent(opposite)}`)
    if (!res.ok && res.status !== 404) {
      const text = await res.text()
      throw new Error(`github DELETE label ${opposite} -> ${res.status}: ${text.slice(0, 200)}`)
    }
  }

  return {
    listOpenPrs,
    listPrFiles,
    prHead,
    prInfo,
    authorPermission,
    ghcrTagExists,
    latestRcTag,
    dispatchPreviewBuild,
    awaitPreviewImage,
    findPreviewRun,
    listPrImageTags,
    postComment,
    setQaLabel,
  }
}
