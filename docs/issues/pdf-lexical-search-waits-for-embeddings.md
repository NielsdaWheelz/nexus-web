# pdf lexical body search waits for embeddings

status: open; source-confirmed, provider-outage runtime check pending.
origin: 2026-10-21 search latency and coverage review.

`python/nexus/services/search/sources.py:185-202` excludes raw pdf fragments and
admits pdf body text through content chunks only when the owner's index state
is `ready`. `services/content_chunking.py:71-94` obtains embeddings before
yielding any chunk. `services/content_indexing.py:567-593` finishes that spool
before publishing chunks and their ready state; publication writes text and
embeddings together (`content_indexing.py:168-230`).

impact: a readable pdf with extracted text and pending or failed embedding work
can match metadata but cannot match its body through browser lexical search.
query-time lexical fallback alone cannot restore that missing index coverage.
this is an availability/freshness defect, not a demonstrated cause of slow
queries over already published indexes.

reproduce: import a text pdf whose distinctive body term is absent from metadata
while embeddings are unavailable, then search for that term. establish separate
lexical publication and semantic readiness for one source revision, retaining
atomic text/locator publication, stale-job fencing and current visibility.

resolved when the body term is discoverable without embeddings, semantic
completion augments the same source generation, and replacement/deletion cannot
resurrect stale text or attach an embedding to a different passage generation.
