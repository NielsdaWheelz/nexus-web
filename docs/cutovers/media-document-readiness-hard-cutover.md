# Media document readiness hard cutover

Status: Implemented in the 2026-06-05 worktree. Use this document as the target
contract, audit checklist, and verification plan for the hard cutover.

This is a hard cutover plan. The final implementation removes the legacy
`embedding` and `ready` media processing statuses from the document path. It
does not preserve runtime compatibility, aliases, frontend fallbacks, or
dual-write behavior for old clients.

## Summary

Nexus currently has two concepts that need to stay separate:

- Document readiness: whether a user or agent can read the captured media as a
  document.
- Retrieval readiness: whether the same media has an active searchable or
  embeddable content index.

The repository already documents this separation. `media.processing_status`
belongs to the source/document lifecycle and is documented as
`pending -> extracting -> ready_for_reading`. Search and embedding readiness
belongs to `media_content_index_states`. The older `embedding` and `ready` media
statuses are not production document-path states anymore, so they must be
removed instead of treated as compatibility values.

The target state is:

- `media.processing_status` has exactly four values:
  `pending`, `extracting`, `ready_for_reading`, `failed`.
- `ready_for_reading` is the only successful terminal media document status.
- `media_content_index_states.status` remains the only retrieval/index lifecycle
  state and keeps `ready` in that bounded context.
- Reader, document map, page range, quote, and frontend fragment-loading paths
  gate on document readiness, not retrieval readiness.
- Search, chat evidence, app search, and content-index consumers gate on the
  active ready index run, not `media.processing_status`.
- Backend capability derivation is the public product contract. Frontend code
  consumes capabilities or a shared document-readiness helper; it does not
  reconstruct the lifecycle in multiple components.

## SME framing

A subject matter expert would start by asking which capability is blocked:

- Can the user read the captured thing as a document?
- Can the system retrieve evidence from it?
- Can the agent quote, cite, or page through it?
- Can background enrichment safely refresh metadata for it?

The SME move is to avoid making one status answer all of those questions. A
single overloaded status creates temporal coupling: the UI waits for embeddings
before reading, search treats extraction failures like index failures, and agent
tools infer document access from an index state. The professional architecture
keeps lifecycle boundaries crisp and exposes capability-level answers at the API
edge.

The SME would also force one owner per concern:

- Source/document lifecycle owner: media ingest and processing state.
- Document read contract owner: document-readiness policy plus
  `media_document_map`.
- Retrieval lifecycle owner: content indexing.
- Product/API owner: media service capability derivation.
- UI owner: a single frontend document-readiness adapter.

No caller should need to know that the historical system once had
`embedding -> ready` as media states.

## SOTA and meta

The current best-practice shape is not "better enum naming". It is a bounded
state-machine design with capability projection:

- Each lifecycle has one state machine and one persistence owner.
- Product surfaces consume capabilities derived from those state machines.
- Background work is independently retryable and does not mutate unrelated
  lifecycle state.
- Public API names describe user-visible capabilities, not internal job phases.
- Data migrations remove invalid states at the storage boundary.
- Contract tests pin capability behavior across media kinds.

The anti-pattern is boolean/status soup: every caller checks a slightly
different subset of `processing_status`, transcript state, artifact existence,
and index state. The durable pattern is a small number of service-owned
predicates with tests that say exactly which media kinds are readable,
quotable, searchable, or unsupported.

An SME would approach the implementation with these moves:

- Draw the lifecycle boundary before editing code.
- Name the capability first, then identify the state owner.
- Remove historical states from the database enum, not only from UI display.
- Replace duplicated status sets with one backend policy and one frontend
  adapter.
- Keep migration repair one-time and runtime behavior strict.
- Make unsupported states loud in tests and service errors.
- Verify by grep, by capability tests, and by kind-specific reader/search tests.

## Codebase rules

The plan follows these existing repo rules:

- `docs/rules/cleanliness.md`: one owner per concern; remove duplicate
  implementations instead of adding wrapper behavior.
- `docs/rules/layers.md`: BFF routes translate transport and delegate business
  decisions to services.
