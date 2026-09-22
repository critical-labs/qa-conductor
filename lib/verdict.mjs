// QA verdict: pure PR-comment formatter + post (comment + exclusive label).

export function formatVerdict({ verdict, notes, pr, baseTag, prTag, durationMin }) {
  const approved = verdict === 'accept'
  const heading = approved ? '## ✅ QA approved' : '## ❌ QA changes requested'
  const body = notes && notes.trim() ? notes : '(no notes)'
  return [
    '<!-- homefree-pr-qa -->',
    heading,
    '',
    `Side-by-side QA session for #${pr}.`,
    '',
    body,
    '',
    '| pane | image |',
    '| --- | --- |',
    `| base | \`${baseTag}\` |`,
    `| PR | \`${prTag}\` |`,
    '',
    `Session: ${durationMin} min`,
    '',
  ].join('\n')
}

export async function postVerdict({ github, pr, verdict, notes, baseTag, prTag, durationMin }) {
  const body = formatVerdict({ verdict, notes, pr, baseTag, prTag, durationMin })
  const comment = await github.postComment(pr, body)
  await github.setQaLabel(pr, verdict === 'accept' ? 'qa-approved' : 'qa-changes-requested')
  return comment?.html_url
}
