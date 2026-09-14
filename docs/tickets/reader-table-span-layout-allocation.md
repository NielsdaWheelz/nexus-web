status: open
origin: 2026-09-13 bounded reader node projection review
area: table rendering / capacity

an exact DOM-node bound does not bound table layout slots. the existing EPUB
sanitizer preserves `td`/`th` `colspan` and `rowspan`
(`python/nexus/services/epub_ingest.py::_EPUB_ALLOWED_ATTRS`). a small node tree
can therefore describe a much larger layout grid. the current
`ReaderPublicationLimits.unit_dom_nodes` counts actual nodes only.

qualify intact-table grid allocation explicitly. oversized excerpts must retain
source spans in their context and accessible attributes without causing the
browser to materialize the original sparse grid. preserve every source cell and
its coordinates; do not narrow the supported source envelope silently.

acceptance: real browser capacity proof covers sparse large spans as well as
dense rows, including two admitted views; chosen layout admission is checked
before mounting and is reflected in worker/native conformance.
