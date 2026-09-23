// QA mirror bridge — injected into each pane page by the qa-conductor pane
// proxy via <script src="/__qa/bridge.js">. Plain browser script: no ESM, no
// dependencies, zero app changes.
//
// The pure selector helpers (buildSelector / resolveSelector) live at top
// level and are exported through the CommonJS guard at the bottom so
// `node --test` can exercise them; the runtime IIFE is inert outside a
// browser.

// --- pure selector helpers -------------------------------------------------

function attrEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function nthOfType(el) {
  const siblings = el.parentNode && el.parentNode.children ? el.parentNode.children : []
  let n = 0
  for (let i = 0; i < siblings.length; i++) {
    if (siblings[i].tagName === el.tagName) {
      n += 1
      if (siblings[i] === el) return n
    }
  }
  return 1
}

function structuralPath(el) {
  const segments = []
  let node = el
  while (node && node.tagName && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
    segments.unshift(node.tagName + ':nth-of-type(' + nthOfType(node) + ')')
    node = node.parentNode
  }
  return segments.join('>')
}

// Selector ladder, most stable first: data-testid → id → aria-label →
// button/link text → structural nth-of-type path from <body>. Returns a small
// descriptor object the peer pane resolves with resolveSelector.
function buildSelector(el) {
  const testid = el.getAttribute('data-testid')
  if (testid) return { t: 'testid', v: testid }
  if (el.id) return { t: 'id', v: el.id }
  const aria = el.getAttribute('aria-label')
  if (aria) return { t: 'aria', v: aria }
  if (el.tagName === 'BUTTON' || el.tagName === 'A') {
    const text = (el.textContent || '').trim()
    if (text.length >= 1 && text.length <= 60) return { t: 'text', tag: el.tagName, v: text }
  }
  return { t: 'path', v: structuralPath(el) }
}

function collectByTag(root, tag, out) {
  const kids = root && root.children ? root.children : []
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].tagName === tag) out.push(kids[i])
    collectByTag(kids[i], tag, out)
  }
  return out
}

function nthChildOfType(parent, tag, n) {
  const kids = parent && parent.children ? parent.children : []
  let seen = 0
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].tagName === tag) {
      seen += 1
      if (seen === n) return kids[i]
    }
  }
  return null
}

// Resolve a descriptor against a document. Returns the element, or null when
// it does not match exactly one element — "where UI matches" is literal, so an
// ambiguous text match is a non-match.
function resolveSelector(desc, doc) {
  if (!desc || !doc) return null
  if (desc.t === 'testid') return doc.querySelector('[data-testid="' + attrEscape(desc.v) + '"]') || null
  if (desc.t === 'id') return doc.querySelector('[id="' + attrEscape(desc.v) + '"]') || null
  if (desc.t === 'aria') return doc.querySelector('[aria-label="' + attrEscape(desc.v) + '"]') || null
  if (desc.t === 'text') {
    const candidates = collectByTag(doc.body, desc.tag, [])
    const matches = []
    for (let i = 0; i < candidates.length; i++) {
      if ((candidates[i].textContent || '').trim() === desc.v) matches.push(candidates[i])
    }
    return matches.length === 1 ? matches[0] : null
  }
  if (desc.t === 'path') {
    if (typeof desc.v !== 'string') return null
    if (desc.v === '') return doc.body || null
    let node = doc.body
    const segments = desc.v.split('>')
    for (let i = 0; i < segments.length; i++) {
      const m = /^([A-Za-z0-9-]+):nth-of-type\((\d+)\)$/.exec(segments[i])
      if (!m || !node) return null
      node = nthChildOfType(node, m[1], Number(m[2]))
    }
    return node || null
  }
  return null
}

// --- browser runtime -------------------------------------------------------

