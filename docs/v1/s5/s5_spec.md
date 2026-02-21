# Slice 5 - EPUB (L2 Spec)

This slice proves multi-fragment document behavior for v1 with EPUB as the first non-single-fragment document kind.
This contract is normative for all S5 implementation PRs.

---

## 1. Goal and Scope

**Goal**: Prove multi-fragment media works.

**In scope**:
- EPUB ingestion using Slice 1 upload/storage foundations (`media_file`, file hash dedupe)
- Deterministic chapter fragment materialization (one fragment per readable chapter/spine item)
- Persisted TOC extraction with stable chapter linkage
- EPUB chapter list and chapter navigation APIs
- Reuse S2 highlight semantics and S3 quote-to-chat semantics on EPUB fragments
- Visibility and processing-state suite compatibility for EPUB
- Explicit retry contract for failed EPUB extraction

**Out of scope**:
- Full EPUB navigation polish (advanced reader UX)
- EPUB ingest-from-URL API surface in this slice (upload-first in S5; URL ingest deferred to v2)
- PDF ingest-from-URL API surface in this slice (deferred to v2)
- PDF extraction/geometry logic (S6)
- Sharing semantics changes (already owned by S4)
- Semantic retrieval/ranking changes (S9)

**Scope guardrail (v1 consistency)**:
- EPUB ingest-from-URL is deferred to v2 and is not a v1 requirement.
- PDF ingest-from-URL is deferred to v2 and is not a v1 requirement.
- Ingestion architecture in S5 MUST remain source-agnostic: future URL EPUB ingest (v2) must converge into the same stored-file extraction pipeline and produce identical artifact contracts.

---

## 2. Domain Models

### 2.1 Existing Models Reused (No Semantic Changes)

#### `media` (subset relevant to S5)
- `id: uuid` (PK)
- `kind: text` (must be `'epub'` for S5 media)
- `title: text` (mutable until extraction completes; then treated as immutable content metadata)
- `processing_status: processing_status_enum`
- `failure_stage: failure_stage_enum | null`
- `last_error_code: text | null`
- `last_error_message: text | null`
- `processing_attempts: int >= 0`
- `requested_url: text | null` (not used for upload-first S5)
- `canonical_url: text | null` (not used for upload-first S5)
- `file_sha256: text | null` (required for dedupe completion)
- `created_by_user_id: uuid`

EPUB-specific constraints:
1. Upload dedupe uniqueness is `(created_by_user_id, kind='epub', file_sha256)`.
2. `created_by_user_id` is required and immutable for uploaded EPUB rows.
3. `ready_for_reading` requires chapter fragments to exist with both `html_sanitized` and `canonical_text`.

#### `media_file` (required for EPUB)
- `media_id: uuid` (PK/FK `media.id`)
- `storage_path: text`
- `content_type: text` (EPUB: `application/epub+zip`)
- `size_bytes: bigint`

#### `fragments` (EPUB chapter artifacts)
- `id: uuid` (PK)
- `media_id: uuid` (FK `media.id`)
- `idx: int` (unique within media)
- `html_sanitized: text` (immutable after `ready_for_reading`)
- `canonical_text: text` (immutable after `ready_for_reading`)
- `created_at: timestamptz`

#### `fragment_blocks` (existing context-window index)
- `fragment_id: uuid` (FK `fragments.id`)
- `block_idx: int` (unique per fragment)
- `start_offset: int >= 0`
- `end_offset: int >= start_offset`

`fragment_blocks` is treated as a derived artifact from immutable `fragment.canonical_text`.
It is regenerated with fragment regeneration and is deleted on retry reset.

EPUB chapter constraints:
1. For each ready EPUB media, chapter fragment indices are contiguous `0..N-1` (no gaps, no duplicates).
2. `idx` is the canonical chapter ordering key for reader navigation and API ordering.
3. S2/S3 highlight and context-window logic reuses `fragment.canonical_text` without EPUB-specific offset rules.
4. Fragment generation follows EPUB spine reading order, not TOC order.
5. A spine item produces a fragment only if its sanitized content yields non-empty `canonical_text` (after trim); non-readable spine items do not produce fragments.

### 2.2 New Model: `epub_toc_nodes`

`epub_toc_nodes` persists the canonical TOC snapshot captured at extraction time.
TOC is immutable after media reaches `ready_for_reading` (except full rebuild on retry).

