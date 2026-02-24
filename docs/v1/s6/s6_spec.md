# Slice 6 - PDF (L2 Spec)

This slice proves PDF reading/highlighting/quote-to-chat behavior for v1.
This contract is normative for all S6 implementation PRs.

---

## 1. Goal and Scope

**Goal**: Support academic / scanned reading.

**In scope**:
- PDF ingestion using Slice 1 upload/storage foundations (`media_file`, file hash dedupe)
- PyMuPDF extraction for PDF-derived plain text (`media.plain_text`) used by quote-to-chat/search
- PDF.js rendering via authenticated file download flow (no document iframes)
- Text-layer selection capture for PDF highlight creation
- Geometry-based PDF highlights with stored `exact` text at creation time
- PDF highlights visible in the existing linked-items pane product surface (via S6 PDF integration; no parallel PDF-only pane)
- Visibility and processing-state suite compatibility for PDF

**Out of scope**:
- Perfect text-to-geometry reconciliation across all PDFs/text layers
- OCR for scanned/image-only PDFs in v1 (scanned support in S6 is visual reading unless a PDF text layer exists)
- PDF ingest-from-URL API surface in v1 (deferred to v2)
- Semantic retrieval/ranking changes (owned by later search slices)
- New sharing semantics (owned by Slice 4)
- Full cross-object linked-items pane architecture unification (documents + conversations + other objects) beyond the PDF integration needed for S6

**Scope guardrail (v1 consistency)**:
- PDF ingest-from-URL is deferred to v2 and is not a v1 requirement.
- S6 must preserve constitution-level topology/security rules: no document iframes, private storage, and BFF-mediated non-streaming API access.
- S6 must preserve existing S2/S3/S4 highlight, quote-to-chat, and visibility semantics for non-PDF media.
- S6 should extend the existing linked-items pane shell/interaction model for PDF rather than introducing a second PDF-specific pane implementation.

---

## 2. Domain Models

### 2.1 Existing Models Reused (No Semantic Changes)

#### `media` / `media_file` (subset relevant to S6)
- Reuse Slice 1 upload + file metadata model for `kind='pdf'`.
- Reuse processing lifecycle fields (`processing_status`, `failure_stage`, `last_error_code`, `processing_attempts`) and file-hash dedupe constraints.
- Reuse canonical media visibility predicate (`can_read_media`) for all PDF file/read/highlight/chat surfaces.

#### Existing offset-based `highlights` + `annotations` (html/epub/transcript only)
- S2/S4 `highlights` remain canonical for fragment-offset anchors.
- S6 MUST NOT weaken existing offset uniqueness/overlap semantics for non-PDF highlights.
- S6 quote-to-chat compatibility must continue to support existing highlight/annotation context paths unchanged.

### 2.2 S6 Model Extension: Unified Logical Highlight + Typed Anchors

S6 adopts a **unified logical `highlight` aggregate** with anchor subtypes.

Design intent:
1. Preserve one user-facing/object-facing concept for highlights and annotations across media kinds.
2. Preserve S3/S4 context target semantics (`target_type='highlight'|'annotation'`).
3. Add a PDF-specific geometry anchor model without regressing fragment-offset highlight semantics.
4. Keep visibility checks and quote rendering extensible for future anchor types.

#### `media` (S6 additions for PDF text readiness)

Add PDF text persistence to `media`:
- `plain_text: text | null`
  - persisted linearized PDF text extracted by PyMuPDF
  - used for quote-to-chat/search/chunking
  - null means "not available yet or extraction failed to produce usable text"
- `page_count: int | null`
  - extracted page count for PDF reader behavior/capability derivation and validation
  - null for non-PDF media

S6 constraints:
1. `plain_text` is only meaningful for `kind='pdf'` in S6.
2. `GET /media/{id}` capability derivation for PDF uses `has_plain_text = (plain_text is non-null and non-empty after trim)`.
3. `page_count >= 1` when present.

#### PDF `media.plain_text` Normalization Contract (S6)

`media.plain_text` and `pdf_page_text_spans` MUST be produced from the same extraction output and normalization pass.
S6 keeps the contract parser-agnostic (PyMuPDF is the expected implementation in this slice).

Normalization rules (v1):
1. Normalize line endings: `\r\n` and `\r` -> `\n`.
2. Normalize page-break/control separators used by extractors (including form-feed `\f` if present) to page separators represented as `\n\n`.
3. Normalize non-breaking spaces (`\u00A0`) to regular spaces.
4. Collapse runs of spaces/tabs within a line to a single space.
5. Collapse runs of 3+ consecutive newlines to `\n\n`.
6. Trim leading/trailing whitespace on the final `media.plain_text` string.
7. `pdf_page_text_spans.start_offset/end_offset` are defined over the **post-normalization** `media.plain_text` string in Unicode codepoint offsets.
8. Quote matching in Section `2.4` performs no additional normalization beyond these persisted strings.

Outcome requirement:
- If normalized PDF text is empty, the PDF may still be readable in S6 (visual rendering path) but `pdf_quote_text_ready(media)=false`.

#### `highlights` (refactored logical core, cross-kind)

`highlights` becomes the canonical logical highlight row shared by all anchor kinds.

Required fields (logical contract; migration shape may preserve/transform legacy columns):
- `id: uuid` (PK)
- `user_id: uuid` (author)
- `anchor_kind: text` enum (`'fragment_offsets' | 'pdf_page_geometry'`)
- `anchor_media_id: uuid` (FK `media.id`, immutable denormalized anchor media pointer)
- `color: text` (existing palette)
- `exact: text` (stored quote text; for PDF may be empty string when region text extraction fails)
- `prefix: text` (stored context/debug support; for PDF may be empty string when unavailable)
- `suffix: text` (stored context/debug support; for PDF may be empty string when unavailable)
- `created_at: timestamptz`
- `updated_at: timestamptz`

