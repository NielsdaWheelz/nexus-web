status: open
origin: 2026-09-12, pr #238 publication memory review
area: epub extraction / resource limits

the 64 mib rendered-output cap counts utf-8 bytes, but extraction retains every
sanitized html and canonical string until publication. one astral codepoint can
widen a mostly-ascii python string to four-byte storage. the byte cap therefore
does not establish the 352 mib parser memory envelope for all admitted unicode.
normalization batches preserve complete grapheme clusters; 4096 clusters is not
an absolute byte bound when one cluster is very large. include that processing
case when establishing the complete unicode resource envelope.

evidence: `python/nexus/services/parser_temp.py:133` counts encoded bytes;
`python/nexus/services/epub_ingest.py:692` retains sanitized chapters and the
canonicalization loop retains fragment bodies. the resource fixture at
`python/tests/service/test_bounded_media_extraction.py:619` covers ascii and
decomposed accents, not astral widening. this is a storage lower-bound finding;
the specific astral parser case has not yet been run. ci receipt
`8ae128f42e7dc7eb` instead measures the separate transient-copy failure.

prerequisite: define the accepted-output contract independently of in-process
string representation. add one astral-widening case to the existing resource
owner, then bound retained-output memory through staged publication or another
explicit storage design. do not raise the worker limit or silently shrink the
document contract to make the proof pass.

acceptance: a near-limit mixed ascii/astral epub publishes exact text and
structure within the unchanged worker envelope; oversized input returns the
typed resource failure within that envelope. prove sensitivity at the existing
resource owner and retain current source/export proofs.
