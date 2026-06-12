# Podcast Module

## Scope

The podcast module owns podcast discovery, subscribe/unsubscribe, OPML import/export, RSS
feed sync, episode + chapter ingest, listening state, transcription (Deepgram + RSS
sidecar), and the per-subscription job orchestration. Playback (the global player, queue,
and `external_audio` resolution) is owned by the [player module](player.md); transcript
chunk indexing is owned by `content_indexing`.

Backend owners live under `python/nexus/services/podcasts/*`, the media-level
`python/nexus/services/transcripts/*`, the YouTube transcript owners
`python/nexus/services/youtube_video_ingest.py` and
`python/nexus/services/youtube_transcripts.py`, and the egress helpers under
`python/nexus/services/net/*`. Frontend owners live under
`apps/web/src/app/(authenticated)/podcasts/*`.

## One Owner Per Concern

This subsystem was consolidated so each piece of state has exactly one owner. The rules
that matter:

- **Podcast-row identity — `identity.upsert_podcast`.** It is the sole resolve-or-create for
  a `podcasts` row. Resolution precedence is **`provider_podcast_id` first, then normalized
  `feed_url`** (the Podcast Index id is the stable catalog identity; `feed_url` is a mutable
  ref). When the two disagree, the provider-matched row wins and the other row's `feed_url`
  is left untouched. Subscribe (Discovery) and OPML import both route through
  `upsert_podcast`, so importing a feed already subscribed via Discovery resolves to the
  same `podcast_id`. OPML synthesizes a deterministic
  `opml-feed-url={normalized_feed_url}` `provider_podcast_id` only when the
  provider has none; a later Discovery subscribe with the real provider id
  converges the row onto it.

- **Current transcript writer — `transcripts.current.write_current_transcript`.** This is the
  single, advisory-locked writer of `podcast_transcript_segments`, `fragments`, and
  `media_transcript_states`. It is media-kind agnostic: podcast RSS sync, on-demand podcast
  transcription, and YouTube ingest all call it; none re-implements the replace → insert →
  index sequence. It holds `pg_advisory_xact_lock('transcript-current:{media_id}')` for the
  whole sequence and runs in the caller's transaction (`transaction()` is non-reentrant).

- **There is no active transcript pointer or version table.** The current transcript is the
  set of `podcast_transcript_segments` and `fragments` for the media. Re-transcription
  deletes those rows and installs replacements in the same locked writer path.

- **Library entries — `library_entries.*`.** Subscribe/unsubscribe and OPML routing call the
  library-entries service (the sole writer of `library_entries`); `services/podcasts/` writes
  no library tables. The unsubscribe teardown is
  `library_entries.remove_user_podcast_subscription_libraries` (classify admin-owned
  non-default → removable, foreign-owned shared → retained; delete; renormalize via the one
  canonical ordering `library_entries.normalize_positions`). The subscription-list reads
  (`library_entries.podcast_ids_in_libraries_for_viewer` /
  `visible_non_default_libraries_for_viewer`) and `set_subscription_libraries` live there too.

- **Feed-controlled fetches — `net.safe_fetch.safe_get`.** Every fetch of a feed-controlled
  URL (RSS feed pages, Podcasting 2.0 chapter JSON, transcript sidecars) goes through one
  SSRF-safe chokepoint: scheme allow-list, DNS-resolve + private/loopback/link-local/metadata
  rejection re-checked on each redirect hop, a streamed body read that aborts past a byte cap,
  and an optional content-type allow-list. First-party provider APIs (Podcast Index) are
  trusted and use `net.http_retry.get_json_with_retry` instead — deliberately separate (no
  SSRF guard, honors `Retry-After`). Residual hardening: pin-to-resolved-IP (a custom httpx
  transport closing the DNS-rebinding TOCTOU) is not yet wired.

## Sync Orchestration

The scheduled poll (`poll.run_scheduled_active_subscription_poll`) is a **pure scheduler**:
it claims each due active subscription (`sync_status -> 'pending'`) and enqueues one durable
`podcast_sync_subscription_job` per subscription, then records run telemetry and returns. It
performs no feed I/O. Manual refresh enqueues the same job. The per-subscription job claims
`pending -> running` (`_claim_subscription_sync_pending`), so exactly one sync runs per claim
— a second poll tick or a concurrent manual refresh can never double-write transcript
state. The poll is off by default (gated by `PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS` and
`WORKER_ALLOWED_JOB_KINDS`).

## Transcription

Admission/quota/entitlement (`request_*`, reservation, `can_transcribe`) is unchanged; the
only consolidation is that every path writes the current transcript rows. On-demand
transcription runs Deepgram, normalizes segments (`transcript_segments.normalize_*`), and
calls the writer; RSS sync fetches a sidecar via `safe_get`, parses it
(`rss_transcript_fetch`), and calls the writer with `request_reason="rss_feed"`. Transcript
chunks flow into the shared `content_chunks` index via
`content_indexing.rebuild_transcript_content_index`; semantic readiness is keyed by the
current embedding provider/model.

`podcasts.deepgram_adapter` is a documented non-LLM provider port, not part of the shared
generation runtime. It owns Deepgram diarization fallback, fixture normalization, and podcast
transcript error mapping. The removal gate is a provider-runtime transcription API that can
preserve those podcast semantics; until then, `make test-live-providers` is the live Deepgram
proof for this adapter.

YouTube video transcripts are a separate non-LLM transcript provider path. The Google
YouTube Data API key proves metadata access only; public transcript/caption acquisition is
performed by the YouTube transcript provider and may be blocked from datacenter IP ranges.
Production deployments that ingest arbitrary YouTube transcripts should configure
`YOUTUBE_TRANSCRIPT_PROXY_URL` with an operator-owned egress/proxy that is allowed to fetch
public captions; otherwise YouTube ingest fails closed as `E_TRANSCRIPT_UNAVAILABLE`. The
YouTube transcript live proof skips when this proxy is not configured because
the YouTube Data API key proves only metadata and caption-track listing, not
caption download.
