# slice_roadmap.md — nexus v1

this document defines the **delivery order** of nexus. each slice is a vertical, user-visible increment. slices form a DAG; later slices assume earlier ones are complete.

non-goal: this document does NOT define full schemas, APIs, or code structure.

---

## slice 0 — foundation: auth, libraries, visibility

**goal**
a real user can log in, has a default library, and the system enforces visibility correctly.

**outcome**
- users can authenticate
- every request has a verified `viewer_user_id`
- libraries exist with membership + roles
- a single canonical `can_view(viewer, object)` predicate exists and is enforced
- a canonical `visible_media_ids(viewer)` primitive exists and is used by all reads

**includes**
- supabase auth integration
- user bootstrap on first login
- default personal library creation
- library + membership model (admin/member)
- server-side visibility enforcement (no leaks)
- minimal schema:
  - users, libraries, library_users, media, library_media
  - highlight stub fields: `owner_user_id`, `sharing`, `anchor_media_id`
  - anchoring rule: highlights are anchored by `anchor_media_id` used by `can_view`
- `visible_media_ids(viewer)` helper (query/cte/view) used by all read paths
- one real read endpoint for social objects:
  - list visible highlights for a media id (even if highlight creation is not implemented)

**excludes**
- media ingestion
- reading UI
- highlights
- conversations
- search

**acceptance**
- unauthenticated request → rejected
- authenticated user sees only their own default library
- user cannot see any object they do not own or share a library with
- 2–3 integration tests prove “no cross-library leak” on highlights via the real read endpoint
- `can_view` and `visible_media_ids` are used by all existing read paths
- `can_view` supports the shared-library intersection rule even before sharing UI exists

**dependencies**
- none

---

## slice 1 — ingestion skeleton: web articles (read-only)

**goal**
a user can add a web article by url and read it once processing completes.

**outcome**
- ingestion jobs exist
- web article → sanitized html → canonical text → readable pane

**includes**
- headless browser fetch
- mozilla readability extraction
- server-side html sanitization
- fragment creation (single fragment)
- processing_status lifecycle up to `ready_for_reading`
- read-only content pane

**excludes**
- highlights
- annotations
- conversations
- epub/pdf
- search

**acceptance**
- user submits url → sees `pending`
- job completes → media becomes readable
- html is rendered (sanitized) in content pane
- canonical_text exists and conforms to the constitution canonicalization spec
- user cannot read media not in a library they belong to
- failed job transitions to `failed` with a typed error and visible UI state
- manual retry resets state and re-runs extraction

**dependencies**
- slice 0

---

## slice 2 — read ui skeleton + pane model

**goal**
core reading layout is real and stable enough to support alignment and highlights.

**outcome**
- pane/tab state machine exists and is predictable

**includes**
- panes/tabsbar/nav state machine
- opening media creates (content pane, linked-items pane)
- open singleton list panes
- pane resizing + horizontal overflow scroll
- no deep links in v1 (pane state is local-only)
- open-by-id routes exist (e.g., `/media/:id`, `/highlight/:id`) without serializing pane layout
- stub media row or static html fragment for layout testing

**excludes**
- highlights
- annotations
- conversations

**acceptance**
- opening a media always yields two panes (content + linked-items)
- pane resizing works without breaking scroll containers
- pane state persists locally across reloads (not shareable URLs)
- open-by-id routes resolve deterministically to the correct object

**dependencies**
- slice 0

---

## slice 3 — html highlights + linked-items alignment

**goal**
users can highlight passages in html content and see linked-items aligned with text.

**outcome**
- core interaction (read → highlight → inspect) works
- alignment behavior is real, not fake

**includes**
- highlight creation on html fragments (offset-based)
- overlapping highlights supported
- linked-items pane rendering
- vertical alignment between highlight targets and linked-items
- highlight deletion/edit (in-place mutation)
- alignment contract:
  - tolerance ≤ 4px between target and linked-item
  - alignment measured via DOM Range bounding rects for highlights
  - off-screen targets show a placeholder state (no forced scroll)
  - alignment recalculates on resize and content reflow (including image load)
  - recalculation is debounced (rAF + 50ms) and avoids layout thrash
- highlight rendering done on a detached DOM tree and swapped in as a whole

**excludes**
- annotations (notes)
- conversations
- epub/pdf
- search

**acceptance**
- user can create multiple highlights in a document
- overlapping highlights render deterministically with no DOM corruption
- segmentation scales without quadratic blowups in number of highlight boundaries
- a perf test measures algorithmic operation count (not wall-clock) under a fixed input size; exact metric defined in the slice spec
- scrolling content keeps active highlight and linked-item aligned (± 4px)
- resizing panes recomputes alignment
- deleting a highlight does not delete any other object; future link cleanup occurs via link deletion rules
- highlights are only visible to their owner until a shared library intersects on the anchor media

