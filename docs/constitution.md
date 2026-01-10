# nexus constitution.md (v1)

this is the l0 “constitution” for nexus. it defines the irreversible decisions, system boundaries, core abstractions, and invariants. everything below (roadmap, slice specs, pr specs, code) must conform.

---

## 1) vision

### problem
people read across articles, books, papers, podcasts, and videos, but their thinking is scattered: highlights live in one app, notes in another, and “chat with context” is brittle and non-shareable.

### solution
nexus is a responsive web app for ingesting documents, reading them in a clean pane-based ui, highlighting/annotating passages, and chatting with llms using quoted context — with library-based sharing so teams can see each other’s work on shared media.

---

## 2) scope and non-scope

### v1 (must ship)
- media ingestion + reading:
  - web articles by url (headless browser → mozilla readability)
  - epubs uploaded or via url (fully extracted into html rendered by us)
  - pdfs uploaded or via url (processed by pymupdf; rendered via pdf.js)
- libraries (groups) + membership + roles (member/admin)
- highlights + optional annotation (0..1) per highlight
- conversations + messages (single-user authoring; can be visible if shared)
- quote-to-chat: include quote + surrounding context + media metadata
- visibility rules enforced server-side (shared-library intersection + sharing enum)
- search (keyword + semantic) across what the user can see
- async processing via jobs (pending/failed/retry states)

### v2 (explicitly not required for v1)
- podcasts (subscription, episodes, transcript highlights)
- videos (transcription, timestamps, highlightable transcript)
- advanced players + deep media controls

### v3 (explicitly not required for v1)
- “enterprise” hardening: full local ephemeral infra parity, perf tuning, deep observability, advanced rate limiting, extensive admin tooling
- perfect migration tooling / backfills for old ingestion formats

### explicit non-scope (for all v1)
- no multi-user conversations (no mixed authors in a conversation)
- no realtime collaborative editing / cursors / live co-annotation
- no document “versioning” or “same-doc” dedup across formats (pdf+epub are separate media rows)
- no offline-first
- no browser extension
- no iframes (render sanitized html in app dom)
- no untyped polymorphic link table; `message_context` is typed and limited to its allowed target types.

---

## 3) core abstractions (ubiquitous language)

- **user**: an account with libraries and authored social objects.
- **library**: an access-control group + a view over media. invisible unless you’re a member.
- **membership**: a user’s role in a library (`admin` or `member`).
- **media**: a readable item: `web_article`, `epub`, or `pdf`.
- **fragment**: an immutable render unit of a media item.
  - web article: 1 fragment
  - epub: 1 fragment per chapter/spine item (plus toc metadata)
  - pdf: fragments are not used for highlights (pdf uses overlay geometry)
- **highlight**: a user-owned selection in a fragment (html/epub) or in a pdf page geometry.
- **annotation**: optional note attached to a highlight (0..1).
- **conversation**: a thread of messages authored by exactly one user.
- **message**: one entry in a conversation; ordered by per-conversation `seq`.
- **context**: a link from a message to an object (media/highlight/annotation/message/conversation) used as llm context.
- **sharing**: visibility mode for social objects: `private` | `library` | `public`.

---

## 4) architecture

### components
- **frontend (next.js)**
  - responsive ui (mobile + desktop)
  - renders media, panes, highlights
  - calls the public api directly with a session cookie (or bearer token for non-browser clients)
- **api (fastapi)**
  - primary business logic, persistence, authorization, search
  - public http api; all endpoints authenticate + authorize every request
- **db (supabase postgres + pgvector)**
  - primary datastore for all structured data + embeddings
- **storage (supabase storage)**
  - stores original epub/pdf files (private)
- **jobs (celery + redis)**
  - ingestion + extraction + chunking + embeddings + llm metadata verification

### request topology (hard constraint)
- browsers call **fastapi** directly for all app data operations.
- frontend is untrusted; fastapi enforces all authorization; frontend may do SSR/CSR but is not a trust boundary.
- fastapi is the source of truth and must enforce authorization for every request.

### api authentication (hard constraint)
- browser requests to fastapi MUST include a verified httpOnly secure session cookie.
- fastapi verifies token signature + claims and derives `viewer_user_id` from the token (`sub`).
- fastapi never trusts user identity passed via custom headers from clients.

---

## 5) hard technology constraints

