# Evidence Layer Hard Cutover

## Role

This document is the target-state plan for replacing format-specific document
retrieval paths with one evidence indexing layer for all text-bearing media:
web articles, EPUBs, PDFs, and transcripts.

The implementation is a hard cutover. The final state keeps no feature flag,
no legacy result type for text retrieval, no compatibility shim, no PDF-only
search path over `media.plain_text`, no transcript-only semantic path, no
fragment-only semantic path, no fallback that bypasses evidence selectors, and
no backward-compatible citation renderer for old retrieval references.

The cutover separates durable evidence from retrieval artifacts:

```text
SourceSnapshot
  -> ContentBlock
      -> ContentChunk + ContentChunkPart
          -> ContentEmbedding
      -> EvidenceSpan
          -> LocatorResolver
```

`ContentChunk` is a retrieval unit. It is not the durable citation contract.
`EvidenceSpan` and its selectors are the durable citation contract.

## Goals

- One backend-owned evidence model for web articles, EPUBs, PDFs, and
  transcripts.
- One indexing service that rebuilds source snapshots, content blocks,
  evidence spans, chunks, chunk parts, and embeddings for a media item.
- One text retrieval result type for document evidence: `content_chunk`.
- Citations that resolve to exact `evidence_span` rows, never model-authored
  citation strings.
- Reader deep links, answer highlights, chat citations, search results, and
  vault exports all resolve through the same locator resolver.
- PDF text retrieval parity with web articles, EPUBs, and transcripts.
- Deterministic, idempotent indexing with parser version, chunker version,
  extractor version, embedding model, and source content hash recorded.
- Hard failure visibility when reading is ready but retrieval is not ready.
- Deletion and reingest semantics that deactivate stale index versions,
  preserve cited evidence, and rebuild a complete active index.
- Tests that treat missing evidence, stale chunks, bad locators, and wrong
  citations as correctness failures.

## Non-Goals

- Do not add a second search service, external vector database, or external
  document warehouse.
- Do not preserve `fragment` or `transcript_chunk` as text evidence search
  result types.
- Do not keep the existing whole-fragment EPUB chunking path.
- Do not add a PDF fallback that searches `media.plain_text` directly.
- Do not make PDFs pretend to be EPUBs. PDFs have their own locator shape.
- Do not rely on the model to author citation ids, quote strings, page
  numbers, section labels, or URLs.
- Do not introduce visual chart/image retrieval in this cutover. PDF visual
  retrieval can be added after text, layout, selectors, and citations are
  correct.
- Do not implement collaborative annotation interoperability beyond preserving
  selector shapes that can support it later.
- Do not preserve old message retrieval rows or old search URLs through a
  compatibility renderer. Old rows may be destructively migrated where exact
  evidence can be reconstructed; otherwise they are not rendered as citations.
- Do not split rollout by user, media kind, or feature flag.

## Final State

Every text-bearing media item has one active evidence index version. A media
item is searchable by text retrieval only when that active version is complete.

Web articles, EPUBs, PDFs, and transcripts all produce:

1. One or more `source_snapshots`.
2. Ordered `content_blocks` derived from source snapshots.
3. Stable `evidence_spans` over content blocks.
4. Ordered `content_chunks` assembled from content block ranges.
5. `content_chunk_parts` that map each chunk back to exact block ranges.
6. `content_embeddings` for the active embedding model.
7. Resolver metadata that can open the source in the reader and project an
   answer highlight.

Search, scoped chat, citations, and exports consume those artifacts. They do
not read raw fragments, transcript chunks, or PDF plain text as retrieval
sources.

## Target Behavior

### Ingest and reingest

- Ingest stores a source snapshot before indexing derived evidence.
- The format-specific extractor emits structured `IndexableBlock` records.
- The shared indexing service validates block ordering, offsets, selectors,
  hashes, and media ownership before writing rows.
- Reingest writes a complete replacement index as a new index run, then
  atomically moves the media's active index pointer to that run.
- Reingest deactivates old index runs. It does not hard-delete evidence rows
  that are referenced by persisted citations, saved annotations, message
  retrievals, exports, or audit records.
- Retention cleanup may delete unreferenced inactive derived rows only after
  reference checks and the configured retention window pass.
- A media item with extractable text is not retrieval-ready until blocks,
  chunks, chunk parts, spans, and embeddings exist.
- A media item without extractable text is marked with a terminal
  `media_content_index_states.status` such as `no_text` or `ocr_required`; it
  is not silently skipped.

### Search

- Text evidence search returns `content_chunk` results.
- Keyword, vector, and hybrid search all rank the same `content_chunks`.
- Scope and permission filters apply before ranking.
- Reranking operates over retrieved chunk candidates and preserves chunk ids.
- Each search result includes at least one backend-selected `evidence_span`
  for snippet, citation, and deep link resolution.
- Search result links are produced by the locator resolver.
- `fragment` and `transcript_chunk` are not accepted search filters or result
  types.

