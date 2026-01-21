# s1_spec.md — slice 1: web article ingestion (read-only)

this slice defines **web article ingestion by url** and read-only rendering. it establishes the ingestion pipeline, persistence contracts, failure semantics, and read api surface. later slices build on these guarantees.

---

## 1) goal and scope

### goal
a user can submit a web url, wait for processing, and read a sanitized, immutable article once ingestion completes.

### in scope
- http/https url ingestion
- fetch + redirect resolution
- readability extraction
- server-side html sanitization
- canonical text generation
- fragment creation (single fragment)
- processing_status lifecycle through `ready_for_reading`
- read api for rendered content
- retry + failure semantics
- visibility enforcement via library membership

### out of scope
- highlights
- annotations
- conversations
- epub/pdf
- search
- embeddings
- dedup beyond canonical_url

---

## 2) domain model (minimum fields)

### media
represents a readable item.

| field | type | constraints |
|------|------|-------------|
| id | uuid | pk |
| kind | enum | `web_article` |
| source_url | text | original user-submitted url |
| canonical_url | text | normalized final url after redirects |
| title | text | nullable; filled by extraction/llm later |
| processing_status | enum | see §5 |
| failure_code | text | nullable |
| failure_message | text | nullable |
| failure_details_json | jsonb | nullable; internal debug only |
| processing_attempts | int | default 0 |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

notes:
- `canonical_url` is the dedup key for web articles.
- media rows are global; visibility is library-based.

### fragment
immutable render unit for html-like media.

| field | type | constraints |
|------|------|-------------|
| id | uuid | pk |
| media_id | uuid | fk → media.id |
| ordinal | int | always 0 for web_article |
| html_sanitized | text | immutable after ready_for_reading |
| canonical_text | text | immutable after ready_for_reading |
| created_at | timestamptz | not null |

invariant:
- exactly one fragment exists for a `web_article` media.

---

## 3) ingestion input contract

### accepted urls
- schemes: `http`, `https` only
- max redirects followed: 5
- redirects to non-http(s) or private ip ranges are rejected

### url normalization
- follow network redirects (3xx); ignore later JS-driven location changes
- final resolved url after redirects becomes `canonical_url`
- normalization steps:
  - strip fragment (`#...`)
  - lowercase scheme and host
  - remove default ports (`:80`/`:443`)
- query string is preserved (no heuristic stripping in v1)

### dedup rule (hard)
- if a `media` row exists with the same `canonical_url`:
  - if `processing_status` ∈ {`pending`,`extracting`}: attach media to target library and show pending
  - if `processing_status` ≥ `ready_for_reading`: attach media to target library and return immediately
  - if `processing_status = failed`: attach and allow retry on the same media row
- no duplicate media rows are created for the same canonical_url.
- enforce with a unique index: `unique(kind, canonical_url)` where `kind = web_article`.
- service logic uses insert-or-select with conflict handling to avoid duplicates.

---

## 4) processing pipeline (single job)

ingestion is executed as **a single job** per media row.

### steps
1. validate url
2. fetch url via headless browser
3. enforce fetch limits (see §9)
4. extract main content via mozilla readability
5. if no meaningful content → fail
6. sanitize html per constitution
7. rewrite links and images
8. generate canonical_text per constitution
9. persist fragment + update media status

### atomicity
- fragment row is written **only if** all steps succeed.
- fragment write + `media.processing_status = ready_for_reading` are persisted in a single db transaction.
- partial fragments are never persisted.
- status transitions may be persisted earlier as they occur.

---

## 5) processing_status state machine

### states
- `pending`
- `extracting`
- `ready_for_reading`
- `failed`

### transitions

pending → extracting → ready_for_reading
pending → failed
extracting → failed
failed → extracting (manual retry)

rules:
- `ready_for_reading` implies fragment rows exist and are immutable.
- no transition out of `ready_for_reading` in this slice.

---

## 6) failure taxonomy (stable error codes)

all failures store:
- `failure_code`
- `failure_message` (human-readable; not api-stable)

### error codes
- `E_URL_INVALID` — invalid scheme or malformed url
- `E_FETCH_FAILED` — network error, timeout, dns failure
- `E_FETCH_FORBIDDEN` — blocked by private ip / disallowed host
- `E_FETCH_UNSUPPORTED_CONTENT_TYPE` — non-html response (no readable content)
- `E_FETCH_KIND_MISMATCH_PDF` — final resource is a pdf
- `E_FETCH_KIND_MISMATCH_EPUB` — final resource is an epub
- `E_EXTRACT_NO_CONTENT` — readability produced no usable content
- `E_SANITIZE_FAILED` — sanitizer error (bug-level)
- `E_CANONICALIZE_FAILED` — canonical text generation error (bug-level)

### retry policy
- automatic retries:
  - allowed for `E_FETCH_FAILED`
  - max N attempts (configurable)
- manual retry:
  - always allowed
  - resets `processing_status = extracting`
  - deletes fragment rows (if any)
  - increments `processing_attempts`

