# Podcast Module

## Scope

The podcast module owns Subscribe/unsubscribe, canonical
Podcast and episode identity, RSS feed sync, episode + chapter ingest, the
independent per-subscription history backfill, and explicit episode Transcribe.
Podcast Index search and read-only Preview are owned by
`python/nexus/services/browse/*`. Listening state, the global player, queue, and
`external_audio` resolution are owned by the [player module](player.md);
transcript chunk indexing is owned by `content_indexing`.

Backend owners live under `python/nexus/services/podcasts/*` (`feed`, `provider`,
`shows`, `ingest`, `sync`, `backfill`, `subscriptions`, `subscriptions_query`,
`episodes`, `episode_acquisition`, `transcription`, `transcription_failure`,
`deepgram_adapter`), the media-level
`python/nexus/services/transcripts/*`, the YouTube transcript owner
`python/nexus/services/youtube.py` (`fetch_youtube_transcript`), and the egress helpers under
`python/nexus/services/net/*`. Terminal transcript failure lives in
`podcasts/transcription_failure.py`, which does not import the provider adapter
on the background supervisor path. Frontend pane composition lives under
`apps/web/src/app/(authenticated)/podcasts/*`. `lib/podcasts/api.ts` owns the
podcast http, its types and the podcast revision; `lib/api/serverState.ts` owns
the panes' server state (shared with the author pane and the metadata overlay);
`lib/podcasts/paneState.ts` owns the podcast failure copy, command runner and
chrome refresh; reusable presentation lives under
`apps/web/src/components/podcasts/*`.

Pane server state: `useServerValue` (one resource) and `useServerList` (a
server-ordered collection) load on their key, refetch when a `stale` token
changes, coalesce refetches (at most one queued, never aborting the run in
flight), show the pane visit's snapshot on return (once: a later return to the
same key loads afresh) and throw defects at render.
Every podcast write in `api.ts` bumps a process-local podcast revision after
success; the index and detail panes put it in their tokens, so a change from a
pane, a resource action, the settings overlay or the player refetches them. The
detail head's token also carries the media query revision, and its generation
feeds the episodes' token, so episodes are always read again after each detail
read. On a pane return the restored episodes are re-read beside the restored
head's first read, then once more after it. A state-filtered episode view also
refetches on the consumption revision.

Both lists load 100 rows and continue on Load more. A continuation echoes the
issuing page's `(cursor, collection_revision)` as one opaque pair; a 409
`E_COLLECTION_CHANGED` reloads the asked-for prefix once (one page longer for a
Load more) and then shows the error with Retry
([ticket](../tickets/podcast-lists-need-keyset-continuations.md)). The header
count appears once a list is complete.

