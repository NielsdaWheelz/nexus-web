# nexus does not restore scroll in a constrained collection

problem: root scroll is written and restored on the collection viewport
(`DesktopNexus.tsx`, `SwitchboardTask.tsx`). when one row cannot fit,
`useCollectionLayout` marks the body `data-collection-constrained` and the body
scrolls instead (`lib/ui/collection.ts`), so no viewport scroll event fires and the
position survives no page change.

impact: a very short window, or a phone at high zoom with the keyboard up, returns
from a nexus page at the top of the list. rows stay reachable.

evidence: found by reading, not reproduced. the viewport-only read predates the
add page's back arrow.

resolved when a return from a nexus page restores the list position in a constrained
body as it does in an unconstrained one.