- `docs/rules/module-apis.md`: expose each capability one way; do not keep
  parallel APIs or local reconstructions.
- `docs/rules/correctness.md`: normalize at ingress, enforce invariants close
  to the owner, and fail loudly when persisted state violates the contract.

## Goals

- Remove `embedding` and `ready` from the media processing lifecycle.
- Make `ready_for_reading` the only document-readable media processing state.
- Keep retrieval/index readiness represented only by
  `media_content_index_states`.
- Centralize backend document-readiness policy so reader, agent, and API paths
  answer the same way.
- Centralize frontend document-readiness policy so fragment loading, navigation,
  and status UI use the same rules.
- Keep transcript, PDF, EPUB, and web-article differences explicit instead of
  hidden inside generic status checks.
- Update tests and docs so future contributors cannot reintroduce the legacy
  states by copying old patterns.

## Non-goals

- No compatibility for old `media.processing_status = 'embedding'` or
  `'ready'` values after the migration.
- No runtime fallback that treats unknown media statuses as readable.
- No frontend support for old API responses.
- No BFF-side business logic to compensate for service-layer gaps.
- No change to retrieval index state names. `media_content_index_states.ready`
  remains valid and is not part of this cutover.
- No change to auth, visibility, library membership, or media ownership rules.
- No change to durable-source ingest semantics or current-only artifact
  preservation beyond any direct status-owner adjustments required by this
  cutover.
- No attempt to make all media kinds expose identical read capabilities. Kind
  differences stay explicit.

## Capability contract

The final product contract is capability-first:

- `can_read`: the media has a user-facing document surface available now.
- `can_quote`: the media has addressable text spans suitable for citation or
  page/fragment quoting.
- `can_search`: the media has an active ready retrieval index.
- `retrieval_status`: the latest active content index lifecycle state.
- `processing_status`: the source/document lifecycle state.

`processing_status` answers only source/document extraction progress. It does
not answer whether embeddings exist. `retrieval_status` answers only content
index progress. It does not answer whether the user can open a reader.

The API must not add `embedding_status` as a second public lifecycle for the
same media row. If the UI needs a richer display, the backend should derive
capabilities and retrieval status from owned service state and return those
fields through the existing media DTO.

### Processing status

Allowed values:

- `pending`: a source has been created but document extraction has not started.
- `extracting`: source/document extraction is actively producing readable
  artifacts.
- `ready_for_reading`: document extraction succeeded enough for the relevant
  read capability.
- `failed`: source/document extraction failed.

Forbidden final-state values:

- `embedding`: removed from `media.processing_status`.
- `ready`: removed from `media.processing_status`.

### Retrieval status

Retrieval readiness stays in `media_content_index_states`.

Allowed values remain owned by content indexing, currently including:

- `pending`
- `indexing`
- `ready`
- `no_text`
- `ocr_required`
- `failed`

This cutover must not rename `media_content_index_states.ready`. That `ready`
means "active retrieval index run is usable", not "media document is readable".

## Target behavior

### Web article

- Ingest creates the media row in `pending` or `extracting`.
- Extraction writes the current readable artifact set.
- On extraction success, media transitions to `ready_for_reading`.
- Reader navigation, fragments, full-document reads, page/range reads, and agent
  document-map calls are allowed when document artifacts exist and the media is
  `ready_for_reading`.
- Content indexing may still be `pending`, `indexing`, `no_text`, or `failed`;
  that must not block opening the reader.

### EPUB

- EPUB extraction succeeds into `ready_for_reading` when navigation and readable
  sections are available.
- EPUB asset serving and section reads use document readiness.
- Search and chat evidence still require content-index readiness if they rely on
  retrieval.

### Transcript-backed media

- Media document readiness for transcript media is not only
  `processing_status`.
- Transcript read capability requires transcript-owned state:
  active transcript version, `transcript_state in ('ready', 'partial')`, and
  usable transcript coverage.
- `processing_status = ready_for_reading` means the media source lifecycle is no
  longer extracting; it does not replace transcript-state checks.
- `semantic_status`, summary status, or embedding/index status must not be used
  to decide basic transcript reading.

