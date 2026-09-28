# historical epub marker correction awaits production

status: open; code proved on restored clone, production repair pending
origin: 2026-09-27 production corpus census, base `3029201f`
area: epub apparatus repair

one of 239 hash-verified ready epubs failed inspect with `Stored EPUB apparatus item
cannot be preserved as a note body` in `reader_navigation_repair._prepare`. its
old exact `footnote_ref` → `footnote` edge joins two one-character reciprocal
`<sup><a>` markers, not a marker to note prose. the old ref survives the proposal
unchanged; the old body's exact span instead equals a new ref. the proposal has
two marker → body pairs with disjoint, substantive 78- and 642-character bodies.
keeping the old body and edge would duplicate one marker and retain a false
relationship. the old body's uuid and old edge have no external dependents in
the restored production clone. private evidence:
`/tmp/nexus-chapter-rehearsal.nx22kQ/census/receipts.jsonl` (0600). dropping
the item would still delete a published stable identity.

the approved one-time correction checks reciprocal retained-dom markers,
exact old/new ref and marker-span matches, two disjoint note bodies, source
target identity, and zero external dependents. apply rechecks under a
`share nowait` write barrier; other old identities retain their strict guard.
on the restored production clone, `d924e3eb4` inspect → apply → inspect was
changed → changed → unchanged in 1.31 seconds. old ref uuid and published
content/state hashes stayed fixed; one false body and edge were removed; four
items and two correct edges remain. altered quote, edge, reciprocal href, and
an injected dependent all rejected without persisted writes.
that earlier clone proof covers the first false body and edge only. pr #398's
0245 clone left this publication unchanged because a second historical backlink
is misclassified; its separate decision is recorded in
[the row 232 ticket](reader-epub-row232-backlink-classification.md).

prerequisite: the release candidate must include the proved correction and
pass the full ready-epub census. after production repair, remove this temporary
exception in the second cleanup release.

acceptance: production fenced inspect/apply shows the same single correction
and idempotent re-inspection, with all unrelated reader state preserved; the
cleanup release restores unconditional old-identity preservation.
