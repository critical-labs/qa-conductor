// PR-QA harness: PR picker -> boot progress -> side-by-side panes with
// interaction relay -> verdict. Plain browser JS, no dependencies.
/* eslint-env browser */
;(() => {
  const $ = id => document.getElementById(id)
  const state = { paneOrigins: null, mirror: true, panes: null, pr: null }

  const api = (path, opts) => fetch(`/qa/api${path}`, opts).then(async r => {
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
    return body
  })

  function show(section) {
    $('picker').style.display = section === 'picker' ? '' : 'none'
    $('progress').style.display = section === 'progress' ? '' : 'none'
    $('panes').classList.toggle('active', section === 'panes')
  }

  async function loadPrs() {
    try {
      const { prs, session } = await api('/prs')
      if (session.status === 'ready') return resume()
      if (session.status !== 'idle' && session.status !== 'error') { show('progress'); return listenProgress() }
      $('prList').innerHTML = ''
      if (!prs.length) { $('prList').textContent = 'No open PRs.'; return }
      for (const pr of prs) {
        const row = document.createElement('div')
        row.className = 'pr'
        const btn = document.createElement('button')
        btn.className = 'primary'
        btn.textContent = 'Open QA'
        btn.onclick = () => open(pr.number, pr.title)
        row.innerHTML = `<span class="n">#${pr.number}</span><span class="t">${pr.title.replace(/</g, '&lt;')}</span>`
        row.appendChild(btn)
        $('prList').appendChild(row)
      }
    } catch (err) {
      $('prList').textContent = `Failed to load PRs: ${err.message}`
    }
  }

  async function resume() {
    const s = await api('/state')
    if (s.status === 'ready' && s.panes) ready(s.panes, s)
    else show('picker')
  }

  async function open(number, title) {
    state.pr = number
    $('headMeta').textContent = `#${number} ${title ?? ''}`
    show('progress')
    $('bootError').style.display = 'none'
    try {
      await api('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr: number }) })
      listenProgress()
    } catch (err) {
      $('bootError').style.display = ''
      $('bootError').textContent = err.message
    }
  }

  function listenProgress() {
    const es = new EventSource('/qa/api/progress')
    es.onmessage = ev => {
      const e = JSON.parse(ev.data)
      if (e.kind === 'step') {
        for (const li of document.querySelectorAll('#progress li')) {
          const past = li.dataset.step === e.step
          li.classList.toggle('now', past)
          if (li.compareDocumentPosition(document.querySelector(`li[data-step="${e.step}"]`)) & Node.DOCUMENT_POSITION_FOLLOWING) {
            li.classList.add('done')
            li.classList.remove('now')
          }
        }
      } else if (e.kind === 'ready') {
        es.close()
        ready(e.panes, e)
      } else if (e.kind === 'error') {
        es.close()
        $('bootError').style.display = ''
        $('bootError').textContent = `Failed at ${e.step}: ${e.message}`
      } else if (e.kind === 'torn-down') {
        es.close()
        location.reload()
      }
    }
  }

  function ready(panes, meta) {
    state.panes = panes
    state.paneOrigins = [panes.baseOrigin, panes.prOrigin]
    if (meta?.baseTag) $('headMeta').textContent += ` · ${tagOf(meta.baseTag)} vs ${tagOf(meta.prTag)}`
    $('baseFrame').src = panes.base
    $('prFrame').src = panes.pr
    show('panes')
  }
  const tagOf = img => (img || '').split(':').pop()

  // --- interaction relay -------------------------------------------------
  window.addEventListener('message', ev => {
    if (!state.paneOrigins || !state.paneOrigins.includes(ev.origin)) return
    const d = ev.data
    if (!d || d.qa !== 1) return
    const fromBase = ev.origin === state.paneOrigins[0]
    const otherFrame = fromBase ? $('prFrame') : $('baseFrame')
    const otherOrigin = fromBase ? state.paneOrigins[1] : state.paneOrigins[0]
    if (d.kind === 'event') {
      if (!state.mirror) return
      otherFrame.contentWindow.postMessage({ ...d, kind: 'replay' }, otherOrigin)
    } else if (d.kind === 'unmatched') {
      const wrap = otherFrame.closest('.paneWrap')
      wrap.classList.remove('flash')
      void wrap.offsetWidth
      wrap.classList.add('flash')
    } else if (d.kind === 'nav') {
      const el = fromBase ? $('baseUrl') : $('prUrl')
      el.textContent = d.href
    }
  })

  // --- toolbar ------------------------------------------------------------
  $('mirrorBtn').onclick = () => {
    state.mirror = !state.mirror
    $('mirrorBtn').textContent = `Mirror: ${state.mirror ? 'on' : 'off'}`
    $('mirrorBtn').classList.toggle('on', state.mirror)
  }
  $('resyncBtn').onclick = () => {
    const href = $('baseUrl').textContent || '/'
    $('prFrame').src = state.paneOrigins[1] + href
  }
  for (const btn of document.querySelectorAll('button[data-width]')) {
    btn.onclick = () => {
      const w = Number(btn.dataset.width)
      for (const f of [$('baseFrame'), $('prFrame')]) f.style.width = w ? `${w}px` : '100%'
      for (const b of document.querySelectorAll('button[data-width]')) b.classList.toggle('on', b === btn)
    }
  }
  $('teardownBtn').onclick = async () => {
    await api('/teardown', { method: 'POST' }).catch(() => {})
    location.reload()
  }

  // --- verdict ------------------------------------------------------------
  async function verdict(v) {
    $('result').textContent = 'Posting…'
    try {
      const { url } = await api('/verdict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: v, notes: $('notes').value }),
      })
      $('result').innerHTML = `Posted: <a href="${url}" target="_blank" rel="noreferrer">comment</a> · <button id="afterTeardown">End session</button>`
      $('afterTeardown').onclick = $('teardownBtn').onclick
    } catch (err) {
      $('result').textContent = `Failed: ${err.message}`
    }
  }
  $('acceptBtn').onclick = () => verdict('accept')
  $('rejectBtn').onclick = () => verdict('reject')

  loadPrs()
})()
