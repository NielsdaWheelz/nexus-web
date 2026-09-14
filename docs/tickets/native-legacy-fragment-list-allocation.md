status: open
origin: 2026-09-14 native source inventory review
area: local schema-one conversion memory

main `OfflineReadingLegacyUnits.kt:44-53` (`15ab34a8...`) closes its
source-fragment cursor by retaining every row in `buildList`. this new list
scales with all fragment identities, strings and scalar objects before any
fragment is converted. the 64 mib original envelope is not a small fragment-
count bound; the new retained allocation has no capacity receipt. its stated
purpose, closing the cursor before another connection stages a fragment, is
valid. exact delta is `/tmp/native-main-followup-deltas-20260914/OfflineReadingLegacyUnits.kt.diff`.

prerequisite: independently review this uncopied main delta; native proofs at
`d10e5e068f` use the prior source. replace whole-list retention with ordered
one-row keyset reads using the existing unique `fragments.fragment_idx` index,
closing each cursor before staging. retain original source/order/checkpoints.

acceptance: many-fragment original conversion and interrupted resume preserve
all hashes and canonical order; no cross-connection cursor remains open during
staging, and measured heap does not retain the complete fragment list.
