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
- podcasts:
  - podcast discovery via podcastindex search + rss fetch
  - subscribe/unsubscribe podcasts
  - episodes are ingested as media (audio url + transcript)
  - transcript viewing + highlighting + quote-to-chat
  - basic audio player + transcript click-to-seek
- videos:
  - youtube url ingestion
  - transcript ingestion
  - basic youtube playback embed + transcript click-to-seek
- libraries (groups) + membership + roles (member/admin)
- highlights + optional annotation (0..1) per highlight
- conversations + messages (single-user authoring; can be visible if shared)
- quote-to-chat: include quote + surrounding context + media metadata
- visibility rules enforced server-side (shared-library intersection + sharing enum)
- search (keyword + semantic) across what the user can see
- async processing via jobs (pending/failed/retry states)

### v2 (explicitly not required for v1)
- advanced players + deep media controls
- "enterprise" hardening: full local ephemeral infra parity, perf tuning, deep observability, advanced rate limiting, extensive admin tooling
- perfect migration tooling / backfills for old ingestion formats

### explicit non-scope (for all v1)
- no multi-user conversations (no mixed authors in a conversation)
- no realtime collaborative editing / cursors / live co-annotation
- no document "versioning" or "same-doc" dedup across formats (pdf+epub are separate media rows)
- no offline-first
- no browser extension
- no iframes for document rendering (render sanitized html in app dom); iframes allowed only for youtube playback embeds (allowlist)
- no untyped polymorphic link table; `message_context` is typed and limited to its allowed target types.
- no youtube channel subscriptions (explicitly out of scope v1)
- no word-level timestamps (segment/utterance-level only)
- no local audio/video uploads (external urls only)
- no first-class support for non-browser clients (cli, mobile apps); browser traffic always flows through next.js; direct fastapi usage is not a supported public API in v1

---

## 3) core abstractions (ubiquitous language)

- **user**: an account with libraries and authored social objects.
- **library**: an access-control group + a view over media. invisible unless you're a member.
- **membership**: a user's role in a library (`admin` or `member`).
- **media**: a readable item: `web_article`, `epub`, `pdf`, `podcast_episode`, or `video`.
- **podcast**: a global collection (not itself media); discovered via podcastindex or rss.
- **podcast_subscription**: user↔podcast relationship; subscribing triggers episode ingestion and auto-add to default library.
- **podcast_episode** (media): `media.kind=podcast_episode`; belongs to exactly one podcast. "episode" is shorthand in prose but the canonical term is `podcast_episode`.
- **video** (media): `media.kind=video`; from youtube with external watch url and transcript. "video" refers to the media item, not a separate object.
- **fragment**: an immutable render unit of a media item. fragments may represent:
  - a document chapter/section (epub: 1 fragment per chapter/spine item, plus toc metadata)
  - an entire article (web article: 1 fragment)
  - a transcript segment (podcast_episode, video: many fragments per media, each with timestamps)
  - pdf: fragments are not used for highlights (pdf uses overlay geometry)
- **transcript segment**: a fragment (not a separate concept) for podcast_episode/video with timestamps (`t_start_ms`, `t_end_ms`) used for transcript rendering, highlighting, and click-to-seek. transcript segments are the fragments for audio/video media.
- **highlight**: a user-owned selection in a fragment (html/epub/transcript segment) or in a pdf page geometry.
- **annotation**: optional note attached to a highlight (0..1).
- **conversation**: a thread of messages authored by exactly one user (no anchor media; visibility via shares).
- **message**: one entry in a conversation; ordered by per-conversation `seq`.
- **context**: a link from a message to an object (media/highlight/annotation/message/conversation) used as llm context.
- **conversation_share**: mapping of a conversation to one or more libraries (visibility for `sharing=library`).
- **conversation_media**: derived mapping of a conversation to media for ui placement (from message_context; does not affect visibility).
- **sharing**: visibility mode for social objects: `private` | `library` | `public`.

---

## 4) architecture

### components
- **frontend (next.js)**
  - responsive ui (mobile + desktop)
  - renders media, panes, highlights
  - route handlers (`/api/*`) act as BFF proxy to fastapi
- **api (fastapi)**
  - primary business logic, persistence, authorization, search
  - accepts requests only via bearer tokens (server-to-server from next.js)
- **db (supabase postgres + pgvector)**
  - primary datastore for all structured data + embeddings
- **storage (supabase storage)**
  - stores original epub/pdf files (private)
- **jobs (celery + redis)**
  - ingestion + extraction + chunking + embeddings + llm metadata verification
