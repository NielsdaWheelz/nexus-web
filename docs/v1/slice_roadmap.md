# Nexus — L1 Slice Roadmap (v1)

This roadmap orders work into vertical slices. Each slice delivers user-visible value and enforces invariants from the constitution.

---

## Cross-Cutting Test Suites

Two test suites are introduced early and reused by every later slice:

### Visibility Test Suite (introduced in S0)
- Integration scenarios covering:
  - Media readability via library membership **(S0)**
  - Highlights visible only via library intersection **(S2+)**
  - Conversations visible via `conversation_shares` **(S3+)**
  - Search filtering (never leaks invisible results) **(S3+)**
- S0 establishes the foundation (media visibility only); later slices extend coverage.
- Every slice that touches visibility must pass all existing scenarios + add new ones.

### Processing-State Test Suite (introduced in S1)
- Ensures state machine transitions never regress:
  - `pending` → `extracting` → `ready_for_reading` → `embedding` → `ready`
  - `failed` transitions and retry semantics
  - **`failed` with playback-ok**: `processing_status = failed` may still allow read/play access depending on `last_error_code` (e.g., `E_TRANSCRIPT_UNAVAILABLE` allows playback but disables highlights)
- Every media-kind slice must pass existing scenarios + add kind-specific ones.

---

## Slice 0 — Auth + Libraries Core

**Goal:** The system boots, authenticates, and the user can organize libraries.

**Outcome:** A logged-in user can create libraries and see the pane shell with a seeded article.

### Includes
- Supabase auth integration
- Next.js BFF proxy (`/api/*`)
- FastAPI app with:
  - Bearer token verification
  - Internal secret header enforcement
  - User row creation on first login
  - Canonical `viewer_user_id`
- Minimal DB schema:
  - `users`
  - `libraries`
  - `memberships`
  - `media`
  - `fragments`
  - `library_media`
- Default library creation invariant
- Library CRUD:
  - Create / rename / delete non-default libraries
  - Add / remove media from a library
  - Admin-only mutation enforced
  - Default library closure invariant enforced
- Pane shell:
  - Collapsible navbar
  - Tabsbar
  - Horizontal resizable panes
  - `/media/:id` route renders content pane (linked-items pane deferred to S2)
- **Seeded fixture media** (no placeholder kind):
  - One real `web_article` row seeded via hardcoded fixture URL in tests
  - Uses real schema: `kind = web_article`, `processing_status = ready_for_reading`
  - Has one real fragment with `html_sanitized` and `canonical_text`
  - No fake abstractions; validates the real data model
- Visibility test suite (foundation):
  - Only library members see media
  - Non-members get 404
  - Default library invariants

### Excludes
- Library sharing (S4)
- Real ingestion pipeline
- Highlights
- Conversations

### Acceptance Criteria
- User logs in via browser
- Next.js forwards token to FastAPI
- FastAPI rejects unauthenticated requests
- FastAPI rejects requests without internal secret header
- Default library exists and is enforced
- User can create a library and add media to it
- Admin-only mutation enforced
- Removing media from default library cascades correctly
- Default library cannot be deleted
- Panes render and resize
- Seeded article visible only to library members
- Non-members get 404
- Mobile responsive layout works
- Integration test spins up Next.js + FastAPI + DB
- Visibility test suite passes

### Risk
- Auth plumbing bugs → fix here or nowhere

---

## Slice 1 — Ingestion Framework + Storage

**Goal:** Build ingestion + storage as first-class systems before any specific media.

**Outcome:** User can upload a file and see pending/failed/retry in UI; download via signed URL.

### Includes
- `media` table + `processing_status` state machine
- `fragment` table (empty initially)
- Job queue wiring (Celery + Redis)
- Retry + failure semantics
- Inline ingestion path (dev) calling same service functions
- **Global ingestion invariants** (apply to all later media kinds):
  - Idempotency rules:
    - `web_article` / `video` / `podcast_episode`: idempotent by `(kind, canonical_source_url)` or episode guid
    - File uploads (`epub` / `pdf`): user-scoped idempotency by `(user_id, file_hash)`, not global dedupe
  - Quota awareness hooks:
    - `check_quota(user, operation)` predicate exists (even if limits are infinite in S1)
    - Enforcement point exists; S7 populates real limits
- Supabase storage private bucket setup
- Upload endpoint (stores path, not blob in DB)
- Download endpoint: `GET /media/:id/file` returns signed URL
- Permission check: `can_read(viewer, media)` before signing
- Signed URL expiry (short-lived)
- **`failed` with playback-ok semantics**:
  - `processing_status = failed` + `last_error_code = E_TRANSCRIPT_UNAVAILABLE` allows playback but disables highlights/quote-to-chat
  - Test this state transition before video slice exists
