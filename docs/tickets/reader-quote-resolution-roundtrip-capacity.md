# retained quote resolution needs maximum-source qualification

- status: open
- origin: 2026-09-13 bounded-workspace implementation review
- area: reader publication resolve/find; hosted and offline readers

the prior quote-only resolver required one HTTP continuation per nonempty unit.
`python/nexus/services/reader_publication_resolve.py` now uses retained SQL text
with at most 511 code points of following overlap and returns at most two scalar
locations. red `9ec1577a19203378`, green `ac329fb9bb5ffe66`; thousands of empty units,
overlapping ambiguity and cross-unit context are green `42851a7ae8996dfd`.
maximum-source query-plan/latency qualification remains open. the client's
30-second semantic operation budget is an experiment input, not a qualified limit.

qualify unique and ambiguous quote resolution across the maximum supported
source. if roundtrips exceed the accepted navigation envelope, use the retained
SQL text/offset projections to narrow candidates without assembling the document.
preserve exact canonical offsets, cross-unit matches and ambiguity.
do not restart deadlines per page, silently choose the first match, lower the
source envelope, or raise a deadline merely to make the proof pass.

acceptance: maximum-source cold resolutions complete within the measured shared
operation envelope; cancellation and admission rejection retain source/target
intent; each server step remains bounded under overlapping reads.