**dependencies**
- slice 0
- slice 1
- slice 2

---

## slice 4 — annotations (notes on highlights)

**goal**
users can attach notes to highlights.

**outcome**
- highlights become meaningful, not just colored text

**includes**
- annotation model (0..1 per highlight)
- create/edit/delete annotation
- annotation rendering in linked-items pane
- annotation visibility rules enforced

**excludes**
- conversations
- quote-to-chat
- epub/pdf
- search

**acceptance**
- highlight can exist without annotation
- annotation always belongs to exactly one highlight
- deleting highlight deletes its annotation
- annotations follow same visibility rules as highlights

**dependencies**
- slice 0
- slice 3

---

## slice 5 — library sharing (two-user visibility)

**goal**
two users can share a library and see each other’s work on shared media.

**outcome**
- collaborative reading works

**includes**
- library membership management (add/remove by email; no invite flow in v1)
- role enforcement (admin vs member)
- library-scoped sharing mode
- visibility across users via shared library intersection

**excludes**
- public sharing
- conversations
- search
- epub/pdf

**acceptance**
- user A shares library with user B by email (user must already exist)
- if user is not found, return `E_USER_NOT_FOUND` and do not create membership
- membership is stored by `user_id` (email is lookup only)
- email uniqueness is enforced by auth provider configuration
- B can read shared media
- B can see A’s highlights and annotations (if sharing = library)
- B cannot see A’s private objects or non-shared media

**dependencies**
- slice 0
- slice 4

---

## slice 6 — conversations + quote-to-chat (single-user)

**goal**
users can start a conversation and send messages with quoted context.

**outcome**
- nexus becomes an actual “thinking tool”

**includes**
- conversation creation (single author only)
- messages ordered by per-conversation seq
- message_context links (media/highlight/annotation)
- quote-to-chat flow (inject quote + surrounding context + metadata)
- conversations have `sharing` with default `private`
- `conversation_shares` table exists; required when `sharing = library`
- `conversation_media` is derived from message_context and updated transactionally
- linked-items panes list conversations via `conversation_media`
- message roles (`user`/`assistant`/`system`)
- context construction includes ±K chars around selection with a hard cap
- quote context sources:
  - html/epub: `fragment.canonical_text`
  - pdf: not supported until slice 12
- conversation pane ui

**excludes**
- multi-user conversations
- public sharing
- epub/pdf
- search

**acceptance**
- user can start a conversation from a highlight
- message includes quote + context text
- deleting a highlight removes it from message context but not the message
- conversations are private by default and never leak
- roles are stored, but only `user` messages can be created via ui in this slice
- a conversation created without media appears under media only after message_context creates `conversation_media`

**dependencies**
- slice 0
- slice 4

---

## slice 7 — conversation sharing (library)

**goal**
owners can share conversations to one or more libraries.

**outcome**
- conversations become visible to other library members

**includes**
- set `conversation.sharing = library` with ≥1 share target
- create/delete `conversation_shares` rows
- enforce owner membership in target libraries at write time

**excludes**
- public sharing
- message-level sharing

**acceptance**
- owner selects a library they are a member of and shares the conversation
- members of that library can view the conversation and messages
- non-members cannot view the conversation

**dependencies**
- slice 5
- slice 6

---

## slice 8 — llm replies + quota gates

**goal**
conversations produce assistant replies with basic plan gating.

**outcome**
- the core product moment exists

**includes**
- minimal llm call for assistant replies
- token accounting hooks
- plan gates (free tier restrictions enforced server-side)

**excludes**
- advanced routing
- model switching

**acceptance**
- user message triggers an assistant reply stored as a message
- token usage is recorded per request
- plan gates enforce allowed usage (free tier behaves as configured)

**dependencies**
- slice 6

---

## slice 9 — epub ingestion (html pipeline reuse)

**goal**
epubs behave like first-class readable documents.

**outcome**
- books work the same way articles do

**includes**
- epub upload / fetch
- full extraction into html
- toc + chapter fragments
- html rendering + highlighting reuse
- fragment navigation

**excludes**
- pdf
- search

**acceptance**
- user uploads epub → sees chapters
- highlights + annotations work per chapter
- linked-items align within chapter fragments per slice 3 alignment contract

**dependencies**
- slice 0
- slice 1 (ingestion framework)
- slice 3 (html highlights)

---

