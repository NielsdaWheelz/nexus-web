# Current-only artifacts hard cutover

## Status

Implemented in `/home/niels/src/personal/nexus-web-current-only` on 2026-06-05.
This document records the target contract and acceptance checklist.

This is the hard cutover contract. The final implementation removes app-level
versions, revisions, source versions, content hashes, content fingerprints, and
runtime compatibility lanes from readable media, transcripts, search evidence,
citations, generated library intelligence, Oracle corpus data, notes, and the
frontend contracts that consume them.

Existing production data is handled by destructive one-time migrations and
repair commands. No permanent code path accepts both the old and new shapes.

## Summary

Nexus is a one-user prototype. It does not need to preserve alternate historical
versions of readable content, transcripts, generated intelligence, indexed
evidence, or source-derived projections. The target state is:

- one current readable artifact per media item,
- one current transcript per transcript-bearing media item,
- one current search/evidence projection per media item,
- one current generated intelligence artifact per library and artifact kind,
- one current Oracle corpus,
- one current note document shape,
- raw source preserved where it already exists,
- no app-level hashes, fingerprints, revisions, or version labels used as
  product identity,
- no API fields whose only job is to carry version/provenance identity,
- no frontend fallback that fabricates a version-like value.

The product tradeoff is explicit: source replacement can invalidate old reader
positions, highlights, search evidence, and chat citation jumps. That is
acceptable for this prototype. Historical reproducibility is not a goal.

## SME framing

A subject matter expert would not start by asking which columns named
`version` can be dropped. The expert question is:

> Which user-visible capability truly needs historical identity, and which
> tables are only preserving old projections because the system grew around
> replayable evidence?

For this product, the answer is current-only. The source of truth is the current
row set, not a durable chain of artifact releases. If a source is reprocessed,
the app replaces the current projection. If an old locator no longer resolves,
the app fails closed rather than replaying an old snapshot or guessing.

The highest-layer fix is therefore not a local rename from `source_version` to
`source_fingerprint`. It is a domain contract change:

- source lifecycle owns raw accepted inputs,
- current-content publishing owns readable artifacts and dependent cleanup,
- retrieval/search owns current evidence only,
- chat stores what happened in the run but does not own source replay,
- frontend contracts consume current locators and IDs only.

## Codebase rules that govern the cutover

This plan follows the repo rules in `docs/rules/`:

- `cleanliness.md`: delete compatibility shims, migration-era branches, stale
  names, version suffixes, duplicate validators, and tests that only preserve
  dead formats.
- `layers.md`: BFF routes and FastAPI routes stay transport-only; services own
  business logic.
- `module-apis.md`: expose each capability through one primary contract.
- `database.md`: table constraints encode the remaining invariants; no
  speculative indexes or duplicate state.
- `correctness.md`: make illegal states unrepresentable and fail loudly on
  defects.
- `concurrency.md`: keep real concurrent behavior correct, but do not preserve
  multi-version history only to avoid making an ownership decision.

## Scope

In scope:

- podcast and video transcript versions,
- web article, EPUB, PDF, transcript content indexing,
- source snapshots and content index runs,
- search result and retrieval citation `source_version` contracts,
- frontend SSE citation/search/media reader `source_version` types and guards,
- PDF extraction and highlight version/fingerprint fields,
- note page and note block revisions,
- original PDF/EPUB file byte hashes and file-hash upload dedupe,
- extracted EPUB resource byte hashes and immutable content-hash caching,
- object search hashes and index versions,
- library intelligence source-set and artifact versions,
- Oracle corpus versions and prompt versions,
- chat prompt block/provider request hashes and provider prompt-cache keys,
- message document schema version markers,
- app-level content hash/fingerprint/checksum fields that exist to identify
  source-derived artifacts,
- docs and tests that describe or enforce the old model.

Out of scope:

- raw source preservation, including original media files and accepted source
  attempt payloads,
- authentication, token, password, secret, and signed-code hashing,
- idempotency, rate-limit, advisory-lock, health-contract, privacy-safe query,
  and external release checksum digests that do not identify Nexus artifacts,
- provider protocol requirements that are not Nexus artifact identity,
- ordinary primary keys,
- timestamps used for display, ordering, scheduling, and job telemetry,
- third-party package versions, dependency lockfiles, Alembic revision filenames,
  and API/provider versions outside Nexus product data.

Security, credential, idempotency, privacy, advisory-lock, health-contract, and
external release checksum hashing is not optional cleanup. These are different
classes of invariant and must remain unless their owning systems are redesigned.

## Allowed Non-Artifact Identity

| Category | Owner | Examples | Forbidden adjacency |
|---|---|---|---|
| Credentials and auth secrets | `crypto.py`, `user_keys.py`, auth/session services | API-key fingerprints, extension token hashes, PKCE challenges | Must not double as media, source, prompt, or evidence identity. |
| Request control | idempotency, rate-limit, advisory-lock services | chat-run idempotency keys, rate-limit keys, advisory-lock projections | Must not persist as artifact provenance or reader/citation fields. |
| Privacy-safe observability | search/tool logging owners | normalized query digests for logs | Must not identify stored source text or readable artifacts. |
| Health and deployment contracts | job/deploy owners | worker capability fingerprints, external release checksums | Must not affect product data identity. |
| Private route/cache metadata | asset/image route owners | route-local cache validators, opaque ETags | Must be derived response metadata only; no DB content-hash identity or dedupe. |
| Third-party protocol requirements | provider/client owners | provider API versions, package/dependency versions | Must stay at the integration boundary and not become Nexus artifact versions. |

## Non-goals