- frontend: next.js
- backend: fastapi (python)
- db: supabase postgres + pgvector
- jobs: celery + redis
- storage: supabase storage (private objects, signed urls only)
- pdf rendering: pdf.js
- pdf extraction: pymupdf
- web article extraction: headless browser + mozilla readability
- epub extraction: fully materialized to html we render (no “reader from file”)
- llm metadata verification: openai model call (exact model may change); runs as async jobs and failures never block reading

### rls posture (hard constraint)
- clients do not access tables via postgrest.
- rls may be enabled as defense-in-depth, but application authorization lives in fastapi.
- service-role credentials are used only server-side (fastapi/jobs), never in clients.

---

## 6) auth and identity

### auth system
- supabase auth (gotrue) is the identity provider.
- browser auth uses httpOnly secure cookies for session (issued by our domain).
- cookie names:
  - `sb-access-token` (short-lived access token jwt)
  - `sb-refresh-token` (longer-lived refresh token)
- next.js auth routes set/refresh cookies server-side; the browser never reads tokens.
- `Authorization: Bearer <access_token>` is optional for non-browser clients only.
  - non-browser clients obtain an access token from supabase auth and send it via `Authorization`.
  - cookie and bearer tokens are the same jwt type and validated identically; if both are present, bearer takes precedence.

### token verification (hard constraint)
- fastapi MUST verify the access token on every request (signature + expiry).
- `viewer_user_id` is derived from the verified token subject (`sub`).
- no endpoint may accept a viewer id from request headers/body as authoritative.
- access tokens must never be stored in localstorage/sessionstorage.
- fastapi accepts access tokens only; refresh tokens are never read by fastapi.
- when access expires, the browser calls a next.js `/auth/refresh` route to refresh cookies, then retries the request.

### identity mapping
- `user.id` is a uuid in our postgres `users` table.
- `users.id` MUST equal the supabase auth user id (`sub`) for that user.
- user row is created on first login (or via webhook/job); duplicates are forbidden.

---

## 7) data immutability + canonicalization (highlights depend on this)

### immutability law
after ingestion completes:
- `fragment.html_sanitized` is immutable.
- `fragment.canonical_text` is immutable.
- we do **not** regenerate these fields in-place, ever.

if ingestion logic changes and we want “new output”, that is a *new media row* (not v1-required).

### html sanitization (no iframes means no exceptions)
- sanitization is performed server-side and persisted as `fragment.html_sanitized`; clients never render unsanitized html.
- sanitizer implementation: `bleach` with a strict allowlist.
- allowed tags/attrs are explicitly enumerated in code to preserve common article structure (text formatting, links, images, tables, code blocks) while removing active content.
- allowed protocols: `http`, `https`, `mailto`; forbid `javascript:`, `vbscript:`, `file:`, `data:`.
- sanitizer uses an explicit allowlist of tags/attrs; strips all event handlers, scripts, iframes, forms, and inline styles.
- drop all attributes starting with `on` (event handlers) even if an allowlist misconfiguration occurs.
- always remove `style` attributes; inline styles are never allowed.
- disallow `srcdoc`, `srcset`, and `xlink:href`.
- urls in `href`/`src` are validated:
  - forbid `javascript:` and `data:`.
  - normalize external links to add `rel="noopener noreferrer"` and `referrerpolicy="no-referrer"`, and force `target="_blank"`.
- ingestion rewrites relative `href`/`src` to absolute using the source url (web) or epub resource mapping (epub).
- external images are served via an image proxy endpoint that enforces allowlist + size limits (10 MB) and caching; no external `src` survives sanitization.

### canonical text definition (html/epub/transcripts that behave like html)
`fragment.canonical_text` is produced by:
1. parsing `fragment.html_sanitized`
2. walking text nodes in document order with explicit block boundaries
3. normalizing:
   - unicode normalization: **nfc**
   - whitespace: map all unicode whitespace (including `&nbsp;`) to `' '`
   - inside a block, collapse consecutive spaces to a single space
   - insert `\n` between block boundaries and between list items
   - `br` inserts `\n`
   - trim each line and collapse multiple blank lines to a single blank line
4. exclusions:
   - never include text from script/style
   - never include hidden elements (defined syntactically as `hidden` attribute or `aria-hidden="true"`; css-based visibility is not detected server-side)
