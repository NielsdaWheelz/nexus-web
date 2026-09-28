# epub apparatus detection repeatedly scans whole ancestor text

status: open
origin: 2026-09-26 exact-source profiling
area: html apparatus / epub extraction

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d` retains portrait
`9e5d8118-050d-48dc-9c99-870443481f61` as `E_ARCHIVE_UNSAFE`, with an old
58,836 ms / 30,000 ms parse-time failure. its original sha256 is
`6593c91398319d4b8582d1857fb8e8e6d0cd705e87c1838cf8364ef910a3bccb`.
current parser code matches deployed code. local exact-byte prepublication
replay still exceeds the 30-second limit, now correctly classified
`E_RESOURCE_LIMIT` / time.

profiling: 33.54 s total; `_target_context` 7,372 calls / 32.95 s cumulative;
`_element_text` rebuilds 1,611,400,478 normalized characters for a 1,405,248-character
book. `services/html_apparatus.py:542` rebuilds full ancestor prose merely to
inspect a short normalized prefix. source ordering and backlink lookup are
negligible. private receipts: `/tmp/nexus-processing-review-20260926/`.

fix repeated work in the apparatus owner while preserving exact classification,
unicode normalization and ordering. retain only necessary per-document results;
do not retain full ancestor text or relax archive/time/memory limits.

acceptance: identical apparatus and canonical output on representative actual
books; this exact source completes under the unchanged limits in the deployed
worker envelope, with measured memory margin and complete readable content.
local parsing is not production publication proof.

scratch-only comparison retained exact normalized 80-character prefixes for one
parsed tree at a time. duration fell from 33.67 s to 0.85 s, peak rss stayed
about 148 mb, and all ordered target records, apparatus html/items/edges,
sanitized chapter html and canonical text matched by sha256
`46f40b33c8adadbeab5e66cdb94177f1369f08ee319fd3eb732d82d4e867f00f`.
693 misses / 19,204 hits; at most 11 memo entries per tree. no application
implementation was changed. preserve exact normalization rather than introducing
a subtly different unicode prefix scanner.