;(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__qaBridgeInstalled) return
  window.__qaBridgeInstalled = true

  // Harness origin arrives via the URL fragment (#qa=<origin>) on the pane's
  // first load; keep it in sessionStorage so SPA navigation (which may rewrite
  // the hash) cannot lose it.
  let harnessOrigin = null
  try {
    const m = /qa=([^&]+)/.exec(window.location.hash || '')
    if (m) harnessOrigin = decodeURIComponent(m[1])
    if (harnessOrigin) window.sessionStorage.setItem('qaHarnessOrigin', harnessOrigin)
    else harnessOrigin = window.sessionStorage.getItem('qaHarnessOrigin')
  } catch (err) {
    // sessionStorage unavailable — fragment-only config still covers this load
  }

  function send(msg) {
    try {
      window.parent.postMessage(msg, '*')
    } catch (err) {
      // parent gone (pane opened outside the harness) — nothing to mirror to
    }
  }

  // Heartbeat: a lightweight liveness ping so the harness can tell a live pane
  // from a crashed or navigated-away one. Reuses send() for its postMessage +
  // try/catch; independent of the capture/replay paths.
  setInterval(function () {
    send({ qa: 1, kind: 'ping' })
  }, 5000)

  function valueOf(el) {
    const tag = el.tagName
    if (tag === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked
      return el.value
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') return el.value
    return undefined
  }

  // --- capture side ---------------------------------------------------------

  const MIRRORED_KEYS = ['Enter', 'Escape', 'Tab']

  function onCaptured(event) {
    if (window.__qaReplaying) return
    const target = event.target
    if (!target || !target.tagName) return
    // File pickers cannot be mirrored (browser security) — do those per-pane.
    if (target.tagName === 'INPUT' && target.type === 'file') return
    if (event.type === 'keydown' && MIRRORED_KEYS.indexOf(event.key) === -1) return
    const msg = { qa: 1, kind: 'event', type: event.type, selector: buildSelector(target) }
    if (event.type === 'keydown') msg.key = event.key
    const value = valueOf(target)
    if (value !== undefined) msg.value = value
    send(msg)
  }

  const MIRRORED_EVENTS = ['click', 'dblclick', 'input', 'change', 'submit', 'keydown']
  for (let i = 0; i < MIRRORED_EVENTS.length; i++) {
    document.addEventListener(MIRRORED_EVENTS[i], onCaptured, true)
  }

  // Page scroll, coalesced to one message per animation frame (smooth, near
  // real-time tracking rather than a 150 ms lurch). Each message carries both
  // the absolute offset and the fraction of the scrollable extent plus that
  // extent, so the receiver can hold the panes proportionally aligned when the
  // two documents have different heights (base vs PR diff). A replayed scrollTo
  // fires its own scroll event asynchronously, so capture is suppressed briefly
  // after a replay to avoid echo loops.
  function scrollMetrics() {
    const de = document.documentElement
    const maxX = Math.max(1, de.scrollWidth - de.clientWidth)
    const maxY = Math.max(1, de.scrollHeight - de.clientHeight)
    return { x: window.scrollX, y: window.scrollY, fx: window.scrollX / maxX, fy: window.scrollY / maxY, maxX: maxX, maxY: maxY }
  }
  let scrollScheduled = false
  let suppressScrollUntil = 0
  document.addEventListener('scroll', function (event) {
    if (window.__qaReplaying || Date.now() < suppressScrollUntil) return
    if (event.target !== document && event.target !== document.documentElement) return
    if (scrollScheduled) return
    scrollScheduled = true
    requestAnimationFrame(function () {
      scrollScheduled = false
      if (window.__qaReplaying || Date.now() < suppressScrollUntil) return
      const m = scrollMetrics()
      send({ qa: 1, kind: 'event', type: 'scroll', scroll: [m.x, m.y], frac: [m.fx, m.fy], ext: [m.maxX, m.maxY] })
    })
  }, true)

  // --- replay side ----------------------------------------------------------

  function applyValue(el, value) {
    const tag = el.tagName
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      el.checked = !!value
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }
    if (tag === 'SELECT') {
      el.value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // React tracks the value property descriptor, so go through the native
      // prototype setter to make controlled components observe the change.
      const proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  function replay(data) {
    if (data.type === 'scroll') {
      if (Array.isArray(data.scroll)) {
        suppressScrollUntil = Date.now() + 200
        const de = document.documentElement
        const myMaxX = Math.max(1, de.scrollWidth - de.clientWidth)
        const myMaxY = Math.max(1, de.scrollHeight - de.clientHeight)
        let x = data.scroll[0]
        let y = data.scroll[1]
        // When this pane's scrollable extent differs materially from the
        // sender's, follow the proportional position instead of the raw pixel
        // offset so the same region stays visible in both panes.
        if (data.ext && data.frac) {
          if (Math.abs(data.ext[1] - myMaxY) > 4) y = Math.round(data.frac[1] * myMaxY)
          if (Math.abs(data.ext[0] - myMaxX) > 4) x = Math.round(data.frac[0] * myMaxX)
        }
        window.scrollTo(x, y)
      }
      return
    }
    const el = resolveSelector(data.selector, document)
    if (!el) {
      send({ qa: 1, kind: 'unmatched', type: data.type })
      return
    }
    if (data.type === 'click' || data.type === 'dblclick') {
      el.click()
      return
    }
    if (data.type === 'keydown') {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: data.key, bubbles: true, cancelable: true }))
      return
    }
    if (data.type === 'input' || data.type === 'change') {
      applyValue(el, data.value)
    }
    // 'submit' is captured for the harness but deliberately not replayed: the
    // mirrored click that raised it already drives the peer's own submit path,
    // and replaying it as well would double-submit.
  }

  window.addEventListener('message', function (event) {
    if (!harnessOrigin || event.origin !== harnessOrigin) return
    const data = event.data
    if (!data || data.qa !== 1 || data.kind !== 'replay') return
    window.__qaReplaying = true
    try {
      replay(data)
    } finally {
      window.__qaReplaying = false
    }
  })

  // --- navigation notifications --------------------------------------------
  // The harness only uses these for its per-pane URL indicators.

  function sendNav() {
    send({ qa: 1, kind: 'nav', href: window.location.pathname + window.location.search })
  }

  const originalPushState = window.history.pushState
  window.history.pushState = function () {
    const result = originalPushState.apply(this, arguments)
    sendNav()
    return result
  }
  const originalReplaceState = window.history.replaceState
  window.history.replaceState = function () {
    const result = originalReplaceState.apply(this, arguments)
    sendNav()
    return result
  }
  window.addEventListener('popstate', sendNav)
  sendNav()
})()

// --- test exports (node --test evaluates this file through a CJS wrapper) ---

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildSelector, resolveSelector }
}
