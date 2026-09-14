# bounded table continuation

status: open
origin: 2026-09-13 bounded-workspace implementation
area: immutable reader publication and rendering

the original `reader_publication_units.py` treated tables as atomic. the staged
replacement now emits bounded excerpts (small-source kernel green
`c6dda79f655206e3`, original-source red `0dc32a58890e91da`); real publication,
accessibility and maximum-source qualification remain open. the existing 64-mib encoded reader envelope admits larger tables than the
experimental unit profile. browser receipt `a6b1e927cbd3818f` measured a 2-mib
dense table at 309,408 dom nodes and about 351 mib of embedder heap for one view;
two views approached 970 mib. a larger atomic allowance is not qualified.

implement the reviewed oversized-table excerpts: preserve logical grid positions,
spans, source caption/header access, exact canonical ranges, images and empty cells.
keep intact layout when it fits. one cell's arbitrarily long explicit header list
must also have bounded access; repeating that list in every continued unit is not
a bounded solution. prepare references in the existing two-pass temporary staging
owner, before publication.

acceptance: dense corpus plus oversized individual cells, rowspan/colspan,
explicit header lists, caption and image-only headers all remain traversable;
each source text range occurs once; no dangling accessibility references; every
encoded/expanded unit and context read obeys its qualified limit. failed preparation
retains the previous publication pointer.

2026-09-14 source allocation review: `ReaderTableSource.canonical_ranges` used
`CanonicalTextBuilder.build_with_source_starts` for a whole fragment, costing an
8-byte source offset per canonical point before other buffers. 64-mib ascii would
add 512 mib; small greens do not qualify this. all-ordinary fragments now skip
that projection. sparse marker mapping now passes the independent nfc, reordered
marks, hangul, emoji and separator corpus in `bd8ea004677d16d3` (kernel passed;
the overall run later failed an unrelated service fixture). the same primitive
now replaces the full array plus sorted list on requested element-anchor reads;
that additional cut awaits its focused replay. largest source and indivisible
normalization-cluster costs remain unqualified.

native integration audit: sparse table metadata and its revision-bound private
index are installed, but `OfflineReadingTableHeaders` has no production caller.
its actual selected-cell caption/header command and reader lease remain required;
passing standalone query proofs cannot establish that visible source access.

2026-09-14 hosted query audit: the source/session has no selected-cell query or
full header/caption disclosure yet. the native characterization in
`apps/android/app/src/test/java/app/nexus/android/offline/reading/OfflineReadingTableHeaders.kt`
retains query-private opacity/result tables across `page()` calls; a signed
ordering tuple in the proposed stateless hosted endpoint cannot preserve that
state. automatic header pages would otherwise recompute earlier associations.
explicit-target and group-only phases can keyset immutable source rows directly.
runtime confirms there is no proved linear bound for all group-keyed opacity
interval state and no reviewed stateless continuation algorithm; the class's
"source-sized interval state" comment is not a qualification receipt.

prerequisite for activation: qualify an actual selected-query reducer and its
continuation ownership against the existing literal/source corpus, maximum
source-formable overlap and repeated selection. scalar metadata for one table
may be scanned with an explicit measured price; publication bodies must remain
addressed through bounded units. preserve exact first-occurrence order and full
source disclosure; do not disguise prefix recomputation as an indexed seek or
freeze a new query lifetime merely to make the proposed cursor work.


small scalar characterization `7dcdc43092c83664` at `3b0d3b9a6b` now passes
22 independent source cases and the actual 3x4/6x8 fragmentation recipes.
candidate/event visits grow 35/70 to 108/216. no maximum query ran. row and
rowgroup recipes with h headers then d data cells produce h*d output links:
12 at 3x4, 48 at 6x8. 49,997 headers and 49,998 cells fit 100,000 elements and
1,599,979 markup bytes but imply 2,499,750,006 prepared per-cell links. eager
pair preparation is therefore not source-sized. a sparse event sweep and
bounded group-opacity representation still require design and measurement;
no persisted query cache or second readiness pointer is accepted.
