import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// bridge.js is a plain browser script with a CommonJS export guard
// (`if (typeof module !== 'undefined' && module.exports)`). The platform
// package.json declares "type": "module", so require()ing the .js file
// directly would parse it as ESM and the guard would never fire — evaluate
// it through the CJS wrapper shape instead. `window` stays undefined here,
// which keeps the runtime IIFE inert.
const bridgePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bridge.js')
const source = readFileSync(bridgePath, 'utf8')
const cjsModule = { exports: {} }
new Function('module', 'exports', source)(cjsModule, cjsModule.exports)
const { buildSelector, resolveSelector } = cjsModule.exports

// --- minimal DOM stub (no jsdom) ------------------------------------------
// Supports only what the bridge helpers use: querySelector (attribute-equals
// form), getAttribute, tagName, textContent, parentNode, children.

class StubElement {
  constructor(tagName, attrs = {}, children = []) {
    this.tagName = tagName.toUpperCase()
    this.attrs = attrs
    this.id = attrs.id || ''
    this.parentNode = null
    this.children = children
    this.ownText = attrs.text || ''
    for (const child of children) child.parentNode = this
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  get textContent() {
    let out = this.ownText
    for (const child of this.children) out += child.textContent
    return out
  }
}

class StubDocument {
  constructor(body) {
    this.body = body
  }

  querySelector(selector) {
    const m = /^\[([a-z-]+)="((?:[^"\\]|\\.)*)"\]$/i.exec(selector)
    if (!m) return null
    const value = m[2].replace(/\\(.)/g, '$1')
    const stack = [this.body]
    while (stack.length) {
      const el = stack.shift()
      if (el.getAttribute(m[1]) === value) return el
      stack.push(...el.children)
    }
    return null
  }
}

const h = (tag, attrs = {}, children = []) => new StubElement(tag, attrs, children)

// Two structurally identical pages (base pane / PR pane): selectors built in
// one must resolve to the twin element in the other.
function makePage() {
  const refs = {}
  refs.testidBtn = h('button', { 'data-testid': 'submit-order', id: 'submit', 'aria-label': 'Submit order', text: 'Submit' })
  refs.idInput = h('input', { id: 'email', 'aria-label': 'Email address' })
  refs.ariaNav = h('nav', { 'aria-label': 'Main menu' })
  refs.textLink = h('a', { text: '  Docs  ' })
  refs.plainSpan = h('span', { text: 'hi' })
  refs.heading = h('h2', { text: 'Items' })
  refs.para1 = h('p', { text: 'a' })
  refs.para2 = h('p', { text: 'b' })
  refs.item1 = h('li', { text: 'one' })
  refs.item2 = h('li', { text: 'two' })
  refs.list = h('ul', {}, [refs.item1, refs.item2])
  refs.section = h('div', {}, [refs.heading, refs.para1, refs.para2, refs.list])
  const body = h('body', {}, [refs.testidBtn, refs.idInput, refs.ariaNav, refs.textLink, refs.plainSpan, refs.section])
  return { document: new StubDocument(body), refs }
}

// --- ladder rung round-trips ----------------------------------------------

test('rung 1: data-testid wins over id, aria-label and text', () => {
  const a = makePage()
  const b = makePage()
  const desc = buildSelector(a.refs.testidBtn)
  assert.deepEqual(desc, { t: 'testid', v: 'submit-order' })
  assert.equal(resolveSelector(desc, b.document), b.refs.testidBtn)
})

test('rung 2: id when no data-testid', () => {
  const a = makePage()
  const b = makePage()
  const desc = buildSelector(a.refs.idInput)
  assert.deepEqual(desc, { t: 'id', v: 'email' })
  assert.equal(resolveSelector(desc, b.document), b.refs.idInput)
})

test('rung 3: aria-label when no data-testid or id', () => {
  const a = makePage()
  const b = makePage()
  const desc = buildSelector(a.refs.ariaNav)
  assert.deepEqual(desc, { t: 'aria', v: 'Main menu' })
  assert.equal(resolveSelector(desc, b.document), b.refs.ariaNav)
})

test('rung 4: trimmed link/button text', () => {
  const a = makePage()
  const b = makePage()
  const desc = buildSelector(a.refs.textLink)
  assert.deepEqual(desc, { t: 'text', tag: 'A', v: 'Docs' })
  assert.equal(resolveSelector(desc, b.document), b.refs.textLink)
})

