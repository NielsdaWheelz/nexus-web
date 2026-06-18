# Oracle Corpus Library Hard Cutover

**Status:** IMPLEMENTATION IN PROGRESS - schema/runtime cutover in branch; release pending gates.
**Author altitude:** SME / staff.
**Type:** Hard cutover. No legacy runtime path, no fallback corpus, no dual-write, no compatibility resolver.
**Migration:** Yes - next Alembic revision at implementation time. Downgrade raises `NotImplementedError`.
**Supersedes / deletes:** Oracle as a parallel text/vector corpus: `oracle_corpus_works`, `oracle_corpus_passages`, their embeddings, direct Oracle passage vector retrieval, and `oracle_corpus_passage` as a runtime `ResourceRef` scheme.

## One-line

Make the Oracle public-domain corpus a real Nexus library containing real media, ingest and embed its text through the shared media/content-indexing substrate, keep only the Oracle-specific ritual layer above that substrate, and delete the old Oracle-owned corpus vector store.

## 1. SME thesis

The professional fix is not to repair the old Oracle seed script or tolerate a model mismatch. The defect is architectural: Oracle currently owns a second ingestion, corpus, embedding, readiness, and retrieval path for text that should be ordinary library media.

After this cutover:

- corpus text is stored as normal `media`;
- corpus membership is stored as normal `library_entries`;
- corpus embeddings live only in `content_embeddings`;
- corpus readiness is `content_index_states(owner_kind='media', owner_id=<media_id>)`;
- Oracle retrieval consumes the shared content-index/search substrate;
- Oracle keeps only its domain state: readings, folios, plate selection, phase semantics, prompt/synthesis, and stable passage-anchor identity where needed for concordance.

The important distinction:

- **Allowed Oracle-specific layer:** curated passage anchors, phase/tags, plate affinity, reading folios.
- **Deleted Oracle-specific layer:** authoritative corpus text, passage embeddings, query embedding code, direct vector search over Oracle-only tables.

## 2. Current state and problems

### 2.1 Parallel corpus tables

`python/nexus/db/models.py` currently defines:

- `OracleCorpusWork`
- `OracleCorpusPassage`
- `OracleCorpusImage`

The text corpus table stores `canonical_text`, `tags`, `embedding_model`, and a PGVector `embedding`. That is a second content-indexing system beside `content_blocks`, `content_chunks`, `content_embeddings`, `evidence_spans`, and `content_index_states`.

### 2.2 Parallel seed script

`scripts/oracle/build_corpus.py` reads local manifests, embeds passage text with `build_text_embeddings`, and inserts directly into Oracle corpus tables. It bypasses:

- `media_source_ingest.py`
- `media_source_attempts`
- EPUB/web article materializers
- `content_indexing.rebuild_content_index`
- `library_entries`
- normal search readiness repair

### 2.3 Parallel Oracle retrieval

`python/nexus/services/oracle.py` currently has:

- `_ensure_current_corpus_ready`
- `_build_query_embedding_for_model`
- `_retrieve_corpus_passages`
- `_retrieve_user_content_chunks_by_embedding`
- `_pick_plate`
- `_corpus_embedding_model`

These functions duplicate work already owned by `semantic_chunks`, `content_indexing`, `search`, and library visibility. They also create the exact production failure mode that motivated this cutover: the seeded corpus and runtime query can disagree about the active embedding model.

### 2.4 Resource identity drift

Oracle citations currently target `oracle_corpus_passage:<id>`. That target is stable for concordance, but it is stable because the passage table is the corpus. If we simply switch to `evidence_span:<id>`, concordance becomes fragile because evidence spans are regenerated on reindex. The correct final shape is a stable Oracle passage anchor that resolves to current media evidence. The anchor is identity and curation metadata, not a text/vector corpus.

### 2.5 Frontend/product split

The Oracle corpus is invisible as a normal library. The Browse pane can find Project Gutenberg works for acquisition, and the Libraries pane can show user libraries, but the Oracle corpus is not modeled as either. The user sees an Oracle feature backed by hidden seed data, not a normal corpus in the app.

## 3. Target behavior

### 3.1 User-visible behavior

1. The user has an **Oracle Corpus** library visible through the normal Libraries surface.
2. The Oracle Corpus library contains the public-domain corpus works as ordinary media entries.
3. The Browse pane may show a pinned "Oracle Corpus" shortcut, but the canonical object is the library, not a Browse-only feature.
4. Oracle readings retrieve public-domain candidates from the Oracle Corpus library and optional personal candidates from the user's visible library/media/note corpus.
5. Oracle readings cite sources through the shared citation/resource graph path.
6. Opening an Oracle citation jumps to the current media/evidence target when the anchor is resolved.
7. If corpus media are not ingested, indexed, or anchor-resolved, Oracle fails with a typed corpus-not-ready error. It never falls back to old tables, fixture files, stale embeddings, or source manifests.

### 3.2 Operator-visible behavior

