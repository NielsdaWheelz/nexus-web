# Slice 7: Podcasts — PR Roadmap

### PR-01: Podcast Backend Foundation (Discovery, Subscription, Safe Ingest)
- **goal**: deliver a production-safe backend podcast vertical with global discovery, per-user subscriptions, bounded/idempotent ingest, and quota-governed transcription readiness.
- **builds on**: slice 6 merged state (media lifecycle, capabilities, highlights, quote-to-chat, default-library closure).
- **acceptance**:
  - authenticated users can run podcast discovery globally and receive podcast metadata only (no episode media leakage in discovery results).
  - subscribe creates a per-user subscription and ingests only the newest plan-configured episode window into the subscriber’s default library.
  - episode identity is idempotent with GUID precedence and deterministic fallback when GUID is missing; retries/polling/second-subscriber flows do not create duplicate episode media rows.
  - when an episode is already ingested/transcribed globally, a second subscriber reuses existing episode rows and receives library attachment without redundant transcription jobs.
  - quota is enforced at new transcription-work creation: over-limit free-tier requests fail with stable quota errors and enqueue nothing; paid/manual plan updates take effect immediately; usage resets at 00:00 UTC.
  - transcription persists transcript-segment fragments with deterministic ordering invariants (`(media_id, idx)` uniqueness and `(t_start_ms, idx)` display order) and diarization fallback to non-diarized output.
  - transcript-unavailable failures preserve playback-only semantics with explicit stable error code behavior and capability gating consistency.
- **non-goals**: no podcast transcript/player frontend UX; no semantic podcast search; no Stripe/self-serve billing.

### PR-02: Podcast Transcript UX + Subscription Lifecycle Closure (planned after PR-01 merges)
- **goal**: ship the user-facing podcast episode experience and lifecycle behavior closure on top of PR-01 backend contracts.
- **builds on**: PR-01.
- **acceptance**:
  - users can open podcast episodes in a transcript media pane with audio playback and transcript click-to-seek behavior.
  - playback transport failures degrade gracefully to an "open in source" path while transcript reading/highlighting remain usable.
  - transcript highlights anchor to transcript segment offsets, and quote-to-chat includes timestamp and speaker label when present.
  - unsubscribe supports all three constitution modes, defaults to mode 1, and never removes episodes from shared libraries implicitly.
  - active subscriptions ingest newly published episodes via polling under the same idempotency and quota rules as initial subscribe.
  - visibility and processing-state regression suites remain green with new podcast/transcript scenarios.
- **non-goals**: no advanced player controls, no recommendation/ranking, no speaker-identity enrichment beyond provider diarization labels.

### PR-03: Real Podcast Transcription Pipeline + Transcript Invariants (planned after PR-02 merges)
- **goal**: replace synthetic transcript-segment ingest with real audio transcription work (Deepgram) while enforcing constitution transcript invariants.
- **builds on**: PR-02.
- **acceptance**:
  - when a newly ingested episode has a reachable external audio URL, backend creates real transcription work and persists transcript segments from provider output (not discovery payload fields).
  - diarization fallback is explicit: if diarized transcription fails, a non-diarized transcription attempt is persisted for reading/highlighting before hard-failing the episode.
  - transcript segments are canonicalized for highlight/chat stability (NFC + whitespace normalization) and persisted with strict timing validity (`t_start_ms < t_end_ms`).
  - transcript failure semantics stay stable and explicit (`E_TRANSCRIPTION_FAILED` / `E_TRANSCRIPTION_TIMEOUT` / `E_DIARIZATION_FAILED` / `E_TRANSCRIPT_UNAVAILABLE`) without regressing playback-only behavior.
  - quote-to-chat timestamp/speaker rendering continues to work from provider-produced transcript segments.
- **non-goals**: no speaker-identity enrichment beyond diarization labels; no semantic podcast search.

### PR-04: Active Subscription Polling Orchestration + Ops Hardening (planned after PR-03 merges)
- **goal**: make ongoing subscription ingest continuously operational in production, not just callable as a service helper.
- **builds on**: PR-03.
- **acceptance**:
  - active-subscription polling runs on a configured schedule (Celery beat/worker path) and only processes `status='active'` subscriptions.
  - each poll pass is bounded and idempotent, with concurrency-safe sync claiming so duplicate concurrent runs do not double-ingest.
  - poll runs emit operator-usable outcome telemetry (`processed_count`, `failed_count`, `skipped_count`, `scanned_count`) and stable failure codes for triage.
  - unsubscribe modes continue to prevent future auto-add exactly as configured under scheduled polling.
  - visibility + processing-state regression suites remain green with scheduled-polling scenarios included.
