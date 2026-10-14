# row 232 retains a false backlink apparatus item

status: unresolved; new campaign preserves existing identities, repair not run
origin: 2026-09-27 pr #398 restored-clone source-note review
area: epub apparatus / historical repair

media `09f34c39-5c2c-481a-a713-9d83f7bbf320` has reciprocal superscript
markers. the approved narrow correction removes false target
`epub:8:target:fn1_1` and its edge after dependent checks. a second historical
item, `epub:8:ref:000001:fn1_1`, represents the authored return marker rather
than a note opener. pr #398 preserves it through
`reader_navigation_repair._verified_0245_legacy_backlink`, so the proposed
reader map can still expose a misleading unavailable note. the 0245 clone
excluded this one publication from its 233 applied repairs. source sha256 is
`74fa6340b64edcb05cd2738993354155f00552d0dcd1b19344cd31bc5a3fa3c9`;
private inspection: `/tmp/nexus-chapter-rehearsal.nx22kQ/source-notes-0245/focus-232.json`.

2026-10-14 disposition: the [new campaign](../book-repair-plan.md) removes
the dataset-specific exception and permits no existing item/edge deletions.
the r3 inspection still contains this media at generation 3 with a changed
proposal and zero removed keys. removing special backlink preservation can
make its fresh inspection refuse; that is an unresolved item, not a repair.
historical deletion approval is not carried into this campaign.

next: preserve this obligation and its exact source evidence. if the ordinary
source-proof contract cannot repair it without identity loss, retain the refusal.
a later broader correction needs its own explicit scope and saved-dependent
proof; do not recreate a dataset-specific compatibility branch.

acceptance: row 232 repairs idempotently; both substantive authored notes open
from their actual markers, no false note remains, and source bytes, fragments,
saved positions and unrelated apparatus identities match baseline. the planned
removal of one-off code alone does not meet that product acceptance.
