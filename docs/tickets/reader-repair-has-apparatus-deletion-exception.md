# reader repair can delete an existing apparatus identity

status: open; replacement contract specified, implementation not run
origin: 2026-10-14 book-repair planning at `75b17c030`
area: reader maintenance / identity preservation

`python/nexus/services/reader_navigation_repair.py:980–986` exempts one
`corrected_legacy_marker` item/edge pair from the ordinary removal refusal.
`_reciprocal_marker_correction` (506), `_specific_0245_bad_target` (687) and
their dependent checks implement that exception. this contradicts the new
campaign's unconditional preservation of existing apparatus identities.

the adjacent `_verified_0245_legacy_backlink` (632) also preserves row 232's
return-marker item when no deletion is proposed. the retained r3 inspection
for `09f34c39-5c2c-481a-a713-9d83f7bbf320` has generation 3, `changed=true`
and empty removed-item/edge sets. deleting that special case may therefore
make this previously eligible item refuse; it is not behavior-neutral cleanup.

fix: in the [book-repair plan](../book-repair-plan.md), remove the complete
legacy marker exception, state and dependent-check machinery. require empty
removed-item/edge sets unconditionally. retain ordinary source correspondence
and retained-body preservation. do not replace the exception with a new fallback.

acceptance: deletion attempts refuse before writes; ordinary qualified proposals
remain equivalent; row 232 may explicitly refuse with no writes. its
[misleading-note obligation](reader-epub-row232-backlink-classification.md)
remains open. rehearse protected-state equality and idempotence on a restored
copy before applying any candidate to production.
