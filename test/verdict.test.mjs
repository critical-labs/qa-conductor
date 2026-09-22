import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatVerdict, postVerdict } from '../lib/verdict.mjs'

const base = {
  pr: 123,
  baseTag: 'ghcr.io/x/app:1.2.3-rc.4',
  prTag: 'ghcr.io/x/app:pr-123-abc123def456',
  durationMin: 12,
}

test('formatVerdict for accept starts with the marker and approved heading', () => {
  const md = formatVerdict({ ...base, verdict: 'accept', notes: 'All flows fine.' })
  assert.ok(md.startsWith('<!-- homefree-pr-qa -->'))
  assert.ok(md.includes('## ✅ QA approved'))
  assert.ok(!md.includes('changes requested'))
})

test('formatVerdict for reject uses the changes-requested heading', () => {
  const md = formatVerdict({ ...base, verdict: 'reject', notes: 'Broken checkout.' })
  assert.ok(md.startsWith('<!-- homefree-pr-qa -->'))
  assert.ok(md.includes('## ❌ QA changes requested'))
  assert.ok(!md.includes('QA approved'))
})

test('formatVerdict includes notes verbatim, both tags, and session duration', () => {
  const notes = 'Line one.\n\n- bullet with `code` & <html>'
  const md = formatVerdict({ ...base, verdict: 'accept', notes })
  assert.ok(md.includes(notes))
  assert.ok(md.includes(base.baseTag))
  assert.ok(md.includes(base.prTag))
  assert.ok(md.includes('Session: 12 min'))
})

test('formatVerdict substitutes (no notes) for empty or missing notes', () => {
  assert.ok(formatVerdict({ ...base, verdict: 'accept', notes: '' }).includes('(no notes)'))
  assert.ok(formatVerdict({ ...base, verdict: 'accept', notes: '   ' }).includes('(no notes)'))
  assert.ok(formatVerdict({ ...base, verdict: 'accept' }).includes('(no notes)'))
})

test('postVerdict posts the formatted comment, sets qa-approved on accept, returns url', async () => {
  const calls = []
  const github = {
    async postComment(pr, body) {
      calls.push(['postComment', pr, body])
      return { html_url: 'https://github.com/x/y/pull/123#issuecomment-1' }
    },
    async setQaLabel(pr, label) {
      calls.push(['setQaLabel', pr, label])
    },
  }
  const url = await postVerdict({ github, ...base, verdict: 'accept', notes: 'ok' })
  assert.equal(url, 'https://github.com/x/y/pull/123#issuecomment-1')
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'postComment')
  assert.equal(calls[0][1], 123)
  assert.equal(calls[0][2], formatVerdict({ ...base, verdict: 'accept', notes: 'ok' }))
  assert.deepEqual(calls[1], ['setQaLabel', 123, 'qa-approved'])
})

test('postVerdict sets qa-changes-requested on reject', async () => {
  const labels = []
  const github = {
    async postComment() {
      return { html_url: 'u' }
    },
    async setQaLabel(pr, label) {
      labels.push(label)
    },
  }
  await postVerdict({ github, ...base, verdict: 'reject', notes: 'nope' })
  assert.deepEqual(labels, ['qa-changes-requested'])
})