- No historical transcript browsing.
- No historical readable-document browsing.
- No ability to replay a citation against old source text after replacement.
- No ability to reproduce an old Oracle reading against an old corpus.
- No ability to compare generated library intelligence artifacts over time.
- No compatibility response fields for old frontend builds.
- No migration-time branch that remains callable after the cutover.
- No silent fallback from missing current evidence to raw source, old snapshots,
  fabricated IDs, hashes, or stored snippets.
- No content hashes/fingerprints as replacement identity.

## Product decisions

### Current-only means destructive replacement

When a source is reprocessed, refreshed, retranscribed, or replaced, Nexus
destroys the dependent current artifacts first or replaces them atomically in
the same owner command. The old content is not queryable.

### Raw source is not current identity

Raw source can remain for retry, inspection, and reprocessing. It must not be
used as an alternate reader or citation source when current artifacts are gone.

### Citations are not replay guarantees

Chat retrieval rows may keep snippets and locators from the run as chat audit
metadata. They do not guarantee a future reader jump after source replacement.
Current reader navigation resolves against the current document only.

### Highlights are current-source artifacts

Highlights belong to the current readable artifact. If the artifact is replaced
and anchors cannot be safely kept by the same current owner command, the
highlights are deleted. There is no preserve-anchor transcript lane.

### Notes accept last-write-wins

This prototype does not preserve note revision tokens. Page and block writes are
last-write-wins within the single-user product. If collaborative editing returns
later, it must be introduced as a new explicit edit-session/concurrency
capability, not by reviving generic `revision` columns.

### Generated intelligence is current presentation

Library intelligence and Oracle readings are current generated presentation, not
durable release artifacts. Builds and events may remain as operational logs, but
they do not define addressable artifact versions.

## Target behavior

### Media source ingest

The durable source-ingest contract from
`docs/cutovers/durable-source-ingest-hard-cutover.md` remains:

1. Accept a valid source intent.
2. Create a visible `media` row and `media_source_attempts` row.
3. Preserve raw source or source reference when available.
4. Run source-specific acquisition and extraction after acceptance.
5. Publish one current readable artifact.
6. Publish one current search/evidence projection.
7. Mark media ready or failed.

The source attempt is an ingest lifecycle record, not a document version.

Uploaded and remotely fetched files are validated by declared byte size, storage
metadata size, and file signature. The system does not compute or persist a
content hash for media identity. Uploading the same bytes twice creates two
current media rows unless a separate canonical source-owner rule, such as URL or
provider identity, intentionally collapses them.

### Web article

For a web article:

- current render fragments are keyed by `media_id` and `idx`,
- current fragment blocks are keyed by current fragment IDs,
- current navigation and reader sections come from those rows,
- source replacement deletes prior fragments, fragment blocks, highlights,
  reader state, current evidence rows, and current chunks before publishing the
  new current artifact,
- no `source_version_for_web_article` exists,
- no canonical-text hash or structure hash exists as artifact identity,
- search and citations carry current locator data only.

### EPUB

For an EPUB:

- the extracted package, TOC, nav locations, fragment sources, resources, and
  fragments are the current artifact for that `media_id`,
- replacement deletes the old current EPUB extraction rows, private extracted
  resource rows, highlights, reader state, current evidence rows, and current
  chunks,
- extracted resources are keyed by owner path, content type, and byte size, not
  by persisted `sha256`,
- asset route cache validators are private route metadata, not content hashes,
- EPUB reader sections do not return `source_version`,
- EPUB indexing never falls back to `fragments_v1` or any other synthetic
  source label.

### PDF

For a PDF:

- `media.plain_text`, `pdf_page_text_spans`, PDF metadata, and PDF highlight
  anchors are current rows only,
- `text_extract_version`, `geometry_version`, `geometry_fingerprint`, and
  `plain_text_match_version` are removed,
- PDF source replacement deletes page spans, PDF highlights, reader state,
  current evidence rows, and current chunks before publishing the new current
  artifact,
- PDF search and reader navigation use page/offset locators only.

### Transcripts

For transcripts:

- there is one transcript row per `media_id`, or no separate transcript header
  table if `media_transcript_states` is sufficient,
- transcript segments are keyed by `(media_id, segment_idx)`,
- fragments for transcripts have no `transcript_version_id`,
- there is no `version_no`,
- there is no `is_active`,
- there is no active transcript pointer,
- there is no preserve-anchor strategy,
- `write_transcript_version` is replaced by a current-only writer such as
  `replace_current_transcript`,
- every path that creates transcripts calls that single writer.

Retranscription is destructive for transcript highlights and transcript
evidence. This is the product decision that removes the need for transcript
versions.

### Search and retrieval

Search returns current results only:

- no search result has `source_version`,
- no search result context ref has `source_version`,
- no retrieval result ref has `source_version`,
- `locator` remains for locatable rows,
- `locator` never contains `transcript_version_id`,
- current evidence rows are selected by `media_id` and current status, not by
  active run IDs,
- evidence resolution reads current blocks/spans only.

If a locator cannot resolve against current rows, resolution fails with a typed
not-found/current-content-missing error. It does not inspect old snapshots, raw
source, or stored snippets.

### Chat and citations

Chat citations preserve answer-marker ordering and enough display metadata for
the historical conversation. They do not preserve source versions.

`message_retrievals` keeps:

- result type,
- source ID,
- media ID when relevant,
- current evidence span ID when relevant at creation time,
- context ref,
- result ref without version fields,
- locator when relevant,
- display text fields,
- citation ordinal.

`message_retrievals` drops:

- `source_version`,
- version-like fields inside `result_ref`,
- `transcript_version_id` inside locators.

`message_retrieval_candidate_ledgers` follows the same rule.

