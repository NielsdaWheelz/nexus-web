# qualify browser dom expansion before mounting units

status: open
origin: 2026-09-13 bounded-workspace implementation and client review
area: publication format, browser/native admission

`python/nexus/services/reader_publication_units.py:_index` (the node counter the
splitter actually uses; `count_html_dom_nodes` is gone) counts lxml nodes and
reserves `READER_PUBLICATION_MOUNT_NODES` beside them (`:174`, with the
`unit_dom_nodes` refusals at `:618` and `:795`); the browser can still insert
tbody or reconstruct formatting while parsing those bytes.
`html5_shape.py` covers only foreign breakouts, nested paragraphs and stray table
structure. its broad docstring is not proof of complete html5 equivalence.
the experimental 8192-node unit profile therefore does not yet establish the
browser's preallocation or live-plus-transition node bound. counting afterward
can detect a defect but cannot undo its peak allocation.

prove a conservative expansion bound over the supported sanitized corpus, or
prepare bounded browser-stable html5 units upstream without altering original
canonical coordinates. table excerpts must emit explicit valid table nesting.
reuse this evidence for schema1 migration where applicable; do not silently drop
formerly admitted content or equate lxml fixed points with html5 streamability.

acceptance: adversarial tbody insertion, adoption/foster recovery, foreign content
and paragraph/table boundaries have measured and enforced preallocation bounds;
rendered canonical ranges remain exact. release qualification includes both old
and entering units at the physical/browser boundary.
