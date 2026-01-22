# Slice 2 — Web Articles + Highlights (L2 Spec)

This slice ships the first complete reading and highlighting experience for Nexus.
It introduces URL-based ingestion, sanitization, canonicalization, and overlapping highlights.

This spec is binding and must conform to the Nexus constitution (L0) and the L1 roadmap.

---

## 1. Goal

Enable users to:
- Ingest a web article by URL
- Read sanitized HTML rendered in-app (no iframes)
- Create overlapping highlights on stable text
- Optionally annotate highlights
- See highlights in a linked-items pane aligned with the text

This slice establishes the canonical text + offset model used by all later media kinds.

---

## 2. Non-Goals

This slice explicitly does NOT include:
- Conversations or chat
- Library sharing
- PDFs, EPUBs, transcripts
- Semantic search
- Summarization
- Public sharing
- Browser extensions
- Author extraction and storage (deferred to S3 — requires `authors` + `media_authors` pivot tables)

---

## 3. Data Model Additions

### 3.1 Highlights

```sql
CREATE TABLE highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fragment_id UUID NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  color TEXT NOT NULL,
  exact TEXT NOT NULL,
  prefix TEXT NOT NULL,
  suffix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_offsets_valid
    CHECK (start_offset >= 0 AND end_offset > start_offset)
);

CREATE UNIQUE INDEX uix_highlights_user_fragment_offsets
  ON highlights (user_id, fragment_id, start_offset, end_offset);
```

**Semantics**
- Offsets are half-open `[start_offset, end_offset)` in unicode codepoints over `fragment.canonical_text`
- Overlapping highlights are allowed
- Duplicate highlights at the exact same span by the same user are forbidden

---

### 3.2 Annotations

```sql
CREATE TABLE annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uix_annotations_one_per_highlight UNIQUE (highlight_id)
);
```

**Semantics**
- An annotation is optional and strictly 0..1 per highlight
- Deleting a highlight deletes its annotation
- Deleting an annotation leaves the highlight intact

---

## 4. Web Article Ingestion

### 4.1 Endpoint

```
POST /media/from_url
```

**Request**

```json
{ "url": "https://example.com/article" }
```

**Response:** `201 Created` (new) or `200 OK` (duplicate)

```json
{
  "media_id": "<uuid>",
  "duplicate": true | false,
  "processing_status": "pending" | "ready_for_reading",
  "ingest_enqueued": true | false
}
```

**Notes:**
- `processing_status` reflects the current state at response time (usually `pending` for new items)
- `ingest_enqueued` is `true` when a job was dispatched (new items), `false` for duplicates already processed
- `extracting` is an internal state; clients should poll `GET /media/{id}` for status updates

---

### 4.2 Canonical URL Rules

- **requested_url**: exactly what the user submitted
- **canonical_url**:
  - Final URL after redirects
  - Lowercase scheme + host
  - Fragment (`#...`) stripped
  - Query params preserved (no heuristic stripping in v1)

**Dedup Behavior**

- If `(kind=web_article, canonical_url)` exists:
  - Reuse the media row
  - Ensure the media is added to the user's default library
  - Return `duplicate = true`
- If not:
  - Create media row
  - Add to default library
  - Begin ingestion

**Placeholder Title**

Media `title` is `NOT NULL`. At creation time before extraction completes:
- Set `title` to truncated `requested_url` (max 255 chars) or `"Untitled"`
- Ingestion updates `title` from extracted `<title>` or `og:title` when `ready_for_reading`

---

### 4.3 Ingestion Execution Model

Ingestion logic is implemented as a pure service function:

```python
ingest_web_article(media_id)
```

**Execution modes:**
- **tests/dev**: synchronous call
- **prod**: Celery task wrapper calls the same function

Processing state transitions must be identical in all modes.

---

### 4.4 State Transitions + Failure Handling

**Processing States:**

| State | Description |
|-------|-------------|
| `pending` | Created, awaiting ingestion |
| `extracting` | Fetch/parse in progress (internal) |
| `ready_for_reading` | Successfully processed |
| `failed` | Terminal failure |

**Failure Mapping:**

| Failure Scenario | `processing_status` | `failure_stage` | `last_error_code` |
|------------------|---------------------|-----------------|-------------------|
| Playwright fetch fails | `failed` | `extract` | `E_INGEST_FAILED` |
| Fetch timeout | `failed` | `extract` | `E_INGEST_TIMEOUT` |
| Sanitizer throws | `failed` | `extract` | `E_SANITIZATION_FAILED` |
| Canonicalization fails | `failed` | `extract` | `E_SANITIZATION_FAILED` |

**Retry Semantics:**

Manual retry via `POST /media/{id}/retry`:
1. Delete existing fragments (if any)
2. Set `processing_status = pending`
3. Increment `attempts` counter
4. Clear `last_error_code` and `failure_stage`
5. Re-enqueue ingestion job

**Retry limits:** Max 3 attempts. After that, manual intervention required.

---

## 5. Extraction + Sanitization

### 5.1 Extraction Pipeline

