# offline (android)

owner of: immutable episode packages and document reading copies on android
14+, the ordinary private `/downloads` workspace pane, the isolated shelf reader
for non-episode copies and reading-position delivery.

## the idea

the device owns acquired bytes and readiness. the ordinary workspace lists every
download independently of catalog coverage; account-menu navigation opens its
`/downloads` pane without leaving mounted writing. episode rows open ordinary
`/media/{id}` and use the global native player. a reading-copy action guards the
actual document exit, then opens the isolated shelf. its return control opens
`/downloads`; the shelf has no management list.

saved episodes resolve their package before remote detail reads. a new online
open can promote the complete saved presentation to the ordinary live pane;
reader intent pins the saved view so a late reply cannot discard interaction.
offline opens stay saved across reconnect. `?view=downloaded` explicitly pins the
package, and `?view=live` explicitly selects the current server presentation.
media location links retain `loc` alongside at most one `view=downloaded|live`;
unknown query keys, unknown view values and duplicate selectors are refused.
live refusal keeps usable downloaded content. saved transcripts use the shared
reader with no progress port, annotations or automatic playback highlighting.
contents, selection/copy and published timestamp seeks remain available.

## parts

| owner | path | contract |
| --- | --- | --- |
| content store | `apps/android/.../offline/OfflineStore.kt` | account namespace, durable acquisition intent, immutable packages, optional slots, reading positions, leases and local streams |
| transfer jobs | `offline/OfflineJobService.kt`, `Transfers.kt` | persisted user-initiated transfer job, media policy, complete-body validation, staged publication and interruption recovery |
| reading sync | `offline/PositionSync.kt` | existing reading-generation/base-revision delivery and explicit conflict resolution |
| native boundary | `offline/OfflineBridge.kt`, web `lib/offline/localContent.ts` | `nexusLocalContent` commands and revision invalidations on the installed and shelf origins |
| local routes | `AppRouter.kt`, `offline/ShelfRouter.kt` | account-bound fixed index/component reads and the isolated reading-copy origin |
| presentation | web `downloads/DownloadsPaneBody.tsx`, `shelf/ShelfReader.tsx` | workspace management and the shared reader over non-episode copies |
| server acquisition | `services/episode_download.py`, `services/reading_copy.py` | one captured episode snapshot and pinned transcript bytes; existing reading-copy archives |

## acquisition and publication

an episode enqueue supplies only `{media_id,title}`. the provisional title grants
no playback authority. native mints `package_id`, obtains the authenticated fixed
`GET /media/{id}/episode-download` capture, and persists it before touching the
publisher enclosure. retries reuse that capture and package. a capture includes
its real consumption observation, settings, rendition, sanitized notes and
published-transcript identity; source refusal never retires an acquired package.

required audio streams to `staging/{package_id}/audio`. strong-etag range resume
appends only the exact pinned remaining representation; a changed response starts
from zero. declared and final full lengths must agree. every output chunk keeps
the 512-mib reserve, including unknown-length bodies. media3 inspector 1.11.1 uses
playback's default media-source/extractors, requires an unencrypted audio track
handled by the default renderer capabilities, and bounds inspection to 30 seconds.
renderer construction, capability probes and release share one private looper;
future waits stay off the app/player looper. inspection closes the retriever,
cancels futures and releases renderers without playback or audio focus.

`episode.json` is `{format_version:1,account_id,media_id,package_id,capture,audio}`;
`audio` contains validated `byte_count`, `mime` and nullable measured `duration_ms`.
source duration remains in the captured rendition. payload and manifest are synced,
the package directory is renamed to `episodes/{package_id}` and its parent synced,
then the next atomic state commits before memory publishes `Ready`. the required
recording and manifest never change in place.

artwork and transcript slots are independent `Absent|Pending|Ready|Failed` values.
transcripts use the captured source key and complete serialized-body sha256/length;
a changed publication is refused, never silently recaptured. artwork retries use
the captured url. each optional component is staged/synced/replaced before its
matching slot commits; a successful slot never refreshes implicitly. optional
failure leaves ready audio usable. limits are 512 kib notes and 8 mib each for
transcript/artwork; excess is explicit unavailability, never truncation. notes
retain formatted text, links and truthful inline-image placeholders. acquisition
does not generate a transcript or download linked pages.

