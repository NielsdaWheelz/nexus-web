# podcasts

podcasts own canonical shows/episodes, per-library automatic delivery, finite
history imports, source traversal and independent playback defaults. library
entries are physical media memberships; shows have no entry and never hide their
episodes. all aggregates member-library subscriptions once per show and is the
parent command scope. subscribe adds available episodes and ongoing delivery to
one destination; contextless subscribe uses the existing default library. finite
import chooses that personal destination or one writable named library and never
changes subscriptions.

the show pane's libraries card contains named subscription destinations, including
read-only rows. its shared title links navigate; inline removal unsubscribes only
that library and keeps episodes. the card's library icon manages named
subscription destinations, including reviewed removal. the header's shared rss
action subscribes personally or unsubscribes everywhere from loaded aggregate
facts. the default destination is
excluded only from card rows, never from subscription state. library changes
invalidate these names immediately within the tab.

library podcast cards and the podcast index share the native `browse podcasts`
plus link. browse has no destination context: discovery and canonical subscribe
both use the personal default; named placement requires explicit selection.
browsing remains available in readable, read-only libraries. all promotes global
unsubscribe; named cards promote local removal with the same projector as the
show's libraries card. confirmed rows remain during failed/refreshing reads, with
their shortcuts blocked. ordinary rows have no expanded panel; actual coverage
warnings and import progress remain.
local removal uses the permission from the same current section read as its rows.

index rows use the shared compact layout below 32em; headers move shortcuts into
more at 479px and below. named menus
contain distinct local occurrence removal and canonical global unsubscribe; all
contains the canonical action once. hiding a focused shortcut returns focus to
more. removal captures displayed successor ids at selection; acknowledged success
focuses the next surviving title, then the card's browse/picker control, then its
section or pane. cancellation restores the opener. list refresh does not own
acknowledgement or this success target.

import and destructive cleanup are separate menu commands. cleanup chooses one
named affected library or everywhere, including while subscribed and for
episode-only destinations. changing scope remounts the review and reads fresh
guards; it never slices an aggregate preview. all four intents use fixed dialogs,
the existing account command owner and retained uncertainty recovery. canonical
admission reads the exact library/show relationship; the default section's
aggregate cannot establish personal membership. destination choice writes
nothing. progress/retry/cancel remain available without subscription rows.
acknowledgement settles the command's feedback condition before offering a
`subscribed` or `import started` receipt. modal and unrelated-work suppression
still apply; authoritative rereads never settle an uncertain command.
command feedback names the observed destination or everywhere, including refusal
and exact-request recovery.

## owners and contracts

`subscriptions.py` owns admission/stop; `imports.py` owns finite operations and
processed identities; `traversal.py` owns one fetched page per durable step;
`sync.py` owns recurring show scans; `ingest.py` owns canonical identities;
`chapters.py` owns chapter source/jobs/publication; `settings.py` owns viewer/show
playback defaults. `subscriptions_query.py` owns aggregate reads and section guards.
all physical placement goes through the [library writer](library.md).

| resource | contract |
| --- | --- |
| `library_podcast_subscriptions` | unique library/show; presence means future delivery; initial import id binds exact create recovery |
| `podcast_library_imports` | finite library/run operation with committed addition/presence counts; one unfinished operation per destination/show |
| `podcast_feed_runs` | one owning finite import or current recurring scan; exact attempt/step/job fences, url worklist and coverage facts |
| `podcast_import_processed_episodes` | temporary import/episode set preserves first processing and later removal intent; retain through failure, clear on completion/cancel |
| `podcast_playback_settings` | independent viewer/show identity/version and nullable speed/silence pair; unsubscribe preserves it |

admission creates rule+initial import or only a finite import, copies known source
episodes and schedules traversal atomically. explicit re-add restores visibility
and retained work; it does not require old episode readability. replaying the same
ids returns current resources without recopying. fresh admission checks exact
library/removal guards; existing different rules/unfinished operations require review.

ongoing delivery occurs only at first canonical insertion, to current rules. known
metadata refresh never refiles. a finite import processes its own observations
once even when another scan discovered them first. validated individual unfile
marks every unfinished destination import processed before deleting. workspace
removal also covers pending destinations without entries. fresh explicit import
can restore an episode; background work never clears viewer suppression.

named unsubscribe keeps episodes; separate cleanup removes all show episodes
there, including manual placements, and preserves personal retention. all stop cascades to affected
non-system member libraries and own default, with confirmation. all/remove deletes
all selected placements/actor lectern items and sets visibility markers while
preserving highlights, notes, attachments, grants, listening history and settings.
read-only affected libraries block the whole operation. no partial parent mutation.

stop previews freeze exact rule/import identities and attempts plus removal fence;
keep ignores changing media revisions so imports cannot prevent stopping. removal
also freezes library revisions/counts. cancellation freezes import identity/attempt,
keeps arrivals and does not stop an ongoing rule. failure retry increments attempt,
retains processed identities and resumes cursor; drained-gap repair restarts at head.
old fetched pages/dead letters cannot affect newer work. cancel never waits on queue
rows while holding show locks.

## source publication

lock order: exact worker queue claim, actor guard when applicable, sorted aliases,
show, run/import, complete sorted media, complete sorted libraries. fetch outside
transactions; commit identities, placement, counts, cursor and next job together.

rss and namespace-aware atom follow next/prev-archive links with requested/final
url dedupe, preserving meaningful case/query. imports include undated/future items;
finite means observed available history, not an exact publication-time snapshot.
unsafe/rejected observations retain coverage gaps while safe branches continue.
fetch exhaustion pauses finite work; clean pages cannot erase earlier gaps.