```sql
CREATE TABLE epub_toc_nodes (
  media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  parent_node_id TEXT NULL,
  label TEXT NOT NULL,
  href TEXT NULL,
  fragment_idx INTEGER NULL,
  depth INTEGER NOT NULL,
  order_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (media_id, node_id),

  CONSTRAINT ck_epub_toc_nodes_node_id_nonempty
    CHECK (char_length(node_id) BETWEEN 1 AND 255),
  CONSTRAINT ck_epub_toc_nodes_parent_nonself
    CHECK (parent_node_id IS NULL OR parent_node_id <> node_id),
  CONSTRAINT ck_epub_toc_nodes_label_nonempty
    CHECK (char_length(trim(label)) BETWEEN 1 AND 512),
  CONSTRAINT ck_epub_toc_nodes_depth_range
    CHECK (depth >= 0 AND depth <= 16),
  CONSTRAINT ck_epub_toc_nodes_fragment_idx_nonneg
    CHECK (fragment_idx IS NULL OR fragment_idx >= 0),
  CONSTRAINT ck_epub_toc_nodes_order_key_format
    CHECK (order_key ~ '^[0-9]{4}([.][0-9]{4})*$'),

  CONSTRAINT fk_epub_toc_nodes_parent
    FOREIGN KEY (media_id, parent_node_id)
    REFERENCES epub_toc_nodes(media_id, node_id)
    ON DELETE CASCADE,

  CONSTRAINT fk_epub_toc_nodes_fragment
    FOREIGN KEY (media_id, fragment_idx)
    REFERENCES fragments(media_id, idx)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX uix_epub_toc_nodes_media_order
  ON epub_toc_nodes (media_id, order_key);

CREATE INDEX idx_epub_toc_nodes_media_fragment
  ON epub_toc_nodes (media_id, fragment_idx);
```

