# Oracle

Oracle has three runtime service owners and one operator boundary.

`python/nexus/services/oracle.py` owns readings: question validation, corpus and
personal retrieval, plate selection, LLM prompt/call/parse, persisted folios, and
SSE event emission.

`python/nexus/services/oracle_corpus.py` owns corpus support mutation, exact
DB/R2 inspection, the publication marker, and the readiness derivation that
gates reading generation.

`python/nexus/services/oracle_plates.py` owns plate assets: URL construction,
metadata lookup, ETag metadata, and byte-size-checked storage reads.

`python/nexus/oracle/manifest.py` parses the reviewed desired state.
`python/nexus/ops/oracle_reconcile.py` is the sole container-internal operator
boundary; the host state machine invokes its narrow phase commands.

## Corpus

The public-domain corpus is a **real Nexus library**, not an Oracle-owned
text/vector store. The library is identified by `libraries.system_key =
'oracle_corpus'` (never by name); its works are ordinary `media` rows ingested and
indexed through the shared media/content-index substrate, so corpus text lives in
`content_chunks`/`content_embeddings` and membership in `library_entries` like any
other media. Three small Oracle-owned table families sit above that substrate:

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
  against the mapped media. Resolution is source-local and exact-first: it
  matches normalized text-quote prefixes against active ready chunks, then uses a
  bounded token-window match for small source-edition spelling/punctuation
  variants. The fallback tolerates line-number/note tokens and small word-level
  insertions where the quote still matches the same passage in the same mapped
  media. Edition line breaks, quote/dash style, and minor public-domain spelling
  differences do not make otherwise identical passages unavailable, but a
  selector still fails closed if the mapped media is a version page,
  table-of-contents-only extraction, or the wrong book.
- `oracle_corpus_publications` contains either no row or the sole key `current`.
  Its manifest digest and embedding provider/model are the publication boundary,
  not a cache of support readiness. Code rejects every other key or malformed
  value.

Some Wikisource works use proofread-page HTML where the poem body and reference
sections share similar page wrappers. The shared web article extractor recognizes
the proofread-page body shape and extracts the `.prp-pages-output` body before
Readability can prefer notes. Corpus entries may pin a Wikisource revision URL as
`source_download_url` when deterministic re-ingest is required; the user-facing
`source_url` remains the canonical readable page.

Operator publication readiness proves the system library, exact manifest
works/metadata, shared media/index state, resolved anchors, plate metadata, and
R2 object size/type sets. Request-time `get_oracle_corpus_readiness` performs the
bounded DB support derivation and reports `ready` only when it is ready and the
sole publication marker exactly matches the baked manifest digest and active
embedding provider/model. It does not contact R2 on each request; the marker
records that the quiesced operator proof published successfully. Marker absence
or drift is not ready. Runtime code does not select among corpus releases,
persist provider request hashes, or store DB-only passage provenance objects.

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
fails typed `E_ORACLE_CORPUS_NOT_READY` when the exact publication is not ready.

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

Application release only records the expected manifest digest. Oracle publication
is the independent host operation
`deploy/hetzner/reconcile-oracle.sh <current-source-sha>`; runtime requests never
create, repair, or publish support.

The operator binds the current immutable release record, its captured config,
and the manifest baked into its worker image. With no active attempt it may no-op
only when exact DB/selector/R2 state and the current marker agree. Before mutation
it rejects removal of any active work, anchor, or plate key. It then durably
records its target, stops all app writers, unpublishes first, reconciles ordinary
library/media/index and plate support through their owners, runs only its exact
declared jobs, proves exact readiness, and inserts the marker last in one short
transaction. R2 objects precede DB metadata; no DB transaction spans HTTP, R2,
or job execution.

The operation is replayable by the same SHA and inputs. After unpublish, writers
normally remain stopped until replay succeeds. One allowed late crash prefix can
leave the exact publication committed and the captured runtime running before
`RuntimeRestored` is durable; replay re-stops those exact writer IDs, converges
and re-proves the same target, then restores the exact recorded runtime.
Physical garbage collection and destructive manifest removals are out of scope.

The manifest describes direct ingestable media sources, passage selectors, and
plate inputs, not corpus text or embeddings. Source URLs must contain the target
text itself. `GET /oracle/corpus` is a pure marker-gated status report and never
mutates on read.