Logical constraints:
1. `anchor_kind` is immutable after create.
2. `anchor_media_id` is immutable after create and MUST equal the media resolved by the anchor subtype.
3. `annotations` remain attached to `highlights.id` regardless of `anchor_kind`.
4. S4 visibility checks use `anchor_media_id` + author/library intersection semantics.

#### `highlight_fragment_anchors` (fragment-offset subtype)

Fragment/text highlights move to an explicit subtype anchor row (or an equivalent migration shape that preserves identical semantics):
- `highlight_id: uuid` (PK/FK `highlights.id`, one-to-one)
- `fragment_id: uuid` (FK `fragments.id`)
- `start_offset: int >= 0`
- `end_offset: int > start_offset`

Semantics (unchanged from S2/S4):
1. Offsets are half-open Unicode codepoint spans over `fragment.canonical_text`.
2. Duplicate span by same user is forbidden.
3. Overlaps are allowed.

#### `highlight_pdf_anchors` (PDF geometry subtype, new)

One row per PDF highlight anchor:
- `highlight_id: uuid` (PK/FK `highlights.id`, one-to-one)
- `media_id: uuid` (FK `media.id`, must equal `highlights.anchor_media_id`)
- `page_number: int` (1-based page number, domain `1..media.page_count`)
- `geometry_version: smallint` (canonicalization version; S6 defines `1`)
- `geometry_fingerprint: text` (lowercase SHA-256 hex of canonicalized geometry serialization for `geometry_version`)
- `sort_top: numeric` (derived from first canonical quad/rect in page-space points)
- `sort_left: numeric` (derived from first canonical quad/rect in page-space points)
- `plain_text_match_version: smallint | null` (PDF quote-context match algorithm version; S6 defines `1`)
- `plain_text_match_status: text` enum (`'pending' | 'unique' | 'ambiguous' | 'no_match' | 'empty_exact'`)
- `plain_text_start_offset: int | null` (offset in `media.plain_text`, half-open start; set only when status=`unique`)
- `plain_text_end_offset: int | null` (offset in `media.plain_text`, half-open end; set only when status=`unique`)
- `rect_count: int >= 1`
- `created_at: timestamptz`

Notes:
- `highlight_pdf_anchors.media_id` duplicates `highlights.anchor_media_id` for constraint clarity and query efficiency.
- `geometry_fingerprint` supports duplicate detection; `sort_top/sort_left` support deterministic ordering.
- Quote-context match metadata is persisted on the PDF anchor so quote-to-chat is deterministic and does not rely on runtime fuzzy matching.

#### `highlight_pdf_quads` (PDF geometry segments, new)

One row per normalized quad/rect segment in a PDF highlight:
- `highlight_id: uuid` (FK `highlights.id`)
- `quad_idx: int >= 0` (canonical ordered sequence)
- `x1,y1,x2,y2,x3,y3,x4,y4: numeric` (canonical quad vertices in page-space points; precision/ordering defined below)

Semantics:
1. A PDF highlight has one or more geometry segments.
2. Segment ordering is deterministic and part of geometry canonicalization.
3. Persisted geometry is renderer-independent after normalization (frontend viewport transforms are not persisted).

#### `pdf_page_text_spans` (PDF plain-text page index, new)

One row per PDF page, mapping page numbers to spans inside `media.plain_text`:
- `media_id: uuid` (FK `media.id`)
- `page_number: int` (1-based, `1..media.page_count`)
- `start_offset: int >= 0`
- `end_offset: int >= start_offset`
- `text_extract_version: smallint` (version of page->plain_text span construction algorithm; S6 defines `1`)
- `created_at: timestamptz`

Semantics:
1. For quote-capable PDF media, there is exactly one `pdf_page_text_spans` row for each page `1..page_count`.
2. Rows are contiguous and ordered by page number (`page_n.end_offset <= page_{n+1}.start_offset` with extractor-defined delimiter policy already reflected in persisted offsets).
3. Empty-text pages are represented by zero-length spans (`start_offset == end_offset`), not by missing rows.
4. `start_offset`/`end_offset` reference the persisted `media.plain_text` string in Unicode codepoint offsets.

#### Derived API Shapes (S6)

`HighlightAnchorOut` (discriminated union):
- fragment variant:
  - `type: "fragment_offsets"`
  - `media_id: uuid`
  - `fragment_id: uuid`
  - `start_offset: int`
  - `end_offset: int`
- pdf variant:
  - `type: "pdf_page_geometry"`
  - `media_id: uuid`
  - `page_number: int`
  - `quads: PdfQuadOut[]` (canonical order, canonical page-space points)

`HighlightOut` (cross-kind, S6 additive contract):
- existing common fields preserved: `id`, `color`, `exact`, `prefix`, `suffix`, timestamps, `annotation`, `author_user_id`, `is_owner`
- new required field: `anchor: HighlightAnchorOut`

Backward-compatibility note:
- Existing fragment highlight create/list routes may continue returning legacy fragment fields during S6 implementation rollout, but the canonical S6 logical highlight contract is `anchor`-based.

### 2.3 PDF Geometry Canonicalization Contract (S6-D02 Resolved)

S6 defines `geometry_version = 1` with the following canonicalization rules.

#### Coordinate space (public API + storage)
1. `page_number` is **1-based** (`1..page_count`) in all public API requests/responses.
2. PDF highlight geometry is expressed in **canonical page-space points** (not viewport pixels).
3. Canonical page space uses:
   - origin at the **top-left** of the page `CropBox`
   - `x` increases right
   - `y` increases down
   - page rotation already removed (unrotated page frame)
4. Frontend renderer/view transforms (zoom, DPR, viewport scroll, CSS scaling, viewer rotation) are presentation-only and MUST NOT be persisted.