1. A seed/repair command creates or repairs the Oracle Corpus library, media, library entries, plate objects, and passage anchors.
2. The command runs through the same ingestion/materialization/indexing services as ordinary media.
3. The command is idempotent by stable keys. Re-running it updates the current intended state or fails loudly on contradictory identity.
4. A readiness command reports:
   - corpus library id;
   - required work count;
   - media ingest status per work;
   - content index status per work;
   - anchor resolution status;
   - plate object status.
5. Production deploy is not considered complete until readiness passes.

## 4. Goals

- **G1. Real library.** The Oracle Corpus is a real `libraries` row with normal memberships and normal `library_entries`.
- **G2. Real media.** Each corpus work is represented by a real `media` row, preferably EPUB when an EPUB source exists.
- **G3. Shared ingestion.** Corpus source acquisition uses `media_source_ingest` and source-specific materializers; no script inserts text fragments, chunks, or embeddings directly.
- **G4. Shared embeddings.** Corpus text embeddings exist only in `content_embeddings`, keyed by `content_chunks`.
- **G5. Shared readiness.** Oracle corpus readiness is derived from `media.processing_status` plus `content_index_states`.
- **G6. Stable curation identity.** Oracle passage identity is a small anchor layer pointing at current media evidence, not a separate passage text/vector table.
- **G7. Shared retrieval primitives.** Oracle retrieval consumes shared content chunk retrieval/search utilities rather than maintaining Oracle-only vector SQL.
- **G8. ResourceRef cutover.** Delete `oracle_corpus_passage`; introduce `oracle_passage_anchor` as the stable public-domain citation/concordance identity.
- **G9. Plate cleanup.** Plate metadata remains Oracle-owned, but plate text embeddings are deleted. Plate selection uses selected anchors/tags deterministically unless a future general asset-embedding substrate exists.
- **G10. Hard delete.** Remove old Oracle corpus models, seed script writes, direct corpus embedding checks, old docs, tests, and frontend assumptions in the same cutover.

## 5. Non-goals

- **N1. Corpus versioning.** The app remains current-only. No corpus releases, no historical corpus replay.
- **N2. Backward-compatible refs.** No runtime support for `oracle_corpus_passage:<id>` after the cutover.
- **N3. A second index owner kind.** Do not add `owner_kind='oracle_corpus'`; corpus text is media-owned.
- **N4. Image media.** Oracle plates do not become library media in this cutover.
- **N5. Cross-encoder reranking.** Retrieval may reuse current hybrid retrieval and deterministic boosts. Reranking is a separate cutover.
- **N6. General public/system library platform.** Add only the minimum `libraries.system_key` semantics needed for the Oracle Corpus. Do not build a general marketplace/public-library platform here.
- **N7. Multi-user marketplace/public corpus sharing.** The one-user prototype can seed the corpus library for the owner. Multi-user public distribution is a future product decision.
- **N8. Lenient source scraping.** Seed manifests must name exact ingestable URLs or exact packaged source artifacts. No "try a landing page and hope" runtime path.
- **N9. Prompt redesign.** The Oracle prompt may receive better grounded candidates, but the voice/product design is not rewritten here.

## 6. Final ownership map

| Concern | Final owner | Contract |
|---|---|---|
| Library row, membership, mutability | `services/library_governance.py` | Oracle Corpus is a real library; no name-based special cases. |
| Library entries | `services/library_entries.py` | Sole writer for corpus media membership. |
| Source acceptance and attempts | `services/media_source_ingest.py` | Durable media/source-attempt record before fetch/materialization/indexing side effects. |
| EPUB/web/PDF extraction | Existing media source adapters | Corpus works use the same materializers as user media. |
| Text blocks/chunks/embeddings | `services/content_indexing.py` | No Oracle direct embedding rows. |
| Active embedding model/provider | `services/semantic_chunks.py` and `content_index_states` | No Oracle `_corpus_embedding_model`. |
| Search/retrieval SQL primitives | `services/search/*` | Oracle consumes or extracts shared chunk retrieval helpers. |
| Corpus seed/anchor mapping | New `services/oracle_corpus.py` | Idempotent orchestration and curation metadata only. |
| Readings/folios/SSE | `services/oracle.py` | Domain product and generation owner. |
| Plates | `services/oracle_plates.py` with renamed `oracle_plates` table | Public owned assets; no text embeddings. |
| Citations/concordance | `services/resource_graph/*` | Citation edges from `oracle_reading:<id>` to current target refs. |
| Browse shortcut | Browse frontend/backend only if needed | Discoverability, not corpus ownership. |

## 7. Final data model

### 7.1 Libraries

The Oracle Corpus must not be encoded by name. Add explicit identity and protection:

```sql
ALTER TABLE libraries
ADD COLUMN system_key text NULL;

ALTER TABLE libraries
ADD CONSTRAINT ck_libraries_system_key
CHECK (system_key IS NULL OR char_length(system_key) BETWEEN 1 AND 80);

CREATE UNIQUE INDEX uix_libraries_system_key
ON libraries(system_key)
WHERE system_key IS NOT NULL;
```

The Oracle Corpus row:

- `name = 'Oracle Corpus'`
- `system_key = 'oracle_corpus'`
- `is_default = false`
- `owner_user_id = <bootstrap/user owner>`
- owner has admin membership

