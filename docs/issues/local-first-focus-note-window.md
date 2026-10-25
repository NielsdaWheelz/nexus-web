# exact page-note focus outside the loaded prefix

`PagePaneBody` preserves a `FocusNote` entry until the exact local outline editor
mounts; it must not report an existing note missing merely because the bounded
100-row prefix excludes it. `LocalOutline` currently exposes prefix pagination
and DOM focus only. a deep target therefore waits for manual expansion.

impact: opening a page at a later note does not yet satisfy the existing focus
entry, and exhausting a very large page would mount too many editors. this needs
a bounded target window rather than loading the full prefix.

evidence: `components/notes/LocalOutline.tsx` reads `useAuthoredPages(adjacency,
limit:100)` and its `focusNote` searches mounted rows; `pages/[pageId]/PagePaneBody.tsx`
retains the pending entry with a mutation observer.

resolved when a known exact link/position can open a bounded neighborhood and
focus its editor, with structural operations still using canonical neighbors and
no false missing-note result. verify a target beyond the first 100 rows on a
100,000-link page without mounting the entire prefix.
