# a title-only publication duplicates the whole document's text

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: publication schema / retained growth

## what is wrong

publishing a new generation copies the per-generation unit rows, which carry
`canonical_text` and the search-source text. a title-only republication therefore
duplicates the whole document's text in SQL to change one string.

layer one is done: `replace_reader_document_title` returns `False` when the
locked media already carries the requested title, so a no-op enrichment publishes
no generation, no descriptor row and no projection copy
(`python/nexus/services/reader_publication.py:382-393`), and
`_prepare_enriched_title` in `python/nexus/tasks/enrich_metadata.py` no longer
freezes a successor descriptor for a rename that changes nothing. a proof covers
it (`test_republishing_an_unchanged_title_advances_no_generation`).

layer two is not done: a **genuine** title change still copies every unit's text.

## prerequisites

this is a schema change — a migration beside 0229, the artifacts writer, and
every generation-addressed read path. it is deliberately scheduled against gate
0's retained-growth number rather than merged blind, so that number must exist
first (see the gate 0/a ticket).

## proposed fix

split unit text and search-source text out of the per-generation rows into a
per-media content-identity row keyed by content digest, so a generation carries
coordinates and a reference rather than a copy; a title reuse then copies
coordinates only.

## acceptance

publishing a changed title advances the generation without copying unit text, and
the retained-growth measurement for a document with N title changes is flat in
document size.
