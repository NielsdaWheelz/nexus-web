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

**includes**
- supabase auth integration
- user bootstrap on first login
- default personal library creation
- library + membership model (admin/member)
- server-side visibility enforcement (no leaks)
- minimal schema:
  - users, libraries, library_users, media, library_media
  - social stubs: highlights, conversations (only columns needed for visibility)

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
- 2–3 integration tests prove “no cross-library leak” on at least one social table
- `can_view` is used by all existing read paths

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
- canonical_text exists and matches rendered content semantics
- user cannot read media not in a library they belong to
- failed job transitions to `failed` with a typed error and visible UI state
- manual retry resets state and re-runs extraction

**dependencies**
- slice 0

---

## slice 2 — html highlights + linked-items alignment

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

**excludes**
- annotations (notes)
- conversations
- epub/pdf
- search

**acceptance**
- user can create multiple highlights in a document
- overlapping highlights render correctly
- scrolling content keeps active highlight and linked-item aligned (± 4px)
- resizing panes recomputes alignment
- deleting a highlight does not delete any other object; future link cleanup occurs via link deletion rules
- highlights are invisible to other users unless shared later

**dependencies**
- slice 1

---

## slice 3 — annotations (notes on highlights)

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
- slice 2

---

## slice 4 — conversations + quote-to-chat (single-user)

**goal**
users can start a conversation and send messages with quoted context.

**outcome**
- nexus becomes an actual “thinking tool”

**includes**
- conversation creation (single author only)
- messages ordered by per-conversation seq
- message_context links (media/highlight/annotation)
- quote-to-chat flow (inject quote + surrounding context + metadata)
- conversation schema includes `sharing` enum and `root_media_id` (required for library sharing)
- message roles (`user`/`assistant`/`system`)
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
- no llm call yet; conversations store user-authored text only (assistant replies are out of scope)

**dependencies**
- slice 3

---

## slice 5 — library sharing (two-user visibility)

**goal**
two users can share a library and see each other’s work on shared media.

**outcome**
- collaborative reading works

**includes**
- library membership management (invite/add/remove)
- role enforcement (admin vs member)
- library-scoped sharing mode
- visibility across users via shared library intersection

**excludes**
- public sharing
- search
- epub/pdf

**acceptance**
- user A shares library with user B
- B can read shared media
- B can see A’s highlights, annotations, and conversations (if sharing = library)
- B cannot see A’s private conversations or non-shared media

**dependencies**
- slice 4

---

## slice 6 — epub ingestion (html pipeline reuse)

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
- linked-items align within chapter fragments per slice 2 alignment contract

**dependencies**
- slice 2 (html highlights)
- slice 1 (ingestion framework)

---

## slice 7 — pdf ingestion (viewer first)

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
- zoom + rotation support with exposed transform matrix
- deterministic screen ↔ page coordinate conversions

**excludes**
- pdf highlights
- text extraction
- embeddings

**acceptance**
- user uploads pdf → sees pdf viewer
- access is blocked if not in a shared library
- pdf rendering works on desktop + mobile
- viewer exposes transform matrix used for later overlays
- coordinate conversions remain correct under zoom/rotation

**dependencies**
- slice 0
- slice 1 (jobs + storage patterns)

---

## slice 8 — pdf highlights (overlay-based)

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
- slice 7
- slice 3

---

## slice 9a — search (private-only, keyword first)

**goal**
users can find what they’ve read and written.

**outcome**
- discovery without ML complexity

**includes**
- keyword search across the viewer’s own media, highlights, annotations, conversations
- scoping (media, conversation)
- visibility-filtered results only (owner-only)

**excludes**
- semantic search
- ranking optimization

**acceptance**
- search never returns invisible objects
- scoped search returns only scoped results
- snippets correspond to canonical text or annotation content

**dependencies**
- slice 4

---

## slice 9b — search (shared keyword)

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

**dependencies**
- slice 5
- slice 9a

---

## slice 10 — embeddings + semantic search

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
- slice 9b

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