- Minimal UI:
  - `processing_status` badge
  - Retry button
  - User can upload a file and see pending/failed/retry
- Processing-state test suite (foundation):
  - State transitions deterministic
  - Retry resets state correctly
  - No duplicate partial data after retry
  - `failed` + playback-ok tested

### Excludes
- Actual media extractors
- Highlights
- Search
- Real quota limits (deferred to S7)

### Acceptance Criteria
- Media row moves through states deterministically
- Failure is visible and retryable
- No duplicate partial data after retry
- URL-based media (`web_article` / `video` / `podcast_episode`): same URL returns existing media (global)
- File uploads: same file by same user returns existing; different users get separate rows
- Upload stores file in private bucket
- Download returns signed URL only if viewer can read media
- Non-members cannot fetch file (even with guessed URL)
- Signed URLs expire
- `failed` + `E_TRANSCRIPT_UNAVAILABLE` state allows playback, disables highlights
- `check_quota` hook exists and is called (passes with infinite limits)
- Processing-state test suite passes

### Risk
- Bad state machine = endless bugs later
- Storage permission bugs = data leakage

---

## Slice 2 — Web Articles + Highlights

**Goal:** Ship the first complete reading + highlighting experience.

**Outcome:** User can add a web article, read it, highlight overlapping spans, and annotate.

### Includes
- URL ingestion via headless browser
- Mozilla Readability extraction
- HTML sanitization (persisted)
- `canonical_text` generation
- Fragment creation (single fragment)
- Content pane rendering
- Metadata extraction (title, authors, date) during ingestion
- `authors` table + `media_authors` pivot
- Async LLM verification job (non-blocking correction)
- UI surfaces metadata (read-only initially)
- Highlight model + uniqueness constraint
- Overlapping highlight support (event-segmented rendering)
- Highlight colors
- Highlight edit (mutate offsets/color without delete/recreate)
- Optional annotation (0..1)
- Linked-items pane (shows highlights; empty shell exists from S0)
- Visibility enforcement (single-user only; sharing comes in S4)
- **Security fixtures suite** (explicit acceptance tests):
  - Sanitizer blocks XSS payloads (script injection, event handlers, javascript: urls)
  - Image proxy blocks SVG + non-image mime types
  - Link rewriting works (rel, target, referrerpolicy)
  - No `data:` urls in document img src
  - Sanitizer strips all inline styles

### Excludes
- Library sharing (S4)
- Conversations
- PDF
- Transcripts

### Acceptance Criteria
- Article renders without iframe
- Sanitized HTML only
- Fragment immutability holds
- Idempotent: same URL returns existing media
- Metadata extraction runs on ingest
- LLM verification corrects bad titles/authors
- Authors linked to media
- Failures don't block reading
- Overlapping highlights render correctly
- Annotations attach/detach cleanly
- No duplicate highlights per user/span
- Highlight edit preserves identity
- Owner sees their highlights
- Integration tests for overlap edge cases
- Security fixtures suite passes
- Visibility test suite passes
- Processing-state test suite passes

### Risk
- DOM segmentation complexity; must be correct
- Canonicalization bugs → highlight drift

---

## Slice 3 — Chat + Quote-to-Chat + Keyword Search

**Goal:** Connect reading to thinking; enable finding content.

**Outcome:** User can chat with an LLM, quote highlighted text into chat, and search their content.

### Includes
- `conversation` + `message` schema
- `conversation_shares` table with service-layer constraint enforcement:
  - `sharing = private` forbids `conversation_share` rows (enforced at write time)
  - `sharing = library` requires ≥1 `conversation_share` rows (enforced at write time)
  - Test these constraints even though sharing UI is deferred
- Message ordering (`seq`)
- **Model registry**:
  - `models` table: `id`, `provider`, `model_name`, `is_available`, `max_context`, `cost_per_1k_tokens`
  - `message.model_id` references registry (not raw string)
  - UI selects from registry
  - Seed manually in v1; Stripe integration later
- LLM adapter abstraction
- Usage accounting hooks
- Chat UI pane
- `message_context` table
- Quote payload:
  - Exact text
  - ±600 chars context (cap enforced)
  - Media metadata
- `conversation_media` derivation
- Linked-items pane shows conversations
- Search endpoint with visibility filtering
- Searchable fields:
  - `media.title`
  - `fragment.canonical_text`
  - `annotation.text`
  - `message.content`
- Scope filters: media, library, conversation
- Pagination + cursor
- Snippet generation (post-filter only)
- **Destructive operations** (constitution invariants):
  - Deleting a highlight removes its annotation
  - Deleting a message removes its `message_context` rows
  - Deleting the last message deletes the conversation
  - Deleting a context target updates `conversation_media` transactionally

