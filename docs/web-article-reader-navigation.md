# Spec: Web Article Reader Navigation Hard Cutover

Status: Accepted source/navigation contract. Frontend text-reader layout is
owned by `docs/text-document-reader-layout-cutover.md`.
Owner: reader + ingestion/content index
Date: 2026-05-27
Hard cutover. No legacy code, no fallback DOM heading scan, no backward
compatibility for EPUB-only navigation schemas, no feature flag, no duplicate
article navigation endpoint.

---

## 1. Problem statement

Web articles currently preserve `h1` through `h6` tags inside
`fragments.html_sanitized`, but the reader treats them as unstructured rendered
HTML. The backend flattens the article into `fragments.canonical_text`, parses
blank-line `fragment_blocks`, and indexes every web block as a generic
paragraph. The result:

- the reader has no web article table of contents or outline
- search, citations, quote-to-chat, and evidence context do not get article
  section labels from web headings
- X thread `web_article` media can have multiple fragments, but there is no
  document-wide heading/navigation model across those fragments
- the frontend could scrape headings from rendered DOM, but that would create a
  second parser after the sanitizer/canonicalizer boundary

EPUB already has a first-class navigation model at `GET /api/media/{id}/navigation`.
That route is generic in path name but EPUB-specific in route function, service,
schema, frontend types, and tests. Web articles should join this reader
navigation capability. They should not get a parallel `/article-toc` endpoint,
frontend-only parser, or UI-only structure that cannot compose with reader
resume, search evidence, quote contexts, and source versioning.

## 2. Goals

- G1. Web articles with meaningful headings expose a source-backed reader
  navigation outline derived from sanitized persisted article HTML.
- G2. `GET /api/media/{id}/navigation` becomes the single reader navigation API
  for every media kind that has a real navigation model.
- G3. EPUB navigation remains supported through the generalized reader
  navigation API, with no separate EPUB-only client contract.
- G4. Web article heading structure is extracted at the backend content boundary,
  not by scanning rendered DOM in `MediaPaneBody` or `HtmlRenderer`.
- G5. Web article headings flow into the existing content index model:
  `content_index_runs`, `source_snapshots`, `content_blocks`, and
  `content_chunks`.
- G6. Search, evidence, quote-to-chat, context rendering, and reader source
  activation can use web article `heading_path` and `source_version` from the
  same active index run as other source-backed content.
- G7. Navigation nodes carry deterministic source-version-scoped identities,
  canonical offsets, fragment targets, and generated anchor ids.
- G8. The UI presents document navigation as navigation, not as a command menu:
  desktop uses a labeled contents surface; mobile uses a drawer/sheet backed by
  the same payload.
- G9. Invalid or stale navigation locators fail explicitly. They are not
  repaired through fuzzy matching, DOM search, old ids, heading text matching, or
  source URL anchors.
- G10. The implementation consolidates repeated web article preparation code
  instead of adding a third copy of sanitize/canonicalize/block extraction.

## 3. Non-goals

- NG1. No frontend-derived heading parser. The frontend never calls
  `querySelectorAll("h1,h2,h3,h4,h5,h6")` to create the canonical outline.
- NG2. No new `/api/media/{id}/article-navigation`,
  `/api/media/{id}/headings`, or `/api/media/{id}/toc` endpoint.
- NG3. No AI-generated or inferred outline in this cutover. If an article has
  no source headings, it has no outline.
- NG4. No fallback from missing indexed navigation to runtime parsing of
  `html_sanitized`.
- NG5. No preservation of raw source heading ids as trusted target ids. Source
  ids may be read for diagnostics later, but v1 generated anchors are
  server-owned.
- NG6. No migration of old `?fragment=` URLs into heading locators.
  `?fragment=` remains a text-fragment/evidence/highlight route input, not the
  reader navigation identity.
- NG7. No pane title derivation from headings, section labels, canonical URL,
  source version, or active reader location.
- NG8. No new secondary-rail tab. The secondary rail remains highlights,
  doc-chat, and library-chat. Contents navigation is reader chrome, not chat
  or assistant state.
- NG9. No speculative DB indexes or new heading table before the active
  `content_blocks` query pattern proves it needs one.
