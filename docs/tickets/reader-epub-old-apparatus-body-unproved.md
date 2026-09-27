# historical epub apparatus body cannot be preserved

status: open
origin: 2026-09-27 production corpus census, base `3029201f`
area: epub apparatus repair

one of 239 hash-verified ready epubs failed inspect with `Stored EPUB apparatus item
cannot be preserved as a note body` in `reader_navigation_repair._prepare`. the old
exact footnote has no proved note group; the new target has the same source
target id and fragment but a different, overlapping exact span, body and stable
key. the old span is one character on an untyped `<a>` under `<sup>`; the new
span starts there and extends 78 characters. this suggests historical
marker-as-body classification. keeping both would duplicate a physical note
and strand the old edge. private evidence:
`/tmp/nexus-chapter-rehearsal.nx22kQ/census/receipts.jsonl` (0600). dropping
the item would delete its stable identity and dependent reader state.

prerequisites: inspect retained dom and source target semantics to decide whether
the new target is overbroad or the old item needs a separately proved identity
reconciliation. do not relax the group guard or publish overlapping bodies.

acceptance: one proved physical note retains the old stable key, exact body or
an explicitly reconciled boundary, and edge endpoint through fenced repair.
until then inspect rejects without a write and the combined reader cutover waits.
