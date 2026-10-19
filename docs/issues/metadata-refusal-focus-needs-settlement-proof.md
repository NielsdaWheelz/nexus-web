# metadata refusal focus needs settlement proof

status: open; preexisting source-reviewed concern, not a live-confirmed defect.
origin: 2026-10-14 imports experience implementation review.
area: shared metadata retry/review controls.

`apps/web/src/components/media/MetadataResearchActions.tsx` uses native disabled
controls for local review pending and canonical metadata retry. chromium can blur
such a focused control to body; their settlement need not rerender the imports
list's focus repair. no actual refused metadata command was qualified here.

source/search now share focus-preserving busy presentation in `ImportActions.tsx`;
real source refusal and duplicate-activation proof resolved that portion of the
former combined ticket. upload refusal is also verified. the owner waived live
no-findings/exact-job review; that waiver supplies no evidence for other metadata
refusal paths. see [metadata proof](imports-live-metadata-proof-needs-working-search.md).

prerequisite: a real offered metadata retry or review command. exercise refusal
with its control focused, then with deliberate focus on another input/draft.
if lost, fix pending presentation at that control's owner, following the existing
focusable busy pattern; do not add an imports observer or poller.

acceptance: refusal retains its connected enabled trigger or intentional canonical
destination and preserves focus/drafts elsewhere. record actual observations and
delete this ticket.