- **transcription provider (deepgram)**
  - transcription requests are processed by jobs

### request topology (hard constraint)
- browsers communicate ONLY with the next.js app (same-origin).
- browsers NEVER call fastapi directly.
- next.js route handlers (`/api/*`) act as a thin BFF proxy.
- next.js forwards authenticated requests to fastapi using `Authorization: Bearer <supabase_access_token>`.
- fastapi accepts requests ONLY via bearer tokens and never via cookies.

### api ownership (hard constraint)
- fastapi is the single source of truth for:
  - authorization
  - business logic
  - validation
  - error semantics
- next.js route handlers are transport-only:
  - authenticate session
  - attach bearer token
  - forward request/response
- next.js must not implement domain logic.

### fastapi exposure model (hard constraint)
- fastapi is designed to be secure even if publicly reachable.
- all fastapi endpoints require a valid bearer token.
- internal secret header is required in production:
  - next.js always includes a shared internal secret header (`X-Internal-Secret`).
  - fastapi rejects requests missing or mismatching this header in production.
  - this enforces that only next.js can call fastapi, even if someone has a valid supabase token.

### iframe policy (hard constraint)
- documents: never use iframes (render sanitized html in app dom).
- youtube playback: allow trusted iframes for youtube player embeds (playback only) with provider allowlist (`youtube.com`, `youtube-nocookie.com`).
- no other iframe sources are permitted.

### cors + csrf posture (hard constraint)
- browser → next.js: same-origin only.
- next.js → fastapi: server-to-server requests only.
- fastapi does NOT enable browser CORS.
- next.js enforces CSRF protection on all state-changing `/api/*` routes:
  - same-origin policy
  - `Origin` / `Referer` validation
- fastapi does NOT implement CSRF protection (bearer-token, non-browser clients only).

### jobs and background processing
- celery workers are trusted internal actors.
- jobs write directly to the database using service credentials.
- jobs prefer direct database writes for performance; they may call internal fastapi endpoints if centralization of invariants is needed later.
- fastapi reads job-written state and enforces visibility.

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
- epub extraction: fully materialized to html we render (no "reader from file")
- llm metadata verification: openai model call (exact model may change); runs as async jobs and failures never block reading
- podcasts: PodcastIndex API + rss fetch
- videos: youtube url ingestion + embed playback (no local video files)
- transcription: deepgram (primary), with fallback to non-diarized transcription if diarization fails; english-only in v1

### media hosting posture (hard constraint)
- we do not host audio or video files; we store external urls + transcripts only.

### audio playback fallback (v1 behavior)
- external podcast audio urls may fail in-browser due to cors, redirects, range request issues, or transient errors.
- if in-browser audio playback fails, show a "open in source" link to the original audio url.
- transcript reading and highlighting remain functional even if playback fails.
- no audio proxy in v1; consider adding a lightweight proxy in v2 if failure rate is high.

### video transcript failure (v1 behavior)
- youtube transcript fetch may fail due to: transcripts disabled, auto-captions only, rate limits, language mismatch.
- if transcript fetch fails but video is playable:
  - allow "playback-only" mode: video plays via embed, but highlights and quote-to-chat are disabled.
  - show "transcript unavailable" state in the transcript pane.
  - `processing_status` = `ready_for_reading` requires transcript; playback-only uses `last_error_code = E_TRANSCRIPT_UNAVAILABLE` with status `failed` but playback url still usable.
- search does not include videos without transcripts.

### rls posture (hard constraint)
- clients do not access tables via postgrest.
- rls may be enabled as defense-in-depth, but application authorization lives in fastapi.
- service-role credentials are used only server-side (fastapi/jobs), never in clients.

---

## 6) auth and identity

### authentication model (hard constraint)
- supabase auth is the sole identity provider.
- authentication state is maintained by next.js using `@supabase/ssr` session cookies.
- access tokens are NEVER stored in localStorage or sessionStorage.
- no endpoint returns access tokens to the browser; tokens exist only in server runtime.
- browser may hold tokens transiently in memory during supabase client auth flows, but never persists them.

### token flow
- browser authenticates with supabase via next.js.
- next.js reads the authenticated session server-side.
- next.js extracts the supabase access token.
- next.js forwards the token to fastapi as: `Authorization: Bearer <access_token>`.
- fastapi validates:
  - jwt signature (supabase jwks)
  - expiration
  - issuer / audience
- fastapi derives `viewer_user_id` from `sub`.

