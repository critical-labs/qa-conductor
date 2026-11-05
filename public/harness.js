// PR-QA harness: hash-routed picker → boot → side-by-side session → verdict,
// and Change Review (#/review), which walks the PRs still waiting for one.
// Plain browser JS, zero dependencies. Server state is authoritative on load.
//
// The pure helpers live at top level and are exported through the CommonJS
// guard at the bottom (as bridge.js does) so `node --test` can exercise them;
// the UI IIFE is inert outside a browser. Text that came from a server,
// adapter or PR (titles, build messages, reasons, errors) is rendered with
// textContent or esc(); links from adapters must be https.
/* eslint-env browser */

// One name per boot step, used by the step list, announcements and errors.
// The step ids are the session states and never change.
const LABELS = { 'ensuring-image': 'Building', cloning: 'Preparing data', migrating: 'Migrating', starting: 'Starting' }

function esc(s) {
  return String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Only https links from adapters (build runs) become anchors: no javascript:.
function isHttpsUrl(u) {
  return typeof u === 'string' && /^https:\/\//i.test(u)
}

// Where to send a viewer who opened the harness somewhere other than its
// configured origin (say localhost for 127.0.0.1): the panes refuse to load
// in, or mirror with, any other origin. null when there's nothing to say.
function harnessOriginNotice(configured, current) {
  if (!configured || configured === current) return null
  return `${configured}/qa/`
}

// The text under the first boot step for the latest build event (buildRun's
// shape): its message, else a summary of the run, which names a completed
// run's conclusion when it isn't success.
function buildSummary({ url, status, conclusion, message } = {}) {
  if (message) return message
  if (!url && !status) return 'Build started'
  if (status !== 'completed') return `Build ${status || 'in progress'}`
  return conclusion && conclusion !== 'success' ? `Build ended: ${String(conclusion).replace(/_/g, ' ')}` : 'Build complete'
}

// An SSE `build` event, in buildRun's shape.
function buildFromEvent(e) {
  return { url: e.runUrl, status: e.runStatus, conclusion: e.runConclusion, message: e.message }
}

// Whether an API answer refused the call for want of the capability: a 403
// marked X-QA-Refusal: capability, or, where a pane proxy in front dropped
// that header (self-QA's nested harnesses), so marked in its body.
function isCapabilityRefusal(status, refusalHeader, body) {
  return status === 403 && (refusalHeader === 'capability' || (body !== null && typeof body === 'object' && body.refusal === 'capability'))
}

// What the header's isolation chip says for a verdict (/api/state's
// `isolation`): its text, whether it warns, and its reasons as the title;
// null before there is one.
// A Map, so a verdict named like an Object member is just unknown.
const NOT_ISOLATED = new Map([['reachable', 'not isolated'], ['shared-host', 'shared host']])
function isolationLabel(isolation, strict = false) {
  if (!isolation || typeof isolation !== 'object') return null
  const reasons = Array.isArray(isolation.reasons) ? isolation.reasons.join('; ') : ''
  const label = isolation.verdict === 'isolated'
    ? { text: 'isolated', warn: false, title: 'The PR pane can\'t reach the base pane, so the base pane shows what the base did' }
    : { text: NOT_ISOLATED.get(isolation.verdict) || 'isolation unknown', warn: true, title: reasons }
  if (!strict) return label
  // strict mode (QA_REQUIRE_ISOLATION=1), said beside the verdict
  const rule = 'QA_REQUIRE_ISOLATION=1 refuses a session that isn\'t isolated'
  return { text: `${label.text} · strict`, warn: label.warn, title: label.title ? `${label.title} — ${rule}` : rule }
}

// The kind of action a bridge event is, as the action log marks it (#8), or
// null for one it doesn't: a click, a submit, a change, or Enter.
function markType(event) {
  const type = event && event.type
  if (type === 'click' || type === 'submit' || type === 'change') return type
  if (type === 'keydown' && event.key === 'Enter') return 'enter'
  return null
}

// The review queue (#/review): the PRs of /api/prs still waiting for a
// verdict, in the order Change Review walks them. In: every PR whose labels
// hold neither verdict label (GitHub label names are case-insensitive) and
// whose number isn't in `done` (verdicts this visit posted, should the list
// lag the label). Out, and counted: PRs the build reports as blocked, which
// would fail every boot; and, counted apart, PRs the build's eligible() marks
// `review: false` (not for review: a draft, say, or docs only). Order: built, then building, then the rest; within a
// group the oldest first (createdAt, undated ones after dated ones, then by
// number). PRs in `skipped` come last, in the order they were skipped.
const READINESS_RANK = new Map([['built', 0], ['building', 1]])
// Whether a PR's labels hold either verdict label (GitHub label names are
// case-insensitive).
function hasVerdictLabel(pr, verdictLabels) {
  const verdicts = new Set([verdictLabels?.accept, verdictLabels?.reject].filter(l => typeof l === 'string').map(l => l.toLowerCase()))
  const labels = Array.isArray(pr?.labels) ? pr.labels : []
  return labels.some(l => typeof l === 'string' && verdicts.has(l.toLowerCase()))
}
function reviewQueue(prs, { verdictLabels, skipped = [], done = [] } = {}) {
  const finished = new Set(done.map(Number))
  const skipOrder = new Map(skipped.map((n, i) => [Number(n), i]))
  let blocked = 0
  let notForReview = 0
  const waiting = []
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || !Number.isInteger(pr.number)) continue
    if (hasVerdictLabel(pr, verdictLabels)) continue
    if (finished.has(pr.number)) continue
    if (pr.review === false) { notForReview++; continue }
    if (pr.imageStatus === 'blocked') { blocked++; continue }
    waiting.push(pr)
  }
  const rank = pr => READINESS_RANK.get(pr.imageStatus) ?? 2
  const age = pr => { const t = Date.parse(pr.createdAt ?? ''); return Number.isFinite(t) ? t : Infinity }
  const byAge = (a, b) => rank(a) - rank(b) || age(a) - age(b) || a.number - b.number
  const fresh = waiting.filter(pr => !skipOrder.has(pr.number)).sort(byAge)
  const again = waiting.filter(pr => skipOrder.has(pr.number)).sort((a, b) => skipOrder.get(a.number) - skipOrder.get(b.number))
  return { queue: fresh.concat(again), blocked, notForReview }
}

// --- PR context: safe rendering ----------------------------------------------
// The PR context pane shows text anyone who can open a pull request writes:
// its title, description, comments, file paths, labels and logins. None of it
// ever reaches the HTML parser. A safe subset of Markdown (headings, lists,
// quotes, code, emphasis, links) is parsed here into plain nodes, and those
// become DOM through createElement, createTextNode and setAttribute alone,
// from a fixed list of tags and attributes. Raw HTML in a body shows as the
// text it is. A link is made only for an absolute http(s) URL, and opens in a
// new tab with no opener and no Referer. An image is never loaded: a tracking
// pixel would tell its author who reviews the PR, from where and when, so it
// becomes a link the reviewer can choose to open. The parser runs in linear
// time, near enough, on any input: no regular expression that can backtrack
// over a body, and every closing delimiter found through a lookup table.

// An absolute http(s) URL, normalized by the URL parser (which drops tabs and
// newlines, so `java\tscript:` is `javascript:` and refused), or null.
function safeHref(raw) {
  if (typeof raw !== 'string') return null
  let u
  try { u = new URL(raw.trim()) } catch { return null }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
}

const MD_MAX = 200000 // characters of one body the parser looks at
const MD_DEPTH = 3 // nested quotes, and nested emphasis, beyond which it's text

// Without HTML comments, as GitHub hides them (a PR template's notes); an
// unterminated one is left as text.
function stripComments(s) {
  let out = ''
  let i = 0
  for (;;) {
    const open = s.indexOf('<!--', i)
    if (open === -1) break
    const close = s.indexOf('-->', open + 4)
    if (close === -1) break
    out += s.slice(i, open)
    i = close + 3
  }
  return out + s.slice(i)
}

const isBlank = line => line.trim() === ''
// The run of `ch` at the start of `s`, after up to three spaces: its length, or 0.
function leadRun(s, ch) {
  let i = 0
  while (i < 3 && s[i] === ' ') i++
  let n = 0
  while (s[i + n] === ch) n++
  return n
}
function headingOf(line) {
  const trimmed = line.replace(/^ {0,3}/, '')
  let n = 0
  while (n < 7 && trimmed[n] === '#') n++
  if (n < 1 || n > 6 || (trimmed.length > n && trimmed[n] !== ' ' && trimmed[n] !== '\t')) return null
  let text = trimmed.slice(n).trim()
  // a closing run of #s
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end < text.length && (end === 0 || text[end - 1] === ' ')) text = text.slice(0, end).trim()
  return { level: n, text }
}
function isRule(line) {
  const t = line.trim()
  if (t.length < 3 || line.length - line.trimStart().length > 3) return false
  const ch = t[0]
  if (ch !== '-' && ch !== '*' && ch !== '_') return false
  let count = 0
  for (const c of t) { if (c === ch) count++; else if (c !== ' ' && c !== '\t') return false }
  return count >= 3
}
// A list item's marker: { ordered, indent, rest }, or null.
function listItemOf(line) {
  let i = 0
  while (i < line.length && line[i] === ' ') i++
  const indent = i
  let ordered = false
  if (line[i] === '-' || line[i] === '*' || line[i] === '+') i++
  else {
    const start = i
    while (i - start < 9 && line[i] >= '0' && line[i] <= '9') i++
    if (i === start || (line[i] !== '.' && line[i] !== ')')) return null
    i++; ordered = true
  }
  if (line[i] !== ' ' && line[i] !== '\t') return null
  return { ordered, indent, rest: line.slice(i).trim() }
}
const quoteOf = line => { const m = /^ {0,3}> ?/.exec(line); return m ? line.slice(m[0].length) : null }
const fenceOf = line => { const n = leadRun(line, '`') >= 3 ? leadRun(line, '`') : leadRun(line, '~'); return n >= 3 ? { ch: line.trimStart()[0], n } : null }