#### Normalization pipeline (`geometry_version = 1`)
1. Validate `page_number` is in range and `quads.length >= 1`.
2. Reject non-finite numbers (`NaN`, `±Infinity`) and degenerate quads/rects (zero or negative area after normalization).
3. **v1 simplification**: each submitted quad is canonicalized to its axis-aligned bounding rectangle in canonical page space and stored as a rectangle-quad.
4. Quantize all coordinates to fixed precision of **0.001 pt** using round-half-away-from-zero (or equivalent deterministic rounding mode; implementation must be stable and documented).
5. Canonical vertex order for stored rectangle-quads is:
   - `(x1,y1) = top-left`
   - `(x2,y2) = top-right`
   - `(x3,y3) = bottom-right`
   - `(x4,y4) = bottom-left`
6. Sort canonical quads by reading order:
   - `top ASC`
   - `left ASC`
   - `bottom ASC`
   - `right ASC`
   - original input index ASC (tie-break before quantization collisions if needed)
7. No server-side merge/coalescing of adjacent/overlapping quads in S6 v1; preserve normalized segment granularity.

#### Identity + ordering derivations
1. `geometry_fingerprint` is SHA-256 over a canonical serialization containing:
   - `geometry_version`
   - `page_number`
   - ordered canonical rectangle-quads (post-quantization)
2. Duplicate PDF-highlight identity for one user is conceptually:
   - `(user_id, media_id, page_number, geometry_version, geometry_fingerprint)`
3. `sort_top` / `sort_left` are derived from the first canonical quad after sorting and are used for deterministic list ordering.
4. Fingerprint is for identity/conflict detection, not user-facing ordering.

#### Enforcement requirement
The implementation MUST provide race-safe duplicate enforcement for the conceptual identity above (DB unique index on equivalent persisted fields and/or equivalent transactional enforcement).

### 2.4 PDF Quote Context Match Contract (S6-D05 Resolved)

S6 defines `plain_text_match_version = 1` for deriving and persisting PDF quote-context anchors in `media.plain_text`.

#### Purpose
1. Preserve `highlight.exact` as the authoritative quoted text.
2. Derive deterministic nearby context spans from `media.plain_text` when safely possible.
3. Avoid silent wrong-context attachment on repeated phrases.
4. Make match outcomes auditable and stable across requests via persisted match metadata.

#### Match lifecycle
1. PDF highlight create/update writes `highlight.exact` immediately (empty string allowed).
2. If `media.plain_text` and `pdf_page_text_spans` are available, the service computes and persists PDF quote match metadata during the same mutation transaction (or immediately after in the same request lifecycle before response commit).
3. If quote text infrastructure is not yet available (e.g., `media.plain_text` not ready), the service sets:
   - `plain_text_match_status='pending'`
   - `plain_text_match_version=NULL`
   - `plain_text_start_offset=NULL`
   - `plain_text_end_offset=NULL`
4. When quote text infrastructure becomes ready, the system MUST provide an idempotent enrichment path that computes missing/`pending` match metadata for existing PDF highlights (background job or equivalent deterministic repair path).
5. S6 does **not** require text-artifact generation/version binding fields for PDF quote matches.
6. If `media.plain_text` or `pdf_page_text_spans` is rewritten for an already-highlightable PDF media (retry/rebuild/repair path), the implementation MUST invalidate PDF quote match metadata for that `media_id` before any quote rendering can rely on stale offsets:
   - set `plain_text_match_status='pending'`
   - set `plain_text_match_version=NULL`
   - clear `plain_text_start_offset` / `plain_text_end_offset`
   - clear `highlight.prefix` / `highlight.suffix`
   - preserve highlight geometry and `highlight.exact`
7. After invalidation, the same deterministic enrichment path (step `4`) MAY recompute match metadata and PDF `prefix/suffix` asynchronously.

#### Match algorithm (`plain_text_match_version = 1`)

Input:
- `highlight.exact`
- `highlight_pdf_anchors.page_number`
- `media.plain_text`
- `pdf_page_text_spans` row for `(media_id, page_number)`

Algorithm:
1. If `highlight.exact == ""`, persist:
   - `plain_text_match_status='empty_exact'`
   - `plain_text_match_version=1`
   - null offsets
2. Otherwise perform **literal codepoint substring matching** (no fuzzy matching; no additional normalization beyond stored strings) against the page-local span `media.plain_text[start_offset:end_offset]`.
3. If exactly one page-local match is found:
   - persist `plain_text_match_status='unique'`
   - persist absolute `plain_text_start_offset`/`plain_text_end_offset` in `media.plain_text` coordinate space
   - persist `plain_text_match_version=1`
4. If multiple page-local matches are found:
   - persist `plain_text_match_status='ambiguous'`
   - null offsets
   - persist `plain_text_match_version=1`
5. If zero page-local matches are found:
   - if the page span row is missing (legacy/backfill anomaly only), a global fallback search over all `media.plain_text` is permitted:
     - one global match => `unique`
     - multiple => `ambiguous`
     - zero => `no_match`
   - otherwise persist `plain_text_match_status='no_match'` with null offsets and `plain_text_match_version=1`

#### Quote rendering use of match metadata
1. Quote-to-chat always includes stored `highlight.exact` (even when empty).
2. Nearby context from `media.plain_text` is included only when:
   - `plain_text_match_status='unique'`
   - offsets are non-null and valid
   - `media.plain_text` remains quote-capable for the media
3. If match status is `ambiguous`, `no_match`, or `empty_exact`, quote-to-chat succeeds and omits nearby text context.
4. Quote-to-chat MUST NOT use a first-match heuristic when status is ambiguous.
5. Implementations MAY opportunistically recompute stale/missing match metadata on quote request, but returned behavior must remain equivalent to the v1 rules above.

#### Stored `prefix/suffix` derivation for PDF highlights (S6)
1. `highlight.exact` remains the authoritative quote text captured at highlight create/update time (typically client text-layer extraction).
2. `highlight.prefix` and `highlight.suffix` are server-derived from `media.plain_text` only when:
   - `plain_text_match_status='unique'`, and
   - persisted match offsets are non-null and valid.
