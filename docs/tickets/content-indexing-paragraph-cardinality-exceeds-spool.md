status: open
origin: 2026-09-14 bounded-workspace full-source indexing review
area: document index block retention and complete spool

source review identifies an accepted-shape lower bound, not an executed maximum
receipt. an EPUB containing 300,000 `<p>x<br/><br/></p>` paragraphs across ten
spine items stays below the existing 100,000 elements per entry, 1,000,000 per
book and 64 MiB HTML-plus-canonical envelope (`epub_ingest.py:90`).

the former exact-end predicate refused canonical newline gaps retained in each
block (`fragment_blocks.py:84`, `content_indexing.py::_iter_content_chunk_parts`).
nearly every paragraph became one chunk. 300,000
256-dimensional float32 embeddings need at least 410,400,000 base64 bytes alone,
exceeding the 402,653,184-byte complete spool limit before text and locators.
`_snapshot_media_indexable_blocks` also loads every source and block row, then
retains one `IndexableBlock` and locator per paragraph (`:1169-1228`).

the narrow coalescing correction now consumes only original whitespace from
exactly adjacent blocks with the same source anchor, charging its UTF-8 bytes.
actual canonicalizer/block-parser/planner red `95935b997d3e7d71` becomes ordinary
green `5c5d4977026646ae`; byte-limit and unknown-gap replay
`85b50d8f6d6228f8` also passes. this removes the demonstrated one-chunk-per-paragraph
mechanism; it does not qualify the accepted structural maximum or the retained
all-block snapshot.

next run the actual accepted source through preparation and indexing, retaining
its source facts, block/chunk counts and resource receipt. preserve exact source
selectors while bounding block-state retention and sizing or streaming the
complete spool from the supported cardinality. do not hide failure by rejecting
previously accepted sources or dropping whitespace/source provenance.

acceptance: the actual source finishes its index with complete selectors and
bounded measured worker/scratch use; the current failure remains sensitive.
