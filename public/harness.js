// PR-QA harness: hash-routed picker → boot → side-by-side session → verdict.
// Plain browser JS, zero dependencies. Server state is authoritative on load.
/* eslint-env browser */
;(() => {
  const $ = id => document.getElementById(id)
  const api = (path, opts) => fetch(`/qa/api${path}`, opts).then(async r => {
    const body = await r.json().catch(() => ({}))
    if (!r.ok) { const e = new Error(body.error || `HTTP ${r.status}`); e.status = r.status; e.body = body; throw e }
    return body
  })
  const announce = (msg, assertive) => { const el = $(assertive ? 'announcerAssertive' : 'announcer'); el.textContent = ''; el.textContent = msg }
  const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
  const tagOf = img => (img || '').split(':').pop()
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  const BOOTING = ['ensuring-image', 'cloning', 'migrating', 'starting']

  const S = {
    pr: null, panes: null, paneOrigins: null, mounted: null,
    mirror: true, scrollMirror: true,
    path: { base: '', pr: '' }, lastMsg: { base: 0, pr: 0 }, hasNav: { base: false, pr: false },
    unmatched: { base: 0, pr: 0 },
    es: null, idlePoll: null, dotPoll: null, notesTimer: null, confirmTimer: null, pendingVerdict: null,
  }

  // --- router --------------------------------------------------------------
  function parseHash() {
    const h = location.hash.replace(/^#/, '') || '/'
    let m = h.match(/^\/pr\/(\d+)\/boot$/); if (m) return { view: 'boot', pr: +m[1] }
    m = h.match(/^\/pr\/(\d+)\/verdict$/); if (m) return { view: 'verdict', pr: +m[1] }
    m = h.match(/^\/pr\/(\d+)$/); if (m) return { view: 'session', pr: +m[1] }
    return { view: 'picker', pr: null }
  }
  const go = hash => { if (location.hash !== hash) location.hash = hash; else render() }
  const setHashSilent = hash => history.replaceState(null, '', hash)

  function showView(id) {
    for (const v of ['picker', 'boot', 'session', 'verdictDone']) $(v).hidden = v !== id
    $('sessionControls').hidden = id !== 'session'
    $('verdictBar').hidden = id !== 'session'
    const heading = { picker: '#picker h1', boot: 'bootHeading', session: 'sessionHeading', verdictDone: '#verdictDone h1' }[id]
    const h = id === 'picker' ? document.querySelector('#picker h1') : id === 'verdictDone' ? document.querySelector('#verdictDone h1') : $(heading)
    if (h) setTimeout(() => h.focus(), 0)
  }
  function setPill(text) { $('statusPill').textContent = text }

  async function render() {
    const route = parseHash()
    let s
    try { s = await api('/state') } catch { s = { status: 'idle' } }
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

  // --- picker (#164 #167 #169) --------------------------------------------
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
    } catch (err) { $('prList').textContent = `Failed to load PRs: ${err.message}` }
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
    twoStepConfirm(c.querySelector('[data-takeover]'), 'End & open?', () => openSession(wantPr, { takeover: true }))
    return c
  }

  function patchRows(prs, session) {
    const list = $('prList')
    if (list.textContent === 'Loading…') list.textContent = ''
    if (!prs.length && !rows.size) { list.textContent = 'No open PRs.'; return }
    const seen = new Set()
    for (const pr of prs) {
      seen.add(pr.number)
      let row = rows.get(pr.number)
      if (!row) { row = document.createElement('div'); row.className = 'pr'; row.dataset.pr = pr.number; rows.set(pr.number, row); list.appendChild(row) }
      const holds = session && session.pr === pr.number && session.status !== 'idle'
      const badge = imageBadge(pr)
      const action = holds
        ? `<button class="primary" data-open="${pr.number}" data-resume="1">QA session active — Resume</button>`
        : `<button class="primary" data-open="${pr.number}">Open QA</button>`
      row.innerHTML = `<span class="num">#${pr.number}</span>`
        + `<span class="main"><span class="title">${esc(pr.title)}</span>`
        + `<span class="submeta">${esc(pr.headRef || '')}${pr.author ? ' · ' + esc(pr.author) : ''} ${badge}</span>`
        + `<span class="rowErr" hidden></span></span>${action}`
    }
    for (const [num, row] of rows) if (!seen.has(num)) { row.remove(); rows.delete(num) }
  }

  function imageBadge(pr) {
    if (pr.imageStatus === 'built') return `<span class="badge"><span class="dot green"></span>ready — opens in seconds</span>`
    if (pr.imageStatus === 'building') return `<span class="badge"><span class="dot amber pulse"></span>building…${pr.runUrl ? ` <a href="${esc(pr.runUrl)}" target="_blank" rel="noreferrer">run ↗</a>` : ''}</span>`
    return `<span class="badge"><span class="dot amber"></span>needs build (~10 min)</span>`
  }

  // delegated picker clicks — survive re-renders (#164)
  $('prList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-open]'); if (!btn) return
    const num = +btn.dataset.open
    if (btn.dataset.resume) return go(`#/pr/${num}`)
    const rowButtons = $('prList').querySelectorAll('button[data-open]')
    for (const b of rowButtons) b.disabled = true
    btn.textContent = 'Opening…'; btn.closest('.pr').setAttribute('aria-busy', 'true')
    openSession(num).catch(err => {
      btn.closest('.pr').removeAttribute('aria-busy')
      for (const b of rowButtons) b.disabled = false
      if (err.status === 409 && err.body && err.body.session) {
        $('conflictSlot').innerHTML = ''; $('conflictSlot').appendChild(conflictCard(err.body.session, num))
      } else {
        const slot = btn.closest('.pr').querySelector('.rowErr'); slot.hidden = false; slot.textContent = err.message
      }
    })
  })
  $('refreshBtn').onclick = () => renderPicker(null)

  async function openSession(num, opts = {}) {
    if (picking) return; picking = true
    try {
      await api('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr: num, ...opts }) })
      go(`#/pr/${num}/boot`)
    } finally { picking = false }
  }

  // --- boot (#163 #165 #166) ----------------------------------------------
  const stepAt = {}
  let bootPr = null

  function renderBoot(pr, state) {
    showView('boot'); setPill(`booting #${pr}`)
    if (bootPr !== pr) { bootPr = pr; for (const k of Object.keys(stepAt)) delete stepAt[k]; resetBootUi() }
    $('bootPr').textContent = pr
    if (state && state.buildRun) setBuildSub(state.buildRun.url, state.buildRun.status)
    attachSse()
  }
  function resetBootUi() {
    for (const li of $('bootSteps').querySelectorAll('li')) { li.classList.remove('now', 'done'); li.removeAttribute('aria-current'); li.querySelector('.stepTime').textContent = '' }
    $('bootSteps').querySelector('[data-step="ensuring-image"] .stepSub').innerHTML = ''
    $('bootError').hidden = true; $('bootActions').hidden = true; $('bootActions').innerHTML = ''; $('bootBar').hidden = false
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
    const labels = { 'ensuring-image': 'Ensuring PR image', cloning: 'Cloning prod databases', migrating: 'Running migrations', starting: 'Starting apps' }
    announce(`${labels[step] || step}, step ${cur + 1} of 4`)
  }
  function setBuildSub(url, status) {
    const sub = $('bootSteps').querySelector('[data-step="ensuring-image"] .stepSub')
    if (!url) { sub.textContent = 'build dispatched'; return }
    const label = status === 'completed' ? 'Image pushed, waiting for migrate image' : `Build ${status || 'in progress'}`
    sub.innerHTML = ` — ${label} <a href="${esc(url)}" target="_blank" rel="noreferrer">view run ↗</a>`
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
    const es = new EventSource('/qa/api/progress'); S.es = es
    if (!bootTimer) bootTimer = setInterval(tickBoot, 1000)
    es.onmessage = ev => {
      const e = JSON.parse(ev.data)
      if (e.kind === 'step') markStep(e.step, e.at)
      else if (e.kind === 'build') setBuildSub(e.runUrl, e.runStatus)
      else if (e.kind === 'ready') { closeSse(); onReady(e) }
      else if (e.kind === 'error') showBootError(e)
      else if (e.kind === 'torn-down') { closeSse(); go('#/') }
    }
  }
  function closeSse() { if (S.es) { S.es.close(); S.es = null } if (bootTimer) { clearInterval(bootTimer); bootTimer = null } }

  function showBootError(e) {
    const cached = stepAt['ensuring-image'] === undefined
    if (cached) $('bootSteps').querySelector('[data-step="ensuring-image"] .stepSub').textContent = 'Image cached'
    $('bootBar').hidden = true
    const pre = $('bootError'); pre.hidden = false
    pre.innerHTML = `<span class="errline">Failed at ${esc(e.step)}: ${esc(e.message)}</span>` + (e.logTail ? esc(e.logTail) : '')
    announce(`Boot failed at ${e.step}: ${e.message}`, true)
    const acts = $('bootActions'); acts.hidden = false; acts.innerHTML = ''
    const retry = mkBtn('Retry boot', 'primary', () => { resetBootUi(); openSession(bootPr).catch(showOpenErr) })
    const back = mkBtn('Back to pull requests', 'ghost', () => go('#/'))
    acts.append(retry, back)
    if (e.step === 'ensuring-image' && e.runUrl) { const a = document.createElement('a'); a.className = 'btn secondary'; a.href = e.runUrl; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = 'View build log ↗'; acts.append(a) }
  }
  function showOpenErr(err) { const pre = $('bootError'); pre.hidden = false; pre.innerHTML = `<span class="errline">${esc(err.message)}</span>` }
  function mkBtn(text, cls, onclick) { const b = document.createElement('button'); b.className = cls; b.textContent = text; b.onclick = onclick; return b }
  $('cancelBoot').onclick = async () => { await api('/teardown', { method: 'POST' }).catch(() => {}); go('#/') }

  // --- session (#163 #170 #171 #172) --------------------------------------
  function onReady(meta) { setHashSilent(`#/pr/${meta.pr || bootPr}`); renderSession(meta) }

  function renderSession(meta) {
    const pr = meta.pr || bootPr || parseHash().pr
    showView('session'); setPill(`session: #${pr}`)
    const panes = meta.panes
    if (S.mounted !== pr) {
      S.mounted = pr; S.pr = pr; S.panes = panes; S.paneOrigins = [panes.baseOrigin, panes.prOrigin]
      S.path = { base: '', pr: '' }; S.hasNav = { base: false, pr: false }; S.lastMsg = { base: Date.now(), pr: Date.now() }
      S.unmatched = { base: 0, pr: 0 }; renderUnmatched('base'); renderUnmatched('pr')
      $('baseFrame').src = panes.base; $('prFrame').src = panes.pr
      $('baseOpen').href = panes.baseOrigin; $('prOpen').href = panes.prOrigin
      setDot('base', 'amber', 'signing in…'); setDot('pr', 'amber', 'signing in…')
      $('baseUrl').textContent = 'signing in…'; $('prUrl').textContent = 'signing in…'
      restoreDraft(pr)
      startIdlePoll(); startDotPoll()
      announce('QA session ready')
    }
    $('sessionMeta').innerHTML = meta.baseTag ? `#${pr} · <span class="tag">${esc(tagOf(meta.baseTag))}</span> vs <span class="tag">${esc(tagOf(meta.prTag))}</span>` : `#${pr}`
    $('sessionHeading').textContent = `QA session for PR ${pr}`
  }

  function teardownSessionUi() {
    S.mounted = null; closeSse()
    if (S.idlePoll) { clearInterval(S.idlePoll); S.idlePoll = null }
    if (S.dotPoll) { clearInterval(S.dotPoll); S.dotPoll = null }
    $('baseFrame').removeAttribute('src'); $('prFrame').removeAttribute('src')
    hideVerdictBody()
  }

  const paneOf = origin => origin === S.paneOrigins[0] ? 'base' : origin === S.paneOrigins[1] ? 'pr' : null
  const frameOf = pane => pane === 'base' ? $('baseFrame') : $('prFrame')
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

  function startDotPoll() {
    S.dotPoll = setInterval(() => {
      const now = Date.now()
      for (const pane of ['base', 'pr']) {
        if (!S.hasNav[pane]) continue
        if (now - S.lastMsg[pane] > 10000) setDot(pane, 'grey', 'stale — no bridge signal >10s')
      }
    }, 3000)
  }

  // pane bar controls (#171)
  document.querySelector('#paneRow').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return
    const pane = btn.dataset.pane
    if (btn.dataset.act === 'reload') { const f = frameOf(pane); f.src = f.src }
    else if (btn.dataset.act === 'copy') navigator.clipboard && navigator.clipboard.writeText(S.path[pane] || '/')
  })
  for (const p of ['base', 'pr']) $(p + 'Unmatched').onclick = () => { S.unmatched[p] = 0; renderUnmatched(p) }

  // header controls
  $('mirrorBtn').onclick = () => setMirror(!S.mirror)
  function setMirror(on) { S.mirror = on; $('mirrorBtn').textContent = `Mirror: ${on ? 'on' : 'off'}`; $('mirrorBtn').classList.toggle('on', on) }
  menuToggle('mirrorMenuBtn', 'mirrorMenu')
  menuToggle('resyncMenuBtn', 'resyncMenu')
  $('scrollMirror').onchange = e => { S.scrollMirror = e.target.checked }
  $('resyncBtn').onclick = () => { $('prFrame').src = S.paneOrigins[1] + (S.path.base || '/'); S.path.pr = S.path.base; updateDivergence() }
  $('resyncLeft').onclick = () => { $('baseFrame').src = S.paneOrigins[0] + (S.path.pr || '/'); S.path.base = S.path.pr; updateDivergence(); $('resyncMenu').hidden = true }
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

  // idle countdown chip (#170)
  function startIdlePoll() { pollIdle(); S.idlePoll = setInterval(pollIdle, 60000) }
  async function pollIdle() {
    let s; try { s = await api('/state') } catch { return }
    if (s.status !== 'ready') return
    if (!s.lastActivity || !s.idleMinutes) return
    const left = s.lastActivity + s.idleMinutes * 60000 - Date.now()
    const chip = $('idleChip'); chip.textContent = `auto-end ${mmss(left)}`
    const low = left < 5 * 60000; chip.classList.toggle('warn', low)
    if (low) announce(`QA session ends in ${Math.ceil(left / 60000)} minutes unless you interact`)
  }

  // teardown two-step (#170)
  twoStepConfirm($('teardownBtn'), 'Confirm end? (3s)', async () => { await api('/teardown', { method: 'POST' }).catch(() => {}); go('#/') })
  function twoStepConfirm(btn, confirmLabel, action) {
    const orig = btn.textContent
    btn.onclick = () => {
      if (btn.dataset.armed) { clearTimeout(S.confirmTimer); btn.dataset.armed = ''; btn.textContent = orig; btn.classList.remove('confirm'); return action() }
      btn.dataset.armed = '1'; btn.textContent = confirmLabel; btn.classList.add('confirm')
      S.confirmTimer = setTimeout(() => { btn.dataset.armed = ''; btn.textContent = orig; btn.classList.remove('confirm') }, 3000)
    }
    btn._disarm = () => { if (btn.dataset.armed) { clearTimeout(S.confirmTimer); btn.dataset.armed = ''; btn.textContent = orig; btn.classList.remove('confirm') } }
  }

  // --- verdict drawer (#168 #173) -----------------------------------------
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
      const { url } = await api('/verdict', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: S.pendingVerdict, notes: $('notes').value }) })
      localStorage.removeItem(draftKey(S.pr))
      announce('Verdict posted')
      $('doneP').textContent = S.pr; $('doneLink').href = url
      go(`#/pr/${S.pr}/verdict`)
    } catch (err) { postBtn.disabled = false; $('previewBack').disabled = false; $('previewLabelChange').textContent = `Failed: ${err.message}` }
  }

  // verdict-done view is rendered on demand; wire once
  $('doneEnd').onclick = async () => { await api('/teardown', { method: 'POST' }).catch(() => {}); go('#/') }
  $('doneKeep').onclick = () => go(`#/pr/${S.pr}`)
  $('doneBack').onclick = () => go('#/')

  // when routed to #/pr/n/verdict but state lost (reload), fall back to session
  function maybeVerdictDone() {
    const r = parseHash()
    if (r.view === 'verdict' && $('doneLink').href && +$('doneP').textContent === r.pr) { showView('verdictDone'); setPill(`session: #${r.pr}`); return true }
    return false
  }

  // --- keyboard (#177) -----------------------------------------------------
  document.addEventListener('keydown', e => {
    if ($('shortcuts').open && e.key === 'Escape') return $('shortcuts').close()
    if (e.key === '?') { e.preventDefault(); return $('shortcuts').showModal() }
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if ($('session').hidden) return
    switch (e.key) {
      case 'm': setMirror(!S.mirror); break
      case 's': $('scrollMirror').checked = !$('scrollMirror').checked; S.scrollMirror = $('scrollMirror').checked; break
      case 'r': $('resyncBtn').click(); break
      case '1': setWidth(375); break
      case '2': setWidth(768); break
      case '3': setWidth(0); break
      case 'v': toggleVerdict(); break
      case 'e': $('teardownBtn').click(); break
      case 'Escape': $('teardownBtn')._disarm && $('teardownBtn')._disarm(); if (!$('verdictBody').hidden) hideVerdictBody(); break
    }
  })
  $('shortcutsClose').onclick = () => $('shortcuts').close()

  // --- compact <900px (#176) ----------------------------------------------
  const mq = window.matchMedia('(max-width: 900px)')
  function applyCompact() { document.body.classList.toggle('compact', mq.matches); $('tabs').hidden = !mq.matches; if (mq.matches) selectTab(currentTab) }
  let currentTab = 'base'
  $('tabs').addEventListener('click', e => { const t = e.target.closest('.tab'); if (t) selectTab(t.dataset.tab) })
  function selectTab(which) {
    currentTab = which
    for (const tab of $('tabs').querySelectorAll('.tab')) tab.classList.toggle('on', tab.dataset.tab === which)
    for (const pane of document.querySelectorAll('#paneRow .pane')) pane.classList.toggle('activeTab', pane.dataset.pane === which)
  }
  mq.addEventListener('change', applyCompact); applyCompact()

  // --- boot ----------------------------------------------------------------
  window.addEventListener('hashchange', () => { if (!maybeVerdictDone()) render() })
  render()
})()
