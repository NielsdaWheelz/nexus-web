# Notes & Pages Evidence Unification — Hard Cutover

**Status:** Implemented — **Rev 3** (landed through the owner-polymorphic content-index pipeline; subsequent notes/pages object-graph work keeps this contract and writes page bodies through graph-backed document commands).
**Author altitude:** SME / staff.
**Migration:** `0143`.
**Supersedes / deletes:** the entire `object_search_*` substrate (tables, service, retriever, scope filter, constants) introduced by `0077_notes_daily_pins_object_search.py` and never finished (the document-embedding writer was never built — see [[project_notes_pages_semantic_search_unbuilt]]).
**Cutover discipline:** hard. No back-compat, no dual-write, no fallback, no shim, no legacy branch. Old path is deleted in the same change that lands the new one.

---

## 1. SME thesis & the problems

The product has **two parallel content-indexing substrates** that do the same job — chunk text, embed it, store vectors, expose hybrid (lexical ∪ semantic) retrieval, resolve a hit back to a citeable, jump-to-source locator. One is mature; the other is a half-built scaffold.

### 1.1 Substrate A — the canonical content/evidence pipeline (mature)
`content_blocks → content_chunks → content_chunk_parts → content_embeddings`, plus `evidence_spans`, now gated by `content_index_states(owner_kind, owner_id)`. Before the cutover the owner was `media_id`; after it, media and page owners share the same pipeline. It backs:
- hybrid search over documents (`search/retrievers/library_content.py:_search_content_chunks`),
- chat/oracle/library-intelligence RAG citations (`evidence_spans` → `message_retrievals` → `[N]` render),
- jump-to-source deep links via `locator_resolver.resolve_evidence_span`.

It embeds **inline during ingest** (`content_indexing.rebuild_media_content_index` ← `pdf_indexing`/`web_article_indexing`/`epub`/`transcript`), because ingest is rare.

### 1.2 Substrate B — `object_search` for notes/pages (half-built)
`object_search_documents` (generated `tsvector`, lexical) + `object_search_embeddings` (pgvector, semantic), projected by `object_search.project_page`/`project_note_block` from `notes.py`. Its problems, all verified:

- **The embedding writer was never built.** No production code writes `object_search_embeddings` or sets `index_status='ready'` (only tests do). `index_status` is permanently `'pending_embedding'` — a schema-level lie. Result: **note/page semantic search returns zero rows in production**; the search service still pays an embedding-API call per notes query and gets nothing back (`object_search.py:142-145`, `search/service.py` query-embedding gate).
- **Lexical works, semantic is dead.** `object_search.search_objects` WHERE-clause matches `search_vector @@ tsq OR title ILIKE …` ungated by status, so notes are keyword-findable; the `semantic_matches` CTE requires `index_status='ready'` + a populated embedding row, so it never fires. In a hybrid-semantic product, notes are second-class: invisible to conceptual queries while documents return semantic hits.
- **Whole-substrate duplication.** Substrate B re-implements: a second vector table + IVFFlat index; a second similarity floor (`OBJECT_SEARCH_MIN_SEMANTIC_SIMILARITY = 0.50` duplicating `CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY = 0.50`); a second scope-filter (`object_search._scope_filter_sql`, which shadows the §4.6 `search/scope.py` matrix that the search-intent cutover declared single-owner); a second projection/snippet path.
- **Notes are not evidence.** Because note content never enters `content_chunks`/`evidence_spans`, the AI cannot retrieve or cite the user's own notes alongside documents — even though `context_assembler._CITABLE_RESULT_TYPE`, `NoteBlockRetrievalResultRef`, `NoteBlockOffsetsLocator`, and `citation_from_search_result` are **already note-shaped and waiting**. For a SOTA AI-native reader, a user's own notes are the highest-value context; leaving them out is the core product gap.

### 1.3 The move
Delete Substrate B. Make **a page a first-class indexable document** in Substrate A — a page is to `media` what its `note_block`s are to fragments/segments. Generalize the pipeline's owner from `media_id` to a polymorphic `(owner_kind, owner_id)`. Keep the **note-shaped result/locator/deep-link/citation layer** (it already exists and is correct). Embed notes through the **one** mechanism (`build_text_embeddings`), via a **debounced reindex job** (the cadence notes need; unlike media's inline embed). The result: notes are semantically searchable and citeable-as-evidence through the same code that serves documents, and the second substrate is gone.

This is the precursor to, and forward-compatible with, the `resource-provenance-graph` cutover (whose `ResourceRef(scheme,id)` is exactly our `(owner_kind, owner_id)`); it does **not** require building that graph.

---

## 2. Target behaviour (capability contract)

After cutover, for the single user:

1. **Semantic note search.** Searching a concept ("emergence", "why caching matters") returns relevant `note_block`s ranked by hybrid lexical∪semantic score, interleaved with documents — not only exact-keyword matches.
2. **Page/title search.** Searching a page title or a daily-note date returns the `page`.
3. **Notes as citeable evidence.** When the AI answers in chat (and in Oracle / Library Intelligence), it can retrieve and cite the user's notes as numbered `[N]` citations, identical in render and jump-to-source to a document citation, deep-linking to `/notes/{block_id}`.
4. **Uniform freshness.** Note search/evidence is *eventually consistent*: a saved note becomes searchable once its page-reindex job completes (seconds), exactly as a just-ingested document becomes searchable once indexed. No content is lost; only the index lags, uniformly across all content types.
5. **Scope-aware.** "Search notes in this library / about this document / used in this conversation" continues to work, now via the single §4.6 scope matrix.
6. **No dead state.** No `pending_embedding` placeholder that never advances; index state means what it says for every content type.

Non-promises are in §13.

---

## 3. Architecture & final state

