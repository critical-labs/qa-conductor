// The harness's PR context pane renders text anyone who can open a pull
// request controls: its title, description, comments, review comments, file
// paths, labels and logins. It never parses that text as HTML. A safe subset
// of Markdown becomes DOM built with createElement, createTextNode and
// setAttribute alone, from a fixed list of tags and attributes; a link is
// made only for an http(s) URL and opens in a new tab with no opener and no
// Referer; an image is never loaded, only linked.
//
// These tests run the renderer against a recording document, then check what
// it built: every tag and attribute, every href, and the HTML it serializes
// to, for hostile bodies (script tags, inline handlers, javascript: and data:
// links, nested HTML, images) and inputs built to be slow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const harnessPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'harness.js')
const harnessSrc = readFileSync(harnessPath, 'utf8')
const cjsModule = { exports: {} }
new Function('module', 'exports', harnessSrc)(cjsModule, cjsModule.exports)
const { safeHref, mdParse, mdRender, renderPrContext } = cjsModule.exports

// A document that records what is built, and nothing else: no innerHTML, no
// parsing, so a renderer that leaned on either would fail here.
const TAGS = new Set(['div', 'section', 'details', 'summary', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'code', 'ul', 'ol', 'li', 'blockquote', 'hr', 'strong', 'em', 'del', 'a', 'br', 'span', 'time'])
const ATTRS = new Set(['href', 'target', 'rel', 'class', 'title', 'open', 'datetime', 'tabindex'])
function fakeDoc() {
  const made = []
  const node = tag => {
    const el = {
      tag, attrs: {}, children: [],
      setAttribute(name, value) {
        assert.ok(ATTRS.has(name), `attribute ${name} on <${tag}>`)
        el.attrs[name] = String(value)
      },
      append(...xs) {
        for (const x of xs) {
          if (typeof x === 'string') el.children.push({ text: x })
          else { assert.ok(x && (x.tag || 'text' in x), 'a node of this document'); el.children.push(x) }
        }
      },
    }
    for (const prop of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'textContent', 'className', 'onclick', 'href', 'src']) {
      Object.defineProperty(el, prop, { set() { throw new Error(`the renderer set .${prop} on <${tag}>`) }, get() { throw new Error(`the renderer read .${prop}`) } })
    }
    made.push(el)
    return el
  }
  return {
    made,
    createElement(tag) { assert.ok(TAGS.has(tag), `tag <${tag}>`); return node(tag) },
    createTextNode(text) { return { text: String(text) } },
  }
}