- NG10. No backward compatibility for internal EPUB-only names. The cutover
  renames the API/service/frontend contracts to reader navigation.

## 4. Current system to reuse and consolidate

### 4.1 Existing ingestion path

Use the existing web article ingestion path as the source boundary:

- `node/ingest/ingest.mjs` fetches a URL and runs Mozilla Readability.
- `python/nexus/tasks/ingest_web_article.py` sanitizes Readability HTML,
  generates canonical text, creates a `Fragment`, inserts `fragment_blocks`,
  and calls `rebuild_fragment_content_index`.
- `python/nexus/services/media.py::create_captured_web_article` performs the
  same sanitize/canonicalize/fragment/index path for extension-captured pages.
- X/Twitter article/thread helpers in `python/nexus/services/media.py` create
  `web_article` fragments and rebuild the same fragment content index.

This cutover introduces one owned preparation path for web article fragments.
Callers stop manually sequencing `sanitize_html`, `generate_canonical_text`,
`parse_fragment_blocks`, `insert_fragment_blocks`, and
`rebuild_fragment_content_index` as unrelated steps.

### 4.2 Existing HTML and text contracts

Reuse and tighten:

- `python/nexus/services/sanitize_html.py` already allowlists `h1` through
  `h6` and owns HTML trust.
- `python/nexus/services/canonicalize.py` owns canonical text generation and
  must remain byte-for-byte aligned with frontend canonical cursor behavior.
- `python/nexus/services/fragment_blocks.py` owns codepoint block ranges used
  for deterministic context windows.
- `apps/web/src/components/HtmlRenderer.tsx` is the only component allowed to
  use `dangerouslySetInnerHTML`.

The heading extractor must use the same canonical DOM walk as
`generate_canonical_text`. Do not implement a second text walker with
"equivalent enough" whitespace rules.

### 4.3 Existing index and evidence model

Reuse the content index rather than creating a second outline store:

- `content_index_runs.source_version` identifies the active extracted source.
- `source_snapshots` records source fingerprint, content hash, source version,
  extractor version, and artifact metadata.
- `content_blocks.block_kind`, `locator`, `selector`, `heading_path`, and
  `metadata` already model source-backed blocks.
- `content_chunks.heading_path` already flows into search/evidence result
  hydration and prompt context rendering.
- `media_content_index_states.active_run_id` already identifies the only active
  run for a media item.

Final source of truth for web article reader navigation is the active content
index run. `fragment_blocks` may carry `block_type` for local context-window
utility, but it is not the navigation API source of truth.

### 4.4 Existing reader navigation path

Reuse and generalize:

- `python/nexus/api/routes/media.py::get_epub_navigation`
- `python/nexus/services/epub_read.py::get_epub_navigation_for_viewer`
- `python/nexus/schemas/media.py::EpubNavigationOut` and related classes
- `apps/web/src/lib/media/readerNavigation.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` navigation
  loading, EPUB section selection, `?loc`, and content rendering orchestration
- `apps/web/src/app/api/media/[id]/navigation/route.ts` BFF proxy

The path `/api/media/{id}/navigation` survives. EPUB-specific service/schema
names do not.

## 5. Final state - target behavior

### 5.1 Reader navigation concept

Reader navigation is a source-backed ordered list of document locations.
Navigation locations are not media titles, search snippets, summaries, chat
state, or reader resume records.

Supported kinds after this cutover:

| Media kind | Navigation source | Content source |
|---|---|---|
| `epub` | persisted EPUB nav locations and TOC nodes | EPUB sections endpoint |
| `web_article` | active `content_blocks` heading blocks | existing fragments endpoint |

Unsupported media kinds return `409 E_INVALID_KIND` from
`GET /api/media/{id}/navigation`. There is no empty fake navigation payload for
unsupported kinds.

### 5.2 Web article outline visibility

A web article has a visible contents affordance when the active reader
navigation payload contains at least two navigable heading sections after
normalization.

Normalization removes:

- blank headings
- headings whose normalized label exactly duplicates the media title and are
  the first heading in the first fragment
- headings whose canonical offset cannot be mapped exactly

Normalization does not invent headings from bold text, paragraphs, metadata,
OpenGraph title, Readability title, AI summaries, or source URL path segments.

