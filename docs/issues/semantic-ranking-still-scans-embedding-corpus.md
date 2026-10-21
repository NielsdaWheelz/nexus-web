# large-corpus search retrieval remains slow

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

2026-10-19 resource-first search: paired reads on the same restored, migrated
848-media / 721,605-chunk corpus took 17.947/15.469s before and
15.575/13.134s after for `pillow`/`keats` resources. the new requests used one
real embedding each (2.188/0.294s); sql execute time including ssh round trips
was 13.113/12.763s. direct `pillow` preview took 0.313s without embedding.
this establishes no regression in those two sequential reads, not production
deadline margin or a new query-plan diagnosis. concurrency and the remaining
large-corpus retrieval cost remain open; no capacity or index change was made.

2026-10-21 source review: the initial full-embedding-scan diagnosis above is
historical, not a confirmed plan for the current implementation.
`search/discovery.py:298-306,333-368` performs neighbour retrieval, family
ranking, owner enrichment and presentation before returning content results.
`search/sources.py:504-544` uses indexed chunk text predicates but computes
query-dependent relevance and each owner's best occurrence before its outer
limit. the returned row cap does not bound the number of matching rows scored.
`discovery.py:184-211` repeats generated-family ranking for selected owners;
this preserves representative evidence and must not be removed blindly.

next evidence needed: per-statement time and current `EXPLAIN (ANALYZE, BUFFERS)`
for broad and scoped queries on the restored corpus, separating provider,
database, hydration, serialization and transport time. inspect actual index
use, rows scored, sorts, temporary work and repeated retrieval. no new timings
or plans were collected by this review. preserve owner diversity, lexical
coverage and activation identity when reducing work; an arbitrary early
occurrence cap changes the answer.