### Scoped chat

- Scoped chat retrieves `content_chunk` candidates only from indexed media in
  the scope.
- Prompt context contains chunk text plus backend-selected evidence spans.
- Assistant citations render from persisted retrieval rows and evidence spans.
- If scoped retrieval returns no indexed evidence, the response states that
  the scoped source has no indexed evidence; it does not fall back to unscoped
  chat or raw document stuffing.
- Model output is not trusted for citation locations.

### Reader navigation and answer highlight

- Search rows, chat citations, and export anchors call the locator resolver.
- The resolver returns the route, query params, label, selector payload, and
  optional projected highlight.
- Saved highlights and annotations remain durable user-authored product data.
  The resolver can resolve both `evidence_span` ids and saved highlight
  anchors, but evidence spans do not replace the saved-highlight storage
  model.
- Web and EPUB answer highlights resolve to fragment-local canonical text
  offsets.
- PDF answer highlights resolve to page number plus text selector and, when
  available, page-space geometry.
- A temporary answer highlight is distinct from a saved user highlight. It
  becomes durable only if the user saves it.

### Saved highlights and annotations

- Saved highlights and annotations are product data, not disposable retrieval
  artifacts.
- Existing web/EPUB fragment-offset highlights and PDF geometry highlights are
  migrated only where a lossless selector can be created. Otherwise they
  remain saved highlight anchors and are resolved by the locator resolver.
- Annotation search remains an annotation search surface. It may include
  resolver output for the attached saved highlight or evidence span, but it is
  not exposed as generic text evidence retrieval.
- Creating an annotation from an answer citation stores a saved highlight or
  annotation anchor derived from the resolved `evidence_span`.

### Exports

- Full-text exports are generated from ordered `content_blocks`.
- Highlight and citation exports use `evidence_spans` and selectors.
- PDF exports preserve page labels and page-local selectors.
- EPUB exports preserve section/href/anchor context.
- Web exports preserve URL/source snapshot identity and text selectors.
- Export code does not branch into raw `media.plain_text` or whole-fragment
  traversal for evidence citations.

### Deletion

- Media deletion deletes source snapshots, blocks, spans, chunks, chunk parts,
  embeddings, and index runs before deleting the media record.
- Retry/reingest deactivates stale evidence artifacts for the media item before
  activating the replacement index. It does not delete evidence referenced by
  durable citations or saved annotations.
- Library removal does not delete media evidence while the media item still
  exists. Permission and scope filters prevent the removed library membership
  from retrieving that media's evidence.
- There is no orphaned evidence row that can be retrieved after media deletion,
  and no evidence row retrievable through a library scope after that media is
  removed from the library.

## Architecture

### Data model

The hard cutover introduces or replaces these logical tables.

#### `source_snapshots`

The immutable source representation used for one indexing run.

Required fields:

- `id`
- `media_id`
- `index_run_id`
- `source_kind`: `web_article`, `epub`, `pdf`, `transcript`
- `artifact_kind`: `html`, `xhtml`, `pdf`, `pdf_text`, `ocr_text`,
  `transcript_json`, `plain_text`
- `artifact_ref`: storage path, object key, or inline artifact reference
- `content_type`
- `byte_length`
- `source_fingerprint`
- `source_version`
- `extractor_version`
- `content_sha256`
- `parent_snapshot_id`
- `language`
- `metadata` as typed `jsonb`
- `created_at`

Rules:

- A source snapshot must be reconstructible from `artifact_ref`,
  `content_type`, `byte_length`, and `content_sha256`.
- Derived artifacts, such as extracted PDF text or OCR text, point to their
  source artifact with `parent_snapshot_id`.
- `source_fingerprint` is the durable source identity used by selectors and
  exported citations. For PDFs it is derived from the original PDF bytes, not
  from extracted text or OCR output.
- Hashes verify identity. They are not the storage location.

#### `content_blocks`

Format-aware source structure. Blocks are the durable unit from which chunks
and spans are derived.

Required fields:

- `id`
- `media_id`
- `index_run_id`
- `source_snapshot_id`
- `block_idx`
- `block_kind`: `heading`, `paragraph`, `list_item`, `table_cell`,
  `table_caption`, `figure_caption`, `pdf_text_block`, `transcript_segment`
- `canonical_text`
- `text_sha256`
- `extraction_confidence`
- `source_start_offset`
- `source_end_offset`
- `parent_block_id`
- `heading_path`
- `locator` as typed `jsonb`
- `selector` as typed `jsonb`
- `created_at`

Offset rules:

- `source_start_offset` and `source_end_offset` are Unicode codepoint offsets
  in the source snapshot coordinate space.
- Source offsets are half-open: `[source_start_offset, source_end_offset)`.
- `canonical_text` length must equal
  `source_end_offset - source_start_offset` when the block represents a
  contiguous source text range.
