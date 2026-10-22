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
podcast http and its types; `lib/api/serverState.tsx` (one resource) and
`lib/api/useServerList.ts` (one list, architecture §8.12) own the panes' server
state (shared with the author pane and the metadata overlay);
`lib/podcasts/paneState.ts` owns the podcast failure copy, command runner and
chrome refresh; reusable presentation lives under
`apps/web/src/components/podcasts/*`.

Pane server state: `useServerValue` (one resource) and `useServerList` (one
list) load on their key, refetch when a `stale` token changes, coalesce
refetches (at most one queued, never aborting the run in flight), show the pane
visit's snapshot on return and throw defects at render. A list keeps the
previous view's rows ("Retained · Updating") while a new sort or filter loads,
and a return rereads it only when its `stale` token moved since it was read.
Every podcast write in `api.ts` publishes `Podcasts` after success; the index
and detail panes put its stamp in their tokens, so a change from a pane, a
resource action, the settings overlay or the player rereads them. The detail
head also observes visible local consumption and activation/foreground changes.
episode pages use subscription identity, last sync completion, archive id/update,
entries/metadata/query revisions and filtered consumption. head generations,
count values and settings versions never invalidate pages. an active, visible,
followed pane rechecks head every 60 seconds; hide/departure stops polling and
the lifecycle stream. unchanged head polls retain the loaded pages.

both lists page in batches of 100. detail's aggregate is a separate exact count
over the list's visible episode relation and canonical consumption projection:
available counts each visible media id once; unfinished includes unplayed and
in-progress. filters, order and page size do not change it. detail reads use one
repeatable-read snapshot. the subscription-list unplayed count keeps its meaning.

detail starts collapsed on a fresh visit: artwork, linked authors and counts.
description, other roles, source links and saved playback defaults expand through
an accessible visit-local disclosure. the header projects the detail read's
subscription metadata beside more: a passive decorative 20px check and hidden
`subscribed` text when followed, hidden `not subscribed` text when known false,
and no subscription claim while initially pending or failed. it adds no read or
command; the menu retains subscription actions and settings. both playback
entrances open the single settings overlay. normal sync
is silent. existing feedback notices show recent-check failure/rejection and
unresolved history coverage outside the disclosure; active repair retains its
warning without a callable retry. diagnostics stay in feedback details.

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

followed-show and library-show outputs always include stored `image_url`
(string or null), selected in their existing list queries. `presentPodcast`
projects it into an artwork capability; suggestions omit that capability.
rows never fetch show details or provider metadata for artwork.
`PodcastRowArtwork` owns presentation for each source through `MediaImage` and
the authenticated image proxy. null, pending and failed sources show initials:
the first grapheme of each of the first two uppercased words, or `P` for an
empty title. success hides initials even for transparent images. image and
initials nodes stay mounted across completion, changing opacity only; source
changes remount the artwork child while preserving the row. artwork is passive
with empty alt text and no duplicate accessible name. image delivery retains
original bytes and the existing private one-day cache.
next can report cached failures through `onLoad`; readiness requires positive
`naturalWidth`.

## Android Offline Downloads

Manual episode downloads are a device capability, not Podcast domain state
([offline](offline.md)). An episode whose `external_playback_url` is HTTPS
gets a `Download {media_kind, title, audio_url}` resource action;
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

episode rows and pane titles share the media play/pause, lectern membership and
libraries icons. a membership command on an external episode explicitly admits
acquisition, then applies its destination; it never subscribes. row show-notes
controls and duplicate episode-body commands are removed. notes, chapters and
transcript-request progress keep their reader owners.

Episode Add uses `POST /podcast-episodes/from-discovery`; Subscribe uses
`POST /podcasts/subscriptions`; failed-backfill repair uses
`POST /podcasts/subscriptions/{podcast_id}/backfill/retry`. Subscribe accepts a
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
  never guessed; recent checks record their last rejection observation and history
  retains a coverage warning while continuing safe pages. adding one
  episode answers 409 `E_PODCAST_EPISODE_IDENTITY_CONFLICT` instead. The
  bibliography is rewritten only when the feed's observation (fingerprint)
  changed, and a missing value never erases a stored one (show notes, sidecar,
  duration, date, valid enclosure). automatic acquisition respects the viewer's
  removal marker under the media lock. normal removal retains media/aliases;
  only explicit episode filing/re-add clears the marker. provider/feed merging
  retains contradictory identity observations for ingestion to reject.
- **subscription** (`podcast_subscriptions`) — `subscriptions.py`: row presence
  means following. the row owns recent-check observations and the saved playback
  pair, with its subscription uuid and one settings version. null speed/silence
  mean app defaults 1×/off. settings requests require both nullable fields and
  captured identity/version. identity mismatch conflicts first; an exact desired
  pair is inert; a differing stale pair conflicts. no automatic lectern filling.
- **Backfill** (`podcast_subscription_backfills`, one per subscription, deleted
  with it) — `backfill.py`: the pre-subscription history walk.

