status: open
origin: 2026-09-13 bounded-table architecture review
area: publication table metadata / header context

bounded header pages alone do not bound preparation or storage. one tbody with
1000 repetitions of `<tr><th scope="rowgroup">Header i</th></tr><tr><td>Value i</td></tr>`
contains 2000 cells and 71,810 UTF-8 bytes including table/tbody wrappers (i=0..999;
SHA256 `46dc7dd24d467c587ac0e4e4548f7dc39dc4c3c30cde055395ea5c400a53bc04`).
WHATWG table header assignment step 3.5 gives the data cells 500,500 cumulative
header associations. EPUB ingest preserves th scope at `epub_ingest.py:274`.
this is supported input, not hypothetical hostile mutation.

prerequisite: finalize sparse table geometry and exact header-assignment rules.
retain a source-sized logical projection; compute bounded context for the selected
cell/window through existing range/page access. shared identical chains may be
an optimization only after their total preparation/storage bound is proved.
do not eagerly expand every cell/header pair or truncate associations.

acceptance: the recipe above and sparse spans preserve complete accessible header
context with bounded page responses, source-proportional retained metadata, and
qualified worker/query memory and latency. explicit headers, data-cell barriers,
empty headers and model-error overlaps follow the normative algorithm.

source: https://html.spec.whatwg.org/multipage/tables.html#algorithm-for-assigning-header-cells