Semantics:
1. `node_id` is stable within one media (deterministic by parse path; not globally stable across different media rows).
2. `order_key` is a canonical sortable path key with format `dddd(.dddd)*` where each `dddd` is a zero-padded 4-digit 1-based sibling ordinal.
3. `order_key` generation algorithm:
   - build the TOC tree from parser output in normalized source order
   - for each node, assign sibling ordinal within its parent by that normalized order
   - build `order_key` by concatenating parent path ordinals with `.` separators (example: third child of root #2 is `0002.0003`)
4. Node ordering for output and comparisons MUST use ASCII lexicographic ascending compare on `order_key`.
5. If parser metadata yields ambiguous sibling order, tie-break deterministically by source encounter index, then by `node_id` ascending.
6. `fragment_idx` MAY be null for structural TOC nodes that do not anchor to a readable chapter.
7. Empty/absent source TOC is represented as zero rows (not an extraction failure by itself).

### 2.3 Derived API Shapes

#### `EpubChapterSummaryOut`
```json
{
  "idx": 0,
  "fragment_id": "uuid",
  "title": "Chapter 1",
  "char_count": 12345,
  "word_count": 2010,
  "has_toc_entry": true,
  "primary_toc_node_id": "1.2"
}
```

Type and derivation contract:
- `idx: integer` (`>= 0`)
- `fragment_id: uuid`
- `title: string` (`1..255` chars)
- `char_count: integer` (`>= 1`), exact Unicode codepoint length of `canonical_text`
- `word_count: integer` (`>= 1`), count of non-empty tokens from `canonical_text.trim().split(/\s+/)`
- `has_toc_entry: boolean`, true iff at least one `epub_toc_nodes` row has `fragment_idx = idx`
- `primary_toc_node_id: string | null`
  - null iff `has_toc_entry=false`
  - otherwise `node_id` of the mapped TOC node with minimum `order_key`

Title resolution (deterministic):
1. First TOC node mapped to `fragment_idx=idx`, ordered by `order_key`.
2. Else first heading text (`h1..h6`) found in `html_sanitized`.
3. Else fallback `Chapter {idx+1}`.

#### `EpubChapterOut`
```json
{
  "idx": 4,
  "fragment_id": "uuid",
  "title": "Methods",
  "html_sanitized": "<section>...</section>",
  "canonical_text": "...",
  "char_count": 9800,
  "word_count": 1660,
  "has_toc_entry": true,
  "primary_toc_node_id": "2.3",
  "prev_idx": 3,
  "next_idx": 5,
  "created_at": "timestamp"
}
```

Type and derivation contract:
- Includes all `EpubChapterSummaryOut` fields with identical semantics.
- `html_sanitized: string` (non-empty, persisted sanitized HTML)
- `canonical_text: string` (non-empty, immutable canonical text)
- `prev_idx: integer | null`
- `next_idx: integer | null`
- `created_at: RFC3339 timestamp`

#### `EpubTocNodeOut`
```json
{
  "node_id": "2.3",
  "parent_node_id": "2",
  "label": "Methods",
  "href": "Text/chapter5.xhtml#methods",
  "fragment_idx": 4,
  "depth": 1,
  "order_key": "0002.0003",
  "children": []
}
```

Type contract:
- `node_id: string` (`1..255`)
- `parent_node_id: string | null`
- `label: string` (`1..512`, trimmed non-empty)
- `href: string | null`
- `fragment_idx: integer | null` (`>= 0` when present)
- `depth: integer` (`0..16`)
- `order_key: string` (format `dddd(.dddd)*`, deterministic sibling ordering key)
- `children: EpubTocNodeOut[]` (recursive, sorted by `order_key` ascending)

### 2.4 EPUB Resource Resolution Contract

For each chapter fragment persisted in S5:
1. Relative `href`/`src` references from EPUB content MUST be rewritten using EPUB resource mapping.
2. Rewritten EPUB-internal resource URLs MUST use canonical safe path format:
   - `/media/{media_id}/assets/{asset_key}`
3. `asset_key` derivation MUST be deterministic for identical EPUB bytes:
   - based on normalized EPUB-internal resource path (fragment stripped)
   - path traversal and absolute/drive-qualified forms are rejected
   - collisions are disambiguated deterministically
4. Canonical asset URLs MUST resolve through server-controlled fetch paths (no direct browser access to private storage objects).
5. External image `src` values MUST be rewritten to the platform image-proxy path; direct external image origins MUST NOT remain in persisted `html_sanitized`.
6. Unresolvable EPUB-internal resources MUST degrade safely:
   - links: may remain as inert/non-resolving UI links
   - images/media: may be omitted or rendered as missing without failing chapter read
7. Resource resolution defects alone do not block `ready_for_reading` when textual chapter extraction is valid.
8. Active content is always removed by sanitization (scripts/forms/unsafe attrs/protocols), consistent with L0 sanitizer rules.

### 2.5 EPUB Title Resolution Contract

Title resolution at extraction completion is deterministic and parser-agnostic.

Priority (first valid wins):
1. OPF/package metadata title fields, checked in order:
   - `dc:title`
   - `title`
2. Upload filename with extension removed.
3. Fallback literal: `Untitled EPUB`.

Normalization rules:
1. Trim leading/trailing whitespace.
2. Collapse internal whitespace runs to a single ASCII space.
3. Reject empty result after normalization and continue to next fallback source.
4. Persist at most 255 characters (truncate beyond 255).

Lifecycle rules:
1. During extraction, title MAY be updated from provisional upload title to resolved title.
2. Once media reaches `ready_for_reading`, title is treated as immutable for that media row.
3. On retry, title is recomputed using the same rules; behavior must remain deterministic for identical input metadata/filename.

### 2.6 EPUB Archive Safety Contract

Archive parsing MUST enforce the following safety controls:
1. Entry path normalization MUST reject:
   - absolute paths
   - `..` traversal segments
   - Windows drive-qualified paths
2. Hard limits (default values):
   - `max_entries = 10000`
   - `max_total_uncompressed_bytes = 536870912` (512 MiB)
   - `max_single_entry_uncompressed_bytes = 67108864` (64 MiB)
   - `max_compression_ratio = 100`
   - `max_parse_time_ms = 30000`
3. Violations MUST terminate extraction for that media and produce error code `E_ARCHIVE_UNSAFE`.
4. `E_ARCHIVE_UNSAFE` is terminal for that media row in S5.
5. `POST /media/{media_id}/retry` MUST reject retry when `last_error_code = E_ARCHIVE_UNSAFE` with `E_RETRY_NOT_ALLOWED` (409).
6. Remediation path is a fresh upload that creates a new media row with corrected input bytes.

---

## 3. State Machines

### 3.1 EPUB Processing Lifecycle

Allowed transitions (same global lifecycle, EPUB-specific guards):
- `pending -> extracting`
- `extracting -> ready_for_reading`
- `ready_for_reading -> embedding`
- `embedding -> ready`
- `ready_for_reading -> ready` (embedding skipped)
- `any -> failed`
- `failed -> extracting` (manual retry)

Guard conditions:
1. `pending -> extracting` requires:
   - `media.kind = 'epub'`
   - `media_file` exists and object is present in storage
   - file type and size validation passed
   - archive safety validation passed
2. `extracting -> ready_for_reading` requires all:
   - chapter fragment set exists (`N >= 1`)
   - each chapter fragment has non-null `html_sanitized` and `canonical_text`
   - TOC snapshot write finished (including zero-row TOC case)
   - fragment indices contiguous `0..N-1`
3. `failed -> extracting` requires:
   - caller authorized for retry
   - previous state exactly `failed`
   - `last_error_code != 'E_ARCHIVE_UNSAFE'`
   - old artifacts deleted before new extraction begins (`fragments`, `fragment_blocks`, `epub_toc_nodes`, and any existing chunk/embedding artifacts for this media)

Illegal transitions (explicit):
- `pending -> ready_for_reading` (skips extraction)
- `ready|embedding|ready_for_reading -> extracting` without retry path
- `ready -> pending`
- `failed -> ready_for_reading` without passing through extraction

### 3.2 TOC Artifact Lifecycle

- `absent -> materialized` during successful extraction.
- `materialized -> immutable` after `ready_for_reading`.
- `immutable -> deleted` only when media is deleted or extraction retry resets artifacts.

---

## 4. API Contracts

All JSON responses use success envelope `{ "data": ... }` and error envelope `{ "error": { "code": "...", "message": "..." } }`.
Binary endpoints explicitly document non-JSON response semantics.

### 4.1 `POST /media/upload/init` (EPUB path)

**request**:
```json
{
  "kind": "epub",
  "filename": "book.epub",
  "content_type": "application/epub+zip",
  "size_bytes": 1048576
}
```

**response 200**:
```json
{
  "data": {
    "media_id": "uuid",
    "storage_path": ".../original.epub",
    "token": "signed-upload-token",
    "expires_at": "timestamp"
  }
}
```

**errors**:
- `E_INVALID_REQUEST` (400): malformed body
- `E_INVALID_KIND` (400): non-file kind supplied
- `E_INVALID_CONTENT_TYPE` (400): invalid EPUB MIME
- `E_FILE_TOO_LARGE` (400): exceeds EPUB size cap
- `E_SIGN_UPLOAD_FAILED` (500): signed upload creation failed

### 4.2 `POST /media/{media_id}/ingest` (EPUB extension)

This endpoint remains the upload confirmation + dedupe commit entrypoint.
For EPUB in S5, extraction is triggered after confirmation only when transition guards allow `pending -> extracting`.

**request**:
- empty body

**response 200**:
```json
{
  "data": {
    "media_id": "uuid",
    "duplicate": false,
    "processing_status": "extracting",
    "ingest_enqueued": true
  }
}
```

Response semantics:
1. `duplicate=true`:
   - `media_id` is the winning existing media id
   - `ingest_enqueued=false`
   - `processing_status` is winner status snapshot
2. `duplicate=false`:
   - if media is in `pending`, extraction is triggered for this media
   - `ingest_enqueued=true` for successful async dispatch from `pending`
   - `ingest_enqueued=false` for idempotent non-dispatch snapshots (`extracting|ready_for_reading|embedding|ready|failed`) and for explicit synchronous/internal execution mode
   - `processing_status` is current state snapshot (`pending|extracting|ready_for_reading|embedding|ready|failed`)
3. Backward compatibility: existing clients that only read `media_id` and `duplicate` remain valid.
4. Re-entry/idempotency guard:
   - repeated `/ingest` on the same non-duplicate media row after dispatch/state advance MUST NOT enqueue again and MUST NOT increment `processing_attempts`.
   - `failed` rows are remediated through `POST /media/{media_id}/retry`, not by redispatch through `/ingest`.

**errors**:
- `E_MEDIA_NOT_FOUND` (404): media missing or not visible
- `E_FORBIDDEN` (403): caller is not upload creator
- `E_STORAGE_MISSING` (400): file/object not found
- `E_INVALID_FILE_TYPE` (400): magic bytes mismatch
- `E_ARCHIVE_UNSAFE` (400): archive safety validation failed (e.g., traversal/zip-bomb thresholds)
- `E_FILE_TOO_LARGE` (400): streamed object exceeds limit
- `E_STORAGE_ERROR` (500): storage read failure

### 4.3 `POST /media/{media_id}/retry`

Manual retry for failed EPUB extraction.

**request**:
- empty body

**response 202**:
```json
{
  "data": {
    "media_id": "uuid",
    "processing_status": "extracting",
    "retry_enqueued": true
  }
}
```

Retry semantics:
1. Valid only when `media.kind='epub'`, `processing_status='failed'`, and `last_error_code != 'E_ARCHIVE_UNSAFE'`.
2. Before any cleanup/reset mutation, enforce source-integrity preconditions:
   - `media_file` exists and source object exists in storage.
   - source bytes pass EPUB type/size validation.
   - when `media.file_sha256` is present, source bytes must match the stored hash (integrity mismatch is treated as source-missing/corrupt failure for retry semantics).
3. Before re-extraction, delete existing extraction artifacts for this media:
   - `fragments`
   - `fragment_blocks`
   - `epub_toc_nodes`
   - any existing chunk/embedding artifacts for this media
4. Increment `processing_attempts`.
5. Clear `failure_stage`, `last_error_code`, `last_error_message`, `failed_at`.
6. Transition to `extracting` and dispatch extraction.
7. If source-integrity precondition fails, return deterministic error and perform no artifact cleanup, no lifecycle mutation, and no dispatch.

**errors**:
- `E_MEDIA_NOT_FOUND` (404): media missing or not visible
- `E_FORBIDDEN` (403): caller is not upload creator
- `E_RETRY_INVALID_STATE` (409): media is not in `failed`
- `E_RETRY_NOT_ALLOWED` (409): retry blocked for terminal failure reason (`E_ARCHIVE_UNSAFE`)
- `E_INVALID_KIND` (400): media kind is not EPUB
- `E_STORAGE_MISSING` (400): source file metadata/object missing or source integrity mismatch before retry reset
- `E_INVALID_FILE_TYPE` (400): source bytes fail EPUB file-type validation before retry reset
- `E_FILE_TOO_LARGE` (400): source bytes exceed EPUB size cap before retry reset
- `E_STORAGE_ERROR` (500): storage read failure while validating source before retry reset

### 4.4 `GET /media/{media_id}/chapters`

Returns lightweight chapter manifest.

**request**:
- query params:
  - `limit` (optional, default `100`, min `1`, max `200`)
  - `cursor` (optional integer chapter idx; returns items with `idx > cursor`)

**response 200**:
```json
{
  "data": [
    {
      "idx": 0,
      "fragment_id": "uuid",
      "title": "Chapter 1",
      "char_count": 12345,
      "word_count": 2010,
      "has_toc_entry": true,
      "primary_toc_node_id": "1.1"
    }
  ],
  "page": {
    "next_cursor": 99,
    "has_more": true
  }
}
```

Ordering and paging:
1. Ordered strictly by `idx ASC`.
2. `next_cursor` is last returned `idx`; `null` when page exhausted.
3. `has_more=true` iff at least one row exists with `idx > next_cursor`; otherwise `false`.
4. Response contract: `data` length `<= limit`.

**errors**:
- `E_MEDIA_NOT_FOUND` (404): media missing or not visible
- `E_MEDIA_NOT_READY` (409): media status `< ready_for_reading` or `failed`
- `E_INVALID_REQUEST` (400): invalid `limit` or `cursor`
- `E_INVALID_KIND` (400): media kind is not EPUB

### 4.5 `GET /media/{media_id}/chapters/{idx}`

Returns one chapter payload with navigation pointers.

**request**:
- path param `idx` (integer, `>= 0`)

**response 200**:
```json
{
  "data": {
    "idx": 4,
    "fragment_id": "uuid",
    "title": "Methods",
    "html_sanitized": "<section>...</section>",
    "canonical_text": "...",
    "char_count": 9800,
    "word_count": 1660,
    "has_toc_entry": true,
    "primary_toc_node_id": "2.3",
    "prev_idx": 3,
    "next_idx": 5,
    "created_at": "timestamp"
  }
}
```

Navigation semantics:
- `max_idx` is the greatest persisted chapter `idx` for that media (`N-1` by contiguity invariant).
- `prev_idx = idx-1` when `idx > 0`, else `null`.
- `next_idx = idx+1` when `idx < max_idx`, else `null`.

**errors**:
- `E_MEDIA_NOT_FOUND` (404): media missing or not visible
- `E_MEDIA_NOT_READY` (409): media status `< ready_for_reading` or `failed`
- `E_CHAPTER_NOT_FOUND` (404): chapter index not present for this media
- `E_INVALID_KIND` (400): media kind is not EPUB

### 4.6 `GET /media/{media_id}/toc`

Returns persisted nested TOC tree.

**request**:
- no query/body

**response 200**:
```json
{
  "data": {
    "nodes": [
      {
        "node_id": "1",
        "parent_node_id": null,
        "label": "Part I",
        "href": "Text/part1.xhtml",
        "fragment_idx": null,
        "depth": 0,
        "order_key": "0001",
        "children": [
          {
            "node_id": "1.1",
            "parent_node_id": "1",
            "label": "Chapter 1",
            "href": "Text/ch1.xhtml",
            "fragment_idx": 0,
            "depth": 1,
            "order_key": "0001.0001",
            "children": []
          }
        ]
      }
    ]
  }
}
```

TOC semantics:
1. Node ordering is deterministic by `order_key` within each sibling set.
2. `fragment_idx` may be null.
3. EPUBs without usable TOC return `nodes: []` (not an error).

**errors**:
- `E_MEDIA_NOT_FOUND` (404): media missing or not visible
- `E_MEDIA_NOT_READY` (409): media status `< ready_for_reading` or `failed`
- `E_INVALID_KIND` (400): media kind is not EPUB

### 4.7 Existing Endpoint Compatibility

#### `GET /media/{media_id}/fragments`
- Remains supported and ordered by `idx ASC`.
- For EPUB in ready states, returns all chapter fragments (full payload).
- No contract removal in S5.

#### Highlight endpoints (`/fragments/{fragment_id}/highlights`, `/highlights/*`)
- No API shape change in S5.
- EPUB fragments are first-class fragment targets; all S2/S4 highlight rules apply unchanged.

#### Quote-to-chat (`POST /conversations/messages` with context type `highlight`)
- No API shape change in S5.
- EPUB highlight contexts render via existing fragment-based context-window logic.

### 4.8 `GET /media/{media_id}/assets/{asset_key}`

Returns extracted EPUB-internal asset bytes through the canonical safe fetch path used by rewritten chapter HTML.

**request**:
- path params:
  - `media_id: uuid`
  - `asset_key: string` (path-safe canonical key generated at extraction time)

**response 200**:
- binary payload (not JSON envelope) with:
  - `Content-Type` from persisted extracted asset metadata
  - cache headers consistent with private authenticated media content

Asset fetch semantics:
1. Valid only for `media.kind='epub'`.
2. Valid only when media is readable (`ready_for_reading|embedding|ready`).
3. Uses canonical visibility predicate; unauthorized access is masked.
4. Missing/unmapped assets are masked as not found.
5. Endpoint MUST NOT expose raw private storage URLs in response body or headers.

**errors**:
- `E_MEDIA_NOT_FOUND` (404): media not visible to caller or asset key is missing/unmapped
- `E_MEDIA_NOT_READY` (409): media status `< ready_for_reading` or `failed`
- `E_INVALID_KIND` (400): media kind is not EPUB
- `E_INVALID_REQUEST` (400): malformed `asset_key`

---

## 5. Error Codes (S5 Additions + Uses)

| code | http | meaning |
|---|---:|---|
| E_RETRY_INVALID_STATE | 409 | Retry requested while media is not in `failed` state. |
| E_RETRY_NOT_ALLOWED | 409 | Retry requested for terminal failure reason that cannot be remediated in-row. |
| E_CHAPTER_NOT_FOUND | 404 | Requested chapter index does not exist for the EPUB media. |
| E_MEDIA_NOT_FOUND | 404 | Media not found or not visible to viewer (masked existence). |
| E_FORBIDDEN | 403 | Caller can see media but is not authorized to mutate ingest/retry state. |
| E_MEDIA_NOT_READY | 409 | Media exists but has not reached readable status. |
| E_INVALID_KIND | 400 | Operation not valid for non-EPUB media. |
| E_INVALID_CONTENT_TYPE | 400 | Upload init content type is not valid for EPUB. |
| E_INVALID_REQUEST | 400 | Invalid query/body shape (e.g., invalid chapter cursor/limit). |
| E_STORAGE_MISSING | 400 | File metadata/object missing, or source-integrity precondition failure in ingest/retry validation. |
| E_INVALID_FILE_TYPE | 400 | Uploaded/source bytes do not match EPUB file-type validation. |
| E_ARCHIVE_UNSAFE | 400 | EPUB archive violates safety constraints (path traversal/size/compression/time limits). |
| E_FILE_TOO_LARGE | 400 | Uploaded/source bytes exceed configured EPUB size limit. |
| E_SIGN_UPLOAD_FAILED | 500 | Upload init could not mint signed upload token. |
| E_STORAGE_ERROR | 500 | Storage read/write failure during ingest/retry operations. |
| E_INGEST_FAILED | 502 | Extraction pipeline failed for non-timeout ingestion failure. |
| E_INGEST_TIMEOUT | 504 | Extraction pipeline timed out. |
| E_SANITIZATION_FAILED | 500 | Sanitization or canonicalization step failed during extraction. |

---

## 6. Invariants

1. EPUB chapter fragments are immutable after `ready_for_reading` (`html_sanitized`, `canonical_text` never mutate in place).
2. Ready EPUB chapter indices are contiguous `0..N-1` and uniquely map to fragments.
3. TOC snapshot is immutable after `ready_for_reading` and versioned only by creating a new media row or retry rebuild.
4. Any TOC node with non-null `fragment_idx` references a valid chapter fragment for the same media.
5. `GET /media/{id}/chapters` and `GET /media/{id}/chapters/{idx}` ordering/navigation are deterministic by fragment `idx`.
6. Highlight anchoring for EPUB uses existing canonical offset model `(fragment_id, start_offset, end_offset)` only.
7. Highlight uniqueness and overlap semantics are unchanged from S2 (`(user_id, fragment_id, start_offset, end_offset)` unique; overlaps allowed).
8. For fixed `(fragment_id, start_offset, end_offset)`, EPUB quote-to-chat context output is deterministic from immutable `fragment.canonical_text` only (no DOM/TOC-dependent offset behavior).
9. EPUB chapter/TOC read endpoints (`/chapters`, `/chapters/{idx}`, `/toc`) enforce canonical media visibility predicate and mask unauthorized access as `404 E_MEDIA_NOT_FOUND`.
10. Retry always clears old extraction artifacts and any existing chunk/embedding artifacts before writing new ones; mixed-generation artifacts are forbidden.
11. `GET /media/{id}/chapters` is metadata-only and MUST NOT include `html_sanitized` or `canonical_text` in manifest items.
12. EPUB media title at `ready_for_reading` is non-empty and produced by deterministic fallback order (`dc:title/title -> filename -> 'Untitled EPUB'`).
13. Chapter TOC summary mapping is deterministic: `has_toc_entry` and `primary_toc_node_id` are computed from `epub_toc_nodes` by `fragment_idx` and minimum `order_key`.
14. Chapter list pagination follows the canonical cursor envelope with both `next_cursor` and `has_more`.
15. EPUB extraction enforces archive safety controls and fails with `E_ARCHIVE_UNSAFE` when limits/path rules are violated.
16. `E_ARCHIVE_UNSAFE` is terminal for the media row; retry is rejected with `E_RETRY_NOT_ALLOWED` and remediation is fresh upload to a new row.
17. EPUB internal asset fetch endpoint (`/media/{id}/assets/{asset_key}`) enforces canonical visibility masking and never exposes direct private storage object URLs.
18. `POST /media/{id}/ingest` is idempotent for non-duplicate rows once state has advanced beyond dispatch eligibility: no redispatch, `ingest_enqueued=false`, and no `processing_attempts` increment on repeat calls.
19. `POST /media/{id}/retry` enforces source-integrity preconditions before cleanup/reset; precondition failure performs no artifact cleanup, no lifecycle mutation, and no dispatch.

---

## 7. Acceptance Scenarios

### scenario 1: chapter fragment immutability
- **given**: an EPUB media reaches `ready_for_reading` with chapter fragments
- **when**: chapter list/read endpoints are called repeatedly and highlights are created/deleted
- **then**: each fragment's `html_sanitized` and `canonical_text` remain byte-for-byte unchanged

### scenario 2: highlights scoped to fragment
- **given**: an EPUB with at least two chapter fragments
- **when**: user creates a highlight in chapter `idx=1`
- **then**: highlight anchors to that chapter fragment only and does not appear on chapter `idx=0` or `idx=2`

### scenario 3: reuse all document logic
- **given**: an EPUB chapter fragment with canonical text containing unicode and block boundaries
- **when**: user creates a highlight and sends it to chat
- **then**: server derives `exact/prefix/suffix` from chapter `canonical_text` and quote-to-chat uses standard fragment context rendering

### scenario 4: visibility test suite passes for new EPUB endpoints
- **given**: media is visible to user A and not visible to user B
- **when**: both call `/media/{id}/chapters`, `/media/{id}/chapters/{idx}`, and `/media/{id}/toc`
- **then**: user A receives data; user B receives `404 E_MEDIA_NOT_FOUND` on all endpoints

### scenario 5: processing-state suite passes for EPUB
- **given**: upload-confirmed EPUB media in `pending`
- **when**: extraction succeeds and clients issue repeat `POST /media/{id}/ingest` calls after initial dispatch/state advance
- **then**: state transitions `pending -> extracting -> ready_for_reading` and chapter/TOC artifacts exist, and repeat ingest calls are idempotent snapshots (no redispatch, no additional attempt increment)

### scenario 6: retry from failed extraction
- **given**: EPUB media in `failed` with old partial extraction/chunk artifacts
- **when**: authorized caller invokes `POST /media/{id}/retry`
- **then**: source-integrity preconditions are checked before cleanup/reset; with valid source bytes old extraction/chunk artifacts are deleted, attempts increment, state transitions to `extracting`, and re-extraction is triggered
- **and**: if source-integrity preconditions fail, retry returns deterministic validation/storage error and media/artifacts remain unchanged

### scenario 7: chapter navigation determinism
- **given**: EPUB with `N` chapter fragments
- **when**: client fetches chapter `idx=k`
- **then**: response always returns `prev_idx`/`next_idx` derived strictly from `idx` and media bounds

### scenario 8: TOC persistence and mapping
- **given**: EPUB with nested TOC entries
- **when**: client fetches `/media/{id}/toc`
- **then**: response returns deterministic nested tree order and mapped `fragment_idx` values where resolvable

### scenario 9: unresolved internal assets degrade safely
- **given**: EPUB chapter HTML references both resolvable and unresolvable internal assets
- **when**: extraction completes and authorized reader fetches chapter content and resolved asset URLs
- **then**: media reaches `ready_for_reading`, resolved assets are served only via `/media/{id}/assets/{asset_key}`, unresolved assets degrade safely, and active content does not execute

### scenario 10: deterministic title fallback
- **given**: uploaded EPUB where OPF title metadata is missing or empty
- **when**: extraction completes
- **then**: media title is set from filename (extension stripped), and if filename is unusable the stored title is exactly `Untitled EPUB`

### scenario 11: embedding path transition coverage
- **given**: EPUB media in `ready_for_reading` and embedding is enabled
- **when**: embedding job succeeds
- **then**: state transitions `ready_for_reading -> embedding -> ready` without mutating chapter fragment content

### scenario 12: embedding-failure retry reset
- **given**: EPUB media in `failed` after partial chunk/embedding artifacts were written
- **when**: authorized caller invokes `POST /media/{id}/retry`
- **then**: chunk/embedding artifacts and extraction artifacts are cleared before transition to `extracting`

### scenario 13: non-epub kind guards on chapter/toc endpoints
- **given**: media row exists with kind not equal to `epub`
- **when**: caller invokes `/media/{id}/chapters`, `/media/{id}/chapters/{idx}`, or `/media/{id}/toc`
- **then**: endpoint returns `400 E_INVALID_KIND`

### scenario 14: unsafe archive rejection
- **given**: uploaded `.epub` whose archive violates traversal or compression/size/time limits
- **when**: ingest/extraction validation runs
- **then**: media does not reach `ready_for_reading` and failure is recorded with `E_ARCHIVE_UNSAFE`

### scenario 15: retry blocked for terminal archive failure
- **given**: EPUB media is in `failed` with `last_error_code='E_ARCHIVE_UNSAFE'`
- **when**: caller invokes `POST /media/{id}/retry`
- **then**: API returns `409 E_RETRY_NOT_ALLOWED`, media row remains unchanged, and client remediation is fresh upload

---

## 8. Traceability Map

| l1 acceptance item | spec section(s) |
|---|---|
| Chapter fragment immutability holds | 2.1, 3.1, 6.1, 7.1 |
| Highlights scoped to fragment | 2.1, 4.7, 6.6, 7.2 |
| Reuse all document logic | 2.1, 2.3, 4.7, 6.6, 6.8, 7.3 |
| Visibility test suite passes | 4.4, 4.5, 4.6, 6.9, 7.4 |
| Processing-state test suite passes | 3.1, 4.2, 4.3, 6.10, 6.18, 6.19, 7.5, 7.6, 7.11, 7.12 |
| Embedding path transition coverage | 3.1, 6.1, 7.11 |
| Embedding-failure retry reset | 3.1, 4.3, 6.10, 7.12 |
| Retry clears all mixed-generation artifacts | 3.1, 4.3, 6.10, 7.6, 7.12 |
| Chapter/TOC mapping determinism | 2.2, 2.3, 4.4, 4.5, 6.13, 7.7, 7.8 |
| Resource rewrite + safe degradation | 2.4, 4.8, 6.17, 7.9 |
| Deterministic title fallback | 2.5, 6.12, 7.10 |
| Non-EPUB kind guards enforced | 4.4, 4.5, 4.6, 5, 7.13 |
| Archive safety protections enforced | 2.6, 3.1, 4.2, 4.3, 5, 6.15, 6.16, 7.14, 7.15 |

---

## 9. Unresolved Questions + Temporary Defaults (must be empty before freeze)

| question | temporary default behavior | owner | due |
|---|---|---|---|
