# highlight admission scans unrelated readings

on `7776e45f6`, `python/nexus/services/search/sources.py:_HIGHLIGHT_OWNER`
applies canonical fragment-bound admission to unrelated reading candidates before
eliminating them. a completed native plan takes1972.731ms with2,448,748 buffer
hits and zero physical reads; highlight-anchor subplans execute179,244 and89,622
loops for3,429 eligible rows and two native results. private evidence is in
`search-release-integration/final-diagnostics/`. this establishes avoidable
candidate work, not the complete cause of publication-time search failure.

the affected actual bff operation returns keyword/active-related504 inside indexed
selection, before extra semantic retrieval or presentation. publication and durable
unrelated edits pass; the read gate remains open. a private same-source prefilter
candidate now has bounded mechanism and same-snapshot equality evidence; actual
bff read acceptance remains pending.

narrow candidates by source before canonical bounds, preserving direct source
admission and exact reading selection. justify this against supported writers:
fragment highlights store the fragment's source as anchor media, relocation
rejects another source, and fragments are not reparented. database constraints
alone do not establish that equality. retain canonical all-anchor bounds.

resolved when same-repeatable-read full eligibility comparison agrees in both
directions, including nulls and duplicates; the unrelated-reading cross-product
is removed; piece evidence and activation remain correct; and the affected actual
bff read operation completes under unchanged limits. no ranking, resource or
deadline change is implied.

one database-only read on the retained0317 clone compares all10 actual eligible
columns with bidirectional `except all` in one read-only repeatable-read snapshot:
old3,429/new3,429, zero differences in either direction, including nulls and
multiplicity. the candidate native plan takes165.603ms, with78 anchor checks,
28,505 shared hits and644 reads, no temp io. the earlier269k checks disappear;
these isolated observations establish no stable ratio or p95 latency claim.
private evidence: `search-release-integration/highlight-db-only/remote/`; sql
`b25fe6bb` and the complete old/new eligibility proof. the one-use database owner
closed normally, removed its three containers and copied credentials, and kept
the clone. no provider, browser or writer ran in this check.

the current source adds only the piece-source candidate predicate before the
existing canonical highlight bounds resolver. direct anchor admission, fragment
kind checks, exact-ref correlation and reading filters are unchanged. the actual
source builder reproduces the measured candidate sql byte-for-byte. retained
scope/piece/quote/activation checks and one actual corrected-v4 bff operation are
still required; the earlier publication, edit and restoration wins remain valid.
