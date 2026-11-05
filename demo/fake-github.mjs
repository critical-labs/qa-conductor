// Demo GitHub: the slice of lib/github.mjs the conductor and a trust-gated
// BuildConvention use, answered from the fixtures, and prContext for the
// harness's PR context pane, where a verdict the demo posted joins the
// conversation. Verdict comments and labels
// are kept in memory (`comments`, `labels`) and logged; nothing leaves the
// machine, and the comment URLs point at the reserved `.invalid` TLD.

import { DEMO_CONTEXT, DEMO_PRS, DEMO_REPO, findPr } from './fixtures.mjs'

export function createDemoGithub({
  prs = DEMO_PRS,
  repo = DEMO_REPO,
  qaLabels = ['qa-approved', 'qa-changes-requested'],
  log = console,
} = {}) {
  const comments = []
  // pr number -> Set of QA labels, seeded from the fixtures; a verdict replaces
  // a PR's set, as setQaLabel does on GitHub, so the review queue drops it
  const labels = new Map(prs.filter(pr => Array.isArray(pr.labels)).map(pr => [pr.number, new Set(pr.labels)]))
  const owner = repo.split('/')[0]

  function lookup(num) {
    const pr = findPr(num, prs)
    if (!pr) throw new Error(`github GET /repos/${repo}/pulls/${num} -> 404: Not Found`)
    return pr
  }
  const headRepo = pr => pr.headRepo ?? repo
  const headOwner = pr => pr.headOwner ?? owner

  return {
    comments,
    labels,

    async listOpenPrs() {
      return prs.map(pr => ({
        number: pr.number, title: pr.title, headSha: pr.headSha, headRef: pr.headRef, author: pr.author,
        labels: [...(labels.get(pr.number) ?? [])], createdAt: pr.createdAt ?? null,
        authorAssociation: pr.authorAssociation, headRepo: headRepo(pr), headOwner: headOwner(pr),
      }))
    },

    async prHead(num) {
      return lookup(num).headSha
    },

    async prInfo(num) {
      const pr = lookup(num)
      return {
        number: pr.number, headSha: pr.headSha, author: pr.author, authorAssociation: pr.authorAssociation,
        isDraft: false, headRepo: headRepo(pr), headOwner: headOwner(pr),
      }
    },

    // Every demo author can push; #105 is blocked by where its head lives.
    async authorPermission() {
      return 'write'
    },

    async prContext(num) {
      const pr = lookup(num)
      const ctx = DEMO_CONTEXT[pr.number] ?? {}
      const repoUrl = `https://example.invalid/${repo}`
      const list = items => ({ items, total: items.length, error: null })
      const posted = comments.filter(c => c.pr === pr.number).map(c => ({ author: 'reviewer', createdAt: null, url: c.url, body: c.body, truncated: false }))
      const verdict = [...(labels.get(pr.number) ?? [])]
      return {
        number: pr.number, title: pr.title, url: `${repoUrl}/pull/${pr.number}`, repoUrl,
        state: 'open', draft: false, merged: false, author: pr.author, labels: [...(ctx.labels ?? []), ...verdict],
        base: 'main', head: pr.headRef, headSha: pr.headSha, createdAt: pr.createdAt ?? null, updatedAt: pr.createdAt ?? null,
        body: ctx.body ?? '', bodyTruncated: false, linkedIssues: ctx.linkedIssues ?? [],
        comments: list([...(ctx.comments ?? []), ...posted]),
        reviews: list(ctx.reviews ?? []),
        reviewComments: list(ctx.reviewComments ?? []),
        checks: ctx.checks ?? { total: 0, passed: 0, failed: 0, pending: 0, other: 0, failing: [], error: null },
      }
    },

    async postComment(num, body) {
      const url = `https://example.invalid/${repo}/pull/${num}#qa-comment-${comments.length + 1}`
      comments.push({ pr: num, body, url })
      log.log(`[demo] comment on #${num} (not posted anywhere):\n${body}`)
      return url
    },

    async setQaLabel(num, label) {
      if (!qaLabels.includes(label)) throw new Error(`unknown QA label: ${label}`)
      labels.set(num, new Set([label]))
      log.log(`[demo] #${num} labelled ${label}`)
    },
  }
}