The frontend may render old chat citation labels from stored retrieval display
fields. Reader jump remains current-only and may fail closed.

### Prompt assembly

Prompt assembly is current execution metadata, not a content-addressed artifact.

Remove:

- per-block prompt `stable_hash`,
- prompt `block_hashes`,
- `stable_prefix_hash`,
- `provider_request_hash`,
- provider `prompt_cache_key` derived from prompt content.

Keep:

- text-free prompt block manifests,
- lane metadata,
- source refs,
- token estimates,
- budget breakdown,
- included/dropped context accounting.

The LLM request is derived directly from the current `PromptPlan`. Prompt cache
identity is disabled instead of replaced with a new hash or fingerprint.

### Notes

Notes stop exposing revisions:

- `pages.revision` is dropped,
- `note_blocks.revision` is dropped,
- request fields named `base_revision` and `base_page_revision` are removed,
- frontend fields named `revision`, `baseRevision`, and persisted revision refs
  are removed,
- highlight note editing no longer requires note revision metadata.

Writes are transactionally valid and last-write-wins. There is no hidden
replacement token.

### Object search

Object search is a current projection:

- `object_search_documents.index_version` is dropped,
- `object_search_documents.content_hash` is dropped,
- `object_search_embeddings.index_version` is dropped,
- `object_search_embeddings.content_hash` is dropped,
- uniqueness is by `(user_id, object_type, object_id)` for current documents,
- embeddings are deleted and rebuilt when the projection changes.

### Library intelligence

Library intelligence becomes one current artifact per library and artifact kind.

Remove:

- `library_source_set_versions`,
- `library_source_set_items` as version-owned inventory,
- `library_intelligence_versions`,
- `library_intelligence_artifacts.active_version_id`,
- `artifact_version`,
- `source_set_version_id`,
- `prompt_version`,
- `schema_version` in public/product state.

Keep or introduce:

- `library_intelligence_artifacts` as the current artifact row,
- child sections, nodes, claims, and evidence keyed to `artifact_id`,
- `library_intelligence_builds` as operational build logs only, if the job
  lifecycle needs them,
- current freshness derived by comparing the current library entries/readiness
  at read time, not by source-set version identity.

If the existing child tables only point at `version_id`, migrate them to point
at `artifact_id` and delete all non-current rows.

### Oracle

Oracle uses one current corpus:

- `oracle_corpus_set_versions` is removed,
- `corpus_set_version_id` is removed from works, passages, images, readings,
  events, and service methods,
- `OracleReading.prompt_version` is removed,
- `provider_request_hash` is removed,
- corpus works are unique by `slug`,
- passages are unique by `(work_id, passage_index)`,
- images are unique by current `source_url` or a stable source-specific plate
  key,
- plate storage keys are not content-addressed by hash.

Readings keep the text, selected passages, selected plate, and generated
argument that were persisted at creation time. They do not promise replay
against the exact old corpus or prompt.

### Frontend

The frontend consumes the current-only API:

- no TypeScript type has `source_version` or `sourceVersion`,
- no frontend locator has `transcript_version_id`,
- no frontend search normalizer rejects rows because a version is missing,
- no `MediaPaneBody` pulse target fabricates `highlight:${id}` as a source
  version,
- no SSE citation guard requires source versions,
- note APIs and components have no revision/baseRevision fields,
- tests stop using `source:v1`, `fragment:...:v1`, `pdf-source:v1`, or
  `revision: 1` fixtures except where testing unrelated external protocols.

## Final architecture

### Owner modules

#### Source lifecycle owner

Owner: `python/nexus/services/media_source_ingest.py`

Responsibilities:

- durable source acceptance,
- source attempts,
- raw source references and source payload lifecycle,
- retry/refresh source acquisition,
- dispatch to source-specific adapters,
- invoke current-content publication after extraction.

Non-responsibilities:

- readable artifact versioning,
- search/citation versions,
- frontend compatibility shapes.

#### Current content owners

The implementation keeps the existing source-specific lifecycle owners and
centralizes only the shared current-evidence projection. This avoids a generic
middle layer that would mostly forward to source-specific materializers.

Owners:

- `python/nexus/services/web_article_artifacts.py` owns web article artifact
  cleanup.
- `python/nexus/services/epub_lifecycle.py` owns EPUB artifact cleanup.
- `python/nexus/services/pdf_ingest.py` owns PDF text artifact cleanup.
- `python/nexus/services/transcripts/current.py` owns transcript replacement.
- `python/nexus/services/content_indexing.py` owns current evidence replacement
  for all readable media.

Responsibilities:

- replace current readable artifacts for web, EPUB, PDF, and transcripts,
- delete dependent current artifacts before replacement,
- coordinate current evidence rebuild through `content_indexing.py`,
- reset dependent reader/highlight/search rows when the current artifact
  changes,
- enforce that a media item has at most one current readable projection.

Transaction contract:

- artifact replacement commands accept a caller-owned `Session`,
- they never commit,
- they may `flush()` to surface constraint failures,
- the source lifecycle or worker orchestration boundary owns commit/rollback,
- non-DB storage cleanup is explicit owner output or owner-local side effect and
  never hides a failed DB replacement.

#### Current evidence owner

Rename or simplify:

- `python/nexus/services/content_indexing.py`

Target responsibility:

- build current blocks, spans, chunks, chunk parts, and embeddings,
- replace old current evidence atomically,
- expose current index status,
- fail without corrupting the previous current evidence when a rebuild fails.

The service does not create source snapshots or index runs.

Public commands:

- `rebuild_media_content_index(...)`
- `rebuild_fragment_content_index(...)`
- `rebuild_transcript_content_index(...)`
- `build_pdf_indexable_blocks(...)`
- `mark_content_index_failed(...)`
- `delete_media_content_index(...)`

