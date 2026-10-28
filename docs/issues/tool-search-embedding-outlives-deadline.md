# tool search embedding outlives cancellation

status: open; source-confirmed ownership gap at `c0acf77c3`, delayed-provider
reproduction pending.

`python/nexus/services/tools/run.py:365-367` owns a tool's absolute deadline.
`tools/reads.py:336-340,389-390` passes it to strict retrieval, but
`services/search/service.py:138-144` starts the query embedding with
`asyncio.to_thread(embed_text, ...)` before consulting that deadline.
`services/embeddings.py:54-64` runs the provider's background retry policy in a
separate event loop. cancelling the awaiting tool does not cancel that thread's
provider request or retries. database admission is cancellable; this embedding
path is not. browser discovery already uses the native async adapter at
`search/discovery.py:118-120`.

impact: a stopped or timed-out agent search can continue provider work after its
tool receipt settles. repeated cancelled calls can retain obsolete work. this
review establishes no measured duration, cost or resource exhaustion.

fix: have strict async retrieval await `embed_texts_async` under its existing
tool deadline with an explicit interactive retry policy, preserving its declared
lexical-fallback semantics. retain the background indexing adapter's separate
policy; do not add a second timer or cancellation owner.

resolved when a deliberately delayed provider is cancelled by tool stop/deadline,
no later retry or database statement starts, and the tool receipt settles once;
ordinary successful retrieval and its expected provider-failure outcome still
work. verify in the isolated runtime, not production.