## slice 10 — pdf ingestion (viewer first)

**goal**
pdfs are readable and gated correctly.

**outcome**
- pdf is no longer a second-class citizen

**includes**
- pdf upload / fetch
- storage in private bucket
- signed url issuance
- pdf.js viewer integration
- page count + basic metadata
- virtualized page loading
- zoom support with exposed transform matrix (includes rotation metadata)
- deterministic screen ↔ page coordinate conversions (zoom + rotation metadata)

**excludes**
- pdf highlights
- text extraction
- embeddings
- user-controlled rotation

**acceptance**
- user uploads pdf → sees pdf viewer
- access is blocked if not in a shared library
- pdf rendering works on desktop + mobile
- viewer exposes transform matrix used for later overlays
- coordinate conversions remain correct under zoom and intrinsic rotation

**dependencies**
- slice 0
- slice 1 (jobs + storage patterns)

---

## slice 11 — pdf highlights (overlay-based)

**goal**
pdf highlights are supported without breaking the model.

**outcome**
- parity with html highlights at the interaction level

**includes**
- overlay-based highlight geometry
- linked-items integration
- annotation support reuse
- visibility enforcement

**excludes**
- text-based anchoring
- embeddings

**acceptance**
- user can highlight text regions on pdf pages
- highlights persist and re-render correctly
- linked-items show and align (page-relative)

**dependencies**
- slice 0
- slice 10
- slice 4

---

## slice 12 — pdf text extraction + canonical_text

**goal**
pdfs become searchable and quotable beyond geometry.

**outcome**
- text-based features can include pdfs

**includes**
- pdf text extraction via pymupdf
- store `media.plain_text`
- optional per-page text mapping for debugging

**excludes**
- pdf semantic embeddings

**acceptance**
- extracted text is stored for a pdf media row
- text extraction does not break existing pdf viewing/highlights

**dependencies**
- slice 0
- slice 10

---

## slice 13 — search (private keyword)

**goal**
users can find what they’ve read and written (private-only).

**outcome**
- discovery without ML complexity

**includes**
- postgres FTS over:
  - media.title and author names
  - fragment.canonical_text (html/epub)
  - annotation bodies (once slice 4 exists)
  - conversation titles + message bodies (once slice 6 exists)
- keyword search over the viewer’s own objects
- scoping (media)
- visibility-filtered results only (owner-only)

**excludes**
- semantic search
- ranking optimization

**acceptance**
- search never returns invisible objects
- scoped search returns only scoped results
- snippets correspond to canonical text or annotation content
- annotations/messages are included in search results only after their slices ship

**dependencies**
- slice 0
- slice 3

---

## slice 14 — search (shared keyword)

**goal**
users can search across shared libraries they can see.

**outcome**
- shared discovery works without leaks

**includes**
- keyword search across media, highlights, annotations, conversations the viewer can see
- scoping (library, media, conversation)
- visibility-filtered results only

**excludes**
- semantic search
- ranking optimization

**acceptance**
- search never returns invisible objects
- scoped search returns only scoped results
- snippets correspond to canonical text or annotation content
- conversation results are filtered via `conversation_shares` visibility

**dependencies**
- slice 0
- slice 5
- slice 13

---

## slice 15 — embeddings + semantic search

**goal**
semantic recall across everything the user can see.

**outcome**
- llm-native discovery works

**includes**
- chunking pipeline
- embeddings storage
- semantic search with keyword fallback
- cost tracking hooks

**excludes**
- podcasts
- videos

**acceptance**
- semantic search returns relevant results
- respects same visibility predicate as keyword search
- chunk regeneration is safe and idempotent

**dependencies**
- slice 9
- slice 12
- slice 14

---

## v1 cutline

v1 ships after:
- slice 11 (pdf highlights)
- slice 14 (shared keyword search)
- slice 15 (semantic search)
- slice 8 (llm replies + quota gates)

---

## notes on parallelism

allowed parallel work:
- ui polish can happen inside slices once acceptance is met
- epub ingestion can begin while conversations are being finalized
- pdf viewer integration can start before html highlights are “perfect”

not allowed:
- building search before visibility rules are locked
- building semantic search before keyword search exists
- adding new media types before html highlight engine is stable

---

## definition of “slice complete”

a slice is complete when:
- all acceptance criteria pass
- no earlier slice behavior is broken
- no new surface contradicts the constitution
- at least one integration test per new read endpoint verifies `can_view` gating
- every slice that adds a visibility boundary adds allow + deny tests
- search slices test snippet non-leak behavior
- alignment requires e2e coverage (playwright) for scroll/reflow cases
