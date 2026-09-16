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
the native evidence and complete sole check are recorded below and in the
release notes.

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

exact published d23063e4 repeats ordinary search, fragment reopening, selected
link targets, all23 pillow fragments and30 assets:92 GET responses200 plus
the target POST200; retained api peak290.176/320 mib, zero max/oom events.
requests took21.277s cold and17.122/27.682/30.701s concurrently. the final
request exceeds the30-second web deadline, so this issue remains open.
source-overlay evidence above is preparatory only; exact-image evidence is
`pillow-d23063e4-exact/`. production/manual deadline acceptance remains open.

production d23063e4 api logged response-header200 for `/search` at23:59:36 utc
in37.174s and30.954s, both beyond the web deadline. lexical openables requests
completed in0.248–2.543s. api header logs do not prove browser receipt/body
completion; user search outcome remains unconfirmed. evidence:
`api-d23063e4-first-manual.log`. this is now a production latency observation.
