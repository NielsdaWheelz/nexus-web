# Reader apparatus hard cutover

> Status: implementation in progress. The persisted backend read model, API,
> web/EPUB HTML extraction, sidecar surface, and deterministic fixture corpus
> exist in the current worktree. PDF apparatus extraction currently supports
> native `cite.*` link graphs as `ready` when deterministic reference targets
> materialize, and marker-only `partial` rows when destinations are missing or
> ambiguous. PDF marker overlays and live GROBID-style scholarly extraction
> remain pending.
> Type: hard cutover.
> Scope: source-authored footnotes, endnotes, bibliography references, reference lists, and in-document citation markers in reader surfaces for web articles, EPUB, and PDF.
> Cutover rule: no legacy lanes, no route-time extraction fallbacks, no client DOM heuristics, no backward-compatible duplicate citation model.

## 1. North star

Nexus should treat a document's scholarly and editorial apparatus as a first-class reader artifact.

When a source document contains a footnote marker, endnote marker, bibliography entry, or in-document academic citation, the reader should:

1. Preserve the source-authored relationship between the marker and its target.
2. Expose the relationship through one typed backend read model and one API.
3. Render inline affordances and hover previews without losing the reader's place.
4. List the apparatus in the reader sidecar, aligned with the in-text markers when possible.
5. Reuse the existing reader-tools, locator, evidence, and hover/activation infrastructure.
6. Keep this separate from generated chat citations and conversation references.

The user-visible surface is a new reader-tools tab labelled `Citations`. The internal domain name is `reader_apparatus` because "citation" is already overloaded by generated assistant evidence, `message_retrievals`, and chat reference rendering.

## 2. SME thesis

A subject matter expert would not start by asking "can we parse superscripts?" They would ask:

1. What source evidence proves that this marker points to this target?
2. What stable locator returns the reader to the marker and target after reflow?
3. Which layer owns the extraction before source semantics are sanitized away?
4. What confidence is high enough to show inline without creating false evidence?
5. How do we keep source-authored apparatus distinct from generated citations?

The correct center of gravity is not regex. It is a source-to-reader relation pipeline:

```text
source artifact -> semantic extraction -> normalized apparatus items/edges -> strict API -> reader activation/projection -> sidecar and hover UI
```

For a one-user prototype, the lightweight version is still this pipeline. The thing to avoid is not persistence; the thing to avoid is building a full reference-manager, CSL renderer, global citation graph, or LLM-only PDF parser before the reader can faithfully expose authored links that already exist in source files.

## 3. Current codebase facts

### 3.1 Existing surfaces to reuse