### 3.1 One substrate, polymorphic owner
`content_blocks`, `content_chunks`, `evidence_spans`, and the (renamed) `content_index_states` are keyed on `(owner_kind text, owner_id uuid)` where `owner_kind ∈ {'media','page'}`. `content_chunk_parts` and `content_embeddings` are keyed via `chunk_id` (unchanged). `media_id` columns are dropped — the FK was already non-cascading (no `ON DELETE` clause ⇒ default `NO ACTION`) and cleanup is already explicit (`docs/rules/database.md`: no `ON DELETE CASCADE`, explicit app cleanup), so a polymorphic owner with app-level cleanup is the idiomatic generalization, not a regression. The owner column is **not** a FK (a single column cannot FK two parent tables); integrity is held by the same explicit-cleanup discipline the codebase already uses for `media_id` (§3.6 enumerates every consumer; AC-4 tests orphan-freedom).

A page is a **document**; its `note_block`s are **blocks**:
- one `content_block` per `note_block`, ordered by the page's graph document (`resource_graph.documents.load_page_document`) and its `origin='note_containment'` `source_order_key`, DFS-flattened, with accumulated offsets;
- `source_kind='note'`, block `locator/selector` kind `'note_text'` carrying `{note_block_id, page_id, start_offset, end_offset, text_quote}`;
- the existing 420-token chunker (`CHUNK_MAX_TOKENS`/`CHUNK_OVERLAP_TOKENS`) coalesces adjacent blocks into `content_chunks`; each chunk gets a `primary_evidence_span_id` and one `content_embedding`;
- `evidence_spans.resolver_kind='note'`.

### 3.2 Storage unified, result-types preserved (the key split)
We unify the **expensive, duplicated** layer (chunking, embedding, vectors, evidence, deletion-cascade, model-version tracking, staleness, the job) and keep the **cheap, meaningful** distinctions that already exist and are correct: the `page` / `note_block` result types, the `note_block_offsets` locator, the `/notes/{block}` / `/pages/{id}` deep links, the `notes` SearchKind. The search/citation **contract is unchanged**; only its storage and retriever internals change.

