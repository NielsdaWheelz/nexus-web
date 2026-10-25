# podcasts

podcasts separate canonical catalogue access, physical collection membership,
future delivery, finite additions and listening state. a known show lists every
known episode, including unsaved episodes. counts describe that catalogue, not
saved contents or a guaranteed publisher total. playback, transcripts, annotations,
state, queue/lectern and device downloads require no save. source withdrawal and
normal removal preserve canonical identities; this promises no permanent audio copy.

named libraries contain physical episodes. all is their distinct non-system
member-library union, including personal holdings. a subscription requires every
known episode in its exact destination plus future discoveries. subscription,
membership, source coverage and addition progress remain separate facts. catalogue
access never enrolls unsaved episodes in personal search, indexes or suggestions.

`add to library…` chooses one actual destination: personal all or a writable named
library. its review offers `podcast` for available history plus automatic future
delivery, or `episodes` for available history once without changing subscriptions.
the buttons confirm `subscribe` or `add episodes`. an already-subscribed destination
keeps the same review, disables `episodes`, and shows its rule and current addition
progress. explicit `unsubscribe…` opens that destination’s existing stop review.
selection and cancel create no rule or placement. acknowledged empty-library creation
survives cancellation.

bulk addition files only the chosen destination. all uses the account's actual
default uuid; choosing a named library does not create a personal holding. the
primary rss subscribe action still selects the personal default; its unsubscribe
action reviews every destination. the show pane's libraries section lists named
subscriptions, including locked read-only rows; its shared links navigate and its
control opens the same destination/mode manager, including all. library changes
invalidate displayed names immediately within the tab.

library podcast sections and the podcast index share the native `browse podcasts`
plus link. browsing carries no destination context and remains available from
read-only libraries. all promotes global unsubscribe; named menus retain distinct
local unsubscribe and global unsubscribe. confirmed rows remain during failed or
refreshing reads, with shortcuts blocked. ordinary rows have no expanded panel;
coverage warnings and addition progress remain. local removal uses authority from
the same current section read as its rows.

index rows use the shared compact layout below 32em; headers move shortcuts into
more at 479px and below. hiding a focused shortcut returns focus to more. removal
captures displayed successor ids at selection; acknowledgement focuses the next
surviving title, then the section's browse/picker control, then its section or pane.
cancellation restores the opener. list refresh does not own acknowledgement or
this success target.

unsubscribe defaults to `keep episodes`, with an explicit remove choice. global
remove includes every affected destination and individually added episode; named
remove changes only that library. `remove episodes from libraries…` remains
available after unsubscribe when placements remain. cleanup chooses a named scope
or everywhere and reads that scope's own preview. mode/scope changes disarm old
reviews; no aggregate preview is silently narrowed. permission blockers refuse the
whole reviewed scope.

the account command owner retains exact requests and uncertainty recovery after
presentation closes. admission feedback says `addition started` with show and
destination; it asserts admission, not completed history. progress counts committed
`added` and `already present`, with no invented denominator. authoritative rereads
never settle an uncertain command; unknown writes say `change not confirmed`.
modal and unrelated-work suppression still apply.

the show identity keeps its 56px cover, contributor links, counts and explicit
show-more disclosure. expanded description, contributor roles, source links and
playback defaults retain their order and 12px group spacing. description is
primary prose; source/default facts are secondary interface text. no second title.

the show header identifies the show and its section, without subscription counts.
workspace presentation owns the title; shared pane chrome supplies the `Podcasts`
context and suppresses it when it equals the title. live and saved detail publish
section metadata `None` in every read state. body loading/error/retry and existing
refresh controls own read feedback.

## owners and contracts

`catalog.py` owns source-only resolution; `ingest.py` owns canonical episode
identities; `episodes.py` owns catalogue enumeration. `subscriptions.py` owns
admission/stop; `imports.py` owns finite operations and processed identities;
`traversal.py` owns one fetched page per durable step; `sync.py` owns source scans.
`chapters.py` owns chapter source/jobs/publication; `settings.py` owns viewer/show
playback defaults. `subscriptions_query.py` owns aggregate reads and section guards.
all physical placement goes through the [library writer](library.md);
`media_deletion.py` owns guarded episode all-removal.

