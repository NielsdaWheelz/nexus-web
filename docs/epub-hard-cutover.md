# EPUB Hard Cutover

## Purpose

Replace the current EPUB extraction path with one production-grade EPUB
publication pipeline.

This is a hard cutover. The final state has no legacy EPUB parser, no
compatibility mode, no dual reader model, no old chapter API, no runtime
version branching, no old asset route, and no automatic migration path for old
EPUB highlights or resume state.

The reader remains a sanitized, reflowable HTML reader. Iframe rendering is not
part of this plan.

## Goals

- Parse EPUB files as complete packaged web publications.
- Preserve the current user-facing reader surface.
- Render content-bearing EPUB raster images and safe SVG images through
  controlled app routes.
- Keep EPUB reader styling owned by the application, not publisher CSS.
- Capture all package-level reading structure: manifest, spine, navigation,
  EPUB2 NCX, EPUB2 guide, EPUB3 landmarks, page list, headings, cover metadata,
  and internal resource references.
- Keep one source of truth for EPUB package interpretation.
- Keep highlights anchored to stable fragment canonical text offsets.
- Make search and agent retrieval derive from the same fragments and offsets as
  the reader.
- Make parsing failures, validation failures, asset failures, and invariant
  violations explicit.
- Make retry idempotent and deterministic.
- Remove stale storage assets and stale derived DB rows explicitly.
- Keep FastAPI routes thin, services domain-owned, and Next.js BFF routes
  transport-only.

## Non-Goals

- Iframe-based EPUB rendering.
- Keeping old EPUB parser behavior.
- Keeping old EPUB section IDs stable.
- Preserving existing EPUB highlights, annotations, or reader resume state.
- Runtime compatibility for old EPUB rows.
- A general EPUB editing system.
- DRM support.
- Remote network resource loading from EPUB content.
- Publisher CSS rendering in the primary reader.
- EPUB font loading.
- EPUB audio or video playback.
- Fixed-layout EPUB rendering.
- CSS-generated content recovery.
- A second search implementation dedicated to EPUB.
- A second highlight model dedicated to EPUB.

## User-Facing Target Behavior

- The media page remains the EPUB reader entry point.
- The frontend keeps using:
  - `GET /api/media/{id}/navigation`
  - `GET /api/media/{id}/sections/{section_id}`
  - `?loc={section_id}` deep links
- The reader remains continuous, reflowable, and theme/profile driven.
- Highlights, annotations, highlight pane, quote-to-chat, reader resume, and
  search links keep their visible workflows.
- EPUBs that previously missed content include all readable spine content.
- EPUB raster images and safe SVG images referenced by rendered EPUB content
  load through app-controlled asset URLs.
- Publisher CSS, publisher fonts, audio, video, fixed layout, and other
  presentation-only resources are ignored in reader mode.
- EPUB content uses the app reader typography, spacing, themes, highlights, and
  mobile chrome.
- Search results and agent citations deep-link back into the EPUB reader.
- Invalid or unsupported EPUBs fail ingestion with a clear media processing
  error instead of entering a partial ready state.

## Final State

### Kept

- `media.kind = 'epub'`.
- `fragments` as immutable render/text units.
- `fragment_blocks` as the context-window index over `canonical_text`.
- `GET /media/{id}/navigation` as the backend reader navigation endpoint.
- `GET /media/{id}/sections/{section_id}` as the backend reader content
  endpoint.
- Next.js BFF routes under `/api/media/...`.
- `HtmlRenderer` as the sanitized HTML renderer.
- Fragment-offset highlights.
- Reader resume state shape for EPUB: target section plus canonical text
  location fields.
- Central search service as the only app search implementation.
- Agent app-search tool delegating to central search.

### Removed

- The existing regex-based EPUB resource rewriting path.
- The existing body-wrapper string slicing path.
- The current "linear readable spine only" extraction assumption.
- Warning-only referenced asset upload semantics.
- FastAPI asset URLs that bypass the Next.js BFF.
- The current TOC-only-or-spine-only section materialization behavior.
- Runtime support for stale EPUB-derived rows from the old parser.
- Existing EPUB highlights, EPUB annotations, message contexts that point to
  those highlights, and EPUB reader resume state during cutover.