If the payload has zero or one section, the reader hides the contents affordance.
The API still returns `sections: []` or a single section. The UI does not parse
the DOM to "try harder."

### 5.3 Heading hierarchy

The extractor records every valid `h1` through `h6` in document order.

Each heading has:

- raw heading level: `1..6`
- normalized display depth: derived by stack from previous headings, with no
  phantom parent nodes
- display label: normalized visible text
- deterministic `section_id`
- deterministic generated `anchor_id`
- `fragment_id` and `fragment_idx`
- `start_offset` and `end_offset` in fragment canonical text
- `heading_path` from the current heading stack
- `ordinal` within the whole media item

Skipped heading levels are preserved as raw levels. Rendering may indent by
normalized depth so an `h4` after an `h2` is one displayed level deeper than
that `h2`, not two empty levels under missing `h3`.

Duplicate labels are allowed. Duplicate target ids are not.

### 5.4 Heading ids and anchors

Generated web article anchors are server-owned. The source page's raw `id` and
`a[name]` attributes are not trusted navigation targets.

Generated id contract:

```text
section_id = web-heading:{fragment_idx}:{heading_ordinal}:{slug}
anchor_id = nexus-web-heading-{fragment_idx}-{heading_ordinal}-{slug}
```

Rules:

- `slug` is derived from normalized heading text.
- `slug` is lowercase ASCII, dash-separated, and stripped to safe URL-fragment
  characters.
- empty slugs become `section`.
- ids are deterministic for the same sanitized source and extractor version.
- ids are scoped to `source_version`; stale ids from old source versions are
  invalid.
- ids do not include database primary keys.
- if the generated id already exists in the sanitized HTML, append a numeric
  suffix deterministically.

The sanitizer/structure-preparation owner adds these ids before the sanitized
HTML is persisted. `HtmlRenderer` only renders persisted sanitized HTML; it does
not create ids.

### 5.5 URL behavior

`?loc=` becomes the canonical reader navigation location query for all media
kinds that implement reader navigation.

Final meaning:

- EPUB: `?loc={epub_section_id}`
- web article: `?loc={web_heading_section_id}`

`?loc` is reader location state inside the `media:{id}` pane resource. Changing
it must not reset pane title state, remount the media pane body, clear tabs, or
derive titles from navigation labels.

Invalid `?loc` handling:

- If `loc` is absent, the reader opens from saved resume or default content.
- If `loc` is present and not in the active navigation payload, the frontend
  removes `loc` with `router.replace`, keeps the media open, and shows one
  explicit "Section unavailable" warning.
- The frontend never searches by heading label, old section id, source URL
  hash, or DOM id to repair invalid `loc`.

`?fragment=` remains the text-source/evidence/highlight fragment selector. It is
not renamed and is not a navigation section id.

### 5.6 Reader jump behavior

Selecting a web article navigation item:

1. pushes `/media/{id}?loc={section_id}` in the active pane
2. resolves the section through the loaded navigation payload
3. switches active fragment when the target heading belongs to a different
   fragment
4. waits for the target fragment to render
5. scrolls to the generated heading anchor or canonical offset
6. applies active-section state in the contents UI
7. cancels any pending restore session for the previous reader location

The scroll target is source-backed. If both anchor id and canonical offset are
available, the canonical offset is the verification source; the anchor is the
DOM target.

### 5.7 Desktop UI

Desktop exposes article contents as reader navigation chrome, not as a command
menu and not as a chat rail tab.

Final shape:

- A compact Contents control appears in the media reader toolbar for web
  articles and EPUBs that have navigation.
- Opening it renders a labeled navigation surface containing nested lists of
  plain links/buttons to sections.
- The surface uses `<nav aria-labelledby=...>` for document navigation
  semantics when inline/non-modal.
- The active section is marked with `aria-current="location"`.
- Long outlines collapse lower levels by default:
  - if node count <= 20, all nodes are expanded
  - if node count > 20, depth 1 and depth 2 are expanded; deeper branches expand
    under the active section or when clicked
- The contents surface does not overlap readable text at desktop widths where a
  side panel can fit. If space is constrained, it behaves like the mobile
  drawer.

### 5.8 Mobile UI

