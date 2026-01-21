# Nexus — L1 Slice Roadmap (v1)

This roadmap orders work into vertical slices. Each slice delivers user-visible value and enforces invariants from the constitution.

---

## Slice 0 — Platform Bootstrap (Walking Skeleton)

**Goal:** The system boots, authenticates, and enforces permissions end-to-end.

**Outcome:** A logged-in user can hit a protected endpoint and get a deterministic response.

### Includes
- Supabase auth integration
- Next.js BFF proxy (`/api/*`)
- FastAPI app with:
  - Bearer token verification
  - User row creation on first login
  - Canonical `viewer_user_id`
- Minimal DB schema:
  - `users`
  - `libraries`
  - `memberships`
- Default library creation invariant

### Excludes
- Media
- Ingestion
- UI beyond "you're logged in"

### Acceptance Criteria
- User logs in via browser
- Next.js forwards token to FastAPI
- FastAPI rejects unauthenticated requests
- Default library exists and is enforced
- Integration test spins up Next.js + FastAPI + DB

### Risk
- Auth plumbing bugs → fix here or nowhere

---

## Slice 1 — Permissions + Visibility Core

**Goal:** Lock the visibility model before content exists.

**Outcome:** `can_view(viewer, object)` exists and is enforced everywhere.

### Includes
- Library membership roles
- Service-layer permission checks
- Visibility predicates for:
  - Libraries
  - Media (placeholder)
  - Social objects (placeholder)
- Error semantics (404 vs 403 discipline)

### Excludes
- UI sharing flows
- Semantic search
- Conversations

### Acceptance Criteria
- Unauthorized access always rejected
- No endpoint returns data without passing `can_view`
- Tests cover:
  - Owner access
  - Non-member denial
  - Default library invariants

### Risk
- This is hard to retrofit later; must be right now

---

## Slice 2 — Media Ingestion Framework (No Media Yet)

**Goal:** Build ingestion as a first-class system before any specific media.

**Outcome:** Media lifecycle + jobs are real, observable, retryable.

### Includes
- `media` table + `processing_status` state machine
- `fragment` table (empty initially)
- Job queue wiring (Celery + Redis)
- Retry + failure semantics
- Inline ingestion path (dev) calling same service functions
- Minimal UI:
  - `processing_status` badge
  - Retry button

### Excludes
- Actual media extractors
- Highlights
- Search

### Acceptance Criteria
- Media row moves through states deterministically
- Failure is visible and retryable
- No duplicate partial data after retry
- Integration tests assert state transitions

### Risk
- Bad state machine = endless bugs later

---

## Slice 3 — Web Articles (First Real Media, End-to-End)

**Goal:** Ship the first complete reading experience.

**Outcome:** User can add a web article, read it, highlight it.

### Includes
- URL ingestion via headless browser
- Mozilla Readability extraction
- HTML sanitization (persisted)
- `canonical_text` generation
- Fragment creation (single fragment)
- Content pane rendering
- Keyword search over:
  - Media title
  - `canonical_text`

### Excludes
- Conversations
- Semantic search
- Sharing
- Annotations

### Acceptance Criteria
- Article renders without iframe
- Sanitized HTML only
- Highlight offsets stable across reloads
- Keyword search finds article text

### Risk
- Canonicalization bugs → highlight drift

---

## Slice 4 — Highlights + Annotations (HTML)

**Goal:** Make reading interactive.

**Outcome:** Users can highlight overlapping spans and annotate them.

### Includes
- Highlight model + uniqueness constraint
- Overlapping highlight support (event-segmented rendering)
- Highlight colors
- Optional annotation (0..1)
- Linked-items pane (highlights only)
- Visibility enforcement (library intersection)

### Excludes
- Conversations
- PDF
- Transcripts

### Acceptance Criteria
- Overlapping highlights render correctly
- Annotations attach/detach cleanly
- No duplicate highlights per user/span
- Integration tests for overlap edge cases

### Risk
- DOM segmentation complexity; must be correct

---

## Slice 5 — Conversations + Chat (No Quotes Required)

**Goal:** Establish the chat system independently of media.

**Outcome:** User can chat with an LLM in a private conversation.