### content-type handling
- treat as html-like if navigation succeeds and either:
  - `document.contentType` is `text/html`, OR
  - readability returns content.
- if neither, return `E_FETCH_UNSUPPORTED_CONTENT_TYPE`.
- if final resource is a pdf/epub, return the kind-mismatch error above.

---

## 7) html sanitization + rewriting (binding)

sanitization rules are inherited from the constitution and are binding here.

additional s1-specific rules:
- unknown tags are **unwrapped** (children preserved)
- unknown attributes are dropped
- `<base>` tags are removed
- `<svg>` is fully disallowed
- `<meta>`, `<link>`, `<style>` are removed entirely

### links
- relative `href` rewritten to absolute using `canonical_url`
- all `<a>` rewritten with:
  - `target="_blank"`
  - `rel="noopener noreferrer"`
  - `referrerpolicy="no-referrer"`

### images
- all `<img src>` rewritten at ingestion time to an **opaque image-proxy url**
- opaque urls are backed by a stateful mapping table:
  - `image_assets(id, media_id, origin_url, created_at)`
  - rewrite `src` to `/api/images/{id}`
- proxy enforces:
  - scheme allowlist
  - private ip blocking
  - content-type allowlist (`image/*`, excluding svg)
  - max size (10mb)
- no external `src` survives sanitization

---

## 8) canonical text generation (binding)

canonical_text is generated exactly as defined in the constitution (§7).

additional s1 rules:
- block list is exactly the constitution list
- newline rules are applied deterministically
- canonical_text is never sent to the client in v1

---

## 9) fetch hardening (security boundary)

the fetcher MUST enforce:
- block private ip ranges (ipv4 + ipv6)
- block localhost, link-local, `.local`
- block cloud metadata endpoints (e.g., `169.254.169.254`)
- block redirects to blocked ranges
- max response size (configurable; e.g. 5mb)
- max wall-clock time per fetch
- max dom size processed by readability
- user agent is explicit and fixed
- fetcher runs in a restricted network environment with egress-only access and no internal service reachability

violations return `E_FETCH_FORBIDDEN` or `E_FETCH_FAILED`.

---

## 10) library insertion semantics

### write rule
- ingestion request specifies `target_library_id`
- default is the user’s default personal library
- viewer must be `admin` of target library

### invariant
- `(library_id, media_id)` is unique
- adding media to any library MUST ensure it exists in the user’s default library (enforced by service logic)

---

## 11) api contracts (minimal)

auth is as defined in the constitution; endpoints require a verified `viewer_user_id`.

### POST /media/web-articles
create or attach a web article.

request:

{
“url”: “https://example.com/article”,
“library_id”: “uuid” // optional; defaults to user’s default library
}

responses (enveloped):
- `200`: `{ "data": { ...media } }` existing media attached (ready or pending)
- `202`: `{ "data": { ...media } }` new ingestion started
- `400`: `{ "error": { "code": "E_URL_INVALID", ... } }`
- `403`: `{ "error": { "code": "E_FORBIDDEN", ... } }`
- `401`: `{ "error": { "code": "E_UNAUTHORIZED", ... } }`

### GET /media/:id
metadata only.

returns (enveloped):

{
  "data": {
    "id": "...",
    "kind": "web_article",
    "title": "...?",
    "processing_status": "...",
    "failure_code": "...?",
    "failure_message": "...?"
  }
}

visibility:
- must enforce `can_view(viewer, media)`; return 404 on non-visible.

### GET /media/:id/fragments
returns sanitized html for reading.

returns (enveloped):

{
  "data": {
    "fragments": [
      {
        "id": "...",
        "ordinal": 0,
        "html_sanitized": ""
      }
    ]
  }
}

rules:
- allowed only if `processing_status >= ready_for_reading`
- canonical_text is never returned
- return 404 on non-visible media (no 403 for reads)

---

## 12) invariants (slice-level)

- exactly one fragment exists for a web article
- fragment.html_sanitized and fragment.canonical_text are immutable after `ready_for_reading`
- no read endpoint bypasses `can_view`
- failed ingestion never leaves partial fragment data
- retry never creates a new media id for the same canonical_url
- two users ingesting the same url converge on the same media row
- `canonical_url` uniqueness is enforced at the db level

---

## 13) acceptance scenarios

### successful ingestion
given: authenticated user  
when: POST url  
then:
- media row is created or reused
- status transitions to `ready_for_reading`
- fragment exists with sanitized html
- user can read content

### dedup attach
given: media exists and is ready  
when: another user submits same url  
then:
- no new media row
- media attached to user’s library
- content is immediately readable

### failed extraction
given: unreadable page  
when: ingestion runs  
then:
- status = `failed`
- failure_code = `E_EXTRACT_NO_CONTENT`
- user sees failed state
- retry is available

### visibility enforcement
given: media not in viewer’s libraries  
when: GET media or fragments  
then:
- request is rejected (404)

---

## 14) non-goals (explicit)

- storing raw fetched html
- client-side sanitization
- iframe rendering
- highlight creation
- semantic processing
