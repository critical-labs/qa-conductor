// Demo fixtures: the pretend repository, its base branch and six open PRs,
// one per readiness state the harness picker can show. `status` is each PR's
// starting build state; the demo build moves `none`/`building` to `built`.
// #104 builds but its app crashes on start (CRASH_TAIL is its log), and #105
// is refused by the trust gate before anything is built. #106 already carries
// a verdict label, so the review queue (#/review) leaves it out. `createdAt`
// orders the queue: oldest first within a readiness group.
//
// A service ref is the pane's display label (`main@demo123`, `#101@abc1234`),
// so appSpecFor(ref) tells the demo provisioner which pane app to run.

export const DEMO_REPO = 'demo/widgets'

export const DEMO_BASE = { ref: 'main', sha7: 'demo123' }

export const DEMO_PRS = [
  {
    number: 101, title: 'Refresh the storefront header and accent colour', headRef: 'refresh-header',
    author: 'ada', authorAssociation: 'MEMBER', headSha: 'abc12340f2e9d8c7b6a5948372615049a8b7c6d5', status: 'built',
    createdAt: '2026-10-01T09:00:00Z',
  },
  {
    number: 102, title: 'Add a sort control to the product list', headRef: 'product-sort',
    author: 'grace', authorAssociation: 'COLLABORATOR', headSha: 'b7e91c20a4d3f5e6c7b8a9d0e1f2a3b4c5d6e7f8', status: 'built',
    createdAt: '2026-10-02T09:00:00Z',
  },
  {
    number: 103, title: 'Validate the contact form on the server', headRef: 'contact-validation',
    author: 'linus', authorAssociation: 'MEMBER', headSha: '5d0f3a91c2b3a4d5e6f708192a3b4c5d6e7f8091', status: 'building',
    createdAt: '2026-10-03T09:00:00Z',
  },
  {
    number: 104, title: 'Upgrade the template engine', headRef: 'template-engine-v5',
    author: 'ada', authorAssociation: 'MEMBER', headSha: 'e42c7b19d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3', status: 'none',
    createdAt: '2026-10-04T09:00:00Z',
    failsAt: 'starting',
  },
  {
    // A trusted author, but the head branch lives in someone else's fork.
    number: 105, title: 'Tweak the checkout copy', headRef: 'checkout-copy',
    author: 'grace', authorAssociation: 'COLLABORATOR', headSha: '9f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c', status: 'blocked',
    headRepo: 'mallory/widgets', headOwner: 'mallory',
    reason: "head branch is in @mallory's fork (mallory/widgets), not the author's",
    createdAt: '2026-10-05T09:00:00Z',
  },
  {
    // Reviewed already: its verdict label keeps it out of the review queue.
    number: 106, title: 'Tidy the footer links', headRef: 'footer-tidy',
    author: 'linus', authorAssociation: 'MEMBER', headSha: '0c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f', status: 'built',
    createdAt: '2026-09-30T09:00:00Z', labels: ['qa-approved'],
  },
]

export const baseLabel = () => `${DEMO_BASE.ref}@${DEMO_BASE.sha7}`
export const prLabel = pr => `#${pr.number}@${pr.headSha.slice(0, 7)}`

export function findPr(number, prs = DEMO_PRS) {
  return prs.find(p => p.number === Number(number)) ?? null
}

// What #104's app prints before it dies: a template engine upgrade gone wrong.
export function crashTail(label) {
  return [
    `widgets 0.4.0 (${label}) starting`,
    'loading templates from views/',
    'node_modules/tmpl-engine/lib/compile.js:88',
    '    const render = registry.layouts.get(name).render',
    '                                              ^',
    "TypeError: Cannot read properties of undefined (reading 'render')",
    '    at compileLayout (node_modules/tmpl-engine/lib/compile.js:88:47)',
    '    at loadViews (src/views.js:21:13)',
    '    at main (src/server.js:14:3)',
    'exited with code 1',
  ]
}

// ref -> { variant: 'base'|'pr', label, crashes }
export function appSpecFor(ref, prs = DEMO_PRS) {
  if (ref === baseLabel()) return { variant: 'base', label: ref, crashes: false }
  const m = /^#(\d+)@/.exec(String(ref))
  const pr = m && findPr(m[1], prs)
  if (!pr || prLabel(pr) !== ref) throw new Error(`unknown demo app ref: ${ref}`)
  return { variant: 'pr', label: ref, crashes: pr.failsAt === 'starting' }
}