Mobile exposes the same navigation payload through a sheet/drawer from reader
chrome.

Rules:

- The affordance is visible and named. It is not a hidden swipe gesture.
- If the sheet is modal, it follows modal dialog focus rules: focus enters the
  sheet, Escape/back closes, outside content is inert, and focus returns to the
  opener.
- If the sheet is non-modal, it uses normal navigation semantics and does not
  claim `aria-modal`.
- The sheet does not insert contents text inside the article `contentRef`.

### 5.9 Search, evidence, citations, and quote-to-chat

Web article heading paths become source-backed evidence labels.

Required composition:

- `content_blocks.heading_path` is populated for heading and paragraph blocks
  under headings.
- `content_chunks.heading_path` carries the same path for retrieval results.
- Search result citation labels use the deepest heading when available instead
  of generic `"Source"`.
- Reader source targets from search/evidence keep their existing locator shape
  for exact text offsets.
- Quote-to-chat reader selections include the active `source_version`; if it is
  missing, context creation fails as it does today.
- Navigation labels never become media titles.

### 5.10 Reader resume

Reader resume remains canonical text-offset based for web articles.

Heading navigation is not a new `ReaderResumeState.kind`. A heading jump updates
the visible position; subsequent scroll-save persists the canonical offset and
fragment target through the existing web reader state contract.

### 5.11 Refresh and reindex behavior

Source refresh or reingest creates a new source version. Old web heading
`section_id` values are invalid for the new active version.

The final web article source version is content-derived:

```text
web_article:fragments:{sha256}
```

where the hash covers the joined canonical text plus the generated heading
structure contract. The fixed string `fragments_v1` is deleted for
`web_article` index runs.

## 6. Architecture

### 6.1 Ownership

| Capability | Owner |
|---|---|
| Raw article extraction | `node/ingest/ingest.mjs` |
| HTML trust and allowed tags/attributes | `python/nexus/services/sanitize_html.py` |
| Canonical text and offset walk | `python/nexus/services/canonicalize.py` |
| Web article structure extraction | new `python/nexus/services/web_article_structure.py` |
| Fragment creation and indexing orchestration | web article ingestion/capture services |
| Active source-backed blocks | `python/nexus/services/content_indexing.py` |
| Reader navigation read model | new `python/nexus/services/reader_navigation.py` |
| HTTP route validation/response envelope | `python/nexus/api/routes/media.py` |
| BFF proxy | `apps/web/src/app/api/media/[id]/navigation/route.ts` |
| Frontend navigation types/helpers | new `apps/web/src/lib/media/readerNavigation.ts` |
| Reader rendering and interaction | `MediaPaneBody` plus extracted reader navigation components |

### 6.2 Web article structure service

Add `python/nexus/services/web_article_structure.py`.

Public contract:

```python
@dataclass(frozen=True)
class WebArticlePreparedFragment:
    html_sanitized: str
    canonical_text: str
    fragment_blocks: list[FragmentBlockSpec]
    index_blocks: list[WebArticleIndexBlockSpec]
    source_fingerprint_material: str

def prepare_web_article_fragment(
    *,
    html: str,
    base_url: str,
    fragment_idx: int,
    media_title: str | None,
) -> WebArticlePreparedFragment: ...
```

Rules:

- The function owns the sequence `sanitize -> add generated heading anchors ->
  canonicalize -> extract blocks`.
- It raises a typed/expected error for invalid HTML or empty canonical text.
- It does not commit DB rows and does not import HTTP/FastAPI types.
- It does not call Readability.
- It does not call provider APIs.
- It uses the canonicalizer's internal DOM walk, refactored if necessary, so
  canonical offsets cannot drift from reader selection offsets.

`WebArticleIndexBlockSpec` includes:

```python
block_idx: int
block_kind: Literal["heading", "paragraph", "blockquote", "list", "code", "table"]
start_offset: int
end_offset: int
text_quote: str
heading_level: int | None
heading_path: tuple[str, ...]
section_id: str | None
anchor_id: str | None
ordinal: int
metadata: dict[str, object]
```

Only `heading` blocks create reader navigation sections. Paragraph-like blocks
inherit the current `heading_path`.

### 6.3 Content indexing