3. The v1 PDF prefix/suffix window size is **64 Unicode codepoints** on each side (same window size used for S2 fragment highlights unless globally amended).
4. If `plain_text_match_status` is `pending|ambiguous|no_match|empty_exact`, or PDF quote text infrastructure is not ready, persist `prefix=""` and `suffix=""`.
5. The enrichment path in Match lifecycle step `4` MAY backfill `prefix/suffix` when it computes a `unique` match.

#### Derived readiness terms (S6)
- `pdf_quote_text_ready(media)` is true iff:
  1. media is in a quote-capable processing state, and
  2. `media.plain_text` is present and non-empty, and
  3. `media.page_count` is present, and
  4. `pdf_page_text_spans` exists for every page `1..page_count` (contiguous coverage)

This is a **derived condition**, not a new `media.processing_status`.

---

## 3. State Machines

### 3.1 PDF Processing Lifecycle

S6 extends the existing `media.processing_status` lifecycle for `kind='pdf'`:
- `pending -> extracting -> ready_for_reading -> embedding -> ready`
- `failed` may occur from extraction/embedding stages with retry via `POST /media/{id}/retry`

Constitution constraints to preserve:
1. PDF reading may be enabled once file/page-render prerequisites exist (`ready_for_reading`), even if `media.plain_text` extraction for quote/search is incomplete or partial.
2. Quote-to-chat/search gating for PDF is separate from file readability and depends on persisted PDF text availability (`has_plain_text` capability seam already exists in code).
3. Retry must prevent mixed-generation artifacts.

S6 lifecycle clarifications:
4. `ready_for_reading` for PDF means the original file is stored and page rendering prerequisites are available (including `page_count`) so the user can read and create geometry highlights.
5. `pdf_quote_text_ready(media)` (Section `2.4`) MAY become true at or after `ready_for_reading`; quote/search capability flips only when this derived condition is satisfied.
6. PDF highlight create/update remains allowed in mutation-ready states even when `pdf_quote_text_ready(media)=false`.
7. Empty `exact` text at highlight create/update is non-fatal and does not block highlight persistence.
8. If a PDF is renderable but no usable normalized text is extracted (e.g., scanned/image-only pages or extraction restrictions), media MAY still reach `ready_for_reading` with `plain_text` absent/empty and quote/search disabled (`pdf_quote_text_ready(media)=false`).
9. If a PDF is password-protected/encrypted such that render prerequisites (including page count/opening the document) cannot be established in v1, media MUST transition to `failed` with a deterministic ingest error code (recommended: `E_PDF_PASSWORD_REQUIRED`).
10. S6 does not support password prompts or in-row credential retry for protected PDFs.
11. Embedding/search retries for PDF MUST NOT rewrite `media.plain_text` or `pdf_page_text_spans`.
12. Any retry/rebuild/repair path that rewrites PDF text artifacts (`media.plain_text` and/or `pdf_page_text_spans`) MUST invalidate existing PDF highlight quote-match metadata per Section `2.4` before exposing quote-to-chat context based on those artifacts.

### 3.2 PDF Highlight Lifecycle (Typed-anchor logical highlight)

Logical lifecycle (same across anchor kinds):
1. `create highlight` -> insert `highlights` core row + exactly one anchor subtype row (`fragment` or `pdf`) atomically
2. optional `annotation upsert` -> create/update single annotation row attached to `highlights.id`
3. `update highlight`
   - color-only update: mutate `highlights.color`
   - bounds update:
     - fragment highlight: mutate fragment anchor offsets + recompute `exact/prefix/suffix`
     - PDF highlight: replace PDF geometry rows + update `geometry_fingerprint` + refresh stored `exact/prefix/suffix` per S6 rules
4. `delete highlight` -> delete `highlights` core row; annotation and anchor subtype rows cascade

Guards (S4/S2 semantics preserved):
1. Create/update/annotation-upsert require media-ready mutation status (`ready_for_reading|embedding|ready`) on `anchor_media_id`.
2. Highlight point-read (`GET /highlights/{highlight_id}`) and author delete follow visibility rules and remain available even if media status later drifts (same as existing highlight behavior). Page-scoped PDF overlay/list routes may additionally require readable media.
3. Mutations are author-only; reads allow shared visibility per S4.

PDF-specific constraints:
1. PDF highlight creation is allowed even when region text extraction returns no text; stored `exact` MAY be empty.
2. Quote-to-chat/search behavior remains separately gated by `media.plain_text` readiness.

---

## 4. API Contracts

### 4.1 `GET /media/{media_id}` (S6 extension)

S6 will extend media read behavior to make PDF quote/search capability accurate:
- `capabilities.can_read` for PDF remains file-based (PDF.js rendering path)
- `capabilities.can_quote` / `capabilities.can_search` for PDF require persisted PDF plain text readiness
- `has_plain_text` TODOs in service code must be replaced with real DB-backed derivation
- `capabilities.can_highlight` is a media-level capability and does not guarantee text selection availability on every PDF page (e.g., scanned/image-only pages without a usable text layer)

### 4.2 `GET /media/{media_id}/file` (PDF.js consumer path)

S6 reuses the existing authenticated signed-download endpoint for PDF.js file fetch:
- canonical visibility masking (`404 E_MEDIA_NOT_FOUND`)
- short-lived signed URL only (no direct private storage URLs persisted in app state contracts)
- no new browser-direct fastapi bypass
- signed file responses used by PDF.js MUST support browser fetch semantics required for incremental PDF loading (`GET` + `Range` requests with `206` responses / equivalent range support and `Content-Type: application/pdf`)
- viewer sessions MUST recover from signed URL expiry by re-requesting `GET /media/{media_id}/file` and retrying the PDF.js document/page fetch path without exposing long-lived storage URLs in app contracts

### 4.3 PDF Highlight APIs (NEW create/list surfaces; generic detail routes extended)

#### 4.3.1 `POST /media/{media_id}/pdf-highlights`

Create a PDF geometry highlight anchored to one PDF page.

Valid only for `media.kind='pdf'`.
Media visibility + author mutation checks apply via canonical media predicate and ready-state guard.

