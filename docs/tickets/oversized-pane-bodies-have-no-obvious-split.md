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

2026-10-04 remeasurement at `e53d484ca68dc961ff884cf7afff32bd9782b2e7`:
media 7,737 lines, library 1,050, stats 968, podcast detail 1,543. #491 gave
library entry snapshot/replacement one owner; these sizes are not removable-line
claims. the media host remains sha256
`cd221d8d2c10456257596c9e8a4bfb7e481ad06e9c3d0932562a9586d470dac9`.

the admitted original browser boundary covers actual article/epub/pdf/transcript
leaves; it does not prove a candidate rewrite equivalent. both source reviews
rejected the proposed visit/interaction split because its cyclic capabilities
would require reflected state or cross-owner coordination. the candidate on peer #496 base `bcfc93b69`
keeps the host cohesive and consolidates positioning, navigation lowering and
publication mechanisms: 7,736→7,499 physical lines (237 removed),
7,438→7,215 nonblank (223 removed), sha256
`1e57a9332c9d9adff35a11baa04d5fd87471c5d6a64224cc9c7aae687a67cdf6`.
no hook was created and no moved-line saving is credited. shared
format/session/progress/navigation engines remain.

acceptance requires actual complexity absorption and net reduction, not a moved
god file or a large reflected property bag. the 4,600-line design estimate is
neither a ceiling nor an invariant, and the source audit does not substantiate
the initially proposed multi-thousand-line deletion. independent source review
and controlled four-format browser comparison admit this narrower consolidation;
unexecuted navigation/editing branches remain source-qualified. the static gate
passed. broader reader reauthoring and other pane concept audits remain open.