Refactor `rebuild_fragment_content_index` so `source_kind == "web_article"`
does not derive every `IndexableBlock` from blank-line parsing.

Final web path:

1. Prepared fragments provide structured index blocks.
2. `rebuild_fragment_content_index` writes `content_blocks` from those specs.
3. `block_kind` is no longer always `"paragraph"` for web articles.
4. `heading_path` is populated for all blocks under headings.
5. `locator` and `selector` carry web navigation metadata for heading blocks.
6. `source_version` is content-derived and non-empty.
7. `extractor_version` is a semantic version string for this extractor, e.g.
   `web_article_structure_v1`.

Final heading block locator:

```json
{
  "type": "web_text_offsets",
  "kind": "web_text",
  "version": 2,
  "fragment_id": "<uuid>",
  "fragment_idx": 0,
  "start_offset": 42,
  "end_offset": 58,
  "text_quote": "Section title",
  "section_id": "web-heading:0:3:section-title",
  "anchor_id": "nexus-web-heading-0-3-section-title",
  "heading_level": 2
}
```

The existing `locator.kind` field is retained where already used. The
`locator.type` discriminator is retained for compatibility with current reader
source activation internals, but this is the final shape after the cutover; no
old alternative web locator shapes are accepted for new source-backed contexts.

### 6.4 Reader navigation service

Add `python/nexus/services/reader_navigation.py`.

Public contract:

```python
def get_media_navigation_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaNavigationOut: ...
```

Behavior:

- verifies media visibility once
- dispatches by `Media.kind`
- for `epub`, calls the EPUB navigation query path after it has been moved or
  wrapped behind this service
- for `web_article`, queries active `content_blocks` with
  `block_kind='heading'`
- returns source version from the active source snapshot/run
- returns `409 E_INVALID_KIND` for unsupported media kinds
- does not parse fragments or HTML at read time
- does not return stale runs
- does not perform fuzzy matching

### 6.5 API schema

Replace EPUB-only schema names in `python/nexus/schemas/media.py`.

Final response:

```python
class ReaderNavigationSectionOut(BaseModel):
    section_id: str
    label: str
    ordinal: int
    level: int | None = None
    depth: int | None = None
    fragment_id: UUID | None = None
    fragment_idx: int | None = None
    start_offset: int | None = None
    end_offset: int | None = None
    anchor_id: str | None = None
    href_path: str | None = None
    href_fragment: str | None = None
    source_version: str | None = None

class ReaderNavigationTocNodeOut(BaseModel):
    id: str
    label: str
    ordinal: int
    level: int | None = None
    depth: int | None = None
    section_id: str | None = None
    href: str | None = None
    source_version: str | None = None
    children: list["ReaderNavigationTocNodeOut"] = []

class ReaderNavigationLocationOut(BaseModel):
    id: str
    label: str
    ordinal: int
    section_id: str | None = None
    href: str | None = None
    source_version: str | None = None

class MediaNavigationOut(BaseModel):
    media_id: UUID
    kind: Literal["epub", "web_article"]
    source_version: str | None
    sections: list[ReaderNavigationSectionOut]
    toc_nodes: list[ReaderNavigationTocNodeOut]
    landmarks: list[ReaderNavigationLocationOut] = []
    page_list: list[ReaderNavigationLocationOut] = []
```

For web articles:

- `sections` contains one row per heading.
- `toc_nodes` contains the heading tree.
- `landmarks` and `page_list` are empty.
- `href_path` and `href_fragment` are null.
- `start_offset`, `end_offset`, `fragment_id`, `fragment_idx`, and
  `anchor_id` are required.

For EPUB:

- payload maps existing EPUB data into the generalized names.
- `start_offset` and `end_offset` may remain null unless already known.
- `href_path` and `href_fragment` preserve existing EPUB section behavior.

### 6.6 HTTP API

`GET /api/media/{id}/navigation`

Preconditions:

- viewer can read the media
- media kind is `epub` or `web_article`
- media has an active source/read model sufficient for navigation

Responses:

- `200 { "data": MediaNavigationOut }`
- `404` if media is not visible
- `409 E_INVALID_KIND` for unsupported kind
- `409 E_MEDIA_NOT_READY` when the media is still extracting or has no active
  content source

