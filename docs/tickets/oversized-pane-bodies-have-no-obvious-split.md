# four pane bodies are oversized with no split anyone can justify

status: open · origin: 2026-09-17 slop sweep (claude session) · area: web panes
· oi-161

the sweep reported four units as too large to read and then declined to act:
`MediaPaneBody.tsx` (one 7.1k-line function), `LibraryPaneBody` (2.4k),
`StatsPaneBody` (1.6k) and `PodcastDetailPaneBody` (1.6k). every verifier agreed
that no split is obvious without inventing abstractions, which would trade size
for indirection and leave the reader worse off.

this is recorded, not scheduled. the honest prerequisite is that the dedupes
land first: the revalidation settlement extraction (oi-155), the destructive
action cutover (oi-156) and the resource-action work all remove material from
exactly these files, and the shape of what remains is what should decide any
split.

prerequisite: the slice PRs and oi-155 / oi-156 have landed.

fix: re-measure the four files afterwards. split only where a cohesive concept
with an explicit contract falls out of the remaining code — a named hook, a
presenter, a state machine — never a mechanical division by line count.

acceptance: either each file has a split whose parts are independently
understandable, or a note here records the re-measured sizes and the decision to
leave them whole.
