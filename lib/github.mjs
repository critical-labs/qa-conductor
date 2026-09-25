// GitHub API client for the QA conductor. All effects go through the injected
// fetchFn (and sleepFn for polling) so tests never touch the network.

const API = 'https://api.github.com'
const RC_TAG_PATTERN = /^1\..*-rc\.\d+$/
const QA_LABELS = ['qa-approved', 'qa-changes-requested']

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// `packageName` defaults to homefree's GHCR container package. The versions
// endpoint is the authed-user path (`/user/...`); GHCR-under-an-org would need
// `/orgs/{owner}/...` — a follow-up when a second consumer needs it.
export function createGithub({ token, repo, fetchFn = fetch, packageName = 'homefree-app' }) {
  const PACKAGE_VERSIONS_PATH = `/user/packages/container/${packageName}/versions`
  async function request(method, path, body) {
    return fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function requestJson(method, path, body) {
    const res = await request(method, path, body)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`github ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
    }
    if (res.status === 204) return null
    return res.json()
  }

  async function* packageVersions() {
    for (let page = 1; ; page++) {
      const versions = await requestJson('GET', `${PACKAGE_VERSIONS_PATH}?per_page=100&page=${page}`)
      for (const version of versions) yield version
      if (versions.length < 100) return
    }
  }

  function versionTags(version) {
    return version.metadata?.container?.tags ?? []
  }

  async function listOpenPrs() {
    const prs = await requestJson('GET', `/repos/${repo}/pulls?state=open&per_page=50`)
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      author: pr.user.login,
    }))
  }

  async function prHead(num) {
    const pr = await requestJson('GET', `/repos/${repo}/pulls/${num}`)
    return pr.head.sha
  }

  async function ghcrTagExists(tag) {
    for await (const version of packageVersions()) {
      if (versionTags(version).includes(tag)) return true
    }
    return false
  }

  async function latestRcTag() {
    let bestTag = null
    let bestUpdated = ''
    for await (const version of packageVersions()) {
      const tag = versionTags(version).find((t) => RC_TAG_PATTERN.test(t))
      if (tag && (!bestTag || version.updated_at > bestUpdated)) {
        bestTag = tag
        bestUpdated = version.updated_at
      }
    }
    return bestTag
  }

  async function dispatchPreviewBuild(num) {
    await requestJson('POST', `/repos/${repo}/actions/workflows/pr-preview.yml/dispatches`, {
      ref: 'main',
      inputs: { pr: String(num) },
    })
  }

  async function awaitPreviewImage(num, sha, { timeoutMs = 900000, pollMs = 15000, sleepFn = defaultSleep, signal } = {}) {
    const tag = `pr-${num}-${sha.slice(0, 12)}`
    let waited = 0
    for (;;) {
      // A cancelled boot (teardown/takeover) must stop polling promptly rather
      // than hold its wait for up to timeoutMs.
      if (signal?.aborted) throw Object.assign(new Error(`aborted waiting for GHCR tag ${tag}`), { name: 'AbortError' })
      if (await ghcrTagExists(tag)) return tag
      if (waited >= timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for GHCR tag ${tag}`)
      await sleepFn(pollMs)
      waited += pollMs
    }
  }

  function runReferencesPr(run, num) {
    const hay = `${run.display_title ?? ''} ${run.head_branch ?? ''} ${run.name ?? ''}`
    return new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(hay)
  }

  async function findPreviewRun(num) {
    const data = await requestJson('GET', `/repos/${repo}/actions/workflows/pr-preview.yml/runs?per_page=10`)
    const runs = Array.isArray(data) ? data : (data?.workflow_runs ?? [])
    if (runs.length === 0) return null
    const byRecency = [...runs].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    const chosen = byRecency.find((run) => runReferencesPr(run, num)) ?? byRecency[0]
    return {
      url: chosen.html_url,
      status: chosen.status,
      conclusion: chosen.conclusion ?? null,
      startedAt: chosen.run_started_at ?? chosen.created_at,
    }
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
    if (!QA_LABELS.includes(label)) throw new Error(`unknown QA label: ${label}`)
    const opposite = QA_LABELS.find((l) => l !== label)
    await requestJson('POST', `/repos/${repo}/issues/${num}/labels`, { labels: [label] })
    const res = await request('DELETE', `/repos/${repo}/issues/${num}/labels/${encodeURIComponent(opposite)}`)
    if (!res.ok && res.status !== 404) {
      const text = await res.text()
      throw new Error(`github DELETE label ${opposite} -> ${res.status}: ${text.slice(0, 200)}`)
    }
  }

  return {
    listOpenPrs,
    prHead,
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