Route handler rule:

- `python/nexus/api/routes/media.py` validates input, calls
  `reader_navigation.get_media_navigation_for_viewer`, and wraps the response.
- It contains no content-index SQL and no media-kind business logic.

### 6.7 Frontend contract

Use `apps/web/src/lib/media/readerNavigation.ts` as the single frontend reader
navigation type/helper module.

Final frontend types mirror `MediaNavigationOut`.

Frontend rules:

- `MediaPaneBody` loads navigation for every readable `epub` and `web_article`.
- `MediaPaneBody` never derives canonical navigation by parsing rendered DOM.
- `HtmlRenderer` remains render-only and does not emit heading lists.
- `TextDocumentReader` renders the shared web article and EPUB text-reader
  surface. Do not add a second TOC component with equivalent logic.
- Navigation jumps use `?loc` and the loaded navigation payload.
- Web heading jumps use existing text-reader scroll/canonical cursor utilities
  where possible.

## 7. Capability contract

No new plan/entitlement flag is introduced.

Navigation availability is a media/read-model capability:

```text
can_navigate_reader =
  can_read
  AND kind in {"epub", "web_article"}
  AND active navigation source exists
  AND sections count >= 1
```

This value is not added to `CapabilitiesOut` in this cutover. It is derived from
`GET /navigation` success and payload content. Add a capability flag only if a
future UI needs to render navigation affordances before loading the navigation
payload.

## 8. Key decisions

### D1. Active content index is the web outline source of truth

The reader navigation API reads web article headings from the active
`content_blocks` run. It does not read directly from `fragments.html_sanitized`.
This keeps navigation, search, citations, source versions, and quote contexts on
one source model.

### D2. No new heading table in v1

`content_blocks` already stores block kind, source offsets, locator, selector,
metadata, heading path, source snapshot, and active run. A dedicated heading
table would duplicate those fields before a query pattern proves it is needed.

### D3. Generated anchors only

Web source ids are not trusted. The system creates generated anchors after
sanitization and before persistence. These anchors are scoped to the active
source version.

### D4. `?loc` generalizes

`?loc` means reader navigation location, not EPUB chapter forever. This matches
the current EPUB behavior and avoids creating `?heading=`, `?toc=`, or
`?section=` variants.

### D5. Search/evidence gets heading paths

This work is not only a visual TOC. The same extracted heading structure
improves retrieval labels and context assembly because it flows through
`content_blocks.heading_path`.

### D6. No inferred outline

AI summaries or inferred section titles can be a separate generated artifact
later. They do not belong in source-backed navigation unless explicitly labeled
and versioned as generated.

## 9. File plan

### Backend

| File | Change |
|---|---|
| `python/nexus/services/web_article_structure.py` | New owned sanitizer/canonicalizer/heading/block preparation service. |
| `python/nexus/services/canonicalize.py` | Refactor internal DOM walk so canonical text generation and structure extraction share one implementation. |
| `python/nexus/services/fragment_blocks.py` | Extend `FragmentBlockSpec` to carry `block_type`; insert existing `fragment_blocks.block_type`. |
| `python/nexus/tasks/ingest_web_article.py` | Use the preparation service; remove inline sanitize/canonicalize/block sequencing. |
| `python/nexus/services/media.py` | Use the preparation service for browser capture and X/web article fragment creation; remove duplicate preparation code. |
| `python/nexus/services/content_indexing.py` | Accept structured web article blocks; populate heading blocks, heading paths, locators, selectors, source version, extractor version. |
| `python/nexus/services/reader_navigation.py` | New service for media navigation dispatch and active web heading projection. |
| `python/nexus/services/epub_read.py` | Keep EPUB section content loading; move/wrap navigation query under reader navigation. |
| `python/nexus/schemas/media.py` | Replace EPUB-only navigation response schemas with generic reader navigation schemas. |
| `python/nexus/api/routes/media.py` | Rename route function to generic navigation and delegate to reader navigation service. |
| `migrations/alembic/versions/*.py` | Only add a migration if required by the chosen block metadata storage; do not add speculative indexes. |

### Frontend

