# reader layer rollback retains a released prepared view

- status: open
- origin: 2026-09-14, bounded reader source-retirement review
- area: hosted reader DOM preparation

`MediaPaneBody.tsx`'s layer adoption (`complete`, around lines 2620–2677) releases
`entry.view` before preparing its painted replacement. If that preparation
throws, its `source()` rollback prepares again. If the same external DOM failure
also refuses rollback, the map still owns the released `entry.view`; the outer
catch sets `layerStatus: Failed`, then publishes the entry. Later render/imperative
borrows read its strict retired getters. This is a structural finding; the current
initial-preparation proof does not exercise paint replacement or rollback.

Prepare the detached replacement while the existing source, artwork and paint
remain owned. On failure or capacity refusal, retain them and publish the exact
layer error. On success, preserve the anchor and replace the owned projection;
delete the rollback preparation. The existing budget must include both views
during this overlap; maximum-shape qualification is still required.

Acceptance: actual admitted source + external browser DOM failure during painted
replacement and fallback; visible owned error, no retired getter escape, source
and paint charges conserved, then successful explicit Retry after the external
operation recovers.