**request**:
```json
{
  "page_number": 12,
  "quads": [
    {
      "x1": 10.0,
      "y1": 20.0,
      "x2": 30.0,
      "y2": 20.0,
      "x3": 30.0,
      "y3": 32.0,
      "x4": 10.0,
      "y4": 32.0
    }
  ],
  "exact": "quoted text from pdf text layer",
  "color": "yellow"
}
```

Request semantics:
1. `page_number` is 1-based and MUST satisfy `1..page_count`.
2. `quads` coordinates are in canonical page-space points (Section `2.3`), not viewport pixels.
3. `exact` is captured from the PDF text layer at create time (typically client-extracted) and stored as authoritative quote text.
4. `exact` MAY be empty when region text extraction fails.
5. `quads` must contain at least one segment.
6. Server normalizes geometry per Section `2.3`, computes `geometry_version=1`, `geometry_fingerprint`, and `sort_top/sort_left`.
7. `quads.length` MUST be `<= 512` (oversize payloads return `E_INVALID_REQUEST`).
8. Non-empty `exact` MUST be `<= 2000` Unicode codepoints (oversize payloads return `E_INVALID_REQUEST`).

**response**:
- `HighlightOut` with `anchor.type='pdf_page_geometry'`

**errors**:
- `E_MEDIA_NOT_FOUND` (404): media not visible or missing
- `E_INVALID_KIND` (400): media is not PDF
- `E_MEDIA_NOT_READY` (409): media not in mutation-ready state
- `E_INVALID_REQUEST` (400): malformed `page_number`/geometry payload
- `E_HIGHLIGHT_CONFLICT` (409): duplicate PDF highlight under canonical geometry identity (`user_id + media_id + page_number + geometry_version + geometry_fingerprint`)

#### 4.3.2 `GET /media/{media_id}/pdf-highlights`

List PDF highlights visible to the caller for a single page.
This is the canonical S6 read surface for PDF page overlay rendering and the linked-items pane for the active page.

**query**:
- `page_number: int` (required, 1-based `1..page_count`)
- `mine_only: boolean` (optional, default `true`; same semantics as S4 fragment highlight list)

S6 scope note:
- This route is intentionally page-scoped in S6.
- Media-wide PDF highlight browsing/list pagination for linked-items is deferred; S6 linked-items behavior is active-page scoped (Section `4.5`).

**response**:
```json
{
  "page_number": 12,
  "highlights": [
    {
      "id": "uuid",
      "anchor": {
        "type": "pdf_page_geometry",
        "media_id": "uuid",
        "page_number": 12,
        "quads": []
      },
      "color": "yellow",
      "exact": "quoted text",
      "prefix": "",
      "suffix": "",
      "annotation": null,
      "author_user_id": "uuid",
      "is_owner": true,
      "created_at": "timestamp",
      "updated_at": "timestamp"
    }
  ]
}
```

List ordering (deterministic):
1. by `page_number` ascending (single-page query makes this constant)
2. by `sort_top` ascending
3. by `sort_left` ascending
4. by `created_at` ascending
5. by `id` ascending

**errors**:
- `E_MEDIA_NOT_FOUND` (404): media not visible or missing
- `E_INVALID_KIND` (400): media is not PDF
- `E_MEDIA_NOT_READY` (409): media is not readable for this page-scoped viewer/list route
- `E_INVALID_REQUEST` (400): invalid `page_number` / `mine_only`

#### 4.3.3 `GET /highlights/{highlight_id}` (S6 extension)

Existing highlight detail route becomes anchor-aware:
- returns `HighlightOut` with `anchor` discriminator for both fragment and PDF highlights
- retains S4 visibility semantics and masked existence behavior

#### 4.3.4 `PATCH /highlights/{highlight_id}` (S6 extension)

Existing highlight update route extends to support PDF highlight updates:
- color-only update (all anchor kinds)
- PDF bounds update (`page_number` + `quads` + replacement `exact`)

PDF bounds-update request contract:
1. If PDF geometry is changed, request MUST include the full replacement geometry payload (`page_number`, `quads`) and replacement `exact` (empty string allowed).
2. Server replaces all prior PDF geometry segments atomically, re-runs Section `2.3` normalization, recomputes `geometry_version`, `geometry_fingerprint`, and `sort_top/sort_left`, and updates stored `exact/prefix/suffix`.
3. Partial patching of individual quad rows is out of scope for S6.
4. Create-time payload guardrails (`quads.length <= 512`, non-empty `exact <= 2000` codepoints) apply to bounds updates.

#### 4.3.5 `DELETE /highlights/{highlight_id}` and annotation routes (reused)

Existing routes are reused for all highlight anchor kinds:
- `DELETE /highlights/{highlight_id}`
- `PUT /highlights/{highlight_id}/annotation`
- `DELETE /highlights/{highlight_id}/annotation`

Behavioral requirement:
- Annotation semantics remain identical across fragment and PDF highlights because annotations attach to the logical `highlights` row.

### 4.4 Quote-to-Chat Compatibility (existing conversation routes, S6 extension)

S6 extends existing quote-to-chat behavior (no new chat route family):
- PDF highlight context items must pass masked visibility validation
- quote rendering for PDF highlights must use stored `exact` and nearby context from `media.plain_text`
- when nearby context cannot be derived, quote-to-chat degrades gracefully while preserving stored `exact` when present
- deterministic match/disambiguation semantics are defined by Section `2.4` (`plain_text_match_version=1`)

PDF quote rendering requirements:
1. If `pdf_quote_text_ready(media)=false`, quote-to-chat returns `E_MEDIA_NOT_READY` (same class as other not-ready quote paths).
2. If `pdf_quote_text_ready(media)=true` and PDF match metadata status is:
   - `unique`: include nearby context derived from persisted `plain_text_*_offset` and `media.plain_text`
   - `ambiguous|no_match|empty_exact`: include no nearby context, but still include stored `exact` and succeed
   - `pending`: implementation must attempt deterministic enrichment before rendering; if still unresolved, degrade as no-nearby-context success
