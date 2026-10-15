// Demo pane app: a small multi-page storefront the demo provisioner serves
// in-process, one instance per pane. It gives the mirror bridge real material:
// a nav bar linking several pages, a GET filter form, POST forms that
// redirect, in-page anchors and long pages that scroll.
//
// The `pr` variant is the change under review: a new heading, a purple accent
// instead of blue, and a sort control the base doesn't have (using it shows up
// as an unmatched interaction in the base pane). Everything echoed back is
// HTML-escaped. The cart, the messages and the saved carts live in the
// pane's store (createStore), which the demo Provisioner makes with the
// pane's database, so each session starts clean, like a freshly cloned
// database, and the demo inspector reads it. A PR app made with
// `clearsSavedCarts` has a bug for the data checks to catch: its "Empty
// cart" deletes the saved carts too.

export const VARIANTS = {
  base: { heading: 'Acme Widgets', accent: '#1d4ed8', sort: false },
  pr: { heading: 'Acme Widget Studio', accent: '#9333ea', sort: true },
}

const NAMES = ['Sprocket', 'Gizmo', 'Flange', 'Doohickey', 'Gasket', 'Coupler', 'Bracket', 'Spindle']
const TIERS = ['Mini', 'Pro', 'Max']
const CATEGORIES = ['parts', 'tools', 'kits']
export const PRODUCTS = NAMES.flatMap((name, i) => TIERS.map((tier, j) => ({
  slug: `${name}-${tier}`.toLowerCase(),
  name: `${name} ${tier}`,
  category: CATEGORIES[(i + j) % CATEGORIES.length],
  price: 4.99 + i * 3 + j * 7,
})))

const SORTS = [['featured', 'Featured'], ['price-asc', 'Price: low to high'], ['price-desc', 'Price: high to low']]
const TOPICS = [['order', 'An order'], ['product', 'A product question'], ['wholesale', 'Wholesale'], ['other', 'Something else']]
const GUIDE = [
  ['choosing', 'Choosing a widget'], ['sizing', 'Sizing and fit'], ['materials', 'Materials'],
  ['finishes', 'Finishes'], ['assembly', 'Assembly'], ['lubrication', 'Lubrication'],
  ['storage', 'Storage'], ['maintenance', 'Maintenance'], ['troubleshooting', 'Troubleshooting'],
  ['returns', 'Returns and repairs'], ['safety', 'Safety'], ['glossary', 'Glossary'],
]
const SENTENCES = [
  'Every widget leaves the workshop hand-checked against its drawing.',
  'Tolerances are tighter on the Pro and Max tiers, which matters most under load.',
  'If in doubt, start one size up: a loose fit can be shimmed, a tight one cannot.',
  'Brass parts darken with handling; that patina is expected and harmless.',
  'Keep spare gaskets somewhere cool and dark so the rubber stays supple.',
  'A drop of light oil at each pivot every few months is plenty.',
  'Overtightening is the most common cause of a cracked flange.',
  'Kits include every fastener you need, plus two spares of the smallest.',
  'Our repair bench will look at any Acme part, whatever its age.',
]

