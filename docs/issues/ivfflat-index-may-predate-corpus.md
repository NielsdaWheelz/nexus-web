# the ivfflat index may predate the corpus it serves

status: open · origin: 2026-10-10 search reauthor (cleanup/search-reauthor, design §12) · area: search performance

`ix_content_embeddings_vector_ann` (ivfflat, lists=100) was created by the baseline
migration (`0236_baseline_schema.sql:4999`). an ivfflat index trained on a near-empty
table keeps the centroids it computed then; once the data arrives, rows crowd a few lists
and recall at `ivfflat.probes = 10` collapses. whether production's index was built
before or after its corpus restore is unknown. search now lets the index drive broad
semantic scopes (`search/semantic.py::nearest_chunks`), so poor lists would silently
drop semantic recall rather than slow the query down.

evidence: on a seeded 200k corpus with the index built after the data, the all-scope
ANN returned 200 of the exact top 200 (campaign `search/explain.txt`); production is
unmeasured.

fix: sample ~50 production query vectors, compare `nearest_chunks` against an exact scan
(`SET LOCAL enable_indexscan = off`); if recall is poor, `REINDEX INDEX CONCURRENTLY
ix_content_embeddings_vector_ann` (and consider `lists ≈ rows / 1000`).

acceptance: measured recall@200 ≥ 0.9 on the production corpus, recorded here before
closing.