5. block definition (minimum): `p`, `li`, `ul`, `ol`, `h1..h6`, `blockquote`, `pre`, `div`, `section`, `article`, `header`, `footer`, `nav`, `aside`
6. `pre` and `code` highlighting: not supported in v1 (whitespace is normalized as above).
7. `pre`/`code` text nodes are included in `fragment.canonical_text`, but highlight creation is disallowed when a selection intersects `pre`/`code`.

**highlight offsets are defined only over `fragment.canonical_text`.**

### highlight anchoring (html/epub/transcript-style)
store:
- `(fragment_id, start_offset, end_offset)`
- `exact`, `prefix`, `suffix` (stored for debugging + future repair; repair is not required in v1)
  - all three are stored in canonical text space, after canonicalization only
  - prefix/suffix length: 64 chars each
  - no extra normalization beyond canonicalization

### pdf highlights (separate model)
store:
- `page_number`
- one or more rectangles/quadpoints in page coordinates
- optional `exact/prefix/suffix` for debug/search support

---

## 8) security model and visibility

### media readability
a viewer can read a media item iff:
- the media is in at least one library the viewer is a member of

### social object visibility (highlight/annotation/message/conversation)
a viewer can see a social object iff:
- sharing = `public`, OR
- sharing = `private` AND viewer is the owner, OR
- sharing = `library` AND:
  - there exists a library `L` such that:
    - viewer ∈ members(L)
    - owner ∈ members(L)
    - anchor_media_id ∈ media(L)

notes:
- conversations are `private` by default and never become visible “by accident”.
- every conversation has a `root_media_id` (or `root_fragment_id` for html/epub) set at creation.
- if sharing = `library`, `anchor_media_id` must exist and is the referenced media for visibility checks.
- conversation visibility depends only on conversation sharing + root media intersection rule.
- message visibility is identical to its conversation; message-level sharing does not exist.
- a message may reference context objects the viewer cannot see; those context links are omitted from the response for that viewer.
- messages inherit conversation visibility (a visible conversation implies all its messages are visible).
- default sharing: conversation `private`; highlight/annotation `library`.
- `conversation.root_media_id` may be null only for private conversations.

### anchoring rules (hard constraint)
- highlight is anchored to exactly one media via `fragment_id` (html/epub) or `media_id + page_number` (pdf).
- annotation is anchored to a highlight and inherits its media.
- message is anchored to its conversation and inherits `root_media_id` for library visibility.
- context links do not change visibility of message/conversation objects.
- every social object has an effective `anchor_media_id`; all library-visibility checks are computed against that id:
  - highlight (html/epub): `fragment.media_id`
  - highlight (pdf): `media_id`
  - annotation: inherits highlight anchor
  - conversation/message: `root_media_id`

### storage access
- storage buckets are private.
- clients receive only short-lived signed urls after server-side permission checks.
- fastapi and jobs are the only components allowed to mint signed storage urls.
- clients never use service-role keys and never receive them.

### content security policy (csp)
- use a strict csp: `script-src 'self'` with no inline scripts and no `unsafe-eval`.
- prefer trusted types where supported.
- sanitization happens server-side only; clients never run sanitizer logic.
- user-generated annotations are rendered as plain text (no html).
- untrusted html rendering uses a dedicated component and never renders unsanitized input.
- frontend must never use `dangerouslySetInnerHTML` except for `fragment.html_sanitized` returned by the api, and only in that dedicated component.

---

## 9) processing states (media lifecycle)

media has a single `processing_status` enum + timestamps.
minimum statuses:
- `pending` (created, waiting for jobs)
- `extracting`
- `ready_for_reading` (html_sanitized + canonical_text stored; user can read + highlight)
- `embedding` (chunks/embeddings running)
- `ready` (all processing complete)
- `failed` (with `failure_reason`)
additional tracking:
- `processing_attempts`, `last_error_code`, `last_error_message`, `failed_at`

rules:
- user may read/highlight only when status >= `ready_for_reading`.
- on retry: delete partial chunks/embeddings and restart from a defined earlier state.
- retry policy: max N automatic retries with exponential backoff; manual retry resets state and deletes chunks.
- `ready_for_reading` means per-kind minimums are satisfied:
  - web_article/epub: `fragment.html_sanitized` + `fragment.canonical_text` exist.
  - pdf: original file stored, page count extracted, and pdf.js can render pages.
