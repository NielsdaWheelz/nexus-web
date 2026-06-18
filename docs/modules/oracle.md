# Oracle

Oracle has three service owners.

`python/nexus/services/oracle.py` owns readings: question validation, corpus and
personal retrieval, plate selection, LLM prompt/call/parse, persisted folios, and
SSE event emission.

`python/nexus/services/oracle_corpus.py` owns the corpus: idempotent seed
orchestration (library, media, source mappings, anchors) and the readiness
derivation that gates reading generation.

`python/nexus/services/oracle_plates.py` owns plate assets: URL construction,
metadata lookup, ETag metadata, and byte-size-checked storage reads.

## Corpus

The public-domain corpus is a **real Nexus library**, not an Oracle-owned
text/vector store. The library is identified by `libraries.system_key =
'oracle_corpus'` (never by name); its works are ordinary `media` rows ingested and
indexed through the shared media/content-index substrate, so corpus text lives in
`content_chunks`/`content_embeddings` and membership in `library_entries` like any
other media. Two small Oracle-owned tables sit above that substrate:

- `oracle_corpus_sources` maps each curated `(corpus_key, work_key)` to its
  authoritative `media_id` (provenance + display order; no text or vectors).
  When the manifest changes a work's ingest URL or media kind, seeding performs a
  hard cutover: it accepts the new source through shared source ingest, repoints
  the source row to the new `media_id`, and removes the previous media from the
  Oracle Corpus library.
- `oracle_passage_anchors` is stable curation/concordance identity: a deterministic
  `selector`, `tags`, `phase_hints`, and cache pointers (`current_evidence_span_id`
  / `current_content_chunk_id`) into the current index. The anchor `id` is the
  durable identity; the pointers are FK-free because evidence/chunk rows are
  regenerated on reindex, and `resolve_oracle_passage_anchors` re-points them
  against the mapped media.

Corpus **readiness** is derived state, not a stored flag:
`get_oracle_corpus_readiness` reports the library id, work/ready-media counts,
anchor/resolved-anchor counts, and plate count, with `status` `ready` only when
every required media is indexed (via `media.processing_status` +
`content_index_states`) and every anchor resolved. Runtime code does not select
among corpus releases, persist provider request hashes, or store DB-only passage
provenance objects.

## Retrieval

Oracle retrieval consumes the shared search substrate; it owns no embedding or
vector SQL. One active-model query embedding from
`services/search/embedding.build_query_embedding` feeds both lanes of
`search/content_chunk_candidates.retrieve_content_chunk_candidates`:

- **Public-domain candidates** are retrieved scoped to the Oracle Corpus library,
  then kept only where a resolved `oracle_passage_anchor` points at the retrieved
  chunk/span. They are boosted by anchor tag/phase/question-token overlap, deduped
  one-per-work, and cited as `oracle_passage_anchor:<id>`.
- **Personal candidates** are retrieved over the viewer's visible media/notes
  **excluding** the corpus library's media, and cited as `evidence_span` (or
  `content_chunk` when no span exists).

Plate selection is deterministic over `oracle_plates` tags vs. question tokens and
selected-candidate tags (no embeddings; tie-broken by `source_url`).

The generation worker calls `get_oracle_corpus_readiness` before generating and
fails typed `E_ORACLE_CORPUS_NOT_READY` when the corpus is not ready. It never
falls back to old tables, fixture files, or stale embeddings.

## Folios, Citation Edges, And Concordance

A reading persists one `oracle_reading_folios` row per phase (descent / ordeal /
ascent) carrying the generated content (attribution, marginalia, locator label).
Each folio references its citation `resource_edge` by `edge_id`: in the same
per-phase transaction `oracle.py` calls
`resource_graph.citations.record_citation` to mint an `origin='citation'` edge
whose source is the `oracle_reading:<id>` and whose target is the cited resource —
a stable `oracle_passage_anchor:<id>` for public-domain text or an
`evidence_span:`/`content_chunk:` for user media. The edge owns identity and the
display snapshot (excerpt, label) captured at generation time; the folio owns the
generated prose, not duplicated on the edge. Navigation is rebuilt by the current
resolver: opening an anchor citation routes through the anchor's current
evidence/media target (`oracle_anchor_current_target`), so the jump tracks reindex
while the cited identity stays fixed.

Concordance ("other readings that drew the same source") is
`resource_graph.citations.concordant_sources` scoped to `source_scheme='oracle_reading'`:
identity equality on the cited `(target_scheme, target_id)`, so two readings that
drew the same public-domain passage share one anchor target id by construction.

## Plate Contract

- Frontend URL: `/api/oracle/plates/[id]`.
- Backend URL: `/oracle/plates/{id}`.
- Frontend type contract: `OraclePlateImageSrc`.
- BFF helper: `proxyPublicToFastAPI`.
- Backend route auth: internal header only; no viewer bearer and no cookies.
- Storage key: `oracle/plates/<stable plate key>.<jpg|png|webp>`.
- DB owner: `oracle_plates` (public owned-asset metadata only; **no text
  embeddings** — plate selection is deterministic over tags/phase hints).

`oracle_plates.py` releases the DB session before reading object storage.
Matching `If-None-Match` requests return `304` from validated DB metadata
without touching storage. The ETag is route metadata, not a content hash.

## Operational Rule

Oracle seed objects and corpus readiness are deployment preconditions after schema
migrations. Runtime request handlers do not seed, repair, or fall back to fixture
files when an owned plate object is missing.

The corpus is seeded and verified by worker-image operator commands, not requests:
`scripts/ensure_oracle_seed_objects.py`, `scripts/oracle/seed_corpus_library.py`
(idempotent — ensures the system library, accepts/reuses each work's media through
the shared source-ingest path, hard-replaces changed manifest sources, attaches
entries via `library_entries`, repairs reused failed/stale media through the
source-ingest owner, upserts source mappings and anchors, and resolves anchors),
and `scripts/oracle/check_corpus_readiness.py` (exits non-zero unless the corpus is
ready). The manifest describes media ingestion (a direct ingestable source URL per
work) plus passage anchors, not raw passage text or embeddings.
`GET /oracle/corpus` exposes the same readiness as a read-only status report
(library ref/id, work/ready-media counts, anchor/resolved-anchor counts, plate
count); it never seeds or repairs on read.