- Page-local, fragment-local, transcript-time, text-quote, and geometry
  coordinates live in typed `locator` and `selector` JSON, not in generic block
  columns.
- `extraction_confidence` is nullable for deterministic digital text and
  required for OCR-derived blocks. OCR confidence is stored at block granularity
  and may also be summarized in source snapshot metadata.
- Blocks must be ordered and non-overlapping within their source representation
  unless `block_kind` explicitly represents derived structure such as table
  captions.

#### `evidence_spans`

Durable citeable spans over content blocks.

Required fields:

- `id`
- `media_id`
- `index_run_id`
- `source_snapshot_id`
- `start_block_id`
- `end_block_id`
- `start_block_offset`
- `end_block_offset`
- `span_text`
- `span_sha256`
- `selector` as typed `jsonb`
- `citation_label`
- `resolver_kind`: `web`, `epub`, `pdf`, `transcript`
- `created_at`

Rules:

- A citation points to an `evidence_span`, not to a model-authored location.
- `start_block_offset` and `end_block_offset` are block-local Unicode
  codepoint offsets in the referenced start and end blocks.
- `span_text` must be reconstructible from the referenced blocks.
- Evidence spans may be generated at indexing time for block-level citations
  and at answer time for exact claim support inside retrieved chunks.
- Answer-time spans must still be persisted before they are rendered.

#### `content_chunks`

Retrieval grouping over block ranges.

Required fields:

- `id`
- `media_id`
- `index_run_id`
- `source_snapshot_id`
- `chunk_idx`
- `chunk_text`
- `chunk_sha256`
- `chunker_version`
- `token_count`
- `heading_path`
- `summary_locator` as typed `jsonb`
- `created_at`

Rules:

- Chunks are deterministic for the same source snapshot and chunker version.
- Chunks are allowed to change across chunker versions.
- Chunks are not durable citation references.
- Chunks do not store model-specific embedding columns.

#### `content_chunk_parts`

Exact mapping from retrieval chunks back to content blocks.

Required fields:

- `chunk_id`
- `part_idx`
- `block_id`
- `block_start_offset`
- `block_end_offset`
- `chunk_start_offset`
- `chunk_end_offset`
- `separator_before`

Rules:

- Parts are ordered.
- `separator_before` is an explicit string, often empty, inserted before this
  part's block slice during reconstruction.
- Parts reconstruct `chunk_text` exactly by concatenating
  `separator_before + block_slice` in `part_idx` order and validating the
  resulting chunk offsets.
- A chunk can span blocks and, for PDFs, can span page boundaries only when
  every part retains page-local locator metadata.

#### `content_embeddings`

Model-specific vector index rows.

Required fields:

- `id`
- `chunk_id`
- `embedding_provider`
- `embedding_model`
- `embedding_version`
- `embedding_config_hash`
- `embedding_dimensions`
- `embedding_vector`
- `embedding_sha256`
- `created_at`

Rules:

- Embeddings are disposable and rebuildable.
- Multiple embedding models may exist only when one active model is clearly
  selected by retrieval configuration.
- Retrieval code filters on the active embedding provider, model, version, and
  config hash explicitly.

#### `media_content_index_states`

The active index pointer for one media item.

Required fields:

- `media_id`
- `active_run_id`
- `latest_run_id`
- `status`: `pending`, `indexing`, `ready`, `no_text`, `ocr_required`,
  `failed`
- `status_reason`
- `active_embedding_provider`
- `active_embedding_model`
- `active_embedding_version`
- `active_embedding_config_hash`
- `updated_at`

Rules:

- Search joins `media_content_index_states` and only retrieves chunks from the
  active ready run.
- Readiness is never inferred from the latest `content_index_runs` row.
- `latest_run_id` tracks the newest attempted run for status reporting.
- `active_run_id` may be null before the first ready index. It changes only
  after the replacement run has passed indexing, embedding, and validation.
- Failed or terminal no-text states are explicit and user-visible.

#### `content_index_runs`

Index lifecycle state.

Required fields:

- `id`
- `media_id`
- `state`: `pending`, `extracting`, `indexing`, `embedding`, `ready`,
  `no_text`, `ocr_required`, `failed`
- `source_version`
- `extractor_version`
- `chunker_version`
- `embedding_provider`
- `embedding_model`
- `embedding_version`
- `embedding_config_hash`
- `started_at`
- `finished_at`
- `failure_code`
- `failure_message`
- `activated_at`
- `deactivated_at`
- `superseded_by_run_id`

Rules:

- `ready_for_reading` and `media_content_index_states.status` are separate.
- User-visible retrieval state reads from `media_content_index_states`.
- Failed indexing is visible and retryable.
- Inactive runs may remain resolvable for durable citations.

### Services

#### `python/nexus/services/content_indexing.py`

The single public service for rebuilding an evidence index.

Primary APIs:

- `rebuild_media_content_index(db, media_id, source_snapshot, blocks, reason)`
- `delete_media_content_index(db, media_id)`
- `deactivate_media_content_index(db, media_id, superseded_by_run_id)`
- `mark_content_index_failed(db, media_id, failure_code, failure_message)`

Rules:

- The service owns all writes to source snapshots, blocks, chunks, chunk
  parts, spans, embeddings, index runs, and active index state.
- Format-specific ingest code may build `IndexableBlock` records but may not
  insert evidence rows directly.
- The service validates ownership, ordering, offsets, text hashes, and locator
  shape before inserts.
- The service atomically moves `media_content_index_states.active_run_id` only
  after the replacement index is complete.

#### `python/nexus/services/content_blocks.py`

Shared block normalization and validation.

Responsibilities:

- Normalize block text.
- Validate offset coverage.
- Build heading paths.
- Convert existing fragment blocks and transcript segments into
  `IndexableBlock`.
- Provide shared chunker input types.

#### `python/nexus/services/evidence_spans.py`

Evidence span creation and verification.

Responsibilities:

- Build default block-level spans.
- Create answer-time spans from selected chunk ranges.
- Verify that `span_text` is reconstructible from blocks.
- Reject citations that cannot be resolved exactly.

#### `python/nexus/services/content_embeddings.py`

Embedding construction and vector serialization.

Responsibilities:

- Build embeddings for chunks.
- Store embeddings in `content_embeddings`.
- Expose active embedding model metadata.
- Hide vector serialization from ingestion, search, and chat code.

#### `python/nexus/services/locator_resolver.py`

Backend-owned locator resolution.

Responsibilities:

- Resolve `evidence_span_id` and `content_chunk_id` into reader links.
- Resolve saved highlight anchors into reader links.
- Produce citation labels.
- Produce answer-highlight selector payloads.
- Dispatch to media-kind-specific resolver modules.

Media-specific resolver modules:

- `python/nexus/services/web_locator_resolver.py`
- `python/nexus/services/epub_locator_resolver.py`
- `python/nexus/services/pdf_locator_resolver.py`
- `python/nexus/services/transcript_locator_resolver.py`

### Locator shapes

Locator JSON must be typed. Each locator has `kind`, `version`, and
media-kind-specific fields.

Web text locator:

```json
{
  "kind": "web_text",
  "version": 1,
  "fragment_id": "...",
  "fragment_idx": 0,
  "start_offset": 120,
  "end_offset": 260,
  "text_quote": {
    "exact": "quoted text",
    "prefix": "before",
    "suffix": "after"
  }
}
```

EPUB text locator:

```json
{
  "kind": "epub_text",
  "version": 1,
  "section_id": "...",
  "fragment_id": "...",
  "href_path": "chapter-01.xhtml",
  "anchor_id": "p12",
  "start_offset": 120,
  "end_offset": 260,
  "text_quote": {
    "exact": "quoted text",
    "prefix": "before",
    "suffix": "after"
  }
}
```

PDF text locator:

```json
{
  "kind": "pdf_text",
  "version": 1,
  "source_snapshot_id": "...",
  "source_fingerprint": "sha256:...",
  "page_number": 12,
  "page_label": "10",
  "plain_text_start_offset": 2048,
  "plain_text_end_offset": 2190,
  "page_text_start_offset": 144,
  "page_text_end_offset": 286,
  "text_quote": {
    "exact": "quoted text",
    "prefix": "before",
    "suffix": "after"
  },
  "geometry": {
    "version": 1,
    "coordinate_space": "pdf_points",
    "page_width": 612.0,
    "page_height": 792.0,
    "page_rotation_degrees": 0,
    "page_box": "crop",
    "quads": []
  },
  "extraction": {
    "method": "digital_text",
    "ocr_engine": null,
    "ocr_engine_version": null,
    "ocr_confidence": null
  }
}
```

PDF locator rules:

- `page_number` is the physical 1-based page index used by the PDF reader.
- `page_label` is the logical PDF page label when available. Citations and
  exports prefer labels for display but keep physical page numbers for
  navigation.
- `source_fingerprint` identifies the original PDF file. It must remain stable
  across extracted text and OCR snapshot rebuilds.
- Geometry uses PDF points in the selected page box after applying page
  rotation. The coordinate schema must include page width, height, rotation,
  and box kind so frontend projection is deterministic.
- Text quote selectors remain the citation truth. Geometry is a projection aid
  and may be absent or stale.
- OCR-derived locators include OCR engine, engine version when available, and
  confidence in `extraction` or block metadata.
- Cross-page evidence is represented as either one evidence span with multiple
  PDF block parts or multiple page-local spans, but resolver output must expose
  every page range and must not collapse cross-page citations to a single page.

Transcript locator:

```json
{
  "kind": "transcript_time_text",
  "version": 1,
  "transcript_version_id": "...",
  "t_start_ms": 12000,
  "t_end_ms": 21000,
  "text_quote": {
    "exact": "quoted text",
    "prefix": "before",
    "suffix": "after"
  }
}
```

