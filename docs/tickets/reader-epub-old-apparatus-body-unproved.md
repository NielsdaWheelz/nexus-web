# historical epub apparatus body cannot be preserved

status: open
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

prerequisites: explicit acceptance of a narrowly proved correction to the
published-identity preservation rule. require reciprocal retained-dom markers,
exact old/new ref and marker-span matches, two disjoint note bodies, the source
target relationship, and zero external dependents. recheck dependents under a
write barrier during apply; reject every ambiguous shape. do not relax the
general group or old-identity guards.

acceptance: fenced inspect/apply removes only the false old body and edge,
retains the unchanged old ref, installs the two proved pairs, and preserves all
unrelated items, edges, and user state. negative shapes reject without a write.
until then inspect rejects and the combined reader cutover waits.