reading copies retain their authenticated archive/baseline operation and CRC/path
validation. each attempt has a unique staging directory, preventing canceled work
from writing a replacement attempt. a retry rebuilds its archive. both transfer
kinds use the configured unmetered/any-connected policy. schedule rejection is
`Failed/Scheduler`, not fictitious running work. a replacement job joins canceled
writers before reusing resumable package staging; sign-out drains all workers.

## state, recovery and leases

`initialize()` loads/reconciles on io before local admission. the format-3 atomic
state owns account, policy, acquisition captures, optional slots and reading-copy
positions. replacement commits before memory changes; a failed state write cannot
make a later enqueue falsely report an acquired package. operational write failures
remain actionable while the last durable intent remains authoritative.

startup converts format-2 reading copies without changing their positions. former
audio lacks capture/baseline authority and becomes `Failed/NeedsDownload`, with no
package or local-play action. its old files stay until explicit removal or
`download again`; that action mints a fresh package and capture. there is no old
audio reader. invalid/incompatible state preserves all files, refuses content
admission and exposes a typed repair error while other device stores remain usable.

system interruption requeues required work without exposing partial readiness.
recovery discards renamed-but-uncommitted required packages and optional components;
committed optional identity/length checks do not require hashing every supplement
before shell startup. component reads verify their pinned digest. task-manager stop
and force-stop are detected through a newer `ApplicationExitInfo.REASON_USER_REQUESTED`
relative to the persisted process-start timestamp; interrupted intent becomes
`Failed/Stopped` with explicit retry. recovery does not depend on `onStopJob`.

`openEpisode(media_id)` atomically returns a package-bound `EpisodeLease` with audio,
rendition, playback baseline, measured duration and the currently committed optional
artwork file. it reads validated native facts without a remote request. the loaded
source never refreshes its artwork/title/chapters from later network or optional
work. remove prevents new leases and defers deletion until the last close. pause
retains the lease; replacement/dismissal releases it. listening history belongs to
[playback](player.md), independently of package removal.

reading-copy leases retain their account namespace across document cleanup. every
local response stream registers for account retirement, including in-memory index
streams. explicit sign-out closes streams and drains workers before purge; old
results cannot publish into a replacement account or package.

## bridge and local reads

`window.nexusLocalContent` is the only content bridge identity; there is no old-name
alias. strict snake_case json commands fit 64 kib. `hello`, push and successful
mutation receipts carry process-monotone decimal-string `revision`, never a whole
index or document. mutations run on io and receipt follows durable intent/state,
not completed network transfer; push precedes its causal receipt. account/document
retirement clears subscriptions, cached indexes and causal waits.

commands are:

- `enqueue {subject: Episode{media_id,title}|ReadingCopy{media_id,media_kind,title}}`;
- `cancel|retry|remove {media_id}`, `retry_extras {media_id,package_id}`, `policy {value}`;
- `open_reader {media_id}` for ready non-episode copies, plus reading `open|close`,
  `save {media_id,locator,base_revision,expected_reader_generation,adopt_unresolved}`
  and `resolve {media_id,choice:Canonical|Device}`;
- `open_hosted {path}` and `purge`.

`/_nexus/device/downloads.json` and `/shelf/downloads.json` share one implementation:
`{account_id,revision,policy,auth_required,consumption_revision,items}`. all download
rows appear in enqueue order regardless of catalog coverage. the explicit limit is
10,000 rows/16 mib; no truncation. `consumption_revision` is the numeric accepted
reading-save invalidation counter, independent of index/server observation revisions.
accepted canonical saves advance it even when an equal locator preserves cursor
revision. the adapter still publishes consumption invalidations.

rows carry `{media_id,kind,title,state,failure,attempts,received,total,size_bytes,
saved_at,progress,package_id,extras}`. missing values are null. package identity
exists from episode intent; extras are null before capture and for non-episodes.
reading progress remains `Canonical{snapshot}`, `Conflict{canonical,device,adopt_unresolved}`
or `Pending|ContentChanged|SourceUnavailable{baseline,device,adopt_unresolved}`.