## Rules

### Evidence rules

- Durable citations point to `evidence_spans`.
- Search results may point to `content_chunks`, but every selected result
  must include evidence span ids.
- The model never receives permission to invent citation labels or URLs.
- The backend rejects a citation span if its text cannot be reconstructed
  from blocks.
- Locators must be generated by services, not assembled in route handlers or
  frontend components.

### Indexing rules

- One service owns evidence writes.
- Format-specific ingestion emits blocks and source snapshots only.
- Blocks must be format-aware, not raw fixed-size text slices.
- Chunking is deterministic and versioned.
- Chunk overlap is allowed, but overlap must be visible in chunk parts.
- Embeddings are model-specific derived rows.
- Reindex deactivates stale derived rows for that media item before activating
  a replacement index. It deletes inactive rows only when those rows are
  unreferenced and retention policy allows deletion. Otherwise it deactivates
  the old run and preserves resolvability.
- Content index state is explicit and user-visible.

### Retrieval rules

- Retrieval filters by viewer permissions and scope before ranking.
- Retrieval joins `media_content_index_states` and uses only the active ready
  run for new search results.
- Retrieval uses `content_chunks` for keyword, vector, and hybrid search.
- Reranking never drops chunk ids or evidence span ids.
- Prompt assembly renders exact chunk text and selected evidence spans.
- No retrieval code reads `fragments.canonical_text`,
  `media.plain_text`, or transcript segment tables directly as the retrieval
  corpus.

### PDF rules

- PDF extraction produces page-aware blocks.
- Digital text extraction is the first path.
- OCR is represented as a source snapshot with its own extractor version when
  needed.
- OCR support is explicit: if OCR is not available in the deployed runtime, a
  scanned PDF is terminal `ocr_required`; if OCR runs, OCR engine, engine
  version, and confidence are recorded on snapshots and blocks.
- PDF extraction records both physical page numbers and logical page labels
  when labels are available.
- PDF locators include source fingerprint, page number, optional page label,
  global text offsets, page-local text offsets, text quote selector, extraction
  method, and optional geometry.
- Geometry quads are used for projection when available, but text selectors
  remain the citation truth.
- Geometry coordinates declare page width, page height, rotation, page box, and
  coordinate units. Frontend code must not guess PDF coordinate transforms from
  raw quads alone.
- PDF block extraction preserves reading order, page membership, and layout
  grouping. Tables use table-aware blocks when extraction can identify row,
  column, caption, and header context; otherwise table text degrades to ordered
  `pdf_text_block` rows with explicit low-confidence metadata.
- PDF evidence spans validate text quote selectors against the current source
  snapshot before rendering. If exact quote/prefix/suffix no longer match, the
  resolver returns a degraded unresolved state instead of projecting a
  misleading highlight.
- Cross-page chunks are allowed only through ordered chunk parts. Cross-page
  citations either render as multiple page-local highlights or an explicit
  multi-page citation; they never silently point to only the first page.
- A scanned PDF with no OCR result has explicit `no_text` or `ocr_required`
  index state, never an empty successful index.

### Frontend rules

- Frontend search and citation code accepts `content_chunk` for text evidence.
- Frontend code does not reconstruct citation labels from locators.
- Reader navigation consumes resolver output.
- Temporary answer highlights are visually distinct from saved highlights.
- BFF routes remain proxy-only and do not contain evidence logic.

### Hard-cutover rules

- Delete old text retrieval code rather than leaving it unused.
- Delete old result types from schemas, TypeScript unions, tests, and route
  validation.
- Delete transcript-only and fragment-only semantic search branches.
- Delete direct EPUB chunk insertion from EPUB ingest.
- Delete any PDF retrieval branch over `media.plain_text`.
- Do not add fallback code for partially indexed media.

## Key Decisions

- `content_chunks` is the retrieval plane, not the citation contract.
- `evidence_spans` is the citation contract.
- `content_blocks` is the durable format-aware source structure.
- `content_chunk_parts` is required because chunks can span blocks.
- `content_embeddings` is separate from chunks because embeddings are
  model-specific and rebuildable.
- `media_content_index_states` is the active index pointer. Runtime search
  never infers active readiness from latest run ordering.
- Search exposes one text evidence result type: `content_chunk`.
- Resolver output, not frontend string assembly, owns reader links and
  citation labels.
- PDF has a first-class locator shape. It is not modeled as fake EPUB or fake
  web article content.
- Reading readiness and retrieval readiness are separate states.
- This is a destructive cutover for pre-evidence legacy retrieval behavior.
  New evidence-layer citations are durable and remain resolvable across
  reingest through inactive index versions.
- `fragments` may remain reader/render units for web and EPUB. They are not
  text evidence search result types.

## Workstream Split