- allowed transitions:
  - `pending` → `extracting` → `ready_for_reading` → `embedding` → `ready`
  - any → `failed`
  - `failed` → `extracting` on retry
  - `ready_for_reading` → `ready` directly if embedding is skipped
- `ready_for_reading` implies fragments are immutable thereafter.

---

## 10) conventions

### ids, timestamps, ordering
- primary keys: uuid v4
- timestamps: `timestamptz`
- message order: `(conversation_id, seq)` where `seq` is a strict increasing integer assigned in the db

### errors
- every api failure has a stable `error_code` (format: `E_CATEGORY_NAME`) and a human `message`.
- do not leak existence across authorization boundaries (prefer 404 over 403 where it matters).
  - error envelope: `{ "error": { "code": "...", "message": "...", "details": ...? } }`
  - success envelope: `{ "data": ... }`
  - `details` is optional and not stable for client contracts (debug only).

### pagination + search responses
- pagination uses cursor: request `limit` + `cursor`; response includes `{ "data": [...], "page": { "next_cursor": "...", "has_more": true } }`.
- search responses return typed results in `data` with at least `{ "type": "...", "id": "..." }`; optional fields include `score` and `snippet`.

### deletion
- hard delete social objects.
- deleting a highlight deletes its annotation (if present).
- deleting an annotation leaves the highlight.
- deleting a message deletes its context links; if it was the last message, delete the conversation.
- media rows persist in v1; users remove media from libraries.

### search
- search must never return objects the viewer cannot see.
- search supports optional scoping (media, author, library, conversation).
- search must apply the same `can_view(viewer, object)` predicate to every returned hit type.
- search may over-fetch then filter, but must never return non-visible results.
- snippets are generated only after visibility filtering to avoid leakage.
- search counts/facets are computed only over visibility-filtered results.

---

## 11) system invariants (laws of physics)

### libraries
- each user has exactly one default personal library:
  - cannot be shared
  - cannot be deleted
  - owner is an `admin` member
- `(library_id, media_id)` is unique.
- default library membership closure:
  - if `(user u is member of library l) AND (l contains media m)`, ensure default library `d(u)` also contains `m`.
  - removing `m` from `d(u)` removes `m` from any library where `u` is the only member.
  - enforced transactionally in service-layer logic on library_media insert/delete; no db triggers in v1.
- roles:
  - only admins can mutate library name, membership/roles, or library_media membership.
  - members are read-only.

### authors
- authors are global.
- `(media_id, author_id)` is unique.
- no author dedup in v1 beyond id uniqueness.

### highlights + annotations
- highlight uniqueness: at most one highlight for `(user_id, fragment_id, start_offset, end_offset)`.
- overlapping highlights are allowed.
- highlight has 0..1 annotation; annotation belongs to exactly one highlight.

### conversations + messages
- a conversation belongs to exactly one user (the author).
- a conversation never contains messages from multiple users.
- a message belongs to exactly one conversation.
- messages have strict order by `seq` (no reliance on timestamp ordering).
- a conversation always has `root_media_id` (or `root_fragment_id`), set at creation.

### visibility correctness
- any endpoint that returns social objects must apply the visibility predicate.
- storage urls are issued only after the same predicate passes.
- a single canonical visibility predicate `can_view(viewer, object)` is implemented server-side and used by every endpoint and search.

### immutability
- after `ready_for_reading`, `fragment.html_sanitized` and `fragment.canonical_text` never change.
- optional derived render caches are allowed and may be recomputed; they are derived from `fragment.canonical_text`.

---

## 12) ui contract (minimal but binding)

- ui is intentionally plain: basic html, minimal styling.
- layout primitives:
  - collapsible left navbar
  - tabsbar at top for pane management
  - horizontal, resizable panes that can overflow off-screen (horizontal scroll)
  - footer player bar for audio/video (v2+), but the bar shell may exist in v1
- opening a media creates two panes:
  - content pane (left)
  - linked-items pane (right)
- linked-items must remain vertically aligned with their highlight targets.

---

## 13) billing constraints (subject to change, but enforced)
- server-side plan gates exist; exact limits and pricing are product-configurable and not part of L0.

---

## 14) what changes require amending this constitution
changing any of the following is a constitution change:
- immutability contract for fragments
- canonicalization definition for offsets
- visibility rules and sharing semantics
- storage privacy model
- “no iframes” constraint
- single-author conversation constraint
- generic links scope
