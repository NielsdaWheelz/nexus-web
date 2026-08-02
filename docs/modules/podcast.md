# Podcast Module

## Scope

The podcast module owns Subscribe/unsubscribe, OPML import/export, canonical
Podcast and episode identity, RSS feed sync, episode + chapter ingest, the
independent per-subscription history backfill, and explicit episode Transcribe.
Podcast Index search and read-only Preview are owned by
`python/nexus/services/browse/*`. Listening state, the global player, queue, and
`external_audio` resolution are owned by the [player module](player.md);
transcript chunk indexing is owned by `content_indexing`.

Backend owners live under `python/nexus/services/podcasts/*`, the media-level
`python/nexus/services/transcripts/*`, the YouTube transcript owner
`python/nexus/services/youtube_transcripts.py`, and the egress helpers under
`python/nexus/services/net/*`. Frontend podcast-management owners live under
`apps/web/src/app/(authenticated)/podcasts/*`. The Nexus Import session composes
the OPML import boundary from `apps/web/src/lib/podcasts/opmlImport.ts`; it owns
local file admission, one destination set, and aggregate result presentation,
while the podcast backend remains the sole XML/feed/import policy owner.

Followed-show and episode pane text filtering is local Pane Search over the
exhaustively loaded current domain view. It matches title and contributor
display/credited names, preserves the server-owned state/sort order, and never
enters URL, request, cursor, snapshot, or folio identity. The list APIs reject
`q`. Episode-wide Mark Played and transcript selection is state-only and
server-resolved; while a local query is active those commands remain
discoverably disabled because rendered rows never define command scope.

## Android Offline Downloads

Manual episode downloads are a device capability, not Podcast domain state.
`derive_offline_download_source` alone projects static eligibility and the
private `GET /media/{media_id}/offline-download-spec` contract from the
episode's HTTPS `external_playback_url`; compact episode DTOs carry only
`offline_download_eligible`, never the URL or local state. The web
`OfflineMediaProvider` owns command lifecycle and keyed subscriptions. Android
`OfflineMediaStore` alone owns the durable Media3 index and bytes.

Episode rows thread their keyed local availability through the episode
presenter. That state is independent of subscription, Library, Lectern,
listening, transcript, and later enclosure freshness. A Ready snapshot stays
removable even if the canonical episode later loses eligibility. There is no
server download table, migration, archive copy, or browser/PWA path.

## Browse Acquisition Boundary

Browse and Preview are read-only. Preview may stream a remote episode through
the player's ephemeral `PreviewAudio`, but open, reload, playback, and natural
end create no Podcast, episode Media, subscription, Library entry, queue item,
progress, transcript, or job.

Episode Add uses `POST /podcast-episodes/from-discovery`; Subscribe uses
`POST /podcasts/subscriptions`; failed-backfill repair uses
`POST /podcasts/subscriptions/{podcastId}/backfill/retry`. Each command accepts
the sealed provider target or canonical Podcast identity defined by its route,
re-resolves provider truth before a first write, and is replayable through the
required `Idempotency-Key`. Named Library inputs are additive. Selecting or
opening a discovery result never auto-subscribes.

## One Owner Per Concern

This subsystem was consolidated so each piece of state has exactly one owner. The rules
that matter:

- **Podcast-row identity — `identity.upsert_podcast`.** It is the sole resolve-or-create for
  a `podcasts` row. Resolution precedence is **`provider_podcast_id` first, then normalized
  `feed_url`** (the Podcast Index id is the stable catalog identity; `feed_url` is a mutable
  ref). When the two disagree, the provider-matched row wins and the other row's `feed_url`
  is left untouched. Browse Subscribe and OPML import both route through
  `upsert_podcast`, so importing a feed already subscribed via Browse resolves to the
  same `podcast_id`. OPML synthesizes a deterministic
  `opml-feed-url={normalized_feed_url}` `provider_podcast_id` only when the
  provider has none; a later Browse Subscribe with the real provider id
  converges the row onto it.

- **Episode identity — `episode_identity.py`.** Every acquired episode resolves
  through stable `PodcastIndex | RssGuid | RssEnclosure` aliases in
  `podcast_episode_identities`. Provider ref, GUID, and enclosure aliases are
  normalized and locked before probing; title, publication time, and random
  values are never identity. Alias collisions fail closed instead of selecting
  a winner.

- **Current transcript writer — `transcripts.current.write_current_transcript`.** This is the
  single, advisory-locked writer of `podcast_transcript_segments`, `fragments`, and
  `media_transcript_states`. It is media-kind agnostic: explicit Podcast and
  Video Transcribe call it; neither re-implements the replace → insert → index
  sequence. It holds `pg_advisory_xact_lock('transcript-current:{media_id}')` for the
  whole sequence and runs in the caller's transaction (`transaction()` is non-reentrant).

- **There is no active transcript pointer or version table.** The current transcript is the
  set of `podcast_transcript_segments` and `fragments` for the media. Re-transcription
  deletes those rows and installs replacements in the same locked writer path.

- **Subscription and Library facts.** A `podcast_subscriptions` row means active;
  unsubscribe deletes it. Named placement is only
  `library_entries(podcast_id)`, with `library_entries.py` as sole writer.
  The row owns the nullable playback-rate and pause-shortening defaults;
  nullable pause shortening projects as `Presence<Off | Natural>` and means
  use the Android device default.
  Default/All stores no Podcast entry. Each active subscription projects one
  virtual Podcast root and suppresses all child episode Media roots before
  projection, type filtering, ordering, pagination, and count. Sync, backfill,
  and explicit Episode Add retain physical child entries but cannot change that
  root cardinality. Unsubscribe removes the virtual parent and retained episodes
  resurface in All with their consumption state intact. Subscribe and OPML add
  named destinations; unsubscribe uses
  `remove_unsubscribed_podcast_placements` to remove viewer-owned unshared
  placements and report retained shared placements. Within a named Library,
  parent Podcast placement subsumes direct episode placement.