### PDF and file-backed media

PDFs need two distinct read capabilities:

- Visual/file read: the original or normalized file is available for viewing.
- Text document read: extracted text, page spans, and quote anchors are
  available.

`can_read` may be true for a visual PDF viewer before text search is ready if
the product intentionally supports file viewing. `can_quote`, page-range text
reads, and search require extracted text/page spans or a ready retrieval index,
as appropriate.

Terminal PDF extraction failures are not visual-readable through the media
reader even when the original file remains downloadable. Password-protected or
encrypted PDFs must surface the failed-document UI rather than falling through
to the PDF viewer.

`ocr_required` is a retrieval/text-read state. It must not be collapsed into
`processing_status = failed` unless source extraction itself failed.

### Agent document path

`media_document_map` remains the owner of read-document SQL and document-map
shape. It must gate reads through the centralized document-readiness policy
before returning map entries, full text, page ranges, headings, quote anchors,
or adjacent document metadata.

Agent-facing tools keep the existing tool contract: unavailable media resources
are returned as `missing` so a model cannot distinguish unauthorized, absent, or
not-yet-readable resources through a tool side channel. Direct media routes and
services may still raise explicit not-ready capability errors where that is the
existing HTTP/API contract.

The owner boundaries remain crisp:

- not found or unauthorized remains auth/resource failure.
- not document-ready is a capability failure.
- document-ready but no text/page spans is a kind-specific unsupported
  capability failure.
- retrieval not ready is a retrieval/search failure, not a document-read
  failure.

### Frontend reader path

The frontend should not define independent readable-status sets in components.
It should import a shared, non-React helper that derives document-readiness
display and fragment-load decisions from the media API shape.

Allowed frontend sources:

- `media.capabilities.can_read`
- `media.capabilities.can_quote`
- `media.processing_status`
- transcript fields when transcript-specific UI needs them
- `media.retrieval_status` only for retrieval/index banners

Disallowed frontend patterns:

- `READABLE_STATUSES = new Set(['ready_for_reading', 'embedding', 'ready'])`
- treating retrieval `ready` as document `ready`
- duplicating fragment-load status checks between server loaders and client
  panes
- silently loading fragments for unknown statuses

## Architecture

### Backend owners

#### Media processing state

`python/nexus/services/media_processing_state.py` owns primitive writes to the
`media.processing_status` and failure-field tuple. It is the service boundary
for status mutations; callers still own their surrounding ingest transaction and
kind-specific preconditions.

Final legal transition shape:

- `pending -> extracting`
- `pending -> ready_for_reading` only for sources that complete synchronously
  through a documented service path
- `extracting -> ready_for_reading`
- `pending -> failed`
- `extracting -> failed`

There is no transition to `embedding` or `ready`.

Repeated calls that try to set the same terminal value should be idempotent only
where the existing service contract already makes idempotency explicit. New
idempotency should not be introduced to hide invalid writers.

#### Document readiness policy

Designate a single backend service owner for document-readiness policy. In this
cutover, the owner is the existing readability/capability policy in
`python/nexus/services/capabilities.py`, with SQL-heavy document-map and
fragment queries staying in their current services.

The owner should stay small and explicit. It should not become a generic media
or search facade. It should answer document capability questions using owned
source state and kind-specific predicates.

Responsibilities:

- define the allowed media document statuses
- expose `is_document_status_ready(status: str) -> bool`
- expose kind-aware readiness checks used by capability derivation
- expose kind-aware readiness checks used by direct read gates
- keep retrieval status out of document-readiness decisions except where a
  capability explicitly says it is search/retrieval-related

Do not put SQL-heavy document-map queries in this module. Keep those in
`media_document_map`.

#### Media document map

`python/nexus/services/media_document_map.py` remains the owner of document-map,
read-resource, and page-range SQL.

It should call the centralized document-readiness policy before returning a
document map or document text. It should not define its own status list. It
should distinguish:

- no readable document
- readable document without text-page spans
- unsupported media kind
- stale/missing artifact invariant

#### Capability derivation