`/_nexus/device/episodes/{media_id}/{package_id}/{episode.json|transcript.json|artwork}`
serves committed matching resources only. absent/removed/mismatched identities are
404; unreadable/incompatible local data is a typed error. json reads require the
normal wire header; web artwork uses header-aware blob fetching. the shelf serves
only its fixed index, packaged reader and confined copy paths, with no added allowed
origin or renderer-supplied credentials/path. its csp/router prevent remote subresources.

reading `PUT /media/{id}/reader-state` retains generation/base-revision fences.
canonical refresh does not move an open copy's baseline. changed content/source
refusal keeps local position evidence; unresolved canonical evidence is adopted
only through explicit `read from here` or the existing choice flow.

**reading copy** `POST /media/{id}/reading-copy` (the bff's copy lane: 280 s,
`maxDuration = 300`) builds the zip, stores it at
`media/{id}/reading-copies/{uuid}.zip` (no row owns it; the orphan sweep
reclaims it after a day) and answers `{data: {url, expires_at, generation}}`:
a signed url fetched without credentials, and the publication generation the
copy was built from. 404 `E_MEDIA_NOT_FOUND`, 409
`E_MEDIA_NOT_READY|E_READER_CONTENT_CHANGED`. a retry builds another copy.
members: `reader.json` =
`{media: {id, title, kind}, document: ReaderDocumentOut}`, the document as
`GET /media/{id}/reader` builds it except that a pdf's `file.url` is the member
`document.pdf` and web article images are text placeholders; plus
`document.pdf` or `assets/{asset_key}`. the build reads one repeatable-read snapshot, releases
it, then streams objects; a vanished object is `E_READER_CONTENT_CHANGED`.

`x_article_content` is a required nullable reader-document field. api/browser
representation notices survive in the copy and use the shared reader chrome,
outside authored text. downloading a thread does not download its article child.
archives missing this field are refused without rewriting bytes or positions;
this includes all text archives made before its introduction. sync/check pending
positions before removing and downloading again: removal deletes device progress.
web article images remain text placeholders, not archived assets.

**position fence** `PUT /media/{id}/reader-state` accepts an optional
`expected_reader_generation`; when present the publication generation must
equal it, else 409 `E_READER_CONTENT_CHANGED`.

## states and copy

- acquisition says `queued`, then bytes received, with a denominator only when
  known. the configurable mobile-data policy is separate from the actual wait
  reason; a queued row never invents a wi-fi wait.
- ready audio says `downloaded · {size}` with ordinary play. missing optional
  artwork or transcript never disables it. no published transcript, partial
  coverage, pending acquisition, download failure, size limits and changed
  publication have distinct copy. retry missing content retains the same
  package; changed publication directs explicit removal and redownload.
- source refusal says `original no longer available · downloaded copy kept`;
  listening remains saved locally, with explicit sync retry. sign-in language
  applies to remote download/sync work, never local playback or reading.
- removal during a lease says `removal pending · episode still open` or
  `removal pending · copy still open`. pausing audio retains its lease.
  episode removal keeps listening history; removing a reading copy with an
  unsynced position uses the existing confirmation dialog.
- list completion/failure announces once, never on byte-progress ticks.
  removal recovers owned focus to a surviving row or heading. publisher notes
  remain expanded formatted text with links and image placeholders; empty
  sections are omitted. artwork failures remain optional and visible.

## invariants

- ready audio means complete supported bytes, matching immutable capture and a real
  consumption baseline; optional content does not own audio readiness.
- local playback/reading never depends on remote admission. remote refusal affects
  synchronization/acquisition, and explicit sign-out retires the account namespace.
- bytes publish before their state; state commits before memory. cancellation,
  removal, policy replacement and account retirement cannot publish stale results.
- collection membership belongs to the catalog; download discovery is independent.
  queue lifetime never owns a downloaded episode's listening history.
- reading position conflicts remain explicit; offline episodes add no notes,
  highlights, reader-position writes or automatic transcript following.

## not here

adaptive/drm/video downloads, automatic subscription downloads, eviction, a browser
corpus replica, server download jobs/audio proxy, or offline mutation parity.
remaining installed-release requirements live in
[offline episodes release steps](../issues/release-offline-episodes.md).