| resource | contract |
| --- | --- |
| `library_podcast_subscriptions` | unique library/show; requires all known episode memberships and ongoing delivery; `initial_import_id` binds exact create recovery and initial work lifetime |
| `podcast_library_imports` | finite library/run operation with committed addition/presence counts; one unfinished operation per destination/show |
| `podcast_feed_runs` | one owning finite import or current source scan; exact attempt/step/job fences, url worklist and coverage facts |
| `podcast_import_processed_episodes` | import/episode set preserves first processing and permitted later unfiling; retain through failure/retry, clear after fenced completion/cancel |
| `podcast_playback_settings` | independent viewer/show identity/version and nullable speed/silence pair; unsubscribe preserves it |

admission creates rule plus initial import, or only a finite import; it files known
episodes in the chosen destination and schedules traversal atomically. exact-id
replay returns current resources without recopying. fresh admission checks exact
library/removal guards. an unfinished once addition must finish or be explicitly
cancelled before subscribing; it is never adopted as subscription history. fresh
once admission refuses an already-subscribed destination.

both canonical ingress paths publish newly inserted episodes to current rules.
metadata refresh never refiles an existing episode. a finite addition processes
its own observations once even when another scan discovered them first. permitted
individual unfiling marks unfinished destination additions processed before deleting;
an all-removal covers pending destinations even without a current placement.
a fresh explicit addition can restore a previously removed episode.

individual named unfiling and assistant filing undo refuse while that exact
library/show rule is active. all-removal refuses while any contributing rule is
active, including a read-only shared rule. `E_PODCAST_SUBSCRIPTION_ACTIVE` is a 409;
removal never silently unsubscribes. episode membership cleanup preserves canonical
identity, transcripts, annotations, listening/settings, queue/lectern and device
downloads. it writes no episode hiding marker and manufactures no default retention.

stop preview and execution select identical destinations. keep selects active
rules and only each rule's unfinished initial import; independent once additions
and their permission blockers are excluded. remove selects rules, unfinished
additions or episode placements and cancels all selected unfinished additions.
rules leave before optional placement removal in the same transaction. read-only
affected destinations block the complete operation. named cleanup preserves
pre-existing personal and other-library holdings.

stop guards freeze destination/rule/import identities, attempts and the removal
fence. keep ignores arriving-entry revisions; remove also freezes library revisions.
`PodcastImportOut.subscription_id` derives from the live initial-import binding;
`can_cancel` is false while bound, and cancellation rechecks it. unsubscribe stops
that bound work. independent cancellation keeps committed arrivals and changes no
rule. retry increments the attempt, retains processed identities and resumes the
cursor; drained-gap repair restarts at the head. old fetched pages/dead letters
cannot affect newer work. cancel never waits on queue rows while holding show locks.

individual all-removal uses its own preview/remove routes. the preview includes
member non-system libraries with a placement, show rule or unfinished addition,
including read-only destinations and only the actor's own default. execution
rechecks that exact set, guards and authority under show/media/library locks,
marks the episode processed in affected unfinished additions, and removes placements.
an absent retry is inert only when no current unfinished addition can restore it;
processed identities prove that condition. a newer placement or unprocessed
addition must pass the original guards or refuse. the result reports current
absence, never a causal receipt. generic `DELETE /media/{id}` rejects episodes.

## source publication

lock order: exact worker queue claim, actor guard when applicable, sorted aliases,
show, run/import, complete sorted media, complete sorted libraries. fetch outside
transactions; commit identities, placement, counts, cursor and next job together.

rss and namespace-aware atom follow next/prev-archive links with requested/final
url dedupe, preserving meaningful case/query. imports include undated/future items;
finite means observed available history, not an exact publication-time snapshot.
unsafe/rejected observations retain coverage gaps while safe branches continue.
fetch exhaustion pauses finite work; clean pages cannot erase earlier gaps.

source scans walk the full reachable graph with one current scan per show. a
known unsubscribed show starts or joins one check per distinct remotely admitted
live visit, including after directory resolution. rerenders and polling never
readmit that visit. `check for new episodes` works for every known show; detail,
preview, hover and action-facts reads issue no source work. rows remain during
checking or failure, with explicit check feedback and retry.