System-library behavior:

- appears in `GET /libraries`;
- can be opened like any library;
- can be searched with `scope=library:<id>`;
- blocks user rename/delete/share/entry edits unless the service call is an explicit system maintenance command;
- never bypasses `library_entries`.

### 7.2 Corpus source mapping

Create a small table that maps curated corpus works to media:

```sql
CREATE TABLE oracle_corpus_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corpus_key text NOT NULL DEFAULT 'oracle',
  work_key text NOT NULL,
  library_id uuid NOT NULL REFERENCES libraries(id),
  media_id uuid NOT NULL REFERENCES media(id),
  title text NOT NULL,
  author_text text NOT NULL,
  source_repository text NOT NULL,
  source_url text NOT NULL,
  source_download_url text NOT NULL,
  source_media_kind text NOT NULL,
  display_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_oracle_corpus_sources_key CHECK (char_length(work_key) BETWEEN 1 AND 160),
  CONSTRAINT ck_oracle_corpus_sources_kind CHECK (source_media_kind IN ('epub','web_article','pdf')),
  CONSTRAINT uix_oracle_corpus_sources_work UNIQUE (corpus_key, work_key),
  CONSTRAINT uix_oracle_corpus_sources_media UNIQUE (media_id)
);
```

Rules:

- `media_id` is the authoritative source text owner.
- `source_download_url` must be directly ingestable. For Gutenberg use `.epub.noimages` or equivalent EPUB URL, not just the ebook landing page.
- This table stores provenance and corpus curation identity, not text chunks or embeddings.

### 7.3 Passage anchors

Create an anchor table for stable Oracle curation/concordance identity:

```sql
CREATE TABLE oracle_passage_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corpus_source_id uuid NOT NULL REFERENCES oracle_corpus_sources(id),
  passage_key text NOT NULL,
  display_label text NOT NULL,
  selector jsonb NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  phase_hints jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_evidence_span_id uuid NULL,
  current_content_chunk_id uuid NULL,
  resolution_status text NOT NULL DEFAULT 'pending',
  resolution_error text NULL,
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uix_oracle_passage_anchors_key UNIQUE (corpus_source_id, passage_key),
  CONSTRAINT ck_oracle_passage_anchors_selector CHECK (jsonb_typeof(selector) = 'object'),
  CONSTRAINT ck_oracle_passage_anchors_tags CHECK (jsonb_typeof(tags) = 'array'),
  CONSTRAINT ck_oracle_passage_anchors_phase_hints CHECK (jsonb_typeof(phase_hints) = 'array'),
  CONSTRAINT ck_oracle_passage_anchors_status
    CHECK (resolution_status IN ('pending','resolved','failed'))
);
```

Anchor rules:

- Anchor `id` is stable Oracle identity.
- `selector` is a deterministic locator into the media source, for example text quote plus prefix/suffix and optional EPUB CFI/chapter path.
- `current_evidence_span_id` and `current_content_chunk_id` are current-index pointers and may change after media reindex.
- current pointers deliberately do not have FKs: evidence/chunk rows are regenerated during reindex, and these cache pointers must not block `content_indexing.delete_content_index`.
- readiness validation must prove the current pointer rows exist, are ready, and are owned by the mapped `media_id`.
- A resolved anchor must point to content owned by the mapped `media_id`.
- A failed anchor makes the corpus not ready.
- Anchor text may appear in selectors as a quote for resolution, but embeddings and retrieval never use anchor-owned vectors.

### 7.4 Plates

Rename the plate table to match final ownership:

- `oracle_corpus_images` -> `oracle_plates`
- model `OracleCorpusImage` -> `OraclePlate`
- drop `embedding_model`
- drop `embedding`
- keep storage metadata, dimensions, artist, attribution, source URL, tags

Plate selection contract:

- selected from `oracle_plates`;
- requires existing storage object and safe dimensions;
- scores by deterministic overlap with selected passage anchor tags, phase hints, work keys, and question tokens;
- no text embedding path until a general asset embedding subsystem exists.

### 7.5 Dropped tables and columns

Drop:

- `oracle_corpus_works`
- `oracle_corpus_passages`
- `oracle_corpus_passages.embedding`
- `oracle_corpus_passages.embedding_model`
- `oracle_corpus_images.embedding`
- `oracle_corpus_images.embedding_model`

Delete the SQLAlchemy models and schemas for the old corpus tables. Do not leave an unused model "for old readings".

## 8. Resource and capability contract

### 8.1 Resource schemes

Final schemes:

- keep `oracle_reading`;
- delete `oracle_corpus_passage`;
- add `oracle_passage_anchor`.

`oracle_passage_anchor:<id>` means "a curated Oracle passage identity that resolves to current indexed media evidence." It does not mean "a separately stored passage document."

### 8.2 Capabilities

`oracle_passage_anchor` capability decisions:

| Capability | Decision |
|---|---|
| citable output target | yes |
| readable body | yes, by resolving to current media/evidence |
| openable/routable | yes, through resolved media reader target |
| searchable scope | no, search the Oracle Corpus library instead |
| attachable to chat | no in this cutover |
| chat subject | no |
| inspectable | no, inspect the backing media |
| linkable graph target | yes for citation/backlink graph |