`python/nexus/services/capabilities.py` owns capability booleans and the
document-ready processing-status policy. It must not preserve
`READABLE_PROCESSING_STATUSES` with legacy values.

Capability derivation should be the backend source of truth for API consumers.
If a caller needs a direct read gate, it calls the same policy used by
capabilities instead of copying a Set.

#### Content indexing

`python/nexus/services/content_indexing.py` continues to own
`media_content_index_states`.

It must not write `media.processing_status = 'embedding'` or `'ready'`.
Indexing success publishes an active ready content-index run. It does not update
the media document lifecycle.

#### Search and chat evidence

`python/nexus/services/search.py` and chat/evidence callers continue to require
an active ready content-index run. They should not infer retrieval readiness
from `media.processing_status = ready_for_reading`.

### Frontend owners

Add or designate one shared frontend helper, for example:

`apps/web/src/lib/media/documentReadiness.ts`

This helper should be importable from both server loader code and client UI
code. It should avoid React hooks and browser-only APIs.

Candidate responsibilities:

- define the frontend mirror of allowed document statuses from the API type
- expose `isDocumentProcessingReady(status)`
- expose `shouldLoadReaderFragments(mediaLike)`
- expose status-display helpers that distinguish document extraction from
  retrieval/indexing
- keep retrieval banners keyed to `retrieval_status`

Components should render from this helper and from backend capability fields.
They should not carry local `READABLE_STATUSES` sets.

## API design

### Media DTO

The media API should keep the public distinction clear:

```ts
type MediaProcessingStatus =
  | "pending"
  | "extracting"
  | "ready_for_reading"
  | "failed";

type MediaRetrievalStatus =
  | "pending"
  | "indexing"
  | "ready"
  | "no_text"
  | "ocr_required"
  | "failed";
```

Representative response shape:

```ts
type MediaOut = {
  id: string;
  kind: MediaKind;
  processing_status: MediaProcessingStatus;
  retrieval_status: MediaRetrievalStatus | null;
  retrieval_status_reason: string | null;
  transcript_state?: "pending" | "processing" | "partial" | "ready" | "failed";
  transcript_coverage?: "none" | "partial" | "full";
  capabilities: {
    can_read: boolean;
    can_quote: boolean;
    can_search: boolean;
  };
};
```

The exact TypeScript names should follow existing generated or hand-written API
types. The contract above is the semantic target, not a request to introduce a
parallel type system.

### Event API

The media-processing event/snapshot API should treat
`ready_for_reading` and `failed` as media document terminal states.

If the UI needs retrieval progress, retrieval/indexing should publish or expose
retrieval-specific state. The processing event stream must not keep a media
event open waiting for an index run after the document is readable.

### Error contract

Document read APIs should return service-layer errors that map cleanly to HTTP:

- `404` for missing or unauthorized media where the route's existing auth
  contract uses not-found masking.
- `409` or the existing capability-error mapping for not-yet-readable media.
- `422` or the existing unsupported-capability mapping for media kinds that are
  readable visually but do not have text/page spans.
- `500` only for invariant violations, such as `ready_for_reading` with a
  required current artifact missing.

Do not hide invariant failures with empty reader responses. Empty content is a
valid result only when the source artifact explicitly represents empty readable
content.

## Database and migration plan

The database enum behind `media.processing_status` must be narrowed. PostgreSQL
enum value removal requires replacing the enum type rather than deleting values
in place.

Migration requirements:

- Before altering the type, update any existing `media.processing_status in
  ('embedding', 'ready')` rows to `ready_for_reading`.
- If production should have zero such rows, the migration may assert/report the
  count before mapping, but it must still leave the database in the new valid
  shape.
- Create a new enum type with only
  `pending`, `extracting`, `ready_for_reading`, `failed`.
- Alter `media.processing_status` through a text cast.
- Drop the old enum type and rename the new one to the canonical type name.
- Recreate defaults and constraints exactly as expected by SQLAlchemy models.
- Add a downgrade only if repo migration conventions require it. The product
  plan does not support runtime rollback compatibility.