recurring scans walk the full reachable graph, once per show. successful settlement
schedules the next hourly slot; failure backs off 15m/1h/6h/24h. settlement copies
observation, clears current pointer and deletes the run. no active rule stops the
recurring owner; finite operations retain their independent lifetime. supported feed
traversal requires no directory success. no bulk audio, transcript or model-enrichment
requests occur; those remain explicit operations.

canonical identity is per-show guid/provider/enclosure aliases. title/date are
never identity. a stable guid may gain enclosure aliases; contradictory stored
aliases are rejected and coverage stays explicit. source facts do not overwrite
unchanged enriched metadata. catalog merge transfers current memberships/processed
identities rather than replaying original destinations.

feed fetching uses safe_get (60s, 10mib); chapters use independent bounded jobs
(15s, 2mib). inline chapters publish immediately and supersede external ownership;
absence preserves existing chapters. external url/job identity fences publication,
including a→b→a changes. successful sidecars revalidate after 24h; changed urls
reset freshness. failures preserve old chapters; core imports never await chapters.

chapter ingestion retains every publisher occurrence and its source times. supplied
invalid ends reject the observation with `E_PODCAST_FEED_UNAVAILABLE`; zero-length
intervals remain supplied and cannot support exact scope. source decimal seconds,
including numeric json fractions, floor exactly once to integer milliseconds within
the storage bound. `end_absence_confirmed` records actual absent
ends; existing nulls remain unverified until a new observation. reader navigation may
derive the next later start only from confirmed absence, never lost provenance.

## wire and presentation

library podcast section/detail reads provide relationships and guards in one
snapshot; ordinary media counts/sort/paging exclude that section. api routes use
client-minted ids, typed snake_case envelopes and nullable fields. podcast acquisition,
imports, previews/stops and settings have dedicated routes. ordinary item placement
accepts only media; no old subscription/backfill CRUD, SSE or show replacement path.

web account owners retain exact pending command bytes across presentation close.
unknown outcomes are inspected/retried without rebasing or claiming success.
accepted progress is server-owned and uses visible-tab polling/change invalidation.
no app data or admission drafts enter browser storage. add modes, scope, counts,
coverage errors and keep/remove consequences are explicit. global removal remains
available on show detail after unsubscribing when saved episodes remain.

the subscriptions index, discovery results, live search/context rows and pane
headers share subscription and libraries shortcuts with their complete menus.
global subscribe uses the actual default library; global
unsubscribe reviews every destination and keeps arrived episodes. libraries
manages named subscriptions, including checked, locked read-only memberships.
one choice opens the existing exact subscription or scoped removal review;
cancel or acknowledgement closes the whole flow. finite import remains separate.

`POST /podcasts/action-facts/resolve` is an authenticated, read-only snapshot of
1–100 distinct canonical/sealed discovery targets, in input order. canonical
visibility matches detail: catalog existence. discovery decoding resolves local
provider identity even when unsubscribed; a valid local miss is `Discovery`,
not provider availability. missing ids and invalid signed targets are explicit
unavailable results. malformed requests fail validation. resolution performs one
catalog batch and reuses aggregate `podcast_states`; it contacts no provider and
acquires nothing.

`usePodcastActionFacts` belongs to the containing view. its account/scope/target
set owns one cancellable read, sequential chunks of at most 100 and publication
only after all chunks succeed. the last canonical observation supplies every
alias's subscription state. changed target sets clear facts; same-key refresh
retains disabled presentation. podcast/library changes and foreground observation
reread local facts without repeating directory content reads. failed or refreshing
facts authorize no new shortcut. sealed row identity and admitted command identity
never migrate when local resolution becomes canonical.

the account action owner retains one scoped library-creation helper and loss
guard. creation retries preserve the exact uuid/name. only the originating live
chooser can advance to subscription review; dismissal leaves an empty created
library and never subscribes or reopens. account feedback retains recovery after
dismissal. checks always describe acknowledged subscription, never proposed choice.

the podcast overview uses one visit-local expansion state for its panel and
existing disclosure button: `show more` with a right chevron when closed,
`show less` with a down chevron when open. shared button anatomy owns the
decorative icon; visible text names the action. visits retain their own expansion
and the existing trigger retains focus recovery before hiding panel content.

## episode-wide commands

whole-show state and unfinished-lectern actions use the shared
[collection actions](collection-actions.md) contract. filtered podcast state
commands name their state selection explicitly and use the same projectors and
account owner. unfiltered commands appear only once. collection selection never
walks browser pages or follows the current sort/text filter.

transcript forecast/admission retains its episode owner and exact count/scope
review. preparation belongs to the current visit; admitted requests and uncertain
outcomes belong to the account. retry/inspection never infer acknowledgement from
reads. there is no transcript behavior or cost-estimation change.

acknowledged state changes publish `Podcasts` and `Consumption`; acknowledged
transcript batches publish `PodcastEpisodes` and invalidate imports. unknown
outcomes, conflicts and inspection invalidate reads without announcing a commit.
episode lists and retained summaries observe `PodcastEpisodes`. an active visible
pane polls queued/running transcripts; each changed current id/transcript-state
signature invalidates retained summaries after that observation. stale in-flight
summary replies are discarded. unchanged observations end the refresh chain;
settings/head-only writes do not invalidate episode pages.

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

## Transcription

recurring scans and finite imports store observed rss sidecar references without fetching
transcript content. discovery-only add currently does not observe those references
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
stream owns updates.
readable full/partial text mounts the shared reader and tools; failed document reads
remain reader retries. available publisher notes occupy one expanded `show notes`
card before transcript content, including document loading and failure. absent notes
omit the card. notes use the existing content scrollport and surrounding typography
and palette; restored reading destinations retain precedence. playback remains in the
canonical header action; body playback explanations and chapter inventories are gone.

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