#### Transcript owner

Rename:

- from `python/nexus/services/transcripts/versions.py`
- to `python/nexus/services/transcripts/current.py`

Target responsibility:

- one current transcript write path,
- advisory lock by `media_id`,
- destructive replacement of segments, transcript fragments, transcript
  highlights, and transcript evidence,
- update `media_transcript_states`.

Public command:

- `replace_current_transcript(...)`

#### Retrieval/citation owner

Owner remains:

- `python/nexus/services/retrieval_citation.py`

Responsibilities after cutover:

- validate citable result refs without source versions,
- require locators only for locatable result types,
- write message retrieval rows without source versions,
- reject old result-ref shapes.

#### Library intelligence owner

Owner remains:

- `python/nexus/services/library_intelligence.py`

Responsibilities after cutover:

- build or refresh the one current artifact,
- delete old child artifact rows before publishing replacement children,
- expose current freshness/status without version/source-set IDs.

#### Oracle owner

Owner remains:

- `python/nexus/services/oracle.py`
- `python/nexus/services/oracle_plates.py`

Responsibilities after cutover:

- seed and validate one current corpus,
- query current works/passages/images,
- create readings without corpus version or prompt version,
- serve plates without DB content hashes as product identity.

#### Storage and file-validation owners

Owners:

- `python/nexus/services/upload.py`
- `python/nexus/services/file_ingest_validation.py`
- `python/nexus/storage/read.py`
- `python/nexus/services/image_proxy.py`
- `python/nexus/services/image_validation.py`

Responsibilities after cutover:

- validate accepted files by declared size, stored object size, streamed byte
  count, and file signature,
- persist storage path, byte size, and content type,
- never compute or persist media-file or EPUB-resource content hashes,
- serve private assets with route-local metadata only.

#### Notes owner

Owner remains:

- `python/nexus/services/notes.py`

Responsibilities after cutover:

- write the current page/block document shape,
- accept last-write-wins mutations for this single-user prototype,
- emit response shapes without revision/base-revision fields,
- reject transport payloads that attempt to use revision tokens.

#### Notes/content-index owner

The former `object_search.py` owner was removed by
`docs/cutovers/notes-pages-evidence-unification-hard-cutover.md`. Current note
search/evidence ownership is:

- `python/nexus/services/note_indexing.py`
- `python/nexus/services/content_indexing.py`

Responsibilities after cutover:

- rebuild current page-owned note content into the polymorphic content index,
- key indexed documents by `(owner_kind, owner_id)` rather than content hash,
- keep note search/evidence current through page reindex jobs.

#### Prompt assembly owner

Owners:

- `python/nexus/services/prompt_budget.py`
- `python/nexus/services/chat_prompt.py`
- `python/nexus/services/context_assembler.py`

Responsibilities after cutover:

- treat prompt plans as current execution inputs,
- persist useful run metadata without block hashes, stable-prefix hashes,
  provider-request hashes, or prompt-cache keys,
- keep provider prompt caching disabled until it has a product owner separate
  from artifact identity.

#### Transport and frontend contract owners

Owners:

- FastAPI route handlers in `python/nexus/api/routes/`
- Next.js BFF routes in `apps/web/src/app/api/`
- frontend parsers/types under `apps/web/src/lib/`

Responsibilities after cutover:

- routes remain transport-only and do not delete artifact internals,
- schemas reject old request fields rather than accepting both shapes,
- frontend types mirror the current wire contract and do not fabricate missing
  source identity.

## Cross-system composition

The final dataflow is:

1. source lifecycle accepts and records source intent,
2. source-specific materializer validates raw bytes or provider payloads,
3. the current artifact owner replaces the readable projection for that media,
4. current evidence is rebuilt from the current readable projection,
5. search and retrieval read current evidence only,
6. chat stores run display/audit metadata without owning replayable source
   versions,
7. reader and frontend navigation resolve against current locators only.

Routes, BFF handlers, UI components, and tests never reach into artifact
internals to perform cleanup. They call the capability owner.

## Database final state

### Drop tables

Drop these tables entirely:

- `podcast_transcript_versions`
- `content_index_runs`
- `source_snapshots`
- `library_source_set_versions`
- `library_source_set_items`
- `library_intelligence_versions`
- `oracle_corpus_set_versions`

Drop old rows in child tables that cannot exist without these tables.

### Replace transcript schema

Target:

- `podcast_transcript_segments.media_id` remains.
- `podcast_transcript_segments.transcript_version_id` is dropped.
- `podcast_transcript_segments` uniqueness becomes `(media_id, segment_idx)`.
- `fragments.transcript_version_id` is dropped.
- `media_transcript_states` remains status-only.
- OPML synthetic podcast IDs and RSS fallback episode IDs are readable
  normalized source tuples, not feed/title hashes.

If a transcript header table is still useful, name it `podcast_transcripts` and
make `media_id` the primary key. Do not name it `current_transcript`.
Currentness is implied by the table contract.

### Replace evidence schema

Target:

- `content_blocks` is keyed by `media_id` and `block_idx`.
- `evidence_spans` points at current `content_blocks`.
- `content_chunks` is keyed by `media_id` and `chunk_idx`.
- `content_chunk_parts` points at current chunks and blocks.
- `content_embeddings` points at current chunks.
- `media_content_index_states` has status fields only, or its status moves into
  `media` if that is simpler.

Remove from evidence tables:

- `index_run_id`,
- `source_snapshot_id`,
- `source_version`,
- `source_fingerprint`,
- `content_sha256`,
- `text_sha256`,
- `span_sha256`,
- `chunk_sha256`,
- `embedding_sha256`,
- `chunker_version`,
- `extractor_version`,
- `embedding_version`,
- `embedding_config_hash`,
- `parent_snapshot_id`,
- supersession/deactivation columns.

Keep:

- primary keys,
- `media_id`,
- ordinals,
- locator JSON,
- selector JSON when it is the current resolver input,
- display labels,
- model/provider/dimensions if needed to call embedding infrastructure.

### Replace media file and extracted resource identity

Remove:

- `media.file_sha256`,
- `epub_resources.sha256`,
- partial unique upload dedupe by `(created_by_user_id, kind, file_sha256)`,
- stale-pending cleanup predicates that depend on `file_sha256 IS NULL`,
- content-hash ETags for image proxy or private extracted assets.

Keep:

- `media_file.storage_path`,
- `media_file.size_bytes`,
- `media_file.content_type`,
- `epub_resources.storage_path`,
- `epub_resources.content_type`,
- `epub_resources.size_bytes`.

Validation is byte-count and signature based. Storage object reads may compare
the persisted byte size to streamed bytes. They must not reintroduce app-level
content hashes as identity.

### Replace library intelligence schema

Target:

- `library_intelligence_artifacts` stores the current overview artifact state.
- child rows point to `artifact_id`.
- build logs, if kept, are named and modeled as builds, not versions.

Remove:

- `active_version_id`,
- `source_set_version_id`,
- `artifact_version`,
- `prompt_version`,
- `schema_version`,
- version/source-set uniqueness constraints.

### Replace Oracle schema

Target:

- current corpus works/passages/images have no corpus version FK,
- readings have no corpus version FK and no prompt version,
- plate storage is keyed by stable non-hash identifiers.

Remove:

- `oracle_corpus_set_versions`,
- every `corpus_set_version_id`,
- `oracle_readings.prompt_version`,
- `oracle_readings.provider_request_hash`,
- `oracle_corpus_images.sha256`,
- content-hash-shaped storage key checks.

### Replace notes and object search schema

Remove:

- `pages.revision`,
- `note_blocks.revision`,
- `object_search_documents.content_hash`,
- `object_search_documents.index_version`,
- `object_search_embeddings.content_hash`,
- `object_search_embeddings.index_version`.

Object search current uniqueness:

- `object_search_documents`: `(user_id, object_type, object_id)`.
- `object_search_embeddings`: current document/chunk relation only.

### Replace PDF support schema

Remove:

- `highlight_pdf_anchors.geometry_version`,
- `highlight_pdf_anchors.geometry_fingerprint`,
- `highlight_pdf_anchors.plain_text_match_version`,
- `pdf_page_text_spans.text_extract_version`.

PDF quote matching remains current only.

### Replace message retrieval schema

Remove:

- `message_retrievals.source_version`,
- `message_retrieval_candidate_ledgers.source_version`,
- `source_version` inside `context_ref` JSON,
- `source_version` inside `result_ref` JSON,
- `transcript_version_id` inside locator JSON.

Migration must strip old JSON keys. It must not leave old keys around for code
to ignore.

## API design

### Wire contract

The public API is positive-current-only, not dual-shape:

- readable media, transcript, search, citation, note, library intelligence, and
  Oracle responses omit artifact version/hash/fingerprint fields entirely,
- requests containing old artifact fields are rejected by the boundary schema
  when they are user input,
- persisted JSON payloads are stripped during migration because they are not
  user input,
- frontend parsers model only the current union and fail closed on impossible
  current shapes,
- no API response includes compatibility aliases for old frontend builds.

### Search API

Remove `source_version` from:

- `SearchResultContextRefOut`,
- `SearchResultContentChunkOut`,
- `SearchResultFragmentOut`,
- `SearchResultNoteBlockOut`,
- `SearchResultHighlightOut`,
- `SearchResultPageOut`,
- `SearchResultMessageOut`,
- `SearchResultEvidenceSpanOut`,
- `SearchResultWebResultOut`.

Search result locators remain the only navigation contract for locatable rows.

### Retrieval schemas

Remove `source_version` from:

- every locatable `RetrievalResultRef`,
- conversation/message retrieval result blocks,
- app-search tool schemas,
- web-search result refs.

Keep explicit validators that ensure:

- locatable types have a locator,
- non-locatable types do not have a locator,
- locator type matches result type,
- context refs do not carry locator/source fields.

### Media reader APIs

Remove `source_version` from:

- media fragments responses,
- EPUB section/navigation responses,
- web article navigation responses,
- transcript view payloads,
- highlight payloads,
- PDF reader payloads.

The reader target event contains:

- `mediaId`,
- target kind,
- locator or highlight ID,
- optional display label.

It does not contain source version.

### Notes APIs

Remove from request and response shapes:

- `revision`,
- `base_revision`,
- `base_page_revision`,
- `baseRevision`,
- `page.revision`,
- `block.revision`.

### Library intelligence APIs

Remove from public responses:

- `active_version_id`,
- `current_source_set_version_id`,
- `active_source_set_version_id`,
- `source_set_version_id`,
- `prompt_version`,
- `schema_version`,
- `artifact_version`.

Expose:

- current artifact status,
- current generated sections/nodes/claims/evidence,
- current source counts/readiness summaries if useful,
- current build status if a build is running.

### Oracle APIs

Remove from internal and public response shapes:

- corpus version IDs,
- prompt version fields,
- provider request hashes.

Readings expose persisted reading content and current object IDs only.

## Duplicate and repetitive patterns to consolidate

### Search/citation validators

Pre-cutover duplication:

- `python/nexus/schemas/retrieval.py` validates source-version/locator shape.
- `python/nexus/schemas/search.py` repeats source-version requirements.
- `python/nexus/schemas/conversation.py` repeats parity checks.
- `python/nexus/services/retrieval_citation.py` repeats strict result-type
  source-version requirements.
- `apps/web/src/lib/api/sse/citations.ts` repeats the same requirements.
- `apps/web/src/lib/search/normalizeSearchResult.ts` repeats them again.

Cutover consolidation:

- one backend locator/result-type validator in `schemas/retrieval.py`,
- search schemas import and use it,
- retrieval citation service uses it,
- frontend mirrors only the final wire union and does not recreate source
  provenance policy.

### Content publication cleanup

Pre-cutover duplication:

- web article lifecycle deletes fragments/highlights/content index,
- EPUB lifecycle deletes extracted structure/assets/highlights/content index,
- PDF ingest deletes spans/plain text/content index,
- transcript writer has separate preserve/replace strategies,
- reconciler and indexing services know about active runs.

Cutover consolidation:

- source-specific artifact owners expose one deletion/replacement command each,
- shared current-evidence replacement stays in `content_indexing.py`,
- source ingest calls the relevant source-specific owner,
- routes and UI never delete artifact internals.

### Current readable identity

Pre-cutover duplication:

- render fragments are current by `media_id`,
- PDF text is current on `media`,
- EPUB support tables are current by `media_id`,
- evidence used active run indirection,
- transcripts used a separate active-transcript mechanism.

Cutover consolidation:

- all readable artifacts are current by `media_id`,
- no subsystem gets a separate active-version mechanism.

### Generated artifact lifecycle

Pre-cutover duplication:

- library source-set versions,
- library intelligence artifact versions,
- library intelligence builds,
- Oracle corpus versions,
- Oracle reading prompt versions.

Cutover consolidation:

- generated state is either current artifact data or operational build/event
  telemetry,
- no generated subsystem owns addressable content versions.

### Note projection identity

Pre-cutover duplication:

- note `revision` columns,
- object-search `content_hash`,
- object-search `index_version`,
- frontend `baseRevision` state,
- highlight note revision requirements.

Cutover consolidation:

- note writes update current rows,
- object search rebuilds current projection,
- frontend submits desired current content.

### PDF current identity

Pre-cutover duplication:

- PDF extraction version,
- page-span text extract version,
- highlight geometry version,
- geometry fingerprint,
- plain-text match version.

Cutover consolidation:

- PDF anchors and page text are current geometry/text rows,
- replacement deletes and rebuilds them.

## Implementation Sequence Used

The cutover was implemented in these completed phases. This section is retained
as historical evidence for the owner-layer order, not as pending backlog.

### Phase 0: frozen contract

1. Landed this spec.
2. Updated `docs/architecture.md` to remove the recurring versioned-artifact
   pattern from the target architecture.
3. Updated affected module docs:
   - `docs/modules/podcast.md`
   - `docs/modules/web-article.md`
   - `docs/modules/epub.md`
   - `docs/modules/pdf.md`
   - `docs/modules/reader-implementation.md`
   - `docs/modules/highlight.md`
   - `docs/modules/library.md`
   - `docs/modules/oracle.md`
   - `docs/modules/chat.md`
4. Kept the migration checklist in this document as acceptance evidence.

### Phase 1: backend API contracts

1. Remove `source_version` from Pydantic schemas.
2. Remove `transcript_version_id` from locator schemas.
3. Remove revision fields from note schemas.
4. Remove version/source-set/prompt fields from library intelligence schemas.
5. Remove Oracle version/prompt fields from schemas.
6. Update services to produce the new shapes.
7. Delete schema tests that assert old fields are required.
8. Add tests that old fields are forbidden.

This phase did not add compatibility serializers.

### Phase 2: storage and database migration

Before running Alembic revision `0138`, repair Oracle plate storage objects while
the pre-cutover DB still contains the old plate keys:

```bash
cd python
uv run python scripts/repair_oracle_plate_storage_keys.py --dry-run
uv run python scripts/repair_oracle_plate_storage_keys.py
```

The script copies every old Oracle plate object to the stable current key that
`0138` writes into `oracle_corpus_images.storage_key`, then verifies destination
content type and byte size. If any source or destination object is missing or
wrong, it exits non-zero and the DB migration must not be run.

Create one hand-written Alembic migration that:

1. Deletes non-current transcript rows, preserving only the current transcript
   segments by `media_id`.
2. Drops transcript version columns/tables/constraints.
3. Drops source snapshots and content index runs.
4. Re-keys evidence tables to current `media_id` ordinals.
5. Drops all content hash/fingerprint/version columns in evidence tables.
6. Drops library source-set/version tables and rewires current artifact children.
7. Drops Oracle corpus version table and corpus version FKs.
8. Drops media file and EPUB resource content-hash identity columns.
9. Drops note revisions and object-search hash/version columns.
10. Drops PDF version/fingerprint columns.
11. Drops message retrieval source-version columns.
12. Strips old source/version/hash fields from JSON payload columns.

No downgrade is required beyond raising `NotImplementedError`, matching prior
hard cutover migrations.

### Phase 3: current-content services

1. Add or rename the current-content owner.
2. Move duplicated cleanup into it.
3. Replace transcript writer with `replace_current_transcript`.
4. Replace content indexing with current-only publication.
5. Update web, EPUB, PDF, YouTube, RSS transcript, Deepgram transcript, and X
   ingestion paths to call the current owner.
6. Delete old repair/reconciler logic that exists only to manage active runs,
   supersession, source snapshots, or versions.

### Phase 4: search, retrieval, prompt assembly, chat

