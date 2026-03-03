# Slice 8: YouTube Video — Spec

## Goal

Deliver YouTube media as transcript-first reading surfaces with embed playback plus optional user-triggered stored audio/video artifacts.

## Acceptance Criteria

### YouTube URL ingestion classifies and attaches correctly
- **given**: an authenticated user submits a valid YouTube URL (including common URL variants for the same video)
- **when**: ingestion is requested
- **then**: the system creates or reuses a `media.kind=video` row, records stable YouTube identity metadata, and attaches the media to the requester’s default library.

### Transcript feasibility spike is completed and documented
- **given**: a representative sample of YouTube videos across likely failure modes (auto-captions, disabled transcripts, rate limits, language mismatch)
- **when**: transcript-fetch feasibility is executed
- **then**: success/failure rates and failure categories are documented in a reproducible artifact set (fixture-backed checks + dated probe report), and the playback-only fallback path is verified end-to-end for transcript-unavailable cases.

### Transcript-success videos become readable transcript media
- **given**: a YouTube video where transcript fetch succeeds
- **when**: ingest processing completes
- **then**: media transitions to `ready_for_reading`, transcript segments are persisted as fragments with deterministic ordering semantics, and the user can watch the video in-app while reading/highlighting/quoting transcript content in the same media view.

### Transcript interactions reuse existing highlight and quote-to-chat behavior
- **given**: a readable video transcript
- **when**: a user selects transcript text, creates a highlight, and sends quote-to-chat
- **then**: highlight anchoring uses transcript segment offsets, and rendered quote context includes source metadata plus timestamp and speaker label when available.

### Transcript click-to-seek works with YouTube playback
- **given**: a readable video transcript and playable video
- **when**: a user clicks a transcript segment
- **then**: playback seeks to the segment’s `t_start_ms` target deterministically.

### YouTube playback uses embed-safe rendering
- **given**: a readable or playback-only video
- **when**: the media pane renders playback
- **then**: playback is rendered through approved YouTube embed origins, not direct file-style browser video playback, and iframe policy remains limited to YouTube playback only.

### Transcript remains usable even when in-app playback fails
- **given**: a video with transcript fragments available but in-app playback cannot start in the current browser/session
- **when**: the user opens the media pane
- **then**: transcript viewing/highlighting/quote-to-chat remain usable, and an explicit source fallback action is available for playback.

### Playback-only fallback is explicit and capability-safe
- **given**: transcript fetch is unavailable but a playable YouTube watch source exists
- **when**: ingest processing completes and the user opens the media
- **then**: `processing_status=failed` with `last_error_code=E_TRANSCRIPT_UNAVAILABLE`, playback remains available, transcript-dependent actions (read/highlight/quote/search) are disabled, and transcript-unavailable state is explicit in UI/API.

### User-triggered audio extraction creates optional stored playback
- **given**: a readable or playback-only YouTube video
- **when**: the user explicitly requests audio extraction
- **then**: extraction runs asynchronously, a private stored audio artifact is created on success, and the media pane can switch to audio playback mode without changing transcript behavior.

### User-triggered video download creates optional stored playback and download
- **given**: a readable or playback-only YouTube video
- **when**: the user explicitly requests video download
- **then**: download runs asynchronously, a private stored video artifact is created on success, and the user can use both in-app stored playback and an explicit signed download action.

### Stored artifacts remain visibility-safe
- **given**: stored audio/video artifacts exist for a video media row
- **when**: any user requests playback/download artifact URLs
- **then**: artifact access is granted only through the same server-side visibility predicate used for media readability, and clients receive short-lived signed URLs only.

### Extraction/download failures are additive and non-destructive
- **given**: extraction or download fails for a video
- **when**: failure is recorded
- **then**: transcript and existing playback paths remain usable exactly as before, with failure state surfaced explicitly and no downgrade of base video readability.

### Idempotency is global and stable across subscribers
- **given**: multiple ingest requests for the same YouTube video from one or more users
- **when**: requests are processed
- **then**: the same canonical video identity resolves to one shared media row and existing transcript artifacts are reused rather than duplicated.

### Cross-cutting suites remain green
- **given**: Slice 8 changes are integrated
- **when**: visibility and processing-state suites run
- **then**: prior slice scenarios still pass and video-specific scenarios pass, including transcript-unavailable playback-only behavior plus extraction/download access-control and failure-isolation cases.

## Key Decisions

**Canonical video identity is provider-based**: YouTube videos are identified by provider video ID with a normalized canonical watch URL derived from that identity. This prevents duplicate rows across URL-shape variants and is the durable idempotency anchor.

**URL ingestion remains a single entrypoint with kind classification**: existing URL-ingestion flow classifies YouTube URLs into `media.kind=video` and non-YouTube URLs into their existing path. This keeps ingestion UX unified while preserving global idempotency semantics.

**Transcript engine is reused, not re-invented**: video transcripts use the same fragment-based transcript model and invariants as podcasts (immutable segment fragments, deterministic ordering, canonicalized transcript text, transcript-offset highlights, timestamp-aware quote rendering).

**Video playback contract is embed-oriented**: video playback metadata is treated as an embed contract (YouTube iframe-safe rendering + source fallback), not as a direct media-file stream contract. This avoids brittle client guessing and aligns with constitution iframe policy.

**Playback metadata is typed and provider-derived**: API playback data is provider-specific and canonical. For YouTube, contract fields are derived server-side from stable provider identity (including provider video ID and embed/watch URLs); clients must not parse raw URLs to build embed behavior.

**Transcript and playback are a single product surface**: for transcript-available videos, MVP requires co-present in-app playback and transcript interaction in one media pane (not a redirect-only or transcript-only primary experience).

**Transcript availability and playback availability remain decoupled**: transcript failure does not imply playback failure. `E_TRANSCRIPT_UNAVAILABLE` is a terminal transcript-readability failure with explicit playback-only capability posture.

**Searchability policy is capability-consistent across transcript media**: transcript-unavailable media is excluded from transcript-dependent search results. This policy applies consistently to both `video` and `podcast_episode` to prevent cross-kind behavior drift.

**Stored artifacts are explicit and additive**: audio extraction and video download are user-triggered, optional artifacts attached to the same video media row. They coexist with provider playback metadata and never become implicit background ingestion.

**Stored artifact access reuses existing storage security model**: extracted/downloaded files remain private storage objects, and all artifact playback/download URLs are minted server-side only after standard media visibility checks.

**Extraction/download lifecycle is orthogonal to transcript lifecycle**: artifact generation status is tracked independently from transcript readability state so extraction/download failures cannot regress an already-readable transcript surface.

**Security posture is explicit for embeds**: Slice 8 requires explicit YouTube embed allowlisting in client security policy and does not relax document rendering constraints (documents still never render via iframe).

**Feasibility evidence is executable, not prose-only**: Slice 8 feasibility deliverables include repeatable test harness coverage and a timestamped sample probe report so operational risk can be re-measured as providers evolve.

## Out of Scope

- YouTube channel subscriptions and channel feed syncing
- Non-YouTube video providers
- Local audio/video upload
- Automatic extraction/download without explicit user action
- Advanced video controls beyond basic playback + transcript seek
- Transcript editing/correction tooling
- Semantic/vector search changes (Slice 9)
- Public API expansion beyond existing browser/BFF model
