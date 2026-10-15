# reindex admission lacks a saved-evidence preservation decision

status: open
origin: 2026-10-15 book-repair clone qualification, selected52 index preparation
area: content index / chat citations / resource graph

normal reindex replaces an owner's span and chunk identities. at frozen source
`150328b65caf2a685fc9a0447560844981430772` (these owners are byte-identical to
normal runtime `0bd6619236ae911bb35741aa2017a4a44312cdf2`),
`python/nexus/services/content_indexing.py:143–175` clears media claims, nulls
`message_retrievals.evidence_span_id`, cleans graph edges and deletes the old
index. `media_intelligence_lifecycle.py:144–153` deletes the summary's claims;
its `ensure_media_unit_in_tx` can also reset the summary before queuing a rebuild.

`resource_graph/cleanup.py:48–112` removes uncited edges and their view states,
including affected link-note motifs, and bumps surviving user-link endpoints.
cited target edges retain their snapshots. `resource_graph/citations.py:161–209`
still renders those saved titles/excerpts, but `reader_targets.py:112–122` returns
no jump when the cited span is gone; `locator_resolver.py:228–246` returns
`E_NOT_FOUND`. snapshot survival therefore does not establish saved-target
reopen or graph preservation. durable passage anchors are a separate identity.

the selected64 reader metadata repair proof remains valid and unchanged. the
proposed selected52 index phase has not run; its actual affected-reference,
claim, summary and graph counts are UNKNOWN. this is an admission gap, not
evidence of current live damage. workers and provider calls remain held.

first census the exact selected owners and their old index dependencies in a
read-only clone snapshot. where dependencies exist, decide the required saved
reference behavior before admitting replacement; fix the responsible identity
or publication owner if preservation is required. do not waive chat/graph rows
through blanket verifier exclusions. keep the separate [old web heading
normalization prerequisite](old-web-publications-lack-index-heading-normalization.md)
and [oracle lazy-anchor refresh](oracle-anchor-chips-typographic-after-corpus-reindex.md)
issues distinct.

acceptance: the actual selected dependency set is accounted for; any required
saved citation, retrieval and graph target survives or resolves correctly after
normal reindex, while snapshot text and unrelated rows remain exact. any
deliberately unavailable target has an explicit accepted contract and scoped
evidence. qualify this with ordinary consumers, not only ready-index counts.
