# semantic ranking still scans the embedding corpus

status: open · origin: 2026-09-15 pr #270 diagnosis · area: search performance · oi-136

the improved document query allows lexical GIN filtering and indexed final
scoring, but its semantic branch still scans/sorts embeddings instead of using
the existing approximate vector index. the retained clone plan covered about708k
embeddings, took6.266s and wrote102148 temporary8-kib blocks (about798 mib).
private plan: `pillow-semantic-inline-analyze.json`; deterministic unit query
vector, not production latency. concurrent requests multiply this work.

owner: `search/sql.py::hybrid_content_chunk_tail_sql` and the content-chunk
retriever. qualify a bounded retrieval plan without silently changing visibility,
ranking, tie-breaking or candidate recall. prove actual query latency, disk
temporary work and combined host pressure before closing.