If an anchor is unresolved, activation fails closed with a typed not-ready/not-found error. It does not show stale manifest text.

### 8.3 Citation target policy

Oracle readings cite:

- `oracle_passage_anchor:<id>` for curated public-domain corpus candidates;
- `evidence_span:<id>` or `content_chunk:<id>` for personal library/note candidates.

Folio display uses the citation edge snapshot for the exact snippet/label shown at generation time. Navigation uses current resolvers.

### 8.4 Concordance

Concordance uses `resource_graph.citations.concordant_sources` over citation edges:

- public-domain corpus matches by `oracle_passage_anchor:<id>`;
- personal media matches by `evidence_span` / `content_chunk`;
- plate/theme matches use folio/plate metadata.

No Oracle-private concordance SQL over old passage tables remains.

## 9. Ingestion and seed contract

### 9.1 Manifest v2

Replace `scripts/oracle/manifest_works.json` with a manifest that describes media ingestion and anchors:

```json
{
  "work_key": "dante-divine-comedy",
  "title": "The Divine Comedy",
  "author_text": "Dante Alighieri",
  "source_repository": "Project Gutenberg",
  "source_url": "https://www.gutenberg.org/ebooks/1001",
  "source_download_url": "https://www.gutenberg.org/ebooks/1001.epub.noimages",
  "source_media_kind": "epub",
  "display_order": 10,
  "passage_anchors": [
    {
      "passage_key": "inferno-canto-1-dark-wood",
      "display_label": "Inferno I",
      "selector": {
        "kind": "text_quote",
        "exact": "...",
        "prefix": "...",
        "suffix": "..."
      },
      "tags": ["threshold", "lostness"],
      "phase_hints": ["descent"]
    }
  ]
}
```

Rules:

- every work has a direct ingest URL or packaged source artifact;
- every anchor has a stable `passage_key`;
- every anchor selector resolves against the indexed media text after ingest;
- manifest tags are Oracle metadata, not user graph tags.

### 9.2 Seed service

Add `services/oracle_corpus.py` with public commands:

- `ensure_oracle_corpus_library(db, owner_user_id) -> OracleCorpusLibraryState`
- `ensure_oracle_corpus_media(db, owner_user_id, manifest) -> OracleCorpusSeedResult`
- `resolve_oracle_passage_anchors(db, corpus_key='oracle') -> AnchorResolutionResult`
- `get_oracle_corpus_readiness(db, viewer_id) -> OracleCorpusReadiness`

The service may call `media_source_ingest` and `library_entries`; it must not:

- insert `content_blocks`;
- insert `content_chunks`;
- insert `content_embeddings`;
- insert `library_entries` directly;
- call `build_text_embeddings` for corpus passages.

### 9.3 Seed script

Replace `scripts/oracle/build_corpus.py` with a command such as:

```bash
cd python
uv run python ../scripts/oracle/seed_corpus_library.py --owner-user <user-id>
uv run python ../scripts/oracle/check_corpus_readiness.py
```

The seed command:

1. ensures the Oracle Corpus library;
2. accepts or reuses each media source;
3. assigns media to the Oracle Corpus library via `library_entries`;
4. runs or waits for source materialization/indexing in an explicit operator mode;
5. upserts source mappings and anchors;
6. resolves anchors to current evidence/chunks;
7. validates plate objects;
8. exits non-zero unless the corpus is ready.

### 9.4 Idempotency

Stable keys:

- library: `libraries.system_key = 'oracle_corpus'`;
- work: `(corpus_key, work_key)`;
- media: normalized source URL plus owner/library intent or explicit source mapping;
- anchor: `(corpus_source_id, passage_key)`;
- plate: stable plate key/source URL.

Conflicts:

- same `work_key` pointing at a different media/source URL is a hard error unless the command is explicitly run in a replacement mode;
- same anchor key with a different selector is a hard error unless replacement mode is explicit;
- replacement mode re-resolves anchors and invalidates old current pointers in one transaction.

## 10. Retrieval architecture

### 10.1 Query embedding

Oracle must delete `_build_query_embedding_for_model` and consume the shared embedding path:

- `services/search/embedding.py`;
- otherwise extract the shared query embedding helper from search into that module.

The embedding model/provider/dimensions are the active search/content-index contract. Oracle never asks for a separate corpus embedding model.

### 10.2 Shared content chunk retrieval

Consolidate repeated "visible ready chunks with active embeddings" SQL.

Current repeated patterns include:

- `search/retrievers/library_content.py` content chunk retrieval;
- `oracle.py:_retrieve_user_content_chunks_by_embedding`;
- app-search content chunk rendering/empty probes;
- any LI/media-intelligence inventory chunk probes.

Create or adapt a shared primitive, for example:

```python
retrieve_content_chunk_candidates(
    db,
    viewer_id,
    query_embedding,
    scope,
    owner_filter,
    limit,
) -> list[ContentChunkCandidate]
```

Requirements:

- reads `content_index_states`;
- requires active provider/model match;
- supports scope `library:<id>`;
- supports media-owned chunks;
- supports note-block-owned chunks where existing product policy includes notes;
- returns enough locator/source data to build `ResourceRef` citations;
- does not know Oracle phases or plates.

### 10.3 Corpus candidate retrieval

Oracle corpus candidate retrieval becomes:

1. resolve Oracle Corpus library id;
2. run shared chunk retrieval scoped to that library;
3. join or map results to resolved `oracle_passage_anchors`;
4. boost by tag/phase/question-token overlap;
5. select phase-balanced candidates, with one-per-work or similar Oracle-domain policy;
6. produce `_Candidate` objects targeting `oracle_passage_anchor:<id>`.

The direct SQL over `oracle_corpus_passages.embedding` is deleted.

### 10.4 Personal library retrieval

Personal retrieval also uses the shared chunk retrieval primitive. Delete Oracle's private `_retrieve_user_content_chunks_by_embedding` SQL. Keep Oracle's product-level candidate policy, such as limiting the number of personal candidates and balancing against public-domain candidates.

### 10.5 Reading admission and worker readiness

`create_reading` may continue to accept and enqueue immediately, but the worker must check corpus readiness before generation.

Readiness checks:

- Oracle Corpus library exists;
- required source rows exist;
- every source media row is readable or terminally ready for reading according to media capability policy;
- every source media row has ready `content_index_states` for the active embedding model/provider;
- every required anchor is resolved;
- plate rows and storage objects are valid.

Failure:

- expected not-ready state raises a typed `E_ORACLE_CORPUS_NOT_READY`;
- operational details go to logs/telemetry;
- frontend copy may say the reading could not be completed, but backend status must preserve the typed cause.

## 11. API design

### 11.1 Existing Oracle reading API

Keep the user-facing write contract:

- `POST /oracle/readings`
- `GET /oracle/readings`
- `GET /oracle/readings/{id}`
- `GET /oracle/readings/{id}/concordance`
- `GET /oracle/plates/{id}`

The response shape may change citation target refs and source kind labels, but no old Oracle corpus passage URI is accepted.

### 11.2 Corpus discovery/status API

Add a read-only endpoint so frontend surfaces can link to and inspect the corpus library without name matching:

- FastAPI: `GET /oracle/corpus`
- Next BFF: `GET /api/oracle/corpus`

Response:

```json
{
  "library_ref": "library:<uuid>",
  "library_id": "<uuid>",
  "status": "ready",
  "work_count": 12,
  "ready_media_count": 12,
  "anchor_count": 48,
  "resolved_anchor_count": 48,
  "plate_count": 12,
  "ready_plate_count": 12
}
```

Rules:

- read-only;
- no source repair from request handlers;
- no seed-on-read;
- visible only to authenticated viewer unless product explicitly chooses a public corpus endpoint.

### 11.3 Library API

Because `libraries.system_key` lands, library schemas expose enough for UI policy:

- `is_system: bool` or `system_key: str | None`;
- `can_rename`;
- `can_delete`;
- `can_edit_entries`.

Do not make UI infer system status from the name `Oracle Corpus`.

### 11.4 Browse pane composition

Browse may show a pinned shortcut:

- label: `Oracle Corpus`;
- target resource: `library:<id>`;
- route: normal library activation;
- source: `GET /api/oracle/corpus` or a future resource discovery endpoint.

Browse must not own corpus membership, seed state, or Oracle readiness.

## 12. Frontend final state

### 12.1 Oracle reading UI

Update Oracle citation rendering to handle:

- `oracle_passage_anchor` refs;
- media/evidence target activation from `CitationOut`;
- no `oracle_corpus_passage` display path.

The frontend should treat citation data like other resource citations. Avoid parsing Oracle-only deep-link strings when the backend already returns citation/read-target metadata.

### 12.2 Libraries

The Oracle Corpus appears in:

- `/libraries`;
- `/libraries/<id>`;
- resource activation/search surfaces that already understand `library:<id>`.

It is system-protected:

- hide or disable rename/delete/share/edit-entry actions with backend-backed capability fields;
- keep visual styling normal. It is a library, not a marketing landing page.

### 12.3 Browse

Optional pinned shortcut only. No new Browse result type unless the Browse API already has a generic library resource row pattern. Prefer reusing shared `ResourceRow`/activation patterns over adding Oracle-only buttons.

## 13. Composition with other systems

### 13.1 Media ingestion

Oracle corpus ingest composes with durable source ingest:

- acceptance before fetch;
- source attempts record retry/failure;
- extraction and indexing are normal media lifecycle steps;
- post-success indexing runs through existing PDF/EPUB/web article indexers.

No Oracle script may call an EPUB parser and then insert fragments/chunks outside the media pipeline.

### 13.2 Search

Oracle becomes another retrieval consumer of the shared search/content chunk substrate. If Oracle needs a lower-level candidate API than `search()`, extract it from search retrievers rather than copying SQL in `oracle.py`.

### 13.3 Chat / app_search

