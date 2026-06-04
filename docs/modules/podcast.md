# Podcast Module

## Scope

The podcast module owns podcast discovery, subscribe/unsubscribe, OPML import/export, RSS
feed sync, episode + chapter ingest, listening state, transcription (Deepgram + RSS
sidecar), and the per-subscription job orchestration. Playback (the global player, queue,
and `external_audio` resolution) is owned by the [player module](player.md); transcript
chunk indexing is owned by `content_indexing`.

Backend owners live under `python/nexus/services/podcasts/*`, the media-level
`python/nexus/services/transcripts/*`, and the egress helpers under
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
  same `podcast_id`. OPML synthesizes a deterministic `opml-{sha1(feed_url)}`
  `provider_podcast_id` only when the provider has none; a later Discovery subscribe with the
  real provider id converges the row onto it.

- **Transcript versions — `transcripts.versions.write_transcript_version`.** This is the
  single, advisory-locked writer of `podcast_transcript_versions` /
  `podcast_transcript_segments` and the owner of `media_transcript_states`. It is media-kind
  agnostic: podcast RSS sync, on-demand podcast transcription, and YouTube ingest all call
  it; none re-implements the deactivate → allocate → insert sequence. It holds
  `pg_advisory_xact_lock('transcript-version:{media_id}')` for the whole sequence and runs in
  the caller's transaction (`transaction()` is non-reentrant). The two unique indexes on
  `podcast_transcript_versions` — `(media_id, version_no)` and the partial `(media_id) WHERE
  is_active` — are the integrity backstop under READ COMMITTED; a lost race surfaces as a
  typed `E_RETRY_INVALID_STATE`, never a lost transcript. `fragment_strategy` carries the one
  real divergence between media kinds: `"preserve_anchors"` (RSS/podcast — bump prior
  fragments aside so highlight anchors survive re-transcription) vs `"replace"` (YouTube —
  delete the media's highlights then fragments first).

- **The active transcript version is resolved by `WHERE is_active`**, not by a denormalized
  pointer. `media_transcript_states` carries no `active_transcript_version_id` column;
  callers join `podcast_transcript_versions ... WHERE is_active` (the partial unique index
  guarantees at most one active row per media). This makes "two sources of truth for the
  active version" unrepresentable.

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
— a second poll tick or a concurrent manual refresh can never double-write a transcript
version. The poll is off by default (gated by `PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS` and
`WORKER_ALLOWED_JOB_KINDS`).

## Transcription

Admission/quota/entitlement (`request_*`, reservation, `can_transcribe`) is unchanged; the
only consolidation is that every path ends in `write_transcript_version`. On-demand
transcription runs Deepgram, normalizes segments (`transcript_segments.normalize_*`), and
calls the writer; RSS sync fetches a sidecar via `safe_get`, parses it
(`rss_transcript_fetch`), and calls the writer with `request_reason="rss_feed"`. Transcript
chunks flow into the shared `content_chunks` index via
`content_indexing.rebuild_transcript_content_index`; the embedding-config hash has one
definition (`content_indexing.compute_embedding_config_hash`).
