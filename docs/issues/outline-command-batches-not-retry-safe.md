# structural command batches can fail exact replay

problem: a batch may update a note and then structurally remove its last place.
the first request commits the deletion; exact replay fails its initial body write
because that note is gone. generic unlink is separate and preserves content.

evidence after insertion #683: `python/nexus/services/outline.py:162-175` now
rejects multiple moves and repeated body/title lanes, fixing the original
examples. it still admits `set_body(note, expected_version=1)` followed by
`remove(last_link, expected_body_version=2)`; `:479-500` deletes that note.
2026-10-19 isolated real bff/api/postgres probe at migration 0297: this canonical
`POST /resource-graph/commands` batch returned 200, note read returned 404, and
replaying identical commands returned 404 `E_NOT_FOUND`.

impact: response loss makes a committed structural operation appear refused.

fix: reject unsupported structural/text combinations before effects or give the
accepted batch a final-intent retry rule. no replay ledger; this remains outside
the preserving-unlink change.

resolved when exact replay converges after committed note deletion, or that
combination is rejected atomically before its first effect.