1. Fetch page using Playwright (Chromium, JS enabled)
2. Capture final DOM HTML
3. Run Mozilla Readability on the DOM
4. Produce extracted HTML body

Raw HTML is not persisted in v1.

---

### 5.2 HTML Sanitization

Sanitization runs server-side and the output is persisted as `fragment.html_sanitized`.

**Allowed tags**

```
p, br,
strong, em, b, i, u, s,
blockquote,
pre, code,
ul, ol, li,
h1, h2, h3, h4, h5, h6,
hr,
a,
img,
table, thead, tbody, tr, th, td,
sup, sub
```

**Allowed attributes**

| Tag | Attributes |
|-----|------------|
| `a` | `href`, `title` |
| `img` | `src`, `alt` |
| `th`, `td` | `colspan`, `rowspan` |

**Hard rules**

- Strip all `style`, `class`, `id`
- Strip all `on*` event handlers
- Disallow `script`, `iframe`, `form`, `svg`, `meta`, `link`, `base`
- Disallow `javascript:`, `data:` URLs
- Rewrite all `<img src>` to go through the image proxy
- External links:
  - Ensure `rel` **includes** `noopener` and `noreferrer` (merge with existing values)
  - Set `target="_blank"`
  - Set `referrerpolicy="no-referrer"`

---

### 5.3 Image Proxy

**Route:** `GET /media/image?url=<encoded>`

**Host:** FastAPI backend (shares validation code with ingestion)

**SSRF Protection (Critical):**

