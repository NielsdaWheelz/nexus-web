# semantic ranking still scans the embedding corpus

status: open · origin: 2026-09-15 pr #270 diagnosis · area: search performance · oi-136

the improved document query allows lexical GIN filtering and indexed final
scoring, but its semantic branch still scans/sorts embeddings instead of using
the existing approximate vector index. the retained clone plan covered about708k
embeddings, took6.266s and wrote102148 temporary8-kib blocks (about798 mib).
private plan: `pillow-semantic-inline-analyze.json`; deterministic unit query
vector, not production latency. concurrent requests multiply this work.

owner: `search/semantic.py::nearest_chunks` and the `content_chunk` family in
`search/sources.py`. qualify a bounded retrieval plan without silently changing visibility,
ranking, tie-breaking or candidate recall. prove actual query latency, disk
temporary work and combined host pressure before closing.

2026-10-10 search reauthor (cleanup/search-reauthor): the nearest-neighbour query now
orders by a bound constant (`ORDER BY embedding_vector <=> CAST(:embedding AS vector)`)
after `SET LOCAL ivfflat.probes = 10`. on a seeded 200k-embedding corpus (pg15, pgvector
0.8.6) the all-scope query is an `ix_content_embeddings_vector_ann` index scan in 5.6 ms
and a one-media scope filters first in 0.4 ms; the chunk family's ranking statement for
a term matching 17% of chunks took 122.6 ms, because every visible lexical match is
scored before the top k is taken. evidence: campaign `search/explain.txt`. not yet
measured on the restored ~700k corpus or production.

exact d23063e4 published-image diagnostic on the native devbox returned all
four semantic requests200:21.277s cold, then17.122/27.682/30.701s concurrently.
the last exceeds the web30-second deadline; the diagnostic client allowed60s.
this is an observed latency failure against the web budget, despite no sql
timeout or api oom. retain this distinction in release acceptance. evidence:
`pillow-d23063e4-exact/summary.json`; private verifier/snapshotted catalog,
real embeddings/R2, retained db0230 clone, no browser or production timing.
