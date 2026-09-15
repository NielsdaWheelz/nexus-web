# semantic document search times out on the restored corpus

status: open · origin: 2026-09-15 pr #270 allocation diagnosis · area: search · oi-134

exact695 api plus provider97fbac7 source overlay completes the query embedding
without oom, then `/search?q=pillow&kinds=documents` returns500: PostgreSQL
`QueryCanceled: canceling statement due to statement timeout` after30 seconds.
the retained db0229 clone has about705k content chunks and708k embeddings.
this is clone evidence; production search has not been measured after the
import fix. private receipt: `pillow-69583dc3-semantic-overlay-retry/`.

the owner is `search/retrievers/content_chunks.py`, using the shared hybrid
tail in `search/sql.py`. its multiply-read eligible-chunks CTE can materialize
the full visible corpus before filtering. obtain the actual plan and preserve
visibility, ordering, candidate bounds and result semantics when fixing it.
do not raise the deadline or disable semantic retrieval to hide the failure.

acceptance: ordinary semantic document search completes on the restored corpus
within its existing deadline, with matching access/ranking behavior and a
focused deterministic regression through the sole repository check.

follow-up diagnosis: allowing the chunk CTE to inline moves past the first
query, then fragment retrieval times out rebuilding its already stored search
vector. using that indexed column returns the cold search200 in36.3s, but
three overlapping requests oom-kill the320-mib api. fragment retrieval retains
up to200 whole chapter bodies and excerpts before cross-type pagination.
private receipt: `pillow-69583dc3-semantic-fragment-overlay/` (exit137, oom).

the prepared fix keeps only fragment identity, length/admission metadata,
source, query and score during ranking. original full locators and query
excerpts are read after selection for discovery and link-target results.
reopening keeps its original prefix snippet. permissions and readiness are
rechecked at projection, and post-limit locator admission remains unchanged.
latest source-overlay allocation and sole check are pending.

metadata-only fragment projection held three overlapping searches below276 mib
without oom. the next timeout belongs to `_search_evidence_spans`: its full-text
expression has no index. db0230 adds that exact GIN expression index with32-mib
maintenance workspace; original migration files and source text remain unchanged.
this is a new non-destructive migration, not another0215→0229 execution.

combined source-overlay + clone index probe passed: cold search18.359s; three
overlapping searches16.930/25.174/27.557s; all23 pillow fragments and30 asset
requests completed. api peak286.348/320 mib, zero oom/swap. this remains
preparatory evidence, not exact published-image or production acceptance;
latency is close to the30-second web deadline. the clone index build took
58.366s and added84975616 bytes. postgres touched its512-mib ceiling with2368
reclaim/limit events, zero oom/swap;32 mib was not a total-memory bound.