const CSS = `
  * { box-sizing: border-box }
  body { margin: 0; font: 16px/1.55 system-ui, sans-serif; color: #1f2933; background: #f7f7f5 }
  .top { background: var(--accent); color: #fff; padding: 14px 24px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 28px }
  .top h1 { margin: 0; font-size: 22px }
  .top a { color: #fff; text-decoration: none }
  .top nav { display: flex; flex-wrap: wrap; gap: 16px }
  .top nav a:hover { text-decoration: underline }
  main, footer { max-width: 880px; margin: 0 auto; padding: 24px }
  footer { color: #7b8794; font-size: 13px }
  a { color: var(--accent) }
  button { font: inherit; background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; cursor: pointer }
  .grid { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px }
  .card { background: #fff; border: 1px solid #e3e3df; border-top: 3px solid var(--accent); border-radius: 8px; padding: 12px }
  .muted { color: #616e7c; font-size: 14px }
  form.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 16px }
  form.stack { display: grid; gap: 12px; max-width: 480px }
  label { display: grid; gap: 4px; font-size: 14px; color: #52606d }
  label.inline { display: flex; align-items: center; gap: 8px }
  input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid #c8c8c2; border-radius: 6px; background: #fff }
  .errors { color: #b42318 }
  .notes li { margin-bottom: 10px }
  th, td { text-align: left; padding: 4px 16px 4px 0 }
`

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const money = n => `$${n.toFixed(2)}`
const options = (pairs, selected) => pairs
  .map(([value, text]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(text)}</option>`).join('')
const productCard = p => `<li class="card"><a href="/products/${p.slug}">${esc(p.name)}</a><div class="muted">${money(p.price)} · ${p.category}</div></li>`

// A pane's data: rows with ids, as tables would hold them.
export function createStore() {
  return { cart_items: [], messages: [], saved_carts: [], nextId: 1 }
}

function layout(ctx, { title, body }) {
  const count = ctx.store.cart_items.reduce((sum, item) => sum + item.qty, 0)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(ctx.v.heading)}</title>
<style>
  :root { --accent: ${ctx.v.accent}; }${CSS}</style>
</head>
<body>
<header class="top">
  <h1><a href="/" data-testid="home-link">${esc(ctx.v.heading)}</a></h1>
  <nav aria-label="Main">
    <a href="/">Home</a> <a href="/products">Products</a> <a href="/guide">Guide</a> <a href="/contact">Contact</a>
    <a href="/cart" id="nav-cart">Cart (${count})</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>Build <code>${esc(ctx.label)}</code> · qa-conductor demo pane</footer>
</body>
</html>`
}

function homePage() {
  const featured = PRODUCTS.filter((_, i) => i % 4 === 0)
  const notes = Array.from({ length: 40 }, (_, i) =>
    `Week ${40 - i}: ${SENTENCES[i % SENTENCES.length]} (${NAMES[i % NAMES.length]} line, batch ${1200 - i * 7})`)
  return {
    title: 'Home',
    body: `<p>Hand-finished widgets, shipped from our workshop since 1987.</p>
<h2>Featured</h2>
<ul class="grid">${featured.map(productCard).join('')}</ul>
<h2>Workshop notes</h2>
<ol class="notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ol>`,
  }
}

function productsPage(ctx, query) {
  const q = (query.get('q') ?? '').trim()
  const category = query.get('category') ?? ''
  const sort = ctx.v.sort ? (query.get('sort') ?? 'featured') : 'featured'
  let list = PRODUCTS.filter(p => p.name.toLowerCase().includes(q.toLowerCase()) && (!category || p.category === category))
  if (sort === 'price-asc') list = [...list].sort((a, b) => a.price - b.price)
  if (sort === 'price-desc') list = [...list].sort((a, b) => b.price - a.price)
  const sortControl = ctx.v.sort ? `<label>Sort <select name="sort" id="sort">${options(SORTS, sort)}</select></label>` : ''
  return {
    title: 'Products',
    body: `<h2>Products</h2>
<form method="get" action="/products" class="row">
  <label>Search <input name="q" id="q" value="${esc(q)}"></label>
  <label>Category <select name="category" id="category">${options([['', 'All'], ...CATEGORIES.map(c => [c, c])], category)}</select></label>
  ${sortControl}
  <button type="submit">Filter</button>
</form>
<div class="muted">${list.length} of ${PRODUCTS.length} products</div>
<ul class="grid">${list.map(productCard).join('')}</ul>`,
  }
}