const escText = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const escAttr = s => escText(s).replace(/"/g, '&quot;')
function html(n) {
  if ('text' in n) return escText(n.text)
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')
  return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`
}
function walk(n, fn) { fn(n); for (const c of n.children ?? []) walk(c, fn) }
const md = (text, opts) => { const doc = fakeDoc(); const root = mdRender(mdParse(text), doc, opts); return { root, html: html(root), doc } }
const textOf = n => ('text' in n ? n.text : n.children.map(textOf).join(''))

// What every rendering must hold, whatever went in.
function assertSafe(root) {
  walk(root, n => {
    if (!n.tag) return
    assert.ok(TAGS.has(n.tag), n.tag)
    for (const k of Object.keys(n.attrs)) assert.ok(ATTRS.has(k), k)
    if (n.tag === 'a') {
      assert.match(n.attrs.href, /^https?:\/\//, 'only http(s) links')
      assert.doesNotThrow(() => new URL(n.attrs.href))
      assert.equal(n.attrs.target, '_blank')
      assert.equal(n.attrs.rel, 'noopener noreferrer')
    } else {
      assert.ok(!('href' in n.attrs), `no href on <${n.tag}>`)
    }
  })
  const out = html(root)
  assert.doesNotMatch(out, /<(script|img|iframe|svg|object|embed|style|form|input|math|base|meta|link)\b/i)
  assert.doesNotMatch(out, /<[a-z0-9]+\b[^>]*\son[a-z]+=/i)
  assert.doesNotMatch(out, /<[a-z0-9]+\b[^>]*\shref="(?!https?:\/\/)/i)
}

test('safeHref: only absolute http(s) URLs, normalized; nothing else', () => {
  assert.equal(safeHref('https://github.com/acme/widget/pull/1'), 'https://github.com/acme/widget/pull/1')
  assert.equal(safeHref('HTTP://Example.com/a b'), 'http://example.com/a%20b')
  assert.equal(safeHref('  https://example.com/x  '), 'https://example.com/x')
  for (const bad of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    '\u0000javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
    '//evil.example/x', '/relative',
    // userinfo: reads like github.com, goes to evil.example
    'https://github.com@evil.example/x', 'https://user:pass@example.com/', 'https://:x@example.com/', 'docs/x.md', '#frag', 'mailto:a@b.example', 'https:', '', null, undefined, 42, {},
  ]) assert.equal(safeHref(bad), null, JSON.stringify(bad))
})

test('Markdown: headings, paragraphs, lists, task items, quotes, code, rules and inline styles', () => {
  const { html: out, root } = md([
    '# Title', '## Sub', '#### Deep', '',
    'Some **bold**, *em*, _em_, __strong__, ~~gone~~ and `a <b> code`.', 'Second line.', '',
    '- one', '- [x] done', '* [ ] todo', '', '1. first', '2) second', '',
    '> quoted **text**', '> more', '',
    '```js', 'const a = "<b>"', '```', '',
    '---', '',
    '| a | b |', '|---|---|', '| 1 | 2 |',
    'snake_case_name stays',
  ].join('\n'))
  assertSafe(root)
  assert.equal(out, '<div class="md">'
    + '<h4>Title</h4><h5>Sub</h5><h6>Deep</h6>'
    + '<p>Some <strong>bold</strong>, <em>em</em>, <em>em</em>, <strong>strong</strong>, <del>gone</del> and <code>a &lt;b&gt; code</code>.<br></br>Second line.</p>'
    + '<ul><li>one</li><li>☑ done</li><li>☐ todo</li></ul><ol><li>first</li><li>second</li></ol>'
    + '<blockquote><p>quoted <strong>text</strong><br></br>more</p></blockquote>'
    + '<pre><code>const a = "&lt;b&gt;"</code></pre>'
    + '<hr></hr>'
    + '<pre class="table">| a | b |\n|---|---|\n| 1 | 2 |</pre>'
    + '<p>snake_case_name stays</p>'
    + '</div>')
})

test('Markdown: links, autolinks, bare URLs, issue references and mentions become safe links', () => {
  const { root, html: out } = md('See [the docs](https://example.com/docs "Docs"), <https://a.example/x>, https://b.example/y. and #12, @ada, a@b.example, x#3', { repoUrl: 'https://github.com/acme/widget' })
  assertSafe(root)
  const links = []
  walk(root, n => { if (n.tag === 'a') links.push([n.attrs.href, textOf(n)]) })
  assert.deepEqual(links, [
    ['https://example.com/docs', 'the docs'],
    ['https://a.example/x', 'https://a.example/x'],
    ['https://b.example/y', 'https://b.example/y'],
    ['https://github.com/acme/widget/issues/12', '#12'],
    ['https://github.com/ada', '@ada'],
  ])
  assert.match(out, /https:\/\/b\.example\/y<\/a>\. and/, 'trailing punctuation stays out of a bare URL')
  // without the repository's URL, #12 is text
  assert.ok(!md('#12 here').html.includes('<a'))
})

test('Markdown: an image is never loaded, only linked, and an unsafe one is text', () => {
  const { root, html: out } = md('![a tracking pixel](https://evil.example/p.png?u=reviewer) and ![x](javascript:alert(1)) and <img src="https://evil.example/q.png">')
  assertSafe(root)
  const links = []
  walk(root, n => { if (n.tag === 'a') links.push([n.attrs.href, textOf(n)]) })
  // the raw tag stays text; the bare URL in it is a link, which loads nothing
  assert.deepEqual(links, [['https://evil.example/p.png?u=reviewer', 'image: a tracking pixel'], ['https://evil.example/q.png', 'https://evil.example/q.png']])
  assert.match(out, /image: x and/)
  assert.match(out, /&lt;img src="<a [^>]+>https:\/\/evil\.example\/q\.png<\/a>"&gt;/)
})

test('a link\'s title names where it really goes, and bidi controls never reach the page', () => {
  const { root } = md('[github.com](https://xn--gthub-n2e.com/x) and https://g\u0456thub.com/y and [ok](https://example.com/a\u202Eb)')
  assertSafe(root)
  const links = []
  walk(root, n => { if (n.tag === 'a') links.push([n.attrs.href, n.attrs.title]) })
  assert.deepEqual(links, [
    ['https://xn--gthub-n2e.com/x', 'https://xn--gthub-n2e.com/x'],
    ['https://xn--gthub-n2e.com/y', 'https://xn--gthub-n2e.com/y'],
    // the control is gone from the body before any URL is read
    ['https://example.com/ab', 'https://example.com/ab'],
  ])
  const bidi = /[\u202A-\u202E\u2066-\u2069]/
  for (const body of ['abc\u202Edcba', '[x\u2067y](https://example.com)', '`a\u202Eb`', '# h\u202Ei', '```\nx\u202Dy\n```']) {
    assert.doesNotMatch(md(body).html, bidi, JSON.stringify(body))
  }
  const ctx = renderPrContext({ title: 't\u202Eitle', author: 'a\u2066b', labels: ['l\u202Eb'], base: 'm\u202Ea', head: 'h\u2069', comments: { items: [], total: 0 }, reviewComments: { items: [{ author: 'x', path: 'src/\u202Egpj.exe', line: 1, body: 'b' }], total: 1 } }, fakeDoc())
  assert.doesNotMatch(html(ctx), bidi)
  assert.match(html(ctx), /src\/gpj\.exe/)
})

const HOSTILE = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<a href="javascript:alert(1)" onclick="alert(2)">click</a>',
  '<div><p><b onmouseover=alert(1)>nested <i>html</i></b></p></div>',
  '<details open ontoggle=alert(1)><summary>x</summary></details>',
  '<style>body{display:none}</style><form action=https://evil.example><input name=x></form>',
  '[click me](javascript:alert(1))',
  '[click me](JaVaScRiPt:alert(1))',
  '[click me]( javascript:alert(1) )',
  '[click me](java\tscript:alert(1))',
  '[click me](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click me](vbscript:msgbox(1))',
  '[click me](//evil.example)',
  '[x](https://ok.example/" onmouseover="alert(1))',
  '[<img src=x onerror=alert(1)>](https://ok.example)',
  '[[nested](https://a.example)](javascript:alert(1))',
  '<javascript:alert(1)>',
  '![x](data:image/svg+xml,<svg onload=alert(1)>)',
  '`<script>alert(1)</script>`',
  '```html\n<script>alert(1)</script>\n```',
  '# <script>alert(1)</script>',
  '> <img src=x onerror=alert(1)>',
  '- <a href=javascript:alert(1)>x</a>',
  '**<script>**alert(1)**</script>**',
  '&lt;script&gt;alert(1)&lt;/script&gt; &#x3C;script&#x3E;',
  '<!-- hidden --><script>alert(1)</script><!-- unterminated',
  '‮<script>\u0000alert(1)</script>',
]

test('hostile bodies render as text: no script, no handler, no unsafe link, nothing outside the allowed tags', () => {
  for (const body of HOSTILE) {
    const { root, html: out } = md(body, { repoUrl: 'https://github.com/acme/widget' })
    assertSafe(root)
    // whatever markup went in is still there to read, as text
    if (body.includes('<script>') && !body.startsWith('<!--')) assert.match(out, /&lt;script&gt;/, body)
  }
  // a link with an unsafe URL keeps its text and loses its link
  const { html: out } = md('[click me](javascript:alert(1))')
  assert.equal(out, '<div class="md"><p>click me</p></div>')
  // HTML comments are hidden, as GitHub hides them; an unterminated one is left as text
  assert.equal(md('a<!-- note -->b').html, '<div class="md"><p>ab</p></div>')
  assert.equal(md('a <!-- open').html, '<div class="md"><p>a &lt;!-- open</p></div>')
  // entities are not decoded: they show as written
  assert.match(md('&lt;b&gt;').html, /&amp;lt;b&amp;gt;/)
})

test('the renderer stays fast on inputs built to make a parser backtrack', () => {
  const n = 100000
  for (const body of [
    '['.repeat(n), '*'.repeat(n), '_'.repeat(n), '~'.repeat(n), '`'.repeat(n), '<'.repeat(n), '<!--'.repeat(n / 4),
    '[a]('.repeat(n / 4), '**a'.repeat(n / 3), '# '.repeat(n / 2), '- '.repeat(n / 2), '> '.repeat(n / 2), ' '.repeat(n) + 'x',
    '`a'.repeat(n / 2), 'https://'.repeat(n / 8), '#'.repeat(n) + ' x', '-'.repeat(n), '- - - '.repeat(n / 6) + 'x',
    '```\n'.repeat(n / 4),
    // bare-URL candidates the URL parser refuses, back to back: each must be
    // consumed once, not scanned again from every h
    'http://['.repeat(n / 8), 'https://['.repeat(n / 9), 'http://%'.repeat(n / 8), 'hhttp://['.repeat(n / 9),
    Array.from({ length: n / 10 }, (_, i) => '`'.repeat((i % 40) + 1) + 'x').join(' '),
  ]) {
    const started = process.hrtime.bigint()
    const { root } = md(body, { repoUrl: 'https://github.com/acme/widget' })
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    assertSafe(root)
    assert.ok(ms < 1500, `${JSON.stringify(body.slice(0, 12))}… took ${ms.toFixed(0)} ms`)
  }
})

