# row 232 retains a false backlink apparatus item

status: deferred; deletion scope undecided, production repair not run
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

prerequisite: decide whether the second stable identity may be removed. recheck
its exact source semantics and every saved dependent under the repair fence.
if approved, remove only that item with the already approved false target and
edge; preserve the real marker, reading state and all unrelated identities.
prove the revised one-off correction on a restored clone before production.

acceptance: row 232 repairs idempotently; both substantive authored notes open
from their actual markers, no false note remains, and source bytes, fragments,
saved positions and unrelated apparatus identities match baseline. remove the
one-off correction after its verified production use.
