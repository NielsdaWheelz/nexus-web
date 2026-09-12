# epub content headings are absent from reader structure

status: open
origin: 2026-09-11 reader structure audit
area: epub ingestion and document navigation

## evidence

`python/nexus/services/epub_ingest.py:2536-2567` creates navigation locations
only from publisher toc nodes. when a fragment has no toc node,
`:2572-2585` creates one location for the entire xhtml spine item. the
ingest path indexes only requested nav anchors (`:765-790`); it never
extracts content headings into navigation structure.

an xhtml file containing several chapters therefore has one reader node when
the publisher navigation is absent or names only the file. finer headings
remain visible in the text but cannot appear as document-map boundaries.

## prerequisites and fix

define the relationship between publisher navigation, content headings, and
physical spine items. during canonicalization, index heading starts and their
hierarchy, reconcile them with publisher targets, and retain one canonical
target for aliases at the same location. preserve publisher labels and source
provenance; do not infer content length from a file or toc-entry count.

## acceptance

independent epub fixtures with multiple headings in one xhtml file, absent
navigation, and a coarse publisher toc expose every supported heading at its
exact canonical offset. fragment totals count content once, typography does
not alter positions, and clicking each heading resolves to its text.