### fastapi constraints
- fastapi NEVER reads cookies.
- fastapi NEVER receives refresh tokens.
- fastapi trusts ONLY verified bearer tokens.
- no endpoint may accept a viewer id from request headers/body as authoritative.

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

### html sanitization (document content only; no iframes in documents)
- sanitization is performed server-side and persisted as `fragment.html_sanitized`; clients never render unsanitized html.
- sanitizer implementation: `bleach` with a strict allowlist.
- allowed tags/attrs are explicitly enumerated in code to preserve common article structure (text formatting, links, images, tables, code blocks) while removing active content.
- allowed protocols: `http`, `https`, `mailto`; forbid `javascript:`, `vbscript:`, `file:`, `data:`.
- sanitizer uses an explicit allowlist of tags/attrs; strips all event handlers, scripts, iframes, forms, and inline styles.
- drop all attributes starting with `on` (event handlers) even if an allowlist misconfiguration occurs.
- always remove `style` attributes; inline styles are never allowed.
- disallow all svg tags and attributes.
- disallow `base`, `meta`, and `link` tags.
- disallow `srcdoc`, `srcset`, and `xlink:href`.
- urls in `href`/`src` are validated:
  - forbid `javascript:` and `data:`.
  - normalize external links to add `rel="noopener noreferrer"` and `referrerpolicy="no-referrer"`, and force `target="_blank"`.
- ingestion rewrites relative `href`/`src` to absolute using the source url (web) or epub resource mapping (epub).
- external images are served via an image proxy endpoint that enforces allowlist + size limits (10 MB) and caching; no external `src` survives sanitization.
  - image proxy enforces `image/*` content-types (no svg), max decoded dimensions, and caches by content hash (not url).

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
8. canonical text is intentionally structure-heavy (block boundaries preserved); this favors stability over “reading-flow” text.

**highlight offsets are defined only over `fragment.canonical_text`.**

### highlight anchoring (html/epub/transcript-style)
store:
- `(fragment_id, start_offset, end_offset)`
- `exact`, `prefix`, `suffix` (stored for debugging + future repair; repair is not required in v1)
  - all three are stored in canonical text space, after canonicalization only
  - prefix/suffix length: 64 chars each
  - no extra normalization beyond canonicalization

### transcript segment canonicalization
- transcript segments store plain text only (no html).
- `fragment.canonical_text` for a transcript segment is the segment's plain text after NFC normalization and whitespace collapse (same normalization rules as html canonicalization, but no html parsing step).
- rendering: transcript text is rendered as escaped plain text (no html injection). use react text nodes or equivalent; never use `dangerouslySetInnerHTML` for transcripts.
- the only blessed use of `dangerouslySetInnerHTML` remains `fragment.html_sanitized` for document rendering.

### transcript highlight anchoring
- transcript highlights anchor to `(fragment_id, start_offset, end_offset)` where fragment is a transcript segment.
- store `t_anchor_ms` for click-to-seek, or derive from the segment's `t_start_ms`.
- minimum: reference the segment id and use its `t_start_ms` for seek target.

### transcript segment fields
- `t_start_ms`, `t_end_ms`: timestamps in milliseconds.
- optional `speaker_label` (string): speaker identification from diarization; no speaker identity resolution in v1.

### pdf highlights (separate model)
store:
- `page_number`
- one or more rectangles/quadpoints in page coordinates
- optional `exact/prefix/suffix` for debug/search support

### pdf text model (for quote-to-chat)
- `media.plain_text` is the linearized pdf text extracted by pymupdf, used for chunking and semantic search.
- pdf highlights store `exact` text at creation time, extracted from the text layer at the highlight coordinates.
- quote-to-chat uses the stored `exact` text plus nearby spans from `media.plain_text` for context.
- we do not re-extract text from coordinates at render time; stored `exact` is authoritative.
- if text extraction fails for a region, highlight creation is allowed but `exact` may be empty; quote-to-chat gracefully degrades.

---

## 8) security model and visibility

### media readability
a viewer can read a media item iff:
- the media is in at least one library the viewer is a member of

### global discovery objects (podcasts)
- podcasts are global metadata objects, not media. they are visible to all authenticated users.
- podcast search results from PodcastIndex can be returned to any authenticated user (these are discovery objects).
- podcast metadata pages (title, description, artwork) are viewable before subscribing.
- episodes are media; library readability rules apply: an episode is readable iff it is in a library the viewer is a member of.
- subscribing to a podcast auto-adds episodes to the user's default library, making them readable to that user.
- search over episodes must be visibility-filtered: only return episodes the viewer can read.
- search over podcasts can return podcasts even if none of their episodes are in the viewer's libraries (discovery is allowed).