Two Codex agents will work in the same branch. Ownership must stay disjoint.
If a contract change is needed across both paths, update this spec first and
then let the contract owner make the code change.

### Path A: Core Evidence and Non-PDF Cutover

Owner: this Codex.

Purpose:

- Build the shared evidence substrate.
- Convert web articles, EPUBs, and transcripts onto it.
- Cut search, scoped chat, retrieval persistence, and vault export over to
  `content_chunk` plus `evidence_span`.

Path A owns these files and new sibling modules:

- `migrations/alembic/versions/*evidence_layer*.py`
- `python/nexus/db/models.py`
- `python/nexus/schemas/search.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/schemas/vault.py`
- `python/nexus/services/content_indexing.py`
- `python/nexus/services/content_blocks.py`
- `python/nexus/services/evidence_spans.py`
- `python/nexus/services/content_embeddings.py`
- `python/nexus/services/locator_resolver.py`
- `python/nexus/services/web_locator_resolver.py`
- `python/nexus/services/epub_locator_resolver.py`
- `python/nexus/services/transcript_locator_resolver.py`
- `python/nexus/services/semantic_chunks.py`
- `python/nexus/services/fragment_blocks.py`
- `python/nexus/services/search.py`
- `python/nexus/services/retrieval_planner.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/context_lookup.py`
- `python/nexus/services/context_rendering.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/vault.py`
- `python/nexus/services/media_deletion.py`
- `python/nexus/services/media.py`
- `python/nexus/services/epub_ingest.py`
- `python/nexus/tasks/ingest_epub.py`
- `python/nexus/tasks/podcast_reindex_semantic.py`
- backend tests for the above services.

Path A must not edit:

- `python/nexus/services/pdf_*.py`, except only where a shared type import is
  absolutely required and agreed with Path B.
- `python/nexus/tasks/ingest_pdf.py`.
- `apps/web/src/**`, except generated API type updates if the repo has a
  single generated source of truth.

Path A deliverables:

1. Migration replaces the current `content_chunks` shape with source
   snapshots, content blocks, evidence spans, chunk parts, and embeddings.
2. ORM models represent all evidence tables and constraints.
3. Shared indexing service accepts typed `IndexableBlock` input and owns all
   evidence writes.
4. Web article ingestion calls the shared indexing service for URL, capture,
   and provider-specific article paths.
5. EPUB ingestion emits blocks and no longer inserts chunks directly.
6. Transcript indexing emits blocks and chunks through the shared service.
7. Search returns `content_chunk` for text evidence and removes `fragment`
   and `transcript_chunk` text retrieval paths.
8. App search persists chunk and evidence span refs.
9. Chat prompt rendering uses chunk text and evidence spans.
10. Vault export reads blocks and evidence spans.
11. Deletion removes media-owned evidence artifacts, while reingest
    deactivates old index versions and preserves cited evidence.
12. Backend tests cover web, EPUB, transcript, search, chat citation, export,
    deletion, and failed-index states.

### Path B: PDF Evidence and Frontend Cutover

Owner: the other Codex.

Purpose:

- Make PDF extraction produce first-class evidence blocks and locators.
- Make the reader, search UI, citation UI, and answer-highlight behavior
  consume resolver output and `content_chunk` results.

Path B owns these files and new sibling modules:

- `python/nexus/services/pdf_ingest.py`
- `python/nexus/tasks/ingest_pdf.py`
- `python/nexus/services/pdf_lifecycle.py`
- `python/nexus/services/pdf_readiness.py`
- `python/nexus/services/pdf_highlights.py`
- `python/nexus/services/pdf_quote_match.py`
- `python/nexus/services/pdf_quote_match_policy.py`
- `python/nexus/services/pdf_highlight_geometry.py`
- `python/nexus/services/pdf_locator_resolver.py`
- `python/nexus/services/pdf_content_blocks.py`
- `apps/web/src/lib/search/resultRowAdapter.ts`
- `apps/web/src/lib/search/resultRowAdapter.test.ts`
- `apps/web/src/lib/api/sse.ts`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/conversations/display.ts`
- `apps/web/src/lib/conversations/attachedContext.ts`
- `apps/web/src/components/search/SearchResultRow.tsx`
- `apps/web/src/components/chat/**`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/pdfReaderRuntime.ts`
- `apps/web/src/lib/highlights/pdfTypes.ts`
- `apps/web/src/lib/highlights/coordinateTransforms.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHighlights.ts`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx`
- `apps/web/src/app/api/search/route.ts`
- `apps/web/src/app/api/media/[id]/**`
- frontend and PDF-service tests for the above files.

Path B must not edit:

- Evidence schema migrations.
- `python/nexus/db/models.py`.
- `python/nexus/services/search.py`.
- `python/nexus/services/agent_tools/app_search.py`.
- Non-PDF ingestion files.

Path B deliverables:

1. PDF extraction emits page-aware `IndexableBlock` records.
2. `ingest_pdf` calls the shared indexing service after text/layout
   extraction.
3. PDF index status distinguishes digital text success, OCR success,
   OCR-required/no-text, and extraction failure.
4. PDF locators include source fingerprint, physical page number, optional page
   label, global text offsets, page-local text offsets, quote selector,
   extraction confidence, and optional typed geometry.
5. PDF resolver opens the reader to the right page and projects answer
   highlights when geometry is available.
6. PDF block extraction preserves reading order, table/layout context when
   available, OCR confidence, and deterministic page membership.
7. Cross-page PDF chunks and evidence spans resolve to explicit multi-page
   citation/highlight output.
8. PDF resolver degrades stale quote selectors instead of projecting highlights
   when the current source snapshot no longer matches the stored selector.
9. Frontend search accepts `content_chunk` and removes `fragment` and
   `transcript_chunk` text result assumptions.
10. Chat citation UI renders backend labels and links from resolver output.
11. Media reader supports resolver-provided temporary answer highlights for
   web, EPUB, transcript, and PDF.
12. PDF saved highlights remain durable user annotations but can be created
   from temporary answer highlights.
13. Frontend tests cover search rows, citations, reader deep links, and PDF
    answer highlight projection.

### Shared integration contract

Path A exposes these stable backend shapes for Path B:

```python
@dataclass(frozen=True)
class IndexableBlock:
    media_id: UUID
    source_kind: str
    block_idx: int
    block_kind: str
    canonical_text: str
    extraction_confidence: float | None
    source_start_offset: int
    source_end_offset: int
    locator: dict[str, object]
    selector: dict[str, object]
    heading_path: tuple[str, ...]
    metadata: Mapping[str, object]
```

```python
@dataclass(frozen=True)
class SourceSnapshotSpec:
    artifact_kind: str
    artifact_ref: str
    content_type: str
    byte_length: int
    content_sha256: str
    source_fingerprint: str
    source_version: str
    extractor_version: str
    parent_snapshot_id: UUID | None
    language: str | None
    metadata: Mapping[str, object]
```

```python
def rebuild_media_content_index(
    db: Session,
    *,
    media_id: UUID,
    source_kind: str,
    source_snapshot: SourceSnapshotSpec,
    blocks: Sequence[IndexableBlock],
    reason: str,
) -> ContentIndexResult: ...
```

Path A exposes this search/citation payload for frontend work:

```ts
interface ContentChunkSearchResult {
  type: "content_chunk";
  id: string;
  media_id: string;
  media_kind: string;
  title: string;
  snippet: string;
  score: number;
  deep_link: string;
  citation_label: string;
  context_ref: {
    type: "content_chunk";
    id: string;
    evidence_span_ids: string[];
  };
  resolver: {
    kind: "web" | "epub" | "pdf" | "transcript";
    route: string;
    params: Record<string, string>;
    highlight?: unknown;
  };
}
```

Path B must consume the payload as authoritative. It must not recompute
citations, labels, or deep links from raw locators.

## Files To Delete Or Stop Using

These are not necessarily deleted as database history, but final runtime code
must not use their old behavior.

- Old direct `content_chunks.embedding` and `content_chunks.embedding_vector`
  ownership. Embeddings move to `content_embeddings`.
- Old semantic search branches that expose `fragment` and `transcript_chunk`
  as text evidence results.
- Old EPUB inline `INSERT INTO content_chunks` in `epub_ingest.py`.
- Old PDF `_try_embedding_handoff` placeholder in `ingest_pdf.py`.
- Old frontend search unions that include `fragment` or `transcript_chunk`
  for text evidence retrieval.
- Old chat context renderers that load whole fragment text for a semantic hit.
- Old vault evidence export paths that construct citation context directly
  from fragments or `media.plain_text`.

## Acceptance Criteria

### Schema and indexing

- A fresh migration creates the evidence tables and removes runtime dependence
  on the old content chunk embedding shape.
- `source_snapshots` are reconstructible from artifact reference, content
  type, byte length, and hash.
- `media_content_index_states` stores the active index pointer. Runtime search
  joins this table and does not infer active readiness from latest run order.
- `content_chunks` has no model-specific embedding vector column.
- `content_embeddings` stores vectors and retrieval filters by active
  provider, model, version, and config hash.
- Every indexed chunk has at least one `content_chunk_part`.
- Every chunk part records block offsets, chunk offsets, and explicit inserted
  separator text.
- Every selected citation has at least one persisted `evidence_span`.
- Reindexing the same source snapshot with the same versions produces the
  same block hashes, chunk hashes, and locator payloads.

### Web articles

- URL-ingested web articles produce source snapshots, blocks, chunks, chunk
  parts, spans, and embeddings.
- Browser-captured web articles produce the same evidence artifacts.
- Search can retrieve a web article by keyword and semantic similarity through
  `content_chunk`.
- Chat citations open the web reader and highlight the exact span.

### EPUBs

- EPUB ingestion no longer writes chunks directly.
- Long EPUB fragments are split into multiple block-derived chunks.
- EPUB citations preserve section id, href path, anchor id, fragment id, and
  offsets where available.
- Search and chat citations open the EPUB reader to the correct section and
  exact text span.

### PDFs

- Digital PDFs with extractable text produce page-aware blocks and chunks.
- PDFs with no extractable text do not appear searchable as empty success;
  they show explicit no-text or OCR-required state.
- PDF search hits include source fingerprint, page-aware resolver output,
  page labels when available, and physical page numbers for navigation.
- PDF chat citations open to the correct page and project a temporary answer
  highlight when geometry exists.
- PDF citation labels use page labels for display when available, while
  resolver navigation uses physical page numbers.
- OCR-derived PDF evidence includes OCR confidence and degrades low-confidence
  table/layout output rather than pretending it is high-confidence digital
  text.
- Cross-page PDF citations render every page range they cover.
- Saved PDF highlights still use durable PDF highlight storage and can be
  created from resolver-projected answer highlights.

### Transcripts

- Transcript semantic retrieval uses the shared evidence index.
- `transcript_chunk` is removed as a search result type.
- Transcript citations preserve time range and text selector.

### Search and chat

- Search request validation rejects `fragment` and `transcript_chunk` text
  evidence filters.
- Scoped chat retrieves only `content_chunk` results for text evidence.
- App search persistence stores chunk ids and evidence span ids.
- Prompt rendering uses exact chunk text and selected spans.
- Citations render from persisted evidence, not model output.
- Missing indexed evidence produces an explicit no-evidence response and no
  fallback retrieval path.

### Saved highlights and annotations

- Saved web/EPUB fragment-offset highlights remain resolvable through the
  locator resolver.
- Saved PDF geometry highlights remain resolvable through the locator
  resolver.
- Annotation search remains a distinct annotation result type and uses
  resolver output for linked source anchors.
- Creating a saved highlight from an answer citation produces a durable saved
  highlight or annotation anchor without mutating the underlying evidence span.

### Frontend

- Search UI renders `content_chunk` rows for web, EPUB, PDF, and transcript
  evidence.
- Citation chips use backend resolver labels and links.
- Reader deep links understand resolver output for all four media kinds.
- Temporary answer highlights work for web, EPUB, transcript, and PDF.
- No TypeScript union or branch retains `transcript_chunk` or semantic
  `fragment` as text evidence result types.

### Exports

- Vault full-text export is generated from ordered blocks.
- Vault citation/highlight export uses evidence spans and selectors.
- PDF exports include page labels and selectors.
- EPUB exports include section/href/anchor context.

### Cleanup and failure

- Media deletion removes all evidence artifacts.
- Reingest deactivates old index versions before activating the new index.
- Reingest preserves evidence referenced by persisted citations, saved
  highlights, annotations, exports, or audit rows.
- Retention cleanup deletes only unreferenced inactive evidence artifacts.
- Library removal changes permissions and scope visibility but does not delete
  media evidence while the media still exists.
- Index failures are visible through `media_content_index_states.status`.
- Tests cover no-text, failed-index, and stale-index states.

## Test Plan

- Backend unit tests for block validation, chunk construction, span
  reconstruction, and locator resolution.
- Backend integration tests for web, EPUB, PDF, and transcript indexing.
- PDF-specific backend tests for page labels, source fingerprints, OCR
  confidence, geometry coordinate metadata, cross-page spans, table/layout
  degradation, and stale text-quote selector behavior.
- Search tests for keyword, vector, hybrid, scope filters, and result shape.
- Chat tests for scoped retrieval, citation persistence, answerability, and
  no-evidence behavior.
- Vault tests for block-derived full-text export and selector-derived
  citation export.
- Deletion/reingest tests that prove inactive chunks, spans, and embeddings
  are not retrieved for new search results but remain resolvable when cited.
- Permission tests that prove library removal hides evidence from that library
  scope without deleting media-owned evidence.
- Frontend tests for search result adaptation, citation chips, resolver links,
  reader navigation, and temporary answer highlights.
- Real-stack smoke test that ingests one web article, one EPUB, one digital
  PDF, and one transcript, then searches and asks a scoped chat question
  against each.

## Cutover Sequence

1. Path A lands schema, models, evidence service APIs, and contract tests.
2. Path B consumes the shared `IndexableBlock` and resolver contracts for PDF
   and frontend work.
3. Path A converts web, EPUB, transcript, search, chat, export, and cleanup.
4. Path B converts PDF ingestion, PDF locator resolution, and frontend
   consumers.
5. Both paths remove legacy result types and dead code.
6. Both paths run backend, frontend, and real-stack smoke tests.
7. The branch ships only when all text-bearing media use the evidence layer.

The final merge cannot contain a partial mode. If any media kind still depends
on old retrieval behavior, the cutover is incomplete.