3. Quote rendering MUST NOT mutate highlight geometry or `exact`; only match metadata may be repaired/backfilled.
4. If PDF text-artifact rewrite invalidation has set match metadata back to `pending`, quote-to-chat follows the same `pending` behavior above (attempt enrichment, then degrade safely if still unresolved).

### 4.5 Reader UI Contract (PDF.js + linked-items integration, informational)

S6 frontend contract must preserve:
- no document iframe embedding
- text-layer selection capture -> PDF highlight create request
- linked-items pane visibility/alignment behavior for PDF highlights
- in S6, the PDF linked-items pane is **active-page scoped** (one page at a time) and may refetch/reconcile when the active page changes; media-wide PDF highlight browsing is out of scope
- S6 reuses the existing linked-items pane shell and row interaction model (focus/selection/annotation/quote actions) for PDF highlights; renderer-specific alignment/measurement is implemented via a PDF adapter path rather than a separate pane product surface
- HTML/EPUB may continue using DOM-anchor measurement (`data-highlight-anchor`-style) while S6 PDF integration may use a different anchor-position adapter (e.g., projected overlay geometry); the pane shell MUST NOT require PDF content to emulate HTML highlight span injection
- visual highlight rendering must project persisted canonical page-space geometry to current viewer/page coordinates without mutating pdf.js-owned text layer DOM
- highlight visuals must be recomputed on viewer/page transformations that change projection (including zoom/scale changes and page rotation where supported)
- lazy page rendering is allowed: highlights for unrendered pages may be absent until that page renders, but MUST appear when the page/text layer becomes available
- PDF highlight selection/capture MUST scope to pdf.js text-layer content only; non-text-layer DOM nodes are outside the PDF highlight capture domain
- when a visible page has no usable text layer (e.g., scanned/image-only page), the UI should not present a false-success highlight creation path from text selection

This section is informational at L2 and should only contract transport/domain-facing interfaces, not UI implementation details.

#### 4.5.1 Linked-items integration seam (informational implementation guidance)

S6 should treat linked-items as:
1. a **shared pane shell** (row rendering, interactions, visibility/ownership affordances), and
2. a **renderer-specific alignment adapter** that supplies anchor positions + focus/scroll hooks.

S6 expectation:
- HTML/EPUB continue using the existing fragment/DOM-anchor alignment path.
- PDF adds a renderer adapter that maps persisted PDF highlight ids (active page) to pane-alignment positions in the current viewer coordinate space.
- S6 does not require a generalized all-object adapter framework to land in one PR; extracting a minimal adapter seam sufficient for HTML/EPUB + PDF is acceptable.

---

## 5. Error Codes (S6 Additions + Uses)

S6 reuses existing highlight/media/chat error codes wherever semantics already match.
New PDF behavior should prefer existing codes over introducing PDF-only variants unless the error class is genuinely distinct.

| code | http | meaning |
|---|---:|---|
| E_MEDIA_NOT_FOUND | 404 | Media/highlight not found or not visible (masked). |
| E_MEDIA_NOT_READY | 409 | Operation requires a ready/readable or quote-capable PDF state and media has not reached it. |
| E_INVALID_KIND | 400 | Operation not valid for non-PDF media. |
| E_INVALID_REQUEST | 400 | Malformed geometry/page payload or invalid query/body shape. |
| E_HIGHLIGHT_CONFLICT | 409 | Duplicate highlight under anchor-specific identity rules (fragment offsets or canonicalized PDF geometry). |
| E_HIGHLIGHT_INVALID_RANGE | 400/409 (existing use) | Fragment-offset range invalid (unchanged for non-PDF highlights). |
| E_PDF_PASSWORD_REQUIRED | 422 | PDF is password-protected/encrypted and v1 cannot establish render prerequisites without a password flow. |
| E_NOT_FOUND | 404 | Quote-to-chat context target not found or not visible (masked). |

Notes:
- `E_PDF_TEXT_UNAVAILABLE` is a recommended `media.last_error_code` diagnostic for renderable PDFs with no usable extracted text (e.g., scanned/image-only); S6 does not require this to be returned as an API error because ingestion may still complete to `ready_for_reading`.
- Oversize PDF highlight create/update payloads (e.g., too many `quads` or non-empty `exact` beyond S6 limits) are `E_INVALID_REQUEST`.

---

## 6. Invariants

S6 invariants (D01/D02/D05 resolved):

