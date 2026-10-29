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
`python/nexus/services/epub_ingest.py` (`_parse`) retains sanitized chapters and the
canonicalization loop retains fragment bodies. the former resource fixture
at `python/tests/service/test_bounded_media_extraction.py:619` covered ascii and
decomposed accents, not astral widening. this is a storage lower-bound finding;
the specific astral parser case has not yet been run. ci receipt
`8ae128f42e7dc7eb` instead measures the separate transient-copy failure.

prerequisite: define the accepted-output contract independently of in-process
string representation. measure an astral-widening input manually, then bound
retained-output memory through staged publication or another explicit storage
design. do not raise the worker limit or silently shrink the document contract.

acceptance: a near-limit mixed ascii/astral epub publishes exact text and
structure within the unchanged worker envelope; oversized input returns the
typed resource failure within that envelope. record manual memory and
source/export checks for the affected ingestion path.

2026-10-28 actual qualification: normal epub upload/confirm of one paragraph
containing 1,800 modest spans, each `('a😀 ').repeat(1000)`, failed before source
capture. the repeated text is 10,800,000 utf-8 bytes before markup, below the per-xhtml
16 mib decoded cap; normal word boundaries avoid the oversized atomic indexing
unit issue. `ingest_media_source` settled dead with `E_RESOURCE_LIMIT` for media
`01a184f2-6a49-7d5a-93b8-68f821dbaa61`, job
`01a184f2-b48e-7356-a60e-d30bcae4c153` at `2026-10-28T23:57:45.924839Z`.
private evidence: `nexus-highlight-excerpts-v1-capacity/.nexus-local/lab/20261028-165442-d8e549709020/containers.log:202`;
fixture: that checkout's ignored `highlight-excerpts-source-capacity.spec.ts`,
`unicode-stride` variant. the canonical lab completed teardown. this confirms
normal-ingestion refusal, not its exact allocation site or peak resident usage;
it is not a source-window helper failure or an admitted-source capacity proof.
