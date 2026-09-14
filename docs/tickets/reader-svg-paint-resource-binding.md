status: open
origin: 2026-09-13 bounded render-node asset admission review
area: epub SVG sanitization / reader asset admission

the former `epub_ingest.py::_sanitize_svg_attributes` literal `url(` check admitted
escaped external references: real EPUB red `c5167524e5221ff5`. producer and package
verification now reuse the pinned tinycss2 owner; green `47b2ad574829161f` preserves
escaped local IDs, ordinary gradients and modern theme-dependent colors.

remaining: shared browser vector admission and the actual resource-request proof.
`LocalFragment{fragment_id,fallback}` replaces raw local URL syntax. literal CSS
and fallback resource semantics belong to the publisher; Kotlin/TS validate the
closed shape and exact artifact integrity, not a duplicate parser or regex.
construct local references with correct CSS quoting after admission. preserve
the existing offline no-network authority/CSP.

acceptance: escaped/mixed-case URL syntax cannot initiate an undeclared request;
ordinary fills/strokes and local gradients survive. prove this through the real
browser resource request boundary and the source sanitizer.