1. PDF documents render without iframes; viewer rendering uses PDF.js (or equivalent JS renderer) under the existing CSP/topology rules.
2. PDF file access for reading uses canonical media visibility and masked existence semantics.
3. Every highlight is represented by exactly one logical `highlights` row and exactly one anchor subtype (`fragment` or `pdf`), never both.
4. `highlights.anchor_kind` and `highlights.anchor_media_id` are immutable after create.
5. `annotations` attach to `highlights.id` only and preserve 0..1-per-highlight semantics across all anchor kinds.
6. PDF highlight anchors are geometry-based (not fragment-offset based); S2 offset invariants remain unchanged for html/epub/transcript highlights.
7. PDF API `page_number` is 1-based in all public requests/responses and MUST be within `1..media.page_count`.
8. Persisted PDF highlight geometry is stored in canonical page-space points (unrotated `CropBox` top-left origin, x-right/y-down) and never in viewport pixel coordinates.
9. PDF geometry normalization uses `geometry_version=1`, axis-aligned rectangle-quad canonicalization, and 0.001-pt quantization before persistence/fingerprinting.
10. PDF duplicate identity is determined by canonical geometry fingerprinting over normalized page geometry plus `user_id`/`media_id`/`page_number` (`geometry_version` included).
11. PDF highlight list ordering is deterministic by page + derived geometry sort keys (`sort_top`, `sort_left`) then `created_at`, `id`.
12. PDF highlights store `exact` text at creation/update time; quote-to-chat treats stored `exact` as authoritative and does not re-extract from geometry at quote time.
13. Overlapping PDF highlights are allowed.
14. PDF quote/search capability gating depends on persisted PDF text readiness (`media.plain_text` or equivalent) and is independent from file readability.
15. Existing S4 visibility semantics remain in force: shared readers may read visible highlights, but mutations remain author-only.
16. `GET /media/{id}/pdf-highlights` defaults to `mine_only=true`; `mine_only=false` returns all PDF highlights visible under S4 semantics.
17. Retry resets partial extraction/search artifacts to prevent mixed-generation PDF processing state; user highlight rows are not implicitly mutated by quote/search artifact regeneration.
18. Quote-to-chat always includes stored `highlight.exact` for PDF highlights and never performs geometry re-extraction at quote time.
19. PDF nearby-context inclusion is allowed only when persisted match metadata is `unique` with valid offsets into `media.plain_text`; ambiguous/no-match/empty-exact outcomes must degrade by omitting nearby context, not by choosing an arbitrary match.
20. `pdf_page_text_spans` coverage for quote-capable PDFs is complete and page-indexed (`1..page_count` with one row per page, empty pages represented as zero-length spans).
21. `media.plain_text` and `pdf_page_text_spans` offsets are derived from one shared normalization pass; page-span offsets always reference the persisted post-normalization `media.plain_text`.
22. Visual PDF highlight rendering is a projection of persisted canonical page-space geometry; zoom/rotation/layout changes MUST NOT mutate persisted highlight geometry.
23. Frontend PDF highlight rendering MUST preserve pdf.js-managed text layer integrity (no mutation of pdf.js text spans to represent persisted highlights).
24. Lazy page rendering may defer visual highlight display for off-screen pages, but once a page/text layer renders, visible highlights for that page must be projected from persisted geometry without data mutation.
25. Renderable PDFs with no usable extracted text may remain readable (`can_read=true`) while quote/search remain disabled (`can_quote=false`, `can_search=false`).
26. Password-protected/encrypted PDFs that cannot establish render prerequisites in v1 are not readable and transition to `failed` with a deterministic password/protection-related ingest error code.
27. The PDF.js file-fetch path (`GET /media/{id}/file` -> signed URL) supports incremental/range PDF loading semantics and viewer recovery from signed URL expiry via endpoint re-fetch, without promoting public storage URLs into app contracts.
28. In S6, the PDF linked-items pane is active-page scoped and uses the same visibility semantics as the page-scoped PDF highlight list route.
29. PDF `prefix/suffix` are server-derived from `media.plain_text` only when persisted PDF match metadata is `unique`; otherwise they persist as empty strings until a deterministic enrichment path fills them.
30. PDF highlight create/update payloads are bounded (`quads.length <= 512`, non-empty `exact <= 2000` codepoints) and oversize payloads are rejected with `E_INVALID_REQUEST`.
31. PDF.js worker execution must remain compatible with the constitution CSP (same-origin worker path under `worker-src 'self'` in v1).
32. S6 protects against stale PDF quote-context offsets without artifact-generation version columns by requiring invalidation (`plain_text_match_*` reset + `prefix/suffix` clear) whenever `media.plain_text` or `pdf_page_text_spans` is rewritten for a media.
33. Embedding/search retries for PDF do not rewrite `media.plain_text` or `pdf_page_text_spans`; if a retry/rebuild path does rewrite them, it must trigger invariant `32` before quote context is served.
34. S6 PDF linked-items behavior reuses the existing linked-items pane product surface and row interaction semantics; renderer-specific alignment/measurement may differ, but S6 MUST NOT ship a separate PDF-only pane UX.
35. The linked-items pane shell must support renderer-specific anchor measurement adapters; PDF integration is not required to emulate HTML `data-highlight-anchor` DOM spans.

---

## 7. Acceptance Scenarios

### scenario 1: selection creates stable highlight
- **given**: a readable PDF rendered in the app with a text layer
- **when**: user selects text and creates a highlight
- **then**: a persisted PDF highlight is created with stable geometry anchor data and appears on reload in the same PDF region (subject to accepted S6 text-layer imperfection risk)

### scenario 2: exact text stored at highlight creation
- **given**: a PDF text-layer selection can be mapped to text
- **when**: user creates a highlight
- **then**: the persisted highlight stores `exact` text captured at creation time

### scenario 3: quote-to-chat waits for pdf plain text
- **given**: a PDF is readable in the viewer but `media.plain_text` is not yet ready
- **when**: user attempts quote-to-chat from a PDF highlight
- **then**: the system blocks quote/search behavior with deterministic readiness semantics while preserving file reading/highlighting behavior

### scenario 4: quote-to-chat uses stored text, not re-extraction
- **given**: a PDF highlight exists with stored `exact`
- **when**: user sends that highlight to chat
- **then**: quote-to-chat uses the stored `exact` and nearby spans from persisted PDF plain text, without re-extracting text from geometry at request time

### scenario 5: overlapping pdf highlights are supported
- **given**: a user already has a PDF highlight on a page region
- **when**: the user creates a second highlight that overlaps but is not an exact duplicate under S6 geometry identity rules
- **then**: both highlights persist and render

### scenario 6: visibility suite passes for pdf highlights
- **given**: a PDF media item is visible to user A and not visible to user B
- **when**: both users call the PDF read/highlight APIs
- **then**: user A receives data per visibility and ownership rules, and user B receives masked not-found responses

### scenario 7: processing-state suite passes for pdf read vs quote gating
- **given**: a PDF upload transitions through ingestion states
- **when**: file readability becomes available before/independent of PDF plain-text quote readiness
- **then**: `can_read` and `can_quote` reflect the intended split without violating existing processing lifecycle invariants

### scenario 8: linked-items pane renders pdf highlights
- **given**: a PDF page contains persisted highlights visible to the viewer
- **when**: the viewer opens the media page
- **then**: highlights render in content and appear in the (active-page scoped) linked-items pane using the same visibility and author metadata semantics as existing highlights