Data repair is a one-time schema migration concern. Production services must not
contain compatibility code that maps `embedding` or `ready` at runtime.

## Duplicate and repetitive patterns removed

These were the consolidation targets discovered in the codebase survey and
removed or routed through the cutover contract:

- `python/nexus/db/models.py`
  - `ProcessingStatus` declared `embedding` and `ready`.
- `python/nexus/services/capabilities.py`
  - `READABLE_PROCESSING_STATUSES` treated `ready_for_reading`, `embedding`, and
    `ready` as equivalent.
- `apps/web/src/lib/media/readerNavigation.ts`
  - frontend `READABLE_STATUSES` mirrored the legacy backend set.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - client fragment-loading/readiness decisions duplicated reader-navigation
    status logic.
- `apps/web/src/lib/panes/paneServerLoaders.ts`
  - server initial-fragment decisions duplicated client decisions.
- `apps/web/src/lib/media/useMediaProcessingStatus.ts`
  - terminal media-event statuses reflected the old
    `ready` terminal state.
- `python/nexus/services/media.py`
  - processing event snapshots treated `ready` as terminal.
- `python/nexus/services/media_source_ingest.py`,
  `python/nexus/services/metadata_lifecycle.py`, and
  `python/nexus/tasks/enrich_metadata.py`
  - refreshable/ready-state sets were reviewed so source refresh and enrichment
    use the narrowed lifecycle deliberately.
- Backend and frontend tests
  - tests that asserted `embedding` or `ready` media processing compatibility
    were deleted or rewritten around the new contract.

The implementation should remove duplicate local status sets rather than
changing each one independently.

## File plan

### Documentation

- `docs/architecture.md`
  - Update processing-status documentation to say the enum has exactly four
    values.
  - Keep content-index status documentation separate and explicit.
- `docs/cutovers/media-document-readiness-hard-cutover.md`
  - This spec remains the migration plan and audit checklist.
- Any docs mentioning media `embedding` or media `ready`
  - Replace with retrieval/index wording or remove if obsolete.

### Backend model and migrations

- `python/nexus/db/models.py`
  - Narrow `ProcessingStatus`.
  - Ensure `MediaContentIndexState.status` keeps its own `ready`.
- `migrations/alembic/versions/<next>_media_document_readiness_hard_cutover.py`
  - Replace the database enum and repair historical rows.

### Backend services

- `python/nexus/services/media_processing_state.py`
  - Remove transition support for `embedding` and `ready`.
  - Add tests for rejected invalid transitions.
- `python/nexus/services/capabilities.py`
  - Designated owner for document-readiness predicates.
  - Keep read/quote/search capability decisions in the right owner.
- `python/nexus/services/media.py`
  - Update event terminal semantics and API DTO derivation.
- `python/nexus/services/media_document_map.py`
  - Require document readiness through the centralized policy.
- `python/nexus/services/reader_navigation.py`
  - Use centralized read policy for navigation availability.
- `python/nexus/services/epub_read.py`
  - Use centralized read policy for EPUB read APIs.
- `python/nexus/services/epub_assets.py`
  - Confirm asset serving uses file/document readiness, not retrieval readiness.
- `python/nexus/services/content_indexing.py`
  - Keep retrieval state isolated; remove any residual media-status coupling.
- `python/nexus/services/search.py`
  - Keep active-ready index checks; do not depend on media processing `ready`.
- `python/nexus/services/media_source_ingest.py`
  - Review source-refresh gates after enum narrowing.
- `python/nexus/services/metadata_lifecycle.py`
  - Review metadata refresh gates after enum narrowing.
- `python/nexus/tasks/enrich_metadata.py`
  - Review task-ready sets after enum narrowing.

### Frontend

- `apps/web/src/lib/media/documentReadiness.ts`
  - New shared frontend helper for document-readiness and fragment-load
    decisions.
- `apps/web/src/lib/media/readerNavigation.ts`
  - Remove local legacy status set and delegate to the helper.
- `apps/web/src/lib/panes/paneServerLoaders.ts`
  - Use the same helper as the client for initial fragment loading.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - Remove local status gates and use the shared helper/capabilities.
  - Keep retrieval banners keyed to retrieval status.
