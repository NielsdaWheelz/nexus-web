# writing status hides its instruction behind details

problem: a text's writing status renders through `FeedbackStatus`, which shows
only the title and moves `message` into a collapsed `details` disclosure. when
local storage fails, the status reads `recent changes are only in this tab.`
and the actionable instruction `keep it open or download your writing.` is not
visible until the person opens details. the same applies to the uncertain
status message and to every recovery row status that carries a message.

impact: the delivery/storage content contract requires the full instruction
beside the affected writing. a person who sees only the title is told that
their recent changes are at risk but not what to do, while the work exists only
in memory.

evidence (source at `9c03be696`):
- `apps/web/src/components/notes/NoteNotices.tsx:347`: `memory_only` carries
  the instruction as `message`; `:381–382` passes it to `FeedbackStatus`.
- `apps/web/src/components/feedback/Feedback.tsx:253,282`: a `message` makes
  the signal collapsible and renders only inside the details body.
- `apps/web/src/components/notes/WritingRecovery.tsx:239`: recovery row states
  (`keep it open or download your writing.`, `your draft is kept. review it.`)
  use the same path.
- lab 6: the quota case reaches a real strict-transaction abort and the status
  title `recent changes are only in this tab.`, then fails to find the visible
  text `keep it open or download your writing.` in the pane.

proposed fix (scoped to e's writing status, no feedback redesign): keep the
title and actions on `FeedbackStatus`, pass no `message` there, and render the
status's instruction as visible text directly beside it in `WritingStatus` and
in recovery rows. ordinary quiet statuses (`saving…`, `saved on this device ·
syncing`, `synced`) have no message and stay unchanged.

resolved when, under a real storage failure, the affected text shows both
`recent changes are only in this tab.` and `keep it open or download your
writing.` without expanding anything, quiet statuses gain no extra text, and the
uncertain/recovery instructions are equally visible.
