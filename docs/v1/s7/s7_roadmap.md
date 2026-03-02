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
