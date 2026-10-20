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
still renders those saved titles/excerpts, but a cited span that is gone lands
nowhere: `resource_items/locations.py` `current_passages` (since the resource
references re-slice; it replaced `reader_targets.py`) has no current extent for it,
so routing gives it no href and its frozen target reads `location_unavailable`.
snapshot survival therefore does not establish saved-target reopen or graph
preservation. durable passage anchors are a separate identity.

the 2026-10-15 read-only selected52 clone census binds 1,549 old spans, chunks
and embeddings, 424 claims and 52 ready summary heads. cleanup would delete
100 persisted `origin=discovery` edges, all with saved snapshots and targets in
the old spans. 93 originate in selected media, six in other media and one in a
note block. these are visible generated connections, not index-only rows:
`connection_discovery.py:287–325` stores their rationale, and
`resource_graph/connections.py:243–267` exposes them. embedding replacement does
not recreate them. normal ready-index publication also changes the media-unit
fingerprint and resets the summary for a later build; leaving follow-on workers
unconsumed does not preserve this product state.

four selected-media retrievals have saved excerpts/locators but no old span
pointer. the bounded census finds no touching user edges, cited-target edges,
oracle pointers or orphan snapshot candidates. this narrows the actual risk;
it does not prove every saved target reopens. graph counts are union-only
candidate predicates, not a sequential worker effect proof. private evidence:
`a-maintenance/selected52-early-census-v1/root-execution/execution/output/census/receipt.json`
sha256 `9c7ab5bd21882b1d9c76e5ed419cc9bd9268d8ba911450bf837891c5eb3d4949`;
independent ownership review `selected52-early-census-independent-review.json`
sha256 `ed8604e52aa030bded06e3fe5ff2d506cc7a050cf2d7b845993abe41fec97a56`.

the 22 completed frozen-150 per-item metadata proofs remain valid. the selected64
schedule stopped at sequence 115, before book 23, after the unnecessary index
mutation was established; that interrupted run and its final global proof never passed.
the earlier census observed 14 repaired and 38 unrepaired article projections.
no index worker has run. this is an admission gap, not evidence of current live
damage. workers and provider calls remain held.

merged #609 compares complete index-block inputs and skips reindex when they
are equal. the later corrected 64-item rehearsal passed on its recorded
26b/0278 candidate: private `b-reader/selected64-preservation-v3/actual-v1/closure-review.json`,
sha256 `840624f65047c0bbc19c506f5f1884208bdf373708428b3309ef5ba016dc66f3`.
final-artifact preservation remains pending. these historical results do not
authorize an ordinary index replacement. for required
ordinary reindexing, decide the saved-reference and generated-product contract
before admitting replacement; fix the responsible identity or publication owner
where preservation is required. recheck exact final dependencies before any
worker admission. do not waive chat/graph rows
through blanket verifier exclusions. keep the separate [old web heading
normalization prerequisite](old-web-publications-lack-index-heading-normalization.md)
and [oracle lazy-anchor refresh](oracle-anchor-chips-typographic-after-corpus-reindex.md)
issues distinct.

acceptance: the actual selected dependency set is accounted for; any required
saved citation, retrieval and graph target survives or resolves correctly after
normal reindex, while snapshot text and unrelated rows remain exact. any
deliberately unavailable target has an explicit accepted contract and scoped
evidence. qualify this with ordinary consumers, not only ready-index counts.