function productPage(slug) {
  const p = PRODUCTS.find(x => x.slug === slug)
  if (!p) return null
  return {
    title: p.name,
    body: `<a href="/products">All products</a>
<h2>${esc(p.name)}</h2>
<div class="muted">${money(p.price)}</div>
<p>The ${esc(p.name)} is one of our ${p.category}. ${SENTENCES[Math.round(p.price) % SENTENCES.length]}</p>
<table><tr><th>Category</th><td>${p.category}</td></tr><tr><th>SKU</th><td>${p.slug.toUpperCase()}</td></tr></table>
<form method="post" action="/cart" class="row">
  <input type="hidden" name="slug" value="${p.slug}">
  <label>Quantity <input type="number" name="qty" id="qty" value="1" min="1" max="9"></label>
  <button type="submit">Add to cart</button>
</form>`,
  }
}

function cartPage(ctx) {
  const items = ctx.store.cart_items.map(({ slug, qty }) => ({ p: PRODUCTS.find(x => x.slug === slug), qty }))
  const saved = ctx.store.saved_carts.length
    ? `<h3>Saved for later</h3>\n<ul>${ctx.store.saved_carts.map(c => `<li>${esc(c.name)} (${c.items} items)</li>`).join('')}</ul>`
    : ''
  if (!items.length) return { title: 'Cart', body: `<h2>Your cart</h2>\n<p>Your cart is empty. <a href="/products">Browse the products</a>.</p>\n${saved}` }
  const total = items.reduce((sum, { p, qty }) => sum + p.price * qty, 0)
  const rows = items.map(({ p, qty }) => `<tr><td><a href="/products/${p.slug}">${esc(p.name)}</a></td><td>${qty}</td><td>${money(p.price * qty)}</td></tr>`)
  return {
    title: 'Cart',
    body: `<h2>Your cart</h2>
<table><tr><th>Item</th><th>Qty</th><th>Subtotal</th></tr>${rows.join('')}<tr><th>Total</th><td></td><th>${money(total)}</th></tr></table>
<form method="post" action="/cart/clear" class="row"><button type="submit">Empty cart</button></form>
${saved}`,
  }
}

function guidePage() {
  const para = (i, k) => [0, 1, 2].map(n => SENTENCES[(i * 3 + k + n * 4) % SENTENCES.length]).join(' ')
  return {
    title: 'Guide',
    body: `<h2>The widget guide</h2>
<nav aria-label="Contents"><ol>${GUIDE.map(([id, t]) => `<li><a href="#${id}">${t}</a></li>`).join('')}</ol></nav>
${GUIDE.map(([id, t], i) => `<section id="${id}"><h3>${t}</h3>${[0, 1, 2].map(k => `<p>${para(i, k)}</p>`).join('')}</section>`).join('\n')}`,
  }
}

