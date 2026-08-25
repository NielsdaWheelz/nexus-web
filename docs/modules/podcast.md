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
`python/nexus/services/net/*`. Transcript admission, reservation settlement,
and terminal failure are separate owners in `podcasts/transcription_usage.py`,
`podcasts/transcription_reservation_settlement.py`, and
`podcasts/transcription_failure.py`; none imports the provider adapter on the
background supervisor path. Frontend pane composition lives under
`apps/web/src/app/(authenticated)/podcasts/*`; reusable Podcast contracts and
controllers live under `apps/web/src/lib/podcasts/*`, and reusable presentation
lives under `apps/web/src/components/podcasts/*`. The Nexus Import session
composes the OPML import boundary from
`apps/web/src/lib/podcasts/opmlImport.ts`; it owns local file admission, one
destination set, and aggregate result presentation, while the podcast backend
remains the sole XML/feed/import policy owner.

Followed-show and episode pane text filtering is local Pane Search over the
exhaustively loaded current domain view. It matches title and contributor
display/credited names, preserves the server-owned state/sort order, and never
enters URL, request, cursor, snapshot, or published pane-header metadata. The
list APIs reject
`q`. Episode-wide Mark Played and transcript selection is state-only and
server-resolved; while a local query is active those commands remain
discoverably disabled because rendered rows never define command scope.

The subscription `filter`/`library_id`/`sort` and episode `state`/`sort` pane
state is URL-owned and decoded by one strict, total codec per surface
(`lib/podcasts/subscriptionView.ts`, `lib/podcasts/episodeView.ts`). Canonical
values are omitted, so a fresh `/podcasts` or `/podcasts/{id}` carries no query
and performs no replace on mount. An unknown value, an empty value, a duplicate
key, or an explicitly written default is `Invalid`: the pane renders
`Invalid podcasts view` / `Invalid episodes view` with `Reset view` and issues
no request. There is no permissive decoder, no component state mirroring the
URL, and no effect that canonicalizes the URL after the fact. The podcast HTTP
API is unchanged — the panes still send every list parameter explicitly,
including default values.

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

- **Current transcript publication — `transcripts.current`.** This is the single,
  advisory-locked writer of `podcast_transcript_segments`, `fragments`, and
  `media_transcript_states`. Non-source import uses `write_current_transcript`,
  which also makes Media readable and admits semantic work. Fenced source ingest
  uses `publish_source_transcript`, which publishes artifacts only; the common
  source terminal owns ready-state, one semantic job, and one media-fact revision.
  Neither caller re-implements the replace → insert sequence. The owner holds
  `pg_advisory_xact_lock('transcript-current:{media_id}')` for the whole sequence
  and runs in the caller's transaction (`transaction()` is non-reentrant).

- **There is no active transcript pointer or version table.** The current transcript is the
  set of `podcast_transcript_segments` and `fragments` for the media. Re-transcription
  deletes those rows and installs replacements in the same locked writer path.

- **Subscription and Library facts.** A `podcast_subscriptions` row means active;
  unsubscribe deletes it. Named placement is only
  `library_entries(podcast_id)`, with `library_entries.py` as sole writer.
  `GET /podcasts/{podcastId}/libraries` is registered by the always-available
  Library relationship router, not the optional provider-ingestion router.
  `PUT /libraries/{libraryId}/podcasts/{podcastId}` is placement-only: it
  requires and transactionally rechecks the active subscription, uses a stable
  idempotency key, and never creates a subscription. An existing unsubscribed
  Podcast remains a canonical actionable resource; its placement inventory
  exposes named destinations as blocked with `RequiresSubscription`.
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

- **Subscription-settings UI — `PodcastSubscriptionSettingsOverlay`.** The
  app-level resource overlay is the only load/draft/save/reconcile lifecycle
  owner. `PodcastSubscriptionSettingsDialog` is presentation-only, and
  `lib/podcasts/subscriptionSettings.ts` strictly decodes the complete GET/PATCH
  envelopes, serializes mutations, and publishes canonical installs. Podcast,
  Podcast-detail, and Library panes subscribe directly to that install
  publisher to refresh their local projections; they do not instantiate a
  second modal controller or persist a hidden settings draft.

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

The active Podcast detail pane converges those independent workers through
`/stream/podcast-subscriptions/{podcast_id}/events`. PostgreSQL triggers on the
subscription and backfill publish only the subscription epoch UUID to
`podcast_subscription_events`; the stream resolves viewer + Podcast to that
epoch, rechecks the same owner and epoch on every fresh snapshot, and closes
only when both live sync and backfill are terminal. The web compares the initial
snapshot to its installed detail, serializes changed-snapshot revalidations, and
aborts observation on pane deactivation or unmount. Replacing a subscription
epoch closes the old listener without emitting the replacement and reconnects
the direct stream against the new epoch. It does not poll, start a manual
refresh run, or treat a globally reused episode as new ingest.

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

The public transcript request service is a media-kind dispatcher; one private
Podcast Episode owner holds sidecar/readable/inflight/quota/fresh-admission
precedence. Current transcript lifecycle persistence, artifact publication, and
semantic-job admission have separate owners under `services/transcripts/`.
Semantic repair is zero-cost indexing work: it serializes on Media, inventories
the canonical queue, never invalidates collection rows, and a repeat against a
live repair job is audit-only idempotency.

Single-Episode and fingerprinted query admission share that private owner but
have different transaction boundaries: a single quota rejection commits only
its immutable audit, while a query admits every selected Episode or none. Each
request locks Media before mutable admission decisions, and source ingest binds
the accepted attempt plus durable job inside the caller-owned transaction.
Enqueue defects propagate and roll the transaction back; there is no failed
enqueue response, fallback state, or `enqueue_failed` audit compatibility path.
If a publisher sidecar cannot produce segments, generated-fallback admission
returns `Admitted | RejectedQuota` through the source fence. Rejected quota
commits the immutable request audit first; the worker then publishes terminal
source/transcript failure under its next exact fence without charging usage.
Generated fallback and operator requeue reserve usage and reset the execution
job without deleting current segments/fragments or downgrading readable
transcript state. The prior current projection survives until the fenced
transcript writer replaces it atomically; the requeue publishes one shared
media-fact revision, not an additional Podcast-only bump.
Publisher and generated success callbacks are collection-pure and never enqueue
semantic work. The common source terminal publishes both effects once after the
artifact fence succeeds. Starting an already-admitted Episode attempt still
counts its processing attempt, but does not publish a second unchanged
`extracting` collection revision.
Terminal Podcast failure settles the source attempt once, then publishes Media,
transcription-job, quota-release, and transcript-state failure through the one
Podcast failure owner in `podcasts/transcription_failure.py`. The source
transaction is owned by `source_attempt_failures.py`, and the queue supervisor
only dispatches to that typed owner. That same transaction advances the canonical shared
media-fact collection family set once; it does not layer a second Episode-row
revision over generic source failure.

`podcasts.deepgram_adapter` is a documented non-LLM provider port, not part of the shared
generation runtime. It owns Deepgram diarization fallback, fixture normalization, and podcast
transcript error mapping. The removal gate is a provider-runtime transcription API that can
preserve those podcast semantics. Current repository proof is deterministic at this boundary;
no live Deepgram compatibility claim is implied by the Nexus provider-release capability.

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