- Any frontend branch that expects old EPUB error codes or old section
  recovery behavior.

## Architecture

```text
EPUB ingest task
  loads uploaded EPUB file
  validates container shape
  parses package document
  builds publication graph
  writes supported local image assets to storage
  persists derived read models
  marks media readable

Publication graph service
  owns EPUB semantics
  normalizes package paths
  parses OPF, nav, NCX, guide, landmarks, page list, headings
  resolves internal references
  classifies package errors and defects

Asset service
  classifies manifest resources
  stores supported render image assets under opaque deterministic keys
  records resource metadata in DB
  serves supported image assets through BFF-backed routes

Reader service
  exposes navigation and section payloads from persisted read models
  never reparses EPUB archives at read time

Search service
  indexes fragments and derived content chunks
  returns deep links into reader locations

Agent app-search tool
  calls central search
  persists retrieval rows and context refs
```

The EPUB archive is interpreted once during ingestion. The reader, search, and
agent paths consume persisted read models derived from that interpretation.

## Derived Data Rules

- Persisted EPUB package rows are the source of truth for package
  interpretation after ingest.
- Sanitized HTML, canonical text, navigation rows, supported asset rows,
  content chunks, generated tsvectors, and embeddings are derived read models.
- Derived read models are deterministic for a given uploaded file and settings.
- Derived read models are rebuilt together on retry.
- No module reparses EPUB bytes to answer reader, search, highlight, or agent
  requests.
- No module owns an independent EPUB interpretation for its own feature.

## Data Model

### Fragments

`fragments` remain the canonical text anchor table.

Rules:

- One EPUB fragment represents one renderable XHTML content document.
- A fragment stores sanitized HTML and canonical text for that content
  document.
- Fragment canonical text is immutable after the media reaches
  `ready_for_reading`.
- Fragment `idx` is the publication reading-order index.
- Image-only or textless renderable spine items still create fragments with
  empty canonical text when they are part of the reading order.
- Highlight offsets are always local to one fragment.
- No global EPUB text offset is accepted by highlight APIs.

Required schema changes:

- Add `epub_fragment_sources`:
  - `id`
  - `media_id`
  - `fragment_id`
  - normalized package href
  - manifest item id
  - spine itemref id when present
  - media type
  - linear flag
  - reading-order ordinal
  - created_at
- Keep every new table primary-keyed by a UUID `id`.
- Do not add database-level cascade behavior.

### Publication Resources

Add an EPUB resource table owned by the EPUB ingest module.

Required fields:

- `id`
- `media_id`
- normalized package href
- manifest item id
- media type
- properties
- fallback item id from the OPF, when present
- storage key for stored local assets, when the resource is stored
- byte size
- content hash
- created_at

Rules:

- The OPF manifest is the authoritative resource inventory.
- Every local manifest resource is classified.
- Supported raster image and SVG image resources needed for reader rendering
  are stored or the ingest fails.
- Unsupported resources are not stored for reader rendering.
- CSS, fonts, audio, video, fixed-layout resources, scripts, and remote
  resources are ignored in reader mode.
- Remote resources are not fetched during rendering.
- Resource hrefs are resolved structurally against the referencing resource
  base path.

### Navigation

Replace current EPUB navigation tables with a single hard-cutover navigation
model that follows the database rules.

Required concepts:

- TOC tree nodes.
- Reading order locations.
- Landmark locations.
- Page-list locations.
- Heading-derived locations.

Rules:

- Navigation locations point into fragments.
- A fragment supports many navigation locations.
- Navigation does not replace fragments as the text anchor domain.
- Section IDs are deterministic from normalized package href plus anchor id
  when an anchor is present.
- If two locations would produce the same section ID, the ingest fails as a
  defect unless the collision is represented by an explicit deterministic
  disambiguation rule.
- The primary reader section list is deterministic and total-ordered.
- Reader section `char_count` counts the represented fragment text once in
  reading order. It must not double-count multiple TOC locations that point to
  the same fragment.

### Content Chunks

Add `content_chunks` as the single semantic retrieval index for text-bearing
media.

Required fields:

- `id`
- `media_id`
- `fragment_id`
- `chunk_idx`
- `start_offset`
- `end_offset`
- `chunk_text`
- source kind
- heading/navigation context
- locator metadata as typed `jsonb`
- embedding model
- embedding vector
- created_at