### Includes
- `conversation` + `message` schema
- Message ordering (`seq`)
- Model selection per message
- LLM adapter abstraction
- Usage accounting hooks
- Chat UI pane

### Excludes
- Quote-to-chat
- Sharing conversations
- Summarization

### Acceptance Criteria
- New chat works without media
- Model choice respected
- Messages ordered strictly
- Failures are surfaced as system messages

### Risk
- Provider abstraction mistakes

---

## Slice 6 — Quote-to-Chat (Documents)

**Goal:** Connect reading to thinking.

**Outcome:** User can quote highlighted text into a chat with context.

### Includes
- `message_context` table
- Quote payload:
  - Exact text
  - ±600 chars context (cap enforced)
  - Media metadata
- `conversation_media` derivation
- Linked-items pane shows conversations

### Excludes
- Transcripts
- PDF

### Acceptance Criteria
- Quoted context is correct and bounded
- Conversations appear next to the media
- Deleting highlight does not break messages

### Risk
- Token bloat if context rules aren't enforced

---

## Slice 7 — EPUB (Partial)

**Goal:** Prove multi-fragment media works.

**Outcome:** User can read an EPUB chapter and highlight it.

### Includes
- EPUB ingestion
- TOC extraction
- Fragment per chapter
- Render:
  - Chapter list
  - First chapter only (initially)
- Reuse highlight + chat logic

### Excludes
- Full EPUB navigation polish

### Acceptance Criteria
- Chapter fragment immutability holds
- Highlights scoped to fragment
- Reuse all document logic

### Risk
- EPUB HTML weirdness

---

## Slice 8 — PDF (Required for v1)

**Goal:** Support academic / scanned reading.

**Outcome:** User can read a PDF, select text, highlight, quote.

### Includes
- PyMuPDF text extraction (for search/quote)
- PDF.js rendering
- Text-layer selection capture
- Geometry-based highlights
- PDF highlights appear in linked-items pane

### Excludes
- Perfect text ↔ geometry reconciliation

### Acceptance Criteria
- Selection creates stable highlight
- Exact text stored
- Quote-to-chat works
- Overlapping PDF highlights supported

### Risk
- PDF selection edge cases; accept imperfection

---

## Slice 9 — Podcast Episodes (Audio + Transcript)

**Goal:** Extend "media" abstraction to time-based text.

**Outcome:** User can read/listen/highlight podcast transcripts.

### Includes
- PodcastIndex search
- `podcast` + `subscription` tables
- RSS fetch + idempotent episode ingest
- Transcript via Deepgram
- Transcript segments as fragments
- Audio player + click-to-seek
- Auto-add episodes to default library

### Excludes
- Semantic search
- Advanced playback

### Acceptance Criteria
- Subscribe → episodes appear
- Highlights anchor to segments
- Quote-to-chat includes timestamps/speaker labels
- Unsubscribe stops future auto-add

### Risk
- Transcription cost + queue pressure

---

## Slice 10 — Video (YouTube)

**Goal:** Reuse transcript logic for video.

**Outcome:** User can ingest a YouTube video and work with transcript.

### Includes
- YouTube URL ingestion
- Transcript fetch (or fail open)
- YouTube embed playback
- Transcript highlighting + quote-to-chat

### Excludes
- Channels
- Local video

### Acceptance Criteria
- Transcript view works without playback
- Playback seeks from transcript
- No document iframes used

### Risk
- YouTube transcript availability variability

---

## Slice 11 — Semantic Search (Post-Skeleton)

**Goal:** Add meaning-aware discovery.

**Outcome:** Users can semantically search what they can see.

### Includes
- Chunking per media type
- Embeddings
- Semantic ranking
- Hybrid keyword + semantic UX

### Acceptance Criteria
- Semantic search never leaks invisible content
- Partial results handled gracefully

---

## Dependency Spine

```
S0: Auth
 └── S1: Permissions
      └── S2: Ingestion Core
           └── S3: Web Article
                └── S4: Highlights
                     └── S5: Chat
                          └── S6: Quote-to-Chat
                               ├── S7: EPUB
                               ├── S8: PDF
                               ├── S9: Podcast Episode
                               └── S10: Video
                                    └── S11: Semantic Search
```