`app_search` remains a chat tool. Oracle should not call the chat tool directly, because that would mix chat telemetry/tool semantics into Oracle generation. Both should share lower-level retrieval primitives.

### 13.4 Library Intelligence

Library Intelligence should see the Oracle Corpus as a normal library if the user explicitly runs LI on that library. LI should not consume Oracle anchors or plate metadata unless a separate product decision makes Oracle curation part of LI.

### 13.5 Resource graph

Citation edges remain the single durable citation/concordance substrate. Oracle does not get a private citation table. Any new `oracle_passage_anchor` scheme must be added to:

- backend `ResourceScheme`;
- strict parser;
- resolver;
- capability registry;
- route activation;
- frontend resource-kind/icon maps;
- tests that assert every scheme has explicit capabilities.

### 13.6 Storage

Oracle plates remain public owned assets under `oracle/plates/...`. Corpus source files use normal media storage paths and media asset rules. Do not route corpus text through Oracle plate storage.

### 13.7 Jobs

Oracle corpus seeding may enqueue media source jobs and wait for their completion in operator scripts. Oracle reading jobs do not repair the corpus. They only check readiness and generate or fail typed.

### 13.8 Provider/model runtime

Embedding provider/model selection remains owned by `semantic_chunks` and the content index. Oracle generation model/provider remains owned by the LLM generation harness. These are separate concerns.

## 14. Hard cutover rules

1. No code path reads `oracle_corpus_passages` after cutover.
2. No code path writes `oracle_corpus_passages` after cutover.
3. No runtime accepts `oracle_corpus_passage:<id>`.
4. No Oracle function calls `build_text_embedding` or `build_text_embeddings` for corpus retrieval.
5. No Oracle table contains a PGVector text embedding.
6. No direct `library_entries` DML outside `library_entries.py`.
7. No direct content-index row DML outside `content_indexing.py` except migrations/tests.
8. No seed-on-request.
9. No source-manifest fallback when anchors fail to resolve.
10. No name-based library policy.
11. No old frontend branch for old citation refs.
12. No compatibility test that proves old refs still work.

## 15. Duplications to consolidate

| Duplication today | Final consolidation |
|---|---|
| Oracle passage embeddings vs `content_embeddings` | Delete Oracle embeddings; corpus uses `content_embeddings`. |
| Oracle `_build_query_embedding_for_model` vs search/semantic embedding helpers | Delete Oracle helper; consume shared query embedding. |
| Oracle `_retrieve_corpus_passages` vs search content chunk retrieval | Replace with shared chunk retrieval scoped to Oracle Corpus library plus anchor mapping. |
| Oracle `_retrieve_user_content_chunks_by_embedding` vs search/app_search chunk SQL | Extract shared retrieval primitive; Oracle consumes it. |
| `oracle_corpus_works` provenance vs media source metadata | Keep only source mapping table that points at media. |
| `oracle_corpus_images` text embeddings vs plate metadata | Rename to `oracle_plates`; delete embeddings. |
| Browse special discovery vs library/resource routing | Browse links to `library:<id>` through shared activation. |
| Resource scheme lists repeated backend/frontend | Update all existing repeated scheme surfaces together; add a negative alignment test if missing. |

## 16. Implementation slices

### S0 - Contract inventory and negative gates

Add source-scanning gates before large edits:

- forbid `oracle_corpus_passage` outside the cutover spec and migration notes;
- forbid `OracleCorpusPassage`;
- forbid `OracleCorpusWork`;
- forbid `oracle_corpus_passages`;
- forbid `oracle_corpus_works`;
- forbid Oracle corpus calls to `build_text_embedding`;
- forbid `embedding_model` / `embedding` on Oracle plate/corpus tables.

These gates may be introduced with temporary allowlists only inside the active slice. Before final merge, allowlists are removed.

### S1 - Schema cutover

Migration:

- add `libraries.system_key`;
- create `oracle_corpus_sources`;
- create `oracle_passage_anchors`;
- rename `oracle_corpus_images` to `oracle_plates`;
- drop plate embedding columns;
- migrate existing `oracle_corpus_works/passages` into source/anchor rows if the data can be mapped;
- rewrite existing resource edges from `oracle_corpus_passage` to `oracle_passage_anchor` if historical readings are retained;
- drop old corpus work/passage tables;
- update SQLAlchemy models.

No downgrade. If an old passage cannot map to a new anchor, the migration or one-time prep command fails. No runtime compatibility resolver.

### S2 - Corpus ingest/seed service

Build the `oracle_corpus.py` service and scripts:

- ensure system corpus library;
- accept/reuse source media;
- assign entries through `library_entries`;
- run/wait for materialization/indexing in operator mode;
- upsert source mappings and anchors;
- resolve anchors;
- validate readiness.

Delete direct text/vector writes from the old seed script.

### S3 - Shared retrieval extraction

Extract the reusable chunk retrieval primitive from search/app_search/Oracle duplication.

Requirements:

- media library scope;
- active embedding model/provider;
- ready `content_index_states`;
- owner-aware dedupe;
- enough source/citation data for Oracle and chat.

Refactor Oracle personal-library retrieval to use it first, then corpus retrieval.

