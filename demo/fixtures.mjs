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

// What the harness's PR context pane shows for each fixture: a description,
// reviews, inline review comments, the conversation and checks, as
// github.prContext gives them. #101 is the rich one; #105's conversation holds
// a comment built to attack the pane, which shows as text. Links stay on the
// reserved .invalid TLD.
const REPO_URL = `https://example.invalid/${DEMO_REPO}`
const at = (day, hour) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`
const say = (author, created, body, extra = {}) => ({ author, createdAt: created, url: `${REPO_URL}/pull/0#c-${author}-${created}`, body, truncated: false, ...extra })

export const DEMO_CONTEXT = {
  101: {
    labels: ['ui', 'design'],
    body: [
      '<!-- PR template: describe the change, link the issue, list how to test it -->',
      '## What',
      'Refreshes the storefront **header**: a new heading, the purple accent from the brand refresh, and a tighter nav.',
      '',
      '## Why',
      'The old header predates the brand guide. Closes #42.',
      '',
      '## How to test',
      '- [x] Open *Home* and *Products* in both panes',
      '- [ ] Check the accent on links and buttons',
      '- [ ] Resize to 375 px: the nav should wrap, not overflow',
      '',
      '```css',
      ':root { --accent: #7c4dff }',
      '```',
      '',
      '> Screenshots: ![header before and after](https://example.invalid/demo/widgets/assets/header.png)',
      '',
      'Design notes: https://example.invalid/design/header-refresh cc @grace',
    ].join('\n'),
    linkedIssues: [42],
    reviews: [
      say('grace', at(1, 14), 'Looks great on desktop. One question on the mobile nav, inline.', { state: 'COMMENTED' }),
      say('linus', at(2, 9), 'The accent contrast fails AA on the grey footer. Please darken it.', { state: 'CHANGES_REQUESTED' }),
    ],
    reviewComments: [
      say('grace', at(1, 14), 'Does this wrap at 375? `flex-wrap` is missing here.', { path: 'src/header.css', line: 18, outdated: false, reply: false }),
      say('ada', at(1, 16), 'Good catch: added in the next commit.', { path: 'src/header.css', line: 18, outdated: false, reply: true }),
      say('linus', at(2, 9), 'Contrast ratio here is 3.9:1.', { path: 'src/theme.css', line: 4, outdated: true, reply: false }),
    ],
    comments: [
      say('ada', at(1, 10), 'Ready for review. The preview build is up in the QA harness.'),
      say('ci-bot', at(1, 11), 'Bundle size: **+0.4 kB** (header.css)'),
    ],
    checks: { total: 4, passed: 3, failed: 0, pending: 1, other: 0, failing: [], error: null },
  },
  102: {
    labels: ['feature'],
    body: 'Adds a **Sort by** control to *Products*: name, price (low to high), price (high to low).\n\nThe choice is kept in the URL (`?sort=price`), so a shared link keeps it.\n\nFixes #37',
    linkedIssues: [37],
    reviews: [say('ada', at(3, 10), 'Works for me.', { state: 'APPROVED' })],
    reviewComments: [],
    comments: [say('grace', at(2, 12), 'QA: please check the sort survives a reload.')],
    checks: { total: 3, passed: 3, failed: 0, pending: 0, other: 0, failing: [], error: null },
  },
  103: {
    labels: ['backend'],
    body: 'Validates the contact form on the server as well as in the browser: required fields, an email that parses, a message under 2,000 characters.',
    linkedIssues: [],
    reviews: [],
    reviewComments: [],
    comments: [],
    checks: { total: 3, passed: 1, failed: 0, pending: 2, other: 0, failing: [], error: null },
  },
  104: {
    labels: ['dependencies'],
    body: 'Upgrades `tmpl-engine` from 4.x to 5.0. Layouts are now registered by name; see the [migration guide](https://example.invalid/tmpl-engine/v5-migration).',
    linkedIssues: [],
    reviews: [],
    reviewComments: [],
    comments: [say('linus', at(4, 15), 'The boot crashes for me locally too: `registry.layouts.get(name)` is undefined.')],
    checks: { total: 3, passed: 1, failed: 2, pending: 0, other: 0, error: null, failing: [
      { name: 'test', conclusion: 'failure', url: `${REPO_URL}/actions/runs/104-test` },
      { name: 'smoke', conclusion: 'timed_out', url: `${REPO_URL}/actions/runs/104-smoke` },
    ] },
  },
  105: {
    labels: [],
    body: 'Tweaks the checkout copy.\n\n<script>alert("the PR context pane shows this as text")</script>',
    linkedIssues: [],
    reviews: [],
    reviewComments: [],
    comments: [say('mallory', at(5, 11), [
      'Shown as text, never run, by the PR context pane:',
      '<img src=x onerror=alert(1)> [a javascript: link](javascript:alert(1)) <a href="javascript:alert(2)" onclick="alert(3)">raw HTML</a>',
      '![a tracking pixel](https://example.invalid/pixel.png)',
    ].join('\n'))],
    checks: { total: 0, passed: 0, failed: 0, pending: 0, other: 0, failing: [], error: null },
  },
  106: {
    labels: [],
    body: 'Groups the footer links and drops the dead *Press* page.',
    linkedIssues: [],
    reviews: [say('ada', at(30, 12), '', { state: 'APPROVED' })],
    reviewComments: [],
    comments: [],
    checks: { total: 2, passed: 2, failed: 0, pending: 0, other: 0, failing: [], error: null },
  },
}