function contactPage(values = {}, errors = []) {
  return {
    title: 'Contact',
    body: `<h2>Contact us</h2>
${errors.length ? `<ul class="errors" role="alert">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
<form method="post" action="/contact" class="stack">
  <label>Name <input name="name" id="name" autocomplete="name" value="${esc(values.name)}"></label>
  <label>Email <input type="email" name="email" id="email" autocomplete="email" value="${esc(values.email)}"></label>
  <label>Topic <select name="topic" id="topic">${options(TOPICS, values.topic ?? 'order')}</select></label>
  <label>Message <textarea name="message" id="message" rows="5">${esc(values.message)}</textarea></label>
  <label class="inline"><input type="checkbox" name="newsletter" id="newsletter" value="yes"${values.newsletter ? ' checked' : ''}> Send me the monthly workshop notes</label>
  <button type="submit">Send message</button>
</form>`,
  }
}

function sentPage(ctx, message) {
  const topic = TOPICS.find(([value]) => value === message.topic)?.[1] ?? 'something else'
  // The EnvTransform neutralises mail in QA panes; say so rather than pretend.
  const mail = ctx.env.MAIL === 'off' ? '<p class="muted">(Mail delivery is off in this pane, so nothing was actually sent.)</p>' : ''
  return {
    title: 'Message sent',
    body: `<h2>Thanks, ${esc(message.name)}</h2>
<p>We got your message about ${esc(topic.toLowerCase())} and will reply to ${esc(message.email)} within two working days.</p>
${mail}
<a href="/">Back to the shop</a>`,
  }
}

async function readForm(req, limit = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('form too large'), { status: 413 })
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' })
  res.end(html)
}
function redirect(res, location) {
  res.writeHead(303, { location, 'content-length': 0 })
  res.end()
}

async function route(ctx, req, res, url) {
  const path = url.pathname
  const query = url.searchParams
  const read = req.method === 'GET' || req.method === 'HEAD'
  const page = (content, status = 200) => sendHtml(res, status, layout(ctx, content))
  const slug = /^\/products\/([a-z0-9-]+)$/.exec(path)?.[1]
  const product = read && slug && productPage(slug)

  if (read && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('ok')
  }
  if (read && path === '/') return page(homePage())
  if (read && path === '/products') return page(productsPage(ctx, query))
  if (product) return page(product)
  if (read && path === '/guide') return page(guidePage())
  if (read && path === '/cart') return page(cartPage(ctx))
  if (req.method === 'POST' && path === '/cart') {
    const form = await readForm(req)
    const slug = form.get('slug')
    const qty = Math.min(9, Math.max(1, Number.parseInt(form.get('qty'), 10) || 1))
    if (PRODUCTS.some(p => p.slug === slug)) {
      const item = ctx.store.cart_items.find(i => i.slug === slug)
      if (item) item.qty = Math.min(99, item.qty + qty)
      else ctx.store.cart_items.push({ id: ctx.store.nextId++, slug, qty })
    }
    return redirect(res, '/cart')
  }
  if (req.method === 'POST' && path === '/cart/clear') {
    ctx.store.cart_items.length = 0
    if (ctx.clearsSavedCarts) ctx.store.saved_carts.length = 0 // the bug
    return redirect(res, '/cart')
  }
  if (read && path === '/contact') return page(contactPage())
  if (req.method === 'POST' && path === '/contact') {
    const form = await readForm(req)
    const values = Object.fromEntries(['name', 'email', 'topic', 'message', 'newsletter'].map(k => [k, (form.get(k) ?? '').trim()]))
    const errors = []
    if (!values.name) errors.push('Please tell us your name.')
    if (!/^[^@\s]+@[^@\s]+$/.test(values.email)) errors.push('Please enter an email address we can reply to.')
    if (!values.message) errors.push('Please write a message.')
    if (errors.length) return page(contactPage(values, errors), 422)
    const id = ctx.store.nextId++
    ctx.store.messages.push({ id, ...values })
    return redirect(res, `/contact/sent?id=${id}`)
  }
  const sent = read && path === '/contact/sent' && ctx.store.messages.find(m => m.id === Number(query.get('id')))
  if (sent) return page(sentPage(ctx, sent))
  return page({ title: 'Not found', body: '<h2>Page not found</h2>\n<p>Try the <a href="/">home page</a>.</p>' }, 404)
}

// log(line) receives one access-log line per response. `store` is the
// pane's data (createStore()), a fresh one by default.
export function createPaneApp({ variant = 'base', label = variant, env = {}, log = () => {}, store = createStore(), clearsSavedCarts = false } = {}) {
  const v = VARIANTS[variant]
  if (!v) throw new Error(`unknown pane app variant: ${variant}`)
  const ctx = { v, label, env, store, clearsSavedCarts }
  return async function paneApp(req, res) {
    const url = new URL(req.url ?? '/', 'http://pane.invalid')
    res.on('finish', () => log(`${req.method} ${url.pathname} ${res.statusCode}`))
    try {
      await route(ctx, req, res, url)
    } catch (err) {
      if (!res.headersSent) sendHtml(res, err.status ?? 500, `<!doctype html><title>Error</title><p>${esc(err.message)}</p>`)
      else res.destroy()
    }
  }
}