### S4 - Oracle corpus retrieval cutover

Rewrite Oracle public-domain candidate retrieval:

- resolve Oracle Corpus library;
- retrieve candidates through shared index;
- map to `oracle_passage_anchors`;
- apply Oracle phase/tag/work balancing;
- cite anchors.

Delete:

- `_ensure_current_corpus_ready` old table counts;
- `_retrieve_corpus_passages`;
- `_corpus_embedding_model`;
- corpus embedding mismatch errors.

Replace with new readiness checks over library/media/index/anchor/plate state.

### S5 - Plate cutover

Rename model/table/service references:

- `OracleCorpusImage` -> `OraclePlate`;
- `oracle_corpus_images` -> `oracle_plates`.

Delete text embedding plate selection. Add deterministic plate scoring from selected candidate metadata.

### S6 - Resource graph/capabilities/frontend refs

Delete `oracle_corpus_passage` scheme and add `oracle_passage_anchor`.

Update:

- `resource_graph/refs.py`;
- `resource_graph/resolve.py`;
- `resource_items/capabilities.py`;
- `resource_items/routing.py`;
- schemas and citation output;
- frontend resource kind/icon/activation maps;
- Oracle reading citation rendering tests.

### S7 - Library/Browse UI

Expose Oracle Corpus as a normal library.

Because system library metadata lands:

- show read-only capabilities from backend;
- disable or hide unsupported mutations;
- add backend tests for mutation rejection.

Add optional Browse shortcut using `library:<id>` activation.

### S8 - Docs/tests/deletion pass

Update:

- `docs/architecture.md`;
- `docs/modules/oracle.md`;
- `docs/modules/library.md`;
- `docs/modules/storage.md`;
- any cutover docs that still claim Oracle corpus passages remain final-state citation targets.

Run negative gates and delete all dead tests that only preserve old behavior.

## 17. Acceptance criteria

### Global

- **AC-G1.** `rg "oracle_corpus_passage|OracleCorpusPassage|oracle_corpus_passages|OracleCorpusWork|oracle_corpus_works"` returns no production references outside migration/spec history.
- **AC-G2.** No Oracle table has a PGVector text embedding column.
- **AC-G3.** Oracle reading generation succeeds when the Oracle Corpus library media are indexed and anchors resolved.
- **AC-G4.** Oracle reading generation fails with `E_ORACLE_CORPUS_NOT_READY` when a required corpus media index is missing or an anchor is unresolved.
- **AC-G5.** Corpus text embeddings are present in `content_embeddings` for media-owned chunks, with active model/provider from `content_index_states`.
- **AC-G6.** The Oracle Corpus library appears in library APIs and can be opened through normal library UI.
- **AC-G7.** Search scoped to the Oracle Corpus library returns its media/chunks like any other library.
- **AC-G8.** Oracle citations use `oracle_passage_anchor`, `evidence_span`, or `content_chunk`; never `oracle_corpus_passage`.
- **AC-G9.** Concordance over two readings that cite the same anchor returns a match.
- **AC-G10.** Reindexing corpus media updates anchor current pointers; future readings still cite the same stable anchor identities.
- **AC-G11.** Plate rendering still uses `/api/oracle/plates/<id>` and validates storage-backed public owned assets.
- **AC-G12.** Browse shortcut, if added, opens the real library and does not create a parallel Oracle browse view.

### Migration/data

- **AC-M1.** Migration creates new tables/columns and drops old Oracle corpus work/passage tables.
- **AC-M2.** Migration is irreversible by design.
- **AC-M3.** Existing reading citation edges are either migrated to anchors or deliberately deleted by a one-time operator decision. No runtime old-ref support remains.
- **AC-M4.** Seed command exits non-zero if any required work cannot ingest, index, or resolve anchors.
- **AC-M5.** Re-running seed command is idempotent for unchanged manifest.

### Backend tests

- **AC-B1.** Unit test: corpus readiness derives from library/media/index/anchor/plate state.
- **AC-B2.** Integration test: seed fixture creates library, media entries, ready index states, resolved anchors.
- **AC-B3.** Integration test: Oracle retrieval queries shared content-index data and produces anchor citations.
- **AC-B4.** Integration test: embedding model mismatch is handled by normal content index readiness, not Oracle corpus-specific checks.
- **AC-B5.** Resource graph test: `oracle_passage_anchor` parser, resolver, capability, route activation, and citation read model are explicit.
- **AC-B6.** Library governance test: system corpus library mutations are rejected.
- **AC-B7.** Search test: `scope=library:<oracle_library_id>` returns corpus chunks through normal search.

### Frontend tests

- **AC-F1.** Library list/detail renders Oracle Corpus.
- **AC-F2.** Oracle reading citation chips render and activate from backend citation data.
- **AC-F3.** Browse shortcut opens the library if shortcut ships.
- **AC-F4.** Old `oracle_corpus_passage` refs are not accepted by frontend parsers.

### Operational