accepted scans may finish after the last unsubscribe; publication consults current
rules. only shows with a remaining rule schedule another scan: the next hourly
slot after success, or 15m/1h/6h/24h failure backoff. settlement records the observation,
clears the current pointer and deletes the run. aggregate/library refresh retains
subscribed-show scope. supported traversal requires no directory success. no bulk
audio, transcript or model-enrichment requests occur; those remain explicit.

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
client-minted ids, typed snake_case envelopes and nullable fields. source resolution
uses `POST /podcasts/resolve` and `POST /podcast-episodes/resolve`; neither acquires a
holding or rule. directory opening resolves identity before canonical navigation;
the subsequent live show visit separately admits its source check. library
subscription/import routes retain their guards and exact ids. ordinary item
placement accepts media; no standalone finite-import action remains.

`PodcastEpisodeCountsOut.known_count` and show keyset pages enumerate known catalogue
episodes. requested-media authority admits workspace-readable media or canonical
episodes outside teardown; document and annotation authority remain scoped. episode
`add to all` uses the real default-library placement route with frozen removal/order
guards. named filing remains separate and retains personally. discovery save freezes
the removal fence before source resolution, then reads canonical placement facts
without replacing that fence. open, play and resolve alone never save.

`GET /podcast-episodes/{id}/removal-preview` supplies the complete scope;
`POST /podcast-episodes/{id}/remove` submits its exact destination/rule/import/attempt/order
guards and removal revision. required placement facts
include effective `all_membership`, its actual library id/revision and current
subscription/admin removal blocker. episode actions distinguish `add to all`,
`libraries…` and `remove from all…`; generic document removal keeps its own contract.

web account owners retain exact pending command bytes across presentation close.
unknown outcomes are inspected/retried without rebasing or claiming success.
accepted progress is server-owned and uses visible-tab polling/change invalidation.
no app data or admission drafts enter browser storage. add modes, scope, counts,
coverage errors and keep/remove consequences are explicit. global removal remains
available on show detail after unsubscribing when saved episodes remain.

the subscriptions index, discovery results, live search/context rows and pane
headers share subscription and library shortcuts with complete menus. the primary
rss subscribe action uses the actual default library. the `libraries` card lists
named rules; its `add to library…` manager includes all, writable named destinations
and checked read-only subscription rows. checked rows review that subscription;
new destinations proceed to the shared podcast/episodes mode review.

subscription commands retain the rss glyph and add a monochrome check for an
observed subscription. the check denotes recurring delivery somewhere, not feed
health, completed import or permission. native commands open reviews; they are
not pressed toggles. opening/cancelling a review changes no relationship.

library choice uses the shared search/create picker: anchored and nonmodal on
desktop, a sheet on phones. search stays mounted through loading and retry;
retained checks stay visible during refresh, while unready or failed facts admit
no new choice or creation. errors never claim an empty catalogue. a choice hands
focus to one complete admission or scoped removal dialog; the departing picker
never restores focus during that handoff. cancel or acknowledgement closes the
flow. cancellation restores the opener or logical fallback; acknowledged removal
prefers its supplied surviving target even before stale rows disappear.

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

only ready action facts carry canonical resolution. resolving/failed facts carry
only a nullable last-observed subscription boolean from the existing matching
read; no extra cache or remembered value exists. the containing source's gate
retains priority over the action-facts read. retained checks stay dimmed and
disabled, named `last known subscribed`; descriptions explain checking/failure.
unknown never means unsubscribed. existing account/read-key/source/admission
boundaries govern observation lifetime; changed target sets may clear marks.
observations never settle uncertain commands. the shared subscription projector
owns glyph, menu/state copy, complete inline names, dialog semantics and the
activation guard, including the default-library shortcut's direct renderer.
failed reads report busy only during an actual retry; an old observation's stale
stamp cannot keep retry disabled after the request ends.

the account action owner retains one scoped library-creation helper and loss
guard. creation retries preserve the exact uuid/name. only the originating live
chooser can advance to addition review; dismissal leaves an empty created
library and never starts an addition or reopens. account feedback retains recovery after
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
stream owns updates.
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