### Invariants
- Conversations exist independent of media; `conversation_media` is not populated until quote-to-chat is used.
- `conversation_shares` constraints enforced in service layer even without sharing UI.

### Excludes
- Library sharing (S4)
- Sharing conversations UI
- Summarization
- Semantic/vector search
- Facets

### Acceptance Criteria
- New chat works without media
- Model choice from registry respected
- Messages ordered strictly
- Failures are surfaced as system messages
- `conversation_shares` constraints enforced:
  - `private` conversation with share rows → rejected
  - `library` conversation without share rows → rejected
- Quoted context is correct and bounded
- Conversations appear next to the media
- Deleting highlight does not break messages (but removes annotation)
- Quoting overlapping highlights behaves deterministically (topmost or smallest span wins; specify and test)
- Search never returns invisible content
- Scope filters work
- Snippets don't leak content from invisible items
- Performance acceptable for 10k items
- **Destructive operations tested**:
  - Delete highlight → annotation deleted
  - Delete message → message_context rows deleted
  - Delete last message → conversation deleted
  - Delete context target → conversation_media updated
- Visibility test suite passes

### Risk
- Provider abstraction mistakes
- Token bloat if context rules aren't enforced
- Visibility joins are complex; get them right now

---

## Slice 4 — Library Sharing

**Goal:** Libraries can be shared with other users.

**Outcome:** Multiple users can be members of the same library with role-based access; highlights and conversations become visible via library intersection.

**Progress:** PR-01 (schema), PR-02 (visibility auth kernel), PR-03 (library governance), and PR-04 (invitation lifecycle) are implemented. Canonical visibility predicates, helper splits, rollout-safe intrinsic write-through, owner-only delete, member management, ownership transfer, and invite lifecycle with atomic accept semantics are in place.

### Includes
- Invite user to library (by email or user id)
- Accept/decline invitation flow
- Add/remove members
- Role changes (admin ↔ member)
- Enforce "only admin mutates membership"
- Highlight visibility via library intersection (unlocks S2 highlights for sharing)
- Conversation visibility via `conversation_shares` (unlocks S3 conversations for sharing)
- Sharing UI for conversations (was deferred, now enabled)
- Visibility test suite extensions:
  - Shared library media visible to all members
  - Shared library members see each other's highlights
  - Conversation sharing to libraries works
  - Non-members still get 404

### Excludes
- Public libraries
- Invitation links

### Acceptance Criteria
- User A invites User B to library
- User B sees library and its media after accepting
- User B sees User A's highlights on shared media
- Conversation shared to library visible to members
- Only admins can add/remove members
- Removing last admin is forbidden
- Integration tests for "library intersection" visibility pattern
- Visibility test suite passes

### Risk
- Visibility queries become complex; but highlights/chat are already tested single-user

---

## Slice 5 — EPUB

**Goal:** Prove multi-fragment media works.

**Outcome:** User can read an EPUB chapter and highlight it.

### Includes
- EPUB ingestion (uses storage from S1)
- TOC extraction
- Fragment per chapter
- Render:
  - Chapter list
  - Chapter navigation
- Reuse highlight + chat logic from S2/S3

### Excludes
- Full EPUB navigation polish
- EPUB ingest-from-URL (deferred to v2)

### Acceptance Criteria
- Chapter fragment immutability holds
- Highlights scoped to fragment
- Reuse all document logic
- Visibility test suite passes
- Processing-state test suite passes

### Risk
- EPUB HTML weirdness

---

## Slice 6 — PDF

**Goal:** Support academic / scanned reading.

**Outcome:** User can read a PDF, select text, highlight, quote.

### Includes
- PyMuPDF text extraction
- `media.plain_text` populated for chunking/search/quote-to-chat
- PDF.js rendering
- Text-layer selection capture
- Geometry-based highlights
- PDF highlights appear in linked-items pane

### Excludes
- Perfect text ↔ geometry reconciliation
- PDF ingest-from-URL (deferred to v2)

### Acceptance Criteria
- Selection creates stable highlight
- Exact text stored at highlight creation
- `media.plain_text` indexed before quote-to-chat
- Quote-to-chat works using stored text (not re-extraction)
- Overlapping PDF highlights supported
- Visibility test suite passes
- Processing-state test suite passes

### Risk
- PDF selection edge cases; accept imperfection

---

## Slice 7 — Podcasts

**Goal:** Extend "media" abstraction to time-based text with cost controls.

**Outcome:** User can subscribe, read/listen/highlight podcast transcripts within usage limits.

### Includes
- `plan` model (free / paid tiers)
- **Real quota limits** (uses hooks from S1):
  - Transcription minutes per day
  - Episodes per subscription