- **AC-O1.** Production runbook includes seed/readiness commands.
- **AC-O2.** Prod readiness check proves every required corpus media row has ready content index state with active embedding model/provider.
- **AC-O3.** Prod readiness check proves every required anchor is resolved.
- **AC-O4.** Prod readiness check proves every plate object exists and is safe.

## 18. Test plan

Focused suites:

- `python -m pytest tests/test_oracle.py`
- `python -m pytest tests/test_oracle_plate_route.py`
- `python -m pytest tests/test_search*.py -k "library or content_chunk or scope"`
- migration tests for the new Alembic revision
- resource graph/capability tests
- library governance/entries tests
- frontend unit/browser tests for Libraries, Browse shortcut, Oracle reading citations

Real-media gate:

- `make test-real-media` or the smallest deterministic real-media shard that ingests an EPUB, indexes it, searches it, and generates an Oracle fixture reading against it.

Negative gates:

```bash
rg -n "oracle_corpus_passage|OracleCorpusPassage|oracle_corpus_passages|OracleCorpusWork|oracle_corpus_works" \
  python apps docs scripts e2e

rg -n "_retrieve_corpus_passages|_corpus_embedding_model|Oracle source corpus is not fully seeded|passage_embeddings|image_embeddings" \
  python scripts
```

The final gate allows only this spec, migration comments, and historical changelog references.

## 19. Key decisions

- **D1. Corpus text is media.** No `owner_kind='oracle_corpus'`; no separate corpus chunks.
- **D2. Corpus membership is library membership.** Use `library_entries`; no Oracle-private membership table.
- **D3. Stable passage identity is an anchor, not a corpus passage table.** It resolves to media/evidence and stores curation metadata only.
- **D4. Delete `oracle_corpus_passage`.** The old name encoded the old architecture. Use `oracle_passage_anchor` for stable public-domain passage identity.
- **D5. Use shared retrieval primitives, not `app_search`.** Oracle and chat share lower-level retrieval, but Oracle does not call the chat tool.
- **D6. Plates stay Oracle-owned assets.** Do not force image media until a general image-media product exists.
- **D7. Plate embeddings are deleted.** Deterministic tag/phase scoring is sufficient and avoids a second model-readiness lane.
- **D8. System library semantics must be explicit.** `libraries.system_key` is the policy handle; no hidden name checks.
- **D9. Browse is discovery only.** Canonical corpus surface is the library.
- **D10. No runtime compatibility.** Historical data migration is allowed; old runtime parsing/resolution is not.

## 20. File inventory

### New

- `python/nexus/services/oracle_corpus.py`
- `scripts/oracle/seed_corpus_library.py`
- `scripts/oracle/check_corpus_readiness.py`
- new Alembic migration
- new tests for corpus seed/readiness/anchor resolution

### Modified

- `python/nexus/db/models.py`
- `python/nexus/services/oracle.py`
- `python/nexus/services/oracle_plates.py`
- `python/nexus/services/media_source_ingest.py` only if a system-source acceptance helper is required
- `python/nexus/services/library_governance.py`
- `python/nexus/services/library_entries.py` only through public API use or system-entry command if needed
- `python/nexus/services/search/*`
- `python/nexus/services/resource_graph/refs.py`
- `python/nexus/services/resource_graph/resolve.py`
- `python/nexus/services/resource_items/capabilities.py`
- `python/nexus/services/resource_items/routing.py`
- `python/nexus/schemas/oracle.py`
- `python/nexus/schemas/library.py`
- `python/nexus/api/routes/oracle.py`
- `apps/web/src/app/(authenticated)/libraries/**`
- `apps/web/src/app/(authenticated)/browse/**` if shortcut ships
- `apps/web/src/app/(oracle)/**`
- `apps/web/src/lib/resources/**`
- `docs/architecture.md`
- `docs/modules/oracle.md`
- `docs/modules/library.md`
- `docs/modules/storage.md`

### Deleted or replaced

- old `scripts/oracle/build_corpus.py` text/vector corpus writes
- `OracleCorpusWork`
- `OracleCorpusPassage`
- `oracle_corpus_works`
- `oracle_corpus_passages`
- `oracle_corpus_passage` resource scheme
- Oracle corpus passage embedding readiness checks
- Oracle direct passage vector retrieval
- Oracle plate text embedding selection

## 21. Open implementation questions

These are implementation decisions, not blockers to the architecture:

1. Should historical Oracle readings be migrated to anchors, or is deleting/regenerating old readings acceptable under the no-backward-compat instruction?
2. Should corpus seed wait synchronously for media jobs, or enqueue then require a separate readiness/drain command?
3. What exact selector format should anchors use for EPUBs: text quote only, EPUB CFI plus text quote, or chapter path plus quote?
4. Which existing search retrieval helper is the best extraction point for shared chunk candidate retrieval?

The SME default answers:

1. Migrate historical readings when anchors map cleanly; otherwise abort the cutover rather than ship a compatibility resolver.
2. Use enqueue plus operator drain/readiness commands; do not do heavy work in Alembic.
3. Use EPUB CFI/chapter path when available plus text quote/prefix/suffix for drift detection.
4. Extract from `search/retrievers/library_content.py` and delete Oracle's copy.
