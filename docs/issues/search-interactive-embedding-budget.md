# interactive search inherits a background embedding budget

status: open; source-confirmed budget mismatch, disconnect behavior unmeasured.
origin: 2026-10-21 search latency review.

`python/nexus/services/search/discovery.py:282,331` waits for query embedding
before lexical retrieval. `services/embeddings.py:68-71,82-88` constructs the
default provider runtime and waits synchronously. the pinned `provider-runtime`
revision `a26f30f7a6f1a25c31b06537614e87cc518cdf49`
(`python/pyproject.toml:58`, `python/uv.lock:791-793`) configures a 45-second
transport timeout per embedding attempt (`provider_runtime/embeddings.py:58,138-143`)
and three attempts (`provider_runtime/retry.py:51-60`). its nominal 120-second
retry deadline is checked between attempts, not around the whole call
(`retry.py:104-118`). installed package provenance matches the pin.

impact: provider slowness can exceed the web proxy's 30-second header budget
(`apps/web/src/lib/api/proxy.ts:226`) before lexical fallback occurs. synchronous
search routes (`python/nexus/api/routes/search.py:48-67`) carry no request
cancellation or remaining budget into retrieval. continued obsolete work is a
source-supported risk; no disconnected-request/provider timing was measured.
the database's per-statement timeout also does not bound the whole search.

fix at the operation owners: separate lexical results from semantic enrichment;
give interactive embeddings and database work one remaining elapsed-time budget,
with cancellation reaching their actual clients. preserve the indexing worker's
separate retry contract. do not equate stopping a browser fetch with stopping a
synchronous worker. related: [browser retry budget](search-retries-lack-an-interaction-budget.md).
the existing [cancellation issue](api-sync-work-outlives-request-cancellation.md)
owns the cross-request/session lifecycle repair.

resolved when a delayed provider cannot delay lexical usability, the semantic
phase ends within its declared total budget, and a superseded/disconnected
search promptly releases provider and database work in an isolated runtime.