const CONTEXT = {
  number: 41, title: 'Add widgets', url: 'https://github.com/acme/widget/pull/41', repoUrl: 'https://github.com/acme/widget',
  state: 'open', draft: true, merged: false, author: 'alice', labels: ['ui', 'needs-qa'],
  base: 'main', head: 'feat/widgets', headSha: 'abc123', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z',
  body: 'Adds **widgets**.\n\nCloses #12', bodyTruncated: false, linkedIssues: [12],
  comments: { items: [{ author: 'bob', createdAt: '2026-10-01T11:00:00Z', url: 'https://github.com/acme/widget/pull/41#issuecomment-1', body: 'Looks good', truncated: false }], total: 3, error: null },
  reviews: { items: [{ author: 'carol', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-02T09:00:00Z', url: 'https://github.com/acme/widget/pull/41#pullrequestreview-1', body: 'Fix the colour', truncated: false }], total: 1, error: null },
  reviewComments: {
    items: [
      { author: 'dan', createdAt: '2026-10-02T09:31:00Z', url: 'https://github.com/acme/widget/pull/41#discussion_r1', path: 'src/widget.js', line: 12, outdated: false, reply: false, body: 'Off by one?', truncated: false },
      { author: 'alice', createdAt: '2026-10-02T09:35:00Z', url: 'https://github.com/acme/widget/pull/41#discussion_r2', path: 'src/widget.js', line: 10, outdated: true, reply: true, body: 'Fixed', truncated: false },
    ],
    total: 2, error: null,
  },
  checks: { total: 3, passed: 1, failed: 1, pending: 1, other: 0, failing: [{ name: 'lint', conclusion: 'failure', url: 'https://github.com/acme/widget/runs/2' }], error: null },
}

test('renderPrContext: the PR at a glance, then its description, reviews, conversation and inline comments', () => {
  const doc = fakeDoc()
  const root = renderPrContext(CONTEXT, doc)
  assertSafe(root)
  const text = textOf(root)
  for (const want of [
    '#41 Add widgets', 'alice', 'draft', 'main ← feat/widgets', 'ui', 'needs-qa', 'Open on GitHub',
    'Checks: 1 passed · 1 failed · 1 pending', 'lint (failure)', 'Closes #12',
    'Description', 'Adds widgets.',
    'Reviews (1)', 'carol', 'changes requested', 'Fix the colour',
    'Conversation (showing 1 of 3)', 'bob', 'Looks good',
    'Inline review comments (2)', 'src/widget.js:12', 'Off by one?', 'src/widget.js:10 (outdated)', 'Fixed',
  ]) assert.ok(text.includes(want), `has ${JSON.stringify(want)}\n${text}`)
  const links = []
  walk(root, n => { if (n.tag === 'a') links.push(n.attrs.href) })
  for (const want of ['https://github.com/acme/widget/pull/41', 'https://github.com/acme/widget/issues/12', 'https://github.com/acme/widget/runs/2', 'https://github.com/acme/widget/pull/41#discussion_r1']) {
    assert.ok(links.includes(want), want)
  }
  // the sections are collapsible, and open
  const details = doc.made.filter(n => n.tag === 'details')
  assert.ok(details.length >= 4)
  for (const d of details) assert.equal(d.attrs.open, '')
})

test('renderPrContext: section errors, empty lists, an unknown total, truncation and no checks are said in words', () => {
  const root = renderPrContext({
    ...CONTEXT, body: '', bodyTruncated: false, draft: false, merged: true, state: 'closed', labels: [], linkedIssues: [],
    comments: { items: [], total: 0, error: null },
    reviews: { items: Array.from({ length: 100 }, () => ({ author: 'r', state: 'COMMENTED', body: 'x', truncated: true })), total: null, error: null },
    reviewComments: { items: [], total: 0, error: 'github GET /repos/acme/widget/pulls/41/comments -> 403: no' },
    checks: { total: null, passed: 0, failed: 0, pending: 0, other: 0, failing: [], error: 'github GET … -> 403: Resource not accessible' },
  }, fakeDoc())
  assertSafe(root)
  const text = textOf(root)
  for (const want of [
    'merged', 'No description.', 'No comments.', 'Reviews (showing the first 100)', '(cut short: open it on GitHub for the rest)',
    "Couldn't read the inline review comments: github GET /repos/acme/widget/pulls/41/comments -> 403: no",
    "Couldn't read the checks: github GET … -> 403: Resource not accessible",
  ]) assert.ok(text.includes(want), `has ${JSON.stringify(want)}\n${text}`)
})

test('renderPrContext: hostile titles, logins, labels, paths, states and URLs stay text, and no unsafe link is made', () => {
  const evil = '<img src=x onerror=alert(1)>'
  const root = renderPrContext({
    ...CONTEXT,
    title: `<script>alert(1)</script>`, author: evil, labels: [evil, '"><svg onload=alert(1)>'], base: evil, head: '<iframe>',
    url: 'javascript:alert(1)', repoUrl: 'javascript:alert(1)//', state: evil, linkedIssues: [12, '1)alert(1'],
    body: HOSTILE.join('\n\n'),
    comments: { items: [{ author: evil, createdAt: evil, url: 'javascript:alert(1)', body: HOSTILE.join('\n'), truncated: false }], total: '<b>', error: null },
    reviews: { items: [{ author: evil, state: '<script>', submittedAt: null, url: 'data:text/html,x', body: evil, truncated: false }], total: 1, error: evil },
    reviewComments: { items: [{ author: evil, path: '<script>alert(1)</script>.js', line: '<b>', outdated: false, reply: false, url: 'vbscript:x', body: evil, truncated: false }], total: 1, error: null },
    checks: { total: 1, passed: 0, failed: 1, pending: 0, other: 0, failing: [{ name: evil, conclusion: evil, url: 'javascript:alert(1)' }], error: null },
  }, fakeDoc())
  assertSafe(root)
  const out = html(root)
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/)
  // no link to the PR or the repository when their URLs aren't http(s)
  walk(root, n => { if (n.tag === 'a') assert.doesNotMatch(n.attrs.href, /^https:\/\/github\.com\/acme\/widget\/issues/) })
})

test('renderPrContext tolerates a missing or malformed answer', () => {
  for (const data of [null, undefined, {}, { number: 'x', comments: 'no', reviews: [1], reviewComments: { items: 'x' }, checks: 5, labels: 'x' }]) {
    assertSafe(renderPrContext(data, fakeDoc()))
  }
})

// The pane's code builds DOM only: it never hands a string to the HTML parser.
test('the PR context code never parses HTML', () => {
  const start = harnessSrc.indexOf('// --- PR context: safe rendering')
  const end = harnessSrc.indexOf('// --- end PR context rendering')
  assert.ok(start > 0 && end > start, 'the markers are there')
  const ui = harnessSrc.indexOf('// --- PR context pane')
  const uiEnd = harnessSrc.indexOf('// --- end PR context pane')
  assert.ok(ui > 0 && uiEnd > ui, 'the pane markers are there')
  for (const part of [harnessSrc.slice(start, end), harnessSrc.slice(ui, uiEnd)]) {
    assert.doesNotMatch(part, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc|\beval\b|new Function/)
  }
})
