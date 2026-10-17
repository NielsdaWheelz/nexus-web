status: open
origin: 2026-10-16 find-bar adversarial source review; predates this change at baseline `69c00182c`
area: pane find / companion focus

evidence revision: implementation `d03fc1ff3`; line citations below refer to that
revision. baseline equivalents: `FindBar.tsx:196`, `useFind.ts:159–160`.

source-traced, not reproduced: activating a companion result can fail after
movement starts. `components/find/FindBar.tsx` calls `find.activate(index)` from
the collection row (`FindBar.tsx:209`); `lib/find/useFind.ts:178`'s reveal publishes `Failed`; the
companion (`FindBar.tsx:229`) replaces that focused `CollectionView` with its failure message. no
focus transfer is owned by this failure transition. paths are under
`apps/web/src/`. the stable results root added for retry does not by itself
restore focus after a failed row activation.

impact: focus can fall to body and leave keyboard users outside search results.
this is distinct from retry/return buttons disappearing, which the current
change repairs.

prerequisite: reproduce a real reveal refusal while its result row owns focus.
repair the transition at the find results view; preserve successful activation's
existing focus behavior and never reclaim focus after a newer user action.

acceptance: failed activation leaves focus on a meaningful surviving target;
success and cancellation preserve their existing behavior; no delayed focus
steal or focus-induced viewport jump.