- `notes` SearchKind still maps to `("page","note_block")` (`kinds.py` unchanged).
- Note **body** search is served from `content_chunks WHERE owner_kind='page'`, projected to `_RankedNoteBlockResult` (note-shaped, `note_block_offsets` locator derived from the chunk's primary block).
- Page-level search is served lexically from `pages` (+ `daily_note_pages`) over **title + description + daily-date terms**, projected to `_RankedPageResult`. **Behavior change (explicit, see D5):** the old `object_search` page document also concatenated the full block body into the page's `search_text` (`object_search.py:37-50`), so a page could match on its body text. Post-cutover, page **body** matching is served by `note_block` chunk results (semantic + lexical, block-granular, deep-linked to the matching block) — strictly better than a lexical whole-page body match — and the page result keeps only title/description/daily terms. No text becomes unsearchable; body search moves from page-granular lexical to block-granular hybrid. (Titles/descriptions are short → lexical, no embeddings.)
- Document search (`_search_content_chunks`) is unchanged except an explicit `owner_kind='media'` guard.

### 3.3 Embed cadence — job, not inline (deliberate divergence from media)
Media embeds inline because ingest is rare. Notes are edited constantly and a network embed call must not block a save, so notes use the **job pattern** (the same pattern as `podcast_reindex_semantic_job`): a note/page mutation marks the page's index state `pending` and enqueues a **debounced** `page_reindex_job` (`dedupe_key="page_reindex:{page_id}"` coalesces rapid edits); the worker rebuilds the page's content index idempotently from current state and flips it to `ready`. Staleness = unconditional rebuild-on-change (honoring the current-only discipline; `content_hash` stays dropped).

### 3.4 Evidence composition — explicit, not automatic
The **citation persistence/render contract** (`message_retrievals` with `media_id NULL`, `retrieval_citation.insert_retrieval_row`, `citation_from_search_result`, `NoteBlockRetrievalResultRef`, `NoteBlockOffsetsLocator`, `context_assembler._CITABLE_RESULT_TYPE` already listing `page`/`note_block`) is already note-shaped — so an **attached** note (a note the user pins to a conversation) becomes a `[N]` citation the moment search can return a `note_block` result (`_materialize_attached_citation` → `get_search_result(…, "note_block", …)`).

But the **RAG retrieval consumers do not route through `get_search_result`**, so notes do **not** "compose automatically". Each is hand-rolled, media-shaped SQL that must be explicitly changed (or explicitly excluded). §7 makes the per-consumer decision for Chat RAG (`app_search`), Oracle, Library Intelligence, and `read_resource`, and §5.7 specifies the locator-resolver + frontend work (which is a real target-type union, not an href fallback — see D9). Nothing about evidence "just works" beyond the attached-resource path.

### 3.5 Final-state module map
```
content_indexing.py        owner-polymorphic core: rebuild_content_index / delete_content_index /
                           deactivate_content_index / _set_index_state; IndexOwner; IndexableBlock.owner
note_indexing.py     [NEW] build_page_indexable_blocks(page) + rebuild_page_content_index(db, page_id, reason)
                           + enqueue_page_reindex(db, page_id, reason)  (note 'note' source_kind owner)
tasks/page_reindex.py[NEW] page_reindex_job(page_id, ...)  (mirrors tasks/podcast_reindex_semantic.py)
jobs/registry.py           + "page_reindex_job" JobDefinition + _run_page_reindex
notes.py                   every project_page/project_note_block/delete_document call → enqueue_page_reindex
                           / delete_content_index(owner=('page', page_id))
search/retrievers/notes.py [NEW, replaces objects.py] _search_note_chunks + _search_pages over the unified tables
search/retrievers/library_content.py  _search_content_chunks + owner_kind='media' guard
search/scope.py            + 'page' and 'note_block' cells in _SCOPE_MATRIX (port object_search._scope_filter_sql)
locator_resolver.py        + resolver_kind 'note' → /notes/{block_id}
object_search.py           DELETED
object_search_documents / object_search_embeddings (tables + models) DELETED
```

### 3.6 Owner-rename consumer inventory (S0 contract migration)
Dropping `media_id` and renaming `media_content_index_states → content_index_states` is **not** local to `content_indexing.py`. Every consumer of the owner column or the index-state table must be migrated to the owner contract. S0 is "owner-aware contract migration across all of these," and is behavior-preserving for media. Verified blast radius (21 files):

| File | Touches | S0 disposition |
|---|---|---|
| `db/models.py` | table defs | rename model `MediaContentIndexState`→`ContentIndexState`; owner cols; drop `Media.content_chunks` rel |
| `services/content_indexing.py` | core | `IndexOwner`, rename fns, owner SQL (§5.1) |
| `services/pdf_indexing.py` | index write + `_mark_pdf_ocr_required_index` `mcis.media_id` | `owner=('media',id)`; state update by owner |
| `services/web_article_ingest.py`, `services/youtube_video_ingest.py` | call indexing | pass `owner=('media',id)` |
| `services/podcasts/transcription.py` | `_semantic_index_requires_repair` reads `mcis` by `media_id` | read state by owner |
| `services/media_deletion.py` | `delete_media_content_index(media_id=…)` | `delete_content_index(owner=('media',id))` |
| `services/media.py` | media read models referencing index state/chunks | owner-aware reads |
| `services/locator_resolver.py` | `resolve_evidence_span` reads `evidence_spans.media_id`, routes `/media/{id}` | derive route from owner; add `'note'` (§5.7) |
| `services/search/retrievers/library_content.py` (`:135`) | `cc.media_id` / `mcis.media_id` joins | owner join + `owner_kind='media'` guard |
| `services/search/retrievers/highlights.py` | references spans/chunks | owner-aware |
| `services/search/service.py` (`:306`) | content_chunk/evidence_span result materialization (media-shaped) | owner-aware; note path projects note-shaped (§5.5) |
| `services/agent_tools/app_search.py` (`:427`,`:956`,`:370`) | RAG content_chunk SQL + context render + empty-probe, all `mcis.media_id=cc.media_id`/`es.media_id=cc.media_id` | owner join; **include notes** (§7 D8) |
| `services/oracle.py` (`_retrieve_user_content_chunks_by_embedding`, `used_semantic_media`) | own `content_chunks JOIN visible_media` by `media_id` | owner join; **include notes** decision (§7 D8) |
| `services/library_intelligence.py` (`_load_inventory`, `:242`) | counts `cc` per `le.media_id` | owner join, **media-only** (notes excluded, §7) |
| `services/object_refs.py` (`:323`) | `hydrate_object_ref` content_chunk search `JOIN cc.media_id` | owner join; media-only |
| `services/reader_navigation.py` (`:51`) | `mcis.media_id` ready-probe + `content_blocks.media_id` heading nav | owner join; media-only (web_article) |
| `services/resource_graph/resolve.py` | span/chunk/page/note_block body loaders and graph visibility | owner-aware; media and page-owned evidence resolve through one graph hydration owner |
| `services/metadata_enrichment.py`, `services/vault.py` | chunk/state refs | owner-aware |
| `tasks/reconcile_stale_ingest_media.py` | reconciler reads `mcis` | owner join; media-only |

`read_resource` composes with `resource_graph.resolve`: page, note_block, page-owned `evidence_span`, and page-owned `content_chunk` refs resolve through the same graph hydration owner, independent of the deleted `object_search` substrate.

---

## 4. Schema & migration `0141` (hard cutover)

`downgrade()` raises `NotImplementedError("Hard cutover: 0141 is not reversible")`.

### 4.1 Owner generalization (per table)
For `content_blocks`, `content_chunks`, `evidence_spans`:
1. `ADD COLUMN owner_kind text`, `ADD COLUMN owner_id uuid`.
2. Backfill: `owner_kind='media'`, `owner_id=media_id`.
3. `ALTER … SET NOT NULL` on both; `ADD CONSTRAINT … CHECK (owner_kind IN ('media','page'))`.
4. Drop FK `…_media_id_fkey`; `DROP COLUMN media_id`.
5. Recreate keys against the owner:
   - `content_blocks`: `UNIQUE (owner_kind, owner_id, block_idx)`; `INDEX (owner_kind, owner_id, block_idx)`.
   - `content_chunks`: `UNIQUE (owner_kind, owner_id, chunk_idx)`; `INDEX (owner_kind, owner_id, chunk_idx)`.
   - `evidence_spans`: `INDEX (owner_kind, owner_id)`.
6. Extend discriminators:
   - `content_chunks` source_kind CHECK → `IN ('web_article','epub','pdf','transcript','note')`.
   - `evidence_spans` resolver_kind CHECK → `IN ('web','epub','pdf','transcript','note')`.

`content_embeddings` and `content_chunk_parts`: **no schema change** (keyed via `chunk_id`). The IVFFlat index (`ix_content_embeddings_vector_ann`) now serves note vectors too.

### 4.2 Index-state rename
`media_content_index_states` → **`content_index_states`**. Apply the same owner transform (drop `media_id`, add `owner_kind`/`owner_id`, `UNIQUE(owner_kind, owner_id)`), recreate the two partial repair indexes against `(owner_kind, owner_id)`. Status enum unchanged (`'pending','indexing','ready','no_text','ocr_required','failed'`; notes use all but `ocr_required`).

### 4.3 Drop Substrate B
`DROP TABLE object_search_embeddings; DROP TABLE object_search_documents;` (and their generated `search_vector`, IVFFlat/GIN indexes go with them).

### 4.4 Backfill (separate one-time step, not in the migration)
Migrations do no heavy work. A `python/scripts/backfill_page_content_index.py` enqueues `page_reindex_job` (dedupe-keyed) for every existing `pages.id`. The worker drains them. (Existing notes are immediately re-readable; they become searchable as the queue drains.)

### 4.5 Locator / selector shape for `note` (single-block invariant)
Block-level (stored in `content_blocks.locator`/`.selector`), mirroring `web_text`:
```json
{ "kind": "note_text", "note_block_id": "<uuid>", "page_id": "<uuid>",
  "start_offset": <int>, "end_offset": <int>,
  "text_quote": { "exact": "<block text>", "prefix": "", "suffix": "" } }
```
Public retrieval locator (already defined — `NoteBlockOffsetsLocator`): `{ "type": "note_block_offsets", "page_id", "block_id", "start_offset", "end_offset" }`.

**Single-block invariant (D10).** A `note_text` locator references exactly **one** `note_block`; it cannot represent a chunk spanning multiple blocks. This is enforced *by construction* via the chunker's anchor function: `content_indexing._same_locator_anchor` decides whether two adjacent blocks may share a chunk. For `web_text`/`epub_text` the anchor is `fragment_id`; for `note_text` the anchor is **`note_block_id`** — so two different note_blocks are never coalesced, and every note chunk lies within one block. A long note_block is still split into multiple single-block chunks by `_block_pieces` (420-token windows, 60 overlap), each carrying a sub-range `note_text` locator. We deliberately **forbid cross-block coalescing for notes** rather than invent a multi-block page selector (simpler, keeps every hit citeable to a specific block; D10).

**Every switch that must gain a `note` case** (each currently `raise`s on unknown kind — verified):
- `content_indexing._resolver_kind` (`:1060`) → `'note' → 'note'`.
- `content_indexing._validate_selector` (`:1140`) → `note_text` branch (offset/text-length invariants identical to `web_text`).
- `content_indexing._same_locator_anchor` (`:1280`) → `note_text` anchors on `note_block_id`.
- `content_indexing._chunk_locator` (`:1305`) → `note_text` branch: single-block offset math (`start = block.start_offset + first_start`, `end = block.start_offset + last_end`; all parts share one `note_block_id`).
- `evidence_spans.resolver_kind` CHECK + `content_chunks.source_kind` CHECK (§4.1).
- `locator_resolver.resolve_evidence_span` (`:25`) dispatch → `_resolve_note_selector` (§5.7).
- Frontend `RetrievalLocator` union (`@/lib/api/sse/locators`) must include `note_block_offsets`; `readerTarget` activation switch (§5.7).

---

## 5. Service & module design

### 5.1 `content_indexing.py` — owner-polymorphic core
- Introduce `@dataclass(frozen=True) class IndexOwner: kind: Literal["media","page"]; id: UUID`. Forward-compatible with `ResourceRef`.
- `IndexableBlock.media_id` → `IndexableBlock.owner: IndexOwner`.
- Rename + reparameterize: `rebuild_media_content_index` → `rebuild_content_index(db, *, owner: IndexOwner, source_kind, blocks, reason)`; `delete_media_content_index` → `delete_content_index(db, *, owner)`; `deactivate_media_content_index` → `deactivate_content_index(db, *, owner, reason)`; `_set_index_state(db, *, owner, status, …)`.
- Concurrency: **do not introduce a new `SELECT … FOR UPDATE`** for pages — `docs/rules/concurrency.md:12` forbids row locks on top of SERIALIZABLE, and per-page single-writer is already guaranteed by the job's dedupe key + lease (one in-flight `page_reindex_job` per page). The existing media `SELECT … FOR UPDATE` (`content_indexing.py:120`) is pre-existing and preserved for the `owner.kind=='media'` path only; the `'page'` path relies on job serialization. If a future non-job caller needs it, use the repo's identity-write pattern (SERIALIZABLE + retry, per the authors-directory `run_identity_write`), not `FOR UPDATE`.
- All INSERT/DELETE SQL: `media_id` → `owner_kind, owner_id`. `delete_content_index` joins (`message_retrievals.evidence_span_id` null-out, chunk/embedding/part cascade) rewritten against `(owner_kind, owner_id)`; graph edge cleanup is owned by `resource_graph.cleanup`.
- `_resolver_kind('note') -> 'note'`. Add a `note_text` branch to the block locator/selector validator (offset/text-length invariants identical to `web_text`).
- Model renames: `MediaContentIndexState` → `ContentIndexState`; drop `Media.content_chunks` relationship.

### 5.2 `note_indexing.py` (new) — the note source adapter
Parallel to `web_article_indexing.py`/`pdf_indexing.py`:
- `build_page_indexable_blocks(db, page) -> list[IndexableBlock]`: produce blocks in **the same document order the user sees** by traversing `resource_graph.documents.load_page_document`, whose containment edges are ordered by `source_order_key`; do not read old `note_blocks.parent_block_id`/`order_key` columns. One `IndexableBlock` per block: `owner=IndexOwner('page', page.id)`, `source_kind='note'`, `canonical_text=block.body_text` (already stored), contiguous `source_start/end_offset` (the validator at `content_indexing.py:1069` requires contiguous ordered blocks), `heading_path` = ancestor block-text path (replaces `object_search._ancestor_text`), `note_text` locator/selector. Skip empty-body blocks (no `canonical_text`); a page with no text → state `no_text`.
- `rebuild_page_content_index(db, *, page_id, reason)`: build blocks → `rebuild_content_index(owner=('page',page_id), source_kind='note', …)`. Empty page → state `no_text`.
- `enqueue_page_reindex(db, *, page_id, reason)`: mark state `pending` + `enqueue_job(kind="page_reindex_job", payload={page_id, reason}, dedupe_key=f"page_reindex:{page_id}")`. **This single call replaces every `object_search.project_page`/`project_note_block` site.**

### 5.3 `tasks/page_reindex.py` + `jobs/registry.py` — the writer (subsumes L1)
- `page_reindex_job(page_id, request_reason="note_edit", request_id=None, task_id=None)`: own session, `rebuild_page_content_index`, commit; on failure rollback + `{status:"failed", error_code}` (mirrors `podcast_reindex_semantic_job` exactly, incl. `justify-ignore-error` boundary).
- Registry: `"page_reindex_job": JobDefinition(kind=…, handler=_run_page_reindex, max_attempts=3, retry_delays_seconds=(60,300,900), lease_seconds=900)`. External-API budget per `retries.md`.

### 5.4 `notes.py` (and callers) — rewire all mutations
**Authoritative discovery:** the rewrite covers **every** former call site of `object_search.project_page` / `object_search.project_note_block` / `object_search.delete_document` (grep is the source of truth). Current write owners are:
- `create_page`, `update_page`, `patch_page_document`(+`_patch_page_document_once`), `quick_capture`, `set_highlight_note_body_pm_json`, `delete_highlight_note`, `delete_page`, and `_resolve_daily_page_once`.
- Highlight notes use `set_highlight_note_body_pm_json` / `delete_highlight_note`; the old `set_highlight_note_body` and `set_note_block_markdown_body_without_commit` helpers are deleted.
- Vault/import flows now submit versioned page-document commands rather than mutating note bodies directly.
- Public block mutation commands have been removed; page/block edits persist through the versioned page-document command path.

Rewrite rule (uniform):
- Any create/update/reorder/move/split/merge of a page or its blocks (including highlight-note create/update) -> `enqueue_page_reindex(db, page_id=<owning page>, reason=...)` once per affected page, before the existing commit. Block-level mutations enqueue the **owning page** (a page is the index unit). Import/vault callers compose the same page-document command path so the caller's transaction flushes the `pending` state + job row atomically.
- `delete_page` → `delete_content_index(db, owner=IndexOwner('page', page_id))` inline (no reindex). Block/highlight-note deletes inside a surviving page → `enqueue_page_reindex`. All `delete_document` calls are removed.
- `_daily_terms`/`_ancestor_text`/`_join_search_text` move out of the deleted `object_search.py`: daily terms → the `_search_pages` retriever (join `daily_note_pages`); ancestor text → `IndexableBlock.heading_path` in `build_page_indexable_blocks`.

**Existing tests that assert the old substrate** must be rewritten in S5, not just deleted: `test_notes.py:638` (asserts `object_search` projection) and `test_search.py:1967`/`:2066` (`test_page_semantic_search_uses_object_search_embeddings`, `test_page_reprojection_deletes_stale_object_search_embeddings`) become tests of the unified pipeline (page reindex → `content_chunks`/`content_embeddings`; reproject → stale chunk deletion). `tests/utils/db.py` cleanup of `object_search_*` is removed; add `content_index_states`/note-chunk cleanup.

### 5.5 Retrievers
- **New `search/retrievers/notes.py`** (replaces `objects.py`):
  - `_search_note_chunks(...)`: the `_search_content_chunks` hybrid SQL with the owner gate swapped — `visible_media` → `owned_pages` (`SELECT id FROM pages WHERE user_id=:viewer_id`), `cc.owner_kind='page'`, join `content_index_states … status='ready'` on the owner. Project to `_RankedNoteBlockResult`: derive `note_block_offsets` locator from the chunk's primary block's `note_text` locator; `page_id`/`page_title` from the owning page; deep link `/notes/{block_id}`; reuse `min_semantic_similarity = CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY`.
  - `_search_pages(...)`: lexical title/daily-date match on `pages` (user-owned) → `_RankedPageResult`, deep link `/pages/{id}`. No embedding.
  - Share the chunk SQL builder with `library_content.py` (parameterized by owner gate) to avoid a third copy.
- **`library_content.py`**: `_search_content_chunks` adds explicit `cc.owner_kind='media'`.

### 5.6 Scope matrix (`search/scope.py`) — finally single-owner
Add `page` and `note_block` cells to `_SCOPE_MATRIX`, porting the semantics of the deleted `object_search._scope_filter_sql` but expressed against the unified tables / owner:
- `all`: no filter.
- `library:` — note's block/page connected by allowed `resource_edges` origins to a `library_entries.media_id` in scope, or a `highlight_note` edge whose highlight anchors to media in scope.
- `media:` — page/note connected to the scoped `media` by allowed `resource_edges` origins, or attached to a highlight on that media.
- `conversation:` — only bare `origin in ('user','citation','system')`, `kind='context'`, `ordinal is null` conversation context refs define app-search scope; ordinal citation edges do not widen the search scope.

**Sequencing (hard prerequisite):** today `_SCOPE_MATRIX` (`scope.py:117`) has **no** `page`/`note_block` cells and the scope behavior lives only in `object_search._scope_filter_sql` (`:340`). The matrix cells **and their ported regression tests (AC-6) must land and pass in S3 before** `object_search._scope_filter_sql` is deleted in S5 — never a window where note scope is unowned. Then delete `object_search._scope_filter_sql` and `OBJECT_SEARCH_MIN_SEMANTIC_SIMILARITY`.

### 5.7 Evidence resolution & frontend (target-type union, not an href fallback — D9)
**Backend.** `locator_resolver.resolve_evidence_span` (`:25`) currently routes everything to `/media/{media_id}` and dispatches `resolver_kind ∈ {web,epub,pdf,transcript}`. Generalize: read `owner_kind`/`owner_id` from the `evidence_spans` row and build the route from the owner (`/media/{id}` for media; `/notes/{block_id}` for notes); add `resolver_kind='note'` → `_resolve_note_selector` (returns the block id + offset range + `note_block_offsets` highlight params). It no longer requires a `media_id` argument.

**Frontend — the strict fix is a target union, because `ReaderSourceTarget` hard-requires `media_id`** (`readerTarget.ts:4`) and `readerTargetFromRetrieval` returns `null` when `media_id` is absent (`readerTarget.ts:43`). A small href fallback would render a `[N]` that does not activate. Required changes:
- Make `ReaderSourceTarget` a discriminated union: `MediaReaderTarget { kind:'media'; media_id; locator; evidence_span_id }` | `NoteReaderTarget { kind:'note'; page_id; block_id; start_offset; end_offset }`.
- `RetrievalLocator` (`@/lib/api/sse/locators`) union must include `note_block_offsets` (verify/add).
- `readerTargetFromRetrieval`: branch on `result_type`/locator — note retrievals (`media_id===null`, `note_block_offsets`) build a `NoteReaderTarget`; `hrefForReaderTarget` gains a `note_block_offsets` → `/notes/{block_id}` branch.
- **Offset-aware activation** in the notes pane (`/pages/[pageId]`, `/notes/[blockId]`): the citation jump must scroll to `block_id` and pulse the `[start_offset,end_offset)` range — parity with the reader's evidence pulse, not just navigation. This is new pane work (not a render no-op); `citations.ts` stays generic on `deep_link`/`result_type`.

**Chat RAG inclusion** is specified in §7 (D8), not here.

---

## 6. Consolidation / dedup ledger (what collapses)

| Duplicated thing (today) | After cutover |
|---|---|
| `object_search_documents` + `object_search_embeddings` tables, generated tsvector, second IVFFlat | **Deleted.** Notes live in `content_chunks`/`content_embeddings` (one vector table, one ANN index). |
| `object_search.py` (project/search/scope/upsert/daily/ancestor) | **Deleted.** Replaced by `note_indexing.py` (write) + `retrievers/notes.py` (read). |
| `OBJECT_SEARCH_MIN_SEMANTIC_SIMILARITY` (0.50) vs `CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY` (0.50) | **One constant.** |
| `object_search._scope_filter_sql` shadowing the §4.6 matrix | **Deleted.** Scope is the single `search/scope.py` matrix (page/note_block cells added). |
| Two embed call sites / two staleness models | **One** mechanism (`build_text_embeddings`), one staleness rule (rebuild-on-change), one state machine (`content_index_states`). |
| `media_id` owner threaded through `content_indexing`/`pdf`/`web`/`epub`/`transcript`/`media_deletion`/`locator_resolver` | **One `IndexOwner`** (`(owner_kind, owner_id)`), forward-compatible with `ResourceRef`. |
| `_ancestor_text` (note search context) | **`heading_path`** (existing chunker field). |
| Permanent `index_status='pending_embedding'` placeholder | **Gone.** `content_index_states` means what it says for every type. |

---

## 7. Composition with other systems — explicit per-consumer decisions

Each evidence/RAG consumer is hand-rolled and media-shaped; none "composes automatically". Decisions:

- **Attached-resource citation (`context_assembler._materialize_attached_citation` → `get_search_result`):** **already works** once search returns a `note_block` result (§3.4). No change beyond the retriever (S3). This is the only path that was genuinely contract-complete.
- **Chat RAG (`agent_tools/app_search.py`, planned via `chat_runs.py:1294`):** **INCLUDE notes (D8).** Today `chat_runs` hard-codes `planned_types=["content_chunk"]` and `app_search` runs three media-shaped SQL blocks (`:427` empty-probe, `:956` context render, plus `_search_content_chunks`) joining `cc.media_id`/`mcis.media_id`/`es.media_id`. Required: (a) the `app_search` content-chunk SQL becomes owner-aware and, for the user's own knowledge, unions media-owned **and** page-owned chunks (gated by `pages.user_id`); (b) `_render_content_chunk_context` resolves note chunks via the `'note'` resolver; (c) the empty-probe `_scoped_content_chunk_empty_status` covers note owners. This is the core "AI cites your notes" capability — its own slice (S4) with AC-5.
- **Oracle (`oracle.py:_retrieve_user_content_chunks_by_embedding`, `used_semantic_media`):** **INCLUDE notes (D8), but as a discrete, separately-gated slice.** Oracle already retrieves *user* content chunks by embedding for a reading; the user's notes are legitimately personal oracle material. Work: generalize its own `content_chunks JOIN visible_media` to union page-owned chunks; the `used_semantic_media` dedup (keyed on `media_id`) must dedup on `(owner_kind, owner_id)`. If descoped, say so loudly — it is **not** automatic. (Default: include.)
- **Library Intelligence (`library_intelligence.py:_load_inventory`, `:242`):** **EXCLUDE notes** — LI summarizes *library media* coverage; notes are not library entries. Its SQL still consumes `content_chunks` and must be migrated for the owner rename (it joins via `le.media_id`, so it stays media-scoped after adding `owner_kind='media'`). Functionally unchanged, mechanically migrated.
- **`read_resource` / `resource_graph.resolve`:** **composes with the graph** — page, note_block, media-owned evidence, and page-owned evidence all resolve through the same `ResourceRef` hydration layer, not through `object_search`.
- **`object_refs.hydrate_object_ref` (`:323`):** owner-rename only; media-scoped (drives the global-search palette). Notes are surfaced via the dedicated note retriever, not here.
- **Highlights & graph edges:** `origin='highlight_note'` edges (highlight → note_block) power scope filters and the note highlight excerpt; `origin='note_body'` edges capture inline note resource refs. Note: highlight-notes are `note_block`s (§5.4) and become searchable/citeable like any note.
- **Default-library / permissions:** documents keep `visible_media_ids_cte_sql`; notes use owner gating (`pages.user_id`). No note sharing (single-user; §13).
- **`media_deletion`:** `delete_media_content_index(media_id=…)` → `delete_content_index(owner=IndexOwner('media', media_id))`.

---

## 8. Rules adherence (`docs/rules`)

- **database.md:** no `ON DELETE CASCADE` (owner is FK-less, app-cleaned); `timestamptz`; new indexes only where queried; numbered migration `0141`; `downgrade` not reversible; `_set_index_state` uses explicit SELECT-then-INSERT/UPDATE (no `ON CONFLICT` merge).
- **concurrency.md / retries.md:** the reindex job is the only embed path off the request thread (no event-loop-blocking embed on save); per-page single-writer comes from the job dedupe key + lease, **not** a new `SELECT … FOR UPDATE` (forbidden over SERIALIZABLE, `concurrency.md:12`); job retries use the external-service budget; mutation→enqueue is idempotent (dedupe key) and the job rebuilds from current state (no cross-retry in-memory state).
- **layers.md / module-apis.md:** logic in services; `note_indexing` exposes one write API (`enqueue_page_reindex`) and the job one handler; no second "search notes" surface (the duplicate retriever is deleted).
- **cleanliness.md / simplicity.md:** hard cutover; the era-named half-built substrate is deleted, not bridged; no `content_hash` reintroduction; no speculative owner kinds beyond `media`/`page`.
- **naming.md:** `IndexOwner`, `ContentIndexState`, source/resolver kind `'note'`, error/span names consistent; `content_index_states` drops the now-wrong `media_` prefix.

---

## 9. Slices (each independently landable, each a hard cutover of its seam)

- **S0 — Owner core.** Migration `0141` §4.1–§4.2 (owner columns, rename `content_index_states`, extend kind CHECKs). Refactor `content_indexing.py` to `IndexOwner` + renamed functions; update `pdf_indexing`/`web_article_indexing`/`epub`/`transcript`/`media_deletion`/`locator_resolver` call sites (`owner=IndexOwner('media', media_id)`). **Behavior-preserving for media.** Gate: full media search + RAG citations green.
- **S1 — Note source adapter + job.** `note_indexing.py`, `tasks/page_reindex.py`, registry entry, `note_text` validator + `'note'` resolver kind.
- **S2 — Rewire notes mutations.** Replace all `object_search.project_*`/`delete_document` with `enqueue_page_reindex`/`delete_content_index`. Backfill script (§4.4).
- **S3 — Note retrievers + scope.** `retrievers/notes.py` (`_search_note_chunks`, `_search_pages`); add page/note_block §4.6 cells; `library_content` owner guard; wire into `search/service.py` dispatch for result types `note_block`/`page`.
- **S4 — Notes as evidence (the L2 payoff).** (a) `locator_resolver` owner-derived route + `'note'` resolver; (b) frontend `ReaderSourceTarget` union + offset-aware note activation (§5.7, D9); (c) **Chat RAG**: `app_search` content-chunk SQL unions page-owned chunks, `_render_content_chunk_context`/empty-probe owner-aware, `chat_runs` planned types include notes (D8); (d) **Oracle**: `_retrieve_user_content_chunks_by_embedding` unions page-owned chunks, `used_semantic_media`→owner dedup (D8). Each of (c)/(d) is independently landable with its own AC; descoping (d) must be stated, not silent.
- **S5 — Delete Substrate B.** Drop `object_search.py`, models, tables (migration §4.3), constant, scope filter; **rewrite** (not delete) the tests that asserted it (§5.4). Negative-grep gate (object_search-specific tokens only — **not** bare `index_status`, which `pdf_indexing.py`/media-doc models legitimately use): zero references to `object_search`, `object_search_documents`, `object_search_embeddings`, `ObjectSearchDocument`, `ObjectSearchEmbedding`, `OBJECT_SEARCH_MIN_SEMANTIC_SIMILARITY`, `pending_embedding`, `project_note_block`, `MediaContentIndexState`, `media_content_index_states`, `rebuild_media_content_index`.

---

## 10. Acceptance criteria

**Global**
- AC-G1 Negative gates (S5 grep list) all empty.
- AC-G2 `pyright`/`ruff`/`tsc`/`eslint` clean; `make test-migrations` green; backend integration + unit green; FE unit + browser green.
- AC-G3 No production code path leaves any `content_index_states` row in a non-terminal status indefinitely; no placeholder statuses.

**Behavioural**
- AC-1 A note containing a concept (not the exact words) is returned for a semantic query for that concept (deterministic fixture embedding in tests).
- AC-2 A page is returned by title and by daily-note date.
- AC-3 Editing a note → within one job cycle, the new text is searchable and the old text is not (rebuild-on-change).
- AC-4 Deleting a page/block removes its chunks/embeddings/spans/state and nulls dependent `message_retrievals.evidence_span_id` (no orphans; verified by API + a `test_migrations`-tier constraint check).
- AC-5 Chat RAG (`app_search`) retrieves and cites a note as `[N]` with a `/notes/{block_id}` deep link whose target **activates** (scrolls to the block and pulses the offset range) — render *and* jump parity with a media citation. Asserts the frontend target union (D9), not just a non-null href.
- AC-6 Scope queries (`library:`/`media:`/`conversation:`) over notes return the same set the deleted `object_search` path returned (regression fixtures ported; matrix cells live before object_search deletion).
- AC-7 Media search/RAG/Oracle/LI behaviour is byte-for-byte unchanged across S0 (snapshot tests over `app_search`, `oracle._retrieve_user_content_chunks_by_embedding`, `object_refs`, `reader_navigation`, `library_intelligence`).
- AC-8 Rapid successive note edits coalesce to a single effective reindex (dedupe key); no embed call on the request thread (asserted: save latency excludes provider call).
- AC-9 Oracle includes a relevant user note among its candidates (D8); `used_semantic_media`→owner dedup does not drop a note when a media of the same id space exists.
- AC-10 A page that matches only via block body no longer returns a `page` result but **does** return the matching `note_block` result (D5 behavior change); page title/description/daily-date still return the `page`. Highlight notes written through `set_highlight_note_body_pm_json` are searchable and citeable.

---

## 11. Non-goals

- N1 Sharing/collaboration of notes; multi-user visibility. Notes stay owner-gated.
- N2 Creating another graph. Evidence unification composes with the existing `ResourceRef`/`resource_edges` graph; it does not introduce a parallel graph or link table.
- N3 Incremental/partial re-embed or `content_hash` dirty-skipping. Rebuild-on-change per current-only discipline.
- N4 Highlighting/annotation *on* notes; PDF-style geometry for notes.
- N5 A periodic notes reconciler. The one-time backfill + per-edit enqueue suffices at single-user scale (flag for later if drift appears).
- N6 Synchronous (inline) note indexing. Deliberately job-based (§3.3).
- N7 Page-level semantic vectors. Page semantic relevance = aggregate of its note_block chunk hits; page result type stays lexical-title.

---

## 12. Key decisions

- **D1 — Unify storage, keep result-types.** Collapse the duplicated chunk/embed/evidence layer; preserve the already-correct `page`/`note_block` result, `note_block_offsets` locator, deep links, and `notes` kind. Minimal contract churn, maximal dedup.
- **D2 — Polymorphic `(owner_kind, owner_id)`, FK-less, app-cleaned.** Consistent with `database.md` (no cascade, explicit cleanup) and forward-compatible with `ResourceRef`. Rejected: synthetic `media` rows per page (pollutes media semantics); two nullable FKs + XOR check (more constraints, no benefit at this scale).
- **D3 — Job, not inline, for notes.** Frequent edits + network embed ⇒ async debounced reindex (the `podcast_reindex_semantic_job` pattern), unlike media's inline ingest embed.
- **D4 — Eventually-consistent note search.** Uniform with media; bounded by job latency; no content loss. Accepts a seconds-long index lag in exchange for non-blocking saves and one freshness model.
- **D5 — Page = document, note_block = block; page result is title/description/daily-lexical.** One `content_block` per `note_block`; the chunk's primary-block evidence span yields the citeable `/notes/{block}` jump. The page **result** matches only on title + description + daily terms; page **body** search is served (better) by `note_block` chunk hits. This drops the old whole-page-body lexical match (object_search concatenated body into the page doc) in favor of block-granular hybrid — an explicit behavior change (§3.2), no text lost.
- **D6 — Scope via the one §4.6 matrix.** Port `object_search._scope_filter_sql` into matrix cells (+ tests) **before** deleting the shadow (§5.6 sequencing). Honors the search-intent cutover's single-owner claim that was previously untrue for notes.
- **D7 — Rename `media_content_index_states` → `content_index_states`** (and `MediaContentIndexState`, `rebuild_media_content_index`, …). The `media_` prefix is now wrong; `cleanliness.md` mandates the rename. Blast radius = §3.6 (21 files).
- **D8 — RAG/Oracle explicitly include notes; LI excludes.** "Notes as evidence the AI cites" requires changing the hand-rolled, media-shaped retrieval SQL in `app_search` and `oracle` to union page-owned chunks (with `used_semantic_media`→owner dedup) — it is **not** automatic. LI stays media-only (notes aren't library entries). Rejected: routing RAG/Oracle through `get_search_result` (different shape, would regress their tuned ranking).
- **D9 — Frontend needs a target-type union, not an href fallback.** `ReaderSourceTarget` requires `media_id` and returns `null` for note retrievals; a note/page `ReaderSourceTarget` variant + offset-aware activation is required so the `[N]` actually jumps (§5.7).
- **D10 — Forbid cross-block coalescing for notes.** Note locator anchor = `note_block_id`, so every chunk stays inside one block and every hit is citeable to a specific block. Rejected: a multi-block page selector (more contract, no benefit at note sizes).

---

## 13. Risks & mitigations

- **R1 — S0 media regression.** Wide `media_id`→owner rename. Mitigate: S0 is behavior-preserving; snapshot tests for media search/RAG (AC-7); land S0 alone first.
- **R2 — Orphaned index rows (no FK).** Mitigate: `delete_content_index` on every page/block delete (AC-4); negative test for orphans; backfill is idempotent.
- **R3 — Scope-port fidelity.** The graph-backed note scope SQL is intricate. Mitigate: explicit `kind`/`origin` allowlists; AC-6 ports the former object_search scope fixtures and adds citation-edge exclusion cases.
- **R4 — Index-lag UX.** A just-saved note isn't instantly searchable. Mitigate: small pages + worker latency = seconds; documented as uniform model; out-of-scope optimization is an inline lexical fast-path (rejected to avoid a second path).
- **R5 — Backfill volume.** Single user ⇒ trivial. Dedupe-keyed enqueue; worker drains.

---

## 14. Test plan (per `testing_standards.md`)

- **Migration tier:** `0141` up; owner columns/CHECKs/uniques present; `object_search_*` gone; constraint test for note evidence-span/owner integrity (AC-4).
- **Unit:** `build_page_indexable_blocks` ordering/offsets/locator; chunker over note blocks; `note_text` locator validator; scope SQL builders.
- **Integration (real PG, fixture embeddings):** AC-1..AC-6, AC-8; media snapshot parity AC-7; deletion/orphan AC-4; job idempotency + dedupe.
- **Browser/FE:** note citation render + `/notes/{block}` deep-link; notes search results unchanged shape.
- **Not run by default:** whole back-integration, e2e, csp (flagged like prior cutovers).