| Rule | Description |
|------|-------------|
| Protocol | Only `http://` and `https://` allowed |
| Ports | Only 80 and 443 allowed |
| Private IPs | Block after DNS resolution: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fe80::/10` |
| Redirects | Follow up to 3 hops; re-validate each hop against all rules |
| DNS rebinding | Resolve DNS once, use resolved IP for connection |

**Content Validation:**
- `Content-Type` must start with `image/`
- SVG explicitly rejected (`image/svg+xml`)
- Max bytes: 10 MB
- Max decoded dimensions: 4096x4096
- Cache key: SHA256 of content bytes

**Error Responses:**
- `400` — Invalid URL, blocked protocol/port
- `403` — SSRF violation (private IP, blocked host)
- `502` — Upstream fetch failed
- `504` — Upstream timeout

---

## 6. Canonical Text Generation

Each web article produces exactly one fragment:
- `fragment.idx = 0`
- `fragment.canonical_text` generated from `html_sanitized`

**Canonicalization Rules**

1. Walk text nodes in document order
2. Normalize:
   - Unicode NFC
   - All whitespace → space
   - Collapse consecutive spaces
3. Block boundaries insert `\n`:
   - `p`, `li`, `ul`, `ol`, `h1`..`h6`, `blockquote`, `pre`, `div`, `section`, `article`, `header`, `footer`, `nav`, `aside`
4. `<br>` inserts `\n`
5. Trim lines; collapse multiple blank lines
6. Exclude:
   - `script`, `style`
   - Nodes with `hidden` or `aria-hidden="true"`

**Immutability**

After `ready_for_reading`, `html_sanitized` and `canonical_text` never change.

---

## 7. Highlight + Annotation API

### 7.1 Offset Mapping

Frontend must:
- Build a deterministic mapping from DOM text nodes → absolute offsets in `canonical_text`
- Compute `(start_offset, end_offset)` from user selection using codepoint-safe iteration (see §7.7)
- Reject selections intersecting `<pre>` or `<code>`
- Apply the same canonicalization rules (block boundaries, `<br>` newlines) as the server to ensure offset alignment

---

### 7.2 Create Highlight

```
POST /fragments/{fragment_id}/highlights
```

**Request:**

```json
{
  "start_offset": 120,
  "end_offset": 145,
  "color": "yellow",
  "exact": "the highlighted text",
  "prefix": "context before ",
  "suffix": " context after"
}
```

**Response:** `201 Created`

```json
{
  "id": "<uuid>",
  "fragment_id": "<uuid>",
  "start_offset": 120,
  "end_offset": 145,
  "color": "yellow",
  "exact": "the highlighted text",
  "prefix": "context before ",
  "suffix": " context after",
  "created_at": "...",
  "updated_at": "...",
  "annotation": null
}
```

**Validation:**
- `start_offset >= 0`
- `end_offset > start_offset`
- `end_offset <= len(fragment.canonical_text)` (service-level)
- `color` must be one of: `yellow`, `green`, `blue`, `pink`, `purple`
- `exact` must equal `canonical_text[start_offset:end_offset]`

---

### 7.3 List Highlights

```
GET /fragments/{fragment_id}/highlights
```

**Response:** `200 OK`

Returns all highlights owned by the authenticated user for the given fragment.

```json
{
  "highlights": [
    {
      "id": "<uuid>",
      "fragment_id": "<uuid>",
      "start_offset": 120,
      "end_offset": 145,
      "color": "yellow",
      "exact": "...",
      "prefix": "...",
      "suffix": "...",
      "created_at": "...",
      "updated_at": "...",
      "annotation": { "id": "...", "body": "..." } | null
    }
  ]
}
```

---

### 7.4 Get Highlight

```
GET /highlights/{highlight_id}
```

**Response:** `200 OK` — same shape as list item, including annotation if present.

---

### 7.5 Update Highlight

```
PATCH /highlights/{highlight_id}
```

**Request:** (all fields optional)

```json
{
  "start_offset": 121,
  "end_offset": 146,
  "color": "green",
  "exact": "...",
  "prefix": "...",
  "suffix": "..."
}
```

**Response:** `200 OK` — updated highlight object.

**Rules:**
- If offsets change, `exact`/`prefix`/`suffix` must also be provided
- Uniqueness constraint re-validated on update
- No drag handles in v1; user reselects span

---

### 7.6 Delete Highlight

```
DELETE /highlights/{highlight_id}
```

**Response:** `204 No Content`

Deleting a highlight cascades to delete its annotation.

---

### 7.7 Codepoint-Safe Offset Handling

**Problem:** JavaScript string indexing uses UTF-16 code units; Python uses Unicode codepoints. Emojis and astral characters cause index drift.

**Specification:**
- Offsets are defined as **Unicode codepoint indices** into `fragment.canonical_text`
- Frontend must compute offsets using codepoint-safe iteration:
  ```js
  // Convert UTF-16 string index to codepoint offset
  const toCodepointOffset = (str, utf16Index) =>
    [...str.slice(0, utf16Index)].length;
  ```
- At least one test must include astral characters (e.g., emoji) to verify offset stability

---

### 7.8 Prefix/Suffix Length Rules

- `prefix`: the `min(64, start_offset)` codepoints immediately before `start_offset`
- `suffix`: the `min(64, len(canonical_text) - end_offset)` codepoints immediately after `end_offset`
- Both fields are **NOT NULL** but may be shorter than 64 chars at document boundaries
- Server validates that provided prefix/suffix match the canonical text at those positions

---

## 7A. Annotation API

Annotations have a 0..1 relationship with highlights. Use **PUT for upsert** semantics.

### 7A.1 Create or Update Annotation

```
PUT /highlights/{highlight_id}/annotation
```

**Request:**

```json
{ "body": "My note about this highlight" }
```

**Response:**
- `201 Created` if new annotation
- `200 OK` if updated existing

```json
{
  "id": "<uuid>",
  "highlight_id": "<uuid>",
  "body": "My note about this highlight",
  "created_at": "...",
  "updated_at": "..."
}
```

---

### 7A.2 Delete Annotation

```
DELETE /highlights/{highlight_id}/annotation
```

**Response:** `204 No Content`

Deleting an annotation leaves the highlight intact.

---

## 8. Overlapping Highlight Rendering

### 8.1 Segmentation Model

- Collect all highlight boundary events
- Split text into disjoint segments
- Each segment carries a set of active highlight IDs

---

### 8.2 Visual Policy

- Background color = highlight with latest `created_at`
- Overlaps are not striped in v1
- Hover shows all overlapping highlights
- Delete/edit acts on the focused highlight

This policy must be deterministic and testable.

---

## 9. Visibility Rules (Slice 2)

A highlight or annotation is visible iff:
- Viewer is the owner (`user_id`)
- AND viewer can read the media containing the fragment

There is no sharing in S2.

---

## 10. UI Requirements

- Content pane renders sanitized HTML only
- Linked-items pane lists highlights aligned vertically
- Highlight selection + rendering works with overlapping spans
- Colors are from a fixed palette (defined in frontend constants)

---

## 11. Error Handling

Use existing error envelope.

**New error codes introduced in S2:**

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `E_INGEST_FAILED` | 502 | Upstream fetch failed |
| `E_INGEST_TIMEOUT` | 504 | Upstream fetch timed out |
| `E_SANITIZATION_FAILED` | 500 | Sanitization/canonicalization error |
| `E_HIGHLIGHT_INVALID_RANGE` | 400 | Invalid offset range (out of bounds, end <= start) |

**Notes:**
- Use existing `E_INVALID_REQUEST` (400) for malformed payloads to avoid code explosion
- Errors must not leak media existence across permission boundaries (return 404 for unauthorized access)

---

## 12. Tests (Acceptance)

### Security Fixtures
- Script injection removed
- `javascript:` URLs stripped
- Inline styles stripped
- SVG images rejected
- Images rewritten to proxy

### Highlight Tests
- Overlapping highlights render deterministically
- Offset math stable across reload
- Edit preserves identity
- Delete cascades annotation

### Integration
- URL ingest creates media + fragment
- Dedup returns existing media
- Media added to default library
- Non-member receives 404
- Processing-state suite passes
- Visibility suite passes

---

## 13. Done Definition

Slice 2 is complete when:
- A real web article can be ingested, read, highlighted, and annotated
- Highlights survive reloads without drift
- Overlapping highlights behave deterministically
- All security and visibility tests pass
- Ingestion uses the same service function in all environments; only the execution wrapper (sync vs Celery) differs