- **non-goals**: no recommendation/ranking logic; no advanced audio player features.

---

## Phase 2: Podcast App Feature Parity

PRs 05–10 bring the podcast experience from "functional backend" to "usable podcast app" by closing the gaps against dedicated podcast clients (Podcast Addict, Apple Podcasts, etc.).

### PR-05: Audio Player Controls + Playback Position Persistence
- **goal**: full player controls (scrubber, skip ±15/30s, speed, volume) and durable playback position persistence across sessions.
- **builds on**: PR-04.
- **acceptance**:
  - seek bar, skip forward/back, speed control (0.5x–3x), and volume slider work in `GlobalPlayerFooter`.
  - playback position persisted to `PodcastListeningState` every 15s during playback + on pause/unload.
  - opening an episode with a saved position auto-resumes.
  - per-episode speed preference persisted; volume is global (localStorage).
- **non-goals**: no sleep timer; no queue/playlist; no played/unplayed state.

### PR-06: Playback Queue + Auto-Advance + Next/Previous
- **goal**: persistent playback queue with auto-advance, next/previous navigation, and queue management UI.
- **builds on**: PR-05.
- **acceptance**:
  - "Play Next" / "Add to Queue" actions on episode rows.
  - auto-advance to next queue item on episode end.
  - next/previous buttons in footer; previous restarts if >3s in, otherwise goes back.
  - queue panel with drag-to-reorder and remove.
  - server-side queue persistence survives page refresh.
- **non-goals**: no shuffle; no repeat; no smart queue generation.

### PR-07: Episode State Tracking + Filtering + Sorting + New Episode Indicators
- **goal**: track played/unplayed/in-progress per episode, add filtering/sorting to episode lists, and show new-episode counts on subscriptions.
- **builds on**: PR-06.
- **acceptance**:
  - episodes auto-marked played at 95% completion; manual mark-as-played/unplayed.
  - filter by state (all/unplayed/in-progress/played), sort by date/duration, search by title.
  - subscriptions page shows unplayed count badge per podcast.
  - "Mark all as played" batch action.
- **non-goals**: no favorites/stars; no push notifications.

### PR-08: OPML Import/Export
- **goal**: bulk import subscriptions from other podcast apps via OPML file upload; export current subscriptions as OPML.
- **builds on**: PR-04 (independent of PR-05–07).
- **acceptance**:
  - upload valid OPML → subscriptions created, sync jobs enqueued, summary returned.
  - unknown-to-PodcastIndex feeds still imported from OPML metadata.
  - export produces valid OPML 2.0 importable by other apps.
  - idempotent: double-import = 0 new subscriptions.
  - max 200 outlines, 1MB file limit.
- **non-goals**: no episode-level state import; no URL import; no non-OPML formats.

### PR-09: Podcast Chapter Support
- **goal**: parse, store, and display podcast chapter markers from RSS feeds (Podcasting 2.0 + Podlove) with player and transcript integration.
- **builds on**: PR-05.
- **acceptance**:
  - RSS chapters extracted during sync and stored per episode.
  - chapter list on media page with click-to-seek.
  - chapter tick marks on scrubber; current chapter shown in footer.
  - chapter headings inline in transcript view.
  - episodes without chapters show no chapter UI.
- **non-goals**: no embedded audio chapter extraction in v1; no user-created chapters.

### PR-10: Podcast Test Coverage Hardening
- **goal**: close critical test gaps across frontend and backend for PRs 01–04 (transcript admission, Deepgram integration, quota edge cases, sync integration, semantic repair, player, transcript states, BFF routes).
- **builds on**: PR-04 (independent of PR-05–09).
- **acceptance**:
  - transcript admission idempotency, quota edge cases, and Deepgram diarization fallback tested.
  - subscription sync full-chain integration tested.
  - all 8 TranscriptMediaPane states tested.
  - global player context tested.
  - PodcastIndex provider error handling tested.
  - existing suites remain green.
- **non-goals**: no E2E browser tests; no tests for PR-05–09 features.

---

## Dependency Graph

```
PR-01 → PR-02 → PR-03 → PR-04 ─┬─→ PR-05 → PR-06 → PR-07
                                 ├─→ PR-08 (OPML, independent)
                                 ├─→ PR-10 (tests, independent)
                                 └─→ PR-09 (chapters, needs PR-05 for scrubber)
```

PR-08 and PR-10 can run in parallel with PR-05–07. PR-09 needs PR-05's scrubber for chapter tick marks.