- **Feed-controlled fetches — `net.safe_fetch.safe_get`.** Every fetch of a feed-controlled
  URL (RSS feed pages, Podcasting 2.0 chapter JSON, transcript sidecars) goes through one
  SSRF-safe chokepoint: scheme allow-list, DNS-resolve + private/loopback/link-local/metadata
  rejection re-checked on each redirect hop, a streamed body read that aborts past a byte cap,
  and an optional content-type allow-list. First-party provider APIs (Podcast Index) are
  trusted and use `net.http_retry.get_json_with_retry` instead — deliberately separate (no
  SSRF guard, honors `Retry-After`). Residual hardening: pin-to-resolved-IP (a custom httpx
  transport closing the DNS-rebinding TOCTOU) is not yet wired.

## Sync Orchestration

`services/podcasts/refresh.py` is the sole admission owner. Scheduled due
refresh, manual Podcast/Podcasts/Library refresh, Subscribe, and OPML all call
one generation primitive and enqueue the same
`podcast_sync_subscription_job`. Manual and due admission additionally create
durable `podcast_refresh_runs` plus one item per subscription epoch. Concurrent
commands either join the active generation or serialize a single generation
bump; the queue dedupe key includes both subscription UUID and generation.

The background lane runs `podcast_refresh_due_job` every 15 minutes. Each pass
claims at most `PODCAST_REFRESH_DUE_LIMIT` oldest eligible rows by
`(next_sync_at, id)` with `FOR UPDATE SKIP LOCKED`, groups them into one run per
viewer, and performs no network I/O. Healthy completion schedules the next
check at 23 hours plus deterministic per-subscription jitter; modeled failures
use the bounded 15m/1h/6h/24h backoff.

`services/podcasts/sync.py` owns the exact queue-attempt protocol. Identity is
subscription epoch + sync generation + queue job/attempt. The worker fences
every claim, checkpoint, and final write against that exact live lease, fetches
and parses RSS once, and persists an ingest checkpoint before the separate
SERIALIZABLE auto-queue/finalization transaction. A retry resumes from the
checkpoint without another feed request or recount. Expected feed failures and
dead-letter exhaustion terminalize the subscription and all joined run items;
unexpected defects remain queue retries. Unsubscribe marks joined items
`Skipped`, deletes the subscription epoch, and deliberately leaves the queue
row for a stale no-I/O exit.

Manual refresh is `POST /podcasts/refresh-runs` with a required
`Idempotency-Key`; canonical snapshots are available by sealed run handle.
Run changes notify `podcast_refresh_events`, and the snapshot SSE route
rechecks ownership on each fresh read before emitting changed `state` frames
and one terminal `done`. Terminal runs/items are pruned child-first after 30
days by the daily bounded `podcast_refresh_run_prune_job`.

Subscribe also creates one `podcast_subscription_backfills` row and enqueues
`podcast_backfill_subscription`. Its immutable cutoff separates pre-subscription
history from live sync. Each job names the backfill ID, expected step, and cursor
digest; the queue claim plus row fence makes replay `Applied`,
`AlreadyApplied`, `StaleJobAttempt`, or `StaleOrUnsubscribed` without a second
write. Every committed nonterminal page enqueues exactly one successor. Exhausted
retries stamp the current fence Failed and retain the dead job for operator
repair; the idempotent Retry command replaces only that failed fence. Live sync
continues while backfill is running, source-limited, or failed.

## Transcription

Add, Subscribe, live sync, and backfill store RSS sidecar references but never
fetch or publish transcript content. Only explicit canonical Transcribe enters
this boundary. Episode Transcribe first tries a valid publisher sidecar through
`safe_get`; if unavailable it applies entitlement/quota admission and runs
Deepgram. Both paths normalize segments and call the current transcript writer.
Transcript chunks flow into the shared `content_chunks` index via
`content_indexing.rebuild_transcript_content_index`; semantic readiness is keyed by the
current embedding provider/model. `media_transcript_states.transcript_origin`
records exactly `Publisher`, `Imported`, or `Generated` while transcript state
is Ready/Partial and is absent otherwise.

`podcasts.deepgram_adapter` is a documented non-LLM provider port, not part of the shared
generation runtime. It owns Deepgram diarization fallback, fixture normalization, and podcast
transcript error mapping. The removal gate is a provider-runtime transcription API that can
preserve those podcast semantics; until then, `make test-live-providers` is the live Deepgram
proof for this adapter.

YouTube video transcripts are a separate non-LLM transcript provider path. The Google
YouTube Data API key proves metadata access only; public transcript/caption acquisition is
performed by the YouTube transcript provider and may be blocked from datacenter IP ranges.
Production deployments that explicitly transcribe arbitrary YouTube videos should configure
`YOUTUBE_TRANSCRIPT_PROXY_URL` with an operator-owned egress/proxy that is allowed to fetch
public captions; otherwise Video Transcribe fails closed as
`E_TRANSCRIPT_UNAVAILABLE`. The
YouTube transcript live proof skips when this proxy is not configured because
the YouTube Data API key proves only metadata and caption-track listing, not
caption download.
