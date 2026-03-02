# Slice 8: YouTube Video — PR Roadmap

### PR-01: YouTube Identity + Ingest + Transcript Contract
- **goal**: deliver a production-safe backend vertical for YouTube URL ingestion, global idempotency, transcript persistence, and explicit playback-only fallback semantics.
- **builds on**: slice 7 merged state (transcript fragments, capability gating, playback-only error semantics, default-library closure).
- **acceptance**:
  - `POST /media/from_url` classifies YouTube URLs (including common variants), normalizes to one canonical provider identity, and creates-or-reuses a single `media.kind=video` row attached to the requester’s default library.
  - repeated ingest requests across users resolve to the same video media row and reuse existing transcript artifacts instead of duplicating rows/work.
  - media playback metadata adopts a typed provider contract where video playback is server-derived from YouTube provider identity (embed/watch URLs + provider video ID) with compatibility shims treated as transitional only.
  - transcript-success ingestion persists canonicalized transcript segments as fragments with deterministic ordering invariants and transitions media to `ready_for_reading` with playable watch-source metadata.
  - transcript-unavailable ingestion sets `processing_status=failed` with `last_error_code=E_TRANSCRIPT_UNAVAILABLE` while preserving playback capability and disabling transcript-dependent capabilities (`can_read/can_highlight/can_quote/can_search=false`).
  - transcript feasibility spike runs against a representative YouTube sample and ships reproducible artifacts (fixture-backed checks + dated probe report) with success/failure rates, failure categories, and verified playback-only fallback behavior.
  - library search applies a shared transcript-media searchability predicate so transcript-unavailable media is excluded consistently across both `video` and `podcast_episode`.
  - visibility + processing-state + media/search regressions remain green with video-specific scenarios added.
- **non-goals**: no frontend YouTube embed/seek UX yet; no non-YouTube providers or channel subscriptions.

### PR-02: YouTube Media Pane + Embed-Safe Transcript UX (planned after PR-01 merges)
- **goal**: ship the end-user video+transcript experience in one media pane using embed-safe YouTube playback and existing transcript interaction patterns.
- **builds on**: PR-01.
- **acceptance**:
  - video playback renders via approved YouTube embed origins (iframe allowlist) instead of direct file-style browser video playback.
  - frontend consumes the typed YouTube playback contract from API and performs no client-side URL parsing for embed construction.
  - transcript-ready videos show co-present in-app playback and transcript interactions in one media view.
  - transcript segment clicks seek embedded playback deterministically to segment `t_start_ms`.
  - transcript highlighting and quote-to-chat for videos reuse existing transcript behavior, including timestamp and speaker metadata when available.
  - if in-app playback fails for a transcript-ready video, transcript reading/highlighting/quote-to-chat remain usable and an explicit source fallback action is shown.
  - playback-only videos present explicit transcript-unavailable state and keep transcript-dependent actions disabled.
  - frontend/e2e regression coverage is added for embed rendering, click-to-seek, playback failure fallback, and transcript-unavailable gating.
- **non-goals**: no advanced player controls (speed/chapters), no semantic ranking changes.