Rules:

- Chunks are derived from `fragments.canonical_text`.
- Chunks use half-open fragment-local codepoint offsets.
- Chunks are rebuilt on media reingest.
- Chunk retrieval deep-links to the containing EPUB section and fragment
  offset.
- Transcript semantic retrieval uses `content_chunks`.
- The transcript-only semantic retrieval implementation is removed.
- This cutover does not introduce a second semantic search service.

## Parser Rules

- Parse ZIP entries with normalized, bounded, archive-internal paths.
- Reject zip-slip paths, duplicate normalized paths, unsupported compression
  abnormalities, and entries that exceed configured size limits.
- Locate `META-INF/container.xml`.
- Parse OPF with a safe XML parser.
- Parse XHTML/nav documents with an HTML5-compatible parser.
- Do not use regex for HTML, XML, or URL reference rewriting.
- Decode text resources from BOM, XML declaration, HTTP-equivalent metadata, or
  UTF-8 default in that order.
- Treat package path normalization as an ingress boundary. After normalization,
  non-canonical paths are defects.
- Read both EPUB3 navigation documents and EPUB2 NCX when present.
- Read EPUB2 guide references.
- Read EPUB3 landmarks and page-list navs.
- Extract headings from content documents as derived navigation metadata.
- Read cover metadata from OPF metadata, manifest properties, and guide
  references.
- Preserve manifest fallback-chain metadata from the EPUB package. This is EPUB
  package semantics, not app backward compatibility.
- Ignore scripts and active content.
- Strip or neutralize event handlers, forms, inline scripts, remote script
  references, stylesheet links, style elements, inline style attributes,
  publisher class-driven styling, and unsafe URLs during sanitization.
- Preserve only structural markup and safe image references required for reader
  rendering.

## Asset Rules

- The primary reader supports only manifest-declared, content-bearing local
  image assets:
  - raster images referenced by sanitized HTML image attributes
  - sanitized SVG images referenced by sanitized HTML or SVG image attributes
  - cover images when surfaced by app-owned reader UI
- The primary reader does not support publisher CSS, publisher fonts, audio,
  video, fixed-layout resources, scripts, or active SVG features.
- Store every supported manifest-declared local image asset referenced by
  rendered content.
- Do not store unsupported resources for reader rendering.
- Rewrite references only in supported image-bearing attributes:
  - HTML `img[src]`
  - HTML `img[srcset]`
  - SVG image `href` and `xlink:href`
- Strip unsupported local resource references from rendered HTML.
- Rewritten asset URLs use one canonical BFF path:
  - `/api/media/{media_id}/assets/{asset_key}`
- Asset keys are opaque to the client. Package hrefs remain internal metadata.
- Add the matching Next.js BFF route.
- Add the matching FastAPI route.
- The frontend never calls FastAPI asset URLs directly.
- Stored asset response headers include content type, cache policy, and content
  length when known.
- Stored asset response headers include `X-Content-Type-Options: nosniff`.
- Stored SVG asset responses include a restrictive asset-level CSP.
- Asset responses never expose private storage URLs.
- Asset writes happen outside DB transactions.
- Ingest writes external assets before making DB rows observable.
- Retry cleanup removes old DB rows first, then removes old external storage
  resources.

### SVG Rules

- Referenced SVG assets are parsed and sanitized during ingest before storage.
- Sanitized SVG assets remove scripts, event handlers, animation elements,
  `foreignObject`, remote URL references, embedded HTML, and active content.
- SVG assets that cannot be sanitized are ingest failures when referenced by
  rendered content.
- Inline SVG in content documents follows the same sanitizer policy as
  referenced SVG assets.
- SVG loaded as an image remains an image asset. It is not treated as an EPUB
  document, script surface, or stylesheet surface.

## API Contracts

### Navigation

`GET /media/{id}/navigation` returns:

- `sections`: total-ordered reader locations
- `toc_nodes`: nested TOC tree
- `landmarks`: ordered locations, empty when absent
- `page_list`: ordered locations, empty when absent

The default reader payload remains focused on reader navigation. It does not
expose the whole publication graph.

EPUB diagnostics are stored for operator inspection outside the reader payload.