Followed-show and episode text filtering is local over the loaded rows ("found
so far" until the list is complete). It matches title and contributor names,
preserves the server-owned order and never enters URL or request; the list APIs
reject `q`. Episode-wide Mark Played and transcript selection is state-only and
server-resolved; while a local query is active those commands stay
discoverably disabled because rendered rows never define command scope.

The subscription `filter`/`library_id`/`sort` and episode `state`/`sort` view
is URL-owned (defaults omitted) and sent to the API as given, defaults included;
the server validates it. A 400 shows the failure notice with `Reset view`; a 404
from the subscriptions list (podcasts disabled) shows the failure notice.

## Android Offline Downloads

Manual episode downloads are a device capability, not Podcast domain state
([offline](offline.md)). An episode whose `external_playback_url` is HTTPS
gets a `Download{mediaKind, title, audioUrl}` resource-action capability;
episode DTOs carry no download fact. Android's `OfflineStore` owns the bytes
and their state.

Episode rows do not show local download state; the resource menu (Download,
Cancel, Remove, Retry) and the Downloads shelf read the device snapshot. Local state
is independent of subscription, Library, Lectern, listening, transcript, and
later enclosure freshness. A Ready snapshot stays removable even if the
canonical episode later loses eligibility. There is no server download table,
migration, archive copy, or browser/PWA path.

## Browse Acquisition Boundary

Browse and Preview are read-only. Preview may stream a remote episode through
the player's ephemeral `PreviewAudio`, but open, reload, playback, and natural
end create no Podcast, episode Media, subscription, Library entry, queue item,
progress, transcript, or job.

Episode Add uses `POST /podcast-episodes/from-discovery`; Subscribe uses
`POST /podcasts/subscriptions`; failed-backfill repair uses
`POST /podcasts/subscriptions/{podcastId}/backfill/retry`. Subscribe accepts a
sealed discovery target or any persisted Podcast id (catalog facts, readable by
id like its detail); Add accepts a sealed episode target. A discovery target is
re-resolved against the provider with no transaction open: a vanished target is
404 `E_NOT_FOUND`, a failing directory its browse code (503/429
`E_BROWSE_PROVIDER_*`, `browse.targets.provider_api_error`). Every podcast
command is idempotent by construction and takes no `Idempotency-Key`: a repeat
converges on the same rows and reports what it found (`AlreadySubscribed`,
`AlreadyPresent`, `AlreadyUnsubscribed`, `NotEligible`). Named Library inputs
are additive. Selecting or opening a discovery result never auto-subscribes.

## Concepts and owners

Four durable facts, every other surface a read model over them:

- **Show** (`podcasts`, show credits) — `shows.upsert_show`: resolve by
  `provider_podcast_id`, then normalized `feed_url`, else insert (an identity
  race re-resolves); the provider-matched row wins and keeps another row's feed
  url untouched. The provider author is the one `author` credit.
- **Episode** (`media` + `podcast_episodes` + chapters + aliases) —
  `ingest.ingest_episodes` is the only writer. Identity is a set of aliases per
  show (`podcast_episode_identities`): at most one `PodcastIndex`, at most one
  `RssGuid`, any number of canonical `RssEnclosure`. Title, date and random
  values are never identity. An item whose identity is ambiguous (no alias; a
  strong alias a newer item of the batch claimed; aliases naming two episodes; a
  second ref or guid; a known guid on a new enclosure without the stored
  PodcastIndex ref) is skipped, counted and logged (`podcast_episode_skipped`),
  never guessed; the sync or backfill then reads `SourceLimited`. Adding one
  episode answers 409 `E_PODCAST_EPISODE_IDENTITY_CONFLICT` instead. The
  bibliography is rewritten only when the feed's observation (fingerprint)
  changed, and a missing value never erases a stored one (show notes, sidecar,
  duration, date). Every written episode lands in the ingesting viewer's All;
  the slice never deletes episodes (an episode's aliases cascade with it).
- **Subscription** (`podcast_subscriptions`) — `subscriptions.py`: a row exists
  iff the viewer follows the show. The row is also the sync's state and owns the
  playback-rate and pause-shortening defaults (nullable pause shortening
  projects as `Presence<Off | Natural>`, absent = Android device default) and
  auto-queue. Enabling auto-queue starts its watermark at that moment
  (`auto_queue ⇒ auto_queue_watermark_at IS NOT NULL` is a CHECK).
- **Backfill** (`podcast_subscription_backfills`, one per subscription, deleted
  with it) — `backfill.py`: the pre-subscription history walk.

Named placement is only `library_entries(podcast_id)`, with `library_entries.py`
as sole writer. `GET /podcasts/{podcastId}/libraries` is registered by the
always-available Library relationship router. `PUT
/libraries/{libraryId}/podcasts/{podcastId}` is placement-only and never
creates a subscription. Default/All stores no Podcast entry: each subscription
projects one virtual Podcast root and suppresses its child episode roots.
Subscribe adds named destinations (a Library holding direct episodes of the show
answers 409 `E_PODCAST_REPLACES_EPISODES` with a fingerprint; resending it
replaces them); unsubscribe deletes the row (the backfill cascades), removes the
viewer's sole-owned placements and keeps shared ones; episodes resurface in All
with their progress.

- **Subscription-settings UI — `PodcastSubscriptionSettingsOverlay`.** The
  app-level resource overlay is the only load/draft/save/reconcile lifecycle
  owner: it loads the subscription, saves one PATCH through `lib/podcasts/api.ts`
  and reconciles the resource-action snapshot. The save (and the player's
  remember-speed) bumps the podcast revision, so open podcast panes refetch; the
  Library pane refetches on its own facts and visits. There is no install
  publisher, mutation tail or confirmed library-entry revision.

Feed-controlled urls (rss pages, Podcasting 2.0 chapter json, transcript
sidecars) are fetched only through `net.safe_fetch.safe_get` (feed pages 60 s
for up to 10 MiB, chapters 15 s and 2 MiB). The Podcast Index api is trusted
and uses `net.http_retry.get_json_with_retry` (`provider.PodcastIndexClient.get`,
which browse also calls). Sync, backfill and add store sidecar urls but never
fetch transcripts or enclosures.

Lock order, shared by every podcast writer: the subscription row or the backfill
row, then the batch's alias advisory locks (sorted), then the `podcasts` row,
then media rows, library rows and the user row (Lectern). Acquisition takes the
alias locks before `upsert_show` touches the show row; subscribe inserts its own
subscription row `ON CONFLICT DO NOTHING` and takes no alias lock.

Collection revisions exist only to make a list continuation exact. A write moves
a viewer's family iff it can change that viewer's list membership or order:
subscribe, unsubscribe and placement move the viewer's own families; an ingest
that inserted an episode or changed its bibliography, date or duration moves
`ENTRY_VISIBILITY_FAMILIES` for the show's audience (subscribers ∪ members of
libraries holding the show or one of its episodes, `shows.bump_audience`); a
show title change moves `LibraryEntries` and `PodcastSubscriptions` for that
audience. A changed show or episode author credit also moves the credit writer's
families for that target's viewers (`contributor_writes.bump_credit_revisions`,
[contributors](contributors.md#invalidation)). Sync status, settings, backfill progress and transcript states are not
list keys and move nothing (the followed list's recency orders break ties on the
follow time, never on `updated_at`). Writers outside this module (transcript source
attempts, metadata enrichment, listening writes) still move every viewer
([ticket](../tickets/media-fact-writers-bump-every-viewer.md),
[ticket](../tickets/listening-writes-bump-podcast-collection-families.md)).

## Sync and backfill

`sync.py` owns the sync state machine `Pending -> Running -> Complete |
SourceLimited | Failed`. Admission (subscribe, manual refresh, the due sweep)
flips only terminal rows to Pending and enqueues one
`podcast_sync_subscription_job` (payload `{subscription_id}`, priority 75
interactive / 100 bulk) per flipped row under the row lock; an already-live row
is joined, so at most one sync is admitted per subscription and the queue's
single claim runs it. Manual refresh is `POST /podcasts/refresh` with a Podcast,
Podcasts or Library scope (Default = all) and answers 202 with the selected
count, joins included. The background lane runs `podcast_refresh_due_job` every
15 minutes: the oldest due terminal rows by `(next_sync_at, id)`, at most 100,
`FOR UPDATE SKIP LOCKED`, no network i/o.

A run claims the row (`Running`, attempts + 1, `sync_started_at`), fetches the
provider's newest 100 episodes and the feed head with no transaction open, then
in one transaction locks the row while it is still `Running`, ingests the merged
batch (rss items enrich the provider window by guid, enclosure or provider ref;
unmatched rss items are appended), auto-queues each episode published in
`(watermark, sync start]` onto the Lectern once (a full Lectern holds the
watermark for a later sync), and settles `SourceLimited` (window full, a next
page, or a skipped item) or `Complete` with the next sync 23 h plus a stable
jitter ≤ 30 min away. A provider or feed failure settles `Failed` with backoff
15 m / 1 h / 6 h / 24 h; a retry-exhausted job dead-letters to `sync.dead_letter`
(`E_PODCAST_SYNC_RETRY_EXHAUSTED`) so the sweep re-admits it. There is no epoch
or attempt fence: a stalled run that outlived its 900 s lease and overlaps its
retry finds the row already settled at commit and writes nothing (`Stale`), and
episode writes are idempotent by alias anyway. The trade-offs: a stray run whose
own dead letter settled the row Failed, committing after a newer admission was
claimed, settles that newer sync with its older fetch (the next due sync
corrects it); a stray that fails while a newer admission is Pending settles it
Failed and counts one failure against it.

Subscribe also seeds the backfill at the subscription's creation (its cutoff)
and enqueues `podcast_backfill_subscription` (`{backfillId, expectedStepNo}`,
deduped per step). The row is the traversal: `step_no` names the next step and
`cursor` the next page with the visited chain. A step fetches its page with no
transaction open, then, under the backfill row lock and only at its step and
non-terminal, ingests the page's episodes at or before the cutoff (undated
included), advances the step and enqueues the next, or stamps `completed_at` /
`source_limited_at` (a revisit, an unsafe url, 10 pages, or a skipped item). A
page that cannot be fetched or parsed raises: the job retries (60 s, 300 s) and
its dead letter (`jobs/dead_letter_projections._project_podcast_backfill`,
matching backfill id and step) stamps it Failed. Retry backlog replaces a failed
backfill with a fresh one at the same cutoff, else answers `NotEligible`. Live
sync continues while the backfill runs, is source-limited, or failed.

The active Podcast detail pane converges both through
`/stream/podcast-subscriptions/{podcast_id}/events`. PostgreSQL triggers on the
subscription and backfill tables publish the subscription id to
`podcast_subscription_events`; the stream (`subscriptions.read_subscription_lifecycle`)
resolves viewer + Podcast to that subscription, re-reads it on every
notification and closes when sync and backfill are both terminal; a replaced
subscription ends the old stream with 404. The web refetches the detail head
whenever a snapshot differs from the loaded detail.

## Transcription

Add, Subscribe, live sync, and backfill store RSS sidecar references but never
fetch or publish transcript content. Only explicit Transcribe enters this
boundary (`transcription.py`). Admission precedence for an episode: a readable
transcript only asks for semantic repair; one in flight (transcript `queued |
running` or job `pending | running`) writes nothing; otherwise the episode's one
job row is reset (`reset_podcast_transcription_job`, under the media row lock),
the transcript marked `queued`, and one durable source attempt created. "Transcribe
all ⟨state⟩" forecasts a count and a selection fingerprint, then queues the whole
recomputed selection or nothing (409 `E_SELECTION_CHANGED`): the forecast is the
exactness guard, not vestigial. A video's request imports its YouTube captions.

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

The attempt (`run_podcast_transcription_now`) publishes a valid publisher
sidecar (`Publisher`) if it yields segments, else marks the job running and runs
Deepgram in the episode's language (its primary subtag; `en` when unknown),
publishing `Generated`. Transcript chunks flow into the shared `content_chunks`
index through `podcast_reindex_semantic_job`. `media_transcript_states.transcript_origin`
records `Publisher`, `Imported`, or `Generated` while the transcript is
Ready/Partial.

Failure raises to the source-attempt owner. A terminal code settles the attempt
through `source_attempt_failures.py`, which publishes Media, job and transcript
failure through `podcasts/transcription_failure.py` (`unavailable` for
`E_TRANSCRIPT_UNAVAILABLE`, else `failed_provider`; it imports no provider: the
supervisor path). A retryable failure (Deepgram 5xx, timeout) retries the job;
when its retries run out, the `SourceAttempt` dead-letter projection settles a
still-running transcript attempt the same way, so a later request can admit a
new one. Other source types keep their dead job for the source repair offer.

`podcasts.deepgram_adapter` is a documented non-LLM provider port, not part of the shared
generation runtime. It owns Deepgram diarization fallback (a diarized failure retries without
diarization and records `E_DIARIZATION_FAILED` on the job), segment extraction, and podcast
transcript error mapping (408/504/timeout `E_TRANSCRIPTION_TIMEOUT`, other http or shape errors
`E_TRANSCRIPTION_FAILED`, no text `E_TRANSCRIPT_UNAVAILABLE`). The removal gate is a provider-runtime transcription API that can
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