### scenario 9: ambiguous-or-missing plain-text match degrades safely
- **given**: a PDF highlight has stored `exact` text and quote-to-chat is otherwise allowed
- **and**: PDF quote match metadata resolves to `ambiguous`, `no_match`, or `empty_exact`
- **when**: user sends the highlight to chat
- **then**: quote-to-chat succeeds, includes stored `exact`, and omits nearby `media.plain_text` context rather than choosing a non-deterministic match

### scenario 10: zoom-or-rotation redraw preserves visual alignment
- **given**: a PDF page with persisted highlights is visible in the viewer
- **when**: the viewer scale/zoom changes (and page rotation changes if supported by the UI)
- **then**: highlights are reprojected from persisted canonical geometry and remain visually aligned without mutating persisted anchor data

### scenario 11: lazy-rendered pages reveal highlights when page text layer appears
- **given**: a PDF has persisted highlights on a page that is initially not rendered
- **when**: the user scrolls until that page renders and its text layer becomes available
- **then**: highlights for that page appear without requiring refetch/rewrite of highlight data

### scenario 12: scanned-or-image-only pdf degrades to visual-read-only semantics
- **given**: a PDF is renderable in PDF.js but normalized extracted text is unavailable/empty
- **when**: ingestion completes
- **then**: media may reach `ready_for_reading` with file-based reading enabled
- **and**: quote/search remain disabled because `pdf_quote_text_ready(media)=false`
- **and**: the UI does not present a false-success text-selection highlight path on pages without a usable text layer

### scenario 13: password-protected pdf fails deterministically in v1
- **given**: an uploaded PDF is password-protected/encrypted and v1 has no password flow
- **when**: ingest attempts to establish render prerequisites/page count
- **then**: media transitions to `failed` with a deterministic password/protection-related ingest error code (recommended `E_PDF_PASSWORD_REQUIRED`)
- **and**: media does not become readable in the viewer

### scenario 14: uploaded pdf reaches readable viewer state through the existing file route
- **given**: a user uploads a valid PDF file through the Slice 1 upload flow
- **when**: PDF extraction/processing reaches `ready_for_reading`
- **then**: the media page can open a PDF.js viewer using the authenticated `GET /media/{media_id}/file` path and render pages without document iframes

### scenario 15: signed file url expiry is recoverable for an active pdf viewer session
- **given**: a readable PDF is open in the viewer through a short-lived signed file URL
- **when**: the storage signed URL expires during continued reading/page loading
- **then**: the client re-fetches `GET /media/{media_id}/file` and resumes PDF.js fetches without exposing a long-lived storage URL or requiring a public bucket

### scenario 16: linked-items pane tracks the active pdf page in s6 page-scoped mode
- **given**: a PDF has visible highlights on multiple pages
- **when**: the viewer changes the active page used by the linked-items pane (via scroll/navigation)
- **then**: the linked-items pane updates to the highlights for that active page using page-scoped PDF highlight list semantics and preserves visibility/ownership rules

### scenario 17: pdf text-artifact rebuild invalidates stale quote-match metadata and safely recovers
- **given**: a PDF already has persisted highlights and at least one highlight has `plain_text_match_status='unique'`
- **when**: an operator retry/rebuild path rewrites `media.plain_text` and/or `pdf_page_text_spans` for that media
- **then**: existing PDF highlight quote-match metadata is invalidated (`plain_text_match_*` reset to pending/null offsets and `prefix/suffix` cleared) before quote-to-chat relies on those artifacts
- **and**: quote-to-chat degrades safely while match metadata is pending
- **and**: deterministic enrichment may later recompute match metadata without changing highlight geometry or stored `exact`

### scenario 18: pdf highlights reuse the existing linked-items pane shell via a pdf alignment adapter
- **given**: the media page already uses the shared linked-items pane shell for HTML/EPUB highlights
- **and**: a PDF page has visible persisted highlights
- **when**: the PDF reader renders the active page and linked-items pane rows
- **then**: PDF highlight rows render in the same linked-items pane product surface (not a separate PDF-only pane)
- **and**: row interactions (focus/quote/annotation affordances) remain consistent with existing highlight rows
- **and**: row alignment is driven by PDF renderer-provided anchor positions rather than HTML span-anchor injection requirements

---

## 8. Traceability Map

| l1 acceptance item | spec section(s) |
|---|---|
| Selection creates stable highlight | 2.2, 2.3, 3.2, 4.3, 4.5, 6.8, 6.9, 6.10, 6.22, 6.24, 6.30, 7.1, 7.10, 7.11 |
| Exact text stored at highlight creation | 2.2, 2.4, 3.2, 4.3, 4.4, 6.12, 6.29, 7.2, 7.4 |
| `media.plain_text` persisted and page-indexed (`pdf_page_text_spans`) before quote-to-chat | 2.2, 3.1, 4.1, 4.4, 6.14, 6.20, 6.25, 7.3, 7.7, 7.14 |
| Quote-to-chat uses stored text (not re-extraction) | 2.4, 3.2, 4.3, 4.4, 6.12, 6.18, 6.19, 6.29, 7.4, 7.9 |
| Overlapping PDF highlights supported | 2.2, 4.3, 6.13, 7.5 |
| Visibility test suite passes | 2.1, 2.2, 4.2, 4.3, 4.4, 4.5, 6.2, 6.15, 6.16, 6.28, 6.34, 7.6, 7.8, 7.16, 7.18 |
| Processing-state test suite passes | 2.2, 2.4, 3.1, 3.2, 4.1, 4.2, 4.4, 5, 6.14, 6.17, 6.20, 6.25, 6.26, 6.27, 6.31, 6.32, 6.33, 6.35, 7.3, 7.7, 7.9, 7.12, 7.13, 7.14, 7.15, 7.17, 7.18 |

---

## 9. Unresolved Questions + Temporary Defaults (must be empty before freeze)

| question | temporary default behavior | owner | due |
|---|---|---|---|