### social object visibility (highlight/annotation/message/conversation)

**highlights + annotations**
- `sharing = public`, OR
- `sharing = private` AND viewer is the owner, OR
- `sharing = library` AND there exists a library `L` such that:
  - viewer ∈ members(L)
  - owner ∈ members(L)
  - anchor_media_id ∈ media(L)

**conversations + messages**
- `sharing = public`, OR
- `sharing = private` AND viewer is the owner, OR
- `sharing = library` AND there exists a library `L` such that:
  - `L ∈ conversation_shares(conversation_id)`
  - viewer ∈ members(L)
  - owner ∈ members(L)

notes:
- conversations are `private` by default and never become visible “by accident”.
- message visibility is identical to its conversation; message-level sharing does not exist.
- message_context and conversation_media never expand visibility; they only control placement.
- a message may reference context objects the viewer cannot see; those context links are omitted from the response for that viewer.
- non-visible context links are omitted (no tombstones).
- default sharing: conversation `private`; highlight/annotation `library`.
- setting `conversation.sharing = library` requires ≥1 `conversation_share` rows; `sharing = private` forbids `conversation_share` rows.
- `conversation_shares` libraries must include the owner (enforced at write time).

### anchoring rules (hard constraint)
- highlight is anchored to exactly one media via `fragment_id` (html/epub) or `media_id + page_number` (pdf).
- annotation is anchored to a highlight and inherits its media.
- message is anchored to its conversation for visibility (no independent sharing).
- context links do not change visibility of message/conversation objects.
- library-visibility checks use `anchor_media_id` for highlights/annotations; conversations use `conversation_shares`:
  - highlight (html/epub): `fragment.media_id`
  - highlight (pdf): `media_id`
  - annotation: inherits highlight anchor
  - conversation/message: `conversation_shares`
- `conversation_shares(conversation_id, library_id)` is required when `sharing = library` and forbidden when `sharing = private`.
- `conversation_media(conversation_id, media_id, last_message_at)` is derived from `message_context`, unique on `(conversation_id, media_id)`, and updated transactionally in v1.
- `conversation_media` contains `(conversation_id, media_id)` iff at least one `message_context` in the conversation resolves to that media and the target still exists.

### storage access
- storage buckets are private.
- clients receive only short-lived signed urls after server-side permission checks.
- fastapi and jobs are the only components allowed to mint signed storage urls.
- clients never use service-role keys and never receive them.

### content security policy (csp)
- baseline strict csp with youtube embed allowances:
  - `script-src 'self'` plus nonces for next.js inline scripts (next.js requires nonces in production for inline script hydration).
  - `frame-src https://www.youtube.com https://www.youtube-nocookie.com` (youtube embeds only).
  - `img-src 'self' https:` (external images via our proxy only; document content never uses data: urls since we proxy images).
  - `data:` in img-src is allowed only for next/image blur placeholders, not for document content (enforced by sanitizer stripping data: from document img src).
  - no `unsafe-eval`; no `unsafe-inline` for scripts (use nonces).
- next.js nonce handling: configure next.js to use CSP nonces for inline scripts; nonce is generated per-request server-side.
- prefer trusted types where supported.
- sanitization happens server-side only; clients never run sanitizer logic.
- user-generated annotations are rendered as plain text (no html).
- untrusted html rendering uses a dedicated component and never renders unsanitized input.
- frontend must never use `dangerouslySetInnerHTML` except for `fragment.html_sanitized` returned by the api, and only in that dedicated component.
- the dedicated html renderer is enforced via lint rule + codeowner review.

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
  - pdf: original file stored, page count extracted, and pdf.js can render pages. text extraction for search/quote-to-chat may still be in progress; semantic search results may be partial until embeddings complete.
  - podcast_episode/video: transcript segments exist (fragments created) + playback url exists (external). diarization may be missing; transcript is still usable.
- allowed transitions:
  - `pending` → `extracting` → `ready_for_reading` → `embedding` → `ready`
  - any → `failed`
  - `failed` → `extracting` on retry
  - `ready_for_reading` → `ready` directly if embedding is skipped
- `ready_for_reading` implies fragments are immutable thereafter.