- `apps/web/src/lib/panes/paneSecondaryModel.ts` already owns the `reader-tools` secondary group with `reader-highlights`, `reader-contents`, and `reader-doc-chat`.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` publishes reader secondary surfaces and owns reader activation, temporary highlights, and sidecar composition.
- `apps/web/src/components/reader/ReaderHighlightsSurface.tsx` and `apps/web/src/components/reader/useAnchoredHighlightProjection.ts` already solve visible-row alignment for anchored reader artifacts.
- `apps/web/src/components/reader/ReaderContentsNav.tsx` is the closest peer surface: a reader-owned tab, separate from chat context.
- `apps/web/src/components/ui/ReaderCitation.tsx` has useful hover/action patterns, but its domain is generated chat citations. Reuse presentation primitives, not its data model.

### 3.2 Existing locator and evidence contracts to reuse

- `apps/web/src/lib/api/sse/locators.ts` defines the existing locator union: `web_text_offsets`, `epub_fragment_offsets`, `pdf_page_geometry`, transcript, note, message, and external URL locators.
- `python/nexus/schemas/reader.py` already contains strict reader state models and text-location schemas.
- `python/nexus/services/locator_resolver.py` resolves evidence spans to reader routes and exact/prefix/suffix highlights.
- `python/nexus/services/retrieval_citation.py` is the single generated-citation writer for `message_retrievals`.

Reader apparatus must reuse the locator vocabulary. It must not write apparatus rows into `message_retrievals`, and it must not pretend that source-authored notes are generated assistant evidence.

### 3.3 Existing ingestion owners to reuse

- Web articles: `python/nexus/services/web_article_structure.py` sanitizes captured HTML, canonicalizes text, and builds fragment blocks.
- EPUB: `python/nexus/services/epub_ingest.py` parses raw XHTML, rewrites resources, sanitizes fragments, stores fragment sources, TOC, and navigation.
- PDF: `python/nexus/services/pdf_ingest.py` owns deterministic PyMuPDF extraction of page text and page spans.
- PDF geometry: `python/nexus/services/pdf_highlight_geometry.py` owns canonical PDF geometry normalization.
- Content indexing: `python/nexus/services/content_indexing.py` owns indexable blocks, evidence spans, and selector validation.
- Media cleanup: `python/nexus/services/media_deletion.py` explicitly cleans media-owned rows and storage artifacts.

Apparatus extraction belongs beside ingestion, before sanitized HTML loses semantic attributes such as `epub:type`, `role`, `id`, and `class`. It does not belong in `HtmlRenderer`, browser click handlers, or a route-time parser.

### 3.4 Current gaps

The current reader can render documents, highlights, contents, generated
citation jumps, and an in-progress source-authored apparatus surface. The
remaining risk is overclaiming coverage before each source format has strict
extraction evidence. The likely failure modes are:

- Client-side selector scraping in `HtmlRenderer`.
- Superscript regexes that confuse citations, exponents, section numbers, page numbers, and units.
- A second sidecar alignment algorithm copied from highlights.
- Chat `References` or `message_retrievals` polluted with source-authored document references.
- PDF behavior that claims precision from plain text where the PDF only provides layout.
- Source semantics lost because extraction happens after sanitization.

The cutover exists to prevent those shapes.

## 4. External standards and SOTA inputs

The implementation should be standards-shaped even when only a subset is implemented initially.

- DPUB-ARIA roles: `doc-noteref`, `doc-footnote`, `doc-endnote`, `doc-biblioref`, `doc-bibliography`, `doc-biblioentry`, `doc-backlink`.
  - https://www.w3.org/TR/dpub-aria-1.1/
- EPUB Structural Semantics Vocabulary: `noteref`, `footnote`, `endnote`, `biblioref`, `bibliography`.
  - https://www.w3.org/TR/epub-ssv-11/
- JATS cross-references: `xref ref-type="fn"` and `xref ref-type="bibr"` with `rid` targets.
  - https://jats.nlm.nih.gov/archiving/tag-library/1.3/attribute/ref-type.html
- Web Annotation selectors and Readium locators: text position, quote, fragment, and publication locators.
  - https://www.w3.org/TR/annotation-model/
  - https://readium.org/architecture/models/locators/
- PDF native links and coordinates: PyMuPDF `Page.get_links()` / `page.links()` and page-space geometry.
  - https://pymupdf.readthedocs.io/en/latest/page.html
- Scholarly PDF structure extraction: GROBID TEI references, notes, and coordinates.
  - https://grobid.readthedocs.io/en/latest/Coordinates-in-PDF/

The SOTA lesson is simple: exact source semantics beat heuristics; when semantics are absent, expose confidence honestly. GROBID-class PDF extraction is a separate adapter, not a fallback path that lets the base PDF extractor hallucinate structure.

## 5. Definitions

`Reader apparatus`

Source-authored document apparatus attached to readable media: footnotes, endnotes, bibliography entries, in-document bibliography markers, reference-section links, and their marker-to-target relationships.

`Apparatus item`

A normalized object with a stable key, kind, label, optional body text or sanitized body HTML, one locator for its own position when known, confidence, extraction method, and source provenance.

`Apparatus edge`

A source-authored relationship between two apparatus items, such as an in-text note marker pointing to a footnote body, or an in-text bibliography marker pointing to a bibliography entry.

`Marker`

The in-document symbol or text that the reader sees inline: `1`, `[12]`, `Smith 2020`, `(Doe and Roe, 2021)`, or a similar citation callout.

`Target`

The footnote, endnote, bibliography entry, or reference section entry that the marker points to.

`Confidence`

The extraction confidence attached to an item or edge:

- `exact`: source semantics explicitly encode the relation, for example EPUB `noteref -> footnote`, DPUB-ARIA roles, JATS `xref @rid`, or PDF internal link geometry.
- `strong`: a deterministic source link and target context prove the relation, but no formal semantic vocabulary is present, for example `sup > a[href="#fn1"]` pointing into a footnotes section.
- `probable`: a deterministic parser identifies likely references or citation markers without a direct source-authored link. These are listed only when useful and never rendered as exact inline targets.

`Source ref`

The structural provenance used to audit why an item exists. Examples: EPUB package href and element id, web source artifact id and DOM path, JATS element id, PDF page number and link rectangle, GROBID TEI element id.

## 6. Goals

1. Add one canonical reader apparatus domain model for web articles, EPUB, and PDF.
2. Extract authored marker-to-target relations at ingest or explicit repair time, before semantic data is stripped.
3. Persist a compact derived read model so the reader can load apparatus without reparsing source artifacts.
4. Add one strict API and one Next BFF route for reader apparatus.
5. Add one reader-tools sidecar tab that lists apparatus and aligns visible markers with sidecar rows.
6. Add inline hover/click affordances for exact and strong markers where locators are available.
7. Reuse existing locator types, reader activation routes, highlight projection mechanics, and media visibility checks.
8. Keep generated assistant citations, conversation references, and source-authored apparatus as separate domains.
9. Bias toward false negatives over false positives.
10. Build a fixture corpus that proves positive and negative cases across web article, EPUB, and PDF.

## 7. Non-goals

1. No full reference-manager product.
2. No CSL formatting engine in this cutover.
3. No library-wide citation graph in this cutover.
4. No cross-document citation deduplication in this cutover.
5. No automatic creation of chat `message_retrievals`.
6. No LLM/VLM-only extraction as source of truth.
7. No OCR or scanned-PDF citation extraction in this cutover.
8. No route-time reparsing of media source artifacts.
9. No client-side DOM scraping in `HtmlRenderer`.
10. No backward-compatible duplicate APIs or legacy apparatus shapes.
11. No claim that plain PDF text alone proves a marker-to-reference relation.
12. No global "References" surface shared with conversation context.

## 8. Capability contract

Every readable media item has exactly one apparatus state row after ingest or backfill.

State values:

- `ready`: extraction completed and at least one item exists.
- `empty`: extraction completed and no apparatus exists.
- `partial`: extraction completed, but one or more declared extractors could not produce complete coverage. Returned items remain valid and confidence-scoped.
- `unsupported`: this media kind or source artifact cannot support apparatus extraction.
- `failed`: extraction attempted and failed. No stale ready items may remain for the current source fingerprint.

Hard-cutover invariant:

- Missing apparatus state for readable media is a server bug, not a fallback trigger.
- The route must not repair or extract on demand.
- Reingest replaces apparatus atomically for the current source fingerprint.
- Failed or unsupported extraction is explicit in the state, not hidden by returning old rows.

The UI renders states as:

- `ready`: show the `Citations` tab with items.
- `empty`: omit the tab unless a developer/debug surface asks for state.
- `partial`: show valid items and a small non-blocking state affordance in the tab header.
- `unsupported`: omit the tab.
- `failed`: omit the tab in normal reader mode and emit diagnosable telemetry/logging.

## 9. Data model

This should be persisted because source semantics are ephemeral in the current pipeline:

- EPUB and web sanitizers strip many semantic attributes.
- PDF links and geometry are expensive to re-extract and must be normalized once.
- The reader needs stable item ids for hover, sidecar rows, projection, and activation.

This is not a user-authored citation database. It is a derived media artifact, analogous to `content_blocks`, `evidence_spans`, `epub_toc_nodes`, `epub_nav_locations`, and `pdf_page_text_spans`.

### 9.1 `reader_apparatus_states`

One row per media item.

Required columns:

- `id uuid primary key`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- `media_id uuid not null`
- `media_kind text not null`
- `source_fingerprint text not null`
- `extractor_version text not null`
- `status text not null`
- `item_count integer not null`
- `edge_count integer not null`
- `diagnostics jsonb not null default '{}'::jsonb`

Constraints:

- `UNIQUE (media_id)`
- `status` check over `ready`, `empty`, `partial`, `unsupported`, `failed`
- No `ON DELETE CASCADE`; cleanup is explicit in `media_deletion.py`.
- `diagnostics` is code-shaped, not exception-shaped. It may contain `missing_targets`, `unsupported_pdf_structure`, `grobid_unavailable`, or similar stable codes.

### 9.2 `reader_apparatus_items`

One row per normalized marker or target.

Required columns:

- `id uuid primary key`
- `created_at timestamptz not null`
- `media_id uuid not null`
- `state_id uuid not null`
- `stable_key text not null`
- `kind text not null`
- `label text null`
- `body_text text null`
- `body_html_sanitized text null`
- `locator jsonb null`
- `locator_status text not null`
- `confidence text not null`
- `extraction_method text not null`
- `source_ref jsonb not null`
- `sort_key text not null`

Kinds:

- `footnote_ref`
- `endnote_ref`
- `bibliography_ref`
- `sidenote_ref`
- `margin_note_ref`
- `footnote`
- `endnote`
- `bibliography_entry`
- `sidenote`
- `margin_note`
- `reference_section`

Locator status:

- `exact`: locator can activate a precise marker or target.
- `container`: locator can activate the containing section or page but not exact text.
- `missing`: source relation exists, but no reader locator can be formed.

Confidence values:

- `exact`
- `strong`
- `probable`

Constraints:

- `UNIQUE (media_id, stable_key)`
- `body_html_sanitized` is allowed only for target kinds.
- `locator` must validate against the shared retrieval/reader locator vocabulary. Do not create a parallel locator grammar unless the existing grammar is formally extended in both Python and TypeScript.

### 9.3 `reader_apparatus_edges`

One row per source-authored relation.

Required columns:

- `id uuid primary key`
- `created_at timestamptz not null`
- `media_id uuid not null`
- `state_id uuid not null`
- `stable_key text not null`
- `from_item_id uuid not null`
- `to_item_id uuid not null`
- `relation text not null`
- `confidence text not null`
- `extraction_method text not null`
- `source_ref jsonb not null`
- `sort_key text not null`

Relations:

- `points_to_note`
- `points_to_endnote`
- `points_to_sidenote`
- `points_to_margin_note`
- `cites_bibliography_entry`
- `backlink_to_marker`
- `contains_reference`

Constraints:

- `UNIQUE (media_id, stable_key)`
- `from_item_id != to_item_id`
- No cascade; explicit cleanup.

### 9.4 Source fingerprint

`source_fingerprint` must change when the source semantics can change.

Examples:

- EPUB: media file checksum plus package spine hrefs plus extractor version.
- Web article: captured source artifact checksum plus canonical URL plus extractor version.
- PDF: media file checksum plus PDF extraction version plus optional GROBID adapter version.

The fingerprint prevents stale apparatus from surviving reingest. It is not a historical versioning system.

## 10. API design

### 10.1 FastAPI route

Add a reader route:

```text
GET /media/{media_id}/apparatus
```

Route rules:

- Authenticate the viewer.
- Reuse the existing media visibility and kind/readiness guard style from reader routes.
- Do not perform extraction.
- Return the current apparatus state and rows.
- Treat missing state as `E_READER_APPARATUS_STATE_MISSING`.
- Route code is transport only; service code owns loading and validation.

### 10.2 Next BFF route

Add:

```text
GET /api/media/[id]/apparatus
```

The browser continues to call `/api/*`. Direct FastAPI browser calls remain prohibited except existing SSE exceptions.

### 10.3 Response schema

Python owner:

```text
python/nexus/schemas/reader_apparatus.py
```

TypeScript owner:

```text
apps/web/src/lib/reader/apparatus.ts
```

Response shape:

```json
{
  "media_id": "uuid",
  "media_kind": "epub",
  "status": "ready",
  "extractor_version": "reader_apparatus_v1",
  "source_fingerprint": "sha256:...",
  "capabilities": {
    "has_inline_markers": true,
    "has_sidecar_items": true,
    "supports_hover_preview": true,
    "supports_jump_to_marker": true,
    "supports_jump_to_target": true,
    "has_probable_items": false
  },
  "items": [
    {
      "stable_key": "epub:chapter-1.xhtml:noteref:fn-1",
      "kind": "footnote_ref",
      "label": "1",
      "body_text": null,
      "body_html_sanitized": null,
      "locator": {
        "type": "epub_fragment_offsets",
        "fragment_index": 0,
        "start_offset": 412,
        "end_offset": 413,
        "exact": "1",
        "prefix": "the claim",
        "suffix": "continues"
      },
      "locator_status": "exact",
      "confidence": "exact",
      "extraction_method": "epub_noteref",
      "source_ref": {
        "format": "epub",
        "package_href": "chapter-1.xhtml",
        "element_id": "noteref-fn-1",
        "href": "#fn-1"
      },
      "sort_key": "000001.000010"
    }
  ],
  "edges": [
    {
      "stable_key": "epub:chapter-1.xhtml:noteref:fn-1->footnote:fn-1",
      "from_stable_key": "epub:chapter-1.xhtml:noteref:fn-1",
      "to_stable_key": "epub:chapter-1.xhtml:footnote:fn-1",
      "relation": "points_to_note",
      "confidence": "exact",
      "extraction_method": "epub_noteref",
      "source_ref": {
        "format": "epub",
        "href": "#fn-1"
      },
      "sort_key": "000001.000010"
    }
  ],
  "diagnostics": {}
}
```

All schemas reject unknown fields.

## 11. Extraction architecture

### 11.1 New service owner

Create one backend owner:

```text
python/nexus/services/reader_apparatus.py
```

The file owns the compact read model operations:

- DOM/JATS/DPUB/EPUB-like source HTML extraction.
- Source fingerprinting.
- Fragment locator attachment.
- Atomic replacement, read queries, and explicit cleanup.

Do not split this into a package until there is real complexity to pay for the indirection.

No extraction logic belongs in routes or React components.

### 11.2 Extraction pipeline

Each adapter follows the same pipeline:

1. Parse source into an adapter-specific source tree.
2. Build an id/name/link target index before sanitization.
3. Build source-to-canonical-text offset maps where the reader needs text locators.
4. Extract candidate markers and targets with source evidence.
5. Classify candidates into exact, strong, probable, or reject.
6. Normalize candidates into `ReaderApparatusItemDraft` and `ReaderApparatusEdgeDraft`.
7. Validate locator shapes and item/edge invariants.
8. Atomically replace database rows for the media source fingerprint.

Reject is a first-class outcome. Do not keep uncertain data just because the UI could hide it later.

### 11.3 HTML and web article extraction

HTML extraction must run before `web_article_structure.prepare_web_article_fragment` loses semantic attributes.

Exact inputs:

- `role="doc-noteref"` links to `role="doc-footnote"`.
- `role="doc-biblioref"` links to `role="doc-biblioentry"` or a target inside `role="doc-bibliography"`.
- JATS-style HTML/XML: `xref ref-type="fn"` and `xref ref-type="bibr"` with `rid`.
- Explicit source links from marker to target where the target has footnote, endnote, reference, or bibliography semantics.

Strong inputs:

- `sup > a[href^="#"]` where the target id is inside a footnote/endnote/reference section.
- Bidirectional note links where target contains a backlink to the marker.
- Common generated footnote structures from Markdown processors, if the id/href graph is deterministic.

Probable inputs:

- Reference-section entries with DOI/URL/arXiv/ISBN-heavy text.
- Author-year or numeric marker patterns only when matched against a detected bibliography entry set.

Rejection rules:

- Bare superscript numbers with no link are not enough.
- Numeric bracket text like `[1]` is not enough unless it links to a reference target or matches a bibliography section with unambiguous numbering.
- Math exponents, units, issue numbers, section numbers, table markers, and page numbers must not be emitted.

### 11.4 EPUB extraction

EPUB extraction runs inside `epub_ingest.py` after resource href rewriting has enough context and before `_epub_sanitize`.

Exact inputs:

- `epub:type~="noteref"` to `epub:type~="footnote"` or `epub:type~="endnote"`.
- `epub:type~="biblioref"` to `epub:type~="biblioentry"` or target inside `epub:type~="bibliography"`.
- DPUB-ARIA roles in XHTML.
- NCX/nav references that identify notes or bibliography sections.

Mapping requirements:

- Source refs include `package_href`, `manifest_id`, `spine_index`, and source element id when available.
- Locators are built as `epub_fragment_offsets` against the sanitized fragment canonical text.
- If the source relation spans fragments, the edge remains valid and each item has its own fragment locator.
- The sanitized reader HTML receives safe `data-reader-apparatus-item-id` attributes for exact marker and target nodes when source-to-sanitized mapping is available.

### 11.5 PDF extraction

PDF is not HTML. Treat it as a separate adapter.

Baseline exact/strong extraction:

- Use PyMuPDF page links (`Page.get_links()` or `page.links()`) to extract internal links from visible rectangles.
- Normalize link rectangles through `pdf_highlight_geometry.py` conventions.
- Build marker items at the source link rectangle.
- Build target items at the destination page/point only when the destination
  resolves to an unambiguous structured target, such as a bracketed reference
  block under a References heading for native `cite.*` links.
- Classify footnote/reference targets only when page text, destination context,
  and geometry support the target type.

GROBID adapter:

- A GROBID adapter may read TEI references, notes, bibliography entries, and coordinates.
- It is an explicit extractor with its own version and diagnostics.
- If GROBID is unavailable, the PDF state can be `partial`; the native-link items remain valid.
- The base PDF extractor must not silently substitute regex citation extraction for missing GROBID structure.

Rejection rules:

- Plain text bibliography segmentation alone does not create marker-to-entry edges.
- Superscript-like glyphs in extracted text are not enough.
- Reference-section entries without in-text marker links may be emitted as probable bibliography entries only if they pass deterministic section and entry parsing.
- Native-link extraction is `ready` only when destinations resolve to typed
  target blocks and exact marker-to-target edges; marker-only extraction remains
  `partial` when destinations are missing, ambiguous, or do not resolve to a
  typed target block.
- An unsupported-adapter fixture is a manifest/support-level contract: it proves
  the current PDF adapters do not invent apparatus for a source with no
  supported signals. API `unsupported` remains reserved for media/source kinds
  that cannot run apparatus extraction at all; unsupported-adapter PDFs may
  legitimately return `empty` with explicit diagnostics.

### 11.6 Sanitized HTML annotation

The reader may render inline affordances only from server-authored annotations:

- `data-reader-apparatus-item-id`
- `data-reader-apparatus-kind`
- `data-reader-apparatus-confidence`

The sanitizer must allow only these safe `data-reader-*` attributes after apparatus extraction has created them. Generic semantic attributes such as `role`, `epub:type`, `class`, or arbitrary `data-*` are not reintroduced into the reader.

`HtmlRenderer` remains a rendering component. It must not detect footnotes, parse superscripts, infer citations, or fetch apparatus.

## 12. Frontend architecture

### 12.1 Reader secondary surface

Add one `reader-tools` surface:

```text
id: "reader-apparatus"
label: "Citations"
```

Files:

- `apps/web/src/lib/panes/paneSecondaryModel.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/components/reader/ReaderApparatusSurface.tsx`
- `apps/web/src/lib/reader/apparatus.ts`
- `apps/web/src/lib/reader/apparatus.css`

Desktop behavior:

- `Citations` appears as a reader-tools tab when apparatus state is `ready` or `partial`.
- Rows are sorted by document order.
- Visible marker rows align vertically with the reader viewport using the shared projection hook.
- Rows whose marker is outside the viewport remain in document order but are not pinned to a visible y-coordinate.
- Hovering a row highlights the inline marker and target when locators exist.
- Activating a row jumps to the marker by default; a secondary action jumps to the target when the target locator exists.

Mobile behavior:

- `Citations` appears in the existing reader-tools sheet.
- Rows use document order and section grouping, not viewport-aligned sidecar geometry.
- Activation uses the same reader target path as desktop.

### 12.2 Projection reuse

Do not create a parallel geometry system.

Reuse the existing projection hook:

```text
useAnchoredHighlightProjection(...)
```

The hook accepts an explicit target selector so highlights continue to measure
`data-active-highlight-ids`, while apparatus rows measure
`data-reader-apparatus-item-id`.

Do not migrate highlights to a generic abstraction unless the duplicated code becomes
larger than the abstraction cost.

Highlight-specific color, quote text, and actions stay in highlight code. Apparatus-specific label, body preview, relation, and confidence stay in apparatus code.

### 12.3 Reader activation target

Keep apparatus activation separate from message retrievals.

Rules:

- `readerTargetFromRetrieval` remains retrieval-specific.
- Apparatus row activation reuses the media reader's existing fragment/section navigation helpers.
- Apparatus activation may pulse a temporary range, but it must not create a highlight unless the user explicitly highlights it.

### 12.4 Inline interactions

For text-based readers:

- Exact/strong marker nodes get focusable affordances through server-authored `data-reader-apparatus-*` attributes.
- Hover opens a compact preview using the target item's `body_text` or sanitized body HTML.
- Click activates the apparatus row and optionally opens the `Citations` sidecar.
- Keyboard focus follows the same behavior as hover.

For PDF:

- Base PDF ingest may emit exact `bibliography_ref` rows from native internal
  `cite.*` links and page geometry.
- When a native `cite.*` destination resolves to an unambiguous bracketed
  reference block, PDF ingest emits exact bibliography targets and
  marker-to-target edges with `ready` status.
- Marker-only native-link rows remain `partial` when target materialization is
  missing or ambiguous.
- No PDF text or superscript regex creates apparatus rows.
- No invisible regex marker overlays are created from plain text.

## 13. Backend composition

### 13.1 Reader routes

`python/nexus/api/routes/reader.py` may include the apparatus route, or a sibling `reader_apparatus.py` router may be added under the same reader API namespace. Either way:

- Routes validate path/session inputs.
- Routes call services.
- Routes do not parse source artifacts or inspect HTML.

### 13.2 Media ingest

Each ingest path invokes apparatus extraction only after source acceptance and before marking reader artifacts complete.

Web:

```text
raw source HTML -> apparatus extraction -> sanitized fragment -> content index
```

EPUB:

```text
raw XHTML chapter -> resource rewrite context -> apparatus extraction -> sanitized fragment -> fragment source/nav/content index
```

PDF:

```text
PDF file -> page text/spans/links/geometry -> apparatus extraction -> content index
```

Extraction is deterministic and non-LLM in the base cutover.

### 13.3 Content index and evidence

Reader apparatus is not stored in `content_chunks` or `evidence_spans` as its primary model.

Allowed composition:

- Apparatus item locators may use the same locator shapes as evidence spans.
- A future "cite this note/reference in chat" action may resolve the item locator to an evidence span or create a normal user quote/highlight, then flow through `retrieval_citation.insert_retrieval_row`.
- Search may later index bibliography entries as content if there is a product need, but that is a separate indexing decision.

Forbidden composition:

- Writing source-authored footnotes directly to `message_retrievals`.
- Treating apparatus edges as assistant claims or chat references.
- Using chat citation ordinals for source-authored citation markers.

### 13.4 Resource provenance graph

The apparatus edge model is intentionally graph-shaped. It can later feed a resource provenance graph as document-internal edges:

```text
media -> apparatus_item -> apparatus_item
```

This cutover does not implement the graph export. It only keeps the source refs and stable keys needed to do that later without reparsing documents.

## 14. UI behavior

### 14.1 Sidecar list

Rows show:

- Marker label.
- Target type: footnote, endnote, reference, bibliography entry.
- Target excerpt or body preview.
- Confidence affordance only when not exact.
- Section/page context when available.

Rows group by document order first, kind second. A citation marker that targets a bibliography entry appears at the marker's document position. The bibliography entry itself appears in the reference-section position and is cross-linked from its markers.

### 14.2 Hover preview

Hover/focus on inline marker:

- Shows footnote/endnote body for note markers.
- Shows bibliography entry excerpt for bibliography markers.
- Shows "target unavailable" only when the source relation exists but the target locator is missing.
- Never invokes an LLM or route-time parser.

### 14.3 Jump behavior

Default activation:

1. If the row represents a marker, jump to marker.
2. If the row represents a target only, jump to target.
3. If both marker and target exist, expose a secondary target action.

After jump:

- Pulse marker/target using the existing temporary-reader-highlight style.
- Do not persist a user highlight.
- Preserve reader state and scroll behavior.

### 14.4 Empty and failure states

Normal reader mode should not display an empty `Citations` tab for media with no apparatus. Failure should be observable in logs/telemetry and tests, not as noisy in-reader UI.

For development/debugging, state diagnostics may be exposed in a debug-only inspector.

## 15. Files and ownership

### 15.1 New files

Backend:

- `python/nexus/schemas/reader_apparatus.py`
- `python/nexus/services/reader_apparatus.py`
- `python/tests/test_reader_apparatus_html.py`
- `python/tests/test_reader_apparatus_api.py`

Frontend:

- `apps/web/src/lib/reader/apparatus.ts`
- `apps/web/src/lib/reader/apparatus.css`
- `apps/web/src/app/api/media/[id]/apparatus/route.ts`
- `apps/web/src/components/reader/ReaderApparatusSurface.tsx`
- `apps/web/src/components/reader/ReaderApparatusSurface.module.css`
- `apps/web/src/components/reader/ReaderApparatusSurface.test.tsx`

Migration:

- `migrations/alembic/versions/0145_reader_apparatus.py`

### 15.2 Existing files to touch

Backend:

- `python/nexus/db/models.py`
- `python/nexus/services/web_article_structure.py`
- `python/nexus/services/epub_ingest.py`
- `python/nexus/services/pdf_ingest.py`
- `python/nexus/services/media_source_ingest.py`
- `python/nexus/services/media_deletion.py`
- `python/nexus/api/routes/__init__.py` or router registration owner
- `python/nexus/services/sanitize_html.py`

Frontend:

- `apps/web/src/lib/panes/paneSecondaryModel.ts`
- `apps/web/src/lib/conversations/readerTarget.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/components/HtmlRenderer.tsx`
- PDF reader component owner, if PDF overlays are implemented in the first slice.

Docs:

- `docs/modules/reader-implementation.md`
- `docs/modules/web-article.md`
- `docs/modules/epub.md`
- `docs/modules/pdf.md`
- `docs/architecture.md`

## 16. Consolidation and deduplication ledger

| Existing pattern | Reuse or consolidate | Rule |
| --- | --- | --- |
| `ReaderHighlightsSurface` sidecar alignment | Extend and reuse `useAnchoredHighlightProjection` with a target selector | No second viewport projection implementation. |
| `RetrievalLocator` union | Reuse for apparatus item locators | No parallel locator JSON grammar. |
| `reader-tools` secondary group | Add `reader-apparatus` peer surface | Do not put source apparatus in conversation context `References`. |
| `ReaderCitation` hover styling | Reuse hover/popup primitives only | Do not reuse generated-citation data model. |
| `retrieval_citation.insert_retrieval_row` | Keep as chat citation writer | Apparatus never writes here unless user explicitly promotes it into chat evidence. |
| `sanitize_html.py` allowlist | Add narrowly scoped `data-reader-apparatus-*` attrs after extraction | Do not preserve arbitrary semantic attrs in reader HTML. |
| `pdf_highlight_geometry.py` | Reuse geometry normalization for PDF overlays | No ad hoc PDF coordinate transforms. |
| `media_deletion.py` cleanup | Add explicit apparatus cleanup | No cascade reliance. |
| `content_indexing.IndexOwner` | Reuse owner vocabulary if indexing later | Apparatus primary storage remains separate. |
| `locator_resolver.py` | Reuse route/activation ideas | Do not force apparatus through evidence spans. |

## 17. Hard cutover rules

1. `reader_apparatus` is the only backend domain for source-authored notes/references/citations.
2. Every readable media item has an apparatus state row after ingest/backfill.
3. Routes never extract or repair on demand.
4. Client components never infer apparatus from rendered HTML.
5. Bare superscript parsing is forbidden.
6. Apparatus extraction must run before source semantic attributes are stripped.
7. Exact/strong/probable confidence must be assigned before persistence.
8. Exact inline affordances require an exact or strong marker locator.
9. Stale apparatus for an old source fingerprint must not be served.
10. Reingest replaces state/items/edges atomically.
11. Generated chat citations and source-authored apparatus remain separate models.
12. Unknown API fields are rejected in backend and frontend schema validation.
13. Database cleanup is explicit.
14. The cutover deletes or rewrites any experimental apparatus code introduced during implementation. No compatibility adapters remain.

## 18. Implementation plan

### S0 - Fixtures and contracts first

Create fixture corpus before implementation:

- EPUB with `epub:type="noteref"` and `epub:type="footnote"`.
- EPUB with endnotes and bibliography references.
- HTML with DPUB-ARIA `doc-noteref` and `doc-footnote`.
- JATS-like article HTML/XML with `xref ref-type="fn"` and `xref ref-type="bibr"`.
- Markdown-generated HTML footnotes using deterministic `href="#fn-1"` / backlink structure.
- Negative HTML with math exponents, issue numbers, and bare superscripts.
- PDF with native internal links from markers to footnotes/references.
- PDF with noisy superscripts and no internal links.
- Optional GROBID TEI fixture with bibliography entries and coordinates.

Add schema tests that fail until strict Pydantic and TypeScript validators exist.

### S1 - Storage and service owner

- Add migration for state/item/edge tables.
- Add SQLAlchemy models.
- Add store functions:
  - `replace_media_apparatus(...)`
  - `get_media_apparatus(...)`
  - `delete_media_apparatus(...)`
- Add explicit media deletion cleanup.
- Add source fingerprint helper.
- Add state invariant tests.

Gate:

- Migration up/down policy matches repo convention.
- Replacement is atomic.
- Reingest cannot leave stale ready rows.

### S2 - HTML/EPUB exact extraction

- Implement DOM extractor for DPUB-ARIA, EPUB semantics, and JATS xrefs.
- Integrate web extraction before `prepare_web_article_fragment` sanitization.
- Integrate EPUB extraction before `_epub_sanitize`.
- Build locator mapping to sanitized canonical text.
- Add safe `data-reader-apparatus-*` annotation after extraction.

Gate:

- Positive fixtures return exact items/edges.
- Negative bare-superscript fixtures return `empty`.
- Sanitized HTML contains only safe apparatus attributes.

### S3 - Strong HTML link graph extraction

- Add deterministic `sup > a[href]` and backlink patterns.
- Add footnote/endnote/reference-section detection.
- Add rejection cases for ambiguous numeric markers.

Gate:

- Markdown-style footnotes work.
- Exponents and section numbers do not emit apparatus.

### S4 - API and frontend read model

- Add FastAPI route.
- Add Next BFF route.
- Add frontend schema and fetch hook.
- Add apparatus-specific activation helpers without overloading retrieval targets.

Gate:

- Unauthorized users cannot read apparatus.
- Browser never calls FastAPI directly.
- Unknown API fields fail validation.

### S5 - Sidecar and inline UI

- Extend the existing anchored projection hook with an explicit target selector.
- Add `ReaderApparatusSurface`.
- Add `reader-apparatus` secondary surface.
- Add inline hover/focus/click marker behavior.
- Add mobile sheet behavior.

Gate:

- Highlights still align exactly as before.
- Apparatus rows align with visible markers.
- Hover previews do not shift layout.
- Mobile shows the same apparatus data in reader-tools sheet.

### S6 - PDF native links

- Extend PDF extraction to collect internal links and rectangles.
- Normalize geometry through `pdf_highlight_geometry.py`.
- Build PDF marker/target locators.
- Add PDF overlay hit targets where exact geometry exists.

Gate:

- Native-link PDF fixture supports exact sidecar rows with exact
  `pdf_page_geometry` marker and target locators and materialized
  `cites_bibliography_entry` edges when reference targets resolve.
- Native-link fixtures with missing or ambiguous destinations stay `partial`
  without invented target edges.
- Noisy PDF fixture does not emit false marker edges.

### S7 - Optional scholarly PDF adapter

Implement only if needed after native links:

- Add explicit GROBID adapter.
- Store adapter version in extractor version or diagnostics.
- Normalize TEI refs/notes/bibliography into the same item/edge model.
- Map coordinates to `pdf_page_geometry`.

Gate:

- GROBID unavailable produces `partial` or `unsupported` diagnostics, never silent regex fallback.
- GROBID fixtures produce source-ref-auditable items and edges.

### S8 - Docs and cleanup

- Update module docs.
- Update architecture docs.
- Add negative static tests preventing client-side apparatus parsing in `HtmlRenderer`.
- Remove any temporary implementation shims.

## 19. Acceptance criteria

### Backend

- AC-B1: Every readable web article, EPUB, and PDF has one `reader_apparatus_states` row after ingest/backfill.
- AC-B2: `GET /media/{media_id}/apparatus` returns strict schemas for `ready`, `empty`, `partial`, `unsupported`, and `failed`.
- AC-B3: Missing state for readable media raises `E_READER_APPARATUS_STATE_MISSING`.
- AC-B4: Reingest with changed source fingerprint deletes or replaces old items/edges atomically.
- AC-B5: Media deletion removes apparatus states/items/edges explicitly.
- AC-B6: EPUB `noteref -> footnote` fixture returns exact marker item, exact target item, and exact edge.
- AC-B7: DPUB-ARIA fixture returns exact marker/target edges.
- AC-B8: JATS fixture returns exact `fn` and `bibr` edges.
- AC-B9: Markdown-style footnote fixture returns strong edges only when target/backlink structure exists.
- AC-B10: Bare superscript negative fixture emits no apparatus.
- AC-B11: PDF ingest emits `empty` when no supported source-authored link
  evidence exists, `ready` when native cite-link targets materialize exactly,
  and `partial` marker-only rows when native cite-link geometry exists but
  targets are missing or ambiguous.
- AC-B12: PDF noisy-superscript fixtures emit no marker-to-reference edges.
- AC-B13: Apparatus extraction never writes `message_retrievals`.
- AC-B14: Apparatus locators validate against the shared locator union.

### Frontend

- AC-F1: `reader-apparatus` appears only in the `reader-tools` secondary group.
- AC-F2: The conversation context `References` surface is unchanged.
- AC-F3: The `Citations` tab lists items in document order.
- AC-F4: Visible marker rows align with reader viewport positions on desktop.
- AC-F5: Mobile renders the same items in the reader-tools sheet.
- AC-F6: Hover/focus on exact markers shows target preview.
- AC-F7: Activating a marker or row jumps and pulses without creating a user highlight.
- AC-F8: `ReaderHighlightsSurface` behavior remains unchanged after projection-hook extension.
- AC-F9: `HtmlRenderer` contains no footnote/citation detection code.
- AC-F10: Frontend validators reject unknown apparatus API fields.

### Product

- AC-P1: A reader can inspect footnotes without losing their place.
- AC-P2: A reader can open the sidecar and see citations/notes aligned with in-text targets.
- AC-P3: A reader can distinguish exact source links from probable extracted references.
- AC-P4: A generated assistant citation and a source-authored document citation are visually and structurally distinct.
- AC-P5: There is no false confidence for PDFs that lack link/coordinate/TEI evidence.

## 20. Test plan

Backend unit tests:

- DOM extraction exact/strong/probable/reject cases.
- EPUB source-ref and fragment-offset mapping.
- JATS xref resolution.
- PDF empty-state behavior without text/superscript inference.
- GROBID TEI parsing only if S7 is implemented.
- Locator validation.
- Stable key generation.

Backend integration tests:

- Ingest creates apparatus state.
- Reingest replaces apparatus.
- Media deletion cleans apparatus.
- API auth and shape.
- Missing-state invariant.
- No `message_retrievals` writes.

Frontend unit tests:

- Apparatus API validator.
- Reader target href generation for apparatus.
- Apparatus row sorting/grouping.
- Hover preview rendering.
- Projection row conversion.

Browser component tests:

- `ReaderApparatusSurface` desktop alignment with synthetic DOM anchors.
- Mobile reader-tools sheet.
- `MediaPaneBody` secondary surface registration using the real provider stack.
- Highlight projection parity after generic hook extraction.

Static negative tests:

- No `footnote`, `endnote`, `noteref`, `biblioref`, or superscript-detection parsing in `HtmlRenderer`.
- No apparatus writes in `retrieval_citation.py`.
- No source-authored apparatus tab under `conversation-context`.

Suggested targeted commands:

```bash
cd python && NEXUS_ENV=test uv run pytest -q -m unit tests/test_reader_apparatus_html.py
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54320/nexus_test NEXUS_ENV=test uv run pytest -q -m integration tests/test_reader_apparatus_api.py
cd apps/web && bunx vitest run --project unit src/lib/reader/apparatus.test.ts src/lib/panes/paneSecondaryModel.test.ts
cd apps/web && bunx vitest run --project browser src/components/reader/ReaderApparatusSurface.test.tsx src/components/workspace/SecondarySurfaceTabs.test.tsx
```

Use the repo's actual targeted command names when implementing; the above names are the intended slices, not a contract that those files already exist.

## 21. API and schema details

### 21.1 Python enums

```python
ReaderApparatusStatus = Literal[
    "ready",
    "empty",
    "partial",
    "unsupported",
    "failed",
]

ReaderApparatusItemKind = Literal[
    "footnote_ref",
    "endnote_ref",
    "bibliography_ref",
    "sidenote_ref",
    "margin_note_ref",
    "footnote",
    "endnote",
    "bibliography_entry",
    "sidenote",
    "margin_note",
    "reference_section",
]

ReaderApparatusRelation = Literal[
    "points_to_note",
    "points_to_endnote",
    "points_to_sidenote",
    "points_to_margin_note",
    "cites_bibliography_entry",
    "backlink_to_marker",
    "contains_reference",
]

ReaderApparatusConfidence = Literal[
    "exact",
    "strong",
    "probable",
]
```

Pydantic config:

- `extra = "forbid"` or equivalent repo-standard strict config.
- UUIDs serialized as strings.
- Locator field validated by shared reader/retrieval locator schemas.

### 21.2 TypeScript runtime guards

`apps/web/src/lib/reader/apparatus.ts` should export:

- `ReaderApparatusResponse`
- `ReaderApparatusItem`
- `ReaderApparatusEdge`
- `isReaderApparatusResponse`
- `assertReaderApparatusResponse`
- `readerApparatusTargetFromItem`

Runtime guard rules:

- Use exact key sets.
- Reuse `isRetrievalLocator`.
- Reject unknown `kind`, `relation`, `status`, `confidence`, and `locator_status`.
- Do not import chat citation types except shared locator helpers.

## 22. Security and safety

HTML safety:

- `body_html_sanitized` must pass the same sanitizer discipline as reader HTML.
- Do not store raw note HTML in the response.
- Do not preserve untrusted source `data-*`, `class`, `style`, event handlers, or arbitrary ARIA.
- The only reader apparatus attributes allowed in rendered document HTML are server-created `data-reader-apparatus-*` attributes.

Authorization:

- Apparatus visibility equals media visibility.
- There is no public apparatus route.
- Apparatus rows cannot be loaded by stable key without media authorization.

Data integrity:

- Stable keys are deterministic but not authorization tokens.
- Source refs are audit data, not browser navigation URLs.
- Diagnostic payloads must not expose filesystem paths or raw parser exceptions.

## 23. Performance

Extraction is ingest-time or explicit repair-time.

Reader load:

- One API call per media reader load, cached in the same way as other reader metadata.
- Response is compact: no full bibliography graph, no raw source HTML, no duplicate target body for every marker.
- Sidecar rendering virtualizes if item count exceeds a practical threshold.

Ingest:

- DOM extraction is linear in source node count.
- PDF native links are linear in page link count plus page count.
- GROBID, if enabled, is outside the base ingest hot path unless explicitly configured.

The one-user prototype can tolerate modest extraction cost. It should not tolerate unbounded route-time parsing or UI-thread inference.

## 24. Risk register

False positives:

- Mitigation: require source links or semantic roles for exact/strong; keep probable scoped and visually distinct.

Lost source semantics:

- Mitigation: extract before sanitizer; persist normalized items/edges; annotate sanitized HTML with safe generated attributes.

Sidecar alignment drift:

- Mitigation: consolidate projection with highlights and test both consumers.

PDF ambiguity:

- Mitigation: native links and coordinates first; GROBID as explicit adapter; no regex fallback.

Domain confusion with chat citations:

- Mitigation: separate schemas, separate API, separate sidecar surface, no `message_retrievals` writes.

Overbuilding:

- Mitigation: store only media-local apparatus state/items/edges. Defer CSL, global graph, cross-document matching, OCR, and reference management.

## 25. Final state

After the cutover:

- Source-authored apparatus has one backend owner: `reader_apparatus`.
- Web, EPUB, and PDF ingest paths produce apparatus state rows deterministically;
  PDF native-link extraction is `ready` only for materialized target graphs and
  remains `partial` for marker-only native links.
- Reader API serves apparatus through one strict contract.
- The web client renders a `Citations` reader-tools tab using the same secondary-surface model as highlights and contents.
- Inline hover/click behavior is backed by server-authored item ids and shared locators.
- Highlights and apparatus share projection infrastructure without sharing domain models.
- Generated assistant citations remain generated assistant citations.
- Conversation context references remain conversation context references.
- No client-side parser, fallback route extraction, or legacy citation compatibility lane exists.