// Markdown text → block nodes: {t:'h', level, text} {t:'p', text}
// {t:'pre', text, cls?} {t:'list', ordered, items:[text]} {t:'quote', blocks}
// {t:'hr'}. Inline text is parsed when rendered.
function mdParse(src, depth = 0) {
  const text = depth === 0 ? stripComments(String(src ?? '').slice(0, MD_MAX).replace(/\r\n?/g, '\n')) : String(src)
  const lines = text.split('\n')
  const blocks = []
  let para = []
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: para.join('\n') }); para = [] } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isBlank(line)) { flush(); continue }
    const fence = fenceOf(line)
    if (fence) {
      flush()
      const body = []
      for (i++; i < lines.length; i++) {
        const close = fenceOf(lines[i])
        if (close && close.ch === fence.ch && close.n >= fence.n && lines[i].trim().length === close.n) break
        body.push(lines[i])
      }
      blocks.push({ t: 'pre', text: body.join('\n') })
      continue
    }
    const heading = headingOf(line)
    if (heading) { flush(); blocks.push({ t: 'h', level: heading.level, text: heading.text }); continue }
    if (isRule(line)) { flush(); blocks.push({ t: 'hr' }); continue }
    if (quoteOf(line) !== null) {
      flush()
      const inner = []
      while (i < lines.length && quoteOf(lines[i]) !== null) inner.push(quoteOf(lines[i++]))
      i--
      blocks.push(depth < MD_DEPTH ? { t: 'quote', blocks: mdParse(inner.join('\n'), depth + 1) } : { t: 'p', text: inner.join('\n') })
      continue
    }
    if (line.trimStart()[0] === '|') {
      flush()
      const rows = []
      while (i < lines.length && !isBlank(lines[i]) && lines[i].trimStart()[0] === '|') rows.push(lines[i++].trim())
      i--
      blocks.push({ t: 'pre', text: rows.join('\n'), cls: 'table' })
      continue
    }
    const item = listItemOf(line)
    if (item) {
      flush()
      const list = { t: 'list', ordered: item.ordered, items: [] }
      while (i < lines.length) {
        const it = listItemOf(lines[i])
        if (it && it.ordered === list.ordered) { list.items.push(it.rest); i++; continue }
        // a nested item, or a line that continues the last item
        if (it || (!isBlank(lines[i]) && /^\s/.test(lines[i]))) { list.items[list.items.length - 1] += `\n${it ? it.rest : lines[i].trim()}`; i++; continue }
        break
      }
      i--
      blocks.push(list)
      continue
    }
    para.push(line.trim())
  }
  flush()
  return blocks
}

// For each position, the next index at or after it where `tok` starts, or -1:
// so finding a closing delimiter is one lookup, never a scan.
function nextTable(s, tok) {
  const t = new Int32Array(s.length + 1).fill(-1)
  for (let i = s.length - 1; i >= 0; i--) t[i] = s.startsWith(tok, i) ? i : t[i + 1]
  return t
}
const isWord = c => c !== undefined && /[A-Za-z0-9]/.test(c)
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

// Inline Markdown → nodes: {t:'text', v} {t:'code', v} {t:'br'}
// {t:'strong'|'em'|'del', c} {t:'link', href, c} {t:'image', href, alt}.
// A link's href is already safe, or the link is just its text.
function mdInline(s, opts = {}, depth = 0) {
  const out = []
  let buf = ''
  const push = node => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } out.push(node) }
  const tables = new Map()
  const next = (tok, from) => {
    if (from > s.length) return -1
    if (!tables.has(tok)) tables.set(tok, nextTable(s, tok))
    return tables.get(tok)[from]
  }
  const inner = text => (depth < MD_DEPTH ? mdInline(text, opts, depth + 1) : [{ t: 'text', v: text }])
  const repo = safeHref(opts.repoUrl)
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && ASCII_PUNCT.includes(s[i + 1] ?? 'x')) { buf += s[i + 1]; i += 2; continue }
    if (c === '\n') { push({ t: 'br' }); i++; continue }
    if (c === '`') {
      let n = 0
      while (s[i + n] === '`') n++
      const close = s.indexOf('`'.repeat(n), i + n)
      if (close === -1) { buf += '`'.repeat(n); i += n; continue }
      push({ t: 'code', v: s.slice(i + n, close).replace(/\n/g, ' ') })
      i = close + n
      continue
    }
    // [text](url) and ![alt](url); a title after the URL is dropped
    if ((c === '[' || (c === '!' && s[i + 1] === '[')) && !opts.inLink) {
      const open = c === '!' ? i + 1 : i
      const close = next(']', open + 1)
      if (close !== -1 && s[close + 1] === '(') {
        // a URL may hold balanced parentheses: javascript:alert(1)
        let end = next(')', close + 2)
        for (let tries = 0; end !== -1 && end - close < 2048 && tries < 4; tries++) {
          const url = s.slice(close + 2, end)
          if (url.split('(').length <= url.split(')').length) break
          end = next(')', end + 1)
        }
        if (end !== -1 && end - close < 2048) {
          const label = s.slice(open + 1, close)
          const href = safeHref(s.slice(close + 2, end).trim().split(/\s/)[0] ?? '')
          if (c === '!') push({ t: 'image', href, alt: label })
          else if (href) push({ t: 'link', href, c: mdInline(label, { ...opts, inLink: true }, depth + 1) })
          else out.push(...(buf ? [{ t: 'text', v: buf }] : []), ...mdInline(label, { ...opts, inLink: true }, depth + 1)), (buf = '')
          i = end + 1
          continue
        }
      }
    }
    // <https://…>
    if (c === '<' && !opts.inLink) {
      const end = next('>', i + 1)
      if (end !== -1 && end - i < 2048) {
        const inside = s.slice(i + 1, end)
        const href = /\s/.test(inside) ? null : safeHref(inside)
        if (href && /^https?:\/\//i.test(inside)) { push({ t: 'link', href, c: [{ t: 'text', v: inside }] }); i = end + 1; continue }
      }
    }
    // a bare URL, without trailing punctuation
    if ((c === 'h' || c === 'H') && !opts.inLink && !isWord(s[i - 1]) && /^https?:\/\//i.test(s.slice(i, i + 8))) {
      let end = i
      while (end < s.length && !/[\s<>]/.test(s[end])) end++
      while (end > i && '.,;:!?)\'"*_~'.includes(s[end - 1])) end--
      const href = safeHref(s.slice(i, end))
      if (href) { push({ t: 'link', href, c: [{ t: 'text', v: s.slice(i, end) }] }); i = end; continue }
    }
    // #123, a reference to an issue or pull request in this repository
    if (c === '#' && repo && !opts.inLink && !isWord(s[i - 1]) && s[i - 1] !== '&' && /[0-9]/.test(s[i + 1] ?? '')) {
      let end = i + 1
      while (end < s.length && end - i <= 9 && /[0-9]/.test(s[end])) end++
      if (!isWord(s[end])) {
        const href = safeHref(`${repo.replace(/\/$/, '')}/issues/${s.slice(i + 1, end)}`)
        if (href) { push({ t: 'link', href, c: [{ t: 'text', v: s.slice(i, end) }] }); i = end; continue }
      }
    }
    // @login, a GitHub user
    if (c === '@' && !opts.inLink && !isWord(s[i - 1]) && isWord(s[i + 1])) {
      let end = i + 1
      while (end < s.length && end - i <= 39 && (isWord(s[end]) || s[end] === '-')) end++
      if (!isWord(s[end]) && s[end] !== '-' && s[end] !== '@' && s[end] !== '.' || (s[end] === '.' && !isWord(s[end + 1]))) {
        push({ t: 'link', href: `https://github.com/${s.slice(i + 1, end)}`, c: [{ t: 'text', v: s.slice(i, end) }] })
        i = end
        continue
      }
    }
    // **strong**, __strong__, *em*, _em_, ~~del~~
    if (c === '*' || c === '_' || c === '~') {
      const double = s[i + 1] === c
      const marks = double ? [c + c, c] : [c]
      let done = false
      for (const mark of marks) {
        if (mark === '~') continue // one tilde is text
        if (c === '_' && isWord(s[i - 1])) break // snake_case
        if (/\s/.test(s[i + mark.length] ?? ' ')) continue
        const close = next(mark, i + mark.length + 1)
        if (close === -1 || /\s/.test(s[close - 1])) continue
        if (c === '_' && isWord(s[close + mark.length])) continue
        const kind = mark === '~~' ? 'del' : mark.length === 2 ? 'strong' : 'em'
        push({ t: kind, c: inner(s.slice(i + mark.length, close)) })
        i = close + mark.length
        done = true
        break
      }
      if (done) continue
      const run = double ? 2 : 1
      buf += s.slice(i, i + run)
      i += run
      continue
    }
    buf += c
    i++
  }
  if (buf) out.push({ t: 'text', v: buf })
  return out
}