| File | Change |
|---|---|
| `apps/web/src/lib/media/readerNavigation.ts` | New generic reader navigation types and TOC normalization helpers. |
| `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` | Load reader navigation for EPUB and web articles; resolve `?loc`; wire contents UI; remove EPUB-only navigation state names. |
| `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx` | Shared web article and EPUB text-reader surface. |
| `apps/web/src/components/HtmlRenderer.tsx` | No navigation extraction. It may render generated heading ids already present in sanitized HTML. |
| `apps/web/src/app/(authenticated)/media/[id]/page.module.css` | Reuse existing TOC styles; add responsive reader contents styles only where needed. |
| `apps/web/src/app/api/media/[id]/navigation/route.ts` | Remains a thin proxy; no business logic. |

### Tests

| File | Change |
|---|---|
| `python/tests/test_sanitize_html.py` | Generated anchor safety and allowed id shape through the preparation path. |
| `python/tests/test_canonicalize.py` | Canonical text remains unchanged except for allowed anchor attributes. |
| `python/tests/test_ingest_web_article.py` | Web article ingest creates heading blocks and content index heading paths. |
| `python/tests/test_content_indexing.py` | Web heading blocks, source version, heading paths, active-run behavior. |
| `python/tests/test_media.py` or route-specific media tests | `/navigation` returns web article navigation and still returns EPUB navigation through generic schema. |
| `python/tests/test_search.py` | Web content search/evidence uses heading labels instead of generic source labels. |
| `python/tests/test_context_rendering.py` | Reader selection/context includes source version and heading path when present. |
| `apps/web/src/lib/media/readerNavigation.test.ts` | TOC tree normalization, skipped levels, duplicate labels, active node helpers. |
| `e2e/tests/web-articles.spec.ts` | Web article contents control, heading jump, active section, highlight regression. |
| `e2e/tests/reader-resume.spec.ts` | Heading jump composes with canonical web resume. |
| `e2e/tests/epub.spec.ts` | EPUB navigation still works through generic contract. |

## 10. Implementation order

1. Add `web_article_structure.py` with pure extraction tests.
2. Refactor canonical DOM walking so structure extraction and canonical text use
   one text/offset implementation.
3. Change web article ingest/capture/X fragment preparation to use the new
   service.
4. Populate `fragment_blocks.block_type` for web article blocks.
5. Refactor `rebuild_fragment_content_index` to consume structured web article
   blocks and write heading-aware `content_blocks`.
6. Replace web article `source_version="fragments_v1"` with
   `web_article:fragments:{sha256}`.
7. Add `reader_navigation.py` and move/wrap EPUB navigation behind it.
8. Replace EPUB-only Pydantic navigation schemas with generic reader navigation
   schemas.
9. Update `GET /media/{id}/navigation` to call reader navigation service.
10. Replace frontend EPUB navigation types with generic reader navigation types.
11. Update `MediaPaneBody` to load navigation for web articles and resolve
    `?loc` generically.
12. Extract/reuse generic contents UI from the EPUB TOC surface.
13. Add web article E2E coverage and run EPUB navigation regressions.
14. Delete obsolete EPUB-only names, stale tests, and any old `fragments_v1`
    expectations for web articles.

Each step may be developed incrementally, but the merged PR is a hard cutover:
no feature flag, no dual API, no fallback client parser, no old schema names
left behind.

## 11. Acceptance criteria

### Backend

- [ ] A web article with `h1`, `h2`, and duplicate `h2` labels produces
  deterministic unique `section_id` and `anchor_id` values.
- [ ] Empty headings and first-heading title duplicates are excluded from
  visible navigation.
- [ ] Generated anchor ids are present in persisted `html_sanitized`.
- [ ] `generate_canonical_text(html_sanitized)` returns the same canonical text
  before and after generated anchor insertion.
- [ ] Web article `content_blocks` include `block_kind="heading"` rows for
  headings.
- [ ] Paragraph blocks under headings carry the expected `heading_path`.
- [ ] Web article `source_version` is content-derived and not `fragments_v1`.
- [ ] `GET /media/{id}/navigation` returns `kind="web_article"` with sections
  and `toc_nodes` for a headed article.
- [ ] `GET /media/{id}/navigation` returns `kind="epub"` for EPUB through the
  generic schema.
