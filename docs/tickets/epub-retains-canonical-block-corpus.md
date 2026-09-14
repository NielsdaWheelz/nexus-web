status: open
origin: 2026-09-14 bounded-workspace source allocation review
area: epub preparation / fragment blocks

`fragment_blocks.py:48` returns one `FragmentBlockSpec` per canonical double
newline; `epub_ingest.py` retains those lists for every chapter in its extraction
plan. `insert_fragment_blocks` also constructs the whole fragment's ORM row list
before flush. temporary block substrings and `strip()` add allocation during
parsing. the pending body spool leaves these lists resident. this is a proven
retention shape, not measured peak attribution.

the earlier claim that arbitrary text-node newlines defeat the source element
bound was incorrect: `canonicalize.py:136` maps all text-node whitespace to a
space. consecutive `<br>` nodes can create canonical double newlines, consuming
the existing 100,000-element per-entry / 1,000,000-element whole-book budget.
for R nodes in the rendered tree, at most two structural newlines per node means
at most R+1 parsed blocks; the exact preflight-to-repaired-tree bound still needs
its source transformation audit. no independent unbounded-cardinality claim.

first measure the body-spool candidate at the existing supported source bounds.
then qualify real `a<br/><br/>` markup within those shared structural budgets,
including the remaining OPF/navigation/wrapper elements. retain exact source
bytes and observed canonical/block counts. reuse contiguous offset/delimiter
semantics; consider an iterator and bounded publication insertion only if the
measurement requires it. do not raise the spool envelope or lower accepted source
limits to conceal the derived cost. arbitrary legacy schema-one canonical inputs
are a separate native contract and do not supply hosted EPUB fixture semantics.

acceptance: actual maximum structural source prepares and publishes exact block
coverage under the declared worker/scratch limits, with independent first/last,
empty-block, separator and rollback oracles; no corpus-sized block/ORM retention.