### Section Content

`GET /media/{id}/sections/{section_id}` returns one reader section payload.

Rules:

- The payload includes one fragment's sanitized HTML and canonical text.
- The payload includes prev/next section IDs.
- Missing sections return one explicit error code. The frontend handles that
  code by reloading navigation once and then showing the media error.
- The endpoint never reparses the EPUB archive.

### Assets

`GET /media/{id}/assets/{asset_key}` returns one stored supported EPUB image
asset.

Rules:

- Permission checks match media read permission.
- Only stored, media-owned assets can be served.
- Only supported image asset content types are served.
- Missing asset rows return one explicit not-found error code.
- Missing storage objects for existing asset rows are defects.
- Invalid asset keys return one explicit invalid-request error code.
- Asset keys are opaque to the client.
- The endpoint does not serve CSS, fonts, audio, video, scripts, EPUB package
  documents, or arbitrary manifest resources.

## Highlight And Resume Rules

- Highlights remain `fragment_offsets`.
- Highlight creation validates against the active fragment canonical text.
- Highlight rendering continues to rebuild a frontend canonical cursor and
  compare it to backend `canonical_text`.
- A canonical mismatch is a defect, not a user-facing recovery state.
- EPUB reader resume keeps the existing visible behavior.
- Existing EPUB reader resume rows are deleted during cutover.
- New EPUB resume state stores:
  - section ID
  - href path
  - anchor ID when present
  - fragment-local text offset
  - progression fields
  - quote context
- Resume restoration uses current navigation and current fragment text only.
- No old section ID remapping path exists after cutover.

## Search And Agent Rules

- Keyword search continues to search `fragments.canonical_text`.
- Semantic search uses `content_chunks` for all text-bearing media.
- App search uses the central search service only.
- Agent citations persist backend-owned context refs.
- Retrieved EPUB context includes:
  - media title
  - author metadata when present
  - section or heading label when present
  - exact chunk text
  - deep link to the section
- The agent tool never reads EPUB archives.
- The agent tool never constructs EPUB source locations itself.

## Ingest And Retry Rules

- Ingest is deterministic for the same uploaded file and settings.
- Ingest is idempotent for retry.
- Ingest deletes old EPUB-derived DB rows explicitly before persisting new
  derived rows.
- Ingest deletes old EPUB storage assets explicitly after DB teardown makes them
  unobservable.
- Ingest does not run external storage writes inside a DB transaction.
- Ingest does not mark media readable until required DB rows and required stored
  image assets exist.
- A supported image asset that is referenced by rendered content but not stored
  is an ingest failure.
- Unsupported presentation resources are stripped or ignored. They do not create
  reader fallbacks and do not block readiness unless their absence removes
  required readable content.
- An EPUB with no readable spine content is an ingest failure.
- An EPUB with invalid package structure is an ingest failure.
- EPUBCheck output is captured as diagnostics. Fatal validation failures block
  readiness. Warnings are stored as diagnostics and do not block readiness
  unless they correspond to a rule above.

## Cutover Data Policy

The cutover is destructive for existing EPUB-derived artifacts.

During the cutover task:

- Delete EPUB reader resume state.
- Delete EPUB highlights.
- Delete annotations attached to deleted EPUB highlights.
- Delete message contexts attached to deleted EPUB highlights or annotations.
- Delete EPUB fragments.
- Delete EPUB navigation rows.
- Delete EPUB resource metadata rows.
- Delete EPUB search chunks and embeddings.
- Delete stored EPUB assets.
- Reingest EPUB files from stored original uploads.

No highlight salvage runs. No old section remapping runs. No compatibility
branch remains after the cutover.

## File Plan

### Documentation

- `docs/epub-hard-cutover.md`
- Update `docs/reader-implementation.md` after implementation to record the
  shipped final state.

### Backend

- `python/nexus/services/epub_ingest.py`
  - Extract only referenced manifest-declared raster and SVG image assets.
  - Strip publisher CSS, fonts, audio, video, fixed-layout resources, and
    unsupported local references from reader HTML.
  - Sanitize referenced SVG assets before storage.
  - Fail ingest when rendered content references a missing local image asset.
