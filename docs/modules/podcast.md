# podcasts

podcasts are the audio specialization of [feeds](feeds.md). the shared owner handles
source identity, subscriptions, history, entry enumeration and removal. canonical
references remain `podcast:<id>` and `/podcasts/<id>`. episodes remain ordinary media;
source ids never enter media placement, player or download commands.

canonical podcast episodes remain globally point-readable outside teardown.
catalogue access creates no personal holding. physical libraries, personal search
and recommendations keep their own membership roots. playback, transcripts,
annotations, queue/lectern and device downloads require no save. source withdrawal
and removal preserve episode identity, without promising a permanent audio copy.

## audio owners

`podcasts/catalog.py` resolves directory identities into the shared source owner;
`ingest.py` owns guid/provider/enclosure aliases and audio metadata. `episodes.py`
projects episode playback facts over `feed_entries`. `settings.py` owns independent
viewer/show playback defaults; unsubscribe retains them. `chapters.py` owns chapter
publication and bounded sidecar jobs. `transcription.py` retains transcript admission.

identity is per-source guid/provider/enclosure aliases. titles and dates never
identify an episode. a stable guid may gain enclosure aliases; contradictory
stored aliases reject the observation and preserve a coverage gap. source refresh
does not overwrite unchanged enriched metadata. canonical merge transfers current
placements and processed identities instead of replaying original destinations.

inline chapters publish immediately and supersede external ownership; absence
preserves existing chapters. external url/job identity fences publication, including
a→b→a changes. sidecars use independent 15-second, 2-mib jobs; successful observations
revalidate after 24 hours. changed urls reset freshness. failure retains chapters;
core source acquisition never awaits them.

chapter ingestion retains every publisher occurrence and its source times. invalid
ends reject the observation; zero-length intervals remain supplied and cannot
support exact scope. decimal seconds floor once to integer milliseconds within
the storage bound. `end_absence_confirmed` records actual absent ends; old nulls
remain unverified until observed again. navigation derives a later start only
from confirmed absence.

## playback and presentation

source state is `unread | in_progress | finished` on the shared wire. podcast
controls retain `unplayed | in progress | played`; transcript and playback commands
translate only at their audio boundary. whole-source state and unfinished-lectern
commands use [collection actions](collection-actions.md); filtered commands name
the exact state selection, independent of loaded pages, text filters and sort.

transcript forecast/admission keeps its exact count and selection fingerprint.
preparation belongs to the visit; admitted commands and uncertain outcomes belong
to the account. observation never implies acknowledgement. transcript batches
publish `PodcastEpisodes` and invalidate imports. the shared source detail polls
its visible observation lane while transcript provisioning runs and invalidates
summaries only after the observed id/state signature changes.

followed-show and library-show outputs always include stored `image_url`
(string or null), selected in their existing list queries. `presentFeed`
projects it into an artwork capability; suggestions omit that capability.
rows never fetch show details or provider metadata for artwork.
`components/ui/Artwork.tsx` owns presentation for every show tile (rows, overview,
metadata overlay, downloaded episode) through `MediaImage`: publisher urls through
the authenticated image proxy, a downloaded episode's saved image as a local blob.
[the app csp still blocks saved blob artwork](../issues/downloaded-artwork-blocked-by-csp.md);
initials preserve presentation without claiming that image delivery works.
absent, pending and failed sources show initials in one box: the
first grapheme of each of the first two uppercased words; an empty title paints
an empty tile. success hides initials even for transparent images. image and
initials nodes stay mounted across completion, changing visibility only; a source
change remounts both layers inside the same box. artwork is passive with empty
alt text and no duplicate accessible name. image delivery retains original bytes
and the existing private one-day cache. next can report cached failures through
`onLoad`; readiness requires positive `naturalWidth`.

episode collection indexes carry no artwork. `MediaSummaryOut.show` (`podcast_id`,
`title`, `image_url`) is non-null exactly for episodes; the sole summary constructor
requires the catalogue identity, independent of following or playback settings.
indexes and live episode outline entries show linked show, ordered authors and
the existing publication date. a matching show's own episode list passes
`containingPodcastId` and omits only its show. same-pane outlines retain it.
captured citations, passages and highlights gain no live show enrichment.

show observations share the existing accepted-publication effect. its account/show
title record survives loading, failure and descriptor changes. the first fresh live
observation and changed titles record before publishing `Feeds`; equal titles
and catalog reads never publish it. the existing summary owner then refreshes all
retained episodes in batches, including episodes outside the displayed selection.
`Entries` comparison remains descriptor-keyed; transcript retry remains separate.
there is no new polling clock or targeted invalidation cache.

bibliography and filtering have separate contracts. `mediaListFilterFields` keeps
released episode matching: title plus show in mixed indexes; title alone on the
show's own list. authors remain visible without becoming episode filter fields.
`playback_snapshot.py` uses the same selection semantics.

saved defaults belong to the viewer/show independently of subscriptions. new
speed choices use `0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3`. player and podcast
form share `PlaybackRateEditor`; retained off-ladder values keep their actual
value at shared display precision until an explicit choice. the range rests at
the nearest stop without marking a choice. the server still accepts 0.5–3.
nullable defaults, skip-silence capability and frozen-pair save/review are owned
by [player](player.md). opening a form never applies or snaps its saved rate.

## Android Offline Downloads

included-show offline snapshots export complete known episode metadata at snapshot
time, with physical membership stored separately. this saves no episode or audio
and grants no write authority. outside snapshot coverage remains unavailable
offline; existing snapshot limits and atomic live-group promotion remain.

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

## Transcription

source scans and finite imports store observed rss sidecar references without fetching
transcript content. discovery-only resolution does not observe those references
([issue](../issues/podcast-discovery-misses-publisher-transcript.md)). only explicit transcribe enters this
boundary (`transcription.py`). Admission precedence for an episode: a readable
transcript only asks for semantic repair; one in flight (transcript `queued |
running` or job `pending | running`) writes nothing; otherwise the episode's one
job row is reset (`reset_podcast_transcription_job`, under the media row lock),
the transcript marked `queued`, and one durable source attempt created. "Transcribe
all ⟨state⟩" forecasts a count and a selection fingerprint, then queues the whole
recomputed selection or nothing (409 `E_SELECTION_CHANGED`): the forecast is the
exactness guard, not vestigial. A video's request imports its YouTube captions.

the episode's transcript admission area displays only `transcribe` before admission,
then truthful queued, running, failed or unavailable states. its mounted processing
observation owns updates.
readable full/partial text mounts the shared reader and tools; failed document reads
remain reader retries. available publisher notes occupy one expanded `show notes`
section before transcript content, including document loading and failure. absent notes
omit the section. notes use the existing content scrollport and surrounding typography
and palette; restored reading destinations retain precedence. playback remains in the
canonical header action; body playback explanations and chapter inventories are gone.
notes retain profile font/size on their public root, reader ink and body leading;
the shared section owns its header. their centered prose measure subtracts the
reader column's two 16px gutters from the profile width, matching transcript
text after removing the section inset. reader-surface/accent tokens still serve
rich content. notes introduce no vertical scrollport or collapse. presentation
issues no seek or progress command; explicit timestamps retain their destinations.

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