// Elements with only safe attributes: a link always opens apart.
function el(doc, tag, attrs = {}, ...children) {
  const e = doc.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v)
  for (const child of children) e.append(typeof child === 'string' ? doc.createTextNode(child) : child)
  return e
}
function link(doc, href, ...children) {
  const safe = safeHref(href)
  if (!safe) return el(doc, 'span', {}, ...children)
  return el(doc, 'a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, ...children)
}

function inlineNodes(nodes, doc) {
  return nodes.map(n => {
    if (n.t === 'text') return doc.createTextNode(n.v)
    if (n.t === 'br') return el(doc, 'br')
    if (n.t === 'code') return el(doc, 'code', {}, n.v)
    if (n.t === 'link') return link(doc, n.href, ...inlineNodes(n.c, doc))
    if (n.t === 'image') return n.href ? link(doc, n.href, `image: ${n.alt}`) : doc.createTextNode(`image: ${n.alt}`)
    return el(doc, n.t, {}, ...inlineNodes(n.c, doc))
  })
}

// Block nodes → a div.md. Headings sit below the pane's own: # is an h4.
function mdRender(blocks, doc, opts = {}) {
  const root = el(doc, 'div', { class: 'md' })
  const inline = text => inlineNodes(mdInline(text, opts), doc)
  const render = (list, into) => {
    for (const b of list) {
      if (b.t === 'h') into.append(el(doc, `h${Math.min(6, b.level + 3)}`, {}, ...inline(b.text)))
      else if (b.t === 'p') into.append(el(doc, 'p', {}, ...inline(b.text)))
      else if (b.t === 'pre') into.append(b.cls ? el(doc, 'pre', { class: b.cls }, b.text) : el(doc, 'pre', {}, el(doc, 'code', {}, b.text)))
      else if (b.t === 'hr') into.append(el(doc, 'hr'))
      else if (b.t === 'quote') { const q = el(doc, 'blockquote'); render(b.blocks, q); into.append(q) }
      else if (b.t === 'list') {
        const l = el(doc, b.ordered ? 'ol' : 'ul')
        for (const item of b.items) {
          const task = /^\[([ xX])\][ \t]/.exec(item)
          l.append(el(doc, 'li', {}, ...(task ? [task[1] === ' ' ? '☐ ' : '☑ '] : []), ...inline(task ? item.slice(4) : item)))
        }
        into.append(l)
      }
    }
  }
  render(Array.isArray(blocks) ? blocks : [], root)
  return root
}

// The pane's content for an /api/pr-context answer: the PR at a glance, then
// its description, reviews, conversation and inline review comments, each a
// collapsible section. Every string in it is the PR's, and untrusted.
function renderPrContext(data, doc) {
  const d = data && typeof data === 'object' ? data : {}
  const s = v => (typeof v === 'string' ? v : '')
  const opts = { repoUrl: safeHref(d.repoUrl) }
  const root = el(doc, 'div', { class: 'ctx' })
  const when = iso => {
    const t = Date.parse(s(iso))
    if (!Number.isFinite(t)) return null
    return el(doc, 'time', { datetime: new Date(t).toISOString() }, new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
  }
  const words = v => s(v).toLowerCase().replace(/_/g, ' ')
  const note = text => el(doc, 'p', { class: 'ctxNote' }, text)
  const CUT = '(cut short: open it on GitHub for the rest)'
  const body = (text, truncated) => {
    const out = [s(text).trim() ? mdRender(mdParse(text), doc, opts) : null, truncated ? note(CUT) : null]
    return out.filter(Boolean)
  }

  // at a glance
  root.append(el(doc, 'h3', { class: 'ctxTitle' }, `#${Number.isInteger(d.number) ? d.number : '?'} ${s(d.title)}`))
  const state = d.merged ? 'merged' : d.draft ? 'draft' : words(d.state) || 'open'
  const meta = el(doc, 'p', { class: 'ctxMeta' }, el(doc, 'span', { class: 'ctxState' }, state), ' · ', s(d.author) || 'ghost', ' · ', `${s(d.base)} ← ${s(d.head)}`)
  root.append(meta)
  const labels = Array.isArray(d.labels) ? d.labels.filter(l => typeof l === 'string') : []
  if (labels.length) root.append(el(doc, 'p', { class: 'ctxLabels' }, ...labels.map(l => el(doc, 'span', { class: 'ctxLabel' }, l))))
  if (safeHref(d.url)) root.append(el(doc, 'p', {}, link(doc, d.url, 'Open on GitHub ↗')))

  const c = d.checks && typeof d.checks === 'object' ? d.checks : null
  if (c && c.error) root.append(note(`Couldn't read the checks: ${s(c.error)}`))
  else if (c && Number.isInteger(c.total)) {
    const n = k => (Number.isInteger(c[k]) ? c[k] : 0)
    const parts = [n('passed') && `${n('passed')} passed`, n('failed') && `${n('failed')} failed`, n('pending') && `${n('pending')} pending`, n('other') && `${n('other')} other`].filter(Boolean)
    const p = el(doc, 'p', { class: 'ctxChecks' }, `Checks: ${c.total === 0 ? 'none' : parts.join(' · ')}`)
    const failing = Array.isArray(c.failing) ? c.failing : []
    if (failing.length) {
      const ul = el(doc, 'ul', { class: 'ctxFailing' })
      for (const f of failing) ul.append(el(doc, 'li', {}, link(doc, f && f.url, `${s(f && f.name)} (${words(f && f.conclusion)})`)))
      p.append(ul)
    }
    root.append(p)
  }
  const issues = (Array.isArray(d.linkedIssues) ? d.linkedIssues : []).filter(Number.isInteger)
  if (issues.length) {
    const p = el(doc, 'p', { class: 'ctxIssues' }, 'Closes ')
    issues.forEach((n, i) => {
      if (i) p.append(', ')
      p.append(opts.repoUrl ? link(doc, `${opts.repoUrl.replace(/\/$/, '')}/issues/${n}`, `#${n}`) : `#${n}`)
    })
    root.append(p)
  }

  const section = (title, ...children) => el(doc, 'details', { open: '' }, el(doc, 'summary', {}, title), ...children)
  root.append(section('Description', ...(s(d.body).trim() ? body(d.body, d.bodyTruncated) : [note('No description.'), ...(d.bodyTruncated ? [note(CUT)] : [])])))

  // a list section: its count, what it couldn't read, and its items
  const listSection = (key, title, what, empty, item) => {
    const list = d[key] && typeof d[key] === 'object' ? d[key] : {}
    const items = Array.isArray(list.items) ? list.items.filter(x => x && typeof x === 'object') : []
    const total = Number.isInteger(list.total) ? list.total : null
    const count = total === null ? (items.length >= 100 ? `showing the first ${items.length}` : `${items.length}`)
      : total > items.length ? `showing ${items.length} of ${total}` : `${items.length}`
    const kids = []
    if (list.error) kids.push(note(`Couldn't read the ${what}: ${s(list.error)}`))
    else if (items.length === 0) kids.push(note(empty))
    for (const it of items) kids.push(item(it))
    root.append(section(`${title} (${count})`, ...kids))
  }
  const head = (it, ...extra) => {
    const h = el(doc, 'p', { class: 'ctxWho' }, el(doc, 'strong', {}, s(it.author) || 'ghost'), ...extra)
    const t = when(it.createdAt || it.submittedAt)
    if (t) h.append(' · ', safeHref(it.url) ? link(doc, it.url, t) : t)
    else if (safeHref(it.url)) h.append(' · ', link(doc, it.url, 'link ↗'))
    return h
  }
  listSection('reviews', 'Reviews', 'reviews', 'No reviews.', it => el(doc, 'div', { class: 'ctxItem' },
    head(it, ' ', el(doc, 'span', { class: `ctxVerdict ${/^[A-Z_]{1,30}$/.test(s(it.state)) ? s(it.state).toLowerCase() : ''}` }, words(it.state))),
    ...body(it.body, it.truncated)))
  listSection('comments', 'Conversation', 'conversation', 'No comments.', it => el(doc, 'div', { class: 'ctxItem' }, head(it), ...body(it.body, it.truncated)))
  listSection('reviewComments', 'Inline review comments', 'inline review comments', 'No inline review comments.', it => el(doc, 'div', { class: 'ctxItem' },
    el(doc, 'p', { class: 'ctxPath' }, el(doc, 'code', {}, `${s(it.path)}${Number.isInteger(it.line) ? `:${it.line}` : ''}`), it.outdated ? ' (outdated)' : '', it.reply ? ' · reply' : ''),
    head(it), ...body(it.body, it.truncated)))
  return root
}
// --- end PR context rendering ------------------------------------------------

// The ticket an invite link carries in its fragment (#enrol=<ticket>), else
// null. The fragment never reaches a server or a Referer.
function inviteFromHash(hash) {
  const m = /^#enrol=([A-Za-z0-9_-]+)$/.exec(String(hash ?? ''))
  return m ? m[1] : null
}

;(() => {
  if (typeof window === 'undefined') return
  const $ = id => document.getElementById(id)

  // This browser's capability: the token the conductor gave it at enrolment,
  // kept at the harness origin (localStorage is per origin, port included, so
  // no pane can read it) and sent as X-QA-Cap on every API call. Where
  // storage throws (a private window, say), it lasts until a reload.
  const CAP_KEY = 'qa-cap'
  let capMemory = null
  const cap = {
    get() { try { return localStorage.getItem(CAP_KEY) ?? capMemory } catch { return capMemory } },
    set(token) { capMemory = token; try { localStorage.setItem(CAP_KEY, token) } catch { /* memory only */ } },
    clear() { capMemory = null; try { localStorage.removeItem(CAP_KEY) } catch { /* nothing kept */ } },
  }

  const api = (path, opts = {}) => {
    const token = cap.get()
    const headers = { ...(opts.headers || {}), ...(token ? { 'x-qa-cap': token } : {}) }
    return fetch(`/qa/api${path}`, { ...opts, headers }).then(async r => {
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        const e = new Error(body.error || `HTTP ${r.status}`); e.status = r.status; e.body = body
        // a restart revoked the token, or it was never given one
        e.capability = isCapabilityRefusal(r.status, r.headers.get('x-qa-refusal'), body)
        // not when the token refused is one already replaced
        if (e.capability && path !== '/enrol' && cap.get() === token) lostCapability()
        throw e
      }
      return body
    })
  }
  // The harness refuses non-JSON POSTs (415), so every write goes through here.
  const postJson = (path, body = {}) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const announce = (msg, assertive) => { const el = $(assertive ? 'announcerAssertive' : 'announcer'); el.textContent = ''; el.textContent = msg }
  const stepLabel = step => LABELS[step] || step
  const tagOf = img => (img || '').split(':').pop()
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  const BOOTING = ['ensuring-image', 'cloning', 'migrating', 'starting']

  const S = {
    pr: null, panes: null, paneOrigins: null, mounted: null, startedAt: null,
    mirror: true, scrollMirror: true,
    path: { base: '', pr: '' }, lastMsg: { base: 0, pr: 0 }, hasNav: { base: false, pr: false },
    unmatched: { base: 0, pr: 0 },
    es: null, idlePoll: null, dotPoll: null, notesTimer: null, confirmTimer: null, pendingVerdict: null, strict: false,
    // the configured verdict labels, from /api/state
    verdictLabels: null,
    // Change Review: `on` while the page is at #/review; `queue` and
    // `blocked` from the last /api/prs read; `current` the PR the walk is on
    // (null between PRs, which lets the next render open the head);
    // `posted` the last verdict's PR and comment URL, shown until the next
    // session is ready; `error` the last failed queue read.
    // `warming` the PR whose build /api/prebuild started for the queue
    review: { on: false, queue: [], blocked: 0, notForReview: 0, current: null, posted: null, error: null, warming: null },
  }

  // What this visit skipped, the PRs it posted a verdict for whose label the
  // PR list hasn't shown yet (`done`, dropped once it does), and how many it
  // reviewed, kept in the tab's session storage so a reload at #/review
  // carries on; in memory where storage throws.
  const REVIEW_KEY = 'qa-review'
  let reviewMemory = { skipped: [], done: [], reviewed: 0 }
  const reviewStore = {
    get() {
      try {
        const v = JSON.parse(sessionStorage.getItem(REVIEW_KEY) || 'null')
        if (v && Array.isArray(v.skipped) && Array.isArray(v.done)) {
          return { skipped: v.skipped.map(Number), done: v.done.map(Number), reviewed: Number.isInteger(v.reviewed) ? v.reviewed : 0 }
        }
      } catch { /* memory only */ }
      return reviewMemory
    },
    set(v) {
      reviewMemory = v
      try { sessionStorage.setItem(REVIEW_KEY, JSON.stringify(v)) } catch { /* memory only */ }
    },
  }

  // --- router --------------------------------------------------------------
  function parseHash() {
    const h = location.hash.replace(/^#/, '') || '/'
    let m = h.match(/^\/pr\/(\d+)\/boot$/); if (m) return { view: 'boot', pr: +m[1] }
    m = h.match(/^\/pr\/(\d+)\/verdict$/); if (m) return { view: 'verdict', pr: +m[1] }
    m = h.match(/^\/pr\/(\d+)$/); if (m) return { view: 'session', pr: +m[1] }
    if (h === '/review') return { view: 'review', pr: null }
    return { view: 'picker', pr: null }
  }
  const go = hash => { if (location.hash !== hash) location.hash = hash; else render() }
  const setHashSilent = hash => history.replaceState(null, '', hash)

  function showView(id) {
    for (const v of ['enrol', 'picker', 'boot', 'session', 'verdictDone', 'queueClear', 'reviewHold']) $(v).hidden = v !== id
    $('sessionControls').hidden = id !== 'session'
    $('verdictBar').hidden = id !== 'session'
    $('inviteBtn').hidden = id === 'enrol'
    // Change Review's strip over its views, and its bar under the panes
    const review = S.review.on && ['boot', 'session', 'queueClear', 'reviewHold'].includes(id)
    $('reviewStrip').hidden = !review
    $('reviewBar').hidden = !(S.review.on && id === 'session')
    document.body.classList.toggle('review', S.review.on)
    // the PR context pane belongs to a PR's boot and session
    if (id !== 'boot' && id !== 'session') contextFor(null)
    const heading = { boot: 'bootHeading', session: 'sessionHeading', reviewHold: 'holdHeading' }[id]
    const h = heading ? $(heading) : document.querySelector(`#${id} h1`)
    if (h) setTimeout(() => h.focus(), 0)
  }

  // --- enrolment -------------------------------------------------------------
  // The conductor enrols a browser while no PR code can be running, or with an
  // invite link (#enrol=<ticket>) from a browser it has enrolled.
  let enrolling = null
  let enrolledAt = 0

  // Resolves, once the view it then renders is up, to whether this browser
  // holds the token it got: one refused while that view was drawn is gone.
  async function enrol(invite = null) {
    let token
    try {
      ({ token } = await postJson('/enrol', invite ? { invite } : {}))
    } catch (err) {
      // a browser already enrolled that opens a spent invite stays as it was
      if (invite && cap.get()) { announce(`Invite link not used: ${err.message}`, true); render(); return false }
      showEnrol(err)
      return false
    }
    cap.set(token); enrolledAt = Date.now()
    await render()
    return cap.get() === token
  }

  // An API call was refused for want of the capability: drop the token and
  // enrol again, once at a time. A token refused just after it was given
  // (while the view after enrolling is drawn, say) shows the enrolment view
  // instead of trying again.
  function lostCapability() {
    cap.clear()
    if (Date.now() - enrolledAt < 5000) return showEnrol(null)
    if (enrolling) return
    enrolling = enrol().finally(() => { enrolling = null })
  }

  function showEnrol(err) {
    teardownSessionUi()
    showView('enrol'); setPill('not enrolled')
    // the harness origin, for the banner when this isn't it
    const origin = err && err.body ? err.body.harnessOrigin : null
    if (origin) showOriginNotice(origin)
    $('enrolReason').textContent = err && err.body && err.body.reason ? `Enrolment is closed: ${err.body.reason}.`
      : err && !err.capability && origin ? `Open the harness at ${origin}/qa/ to enrol this browser.`
        : err ? err.message : 'This browser lost its enrolment.'
  }
  $('enrolRetry').onclick = () => { if (!enrolling) enrolling = enrol().finally(() => { enrolling = null }) }

  // An enrolled browser hands out a link that enrols one more, once, within
  // ten minutes, whatever is running.
  $('inviteBtn').onclick = async () => {
    try {
      const { url, expiresAt } = await postJson('/invite')
      $('inviteLink').value = url
      $('inviteExpiry').textContent = `It works once, until ${new Date(expiresAt).toLocaleTimeString()}.`
      $('inviteCopy').textContent = 'Copy'
      $('inviteDialog').showModal(); $('inviteLink').select()
    } catch (err) { if (!err.capability) announce(`Invite failed: ${err.message}`, true) }
  }
  $('inviteCopy').onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText($('inviteLink').value).then(() => { $('inviteCopy').textContent = 'Copied' }, () => {}) }
  $('inviteClose').onclick = () => $('inviteDialog').close()
  function setPill(text) { $('statusPill').textContent = text }

  // The session's isolation verdict, in the header; none while idle.
  function showIsolation(isolation) {
    const el = $('isolationChip'); const label = isolationLabel(isolation, S.strict)
    el.hidden = !label
    if (!label) return
    el.textContent = label.text; el.title = label.title; el.classList.toggle('warn', label.warn)
    el.setAttribute('aria-label', `Isolation: ${label.text}. ${label.title}`)
  }

  // The banner for a harness opened at another origin. Its text is set as
  // text, and the link is made only for an http(s) URL.
  function showOriginNotice(configured) {
    const el = $('originNotice')
    const url = harnessOriginNotice(configured, location.origin)
    el.textContent = ''
    el.hidden = !url
    if (!url) return
    el.append('This harness is meant to be opened at ')
    if (/^https?:\/\//i.test(url)) {
      const a = document.createElement('a'); a.href = url; a.textContent = url
      el.append(a)
    } else {
      el.append(url)
    }
    el.append('. The panes load and mirror only there.')
  }

  async function render() {
    const route = parseHash()
    let s
    try {
      s = await api('/state'); showOriginNotice(s.harnessOrigin); S.strict = s.requireIsolation === true; showIsolation(s.status === 'idle' ? null : s.isolation)
      if (s.verdictLabels) S.verdictLabels = s.verdictLabels
    } catch (e) {
      if (e && e.capability) return // enrolment takes over
      // At another host or port than the harness origin's, the API refuses a
      // browser (403 not the harness origin) and names the origin instead.
      showOriginNotice(e && e.body ? e.body.harnessOrigin : null)
      s = { status: 'idle' }
    }
    if (route.view === 'review') return renderReview(s)
    // any other route leaves Change Review; a session it opened stays
    leaveReview()
    const active = s.status !== 'idle'
    if (route.view === 'picker' || !route.pr) { teardownSessionUi(); return renderPicker(s) }
    if (active && s.pr === route.pr) {
      if (s.status === 'ready') return renderSession(s)
      return renderBoot(route.pr, s)
    }
    teardownSessionUi()
    if (active) return renderPicker(s, { conflictFor: route.pr })
    return renderPicker(s, { endedFor: route.pr })
  }

  // --- picker --------------------------------------------------------------
  const rows = new Map()
  let picking = false

  async function renderPicker(state, opts = {}) {
    setHashSilent('#/')
    showView('picker')
    setPill(state && state.status !== 'idle' ? `session: #${state.pr}` : 'idle')
    renderConflict(state, opts)
    try {
      const { prs, session } = await api('/prs')
      patchRows(prs, session)
    } catch (err) {
      if (err && err.capability) return // enrolment takes over, and renders again
      $('prList').textContent = `Failed to load PRs: ${err.message}`
    }
  }

  function renderConflict(state, opts) {
    const slot = $('conflictSlot'); slot.innerHTML = ''
    if (opts.endedFor) {
      const n = document.createElement('div'); n.className = 'note'
      n.textContent = `Session for #${opts.endedFor} has ended (idle teardown or manual). Pick a PR to start a new one.`
      slot.appendChild(n); return
    }
    if (opts.conflictFor && state && state.status !== 'idle') {
      slot.appendChild(conflictCard(state, opts.conflictFor))
    }
  }

  function conflictCard(state, wantPr) {
    const now = Date.now()
    const readyFor = state.startedAt ? mmss(now - state.startedAt) : '—'
    const idleFor = state.lastActivity ? mmss(now - state.lastActivity) : '—'
    const endsIn = state.lastActivity && state.idleMinutes ? mmss(state.lastActivity + state.idleMinutes * 60000 - now) : '—'
    const c = document.createElement('div'); c.className = 'conflict'
    c.innerHTML = `<h2>A session is already running on #${state.pr}${state.title ? ' — ' + esc(state.title) : ''}</h2>`
      + `<div class="times">${state.status === 'ready' ? `ready ${readyFor}` : esc(state.status)} · idle ${idleFor} · auto-ends in ${endsIn}</div>`
      + `<div class="acts"><button class="secondary" data-resume="${state.pr}">Resume #${state.pr}</button>`
      + `<button class="danger-ghost" data-takeover="${wantPr}">End #${state.pr} and open #${wantPr}</button>`
      + `<button class="ghost" data-back="1">Back</button></div>`
    c.querySelector('[data-resume]').onclick = () => go(`#/pr/${state.pr}`)
    c.querySelector('[data-back]').onclick = () => { $('conflictSlot').innerHTML = '' }
    twoStepConfirm(c.querySelector('[data-takeover]'), 'End & open?', () => openSession(wantPr, { takeover: true }).catch(err => {
      if (!showConflict(err, wantPr)) announce(`Couldn't open #${wantPr}: ${err.message}`, true)
    }))
    return c
  }

  function patchRows(prs, session) {
    const list = $('prList')
    // Text that stood in for the rows ("Loading…", "No open PRs.", an error)
    // detached them all: clear it, and each row is appended again below.
    if (![...rows.values()].some(row => row.parentNode === list)) list.textContent = ''
    if (!prs.length) { list.textContent = 'No open PRs.'; rows.clear(); return }
    const seen = new Set()
    for (const pr of prs) {
      seen.add(pr.number)
      let row = rows.get(pr.number)
      if (!row) { row = document.createElement('div'); row.className = 'pr'; row.dataset.pr = pr.number; rows.set(pr.number, row) }
      if (row.parentNode !== list) list.appendChild(row)
      const holds = session && session.pr === pr.number && session.status !== 'idle'
      const num = esc(pr.number)
      // A blocked PR can still be opened: the build's ensureBuilt is the real gate.
      const action = holds
        ? `<button class="primary" data-open="${num}" data-resume="1">QA session active — Resume</button>`
        : `<button class="primary" data-open="${num}">Open QA</button>`
      row.innerHTML = `<span class="num">#${num}</span>`
        + `<span class="main"><span class="title">${esc(pr.title)}</span>`
        + `<span class="submeta">${esc(pr.headRef || '')}${pr.author ? ' · ' + esc(pr.author) : ''} </span>`
        // left out of Change Review by the build's eligible(), but open by hand
        + (pr.review === false ? `<span class="skipNote">not for review${pr.skipReason ? ': ' + esc(pr.skipReason) : ''}</span>` : '')
        + `<span class="rowErr" hidden></span></span>${action}`
      row.querySelector('.submeta').appendChild(imageBadge(pr))
    }
    for (const [num, row] of rows) if (!seen.has(num)) { row.remove(); rows.delete(num) }
  }

  function runLink(url, text) {
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = text
    return a
  }

  function imageBadge(pr) {
    const badge = document.createElement('span'); badge.className = 'badge'
    const dot = document.createElement('span')
    let text
    if (pr.imageStatus === 'built') { dot.className = 'dot green'; text = 'ready — opens in seconds' }
    else if (pr.imageStatus === 'building') { dot.className = 'dot amber pulse'; text = 'building…' }
    else if (pr.imageStatus === 'blocked') { dot.className = 'dot grey'; badge.classList.add('blocked'); text = `can't boot: ${pr.reason || 'not allowed'}` }
    else { dot.className = 'dot amber'; text = 'needs build (~10 min)' }
    badge.append(dot, document.createTextNode(text))
    if (pr.imageStatus === 'building' && isHttpsUrl(pr.runUrl)) badge.append(' ', runLink(pr.runUrl, 'run ↗'))
    return badge
  }

  // delegated picker clicks — survive re-renders
  $('prList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-open]'); if (!btn) return
    const num = +btn.dataset.open
    if (btn.dataset.resume) return go(`#/pr/${num}`)
    // one Open QA at a time: rows redrawn meanwhile (a re-enrolment's) are
    // enabled, but take no click
    if (picking) return
    // the row stays while it is re-rendered (a re-enrolment's, say); the
    // buttons in it don't
    const row = btn.closest('.pr')
    for (const b of $('prList').querySelectorAll('button[data-open]')) b.disabled = true
    btn.textContent = 'Opening…'; row.setAttribute('aria-busy', 'true')
    openSession(num).catch(err => {
      row.removeAttribute('aria-busy')
      for (const b of $('prList').querySelectorAll('button[data-open]')) b.disabled = false
      if (!showConflict(err, num)) { const slot = row.querySelector('.rowErr'); slot.hidden = false; slot.textContent = err.message }
    })
  })

  // A 409 naming the session that holds the conductor gets its conflict
  // card. Returns whether it did.
  function showConflict(err, num) {
    if (!(err.status === 409 && err.body && err.body.session)) return false
    $('conflictSlot').innerHTML = ''; $('conflictSlot').appendChild(conflictCard(err.body.session, num))
    return true
  }
  $('refreshBtn').onclick = () => renderPicker(null)
  $('reviewBtn').onclick = () => go('#/review')

  async function openSession(num, opts = {}) {
    if (picking) return; picking = true
    try {
      await postJson('/session', { pr: num, ...opts }).catch(async err => {
        // A restart revoked the token, and with it any session: once this
        // browser has enrolled again, ask once more. Not as a takeover: a
        // session started since gets its conflict card, not an unseen end.
        if (!(err.capability && enrolling && await enrolling)) throw err
        return postJson('/session', { pr: num })
      })
      // Change Review stays at #/review: its strip sits over the boot view
      if (S.review.on) renderBoot(num, null); else go(`#/pr/${num}/boot`)
    } finally { picking = false }
  }

  // --- Change Review (#/review) --------------------------------------------
  // The walk: the PRs still waiting for a verdict (reviewQueue), one session
  // at a time. A verdict or a skip ends the PR and the next render opens the
  // next one; the hash stays #/review throughout, and server state is
  // authoritative on load, so a reload carries on where it was.
  let reviewing = null // the render in flight, so two never open two sessions

  function renderReview(state) {
    reviewing ??= reviewWalk(state).catch(err => announce(`Change Review: ${err.message}`, true)).finally(() => { reviewing = null })
    return reviewing
  }

  // Leaving #/review for any other view: the walk forgets where it was, so a
  // later visit starts from the queue head, and a session it opened stays.
  function leaveReview() { S.review.on = false; S.review.current = null; S.review.posted = null; S.review.error = null }

  async function reviewWalk(state) {
    S.review.on = true
    // the page left #/review while this walk awaited: nothing more to draw
    const left = () => parseHash().view !== 'review'
    let prs
    try { ({ prs } = await api('/prs')) } catch (err) {
      if (err && err.capability) return // enrolment takes over, and renders again
      if (left()) return
      // the queue can't be read: say so, and keep showing a session the walk
      // was on, if any
      S.review.error = err.message
      if (state.status !== 'idle' && Number.isInteger(state.pr)) {
        S.review.current = state.pr; renderStrip()
        return state.status === 'ready' ? renderSession(state) : renderBoot(state.pr, state)
      }
      renderStrip(); showView('queueClear'); setPill('review')
      return
    }
    if (left()) return
    S.review.error = null
    const stored = reviewStore.get()
    // the sessions the walk itself opened and finished or skipped: these it
    // may end without asking; any other running session is the reviewer's
    const owned = pr => stored.done.includes(pr) || stored.skipped.includes(pr)
    // a PR whose verdict label the list now shows needs no more cover
    const done = stored.done.filter(n => !prs.some(p => p.number === n && hasVerdictLabel(p, S.verdictLabels)))
    if (done.length !== stored.done.length) reviewStore.set({ ...stored, done })
    const { skipped } = stored
    const { queue, blocked, notForReview } = reviewQueue(prs, { verdictLabels: S.verdictLabels, skipped, done })
    S.review.queue = queue; S.review.blocked = blocked; S.review.notForReview = notForReview
    const active = state.status !== 'idle' && state.status !== 'error'
    const previous = S.review.current // null on a fresh entry, or after a verdict or skip
    if (queue.length === 0) {
      S.review.current = null
      // a session on a PR the walk never opened is the reviewer's: ask
      if (active && !owned(state.pr)) return showHold('foreign-empty', state)
      // nothing left: end the walk's own last session and say so
      if (active || state.status === 'error') {
        teardownSessionUi(); await postJson('/teardown').catch(() => {})
        if (left()) return
      }
      renderStrip(); showView('queueClear'); setPill('queue clear')
      const b = $('queueClearBlocked'); b.hidden = blocked === 0 && notForReview === 0
      const one = notForReview === 1
      b.textContent = [
        blocked === 0 ? '' : `${blocked} can't boot and ${blocked === 1 ? 'is' : 'are'} left out.`,
        notForReview === 0 ? '' : `${notForReview} not for review ${one ? 'is' : 'are'} left out; open ${one ? 'it' : 'them'} from the pull requests.`,
      ].filter(Boolean).join(' ')
      return
    }
    const queued = active && queue.some(p => p.number === state.pr)
    S.review.current = queued ? state.pr : queue[0].number
    renderStrip()
    if (active && !queued) {
      // the session is on a PR the queue is done with: replace it with the
      // next; on any other PR, ask (a review started from the picker, say)
      if (owned(state.pr)) { teardownSessionUi(); return openSession(S.review.current, { takeover: true }) }
      return showHold('foreign', state)
    }
    if (active) return state.status === 'ready' ? renderSession(state) : renderBoot(state.pr, state)
    // a boot of the current PR failed: its error, with Retry, Skip and Stop
    if (state.status === 'error' && state.pr === S.review.current) return renderBoot(state.pr, state)
    // the walk was on this very PR and its session ended (the idle teardown,
    // say): don't boot it again by itself
    if (previous !== null && previous === S.review.current) return showHold('ended', state)
    teardownSessionUi()
    return openSession(S.review.current)
  }

  // Warm the queue's next PR while this one is reviewed, so its boot finds
  // the image. The conductor asks the build adapter once per PR; the strip
  // says "warming" while the answer is that a build started.
  function warmNext() {
    const next = S.review.queue.find(p => p.number !== S.review.current)
    if (!next || next.imageStatus === 'built' || next.imageStatus === 'building') return
    postJson('/prebuild', { pr: next.number }).then(r => {
      if (r && r.started && S.review.on) { S.review.warming = next.number; renderStrip() }
    }).catch(() => {})
  }

  // The strip: the PR, the count, what's next, the blocked and not-for-review counts, the last
  // verdict, and a failed queue read. Titles and errors are text.
  function renderStrip() {
    const r = S.review
    const { reviewed } = reviewStore.get()
    const pr = r.queue.find(p => p.number === r.current) || null
    $('reviewNum').textContent = r.current === null ? '' : `#${r.current}`
    $('reviewTitle').textContent = pr && pr.title ? pr.title : ''
    const total = reviewed + r.queue.length
    $('reviewCount').textContent = r.queue.length ? `${reviewed + 1} of ${total}` : `${reviewed} of ${total} done`
    const next = r.queue.filter(p => p.number !== r.current)[0]
    const warming = next && r.warming === next.number ? ' · warming' : ''
    $('reviewNext').textContent = r.queue.length === 0 ? '' : next ? `next #${next.number}${warming}` : 'last one'
    $('reviewBlocked').textContent = [r.blocked ? `${r.blocked} can't boot` : '', r.notForReview ? `${r.notForReview} not for review` : ''].filter(Boolean).join(' · ')
    const posted = $('reviewPosted'); posted.textContent = ''
    if (r.posted) {
      posted.append(`Posted to #${r.posted.pr}`)
      if (isHttpsUrl(r.posted.url)) { posted.append(' '); posted.append(runLink(r.posted.url, '↗')) }
    }
    $('reviewError').hidden = !r.error
    $('reviewErrorText').textContent = r.error ? `Couldn't load the queue: ${r.error}` : ''
  }

  // A pause in the walk: a session on a PR outside the queue ('foreign'), or
  // the current PR's session gone ('ended').
  function showHold(kind, state) {
    const n = S.review.current
    showView('reviewHold'); setPill('review')
    $('holdResume').hidden = kind === 'ended'
    if (kind !== 'ended') {
      $('holdHeading').textContent = `A session is running on #${state.pr}, which isn't in the queue`
      $('holdResume').textContent = `Resume #${state.pr}`
      $('holdResume').onclick = () => { leaveReview(); go(`#/pr/${state.pr}`) }
      if (kind === 'foreign-empty') {
        $('holdText').textContent = 'No other pull request is waiting for a verdict. Resume it in the plain harness, or end it.'
        $('holdPrimary').textContent = `End #${state.pr}`
        twoStepConfirm($('holdPrimary'), 'End?', async () => { teardownSessionUi(); await postJson('/teardown').catch(() => {}); renderReview({ status: 'idle' }) })
      } else {
        $('holdText').textContent = `Resume it in the plain harness, or end it and open #${n}, the next pull request waiting for a verdict.`
        $('holdPrimary').textContent = `End #${state.pr} and open #${n}`
        twoStepConfirm($('holdPrimary'), 'End & open?', () => { teardownSessionUi(); openSession(n, { takeover: true }).catch(err => announce(`Couldn't open #${n}: ${err.message}`, true)) })
      }
    } else {
      $('holdHeading').textContent = `The session for #${n} has ended`
      $('holdText').textContent = 'The idle teardown, or someone ending it. Continue to open it again, or skip it.'
      $('holdPrimary').textContent = `Continue with #${n}`
      $('holdPrimary').onclick = () => { teardownSessionUi(); openSession(n).catch(err => announce(`Couldn't open #${n}: ${err.message}`, true)) }
    }
  }
  $('holdStop').onclick = () => stopReview()

  function stopReview() { leaveReview(); go('#/') }
  $('stopBtn').onclick = stopReview
  $('queueBack').onclick = stopReview
  $('queueAgain').onclick = () => api('/state').then(renderReview, () => renderReview({ status: 'idle' }))
  $('reviewRetry').onclick = () => api('/state').then(renderReview, () => renderReview({ status: 'idle' }))

  // Skip: the current PR goes to the back of the queue for this visit, its
  // session ends, and the next opens.
  async function skipReview() {
    const pr = S.review.current
    if (pr === null) return
    // a walk in flight may be opening a session: a skip now would be lost
    if (reviewing) return announce('Change Review is busy; try again in a moment', true)
    const stored = reviewStore.get()
    reviewStore.set({ ...stored, skipped: stored.skipped.filter(n => n !== pr).concat(pr) })
    S.review.current = null; S.review.posted = null
    teardownSessionUi()
    await postJson('/teardown').catch(() => {})
    return renderReview({ status: 'idle' })
  }
  twoStepConfirm($('skipBtn'), 'Skip? (3s)', skipReview)
  twoStepConfirm($('barSkip'), 'Skip?', skipReview)

  // A verdict posted in Change Review: the PR is done, and the next opens.
  async function reviewAdvance(pr, url) {
    const { skipped, done, reviewed } = reviewStore.get()
    reviewStore.set({ skipped: skipped.filter(n => n !== pr), done: done.includes(pr) ? done : done.concat(pr), reviewed: reviewed + 1 })
    S.review.posted = { pr, url }; S.review.current = null
    hideVerdictBody(); $('verdictPreview').hidden = true; $('verdictEdit').hidden = false
    teardownSessionUi()
    let s
    try { s = await api('/state') } catch { s = { status: 'ready', pr } }
    return renderReview(s)
  }

  // The compact bar: one pane at a time, flipped with a thumb.
  $('switchBase').onclick = () => selectTab('base')
  $('switchPr').onclick = () => selectTab('pr')
  $('barVerdict').onclick = () => toggleVerdict()

  // --- boot ----------------------------------------------------------------
  const stepAt = {}
  let bootPr = null
  for (const li of $('bootSteps').querySelectorAll('li')) li.querySelector('.stepLabel').textContent = stepLabel(li.dataset.step)

  function renderBoot(pr, state) {
    showView('boot'); setPill(`booting #${pr}`)
    if (bootPr !== pr) { bootPr = pr; for (const k of Object.keys(stepAt)) delete stepAt[k]; resetBootUi() }
    $('bootPr').textContent = pr
    contextFor(pr)
    if (state && state.buildRun) setBuildSub(state.buildRun)
    attachSse()
  }
  function resetBootUi() {
    for (const li of $('bootSteps').querySelectorAll('li')) { li.classList.remove('now', 'done'); li.removeAttribute('aria-current'); li.querySelector('.stepTime').textContent = '' }
    $('bootSteps').querySelector('[data-step="ensuring-image"] .stepSub').textContent = ''
    $('bootError').hidden = true; $('bootActions').hidden = true; $('bootActions').textContent = ''; $('bootBar').hidden = false
    $('bootTotal').textContent = ''
  }
  function stepIndex(step) { return BOOTING.indexOf(step) }
  function markStep(step, at) {
    stepAt[step] = at || Date.now()
    const cur = stepIndex(step)
    for (const li of $('bootSteps').querySelectorAll('li')) {
      const i = stepIndex(li.dataset.step)
      li.classList.toggle('now', i === cur); li.classList.toggle('done', i < cur)
      if (i === cur) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current')
    }
    announce(`${stepLabel(step)}, step ${cur + 1} of 4`)
  }
  // Build progress under the first step: the BuildConvention's own message
  // when it sends one, else a summary of its CI run, plus an https run link.
  function setBuildSub(build = {}) {
    const { url } = build
    const sub = $('bootSteps').querySelector('[data-step="ensuring-image"] .stepSub')
    sub.textContent = ` — ${buildSummary(build)}`
    if (isHttpsUrl(url)) sub.append(' ', runLink(url, 'view run ↗'))
  }
  let bootTimer = null
  function tickBoot() {
    const now = Date.now()
    const first = stepAt['ensuring-image']
    if (first) $('bootTotal').textContent = mmss(now - first)
    for (const li of $('bootSteps').querySelectorAll('li')) {
      const step = li.dataset.step, tEl = li.querySelector('.stepTime')
      const started = stepAt[step]; if (!started) continue
      const next = BOOTING[stepIndex(step) + 1]
      const ended = next && stepAt[next]
      tEl.textContent = mmss((ended || now) - started)
    }
  }

  function attachSse() {
    if (S.es) return
    // EventSource can't send a header, so the token goes in the URL
    const es = new EventSource(`/qa/api/progress?cap=${encodeURIComponent(cap.get() || '')}`); S.es = es
    if (!bootTimer) bootTimer = setInterval(tickBoot, 1000)
    // It reconnects by itself, but not after a refusal: state says why.
    es.onerror = () => { if (S.es === es && es.readyState === EventSource.CLOSED) { closeSse(); setTimeout(render, 1000) } }
    es.onmessage = ev => {
      const e = JSON.parse(ev.data)
      if (e.kind === 'step') markStep(e.step, e.at)
      else if (e.kind === 'build') setBuildSub(buildFromEvent(e))
      else if (e.kind === 'isolation') showIsolation(e)
      else if (e.kind === 'ready') { closeSse(); onReady(e) }
      else if (e.kind === 'error') showBootError(e)
      else if (e.kind === 'torn-down') { closeSse(); if (S.review.on) render(); else go('#/') }
    }
  }
  function closeSse() { if (S.es) { S.es.close(); S.es = null } if (bootTimer) { clearInterval(bootTimer); bootTimer = null } }

  function showBootError(e) {
    const cached = stepAt['ensuring-image'] === undefined
    if (cached) $('bootSteps').querySelector('[data-step="ensuring-image"] .stepSub').textContent = 'Already built'
    $('bootBar').hidden = true
    showErrorText(`Failed at ${stepLabel(e.step)}: ${e.message}`, e.logTail)
    announce(`Boot failed at ${stepLabel(e.step)}: ${e.message}`, true)
    const acts = $('bootActions'); acts.hidden = false; acts.textContent = ''
    const retry = mkBtn('Retry boot', 'primary', () => { resetBootUi(); openSession(bootPr).catch(showOpenErr) })
    const back = mkBtn('Back to pull requests', 'ghost', () => go('#/'))
    acts.append(retry)
    if (S.review.on) acts.append(mkBtn('Skip', 'danger-ghost', skipReview), mkBtn('Stop', 'ghost', stopReview))
    else acts.append(back)
    if (e.step === 'ensuring-image' && isHttpsUrl(e.runUrl)) { const a = runLink(e.runUrl, 'View build log ↗'); a.className = 'btn secondary'; acts.append(a) }
  }
  function showErrorText(line, tail) {
    const pre = $('bootError'); pre.hidden = false; pre.textContent = ''
    const span = document.createElement('span'); span.className = 'errline'; span.textContent = line
    pre.append(span)
    if (tail) pre.append(tail)
  }
  function showOpenErr(err) { showErrorText(err.message) }
  function mkBtn(text, cls, onclick) { const b = document.createElement('button'); b.className = cls; b.textContent = text; b.onclick = onclick; return b }
  $('cancelBoot').onclick = async () => { leaveReview(); await postJson('/teardown').catch(() => {}); go('#/') }

  // --- session -------------------------------------------------------------
  function onReady(meta) { if (!S.review.on) setHashSilent(`#/pr/${meta.pr || bootPr}`); showIsolation(meta.isolation); renderSession(meta) }

  function renderSession(meta) {
    const pr = meta.pr || bootPr || parseHash().pr
    showView('session'); setPill(`session: #${pr}`)
    const panes = meta.panes
    if (S.mounted !== pr) {
      S.mounted = pr; S.startedAt = meta.startedAt ?? null; S.pr = pr; S.panes = panes; S.paneOrigins = [panes.baseOrigin, panes.prOrigin]
      S.path = { base: '', pr: '' }; S.hasNav = { base: false, pr: false }; S.lastMsg = { base: Date.now(), pr: Date.now() }
      S.unmatched = { base: 0, pr: 0 }; renderUnmatched('base'); renderUnmatched('pr')
      // as given: the pane proxy tells each pane's bridge whom to talk to
      enterPane('base', panes.base); enterPane('pr', panes.pr)
      $('baseOpen').href = panes.baseOrigin; $('prOpen').href = panes.prOrigin
      setDot('base', 'amber', 'signing in…'); setDot('pr', 'amber', 'signing in…')
      $('baseUrl').textContent = 'signing in…'; $('prUrl').textContent = 'signing in…'
      restoreDraft(pr)
      startIdlePoll(); startDotPoll()
      announce('QA session ready')
      if (S.review.on) { S.review.posted = null; renderStrip(); warmNext() }
    }
    $('sessionMeta').innerHTML = meta.baseTag ? `#${pr} · <span class="tag">${esc(tagOf(meta.baseTag))}</span> vs <span class="tag">${esc(tagOf(meta.prTag))}</span>` : `#${pr}`
    $('sessionHeading').textContent = `QA session for PR ${pr}`
    contextFor(pr)
  }

  function teardownSessionUi() {
    S.mounted = null; S.startedAt = null; closeSse()
    if (S.idlePoll) { clearInterval(S.idlePoll); S.idlePoll = null }
    if (S.dotPoll) { clearInterval(S.dotPoll); S.dotPoll = null }
    $('baseFrame').removeAttribute('src'); $('prFrame').removeAttribute('src')
    hideVerdictBody()
  }

  const paneOf = origin => origin === S.paneOrigins[0] ? 'base' : origin === S.paneOrigins[1] ? 'pr' : null
  const frameOf = pane => pane === 'base' ? $('baseFrame') : $('prFrame')
  // A path a pane's bridge reported, on that pane's origin: as a bare path,
  // one that starts with // would name another host, which the conductor
  // refuses. The conductor checks what this gives stays on the pane.
  const onPane = (pane, path) => `${S.paneOrigins[pane === 'base' ? 0 : 1]}${path}`

  // Loads a pane's frame at `to` (a URL or path on that pane) through a
  // one-time link, which sets the pane cookie first: the panes answer only a
  // browser that holds it. A failure shows on the pane's bar.
  async function enterPane(pane, to) {
    try {
      const { url } = await postJson('/pane-entry', { role: pane, to: to || '/' })
      frameOf(pane).src = url
    } catch (err) {
      if (err.capability) return
      setDot(pane, 'red', err.message); $(pane + 'Url').textContent = err.message
    }
  }
  function setDot(pane, cls, title) { const d = $(pane + 'Dot'); d.className = 'dot ' + cls; d.title = title }
  function renderUnmatched(pane) {
    const el = $(pane + 'Unmatched'); const n = S.unmatched[pane]
    el.hidden = n === 0; el.textContent = `${n} unmatched`
    const tab = document.querySelector(`.tab[data-tab="${pane}"]`)
    if (tab) { let b = tab.querySelector('.tabBadge'); if (n === 0) { if (b) b.remove() } else { if (!b) { b = document.createElement('span'); b.className = 'tabBadge'; tab.appendChild(b) } b.textContent = n } }
  }
  function updateDivergence() {
    const diverged = S.hasNav.base && S.hasNav.pr && S.path.base !== S.path.pr
    document.querySelector('.pane[data-pane="base"]').classList.toggle('diverged', diverged)
    document.querySelector('.pane[data-pane="pr"]').classList.toggle('diverged', diverged)
    let dot = $('resyncBtn').querySelector('.dot'); if (diverged && !dot) { dot = document.createElement('span'); dot.className = 'dot amber'; dot.style.marginLeft = '4px'; $('resyncBtn').appendChild(dot) } else if (!diverged && dot) dot.remove()
  }

  window.addEventListener('message', ev => {
    if (!S.paneOrigins || !S.paneOrigins.includes(ev.origin)) return
    const d = ev.data; if (!d || d.qa !== 1) return
    const pane = paneOf(ev.origin); if (!pane) return
    S.lastMsg[pane] = Date.now()
    if (d.kind === 'event') {
      markAction(pane, d)
      if (!S.mirror) return
      if (d.type === 'scroll' && !S.scrollMirror) return
      const other = pane === 'base' ? 'pr' : 'base'
      frameOf(other).contentWindow.postMessage({ ...d, kind: 'replay' }, S.paneOrigins[other === 'base' ? 0 : 1])
    } else if (d.kind === 'nav') {
      S.path[pane] = d.href; S.hasNav[pane] = true
      $(pane + 'Url').textContent = d.href; setDot(pane, 'green', 'live')
      updateDivergence()
    } else if (d.kind === 'ping') {
      if (S.hasNav[pane]) setDot(pane, 'green', 'live')
    } else if (d.kind === 'unmatched') {
      S.unmatched[pane]++; renderUnmatched(pane)
      const wrap = frameOf(pane).closest('.paneWrap'); wrap.classList.remove('flash'); void wrap.offsetWidth; wrap.classList.add('flash')
      announce(`Interaction not mirrored to ${pane === 'pr' ? 'PR' : 'base'} pane`)
    }
  })

  // #8: each action a pane's bridge reports, mirrored or not, becomes a mark
  // in the session's action log: the pane and the kind of action, never the
  // element or a value. At most one of each kind a pane every 100 ms, as the
  // conductor keeps: a click and the submit it sets off are two. The pane's
  // own page can post such messages, so the log labels a mark as reported
  // by that pane. A monotonic clock: a step back of the system clock must
  // not hold marks back.
  const lastMark = new Map()
  function markAction(pane, d) {
    const type = markType(d)
    if (type === null) return
    const now = performance.now()
    const kind = `${pane} ${type}`
    if (now - (lastMark.get(kind) ?? -Infinity) < 100) return
    lastMark.set(kind, now)
    postJson('/actions/mark', { pane, type }).catch(() => {})
  }

  function startDotPoll() {
    S.dotPoll = setInterval(() => {
      const now = Date.now()
      for (const pane of ['base', 'pr']) {
        if (!S.hasNav[pane]) continue
        if (now - S.lastMsg[pane] > 10000) setDot(pane, 'grey', 'stale — no bridge signal >10s')
      }
    }, 3000)
  }

  // pane bar controls
  document.querySelector('#paneRow').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return
    const pane = btn.dataset.pane
    // where the pane's bridge last said it was, else its landing page
    if (btn.dataset.act === 'reload') enterPane(pane, S.path[pane] ? onPane(pane, S.path[pane]) : S.panes[pane])
    else if (btn.dataset.act === 'copy') navigator.clipboard && navigator.clipboard.writeText(S.path[pane] || '/')
  })
  for (const p of ['base', 'pr']) $(p + 'Unmatched').onclick = () => { S.unmatched[p] = 0; renderUnmatched(p) }

  // header controls
  $('mirrorBtn').onclick = () => setMirror(!S.mirror)
  function setMirror(on) { S.mirror = on; $('mirrorBtn').textContent = `Mirror: ${on ? 'on' : 'off'}`; $('mirrorBtn').classList.toggle('on', on) }
  menuToggle('mirrorMenuBtn', 'mirrorMenu')
  menuToggle('resyncMenuBtn', 'resyncMenu')
  $('scrollMirror').onchange = e => { S.scrollMirror = e.target.checked }
  $('resyncBtn').onclick = () => { enterPane('pr', onPane('pr', S.path.base || '/')); S.path.pr = S.path.base; updateDivergence() }
  $('resyncLeft').onclick = () => { enterPane('base', onPane('base', S.path.pr || '/')); S.path.base = S.path.pr; updateDivergence(); $('resyncMenu').hidden = true }
  for (const btn of document.querySelectorAll('button[data-width]')) btn.onclick = () => setWidth(+btn.dataset.width, btn)
  function setWidth(w, btn) {
    for (const f of [$('baseFrame'), $('prFrame')]) f.style.width = w ? `${w}px` : '100%'
    for (const b of document.querySelectorAll('button[data-width]')) b.classList.toggle('on', b === (btn || document.querySelector(`button[data-width="${w}"]`)))
  }
  function menuToggle(btnId, menuId) {
    $(btnId).onclick = e => { e.stopPropagation(); const m = $(menuId); m.hidden = !m.hidden; $(btnId).setAttribute('aria-expanded', String(!m.hidden)) }
  }
  document.addEventListener('click', () => { $('mirrorMenu').hidden = true; $('resyncMenu').hidden = true })
  for (const m of ['mirrorMenu', 'resyncMenu']) $(m).addEventListener('click', e => e.stopPropagation())

  // idle countdown chip
  function startIdlePoll() { pollIdle(); S.idlePoll = setInterval(pollIdle, 60000) }
  async function pollIdle() {
    let s; try { s = await api('/state') } catch { return }
    if (S.mounted === null) return // the view went meanwhile
    // a view mounted from the ready event learns its session's start here
    if (S.startedAt === null && s.status === 'ready' && s.pr === S.mounted) S.startedAt = s.startedAt
    // The session this view shows ended, or was opened again (by another
    // browser, say), whose panes took new pane cookies: draw it afresh.
    if (s.status !== 'ready' || s.pr !== S.mounted || s.startedAt !== S.startedAt) { teardownSessionUi(); return render() }
    if (!s.lastActivity || !s.idleMinutes) return
    const left = s.lastActivity + s.idleMinutes * 60000 - Date.now()
    const chip = $('idleChip'); chip.textContent = `auto-end ${mmss(left)}`
    const low = left < 5 * 60000; chip.classList.toggle('warn', low)
    if (low) announce(`QA session ends in ${Math.ceil(left / 60000)} minutes unless you interact`)
  }

  // teardown two-step
  twoStepConfirm($('teardownBtn'), 'Confirm end? (3s)', async () => { await postJson('/teardown').catch(() => {}); go('#/') })
  function twoStepConfirm(btn, confirmLabel, action) {
    const orig = btn.textContent
    btn.onclick = () => {
      if (btn.dataset.armed) { clearTimeout(S.confirmTimer); btn.dataset.armed = ''; btn.textContent = orig; btn.classList.remove('confirm'); return action() }
      btn.dataset.armed = '1'; btn.textContent = confirmLabel; btn.classList.add('confirm')
      S.confirmTimer = setTimeout(() => { btn.dataset.armed = ''; btn.textContent = orig; btn.classList.remove('confirm') }, 3000)
    }
    btn._disarm = () => { if (btn.dataset.armed) { clearTimeout(S.confirmTimer); btn.dataset.armed = ''; btn.textContent = orig; btn.classList.remove('confirm') } }
  }

  // --- verdict drawer ------------------------------------------------------
  $('verdictToggle').onclick = () => toggleVerdict()
  function toggleVerdict(force) {
    const body = $('verdictBody'); const open = force !== undefined ? force : body.hidden
    body.hidden = !open; $('verdictToggle').setAttribute('aria-expanded', String(open))
    if (open) { $('verdictPreview').hidden = true; $('verdictEdit').hidden = false; $('notes').focus() }
  }
  function hideVerdictBody() { $('verdictBody').hidden = true; $('verdictToggle').setAttribute('aria-expanded', 'false') }
  const draftKey = pr => `qa-notes-${pr}`
  function restoreDraft(pr) { $('notes').value = localStorage.getItem(draftKey(pr)) || '' }
  $('notes').addEventListener('input', () => { clearTimeout(S.notesTimer); S.notesTimer = setTimeout(() => { if (S.pr) localStorage.setItem(draftKey(S.pr), $('notes').value) }, 500) })

  $('acceptBtn').onclick = () => openPreview('accept')
  $('rejectBtn').onclick = () => openPreview('reject')
  async function openPreview(verdict) {
    S.pendingVerdict = verdict
    const q = `?verdict=${verdict}&notes=${encodeURIComponent($('notes').value)}`
    let body = '(preview unavailable — post will still work)', applies = verdict === 'accept' ? 'qa-approved' : 'qa-changes-requested', removes = verdict === 'accept' ? 'qa-changes-requested' : 'qa-approved'
    try { const r = await api('/verdict/preview' + q); body = r.body || body; applies = r.applies || applies; removes = r.removes || removes } catch { /* keep fallback */ }
    $('previewBody').textContent = body
    $('previewLabelChange').textContent = `Will apply ${applies}, remove ${removes}.`
    const postBtn = $('postBtn'); postBtn.textContent = `Post to PR #${S.pr}`; postBtn.className = verdict === 'accept' ? 'primary' : 'danger'
    $('verdictEdit').hidden = true; $('verdictPreview').hidden = false
  }
  $('previewBack').onclick = () => { $('verdictPreview').hidden = true; $('verdictEdit').hidden = false }
  $('postBtn').onclick = async () => {
    const postBtn = $('postBtn'); postBtn.disabled = true; $('previewBack').disabled = true
    try {
      const { url } = await postJson('/verdict', { verdict: S.pendingVerdict, notes: $('notes').value })
      localStorage.removeItem(draftKey(S.pr))
      announce('Verdict posted')
      postBtn.disabled = false; $('previewBack').disabled = false
      if (S.review.on) return reviewAdvance(S.pr, url)
      $('doneP').textContent = S.pr; $('doneLink').href = url
      go(`#/pr/${S.pr}/verdict`)
    } catch (err) { postBtn.disabled = false; $('previewBack').disabled = false; $('previewLabelChange').textContent = `Failed: ${err.message}` }
  }

  // verdict-done view is rendered on demand; wire once
  $('doneEnd').onclick = async () => { await postJson('/teardown').catch(() => {}); go('#/') }
  $('doneKeep').onclick = () => go(`#/pr/${S.pr}`)
  $('doneBack').onclick = () => go('#/')

  // when routed to #/pr/n/verdict but state lost (reload), fall back to session
  function maybeVerdictDone() {
    const r = parseHash()
    if (r.view === 'verdict' && $('doneLink').href && +$('doneP').textContent === r.pr) { showView('verdictDone'); setPill(`session: #${r.pr}`); return true }
    return false
  }

  // --- PR context pane -------------------------------------------------------
  // A side pane beside the panes, or below 900 pixels a modal overlay, with
  // the PR's description, comments, reviews and checks (/api/pr-context,
  // drawn by renderPrContext, which never parses HTML). It is there while a
  // PR boots or its session is up, closed by default: the header's button or
  // `c` toggles it, and whether it is open lives in the tab's session storage,
  // so the next PR of a walk opens with it as the last was left.
  const CTX_KEY = 'qa-context'
  const CTX_FRESH_MS = 60000 // how long a read is shown again without asking
  let ctxMemory = false
  const ctxStore = {
    get() { try { const v = sessionStorage.getItem(CTX_KEY); return v === null ? ctxMemory : v === 'open' } catch { return ctxMemory } },
    set(open) { ctxMemory = open; try { sessionStorage.setItem(CTX_KEY, open ? 'open' : 'closed') } catch { /* memory only */ } },
  }
  const CTX = { pr: null, open: false, cache: new Map(), loading: null, opener: null }
  let compact = false

  // The PR the pane is about, from the boot or session view; null hides the
  // pane and its button, and leaves the stored choice alone.
  function contextFor(pr) {
    const changed = CTX.pr !== pr
    CTX.pr = pr
    $('contextBtn').hidden = pr === null
    if (pr === null || !ctxStore.get()) return showContext(false)
    if (changed || !CTX.open) showContext(true)
  }

  function showContext(open, { focus = false } = {}) {
    const pane = $('prContext')
    CTX.open = open
    pane.hidden = !open
    $('contextBtn').setAttribute('aria-expanded', String(open))
    $('contextBtn').classList.toggle('on', open)
    if (!open) return
    $('ctxNum').textContent = `#${CTX.pr}`
    loadContext(CTX.pr)
    // the overlay is modal: focus goes into it
    if (focus || compact) setTimeout(() => $('ctxHeading').focus(), 0)
  }

  function toggleContext() {
    if (CTX.pr === null) return
    if (!CTX.open) {
      CTX.opener = document.activeElement
      ctxStore.set(true); showContext(true, { focus: true })
      return
    }
    closeContext()
  }
  function closeContext() {
    ctxStore.set(false); showContext(false)
    // focus back where it was, or to the button that opens the pane
    const back = CTX.opener && CTX.opener !== document.body && CTX.opener.isConnected ? CTX.opener : $('contextBtn')
    CTX.opener = null
    if (back && typeof back.focus === 'function') back.focus()
  }

  async function loadContext(pr, force = false) {
    if (pr === null) return
    const hit = CTX.cache.get(pr)
    if (hit && !force && Date.now() - hit.at < CTX_FRESH_MS) return drawContext(hit.data)
    if (CTX.loading === pr) return
    CTX.loading = pr
    setCtxStatus('Loading…', false)
    if (!hit) $('ctxBody').textContent = ''
    try {
      const data = await api(`/pr-context?pr=${encodeURIComponent(pr)}`)
      CTX.cache.set(pr, { at: Date.now(), data })
      if (CTX.pr === pr) drawContext(data)
    } catch (err) {
      if (err && err.capability) return // enrolment takes over
      if (CTX.pr === pr) setCtxStatus(`Couldn't load the PR context: ${err.message}`, true)
    } finally {
      if (CTX.loading === pr) CTX.loading = null
    }
  }
  function setCtxStatus(text, failed) {
    $('ctxStatus').textContent = text; $('ctxStatus').hidden = !text
    $('ctxRetry').hidden = !failed
  }
  function drawContext(data) {
    setCtxStatus('', false)
    const body = $('ctxBody'); body.textContent = ''
    body.append(renderPrContext(data, document))
  }

  $('contextBtn').onclick = () => toggleContext()
  $('ctxClose').onclick = () => closeContext()
  $('ctxRefresh').onclick = () => loadContext(CTX.pr, true)
  $('ctxRetry').onclick = () => loadContext(CTX.pr, true)
  // Esc closes the pane from inside it; the overlay keeps Tab inside itself.
  $('prContext').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); return closeContext() }
    if (e.key !== 'Tab' || !compact) return
    const items = [...$('prContext').querySelectorAll('a[href], button, summary')].filter(x => !x.hidden && x.offsetParent !== null)
    if (!items.length) return
    const first = items[0], last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === $('ctxHeading'))) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  })
  // Below 900 pixels the pane is an overlay, a modal dialog; above, a region.
  function applyContextLayout(isCompact) {
    compact = isCompact
    const pane = $('prContext')
    pane.setAttribute('role', compact ? 'dialog' : 'region')
    if (compact) pane.setAttribute('aria-modal', 'true'); else pane.removeAttribute('aria-modal')
  }
  // --- end PR context pane ---------------------------------------------------

  // --- keyboard ------------------------------------------------------------
  document.addEventListener('keydown', e => {
    if ($('inviteDialog').open) return // its own keys; Escape closes it
    if ($('shortcuts').open && e.key === 'Escape') return $('shortcuts').close()
    if (e.key === '?') { e.preventDefault(); return $('shortcuts').showModal() }
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    // the PR context pane, in a boot or a session; not Cmd-C or Ctrl-C
    if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !$('contextBtn').hidden) { e.preventDefault(); return toggleContext() }
    if (e.key === 'Escape' && CTX.open && compact) return closeContext()
    if ($('session').hidden) return
    const keys = ['m', 's', 'r', '1', '2', '3', 'v', 'e', 'n']
    if (keys.includes(e.key)) e.preventDefault()
    switch (e.key) {
      case 'n': if (S.review.on) $('skipBtn').click(); break
      case 'm': setMirror(!S.mirror); break
      case 's': $('scrollMirror').checked = !$('scrollMirror').checked; S.scrollMirror = $('scrollMirror').checked; break
      case 'r': $('resyncBtn').click(); break
      case '1': setWidth(375); break
      case '2': setWidth(768); break
      case '3': setWidth(0); break
      case 'v': toggleVerdict(); break
      case 'e': $('teardownBtn').click(); break
      case 'Escape': for (const id of ['teardownBtn', 'skipBtn', 'barSkip', 'holdPrimary']) $(id)._disarm && $(id)._disarm(); if (!$('verdictBody').hidden) hideVerdictBody(); break
    }
  })
  $('shortcutsClose').onclick = () => $('shortcuts').close()

  // --- compact <900px ------------------------------------------------------
  const mq = window.matchMedia('(max-width: 900px)')
  function applyCompact() { document.body.classList.toggle('compact', mq.matches); $('tabs').hidden = !mq.matches; if (mq.matches) selectTab(currentTab); applyContextLayout(mq.matches) }
  let currentTab = 'base'
  $('tabs').addEventListener('click', e => { const t = e.target.closest('.tab'); if (t) selectTab(t.dataset.tab) })
  function selectTab(which) {
    currentTab = which
    $('switchBase').classList.toggle('on', which === 'base'); $('switchPr').classList.toggle('on', which === 'pr')
    for (const tab of $('tabs').querySelectorAll('.tab')) tab.classList.toggle('on', tab.dataset.tab === which)
    for (const pane of document.querySelectorAll('#paneRow .pane')) pane.classList.toggle('activeTab', pane.dataset.pane === which)
  }
  mq.addEventListener('change', applyCompact); applyCompact()

  // --- boot ----------------------------------------------------------------
  window.addEventListener('hashchange', () => {
    if (inviteFromHash(location.hash)) start() // an invite link opened in this tab
    else if (!maybeVerdictDone()) render()
  })

  // An invite link's ticket leaves the URL before it is used, so neither a
  // reload nor the history holds it. Without a token, enrol now.
  function start() {
    // Framed by another page (an admin page that embeds the harness, which
    // QA_HARNESS_FRAME_ANCESTORS allows): a theme may style it for that.
    let framed = false
    try { framed = window.self !== window.top } catch { framed = true }
    document.body.classList.toggle('framed', framed)
    const invite = inviteFromHash(location.hash)
    if (invite) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/`)
      enrolling = enrol(invite).finally(() => { enrolling = null })
    } else if (!cap.get()) {
      enrolling = enrol().finally(() => { enrolling = null })
    } else {
      render()
    }
  }
  start()
})()

// --- test exports (node --test evaluates this file through a CJS wrapper) ---

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, isHttpsUrl, LABELS, harnessOriginNotice, buildSummary, buildFromEvent, inviteFromHash, isCapabilityRefusal, isolationLabel, hasVerdictLabel, reviewQueue, safeHref, mdParse, mdRender, renderPrContext }
}