- [ ] Unsupported kinds still return `E_INVALID_KIND`.
- [ ] Not-ready media returns `E_MEDIA_NOT_READY`.
- [ ] The route handler contains no content extraction or SQL business logic.

### Frontend

- [ ] Web article reader loads navigation from `/api/media/{id}/navigation`.
- [ ] No frontend code derives canonical navigation with heading DOM queries.
- [ ] Web article contents control is hidden when fewer than two navigable
  headings exist.
- [ ] Selecting a heading pushes `?loc={section_id}` and scrolls to that
  heading.
- [ ] Cross-fragment heading jumps switch fragments and then scroll.
- [ ] Invalid `?loc` is cleared with one user-visible warning and no fuzzy
  repair.
- [ ] Active section is marked visually and with `aria-current="location"`.
- [ ] Mobile contents opens through an explicit affordance and does not insert
  TOC text into article `contentRef`.
- [ ] Text selection, highlight creation, highlight navigation, and quote-to-chat
  still operate against canonical offsets.
- [ ] EPUB previous/next, select-section, TOC tree, and `?loc` behavior still
  work.

### Search and context

- [ ] Web article search/evidence results expose heading labels when the hit is
  under a heading.
- [ ] Reader selection contexts include the active web article source version.
- [ ] Source version mismatch rejects stale reader selections.
- [ ] Prompt context rendering includes `<heading_path>` for web article hits
  with headings.

### Codebase cleanliness

- [ ] There is one reader navigation API and one frontend navigation type
  module.
- [ ] There is one web article preparation service.
- [ ] No new article navigation table or speculative index is added.
- [ ] No legacy EPUB-only navigation schemas remain in active code.
- [ ] No `article-toc`, `headings`, or `toc` endpoint is added.
- [ ] No feature flag gates the new navigation model.

## 12. Verification commands

Targeted backend:

```bash
uv run --project python pytest \
  python/tests/test_sanitize_html.py \
  python/tests/test_canonicalize.py \
  python/tests/test_ingest_web_article.py \
  python/tests/test_content_indexing.py \
  python/tests/test_media.py \
  python/tests/test_search.py \
  python/tests/test_context_rendering.py
```

Targeted frontend:

```bash
cd apps/web
npx vitest run src/lib/media/readerNavigation.test.ts
npx tsc --noEmit --pretty false
npx eslint . --max-warnings 0
```

Targeted E2E:

```bash
npx playwright test e2e/tests/web-articles.spec.ts
npx playwright test e2e/tests/reader-resume.spec.ts
npx playwright test e2e/tests/epub.spec.ts
```

Full gate remains the repo's standard check command when available:

```bash
make check
```

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Canonical offsets drift from frontend cursor behavior. | Refactor to one canonical DOM walk; add exact offset tests for headings, lists, blockquotes, and duplicate whitespace. |
| Sanitizer trust boundary is weakened by generated ids. | Generate ids inside the trusted preparation path; allow only generated safe id attributes; keep event/style stripping unchanged. |
| Existing web source versions become stale. | Hard cutover to content-derived web article source versions; update tests and context validation in lockstep. |
| Long outlines become noisy. | Store all headings; collapse lower display depths in UI; hide control for fewer than two visible headings. |
| X thread headings are generic. | They still produce useful post-level navigation when generated by the X renderer; future label improvements belong in the X renderer, not the navigation service. |
| Querying headings from `content_blocks` is slow at scale. | Use existing `(media_id, index_run_id)` active-run access first; add an index only after measuring a high-volume pattern. |
| EPUB behavior regresses during schema rename. | Keep EPUB E2E and backend navigation contract tests in the same cutover PR. |
| UI treats contents as commands. | Use semantic navigation for contents; reserve `ActionMenu` for commands like reader settings. |

## 14. Final state summary

After the cutover, web article navigation is source-backed reader navigation:

- extracted once at backend ingress/index time
- persisted through the active content index
- versioned with source snapshots
- exposed by the same `/navigation` endpoint as EPUB
- rendered by shared reader navigation UI
- composed with search, citations, quote-to-chat, reader source activation, and
  canonical web resume

There is no client-side TOC parser, no duplicate endpoint, no legacy EPUB-only
navigation contract, and no fallback path that guesses headings after the fact.