- `apps/web/src/lib/media/useMediaProcessingStatus.ts`
  - Treat `ready_for_reading` and `failed` as media document terminal states.
- Any status labels or badges
  - Do not show "Embedding" as a media processing status. Show retrieval/index
    progress in retrieval-specific UI only.

### Tests

- `python/tests/test_capabilities.py`
  - Assert `ready_for_reading` is the only successful document media status.
  - Assert retrieval `ready` affects `can_search`, not `can_read`.
- `python/tests/test_media_processing_state.py`
  - Assert no legal transitions to `embedding` or `ready`.
- `python/tests/test_media.py`
  - Assert event snapshots terminalize on `ready_for_reading`.
- `python/tests/test_media.py`
  - Add read gates for pending/extracting/failed/not-text-readable cases.
- `python/tests/test_media_schemas.py`
  - Assert API response schemas reject old media processing statuses.
- `python/tests/test_read_resource_tool.py` and
  `python/tests/test_inspect_resource_tool.py`
  - Assert agent media document tools mask not-ready documents as `missing`.
- `python/tests/test_locator_resolver.py`
  - Assert direct evidence links reject spans from inactive content-index runs.
- `python/tests/test_reconcile_stale_ingest_media.py`
  - Assert stale semantic-ready repair ignores deactivated index runs.
- `python/tests/test_content_indexing.py`
  - Assert indexing success does not mutate `media.processing_status`.
- `python/tests/test_search.py`
  - Assert search requires active ready index state.
- Frontend reader-navigation tests
  - Remove legacy readable-status cases.
  - Assert server and client fragment-load helpers agree.
- Frontend media-pane tests
  - Assert document-ready/readable and retrieval-indexing banners compose
    without blocking each other incorrectly.

## Implementation order

1. Add the database migration and narrow the SQLAlchemy enum.
2. Update backend status-transition owner and remove legacy transition targets.
3. Designate the centralized backend document-readiness policy.
4. Route capability derivation and document-map/read services through that
   policy.
5. Keep content indexing and search on `media_content_index_states`; remove any
   media-status coupling found during the grep audit.
6. Add the shared frontend document-readiness helper.
7. Replace local frontend readable-status and fragment-load checks with the
   helper.
8. Update event terminal semantics to `ready_for_reading`/`failed`.
9. Rewrite tests around the new contract.
10. Update docs and run the grep gates.

The migration and model narrowing should land in the same change as service
updates. Do not deploy a model that rejects persisted enum values before the
database migration repairs those values.

## Acceptance criteria

- `media.processing_status` cannot contain `embedding` or `ready` in the
  database schema.
- SQLAlchemy `ProcessingStatus` exposes only
  `pending`, `extracting`, `ready_for_reading`, and `failed`.
- No production writer can set `media.processing_status` to `embedding` or
  `ready`.
- No production reader treats `embedding` or `ready` as media document-readable.
- `media_content_index_states.status = 'ready'` remains valid and is used by
  search/retrieval paths.
- A media item can be document-readable while retrieval indexing is still
  pending or indexing.
- A media item can have retrieval failure without losing document readability.
- Direct document-read routes fail with a not-ready capability error when the
  document is not readable; agent resource tools mask the same state as
  `missing` under their existing tool contract.
- Page-range and quote APIs distinguish missing text/page spans from source
  extraction failure.
- Frontend server loaders and client components agree on when to load reader
  fragments.
- Frontend retrieval/index banners do not block document-reader rendering.
- Media processing event streams terminalize on `ready_for_reading` and
  `failed`.
- Tests no longer assert legacy readable compatibility.
- Docs no longer describe `embedding` or `ready` as media processing states.

## Grep gates

The implementation is not complete until grep confirms the old media statuses
are gone from live paths.

Allowed hits:

- migration file that maps old enum values
- this cutover spec
- historical changelog text if any exists and is explicitly historical
- retrieval/index code that uses `media_content_index_states.status = 'ready'`

Disallowed live-path hits:

```bash
rg "ProcessingStatus\\.(embedding|ready)\\b" python/nexus python/tests
rg "processing_status.*['\\\"](embedding|ready)['\\\"]" python/nexus python/tests apps/web/src
rg "['\\\"](embedding|ready)['\\\"].*processing_status" python/nexus python/tests apps/web/src
rg "READABLE_.*(embedding|ready)|embedding.*READABLE|ready.*READABLE" python/nexus apps/web/src python/tests
```

Because retrieval uses the word `ready` legitimately, grep review must inspect
context rather than ban the token globally.

## Verification plan

Run targeted tests first:

```bash
cd python && NEXUS_ENV=test uv run pytest -v --tb=short \
  tests/test_capabilities.py \
  tests/test_media_processing_state.py \
  tests/test_media_schemas.py \
  tests/test_media.py \
  tests/test_media_events.py \
  tests/test_read_resource_tool.py \
  tests/test_inspect_resource_tool.py \
  tests/test_locator_resolver.py \
  tests/test_content_indexing.py \
  tests/test_reconcile_stale_ingest_media.py \
  tests/test_search.py

cd apps/web && bun run test:unit -- \
  src/lib/media/readerNavigation.test.ts \
  src/lib/media/documentReadiness.test.ts \
  src/lib/workspace/bootstrap.server.test.ts
```

Then run the repo's normal focused frontend checks for touched files:

```bash
cd apps/web && bun run lint:css-tokens
cd apps/web && bun run lint
cd apps/web && bun run typecheck
```

If the migration touches generated schema snapshots or Alembic heads, run the
repo's migration verification path before merging:

```bash
make test-migrations
```

Do not use broad `make verify` as the first feedback loop for this cutover unless
the user explicitly asks for the full gate. Use it only after the targeted tests
and grep gates pass.

## Composition with other systems

### Current-only artifacts

This cutover complements current-only artifact ownership. Document readiness
should refer to current readable artifacts. Historical artifacts may remain for
audit or migration needs, but read APIs should not fall back to stale artifacts
to compensate for a non-ready current document.

### Durable source ingest

Source ingest remains responsible for producing durable source artifacts and
starting extraction. It should set source/document lifecycle states only through
the media-processing-state owner.

### Content indexing

Content indexing composes after document extraction. It consumes current text
artifacts and publishes retrieval readiness. It must be independently retryable
without mutating document readiness.

### Search

Search composes with content indexing. It should continue to require an active
ready index run and should not use `media.processing_status` as a proxy for
retrieval availability.

### Chat and evidence

Chat tools that retrieve evidence compose with search/index readiness. Chat
tools that directly read a known document compose with document readiness and
`media_document_map`.

### Reader UI

Reader UI composes with document readiness first and retrieval readiness second.
The primary reader should open when the document is readable. Retrieval status
can drive secondary banners, disabled search affordances, or explanation text.

### Library and metadata enrichment

Library views and metadata enrichment should use capability fields or the
centralized readiness helper. They should not carry independent assumptions that
`ready` is a media lifecycle state.

## Key decisions

- The word `ready` is allowed in retrieval/index state and forbidden in media
  processing state.
- `ready_for_reading` is the only successful terminal media document state.
- The hard cutover includes database enum replacement, not only application-code
  changes.
- Data repair belongs in the migration. Runtime compatibility belongs nowhere.
- Capability booleans are the API-level contract for product behavior.
- Document readiness and retrieval readiness can move independently after
  extraction.
- Frontend status displays should be capability-driven and retrieval-specific,
  not enum-string-driven in each component.
- Agent read APIs should fail loudly on broken readiness invariants.

## Implementation checks

Verify:

- the current Alembic head and next migration revision number
- the exact PostgreSQL enum type name in the deployed database
- whether any production rows currently contain `embedding` or `ready`
- whether transcript media uses `processing_status` as an event-stream terminal
  separate from transcript-state events
- whether visual PDF viewing is intended to be covered by `can_read` or by a
  more specific file-view capability
- whether any mobile/native client consumes raw media processing statuses

These checks do not change the target architecture. They determine exact file
edits and rollout sequencing.