Named placement is only `library_entries(podcast_id)`, with `library_entries.py`
as sole writer. `GET /libraries/placements/podcast:{podcastId}` lists where a
show sits; `PUT /libraries/{libraryId}/items/podcast:{podcastId}` is
placement-only and never creates a subscription. Default/All stores no Podcast
entry: each subscription projects one virtual Podcast root and suppresses its
child episode roots. Subscribe adds named destinations (a Library holding direct
episodes of the show answers 409 `E_PODCAST_REPLACES_EPISODES` with the counts;
resending with `replace_episodes: true` replaces them; placement through
Libraries… takes the same flag); unsubscribe deletes the row (the backfill cascades), removes the
viewer's sole-owned placements and keeps shared ones; episodes resurface in All
with their progress.

- **Subscription-settings UI — `PodcastSubscriptionSettingsOverlay`.** The
  app-level resource overlay is the only load/draft/save lifecycle owner: it
  loads the subscription and saves one PATCH through `lib/podcasts/api.ts`. The
  save (and the player's
  remember playback) publishes `Podcasts`, so open podcast panes reread; the
  Library pane rereads on its own topics. There is no install publisher or
  mutation tail.

Feed-controlled urls (rss pages, Podcasting 2.0 chapter json, transcript
sidecars) are fetched only through `net.safe_fetch.safe_get` (feed pages 60 s
for up to 10 MiB, chapters 15 s and 2 MiB). The Podcast Index api is trusted
and uses `net.http_retry.get_json_with_retry` (`provider.PodcastIndexClient.get`,
which browse also calls). Sync, backfill and add store sidecar urls but never
fetch transcripts or enclosures.

worker effects first lock the exact running queue execution, then subscription,
then backfill when applicable, then sorted alias locks, show, media and libraries.
no network io holds those locks. Acquisition takes the
alias locks before `upsert_show` touches the show row; subscribe inserts its own
subscription row `ON CONFLICT DO NOTHING` and takes no alias lock.

Podcast lists keep no revision. A write that moves a show or an episode across
an open continuation (an ingest, a title or credit change, listening) falls
under the keyset guarantee (architecture §8.12); the tab that made the write
rereads. The followed list's recency orders break ties on the follow time,
never on `updated_at`.

## Sync and backfill

`sync.py` owns `Pending → Running → Complete | Failed`. admission preserves the
last observation and stores the exact admitted `sync_job_id`. a worker must own
both its queue execution and that job id before start, ingest or settlement;
terminal settlement clears the reference. stale workers and old dead letters
write nothing. the queue's terminal callback transaction already supplies its
execution fence; callbacks still qualify domain identity.

subscribe/manual refresh admit one job under the subscription lock; an active
check is joined. the due sweep runs every 15 minutes, selecting at most 100 due
terminal rows. successful checks observe the provider's newest 100 and feed head,
then schedule 23 hours plus stable 0–30 minute jitter. failure backs off 15m/1h/6h/24h.
full windows and next-page links are normal bounded coverage. success replaces
`sync_had_rejected_items` and clears its error; failure preserves prior rejection
evidence. null means no observation under this contract. every terminal check
advances `sync_completed_at`.

`backfill.py` walks the observed pre-subscription history chain at its original
cutoff, including undated items. one page per job; safe continuation is committed
atomically with ingestion/cursor advancement and becomes available one second
later. there is no lifetime page cap. rejection accumulates without stopping later
pages. cycles and unsafe continuations fail distinctly; fetch/parse failures use
the existing queue retry/dead-letter policy. completion means the observed chain
ended, independently of rejected-item coverage.

history output is its id, derived state, update time and nullable unresolved
error pair. retry captures `expected_backfill_id`, locks the subscription, and
replaces only that terminal problem with a new uuid at the same cutoff. unresolved
errors survive admission; clean completion clears them. repeated old requests
return `NotEligible` with the current history. menu and notice capture the same
identity; running repairs offer no retry.

the active pane observes full lifecycle snapshots through the existing SSE route;
subscription/backfill notifications carry the subscription id. snapshots include
subscription identity, recent state/completion and history facts. terminal streams
close; the bounded head observation above detects later scheduled checks.

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
  source terminal owns ready-state and one semantic job.
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
index through `media_content_reindex_job`, the media's one index job: publishing a
transcript retracts the old index, and the attempt's success (or, for YouTube
captions, `write_current_transcript`) requests the next revision. `media_transcript_states.transcript_origin`
records `Publisher`, `Imported`, or `Generated` while the transcript is
Ready/Partial.

Failure raises to the source-attempt owner. A terminal code settles the attempt
through `source_publication.py`, which publishes Media, job and transcript
failure through `podcasts/transcription_failure.py` (`unavailable` for
`E_TRANSCRIPT_UNAVAILABLE`, else `failed_provider`; it imports no provider: the
supervisor path). A retryable failure (Deepgram 5xx, timeout) retries the job;
when its retries run out, its `on_dead` hook (`source_publication.on_dead_letter`) settles a
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