test('rung 4: text of a button spans its descendants', () => {
  const button = h('button', { text: 'Sa' }, [h('span', { text: 've' })])
  const page = new StubDocument(h('body', {}, [button]))
  const desc = buildSelector(button)
  assert.deepEqual(desc, { t: 'text', tag: 'BUTTON', v: 'Save' })
  assert.equal(resolveSelector(desc, page), button)
})

test('rung 5: structural path for anonymous elements', () => {
  const a = makePage()
  const b = makePage()
  const desc = buildSelector(a.refs.item2)
  assert.deepEqual(desc, { t: 'path', v: 'DIV:nth-of-type(1)>UL:nth-of-type(1)>LI:nth-of-type(2)' })
  assert.equal(resolveSelector(desc, b.document), b.refs.item2)
})

test('rung 5: nth-of-type counts same-tag siblings only', () => {
  const a = makePage()
  const b = makePage()
  // para2 is the third child of the section but only the second <p>
  const desc = buildSelector(a.refs.para2)
  assert.deepEqual(desc, { t: 'path', v: 'DIV:nth-of-type(1)>P:nth-of-type(2)' })
  assert.equal(resolveSelector(desc, b.document), b.refs.para2)
})

// --- ladder fallthrough ----------------------------------------------------

test('non-button/link elements skip the text rung', () => {
  const a = makePage()
  const b = makePage()
  const desc = buildSelector(a.refs.plainSpan)
  assert.deepEqual(desc, { t: 'path', v: 'SPAN:nth-of-type(1)' })
  assert.equal(resolveSelector(desc, b.document), b.refs.plainSpan)
})

test('button text longer than 60 chars falls through to path', () => {
  const long = 'x'.repeat(61)
  const button = h('button', { text: long })
  h('body', {}, [button])
  assert.deepEqual(buildSelector(button), { t: 'path', v: 'BUTTON:nth-of-type(1)' })
})

test('button text of exactly 60 chars still uses the text rung', () => {
  const text = 'y'.repeat(60)
  const button = h('button', { text })
  h('body', {}, [button])
  assert.deepEqual(buildSelector(button), { t: 'text', tag: 'BUTTON', v: text })
})

test('whitespace-only button text falls through to path', () => {
  const button = h('button', { text: '   ' })
  h('body', {}, [button])
  assert.deepEqual(buildSelector(button), { t: 'path', v: 'BUTTON:nth-of-type(1)' })
})

// --- resolution strictness --------------------------------------------------

test('ambiguous text resolves to null', () => {
  const one = h('button', { text: 'Save' })
  const two = h('button', { text: 'Save' })
  const page = new StubDocument(h('body', {}, [one, h('div', {}, [two])]))
  assert.equal(resolveSelector({ t: 'text', tag: 'BUTTON', v: 'Save' }, page), null)
})

test('unique text among many same-tag elements resolves', () => {
  const save = h('button', { text: 'Save' })
  const cancel = h('button', { text: 'Cancel' })
  const page = new StubDocument(h('body', {}, [save, cancel]))
  assert.equal(resolveSelector({ t: 'text', tag: 'BUTTON', v: 'Cancel' }, page), cancel)
})

test('unresolvable descriptors return null', () => {
  const { document } = makePage()
  assert.equal(resolveSelector({ t: 'testid', v: 'nope' }, document), null)
  assert.equal(resolveSelector({ t: 'id', v: 'nope' }, document), null)
  assert.equal(resolveSelector({ t: 'aria', v: 'nope' }, document), null)
  assert.equal(resolveSelector({ t: 'text', tag: 'BUTTON', v: 'nope' }, document), null)
  assert.equal(resolveSelector({ t: 'path', v: 'DIV:nth-of-type(1)>TABLE:nth-of-type(1)' }, document), null)
  assert.equal(resolveSelector({ t: 'path', v: 'DIV:nth-of-type(9)' }, document), null)
  assert.equal(resolveSelector({ t: 'bogus', v: 'x' }, document), null)
  assert.equal(resolveSelector(null, document), null)
})

test('selector for body itself round-trips as an empty path', () => {
  const a = makePage()
  const b = makePage()
  const desc = buildSelector(a.document.body)
  assert.deepEqual(desc, { t: 'path', v: '' })
  assert.equal(resolveSelector(desc, b.document), b.document.body)
})