- `python/nexus/services/media.py`
  - Enforce media visibility, kind, readiness, asset-key validity, image-only
    content types, and storage lookup for EPUB reader assets.
- `python/nexus/services/epub_read.py`
  - Read persisted reader models only.
- `python/nexus/services/sanitize_html.py`
  - Keep sanitization centralized. Preserve only structural markup and safe
    image references through typed EPUB inputs.
- `python/nexus/services/canonicalize.py`
  - Keep canonical text generation as the single backend text contract.
- `python/nexus/services/search.py`
  - Replace transcript-specific semantic retrieval with content chunk
    retrieval.
- `python/nexus/services/semantic_chunks.py`
  - Own generic content chunking and embedding helpers.
- `python/nexus/services/agent_tools/app_search.py`
  - Continue to call central search. Do not add EPUB-specific retrieval logic.
- `python/nexus/api/routes/media.py`
  - Add image asset route and keep route handlers transport-shaped.
- `python/nexus/db/models.py`
  - Add hard-cutover EPUB resource/navigation/chunk models.
- `migrations/alembic/versions/*`
  - Add destructive hard-cutover schema and data migration.

### Frontend

- `apps/web/src/app/api/media/[id]/assets/[...assetKey]/route.ts`
  - Image asset BFF proxy route.
- `apps/web/src/lib/api/proxy.ts`
  - Forward the safe response headers needed for binary EPUB image assets.
- `apps/web/src/lib/media/epubReader.ts`
  - Update reader DTOs to the new navigation payload.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - Keep reader behavior; remove stale recovery/error-code branches.
- `apps/web/src/app/(authenticated)/media/[id]/EpubContentPane.tsx`
  - Keep rendering through `HtmlRenderer` with app-owned reader styling.
- `apps/web/src/components/HtmlRenderer.tsx`
  - Remains the only direct sanitized HTML insertion point. It does not perform
    client-side resource rewriting or publisher stylesheet loading.
- `apps/web/src/lib/search/resultRowAdapter.ts`
  - Accept content chunk results through central search DTOs.

### Tests

- `python/tests/test_epub_ingest.py`
- `python/tests/test_epub_ingest_real_fixtures.py`
- `python/tests/test_media.py`
- `apps/web/src/app/api/media/[id]/assets/[...assetKey]/route.test.ts`
- `python/scripts/seed_e2e_data.py`
- `python/tests/test_search.py`
- `python/tests/test_agent_app_search.py`
- `apps/web/src/lib/highlights/*.test.ts`
- `apps/web/src/lib/media/epubReader.test.ts`
- `e2e/tests/epub.spec.ts`
- `e2e/tests/search.spec.ts`
- `e2e/tests/reader-resume.spec.ts`

## Test Plan

Follow red/green TDD from the acceptance criteria.

### Unit Tests

- EPUB path normalization rejects zip-slip and duplicate normalized paths.
- OPF parsing extracts manifest, spine, metadata, cover, fallback-chain
  metadata, and package direction.
- Navigation parsing extracts EPUB3 TOC, landmarks, page list, and EPUB2 NCX.
- Image URL rewriting resolves paths from the referencing content document.
- `img[srcset]` rewriting preserves descriptors.
- SVG asset sanitization strips active content and remote references.
- Unsupported CSS, font, audio, video, and fixed-layout resources are ignored
  without creating reader fallback branches.
- Canonical text generation remains identical between backend and frontend for
  touched fixtures.

### Backend Integration Tests

- Ingest persists one fragment for every renderable reading-order content
  document, including image-only spine items.
- Ingest persists all required raster and SVG image render assets.
- Ingest fails when a referenced local image render asset cannot be stored.
- Ingest rejects referenced SVG assets that cannot be sanitized.
- Navigation returns deterministic sections and does not double-count char
  counts for repeated TOC targets.
- Section content returns sanitized HTML and canonical text from persisted rows.
- Asset route enforces media read permission and serves stored image assets.
- Asset route rejects invalid keys, masks unreadable media, distinguishes
  missing asset rows from missing storage defects, and emits required headers.
- Keyword search returns EPUB fragment hits with valid deep links.
- Semantic search returns content chunk hits with valid deep links.
- Transcript semantic search is backed by `content_chunks`.
- Agent app search retrieves chunks through central search and persists
  backend-owned refs.