### transcription failure modes
- distinguish "transcript failed" vs "embedding failed" in `last_error_code` conventions.
- single `processing_status` enum, but `last_error_code` provides richer error detail:
  - `E_TRANSCRIPTION_FAILED`: transcription provider returned an error.
  - `E_TRANSCRIPTION_TIMEOUT`: transcription did not complete in time.
  - `E_DIARIZATION_FAILED`: diarization failed but base transcript may still be usable (fallback to non-diarized).
  - `E_EMBEDDING_FAILED`: embedding step failed after transcript was successful.

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
- deleting a context target that was the only reason a conversation was associated to a media must remove that `(conversation_id, media_id)` from `conversation_media` transactionally.
- media rows persist in v1; users remove media from libraries.

### search
search is split into two distinct modes:

**discovery search** (podcasts only):
- search podcasts globally via PodcastIndex; available to all authenticated users.
- returns podcast metadata (not episodes) regardless of library membership.
- no visibility filtering required for podcast discovery results.

**library search** (everything else):
- search media, episodes, highlights, annotations, conversations.
- must never return objects the viewer cannot see.
- supports optional scoping (media, author, library, conversation).
- must apply the same `can_view(viewer, object)` predicate to every returned hit type.
- may over-fetch then filter, but must never return non-visible results.
- snippets are generated only after visibility filtering to avoid leakage.
- counts/facets are computed only over visibility-filtered results.
- semantic search returns only items with embeddings ready; results may be partial until embeddings complete.

### chunking + embeddings (transcripts)
- transcript chunking sizes are different from articles (smaller, time-aware).
- embed transcript content by aggregating transcript segment fragments; transcripts have no single root fragment (the "full transcript" is a derived view, not a data model primitive).
- no plan-based embedding limitation.
- exact chunk sizes are implementation details and not specified in L0.

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
- `conversation_media` is updated in the same db transaction as `message_context` inserts/deletes (no inconsistent reads).

### visibility correctness
- any endpoint that returns social objects must apply the visibility predicate.
- storage urls are issued only after the same predicate passes.
- a single canonical visibility predicate `can_view(viewer, object)` is implemented server-side and used by every endpoint and search.

### immutability
- after `ready_for_reading`, `fragment.html_sanitized` and `fragment.canonical_text` never change.
- optional derived render caches are allowed and may be recomputed; they are derived from `fragment.canonical_text`.

### podcasts
- each `podcast_episode` media belongs to exactly one podcast.
- podcast subscriptions:
  - subscribing creates `user_podcast_subscription`.
  - subscribing triggers ingestion of episodes and auto-adds ingested episodes to user's default library.
  - new episodes are periodically fetched and auto-added to default library while subscribed.
- unsubscribe options (user chooses one):
  1. stop future ingestion only (default): existing episodes remain in libraries.
  2. also remove episodes from default library only.
  3. also remove episodes from all single-member libraries (consistent with default-library closure rule).
- never remove episodes from shared libraries without explicit per-library action (protects shared contexts).

### transcript segments
- transcript segment fragments have:
  - `t_start_ms < t_end_ms`
  - `(media_id, idx)` is unique; `idx` is a stable integer ordering key assigned at ingestion.
  - display order is `(t_start_ms, idx)` to handle overlapping segments deterministically.
  - overlaps are allowed (diarized utterances may overlap when speakers interrupt); UI uses `t_start_ms` for click-to-seek.
- transcript fragments obey the same immutability law after `ready_for_reading`.

### videos
- video media has exactly one external watch url and provider id (youtube).
- we never store the video file.

---

## 12) ui contract (minimal but binding)

- ui is intentionally plain: basic html, minimal styling.
- layout primitives:
  - collapsible left navbar
  - tabsbar at top for pane management
  - horizontal, resizable panes that can overflow off-screen (horizontal scroll)
  - footer player bar for audio/video (v1-required, basic): play/pause, jump back/forward, next/prev (episode), and open pane
- opening a media creates two panes:
  - content pane (left)
  - linked-items pane (right)
- linked-items must remain vertically aligned with their highlight targets.
- a conversation is listed in a media's linked-items pane iff `conversation_media` contains `(conversation_id, media_id)` and the viewer can view the conversation.
- podcast episode pane and video pane are "media panes" whose content is the transcript view plus player (audio controls or youtube embed).
- clicking a transcript segment seeks the player to that segment's `t_start_ms`.

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
- document iframe ban policy (documents must never use iframes)
- youtube embed allowlist policy (adding/removing allowed embed domains)
- single-author conversation constraint
- generic links scope
- transcript segmentation/immutability rules
- subscription auto-add semantics
- request topology (BFF vs direct api)
- auth token flow or storage location
- fastapi exposure model
- allowing browsers to call fastapi directly
- supporting non-browser clients as a public API
