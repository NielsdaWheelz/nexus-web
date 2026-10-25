# epub reindex does not reconstruct heading context

`python/nexus/services/content_indexing.py:426` creates epub `IndexableBlock`
values without `heading_path`; its default is empty at
`python/nexus/services/content_chunking.py:57`. forced text reindex uses these
blocks at `content_indexing.py:658`, spools them at `:673`, and publishes them
at `:678`. the publisher reads their headings at `:199` and chooses citation
labels at `:207`. restored epub
passages have nonempty stored heading paths. publication takes that metadata
from the supplied blocks, so reindexing can lose existing heading context.

impact: heading search terms and citation labels may disappear while literal
text and passage targets remain valid. book137's fixture incorrectly assumed
that the current extractor could reproduce existing passage metadata; its
setup assertion failed before passage publication. the failed run and unchanged
canonical hashes remain private at `.nexus-local/search-qualification/book137/`.

resolve by deriving heading context from the canonical epub navigation/source
representation through a shared extraction owner, then verify reindex metadata,
literal text and targets together. preserving authoritative existing passages
in a maintenance fixture does not qualify that extraction path.