- Retry removes old derived rows and old assets before publishing new rows.

### Frontend Component Tests

- Highlight rendering still aborts on canonical mismatch.
- Selection-to-offset conversion still produces fragment-local offsets.
- EPUB navigation DTO parsing accepts the final payload and rejects malformed
  rows.
- Search result adapter accepts content chunk results.

### E2E Tests

- A real EPUB opens through the same media page and renders raster images.
- A real EPUB opens through the same media page and renders sanitized SVG
  images.
- EPUB publisher CSS does not affect the reader or app chrome.
- No unresolved local image URLs remain in rendered EPUB HTML.
- The browser makes no remote network requests for EPUB-local resources.
- TOC navigation opens nested TOC targets.
- Internal links navigate within the EPUB reader.
- Highlight create, edit, delete, and annotation work in an EPUB section.
- Quote-to-chat from an EPUB highlight includes the selected quote and source.
- EPUB keyword search opens the result section.
- EPUB semantic search opens the result section.
- Transcript semantic search still opens the transcript timestamp target.
- EPUB resume survives reload and profile reflow.
- Reingest after failure produces exactly one readable derived state.

## Acceptance Criteria

- All EPUB reader APIs are served by the new persisted read model.
- No code path reparses the EPUB archive at reader, search, or agent-query time.
- No old EPUB parser functions remain.
- No runtime branch exists for old EPUB rows.
- No old EPUB asset URL shape remains in sanitized HTML.
- Every rendered local image URL resolves through `/api/media/{id}/assets`.
- Raster image assets referenced by rendered EPUB content load in the browser.
- Sanitized SVG image assets referenced by rendered EPUB content load in the
  browser.
- Publisher CSS, fonts, audio, video, fixed-layout resources, scripts, and
  active SVG features are absent from reader-mode rendering.
- The reader and app chrome remain styled only by app-owned CSS.
- The browser makes no remote EPUB resource requests during reader rendering.
- Existing EPUB highlights and EPUB resume states are removed by cutover.
- Highlight creation and rendering use fragment-local canonical offsets only.
- Search and agent citations point back to fragment-derived reader locations.
- Semantic retrieval has one content chunk implementation.
- EPUB ingest cannot mark media readable when required image assets are missing
  or referenced SVG assets cannot be sanitized.
- Retry is idempotent and leaves no duplicate fragments, nav rows, chunks, or
  resource rows.
- The implementation passes `make verify` and `make test-e2e`.

## Key Decisions

- Hard runtime cutover beats compatibility.
- Existing EPUB highlights are discarded, not salvaged.
- Fragments remain the text anchor domain.
- Navigation locations point into fragments.
- Sections remain an API convenience, not the authoritative model.
- The OPF manifest is the resource inventory source of truth.
- Reader mode intentionally favors app-owned readability styling over publisher
  styling.
- Render asset support is limited to content-bearing raster and sanitized SVG
  images.
- CSS, fonts, audio, video, fixed layout, scripts, and active SVG features are
  unsupported in reader mode.
- All render-required local image assets are stored.
- Asset serving goes through the Next.js BFF.
- EPUB parsing is an ingest concern only.
- Search and agent retrieval derive from fragment text and `content_chunks`.
- EPUBCheck is diagnostic input, not the parser.
- EPUB package fallback-chain metadata is parsed as EPUB semantics; old app
  fallback behavior is not preserved.

## Rule Alignment

- `docs/rules/layers.md`: BFF routes proxy, FastAPI routes validate, services
  own domain logic.
- `docs/rules/correctness.md`: EPUB input is parsed and canonicalized at
  ingress; non-canonical trusted values are defects.
- `docs/rules/module-apis.md`: one parser, one asset route, one search path.
- `docs/rules/simplicity.md`: no feature flag, no compatibility mode, no dual
  parser.
- `docs/rules/control-flow.md`: finite EPUB variants and error codes must be
  explicitly handled.
- `docs/rules/database.md`: new tables use UUID primary keys, explicit cleanup,
  and no new DB-level cascades.
- `docs/rules/concurrency.md`: external storage and DB mutation ordering is
  explicit.
- `docs/rules/testing_standards.md`: acceptance criteria drive behavior tests.
