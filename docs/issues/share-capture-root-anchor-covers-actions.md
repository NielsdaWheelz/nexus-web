# share capture anchors root slips inside its action card

problem: the standalone `/share` page measures its Root anchor against the compact
capture card. a held slip covers Save and Cancel even though the viewport has
ample room below the card. this is a page-root placement defect; no semantic
modal was open, so the modal-backdrop rule alone does not describe it.

evidence: integration72cf9db84; `apps/web/src/app/share/ShareCapture.tsx:74-78`
mounts Root inside `.capture`; `share.module.css:123` makes that compact wrapper
positioned. actual canonical chromium run20261103-030012-71ffc79b7949 at1280x720
shows the overlap in `artifacts/capture-repair/accepted-read-loss-chromium.png`
and the matching whole aria snapshot. the page's `.card` is centered by `.backdrop`.

impact: an unanswered-save notice can intercept the capture card's fixed actions.

fix at the page host: give Root the actual page bounds using existing stage
composition. retain the card's layout, overlay ancestry, shell and sign-in owner;
add no reserved feedback strip, fake modal, local stage or alternate placement map.

resolved when: a real unanswered capture and typed refusal put their slips clear
of fixed card actions in both browser engines and a constrained phone viewport,
with nested destination dialogs still owning their own notices. assign after the
current capture repair is integrated to avoid competing edits.
