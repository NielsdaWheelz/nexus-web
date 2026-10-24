# the reader's recolour and bounds edit stop the pane on an answered defect

status: open · origin: notes re-slice review, 2026-10-21 · area: reader web ui
(`app/(authenticated)/media/[id]/useAnnotationVerbs.ts`)

recolouring a highlight and editing its bounds write through the tab FIFO
(`annotations.ts` `update`). since the notes re-slice the queue ends a job the api
answers with a defect (500, a malformed reply) and hands it to the owner's `fail`;
before, it held the request at the queue head. both verbs pass that error to
`useAnnotationVerbs`'s `fail`, which raises every same-system defect to the pane
boundary: "this pane stopped unexpectedly", no retry, once the queue has already
reported it.

impact: a 500 on a recolour or a bounds edit, which may have landed, stops the reader
pane instead of saying the change is unconfirmed. nothing is lost (both carry their
expected version, so a resend after a landed change is refused as a conflict). the
selection composer's own writes no longer stop the pane: it keeps the draft and says
"this request did not finish. your draft is kept." (notes re-slice).

evidence: by code, `useAnnotationVerbs.ts` `fail` (`setDefect` for
`isSameSystemApiDefect`) on the `recolor` and `rebound` rejections; the notes harness
proved the composer's half live (consumers/Q4f).

resolved when: a recolour and a bounds edit answered 500 after landing keep the pane,
say the change is unconfirmed and offer it again, and the defect is reported once.