1. Update search queries to read current evidence rows directly.
2. Update `retrieval_citation.py` to validate locator-only current refs.
3. Update chat run event emission and message block hydration.
4. Update `locator_resolver.py` to resolve current rows only.
5. Remove prompt block hashes, provider request hashes, stable-prefix hashes,
   and prompt cache keys.
6. Remove old snapshot reconstruction tests.
7. Add fail-closed tests for missing current content.

### Phase 5: frontend cutover

1. Remove `source_version` and `sourceVersion` fields from frontend types.
2. Remove `transcript_version_id` from locator types.
3. Update SSE citation guards.
4. Update search normalizers and row adapters.
5. Update media reader payload parsing.
6. Update highlight and PDF reader types.
7. Remove fabricated source-version fallbacks in `MediaPaneBody`.
8. Remove note revision state and API payloads.
9. Rewrite fixtures and tests.

### Phase 6: generated intelligence and Oracle

1. Collapse library intelligence services to current artifacts.
2. Collapse Oracle corpus services to one current corpus.
3. Update seed/import scripts.
4. Update Oracle plate storage-key contract away from content-addressed keys.
5. Remove prompt/schema/version constants where they only identify app
   artifacts.

### Phase 7: cleanup sweep

Run repo-wide searches and delete or justify every remaining app-domain match:

```bash
rg -n "source_version|sourceVersion|transcript_version_id|version_no|is_active|active_version_id|artifact_version|source_set_version|corpus_set_version|prompt_version|schema_version|revision|baseRevision|base_revision|index_version|fingerprint|content_hash|sha256|_hash|hash\\("
```

Every remaining active-code hit is one of:

- security/auth hashing,
- idempotency, rate-limit, advisory-lock, health-contract, privacy-safe query,
  or external release checksum hashing,
- third-party dependency/package versioning,
- Alembic migration identity,
- external protocol field that cannot be renamed,
- fail-fast legacy payload guards,
- a historic migration file,
- this cutover document.

Anything else is unfinished.

## Files to change

### Docs

- `docs/architecture.md`
- `docs/modules/podcast.md`
- `docs/modules/web-article.md`
- `docs/modules/epub.md`
- `docs/modules/pdf.md`
- `docs/modules/reader-implementation.md`
- `docs/modules/highlight.md`
- `docs/modules/library.md`
- `docs/modules/oracle.md`
- `docs/modules/chat.md`
- this cutover document

### Database and migrations

- `python/nexus/db/models.py`
- new Alembic migration under `migrations/alembic/versions/`
- migration tests in `python/tests/test_migrations.py`

### Backend services

- `python/nexus/services/media_source_ingest.py`
- `python/nexus/services/upload.py`
- `python/nexus/services/remote_file_client.py`
- `python/nexus/services/file_ingest_validation.py`
- `python/nexus/storage/read.py`
- `python/nexus/services/content_indexing.py`
- `python/nexus/services/transcripts/versions.py`
- `python/nexus/services/transcript_segments.py`
- `python/nexus/services/media.py`
- `python/nexus/services/media_document_map.py`
- `python/nexus/services/reader_navigation.py`
- `python/nexus/services/epub_read.py`
- `python/nexus/services/web_article_structure.py`
- `python/nexus/services/web_article_indexing.py`
- `python/nexus/services/epub_ingest.py`
- `python/nexus/services/epub_assets.py`
- `python/nexus/services/epub_lifecycle.py`
- `python/nexus/services/pdf_ingest.py`
- `python/nexus/services/pdf_indexing.py`
- `python/nexus/services/pdf_highlights.py`
- `python/nexus/services/pdf_highlight_geometry.py`
- `python/nexus/services/podcasts/transcription.py`
- `python/nexus/services/podcasts/ingest.py`
- `python/nexus/services/youtube_transcripts.py`
- `python/nexus/services/search.py`
- `python/nexus/services/locator_resolver.py`
- `python/nexus/services/retrieval_citation.py`
- `python/nexus/services/message_retrievals.py`
- `python/nexus/services/chat_run_message_blocks.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/agent_tools/web_search.py`
- `python/nexus/services/notes.py`
- `python/nexus/services/highlights.py`
- `python/nexus/services/note_indexing.py`
- `python/nexus/services/content_indexing.py`
- `python/nexus/services/image_proxy.py`
- `python/nexus/services/image_validation.py`
- `python/nexus/services/library_intelligence.py`
- `python/nexus/services/library_governance.py`
- `python/nexus/services/oracle.py`
- `python/nexus/services/oracle_plates.py`
- `python/nexus/oracle/seed_objects.py`
- `python/nexus/tasks/reconcile_stale_ingest_media.py`

### Backend schemas and routes

- `python/nexus/schemas/retrieval.py`
- `python/nexus/schemas/search.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/schemas/media.py`
- `python/nexus/schemas/highlights.py`
- `python/nexus/schemas/notes.py`
- `python/nexus/schemas/library_intelligence.py`
- `python/nexus/api/routes/notes.py`
- `python/nexus/api/routes/media_ingest.py`

Routes should only change transport shapes. They must not own compatibility
logic.

### Frontend