- Enforcement at FastAPI layer via `check_quota`
- Manual plan assignment (Stripe later)
- Free tier limits:
  - X minutes transcription/day
  - Last N episodes per subscription (e.g., 50)
- PodcastIndex search
- `podcast` + `subscription` tables
- Subscription is per-user (not per-library)
- RSS fetch + idempotent episode ingest (uses S1 idempotency rules)
- Episode idempotency:
  - `(podcast_id, episode_guid)` unique when guid present
  - Fallback: `(podcast_id, enclosure_url, published_at)` when guid absent
- Episode ingest is global: episodes are shared across users, transcription runs once
- Immediate ingest: last N episodes only (e.g., 50)
- Progressive backfill: older episodes on-demand or scheduled
- Transcript via Deepgram
- Transcript segments as fragments with deterministic ordering: `(media_id, idx)` unique
- Display order: `(t_start_ms, idx)` handles overlaps
- Audio player + click-to-seek
- Auto-add episodes to user's default library on subscribe
- Diarization fallback: if diarization fails, fallback to non-diarized transcript

### Excludes
- Stripe integration
- Self-serve upgrade UI
- Semantic search
- Advanced playback

### Acceptance Criteria
- Free user hits transcription limit → blocked with error
- Paid user has higher/no limit
- Usage resets daily
- Admin can manually set plan
- Subscribe → last N episodes appear in user's default library
- Two users subscribing does not duplicate episodes
- Second subscriber causes zero new transcript jobs if already ingested
- Episode with missing guid uses fallback idempotency
- Highlights anchor to segments
- Quote-to-chat includes timestamps/speaker labels
- Unsubscribe stops future auto-add
- Transcript segment order is deterministic by `(media_id, idx)`
- Visibility test suite passes
- Processing-state test suite passes

### Risk
- Transcription cost + queue pressure
- One user subscribing to 1500-episode feed = cost explosion without quotas

---

## Slice 8 — YouTube Video

**Goal:** Reuse transcript logic for video.

**Outcome:** User can ingest a YouTube video and work with transcript.

### Includes
- YouTube URL ingestion
- **Transcript feasibility spike** (risk validation):
  - Test YouTube transcript fetch against diverse video types
  - Document failure rates: auto-captions, disabled transcripts, rate limits
  - Confirm `playback-only` fallback works end-to-end (uses S1 `failed` + playback-ok semantics)
- Transcript fetch (or fail to playback-only mode per constitution)
- YouTube embed playback (validates iframe allowlist)
- Transcript highlighting + quote-to-chat
- Click-to-seek from transcript
- Transcript segment ordering: `(media_id, idx)` consistent with podcasts

### Excludes
- Channels
- Local video

### Acceptance Criteria
- Transcript feasibility spike documented with success/failure rates
- Transcript view works without playback
- Playback seeks from transcript
- YouTube embed renders (iframe allowed per constitution)
- Playback-only mode works when transcript unavailable:
  - `processing_status = failed`
  - `last_error_code = E_TRANSCRIPT_UNAVAILABLE`
  - Playback URL still usable
  - Highlights and quote-to-chat disabled
- Idempotent: same YouTube URL returns existing media
- Visibility test suite passes
- Processing-state test suite passes

### Risk
- YouTube transcript availability variability
- Feasibility spike may reveal high failure rates; accept playback-only as default

---

## Slice 9 — Semantic Search

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
- Visibility test suite passes

---

## Dependency Spine

```
S0: Auth + Libraries Core
 └── S1: Ingestion Framework + Storage
      └── S2: Web Articles + Highlights
           └── S3: Chat + Quote-to-Chat + Keyword Search
                └── S4: Library Sharing
                     └── S5: EPUB
                          └── S6: PDF
                               └── S7: Podcasts (with billing)
                                    └── S8: YouTube Video
                                         └── S9: Semantic Search
```

**Key ordering rationale:**
- S4 (Library Sharing) comes after S3 (Chat) because:
  - Sharing depends on highlights existing (S2)
  - Sharing depends on conversations existing (S3)
  - Highlights do NOT depend on sharing
  - This allows validating the core product loop (read → highlight → chat) before multi-user complexity

---

## Parallelization Notes

Once S0 is done (auth + libs + panes), teams can parallelize:

**Team A**: Ingestion framework + storage (S1)
**Team B**: Highlight renderer + overlap segmentation (part of S2) using seeded fixture fragments
**Team C**: Chat system (S3) using no media

Then merge at S2/S3 boundary.

### Don't Parallelize
- Don't build highlights before canonicalization + fragment model exists (but can build renderer against fixture fragments)
- Don't build sharing before core permission predicates exist (but can design UI)
- Don't build quote-to-chat before highlights exist