- `apps/web/src/lib/api/sse/citations.ts`
- `apps/web/src/lib/api/sse/events.ts`
- `apps/web/src/lib/api/sse/locators.ts`
- `apps/web/src/lib/search/types.ts`
- `apps/web/src/lib/search/normalizeSearchResult.ts`
- `apps/web/src/lib/search/resultRowAdapter.ts`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/conversations/readerTarget.ts`
- `apps/web/src/lib/chat/citations.ts`
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/lib/media/readerNavigation.ts`
- `apps/web/src/lib/media/transcriptView.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/epubHelpers.ts`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/lib/highlights/api.ts`
- `apps/web/src/components/reader/toAnchoredHighlightRow.ts`
- `apps/web/src/components/reader/useAnchoredHighlightProjection.ts`
- `apps/web/src/lib/notes/api.ts`
- `apps/web/src/app/(authenticated)/notes/NotesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`
- `apps/web/src/components/notes/HighlightNoteEditor.tsx`
- all directly affected tests and fixtures

## Acceptance criteria

### Structural

- No active ORM model contains app-domain columns named `version`,
  `version_no`, `source_version`, `revision`, `fingerprint`, `content_hash`,
  `sha256`, `config_hash`, or equivalent app artifact identity names.
- No active service owns a versioned artifact table.
- No active frontend type contains `source_version`, `sourceVersion`,
  `transcript_version_id`, `revision`, or `baseRevision`.
- No active API response emits version/hash/fingerprint fields for readable
  media, transcripts, search, citations, notes, library intelligence, or Oracle.
- Old JSON payload columns are migrated to remove version/hash/fingerprint
  keys.
- Historic migration files may still contain old names. Active code may not.

### Behavior

- Reprocessing a web article replaces its current readable artifact and current
  evidence only.
- Reprocessing an EPUB replaces its current extraction, resources, reader
  structure, highlights, and evidence only.
- Uploading or remotely fetching the same PDF/EPUB bytes again does not reuse a
  prior media row by file hash.
- Reprocessing a PDF replaces its current text/page spans/highlights/evidence
  only.
- Retranscribing a podcast/video replaces its current transcript,
  transcript-backed fragments, transcript highlights, and evidence only.
- Search returns current rows only.
- Chat citations can render historical display text but reader jumps resolve
  against current content only.
- Missing current content produces a typed fail-closed result.
- Note saves do not require revision/baseRevision fields.
- Library intelligence has one current artifact per library/kind.
- Oracle has one current corpus.

### Code quality

- No compatibility serializers.
- No frontend fallback values that fabricate missing source identity.
- No route-local business logic.
- No duplicate cleanup paths for web/EPUB/PDF/transcript replacement outside
  the source-specific artifact owners.
- Artifact replacement services do not commit caller transactions.
- Old-field request payloads are rejected at transport/schema boundaries.
- Cleanup does not rely on database cascades as a substitute for owner commands.
- Required storage repair commands are proven before destructive migrations.
- Final hash/version sweeps leave only the allowed non-artifact categories.
- No tests assert old fields are accepted.
- Tests assert old fields are rejected or absent.

## Verification

Start with targeted suites. Do not run full `make verify` until the targeted
contracts are green.

Backend:

```bash
./scripts/with_test_services.sh make _test-back-db-ready
cd python && NEXUS_ENV=test uv run pytest -v --tb=short \
  tests/test_migrations.py \
  tests/test_content_indexing.py \
  tests/test_locator_resolver.py \
  tests/test_retrieval_schema_contracts.py \
  tests/test_search.py \
  tests/test_media.py \
  tests/test_podcasts.py \
  tests/test_ingest_youtube_video.py \
  tests/test_pdf_ingest.py \
  tests/test_pdf_ingest_task.py \
  tests/test_reconcile_stale_ingest_media.py \
  tests/test_library_intelligence_read_model.py \
  tests/test_notes.py \
  tests/test_oracle.py \
  tests/test_oracle_plate_route.py
```

Frontend:

```bash
cd apps/web && bun run test:unit -- \
  src/lib/api/sse/citations.test.ts \
  src/lib/api/sse/events.test.ts \
  src/lib/media/readerNavigation.test.ts \
  src/lib/search/resultRowAdapter.test.ts \
  src/lib/notes/api.test.ts \
  src/app/'(authenticated)'/media/'[id]'/epubHelpers.test.ts

cd apps/web && bun run test:browser -- \
  src/app/'(authenticated)'/media/'[id]'/MediaPaneBody.test.tsx \
  src/__tests__/components/PdfReader.test.tsx \
  src/components/reader/ReaderContentsNav.test.tsx \
  src/components/notes/HighlightNoteEditor.test.tsx
```

E2E:

```bash
make test-e2e PLAYWRIGHT_ARGS='tests/pdf-reader.spec.ts tests/epub.spec.ts tests/web-articles.spec.ts --project=chromium'
make test-real-media PLAYWRIGHT_ARGS='tests/real-media/readiness.spec.ts tests/real-media/search-evidence.spec.ts tests/real-media/upload-pdf.spec.ts tests/real-media/upload-epub.spec.ts tests/real-media/captured-web-article.spec.ts'
```

Publish-level confidence still requires the repo's broader gates, CI, and deploy
smoke appropriate to the release.

## Final state checklist

- [x] `docs/architecture.md` no longer describes a recurring
      versioned-artifact pattern.
- [x] Transcript writer is current-only.
- [x] Content indexing has no runs or snapshots.
- [x] Search and retrieval schemas have no source versions.
- [x] Frontend search/SSE/media types have no source versions.
- [x] Prompt assemblies and MessageLLM metadata have no prompt hashes or prompt
      cache keys.
- [x] Notes have no revisions.
- [x] Media files and EPUB resources have no persisted content hashes.
- [x] Object search has no hashes or index versions.
- [x] PDF extraction/highlight anchors have no version/fingerprint fields.
- [x] Library intelligence has no source-set or artifact versions.
- [x] Oracle has no corpus versions or prompt versions.
- [x] Old JSON fields are stripped.
- [x] All old compatibility tests are deleted or rewritten.
- [x] A final `rg` sweep leaves only allowed security, dependency, migration,
      and external-protocol matches.
