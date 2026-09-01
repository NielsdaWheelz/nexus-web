# Durable video copy and timed-media hard cutover

**Status:** Implementation specification · rev 3 (adversarial-review revised)
· 2026-08-31

**Type:** One-release hard cutover. No flag, alias, dual write, permissive
decoder, compatibility view, legacy route, or playback fallback survives.

## Decision

Nexus will let an authorized user **Keep a copy** of a regular public YouTube
VOD as one immutable, seekable H.264/AAC MP4 in private R2 **only after YouTube
has granted prior written approval that expressly covers Nexus, audiovisual
storage/offline playback, and the exact acquisition mechanism**. Podcast
episodes and videos will then use one timed-media session, one playback-state
contract, one player shell, one current-transcript owner, and one Highlight
aggregate.

This is the 80/20 cut:

- one source identity, timeline, account-held copy, and playback rendition;
- explicit copy and transcription commands only;
- segment-timed transcripts, soft follow, moment highlights, and one-cue text
  highlights;
- existing Postgres queue/Heavy lease, R2, media SSE, Consumption, player,
  transcript, Highlight, selection, feedback, and resource-action primitives;
- browser `<video>` for owned video, the allowlisted YouTube embed controlled
  only through Google's documented IFrame Player API for reference playback,
  and the existing native Android audio engine for podcasts.

This PR is the specification only. It contains no migration, service, route,
worker, player, Android, or proof implementation. A documentation-policy PASS
therefore accepts only this document; it MUST NOT be reported as product,
cutover, or acceptance evidence. AC1–AC17 remain `NOT_RUN` until their named
production owners and governed proofs exist at the same exact candidate SHA.
AC18 is `BLOCKED` on the missing written YouTube approval, its signed minimum
disposition-notice contract, and the absence of a documented, signed, bounded
deployed-R2 terminal fence for lost Create/Complete responses
and issued/in-flight presigned UploadSession PUTs;
every other AC18 artifact and release execution remains `NOT_RUN`. `PASS`, `BLOCKED`, and
`NOT_RUN` are distinct outcomes.

Assumptions are: the user keeps only media they own or may lawfully copy; v1
supports non-DRM, non-live, non-playlist public YouTube VODs only inside the
written approval's scope; production remains Nexus Postgres + the existing
background worker + private R2; and video on Android is foreground WebView
playback, not a new Media3 video service. User attestation records product
intent; it is neither legal proof nor provider permission. YouTube's current
policy prohibits storing/offline-playing audiovisual content without prior
written approval and prohibits non-API retrieval; its API-data policy also
limits refresh/retention, access, attribution, and derived use. Therefore the
release gate is an immutable, human-approved compliance artifact naming the
approval id, effective/expiry dates, API project/client, covered policy
clauses, allowed content, exact adapter/version, and four independent closed
capability arms: `AudiovisualCopyApproved`,
`CaptionTransformDisabled | CaptionTransformApproved`,
`OwnedVideoAsrDisabled | OwnedVideoAsrApproved`, and
`YouTubeTimedObservationDisabled | YouTubeTimedObservationApproved`. The caption arm is
`Approved` only when the writing expressly authorizes caption download,
storage, normalization/segmentation, private transcript display and inevitable
user-controlled plaintext copying, timing-based
active-cue synchronization/seek/follow, and owned-copy `VTTCue` overlay, plus
the exact retention/deletion model; silence or a generic API approval is
`Disabled`. If the writing permits static display but not any named timing use,
the entire arm remains `Disabled` in v1 rather than exposing a second partial
caption product. The ASR arm is `Approved` only when the writing separately
authorizes extracting audio from the approved audiovisual copy, transmitting
those exact bytes to the named ASR vendor, creating/storing the derived timed
transcript, and the exact private-use/retention/deletion model. Silence, generic
copy approval, or user consent is `Disabled`; disabled means forecast,
admission, extraction, provider dispatch, and publication contain no owned-
video ASR arm or hidden path.
The timed-observation arm is independently `Approved` only when a dated,
audited YouTube use-case decision expressly permits every Nexus-created fact
derived from YouTube-origin playback: position/history/completion, Listening or
Viewing Activity, temporal Highlights, transcript active-cue/follow timing, and
any associated analytics or retention. It binds the exact API project, player
adapter/version, data fields, purpose, disclosure, retention, and deletion
rules. Generic API access, non-MFK status, audiovisual-copy approval, or an
analytics amendment that does not name these exact uses is `Disabled`. While
disabled, all YouTube-provenance playback is structurally untracked: those
writers/capabilities are absent, not merely hidden by UI. This conservative
gate follows YouTube's prohibition on independently derived API data/metrics
and the separately accepted audited-use-case model in its
[Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
and [additional derived-metrics policy](https://developers.google.com/youtube/terms/derived-metrics-policy).
Caption-derived semantic indexing, Ask/Learn, server/global indexed search,
text Highlight, public share, application export, and AI disclosure remain
forbidden in v1 even under that arm. Ephemeral Find over currently displayed
cues and inevitable user-controlled browser plaintext copy are permitted only
because the approval arm expressly covers them; neither persists an
application artifact.
Its SHA-256 is bound into the release
manifest and checked again at process startup. Missing, expired, broader-than-
approved, or adapter-mismatched truth is a release/startup refusal: the copy
job is not registered and no Keep capability or hidden acquisition path exists.
An approval that covers storage but not the acquisition mechanism is
insufficient. A copy approval never implies either a caption-transform or
owned-video-ASR exception.
Caption OAuth has a separate release/startup gate,
`YouTubeOAuthProductionReady`; provider approval never implies it. Its signed
artifact binds the exact Cloud project/client, **In production** publishing
status, verified domains, home/privacy/terms URLs, redirect URI, enabled
YouTube Data API, exact `youtube.force-ssl` scope, consent brand, data-access
verification result, and dated operator evidence. Settings and route
registration contain no Connect capability unless both this artifact and
`CaptionTransformApproved` are live. A Testing project is categorically
ineligible: Google documents that test-user authorization and offline refresh
tokens for non-basic scopes expire after seven days, which cannot satisfy this
day-28/day-30 lifecycle. Production apps requesting sensitive/restricted scope
must satisfy Google's applicable verification and policy-compliance process;
the release check verifies deployed Cloud state, not a checked-in promise.
For this one-user API client, the compliance artifact, timed-observation arm,
Data API key, OAuth web client, embedded-player identity, and Android Media
Integrity registration must all resolve to one exact Cloud project identity;
there is no implicit cross-project credential pool. A future multi-client
deployment would need an explicit closed client-to-project map in every signed
artifact. Startup and release reject any mismatch.
See Google's [OAuth audience/publishing-status contract](https://support.google.com/cloud/answer/15549945)
and [production-readiness policy-compliance checklist](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).
When the caption arm is disabled, the caption adapter, source-plan member,
OAuth scope, publication provenance, and every hidden caption path are absent;
publisher sidecar and Podcast hosted ASR continue independently. This external copy
approval is currently `BLOCKED`, not inferred from this document or from a
checkbox.

Approval is a live capability, not a startup snapshot. The signed artifact is
revalidated at every capability projection, command admission, immediately
before each provider/API acquisition, and again in the DB publication
transaction. A clock crossing or artifact replacement after admission cancels
the external step, prevents publication, and drives the ordinary verified-
absence/full-reservation-release owners. The artifact carries a closed
post-expiry disposition: an expressly approved `MayRetainUntil { instant }` or the
default `UnpublishAndDeleteBy { instant <= approvalExpiry + 24h }`. It also
validates the signed minimum disposition-notice contract against the
derived active-cohort margin; the 24-hour default is a latest deadline, not
evidence that 32 copies can be drained in 24 hours. API startup
with an invalid artifact enters read-only cleanup mode rather than refusing the
cleanup workers: Keep/caption capabilities and owned playback are absent,
existing owned assets are unpublished, and their normal removal/reconcile jobs
are admitted. The artifact also binds the signed
`PROVIDER_MIN_DISPOSITION_NOTICE_SECONDS` and provider-terminal-path digest;
release derives the safe effective video cohort from those values and remains
blocked when the current cohort cannot fit. Each reserved compliance lane's
supervisor-owned control loop invokes its partition of
`provider_compliance_sweep` at startup/before claim and with an independent
release-proved monotonic cadence no greater than 60 seconds. It owns discovery
of transient OAuth expiry plus copy/caption refresh/deletion deadlines;
provider calls remain in the promoted operation, never the scanner.
`MayRetainUntil` is a maximum permitted retention window, not a promise to keep
bytes until that instant and not an authorization to keep publishing them.
Invalidation always unpublishes immediately and may begin physical removal at
once; the named instant is only the latest permitted absence deadline. A renewed
approval never silently republishes retained bytes. The user must issue a fresh
**Keep a copy…** decision after cleanup, so an old consent or artifact cannot be
revived as authority.
Clock-boundary and already-running-worker proofs kill the process on both sides
of every revalidation point.

Follow `docs/rules/*`, `docs/local-rules/*`, especially
`testing-standards.md`, and the owner contracts in `docs/modules/{video,player,
podcast,highlight,storage,consumption-activity}.md`.

External constraints are normative implementation inputs, not remembered
folklore: Google's [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference),
[embedded-player minimum functionality](https://developers.google.com/youtube/terms/required-minimum-functionality),
and [playback-integrity policy](https://developers.google.com/youtube/terms/developer-policies)
own the documented API, acquisition/storage permission, visibility/size,
overlay, no-background-play, API-data refresh, and client-identification rules;
Google's [Made-for-Kids status contract](https://developers.google.com/youtube/v3/guides/made_for_kids_status)
and [authorized caption download contract](https://developers.google.com/youtube/v3/docs/captions/download)
own tracking and caption access; Cloudflare's [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[presigned URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
and [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
contracts own deletion, bearer, and checksum behavior; FFmpeg's
[command contract](https://ffmpeg.org/ffmpeg.html) owns mapping/metadata
semantics. H records a dated release certification against those primary
sources because provider policy and capabilities may change.

## Goals and rules

- `Copy kept` means verified owned bytes that the canonical player can seek.
- The original URL is provenance and an explicit **Open source** action. It is
  never a silent recovery path for a broken kept copy.
- Media readiness, copy state, transcript state, progress, Highlights, notes,
  and Library/Lectern membership are independent.
- Media time always means original-source milliseconds. Speed, buffering, and
  pause shortening never transform stored time.
- One *current* generation-scoped `MediaTimeline` owns playback, progress,
  transcript cues, chapters, activity positions, and temporal Highlights for
  one Media. Historical generations survive only as provenance.
- `media_timelines.duration_ms` is the sole duration authority for a timed
  Media. Every wire duration projects from it; `PlaybackStateOut` no longer
  carries a duration and the playback-state PUT no longer accepts one — the
  client-supplied duration field is deleted with `/listening-state`.
- Its sealed handle includes `binding_epoch`. Every content-bound timed writer
  locks Timeline and verifies that epoch through one owner gateway.
- One active `PlayerSession` owns transport and timeline state. A canvas is a
  projection, never a second player.
- External work occurs outside database transactions. DB publication is last.
- A stale queue lease cannot publish progress, assets, transcripts, or failure.
  The fencing primitive is a row lock on the exact running claim
  (`lock_and_renew_running_job_claim` semantics: status, claimant, attempt
  number, and lease verified under `FOR UPDATE`, lock held through commit,
  lease renewed) — never a read-only lease check.
- One scoped lock order. Coordination nonlocking-resolves the complete
  OperationRef set. A transaction that prunes an operation or requests
  `ObserveTerminal` first takes the transaction-scoped
  `OperationRefSettlementGate(operationKind, domainOperationId)` for the
  complete relevant ref set in ascending canonical `(kind, UUID-bytes)` order,
  re-resolves under that gate, then ascending-locks the exact `background_jobs`
  target/running-claim rows first, then ascending-locks and revalidates their
  `coordination_operation_jobs` rows, then, when deadline capacity is read or
  mutated, locks the sole `ProviderComplianceScheduleGate` row and exact neutral
  allocations in ascending UUID order, then takes `MediaJobAdmissionGate` when
  creating/activating domain work, then Media -> current-Timeline head ->
  Timeline -> attempt -> viewer -> domain row. Cancel, requeue, terminalize,
  teardown, composite claim, and every batch use the same queue -> correlation
  order; prune and terminal observation use the one named pre-queue gate and
  then that identical order. No transaction may acquire a settlement gate after
  a queue/correlation or domain lock, and no transaction may acquire the
  compliance schedule gate after an account/binding/Media/domain lock. A
  domain-only transaction that needs deadline capacity starts at the schedule
  gate (then Media admission if applicable); another domain-only transaction
  starts at Media. All schedule/OperationRef/allocation identities are
  nonlocking-resolved before the first lock and equality-rederived at the
  schedule rank—no placement discovery occurs under Media. Canonical provider Add is the only pre-Media
  namespace exception: it takes the provider-identity advisory lock first,
  then resolves/locks Media, and never acquires a queue row; no transaction
  may take that advisory namespace after Media. The deadlock proof includes
  concurrent Add/Keep and opposing provider identities. Every Media-bound
  durable-operation creator (primary/supplemental producer, semantic, removal
  retry, reconcile/cleanup, and teardown admission) first takes one
  transaction-scoped `MediaJobAdmissionGate(media_id)` advisory mutex, ordered
  by ascending Media UUID for a batch, before committing its domain
  `AwaitingDispatch` identity. It does not insert, query, or retain a queue row.
  The sole closed exception is the `VideoCopyStorageObject` cleanup reservation:
  while holding the exact copy running claim, then this Media gate, the storage-
  object reservation transaction atomically inserts its path-bound cleanup as
  `Reserved`. That row is not dispatchable and has no OperationRef correlation.
  A later failure/cancel/removal/teardown transaction takes the same Media gate,
  revalidates the exact object/owner and deletion authority, CASes `Reserved ->
  AwaitingDispatch`, commits, and only then uses ordinary postcommit/startup
  admission. No other creator may use `Reserved`.
  Whole-Media teardown takes the same gate, marks deletion intent, inventories
  the now-stable domain operation-ref set, and holds the gate through commit;
  later admission rejects that intent. The post-commit dispatcher (including
  startup recovery) must reacquire the same Media gate and, inside one managed
  coordination transaction, revalidate through the domain owner that the exact
  operation is still `AwaitingDispatch` and teardown is absent before inserting
  its correlation/job. Teardown under the gate terminalizes any no-correlation
  operation; a delayed dispatcher then observes terminal truth and admits
  nothing. It then asks coordination to cancel or promote the exact correlated
  set, so a just-admitted operation cannot be invisible. Provider-identity namespace
  locks, when applicable, precede these Media gates. A transition that creates
  no domain operation never takes the admission gate and keeps coordination
  claim -> Media order. A claimed worker that must create a child cleanup
  operation commits that child—or activates the exact pre-reserved video
  cleanup—through the Media gate in a fresh domain transaction, then awaits
  typed coordination admission; after the gate it rechecks cancellation/
  teardown before the child commit. The barrier proof
  pauses copy, transcript, removal-retry, reconcile, and worker-child admission
  before domain commit, after domain commit/before correlation, and after
  correlation against teardown, and also kills before/after Reserved activation,
  proving neither a phantom writer, dispatchable Reserved row, duplicate cleanup,
  nor a cycle.
  Replay-stable domain ids are generated before admission; domain uniqueness
  and replay identity converge concurrent requests, while coordination
  uniqueness converges duplicate post-commit admits. Removal, copy, transcript, playback-state, Reset progress,
  natural-end settlement, completion/unread, batch playback-state mutation,
  Highlight, chapter, and publication writers use this same Timeline gateway.
  When one transaction touches multiple rows at the same layer (including a
  transcript batch or whole-Media teardown), it resolves the complete lock set
  before the first lock and acquires that layer in ascending UUID bytes; it
  never discovers and locks a later row from input order. The deadlock proof
  submits the same Media set in opposing orders.
  A domain rejection/join commits no `AwaitingDispatch` identity, so no
  coordination candidate exists. A stale correlation without its exact domain
  operation is a coordination defect quarantined by startup recovery, never an
  inferred job.
  The deadlock proof exercises every transaction that acquires more than one
  member of this order, including opposing OperationRef batches and
  prune-vs-terminalize and prune-before-finalizer; it explicitly races video
  Keep/reservation/Fence/teardown, caption refresh/replacement/expiry, owned-ASR
  request/Fence/Finalize, and OAuth start/callback/binding/revocation/account
  erasure in both schedule->domain and queue->schedule->domain directions. No broader undocumented
  global-order claim is made.
  `record_playback_heartbeat` is restructured so the Timeline gateway takes the
  Media and Timeline locks before any viewer lock: replay memos take a
  `FOR KEY SHARE` on the viewer row through their FK and would otherwise
  deadlock `_lock_viewer`'s `FOR UPDATE`. `_require_source_publication`'s
  existing media-before-queue order is brought into line as part of this cut.
- Supplemental copy/transcript failure never poisons an otherwise readable or
  externally playable Media.
- Every wire union is exhaustive and strictly decoded. Semantic absence uses
  `Presence<T>`, never nullable/omitted ambiguity. No wire arm carries a
  capability boolean whose value is derivable from a sibling field; capability
  is expressed by the arm itself.
- Status is derived from durable facts and refreshed by the media SSE, whose
  read model this cutover hard-cuts (see "Media event stream"). Do not add a
  second workflow engine, broker, object store, annotation system, lifecycle
  timer, or status poller. The owned-video engine's bounded playback-ticket
  renewal deadline, scoped to a live session, is explicitly exempt: that rule
  governs domain/status polling, not transport upkeep.

## Scope

In scope:

- Keep, cancel, retry, inspect, play, and remove one account-held YouTube copy
  inside the exact provider-approval scope (inspection means the per-item
  `Kept { verifiedAt, sizeBytes, approvalExpiresAt }` projection only);
- immutable private storage, direct ranged delivery, cleanup, and teardown;
- a generic timed-media playback state and mixed podcast/video player session;
- playback speed `0.5x` through `3x` using the existing rate kernel;
- explicit durable podcast/video transcription, current-only publication, and
  segment timestamps;
- playback-following transcript cursor and user-controlled soft follow;
- durable moment Highlights from player chrome and one-cue transcript text
  Highlights through the existing selection UI;
- actual-player video activity instead of focused-pane dwell;
- hard deletion of obsolete names, routes, decoders, branches, and tests.

Non-goals:

- auto-keep, subscriptions/channels, bulk copy, retention rules, mirroring, or
  copy refresh/version history;
- playlists, Shorts-specific behavior, live streams, private/member/age-gated
  videos, cookies, login automation, DRM circumvention, or arbitrary URLs;
- multiple qualities, DASH/HLS output, adaptive streaming, transcoding,
  browser/PWA offline, export, or filesystem UI;
- native Android video/background playback, PiP, Cast, AirPlay, or waveform UI;
- browser/video silence shortening in this cut; the control is omitted where
  the selected engine cannot truthfully support it;
- word-level timing, karaoke, transcript editing/history/translation,
  diarization correction, AI chapters, local ASR, or automatic transcription;
- cross-cue transcript selections, clips, bookmarks, collaborative annotation,
  or a second highlight store;
- partial-coverage transcripts: no provider emits them today, and no
  publication can prove completeness while video Timeline duration may be
  absent. `transcript_coverage` is deleted, not migrated; reintroduce coverage
  only together with a producer that derives it from cue coverage against a
  known duration;
- an account-level kept-copy inventory, storage total, or copy-count cap;
  retention rules, bulk copy, and auto-cleanup remain out;
- queue ordering, ETA, or invented progress;
- a new journey; the 15-entry cap is enforced structurally by
  `proof-journey-cap` in `python/nexus_test_control/policy.py`, and this
  cutover adds no registry entry — it replaces `podcast-refresh-playback` in
  place;
- provider revision history or rebinding pre-copy timed facts to unverified
  bytes.
- any audiovisual acquisition or caption scraping outside YouTube's documented
  APIs and the immutable approval artifact; without that artifact YouTube is
  embed-only and durable copy remains blocked rather than silently substituted.

## Target behavior and content contract

Each feature workstream includes a product/content designer. Engineers do not
invent labels or provider text. “Good” content is truthful, stable across
surfaces, useful without diagnostics, and never claims more precision or
durability than the schema proves.

Every sentence this spec quotes verbatim lives in one owner module,
`apps/web/src/lib/media/timedMediaCopy.ts` (exactly as `OFFLINE_READING_COPY`
is owned), read by the B/D/E/F surfaces and by the resource-action catalog
entries; no surface restates one of these sentences inline (residue-gated).
Formatting rules: every `{time}`/`{start}`/`{end}` renders through the
existing `formatClock.ts` owner, and within one transcript or marker list all
values use the widest form the media's duration requires, so an item over an
hour never mixes `MM:SS` and `H:MM:SS`. `sizeBytes` renders through the
existing byte-unit formatter in `lib/offlineReading/presentation.ts`;
`verifiedAt` renders as a relative date. The **Kept** detail copy is
**Copy kept {relative date} · {size}. Available while provider permission
remains valid; current permission expires {approval date}. Nexus may remove the
copy sooner if that permission changes.** The Keep dialog says **Nexus keeps a
private copy while provider permission remains valid. You can remove it any
time; Nexus may remove it sooner if that permission changes.** Ellipsis discipline: openers that lead
to a dialog take `…`; status text does not.

Announcements: intermediate copy and transcript states (`Queued`, `Keeping`,
stages, `Cancelling`, `Removing`) update the projection silently and are never
announced. At most one terminal outcome per command per live observing client
(**Copy kept**, **Copy
cancelled**, **Couldn’t keep a copy**, **Couldn’t finish removing the copy**,
transcript ready/failed) emits one Polite Feedback notice through the existing
owner; Assertive is reserved for a failure the user must act on. The player's
single live region is never reused for copy lifecycle. Feedback is ephemeral:
reload/navigation reads authoritative state and does not recreate an old toast;
no durable notification subsystem is introduced for this cut.

| Feature / content owner | Required content | “Good” means |
| --- | --- | --- |
| Copy designer | **Keep a copy…**, **Copy queued**, **Keeping copy…**, stage lines Resolve **Finding the video…**, Download **Downloading…**, Package **Preparing the file…**, Probe **Checking the file…**, Upload **Saving to Nexus…**, Verify **Verifying the upload…**, Finalize **Finishing…**, **Cancel**, **Cancelling…**, **Copy cancelled**, **Copy kept**, **Couldn’t keep a copy**, conditional **Retry**, opener **Remove copy…**, confirmation action **Remove copy**, **Removing copy…**, **Couldn’t finish removing the copy**, **Retry removal**, remove block **Nexus is transcribing this item. Cancel or finish transcription before removing the copy.** | Keep is positioned as “in Nexus” while device downloads stay “on this device”; the Offline action remains absent for video so the two never co-occur. Bytes render only as “{done} of {total}” scoped to the named stage, never an overall percentage or a resetting bar; safe specific failure and only truthful recovery; success only after seekable publication. **Cancelling…** may persist until the running step notices and carries no action by design. |
| Player designer | **Media player**, **Play/Pause**, **Back 15 seconds**, **Forward 30 seconds**, **Playback speed**, **Highlight** (accessible name **Highlight this moment**), **Capture** (accessible name **Record a voice note here**), **Open video**, **Open source**, owned-only **Audio only — open the video to watch**, YouTube-only **Video paused — open the video to continue** | One vocabulary and landmark for podcasts/videos; changing time is not live-announced; unsupported controls are absent. For a video the speed control shows only the value — no podcast-inheritance scope line, no **Remember {rate}**, and none of their announcements. **Highlight** is the deterministic primary chrome action at 320 px; **Capture** lives in overflow. **Open source** carries the saved source position (`&t=`) while the Timeline is unbound, and opens the plain watch URL once the Timeline carries owned identity or a removal row — Nexus can no longer prove the provider timeline matches. List/menu verbs are kind-aware: **Watch** for video, **Listen** for audio; **Play**/**Play next** apply to canonical timed video. |
| Transcript designer | **Transcribe…**, **Verify episode length…**, **Transcription queued**, **Transcribing…**, **Cancel transcription**, **Cancelling transcription…**, **Open transcript**, **Couldn’t transcribe this item**, **Retry transcription**, canonical **Remove copy…**, **Play from {time}**, visible **Return to {time}** with stable accessible name **Return to playback position**, cross-cue line **Select within one transcript segment to highlight.**, timestamp/speaker line **Select only transcript text within one segment to highlight.**, pre-copy warning **If you transcribe first, keeping a copy later requires discarding this saved transcript and timeline.** | Cues are readable prose with a separate timestamp control; provenance renders as publisher-provided, imported, YouTube captions, YouTube automatic captions, third-party machine, or Nexus machine, so `Generated` never implies Nexus billing and approved caption API data never loses source attribution; no word-level implication or cue-by-cue announcement. **Play from {time}** is the single label for every timestamp affordance on a timed-media pane, including show-notes timestamps, and all share one seek-and-resume behavior. |
| Highlight designer | **Highlight this moment**, marker label **Highlight at {time}** / **Highlight from {start} to {end}**, **Couldn’t highlight this moment**, **Highlight needs review**, existing color/note actions | A moment is source time; a passage is exact/prefix/suffix text in one timed cue; Highlight and Walknotes Capture remain distinct (Highlight saves a time marker you can find later; Capture records a Walknote). A quoteless `media_time` Highlight presents as **{title} at {time}** everywhere a quote would otherwise appear — quick-note composer, Vault row, Evidence marker, chat citation, export — and is excluded from text search rather than indexed as an empty string. |
| Activity designer | Existing Viewing/Listening language | Video time comes from a playing engine, never pane dwell; parked owned-video playback records Listening, never Viewing; YouTube pauses when it cannot remain visibly presented; no state is promoted to an attention badge unless the user can act. |

The Player content owner maps observation decisions exhaustively with no
internal approval vocabulary: `Untracked { MadeForKids }` -> **YouTube controls
this video. Nexus won’t save progress, activity, highlights, or transcript
follow.**; `Untracked { TimedObservationNotApproved }` -> **Nexus can play this
video, but won’t save progress, activity, highlights, or transcript follow.**;
`Untracked { PolicyUnknown }` -> **Nexus couldn’t verify whether timed features
are allowed. Playback is available without Nexus progress, activity,
highlights, or transcript follow.**; `Unavailable { PolicyUnknown }` -> **Nexus
couldn’t verify the playback policy for this video.** + **Retry** and **Open
source** when safe provenance exists; and `Unavailable {
UntrackedEmbedProfileUncertified | UntrackedOwnedProfileUncertified }` ->
**Nexus can’t safely open this YouTube video here.** + **Open source**, with no
Retry until the deployment profile is repaired. Local
`UntrackedProfileArtifactMismatch | UntrackedEmbedProfileUnsupportedHost |
UntrackedOwnedProfileUnsupportedHost` uses the same copy/action and no Retry
for that exact release/host. Every Activity detail carrying tracked YouTube
provenance includes **Nexus calculates this activity from player events. It is
not a YouTube metric and does not prove you were watching.** D/F render and
accessibility tests enumerate every arm.

Podcast input verification has its own content, never generic transcription:
**Verifying episode length…**, bytes **{done} of {total}** only when the server
knows a trustworthy total (otherwise an indeterminate stage), **Cancel
verification**, **Cancelling verification…**, transient **Couldn’t verify the
episode length.** + **Retry length check**, permanent **This episode’s audio
source can’t be fetched safely.**, **This episode’s audio isn’t available.**,
**This episode’s audio format can’t be verified.**, **This episode is over the
four-hour limit.**, and **This episode is over the 4 GiB limit.** Permanent arms
have no Retry; a fresh
feed/source change can expose **Verify episode length…** again. Progress is
silent, cancellation returns focus to that action, and one terminal result is
announced through Polite Feedback.

The Settings OAuth content map is likewise closed: `Disconnected` -> **Connect
YouTube captions**; `Connecting { phase: AwaitingGoogle }` -> heading
**Connecting to YouTube…**, body **Finish in the Google window. You can safely
return here. This connection attempt expires after ten minutes.**, with no
action that pretends to cancel server state; `Connecting { phase: Finalizing }`
-> heading **Finishing your YouTube connection…**, body **You can safely return
here.**, with no action; `ChooseChannel` -> **Choose your YouTube channel** and **Nexus
will use captions only for the channel you choose.** with **Connect channel** /
**Cancel**; `Connected` -> **YouTube captions connected** + **Disconnect
YouTube captions**; `Revoking` -> **Disconnecting YouTube captions…** with no
action; `RemoteUnconfirmed` -> **Nexus disconnected locally, but couldn’t
confirm removal at Google. Revoke Nexus in Google account security before
reconnecting.** + **Open Google account security** + **I’ve revoked Nexus at
Google**;
denial -> one **You cancelled the Google connection.** notice and Disconnected;
pending expiry/cancel -> one **Channel selection expired. Connect again.** /
**Connection cancelled.** notice; zero/invalid channels -> **Nexus couldn’t
find an eligible YouTube channel for this account.** + **Open Google account
security**. Browser/App-Link completion returns focus to the Settings heading;
the selected option receives focus after validation errors, duplicate labels
use their numbered accessible name, state changes are Polite once, and reload
never recreates terminal feedback.

Copy state is exhaustive, projected from queue-owned classifications (never
“due” timestamps):

| State | Source of truth | Action |
| --- | --- | --- |
| `Unsupported` | ineligible kind/provider/permission | omit copy UI |
| `NotKept { keep: Keepable { progressReset: NotRequired \| AcknowledgementRequired } }` | none of ready asset, active attempt, latest failure, active removal; reset arm derives from unproven position/completion | **Keep a copy…**; the acknowledgement arm renders the reset disclosure |
| `NotKept { keep: Blocked { reason: TimelineUnproven } }` | authored or otherwise irreplaceable unproven timed facts | discard-current-timeline recovery; no Keep |
| `NotKept { keep: Blocked { reason: ComplianceCapacity, effectiveMaxActiveContents } }` | the exact active reservation/live-schedule union is at the signed-notice-derived effective cap (absolute ceiling 32) or no nonoverlapping reserved video-lane window fits before this approval deadline | **View kept copies**; remove one before Keep is offered again |
| `Queued` | exact accepted attempt + nonterminal job without a live lease (pending, failed-awaiting-retry, or running-with-expired-lease) | Cancel |
| `Keeping` | exact live lease; optional real stage/bytes | Cancel |
| `Cancelling` | exact cancellation request + nonterminal job | none |
| `Kept` | current verified asset row | Remove copy… |
| `Failed` | latest classified terminal attempt failure and no asset, including modeled wall-timeout/OOM resource limits | Retry only when the current structural retry arm permits; otherwise recover by its typed action |
| `Suspended` | exact unexpected dead job still owns its attempt/binding | **Nexus needs repair before this copy can continue.**; no user action |
| `Removing` | current-generation removal has no completion and its latest cleanup attempt is active | none |
| `RemovalFailed` | latest cleanup attempt has its classified-failure row and removal has no completion | Retry removal (`DELETE` with a new key, see endpoints) |
| `RemovalSuspended` | latest cleanup attempt has an unexpected dead cleanup plus suspension row | **Nexus needs repair before removal can continue.**; no user action |

The projection resolves the stable producer operation from the source attempt
and its unique `media_video_copy_reconciliations` child. It asks the existing
coordination owner's typed `operation_health(OperationRef)` port for the one
queue-owned correlation keyed by `{operationKind, domainOperationId}`; domain
code never reads `background_jobs`, copies a queue id, or performs a generic
payload/latest-job scan. Generation cancel intent has highest active
precedence (`Cancelling`); an unresolved producer or reconcile suspension is
`Suspended` and blocks Retry/Discard; otherwise a live lease on either job is
`Keeping` (reconcile/readback reports `Verify`), any remaining unclaimed
nonterminal owner is `Queued`, and terminal domain facts decide the other arms.
A dead reconcile cannot be hidden by a pending/failed/cancelled producer.
Both producer and reconcile dead-letter projectors insert immutable monotonically
allocated suspension occurrences and `Requeued` resolutions under their domain
locks; two dead -> requeue -> dead cycles and eventual success/pruning retain
both crash histories.

`ComplianceCapacity` carries the current nonnegative
`effectiveMaxActiveContents <= 32` and renders title **Nexus has reached its
safe kept-video capacity**, body **Current provider deadlines allow {count}
kept copies. Remove one before keeping another.**, and **View kept copies**.
The count is server-derived and strictly decoded; zero suppresses Keep entirely
and blocks release/startup rather than showing a nonsensical action. That action opens
the existing Library with a local `Kept` video-copy filter and focuses the first
result; an empty/drifted result refreshes Media and returns focus to the blocked
Keep explanation. There is no Retry loop: removing and physically settling a
copy releases one neutral capacity allocation, SSE refreshes this projection,
and **Keep a copy…** returns. The current effective cap and absolute 32 ceiling
are visible before the dialog and rechecked in the command transaction.

Failure is typed as a closed discriminated union — retryability is the
discriminator, never a boolean:

```text
VideoCopyFailure =
  Retryable { kind: Network | Storage | ResourceLimit }
  | Permanent { kind: ProfileUnavailable | TooLong | TooLarge
                | SourceIneligible | SourceMetadataUnavailable
                | TimelineUnsupported | TimelineChanged }
RemovalFailure = Retryable { kind: Storage }
```

Each member has exactly one approved sentence: `Retryable` -> **Couldn’t keep
a copy** + Retry; `ProfileUnavailable` -> **This video isn’t available in a
format Nexus can keep** + Open source; `TooLong` -> **This video is longer
than Nexus’s supported length** + Open source; `TooLarge` -> **This video is
too large to keep** + Open source; `SourceIneligible` (live, playlist,
private/member/age-gated, login required — adapter-classified, never folded
into `ProfileUnavailable`) -> **Nexus can only keep regular public videos** +
Open source; `SourceMetadataUnavailable` -> **Nexus can’t verify this video’s
size, so it can’t keep a safe copy** + Open source; `TimelineUnsupported` -> **This video’s timing can’t be
verified, so Nexus can’t keep it** + Open source; `TimelineChanged` -> **The
original no longer matches this item’s saved timeline** + Open source;
removal failure -> **Couldn’t finish removing the copy** + Retry removal.
The projection maps `media_source_attempts.error_code` into this union
through the closed durable `VideoCopyFailureCode` table. An unrecognized
trusted code is corrupt state: the read owner raises the defect, operator
telemetry identifies the row, and no invented generic product state renders.
`media_source_attempts.error_message` and
`background_jobs.last_error` are operator diagnostics no projection may read;
raw provider, subprocess, path, or object-store text never renders
(residue-gated).

The durable copy code union is exactly `E_VIDEO_NETWORK`, `E_VIDEO_STORAGE`,
`E_VIDEO_WALL_TIMEOUT`, `E_VIDEO_MEMORY_LIMIT`,
`E_VIDEO_PROFILE_UNAVAILABLE`, `E_VIDEO_TOO_LONG`, `E_VIDEO_TOO_LARGE`,
`E_VIDEO_COPY_SOURCE_INELIGIBLE`, `E_VIDEO_SOURCE_METADATA_UNAVAILABLE`,
`E_VIDEO_TIMELINE_UNSUPPORTED`, and `E_VIDEO_TIMELINE_CHANGED`. Each expected
code terminalizes the domain attempt and completes its first queue run;
retryability controls only a new explicit user attempt. Process/host
interruption, lost lease, and supervisor defect are queue-infrastructure
outcomes: they replay the same domain attempt within its declared budget and
project `Suspended` if exhausted, never a fictitious product `Interrupted`
failure. Removal has one expected durable dependency family,
`E_VIDEO_REMOVAL_STORAGE`; exhaustion projects `RemovalFailed`, while any
unknown defect projects `RemovalSuspended`.

Both copy dialogs render through the one canonical confirmation renderer:
`ResourceOperation.Media.VideoCopy` joins the catalog in the Consume group
(explicit order and tone, per-state presentations mirroring
`ResourceOperation.Media.Offline`) and `ResourceOperation.Media.VideoCopyRemove`
joins the Danger group. Confirmation is structural:
`RequiredPlain { contentBlocks } | RequiredAttested { contentBlocks,
acknowledgements: NonEmptyArray<{ key, label }> }`. Remove uses
`RequiredPlain`; Keep uses `RequiredAttested`. Every required acknowledgement
gates confirm independently and preserves stable order, focus, and field-level
error association. This is implemented once so Remove-copy and every future
attested action reuse it without a fake checkbox or empty semantic sentinel.
No surface renders its own Keep or Remove-copy dialog.

The opener is **Keep a copy…**. Its dialog is:

- title: **Keep a copy?**
- body: **Save a durable playable copy in Nexus in case the original changes
  or disappears.**
- first-copy addendum: **Playback, transcription, and highlighting are
  unavailable while Nexus keeps the copy. After keeping finishes, fails, or
  you cancel, play again; transcription and highlighting become available for
  the source Nexus can then verify. Keeping runs in the background and can
  take a while for long videos.**
- progress-reset addendum, shown exactly when unproven derived facts exist
  (see the two-tier rule below): **Nexus can’t prove your saved position
  matches the copy it will make, so keeping will reset this item to the
  start and clear completion. Your transcript, highlights, notes, and past
  viewing or listening time are untouched; positions recorded against the old
  timeline stop contributing to position statistics.**
- required checkboxes, in this order: **I confirm I have the right to keep this
  copy.** and, only for `AcknowledgementRequired`, **Reset my saved position
  and completion.**
- actions: **Keep a copy**, **Cancel**; Keep is disabled until checked.

The tick is the attestation act; the command stores
`rightsBasis: UserAttestedAuthorized`, and the attempt actor and creation time
are its product record. The existing attempt-actor `ON DELETE SET NULL` FK is
recreated as restrictive; account erasure explicitly deletes owned attempts in
owner order, so a live attestation never silently loses its actor. This favors
relational truth during account life while preserving explicit user erasure.
Do not build a legal taxonomy or call this legal proof.

Remove always requires confirmation because Nexus does not maintain a second
remote-source health state:

- title: **Remove kept copy?**
- body: **Nexus will delete its playable copy. This item will stop playing in
  Nexus. Keeping it again works only if the source still produces the same
  verified video; Nexus can’t guarantee that. You can still open the source.**
- actions: **Remove copy**, **Cancel**.

Removal preserves Media, timeline, transcript, Highlights, notes, progress, and
Library/Lectern relationships. Whole-Media deletion retains its existing,
separate destructive semantics.

The removal ledger retains one immutable removal identity per unpublished
content publication; it references the still-live neutral content row and never
copies the deleted publication-row id into an unverified UUID column.
completion/failure live in separate outcome rows. Within one Timeline
generation, Re-Keep is allowed after cleanup only when publication reproduces
the most recent removal's exact owned-content identity (SHA plus the semantic
profile/timeline-conformance version). The probe stage additionally gates duration against the current
Timeline within 1,000 ms and fails `E_VIDEO_TIMELINE_CHANGED` after local
download/package/probe but before upload. A provider re-encode or a
a profile/conformance-version mismatch therefore cannot bind old timed facts. **Discard saved
timeline** retires that generation and publishes a fresh unbound generation;
historical removals remain auditable but do not constrain the new generation.
A mismatch projects `Permanent { TimelineChanged }` and is not retryable
within the old generation.

First-copy identity is fail-closed, in two tiers.

Tier 1 — authored, irreplaceable facts: a transcript publication, retained
unbound timed transcript fragments or their Highlights, chapters, temporal
Highlights, or nonterminal transcript work. These block Keep:
`NotKept { keep: Blocked { reason: TimelineUnproven } }`, and the command
fails `E_MEDIA_TIMELINE_UNPROVEN`. Show title **This video can’t be kept
safely** and body **Nexus can’t verify that a copy made now matches the
version you already played, transcribed, or highlighted. To keep a copy,
discard this item’s saved timeline first, then keep the copy before using
it.** Actions are **Discard saved timeline…** and **Open source**; there is
no Retry.

Tier 2 — derived, regenerable facts: nondefault playback position and
completion. These do not block; the Keep dialog shows the progress-reset
addendum above, and on admission the Timeline gateway performs the existing
Reset-progress transition (advance `reset_epoch`, zero position and
completion). Rate preference and Activity spans are observations/preferences,
not source identity: they are never deleted. The Timeline epoch bump makes old
Activity positions non-current while `activeMs` continues to count. A default
position row alone triggers nothing. When both tiers are present, Tier 1 wins.

**Discard saved timeline** is one explicit, idempotent confirmed command owned
by the Timeline owner: title **Discard this item’s saved timeline?**, body
naming exactly what is removed (saved position and completion, transcript with
its segments and cues, chapters, and time-anchored Highlights) and what is
retained (the item, Library/Lectern placement, note prose, Media-level links,
and Activity time). Notes attached only to a deleted Highlight are detached;
the prose is retained, but the deleted attachment edge cannot truthfully be
preserved. Confirm **Discard timeline**. Under Media -> head -> current
Timeline locks, owner-provided in-transaction helpers delete those exact
content-bound facts, retire the current generation, create a fresh unbound
Timeline at epoch zero, and atomically move the head. Historical Timeline,
owned identity, removal, and Activity provenance remain; stale handles fail
because they no longer identify the head. The command requires all of these
facts under the same locks: no `media_video_assets` publication, no active or
failed removal, no suspended removal, and no queued/running/cancelling/
suspended copy, transcript, or other content-bound writer. A current asset
fails `E_MEDIA_TIMELINE_BUSY` and points to **Remove copy**; classified removal
failure points to **Retry removal**; suspended removal or transcript work
points to operator repair. A transcript `Suspended` arm is never treated as
terminal enough for Discard: the operator must requeue that exact dead job and
let it settle, or run the separately audited terminalization procedure that
proves no provider submission, live lease, reservation, allocation, or write
horizon remains. The command never attempts cross-job cancellation or
abandonment implicitly. It is the recovery action in both fail-closed dialogs
only after these preconditions hold.
`ResourceOperation.Media.TimelineDiscard` is the sole Danger-catalog action
that renders this confirmation and invokes the endpoint; panes and error
surfaces plan that operation rather than owning bespoke dialog copy.
**Remove from Nexus** remains the ordinary danger action, never the
copy-feature workaround.

Admitting a clean first copy inserts the exact Timeline binding row and
increments `binding_epoch`. While reserved, Nexus pauses any
stale external session, projects playback as unavailable, and rejects direct
timed commands (playback-state PUT, transcript and chapter publication, both
temporal Highlight commands) with the typed binding error; positioned
Activity delivery is accepted with its epoch recorded (observations are
facts, not commands — see Observed activity). Copy failure/cancellation
deletes only its own binding row; successful publication inserts immutable
owned identity. Every exact terminal resolution increments the epoch again,
so a handle observed during binding is also stale. Re-Keep admission stores
no binding reservation and never bumps `binding_epoch` — the bytes are
identical and existing handles stay valid; its payload `bindingEpoch` is only
a sanity fence against whole-Media re-creation or Timeline-generation discard.
This intentionally prevents new timed facts from racing a long acquisition.

## Final architecture

```text
YouTube Media + explicit Keep
  -> media_source_attempt(youtube_video_copy) + acquire_video_copy
     (dedicated worker-media lane, TimedMediaHeavy capacity)
  -> fixed yt-dlp adapter -> compatible streams -> ffmpeg stream-copy/faststart
  -> probe + hash -> reserved attempt path -> private R2 (multipart, checksummed)
  -> lease-fenced media_video_asset publication (DB last)

MediaTimeline
  -> PlaybackState -------> PlayerSession -> engine adapter -> shared chrome
  -> TranscriptPublication ----^                 |
  -> Temporal Highlight <------------------------+
  -> Consumption activity <- actual engine observations

engine adapters = BrowserAudio | OwnedVideo | YouTubeIframe | AndroidAudio
(PreviewAudio maps onto the BrowserAudio/AndroidAudio adapters with Timeline,
 playback state, heartbeat, activity, chapters, completion, and Media ID all
 absent by type)
```

Sole owners:

| Concern | Owner |
| --- | --- |
| YouTube identity and copy admission | video-copy service over source-attempt owner |
| acquisition/probe/profile | pinned video-copy provider adapter |
| object path and lifecycle | `storage/paths.py::build_video_copy_storage_path(object_key_suffix)` + cleanup/teardown owners |
| timeline/playback state | Consumption |
| source selection | `services/playback_source.py` |
| session/engine/chrome | global player |
| current transcript | `services/transcripts/*` |
| annotations | Highlight |
| transcript follow | one pure timed-transcript controller |
| observed spans | Consumption Activity |
| lifecycle refresh | `/stream/media/{id}/events` SSE over the hard-cut read model (see "Media event stream") |

## Persistence

The next migration performs one hard cut.

### New tables

Conventions (per `docs/rules/database.md`): every new table owns a generated
UUIDv7 `id` primary key; a parent id used as a foreign key is never reused as
the child's primary key. Every new foreign key uses the default non-cascading
delete — cleanup is explicit in `media_deletion.py`; do not copy the legacy
`ondelete='CASCADE'` examples. Every new durable entity table declares
`created_at TIMESTAMPTZ NOT NULL DEFAULT now()`; the current-head row also
declares `updated_at TIMESTAMPTZ NOT NULL`. All unmarked columns are `NOT
NULL`. No new `CHECK` constraint, trigger, or business-state index is created.
Every
timed-media millisecond wire field uses the non-negative int64 bound already
used by `consumption_activity`, never `_NonNegInt32`.

```text
coordination_operation_jobs                  # coordination-owned, never domain-read
  id UUID PK
  operation_kind TEXT
  domain_operation_id UUID                   # opaque to coordination
  job_id UUID UNIQUE FK background_jobs
  created_at TIMESTAMPTZ
  UNIQUE(operation_kind, domain_operation_id)

coordination_operation_terminal_receipts     # immutable content-free terminal proof
  id UUID PK
  operation_kind TEXT
  domain_operation_id UUID
  terminal_outcome_sha256 TEXT
  terminal_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(operation_kind, domain_operation_id)
  UNIQUE(id, operation_kind, domain_operation_id)

coordination_operation_terminal_dependencies # exact claim-set observation edges
  id UUID PK
  observing_operation_kind TEXT
  observing_domain_operation_id UUID
  observed_operation_kind TEXT
  observed_domain_operation_id UUID
  observed_terminal_receipt_id UUID nullable # linked at terminal settlement
  created_at TIMESTAMPTZ
  UNIQUE(observing_operation_kind, observing_domain_operation_id,
         observed_operation_kind, observed_domain_operation_id)
  UNIQUE(id, observing_operation_kind, observing_domain_operation_id,
         observed_operation_kind, observed_domain_operation_id)
  FK(observed_terminal_receipt_id, observed_operation_kind,
     observed_domain_operation_id) ->
    coordination_operation_terminal_receipts(
      id, operation_kind, domain_operation_id)

user_account_erasure_operations              # durable account-deletion owner
  id UUID PK
  user_id UUID UNIQUE FK users
  checkpoint TEXT                            # AwaitingDispatch | PlanReady | Executing |
                                             # ReadyToCommit
  requested_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, user_id)

user_account_erasure_root_plan_seals         # immutable admission-fenced roots
  id UUID PK
  erasure_operation_id UUID UNIQUE FK user_account_erasure_operations
  account_ref_set_sha256 TEXT
  media_set_sha256 TEXT
  user_fk_inventory_sha256 TEXT
  physical_disposition_plan_sha256 TEXT
  root_plan_sha256 TEXT UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, erasure_operation_id)

user_account_erasure_root_account_ref_target_members # exact root digest members
  id UUID PK
  erasure_operation_id UUID
  root_plan_seal_id UUID
  account_ref_target_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(root_plan_seal_id, account_ref_target_id)
  FK(root_plan_seal_id, erasure_operation_id) ->
    user_account_erasure_root_plan_seals(id, erasure_operation_id)
  FK(account_ref_target_id, erasure_operation_id) ->
    user_account_erasure_account_ref_targets(id, erasure_operation_id)

user_account_erasure_closure_seals           # exact transitive final coverage
  id UUID PK
  erasure_operation_id UUID UNIQUE FK user_account_erasure_operations
  root_plan_seal_id UUID UNIQUE
  successor_graph_sha256 TEXT
  target_completion_set_sha256 TEXT
  physical_disposition_completion_set_sha256 TEXT
  fresh_discovery_sha256 TEXT
  closure_sha256 TEXT UNIQUE
  created_at TIMESTAMPTZ
  FK(root_plan_seal_id, erasure_operation_id) ->
    user_account_erasure_root_plan_seals(id, erasure_operation_id)

user_account_erasure_account_ref_targets     # immutable exact account ref plan
  id UUID PK
  erasure_operation_id UUID FK user_account_erasure_operations
  operation_kind TEXT
  domain_operation_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(erasure_operation_id, operation_kind, domain_operation_id)
  UNIQUE(id, erasure_operation_id)

user_account_erasure_account_ref_completions # exact ref transferred/terminal
  id UUID PK
  account_ref_target_id UUID UNIQUE FK user_account_erasure_account_ref_targets
  outcome TEXT                               # Terminalized | Transferred
  created_at TIMESTAMPTZ

user_account_erasure_account_ref_successors  # append-only transitive plan edge
  id UUID PK
  erasure_operation_id UUID
  predecessor_target_id UUID
  successor_target_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(predecessor_target_id, successor_target_id)
  FK(predecessor_target_id, erasure_operation_id) ->
    user_account_erasure_account_ref_targets(id, erasure_operation_id)
  FK(successor_target_id, erasure_operation_id) ->
    user_account_erasure_account_ref_targets(id, erasure_operation_id)

user_account_erasure_media_targets           # plan survives Media teardown to closure
  id UUID PK
  erasure_operation_id UUID
  user_id UUID
  media_id UUID UNIQUE                       # validated live at plan time; no FK so
                                             # the target survives Media deletion
  media_identity_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, erasure_operation_id)
  FK(erasure_operation_id, user_id) -> user_account_erasure_operations(id, user_id)

user_account_erasure_media_completions       # survives Media deletion to closure
  id UUID PK
  erasure_operation_id UUID
  media_target_id UUID UNIQUE
  erasure_operation_identity_sha256 TEXT
  media_identity_sha256 TEXT UNIQUE
  teardown_receipt_sha256 TEXT
  created_at TIMESTAMPTZ
  FK(media_target_id, erasure_operation_id) ->
    user_account_erasure_media_targets(id, erasure_operation_id)

user_account_erasure_user_fk_targets         # exact generated users-FK plan
  id UUID PK
  erasure_operation_id UUID FK user_account_erasure_operations
  fk_catalog_identity_sha256 TEXT
  row_identity_sha256 TEXT
  disposition TEXT                          # DeleteOwnedChild |
                                            # TransformToContentFreeReceipt
  created_at TIMESTAMPTZ
  UNIQUE(erasure_operation_id, fk_catalog_identity_sha256, row_identity_sha256)
  UNIQUE(id, erasure_operation_id)

user_account_erasure_user_fk_completions
  id UUID PK
  user_fk_target_id UUID UNIQUE FK user_account_erasure_user_fk_targets
  outcome TEXT                              # Deleted | Transformed
  created_at TIMESTAMPTZ

user_account_erasure_physical_dispositions  # one actual mutation owner
  id UUID PK
  erasure_operation_id UUID
  physical_resource_identity_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(erasure_operation_id, physical_resource_identity_sha256)
  UNIQUE(id, erasure_operation_id)
  FK(erasure_operation_id) -> user_account_erasure_operations(id)

user_account_erasure_account_operation_disposition_owners # typed owner arm
  id UUID PK
  erasure_operation_id UUID
  physical_disposition_id UUID UNIQUE
  account_ref_target_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(account_ref_target_id, physical_disposition_id)
  FK(physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_physical_dispositions(id, erasure_operation_id)
  FK(account_ref_target_id, physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_account_ref_coverage_targets(
      account_ref_target_id, physical_disposition_id, erasure_operation_id)

user_account_erasure_media_disposition_owners # typed owner arm
  id UUID PK
  erasure_operation_id UUID
  physical_disposition_id UUID UNIQUE
  media_target_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_physical_dispositions(id, erasure_operation_id)
  FK(media_target_id, physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_media_coverage_targets(
      media_target_id, physical_disposition_id, erasure_operation_id)

user_account_erasure_user_fk_disposition_owners # typed owner arm
  id UUID PK
  erasure_operation_id UUID
  physical_disposition_id UUID UNIQUE
  user_fk_target_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_physical_dispositions(id, erasure_operation_id)
  FK(user_fk_target_id, physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_user_fk_coverage_targets(
      user_fk_target_id, physical_disposition_id, erasure_operation_id)

user_account_erasure_target_disposition_coverage # neutral target/disposition edge
  id UUID PK
  erasure_operation_id UUID
  physical_disposition_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(id, erasure_operation_id)
  UNIQUE(id, physical_disposition_id, erasure_operation_id)
  FK(physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_physical_dispositions(id, erasure_operation_id)

user_account_erasure_account_ref_coverage_targets # typed logical target arm
  id UUID PK
  erasure_operation_id UUID
  coverage_id UUID UNIQUE
  physical_disposition_id UUID
  account_ref_target_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(account_ref_target_id, physical_disposition_id)
  UNIQUE(account_ref_target_id, physical_disposition_id, erasure_operation_id)
  FK(coverage_id, physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_target_disposition_coverage(
      id, physical_disposition_id, erasure_operation_id)
  FK(account_ref_target_id, erasure_operation_id) ->
    user_account_erasure_account_ref_targets(id, erasure_operation_id)

user_account_erasure_media_coverage_targets  # typed logical target arm
  id UUID PK
  erasure_operation_id UUID
  coverage_id UUID UNIQUE
  physical_disposition_id UUID
  media_target_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(media_target_id, physical_disposition_id)
  UNIQUE(media_target_id, physical_disposition_id, erasure_operation_id)
  FK(coverage_id, physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_target_disposition_coverage(
      id, physical_disposition_id, erasure_operation_id)
  FK(media_target_id, erasure_operation_id) ->
    user_account_erasure_media_targets(id, erasure_operation_id)

user_account_erasure_user_fk_coverage_targets # typed logical target arm
  id UUID PK
  erasure_operation_id UUID
  coverage_id UUID UNIQUE
  physical_disposition_id UUID
  user_fk_target_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(user_fk_target_id, physical_disposition_id)
  UNIQUE(user_fk_target_id, physical_disposition_id, erasure_operation_id)
  FK(coverage_id, physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_target_disposition_coverage(
      id, physical_disposition_id, erasure_operation_id)
  FK(user_fk_target_id, erasure_operation_id) ->
    user_account_erasure_user_fk_targets(id, erasure_operation_id)

user_account_erasure_physical_disposition_completions # append-only coverage seals
  id UUID PK
  erasure_operation_id UUID
  physical_disposition_id UUID
  completion_generation BIGINT
  physical_mutation_receipt_sha256 TEXT
  covered_completion_set_sha256 TEXT
  outcome TEXT                              # Completed
  created_at TIMESTAMPTZ
  UNIQUE(physical_disposition_id, completion_generation)
  UNIQUE(id, physical_disposition_id, erasure_operation_id)
  FK(physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_physical_dispositions(id, erasure_operation_id)

user_account_erasure_physical_disposition_completion_heads # current coverage
  id UUID PK
  erasure_operation_id UUID
  physical_disposition_id UUID UNIQUE
  completion_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  FK(physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_physical_dispositions(id, erasure_operation_id)
  FK(completion_id, physical_disposition_id, erasure_operation_id) ->
    user_account_erasure_physical_disposition_completions(
      id, physical_disposition_id, erasure_operation_id)

user_account_erasure_suspensions
  id UUID PK
  erasure_operation_id UUID FK user_account_erasure_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(erasure_operation_id, occurrence_no)

user_account_erasure_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK user_account_erasure_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

user_account_erasure_receipts                # content-free after user deletion
  id UUID PK
  erasure_operation_identity_sha256 TEXT UNIQUE
  account_ref_count BIGINT
  media_count BIGINT
  user_fk_count BIGINT
  physical_disposition_count BIGINT
  successor_edge_count BIGINT
  closure_sha256 TEXT
  outcome TEXT                              # Deleted
  created_at TIMESTAMPTZ

media_teardown_intents                        # existing table, rebuilt in place
  id UUID PK
  media_id UUID UNIQUE FK media
  checkpoint TEXT                              # AwaitingDispatch | Unprepared |
                                               # PathsPrepared | Deleting |
                                               # ReadyToCommit
  cleanup_not_before TIMESTAMPTZ nullable
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)

media_teardown_storage_paths                  # immutable owned deletion plan
  id UUID PK
  teardown_intent_id UUID
  media_id UUID
  storage_path TEXT
  planned_owner_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(teardown_intent_id, storage_path)
  UNIQUE(id, storage_path)
  UNIQUE(id, teardown_intent_id, storage_path)
  FK(teardown_intent_id, media_id) -> media_teardown_intents(id, media_id)

media_teardown_storage_path_cleanup_dependencies # observer link, never owner arm
  id UUID PK
  teardown_storage_path_id UUID UNIQUE
  teardown_intent_id UUID
  cleanup_operation_id UUID UNIQUE
  storage_path TEXT
  coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT              # MediaTeardown
  observed_operation_kind TEXT               # StorageObjectCleanup
  created_at TIMESTAMPTZ
  UNIQUE(id, teardown_storage_path_id, cleanup_operation_id)
  UNIQUE(id, teardown_storage_path_id, cleanup_operation_id, storage_path)
  FK(teardown_storage_path_id, teardown_intent_id, storage_path) ->
    media_teardown_storage_paths(id, teardown_intent_id, storage_path)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(coordination_dependency_id, observing_operation_kind,
     teardown_intent_id, observed_operation_kind, cleanup_operation_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

media_teardown_video_compliance_dependencies # active typed root observation
  id UUID PK
  teardown_intent_id UUID
  media_id UUID
  lifecycle_operation_id UUID UNIQUE
  content_id UUID UNIQUE
  coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT              # MediaTeardown
  observed_operation_kind TEXT               # YouTubeVideoCopyLifecycle
  created_at TIMESTAMPTZ
  UNIQUE(teardown_intent_id, lifecycle_operation_id)
  UNIQUE(id, teardown_intent_id, lifecycle_operation_id)
  FK(teardown_intent_id, media_id) ->
    media_teardown_intents(id, media_id)
  FK(lifecycle_operation_id, content_id, media_id) ->
    media_youtube_video_copy_lifecycle_operations(
      id, content_id, media_id)
  FK(coordination_dependency_id, observing_operation_kind,
     teardown_intent_id, observed_operation_kind, lifecycle_operation_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

media_teardown_video_compliance_settled_dependencies # receipt-backed root member
  id UUID PK
  teardown_intent_id UUID
  media_id UUID
  coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT              # MediaTeardown
  observed_operation_kind TEXT               # YouTubeVideoCopyLifecycle
  lifecycle_operation_id UUID UNIQUE          # opaque until teardown settles; no FK
  observed_terminal_receipt_id UUID UNIQUE
  video_compliance_receipt_id UUID UNIQUE
  lifecycle_operation_identity_sha256 TEXT
  content_identity_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(teardown_intent_id, lifecycle_operation_id)
  UNIQUE(id, teardown_intent_id, lifecycle_operation_id)
  FK(teardown_intent_id, media_id) ->
    media_teardown_intents(id, media_id)
  FK(coordination_dependency_id, observing_operation_kind,
     teardown_intent_id, observed_operation_kind, lifecycle_operation_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)
  FK(observed_terminal_receipt_id, observed_operation_kind,
     lifecycle_operation_id) ->
    coordination_operation_terminal_receipts(
      id, operation_kind, domain_operation_id)
  FK(video_compliance_receipt_id,
     lifecycle_operation_identity_sha256) ->
    media_youtube_video_copy_compliance_receipts(
      id, lifecycle_operation_identity_sha256)

media_teardown_storage_path_absences          # per-plan durable convergence
  id UUID PK
  teardown_storage_path_id UUID UNIQUE FK media_teardown_storage_paths
  cleanup_operation_id UUID UNIQUE FK storage_object_cleanup_operations
  cleanup_dependency_id UUID UNIQUE
  storage_path TEXT
  cleanup_object_absence_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(cleanup_dependency_id, teardown_storage_path_id, cleanup_operation_id,
     storage_path) ->
    media_teardown_storage_path_cleanup_dependencies(
      id, teardown_storage_path_id, cleanup_operation_id, storage_path)
  FK(cleanup_object_absence_id, cleanup_operation_id, storage_path) ->
    storage_object_cleanup_object_absences(
      id, cleanup_operation_id, storage_path)

media_teardown_terminal_receipts              # survives Media/intent deletion
  id UUID PK
  teardown_intent_id UUID UNIQUE              # opaque historical identity, no FK
  media_identity_sha256 TEXT                   # no reusable/raw Media UUID
  outcome TEXT                                 # Deleted | Voided | NoOp | Stale |
                                               # TransferredToCleanup
  created_at TIMESTAMPTZ

storage_object_cleanup_operations             # storage-domain operation owner
  id UUID PK
  storage_path TEXT
  checkpoint TEXT                              # Reserved | AwaitingDispatch | Retained |
                                               # DeleteRequired | Deleted
  local_writer_quiescence_not_before TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, storage_path)

storage_object_generations                    # canonical path/write identity
  id UUID PK
  storage_path TEXT
  object_generation BIGINT
  created_at TIMESTAMPTZ
  UNIQUE(storage_path, object_generation)
  UNIQUE(id, storage_path)

storage_legacy_opaque_producer_operations     # no invented pre-cut request facts
  id UUID PK
  storage_path TEXT
  legacy_authority_sha256 TEXT UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, storage_path)

storage_object_generation_producers            # neutral immutable producer arm
  id UUID PK
  object_generation_id UUID
  storage_path TEXT
  producer_generation BIGINT
  created_at TIMESTAMPTZ
  UNIQUE(object_generation_id, producer_generation)
  UNIQUE(id, object_generation_id, storage_path)
  FK(object_generation_id, storage_path) ->
    storage_object_generations(id, storage_path)

storage_object_generation_stable_operation_producer_owners # typed owner arm
  id UUID PK
  producer_id UUID UNIQUE
  object_generation_id UUID
  storage_path TEXT
  operation_kind TEXT
  domain_operation_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(operation_kind, domain_operation_id,
         object_generation_id, storage_path)
  UNIQUE(producer_id, operation_kind, domain_operation_id,
         object_generation_id, storage_path)
  FK(producer_id, object_generation_id, storage_path) ->
    storage_object_generation_producers(id, object_generation_id, storage_path)

storage_object_generation_upload_session_producer_owners # typed owner arm
  id UUID PK
  producer_id UUID UNIQUE
  object_generation_id UUID
  storage_path TEXT
  upload_session_object_generation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(producer_id, upload_session_object_generation_id,
         object_generation_id, storage_path)
  FK(producer_id, object_generation_id, storage_path) ->
    storage_object_generation_producers(id, object_generation_id, storage_path)
  FK(upload_session_object_generation_id, object_generation_id, storage_path) ->
    storage_upload_session_object_generations(
      id, object_generation_id, storage_path)

storage_object_generation_legacy_opaque_producer_owners # typed owner arm
  id UUID PK
  producer_id UUID UNIQUE
  object_generation_id UUID
  storage_path TEXT
  legacy_opaque_producer_operation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(producer_id, object_generation_id, storage_path) ->
    storage_object_generation_producers(id, object_generation_id, storage_path)
  FK(legacy_opaque_producer_operation_id, storage_path) ->
    storage_legacy_opaque_producer_operations(id, storage_path)

storage_remote_write_generations              # armed before any remote mutation
  id UUID PK
  producer_id UUID
  object_generation_id UUID
  storage_path TEXT
  mutation_generation BIGINT
  mutation_kind TEXT                          # PutObject | CreateMultipart |
                                               # UploadPart | CompleteMultipart |
                                               # AbortMultipart | DeleteObject |
                                               # PresignedPut
  canonical_request_sha256 TEXT
  armed_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(object_generation_id, mutation_generation)
  UNIQUE(id, object_generation_id, storage_path)
  UNIQUE(id, producer_id, object_generation_id, storage_path)
  UNIQUE(id, producer_id, object_generation_id, storage_path, mutation_kind)
  FK(producer_id, object_generation_id, storage_path) ->
    storage_object_generation_producers(
      id, object_generation_id, storage_path)
  FK(object_generation_id, storage_path) ->
    storage_object_generations(id, storage_path)

storage_remote_write_terminal_results         # authenticated completed I/O only
  id UUID PK
  remote_write_generation_id UUID UNIQUE FK storage_remote_write_generations
  outcome TEXT                                # Committed | DefinitivelyNotApplied |
                                               # ProviderTerminallyFenced
  provider_response_sha256 TEXT
  provider_operation_identity_sha256 TEXT nullable
  completed_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, remote_write_generation_id)

storage_object_cleanup_generation_members     # exact complete writer-set input
  id UUID PK
  cleanup_operation_id UUID
  object_generation_id UUID
  storage_path TEXT
  created_at TIMESTAMPTZ
  UNIQUE(cleanup_operation_id, object_generation_id)
  UNIQUE(id, cleanup_operation_id, object_generation_id, storage_path)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(object_generation_id, storage_path) ->
    storage_object_generations(id, storage_path)

storage_object_cleanup_multipart_targets      # every discovered upload cleanup target
  id UUID PK
  cleanup_generation_member_id UUID
  cleanup_operation_id UUID
  object_generation_id UUID
  storage_path TEXT
  provider_upload_id TEXT
  discovery_identity_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(cleanup_operation_id, provider_upload_id)
  UNIQUE(id, cleanup_generation_member_id, cleanup_operation_id,
         object_generation_id, storage_path)
  UNIQUE(id, cleanup_generation_member_id, cleanup_operation_id,
         object_generation_id, storage_path,
         provider_upload_id)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(cleanup_generation_member_id, cleanup_operation_id,
     object_generation_id, storage_path) ->
    storage_object_cleanup_generation_members(
      id, cleanup_operation_id, object_generation_id, storage_path)

storage_object_cleanup_multipart_observations # cleanup-owned complete LIST generation
  id UUID PK
  cleanup_operation_id UUID
  storage_path TEXT
  observation_generation BIGINT
  provider_upload_count BIGINT
  provider_upload_set_sha256 TEXT
  provider_response_sha256 TEXT
  observed_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(cleanup_operation_id, observation_generation)
  UNIQUE(id, cleanup_operation_id, storage_path)
  UNIQUE(id, cleanup_operation_id, storage_path,
         provider_upload_count, provider_upload_set_sha256)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)

storage_object_cleanup_multipart_observation_members
  id UUID PK
  multipart_observation_id UUID
  cleanup_operation_id UUID
  storage_path TEXT
  target_id UUID
  cleanup_generation_member_id UUID
  object_generation_id UUID
  provider_upload_id TEXT
  created_at TIMESTAMPTZ
  UNIQUE(multipart_observation_id, provider_upload_id)
  FK(multipart_observation_id, cleanup_operation_id, storage_path) ->
    storage_object_cleanup_multipart_observations(
      id, cleanup_operation_id, storage_path)
  FK(target_id, cleanup_generation_member_id, cleanup_operation_id,
     object_generation_id, storage_path,
     provider_upload_id) ->
    storage_object_cleanup_multipart_targets(
      id, cleanup_generation_member_id, cleanup_operation_id,
      object_generation_id, storage_path,
      provider_upload_id)

storage_object_cleanup_multipart_abort_generations # exact target mutation authority
  id UUID PK
  target_id UUID
  cleanup_generation_member_id UUID
  cleanup_operation_id UUID
  object_generation_id UUID
  storage_path TEXT
  provider_upload_id TEXT
  abort_producer_id UUID
  operation_kind TEXT                         # StorageObjectCleanup
  mutation_kind TEXT                          # AbortMultipart
  remote_write_generation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, target_id, cleanup_generation_member_id,
         cleanup_operation_id, object_generation_id, storage_path,
         provider_upload_id, remote_write_generation_id)
  FK(target_id, cleanup_generation_member_id, cleanup_operation_id,
     object_generation_id, storage_path, provider_upload_id) ->
    storage_object_cleanup_multipart_targets(
      id, cleanup_generation_member_id, cleanup_operation_id,
      object_generation_id, storage_path, provider_upload_id)
  FK(abort_producer_id, operation_kind, cleanup_operation_id,
     object_generation_id, storage_path) ->
    storage_object_generation_stable_operation_producer_owners(
      producer_id, operation_kind, domain_operation_id,
      object_generation_id, storage_path)
  FK(remote_write_generation_id, abort_producer_id,
     object_generation_id, storage_path, mutation_kind) ->
    storage_remote_write_generations(
      id, producer_id, object_generation_id, storage_path, mutation_kind)

storage_object_cleanup_multipart_target_completions
  id UUID PK
  target_id UUID UNIQUE
  cleanup_generation_member_id UUID
  cleanup_operation_id UUID
  object_generation_id UUID
  storage_path TEXT
  provider_upload_id TEXT
  abort_generation_association_id UUID UNIQUE
  abort_remote_write_generation_id UUID UNIQUE
  abort_terminal_result_id UUID UNIQUE
  outcome TEXT                                # Aborted | DefinitivelyAbsent |
                                              # ProviderTerminallyFenced
  created_at TIMESTAMPTZ
  FK(target_id, cleanup_generation_member_id, cleanup_operation_id,
     object_generation_id, storage_path,
     provider_upload_id) ->
    storage_object_cleanup_multipart_targets(
      id, cleanup_generation_member_id, cleanup_operation_id,
      object_generation_id, storage_path,
      provider_upload_id)
  FK(abort_generation_association_id, target_id,
     cleanup_generation_member_id, cleanup_operation_id,
     object_generation_id, storage_path, provider_upload_id,
     abort_remote_write_generation_id) ->
    storage_object_cleanup_multipart_abort_generations(
      id, target_id, cleanup_generation_member_id,
      cleanup_operation_id, object_generation_id, storage_path,
      provider_upload_id, remote_write_generation_id)
  FK(abort_terminal_result_id, abort_remote_write_generation_id) ->
    storage_remote_write_terminal_results(
      id, remote_write_generation_id)

storage_object_orphan_discovery_candidates    # immutable provider observation
  id UUID PK
  storage_path TEXT
  discovery_generation BIGINT
  provider_observation_sha256 TEXT
  observed_etag TEXT
  observed_size_bytes BIGINT
  observed_last_modified TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(storage_path, discovery_generation)
  UNIQUE(id, storage_path)

storage_object_cleanup_media_owners            # exactly one owner arm per operation
  id UUID PK
  cleanup_operation_id UUID UNIQUE
  media_id UUID FK media
  storage_path TEXT
  created_at TIMESTAMPTZ
  UNIQUE(media_id, cleanup_operation_id)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)

storage_object_cleanup_upload_session_owners
  id UUID PK
  cleanup_operation_id UUID UNIQUE
  upload_session_object_generation_id UUID UNIQUE
  storage_path TEXT
  created_at TIMESTAMPTZ
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(upload_session_object_generation_id, storage_path) ->
    storage_upload_session_object_generations(id, storage_path)

storage_object_cleanup_video_copy_owners       # canonical video-object cleanup arm
  id UUID PK
  cleanup_operation_id UUID UNIQUE
  storage_object_id UUID UNIQUE
  object_generation_id UUID
  storage_path TEXT
  created_at TIMESTAMPTZ
  UNIQUE(cleanup_operation_id, storage_object_id)
  UNIQUE(cleanup_operation_id, storage_object_id,
         object_generation_id, storage_path)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(storage_object_id, object_generation_id, storage_path) ->
    media_video_storage_objects(id, object_generation_id, storage_path)

storage_upload_session_object_generations      # stable object, not a credential
  id UUID PK
  object_generation_id UUID UNIQUE
  upload_session_id UUID FK media_upload_sessions
  upload_generation BIGINT
  storage_path TEXT
  created_at TIMESTAMPTZ
  UNIQUE(upload_session_id, upload_generation)
  UNIQUE(id, storage_path)
  UNIQUE(id, object_generation_id, storage_path)
  FK(object_generation_id, storage_path) ->
    storage_object_generations(id, storage_path)

storage_upload_session_remote_write_generations # one per possibly delivered PUT credential
  id UUID PK
  remote_write_generation_id UUID UNIQUE
  producer_id UUID
  upload_session_object_generation_id UUID
  object_generation_id UUID
  storage_path TEXT
  credential_issuance_generation BIGINT
  credential_scope_sha256 TEXT
  signing_key_version TEXT
  signed_request_sha256 TEXT
  signed_url_sha256 TEXT
  issued_at TIMESTAMPTZ
  credential_expires_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(upload_session_object_generation_id, credential_issuance_generation)
  UNIQUE(id, object_generation_id, storage_path)
  FK(producer_id, upload_session_object_generation_id,
     object_generation_id, storage_path) ->
    storage_object_generation_upload_session_producer_owners(
      producer_id, upload_session_object_generation_id,
      object_generation_id, storage_path)
  FK(upload_session_object_generation_id, object_generation_id, storage_path) ->
    storage_upload_session_object_generations(
      id, object_generation_id, storage_path)
  FK(remote_write_generation_id, producer_id, object_generation_id, storage_path) ->
    storage_remote_write_generations(
      id, producer_id, object_generation_id, storage_path)

storage_object_cleanup_legacy_teardown_owners
  id UUID PK
  cleanup_operation_id UUID UNIQUE
  legacy_teardown_identity_sha256 TEXT UNIQUE
  storage_path TEXT
  created_at TIMESTAMPTZ
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)

storage_object_cleanup_media_teardown_path_owners
  id UUID PK
  cleanup_operation_id UUID UNIQUE
  teardown_storage_path_id UUID UNIQUE
  storage_path TEXT
  created_at TIMESTAMPTZ
  UNIQUE(teardown_storage_path_id, cleanup_operation_id)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(teardown_storage_path_id, storage_path) ->
    media_teardown_storage_paths(id, storage_path)

storage_object_cleanup_orphan_discovery_owners # sixth exact owner arm
  id UUID PK
  cleanup_operation_id UUID UNIQUE
  orphan_candidate_id UUID UNIQUE
  storage_path TEXT
  created_at TIMESTAMPTZ
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(orphan_candidate_id, storage_path) ->
    storage_object_orphan_discovery_candidates(id, storage_path)

storage_object_cleanup_remote_write_fences    # mandatory terminal-write proof
  id UUID PK
  cleanup_operation_id UUID UNIQUE FK storage_object_cleanup_operations
  fence_kind TEXT                              # StructuralNeverArmed |
                                               # AllKnownWriteGenerationsFenced |
                                               # ProviderTerminalPath
  object_generation_set_sha256 TEXT
  creator_producer_set_sha256 TEXT
  creator_remote_write_generation_count BIGINT
  creator_writer_set_sha256 TEXT
  provider_contract_sha256 TEXT nullable
  provider_evidence_sha256 TEXT nullable
  fenced_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, cleanup_operation_id)
  UNIQUE(id, cleanup_operation_id, object_generation_set_sha256)

storage_object_cleanup_multipart_settlements  # final sealed target/list proof
  id UUID PK
  cleanup_operation_id UUID UNIQUE
  storage_path TEXT
  remote_write_fence_id UUID UNIQUE
  scope TEXT                                  # NotApplicable |
                                              # CompleteListSettled
  multipart_capable_creator_count BIGINT
  multipart_capable_creator_set_sha256 TEXT
  multipart_creator_generation_count BIGINT
  multipart_creator_generation_set_sha256 TEXT
  final_multipart_observation_id UUID nullable UNIQUE
  final_provider_upload_count BIGINT
  final_provider_upload_set_sha256 TEXT
  target_completion_count BIGINT
  target_completion_set_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, cleanup_operation_id)
  UNIQUE(id, cleanup_operation_id, remote_write_fence_id)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(remote_write_fence_id, cleanup_operation_id) ->
    storage_object_cleanup_remote_write_fences(id, cleanup_operation_id)
  FK(final_multipart_observation_id, cleanup_operation_id, storage_path,
     final_provider_upload_count, final_provider_upload_set_sha256) ->
    storage_object_cleanup_multipart_observations(
      id, cleanup_operation_id, storage_path,
      provider_upload_count, provider_upload_set_sha256)

storage_object_cleanup_object_absences       # sole authenticated post-fence HEAD fact
  id UUID PK
  cleanup_operation_id UUID UNIQUE
  storage_path TEXT
  remote_write_fence_id UUID UNIQUE
  multipart_settlement_id UUID UNIQUE
  object_generation_set_sha256 TEXT
  object_generation_count BIGINT
  head_request_sha256 TEXT
  head_response_sha256 TEXT
  provider_request_identity_sha256 TEXT
  observed_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, cleanup_operation_id, storage_path)
  FK(cleanup_operation_id, storage_path) ->
    storage_object_cleanup_operations(id, storage_path)
  FK(remote_write_fence_id, cleanup_operation_id,
     object_generation_set_sha256) ->
    storage_object_cleanup_remote_write_fences(
      id, cleanup_operation_id, object_generation_set_sha256)
  FK(multipart_settlement_id, cleanup_operation_id,
     remote_write_fence_id) ->
    storage_object_cleanup_multipart_settlements(
      id, cleanup_operation_id, remote_write_fence_id)

storage_object_cleanup_object_absence_generation_members
  id UUID PK
  cleanup_object_absence_id UUID
  cleanup_generation_member_id UUID UNIQUE
  cleanup_operation_id UUID
  object_generation_id UUID
  storage_path TEXT
  created_at TIMESTAMPTZ
  UNIQUE(cleanup_object_absence_id, object_generation_id)
  UNIQUE(id, cleanup_object_absence_id, cleanup_operation_id,
         object_generation_id, storage_path)
  FK(cleanup_object_absence_id, cleanup_operation_id, storage_path) ->
    storage_object_cleanup_object_absences(
      id, cleanup_operation_id, storage_path)
  FK(cleanup_generation_member_id, cleanup_operation_id,
     object_generation_id, storage_path) ->
    storage_object_cleanup_generation_members(
      id, cleanup_operation_id, object_generation_id, storage_path)

storage_object_cleanup_suspensions             # unexpected dead occurrence
  id UUID PK
  cleanup_operation_id UUID FK storage_object_cleanup_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(cleanup_operation_id, occurrence_no)

storage_object_cleanup_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK storage_object_cleanup_suspensions
  resolution TEXT                              # Requeued only
  created_at TIMESTAMPTZ

media_teardown_suspensions                     # intent id is operation identity
  id UUID PK
  teardown_intent_id UUID FK media_teardown_intents
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(teardown_intent_id, occurrence_no)

media_teardown_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_teardown_suspensions
  resolution TEXT                              # Requeued only
  created_at TIMESTAMPTZ

embedding_usage_charges                       # account-owned; survives Media teardown
  id UUID PK
  user_id UUID FK users
  provider TEXT
  model_id TEXT
  provider_operation_ref TEXT nullable
  billed_units BIGINT
  charge_evidence_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, user_id)
  UNIQUE(provider, provider_operation_ref)

media_content_reindex_operations              # exact existing index revision
  id UUID PK
  media_id UUID FK media
  revision BIGINT
  reason TEXT
  created_at TIMESTAMPTZ
  UNIQUE(media_id, revision)
  UNIQUE(id, media_id)

media_active_content_reindex_operations
  id UUID PK
  media_id UUID UNIQUE
  operation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(operation_id, media_id) -> media_content_reindex_operations(id, media_id)

media_content_reindex_embedding_intents       # one exact billed batch
  id UUID PK
  media_id UUID
  operation_id UUID
  batch_ordinal INTEGER
  request_sha256 TEXT
  provider TEXT
  model_id TEXT
  dimensions INTEGER
  authorizing_user_id UUID FK users
  authorization_context_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(operation_id, batch_ordinal)
  UNIQUE(id, operation_id, media_id)
  UNIQUE(id, authorizing_user_id)
  FK(operation_id, media_id) -> media_content_reindex_operations(id, media_id)

media_content_reindex_embedding_results
  id UUID PK
  embedding_intent_id UUID UNIQUE
  response_sha256 TEXT
  vector_bundle_sha256 TEXT
  authorizing_user_id UUID
  usage_charge_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, embedding_intent_id)
  FK(embedding_intent_id, authorizing_user_id) ->
    media_content_reindex_embedding_intents(id, authorizing_user_id)
  FK(usage_charge_id, authorizing_user_id) ->
    embedding_usage_charges(id, user_id)

media_content_reindex_embedding_result_vectors # exact ordered durable result
  id UUID PK
  embedding_result_id UUID
  input_ordinal INTEGER
  embedding_f32 BYTEA
  embedding_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(embedding_result_id, input_ordinal)
  FK(embedding_result_id) -> media_content_reindex_embedding_results(id)

media_content_reindex_embedding_uncertainties
  id UUID PK
  embedding_intent_id UUID UNIQUE FK media_content_reindex_embedding_intents
  reason_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, embedding_intent_id)

media_content_reindex_embedding_resolutions
  id UUID PK
  uncertainty_id UUID UNIQUE
  embedding_intent_id UUID UNIQUE
  resolution TEXT                           # RecoveredResult | ChargedNoResult
  recovered_result_id UUID nullable UNIQUE
  charged_no_result_usage_charge_id UUID nullable UNIQUE
  authorizing_user_id UUID
  operator_user_id UUID FK users
  authorization_context_sha256 TEXT
  created_at TIMESTAMPTZ
  FK(uncertainty_id, embedding_intent_id) ->
    media_content_reindex_embedding_uncertainties(id, embedding_intent_id)
  FK(recovered_result_id, embedding_intent_id) ->
    media_content_reindex_embedding_results(id, embedding_intent_id)
  FK(embedding_intent_id, authorizing_user_id) ->
    media_content_reindex_embedding_intents(id, authorizing_user_id)
  FK(charged_no_result_usage_charge_id, authorizing_user_id) ->
    embedding_usage_charges(id, user_id)

media_content_reindex_completions
  id UUID PK
  operation_id UUID UNIQUE FK media_content_reindex_operations
  created_at TIMESTAMPTZ

media_content_reindex_failures
  id UUID PK
  operation_id UUID UNIQUE FK media_content_reindex_operations
  error_code TEXT
  created_at TIMESTAMPTZ

media_content_reindex_cancellations
  id UUID PK
  operation_id UUID UNIQUE FK media_content_reindex_operations
  created_at TIMESTAMPTZ

media_content_reindex_suspensions
  id UUID PK
  operation_id UUID FK media_content_reindex_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(operation_id, occurrence_no)

media_content_reindex_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_content_reindex_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

media_metadata_enrichment_operations           # exact enrichment generation
  id UUID PK
  media_id UUID FK media
  request_fingerprint_sha256 TEXT
  attempt_no INTEGER
  created_at TIMESTAMPTZ
  UNIQUE(media_id, request_fingerprint_sha256, attempt_no)
  UNIQUE(id, media_id)

media_active_metadata_enrichment_operations
  id UUID PK
  media_id UUID UNIQUE
  operation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(operation_id, media_id) -> media_metadata_enrichment_operations(id, media_id)

media_metadata_enrichment_dispatch_intents
  id UUID PK
  media_id UUID
  operation_id UUID
  step_ordinal INTEGER
  step_kind TEXT
  request_sha256 TEXT
  provider TEXT
  model_id TEXT
  authorizing_user_id UUID FK users
  authorization_context_sha256 TEXT
  agent_turn_id UUID UNIQUE FK agent_turns
  created_at TIMESTAMPTZ
  UNIQUE(operation_id, step_ordinal)
  UNIQUE(id, operation_id, media_id)
  FK(operation_id, media_id) -> media_metadata_enrichment_operations(id, media_id)

media_metadata_enrichment_dispatch_results
  id UUID PK
  dispatch_intent_id UUID UNIQUE FK media_metadata_enrichment_dispatch_intents
  response_sha256 TEXT
  opaque_session_ref_sha256 TEXT
  normalized_usage_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, dispatch_intent_id)

media_metadata_enrichment_dispatch_uncertainties
  id UUID PK
  dispatch_intent_id UUID UNIQUE FK media_metadata_enrichment_dispatch_intents
  reason_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, dispatch_intent_id)

media_metadata_enrichment_dispatch_resolutions
  id UUID PK
  uncertainty_id UUID UNIQUE
  dispatch_intent_id UUID UNIQUE
  resolution TEXT                           # RecoveredResult | NoRecoverableResult
  recovered_result_id UUID nullable UNIQUE
  operator_user_id UUID FK users
  authorization_context_sha256 TEXT
  created_at TIMESTAMPTZ
  FK(uncertainty_id, dispatch_intent_id) ->
    media_metadata_enrichment_dispatch_uncertainties(id, dispatch_intent_id)
  FK(recovered_result_id, dispatch_intent_id) ->
    media_metadata_enrichment_dispatch_results(id, dispatch_intent_id)

media_metadata_enrichment_completions
  id UUID PK
  operation_id UUID UNIQUE FK media_metadata_enrichment_operations
  created_at TIMESTAMPTZ

media_metadata_enrichment_failures
  id UUID PK
  operation_id UUID UNIQUE FK media_metadata_enrichment_operations
  error_code TEXT
  created_at TIMESTAMPTZ

media_metadata_enrichment_cancellations
  id UUID PK
  operation_id UUID UNIQUE FK media_metadata_enrichment_operations
  created_at TIMESTAMPTZ

media_metadata_enrichment_suspensions
  id UUID PK
  operation_id UUID FK media_metadata_enrichment_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(operation_id, occurrence_no)

media_metadata_enrichment_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_metadata_enrichment_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

media_unit_build_operations                    # immutable billed build generation
  id UUID PK
  media_id UUID FK media
  content_fingerprint TEXT
  attempt_no INTEGER
  created_at TIMESTAMPTZ
  UNIQUE(media_id, content_fingerprint, attempt_no)
  UNIQUE(id, media_id)

media_active_unit_build_operations
  id UUID PK
  media_id UUID UNIQUE
  operation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(operation_id, media_id) -> media_unit_build_operations(id, media_id)

media_unit_build_dispatch_intents
  id UUID PK
  media_id UUID
  operation_id UUID
  step_ordinal INTEGER
  request_sha256 TEXT
  provider TEXT
  model_id TEXT
  authorizing_user_id UUID FK users
  authorization_context_sha256 TEXT
  llm_call_id UUID UNIQUE FK llm_calls
  created_at TIMESTAMPTZ
  UNIQUE(operation_id, step_ordinal)
  UNIQUE(id, operation_id, media_id)
  FK(operation_id, media_id) -> media_unit_build_operations(id, media_id)

media_unit_build_dispatch_results
  id UUID PK
  dispatch_intent_id UUID UNIQUE FK media_unit_build_dispatch_intents
  response_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, dispatch_intent_id)

media_unit_build_dispatch_uncertainties
  id UUID PK
  dispatch_intent_id UUID UNIQUE FK media_unit_build_dispatch_intents
  reason_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, dispatch_intent_id)

media_unit_build_dispatch_resolutions
  id UUID PK
  uncertainty_id UUID UNIQUE
  dispatch_intent_id UUID UNIQUE
  resolution TEXT                           # RecoveredResult | ChargedNoResult
  recovered_result_id UUID nullable UNIQUE
  operator_user_id UUID FK users
  authorization_context_sha256 TEXT
  created_at TIMESTAMPTZ
  FK(uncertainty_id, dispatch_intent_id) ->
    media_unit_build_dispatch_uncertainties(id, dispatch_intent_id)
  FK(recovered_result_id, dispatch_intent_id) ->
    media_unit_build_dispatch_results(id, dispatch_intent_id)

media_unit_build_completions
  id UUID PK
  operation_id UUID UNIQUE FK media_unit_build_operations
  created_at TIMESTAMPTZ

media_unit_build_failures
  id UUID PK
  operation_id UUID UNIQUE FK media_unit_build_operations
  error_code TEXT
  created_at TIMESTAMPTZ

media_unit_build_cancellations
  id UUID PK
  operation_id UUID UNIQUE FK media_unit_build_operations
  created_at TIMESTAMPTZ

media_unit_build_suspensions
  id UUID PK
  operation_id UUID FK media_unit_build_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(operation_id, occurrence_no)

media_unit_build_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_unit_build_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

media_timeline_heads                         # sole current-generation pointer
  id UUID PK
  media_id UUID UNIQUE FK media
  current_timeline_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  FK(current_timeline_id, media_id) -> media_timelines(id, media_id)

media_user_title_states                     # persistent CAS state; survives clear
  id UUID PK
  media_id UUID UNIQUE FK media
  write_revision BIGINT
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  UNIQUE(id, media_id)

media_user_title_values                     # row existence = authored title present
  id UUID PK
  media_id UUID UNIQUE
  title_state_id UUID UNIQUE
  authored_by_user_id UUID FK users
  title TEXT
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  FK(title_state_id, media_id) -> media_user_title_states(id, media_id)

media_timelines                              # stable generation identity
  id UUID PK
  media_id UUID FK media
  generation BIGINT
  UNIQUE(media_id, generation)
  UNIQUE(id, media_id)
  duration_ms BIGINT nullable
  duration_source TEXT nullable              # PodcastMetadataAdvisory |
                                             # OwnedVideoProbe
  binding_epoch BIGINT
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

media_timeline_copy_bindings                 # row existence = first-copy bind
  id UUID PK
  media_id UUID
  timeline_id UUID UNIQUE
  copy_attempt_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(copy_attempt_id, media_id) -> media_source_attempts(id, media_id)

media_timeline_owned_video_identities        # immutable after insertion
  id UUID PK
  media_id UUID
  timeline_id UUID UNIQUE
  UNIQUE(id, media_id)
  sha256 TEXT
  profile TEXT                               # CompatibleMp4V1
  derivation_version TEXT                  # audit provenance, not identity alone
  created_at TIMESTAMPTZ
  FK(timeline_id, media_id) -> media_timelines(id, media_id)

media_video_copy_reconciliations             # attempt-wide cleanup/publication owner
  id UUID PK
  media_id UUID
  source_attempt_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  FK(source_attempt_id, media_id) -> media_source_attempts(id, media_id)

media_video_reconciliation_uncertainties     # immutable external-I/O ambiguity
  id UUID PK
  remote_mutation_dispatch_intent_id UUID UNIQUE
  reason_code TEXT
  created_at TIMESTAMPTZ
  FK(remote_mutation_dispatch_intent_id) ->
    media_video_remote_mutation_dispatch_intents(id)

media_video_reconciliation_uncertainty_resolutions
  id UUID PK
  uncertainty_id UUID UNIQUE FK media_video_reconciliation_uncertainties
  resolution TEXT                            # Verified | Absent | Superseded
  created_at TIMESTAMPTZ

media_video_storage_objects                  # neutral allocated object identity
  id UUID PK
  object_generation_id UUID UNIQUE
  media_id UUID
  reconciliation_id UUID
  source_run_count INTEGER
  storage_path TEXT UNIQUE                   # canonical path containing random suffix; not authority
  expected_sha256 TEXT
  expected_size_bytes BIGINT
  expected_duration_ms BIGINT
  expected_width INTEGER
  expected_height INTEGER
  expected_max_av_skew_ms BIGINT
  expected_profile TEXT
  expected_derivation_version TEXT
  integrity_mode TEXT
  expected_content_type TEXT
  expected_content_disposition TEXT
  expected_cache_control TEXT
  local_writer_quiescence_not_before TIMESTAMPTZ # exact run, NOT NULL
  created_at TIMESTAMPTZ
  UNIQUE(reconciliation_id, source_run_count)
  UNIQUE(id, media_id)
  UNIQUE(id, reconciliation_id, media_id)
  UNIQUE(id, object_generation_id, storage_path)
  FK(reconciliation_id, media_id) -> media_video_copy_reconciliations(id, media_id)
  FK(object_generation_id, storage_path) ->
    storage_object_generations(id, storage_path)

media_video_multipart_allocations            # transient upload state
  id UUID PK
  media_id UUID
  storage_object_id UUID UNIQUE
  upload_id TEXT
  created_at TIMESTAMPTZ
  UNIQUE(storage_object_id, upload_id)        # provider identity is path + upload id
  FK(storage_object_id, media_id) -> media_video_storage_objects(id, media_id)

media_video_remote_mutation_dispatch_intents # durable before every R2 mutation
  id UUID PK
  remote_write_generation_id UUID UNIQUE
  producer_id UUID
  producer_operation_kind TEXT
  producer_domain_operation_id UUID
  storage_object_id UUID FK media_video_storage_objects
  object_generation_id UUID
  storage_path TEXT
  video_operation_identity_sha256 TEXT       # video run/part/upload association only;
                                             # kind/request/arm time live on generic row
  created_at TIMESTAMPTZ
  UNIQUE(id, remote_write_generation_id)
  FK(producer_id, producer_operation_kind, producer_domain_operation_id,
     object_generation_id, storage_path) ->
    storage_object_generation_stable_operation_producer_owners(
      producer_id, operation_kind, domain_operation_id,
      object_generation_id, storage_path)
  FK(storage_object_id, object_generation_id, storage_path) ->
    media_video_storage_objects(id, object_generation_id, storage_path)
  FK(remote_write_generation_id, producer_id, object_generation_id, storage_path) ->
    storage_remote_write_generations(
      id, producer_id, object_generation_id, storage_path)

media_video_reconciliation_plans             # immutable prepare/IO/settle fence
  id UUID PK
  media_id UUID
  reconciliation_id UUID
  occurrence_no INTEGER
  storage_object_id UUID nullable
  upload_id_snapshot TEXT nullable             # required for upload-bound actions
  part_cursor_snapshot TEXT nullable            # bounded provider checkpoint
  action TEXT                                 # Inspect | DiscoverMultipart |
                                              # Verify | ProveNoObject
  local_writer_horizon_snapshot TIMESTAMPTZ nullable
  created_at TIMESTAMPTZ
  UNIQUE(reconciliation_id, occurrence_no)
  UNIQUE(id, media_id)
  UNIQUE(id, reconciliation_id, media_id)
  FK(reconciliation_id, media_id) -> media_video_copy_reconciliations(id, media_id)
  FK(storage_object_id, reconciliation_id, media_id) ->
    media_video_storage_objects(id, reconciliation_id, media_id)

media_video_reconciliation_multipart_observations # sealed complete LIST result
  id UUID PK
  reconciliation_plan_id UUID UNIQUE
  reconciliation_id UUID
  media_id UUID
  discovered_upload_count BIGINT
  discovered_upload_set_sha256 TEXT
  provider_response_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, reconciliation_plan_id, reconciliation_id, media_id)
  FK(reconciliation_plan_id, reconciliation_id, media_id) ->
    media_video_reconciliation_plans(id, reconciliation_id, media_id)

media_video_reconciliation_discovered_uploads # one member of complete LIST result
  id UUID PK
  multipart_observation_id UUID
  reconciliation_plan_id UUID
  reconciliation_id UUID
  media_id UUID
  storage_object_id UUID
  provider_upload_id TEXT
  disposition TEXT                           # Adopted | CleanupRequired
  cleanup_target_id UUID nullable
  cleanup_generation_member_id UUID nullable
  cleanup_operation_id UUID nullable
  object_generation_id UUID
  storage_path TEXT
  created_at TIMESTAMPTZ
  UNIQUE(reconciliation_plan_id, provider_upload_id)
  FK(multipart_observation_id, reconciliation_plan_id,
     reconciliation_id, media_id) ->
    media_video_reconciliation_multipart_observations(
      id, reconciliation_plan_id, reconciliation_id, media_id)
  FK(storage_object_id, reconciliation_id, media_id) ->
    media_video_storage_objects(id, reconciliation_id, media_id)
  FK(storage_object_id, object_generation_id, storage_path) ->
    media_video_storage_objects(id, object_generation_id, storage_path)
  FK(cleanup_target_id, cleanup_generation_member_id, cleanup_operation_id,
     object_generation_id, storage_path, provider_upload_id) ->
    storage_object_cleanup_multipart_targets(
      id, cleanup_generation_member_id, cleanup_operation_id,
      object_generation_id, storage_path, provider_upload_id)

media_video_active_reconciliation_plans      # at most one unsettled IO plan
  id UUID PK
  media_id UUID
  reconciliation_id UUID UNIQUE
  plan_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(reconciliation_id, media_id) -> media_video_copy_reconciliations(id, media_id)
  FK(plan_id, reconciliation_id, media_id) ->
    media_video_reconciliation_plans(id, reconciliation_id, media_id)

media_video_reconciliation_plan_resolutions  # immutable settle/supersede outcome
  id UUID PK
  plan_id UUID UNIQUE FK media_video_reconciliation_plans
  resolution TEXT                            # Settled | Superseded
  reason_code TEXT
  created_at TIMESTAMPTZ

media_video_copy_cancellation_requests       # one generation-wide cancel intent
  id UUID PK
  media_id UUID
  source_attempt_id UUID UNIQUE
  requested_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  FK(source_attempt_id, media_id) -> media_source_attempts(id, media_id)

media_video_copy_suspensions                 # unexpected dead producer occurrence
  id UUID PK
  source_attempt_id UUID FK media_source_attempts
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(source_attempt_id, occurrence_no)

media_video_copy_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_video_copy_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

media_video_storage_reconcile_suspensions    # unexpected dead reconcile occurrence
  id UUID PK
  reconciliation_id UUID FK media_video_copy_reconciliations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(reconciliation_id, occurrence_no)

media_video_storage_reconcile_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_video_storage_reconcile_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

media_video_storage_verifications            # final object passed selected integrity mode
  id UUID PK
  media_id UUID
  storage_object_id UUID UNIQUE
  verified_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, storage_object_id, media_id)
  FK(storage_object_id, media_id) -> media_video_storage_objects(id, media_id)

media_video_storage_absences                 # failed/cancelled run cleanup converged
  id UUID PK
  media_id UUID
  storage_object_id UUID UNIQUE
  object_generation_id UUID
  storage_path TEXT
  cleanup_operation_id UUID UNIQUE
  cleanup_object_absence_id UUID UNIQUE
  cleanup_object_absence_generation_member_id UUID UNIQUE
  reason_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, storage_object_id, cleanup_operation_id)
  FK(storage_object_id, media_id) ->
    media_video_storage_objects(id, media_id)
  FK(storage_object_id, object_generation_id, storage_path) ->
    media_video_storage_objects(id, object_generation_id, storage_path)
  FK(cleanup_operation_id, storage_object_id,
     object_generation_id, storage_path) ->
    storage_object_cleanup_video_copy_owners(
      cleanup_operation_id, storage_object_id,
      object_generation_id, storage_path)
  FK(cleanup_object_absence_id, cleanup_operation_id, storage_path) ->
    storage_object_cleanup_object_absences(
      id, cleanup_operation_id, storage_path)
  FK(cleanup_object_absence_generation_member_id,
     cleanup_object_absence_id, cleanup_operation_id,
     object_generation_id, storage_path) ->
    storage_object_cleanup_object_absence_generation_members(
      id, cleanup_object_absence_id, cleanup_operation_id,
      object_generation_id, storage_path)

media_video_contents                         # immutable verified content record
  id UUID PK
  media_id UUID
  timeline_id UUID
  owned_identity_id UUID
  storage_verification_id UUID UNIQUE
  size_bytes BIGINT
  duration_ms BIGINT                         # conformance input; wire reads Timeline
  width INTEGER
  height INTEGER
  max_av_skew_ms BIGINT
  worker_image_digest TEXT                 # build attestation, non-semantic
  upload_protocol_version TEXT             # storage provenance, non-semantic
  verified_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, storage_verification_id, media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(owned_identity_id, media_id) -> media_timeline_owned_video_identities(id, media_id)
  FK(storage_verification_id, media_id) -> media_video_storage_verifications(id, media_id)

media_video_assets                           # row existence = current publication
  id UUID PK
  media_id UUID UNIQUE FK media
  timeline_id UUID
  content_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(content_id, media_id) -> media_video_contents(id, media_id)

media_youtube_video_copy_lifecycle_operations # stable compliance identity per content
  id UUID PK
  media_id UUID
  content_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, content_id, media_id)
  FK(content_id, media_id) -> media_video_contents(id, media_id)

provider_compliance_schedule_gate             # seeded singleton placement mutex
  id UUID PK
  gate_kind TEXT UNIQUE                       # YouTubeRestrictedData
  placement_generation BIGINT
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

provider_compliance_placement_generations     # append-only placement snapshots
  id UUID PK
  schedule_gate_id UUID
  placement_generation BIGINT
  placement_input_count BIGINT
  placement_input_set_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(schedule_gate_id, placement_generation)
  UNIQUE(id, schedule_gate_id, placement_generation,
         placement_input_count, placement_input_set_sha256)
  FK(schedule_gate_id) -> provider_compliance_schedule_gate(id)

provider_compliance_execution_slots           # fixed, partitioned deadline workers
  id UUID PK
  lane_kind TEXT                              # VideoCopy | Caption | OwnedAsr |
                                              # OAuth
  slot_no INTEGER
  created_at TIMESTAMPTZ
  UNIQUE(lane_kind, slot_no)
  UNIQUE(id, lane_kind, slot_no)

provider_compliance_capacity_allocations      # neutral immutable slot/window fact
  id UUID PK
  allocation_kind TEXT                       # VideoCopy | Caption | OwnedAsr |
                                              # OAuth
  schedule_gate_id UUID
  placement_id UUID UNIQUE
  placement_generation BIGINT
  execution_slot_id UUID
  execution_lane_kind TEXT
  execution_slot_no INTEGER
  compliance_delete_deadline TIMESTAMPTZ
  placement_input_count BIGINT
  placement_input_set_sha256 TEXT
  constants_sha256 TEXT
  scheduled_window_start TIMESTAMPTZ
  scheduled_window_end TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, allocation_kind)
  UNIQUE(schedule_gate_id, placement_generation)
  UNIQUE(execution_slot_id, scheduled_window_start, scheduled_window_end)
  FK(schedule_gate_id) -> provider_compliance_schedule_gate(id)
  FK(placement_id, schedule_gate_id, placement_generation,
     placement_input_count, placement_input_set_sha256) ->
    provider_compliance_placement_generations(
      id, schedule_gate_id, placement_generation,
      placement_input_count, placement_input_set_sha256)
  FK(execution_slot_id, execution_lane_kind, execution_slot_no) ->
    provider_compliance_execution_slots(id, lane_kind, slot_no)

provider_compliance_video_capacity_allocations # typed absolute phase schedule
  id UUID PK
  capacity_allocation_id UUID UNIQUE
  allocation_kind TEXT                         # VideoCopy
  approval_artifact_sha256 TEXT
  approval_policy_version TEXT
  disposition TEXT                             # MayRetainUntil |
                                               # UnpublishAndDeleteBy
  retain_until TIMESTAMPTZ nullable
  purge_due_at TIMESTAMPTZ
  provider_min_disposition_notice_seconds BIGINT
  provider_disposition_contract_sha256 TEXT
  schedule_revision BIGINT
  workflow_member_ceiling BIGINT                # 1 owned-ASR allocation
  root_invocation_ceiling BIGINT                # 4
  owned_asr_finalize_invocation_ceiling BIGINT  # 1 after the root Fence
  removal_invocation_ceiling BIGINT             # 2
  cleanup_invocation_ceiling BIGINT             # 2
  queue_handoff_ceiling BIGINT                  # 8
  recovery_invocation_ceiling BIGINT             # 4
  fence_not_after TIMESTAMPTZ
  writer_drain_not_after TIMESTAMPTZ
  owned_asr_finalize_not_after TIMESTAMPTZ
  writers_finalize_not_after TIMESTAMPTZ
  removal_activation_not_after TIMESTAMPTZ
  cleanup_terminal_not_after TIMESTAMPTZ
  removal_completion_not_after TIMESTAMPTZ
  root_finalize_not_after TIMESTAMPTZ
  root_settlement_not_after TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, capacity_allocation_id)
  FK(capacity_allocation_id, allocation_kind) ->
    provider_compliance_capacity_allocations(id, allocation_kind)

provider_compliance_caption_capacity_allocations # typed immutable phase plan
  id UUID PK
  capacity_allocation_id UUID UNIQUE
  allocation_kind TEXT                         # Caption
  deadline_basis_sha256 TEXT
  schedule_revision BIGINT
  wave_no BIGINT
  deadline_fence_not_after TIMESTAMPTZ
  writer_drain_not_after TIMESTAMPTZ
  deadline_finalize_not_after TIMESTAMPTZ
  deadline_settlement_not_after TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, capacity_allocation_id)
  FK(capacity_allocation_id, allocation_kind) ->
    provider_compliance_capacity_allocations(id, allocation_kind)

provider_compliance_owned_asr_capacity_allocations # typed immutable phase plan
  id UUID PK
  capacity_allocation_id UUID UNIQUE
  allocation_kind TEXT                         # OwnedAsr
  deadline_basis_sha256 TEXT
  schedule_revision BIGINT
  wave_no BIGINT
  deadline_fence_not_after TIMESTAMPTZ
  writer_drain_not_after TIMESTAMPTZ
  deadline_finalize_not_after TIMESTAMPTZ
  deadline_settlement_not_after TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, capacity_allocation_id)
  FK(capacity_allocation_id, allocation_kind) ->
    provider_compliance_capacity_allocations(id, allocation_kind)

provider_compliance_oauth_capacity_allocations # typed immutable phase plan
  id UUID PK
  capacity_allocation_id UUID UNIQUE
  allocation_kind TEXT                         # OAuth
  deadline_basis_sha256 TEXT
  schedule_revision BIGINT
  fence_not_after TIMESTAMPTZ
  local_drain_not_after TIMESTAMPTZ
  finalize_not_after TIMESTAMPTZ
  settlement_not_after TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, capacity_allocation_id)
  FK(capacity_allocation_id, allocation_kind) ->
    provider_compliance_capacity_allocations(id, allocation_kind)

provider_compliance_oauth_schedule_owners     # exact active OAuth deadline ref
  id UUID PK
  operation_kind TEXT
  domain_operation_id UUID
  capacity_allocation_id UUID UNIQUE
  oauth_capacity_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  UNIQUE(operation_kind, domain_operation_id)
  UNIQUE(id, operation_kind, domain_operation_id)
  FK(oauth_capacity_allocation_id, capacity_allocation_id) ->
    provider_compliance_oauth_capacity_allocations(
      id, capacity_allocation_id)

provider_compliance_oauth_authorization_expiry_owners # typed arm 1
  id UUID PK
  schedule_owner_id UUID UNIQUE
  expiry_operation_id UUID UNIQUE
  operation_kind TEXT                         # YouTubeOAuthAuthorizationAttemptExpiry
  created_at TIMESTAMPTZ
  FK(schedule_owner_id, operation_kind, expiry_operation_id) ->
    provider_compliance_oauth_schedule_owners(
      id, operation_kind, domain_operation_id)
  FK(expiry_operation_id) ->
    youtube_caption_oauth_authorization_attempt_expiry_operations(id)

provider_compliance_oauth_exchange_owners    # typed arm 2
  id UUID PK
  schedule_owner_id UUID UNIQUE
  exchange_intent_id UUID UNIQUE
  operation_kind TEXT                         # YouTubeOAuthExchange
  created_at TIMESTAMPTZ
  FK(schedule_owner_id, operation_kind, exchange_intent_id) ->
    provider_compliance_oauth_schedule_owners(
      id, operation_kind, domain_operation_id)
  FK(exchange_intent_id) -> youtube_caption_oauth_exchange_intents(id)

provider_compliance_oauth_pending_expiry_owners # typed arm 3
  id UUID PK
  schedule_owner_id UUID UNIQUE
  expiry_operation_id UUID UNIQUE
  operation_kind TEXT                         # YouTubeOAuthPendingExpiry
  created_at TIMESTAMPTZ
  FK(schedule_owner_id, operation_kind, expiry_operation_id) ->
    provider_compliance_oauth_schedule_owners(
      id, operation_kind, domain_operation_id)
  FK(expiry_operation_id) ->
    youtube_caption_oauth_pending_expiry_operations(id)

provider_compliance_oauth_binding_lifecycle_owners # typed arm 4
  id UUID PK
  schedule_owner_id UUID UNIQUE
  lifecycle_operation_id UUID UNIQUE
  operation_kind TEXT                         # YouTubeOAuthBindingLifecycle
  created_at TIMESTAMPTZ
  FK(schedule_owner_id, operation_kind, lifecycle_operation_id) ->
    provider_compliance_oauth_schedule_owners(
      id, operation_kind, domain_operation_id)
  FK(lifecycle_operation_id) ->
    youtube_caption_oauth_binding_lifecycle_operations(id)

provider_compliance_oauth_credential_revocation_owners # typed arm 5
  id UUID PK
  schedule_owner_id UUID UNIQUE
  revocation_id UUID UNIQUE
  operation_kind TEXT                         # YouTubeCredentialRevocation
  created_at TIMESTAMPTZ
  FK(schedule_owner_id, operation_kind, revocation_id) ->
    provider_compliance_oauth_schedule_owners(
      id, operation_kind, domain_operation_id)
  FK(revocation_id) -> youtube_caption_credential_revocations(id)

provider_compliance_phase_wake_sequences     # neutral exact operation owner
  id UUID PK
  operation_kind TEXT
  domain_operation_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(operation_kind, domain_operation_id)
  UNIQUE(id, operation_kind, domain_operation_id)

provider_compliance_phase_wake_registrations # immutable durable timer facts
  id UUID PK
  wake_sequence_id UUID
  operation_kind TEXT
  domain_operation_id UUID
  wake_generation BIGINT
  phase_fact_kind TEXT                       # DrainDue | FinalizeDue |
                                             # SettlementDue
  due_at TIMESTAMPTZ
  placement_id UUID
  schedule_gate_id UUID
  placement_generation BIGINT
  placement_input_count BIGINT
  placement_input_set_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(wake_sequence_id, wake_generation)
  UNIQUE(id, wake_sequence_id, operation_kind, domain_operation_id)
  FK(wake_sequence_id, operation_kind, domain_operation_id) ->
    provider_compliance_phase_wake_sequences(
      id, operation_kind, domain_operation_id)
  FK(placement_id, schedule_gate_id, placement_generation,
     placement_input_count, placement_input_set_sha256) ->
    provider_compliance_placement_generations(
      id, schedule_gate_id, placement_generation,
      placement_input_count, placement_input_set_sha256)

provider_compliance_current_phase_wakes      # sole current timer head
  id UUID PK
  wake_registration_id UUID UNIQUE
  wake_sequence_id UUID UNIQUE
  operation_kind TEXT
  domain_operation_id UUID
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  UNIQUE(operation_kind, domain_operation_id)
  UNIQUE(id, wake_sequence_id, operation_kind, domain_operation_id)
  FK(wake_registration_id, wake_sequence_id, operation_kind,
     domain_operation_id) ->
    provider_compliance_phase_wake_registrations(
      id, wake_sequence_id, operation_kind, domain_operation_id)

provider_compliance_video_phase_wake_owners  # typed wake-sequence owner arm
  id UUID PK
  wake_sequence_id UUID UNIQUE
  compliance_schedule_id UUID UNIQUE
  lifecycle_operation_id UUID UNIQUE
  operation_kind TEXT                        # YouTubeVideoCopyLifecycle
  created_at TIMESTAMPTZ
  FK(wake_sequence_id, operation_kind, lifecycle_operation_id) ->
    provider_compliance_phase_wake_sequences(
      id, operation_kind, domain_operation_id)
  FK(compliance_schedule_id, lifecycle_operation_id) ->
    media_youtube_video_copy_compliance_schedules(
      id, lifecycle_operation_id)

provider_compliance_caption_initial_phase_wake_owners # typed sequence owner arm
  id UUID PK
  wake_sequence_id UUID UNIQUE
  initial_reservation_id UUID UNIQUE
  operation_kind TEXT                        # YouTubeCaptionInitialLifecycle
  created_at TIMESTAMPTZ
  FK(wake_sequence_id, operation_kind, initial_reservation_id) ->
    provider_compliance_phase_wake_sequences(
      id, operation_kind, domain_operation_id)
  FK(initial_reservation_id, operation_kind) ->
    media_youtube_caption_initial_capacity_reservations(
      id, lifecycle_operation_kind)

provider_compliance_caption_phase_wake_owners # typed wake-sequence owner arm
  id UUID PK
  wake_sequence_id UUID UNIQUE
  compliance_schedule_id UUID UNIQUE
  lifecycle_operation_id UUID UNIQUE
  operation_kind TEXT                        # YouTubeCaptionLifecycle
  created_at TIMESTAMPTZ
  FK(wake_sequence_id, operation_kind, lifecycle_operation_id) ->
    provider_compliance_phase_wake_sequences(
      id, operation_kind, domain_operation_id)
  FK(compliance_schedule_id, lifecycle_operation_id) ->
    media_youtube_caption_compliance_schedules(id, lifecycle_operation_id)

provider_compliance_owned_asr_phase_wake_owners # typed sequence owner arm
  id UUID PK
  wake_sequence_id UUID UNIQUE
  compliance_schedule_id UUID UNIQUE
  lifecycle_operation_id UUID UNIQUE
  operation_kind TEXT                        # YouTubeOwnedAsrLifecycle
  created_at TIMESTAMPTZ
  FK(wake_sequence_id, operation_kind, lifecycle_operation_id) ->
    provider_compliance_phase_wake_sequences(
      id, operation_kind, domain_operation_id)
  FK(compliance_schedule_id, lifecycle_operation_id) ->
    media_youtube_owned_asr_compliance_schedules(id, lifecycle_operation_id)

provider_compliance_oauth_phase_wake_owners # typed wake-sequence owner arm
  id UUID PK
  wake_sequence_id UUID UNIQUE
  oauth_schedule_owner_id UUID UNIQUE
  operation_kind TEXT
  domain_operation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(wake_sequence_id, operation_kind, domain_operation_id) ->
    provider_compliance_phase_wake_sequences(
      id, operation_kind, domain_operation_id)
  FK(oauth_schedule_owner_id, operation_kind, domain_operation_id) ->
    provider_compliance_oauth_schedule_owners(
      id, operation_kind, domain_operation_id)

media_youtube_video_copy_compliance_schedule_reservations # pre-I/O capacity
  id UUID PK
  media_id UUID
  source_attempt_id UUID UNIQUE
  capacity_allocation_id UUID UNIQUE
  video_capacity_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  UNIQUE(id, media_id, source_attempt_id)
  FK(source_attempt_id, media_id) -> media_source_attempts(id, media_id)
  FK(video_capacity_allocation_id, capacity_allocation_id) ->
    provider_compliance_video_capacity_allocations(
      id, capacity_allocation_id)

media_youtube_video_copy_compliance_schedules # live owner of neutral capacity
  id UUID PK
  lifecycle_operation_id UUID UNIQUE
  media_id UUID
  content_id UUID UNIQUE
  capacity_allocation_id UUID UNIQUE
  video_capacity_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  UNIQUE(id, lifecycle_operation_id)
  UNIQUE(id, lifecycle_operation_id, content_id, media_id)
  FK(lifecycle_operation_id, content_id, media_id) ->
    media_youtube_video_copy_lifecycle_operations(id, content_id, media_id)
  FK(video_capacity_allocation_id, capacity_allocation_id) ->
    provider_compliance_video_capacity_allocations(
      id, capacity_allocation_id)

media_youtube_video_copy_compliance_fence_sets # pre-resolved writer/removal plan
  id UUID PK
  lifecycle_operation_id UUID UNIQUE
  compliance_schedule_id UUID UNIQUE
  media_id UUID
  content_id UUID UNIQUE
  storage_verification_id UUID
  storage_object_id UUID UNIQUE
  cleanup_operation_id UUID UNIQUE
  planned_removal_id UUID UNIQUE              # exact pair realized at Fence
  planned_removal_attempt_id UUID UNIQUE      # exact pair realized at Fence
  fence_generation_id UUID UNIQUE
  removal_coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT               # YouTubeVideoCopyLifecycle
  removal_observed_operation_kind TEXT       # VideoCopyRemoval
  operation_member_count BIGINT
  operation_member_set_sha256 TEXT
  fenced_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, lifecycle_operation_id, content_id, media_id)
  UNIQUE(id, planned_removal_id, planned_removal_attempt_id)
  UNIQUE(id, lifecycle_operation_id, planned_removal_id,
         planned_removal_attempt_id)
  UNIQUE(id, lifecycle_operation_id, planned_removal_id,
         planned_removal_attempt_id,
         removal_coordination_dependency_id)
  FK(lifecycle_operation_id, content_id, media_id) ->
    media_youtube_video_copy_lifecycle_operations(id, content_id, media_id)
  FK(compliance_schedule_id, lifecycle_operation_id, content_id, media_id) ->
    media_youtube_video_copy_compliance_schedules(
      id, lifecycle_operation_id, content_id, media_id)
  FK(content_id, storage_verification_id, media_id) ->
    media_video_contents(id, storage_verification_id, media_id)
  FK(storage_verification_id, storage_object_id, media_id) ->
    media_video_storage_verifications(id, storage_object_id, media_id)
  FK(cleanup_operation_id, storage_object_id) ->
    storage_object_cleanup_video_copy_owners(
      cleanup_operation_id, storage_object_id)
  FK(removal_coordination_dependency_id, observing_operation_kind,
     lifecycle_operation_id, removal_observed_operation_kind,
     planned_removal_attempt_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

media_youtube_video_copy_compliance_owned_asr_members # two typed child refs
  id UUID PK
  compliance_fence_set_id UUID
  root_lifecycle_operation_id UUID
  media_id UUID
  video_content_id UUID
  owned_asr_data_allocation_id UUID UNIQUE
  transcription_job_id UUID UNIQUE
  owned_asr_lifecycle_operation_id UUID UNIQUE
  work_coordination_dependency_id UUID UNIQUE
  lifecycle_coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT              # YouTubeVideoCopyLifecycle
  work_observed_operation_kind TEXT          # TranscribeMedia
  lifecycle_observed_operation_kind TEXT     # YouTubeOwnedAsrLifecycle
  created_at TIMESTAMPTZ
  UNIQUE(compliance_fence_set_id, owned_asr_data_allocation_id)
  FK(compliance_fence_set_id, root_lifecycle_operation_id,
     video_content_id, media_id) ->
    media_youtube_video_copy_compliance_fence_sets(
      id, lifecycle_operation_id, content_id, media_id)
  FK(owned_asr_data_allocation_id, transcription_job_id,
     video_content_id, media_id) ->
    media_youtube_owned_asr_data_allocations(
      id, transcription_job_id, video_content_id, media_id)
  FK(owned_asr_lifecycle_operation_id, owned_asr_data_allocation_id) ->
    media_youtube_owned_asr_lifecycle_operations(
      id, owned_asr_data_allocation_id)
  FK(work_coordination_dependency_id, observing_operation_kind,
     root_lifecycle_operation_id, work_observed_operation_kind,
     transcription_job_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)
  FK(lifecycle_coordination_dependency_id, observing_operation_kind,
     root_lifecycle_operation_id, lifecycle_observed_operation_kind,
     owned_asr_lifecycle_operation_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

media_youtube_video_copy_compliance_owned_asr_settled_members # receipt-backed replacement
  id UUID PK
  compliance_fence_set_id UUID
  root_lifecycle_operation_id UUID
  video_content_id UUID
  media_id UUID
  transcription_job_id UUID UNIQUE
  owned_asr_lifecycle_operation_id UUID UNIQUE
  work_terminal_receipt_id UUID UNIQUE
  lifecycle_terminal_receipt_id UUID UNIQUE
  work_operation_kind TEXT                    # TranscribeMedia
  lifecycle_operation_kind TEXT               # YouTubeOwnedAsrLifecycle
  owned_asr_compliance_receipt_id UUID UNIQUE
  work_compliance_receipt_id UUID UNIQUE
  lifecycle_operation_identity_sha256 TEXT
  transcription_job_identity_sha256 TEXT
  owned_asr_data_allocation_identity_sha256 TEXT
  deadline_member_set_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(compliance_fence_set_id, transcription_job_id,
         owned_asr_lifecycle_operation_id)
  FK(compliance_fence_set_id, root_lifecycle_operation_id,
     video_content_id, media_id) ->
    media_youtube_video_copy_compliance_fence_sets(
      id, lifecycle_operation_id, content_id, media_id)
  FK(work_terminal_receipt_id, work_operation_kind,
     transcription_job_id) ->
    coordination_operation_terminal_receipts(
      id, operation_kind, domain_operation_id)
  FK(lifecycle_terminal_receipt_id, lifecycle_operation_kind,
     owned_asr_lifecycle_operation_id) ->
    coordination_operation_terminal_receipts(
      id, operation_kind, domain_operation_id)
  FK(owned_asr_compliance_receipt_id,
     lifecycle_operation_identity_sha256, transcription_job_identity_sha256,
     deadline_member_set_sha256) ->
    media_youtube_owned_asr_compliance_receipts(
      id, lifecycle_operation_identity_sha256, work_identity_sha256,
      deadline_member_set_sha256)
  FK(work_compliance_receipt_id, transcription_job_identity_sha256,
     owned_asr_data_allocation_identity_sha256,
     deadline_member_set_sha256) ->
    media_transcription_compliance_receipts(
      id, transcription_job_identity_sha256,
      owned_asr_data_allocation_identity_sha256,
      deadline_member_set_sha256)

media_youtube_video_copy_compliance_removal_members # realized planned pair
  id UUID PK
  compliance_fence_set_id UUID UNIQUE
  root_lifecycle_operation_id UUID
  video_content_id UUID
  media_id UUID
  planned_removal_id UUID UNIQUE
  planned_removal_attempt_id UUID UNIQUE
  coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT              # YouTubeVideoCopyLifecycle
  observed_operation_kind TEXT               # VideoCopyRemoval
  created_at TIMESTAMPTZ
  FK(compliance_fence_set_id, root_lifecycle_operation_id,
     video_content_id, media_id) ->
    media_youtube_video_copy_compliance_fence_sets(
      id, lifecycle_operation_id, content_id, media_id)
  FK(compliance_fence_set_id, root_lifecycle_operation_id,
     planned_removal_id, planned_removal_attempt_id,
     coordination_dependency_id) ->
    media_youtube_video_copy_compliance_fence_sets(
      id, lifecycle_operation_id, planned_removal_id,
      planned_removal_attempt_id,
      removal_coordination_dependency_id)
  FK(planned_removal_attempt_id, planned_removal_id) ->
    media_video_copy_removal_attempts(id, removal_id)
  FK(planned_removal_id, video_content_id, media_id) ->
    media_video_copy_removals(id, content_id, media_id)
  FK(coordination_dependency_id, observing_operation_kind,
     root_lifecycle_operation_id, observed_operation_kind,
     planned_removal_attempt_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

media_youtube_video_copy_lifecycle_suspensions
  id UUID PK
  lifecycle_operation_id UUID FK media_youtube_video_copy_lifecycle_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(lifecycle_operation_id, occurrence_no)

media_youtube_video_copy_lifecycle_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_youtube_video_copy_lifecycle_suspensions
  resolution TEXT                          # Requeued only
  created_at TIMESTAMPTZ

media_youtube_video_copy_compliance_receipts # content-free after physical delete
  id UUID PK
  lifecycle_operation_identity_sha256 TEXT UNIQUE
  content_identity_sha256 TEXT
  outcome TEXT                             # Removed | DeadExpired
  created_at TIMESTAMPTZ
  UNIQUE(id, lifecycle_operation_identity_sha256)

media_video_copy_removals                   # immutable removal identity
  id UUID PK
  media_id UUID FK media
  timeline_id UUID
  content_id UUID UNIQUE                    # one removal per content publication
  created_at TIMESTAMPTZ
  UNIQUE(id, content_id, media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(content_id, media_id) -> media_video_contents(id, media_id)

media_video_copy_removal_attempts           # one immutable cleanup intent
  id UUID PK
  removal_id UUID FK media_video_copy_removals
  attempt_no INTEGER
  created_at TIMESTAMPTZ
  UNIQUE(removal_id, attempt_no)
  UNIQUE(id, removal_id)

media_video_copy_removal_cleanup_dependencies # parent observes canonical cleanup
  id UUID PK
  removal_attempt_id UUID UNIQUE
  removal_id UUID
  cleanup_operation_id UUID
  storage_object_id UUID
  coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT              # VideoCopyRemoval
  observed_operation_kind TEXT               # StorageObjectCleanup
  created_at TIMESTAMPTZ
  UNIQUE(id, removal_attempt_id, cleanup_operation_id, storage_object_id)
  FK(removal_attempt_id, removal_id) ->
    media_video_copy_removal_attempts(id, removal_id)
  FK(cleanup_operation_id, storage_object_id) ->
    storage_object_cleanup_video_copy_owners(
      cleanup_operation_id, storage_object_id)
  FK(coordination_dependency_id, observing_operation_kind,
     removal_attempt_id, observed_operation_kind, cleanup_operation_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

media_video_copy_removal_completions        # exact attempt proved bytes absent
  id UUID PK
  removal_id UUID UNIQUE
  removal_attempt_id UUID UNIQUE
  cleanup_dependency_id UUID UNIQUE
  cleanup_operation_id UUID
  storage_object_id UUID
  storage_absence_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(removal_attempt_id, removal_id) ->
    media_video_copy_removal_attempts(id, removal_id)
  FK(cleanup_dependency_id, removal_attempt_id,
     cleanup_operation_id, storage_object_id) ->
    media_video_copy_removal_cleanup_dependencies(
      id, removal_attempt_id, cleanup_operation_id, storage_object_id)
  FK(storage_absence_id, storage_object_id, cleanup_operation_id) ->
    media_video_storage_absences(
      id, storage_object_id, cleanup_operation_id)

media_video_copy_removal_failures           # classified expected terminal failure
  id UUID PK
  removal_attempt_id UUID UNIQUE FK media_video_copy_removal_attempts
  error_code TEXT
  created_at TIMESTAMPTZ

media_video_copy_removal_suspensions        # unexpected dead cleanup; repair-only
  id UUID PK
  removal_attempt_id UUID FK media_video_copy_removal_attempts
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(removal_attempt_id, occurrence_no)

media_video_copy_removal_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_video_copy_removal_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

media_transcript_input_preparations          # Podcast paid-input duration owner
  id UUID PK
  media_id UUID
  timeline_id UUID
  source_attempt_id UUID UNIQUE
  source_locator_sha256 TEXT                 # canonical locator, no credentials
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(source_attempt_id, media_id) -> media_source_attempts(id, media_id)

media_active_transcript_input_preparations   # row existence = preparing exact input
  id UUID PK
  media_id UUID UNIQUE
  preparation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(preparation_id, media_id) -> media_transcript_input_preparations(id, media_id)

media_transcript_input_preparation_progress  # at most one current stage fact
  id UUID PK
  preparation_id UUID UNIQUE FK media_transcript_input_preparations
  generation BIGINT
  stage TEXT                                 # Fetch | Probe
  bytes_done BIGINT                          # zero for Probe
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  UNIQUE(id, preparation_id)

media_transcript_input_preparation_known_totals # Presence child; Fetch only
  id UUID PK
  progress_id UUID UNIQUE FK media_transcript_input_preparation_progress
  total_bytes BIGINT
  created_at TIMESTAMPTZ

media_transcript_input_probes                # immutable exact-byte paid forecast fact
  id UUID PK
  media_id UUID
  preparation_id UUID UNIQUE
  input_sha256 TEXT
  size_bytes BIGINT
  duration_ms BIGINT
  probed_at TIMESTAMPTZ
  expires_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  FK(preparation_id, media_id) -> media_transcript_input_preparations(id, media_id)

media_transcript_input_preparation_failures
  id UUID PK
  preparation_id UUID UNIQUE FK media_transcript_input_preparations
  error_code TEXT                            # E_TRANSCRIPT_INPUT_DEPENDENCY |
                                             # E_TRANSCRIPT_INPUT_SOURCE_UNSAFE |
                                             # E_TRANSCRIPT_INPUT_SOURCE_UNAVAILABLE |
                                             # E_TRANSCRIPT_INPUT_FORMAT |
                                             # E_TRANSCRIPT_INPUT_SIZE_LIMIT |
                                             # E_TRANSCRIPT_INPUT_DURATION_LIMIT
  created_at TIMESTAMPTZ

media_transcript_input_preparation_cancellations
  id UUID PK
  preparation_id UUID UNIQUE FK media_transcript_input_preparations
  created_at TIMESTAMPTZ

media_transcript_input_preparation_suspensions
  id UUID PK
  preparation_id UUID FK media_transcript_input_preparations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(preparation_id, occurrence_no)

media_transcript_input_preparation_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_transcript_input_preparation_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

media_transcription_jobs                    # immutable per-request work identity
  id UUID PK
  media_id UUID
  timeline_id UUID
  source_attempt_id UUID UNIQUE
  input_probe_id UUID nullable
  request_reason TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, source_attempt_id, media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(source_attempt_id, media_id) -> media_source_attempts(id, media_id)
  FK(input_probe_id, media_id) -> media_transcript_input_probes(id, media_id)

media_active_transcriptions                 # row existence = nonterminal intent
  id UUID PK
  media_id UUID UNIQUE
  transcription_job_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(transcription_job_id, media_id) -> media_transcription_jobs(id, media_id)

media_transcription_usage_daily
  id UUID PK
  user_id UUID
  usage_date DATE
  created_at TIMESTAMPTZ
  UNIQUE(user_id, usage_date)
  UNIQUE(id, user_id)
  FK(user_id) -> users(id)

media_transcription_usage_baselines          # exact pre-cut aggregate fact
  id UUID PK
  usage_daily_id UUID UNIQUE FK media_transcription_usage_daily
  used_minutes BIGINT
  created_at TIMESTAMPTZ

media_transcription_usage_charges            # immutable account/day-owned usage
  id UUID PK
  usage_daily_id UUID
  user_id UUID
  committed_minutes BIGINT
  created_at TIMESTAMPTZ
  UNIQUE(id, user_id)
  UNIQUE(id, user_id, usage_daily_id)
  FK(usage_daily_id, user_id) -> media_transcription_usage_daily(id, user_id)

media_transcript_request_audits
  id UUID PK
  media_id UUID
  transcription_job_id UUID nullable
  viewer_id UUID nullable                   # legacy provenance may be absent
  request_reason TEXT
  decision_kind TEXT                        # ForecastOnly | Command
  outcome TEXT
  required_minutes BIGINT nullable
  remaining_minutes BIGINT nullable
  fits_budget BOOLEAN nullable
  created_at TIMESTAMPTZ
  FK(media_id) -> media(id)
  FK(transcription_job_id, media_id) -> media_transcription_jobs(id, media_id)
  FK(viewer_id) -> users(id)

media_transcription_reservations            # neutral held budget identity
  id UUID PK
  media_id UUID
  transcription_job_id UUID UNIQUE
  user_id UUID
  usage_daily_id UUID
  reserved_minutes BIGINT
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, media_id, user_id, usage_daily_id)
  FK(transcription_job_id, media_id) -> media_transcription_jobs(id, media_id)
  FK(usage_daily_id, user_id) -> media_transcription_usage_daily(id, user_id)

media_transcription_reservation_settlements # one exact release/commit result
  id UUID PK
  media_id UUID
  reservation_id UUID UNIQUE
  user_id UUID
  usage_daily_id UUID
  usage_charge_id UUID UNIQUE
  committed_minutes BIGINT
  released_minutes BIGINT
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  FK(reservation_id, media_id, user_id, usage_daily_id) ->
    media_transcription_reservations(id, media_id, user_id, usage_daily_id)
  FK(usage_charge_id, user_id, usage_daily_id) ->
    media_transcription_usage_charges(id, user_id, usage_daily_id)

media_transcription_submissions             # row = provider accepted work
  id UUID PK
  transcription_job_id UUID UNIQUE FK media_transcription_jobs
  provider TEXT
  provider_operation_ref TEXT
  accepted_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(provider, provider_operation_ref)
  UNIQUE(id, transcription_job_id)

media_transcription_results                 # authenticated bounded replay input
  id UUID PK
  transcription_job_id UUID UNIQUE
  submission_id UUID UNIQUE
  owned_asr_data_allocation_id UUID nullable UNIQUE
  response_sha256 TEXT
  normalized_cues_sha256 TEXT
  language TEXT nullable
  received_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, transcription_job_id)
  FK(submission_id, transcription_job_id) ->
    media_transcription_submissions(id, transcription_job_id)
  FK(owned_asr_data_allocation_id, transcription_job_id) ->
    media_youtube_owned_asr_data_allocations(id, transcription_job_id)

media_transcription_result_cues             # exact ordered provider result
  id UUID PK
  transcription_job_id UUID
  transcription_result_id UUID
  segment_index INTEGER
  start_ms BIGINT
  end_ms BIGINT
  speaker TEXT nullable
  text TEXT
  cue_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(transcription_result_id, segment_index)
  FK(transcription_result_id, transcription_job_id) ->
    media_transcription_results(id, transcription_job_id)

media_transcription_result_receipts         # content-free after cue consumption
  id UUID PK
  transcription_job_id UUID UNIQUE FK media_transcription_jobs
  result_identity_sha256 TEXT
  response_sha256 TEXT
  normalized_cues_sha256 TEXT
  outcome TEXT                              # Published | Cancelled | Failed
  created_at TIMESTAMPTZ
  UNIQUE(id, transcription_job_id)

media_transcription_compliance_receipts     # non-FK terminal truth after forced purge
  id UUID PK
  transcription_job_identity_sha256 TEXT UNIQUE
  owned_asr_data_allocation_identity_sha256 TEXT
  deadline_member_set_sha256 TEXT
  outcome TEXT                              # DeadlineNoData | DeadlineDeleted |
                                            # DeadlineDeadExpired
  dispatch_disposition_sha256 TEXT nullable
  created_at TIMESTAMPTZ
  UNIQUE(id, transcription_job_identity_sha256,
         owned_asr_data_allocation_identity_sha256,
         deadline_member_set_sha256)

media_transcription_dispatch_intents        # persisted before non-idempotent POST
  id UUID PK
  transcription_job_id UUID UNIQUE FK media_transcription_jobs
  input_sha256 TEXT
  started_at TIMESTAMPTZ
  created_at TIMESTAMPTZ

media_transcription_dispatch_uncertainties  # response ownership cannot be proved
  id UUID PK
  transcription_job_id UUID UNIQUE FK media_transcription_jobs
  reason_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, transcription_job_id)

media_transcription_dispatch_resolutions    # immutable operator resolution/evidence
  id UUID PK
  uncertainty_id UUID UNIQUE
  transcription_job_id UUID UNIQUE
  resolution_kind TEXT                      # RecoveredResult | ChargedNoResult
  provider_operation_ref TEXT nullable UNIQUE
  response_sha256 TEXT nullable
  recovered_result_receipt_id UUID nullable UNIQUE
  operator_user_id UUID FK users
  authorization_context_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, uncertainty_id, transcription_job_id)
  FK(uncertainty_id, transcription_job_id) ->
    media_transcription_dispatch_uncertainties(id, transcription_job_id)
  FK(recovered_result_receipt_id, transcription_job_id) ->
    media_transcription_result_receipts(id, transcription_job_id)

media_transcription_completions             # terminal outcomes are disjoint rows
  id UUID PK
  transcription_job_id UUID UNIQUE FK media_transcription_jobs
  created_at TIMESTAMPTZ

media_transcription_failures
  id UUID PK
  transcription_job_id UUID UNIQUE FK media_transcription_jobs
  error_code TEXT
  source_kind TEXT                           # Sidecar | Caption | HostedAsr
  created_at TIMESTAMPTZ

media_transcription_cancellations
  id UUID PK
  media_id UUID
  transcription_job_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(transcription_job_id, media_id) -> media_transcription_jobs(id, media_id)

media_transcription_suspensions
  id UUID PK
  transcription_job_id UUID FK media_transcription_jobs
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(transcription_job_id, occurrence_no)

media_transcription_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_transcription_suspensions
  resolution TEXT                           # Requeued | Terminalized
  created_at TIMESTAMPTZ

media_transcript_publications             # immutable publication identity/history
  id UUID PK
  media_id UUID FK media
  timeline_id UUID
  producer_source_attempt_id UUID UNIQUE
  origin TEXT                             # Publisher | Imported | Generated
  input_kind TEXT                         # SidecarBytes | CaptionBytes |
                                          # StreamedAudioBytes |
                                          # ExtractedAudioBytes | MigrationDigest
  input_sha256 TEXT
  provider TEXT nullable
  model_id TEXT nullable
  language TEXT nullable
  timing_granularity TEXT                 # Segment
  published_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(producer_source_attempt_id, media_id) ->
    media_source_attempts(id, media_id)

media_transcript_publication_heads        # row existence/pointer = current publication
  id UUID PK
  media_id UUID UNIQUE FK media
  transcript_publication_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  FK(transcript_publication_id, media_id) -> media_transcript_publications(id, media_id)

media_transcript_reindex_intents          # stable semantic operation identity
  id UUID PK
  media_id UUID
  transcript_publication_id UUID
  semantic_revision BIGINT
  request_reason TEXT
  created_at TIMESTAMPTZ
  UNIQUE(transcript_publication_id, semantic_revision)
  UNIQUE(id, media_id)
  UNIQUE(id, transcript_publication_id, media_id)
  FK(transcript_publication_id, media_id) -> media_transcript_publications(id, media_id)

media_active_transcript_reindex_intents
  id UUID PK
  media_id UUID
  transcript_publication_id UUID UNIQUE
  reindex_intent_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(reindex_intent_id, transcript_publication_id, media_id) ->
    media_transcript_reindex_intents(id, transcript_publication_id, media_id)

media_transcript_reindex_embedding_intents    # one exact billed batch
  id UUID PK
  media_id UUID
  reindex_intent_id UUID
  batch_ordinal INTEGER
  request_sha256 TEXT
  provider TEXT
  model_id TEXT
  dimensions INTEGER
  authorizing_user_id UUID FK users
  authorization_context_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(reindex_intent_id, batch_ordinal)
  UNIQUE(id, reindex_intent_id, media_id)
  UNIQUE(id, authorizing_user_id)
  FK(reindex_intent_id, media_id) -> media_transcript_reindex_intents(id, media_id)

media_transcript_reindex_embedding_results
  id UUID PK
  embedding_intent_id UUID UNIQUE
  vector_bundle_sha256 TEXT
  response_sha256 TEXT
  authorizing_user_id UUID
  usage_charge_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, embedding_intent_id)
  FK(embedding_intent_id, authorizing_user_id) ->
    media_transcript_reindex_embedding_intents(id, authorizing_user_id)
  FK(usage_charge_id, authorizing_user_id) ->
    embedding_usage_charges(id, user_id)

media_transcript_reindex_embedding_result_vectors # exact ordered durable result
  id UUID PK
  embedding_result_id UUID
  input_ordinal INTEGER
  embedding_f32 BYTEA
  embedding_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(embedding_result_id, input_ordinal)
  FK(embedding_result_id) -> media_transcript_reindex_embedding_results(id)

media_transcript_reindex_embedding_uncertainties
  id UUID PK
  embedding_intent_id UUID UNIQUE FK media_transcript_reindex_embedding_intents
  reason_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, embedding_intent_id)

media_transcript_reindex_embedding_resolutions
  id UUID PK
  uncertainty_id UUID UNIQUE
  embedding_intent_id UUID UNIQUE
  resolution TEXT                           # RecoveredResult | ChargedNoResult
  recovered_result_id UUID nullable UNIQUE
  charged_no_result_usage_charge_id UUID nullable UNIQUE
  authorizing_user_id UUID
  operator_user_id UUID FK users
  authorization_context_sha256 TEXT
  created_at TIMESTAMPTZ
  FK(uncertainty_id, embedding_intent_id) ->
    media_transcript_reindex_embedding_uncertainties(id, embedding_intent_id)
  FK(recovered_result_id, embedding_intent_id) ->
    media_transcript_reindex_embedding_results(id, embedding_intent_id)
  FK(embedding_intent_id, authorizing_user_id) ->
    media_transcript_reindex_embedding_intents(id, authorizing_user_id)
  FK(charged_no_result_usage_charge_id, authorizing_user_id) ->
    embedding_usage_charges(id, user_id)

media_transcript_reindex_completions
  id UUID PK
  reindex_intent_id UUID UNIQUE FK media_transcript_reindex_intents
  created_at TIMESTAMPTZ

media_transcript_reindex_failures
  id UUID PK
  reindex_intent_id UUID UNIQUE FK media_transcript_reindex_intents
  error_code TEXT
  created_at TIMESTAMPTZ

media_transcript_reindex_cancellations
  id UUID PK
  reindex_intent_id UUID UNIQUE FK media_transcript_reindex_intents
  created_at TIMESTAMPTZ

media_transcript_reindex_suspensions
  id UUID PK
  reindex_intent_id UUID FK media_transcript_reindex_intents
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(reindex_intent_id, occurrence_no)

media_transcript_reindex_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_transcript_reindex_suspensions
  resolution TEXT                           # Requeued only
  created_at TIMESTAMPTZ

youtube_caption_oauth_pkce_secret_materials  # application-AEAD ciphertext only
  id UUID PK                                 # neutral PKCE allocation identity
  authorization_attempt_id UUID UNIQUE       # immutable semantic owner
  envelope_version TEXT                      # Aes256GcmEnvelopeV1
  kek_version TEXT
  data_nonce BYTEA                           # exact 96-bit fresh nonce
  ciphertext BYTEA
  ciphertext_tag BYTEA                       # exact 128-bit GCM tag
  wrap_nonce BYTEA                           # independent exact 96-bit nonce
  wrapped_dek BYTEA                          # wrapped exact 256-bit random DEK
  wrapped_dek_tag BYTEA                      # exact 128-bit GCM tag
  created_at TIMESTAMPTZ
  UNIQUE(id, authorization_attempt_id)
  UNIQUE(kek_version, wrap_nonce)
  FK(authorization_attempt_id) -> youtube_caption_oauth_authorization_attempts(id)

youtube_caption_oauth_authorization_code_secret_materials
  id UUID PK                                 # neutral code allocation identity
  exchange_intent_id UUID UNIQUE             # immutable semantic owner
  envelope_version TEXT                      # Aes256GcmEnvelopeV1
  kek_version TEXT
  data_nonce BYTEA
  ciphertext BYTEA
  ciphertext_tag BYTEA
  wrap_nonce BYTEA
  wrapped_dek BYTEA
  wrapped_dek_tag BYTEA
  created_at TIMESTAMPTZ
  UNIQUE(id, exchange_intent_id)
  UNIQUE(kek_version, wrap_nonce)
  FK(exchange_intent_id) -> youtube_caption_oauth_exchange_intents(id)

youtube_caption_oauth_refresh_credential_secret_materials
  id UUID PK                                 # neutral refresh allocation identity
  credential_id UUID UNIQUE                  # immutable semantic owner
  envelope_version TEXT                      # Aes256GcmEnvelopeV1
  kek_version TEXT
  data_nonce BYTEA
  ciphertext BYTEA
  ciphertext_tag BYTEA
  wrap_nonce BYTEA
  wrapped_dek BYTEA
  wrapped_dek_tag BYTEA
  created_at TIMESTAMPTZ
  UNIQUE(id, credential_id)
  UNIQUE(kek_version, wrap_nonce)
  FK(credential_id) -> youtube_caption_oauth_credentials(id)

youtube_caption_oauth_authorization_attempts # neutral immutable attempt identity
  id UUID PK
  user_id UUID FK users
  oauth_state_sha256 TEXT UNIQUE
  oauth_state_key_version INTEGER
  expires_at TIMESTAMPTZ
  oauth_client_id_sha256 TEXT
  api_project_id_sha256 TEXT
  redirect_uri_sha256 TEXT
  scope_set_sha256 TEXT
  consent_document_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, user_id)

youtube_caption_oauth_active_authorization_attempts # row existence = Connecting
  id UUID PK
  authorization_attempt_id UUID UNIQUE
  user_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(authorization_attempt_id, user_id) ->
    youtube_caption_oauth_authorization_attempts(id, user_id)

youtube_caption_oauth_awaiting_callbacks     # pre-callback phase marker only
  id UUID PK
  authorization_attempt_id UUID UNIQUE
  user_id UUID UNIQUE
  pkce_verifier_sha256 TEXT
  pkce_challenge_s256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, authorization_attempt_id)
  FK(authorization_attempt_id, user_id) ->
    youtube_caption_oauth_authorization_attempts(id, user_id)

youtube_caption_oauth_browser_attempt_bindings
  id UUID PK
  authorization_attempt_id UUID UNIQUE FK youtube_caption_oauth_authorization_attempts
  browser_session_binding_sha256 TEXT
  cookie_capability_sha256 TEXT
  cookie_key_version INTEGER
  created_at TIMESTAMPTZ

youtube_caption_oauth_awaiting_callback_pkce_holds # exact encrypted verifier owner
  id UUID PK
  awaiting_callback_id UUID UNIQUE
  authorization_attempt_id UUID
  pkce_secret_material_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(awaiting_callback_id, authorization_attempt_id) ->
    youtube_caption_oauth_awaiting_callbacks(id, authorization_attempt_id)
  FK(pkce_secret_material_id, authorization_attempt_id) ->
    youtube_caption_oauth_pkce_secret_materials(id, authorization_attempt_id)

youtube_caption_oauth_authorization_attempt_expiry_operations # one per attempt
  id UUID PK
  authorization_attempt_id UUID UNIQUE FK youtube_caption_oauth_authorization_attempts
  cleanup_due_at TIMESTAMPTZ
  compliance_delete_deadline TIMESTAMPTZ
  created_at TIMESTAMPTZ

youtube_caption_oauth_callback_replay_tombstones # bounded exact replay only
  id UUID PK
  expiry_operation_id UUID UNIQUE FK youtube_caption_oauth_authorization_attempt_expiry_operations
  callback_response_sha256 TEXT
  outcome TEXT                              # CallbackTransferred | Denied
  replay_delete_due_at TIMESTAMPTZ
  created_at TIMESTAMPTZ

youtube_caption_oauth_authorization_attempt_expiry_suspensions
  id UUID PK
  expiry_operation_id UUID FK youtube_caption_oauth_authorization_attempt_expiry_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(expiry_operation_id, occurrence_no)

youtube_caption_oauth_authorization_attempt_expiry_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK youtube_caption_oauth_authorization_attempt_expiry_suspensions
  resolution TEXT                          # Requeued only
  created_at TIMESTAMPTZ

youtube_caption_oauth_authorization_attempt_expiry_receipts # content-free
  id UUID PK
  expiry_operation_identity_sha256 TEXT UNIQUE
  outcome TEXT                             # CallbackReplayExpired | DeniedReplayExpired |
                                           # UnusableStart | Expired | Erased
  created_at TIMESTAMPTZ

youtube_caption_oauth_exchange_intents      # one-use callback exchange owner
  id UUID PK
  credential_allocation_id UUID UNIQUE
  authorization_attempt_id UUID UNIQUE
  authorization_code_sha256 TEXT UNIQUE
  callback_received_at TIMESTAMPTZ
  cleanup_due_at TIMESTAMPTZ
  compliance_delete_deadline TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, credential_allocation_id)
  UNIQUE(id, authorization_attempt_id)
  FK(credential_allocation_id, authorization_attempt_id) ->
    youtube_caption_oauth_credential_allocations(id, authorization_attempt_id)

youtube_caption_oauth_exchange_code_holds   # row permits AwaitingDispatch
  id UUID PK
  exchange_intent_id UUID UNIQUE FK youtube_caption_oauth_exchange_intents
  authorization_code_secret_material_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, exchange_intent_id)
  FK(authorization_code_secret_material_id, exchange_intent_id) ->
    youtube_caption_oauth_authorization_code_secret_materials(id, exchange_intent_id)

youtube_caption_oauth_exchange_pkce_holds   # transferred, never copied/re-encrypted
  id UUID PK
  exchange_intent_id UUID UNIQUE
  authorization_attempt_id UUID
  pkce_secret_material_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(exchange_intent_id, authorization_attempt_id) ->
    youtube_caption_oauth_exchange_intents(id, authorization_attempt_id)
  FK(pkce_secret_material_id, authorization_attempt_id) ->
    youtube_caption_oauth_pkce_secret_materials(id, authorization_attempt_id)

youtube_caption_oauth_exchange_dispatch_intents # before one-use token POST
  id UUID PK
  exchange_intent_id UUID UNIQUE FK youtube_caption_oauth_exchange_intents
  request_sha256 TEXT
  started_at TIMESTAMPTZ
  created_at TIMESTAMPTZ

youtube_caption_oauth_credentials           # neutral secret allocation facts
  id UUID PK
  user_id UUID FK users
  authorization_attempt_identity_sha256 TEXT UNIQUE
  oauth_client_id_sha256 TEXT
  api_project_id_sha256 TEXT
  scope_set_sha256 TEXT
  consent_document_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, user_id)

youtube_caption_oauth_credential_allocations # exact attempt-to-credential transfer
  id UUID PK
  authorization_attempt_id UUID UNIQUE
  credential_id UUID UNIQUE
  user_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(id, credential_id)
  UNIQUE(id, authorization_attempt_id)
  FK(authorization_attempt_id, user_id) ->
    youtube_caption_oauth_authorization_attempts(id, user_id)
  FK(credential_id, user_id) -> youtube_caption_oauth_credentials(id, user_id)

youtube_caption_oauth_credential_secret_holds # row = exact encrypted refresh secret exists
  id UUID PK
  credential_id UUID UNIQUE FK youtube_caption_oauth_credentials
  refresh_credential_secret_material_id UUID UNIQUE
  token_response_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, credential_id)
  FK(refresh_credential_secret_material_id, credential_id) ->
    youtube_caption_oauth_refresh_credential_secret_materials(id, credential_id)

youtube_caption_oauth_exchange_results      # secret-owner acknowledgement
  id UUID PK
  exchange_intent_id UUID UNIQUE
  credential_allocation_id UUID UNIQUE
  credential_id UUID UNIQUE
  credential_secret_hold_id UUID UNIQUE
  received_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, exchange_intent_id)
  FK(exchange_intent_id, credential_allocation_id) ->
    youtube_caption_oauth_exchange_intents(id, credential_allocation_id)
  FK(credential_allocation_id, credential_id) ->
    youtube_caption_oauth_credential_allocations(id, credential_id)
  FK(credential_secret_hold_id, credential_id) ->
    youtube_caption_oauth_credential_secret_holds(id, credential_id)

youtube_caption_oauth_exchange_uncertainties
  id UUID PK
  exchange_intent_id UUID UNIQUE FK youtube_caption_oauth_exchange_intents
  reason_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(id, exchange_intent_id)

youtube_caption_oauth_exchange_resolutions
  id UUID PK
  uncertainty_id UUID UNIQUE
  exchange_intent_id UUID UNIQUE
  resolution TEXT                           # UnrecoverableRemoteGrant only
  operator_user_id UUID nullable FK users
  authorization_context_sha256 TEXT
  created_at TIMESTAMPTZ
  FK(uncertainty_id, exchange_intent_id) ->
    youtube_caption_oauth_exchange_uncertainties(id, exchange_intent_id)

youtube_caption_oauth_exchange_receipts     # content-free after transient erase
  id UUID PK
  exchange_identity_sha256 TEXT UNIQUE
  outcome TEXT                              # PendingSelectionCreated |
                                            # InvalidProviderResponse |
                                            # UnrecoverableRemoteGrant |
                                            # Cancelled | Expired | Erased
  created_at TIMESTAMPTZ

youtube_caption_oauth_pending_connections   # callback -> channel select
  id UUID PK
  user_id UUID UNIQUE FK users
  credential_id UUID UNIQUE
  credential_use_completion_id UUID UNIQUE
  credential_use_operation_kind TEXT        # YouTubeOAuthExchange
  credential_use_domain_operation_id UUID
  channel_allocation_count BIGINT
  channel_allocation_set_sha256 TEXT
  expires_at TIMESTAMPTZ                    # <= callback + 10 minutes
  created_at TIMESTAMPTZ
  UNIQUE(id, user_id)
  UNIQUE(id, user_id, credential_use_completion_id)
  FK(credential_id, user_id) -> youtube_caption_oauth_credentials(id, user_id)
  FK(credential_use_completion_id, credential_id,
     credential_use_operation_kind, credential_use_domain_operation_id) ->
    youtube_caption_oauth_credential_use_completion_seals(
      id, credential_id, operation_kind, domain_operation_id)

youtube_caption_oauth_pending_channel_allocations # temporary exact set associations
  id UUID PK
  pending_connection_id UUID
  user_id UUID
  credential_use_completion_id UUID
  channel_data_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(pending_connection_id, channel_data_allocation_id)
  FK(pending_connection_id, user_id, credential_use_completion_id) ->
    youtube_caption_oauth_pending_connections(
      id, user_id, credential_use_completion_id)
  FK(channel_data_allocation_id, credential_use_completion_id) ->
    youtube_caption_oauth_channel_data_allocations(
      id, credential_use_completion_id)

youtube_caption_oauth_pending_expiry_operations # one exact pending owner
  id UUID PK
  pending_connection_id UUID UNIQUE FK youtube_caption_oauth_pending_connections
  expiry_due_at TIMESTAMPTZ
  compliance_delete_deadline TIMESTAMPTZ
  created_at TIMESTAMPTZ

youtube_caption_oauth_pending_expiry_suspensions
  id UUID PK
  expiry_operation_id UUID FK youtube_caption_oauth_pending_expiry_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(expiry_operation_id, occurrence_no)

youtube_caption_oauth_pending_expiry_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK youtube_caption_oauth_pending_expiry_suspensions
  resolution TEXT                          # Requeued only
  created_at TIMESTAMPTZ

youtube_caption_oauth_pending_expiry_receipts # content-free after transfer/delete
  id UUID PK
  expiry_operation_identity_sha256 TEXT UNIQUE
  outcome TEXT                             # Connected | RevocationTransferred
  reason TEXT nullable                     # Cancelled | Expired | UserErasure
  created_at TIMESTAMPTZ

youtube_caption_oauth_bindings              # finalized one-user consent owner
  id UUID PK
  user_id UUID UNIQUE FK users
  credential_id UUID UNIQUE
  connected_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, user_id)
  UNIQUE(id, credential_id, user_id)
  FK(credential_id, user_id) -> youtube_caption_oauth_credentials(id, user_id)

youtube_caption_oauth_binding_channel_selections # binding -> immutable data; no copy
  id UUID PK
  binding_id UUID
  credential_id UUID
  authorizing_user_id UUID
  channel_data_allocation_id UUID UNIQUE
  credential_use_completion_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(id, binding_id)
  UNIQUE(id, channel_data_allocation_id, binding_id)
  FK(binding_id, credential_id, authorizing_user_id) ->
    youtube_caption_oauth_bindings(id, credential_id, user_id)
  FK(channel_data_allocation_id, credential_id, authorizing_user_id,
     credential_use_completion_id) ->
    youtube_caption_oauth_channel_data_allocations(
      id, credential_id, authorizing_user_id,
      credential_use_completion_id)

youtube_caption_oauth_binding_channel_snapshots # immutable publication generations
  id UUID PK
  binding_id UUID FK youtube_caption_oauth_bindings
  channel_selection_id UUID UNIQUE
  generation BIGINT
  created_at TIMESTAMPTZ
  UNIQUE(binding_id, generation)
  UNIQUE(id, binding_id)
  FK(channel_selection_id, binding_id) ->
    youtube_caption_oauth_binding_channel_selections(id, binding_id)

youtube_caption_oauth_binding_channel_heads # sole current snapshot pointer
  id UUID PK
  binding_id UUID UNIQUE FK youtube_caption_oauth_bindings
  channel_snapshot_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  FK(channel_snapshot_id, binding_id) ->
    youtube_caption_oauth_binding_channel_snapshots(id, binding_id)

youtube_caption_oauth_binding_lifecycle_operations
  id UUID PK
  binding_id UUID FK youtube_caption_oauth_bindings
  channel_snapshot_id UUID UNIQUE
  refresh_due_at TIMESTAMPTZ               # <= refreshed_at + 28 days
  purge_due_at TIMESTAMPTZ
  compliance_delete_deadline TIMESTAMPTZ   # <= expires_at
  created_at TIMESTAMPTZ
  UNIQUE(id, binding_id)
  FK(channel_snapshot_id, binding_id) ->
    youtube_caption_oauth_binding_channel_snapshots(id, binding_id)

youtube_caption_oauth_binding_refresh_results # authenticated successor input
  id UUID PK
  binding_id UUID
  lifecycle_operation_id UUID UNIQUE
  channel_selection_id UUID UNIQUE
  channel_data_allocation_id UUID UNIQUE
  credential_use_completion_id UUID UNIQUE
  credential_use_operation_kind TEXT        # YouTubeOAuthBindingLifecycle
  created_at TIMESTAMPTZ
  UNIQUE(id, binding_id)
  FK(lifecycle_operation_id, binding_id) ->
    youtube_caption_oauth_binding_lifecycle_operations(id, binding_id)
  FK(channel_selection_id, binding_id) ->
    youtube_caption_oauth_binding_channel_selections(id, binding_id)
  FK(channel_selection_id, channel_data_allocation_id, binding_id) ->
    youtube_caption_oauth_binding_channel_selections(
      id, channel_data_allocation_id, binding_id)
  FK(channel_data_allocation_id, credential_use_completion_id,
     credential_use_operation_kind, lifecycle_operation_id) ->
    youtube_caption_oauth_channel_data_allocations(
      id, credential_use_completion_id,
      credential_use_operation_kind, credential_use_domain_operation_id)

youtube_caption_oauth_binding_lifecycle_suspensions
  id UUID PK
  lifecycle_operation_id UUID FK youtube_caption_oauth_binding_lifecycle_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(lifecycle_operation_id, occurrence_no)

youtube_caption_oauth_binding_lifecycle_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK youtube_caption_oauth_binding_lifecycle_suspensions
  resolution TEXT                          # Requeued only
  created_at TIMESTAMPTZ

youtube_caption_oauth_binding_compliance_receipts # content-free after erase
  id UUID PK
  lifecycle_operation_identity_sha256 TEXT UNIQUE
  outcome TEXT                             # RefreshedSuccessor | Revoked |
                                           # DeletedAtDeadline | DeadExpired
  created_at TIMESTAMPTZ

youtube_caption_oauth_active_bindings       # row existence authorizes use
  id UUID PK
  user_id UUID UNIQUE
  binding_id UUID UNIQUE
  created_at TIMESTAMPTZ
  FK(binding_id, user_id) -> youtube_caption_oauth_bindings(id, user_id)

youtube_caption_oauth_binding_deactivations # fail-closed account disposition
  id UUID PK
  binding_id UUID UNIQUE FK youtube_caption_oauth_bindings
  reason TEXT                              # Disconnect | RefreshFailed |
                                           # ApprovalExpired | DataExpired | UserErasure
  created_at TIMESTAMPTZ
  UNIQUE(id, binding_id)

youtube_caption_oauth_binding_deadline_operation_sets # sealed same-binding refs
  id UUID PK
  binding_id UUID UNIQUE
  deactivation_id UUID UNIQUE
  root_lifecycle_operation_id UUID UNIQUE
  fence_generation_id UUID UNIQUE
  member_count BIGINT
  member_set_sha256 TEXT
  fenced_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, binding_id, root_lifecycle_operation_id)
  FK(binding_id) -> youtube_caption_oauth_bindings(id)
  FK(deactivation_id, binding_id) ->
    youtube_caption_oauth_binding_deactivations(id, binding_id)
  FK(root_lifecycle_operation_id, binding_id) ->
    youtube_caption_oauth_binding_lifecycle_operations(id, binding_id)

youtube_caption_oauth_binding_deadline_peer_members # non-root exact refs
  id UUID PK
  deadline_set_id UUID
  binding_id UUID
  root_lifecycle_operation_id UUID
  peer_lifecycle_operation_id UUID UNIQUE
  coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT             # YouTubeOAuthBindingLifecycle
  observed_operation_kind TEXT              # YouTubeOAuthBindingLifecycle
  created_at TIMESTAMPTZ
  UNIQUE(deadline_set_id, peer_lifecycle_operation_id)
  FK(deadline_set_id, binding_id, root_lifecycle_operation_id) ->
    youtube_caption_oauth_binding_deadline_operation_sets(
      id, binding_id, root_lifecycle_operation_id)
  FK(peer_lifecycle_operation_id, binding_id) ->
    youtube_caption_oauth_binding_lifecycle_operations(id, binding_id)
  FK(coordination_dependency_id, observing_operation_kind,
     root_lifecycle_operation_id, observed_operation_kind,
     peer_lifecycle_operation_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

youtube_caption_oauth_credential_uses        # neutral one-claim provider-use cycle
  id UUID PK
  credential_id UUID
  use_generation BIGINT
  created_at TIMESTAMPTZ
  UNIQUE(credential_id, use_generation)
  UNIQUE(id, credential_id)
  FK(credential_id) -> youtube_caption_oauth_credentials(id)

youtube_caption_oauth_credential_use_operation_owners # exact caller OperationRef arm
  id UUID PK
  credential_use_id UUID UNIQUE
  credential_id UUID
  operation_kind TEXT
  domain_operation_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(operation_kind, domain_operation_id, credential_use_id)
  UNIQUE(credential_use_id, credential_id, operation_kind, domain_operation_id)
  FK(credential_use_id, credential_id) ->
    youtube_caption_oauth_credential_uses(id, credential_id)

youtube_caption_oauth_credential_use_dispatch_intents # armed provider-use boundary
  id UUID PK
  credential_use_id UUID
  credential_id UUID
  request_generation BIGINT
  dispatch_kind TEXT                        # RefreshGrant | ChannelsList |
                                            # VideosList | CaptionsList |
                                            # CaptionDownload
  canonical_request_sha256 TEXT
  armed_at TIMESTAMPTZ
  request_deadline TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(credential_use_id, request_generation)
  UNIQUE(id, credential_use_id, credential_id)
  FK(credential_use_id, credential_id) ->
    youtube_caption_oauth_credential_uses(id, credential_id)

youtube_caption_oauth_credential_use_terminal_results # content-free request settlement
  id UUID PK
  dispatch_intent_id UUID UNIQUE
  credential_use_id UUID
  credential_id UUID
  outcome TEXT                              # Completed | DefinitivelyNotSent |
                                            # ResponseLost | Fenced
  terminal_evidence_sha256 TEXT
  completed_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, dispatch_intent_id)
  UNIQUE(id, dispatch_intent_id, credential_use_id, credential_id)
  FK(dispatch_intent_id, credential_use_id, credential_id) ->
    youtube_caption_oauth_credential_use_dispatch_intents(
      id, credential_use_id, credential_id)

youtube_caption_oauth_credential_use_completion_seals # exact successful request set
  id UUID PK
  credential_use_id UUID UNIQUE
  credential_id UUID
  operation_kind TEXT
  domain_operation_id UUID
  request_count BIGINT
  request_set_sha256 TEXT
  terminal_result_set_sha256 TEXT
  completed_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, credential_id)
  UNIQUE(id, credential_use_id, credential_id)
  UNIQUE(id, credential_id, operation_kind, domain_operation_id)
  FK(credential_use_id, credential_id, operation_kind, domain_operation_id) ->
    youtube_caption_oauth_credential_use_operation_owners(
      credential_use_id, credential_id, operation_kind, domain_operation_id)

youtube_caption_oauth_credential_use_completion_members # relational seal inputs
  id UUID PK
  completion_seal_id UUID
  credential_use_id UUID
  credential_id UUID
  dispatch_intent_id UUID UNIQUE
  terminal_result_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(completion_seal_id, dispatch_intent_id)
  FK(completion_seal_id, credential_use_id, credential_id) ->
    youtube_caption_oauth_credential_use_completion_seals(
      id, credential_use_id, credential_id)
  FK(dispatch_intent_id, credential_use_id, credential_id) ->
    youtube_caption_oauth_credential_use_dispatch_intents(
      id, credential_use_id, credential_id)
  FK(terminal_result_id, dispatch_intent_id,
     credential_use_id, credential_id) ->
    youtube_caption_oauth_credential_use_terminal_results(
      id, dispatch_intent_id, credential_use_id, credential_id)

youtube_caption_oauth_channel_data_allocations # one immutable channel fact
  id UUID PK
  credential_id UUID
  authorizing_user_id UUID
  credential_use_completion_id UUID
  credential_use_operation_kind TEXT
  credential_use_domain_operation_id UUID
  channel_id TEXT
  display_label TEXT
  channel_record_sha256 TEXT
  retrieved_at TIMESTAMPTZ
  expires_at TIMESTAMPTZ                   # <= retrieved_at + 30 days
  created_at TIMESTAMPTZ
  UNIQUE(id, credential_id, authorizing_user_id)
  UNIQUE(id, credential_use_completion_id)
  UNIQUE(id, credential_id, authorizing_user_id,
         credential_use_completion_id)
  UNIQUE(id, credential_use_completion_id,
         credential_use_operation_kind, credential_use_domain_operation_id)
  UNIQUE(credential_use_completion_id, channel_id)
  FK(credential_id, authorizing_user_id) ->
    youtube_caption_oauth_credentials(id, user_id)
  FK(credential_use_completion_id, credential_id,
     credential_use_operation_kind, credential_use_domain_operation_id) ->
    youtube_caption_oauth_credential_use_completion_seals(
      id, credential_id, operation_kind, domain_operation_id)

youtube_caption_oauth_channel_data_channel_duplicates # Presence child
  id UUID PK
  channel_data_allocation_id UUID UNIQUE FK youtube_caption_oauth_channel_data_allocations
  ordinal INTEGER
  total INTEGER
  created_at TIMESTAMPTZ

youtube_caption_credential_revocations      # remote revoke after local fail-close
  id UUID PK
  user_id UUID
  credential_id UUID UNIQUE
  requested_at TIMESTAMPTZ
  retry_until TIMESTAMPTZ                   # early remote-attempt cutoff
  compliance_delete_deadline TIMESTAMPTZ    # <= requested_at + 7 days
  created_at TIMESTAMPTZ
  UNIQUE(id, user_id)
  FK(credential_id, user_id) -> youtube_caption_oauth_credentials(id, user_id)

youtube_caption_credential_revocation_reasons # immutable trigger set; never overwrite
  id UUID PK
  revocation_id UUID FK youtube_caption_credential_revocations
  reason TEXT                               # Disconnect | PendingCancelled |
                                            # PendingExpired | NoEligibleChannel |
                                            # ChannelSetUnbounded |
                                            # ChannelMetadataInvalid |
                                            # RefreshFailed | ApprovalExpired |
                                            # DataExpired | UserErasure
  subject_identity_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(revocation_id, reason, subject_identity_sha256)

youtube_caption_credential_revocation_dispositions # before secret deletion
  id UUID PK
  revocation_id UUID UNIQUE FK youtube_caption_credential_revocations
  outcome TEXT                              # Revoked | AlreadyInvalid |
                                            # RemoteUnconfirmed
  provider_response_sha256 TEXT nullable
  created_at TIMESTAMPTZ

youtube_caption_credential_revocation_receipts # content-free terminal truth
  id UUID PK
  revocation_identity_sha256 TEXT UNIQUE
  reason_set_sha256 TEXT
  outcome TEXT                              # Revoked | AlreadyInvalid |
                                            # RemoteUnconfirmed
  provider_response_sha256 TEXT nullable
  created_at TIMESTAMPTZ

youtube_caption_oauth_remote_unconfirmed_markers # current actionable state
  id UUID PK
  user_id UUID UNIQUE FK users
  reason TEXT                               # RevocationRemoteUnconfirmed |
                                            # ExchangeGrantUnrecoverable
  created_at TIMESTAMPTZ

youtube_caption_oauth_remote_unconfirmed_revocation_owners
  id UUID PK
  marker_id UUID UNIQUE FK youtube_caption_oauth_remote_unconfirmed_markers
  revocation_receipt_id UUID UNIQUE FK youtube_caption_credential_revocation_receipts
  created_at TIMESTAMPTZ

youtube_caption_oauth_remote_unconfirmed_exchange_owners
  id UUID PK
  marker_id UUID UNIQUE FK youtube_caption_oauth_remote_unconfirmed_markers
  exchange_receipt_id UUID UNIQUE FK youtube_caption_oauth_exchange_receipts
  created_at TIMESTAMPTZ

media_youtube_caption_initial_capacity_reservations # before provider I/O/bytes
  id UUID PK
  media_id UUID
  transcription_job_id UUID UNIQUE
  source_attempt_id UUID UNIQUE
  credential_use_id UUID UNIQUE
  credential_id UUID
  operation_kind TEXT                       # TranscribeMedia
  lifecycle_operation_kind TEXT             # YouTubeCaptionInitialLifecycle
  coordination_dependency_id UUID UNIQUE
  observed_operation_kind TEXT              # TranscribeMedia
  preallocated_deadline_set_id UUID UNIQUE
  preallocated_fence_generation_id UUID UNIQUE
  capacity_allocation_id UUID UNIQUE
  caption_capacity_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, transcription_job_id, source_attempt_id, media_id)
  UNIQUE(id, transcription_job_id, media_id)
  UNIQUE(id, transcription_job_id)
  UNIQUE(id, lifecycle_operation_kind)
  UNIQUE(id, credential_use_id, credential_id, operation_kind,
         transcription_job_id, media_id)
  FK(transcription_job_id, source_attempt_id, media_id) ->
    media_transcription_jobs(id, source_attempt_id, media_id)
  FK(credential_use_id, credential_id, operation_kind,
     transcription_job_id) ->
    youtube_caption_oauth_credential_use_operation_owners(
      credential_use_id, credential_id, operation_kind, domain_operation_id)
  FK(coordination_dependency_id, lifecycle_operation_kind, id,
     observed_operation_kind, transcription_job_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)
  FK(caption_capacity_allocation_id, capacity_allocation_id) ->
    provider_compliance_caption_capacity_allocations(
      id, capacity_allocation_id)

media_youtube_caption_initial_deadline_operation_sets # exact two-ref fence
  id UUID PK
  initial_reservation_id UUID UNIQUE
  transcription_job_id UUID UNIQUE
  coordination_dependency_id UUID UNIQUE
  fence_generation_id UUID UNIQUE
  observing_operation_kind TEXT              # YouTubeCaptionInitialLifecycle
  observed_operation_kind TEXT               # TranscribeMedia
  member_set_sha256 TEXT
  fenced_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, initial_reservation_id, transcription_job_id)
  FK(initial_reservation_id, transcription_job_id) ->
    media_youtube_caption_initial_capacity_reservations(
      id, transcription_job_id)
  FK(coordination_dependency_id, observing_operation_kind,
     initial_reservation_id, observed_operation_kind,
     transcription_job_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

media_youtube_caption_initial_lifecycle_receipts # content-free after transfer/delete
  id UUID PK
  initial_reservation_identity_sha256 TEXT UNIQUE
  outcome TEXT                               # PublishedTransfer | NoData |
                                             # SourceFailed | Cancelled |
                                             # DeletedAtDeadline |
                                             # DeadExpired | TeardownDeleted
  defect_code_sha256 TEXT nullable
  created_at TIMESTAMPTZ

media_youtube_caption_data_allocations    # sole restricted data/provenance owner
  id UUID PK
  media_id UUID
  authorizing_user_id UUID FK users
  oauth_binding_id UUID
  credential_id UUID
  credential_use_completion_id UUID UNIQUE
  credential_use_operation_kind TEXT
  credential_use_domain_operation_id UUID
  youtube_channel_id TEXT
  caption_id TEXT
  caption_kind TEXT                       # Manual | Automatic
  input_sha256 TEXT
  normalized_cues_sha256 TEXT
  language TEXT nullable
  oauth_binding_sha256 TEXT
  approval_artifact_sha256 TEXT
  retrieved_at TIMESTAMPTZ
  expires_at TIMESTAMPTZ                  # no later than retrieved_at + 30 days
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, credential_use_completion_id,
         credential_use_operation_kind, credential_use_domain_operation_id,
         media_id)
  FK(oauth_binding_id, credential_id, authorizing_user_id) ->
    youtube_caption_oauth_bindings(id, credential_id, user_id)
  FK(credential_use_completion_id, credential_id,
     credential_use_operation_kind, credential_use_domain_operation_id) ->
    youtube_caption_oauth_credential_use_completion_seals(
      id, credential_id, operation_kind, domain_operation_id)

media_youtube_caption_data_initial_use_owners # staged-only producer association
  id UUID PK
  caption_data_allocation_id UUID UNIQUE
  media_id UUID
  credential_use_completion_id UUID UNIQUE
  credential_use_operation_kind TEXT       # TranscribeMedia
  transcription_job_id UUID UNIQUE
  initial_capacity_reservation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(caption_data_allocation_id, initial_capacity_reservation_id,
         transcription_job_id, media_id)
  FK(caption_data_allocation_id, credential_use_completion_id,
     credential_use_operation_kind, transcription_job_id, media_id) ->
    media_youtube_caption_data_allocations(
      id, credential_use_completion_id,
      credential_use_operation_kind, credential_use_domain_operation_id,
      media_id)
  FK(transcription_job_id, media_id) ->
    media_transcription_jobs(id, media_id)
  FK(initial_capacity_reservation_id, transcription_job_id, media_id) ->
    media_youtube_caption_initial_capacity_reservations(
      id, transcription_job_id, media_id)

media_youtube_caption_data_refresh_use_owners # mutually exclusive staged arm
  id UUID PK
  caption_data_allocation_id UUID UNIQUE
  media_id UUID
  credential_use_completion_id UUID UNIQUE
  credential_use_operation_kind TEXT       # YouTubeCaptionLifecycle
  lifecycle_operation_id UUID
  created_at TIMESTAMPTZ
  UNIQUE(caption_data_allocation_id, lifecycle_operation_id, media_id)
  FK(caption_data_allocation_id, credential_use_completion_id,
     credential_use_operation_kind, lifecycle_operation_id, media_id) ->
    media_youtube_caption_data_allocations(
      id, credential_use_completion_id,
      credential_use_operation_kind, credential_use_domain_operation_id,
      media_id)
  FK(lifecycle_operation_id, media_id) ->
    media_youtube_caption_lifecycle_operations(id, media_id)

media_youtube_caption_data_allocation_cues # bounded staging bytes, consumed atomically
  id UUID PK
  caption_data_allocation_id UUID
  segment_index INTEGER
  start_ms BIGINT
  end_ms BIGINT
  speaker TEXT nullable
  text TEXT
  cue_sha256 TEXT
  created_at TIMESTAMPTZ
  UNIQUE(caption_data_allocation_id, segment_index)
  FK(caption_data_allocation_id) -> media_youtube_caption_data_allocations(id)

media_youtube_caption_publication_data    # publication association only
  id UUID PK
  media_id UUID
  transcript_publication_id UUID UNIQUE
  caption_data_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, transcript_publication_id, media_id)
  UNIQUE(id, caption_data_allocation_id, transcript_publication_id, media_id)
  FK(transcript_publication_id, media_id) -> media_transcript_publications(id, media_id)
  FK(caption_data_allocation_id, media_id) ->
    media_youtube_caption_data_allocations(id, media_id)

media_youtube_caption_lifecycle_operations # refresh-or-delete owner per publication
  id UUID PK
  media_id UUID
  transcript_publication_id UUID UNIQUE
  caption_publication_data_id UUID UNIQUE
  caption_data_allocation_id UUID UNIQUE
  refresh_due_at TIMESTAMPTZ              # no later than refreshed_at + 28 days
  purge_due_at TIMESTAMPTZ                 # early internal enforcement point
  compliance_delete_deadline TIMESTAMPTZ   # min API/approval/revocation deadline
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  FK(caption_publication_data_id, caption_data_allocation_id,
     transcript_publication_id, media_id) ->
    media_youtube_caption_publication_data(
      id, caption_data_allocation_id, transcript_publication_id, media_id)

media_youtube_caption_compliance_schedules # current reserved deadline placement
  id UUID PK
  lifecycle_operation_id UUID UNIQUE
  capacity_allocation_id UUID UNIQUE
  caption_capacity_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  UNIQUE(id, lifecycle_operation_id)
  FK(lifecycle_operation_id) -> media_youtube_caption_lifecycle_operations(id)
  FK(caption_capacity_allocation_id, capacity_allocation_id) ->
    provider_compliance_caption_capacity_allocations(
      id, capacity_allocation_id)

media_youtube_caption_refresh_runs          # exact source attempt per refresh try
  id UUID PK
  media_id UUID
  lifecycle_operation_id UUID
  run_no INTEGER
  source_attempt_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(lifecycle_operation_id, run_no)
  UNIQUE(id, media_id)
  UNIQUE(id, lifecycle_operation_id, media_id)
  FK(lifecycle_operation_id, media_id) ->
    media_youtube_caption_lifecycle_operations(id, media_id)
  FK(source_attempt_id, media_id) -> media_source_attempts(id, media_id)

media_youtube_caption_refresh_results       # authenticated ready-to-publish fact
  id UUID PK
  media_id UUID
  refresh_run_id UUID UNIQUE
  lifecycle_operation_id UUID
  caption_data_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  FK(refresh_run_id, lifecycle_operation_id, media_id) ->
    media_youtube_caption_refresh_runs(
      id, lifecycle_operation_id, media_id)
  FK(caption_data_allocation_id, lifecycle_operation_id, media_id) ->
    media_youtube_caption_data_refresh_use_owners(
      caption_data_allocation_id, lifecycle_operation_id, media_id)

media_youtube_caption_lifecycle_completions
  id UUID PK
  lifecycle_operation_id UUID UNIQUE FK media_youtube_caption_lifecycle_operations
  outcome TEXT                             # Replaced | Deleted
  replacement_publication_identity_sha256 TEXT nullable # audit only; row is
                                                   # retention-bounded/deleted
  created_at TIMESTAMPTZ

media_youtube_caption_lifecycle_suspensions
  id UUID PK
  lifecycle_operation_id UUID FK media_youtube_caption_lifecycle_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(lifecycle_operation_id, occurrence_no)

media_youtube_caption_lifecycle_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_youtube_caption_lifecycle_suspensions
  resolution TEXT                          # Requeued only
  created_at TIMESTAMPTZ

media_youtube_caption_compliance_receipts  # content-free, survives mandated erase
  id UUID PK
  lifecycle_operation_identity_sha256 TEXT UNIQUE
  publication_identity_sha256 TEXT
  outcome TEXT                             # Replaced | DeletedAtDeadline |
                                           # DeadExpired
  defect_code_sha256 TEXT nullable
  created_at TIMESTAMPTZ

media_youtube_owned_asr_data_allocations   # exists before restricted plaintext
  id UUID PK
  media_id UUID
  transcription_job_id UUID UNIQUE
  video_content_id UUID
  authorizing_user_id UUID FK users
  approval_artifact_sha256 TEXT
  use_policy_version TEXT                  # RestrictedYouTubeDerivedV1
  purge_due_at TIMESTAMPTZ
  compliance_delete_deadline TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, transcription_job_id)
  UNIQUE(video_content_id)
  UNIQUE(id, transcription_job_id, video_content_id, media_id)
  FK(transcription_job_id, media_id) -> media_transcription_jobs(id, media_id)
  FK(video_content_id, media_id) -> media_video_contents(id, media_id)

media_youtube_owned_asr_publication_data   # published arm of exact allocation
  id UUID PK
  media_id UUID
  transcript_publication_id UUID UNIQUE
  owned_asr_data_allocation_id UUID UNIQUE
  produced_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, transcript_publication_id, media_id)
  FK(transcript_publication_id, media_id) -> media_transcript_publications(id, media_id)
  FK(owned_asr_data_allocation_id, media_id) ->
    media_youtube_owned_asr_data_allocations(id, media_id)

media_youtube_owned_asr_lifecycle_operations # owns staged or published data
  id UUID PK
  media_id UUID
  owned_asr_data_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  UNIQUE(id, media_id)
  UNIQUE(id, owned_asr_data_allocation_id)
  FK(owned_asr_data_allocation_id, media_id) ->
    media_youtube_owned_asr_data_allocations(id, media_id)

media_youtube_owned_asr_compliance_schedules # current reserved deadline placement
  id UUID PK
  lifecycle_operation_id UUID UNIQUE
  capacity_allocation_id UUID UNIQUE
  owned_asr_capacity_allocation_id UUID UNIQUE
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  UNIQUE(id, lifecycle_operation_id)
  FK(lifecycle_operation_id) -> media_youtube_owned_asr_lifecycle_operations(id)
  FK(owned_asr_capacity_allocation_id, capacity_allocation_id) ->
    provider_compliance_owned_asr_capacity_allocations(
      id, capacity_allocation_id)

media_youtube_owned_asr_deadline_operation_sets # exact two-ref compliance fence
  id UUID PK
  lifecycle_operation_id UUID UNIQUE
  owned_asr_data_allocation_id UUID UNIQUE
  transcription_job_id UUID UNIQUE
  fence_generation_id UUID UNIQUE
  coordination_dependency_id UUID UNIQUE
  observing_operation_kind TEXT                # YouTubeOwnedAsrLifecycle
  observed_operation_kind TEXT                 # TranscribeMedia
  member_set_sha256 TEXT                       # lifecycle ref + TranscribeMedia ref
  fenced_at TIMESTAMPTZ
  created_at TIMESTAMPTZ
  UNIQUE(id, lifecycle_operation_id, owned_asr_data_allocation_id)
  FK(lifecycle_operation_id, owned_asr_data_allocation_id) ->
    media_youtube_owned_asr_lifecycle_operations(
      id, owned_asr_data_allocation_id)
  FK(owned_asr_data_allocation_id, transcription_job_id) ->
    media_youtube_owned_asr_data_allocations(id, transcription_job_id)
  FK(coordination_dependency_id, observing_operation_kind,
     lifecycle_operation_id, observed_operation_kind,
     transcription_job_id) ->
    coordination_operation_terminal_dependencies(
      id, observing_operation_kind, observing_domain_operation_id,
      observed_operation_kind, observed_domain_operation_id)

media_youtube_owned_asr_lifecycle_suspensions
  id UUID PK
  lifecycle_operation_id UUID FK media_youtube_owned_asr_lifecycle_operations
  occurrence_no INTEGER
  defect_code TEXT
  created_at TIMESTAMPTZ
  UNIQUE(lifecycle_operation_id, occurrence_no)

media_youtube_owned_asr_lifecycle_suspension_resolutions
  id UUID PK
  suspension_id UUID UNIQUE FK media_youtube_owned_asr_lifecycle_suspensions
  resolution TEXT                          # Requeued only
  created_at TIMESTAMPTZ

media_youtube_owned_asr_compliance_receipts # content-free, survives erase
  id UUID PK
  lifecycle_operation_identity_sha256 TEXT UNIQUE
  work_identity_sha256 TEXT
  deadline_member_set_sha256 TEXT
  publication_identity_sha256 TEXT nullable
  outcome TEXT                             # NoData | DeletedAtDisposition |
                                           # DeadExpired
  defect_code_sha256 TEXT nullable
  created_at TIMESTAMPTZ
  UNIQUE(id, lifecycle_operation_identity_sha256, work_identity_sha256,
         deadline_member_set_sha256)

highlight_media_time_anchors
  id UUID PK
  highlight_id UUID UNIQUE
  media_id UUID
  timeline_id UUID
  position_ms BIGINT
  created_at TIMESTAMPTZ
  FK(highlight_id, media_id) -> highlights(id, anchor_media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)

highlight_transcript_time_anchors
  id UUID PK
  highlight_id UUID UNIQUE
  media_id UUID
  timeline_id UUID
  t_start_ms BIGINT
  t_end_ms BIGINT
  fragment_id UUID nullable                # disposable current locator
  start_offset INTEGER nullable
  end_offset INTEGER nullable
  created_at TIMESTAMPTZ
  FK(highlight_id, media_id) -> highlights(id, anchor_media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(fragment_id, media_id) -> fragments(id, media_id)
```

`services/youtube_oauth_secret_envelopes.py` is the single cryptographic owner
for those three typed material tables; routes, jobs, and adapters cannot call a
cipher directly. Before insertion it allocates the material UUID, generates a
fresh CSPRNG 32-byte DEK and independent 96-bit data and wrap nonces, and uses a
vetted AES-256-GCM implementation with 128-bit tags. Data AAD is canonical,
versioned bytes over exactly `{ domain="nexus.youtube.oauth.secret.data",
envelopeVersion, materialKind: PkceVerifier | AuthorizationCode |
RefreshCredential, materialId, semanticOwnerKind: AuthorizationAttempt |
ExchangeIntent | Credential, semanticOwnerId }`. PKCE's owner is the immutable
authorization attempt, authorization code's owner is the exchange intent, and
refresh credential's owner is the credential. DEK-wrap AAD is exactly
`{ domain="nexus.youtube.oauth.secret.wrap", envelopeVersion, materialKind,
materialId, semanticOwnerKind, semanticOwnerId, kekVersion,
dataEnvelopeSha256 }`, where the final field hashes the
complete data envelope (`data AAD`, nonce, ciphertext, and tag). Mutable
hold/phase rows are deliberately not AAD: transferring the same PKCE material
between typed holds never decrypts or re-encrypts it because its attempt owner
does not change. Every encrypt/decrypt derives AAD from the expected semantic
owner reached through the operation—not from the material row alone—and the
composite hold/material/owner FKs make a same-kind cross-owner repoint
relationally invalid. Kind/domain plus separate typed tables prevent cross-
secret substitution.

`services/youtube_oauth_keyring.py`, composed once from
`python/nexus/config.py`, exposes a read-only deployment-injected map
from `(materialKind, kekVersion)` to an exact 32-byte KEK, with cryptographically
distinct KEK bytes for every material kind/version and exactly one
current encrypting version per kind and a bounded decrypt-only set. Keys exist
outside Postgres, the repository, manifests, queues, logs, exceptions, and
diagnostics; release evidence records only versions and digests. Startup
inventories all live ciphertext versions before serving caption routes.
Unknown envelope/key versions, wrong nonce/tag/key length, authentication/AAD
failure, duplicate `(kekVersion, wrapNonce)` insertion, repeated KEK bytes
across kinds, or row/owner/kind substitution is a security and
readiness incident—not an OAuth rejection and never cleanup success. Rotation
rewraps only each authenticated DEK under a fresh wrap nonce in an owned,
compare-and-swap transaction; it does not rewrite secret ciphertext. An old KEK
cannot retire until the exact live-row inventory is zero for its version and
the declared replica/WAL/backup horizon no longer contains an envelope that
requires it. Concurrent use/rewrap and crash replay preserve exactly one valid
envelope.

Only the credential owner decrypts immediately around the provider call; raw
bytes never cross a DTO, queue/replay body, audit, cache, or exception boundary.
Buffers have the smallest practical lifetime and are wiped best-effort, but
Python/framework copies cannot support a false absolute-zeroization claim;
core dumps are disabled and residue/log tests own that remaining risk. Deleting
the live ciphertext/hold in one Postgres transaction is the live-store absence
proof, not cryptographic erasure of WAL or backups. The signed compliance
artifact must expressly permit the bounded encrypted-backup retention policy,
and restore tooling must run the due-row purge before API/worker readiness. If
that retention is not permitted, this envelope design is release-`BLOCKED` and
must be replaced by independently destructible keys outside backups. The
accepted tradeoff is atomic lifecycle/ownership without an external secret
orphan, at the cost that compromise of both Postgres and the deployment keyring
exposes live secrets and provides less per-secret IAM/audit isolation.

The canonical crypto proof covers known-answer and round-trip vectors, forced
wrap-nonce collision, every single-field/cross-row/cross-kind mutation, valid
same-kind material-FK swaps across two attempts/exchanges/credentials, unknown
version/key, PKCE hold transfer/delete crash points, exact-one-hold inventory, concurrent
rotation, old/new decrypt, KEK-version-label swaps, zero-live-row retirement,
log/core-dump residue, and
backup restore followed by pre-readiness expiry scrub. Static residue forbids
direct AES calls and the predecessor `SecretVersionRef`, external-secret
materialization, secret-absence table, and secret-manager client/import paths.

Transcript replacement clears disposable locator FKs through the Highlight
owner before deleting/replacing Fragment rows, then re-resolves them after the
new publication; a stale UUID is never retained as an unaudited pseudo-link.
Timeline `id/media_id/generation` are stable identity. Only the Timeline owner
may mutate `binding_epoch`, set `duration_ms` from the first verified owned
publication (then require equality), and advance `updated_at` in the same
transaction; ordinary metadata or provider duration never touches it.
The usage-day row is identity/lock scope only. Migration snapshots each exact
pre-cut `minutes_used` into one immutable baseline because settled legacy work
no longer retains per-request charge facts. It separately requires
`minutes_reserved` to equal the sum of exactly correlated live legacy job
reservations, migrates those into per-work reservations, and aborts with day/
work ids on any mismatch. Only after equality does it drop legacy
`minutes_used`, `minutes_reserved`, and `updated_at`. Monthly used is baseline
plus immutable post-cut usage charges; held is unsettled post-cut/per-work
reservations, never baseline. Admission locks the stable viewer/user row at the viewer layer
before materializing any usage-day identity or reservation, then recomputes
the entitlement-period sum; a missing day row and UTC-midnight crossing cannot
create different budget mutexes. Concurrent requests for different Media
cannot oversubscribe the same one-user budget. The concurrency proof submits
both Media in opposing order across a UTC-month boundary and independently
recomputes every month's accounting from facts.
Every reserved work must have exactly one settlement before it becomes
terminal or its active marker clears. Both amounts are nonnegative and
`committed_minutes + released_minutes == reserved_minutes`; publication,
failure, cancellation, and replay read/reuse the existing settlement
idempotently under the reservation lock. Settlement atomically inserts exactly
one account/day-owned charge (including a zero-minute charge) and references
it; the charge has no Media/work FK and therefore survives whole-Media
teardown. Monthly held is exactly reservations without settlement and used is
baseline plus charges. Crash, concurrent cancel-vs-complete, and concurrent
settle-vs-Media-delete proofs recompute those equations, prove used is
identical before/after Media deletion, and forbid a leaked hold, refund, or
double settlement. A cross-user or cross-usage-day reservation/charge pairing
is rejected by the composite FKs and a real-FK proof. Explicit account erasure first deletes Media-owned
settlements through their work owners, then user-owned charges and baselines,
then the usage-day row; ordinary Media deletion never touches charges.

`media_video_assets` publication is row existence. Unpublication is `DELETE`
of the exact asset row inside the removal transaction — no status or
`unpublished_at` column, and no soft-deleted publication may exist. The
immutable content record supplies storage/measurement provenance after that
delete. `Removing`/`RemovalFailed`/`RemovalSuspended`/`KeptCopyRemoved` derive
from the current generation's latest removal plus its completion or latest
immutable cleanup-attempt outcome. A classified failure/completion row is
sufficient terminal truth and never depends on a retained succeeded queue row;
the queue row is required only while work is active or a suspended dead claim
needs same-job repair, and normal succeeded-row pruning cannot change product
state. Retrying removal retains the failed attempt, inserts the next cleanup
  attempt as `AwaitingDispatch` for the same removal identity; after commit the
  idempotent dispatcher admits that ref with the full retry budget. Concurrent retries linearize under the
removal lock and cannot create two live cleanup jobs. An unexpected dead job inserts the suspension row and
remains infrastructure-owned/dead until the operator requeues that exact job;
it is never translated into a normal product failure or user Retry. Durable
proof of removed bytes lives in the completion row, immutable content record,
removal identity, and Timeline owned identity.

Operator same-job requeue is one atomic queue-first transition through the
coordination port: lock the exact dead queue row, then its exact
`coordination_operation_jobs` row and revalidate the OperationRef, then lock
Media/head/Timeline and its domain work/removal attempt; verify the unresolved
suspension and absence of a competing terminal outcome/live job; insert the
immutable `Requeued` resolution; and requeue while preserving
`cancel_requested_at`. Under the already-required domain lock, each dead-letter
projection allocates `occurrence_no = max(existing occurrence_no) + 1` for that
work/removal attempt; it never derives the occurrence from the queue's
resettable `attempts` counter. The domain owner permits at most one unresolved
occurrence under lock. Product projection selects the latest unresolved
occurrence and ignores resolved history. Later
completion/failure may coexist with resolved suspension history without
ambiguity. Removal has no abandon transition: it must requeue until verified
absence completes or an expected dependency attempt classifies failure.
Transcript `Terminalized` is allowed only in the same transaction that settles
quota, inserts cancellation or typed failure, clears active ownership, and
completes the queue after all leases/submissions/write horizons are closed.
That transaction must call the one
`terminalize_transcript_work_in_txn` owner, which CASes the exact work's
correlated supplemental source attempt to `succeeded | failed | cancelled` for
completion/failure/cancel respectively; normal paths, generic repair, and
provider-resolution may not terminalize around it. `Suspended` deliberately
leaves both work and source attempt nonterminal. The CAS proves the work ->
source-attempt relation and cannot touch a newer attempt.
Dispatch-uncertain transcription is excluded: its separate provider-resolution
command is the only transition and requeue refuses it.

Application owners enforce positive sizes/durations/dimensions, valid hashes,
the v1 codec/profile, time within the known timeline, and same-Media foreign
facts. A dispatch resolution is structurally total: `RecoveredResult` requires
both provider operation reference and exact response SHA-256;
`ChargedNoResult` requires response SHA absent and permits the operation
reference only when independently authenticated. The operator actor and
authorization-context digest are mandatory, and one uncertainty can gain only
one immutable resolution. A recovered result inserts/reuses the submission
whose provider/ref exactly equals the resolution ref; global nullable
uniqueness forbids one provider operation from resolving two works. Replay and
cross-work-ref proofs enforce both facts. Storage verification is immutable
evidence that bytes once passed integrity; an absence may follow it only when
no content row references that verification (verified-before-publication then
cancelled/cleaned). Publication requires verification and rechecks absence is
missing. Absence is terminal physical cleanup truth; a row with neither fact is
unreconciled, while verification-without-content/absence is ready for the same
attempt to publish. Metadata-derived podcast Timeline duration is advisory and never a
write bound: the "time within the known timeline" rule applies only to
durations installed by the trusted probe on a verified owned asset; podcast
writers validate only non-negative, sanely bounded positions, and migration
never rejects or truncates an existing playback-state position that exceeds
episode metadata duration. Current-generation owned identity and binding are
represented by mutually exclusive row existence, never nullable lifecycle
clusters; asset/removal content must match that identity. Activity
Timeline fields are present exactly for `Listening`/`Viewing` spans whose
media has a Timeline and absent for `Reading` spans; positions remain
independently `Presence`-paired and may be absent on a timed span. Per
`docs/rules/database.md`, do not add business-state `CHECK` constraints or
triggers.

### Hard-cut renames and additions

- `podcast_listening_states` -> `media_playback_states`, with class names by
  module: `db/models.py::PodcastListeningState` -> `MediaPlaybackState`;
  `schemas/consumption.py::ListeningStateOut` -> `PlaybackStateOut` (the
  CAS-fenced contract, keeping `write_revision`, `reset_epoch`, and
  `last_engaged_at`); `schemas/media.py::ListeningStateOut` is deleted
  outright and `MediaOut.listening_state` is replaced by the strict
  projections; `schemas/podcast.py::PodcastEpisodeListeningStateOut` ->
  `PodcastEpisodePlaybackStateOut`; `E_STALE_LISTENING_REVISION` ->
  `E_STALE_PLAYBACK_REVISION` (409), with `errors.py` and the frontend
  heartbeat client updated in the same release. Preserve Podcast position,
  rate, and completion exactly. Pre-cut canonical-YouTube playback state,
  completion facts, player history, and Lectern/device snapshots lack a
  validated MFK decision and are deleted with exact counts/ids; unknown
  historical tracking is never relabelled compliant. (A future lawful import
  would need item-specific non-MFK evidence; this cut does not make migration
  API calls.) Then replace the legacy composite primary key with a
  generated UUIDv7 `id` primary key, retain `UNIQUE(user_id, media_id)`, add
  `created_at`, and recreate every foreign key without `CASCADE`/`SET NULL`;
  drop `duration_ms` (the Timeline is the sole duration
  authority — the client-supplied wire duration dies with
  `/listening-state`). Add `timeline_id UUID NOT NULL` with
  `FK(timeline_id, media_id)` and `binding_epoch BIGINT NOT NULL`, backfilled
  from Timeline at epoch zero. Before setting NOT NULL, the migration deletes
  any playback-state row whose Media kind is not `podcast_episode` or `video`
  (residue of the unguarded legacy endpoint; log the count); the new PUT
  enforces the timed-media kind guard the old route lacked with a typed
  error. Position-column width moves to BIGINT alongside the int64 wire rule.
- `podcast_episode_chapters` keeps its honest Podcast owner but gains
  same-Media `timeline_id` (backfilled via episode -> media); every ingest
  write uses the Timeline gateway.
- `consumption_activity_spans` gains nullable same-Media `timeline_id` plus
  `binding_epoch`, present exactly for `Listening`/`Viewing` spans of
  Timeline-bearing media (regardless of position presence) and absent for
  `Reading` rows; migration asserts zero `Reading` rows received Timeline
  fields. Pre-cutover `modality='Viewing'` rows recorded focused-pane dwell,
  not engine evidence: the migration DELETES them, plus every pre-cut
  Listening/Viewing span for canonical YouTube Media whose MFK status was not
  authoritatively checked, plus any
  `consumption_completion_facts` row they alone justified, recording both
  counts in the migration proof — dwell is no longer activity truth.
  `timeline_id`/`binding_epoch` join the capture-key semantic identity tuple
  (`_activity_store._CAPTURE_SEMANTIC_FIELDS` and its existing-row SELECT); a
  capture key replayed with different Timeline facts is
  `E_ACTIVITY_CAPTURE_CONFLICT`, never a silent dedupe. The consumption-state
  discriminator widens to canonical timed-media kind
  (`_projection._AUDIO_READ_STATE_KINDS`, the completion branch in
  `consumption/service.py`). Completion remains distinct from attention:
  natural-end settlement records the active engine's last observed modality
  (`Viewing` while visibly attached, `Listening` for parked owned video), while
  an explicit user **Mark finished** on video records `Viewing`. No kind-only
  mapper may invent Viewing for a parked natural end.
- `podcast_transcript_segments` -> `media_transcript_segments` and
  `PodcastTranscriptSegment` -> `MediaTranscriptSegment`. Segment rows
  reference `(publication_id, media_id)` with `publication_id NOT NULL` by
  design — segments are publication-scoped derived content. The rename drops
  `uq_podcast_transcript_segments_media_idx`,
  `ck_podcast_transcript_segments_segment_idx_non_negative`, and
  `ck_podcast_transcript_segments_time_offsets_valid`, creates
  `uq_media_transcript_segments_publication_idx(publication_id, segment_idx)`,
  renames the start index to `ix_media_transcript_segments_media_start`, and
  recreates the legacy cascading Media FK as the repository-default restrictive
  FK; whole-Media deletion remains explicit child-first owner code.
- `media_transcript_publications` is the sole owner of origin, input kind,
  input digest, provider, model, language, and timing granularity, and its
  rows are immutable history. `media_transcript_publication_heads` is the sole
  current pointer: publication/replacement inserts a new row and atomically
  creates or swaps the head under the Timeline/current-transcript lock. Old
  segment/Fragment content may be owner-deleted, but a non-caption publication
  identity remains while audit/reindex history references it; Highlights
  survive independently by Timeline/time/quote and carry no publication FK.
  Caption expiry follows its stricter deletion owner after the head and every
  restricted derived child are removed.
  The mutable `media_transcript_states` cluster is dropped after migration
  materializes its authoritative work/publication/reindex facts. The one
  `derive_media_transcript_projection` query owner computes the closed wire
  operation, semantic status, request reason, and typed error from those facts;
  no cache, repair loop, nullable status cluster, or second writer survives.
  The immutable `media_transcription_jobs` row, row-existence active marker,
  neutral reservation/settlement, and disjoint submission/terminal outcome
  rows are the authoritative work identity. `TranscriptWorkHandle` seals that per-request job id, and state,
  source-attempt correlation, Timeline fence, reservation ownership, and exact
  cancellation all resolve through it; the coordination port reaches the queue
  item through `OperationRef { operationKind=TranscribeMedia,
  domainOperationId=transcription_job_id }`, never a copied raw queue UUID or
  domain FK. No Media-level mutable row can identify work by itself. For every
  readable legacy transcript, migration synthesizes or resolves exactly one
  same-Media producer source attempt, creates one immutable publication with
  that FK, and inserts exactly one head pointing to it; an unreadable/partial
  legacy state gets no publication or head. It aborts on zero/multiple producer
  candidates and proves readable-state/publication/head/segment count parity
  plus the composite FKs. Every post-cut read resolves only through the head.
  The migration drops `transcript_origin` (after synthesizing publications) and
  `transcript_coverage` (deleted per Non-goals, not migrated). Publication may
  coexist with queued/running/cancelling/failed replacement work; the derived
  projection returns `idle` when no active work remains.
  Transcript Fragments gain nullable `transcript_publication_id` with
  composite `FK(transcript_publication_id, media_id)`; non-transcript
  fragments keep it absent; `ck_fragments_time_offsets_paired_null` and
  `ck_fragments_time_offsets_valid` are dropped (application invariants).
- Hard-cut the derived transcript operation union to `idle | preparing_input |
  cancelling_input | queued | running | cancelling | quota_blocked | failed |
  unavailable | suspended`. Preflight
  MUST assert and
  report zero `partial` rows; partial content is neither complete nor safe to
  relabel, so migration aborts for explicit operator repair instead of
  upgrading it to readable content. Migrate `not_requested`/`ready -> idle`,
  `failed_quota -> quota_blocked`, `failed_provider -> failed`; delete old
  decoders, table, business-state checks (`ck_media_transcript_states_state`
  and `ck_media_transcript_states_coverage`), and
  `ix_media_transcript_states_semantic_repair`, with no replacement state
  index. The repair SELECT starts from authoritative active-intent/current-
  head/publication rows and applies `TranscriptUsePolicy`; one-user scale does
  not justify a mutable cache. Catalog and query-behavior proofs cover the
  derived union. The same ten-value operation
  union plus publication Presence cuts through the whole action surface in one
  release: `TranscriptResourceActionCapabilityOut.state` and
  `_TRANSCRIPT_ACTION_STATE` (`resource_items/action_snapshots.py`), the
  `resourceActionSnapshot.ts` strict decoder, the
  `ResourceOperation.Media.Transcript` catalog `states` record and
  `planTranscript` switch, and `resourceActionProductOracle.ts` — the
  `Ready`/`Partial`/`FailedQuota`/`FailedProvider` operation arms and the
  `coverage` field are
  deleted, and the relabelled presentations are `Transcribe…` /
  `Verifying episode length…` / `Cancelling length check…` /
  `Transcription queued` / `Transcribing…` / `Cancelling transcription…` /
  `Open transcript` /
  `Review billing` (QuotaBlocked, intent `ReviewBilling`, never retry) /
  `Retry transcription` / `No transcript available` (no intent).
- Rename the shared `podcast_reindex_semantic_job` task/kind to
  `media_transcript_reindex_job` and give it one immutable
  `media_transcript_reindex_intents` identity per publication/semantic
  revision. Its OperationRef is
  `MediaTranscriptReindex(reindexIntentId)` and its strict payload is
  `{ reindexIntentId, mediaId, transcriptPublicationId, semanticRevision }`;
  there is no payload search or `dedupe_key` surrogate. The registry entry,
  topology tuple (`BACKGROUND_WORKER_JOB_KINDS`), task module/function including
  its literal `job.kind` self-check, and both admission sites in
  `services/transcripts/semantic.py` move in the same commit;
  `lock_jobs_for_payload` is deleted. Under the locked Media/current-
  publication rows, the owner rejects an existing active marker for that exact
  publication, allocates
  `semantic_revision = max(revision for that publication) + 1`, inserts the
  immutable intent plus active marker, and commits it as `AwaitingDispatch`.
  A terminal completion, classified failure, or cancellation clears that exact
  active marker; Retry after terminal failure allocates the next revision and
  a new OperationRef, never resets or reuses the old intent. Concurrent
  publication/repair requests therefore converge to one active revision, and a
  stale retry cannot overwrite a newer outcome. Replacement may leave a
  claimed old publication's cancellation-fenced marker until its worker
  settles while creating a distinct active marker for the new head; the old
  worker must recheck the current head before every write and cannot publish
  against it. Teardown inventories both refs. A claimed transcript publication
  transaction never acquires the Media admission gate or creates semantic work.
  After it commits, a fresh gate-first domain transaction revalidates teardown,
  current head and semantic-eligible `TranscriptUsePolicy`, creates/joins the
  exact reindex intent as `AwaitingDispatch`, then uses the standard postcommit
  OperationRef dispatcher. Replacement inserts the exact
  old-intent cancellation before swapping the head and deleting/rebinding only
  disposable segment/Fragment content; the ordinary old publication identity
  remains immutable history. Teardown cancels before child-first deletion, and
  a delayed reconciler cannot index either stale publication. Completion,
  classified failure, cancellation,
  and unexpected suspension are disjoint per-intent rows; only one of the first
  three is terminal, while dead -> requeue records monotonically allocated
  suspension/resolution history. Derived semantic status is a
  current-publication projection, never terminal evidence for an old intent.
  A current YouTube-caption publication projects exactly
  `InapplicableByPolicy`: it never has an active marker or reindex intent, and
  stale repair refuses it. `reconcile_stale_ingest_media_job` is a live
  admission source for the renamed kind: readability becomes exact current-
  publication existence and semantic revision, its segment existence probe is
  renamed, and `request_transcript_semantic_repair` uses that same predicate.
  Migration maps an old nonterminal semantic job only when its Media has one
  exact eligible current publication/revision; ambiguity aborts and terminal
  history is not made runnable. Proofs cover replacement-publication,
  teardown, concurrent revision allocation, claimed-old-reindex versus
  replacement, stale retry/repair, caption-policy refusal, two dead/requeue
  cycles, and pruning convergence.
  Reindex embedding is not replay-safe provider work. Before each bounded batch,
  the owner commits the exact request digest, provider/model/dimensions,
  authorizing user/context, and batch ordinal, then makes exactly one
  zero-provider-retry call. Success commits the response digest, account-owned
  usage charge, bundle digest, and one ordered Postgres `BYTEA` vector child per
  input before index publication; resume consumes those children and makes zero
  provider calls for an already completed batch. Vector count, ordinal, byte
  length, finite float32 values, per-vector digest, and aggregate digest are
  revalidated on every read. A lost or ambiguous response inserts uncertainty
  and is never automatically resubmitted or requeued. `RecoveredResult`
  atomically inserts the ordinary result/vector/charge facts and points the
  authenticated resolution at that result; `ChargedNoResult` inserts only the
  independently evidenced account charge. Exactly one arm is structurally
  complete. Child-first deletion removes Media-owned vectors and intents while
  the account charge survives. Content reindex uses the identical generated
  protocol and invariant owner; schema parity is a catalog proof, not duplicated
  handwritten behavior.
  Maintenance inventory also joins every `ingest_media_source` queue row to a
  transcript supplemental source attempt. Before rewrite, the release
  controller and migration independently assert zero `running` rows in that
  exact transcript-source-attempt join; a primary-ingest row of the same kind
  is outside this set and remains valid. After that join-scoped zero-running proof,
  migration rewrites every such non-running row — in every status — to
  `transcribe_media` with the new strict work/timeline/attempt payload,
  resource class, and current task digest while preserving attempt count,
  cancellation, result/error bytes, due time, and terminal history. Terminal
  rows remain terminal. A pending row with zero executions may resume the same
  work. Any nonterminal row in `pending` or retryable `failed` with
  `attempts/run_count > 0` predates the dispatch-intent fence and could already
  have reached Deepgram: in the same migration transaction it becomes queue
  `dead`, clears claimant/lease/heartbeat fields, sets
  `finished_at=coalesce(finished_at, now())`, preserves attempt count,
  cancellation, due time, and opaque result/error audit bytes, inserts dispatch
  uncertainty with `reason_code=LegacyPreFence`, conservatively settles its
  maximum, and projects `Suspended`. Migration never synthesizes a dispatch
  intent/input digest from the current mutable locator. `RecoveredResult` is
  admissible for such a row only when independently retained exact submitted
  bytes plus their contemporaneous digest/provider correlation prove the work;
  otherwise the resolver permits only `ChargedNoResult`. The migration/resolver
  proof rejects a fabricated recovered result and accepts the audited charged-
  no-result arm.
  An already-dead correlated row is normalized to the same uncertainty facts
  without changing its terminal timestamps. `never_prune_dead` applies. No
  attempted migrated row is left in a runnable status; only zero-execution
  pending may run. The upgraded-catalog proof covers attempted pending,
  retryable failed, already dead, and zero-attempt pending fixtures. It asserts no
  transcript-source attempt remains executable by the primary-ingest handler.
- `podcast_transcription_jobs` -> `media_transcription_jobs`
  (`PodcastTranscriptionJob` -> `MediaTranscriptionJob`),
  `podcast_transcript_request_audits` -> `media_transcript_request_audits`,
  and `podcast_transcription_usage_daily` -> `media_transcription_usage_daily`
  — all serve podcast and video lanes. Jobs are rebuilt from the legacy
  one-row-per-Media shape into the immutable UUIDv7 request identity described
  above. Request audits preserve every existing opaque UUID, use UUIDv7 only
  as the default for new rows, gain restrictive Media/viewer FKs plus nullable
  work FK, and retain `created_at`; forecast/rejected/dry-run history has no
  work, while accepted-work history is linked only where exact queue/work
  correlation is provable. Legacy nullable viewer provenance is preserved;
  legacy `requested_by_user_id` is renamed exactly to `viewer_id`, including
  its FK and index/catalog names; the migration/catalog oracle and residue gate
  assert no old column/constraint/index name remains.
  the application requires viewer id on every new command. Legacy outcome,
  required/remaining-minute, and budget-fit snapshots are retained; `dry_run`
  maps deterministically to `decision_kind=ForecastOnly|Command` and only then
  is the boolean dropped. Usage-daily gains UUIDv7 `id`, `UNIQUE(user_id, usage_date)`,
  restrictive owner FKs, and `created_at` instead of a composite natural PK.
  Legacy `CASCADE`/`SET NULL` FKs are replaced and all children are owned by
  explicit child-first deletion. Status and request-reason CHECK constraints
  are dropped, not extended; vocabulary moves to application owners. The
  forecast/reserve/settle seam (`transcription_usage.py`,
  `transcription_reservation_settlement.py`) moves under the generic
  transcript kernel (workstream E) and loses its podcast-episode kind guard.
  Only RSS/subscription/provider-sidecar adapters keep honest Podcast names.
  Migration backfill maps each legacy mutable transcription row to one UUIDv7
  work id, current Timeline, a synthesized supplemental source attempt with
  the exact migrated queue correlation, and at most one reservation,
  submission, or terminal outcome. It aborts with row ids before mutation if
  status, queue payload, audit, usage, provider reference, or reservation
  totals cannot form exactly one closed arm; it never guesses request history.
  The migration proof independently checks every legacy-row count and opaque
  id, `created_at`, uniqueness, restrictive FK, reservation arithmetic, and
  projection parity.
- For `kind=video`, persistent `media_user_title_states` plus optional
  `media_user_title_values` are the sole user-authored title owner; the legacy
  bare `media.title` is never interpreted as authorship. Every new or migrated
  `kind=video` Media gets a state row at revision zero, including when no value
  exists. `FromUrlRequest` and its strict BFF/TypeScript decoders gain
  `userTitle: Presence<CanonicalUserTitle>`; Add may create the value atomically
  with Media and its state. `CanonicalUserTitle` has one server owner: reject
  every Unicode `Cc`, `Zl`, `Zp`, or `Bidi_Control` scalar; normalize to NFC;
  map each remaining Unicode White_Space run to one U+0020, trim U+0020, then
  require 1..200 Unicode scalars and at most 800 UTF-8 bytes. The client mirrors this only for immediate
  feedback. Every surface renders the plain-text value inside
  `<bdi dir="auto">`; it is never markup, an iframe attribute assembled as
  HTML, or an unredacted log field. A new viewer-authorized, idempotent
  `PUT /media/{id}/user-title` requires `Idempotency-Key` and accepts
  `{ expectedRevision, title: Presence<CanonicalUserTitle> }`, CASes the
  persistent state, increments its revision on every value change, and is the
  only later writer. `Absent` deletes only the value and increments state; it
  never deletes or resets revision, closing absent -> value -> absent ABA.
  There is no claimed pre-existing edit/provenance ledger, so automation cannot
  decide whether a legacy value was user-authored. Before maintenance, the one
  user must review an exact generated inventory and produce a short-lived,
  locally signed cutover-attestation manifest with exactly one decision for
  every legacy video row: `PreserveAsUserTitle | ClearToFallback`, bound to the
  Media UUID and the then-current title bytes. The manifest is not checked in,
  logged, or retained after the migration receipt. Migration refuses an absent,
  duplicate, stale, invalid, or unreviewed decision. `PreserveAsUserTitle`
  passes the existing value through the canonical normalizer and creates the
  revision-zero value; an invalid value blocks for explicit user correction—it
  is never truncated. `ClearToFallback` stores no copy and uses **YouTube
  video** for canonical YouTube or **Video** for every other provider. The
  durable receipt retains only aggregate per-disposition counts and the signed
  manifest digest; that digest is access-restricted and retention-bounded
  because title digests can be dictionary-recoverable. The rollback-only
  migration oracle may compare exact values in-transaction. This deliberate
  one-user ceremony prevents silent destructive title loss without pretending
  provenance can be reconstructed. `MediaOut.title`
  remains a required display string computed as the
  value row or fallback, while `titleSource: User | Fallback` and
  `titleRevision` are closed video-only projections. Provider API title is
  never an input. Add-panel review exposes an optional **Title** field for each
  video URL. Every video card and active player exposes an accessible
  **Edit title…** action opening one labelled dialog prefilled from the value;
  **Clear title** restores the provider-specific fallback. Save preserves focus, disables
  only while its own request is pending, announces success/error, and updates
  card, player, offline model, history, and search from the returned projection.
  A 409 stale-revision reply refreshes title/revision, retains the local draft,
  announces the conflict, and requires an explicit second Save; there is no
  optimistic last-write-wins. Empty, over-200-scalar, control, bidi-control,
  noncanonical, and multiline fixtures are rejected identically by Add, edit
  UI, BFF, and server. Proofs include absent -> A -> absent -> stale-A ABA
  rejection, initial/all-provider backfill revision, unsupported-provider
  read/edit/clear, reload, focus return, and live/offline/search propagation.
- Add source types `youtube_video_copy` and `youtube_caption_refresh` to
  `services/media_source_types.py`
  (deliberately NOT a member of `TRANSCRIPT_SOURCE_TYPES`). `youtube_video`
  remains metadata Add; `video_transcript` becomes real durable transcript
  work. `youtube_caption_refresh` is a supplemental, Timeline-bound source
  attempt owned only by `YouTubeCaptionLifecycle(lifecycleOperationId)`; it is
  excluded from paid transcription work, reservations, transcript operation
  projection, and default source selection, and its success/failure mapping is
  the lifecycle refresh/expiry state machine above. Attempt scope is derived
  exhaustively from the closed source-type
  owner; no duplicative `attempt_role` column is added. `attempt_no` remains
  globally monotonic per Media under the existing
  `UNIQUE(media_id, attempt_no)`, and every primary/supplemental allocator uses
  the same Media-locked next-number helper. `_require_source_publication`'s
  latest-attempt supersede check is scoped to the derived role, and its
  hardcoded `job.kind ==
  'ingest_media_source'` assertion becomes a caller-supplied expected-kind
  parameter. Normative invariant: a supplemental attempt never supersedes,
  and is never superseded by, a primary-ingest attempt; Refresh/Retry during
  a running copy neither cancels it nor is cancelled by it.
  Supplemental copy/transcript attempts additionally carry restrictive
  same-Media `timeline_id`; the current `videoCopy`/`transcript.operation`
  projections consider only rows whose Timeline is the current head. Discard
  deliberately retains older attempts/removals/outcomes as history, but none
  may constrain or appear on the fresh generation. A Retry creates a new
  attempt in the same Timeline generation, never a new generation.
  Source-attempt migration maps legacy `media_source_attempts.job_id` only
  after mapping each queue-owned item to a typed operation correlation:
  `PrimaryMediaIngest(sourceAttemptId)`, `AcquireVideoCopy(sourceAttemptId)`, or
  the transcript work ref. Any nonterminal attempt with a missing or ambiguous
  queue item aborts for operator repair; terminal dangling values are reported
  with exact ids/counts. After fail-closed mapping it drops the old FK/index and
  `job_id` column from the table/model rather than leaving a writable
  compatibility pointer. Pg-catalog, ORM-shape, import, and source-residue
  assertions prove absence. No new FK is created, and all
  primary/supplemental admission owners move to the same Media-gated
  AwaitingDispatch -> coordination protocol in this cut. Residue proves no
  source operation reads/writes the legacy pointer; the barrier proof includes
  primary admission and caption refresh racing whole-Media teardown. Topology,
  migration, same-Media FK, and projection tests prove the refresh attempt can
  neither appear as paid transcript work nor supersede another source role.
- Add a unique partial YouTube identity index on `(provider, provider_id)`
  with predicate `kind='video' AND provider='youtube' AND provider_id IS NOT
  NULL` (matching the X/email index shape), registered in
  `db/retries.py::RETRYABLE_UNIQUE_CONSTRAINTS` in the same commit —
  defence-in-depth beside the existing `uix_media_canonical_url`
  convergence. `services/youtube_provider_lock.py` adds
  `lock_youtube_provider_identity` mirroring `lock_x_provider_identity`; the
  YouTube Add path takes it before `_find_reusable_url_media`, whose YouTube
  branch re-keys from canonical URL to `(provider, provider_id)`, so
  concurrent Adds serialize and the index never surfaces as an unmapped
  23505. Migration aborts on an existing duplicate with a report listing the
  duplicate media ids and the operator procedure (whole-Media delete of the
  loser via the existing destructive delete — never a merge), plus a count of
  video rows with YouTube URLs but NULL provider identity. Before creating the
  index, the migration deterministically parses supported canonical YouTube
  URLs into provider ids and aborts with exact row ids for every malformed,
  ambiguous, or still-NULL supported row; enabling identity reuse while such
  rows survive would permit duplicates. Never guess a merge winner.
- Add terminal `cancelled` to the attempt lifecycle everywhere at once: the
  `MediaSourceAttemptStatus` enum, the wire `Literal` in `schemas/media.py`,
  the strict validator `media_source_ingest._source_attempt_status`, and the
  browser decoder tuple `ingestionClient.ts::SOURCE_ATTEMPT_STATUSES`. Every
  lifecycle predicate is rewritten to one named terminal set
  `{succeeded, superseded, failed, cancelled}` — no consumer may keep the
  `NOT IN ('succeeded','superseded')` shorthand (`media_activity.py`
  classification/`source_published`/`_source_stage`,
  `source_publication.py`'s allowed statuses and progress filter,
  `media_source_ingest._IN_FLIGHT_ATTEMPT_STATUSES` and its call sites;
  residue-gated). `background_jobs` gains queue-owned nullable
  `cancel_requested_at`. No NEW lifecycle-state index or uniqueness
  constraint is added — Media locking plus mutation replay linearizes the one
  active copy invariant; existing claim/prune/dedupe indexes are untouched.
- Add relational `UNIQUE(id, media_id)` to `media_source_attempts` solely as the
  target for same-Media composite FKs; this is identity shape, not lifecycle
  uniqueness.
- Widen `media_source_attempts.progress_completed` and `progress_total` from
  `INTEGER` to `BIGINT`, preserving NULLs and rejecting negative or greater-
  than-int64 values in the owner. The 4 GiB profile cannot be represented by
  the existing signed 32-bit columns; migration and wire proofs cover values on
  both sides of 2 GiB and at the 4 GiB ceiling.
- The primary/supplemental split has one owner: a
  `PRIMARY_INGEST_SOURCE_TYPES` frozenset in `services/media_source_types.py`
  (primary = today's `media.py:_SOURCE_ATTEMPT_TYPES_SQL` set; supplemental =
  `youtube_video_copy`, `video_transcript`, `podcast_episode_transcript`).
  Every latest-attempt reader selects the latest PRIMARY attempt:
  `load_source_progress`, `public_source_urls.current_public_source_url`,
  `media.py` `_source_attempt_available_sql` + `_SOURCE_JOB_SUSPENDED_SQL`,
  `public_resource_sharing._load_subject_facts`, and the `media_activity`
  classification LATERAL, with an inventory pass over remaining
  `attempt_no DESC` sites. `_source_progress_from_attempt` splits into two
  decoders — primary keeps `{Validate, Extract, Finalize} x {Page, Chapter}`;
  a copy decoder owns `{Resolve, Download, Package, Probe, Upload, Verify,
  Finalize} x {Byte}` (`progress_unit` gains `Byte`) — so neither union can
  decode the other's rows. Copy and timed-transcript work is projected only
  by `GET /media/{id}`'s `videoCopy`/`transcript` arms, never by the ingest
  Activity pane or its needs-attention badge.
- Make `highlights.anchor_kind` and `anchor_media_id` non-null. First the
  migration deletes every `highlights` row with neither a
  `highlight_fragment_anchors` nor a `highlight_pdf_anchors` child — already
  unreadable under `highlight_readability_filter` — using the same explicit
  child-first order as `delete_highlight_rows` (grants, resource-graph edges
  including link/stance and highlight-note edges, idea rows, then the root),
  logging the count; it does not abort on rows no surface can ever show. Then
  it backfills both columns from the surviving child row and sets NOT NULL.
  Add anchor kinds `media_time` and `transcript_time_text` plus
  `UNIQUE(id, anchor_media_id)`. For every `fragment_offsets` Highlight whose
  `anchor_media_id` is podcast/video media, the migration converts the anchor
  to `transcript_time_text`: it inserts the new anchor row carrying the
  existing `fragment_id`/`start_offset`/`end_offset` as the disposable
  locator, takes `t_start_ms`/`t_end_ms` from the joined `fragments` row,
  and deletes the `highlight_fragment_anchors` row; a timed-media fragment
  anchor whose joined fragment has NULL timings, or whose Media has no
  publication, aborts for explicit operator repair. Post-migration, zero
  `fragment_offsets` rows remain on timed media (residue-asserted). The
  migration drops `ck_highlights_anchor_kind_valid` and
  `ck_highlights_anchor_fields_paired_null` without replacement (application
  invariants), keeping only `ck_highlights_color`, and relaxes
  `exact`/`prefix`/`suffix` to nullable with the application invariant:
  quote fields present for every kind except `media_time`, absent for
  `media_time`. Any new child-anchor constraint name is registered in
  `highlights.map_integrity_error`'s allowlist so a violation surfaces as
  `E_INVALID_REQUEST`, never `E_INTERNAL`.
- Every new HTTP failure code in this spec is added to the closed
  `nexus.errors.ApiErrorCode` enum and `ERROR_CODE_TO_STATUS` before a handler
  raises it. Worker-only classified outcomes use the separate closed
  `VideoCopyFailureCode`; the background child envelope carries that union
  explicitly. Unexpected exceptions remain `E_WORKER_CHILD_DEFECT` and retain
  infrastructure ownership. Both code owners are `durable-job-replay` source
  globs, so either change re-selects that risk's proofs.

### Media event stream

The existing media SSE closes as soon as `processing_status` is terminal — a
YouTube video is `ready_for_reading` before any Keep exists, so without this
cut the entire copy/transcript/removal lifecycle would receive zero live
updates while the spec forbids polling. This cutover hard-cuts the read
model: `services/media.py::read_event_snapshot` drops the loose
`transcript_state`/`transcript_coverage` fields and embeds the four strict
projections (`timeline`, `videoCopy`, `playback`, `transcript`) verbatim, so
the SSE frame and `GET /media/{id}` are one shape; its `terminal` predicate
becomes `processing_status is terminal AND videoCopy is a terminal arm
(Unsupported | NotKept | Kept | Failed | Suspended | RemovalFailed |
RemovalSuspended) AND the
transcript operation is terminal (Idle | QuotaBlocked | Failed | Suspended |
Unavailable) AND no binding reservation or nonterminal removal cleanup is
open`. `api/routes/stream.py` stops terminating on `ready_for_reading`
alone; the client `useMediaProcessingStatus.ts` derives `shouldStream` from
the projections (deleting its terminal gate and `expectExactRecord` key
list) and re-decodes the pushed snapshot in place — no `MediaOut` refetch.
The player runtime owns a shell-level continuous subscription mode for the
active session's Media, independent of any open pane. That mode remains open
until the session ends even while every lifecycle projection is terminal;
the mounted Media pane likewise keeps its authoritative stream open for its
entire mounted lifetime, even with no active session. Only one-shot command
observers may close on the terminal predicate. Thus a later command in another
tab — including first Keep from `NotKept` — still refreshes a visible pane and
delivers its epoch bump to dismiss a stale session. Copy and
transcript attempts touch `media.updated_at` only to invalidate this read
model. The proof uses two clients and mutates the Timeline after the first
client observed a terminal snapshot.

The semantic-job rename is also a data cut. After the separately ordered native
outbox flush, the release controller enables the deploy-owned maintenance gate,
drains/cancels bounded work through ordinary queue transitions, and gracefully
shutdown-releases any remaining claim through the existing queue owner before
stopping every worker lane and then `api`. It must prove zero old-kind
`running` rows and zero `running` rows in the exact transcript supplemental
source-attempt -> `ingest_media_source` join before migration; the migration
repeats both assertions and aborts rather than fabricating a pending or dead
state from an orphaned claim. Primary-ingest rows of that shared kind are not
rewritten. The release one-off then
rewrites `background_jobs.kind` for EVERY old-kind row in every non-running
status and asserts zero old-kind rows across all statuses before commit.
Retained dead rows are not exempt. The gate remains
active through exact-version postdeploy verification and is removed only by
the release controller; crash recovery is idempotent. This follows the
repository's incompatible-cut standard rather than racing live writers.

Legacy YouTube transcript provenance is a release blocker, not an `Imported`
alias. The current implementation fetched those rows through
`youtube_transcript_api`; `transcript_origin='Imported'` cannot prove lawful API
access or retention. Preflight therefore treats every readable transcript on
canonical YouTube Media, plus its Fragments, semantic chunks, quotes, and
transcript Highlights, as unapproved legacy caption data. It aborts with exact
Media/Fragment/Highlight/index ids and requires the one user to explicitly
**Discard saved timeline** (which also deletes derived semantic data) before
cutover. The only exception is an immutable operator provenance artifact that
proves the exact input digest came from a lawful non-YouTube publisher source;
generic origin text or a later caption approval cannot retroactively prove it.
No legacy YouTube-caption row is mapped to a publication. The dependency,
imports, proxy/config surface, and every call to `youtube_transcript_api` are
deleted, and migration/residue proofs assert zero migrated legacy caption
publications and zero surviving symbol/package/config path.

Transcript synthesis is total, in three cases after that preflight. (1) For every Media whose
`transcript_state` is readable, migration requires valid provenance and exact
agreement among state, ordered segments, and timed transcript Fragments; it
preserves origin, creates exactly one publication with
`input_kind=MigrationDigest`, and binds all segment/Fragment rows to it. The
digest is pinned: SHA-256 over UTF-8 of
`nexus:media-transcript-publication:v1\n` + the canonical JSON array of
`{"index": int, "start_ms": int, "end_ms": int, "speaker": string|null,
"text": string}` serialized with sorted keys, separators `(",", ":")`,
`ensure_ascii=False`, text exactly as stored — one shared named constant used
by the migration and asserted independently by the A proof. (2) For every
Media that owns transcript content under a NON-readable state (a normal,
expected population — `0202_browse_finalize` guarantees such rows carry NULL
origin), migration creates NO publication: it DELETES those Media's segment
rows (derived semantic-index copy the next publication regenerates) and
RETAINS their fragments with `transcript_publication_id` NULL so authored
content is not silently promoted to readable truth. Preflight counts these
unbound timed Fragments and aborts with exact ids if any Highlight references
one, because no current publication can supply the immutable transcript-time
anchor; the operator must repair or explicitly discard it before cutover.
Unhighlighted retained timed Fragments join the Tier-1 first-Keep/discard gate.
(3) Migration never silently deletes `fragments`, `highlights`, or an anchor
row. A readable state with missing
provenance or state/segment/Fragment disagreement also aborts for explicit
operator repair; no publication is guessed. Post-migration assertions: zero
unbound segment rows, zero timed Fragments without a publication where their
Media's transcript is readable (both residue-listed and in the A proof).

Migration creates generation-zero Timeline plus one current-head row for every
existing podcast/video. Podcast
duration backfills only from canonical episode metadata (advisory, never a
write or paid-ASR bound) with `duration_source=PodcastMetadataAdvisory`; video duration stays absent until the conforming probe on a
verified owned asset establishes it — `youtube_video_ingest` is NOT extended
to fetch provider `contentDetails` in this cut, so no provider-reported
duration ever binds a Timeline. The first publication transaction (and any
re-Keep publication) sets `media_timelines.duration_ms` from the conforming
probe in the same commit that inserts owned identity;
that write sets `duration_source=OwnedVideoProbe`;
`media_video_contents.duration_ms` must equal it exactly, and every wire
duration projects from the Timeline. Binding epoch starts at zero and no
video owned identity is inferred. Duration alone never proves content
identity.

Whole-Media teardown is hard-cut to cover video: the document-kinds teardown
owner (`_DOCUMENT_KINDS`, `delete_document_media_if_unreferenced`,
`_claim_document_media_teardown`) is renamed kind-agnostic and covers pdf,
epub, web_article, and video; `enumerate_media_storage_paths` unions every
`media_video_storage_objects.storage_path WHERE media_id = ...` (including
pre-publication failed/cancelled runs), every published/historical content
reference, and every reserved/in-flight `storage_object_cleanup_operations`
path reached through the exhaustive direct-Media, MediaTeardownPath,
published-UploadSession, or VideoCopyStorageObject -> storage-object -> Media
join before deleting
any owning row, so teardown cannot erase the only pointer to an orphan R2
object; re-Add
after teardown cannot resolve the torn-down row through the
reuse-by-canonical-URL branch. Teardown first inventories every stable domain
OperationRef capable of writing this Media and asks coordination to resolve and
ascending-lock its exact correlated queue set: copy and transcript source work,
transcript input preparation and semantic/reindex work, video-copy removal
cleanup, multipart abort/reconcile, caption and owned-ASR lifecycle, the
registry-classified content-reindex/enrichment/unit-build writers, storage cleanup/orphan
ownership, and teardown itself. It supersedes unclaimed producer work or requests exact
cancellation of claimed producers. An unresolved dead producer is not terminal
domain truth: copy/transcript suspension blocks child deletion until same-job
requeue settles it, and dispatch uncertainty blocks until the authenticated
resolver settles it. The deletion/cancel intent remains durable and wins after
repair: a recovered transcript result is reduced to its digest-only receipt and
never published; staged result-cue children/result are deleted in the same
terminal transaction. Teardown never deletes suspension, dispatch, or provider
evidence merely because the coordination job is `dead`. Cleanup/convergence work is different:
unclaimed removal/reconcile/storage cleanup is promoted, claimed cleanup is
awaited, and dead cleanup requires same-job repair; teardown never cancels the
sole owner that must prove object/upload absence. For each planned path it
creates or joins exactly one canonical `StorageObjectCleanup` operation and
inserts a path-bound teardown -> cleanup observer association plus the matching
coordination dependency; observer linkage never becomes a second cleanup owner.
An existing `VideoCopyStorageObject` reservation is activated in place, while an
existing Awaiting/claimed/dead cleanup retains its original owner and is
promoted/awaited/repaired. When no reusable operation exists, teardown creates a
fresh replay-stable operation whose sole owner is `MediaTeardownPath`. Terminal
`Retained` is historical keep-owner truth and is never reopened or transferred,
so teardown allocates a fresh generation. Terminal `Deleted` may satisfy the plan
only after a fresh no-new-writer/path-equality check proves its exact remote
fence still covers the complete writer set; otherwise teardown creates a fresh
generation. No operation ever has both video/Media and MediaTeardownPath owner
arms; no second live path deleter or copied checkpoint is created. It reschedules
until every producer has a terminal domain fact, exactly one cleanup owner has
converged through a provider-proven remote-write fence, and every multipart/
presigned-writer generation is fenced. Claimed/unclaimed cleanup-vs-teardown
barrier proofs assert one surviving owner and eventual DB/object convergence;
user deletion must not manufacture a dead-worker defect.

`YouTubeVideoCopyLifecycle` is also classified convergence work, never a writer
that teardown may cancel or a Media child it may delete directly. For every
current or historical content lifecycle, Prepare pre-resolves its schedule,
reserved cleanup, exact writer set, and existing-or-preallocated removal pair
before Media locks, inserts the exact
`MediaTeardown(intentId) -> YouTubeVideoCopyLifecycle(lifecycleOperationId)`
coordination dependency **and** its composite-FK
`media_teardown_video_compliance_dependencies` active association, and invokes
`WholeMediaTeardownAdoptVideoCompliance` under the already-declared gates. That
closed authority equality-joins an existing fence or atomically creates the
same typed Fence/realized non-admissible removal pair; teardown cannot create a
parallel deletion owner. It then promotes/awaits the root's typed ASR
Fence/Finalize, the already-realized removal, and its exact reserved generic
cleanup through physical absence and the root coordination receipt. A dead root
or child remains the same sealed ref and is requeued only through its typed
deadline repair before the current typed-allocation cutoff. When the root
settles, coordination's registered receipt-link observer runs after linking the
root coordination receipt and before the deletion-only root callback. In that
same settlement transaction it validates the content-free video compliance
receipt, inserts the receipt-backed
`media_teardown_video_compliance_settled_dependencies` row, and deletes the
active association; no committed prefix has both or neither. The settled row
retains the exact coordination edge/receipt and domain-receipt digest without a
restrictive FK to the deleted lifecycle. Teardown `ReadyToCommit` requires
exact plan equality against one active-or-settled typed association per planned
root and requires every member to be in the settled arm, in addition to every
path absence. Receipt-only truth without that typed conversion, a cross-Media/
cross-root receipt, or an extra root blocks readiness. Crash before/after adoption, an already-
fenced root, historical content, a dead root/removal/cleanup, and competing
product Remove prove one compliance set, active-to-settled conversion, and
eventual convergence.

Teardown itself is a three-phase durable operation, never a queue-payload
checkpoint. Prepare holds the owned `MediaTeardown(intentId)` claim, locks the
registry-derived ref set and Media, and inserts the complete immutable
`media_teardown_storage_paths` plan plus `cleanup_not_before`, creates/joins
each exact cleanup operation, conditionally creates a sole `MediaTeardownPath`
owner only for a new operation, and always inserts the typed observer/
coordination dependency before changing
the intent to `PathsPrepared`; replay requires exact plan equality. Media and
the restrictive intent FK remain live and every read stays hidden by intent.
Teardown performs no object DELETE, HEAD, or provider settlement. It promotes
the generic cleanup refs and, under its owned claim, inserts a plan-child
absence only after the exact cleanup is `Deleted` and the sole generic
`storage_object_cleanup_object_absences` row composite-FKs that same cleanup,
its complete writer fence, multipart settlement, sealed object-generation set,
and authenticated post-fence `HEAD NotFound`. The teardown absence FKs the
observer association and that generic fact; it neither performs HEAD nor copies
provider evidence. `ReadyToCommit` derives only from full plan coverage by those rows plus
terminal writer/ref truth. A local horizon or HEAD alone is never sufficient.
No DB owner/path row is deleted first. When every path is fenced absent and
every writer and video-compliance root is terminal, the finalizer invokes exactly one
`settle_terminal_operation_set({MediaTeardown(intentId), ...cleanupRefs,
...videoComplianceRootRefs},
transitions, callback, authority=WholeMediaTeardown(intentId))` over the
immutable complete plan set. The set primitive
pre-acquires parent and child settlement gates in canonical OperationRef order,
then every exact queue/correlation/domain lock. It requires every cleanup's
terminal `Deleted` fact and generic-absence/fence/settlement FKs, verifies the already-created exact
dependency `{ observing=MediaTeardown(intentId),
observed=StorageObjectCleanup(cleanupOperationId) }`, and links only its
`observed_terminal_receipt_id` to the cleanup coordination receipt. It also
requires exact-set equality over every receipt-backed typed video-compliance
dependency and verifies each composite-FK root coordination/domain receipt;
the generic edge alone or a receipt-only guessed member cannot satisfy this
set. Only then does it write the non-FK terminal teardown receipt and parent
domain terminal fact, write the parent
coordination receipt, and removes all child/parent correlations/jobs before any
domain deletion. Missing, additional, second-parent, or mismatched cleanup truth
  causes an all-or-nothing no-write retry. Its deletion-only callback follows the
  generated restrictive-FK topology for the **entire** compliance and cleanup
  graph. The required partial order is: domain associations first (settled
  teardown-video dependency before its generic coordination edge, video/
  teardown storage absences, removal completion/dependency/history, active and
  receipt-backed ASR members, realized-removal member); compliance fence set;
  current phase-wake head -> immutable registrations -> typed wake-sequence
  owner -> wake sequence -> live video schedule -> typed video capacity allocation -> neutral capacity
  allocation; video lifecycle; generic absence-generation members -> generic
  object absence -> multipart settlement; target completions -> typed Abort
  generation associations and observation members -> observations -> targets;
  remote-write fence; cleanup generation members, terminal results/write
  generations/producers in their generated child order; typed cleanup-owner arm
  -> cleanup operation; teardown observer/dependency/path rows -> intent; then
  removal/content/verification/storage-object and the remaining generated
  child-first Media inventory. Caption-initial/caption/owned-ASR/OAuth wake
  sequences and schedules likewise precede their typed then neutral allocations
  and lifecycle/reservation parents. The generated owner
  may refine independent siblings but may not reverse any named edge. All gates
  remain held. It never removes a cleanup/compliance parent while an absence,
  schedule, member, or historical removal row still references it. No nested child settlement or
  post-receipt lock acquisition occurs.
The receipt gives settlement and replay
a terminal predicate after the parent is gone without retaining a raw Media
id. `Voided | NoOp | Stale` use the same domain-receipt then coordination-
settlement boundary while leaving Media as their semantics require. Thus no
running OperationRef loses its parent, and no post-delete cleanup depends on a
restrictive Media FK. Migration strict-decodes every nonterminal/dead teardown
payload's checkpoint, path set, and cleanup deadline into these rows; missing,
duplicate, noncanonical, or owner-disagreeing paths abort. Prepare/cleanup-
transfer/adoption/fence/absence/final-set crash points—including every coordination
receipt, dependency link, job/correlation removal, and child/intent/domain
deletion—late presigned PUT, response loss, a competing observer/second parent,
and finalizer-vs-cleanup-settlement opposing order,
void/no-op/stale,
  and real-FK proofs—including an observed cleanup already referenced by video
  absence and completed-removal history, a live compliance schedule/capacity
  allocation, and the complete generic absence/multipart graph—cover
every boundary.

The predecessor's `DeletionCommitted` payload is the one migration exception:
old code could delete Media/intent before external object cleanup, so those
rows cannot be backfilled under restrictive FKs. Under maintenance the release
controller first shutdown-releases and proves zero running teardown claims.
For every pending/retryable/dead `DeletionCommitted` row with absent Media,
migration strict-decodes its exact canonical path set/deadline and, in one
coordination transaction, creates one neutral
`storage_object_cleanup_operations` plus exactly one FK-free
`storage_object_cleanup_legacy_teardown_owners` child per path, whose
domain-separated identity digest derives from the payload's legacy teardown
intent id,
`local_writer_quiescence_not_before = cleanupNotBefore` and
checkpoint `AwaitingDispatch`; their strict payload is only
`{ cleanupOperationId }` and their
`StorageObjectCleanup` correlations/jobs are created atomically. No
`MediaTeardown` correlation is ever manufactured for the parentless legacy
row. Only after every successor is durable does migration-owned coordination
terminalize the old queue row and write `TransferredToCleanup` (not `Deleted`). Dead defect
identity is preserved as a content-free digest. Each successor owns the remote
writer-set fence plus DELETE/HEAD until post-fence `HEAD NotFound`; only then is
it terminal/prunable. Empty paths
must be proved empty, never inferred. A running row at migration, malformed or
duplicate path, existing conflicting cleanup owner, or missing deadline aborts.
Pending/retryable/dead absent-Media fixtures plus crash after each successor/
correlation/predecessor transition prove idempotent resume and eventual object
absence. Post-cut invariants prove no correlation points to an absent domain
operation. The `LegacyTeardownSuccessor` resolver remains production-supported
until a later governed release proves zero operation/correlation/job rows and
then removes it; it is not deleted while migrated work can survive.

`services/media_deletion.py` exposes one kind-agnostic, owner-composed
child-first helper used by ordinary deletion, migration cleanup, and proof.
`services/media_deletion_fk_inventory.py` derives the restrictive Media-owned
FK graph from SQLAlchemy metadata, requires every edge to have one registered
owner helper, topologically orders the helpers, and fails on an unregistered
or cyclic edge; a pg-catalog equality proof prevents this prose from becoming
the sole inventory. The required order includes:

- Highlight anchor/edge children before Highlight roots; transcript segments
  and Fragments before publication, with locator FKs cleared through Highlight;
- each active transcript-reindex marker before its embedding vector/result/
  uncertainty/outcome/suspension children and intent; caption data-allocation
  staging cues before refresh-result/run/suspension/completion/lifecycle,
  publication association, and data allocation;
  owned-ASR lifecycle resolution/suspension children before its operation and
  companion; both before current publication head, segments/Fragments, and publication;
- transcript request audits through their retention owner, then dispatch/
  uncertainty/submission/terminal/suspension/settlement children before
  reservation, active marker, input-probe/preparation children, state, and work;
- content-reindex, metadata-enrichment, and media-unit-build active/outcome/
  dispatch/suspension children before their immutable operation (and summary
  head), with all exact OperationRefs already terminalized;
- asset and removal outcome/suspension children before the exact removal
  attempt, completion, and removal; content before verification; reconciliation
  active-plan/resolution/suspension/absence/verification/allocation children
  before plan, storage object, and reconciliation; copy suspension/cancel/
  binding children before source attempt;
- generic storage-cleanup suspension resolutions/suspensions before cleanup
  operation, and teardown suspension children plus immutable path plans before
  teardown intent in the final coordinated commit; and
- user title, owned identity, Podcast chapters, playback state, and Activity
  Timeline references before Timeline head/Timeline and finally Media.

Restricted caption/owned-ASR lifecycle rows are retention-bounded provider-data
owners and are deleted,
not retained as immutable audit, once their terminal correlation is closed;
the terminal operation is proven inside that transaction. Teardown terminal
receipts and user/day usage charges have no Media FK and survive this helper.
User/day-owned usage charges are not Media children and survive this
helper. Podcast chapter rows
are deleted through the chapter owner before their Timeline. Consumption-owned
playback-state and activity Timeline references
are removed through `delete_media_consumption_state_in_txn`; only then are the
Timeline head and `media_timelines` deleted. A real-FK proof runs this exact
helper child-first, asserts the generated order contains every named new table
(including both restricted publication-association/lifecycle families, caption
data-allocation staging cues,
active reindex, and publication head), and rejects any shadow
teardown implementation.

`services/user_deletion_fk_inventory.py` is the exhaustive user-root analogue
of the Media inventory. Generated SQLAlchemy metadata and an independent
`pg_catalog` query must produce the same ordered set of every restrictive,
CASCADE, and SET-NULL FK to `users.id`; each is registered exactly once as
`DeleteOwnedChild` or `TransformToContentFreeReceipt` with one child-first owner.
No FK survives by relying on database cascade, and no legal/audit carve-out may
retain a reusable user id: its owner must first write a purpose-bounded,
non-FK, content-free receipt and delete the user-linked row. Unknown edge,
cycle, unregistered table, nullable shortcut, or target/completion mismatch
blocks startup/migration/erasure. The real-Postgres proof seeds every existing
user edge—including Reader, Consumption, upload, billing, OAuth, sessions, and
operator-audit shapes—and compares generated plan, catalog, and post-delete
absence exactly.

The one-user deployment contract is explicit: account deletion is available
only when the release-proved human-user cardinality is exactly one, and its
Media plan contains every Media row; `created_by_user_id` is attribution, not
an ownership guess. A multi-user database fails this endpoint before mutation
until a separate sharing/ownership model exists. Authenticated
`DELETE /settings/account` requires CSRF, `Idempotency-Key`, a successful
existing-auth-owner reauthentication no older than five minutes, and strict
`{ confirmation: "DELETE MY ACCOUNT" }`. It returns the same `Deleting`
projection for an admitted replay, immediately removes ordinary mutation
capabilities, and preserves only the erasure-status/session path until the user
row and sessions are deleted. Wrong text, stale reauth, or unsupported
cardinality performs no write.

Account erasure has a separate durable fail-closed barrier because OAuth
credentials and account charges are not Media children. The request creates
`UserAccountErasure(erasureOperationId)` as `AwaitingDispatch`; its Light
`user_account_erasure` JobDefinition uses strict payload
`{ erasureOperationId }`, `max_attempts=8`,
`retry_delays_seconds=(5,15,60,300,900,1800,3600,3600)`,
`resource_class=Light`, `lease_seconds=60`,
`heartbeat_interval_seconds=5`, `wall_timeout_seconds=900`,
`never_prune_dead=True`, account discovery, and startup reconciliation. The
request may take the account gate before queue admission only to create the
neutral `AwaitingDispatch` row. Every worker phase thereafter enters through
`with_owned_operation_claim(UserAccountErasure(...))`, locking queue/
correlation first and only then the account gate/domain rows. Phase one changes
`AwaitingDispatch -> PlanReady` only in the same transaction that deletes
active authorization markers, blocks new start/callback/select/refresh and
Media/embedding admission, and persists the complete immutable exact account-
OperationRef, every-Media, and generated user-FK logical target plan. Before it
seals that plan, it creates/joins every deterministic terminal sink required by
current state—especially exactly one `CredentialRevocation` ref per credential—
and inserts the allowed predecessor -> sink edges. Exchange under erasure routes
an obtained credential directly to that sink; it never creates a selectable
pending connection. In that same transaction the planner canonicalizes each
independently mutated physical resource set into one disposition, maps every
logical target to one or more dispositions, inserts one root-member row for
every initial/sink account-ref target, and writes the root-plan seal over those
durable members, physical-resource identities, and both complete root sets.

A physical disposition has a nonempty exact target set and exactly one typed
owner child; that child derives the owner kind, so no parallel kind
discriminator can drift. Owner selection follows the actor that performs the
terminal physical mutation, not the transient operation that happened to
discover it: credential/secret resources belong to their preplanned revocation
leaf; exchange/pending/binding-local rows belong to their exact operation;
Media belongs to its teardown; only remaining generated rows use the registered
user-FK owner. Thus a predecessor may transfer authority but can never delete a
successor-owned resource. Two logical targets that reach the same OAuth, Media,
credential, restricted-data, billing, or audit resource map to the same
physical disposition, never competing owners; one logical OperationRef target
may map to several dispositions when it owns several independently mutated
resources.

Every neutral coverage row has exactly one typed AccountRef/Media/UserFk target
child through same-erasure composite FKs. Every logical target has at least one
typed coverage child, and each target/disposition pair appears exactly once;
zero or multiple typed arms, duplicate pair, cross-erasure, uncovered,
orphaned, or empty-disposition coverage aborts the transaction. The initial
account-ref digest is recomputed only from root-member rows, never from the
later-growing target table. Every account-ref target is either a root member or
is reachable through the same-erasure successor DAG (both is legal when an
existing root is reused as a successor); an unreachable target is a defect. All
direct target-creating admissions are already fenced; a partial root plan never
becomes visible and replay requires exact seal/member/target/physical-resource/
disposition/typed-coverage equality. The ranked successor-edge owner may later
append/reuse only a deterministic target whose physical resources are already
in the sealed plan; it atomically adds exact coverage before exposing the edge.
Discovery of a new resource aborts for audited replan rather than silently
expanding the immutable physical plan. The closure seal freezes the complete
target/edge/coverage set without mutating an earlier row.
Account discovery excludes
only the exact currently owned `UserAccountErasure(erasureOperationId)` ref;
it never excludes the kind globally, so any stale prior erasure is a defect.
The next owned transaction changes `PlanReady -> Executing` only after that
equality check, then releases the account gate and claim locks. `Executing`
derives remaining work exclusively from physical-disposition-minus-completion
coverage; logical target completions are evidence emitted by that one mutation
owner, never independent permission to mutate. No mutable cursor exists.

Phase two never holds a user/OAuth gate across a Media lock or external I/O. It
drives each unfinished physical disposition through its one registered owner.
An account-operation disposition uses ordinary coordination: code exchange is
resolved/expired without resubmitting an armed call; each pending/binding
credential is transferred to its preplanned revocation leaf; and that leaf's
secret deletion reaches verified
live-Postgres hold/material absence (remote revoke may end `RemoteUnconfirmed`) before credential facts
disappear. Any transition that joins a successor ref atomically
reuses its same-erasure target plus the prevalidated predecessor->successor edge before
marking the predecessor `Transferred`; every Transferred completion requires
at least one edge. Multiple predecessors may converge on the same successor,
but no edge may cross erasure operations. The append owner enforces this closed
strict-rank DAG: `OAuthExchange -> PendingExpiry | CredentialRevocation` and
`PendingExpiry | BindingLifecycle -> CredentialRevocation`; revocation has no
successor, while `AuthorizationAttemptExpiry` is always a terminal `Erased`
leaf because callback replay ownership is independent of exchange. Self,
same-rank, backward, unknown-kind, duplicate-conflicting, and
cycle-forming edges are rejected before either completion. A target may be
`Transferred` only when its allowed successor target+edge is durable, and
closure is complete only when every reachable leaf has a terminal completion.
Readiness is the transitive closure,
not only the initial snapshot. Transfers never swap a disposition owner: the
actual physical leaf owner was sealed before execution. A Media disposition invokes its one planned
Media teardown in ascending Media order through a fresh Media gate. Teardown
completion writes the content-free Media completion and disposition completion
in the same final Media transaction; the non-Media-FK plan target remains only
until account closure so its typed disposition owner and completion stay
relationally provable after Media is gone;
missing/already-deleted Media requires the preexisting exact teardown receipt,
not inference. Staged ASR/caption data and embedding vectors are included in
the child-first inventories, while immutable account charge/audit rows follow
their explicit retention owner. For every disposition, only its typed owner may
perform the physical mutation; that transaction writes completion generation
one and its head, whose digest covers the exact already-terminal mapped logical
completion set and whose immutable physical-resource/mutation receipt proves
the one mutation. A logical completion is written by its own operation
transition (`Terminalized | Transferred`) or typed Media/user-FK owner; it does
not independently authorize a physical mutation, and closure additionally
requires every disposition in that target's coverage to be complete. The generic user-FK
inventory never separately invokes a row covered by an account-operation or
Media disposition. A registered user-FK disposition invokes its child-first
owner once and writes `Deleted | Transformed` for each mapped logical target
whose complete covered resource set is then terminal; a crash resumes the
disposition set difference. A
successor target that maps to an already completed physical disposition may be
completed without a second mutation only when the immutable current physical-
mutation receipt, physical-resource identity, and typed owner prove the same terminal row. Its transaction
writes the new logical completion, appends completion generation N+1 with the
same mutation-receipt digest and expanded exact completion-set digest, and
CAS-swaps the completion head; it never edits a prior seal. A receipt mismatch
is a defect. Once fresh account discovery is empty and every immutable
account/Media/user-FK target has exactly one valid completion and every
physical disposition has exactly one current head whose completion-set digest
equals its final coverage (historical generations may remain), one owned
transaction changes `Executing -> ReadyToCommit`. Any uncovered, duplicate, or
newly discovered direct Media/user-FK row leaves it Executing as an admission-
barrier defect; only a successor OperationRef may extend the plan through the
ranked append owner, and the sealed root targets are never edited. That
  transition inserts the immutable closure seal over the same-erasure root
  membership digest, complete successor DAG and reachability partition, logical target/completion set, physical-
disposition/completion set, coverage equality, and fresh-empty discovery
digest.

Only from `ReadyToCommit`, with that exact closure seal, after every
root/successor target has one completion and every physical disposition's
current completion head exactly covers its mapped targets, fresh account
discovery is empty except the exact erasure self-ref, every OAuth/channel/
credential/encrypted material and Media/restrictive user FK is absent, and user-owned charges/
audits due for erasure have settled does phase three enter one final
`settle_terminal_operation(UserAccountErasure(erasureOperationId),
readyToCommitClosureProof, callback)` as the exact current worker/attempt. The
primitive takes the account gate after its settlement/queue/correlation locks
and revalidates every closure predicate. Its registered terminal transition
  writes the content-free erasure receipt with exact counts (including physical
  dispositions) before the coordination receipt. Its deletion-only callback then
  follows the generated restrictive-FK topology exactly: closure seal; physical
  completion heads then their immutable generations; typed disposition-owner
  arms; typed coverage arms then neutral coverage; logical completions; root
  memberships and successor edges; physical dispositions; logical targets; root
  plan; erasure operation; and only then every remaining generated session/user
  child before the user. The catalog oracle proves that order against real FKs,
  including same-erasure cross-disposition owner/coverage substitution. The
  transition, callback, and coordination receipt
commit or roll back together; the erasure receipt is the post-user terminal
resolver. Unexpected death
records an occurrence and same-ref repair. Proofs seed Pending and Binding at
plan time and kill after deterministic leaf creation, each Exchange ->
PendingExpiry -> Revocation and Binding -> Revocation transfer, leaf revocation,
each ciphertext/hold deletion, physical completion, coordination receipt/
dependency/job/correlation removal, user deletion, and erasure receipt; seed
self plus pending/dead OAuth refs and assert exact
self-exclusion/closure. They race finalization against callback/expiry/
revocation claim, lifecycle refresh, semantic result recovery, operator
resolver, and dead repair in opposing order and prove no lock cycle, orphan
secret/plaintext, lost charge, cross-user/cross-erasure FK, or double mutation.
Fixtures deliberately overlap one credential/revocation, one restricted
publication, one Media, and one retained charge between domain targets and the
  generic user-FK inventory and assert one physical owner, one mutation, complete
  logical receipts, and exact closure. Real-FK fixtures reject every cross-
  erasure owner/coverage pairing and multiple typed owner or target arms; root-
  membership fixtures cover an initial target reused as a successor, a new
  successor, a missing root member, and an unreachable account-ref target.

Every new Podcast/video Media creation path calls the one Timeline owner in the
same transaction. Playback-state writes carry the expected sealed
`timelineHandle`; a stale/mismatched Timeline is rejected before the existing
revision CAS.

Migration A also renames every dependent constraint and index of the renamed
tables to the new vocabulary, and the A proof asserts zero pg_catalog objects
matching the old names. The complete list of constraints this migration
rewrites or drops, by catalog name, is part of the A proof's upgraded-catalog
oracle: `ck_media_source_attempts_source_type` and
`ck_media_source_attempts_status` (dropped, vocabulary moves to application
owners), `ck_media_transcript_states_state` / `_coverage` (dropped),
`ix_media_transcript_states_semantic_repair` (dropped),
`ck_highlights_anchor_kind_valid` / `ck_highlights_anchor_fields_paired_null`
(dropped), and the segment/fragment constraint set named above.

Do not overload `media_file`, `media.processing_status`, attempt JSON, or a
transcript fragment as an owned-video publication.

## Capability and API contract

`GET /media/{id}` exposes four strict projections. It deletes the loose
nullable `transcript_state`/`transcript_coverage` fields, folds the existing
`Presence<TranscriptOrigin>` field into the transcript publication's strict
provenance union, deletes
`listening_state` and `episode_state` (position/completion reach clients only
through `GET /playback-state` and the existing `ConsumptionOut`), and moves
`chapters` under the `timeline` projection. The four projections are nested
models configured `alias_generator=to_camel, populate_by_name=True,
extra='forbid'`, serialized `by_alias=True` — the camel island the
Consumption family already established; `MediaOut`'s legacy snake fields are
otherwise unchanged.

```text
timeline: Present { timelineHandle, durationMs: Presence<int>,
                    openSourceUrl: Presence<string> } | Absent
  # timelineHandle appears here exactly once; every timed writer sends this
  # handle. openSourceUrl is the provenance Open-source target (absent when
  # none), so OwnedVideo playback also has one.

videoCopy:
  Unsupported
  | NotKept {
      keep: Keepable { progressReset: NotRequired | AcknowledgementRequired }
            | Blocked { reason: TimelineUnproven }
    }
  | Queued { copyHandle }                    # Cancel implied by the arm
  | Keeping { copyHandle, progress: Presence<VideoCopyProgress> }
  | Cancelling
  | Kept { verifiedAt, sizeBytes, approvalExpiresAt,
           remove: Removable | Blocked { reason: TranscriptInProgress } }
  | Failed { failure: VideoCopyFailure,
             retry: Retriable | Blocked { reason: TimelineUnproven } }
  | Suspended                              # unexpected dead job; operator-owned
  | Removing
  | RemovalFailed { failure: RemovalFailure }
  | RemovalSuspended

playback:
  Unavailable { reason: PlaybackUnavailableReason }
  | ExternalAudio { streamUrl }
  | ExternalYouTubeVideo { providerVideoId, watchUrl }
  | OwnedVideo { assetHandle, contentType, sizeBytes, width, height }

transcript:
  Unsupported
  | Supported {
      publication: Absent | Present {
        publicationHandle,
        provenance: PublisherProvided
                    | Imported { provider: Presence<string> }
                    | YouTubeCaption { kind: Manual | Automatic }
                    | Machine {
                        producer: ThirdParty | Nexus,
                        provider: Presence<string>,
                        modelId: Presence<string>
                      },
        language: Presence<string>
        access:
          Readable {
            policy: Ordinary | RestrictedYouTubeCaption |
                    RestrictedYouTubeOwnedAsr,
            removalDeadline: Presence<instant>
          }
          | RestrictedUnavailable {
              reason: ApprovalExpired | BindingInactive | LifecycleExpired |
                      AuthorizerMismatch | PlaintextResidualNotApproved
            }
      },
      operation:
        Idle {
          action: NoAction
                  | Requestable { intent: Transcribe | ReplaceWithNexus }
                  | Blocked { reason: TranscriptBlockReason }
        }
        | PreparingInput {
            inputPreparationHandle,
            progress: Presence<Fetch { bytesDone,
                                       totalBytes: Presence<int> } | Probe>
          }
        | CancellingInput { inputPreparationHandle }
        | InputVerificationFailed {
            inputPreparationFailureHandle,
            failure: Dependency { recovery: Retry }
                     | SourceUnsafe { recovery: None }
                     | SourceUnavailable { recovery: None }
                     | Format { recovery: None }
                     | SizeLimit { recovery: None }
                     | DurationLimit { recovery: None }
          }
        | Queued { transcriptWorkHandle }
        | Running { transcriptWorkHandle }
        | Cancelling { transcriptWorkHandle }
        | QuotaBlocked { requiredMinutes,
                         remainingMinutes: int }
        | Failed { failureHandle, failure: TypedFailure }
        | Suspended
        | Unavailable { reason: TranscriptUnavailableReason }
    }
```

Every reason union is closed in v1 and decoded with no default branch on
either side of the wire (residue-gated):

- `TimelineUnproven` is the only `NotKept` block reason. Progress reset is a
  structural `Keepable` arm, and active copy/removal have their own top-level
  states, so unreachable duplicate reasons cannot drift. `TranscriptInProgress`
  is the sole remove block reason. `Unsupported` covers only ineligible kind,
  provider, or permission.
- `PlaybackUnavailableReason = CopyBinding | KeptCopyRemoved |
  NoPlayableSource | UnsupportedProvider` — bodies **Playback is paused while
  Nexus keeps a copy.** / **The kept copy was removed. You can still open the
  source.** / **This item has no playable source.** / provider not canonical
  YouTube (copy projection `Unsupported`, **Open source** the only action).
  A `video` Media whose provider identity is not a supported YouTube VOD
  resolves to `UnsupportedProvider` — the non-YouTube `external_video`
  fallback in `playback_source.py` is deleted, not carried forward.
- Per-session `YouTubeEngineFailure = ProviderPolicyUnknown |
  ProviderClientIdentityInvalid | ActivationDecisionExpired |
  MediaIntegrityUnavailable | ProviderScriptUnavailable |
  ProviderInitializationTimeout | UntrackedProfileArtifactMismatch |
  UntrackedEmbedProfileUnsupportedHost |
  UntrackedOwnedProfileUnsupportedHost |
  InvalidVideoParameter |
  Html5PlaybackError | VideoUnavailable | EmbedNotAllowed |
  ProviderProtocolUnknown | ObservationAuthorizationExpired |
  PauseUnconfirmed`. It is local to
  `{playerSessionId, hostKind}` and
  never written into durable Media playback truth: one Android identity defect
  cannot poison browser playback. Rendering is an exhaustive arm-to-copy/action
  map with no generic fallback: `ProviderPolicyUnknown` -> **Nexus couldn’t
  verify the playback policy for this video.** / Retry;
  `ProviderClientIdentityInvalid` -> **This Nexus app isn’t configured to play
  YouTube videos.** / no Retry; `ActivationDecisionExpired` -> **The YouTube
  playback check expired.** / Retry; `MediaIntegrityUnavailable` -> **This
  Android build can’t prove its identity to YouTube. Update Nexus for Android.**
  / no Retry; `ProviderScriptUnavailable` -> **Nexus couldn’t load the YouTube
  player.** / Retry; `ProviderInitializationTimeout` -> **The YouTube player
  didn’t become ready.** / Retry with fresh authorization;
  `UntrackedProfileArtifactMismatch` -> **Nexus can’t safely open this YouTube
  video here.** / Open source, no Retry until this release is repaired;
  `UntrackedEmbedProfileUnsupportedHost` -> the same safe-open copy/action
  when this exact browser/WebView version is outside the certified raw-embed
  matrix; `UntrackedOwnedProfileUnsupportedHost` -> the same safe-open
  copy/action when this exact host is outside the certified native-control
  matrix;
  `InvalidVideoParameter` -> **Nexus couldn’t open this
  YouTube video safely.** / Open source; `Html5PlaybackError` -> **YouTube
  couldn’t play this video here.** / Retry with fresh authorization;
  `VideoUnavailable` -> **This YouTube video is no longer available.** / Open
  source; `EmbedNotAllowed` -> **The video owner doesn’t allow this video to
  play here.** / Open source; `ProviderProtocolUnknown` -> **Nexus stopped the
  player because YouTube returned an unknown state.** / Open source;
  `ObservationAuthorizationExpired` -> **Nexus couldn’t renew the YouTube
  playback check.** / Retry; `PauseUnconfirmed` -> **Nexus closed the YouTube
  player because it couldn’t confirm playback stopped.** / Retry. Identity/integrity are non-retryable for
  that host/release and block device acceptance. Type checking plus a focused
  render proof enumerates all arms; no generic `Failed` arm invents Retry.
- `TranscriptBlockReason = BillingRequired | SourceRequired | TimelineBinding |
  DurationUnknown` — `BillingRequired` renders **Transcription is included
  with AI plans** + Review billing (`E_BILLING_REQUIRED` is projected, never
  thrown from the read path); `TimelineBinding` renders the binding pause line;
  `SourceRequired` renders **Keep a copy to transcribe this video** from
  current copy/source facts and supplies the Keep action;
  `DurationUnknown` renders **Nexus needs to verify this episode’s length before
  it can quote transcription time.** + **Verify episode length…** for Podcast;
  video retains **Nexus needs the item’s length before it can transcribe it.**
- `TranscriptUnavailableReason = NoProviderTranscript` only. Unsupported kind
  is the top-level `Unsupported` arm. `NoProviderTranscript` is terminal only
  for that exact check attempt. **Check again** starts the ordinary fresh
  forecast -> `POST /media/{id}/transcript/request` flow with a new
  `Idempotency-Key`; request admission explicitly accepts the exact
  `Unavailable { NoProviderTranscript }` operation. It is not a second route,
  worker kind, or hidden automatic retry.
  A later kept copy or newly eligible source makes the read projection
  `Idle/Requestable` and leaves the historical outcome only in audit, so a
  stale `SourceRequired`/unavailable result can never mask new capability.
- One shared `TypedFailure { code, recovery: Retry | CheckAgain |
  TranscribeWithNexus | OpenSource | KeepCopy | RemoveCopy | ReviewBilling |
  None }` populates `transcript.Failed`, with `code` closed
  to the error-code table below.

Database UUIDs remain private. `TimelineHandle` seals private Timeline
identity plus `binding_epoch`: a payload-carrying variant of
`_EntityHandleSpec` in `services/sealed_handles.py` with wire grammar
`nmt1.{b64url(uuid16 || be-uint64 epoch)}.{b64url(tag16)}`, with the high bit
required to be zero so the wire and signed Postgres `BIGINT` domain are the
same non-negative int64 set, exposing
`seal_media_timeline(timeline_id, binding_epoch)` and
`unseal_media_timeline(raw) -> (UUID, int)`. `VideoCopyHandle`,
`VideoAssetHandle`, `TranscriptPublicationHandle`, and
`TranscriptWorkHandle`/`TranscriptFailureHandle`,
`TranscriptInputPreparationHandle`, `TranscriptInputPreparationFailureHandle`,
and `TranscriptInputProbeHandle` are ordinary
single-UUID `_EntityHandleSpec` entries with distinct prefixes and domains.
`YouTubeOAuthPendingHandle` and `YouTubeOAuthPendingChannelHandle` are separate
expiring sealed types, never aliases of an entity handle. Their exact grammars
are `nyop1.{b64url(pendingUuid16 || be-int64 expiryMs || uint8 keyVersion)}.{b64url(tag16)}`
and
`nyoc1.{b64url(pendingUuid16 || channelRowUuid16 || be-int64 expiryMs || uint8 keyVersion)}.{b64url(tag16)}`.
The MAC domains, prefixes, payload lengths, and parsers are distinct; canonical
unpadded base64url, nonnegative millisecond expiry, known verification key, and
no trailing bytes are mandatory. The channel handle therefore cannot be moved
to another pending connection even if both belong to the same user. The server
still locks/rechecks pending ownership, current approval, expiry, child row,
and unused state: these handles identify a bounded choice but do not authorize.
Property proofs cover cross-type, cross-pending, stale, bit-flipped, noncanonical,
unknown-version, and key-rotation cases without exposing a raw provider id.
OAuth `state` itself is a deterministic sealed capability with grammar
`nys1.{b64url(attemptUuid16 || uint8 keyVersion)}.{b64url(tag32)}` and a
separate `nexus.youtube.oauth.state` MAC domain. It contains no user, redirect,
or secret bytes; callback unseals the attempt, equality-checks the stored state
SHA-256, and reauthorizes its immutable user/host/client/redirect/expiry facts.
The retained signing version lets an idempotent Start replay reconstruct the
exact same state and authorization Location after response loss without storing
raw state. The verification key remains available through attempt plus replay-
tombstone retention. Noncanonical/cross-attempt/expired/key-rotation proofs
cover desktop browser and Android Custom Tab using the identical Browser flow;
state never authorizes past those DB checks.
Browser callback binding uses a distinct deterministic sealed cookie
capability,
`nyob1.{b64url(attemptUuid16 || uint8 keyVersion)}.{b64url(tag32)}`, under
`nexus.youtube.oauth.browser-cookie`. Start stores its digest/version and emits
the fixed `__Host-nexus-youtube-oauth` cookie with `Secure; HttpOnly;
SameSite=Lax; Path=/; Max-Age=600` and no `Domain`; same-attempt response replay
reissues exactly that value. First callback requires the ordinary authenticated
Nexus session, its stored session-binding digest, exact cookie MAC/digest, and
state-attempt equality, then expires only this OAuth cookie with the same
attributes. Tombstone replay is side-effect-free and requires the retained
authenticated user/tombstone, not a consumed cookie. Lost response, fixation,
cross-session, wrong attempt, replay, expiry, clearing, and key rotation are
exact browser proofs; the ordinary Nexus session cookie is never cleared. The
same contract applies in Android's system Custom Tab. Nexus deliberately has no
Android-specific OAuth state/callback arm, native token exchange, integrity-
attestation client, app-install identity, or caller-selected host downgrade.
`TranscriptForecastHandle` is a 15-minute sealed canonical-JSON decision
token with no raw database id: it contains the outward `timelineHandle`,
viewer/account policy version, the exact closed intent, its required
`failureHandle | publicationHandle` correlation, a Podcast
`inputProbeHandle` plus input SHA/duration/expiry when hosted input is possible,
ordered source plan, budget-policy arm, and maximum reservable minutes. Its MAC covers every byte; it is evidence of what
was shown, never authorization or a reservation.
Every handle's MAC input is domain-separated per type and covers every field
the wire string carries, so a modified epoch or a handle replayed at a
different endpoint fails verification. Handlers unseal to recover identity
and the epoch fence, then authorize the request from the viewer and re-read
row currency from the database inside the gateway transaction — handles
identify but never authorize. `copyHandle` is only the exact
active-generation fence needed for cancellation, never a raw attempt ID.

`CanonicalProviderDisplayLabel` has one server ingress owner for pending,
binding-snapshot, and refresh-result labels: reject Unicode `Cc`, `Zl`, `Zp`,
and `Bidi_Control`; NFC-normalize; map every Unicode White_Space run to U+0020;
trim; then require 1..200 scalars and at most 800 UTF-8 bytes. Provider channel
enumeration requests `maxResults=50`, permits at most 10 fully authenticated
pages, 50 total eligible channels, and 1 MiB aggregate response bytes; a token
past either bound, duplicate channel id, invalid label, or unknown response
field transfers the credential to revocation with
`ChannelSetUnbounded | ChannelMetadataInvalid`. Frozen pending allocation associations sort by
normalized label and then raw channel id as ascending UTF-8 bytes. Equal labels
project `duplicate: Present<{ ordinal, total }>` (otherwise Absent), where the
ordinal is over that frozen stable order. Duplicate options visibly render
**{label} — channel {ordinal} of {total}** and use **{label}, channel {ordinal}
of {total}** as the accessible name; unique labels render only the label. The
selected binding's immutable per-channel allocation retains that bounded
Presence child and both Settings
and `Connected` render the same visible disambiguator, so a sighted user never
sees two indistinguishable choices or loses which one was selected. The raw id remains server-only and
every label renders as text in `<bdi dir="auto">`.

Resolution is deterministic: a current verified asset yields `OwnedVideo`; an
unbound Timeline may yield a valid external arm; an active first binding yields
`Unavailable { reason=CopyBinding }`; a bound Timeline without its asset yields
`Unavailable { reason=KeptCopyRemoved }` plus Open source. Failure never changes
source inside an active session, and owned identity never auto-falls back to the
provider. Local YouTube activation failure leaves the durable arm
`ExternalYouTubeVideo` and renders only the corresponding session
failure/recovery. Policy, expiry, integrity, and script failures construct no
iframe; error 153 can arise only after construction, so the adapter
immediately pauses/destroys that attempted iframe, records no player-derived
fact, and leaves no active provider node.

`VideoCopyProgress` is the strict wire union
`Stage { kind: "Stage", runCount: int>=1, stage: CopyStage } |
Bytes { kind: "Bytes", runCount: int>=1, stage: Download | Upload | Verify,
completedBytes: int64, totalBytes: int64 }`, with no extra keys.
`CopyStage = Resolve | Download | Package | Probe | Upload | Verify |
Finalize` in exactly that order (`Probe` = local ffprobe/conformance/hash;
`Verify` = post-upload integrity confirmation). `Bytes` requires
`0 <= completedBytes <= totalBytes`, `totalBytes > 0`; within one run/stage its
total is immutable and completed bytes never decrease. The fenced owner
accepts only lexicographically advancing `(runCount, stageOrdinal,
completedBytes)`; a new run may reset stage/bytes only after the same
lease-fenced `run_count` increment described below, and stale runs write
nothing. Byte totals appear only from a real stable source total, exact
packaged upload size, or exact readback size—never an estimate. A stage without
such a total uses `Stage`, not zero/null/sentinel bytes. Copy progress persists
in the supplemental attempt's widened `processing_stage`/`progress_*` columns
under the one copy decoder and every update uses the owned-claim fence. UI
renders **{done} of {total}** only inside the named stage, never a cross-stage
percentage or ETA. Decoder/property/lease-loss/crash proofs cover invalid
bounds, total drift, stage/run regression, stale update, and replay.

HTTP `ApiErrorCode`, durable worker `VideoCopyFailureCode`, and durable worker
`TranscriptFailureCode` are separate closed enums. A worker-only code is never
added to an HTTP status map merely to satisfy a registry; every persisted code
has one exhaustive supervisor-to-domain-attempt mapping, and unknown trusted
data is a defect.

| Code | Status | Raised by | Retry | Projects |
| --- | --- | --- | --- | --- |
| `E_MEDIA_TIMELINE_UNPROVEN` | 409 | Keep admission | no | `Blocked { TimelineUnproven }` |
| `E_MEDIA_TIMELINE_BINDING` | 409 | direct timed commands during binding | after settle | binding pause |
| `E_MEDIA_TIMELINE_STALE` | 409 | stale handle before the revision CAS | fresh handle | session dismissal |
| `E_MEDIA_TIMELINE_BUSY` | 409 | discard while an asset, incomplete removal, or content-bound writer/suspension exists | remove/settle/repair first | current lifecycle state |
| `E_VIDEO_COMPLIANCE_CAPACITY` | 409 | Keep schedule placement cannot reserve one of the two video lanes before the approval deadline | remove and physically settle another kept copy | `Blocked { ComplianceCapacity }` |
| `E_YOUTUBE_OAUTH_COMPLIANCE_CAPACITY` | 409 | OAuth Start cannot preserve one new-root plus four-successor headroom on the reserved OAuth lane | wait for prior replay-expiry/convergence refs to settle, then explicitly Try again | `Disconnected { connect: Blocked { ComplianceCapacity } }` |
| `E_VIDEO_COPY_REMOVE_BLOCKED` | 409 | Remove while transcript work is nonterminal | cancel/settle transcript | `Blocked { TranscriptInProgress }` |
| `E_TRANSCRIPT_FORECAST_CHANGED` | 409 | request recomputation differs from confirmed forecast | confirm fresh forecast | no work/reservation |
| `E_TRANSCRIPT_PUBLICATION_STALE` | 409 | cue read handle is no longer the current publication | refresh Media projection | no stale cue install |
| `E_TRANSCRIPT_SOURCE_REQUIRED` | — | exact transcript check attempt, never queue-retried | Keep copy or later Check again | current-fact `Idle { Blocked { SourceRequired } }` |
| `E_TRANSCRIPT_INPUT_DEPENDENCY` | — | Podcast input fetch bounded dependency/retry exhaustion | fresh input-preparation command with a new key | `InputVerificationFailed { Dependency { recovery: Retry } }` |
| `E_TRANSCRIPT_INPUT_SOURCE_UNSAFE` | — | Podcast URL/DNS/peer/redirect/gateway policy rejection | no; wait for a changed feed source | `InputVerificationFailed { SourceUnsafe { recovery: None } }` |
| `E_TRANSCRIPT_INPUT_SOURCE_UNAVAILABLE` | — | closed nonretryable Podcast origin response | no; wait for a changed feed source | `InputVerificationFailed { SourceUnavailable { recovery: None } }` |
| `E_TRANSCRIPT_INPUT_FORMAT` | — | bounded response/media/demux/codec/timestamp rejection | no | `InputVerificationFailed { Format { recovery: None } }` |
| `E_TRANSCRIPT_INPUT_SIZE_LIMIT` | — | exact byte fence exceeded | no | `InputVerificationFailed { SizeLimit { recovery: None } }` |
| `E_TRANSCRIPT_INPUT_DURATION_LIMIT` | — | exact probed duration exceeds four hours | no | `InputVerificationFailed { DurationLimit { recovery: None } }` |
| `E_TRANSCRIPT_CUES_OVERLAP` | — | normalized source cannot form bounded nonoverlapping cues | explicit hosted-only confirmation only when failed source was free and a current authorized hosted-ASR input exists; otherwise recheck free source or none for HostedAsr | `Failed { failure: { code: E_TRANSCRIPT_CUES_OVERLAP, recovery: TranscribeWithNexus \| CheckAgain \| None } }` with valid combination derived from immutable `source_kind` + current input facts |
| `E_TRANSCRIPT_CAPTION_METADATA_UNPROVEN` | — | official caption metadata cannot prove manual/generated provenance | no automatic paid fallback; explicit hosted-only confirmation if a current authorized hosted-ASR input exists, otherwise recheck | `Failed { failure: { code: E_TRANSCRIPT_CAPTION_METADATA_UNPROVEN, recovery: TranscribeWithNexus \| CheckAgain } }` from current input facts |
| `E_TRANSCRIPT_SOURCE_DEPENDENCY` | — | sidecar/caption network, quota, or closed retryable provider response | user Retry; no paid fallback in this work | `Failed { failure: { code: E_TRANSCRIPT_SOURCE_DEPENDENCY, recovery: Retry } }` |
| `E_TRANSCRIPT_SOURCE_INVALID` | — | invalid content type/UTF-8/language/control data or aggregate/source-segment limit | no automatic paid fallback; explicit hosted-only confirmation for a failed free source when a current authorized hosted-ASR input exists | `Failed { failure: { code: E_TRANSCRIPT_SOURCE_INVALID, recovery: TranscribeWithNexus \| CheckAgain \| None } }` from immutable `source_kind` + current input facts |
| `E_TRANSCRIPT_OWNED_ASSET_READ` | — | transient ranged-read/storage dependency failure before provider dispatch | user Retry | `Failed { failure: { code: E_TRANSCRIPT_OWNED_ASSET_READ, recovery: Retry } }` |
| `E_TRANSCRIPT_OWNED_ASSET_INTEGRITY` | — | definitive object absence, hash mismatch, or asset/content disagreement | remove the broken copy; no Retry | `Failed { failure: { code: E_TRANSCRIPT_OWNED_ASSET_INTEGRITY, recovery: RemoveCopy } }` |
| `E_TRANSCRIPT_PROVIDER_UNAVAILABLE` | — | closed transient hosted-provider/network response | user Retry | `Failed { failure: { code: E_TRANSCRIPT_PROVIDER_UNAVAILABLE, recovery: Retry } }` |
| `E_TRANSCRIPT_PROVIDER_PROFILE_UNSUPPORTED` | — | pinned provider response cannot satisfy the required transcript profile/diarization contract | no | `Failed { failure: { code: E_TRANSCRIPT_PROVIDER_PROFILE_UNSUPPORTED, recovery: None } }` |
| `E_TRANSCRIPT_WALL_TIMEOUT` / `E_TRANSCRIPT_MEMORY_LIMIT` | — | transcript supervisor resource envelope | user Retry | `Failed { failure: { code: exact resource code, recovery: Retry } }` |
| `E_TRANSCRIPT_PROVIDER_OUTCOME_UNKNOWN` | — | operator resolves an ambiguous non-idempotent provider dispatch with no recoverable result | explicit new work after audited resolution | `Failed { failure: { code: E_TRANSCRIPT_PROVIDER_OUTCOME_UNKNOWN, recovery: Retry } }` |
| `E_VIDEO_COPY_SOURCE_INELIGIBLE` | — | worker (durable attempt code) | no | `Permanent { SourceIneligible }` |
| `E_VIDEO_SOURCE_METADATA_UNAVAILABLE` | — | worker (durable attempt code) | no | `Permanent { SourceMetadataUnavailable }` |
| `E_VIDEO_PROFILE_UNAVAILABLE` | — | worker (durable attempt code) | no | `Permanent { ProfileUnavailable }` |
| `E_VIDEO_TIMELINE_UNSUPPORTED` | — | worker (durable attempt code) | no | `Permanent { TimelineUnsupported }` |
| `E_VIDEO_TIMELINE_CHANGED` | — | worker re-Keep probe/publication mismatch | no | `Permanent { TimelineChanged }` |
| `E_VIDEO_TOO_LARGE` / `E_VIDEO_TOO_LONG` | — | worker (durable attempt codes) | no | `Permanent { TooLarge / TooLong }` |
| `E_VIDEO_NETWORK` / `E_VIDEO_STORAGE` | — | worker closed expected dependency mapping | user retry | `Retryable { Network / Storage }` |
| `E_VIDEO_WALL_TIMEOUT` / `E_VIDEO_MEMORY_LIMIT` | — | supervisor (durable attempt codes) | user retry | `Retryable { ResourceLimit }` |
| `E_HIGHLIGHT_ANCHOR_UNSUPPORTED` | 422 | `POST /fragments/{id}/highlights` on a transcript fragment | no | typed rejection |
| `E_TRANSCRIPT_USE_FORBIDDEN` | 403 | any restricted-caption consumer outside approved private read/plain Copy | no | typed policy rejection; UI capability absent |
| `E_YOUTUBE_OAUTH_STATE_INVALID` | — | internal callback disposition for missing, expired, replayed, or cookie-mismatched OAuth state; the outward callback response remains the fixed query-free `303` | restart Connect | no exchange; emit a content-free security/readiness incident for an unexpected invariant break rather than normalizing it into ordinary UI state |
| `E_YOUTUBE_OAUTH_RESPONSE_INVALID` | — | exchange worker durable outcome for wrong scope/token type, missing refresh token, redirect/client mismatch, or closed token-response violation | revoke in Google, then reconnect | exchange receipt `InvalidProviderResponse`; cleanup converges to `RemoteUnconfirmed { ExchangeGrantUnrecoverable }` |
| `E_YOUTUBE_OAUTH_EXCHANGE_UNCERTAIN` | — | exchange worker durable outcome when one-use code exchange may have reached Google but no owned refresh secret is recoverable | Google account security, then reconnect | exchange receipt `UnrecoverableRemoteGrant`; `RemoteUnconfirmed { ExchangeGrantUnrecoverable }`, no credential use |
| `E_YOUTUBE_OAUTH_PENDING_STALE` | 409 | expired, consumed, wrong-user, or replayed pending handle | reconnect | no binding |
| `E_READER_SELECTION_NO_QUOTE` | 422 | quoting a moment Highlight | no | **A moment highlight has no text to quote. Highlight the transcript passage instead.** |
| `E_ACTIVITY_CAPTURE_CONFLICT` | 409 | capture key replayed with different Timeline facts | no | typed conflict |
| `E_STALE_PLAYBACK_REVISION` | 409 | renamed existing CAS rejection | fresh state | heartbeat recovery |

Worker-terminal codes marked `—` never reach an HTTP boundary; each is a member
of its concern's durable failure enum and maps through the corresponding typed
domain failure. Expected classified failures terminalize the domain attempt and complete the queue job;
they do not consume dead-letter repair. An unexpected exception, corrupt code,
or invariant violation leaves the job dead and binding visibly operator-owned
until `requeue_dead_job` repairs that same work; it is never projected as an
ordinary retryable product failure.

Endpoints. Every new command binds its replay identity to canonical
`{method, exact path including the media id, body}` bytes hashed through
`resource_mutation_replay.canonical_json_bytes` (following
`podcasts/control_replay.py`), recorded inside the admission transaction
under one named scope per concern (`video-copy:command`,
`timed-media:highlight`, `timed-media:transcript`, `media:user-title`). Replay of the SAME
`Idempotency-Key` returns the memoized response for that admitted decision —
mismatched bytes, cross-media reuse, or cross-endpoint reuse raise
`E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`, never a silent memo hit. A NEW key is new
intent evaluated against current state: Keep from retryable `Failed` may admit
a new attempt in the same Timeline generation; Remove from `RemovalFailed` may
insert one fresh cleanup attempt as `AwaitingDispatch` for that exact
removal; transcript Retry may admit new transcript work; cancel after terminal,
Keep while `Kept`, and Remove while already `Removing` return current truth
without side effects. Each endpoint below owns its transition; there is no
blanket terminal-state no-op rule.

| Endpoint | Contract |
| --- | --- |
| `POST /settings/youtube-captions/oauth/start` | Browser-only authenticated BFF command with CSRF, `Idempotency-Key`, and an empty strict body. `hostKind` is never caller input. The server derives `Browser` and creates the browser-attempt binding. Available only under live `CaptionTransformApproved` plus the separate exact-project `YouTubeOAuthProductionReady` deployment gate. It nonlocking-resolves the account state, then takes the singleton schedule gate/exact capacity rows before the account gate. Under those locks it checks active attempt, pending, binding, revocation, remote-unconfirmed marker, and `activeDeadlineRefCount + YOUTUBE_OAUTH_EXTERNAL_NEW_ROOT_COUNT(1) + YOUTUBE_OAUTH_INTERNAL_SUCCESSOR_HEADROOM(4) <= YOUTUBE_OAUTH_MAX_ACTIVE_DEADLINE_REFS(12)` before creating anything; seven old refs admit the eighth external root, while eight old refs reject before redirect, secret, or provider work; an active attempt projects `Connecting` and is never overwritten. For a new attempt, allocate the attempt UUID, deterministically seal the one-use OAuth state, and generate a random 256-bit PKCE verifier plus its application-AEAD envelope in memory. One transaction inserts the neutral Browser attempt/state digest, unique active marker, awaiting phase, typed PKCE material/hold, exact browser session binding, `YouTubeOAuthAuthorizationAttemptExpiry(expiryOperationId)` as `AwaitingDispatch`, and its neutral capacity/schedule/typed authorization-expiry owner; rollback leaves neither capability nor owner. Only the committed hold permits a `303` to Google's exact allowlisted HTTPS authorization URL. Before callback consumption, a same-key response-loss retry deterministically reconstructs the exact state/Location and rejoins that attempt; after consumption it redirects to query-free Settings/current projection rather than reopening Google. Postcommit admission and the lane control scanner own expiry even if no callback occurs; cleanup atomically deletes active/awaiting/browser-binding/hold/material/attempt only through the terminal transition/receipt and generated schedule-owner order. The exact request is `response_type=code`, one configured HTTPS redirect URI, PKCE `S256`, exact `youtube.force-ssl`, `access_type=offline`, `prompt=consent`, and `include_granted_scopes=false`; no OpenID/audience claim is requested or inferred. `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. |
| `GET /oauth/youtube-captions/callback` | Unclaimed server-only HTTPS callback with access-log query suppression. Accept exactly one closed shape: success `{ code, state }` or denial `{ error=access_denied, state }`; mixed, extra, unknown-error, missing, or malformed shapes fail closed. Every branch—including unknown/malformed/cross-user state and unexpected exceptions caught at this route boundary—returns `303` to a fixed query-free Settings URL with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; it never renders, reflects, or leaves diagnostics on the callback URL. Untrusted shapes mutate no attempt and set at most a short-lived same-site generic-feedback code containing no provider value. An unexpected exception additionally emits a content-free defect/readiness incident with no query, state, code, cookie, provider body, or user identifier; it is never normalized as an ordinary OAuth denial. The callback always requires the authenticated Nexus browser session plus exact `Secure; HttpOnly; SameSite=Lax` per-attempt state-cookie binding, including in Android's system Custom Tab; no state-only or native-host exception exists. It nonlocking-resolves the attempt, then takes the singleton schedule gate/exact allocations before the account gate and locks the active attempt, awaiting phase, browser binding, and expiry operation. Denial validates/consumes state and atomically deletes the active marker plus awaiting PKCE hold/material and awaiting row, clears the OAuth cookie, inserts the `Denied` replay tombstone, and immediately projects `Disconnected` with one sanitized feedback; neutral attempt, browser binding, expiry, tombstone, and its expiry schedule remain only for replay retention. Success validates state/expiry/client/redirect/session binding, envelope-encrypts the code in memory, then atomically creates the neutral credential and exact attempt-to-credential allocation, exchange intent, code material/hold, transfers the unchanged PKCE material from the awaiting hold to the exchange hold, inserts the `CallbackTransferred` tombstone, creates/joins the exchange capacity/schedule/typed owner from the root's reserved headroom, clears the OAuth cookie, and deletes only the awaiting row; the active marker remains the sole `Connecting { phase: Finalizing }` owner during exchange. The tombstone derives state/redirect disposition through expiry -> attempt and is keyed by the exact closed response digest; before bounded retention expires, an exact replay by the same authenticated user rejoins the sanitized redirect without mutation, while any code/error/state/session mismatch fails. Callback commit does not write a terminal expiry receipt or terminalize that operation. Postcommit it promotes the same expiry ref to `replay_delete_due_at`; success also admits `YouTubeOAuthExchange`, which exclusively owns both transient ciphertext rows. At replay due, expiry deletes the browser binding, tombstone, and expiry operation and writes `DeniedReplayExpired | CallbackReplayExpired`; denial also deletes the now-unreferenced attempt, while success leaves it only when exchange/allocation still owns it. A process crash before callback commit leaves the awaiting phase and Google code replayable; after commit no secret-write prefix remains. Google always redirects to this server callback and then query-free Settings. Android presents that identical page in Custom Tab with a visible ordinary **Return to Nexus** verified App-Link; the user may need to sign in to Nexus in the Custom Tab, an accepted security-for-friction tradeoff. It never exchanges tokens in the request. |
| `GET /settings/youtube-captions/connection` | Authenticated `Cache-Control: private, no-store` projection: `Disconnected { connect: Available | Blocked { ComplianceCapacity } } | Connecting { phase: AwaitingGoogle \| Finalizing } | ChooseChannel { pendingHandle: YouTubeOAuthPendingHandle, channels: [{ channelHandle: YouTubeOAuthPendingChannelHandle, displayLabel: CanonicalProviderDisplayLabel, duplicate: Absent \| Present<{ ordinal, total }> }] } | Connected { selectedChannelLabel: CanonicalProviderDisplayLabel, duplicate: Absent \| Present<{ ordinal, total }> } | Revoking | RemoteUnconfirmed { reason: RevocationRemoteUnconfirmed \| ExchangeGrantUnrecoverable }`. `RemoteUnconfirmed` derives only from the unique actionable marker and takes precedence over Disconnected; exactly one typed owner child must match its reason. `Connecting` derives only from the unique active-attempt marker: the awaiting-callback row proves `AwaitingGoogle`, while an exchange intent after callback transfer proves `Finalizing`; zero or both phase owners is a projection/readiness defect, never an inferred phase. Both pending handle types identify only current rows, carry expiry/version, and never authorize; every use rechecks current user, live pending ownership, approval, and unused state. Raw channel id, credential, OAuth code/state, encrypted material identity, or key version is never returned. Labels render as plain text inside `<bdi dir="auto">`; duplicate choices and Connected visibly render `— channel {ordinal} of {total}` and use the comma form in the accessible name. |
| `POST /settings/youtube-captions/remote-unconfirmed/acknowledge` | Authenticated CSRF + `Idempotency-Key` command with strict `{ confirmation: "REVOKED AT GOOGLE" }`. It requires the current marker, records only a domain-separated manual-attestation digest in the replay memo, and deletes marker plus its typed owner child after the user explicitly activates **I’ve revoked Nexus at Google**; immutable content-free exchange/revocation receipts remain audit truth. The resulting projection is Disconnected and a later explicit start may reconnect. This endpoint cannot claim or alter Google's remote state and never upgrades the historical outcome from `RemoteUnconfirmed`; absent the explicit manual attestation, reconnect remains blocked. Account erasure deletes an unacknowledged marker through its sealed user-FK inventory. |
| `POST /settings/youtube-captions/pending/select` | CSRF + `Idempotency-Key`; strict `{ pendingHandle, channelHandle }`. Unseal both, then invoke `settle_terminal_operation(YouTubeOAuthPendingExpiry(expiryOperationId), ConnectedTransition, callback)`, which takes settlement/queue/correlation, then the singleton schedule gate/exact allocations, then the account gate and refuses a competing live claim. Under those locks the registered terminal transition requires the same exact user-owned, unexpired pending row, its sealed complete allocation set, and one associated selected allocation; it inserts the binding selection pointing to that unchanged allocation, generation-one snapshot/head/active marker, first binding-lifecycle `AwaitingDispatch` operation and successor dependency, creates/joins that binding ref's neutral capacity/schedule/typed owner from reserved headroom, and writes the pending-expiry `Connected` domain receipt before the coordination receipt. The deletion-only callback then removes the pending typed schedule arm/owner/allocation, every pending association, duplicate child plus allocation for each unselected channel, the pending operation/row, and leaves exactly the selected allocation owned by the binding selection. No channel id/label/expiry is copied. Postcommit admits binding lifecycle. Replay resolves through terminal receipts to the same projection; a second choice, raw/cross-pending provider id, cross-user handle, wrong-use allocation, or receipt mismatch fails closed. A real-FK multi-channel proof leaves exactly one channel fact. |
| `DELETE /settings/youtube-captions/pending` | CSRF + `Idempotency-Key`; exact pending handle required. Invoke the same settlement primitive with the registered `RevocationTransferred` transition: under settlement/queue/correlation, then the singleton schedule gate/exact allocations, then account locks, the transition creates/joins the durable `YouTubeCredentialRevocation` owner over the neutral credential with reason `PendingCancelled`, creates/joins its neutral capacity/schedule/typed revocation owner from reserved headroom, inserts the domain successor edge `PendingExpiry -> CredentialRevocation`, creates the inverse observation dependency `{ observing=CredentialRevocation, observed=PendingExpiry }`, and writes the pending-expiry `RevocationTransferred` domain receipt before coordination-receipt insertion. The deletion-only callback removes duplicate children, every pending association/allocation, its now-unreferenced credential-use completion/member/result/intent/owner/use graph, operation, and pending row. Postcommit admits revocation. The due job uses the identical primitive with `PendingExpired`; neither path deletes the sole secret first, and a competing claim returns typed retry rather than a partial transfer. Real-FK proofs reject reversed dependency direction, wrong receipt, cross-operation substitution, or an orphaned allocation/use row. |
| `DELETE /settings/youtube-captions` | CSRF + `Idempotency-Key`; nonlocking-resolve, then take the singleton schedule gate/exact allocations before `YouTubeOAuthConnectionGate`. Under those locks, atomically insert exact binding deactivation `Disconnect` (the local capability/no-new-dispatch boundary), add the immutable `Disconnect` reason to one durable credential-revocation operation, create/join its neutral capacity/schedule/typed revocation owner from reserved headroom, insert the domain successor edge `BindingLifecycle -> CredentialRevocation`, create the inverse coordination observation dependency `{ observing=CredentialRevocation, observed=BindingLifecycle }`, and promote the existing binding-lifecycle ref. A reversed edge, another binding generation, or same-credential substitution fails the real-FK proof. The active marker remains only as a drain fence; every read/use also requires deactivation absence, so the projection is immediately `Revoking`. The owner drains/fences every earlier credential-use dispatch through persisted deadline phases, never an in-process wait. It holds no OAuth/user lock while discovering or locking Media. It then enumerates restricted publications and invokes each caption/owned-ASR lifecycle through a fresh per-Media gate in ascending Media order; missing/tearing-down Media is a typed no-op. It calls `OAuthBindingDeadlineFence` over the complete same-binding lifecycle set; that phase persists its next due time and returns. Process-termination/dependency events or the lane watchdog promote `OAuthBindingDeadlineFinalize`, which writes every lifecycle domain/coordination receipt, and only its deletion callback erases active marker/head/snapshots/results/deactivation/binding. Revocation similarly settles only after provider disposition, typed refresh hold/material deletion proof, and its domain receipt. Neither waits on the other while holding a lock, and neutral credential/revocation identity disappears only after both ownership sets are terminal. Provider revocation is postcommit and cannot restore use. |
| `PUT /media/{id}/user-title` | Viewer-authorized with `Idempotency-Key`; strict `{ expectedRevision, title: Presence<CanonicalUserTitle> }` using the single NFC/control/bidi/single-line server normalizer above. Under `media:user-title`, canonical replay bytes include method/path/the normalized body. First execution CASes the persistent title-state row, increments revision for an actual value change, inserts/updates or deletes only the value row, and memoizes `{ title, titleSource, titleRevision }` in the same transaction; same-key retry returns that exact projection even though current revision advanced, mismatched reuse fails, and a new key with stale revision conflicts unless the desired current value already equals the request, in which case it is a no-write equality success with current revision. Exact BFF route and strict decoder preserve Presence; provider metadata is never touched. |
| `POST /media/{id}/video-copy` | Required `Idempotency-Key`; `{ profile: "CompatibleMp4V1", rightsBasis: "UserAttestedAuthorized", acknowledgeProgressReset: Absent \| Present<Literal<true>> }`; acknowledgement MUST be Present exactly for the `AcknowledgementRequired` arm and Absent otherwise. Before work admission, lock the singleton compliance schedule gate, enforce the exact reservation/live-schedule union below the signed-notice-derived effective compliance capacity (absolute ceiling 32), and reserve a feasible neutral video capacity allocation; failure is `E_VIDEO_COMPLIANCE_CAPACITY` with zero attempt/provider/storage work. Otherwise join exact active/ready work, retry only when current `retry` is `Retriable`, reject timeline mismatch; returns `200` + the copy projection (house command convention, not `202`). |
| `POST /media/{id}/video-copy/cancel` | Required `Idempotency-Key` and `{ copyHandle }`; resolve and ascending-lock the exact generation's producer plus linked reconcile queue rows. Supersede an unclaimed producer only when no storage cleanup remains; otherwise persist the one domain cancel intent and set/preserve cancellation on either live claim, killing the copy or full-readback/reconcile child through the shared supervisor. Attempt cancellation, binding release, and producer completion wait until every run is Published or Absent; a verified-but-unpublished object is deleted by the linked reconcile owner first. Too-late replay after publication returns current truth. A stale/wrong generation can cancel neither job. |
| `DELETE /media/{id}/video-copy` | Required `Idempotency-Key`; state-directed and always under `MediaJobAdmissionGate`. After locking Media/head/Timeline it rejects creation or Retry when an active video-compliance fence exists and returns that exact compliance-owned removal truth; startup and operator repair use the same gate/check. Otherwise, from `Kept/Removable`, atomically unpublish and persist removal plus cleanup attempt as `AwaitingDispatch`; from `RemovalFailed`, retain history and insert the next exact attempt likewise. After domain commit, await idempotent postcommit admission; replay/startup resumes the same ref. Its worker only activates/joins and observes the exact reserved `StorageObjectCleanup`; after that cleanup's terminal receipt and generic authenticated absence fact, it inserts removal completion. The generic cleanup alone advances `DeleteRequired` and owns Abort/Delete/HEAD. `Kept/Blocked` rejects; Suspended exposes operator repair; Removing/NotKept return current truth. |
| `POST /media/{id}/timeline/discard` | Required `Idempotency-Key` and `{ timelineHandle }`; requires the canonical Discard confirmation and current viewer mutation authority; rejects stale head and `E_MEDIA_TIMELINE_BUSY`; owner helpers delete exactly current-generation content-bound facts, publish a fresh unbound Timeline generation, and return the four refreshed projections. Replay returns the memoized generation, never discards twice. |
| `GET /media/{id}/playback-ticket?assetHandle=...` | Viewer-authorized; unseals the handle then re-reads exact asset currency from the DB (a handle for a removed or superseded asset is rejected); response `Cache-Control: no-store`; returns strict `{ url, serverIssuedAt, expiresAt }` for one bounded private R2 signed GET URL, with `0 < expiresAt-serverIssuedAt <= VIDEO_PLAYBACK_TICKET_MAX_SECONDS`. Never proxies bytes. |
| `POST /media/{id}/youtube-observation-authorization` | Viewer-authorized activation/renewal and domain-mutation-free; strict body `{ playerSessionId: UUID, source: ExternalYouTube \| YouTubeOriginOwnedVideo { assetHandle } }`. The authorization is deliberately host-neutral: neither request, result, nor token accepts or signs a Browser/Android claim, because v1 has no nonspoofable app-install identity and the fixed native-boundary rule admits no seventh attestation client. Browser versus WebView construction remains a local host-capability decision, with Android Media Integrity enforced independently by release/device proof. Re-read exact current source; the owned arm additionally unseals/rechecks current asset/content/Timeline. Call official `videos.list(part=id,status,liveStreamingDetails)` for the frozen provider id and require exactly one exact-id item with closed fields, public/processed/non-live VOD, and for External `embeddable=true`. Decision mapping is exhaustive by source. For External, exact `madeForKids=true`, an exact eligible non-MFK item without timed-observation approval, or policy uncertainty maps respectively to `Untracked { MadeForKids \| TimedObservationNotApproved \| PolicyUnknown }` only while the separately certified no-JS embed profile is live; otherwise it maps to `Unavailable { UntrackedEmbedProfileUncertified }`. If no safe External identity can be frozen, it maps to `Unavailable { PolicyUnknown }`. For current approved owned bytes, those same three provider decisions map to the matching `Untracked` arm only while the separately certified native owned profile is live; otherwise they map to `Unavailable { UntrackedOwnedProfileUncertified }`. If current approved owned bytes cannot be frozen, it maps to `Unavailable { PolicyUnknown }`. No uncertified profile ever constructs a player. The closed `Cache-Control: private, no-store` result is `Tracked { playerSessionId, source, providerVideoId, serverIssuedAt, observationExpiresAt, youtubeObservationToken } \| Untracked { playerSessionId, source, reason: MadeForKids \| TimedObservationNotApproved \| PolicyUnknown, profile: CertifiedUntrackedProfileRef { profileId, version, artifactSha256 } } \| Unavailable { playerSessionId, source, reason: PolicyUnknown \| UntrackedEmbedProfileUncertified \| UntrackedOwnedProfileUncertified }`. Every arm echoes the exact request correlation; a stale/mismatched response is destroyed without construction or persistence. `Tracked` requires exact `madeForKids=false` and a live matching `YouTubeTimedObservationApproved` artifact; neither fact implies the other. Its nominal, domain-separated token binds viewer, Media, current Timeline/epoch, source, provider id, exact timed-observation artifact, and—for owned source—asset/content identity, plus player session, server issue time, random 192-bit nonce, closed/versioned claims, signing-key version, and a `YOUTUBE_OBSERVATION_AUTHORIZATION_TTL` window. It signs the window, never a future client event. The client captures a monotonic response baseline, allows capture only before its conservative RTT-adjusted local deadline, and renews at `YOUTUBE_OBSERVATION_RENEW_AT`. Untracked decisions are activation-scoped, carry no observation deadline/token, and are discarded after constructing the certified profile; reopening, source drift, or a visibility-destroy/reopen cycle performs a fresh authorization rather than renewal. Untracked categorically removes every Nexus time/history/position/completion/Activity/Highlight/transcript-follow/analytics writer and PlayerSession/Lectern history for both YouTube sources. Interactive tracked writes additionally require current viewer/source/asset; delayed Activity verifies the historical signed identity and may survive later Keep/Discard. A signing key remains verification-only until `max(observationExpiresAt for every token it signed) + 24h delivery + configured retry/scanner/clock-skew margin`; rotation cannot infer a fixed 24-hour retirement from key-change time. Stale outbox rows are deleted, and audit stores only a bounded decision-receipt digest. |
| `GET/PUT /media/{id}/playback-state` | Hard-replaces `/listening-state`; PUT adds closed `engineSource`, paired `youtubeObservationToken`/`captureOffsetMs` Presence, and expected `timelineHandle`, rejected for stale epoch/binding before CAS; no duration field. Token/offset are Present exactly for `ExternalYouTube | YouTubeOriginOwnedVideo`, Absent for `NonYouTubeOwnedVideo | Audio`; verification precedes state/history/completion mutation and binds owned writes to asset/content. Untracked YouTube playback has no persisted GET/PUT arm. |
| `POST /media/{id}/preview-position` | Moves with the renamed router; keeps its Podcast-episode-only admission (never subject to a video binding), gains the Timeline gateway + `timelineHandle`. |
| `POST /media/{id}/transcript/input-preparation` | Required `Idempotency-Key` and `{ timelineHandle, retryFrom: Presence<TranscriptInputPreparationFailureHandle> }`; Podcast-only explicit **Verify episode length…** command. `retryFrom` is Absent for an initial/fresh-source command and Present exactly for the current Dependency failure; permanent or stale/wrong-Media handles reject before work. A retry creates fresh preparation/source-attempt work rather than reusing terminal failure identity. Under the Media gate it creates/joins one exact preparation/source-attempt operation bound to the current Timeline and SHA-256 of the canonical credential-free stream locator, then dispatches `ProbeTranscriptInput(preparationId)` through OperationRef. The TimedMediaHeavy worker uses only `safe_stream_to_private_file` below, hashes the complete exact bytes, probes that same private file, enforces the 4 GiB/4-hour envelope, and publishes one 15-minute probe fact under the owned-claim fence; no ASR/provider call or reservation occurs. Projection is `PreparingInput { progress }` across reload, with Fetch bytes only from persisted worker facts and a total only for a validated Content-Length; Probe has no invented percent. `RetryableDependency` becomes the typed retryable `InputVerificationFailed` arm; `UnsafeSource`, `SourceUnavailable`, `InvalidInput`, `TooLarge`, and `TooLong` become their permanent exact arms with no Retry and the content above. Cancelled returns `Idle/Blocked DurationUnknown`; an unexpected dead ref is `Suspended`. A changed canonical feed/source locator invalidates the old failure and exposes a fresh verification command with retryFrom Absent. |
| `POST /media/{id}/transcript/input-preparation/cancel` | Required `Idempotency-Key` and `{ inputPreparationHandle }`; cancels only that exact preparation through OperationRef, projects `CancellingInput`, kills the bounded child through the supervisor, removes private temp, inserts terminal cancellation, and restores `Idle/Blocked DurationUnknown`. Wrong/stale handles cannot cancel newer work. |
| `POST /media/{id}/transcript/forecast` | Read-only forecast; strict explicit Default/HostedOnly intent, no provider call or durable trace. A hosted reason requires current `HostedAsrInput`: `YouTubeOwnedVideoAsset { contentIdentity, approvalArtifactSha256, usePolicyVersion, disposition }` only while `OwnedVideoAsrApproved` is live, or `PodcastStream` plus current exact-byte probe. Default names sidecar, conditionally approved caption, then hosted ASR only when that input-specific approval exists; disabled arms are absent rather than returned blocked-but-callable. The closed forecast/budget union is unchanged, and its sealed handle binds exact source plan, both independent approval arms, asset/probe/duration identities, restricted-use policy/disposition, entitlement, and maximum cost. |
| `POST /media/{id}/transcript/request` | Required idempotency, Timeline and forecast handles. Under Media/head/Timeline locks it reauthorizes every forecast field, including independent caption/owned-ASR approval, exact asset/probe, restricted-use disposition, duration, source order, cost and entitlement; drift returns a fresh forecast with zero work/reservation. Equality commits work/active marker/source attempt/reservation as `AwaitingDispatch`, then dispatches postcommit. The worker repeats owned-ASR approval immediately before extraction, provider dispatch, and publication; expiry/replacement cancels, releases/settles honestly, publishes nothing, and arms disposition cleanup. Podcast bytes repeat exact probe hash/duration validation before dispatch. No `dryRun`. |
| `POST /media/{id}/transcript/cancel` | Required `Idempotency-Key` and `{ transcriptWorkHandle }`; cancels/supersedes only that exact queued or running work through the shared queue cancellation substrate, projects `Cancelling` while a claimed child settles, applies the pre-/post-provider reservation settlement contract (never blindly releasing charged or unknown usage), and preserves the current publication. Wrong/stale work cannot be cancelled. |
| `GET /media/{id}/transcript/cues?publicationHandle=...` | Viewer-authorized bounded content read. Unseal, then under Media/publication ownership require the exact current publication or `E_TRANSCRIPT_PUBLICATION_STALE`. Apply `TranscriptUsePolicy`; either restricted YouTube-derived arm requires exact authorizer, live matching approval, unexpired lifecycle and host-specific plaintext residual permission; caption additionally requires the active credential binding. Return strict `{ publicationHandle, access: Readable { policy: Ordinary \| RestrictedYouTubeCaption \| RestrictedYouTubeOwnedAsr, removalDeadline: Presence<instant> }, language: Presence<string>, cues: [...] }`, where deadline is Absent exactly for Ordinary and Present exactly for either restricted arm, ordered by unique segment index within the 4,000-cue/4-MiB ceilings; otherwise return the same metadata-only `RestrictedUnavailable` arm as Media with no cues. `Cache-Control: private, no-store`. Media SSE carries metadata only. |
| `POST /media/transcript/forecasts`, `POST /media/transcript/request/batch` | V1 batch is Default-only. The selection fingerprint includes each Timeline, probe/asset digest, ordered source plan, both approval arms and artifact digests, restricted-use disposition, policy version and maximum cost. Under ascending Media gates/locks it recomputes all or commits none as `AwaitingDispatch`; postcommit dispatcher admits stable refs. Episode eligibility remains Podcast-specific; no video or hosted-only intent is smuggled through that resolver. One key, no `dryRun`. |
| `POST /media/{id}/time-highlights` | Required `Idempotency-Key`; `{ timelineHandle, positionMs, engineSource: NonYouTubeOwnedVideo \| YouTubeOriginOwnedVideo \| ExternalYouTube \| Audio, youtubeObservationToken: Presence<YouTubeObservationToken>, captureOffsetMs: Presence<int64>, color }`; token/offset are Present exactly for the two YouTube arms and Absent otherwise, with owned token bound to asset/content. Current source/asset resolution and signature verification precede mutation. Untracked/MFK/unknown playback has no capability and is rejected before storing text/time. All four arms have strict-decoder fixtures. Returns `201` + `TypedHighlightOut`; replay returns the same body. |
| `POST /media/{id}/transcript-highlights` | Required `Idempotency-Key`; `{ publicationHandle, segmentIndex, startOffset, endOffset, color }`. The server first applies `TranscriptUsePolicy` and rejects either restricted YouTube-derived arm with `E_TRANSCRIPT_USE_FORBIDDEN` before reading cue text. Only `Ordinary` derives quote/time/locator under lock and returns `TypedHighlightOut`; stale publication rejects. |
| existing `PATCH /highlights/{id}` | Accepts a colour-only update for every anchor kind (the colour branch precedes any anchor-kind requirement); rejects an `anchor` update for time kinds with typed `E_INVALID_REQUEST` (**Time anchors cannot be moved**), never a 404. |
| existing `POST /fragments/{id}/highlights` | Rejects transcript fragments with `E_HIGHLIGHT_ANCHOR_UNSUPPORTED` (422); remains the document-only FragmentOffsets command. |
| existing `GET /media/{id}/highlights` | Adds exhaustive `media_time` and `transcript_time_text` anchor arms. On timed Media the response merges both time kinds ordered by source time ascending (`t_start_ms`/`position_ms`), then `start_offset`, then `created_at ASC, id ASC`; unresolved-locator rows sort last with an Absent locator, never dropped. The fragment-cache repair pass runs only over `fragment_offsets` rows; transcript-anchor re-resolution is owned by the publication transaction, never this read. |

The `profile` field in the exact untracked wire arm is a deployment-wide signed
release artifact selected by source; it
contains no caller-supplied or inferred Browser/Android identity. The two
`Unavailable { ...ProfileUncertified }` reasons mean only that this deployed
artifact is absent, expired, signature-invalid, or not the exact configured
artifact. The client must equality-bind the returned id/version/SHA-256 to its
compiled release manifest before construction. A mismatch is local
`UntrackedProfileArtifactMismatch`; an exact browser/WebView/OS outside that
artifact's versioned allowlist is local
`UntrackedEmbedProfileUnsupportedHost | UntrackedOwnedProfileUnsupportedHost`.
Neither local failure is fabricated as a server response. This division keeps
server authority host-neutral while making release and host drift fail closed.

The OAuth `ComplianceCapacity` arm is externally reachable only from a fresh
Start. Settings renders **Connection cleanup is still finishing. Try again
after it completes.** with an ordinary **Try again** button; the button has the
same accessible name and issues a new idempotent Start only on activation.
Prior replay-expiry/convergence refs settle automatically; the UI neither spins
nor claims an ETA. The BFF strict decoder maps only
`E_YOUTUBE_OAUTH_COMPLIANCE_CAPACITY` to this arm and rejects use of the video
capacity code. Callback, select, disconnect, revocation, erasure, and every
other internal successor use reserved headroom and can never surface or persist
this user-facing failure. Boundary/replay tests prove seven old refs admit the
eighth Start, eight reject before redirect/secret/provider work, Try again
succeeds after expiry, and internal transitions remain non-failable.

Every terminal verb in this endpoint table is semantic shorthand for the
coordination settlement contract above. In particular, callback replay expiry,
exchange completion, pending selection/cancel/expiry, binding teardown, and
credential revocation may delete their operation row only inside
`settle_terminal_operation` after the coordination receipt/dependency links;
no route performs a correlation-only postcommit cleanup.

The per-attempt OAuth cookie uses a `__Host-` name and exactly `Secure;
HttpOnly; SameSite=Lax; Path=/` with no `Domain` attribute; browser/Custom-Tab
tests reject any looser scope or prefix violation.

OAuth callback query secrecy is an owned deployment contract, not a comment on
the route. `deploy/hetzner/Caddyfile` defines an exact callback path matcher and
`log_skip`s that request from Caddy access logging before `reverse_proxy`;
ordinary access logging remains enabled elsewhere. The ASGI request-context
owner in `python/nexus/middleware/request_id.py` continues to bind only
`request.url.path`, `python/nexus/logging.py` has a deny processor that removes
`code`, `state`, OAuth error-description/URI, raw URL, query, and request-target
fields recursively from application/exception events, and Uvicorn access logs
remain disabled. No tracing/span/breadcrumb owner may record URL query or
redirect `Location`; browser completion immediately uses `history.replaceState`
on the query-free Settings/App-Link target before any analytics or error SDK is
initialized. The release proof sends unique canary values in every accepted and
rejected callback shape, then scans Caddy, container, application, exception,
trace, browser-history, and error-reporting sinks and requires zero plaintext
matches while the bounded callback-response SHA-256 remains. Adding a proxy,
logger, tracer, or SDK that observes request targets changes this inventory and
fails the static/e2e secrecy gate.

Every `youtubeObservationToken` wire mention above is paired, not standalone.
Interactive playback-state/seek/history/completion and moment-Highlight bodies
carry `captureOffsetMs: int64`; Activity carries
`captureStartOffsetMs/captureEndOffsetMs: int64`. On receipt of Tracked
authorization the client records `responseReceivedMonotonicMs`; offsets are
authorized client-asserted monotonic differences from that baseline, and the
conservative local deadline subtracts observed request round trip from the
signed 60-second window. The server reconstructs `serverIssuedAt + offset`,
requires `0 <= start <= end <= observationExpiresAt-serverIssuedAt`, bounds
reported span duration/drift against the offset delta, and verifies the exact
session/capture generation. The issuance MAC does not sign a later offset and
cannot prove gaze, an honest client clock, or an unmodified client; it only
bounds what the authenticated client may assert. Client wall time is never
authorization. `PositionSample`, heartbeat coalescing, seek commit,
`EngineObservation`, IndexedDB outbox, and idempotency bytes retain this exact
shape. Interactive mutations must reach the server before token expiry; only
Activity may arrive up to 24 hours later, and only for a wholly in-window span.
Renewal closes the old capture generation. Clock/RTT/drift/bounds, coalescing,
offline-delivery, and cross-generation proofs cover zero and the final allowed
millisecond; no test claims forged in-window offsets are cryptographically
detectable. UI/privacy copy names Activity/history as Nexus-calculated behavior,
not YouTube metrics, and links the applicable disclosure.

One shell-owned cue resource keyed by `publicationHandle` serves both the pane
and OwnedVideo `TextTrack`; they never fetch or cache independently. A Media
projection handle change synchronously clears installed DOM/VTTCues and aborts
the prior fetch. Before cache, DOM, or track installation, the owner compares
the response handle with both the latest Media projection and the live
session's publication handle; a late response for publication A after B is
discarded even if A was current when the server read began. The browser proof
forces B's response to install before delayed A and proves no A cue survives.

Highlight anchor wire shape: `anchor` is a discriminated union
(`Field(discriminator='type')`) of four arms; the quote triple moves off the
flat root and into the arms that own one (`fragment_offsets`,
`pdf_page_geometry`, `transcript_time_text` each carry required
`quote { exact, prefix, suffix }`; `media_time` carries none — quote absence
is structural). The two new arms in full:
`media_time { type, mediaId, timelineHandle, positionMs }` and
`transcript_time_text { type, mediaId, timelineHandle,
tStartMs, tEndMs, quote,
locator: Presence<{ fragmentId, startOffset, endOffset }> }` — `locator`
absent exactly when the current publication no longer resolves the quote
(**Highlight needs review**). Snake `media_time`/`transcript_time_text` are
the anchor-union discriminators everywhere (matching the DB values);
PascalCase `MediaTimePoint`/`TranscriptTimeText` is reserved for the
reader-target, public-share, and marker unions where PascalCase is already
the convention. `TypedHighlightOut` and the frontend `HIGHLIGHT_KEYS` drop
the root-level quote keys in the same release.

The resource capability makes Keep applicable only when the viewer may mutate a
canonical YouTube video, no teardown is active/failed, and no ready/active copy
conflicts. A first copy also requires no Tier-1 content-bound timed facts; the
projection supplies `TimelineUnproven` instead of admitting work. Capability
ownership is hard-cut alongside: a new
`VideoCopyResourceActionCapabilityOut { kind: 'VideoCopy', availability,
state, blockReason }` joins the capability union as the sole source of
Keep/Retry/Remove applicability, projecting the identical facts as
`MediaOut.videoCopy` from the same owner so the two can never disagree
(`ServerActionAvailabilityBlockedOut.reason` is not extended). `Failed.retry`
is re-derived on every read: Tier-1 facts authored after the failed attempt
change it to `Blocked { TimelineUnproven }`; the diagnostic remains visible but
Retry is never falsely offered. Timed-media
annotation is decoupled from text readability but remains observation-gated.
The durable resource projection's `canHighlightMoment` is true only for a
non-YouTube owned playable source with a Timeline and no binding; it is false
for both YouTube-provenance sources because a Media read cannot predict a
session's activation decision. A session-local closed
`highlightMoment: Allowed | Unavailable` capability becomes Allowed for those
sources only after installing a current `Tracked` decision/token and returns to
Unavailable synchronously on renewal failure, expiry, or any `Untracked` arm.
The chrome action requires both resource/session gates and is absent otherwise;
`_require_media_readable_for_highlight` splits so `time-highlights` requires
only the Timeline gateway, `derive_capabilities` stops deriving
`can_highlight` from transcript projection for timed media, and the text-quote
capabilities keep requiring a readable publication. `CapabilitiesOut.can_play`
and its frontend decoder field are deleted — playability derives exclusively
from the `playback` union arm (residue-gated).

The Timeline gateway is mandatory for playback state, transcript/chapter
publication, both temporal Highlight commands, and `Listening`/`Viewing`
Activity delivery for canonical timed Media (`Reading` batches and
Timeline-less media bypass it and store absent fields). In the global lock
order it locks Media -> current-head -> Timeline, unseals/checks epoch, rejects a binding
reservation for direct timed commands, then invokes the domain writer in that
transaction; for Activity delivery it records the observed epoch instead of
rejecting (see Observed activity). Where transcript publication composes with
it, the gateway lock is taken first, then the existing
`pg_advisory_xact_lock('transcript-current:{media_id}')` inside the same
transaction, and `transcripts.current` remains the sole writer of publication
head, segments, and fragments (retiring `docs/modules/podcast.md`'s "no
active transcript pointer" sentence). Async jobs persist their expected
handle at admission. No owner reimplements this fence.

Per `docs/rules/{database,concurrency}.md`, no new or rebuilt domain table
references `background_jobs`, and supplemental operations do not use
`media_source_attempts.job_id`. Stable domain identities are the source
attempt, copy-approval lifecycle, transcript work/input preparation/reindex/
restricted-publication lifecycle work, OAuth authorization-attempt expiry/exchange/pending expiry/
binding lifecycle/revocation, account-erasure operation, removal attempt,
copy-reconciliation, storage-cleanup operation, and existing media-teardown
intent rows. The closed operation-kind union is
`PrimaryMediaIngest | AcquireVideoCopy | ReconcileVideoCopy |
ProbeTranscriptInput | TranscribeMedia | MediaTranscriptReindex |
YouTubeOAuthAuthorizationAttemptExpiry | YouTubeOAuthExchange |
YouTubeOAuthPendingExpiry | YouTubeOAuthBindingLifecycle |
YouTubeVideoCopyLifecycle | YouTubeCaptionInitialLifecycle |
YouTubeCaptionLifecycle |
YouTubeOwnedAsrLifecycle | YouTubeCredentialRevocation |
VideoCopyRemoval | StorageObjectCleanup |
MediaContentReindex | EnrichMediaMetadata | MediaUnitBuild | MediaTeardown |
UserAccountErasure`;
adding a kind requires its domain resolver, teardown inventory, migration
mapping, registry/topology entry, and governed proof in the same change.
`MediaContentReindex` is backed by the exact new reindex-operation/revision row,
`EnrichMediaMetadata` by its exact fingerprinted operation row, and
`MediaUnitBuild` by its new immutable content-fingerprinted operation row
(the mutable `media_summaries` head is not operation identity);
their handlers move off payload ownership and through the same claim fence.
`media_teardown_intents.id` is `MediaTeardown` identity and gains a
domain-owned `AwaitingDispatch | Unprepared | PathsPrepared | Deleting |
ReadyToCommit` checkpoint; `Deleting -> ReadyToCommit` occurs only after every
planned path is `HEAD NotFound`, and terminal commit deletes the intent and
writes the receipt rather than persisting a fictional `Deleted` intent;
queue payload no longer owns it. `storage_object_cleanup` is likewise rebuilt
around `storage_object_cleanup_operations.id`: its strict queue payload is
only the operation ref plus equality-checkable routing facts, while path,
owner, write horizon, checkpoint, and terminal truth live in the storage
domain row. The existing coordination module owns
`coordination_operation_jobs` and a typed
`OperationRef { operationKind, domainOperationId }` correlation with one live
queue target per ref. It exposes admit, health, cancel, requeue, resolve, and
terminal-transition ports; only that module reads/writes the queue backend,
correlation row, or payload. The boundary is deliberately two durable steps,
not a cross-owner transaction: the domain admission first commits an
`AwaitingDispatch` operation; the request then awaits idempotent
`admit_operation(ref, definition, payload)`. That dispatcher/reconciler
reacquires `MediaJobAdmissionGate`, and one managed transaction revalidates the
domain operation/teardown predicate through its owner before coordination
atomically inserts the job and correlation through the canonical transactional
enqueue primitive, including its `pg_notify` wakeup in that same commit.
Rollback creates neither job/correlation nor a ghost wakeup; listener loss is
harmless because the committed-row/startup scan is authoritative. A crash in
the gap is recovered by
the existing startup/periodic operation reconciler through the identical gate;
uniqueness converges concurrent admit/replay, while teardown terminalizes a
no-correlation operation under that gate so delayed admission becomes a no-op.
A worker never performs a prior health check followed by an unfenced domain
write. Coordination owns
`with_owned_operation_claim(ref, workerId, attemptNo, domainMutation)`: one
managed mutation nonlocking-resolves the ref, locks and renews the exact
`background_jobs` running claim, then locks/revalidates its correlation,
verifies status/claimant/attempt/lease, and invokes the owner-supplied domain helper in
the global Media/TL/domain order on that same transaction/connection; there is
no nested transaction and domain code never sees a queue row. Progress,
publication, failure, cancellation, verification/absence, and cleanup facts all
use this boundary. A composite copy/reconcile or teardown transition uses the
separate coordination-owned
`with_owned_operation_claim_set(ownedRef, peerRequirements, workerId,
ownedAttemptNo, domainMutation)`. Every declared peer edge has one durable
`coordination_operation_terminal_dependencies` row created or joined by the
relationship owner before the observed operation can be pruned. The helper
nonlocking-resolves the complete stable ref set, takes every required
settlement gate in canonical ref order, re-resolves, then takes every queue and
correlation lock in ascending job-id order,
validates the caller's exact live owned claim, and applies this closed peer
matrix before invoking one domain mutation on the same connection:

- `ObserveTerminal` locks and verifies the exact owned-parent -> observed-peer
  dependency and grants read-only authority in exactly one of two closed arms:
  either the queue and correlation are present, terminal, and agree with the
  locked exact terminal domain predicate; or both are absent after pruning and
  the dependency points through its composite FK to the locked immutable
  content-free terminal receipt for that exact OperationRef. The receipt is
  accepted only through the operation kind's registered terminal resolver and
  outcome-digest version. A partial queue/correlation pair, an absent receipt,
  a different parent/peer, a missing terminal fact, or any nonterminal truth
  rejects the whole claim set. The helper never recreates a queue row;
- `DelegateUnclaimedRecovery` accepts only an unclaimed pending/retryable peer
  in a checked, statically declared domain relationship (in v1, the exact
  Acquire-attempt <-> Reconcile-child pair). With the peer queue/correlation
  locks held so it cannot be claimed, the helper authorizes the currently
  owned claim to make the one composite domain transition and atomically
  supersede/terminalize that never-started peer target. It does not create a
  peer running claim, increment peer attempts, or consume a second Heavy
  capacity slot;
- `CancelOnly` accepts a cancellation-requested target only for cancellation,
  verified-absence, or teardown convergence and categorically forbids
  publication; and
- a peer claimed by another worker, an expired but unrecovered claim, a dead or
  suspended target, a missing/ambiguous correlation, or a state outside the
  named requirement makes the whole helper write nothing and returns typed
  retry/operator-repair truth.

The helper never treats a locked but unclaimed row as a general worker claim:
delegation exists only for the named relationship/transition, and the peer is
made non-runnable in the same transaction as its terminal domain fact. Any
later admission/claim CAS therefore observes terminal truth. Terminal queue
transitions for the set happen in that transaction or by ordinary exact-ref
replay. Real-Postgres proofs run opposing-ref-order, claim-vs-delegation,
cancel-vs-publication, peer-death, lease-loss, prune-vs-settlement,
prune-before-finalizer, and assert
the single-capacity `TimedMediaHeavy` row never reports two holders.
The terminal domain fact may commit before the separate
idempotent `terminalize_operation` follow-up; replay sees that fact and finishes
the queue transition, but no stale claim can create it. There is one deletion
boundary, `settle_terminal_operation(ref, ownerTerminalProof,
deleteDomainStateAfterReceipt)`. It nonlocking-resolves the ref, acquires its
settlement gate first, re-resolves, locks queue then correlation and the
registered domain predicate. Queue and correlation must resolve through exactly
one closed arm: an exact present pair; both absent for a registered
`AwaitingDispatch` crash-gap transition whose admission has been fenced; or both
absent with the exact already-written coordination receipt/outcome and either
the matching retained terminal domain fact or registered receipt-only resolver
after domain deletion. The third arm is idempotent response-loss replay and
performs no transition/deletion again. A partial pair, receipt conflict, or any
other absence rejects. In one transaction the primitive verifies monotonic terminal truth or
runs one statically registered terminal transition that materializes the domain-
specific terminal receipt and any successor/dependency rows under those same
locks;
inserts/joins the immutable
`coordination_operation_terminal_receipts` row; links every existing terminal
dependency that names the ref; transitions the queue terminal if needed;
deletes correlation then job; and only then invokes the owner callback to
delete terminal domain-operation rows whose identity has been replaced by that
receipt. The callback is deletion-only: it may not create a successor, domain
outcome, dependency, or business mutation after the coordination receipt. A
domain-specific outcome receipt is evidence supplied to
`ownerTerminalProof`, never a substitute for the coordination receipt. Receipt
conflict, dependency-link failure, a partial queue/correlation pair, or owner
callback failure rolls back the entire settlement.

The only atomic multi-ref terminal-settlement/deletion port is
`settle_terminal_operation_set(refs, ownerTerminalTransitions,
deleteDomainStateAfterReceipts, authority)`. `authority` is the closed union
`WholeMediaTeardown(intentId) |
CaptionInitialPublicationTransfer(initialReservationId, transcriptionJobId,
workerId, attemptNo) |
CaptionInitialDeadlineFence(initialReservationId, transcriptionJobId,
preallocatedDeadlineSetId, preallocatedFenceGenerationId) |
CaptionInitialDeadlineFinalize(deadlineSetId, fenceGenerationId) |
OwnedAsrDeadlineFence(lifecycleOperationId, ownedAsrDataAllocationId,
transcriptionJobId, preallocatedDeadlineSetId, preallocatedFenceGenerationId) |
OwnedAsrDeadlineFinalize(deadlineSetId, fenceGenerationId) |
OwnedAsrDeadlineFinalizeForVideoCopy(deadlineSetId, fenceGenerationId,
videoComplianceSetId, videoFenceGenerationId) |
OAuthBindingDeadlineFence(bindingId, deactivationId,
rootLifecycleOperationId, preallocatedDeadlineSetId,
preallocatedFenceGenerationId) |
OAuthBindingDeadlineFinalize(deadlineSetId, fenceGenerationId)`; no caller-supplied
boolean or generic privileged mode exists. Teardown and Finalize resolve an
already-immutable plan/set;
`CaptionInitialPublicationTransfer` resolves exactly the reservation's
`YouTubeCaptionInitialLifecycle` ref and observed `TranscribeMedia` ref, takes
both settlement gates then both queue/correlation sets in canonical order, and
validates the caller's exact live TranscribeMedia claimant/attempt/lease plus an
unclaimed, settleable Initial target and the real-FK dependency. A claimed,
fenced, dead, missing, or mismatched Initial peer, or lost work lease, writes
nothing. It is the only authority that may terminalize both refs while
materializing initial caption publication; no caller may enter it after taking
the work claim locks.
`OwnedAsrDeadlineFinalizeForVideoCopy` additionally resolves the exact active
video-compliance parent member before locking. Each Fence instead resolves its
exact typed initial reservation/lifecycle plus allocation/work or deactivated-binding lifecycle
tuple before any set row exists, equality-checks the two preallocated ids, and
may only create that one typed set. The port sorts the
resolved stable OperationRefs, acquires **all** settlement gates, then all exact
queue/correlation and registered domain locks in the same canonical order. In
the common final phase each member must resolve through the singleton's exact
present-pair, fenced `AwaitingDispatch` both-absent, or already-settled exact-
receipt arm; a retained-domain child may therefore join without recreating its
queue. It runs every required terminal transition/dependency, materializes each
domain receipt before its coordination receipt, links every coordination
receipt, terminalizes every queue target, and removes every correlation/job
before invoking one deletion-only child-first callback while all gates remain
held. It is atomic: no prefix receipt/deletion commits.

`OwnedAsrDeadlineFence` and the two closed Finalize authorities are one coordination-owned,
two-invocation fence/finalize mode because compliance supersession cannot pretend that a dead, expired, or
currently running worker is a live owned claim. Its first invocation locks the
exact lifecycle plus allocation's unique `TranscribeMedia` ref, creates or
equality-joins the immutable two-ref deadline-set row and lifecycle -> work
terminal dependency and requests cancellation where possible. Existence of the
deadline-set row is the allocation's no-new-provider/result/publication fence:
every such acceptor locks the allocation and proves that row absent immediately
before its write or socket handoff; `fenceGenerationId` is never copied as a
fallible predicate.
It commits no terminal receipt and deletes no queue/domain row. It requests
process-group termination, installs the immutable DrainDue wake/current head in
that same commit, and returns `DeadlineFenceCommitted`; the supervisor never
waits inside this invocation. Termination acknowledgement may advance the wake,
and the persisted absolute horizon remains the fallback. A later Finalize
invocation reacquires every gate and lock from the sealed set, rejects a changed member
digest or any later writer, and requires every process/provider write path to
be terminal, content-free-settleable, or post-fence-rejecting before applying
the registered deadline transitions. Pending, running, dead, expired-lease,
and dispatch-uncertain members are accepted only by those typed transitions;
ordinary `with_owned_operation_claim_set` is forbidden. Response-loss replay
uses the already-settled receipt arm and cannot repeat deletion.

Ordinary `OwnedAsrDeadlineFinalize` rejects any active video-compliance parent
member. `OwnedAsrDeadlineFinalizeForVideoCopy` nonlocking-resolves the exact
parent set/member and includes their settlement gate/rows in the predeclared
lock set; it equality-checks both fence generations and is the only transition
allowed to perform the active-to-receipt-backed member conversion before its
deletion-only callback. A wrong/missing/second parent or invoking the ordinary
variant against a video-bound child writes nothing.

Nested singleton settlement, a late-added ref, second-parent substitution, or
callback lock acquisition outside the predeclared set rejects. Whole-Media
teardown and these two typed phases of the exact owned-ASR deadline mode are the
only v1 callers besides the two typed same-binding deadline phases below.
Opposing observer/second-parent, live/dead/expired caller, crash after fence and
at every receipt, response-loss replay, and crash-between-child-deletions proofs
demonstrate canonical lock order, late-write rejection, and full rollback.

`OAuthBindingDeadlineFence` is valid only after the account-gated deactivation
commit has made new binding lifecycle/use creation impossible while retaining
the active marker as a drain fence. It nonlocking-discovers the exact current
root plus every older nonsettled lifecycle for that binding, pre-acquires the
complete settlement-gate/queue/correlation set before the account/binding rows,
then creates the immutable deadline set, peer members, and root -> peer terminal
dependencies in one transaction. Row existence fences refresh result/head
publication; every acceptor locks the binding and rejects it. After durable
DrainDue wakes prove credential-use dispatches drained and processes terminated,
`OAuthBindingDeadlineFinalize` reacquires the sealed set and accepts pending,
running, dead, expired-lease, or already-settled exact-receipt members only
through registered deadline transitions. Each transition writes its binding
domain receipt before coordination receipt; the root receipt links the
revocation observer dependency. Only after all queue/correlation pairs are
removed does one deletion-only callback remove refresh results, active marker,
head, deadline peer/set rows, each binding-lifecycle current wake head ->
registrations -> typed sequence owner -> sequence -> typed operation arm ->
neutral schedule owner -> typed capacity -> neutral capacity allocation,
suspension children/lifecycle operations,
snapshots, selections/channel allocations and now-unreferenced credential-use
provenance, deactivation, and binding in restrictive-FK order. The revocation-
owned credential/secret is never deleted by this callback. Reversed dependency,
new member, live-use, wrong binding/generation, callback-order, and crash-at-
every-receipt proofs reject partial erasure.

Initial-caption source disposition uses the coordination-owned
`coordinate_caption_initial_source_outcome(authority)` port with the closed
authority `CaptionInitialNoDataAdvance(initialReservationId,
transcriptionJobId, workerId, attemptNo, nextSourcePlanSha256) |
CaptionInitialSourceFailed(initialReservationId, transcriptionJobId, workerId,
attemptNo, failureDigest) | CaptionInitialCancelled(initialReservationId,
transcriptionJobId, workerId, attemptNo)`. It nonlocking-resolves the exact
Initial -> TranscribeMedia dependency, takes both settlement gates and then
both queue/correlation sets in canonical order, validates the exact live owned
TranscribeMedia claimant/attempt/lease plus unclaimed settleable Initial ref,
then locks schedule/account/Media facts. `NoDataAdvance` writes/links and
terminalizes only the Initial ref while atomically advancing the still-owned
TranscribeMedia work to the pre-sealed next source; it cannot alter billing or
invent a source. `SourceFailed` writes the closed failure digest and
terminalizes both refs without fallback. `Cancelled` requires the exact durable
work cancellation and terminalizes both. Each writes domain receipts before
coordination receipts and runs Initial child-first cleanup only afterward. A
claimed/fenced/dead Initial peer, work lease loss, source-plan drift, or a race
with CaptionInitialDeadlineFence writes nothing. No singleton Initial
settlement may advance or fail TranscribeMedia.

The video-compliance nonterminal multi-ref handoff uses a different coordination-owned
port, `coordinate_video_copy_compliance_set(authority)`, with the closed
authority `VideoCopyComplianceFence(lifecycleOperationId, contentId,
preallocatedSetId, preallocatedFenceGenerationId, plannedRemovalId,
plannedRemovalAttemptId) |
WholeMediaTeardownAdoptVideoCompliance(teardownIntentId,
lifecycleOperationId, contentId, preallocatedSetId,
preallocatedFenceGenerationId, plannedRemovalId, plannedRemovalAttemptId) |
VideoCopyComplianceFinalize(setId, fenceGenerationId)`. It is not a
settlement/deletion shortcut. The teardown variant first proves the exact live
teardown intent owns the lifecycle's Media and may only equality-join an
existing fence or perform the identical one-time Fence transition for that
lifecycle; it cannot invent content, cleanup, removal, or receipt truth. Fence
nonlocking-resolves the video lifecycle, the complete registry-derived
content-bound `TranscribeMedia`/`YouTubeOwnedAsrLifecycle` refs, exact reserved
storage cleanup, and the exact existing-or-preallocated removal ref **before**
any Media lock. It sorts the full OperationRef set, acquires every settlement
gate then every existing queue/correlation, locks the singleton compliance
schedule gate plus this lifecycle's exact neutral/typed allocation, takes
`MediaJobAdmissionGate`, and only then locks
Media/head/Timeline/content. It re-runs discovery under those
locks; a new/missing ref causes a no-write retry with a newly complete set,
never a late lock. Exact equality inserts the typed immutable fence set/members,
the exact planned removal row/attempt, root -> child/removal dependencies, and
the realized-removal member in the **same** transaction, then installs the
content no-new-transcription/result/publication/removal-or-retry fence and
unpublishes only if the asset still names this content. The planned removal ref
is deliberately non-admissible while checkpoint is `FenceCommitted`; every
product command, startup repair, operator repair, and domain admission that can
create or retry a removal holds `MediaJobAdmissionGate`, rechecks the active
fence, and must join or reject this exact pair. There is no interval in which
Retry can make the immutable seal stale. The seal's exact
OperationRef algebra is `{ YouTubeVideoCopyLifecycle(root),
VideoCopyRemoval(plannedAttempt) } union for each owned-ASR allocation {
TranscribeMedia(work), YouTubeOwnedAsrLifecycle(lifecycle) }`, canonicalized as
length-prefixed `(operationKind, domainOperationId)` bytes sorted by the global
OperationRef order. The allocation schema and admission gate enforce at most
one current restricted owned-ASR allocation per video content, so `N in {0,1}`
and `operation_member_count in {2,4}`. The SHA-256 is over that exact byte
sequence, and the `N` active-or-settled typed member rows must equal it. A
pre-cut content with more than one live allocation blocks migration for explicit
convergence; none is discarded or guessed. The reserved `StorageObjectCleanup` is equality-bound separately by
its composite owner FK and is excluded because `Reserved` is not an
OperationRef. Zero/one-child, reordered, duplicate, count/row mismatch,
and late-member cases are release proofs. Fence commits no child terminal fact
or queue row and does not admit the realized removal.

Outside all root locks, the coordinator terminates bounded processes and invokes
each typed owned-ASR deadline fence followed by
`OwnedAsrDeadlineFinalizeForVideoCopy`. Its registered Finalize
transition first writes/equality-joins both domain compliance receipts and both
coordination receipts. Before the deletion-only child callback removes work,
allocation, or lifecycle rows, the same atomic set transaction inserts the
receipt-backed settled member with the exact two OperationRefs and both domain-
receipt composite FKs, then deletes the restrictive-FK active member. Exactly
one active-or-settled member per sealed pair exists throughout; conversion,
receipt, or FK-order failure rolls the whole child settlement back. The
settlement links the already-created video-lifecycle dependencies.
`VideoCopyComplianceFinalize`
then reacquires the **sealed** gate/queue/correlation set before Media, requires
every receipt-backed settled member and zero late writer, and changes `FenceCommitted ->
WritersSettled`. In the same transaction it revalidates the already-realized
planned removal/dependency/member, changes only the checkpoint to
`RemovalAwaiting`, and postcommit admission owns that **same** ref. It may not
create or replace a removal pair. A later Finalize invocation pre-acquires that sealed
removal ref too, requires the realized member, its coordination receipt, exact
removal completion, generic cleanup fence, and
storage absence, and writes `RemovalAbsent` plus the video-lifecycle domain
receipt. Only after that commit does ordinary
`settle_terminal_operation(YouTubeVideoCopyLifecycle(...))` create/link the root
coordination receipt and use a deletion-only callback to delete fence members/
set before the lifecycle operation. No phase discovers a ref after Media lock,
uses ordinary claim-set power over dead work, or deletes child operation state.
Changed writer membership, wrong content/cleanup/removal pair, late
publication, opposing ref order, dead/expired child, active-to-settled member
restrictive-FK order, crash/rollback at that conversion and every fence/child-
receipt/removal boundary, and response-loss replay are mandatory real-Postgres
proofs.

A later valid relationship
may join the retained receipt while creating its dependency; no owner may
manufacture a receipt from queue status alone. No domain owner or generic
pruner may remove only a correlation, job, or terminal domain operation.
Dead/suspended jobs retain their correlation. Content-free terminal receipts
are the stable post-settlement identity and retain no payload, user id, source
id, or provider fact; operation health is derived from terminal domain truth or
that receipt, not a retained succeeded queue row. Whole-Media
teardown enumerates domain operation refs first and asks the same port for its
stable queue set. Generic payload scans and direct domain-to-coordination FKs
are residue-gated. Stale-lease proofs cover copy verification/publication/
failure, reconcile absence, transcript publish/fail/cancel, input-probe
publication, and removal cleanup through this port. Migration maps each legacy
primary/supplemental, semantic, teardown, and storage-cleanup queue item to one
typed correlation only after exact payload/attempt/work agreement; zero or
multiple matches abort. Migration materializes a durable cleanup operation for
every pending/retryable/running/dead cleanup payload and uses the existing
teardown-intent id for every teardown row; a dead row gets its exact unresolved
suspension occurrence. Missing owners, duplicate live rows, payload/checkpoint
disagreement, or a nonterminal job without stable domain identity aborts with
ids. Terminal domain facts may clear stale legacy pointers without
manufacturing a correlation. Before recovery, an exact validated
`AwaitingDispatch` operation may have zero or one correlation; zero is legal
only for that state and is the designed crash-gap prefix. Startup first runs
the gated operation reconciler, which admits it or terminalizes it under
teardown. Only after convergence does the readiness inventory assert every
still-active operation has exactly one live/dead target and every
nonterminal/dead job has exactly one correlation; readiness refuses while a
zero-target operation remains. Real-Postgres proofs
cover duplicate admission, enqueue/notify commit, rollback/no-ghost-wakeup,
listener-disconnect plus startup-scan recovery, both sides of the domain/
correlation crash gap, terminal replay/pruning, terminal observation both
before and after settlement, rollback at receipt/dependency/job/correlation/
domain-delete boundaries, teardown/cleanup migration, and
ambiguous legacy mapping. Removal cleanup resolves
`VideoCopyRemoval(removalAttemptId)` by OperationRef, then strict-decodes and
equality-checks its payload; it never searches by payload containment. The
job's closed dispatch union gains a distinct removal arm beside
`StorageObjectCleanup(cleanupOperationId)` (whose domain owner union is
`Media | UploadSessionObjectGeneration | VideoCopyStorageObject |
LegacyTeardownSuccessor | MediaTeardownPath | OrphanDiscovery`):
`ownerKind: "VideoCopyRemoval"`, with strict payload
`{ operationRef: VideoCopyRemoval(removalAttemptId), mediaId }`. The handler
resolves path, removal id, write horizon, and checkpoint from the exact domain
attempt and equality-checks the routing media id; no mutable lifecycle truth is
duplicated in payload. It takes the owner-row lock on `media`,
live-owner recheck via `path_has_live_db_owner`, and domain completion
write-back through the removal completion/failure owners. The cleanup worker
records an outcome only when `removalAttemptId` is the latest attempt for a
`removalId` that resolves to the same immutable content record and path as its
payload. `path_has_live_db_owner` consults the current
asset -> content relation and explicitly does NOT treat the removal identity as
a live publication.

Every server-side object mutation is hard-cut through
`services/storage_remote_writes.py`; `storage/client.py`'s raw mutators become
private adapter ports callable only by that owner. Domain admission first
allocates/reuses one path-bound `storage_object_generations` row and inserts the
neutral immutable `storage_object_generation_producers` row plus exactly one
typed owner child: registered
`StableStorageProducerRef { operationKind, domainOperationId }`,
`UploadSessionObjectGeneration`, or `LegacyOpaqueStorageProducer`. The base
`producerGeneration` is monotonic within the object generation; zero or
multiple owner children is a readiness defect. A path may have several
producer rows because a creator, multipart abort, and later cleanup Delete are
different authorities. Immediately before
any socket handoff, an owned DB transaction takes the path/admission mutex and
inserts the next `storage_remote_write_generations` row with the canonical
request digest and composite FK to the exact neutral producer; that
committed row is the conservative armed boundary. The provider call occurs
without DB locks. A second owned transaction inserts its authenticated terminal
result only for a closed response that proves committed or definitively not
applied. Response loss, process death, timeout, or unknown response leaves the
armed generation without a result and categorically requires a provider-
terminal fence; observation of object bytes cannot prove that a late request
will not still complete. `StructuralNeverArmed` therefore means a sealed domain
writer set with zero remote-write rows—not a cleanup checkpoint—and the unused
`Armed` cleanup state is deleted.

`jobs/storage_write_capabilities.py` is the exhaustive checked registry for the
stable-operation owner arm, containing
`StorageProducerDefinition { operationKind, resolver, terminalPredicate,
authorizedMutationKinds, migrationOwner }`. Its resolver must return the exact
immutable producer operation or its content-free terminal receipt; a mutable
Media/path lookup is not identity. The static mutator inventory covers the single storage adapter plus every
production call site in `services/{remote_file_client,epub_ingest,
email_ingest_service,media_source_ingest,oracle_plates}.py`, upload signing in
`services/media_upload_sessions.py`, video multipart, and deletion owners in
`services/{media_source_ingest,library_governance}.py`. Every call site either
uses its existing immutable operation or is migrated to an explicit durable
producer operation before the raw call is made private; it then creates exactly
one neutral producer plus typed owner per authorized generation/path. Registry construction
compares AST call sites, producer-admission ports, operation resolvers/terminal
predicates, producer/typed-owner creators, object-generation composite FKs, and
runtime mutation kinds for exact equality. The UploadSession arm resolves by
its composite FK and the legacy arm by its path-bound composite FK rather than
being invented as queue OperationRefs. A new raw mutator/call site, a producer
with zero/multiple typed owners, a stable owner without one registry arm, or a
mutation kind outside its owner's closed capability fails release.
Real-FK proofs race two admissions for the same stable OperationRef/object/path
and prove one producer, then create two distinct producers for the same object/
path and reject pairing an UploadSession issuance or video dispatch subtype
with the other producer;
operation kind/id, producer, object generation, and path must all agree.
Delete/Abort calls use their cleanup/removal producer and have their
own armed/result evidence, so every armed mutation remains attributable and
rejoinable, but `DeleteObject` and
`AbortMultipart` are excluded from the creator-capable writer set because they
cannot materialize final bytes; every PUT/Create/part/Complete/presigned
capability is included. This adds one small durable arm/result pair per remote
mutation, accepted to make late-write authority computable.

Presigned upload issuance is itself an owned writer admission in
`services/media_upload_sessions.py` and the existing upload route/storage-
signing seam. Under the upload-session lock it first creates/joins the immutable
`storage_upload_session_object_generations` row for exact
`{uploadSessionId, uploadGeneration, path}` and its canonical object generation,
then allocates the next monotonically increasing
`credential_issuance_generation`. One transaction generates distinct ids and
inserts the generic `PresignedPut` remote-write generation plus an UploadSession
subtype linked through its unique `remote_write_generation_id`,
freezes path/method/content constraints, actual signing instant/expiry and
signing-key version, locally constructs the SigV4 URL, and stores the canonical-
request and URL digests before any response can
return it. Transaction failure means the local URL was never delivered; commit
followed by response loss remains conservatively a possibly delivered
generation. The same live idempotency decision reconstructs the exact URL from
those frozen inputs and retained signing version; after expiry the client uses
a new key, which allocates and records another issuance. No code signs or
returns a PUT credential without the committed row, and cleanup's owner/
admission mutex forbids another issuance once `DeleteRequired` begins. Raw
signed URLs remain absent from DB/log/replay bodies. Cleanup's UploadSession
owner binds this exact object-generation row and path through composite FKs,
never merely the mutable session. Writer-set derivation
includes every issuance row, not merely observed PUTs.

Pre-cut sessions do not retain enough facts to reconstruct exact historical
credential issuances: current generation/expiry can have been re-signed, and a
fabricated issuance or remote-write row would be false evidence. Current
issuance subtype rows therefore have no legacy discriminator and always carry
their real signing/request/URL facts. Maintenance
therefore requires zero live pre-cut UploadSessions and zero unaccounted
objects, or a provider-supplied terminal-path fence plus one canonical object
generation, `storage_legacy_opaque_producer_operations` row, neutral producer,
and legacy typed owner for every opaque path. That owner authorizes no new
mutation and becomes terminal only through the exact provider fence; migration
creates zero synthetic remote-write,
terminal-result, or issuance rows. Any other state aborts migration. Elapsed URL
expiry or a quiet drain alone is never proof. Every current issuance, opaque
legacy path, and ambiguous server mutation requires `ProviderTerminalPath`,
which is presently unavailable and keeps release `BLOCKED`. Proofs cover
sign-before-commit rollback, commit/response
loss, same-key reconstruction, new-key generation, signing-key rotation,
published-Media active/dead cleanup discovery, legacy migration,
issuance-vs-cleanup, and a late accepted PUT after apparent absence.

Incomplete multipart uploads are a separate mandatory precondition because
they are invisible to ListObjects and the ordinary orphan sweep. V1 deliberately
does not fabricate legacy ownership for them. After maintenance has stopped all
mutators, the deployed one-day multipart lifecycle has elapsed, and the signed
provider terminal fence covers every pre-cut Create/part/Complete request, the
release controller fully paginates authenticated `ListMultipartUploads` over
the exact controlled prefix. It commits the complete continuation-chain digest,
observation time, `upload_count=0`, canonical empty-set SHA-256, lifecycle-rule
digest, bucket/account identity digest, and terminal-fence digest to the
pre-mutation manifest. Migration immediately repeats the same read-only complete
LIST under maintenance before any DML and requires byte-equal empty truth. A
nonempty page, missing/repeated continuation token, path outside the controlled
prefix, response loss, drift between observations, or inability to prove no
late pre-cut Create aborts before mutation with the observed path/upload ids for
operator action. There is no “lifecycle will eventually clean it” waiver. The
release proof injects a Create response loss with no DB allocation and proves
that the untracked upload blocks until the lifecycle+terminal-fence precondition
and complete empty LIST are real.

Generic `StorageObjectCleanup` is likewise a two-transaction prepare/I/O/
settle protocol. Ordinary reservation under the typed owner lock inserts one
replay-stable operation plus exactly one owner-association child as
`AwaitingDispatch`; post-commit admission carries only `{ cleanupOperationId }`.
The video-object arm is the sole deliberate preactivation variant: the storage-
object reservation transaction creates its operation/typed owner as `Reserved`,
with no queue/correlation, and the B reconciliation/removal/teardown owner may
CAS it exactly once to `AwaitingDispatch` only after deletion/absence becomes
required. Startup recovery reaches it only through a registered parent intent;
teardown uses the separate reservation port below. Neither guesses from a path.
A `Reserved` row is not an active OperationRef and cannot
be claimed, settled, or pruned. The resolver
requires exactly one of Media/UploadSessionObjectGeneration/VideoCopyStorageObject/
LegacyTeardownSuccessor/MediaTeardownPath/OrphanDiscovery owner rows, derives the arm and real owner identity from that
child, and rejects zero or multiple arms before reading path/local horizon from
the neutral operation. The storage owner exposes one relational inventory whose
active and reserved projections union every path to Media: the direct Media
child, `MediaTeardownPath`, UploadSession when
its exact `published_media_id` references that Media, and
`VideoCopyStorageObject -> media_video_storage_objects.media_id`; FK-free legacy
and ownerless orphan arms cannot be guessed into the set. Teardown uses that
same union before deleting an upload session or video storage row, and activates
an exact reserved video cleanup before deleting any owner. Under its
owned claim, prepare locks the owner/operation, rechecks the exact path and
local horizon, and either (a) proves a committed exact live owner and records
terminal `Retained`, (b) reschedules while a local writer may still initiate a
request, or (c) records durable `DeleteRequired` only after exclusive no-owner
proof plus a `storage_object_cleanup_remote_write_fences` row. In that same
prepare transaction it takes the writer-admission mutex, allocates/joins the
current cleanup's noncreator Delete/Abort producer, seals the complete
path-bound object-generation member set, and derives the complete
**creator-capable** producer set only from the neutral producers plus their
exact typed-owner union and registry capability class. It hashes/counts only
canonical PUT/Create/part/Complete/presigned generations/results. Delete/Abort
producers and generations remain attributable operation history but are
categorically excluded from creator-producer terminality, count, and digest, so
the cleanup operation does not wait for its own later Delete. Deleting a
creator producer or typed owner, substituting another operation/object/path,
omitting a creator call-site owner, or changing the registry-derived capability
class makes topology unequal and blocks cleanup. That row is
`StructuralNeverArmed` only when every creator producer's typed owner is
terminal under its registered/composite-FK predicate, every creator producer
has zero armed creator-capable mutations, and no opaque legacy producer exists;
`AllKnownWriteGenerationsFenced` only when every member's every creator-capable
remote-write generation has an authenticated terminal result, every typed
creator producer is terminal, and the canonical creator-producer/owner/writer-
set digest matches;
and `ProviderTerminalPath` for an ownerless/legacy
path or an UploadSession/presigned/ambiguous server-write path only under a
deployed provider contract that closes
every outstanding write to that exact path. Issuing a presigned UploadSession
PUT URL itself creates one durable potential-writer generation; because Nexus
cannot observe whether the client handed it to R2, URL expiry is not a dispatch
or terminal fence. The generation remains armed until `ProviderTerminalPath`
proves that an accepted pre-expiry PUT cannot complete later. A timestamp,
expired presigned URL, local TERM/socket timeout,
LIST omission, or owner-row absence is not a fence. It then commits. External
DELETE and bounded HEAD run with no DB lock/transaction; DELETE success or
`NotFound` alone is not settlement, and response loss repeats HEAD rather than
inventing absence. Settle reacquires the exact claim and owner locks,
revalidates unchanged operation/path/local horizon/fence and absence of a newly
authorized creator. It re-derives the unchanged exact creator set; additional
same-cleanup Delete/Abort evidence neither satisfies nor invalidates that fence.
It records `Deleted`/terminalizes only in the same transaction that inserts or
equality-joins the sole generic object-absence fact for an authenticated exact
`HEAD NotFound` observed after that fence and multipart settlement. That fact
binds the HEAD request/response/provider-request digests and the complete sealed
object-generation count/digest; its member rows prove every generation covered.
Claim loss or drift writes nothing; the
next owner resumes `DeleteRequired`. The owner admission mutex rejects new
writes while that arm is held. `Media`, `UploadSession`,
`VideoCopyStorageObject`, FK-free `LegacyTeardownSuccessor`,
`MediaTeardownPath`, and `OrphanDiscovery` each have an exhaustive owner
resolver/terminal predicate; the legacy arm uses no Media lookup.
Schema/adversarial proofs reject zero/multiple owner arms and cross-Media
discovery. Expected storage dependency failure never terminalizes mandatory
cleanup: the same operation reschedules with bounded backoff until `Retained`
or fenced `HEAD NotFound -> Deleted`. If current R2 cannot produce a required
path/write-generation fence, the operation stays discoverable and readiness
fails closed rather than converting elapsed time to absence. Unexpected dead
work retains suspension/correlation for same-job repair.
Real-Postgres+MinIO proofs cover Retained proof, delete-response loss, stale
lease, late-write response races, writer/teardown races, all six owner arms,
Delete/Abort rows both before and after creator-fence insertion, registry
capability-class drift, two dead/requeue cycles, and DB/object convergence;
deployed-R2 certification,
not MinIO, owns remote-fence capability.
The present R2 documentation supplies no such terminal-path operation, so both
ambiguous canonical server mutations and every issued UploadSession PUT make this release
gate `BLOCKED`; video-only smoke tests cannot certify the generic path.

`storage_orphan_sweep` is hard-cut to discovery-only. It may page the controlled
prefix, but it never directly deletes, HEAD-settles, or treats its continuation
payload as lifecycle authority. Under the path advisory lock, each observed
object first re-runs the exhaustive `path_has_live_db_owner` query. A current
asset, upload, reserved writer, teardown path, or other registered owner skips
candidate creation entirely; the generic cleanup's later recheck remains the
race-closing authority. Only an ownerless observation canonicalizes
`{path, ETag, size, lastModified}` and either joins the one
unresolved candidate/cleanup or allocates the next immutable
`discovery_generation`, `OrphanDiscovery` child, and
`StorageObjectCleanup(cleanupOperationId)` as `AwaitingDispatch`; postcommit
coordination admits that ref. If a prior generation is terminal but the path is
observed again, object existence itself requires a new generation even when
ETag/bytes match. The generic cleanup owner then proves `ProviderTerminalPath`
before DELETE/HEAD. Scanner death before/after candidate, owner, and correlation
commit converges to exactly one operation for the observed generation. Direct
DELETE imports, path-only already-seen suppression, and destructive orphan
payload checkpoints are residue-gated.

`jobs/media_write_capabilities.py` is a checked-in exhaustive registry over
every production `JobDefinition`, classified as `None |
StableOperationRef { kind, resolver, terminalPredicate,
discoverActiveByMedia } |
StableOperationRefSetScanner { scanners:
NonEmpty<StableOperationRefScannerArm { operationKind, discoveryOwner,
exactRefPort }> } |
DurableFanOutScanner { discoveryOwner, replayIdentity,
childOperationKinds: NonEmpty<OperationKind>,
existingRefScannerArms: tuple<StableOperationRefScannerArm>, admitPort } |
ProvenPostDeleteNoOp { proofOwner }`. Registry construction fails when a job
kind is missing, duplicated, or claims a Media id/persists a Media-owned child
without the stable-ref arm. Every Media-bound entry supplies a read-only
`discoverActiveByMedia(mediaId) -> ascending OperationRef[]` that returns domain
`AwaitingDispatch` rows even with zero correlation plus all correlated live/
dead nonterminal refs; it categorically excludes `Reserved` rows. Separately,
`jobs/storage_write_capabilities.py` owns the closed
`discoverReservedCleanupByMedia(mediaId) -> ascending
CleanupReservationRef[]` port. A reservation ref is exact
`{cleanupOperationId, ownerKind=VideoCopyStorageObject, storageObjectId,
objectGenerationId, path}` and is never cast to OperationRef. Under the Media
admission gate, teardown compares that complete set to its path plan, inserts
the observer dependencies, and CAS-activates every required reservation before
ordinary active-ref discovery/admission; removal/reconciliation activate only
their composite-FK exact reservation. Startup first discovers the registered
parent removal/reconciliation/teardown intent and invokes that same activation,
never all reservations. Crash before/after CAS and correlation, exact-set drift,
and teardown-vs-activation races prove one cleanup and no invisible ref.
Teardown never discovers from queue payload. Account-
scoped OAuth entries declare Media discovery NotApplicable and supply the
parallel user-erasure discovery owner. Its equality proof compares the registry with the
actual production topology and statically inventories payload decoders, Media
FK writes, and provider/billing dispatch sites. The cut specifically migrates
the pre-existing `media_content_reindex_job`, `enrich_metadata`, and
`media_unit_build` jobs to their refs above; a running/dead row with no unique
owner mapping blocks release. `ProvenPostDeleteNoOp` requires a same-transaction
missing/teardown recheck before any provider call, charge, or write and is not a
convenient exemption. Whole-Media teardown uses this registry, not a hand-kept
list, and the barrier proof races every `StableOperationRef` writer plus each
post-delete-no-op proof against deletion.
The registry proof seeds one zero-correlation `AwaitingDispatch` row for every
Media-bound kind plus correlated pending/running/dead rows and asserts exact-set
equality before deletion; static owner equality fails if a new domain operation
table lacks discovery.
Set-scanner construction also rejects an empty tuple or duplicate operation
kind. Discovery normalizes each arm to ascending refs, unions/deduplicates, and
sorts canonically by `(operationKind, domainOperationId)` before promotion; the
registry/topology equality proof asserts the exact ordered arm tuple.

`DurableFanOutScanner` is the only scanner class allowed to create child domain
operations. It may perform read-only discovery, but for each candidate it must
commit a replay-stable child `AwaitingDispatch` identity through that child's
ordinary admission gate before postcommit coordination enqueue; queue payload
is never the child identity. Its declared child-kind set and existing-ref arm
set must independently equal static DML and runtime topology.
`storage_orphan_sweep` declares child kind `StorageObjectCleanup`, uses
`(path, discovery_generation)` replay identity, and declares
`existingRefScannerArms=(ReconcileVideoCopy,)` for its separate promotion of
already-existing reconciliation refs. Existing-ref discovery cannot masquerade
as child creation.
`reconcile_stale_ingest_media_job` declares exactly `PrimaryMediaIngest |
MediaContentReindex | MediaTranscriptReindex`, uses each existing owner gateway,
and cannot enqueue first. Kill/replay proofs at discovery, child-domain commit,
and correlation admission—including concurrent Media teardown—prove one child
per exact candidate and no post-delete writer. A fan-out job classified as
read-only, `None`, or `ProvenPostDeleteNoOp` is a registry-construction defect.

`provider_compliance_sweep` is not a queue JobDefinition and cannot compete
with deadline work for a slot. It is the read-only function behind an exhaustive
`ProviderComplianceLaneScannerRegistry` partitioned exactly as VideoCopy ->
`YouTubeVideoCopyLifecycle`, Caption -> `YouTubeCaptionInitialLifecycle |
YouTubeCaptionLifecycle`, OwnedAsr ->
`YouTubeOwnedAsrLifecycle`, and OAuth ->
`YouTubeOAuthAuthorizationAttemptExpiry | YouTubeOAuthExchange |
YouTubeOAuthPendingExpiry | YouTubeOAuthBindingLifecycle |
YouTubeCredentialRevocation`. Every one of the five
`worker-provider-compliance` processes runs a supervisor-owned control loop
concurrently with, and outside the capacity accounting of, its task executor.
The loop scans only its configured lane at process startup, before every task
claim, and from an independent monotonic watchdog whose start-to-start cadence
is no greater than 60 seconds even while a handler is running. The two
VideoCopy processes share a lane advisory lease so duplicate scans are benign;
the other lanes have one process each. A missed cadence makes that process and
global readiness unhealthy, and restart performs an immediate scan before
claiming. There is no sixth scheduler process, durable sweep job, ad-hoc cursor,
or cross-lane borrowing.

Each lane arm returns ascending exact refs that are due, missing a correlation,
or dead through a mandatory deadline; it performs no DML, provider call,
billing, or payload mutation. For each ref it calls the coordination-owned
refresh/promotion, typed expiry, or bounded `RemoteUnconfirmed` port, which
applies all queue/correlation/domain locks and mutations above. The scanner
registry, runtime lane identity, execution-slot table, and deployment topology
must be exact-set equal. Fake-clock/process proofs saturate and kill each lane
executor and its control loop independently, assert every live replacement
scans before claim, and prove observed cadence never exceeds 60 seconds.

All compliance waits are durable fact transitions, never a worker sleep,
mutable lifecycle enum, or polling loop. A Fence transaction inserts the
domain's narrow immutable fence fact, creates/joins the neutral exact-operation
wake sequence plus its one typed schedule-owner arm, inserts the next immutable
`provider_compliance_phase_wake_registrations` row, and replaces the one
`provider_compliance_current_phase_wakes` head,
atomically schedules the same OperationRef for `due_at` through coordination,
and returns within the JobDefinition wall timeout. State is derived from the
fence/terminal facts and the current wake's immutable `phase_fact_kind`; no
shared status or nullable phase cluster is authoritative. A typed local
process-termination, provider-terminal, cleanup/removal receipt, or dependency
event may atomically insert a higher wake generation with an earlier due time,
swap the current head, and wake the same ref; old registrations remain
append-only evidence only while their restrictive-FK wake sequence and typed
schedule owner are live, and the lane watchdog is the bounded lost-event
fallback.
Finalize is always a later invocation that rechecks the current registration,
generation, composite-FK placement snapshot, equality with the current
schedule's neutral allocation placement, complete remaining tail, and
authoritative terminal facts. It
either inserts the next fact/wake and atomically removes the predecessor head
or settles; it never holds a process through the 14,400-second transcript
horizon, TERM/KILL grace, provider bound, or recovery allowance.
Every handler invocation must complete below its declared 300/900-second wall.
Proofs kill immediately before/after Fence plus atomic reschedule, keep the host
offline through the full writer horizon, lose every early event, and require
startup/watchdog recovery, no backoff-derived deadline, no duplicate Finalize,
no zero/two typed wake-sequence owner arms, cross-sequence/operation
substitution, stale/cross-lane/cross-input placement rejection, and no committed fence without
exactly one future wake or terminal receipt. Terminal callbacks delete current
head -> every registration -> typed sequence-owner arm -> sequence before the
schedule/domain parent; Media/account erasure proves zero residual wake rows.

All OAuth deadline refs use the reserved `OAuth` compliance slot rather than an
unbounded `worker-background` queue. `YouTubeOAuthConnectionGate` enforces
`YOUTUBE_OAUTH_MAX_ACTIVE_DEADLINE_REFS=12`,
`YOUTUBE_OAUTH_EXTERNAL_ADMISSION_LIMIT=8`, and
`YOUTUBE_OAUTH_INTERNAL_SUCCESSOR_HEADROOM=4` over the exhaustive scanner
union. Before an outbound Start or ordinary refresh can create a capability,
secret, or provider request, the schedule/account transaction requires
`activeDeadlineRefCount + YOUTUBE_OAUTH_EXTERNAL_NEW_ROOT_COUNT(1) +
YOUTUBE_OAUTH_INTERNAL_SUCCESSOR_HEADROOM(4) <= 12`; exceeding that bound
returns typed
`ComplianceCapacity` with no mutation. The just-created durable root ref and
the account-gate invariant are distinct from the four reserved internal
overlap positions needed
by the widest authorization-expiry -> exchange -> pending/binding ->
revocation transition chain. Internal callback, expiry, selection,
disconnect, revocation, and erasure transitions therefore create/join their
successor schedule before releasing a predecessor and cannot capacity-fail;
they may temporarily own the bounded predecessor-and-successor prefix instead
of pretending it is a swap. Under the singleton
schedule gate, each active ref owns one neutral `OAuth` capacity allocation and
neutral schedule owner plus exactly one of the five FK-backed typed arms
(`AuthorizationAttemptExpiry | Exchange | PendingExpiry | BindingLifecycle |
CredentialRevocation`). Zero/multiple arms, an operation-kind/domain-id mismatch,
or a typed child pointing at another operation blocks admission/readiness. The
restrictive typed FK prevents domain deletion while capacity is still owned.
Deadline acceleration creates a new placement/revision,
atomically swaps the owner, then deletes the old neutral allocation. The common
backlog bound is:

```text
PROVIDER_COMPLIANCE_OAUTH_RECOVERY_INVOCATION_CEILING = 4
PROVIDER_COMPLIANCE_OAUTH_MAX_HANDLER_WALL_SECONDS =
  max(YOUTUBE_OAUTH_BINDING_LIFECYCLE_WALL_TIMEOUT_SECONDS(900),
      YOUTUBE_CREDENTIAL_REVOCATION_WALL_TIMEOUT_SECONDS(300),
      YOUTUBE_OAUTH_EXCHANGE_WALL_TIMEOUT_SECONDS(300),
      YOUTUBE_OAUTH_EXPIRY_WALL_TIMEOUT_SECONDS(300)) = 900

PROVIDER_COMPLIANCE_OAUTH_RECOVERY_SECONDS =
  PROVIDER_COMPLIANCE_OAUTH_RECOVERY_INVOCATION_CEILING(4) *
    (PROVIDER_COMPLIANCE_OAUTH_MAX_HANDLER_WALL_SECONDS(900) +
     PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60)) = 3840

PROVIDER_COMPLIANCE_OAUTH_PER_REF_SECONDS =
  PROVIDER_COMPLIANCE_OAUTH_MAX_HANDLER_WALL_SECONDS(900) +
  BACKGROUND_PROCESS_TERM_GRACE_SECONDS +
  BACKGROUND_PROCESS_KILL_GRACE_SECONDS +
  PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60) +
  PROVIDER_COMPLIANCE_OAUTH_RECOVERY_SECONDS(3840)

PROVIDER_COMPLIANCE_OAUTH_QUEUE_MARGIN_SECONDS =
  PROVIDER_COMPLIANCE_SWEEP_INTERVAL_SECONDS(60) +
  YOUTUBE_OAUTH_MAX_ACTIVE_DEADLINE_REFS(12) *
    PROVIDER_COMPLIANCE_OAUTH_PER_REF_SECONDS
```

Each schedule revision stores absolute fence/drain/finalize/settlement cutoffs;
claim, scanner promotion, provider handoff, and replay reject a missed cutoff or
insufficient remaining tail. Release/fake-clock proofs run the complete 12-ref
same-deadline cohort on the sole slot, including simultaneous binding
deactivation, caption/ASR promotion onto their separately reserved lanes, and
zero cross-lane borrowing.

Every registered OAuth terminal callback uses the generated order current wake
head -> all wake registrations -> typed sequence owner -> wake sequence ->
typed OAuth operation arm -> neutral OAuth schedule owner -> typed OAuth
capacity allocation -> neutral capacity allocation -> domain operation.
A transition that creates an OAuth successor first creates its capacity/
schedule/typed arm under the same schedule+account transaction, then removes
the predecessor arm/owner/allocation when its replay contract permits; exact
root/headroom revalidation forbids a thirteenth prefix while never denying an
internal convergence transition. Response-loss replay joins the already-created
successor and cannot leak another allocation. Proofs run more than 12 complete start/deny,
exchange/pending, binding-refresh/disconnect, and revocation cycles, crash at
every swap/delete, and reject zero/two arms plus cross-kind/cross-operation
substitution while the active count returns to its true value. A focused
headroom proof retains seven denial replay-expiry refs, admits the eighth
external Start, drives callback plus every legal successor overlap, and races
rapid Connect/select/disconnect without any internal capacity failure.

`youtube_oauth_authorization_attempt_expiry` and
`youtube_oauth_pending_expiry` are Light `StableOperationRef` JobDefinitions
with strict payloads `{ expiryOperationId }`, literal job-kind self-checks,
`deadline_lane_policy=StaticCompliance { laneKind=OAuth }`,
`max_attempts=8`, `retry_delays_seconds=(5,15,60,300,900,1800,3600,3600)`,
`lease_seconds=60`, `heartbeat_interval_seconds=5`,
`YOUTUBE_OAUTH_EXPIRY_WALL_TIMEOUT_SECONDS=300`, and
`never_prune_dead=True`. The shared timing owner commits
`YOUTUBE_OAUTH_ATTEMPT_TTL_SECONDS=600`,
`YOUTUBE_OAUTH_PENDING_TTL_SECONDS=600`, and
`YOUTUBE_OAUTH_TRANSIENT_COMPLIANCE_MARGIN_SECONDS =
PROVIDER_COMPLIANCE_OAUTH_QUEUE_MARGIN_SECONDS`; each hard deadline is
its expiry plus that margin and includes the 60-second scan/claim/termination
budget. The authorization owner needs no external I/O: its owned account-gated
transition derives one of two phases, never a mutable status.
`AwaitingCallback` has an awaiting row and no tombstone; at attempt expiry it
invokes `settle_terminal_operation`; its registered transition writes `Expired |
UnusableStart | Erased` before the coordination receipt, and its deletion-only
callback deletes active marker, browser binding, PKCE hold/material, awaiting
row, then the expiry typed schedule arm/owner/capacity allocation, operation,
and neutral attempt in the same transaction.
`ReplayRetention` has one tombstone and no awaiting row; the same ref stays
nonterminal and is promoted to `replay_delete_due_at`. At that instant it
uses the same primitive; its registered transition writes
`DeniedReplayExpired | CallbackReplayExpired` before the coordination receipt,
and its deletion-only callback deletes browser binding/tombstone, the expiry
typed schedule arm/owner/capacity allocation, expiry operation, and
a Denied neutral attempt, while a transferred attempt is deleted only when no
exchange/allocation FK still owns it. Restrictive-FK and replay proofs cover desktop and Custom Tab at
awaiting expiry, denial retention, transferred replay retention, and deletion.
It never deletes PKCE material now held by exchange and never terminalizes at
callback commit. The pending owner performs no provider I/O: when due, it uses
the same settlement primitive/`PendingExpired` callback specified by the
endpoint contract, then admits revocation postcommit. Selection/cancel races
take the settlement gate before queue/correlation and the account gate. Before
deadline dead work uses same-ref repair. At the hard deadline the typed scanner
uses that primitive's declared deadline transition to cancel/fence a pending,
running, expired-lease, or dead target before deleting authorization material
or transferring pending credentials. It never substitutes
elapsed time for row deletion. Failure to complete real cleanup keeps readiness
blocked and the same operation discoverable. Account discovery includes both families, and account erasure must
terminalize/transfer them before deleting their user.

`youtube_oauth_exchange` is a separate Light `StableOperationRef` JobDefinition
with strict payload `{ exchangeIntentId }`, a single provider attempt, and the
neutral credential/exchange terminal predicates above. Its cleanup due/deadline
are bounded by the awaiting-callback expiry plus the same transient margin. Its
definition uses `deadline_lane_policy=StaticCompliance { laneKind=OAuth }`,
`max_attempts=1`, no provider retry,
`lease_seconds=60`, `heartbeat_interval_seconds=5`,
`YOUTUBE_OAUTH_EXCHANGE_WALL_TIMEOUT_SECONDS=300`, and
`never_prune_dead=True`. Before
deadline it uses same-ref repair. At deadline the scanner fences/supersedes any
pending, running, expired-lease, or dead correlation through the settlement
gate and bounded supervisor termination before terminal settlement. A committed result necessarily includes the
same-transaction refresh-ciphertext hold; a committed dispatch intent without
that pair resolves only to `UnrecoverableRemoteGrant`, never resubmits and never
pretends Postgres can recover a token lost before commit. The transition moves
any refresh hold to the exact pending or revocation successor, atomically
deletes the unique active-attempt marker plus code and PKCE holds/materials,
writes `PendingSelectionCreated | UnrecoverableRemoteGrant |
Cancelled | Expired | Erased`, then invokes the settlement primitive before
deleting its typed schedule arm, neutral schedule owner, capacity allocation,
and exchange operation in that order. Missing KEK, AEAD failure, or
provider ambiguity is not converted into cleanup success; the security incident
keeps readiness blocked until the exact encrypted rows are safely disposed.
An account-scoped
`YouTubeOAuthConnectionGate(userId)` serializes start/callback/pending/binding/
revocation ownership; domain admission commits `AwaitingDispatch`, and the
postcommit/startup reconciler reacquires that gate before canonical queue+
correlation admission. `youtube_credential_revocation` is likewise a Light
`StableOperationRef` job with strict payload `{ revocationId }`,
`deadline_lane_policy=StaticCompliance { laneKind=OAuth }`,
`max_attempts=10`,
`retry_delays_seconds=(60,300,900,3600,21600,43200,86400,172800,259200)`,
`lease_seconds=60`, `heartbeat_interval_seconds=5`,
`YOUTUBE_CREDENTIAL_REVOCATION_WALL_TIMEOUT_SECONDS=300`, and
`never_prune_dead=True`. Admission requires
`compliance_delete_deadline <= requested_at + 7d` and
`retry_until <= compliance_delete_deadline -
YOUTUBE_CREDENTIAL_REVOCATION_COMPLIANCE_MARGIN_SECONDS`; that named margin is
exactly `PROVIDER_COMPLIANCE_OAUTH_QUEUE_MARGIN_SECONDS`, and startup/release
reject a nonpositive or schedule-drifted margin. Every remote
retry is capped by `retry_until`. A missing
correlation is admitted, a dead claim before deadline remains suspended for
same-job repair. At `retry_until`, the due transition first acquires the
settlement gate, locks queue/correlation/account, prevents any new credential-
use or revocation dispatch arm, records cancellation for a pending/running/
expired-lease/dead target, and fences the exact claimant/attempt. It releases DB
locks after atomically inserting the DrainDue wake at the bounded 300-second
request horizon plus TERM/KILL grace, requests termination, and returns. An
acknowledgement can wake the same ref early; otherwise a later watchdog-driven
invocation resumes at that absolute due time. Only after no local request owner remains does
`settle_terminal_operation` recheck the fence and absence of any live dispatch,
delete the refresh hold/material, write the content-free `RemoteUnconfirmed`
domain receipt, and remove its typed schedule arm/owner/capacity plus operation/
queue state atomically, leaving the full
recovery margin to prove ciphertext absence before the hard deadline. A late
provider response cannot reacquire the fenced attempt or write a result. Proofs cover
callback/cancel/disconnect replay, death before/after correlation, revoke
success/already-invalid/response loss, pending/running/expired/dead at cutoff,
late provider response, every settlement boundary, two dead/requeue cycles,
dead through deadline, and encrypted-hold/material equality.

`youtube_oauth_binding_lifecycle` is a Light `StableOperationRef` JobDefinition
with strict `{ lifecycleOperationId }`,
`deadline_lane_policy=StaticCompliance { laneKind=OAuth }`, `max_attempts=5`,
`retry_delays_seconds=(60,300,900,3600)`, `lease_seconds=300`,
`heartbeat_interval_seconds=30`,
`YOUTUBE_OAUTH_BINDING_LIFECYCLE_WALL_TIMEOUT_SECONDS=900`, and
`never_prune_dead=True`. Refresh is due no later than day 28. Its hard
Authorized-Data deadline is the minimum of snapshot day 30, approval expiry,
credential revocation, user erasure, and any stricter disposition. The owner
sets `purge_due_at <= compliance_delete_deadline -
PROVIDER_COMPLIANCE_OAUTH_QUEUE_MARGIN_SECONDS`; startup/release
reject a nonpositive margin. Before purge, dead work uses same-ref repair. At
purge/deadline the account-gated first transaction inserts/joins the exact
deactivation/revocation reason but retains the active marker as the no-new-use
drain fence. The scanner then calls `OAuthBindingDeadlineFence` with
preallocated set/fence ids; coordination pre-resolves every nonsettled lifecycle
generation for the same binding, acquires the complete canonical settlement/
queue/correlation set before any account row, and seals/fences that exact set.
After all credential-use dispatches and local processes are terminal outside DB
locks, `OAuthBindingDeadlineFinalize` writes every lifecycle domain receipt then
coordination receipt and performs the one restrictive-FK deletion callback
specified by the central port. It never uses ordinary claim-set authority for a
dead/expired ref and never directly erases an operation or correlation. It
needs no Media lock; each restricted publication is separately promoted through
its per-Media lifecycle. No caption route reads Authorized Data at or beyond the
deadline, and API readiness remains disabled until startup proves the account
rows absent.

The three pre-existing Media writers are not papered over by that registry.
Their immutable operation rows own `AwaitingDispatch`; the correlation owns
queue health; and lifecycle-specific child facts own completion, classified
failure, cancellation, unexpected suspension, and—where external work exists—
dispatch intent, authenticated completion, or unresolved uncertainty.
Content/transcript reindex use the exact embedding-batch protocol above and
account-owned `embedding_usage_charges`; metadata enrichment references its
existing immutable `agent_turns` native-subscription ledger; unit build
references the existing `llm_calls` BilledOnce ledger. Each intent records the
authorizing user/context before dispatch. Provider/session reference,
request/response SHA-256, normalized usage, and audit identity move out of queue
payload/step journals into the appropriate exact domain child plus its sole
ledger owner before old payload fields are deleted. An uncertainty has one
authenticated owner-specific resolution and cannot be requeued; an unexpected
dead claim has one same-job repair occurrence and cannot create a replacement
operation. Content reindex has no generative-LLM arm, but every hosted embedding
batch has the non-idempotent intent/result/uncertainty protocol; the operation
is superseded only by an immutable cancellation when its exact revision is no
longer current. Enrichment/build publication runs through the owned-claim
fence, rechecks Media plus teardown immediately before the provider call and
again before DB publication, and discards an authenticated recovered result
after deletion intent while retaining account-level charge/audit facts.
Teardown cancels unclaimed operations, requests cancellation of claimed ones,
waits for authenticated resolution of uncertainty, and blocks on dead work
until same-job repair; it never deletes evidence to manufacture terminality.

Migration joins every status of those three legacy kinds, plus the renamed
transcript-semantic kind, by exact media,
revision/fingerprint/summary generation and step-journal facts. It creates one
operation/correlation and moves complete dispatch evidence losslessly; zero or
multiple matches, mutable-summary aliasing across fingerprints, an uncertain
payload without its request digest, or a running/dead row with no exact owner
aborts. Under maintenance with zero running claims, only a zero-execution
pending legacy row may become runnable. Any pending/retryable/dead row with an
attempted external dispatch predating the new fence becomes non-runnable
`LegacyPreFence`, preserves its opaque audit bytes, gains an unresolved
dispatch uncertainty, and requires authenticated recovery or charged-no-result
resolution; it is never automatically resubmitted. Real-Postgres/provider-fake proofs cover stale revision/fingerprint,
claimed and dead predecessor work, response loss, charge settlement,
replacement, teardown before dispatch/after dispatch/before publication,
recovered-result suppression, and terminal correlation pruning. This wider
coordination migration is deliberate: a hard teardown guarantee cannot safely
exclude older writers merely because video did not create them.

Playback-ticket authorization repeats viewer access and exact asset currency.
The signed URL exists only as the ticket service's return value and the HTTP
response body — never assigned to a variable that reaches a logger, never
stored in a row or replay memo, never embedded in an exception, never in
`MediaOut`; `url`/`signed_url`/`playback_url`/`location` join
`redact.py::FORBIDDEN_KEYS` so a future `safe_kv` call site raises in
dev/test, and the C proof asserts no captured log record or persisted row
contains `X-Amz-Signature`. The visible URL path contains only the random
object-key suffix; it is not an authority token, and signatures authorize but
do not conceal paths, so Media,
attempt, Timeline, user, and removal UUIDs must not occur in it.

Owned-video delivery is a no-CORS media fetch: the committed R2 CORS policy
already permits `GET`/`HEAD` with the `range` request header and exposes
`ETag`/`Accept-Ranges`/`Content-Range`/`Content-Length`, and
the existing CORS files are unchanged (the separate multipart lifecycle files
are added). The `<video>` element
must NOT carry a `crossorigin` attribute — that would turn every range
request into a CORS request and couple playback to bucket policy. The binding
browser constraint is CSP: the storage origin is named explicitly in
`media-src` — the deployed R2 origin joins `mediaOrigins` in
`apps/web/src/lib/env.ts`, and the local/test build emits the MinIO endpoint
into `CSP_MEDIA_ORIGINS` via `nexus_test_control/build.py`; the D proof
asserts an owned-video element loads locally with zero CSP violations.

Owned objects are written with `Content-Type: video/mp4`,
`Content-Disposition: inline`, and `Cache-Control: private, no-store`, applied at write time through new
explicit `content_disposition`/`cache_control` parameters on the storage
client's upload path (defaulting absent for existing callers). This deliberately
trades browser range-cache efficiency for truthful privacy/removal semantics in
the one-user product. The playback-ticket JSON response is also `no-store`.
Nexus cannot erase bytes a user agent has already buffered or downloaded; DB
unpublication plus verified R2 deletion prevents future ticket issuance and
future S3-origin reads, which is the exact revocation claim.

Ticket lifetime is owned by dedicated settings
(`VIDEO_PLAYBACK_TICKET_MIN_SECONDS`, `VIDEO_PLAYBACK_TICKET_MAX_SECONDS`,
`VIDEO_PLAYBACK_TICKET_EXPIRY_SAFETY_MS=60_000`)
with the derived formula `clamp(durationMs / MIN_PLAYBACK_RATE + 15m, 30m,
profile max duration / MIN_PLAYBACK_RATE + 15m)` (8h15m at the v1 4h/0.5x
caps), so one ticket always covers a full uninterrupted watch of any video
inside the profile cap; `_validate_storage_lifecycle` rejects
`VIDEO_PLAYBACK_TICKET_MIN_SECONDS*1000 <=
VIDEO_PLAYBACK_TICKET_EXPIRY_SAFETY_MS`, max < min, safety <= 0, or max above
the SigV4 presign ceiling; boundary proofs use that exact conversion.
Every ticket request records `requestStartedMonotonicMs` and
`responseReceivedMonotonicMs`; the strict response decoder requires server
instants with `expiresAt > serverIssuedAt` and derives, without consulting the
client wall clock, `localSafeDeadlineMs = responseReceivedMonotonicMs +
(expiresAt-serverIssuedAt) - (responseReceivedMonotonicMs-
requestStartedMonotonicMs) - VIDEO_PLAYBACK_TICKET_EXPIRY_SAFETY_MS`.
A nonpositive remainder is expired on arrival. Subtracting the full RTT plus
the fixed skew/signing safety is deliberately conservative. `SIGNED_URL_EXPIRY_S` is
untouched and keeps governing document URLs. For `Ordinary | Tracked`
`OwnedVideo` only, activation and every paused-to-playing transition compare
the ticket's remaining lifetime with worst-case remaining media time at 0.5x
plus 15 minutes. If insufficient, that engine fetches and installs a
replacement while still paused, captures `{ currentTime, paused,
playbackRate }`, restores them after `loadedmetadata`, and suppresses the
`emptied` reset for the in-flight swap. This chooses a longer bounded bearer
lifetime over repeated, disruptive `src` swaps; `no-store` and physical
deletion constrain the risk. A ticket is never reused across sessions. On a
media error, exactly one silent re-ticket/source-recovery is attempted for
those two profiles when the ticket is expired or inside its refresh window.
An ordinary browser may restore the captured state and resume only when its
host gesture policy allows; gesture-required Android always restores paused,
projects `NeedsGesture`, and exposes visible **Tap to play**. A second
failure renders **Couldn’t play the kept copy**, and neither path may resolve
`ExternalYouTubeVideo`.

`ProviderControlled` strict-untracked owned playback has a separate state-
blind ticket contract. It installs one fresh ticket before construction and
retains only `localSafeDeadlineMs`; it registers no
media-state/error listener and never reads position, paused, rate, duration, or
remaining media time. At that conservative deadline it synchronously performs
the certified teardown regardless of whether the user agent appears paused or
playing, focuses visible **Open video**, and announces exactly **Playback
expired. Open the video to continue.** once through polite player status. The
surface then requires that explicit **Open video**, a fresh authorization/ticket,
and a user gesture, beginning at the user-agent default. It never silently
renews, swaps, or resumes. A long-paused strict-untracked session can therefore
expire and lose position; preserving continuity would require the observation
this profile forbids. `visibilitychange`, `pagehide`, `freeze`, `pageshow`,
document focus return, and Android suspend/resume all compare the monotonic
deadline before any engine or origin reuse; hidden/frozen strict media is
destroyed, and a delayed/clamped timer can only show the expired continuation
surface on return. Forced-expiry browser and device proofs skew the client wall
clock, maximize RTT, clamp the timer, suspend the page/process across the
deadline, and assert no state read/listener/writer or new origin request at or
after the conservative deadline. Signed R2 URLs are
protected by the existing document `Referrer-Policy:
strict-origin-when-cross-origin` (media elements do not support a
per-element `referrerPolicy`; the invalid attribute claim is deleted), and
neither URL nor query enters history or router state.

Remove revokes new tickets at DB commit, clears the media element source in
every observing session, and ends in `KeptCopyRemoved`, never
external playback. A removal-initiated cleanup is a distinct transition with
a ZERO write horizon: the asset is published-then-unpublished in one
transaction, so no writer can hold the path; the removal reservation is
admitted with `writeMayLandUntil = now` and `available_at = now`. Cleanup takes
`DeleteRequired` when scheduled and converges durably across retry/outage.
There is no false hard deletion-time bound on a shared queue; the release
records and alerts on a normal-case removal SLO, while product state remains
`Removing` until object absence is verified. Already-buffered client bytes are
outside that promise.

## Copy workflow and storage ordering

The strict source payload is:

```text
YouTubeVideoCopyV1 {
  providerVideoId,
  timelineId, bindingEpoch,               # private worker fence
  profile: CompatibleMp4V1,
  rightsBasis: UserAttestedAuthorized
}
```

Profile limits are validated configuration settings owned by `config.py` with
production defaults (regular VOD, at most 4 hours, `max(width, height) <=
1920` so portrait is admitted, 4 GiB final bytes, 4 GiB aggregate input,
12.5 GiB attempt directory, 15 GiB free-space precondition, 2 GiB host
floor, 7200 s wall budget) — never a test-selected branch or fixture flag in
product code. The worker image pins yt-dlp and ffmpeg/ffprobe; their
executable paths are validated configuration settings, not `PATH` lookups, so
ordinary proofs point them at a test-owned fake executable.

Stream selection is an owned deterministic selector over yt-dlp's strict
metadata output, never a loose format expression. It accepts only separate
non-DRM H.264 video and AAC-LC audio candidates with exact byte size (not
`filesize_approx` or missing size), builds pairs whose sum plus a fixed 64 MiB
container margin is <= 4 GiB, then orders by video pixel count, height, frame
rate (capped at 60), video bitrate, audio bitrate, and finally the two provider
format ids as ascending UTF-8 bytes; all quality dimensions except ids are
descending. It passes the chosen exact ids to yt-dlp. No exact-size candidate
is a typed metadata/profile failure rather than a speculative download. A
720p-or-lower-only H.264 ladder is Kept, not failed. Runtime input/output byte
watchdogs remain authoritative because provider metadata can lie.
`CompatibleMp4V1` post-probe additionally requires 8-bit `yuv420p` H.264
Baseline/Main/High at level <= 5.1 and <= 60 fps, plus AAC-LC mono/stereo at
44.1 or 48 kHz; anything outside that browser/device matrix is
`E_VIDEO_PROFILE_UNAVAILABLE`, never silently transcoded. `E_VIDEO_TOO_LARGE`
fires only when exact candidates exist but none fits; `E_VIDEO_TOO_LONG` gates
duration. One canonical semantic-derivation manifest contains only exact tool
versions/binary hashes and byte-or-timeline-affecting adapter source hashes,
selector/version/constants, normalized static argv templates (excluding run
paths and provider-selected format ids), profile, and timestamp/conformance
rules. Lowercase SHA-256 of those canonical bytes is `derivation_version`.
Storage part size/checksum protocol, base/build image, output worker-image
digest, and deployment identity are excluded because they cannot change the
owned bytes or source-time mapping; the deployment manifest binds those as
separate content provenance. Re-Keep is gated by exact SHA plus the semantic
profile/conformance version, not build or upload-transport drift.
No placeholder (`e.g.`, `<N>`, floating tag, or unexpanded version) may pass
the static configuration proof.

The adapter accepts only a validated provider ID, constructs the watch URL
internally, passes a fixed argv without a shell terminated by `--` before the
URL, uses `--ignore-config`, disables plugin auto-loading and every
exec/external-downloader/post-processor-command option, uses a fixed literal
`-o` basename (never a provider-derived template), rejects
playlists/live/cookies/login (classifying live, playlist, private, member,
age-gated, and login-required explicitly as `E_VIDEO_COPY_SOURCE_INELIGIBLE`,
never folding them into profile failure), and stream-copies/remuxes to MP4
rather than transcoding or silently choosing WebM. yt-dlp, ffmpeg, and
ffprobe run with an explicitly constructed minimal environment (PATH, LANG,
and HOME/XDG_*/TMPDIR pointed inside the private attempt directory, built the
way `node_ingest._NODE_ENVIRONMENT` is — never inherited `os.environ`); cwd
is the attempt directory; no secret environment variable is visible to a
provider subprocess. The `worker-media` network namespace can egress only
through the owned media egress gateway's two separately authenticated
listeners. `YouTubeAcquisitionV1` validates only the configured YouTube/CDN
suffix allowlist and is the sole listener/address/credential exposed to the
yt-dlp subprocess environment. `PodcastAudioFetchV1` accepts arbitrary
canonical HTTPS hosts but implements the public-address/peer/redirect policy in
the transcript input contract below; it is selected explicitly only by the
in-process safe-stream client with a deployment-injected mTLS workload
credential that is never present in tool environment, argv, filesystem view,
or queue payload. Network policy denies direct public egress and cross-listener
credentials. Both listeners resolve DNS, reject denied ranges, validate the
actual connected peer and end-to-end TLS, and repeat policy on every CONNECT;
policy identity and normalized destination enter a content-free authenticated
connection receipt. This is the network SSRF boundary; application URL parsing
complements rather than claims to constrain yt-dlp's own stack. Both policies,
listener isolation, credential absence, and malicious redirects are asserted
by the B resource-envelope proof. `shorts`/
`live`/`embed` paths normalize to a canonical watch URL in
`youtube_identity`, so eligibility cannot be pre-judged from stored identity.

The packaging argv is a committed profile constant beside the pinned tool
versions: `ffmpeg -nostdin -i <video> -i <audio> -map 0:v:0 -map 1:a:0 -c
copy -map_metadata -1 -map_chapters -1 -movflags
+faststart+negative_cts_offsets -avoid_negative_ts make_zero -fflags +bitexact
-max_muxing_queue_size 4096 -f mp4 <out>`. Explicit stream order and metadata/
chapter stripping prevent provider/tool metadata from becoming accidental
identity. `+bitexact` alone is not a reproducibility guarantee: the proof
packages the same manifested inputs twice with the pinned image and requires
byte-identical output. The
conformance contract is the checkable post-conditions of exactly that
recipe: (a) per-track strictly increasing DTS over a full, streaming `ffprobe
-show_packets -of compact` parser capped at 2,000,000 records and constant
memory — whole probe output is never captured; (b) either no `elst` box at
all, or at most one
non-empty start-trim edit per track with `media_time <= 200 ms` and no empty
edits (the standard AAC-priming edit is legal — rejecting all edit lists
would reject most legitimately remuxed videos); (c) first video presentation
timestamp exactly 0 and first audio presentation timestamp in [0, 100 ms]
after edits are applied; (d) `max_av_skew_ms = |first audio presentation −
first video presentation|` after edits, `<= 100 ms`, persisted as exactly
that quantity; (e) intra-track DTS gaps bounded by `max(500 ms, 2x nominal
frame/sample duration)` — larger is a discontinuity; (f)
`source_to_presentation_offset_ms = 0`, proven by probing both selected inputs
and output and comparing exact rational packet/edit timestamps before any
millisecond projection; `make_zero` cannot manufacture this proof. Any leading
trim, discontinuity, or unknown mapping fails. (g) a recorded-but-tolerated
tail rule `|video track
duration − audio track duration| <= 1,000 ms`. Anything else fails
`E_VIDEO_TIMELINE_UNSUPPORTED`. Changing the argv changes
`derivation_version`. Conforming, edit-listed, shifted-source-origin, and
metadata-variation fixtures live under `testdata/media/`; the shifted fixture
must fail even when the output is internally synchronized.

`acquire_video_copy` and owned-video audio extraction/ASR run on a dedicated
third production lane, not the shared background worker: a `worker-media`
compose service with its own
memory/pids budget (yt-dlp + ffmpeg cannot fit today's background limits; the
compose `mem_limit`/`memswap_limit` and the cgroup readiness check move
together), its own `MEDIA_WORKER_JOB_KINDS` tuple disjoint from
interactive/background, and its own `JobResourceClass.TimedMediaHeavy`
single-capacity row
seeded by migration A, with the capacity SQL parameterized by resource class
— a two-hour copy can never monopolize ingest, cleanup, or teardown, and the
`docs/modules/jobs.md` two-lane sentence is amended by workstream H.
`apps/worker/main.py` defects at startup unless the registry key set equals
the topology exactly, so registry, topology tuples, and migration land
together. It reuses the queue, lease, process executor, source-attempt fence,
and failure supervision. The copy `JobDefinition` has committed constants:
`resource_class=TimedMediaHeavy`, `max_attempts=3`,
`retry_delays_seconds=(30, 120)`, `lease_seconds=30`, and
`heartbeat_interval_seconds=5`. Definitive classified
provider/network/storage/resource outcomes settle the attempt and complete the
queue on their first run. A lost/timeout response from mutating multipart
Create/UploadPart/Complete/Abort instead inserts the immutable unresolved-I/O
fact from which `ReconcileRequired` is derived on the same attempt/run: it
never projects user `Failed`, admits a new work id, or
redownloads before exact List/HEAD reconciliation; only a definitive failure
after reconciliation maps to `E_VIDEO_STORAGE`. Only a
lost lease, supervisor/process crash, or host interruption replays the same
domain generation within this bounded infrastructure budget. A user Retry
admits new work only after a classified terminal outcome. The heartbeat field
joins the registry/task digest and keeps cancellation observation plus TERM
grace below 30 seconds. `wall_timeout_seconds` comes from a dedicated validated
`VIDEO_COPY_WALL_TIMEOUT_SECONDS` (default 7200), `never_prune_dead=True`, a
third `ChildExitCleanup` arm keyed on the copy attempt id, and
`resource_failure_projection="Job"` (never `"SourceAttemptMedia"`). Dead
letters keep the same attempt/binding operator-owned and do not project an
ordinary `Failed` arm. `JobDefinition.wall_timeout_seconds` already exists
and is already task-digested; the cut deletes its 900 s default so every
kind declares its budget explicitly, and raises the two committed ceilings
(`process_executor._WALL_TIMEOUT_MAX_SECONDS` and the config validator) as
per-resource-class maxima — `TimedMediaHeavy` 14,400 s with per-kind validated
copy 7,200 s and transcript 14,400 s; other resource classes remain 900 s;
`BACKGROUND_PROCESS_WALL_TIMEOUT_SECONDS` remains the ingest budget and its
compose value stays "900".

`python/nexus/jobs/registry.py` is the sole closed production
`JobDefinition` registry. The cut makes `resource_class`, `max_attempts`, the
exact retry-delay tuple, `lease_seconds`, `heartbeat_interval_seconds`,
`wall_timeout_seconds`, and `never_prune_dead` mandatory constructor fields
and makes `handler_path` plus `deadline_lane_policy` mandatory with no default/
sentinel inheritance. The latter is the closed `Ordinary | StaticCompliance
{ laneKind } | VideoComplianceMember` union; only the named lifecycle roots and
the exact realized removal/cleanup resolver may select a reserved lane. Registry construction validates positive
budgets, a nonempty nonnegative delay tuple whenever `max_attempts > 1` with
the scheduler's committed saturating-last-delay indexing, heartbeat strictly
below lease, wall timeout within the resource-class ceiling, and a strict
payload decoder for every kind. A static/runtime equality oracle compares the
registry keys and field digest to every worker topology/dispatcher/task owner;
one missing, duplicated, defaulted, or drifted kind blocks startup and governed
proofs. Workstream H updates every pre-existing definition explicitly in the
same cut; the named new definitions below are not exceptions to this oracle.

`video_multipart_reconcile` is a second fully declared
`TimedMediaHeavy` definition on that same single-capacity `worker-media` lane,
not a branch of Light `storage_object_cleanup`: handler
`tasks/video_multipart_reconcile.py::reconcile_video_multipart_storage`,
`max_attempts=5`, `retry_delays_seconds=(60, 300, 900, 3600, 21600)`,
`lease_seconds=300`, `heartbeat_interval_seconds=5`,
`wall_timeout_seconds=7200`, and `never_prune_dead=True`. Its kind, strict
payload/checkpoints, limits, and task digest join `MEDIA_WORKER_JOB_KINDS`, the
resource envelope, maintenance drain, dead-repair owner, teardown queue set,
and registry/topology equality proof. Full readback can therefore never occupy
a Light/background cleanup worker.

Temp space is a validated absolute `VIDEO_TEMP_ROOT` setting (default
`/var/lib/nexus/video-tmp`) mirroring `PARSER_TEMP_ROOT`: an entry in the
worker env example, a bind mount on `worker-media` in the compose file, a
cloud-init `install -d -o 10001 -g 10001 -m 0700` line for fresh hosts plus
an idempotent `install -d` in the release path (cloud-init runs once and the
live host is already provisioned), and a release preflight gate mirroring
the parser-temp gate (exact directory metadata plus 15 GiB free, blocking
the release). Use one private attempt/execution directory. Bound input
streams to 4 GiB aggregate, final output to 4 GiB, and the attempt directory
to 12.5 GiB — the measured envelope covers 4 GiB input + 4 GiB packaged output
+ a second 4 GiB faststart output plus 512 MiB overhead, while the free-space
gate preserves a 2 GiB host floor. Because the `TimedMediaHeavy` lane has
capacity one, owned-video ASR cannot consume the same root concurrently;
`+faststart` rewrites via a temp file on `VIDEO_TEMP_ROOT`; ffmpeg runs in
streaming mode with bounded `-max_muxing_queue_size` so its memory footprint
is independent of file size. This is a checked envelope, not a filesystem
reservation; the adapter still fails safely on short write/`ENOSPC`. Normal
exit removes its exact directory via the `ChildExitCleanup` arm. Stale
directories are removed ONLY at worker startup, inside the bounded child,
reusing the `prune_stale_parser_temp` shape with a queue-owned
`video_copy_attempt_has_live_job` liveness predicate — no per-claim
filesystem scan. Temp paths never enter payloads or logs. The release proof
measures peak RSS, peak PID count, CPU, disk peak, and wall time for the
supervisor + child + yt-dlp + ffmpeg tree under the `worker-media` cgroup.

Publication order:

1. Generate replay-stable attempt/reconciliation/binding ids before one
   serializable domain admission transaction. Lock Media -> current-head ->
   Timeline, validate capability, claim replay, create the supplemental source
   attempt plus its unique reconciliation (derived `AwaitingStorageObject`
   because no storage/allocation/result fact exists), and record
   replay. All domain writes roll back together on rejection/no-op. For a first
   copy, insert the exact binding row and increment Timeline epoch; touch Media
   for SSE. After commit, await coordination admission of
   `AcquireVideoCopy(attemptId)` and
   `ReconcileVideoCopy(reconciliationId)` in stable OperationRef order. The
   latter carries strict `{ mediaId, reconciliationId }` and is due no earlier
   than the copy wall horizon. A crash between domain and either correlation is
   recovered from the two domain `AwaitingDispatch` refs; no domain row stores
   a queue id. For one accepted attempt the exact operation cardinality is
   `AcquireVideoCopy producer = 1` and
   `ReconcileVideoCopy coordinator = 1`; the coordinator is not counted as a
   producer. `StorageObjectCleanup reservations = N` where `N` is the exact
   number of materialized `media_video_storage_objects` across runs (zero before
   the first object reservation), and cleanup operations are never producers.
   Replays, concurrent Keep, retry applicability, and response loss preserve
   those equations rather than merely showing one final publication.
2. Under the lease fence, before any external work or `run_count` increment,
   the run reads its attempt, asset, and every prior storage-object row for
   this attempt. An already terminal-succeeded attempt with its published
   asset first idempotently retains/finalizes the deterministic storage
   reservation and clears any completed multipart allocation, then completes
   as succeeded (no provider call). A terminal-failed/cancelled attempt may
   complete its producer queue only after every prior storage row has either
   published content or an absence fact; otherwise it promotes/re-arms the
   exact linked reconcile cleanup and reschedules. Every prior row with neither verification nor absence is
   reconciled first through the exact copy/reconcile OperationRef claims: a verified
   completed object inserts/reuses verification and resumes at publication
   without another provider download/package/upload; still-live/ambiguous
   ownership reschedules the same work; confirmed absence inserts the absence
   fact and permits a new run. A prior verification likewise resumes
   publication, and an absence is already disposed. Only when every prior run
   is terminally disposed and none is publishable does the claiming lease
   increment `attempt.run_count` inside a lease-fenced transaction, exactly
   as `mark_running` does — a stale lease that later resumes computes a
   different run number and can only ever write its own path. The worker
   resolves/downloads/packages in its private temp dir, reporting only fenced
   monotonic progress.
3. Probe duration/codecs/dimensions, compute SHA-256 and exact length, and
   validate the complete Timeline-conformance contract. For re-Keep, gate the
   probed duration against `media_timelines.duration_ms` (1,000 ms) here,
   before upload cost.
4. In one lease-fenced transaction, generate one cryptographically random
   192-bit random object-key suffix, derive and insert only the canonical path
   on the neutral `media_video_storage_objects` row
   bound to the exact `(reconciliation_id, source_run_count)`, with the complete
   pre-upload expected hash/measurements/profile/derivation, selected integrity
   mode, and response headers, and reserve its
   `media/video/v1/<base64url-token>.mp4` path. In that same transaction,
   set its one-time `local_writer_quiescence_not_before`; `Armed` is then derived
   from that storage object plus the still-live producer. The same transaction
   creates/joins exactly one canonical generic `StorageObjectCleanup` operation
   plus `VideoCopyStorageObject` owner for this object generation in `Reserved`;
   no queue row exists until absence/deletion is required. After commit, the
   coordination port promotes its existing heavy reconcile OperationRef to the
   exact due time. That heavy operation owns listing, adoption, readback, and
   publication decisions; the reserved generic cleanup is the only later Abort/
   Delete/fence/absence authority. `storage/paths.py` owns and validates the
   suffix/path grammar; the suffix is discarded after path construction and is
   never a second persisted identity. The
   allocation owner validates `source_run_count >= 1`, and no relational id or
   call-site interpolation enters the key. This happens immediately before
   `CreateMultipartUpload`; rejection rolls both rows back. The reservation
   entry point gains a required caller-supplied
   `write_window_seconds`: the copy passes `bounded local upload deadline +
   BACKGROUND_PROCESS_TERM_GRACE_SECONDS + R2_READ_TIMEOUT_SECONDS` — the
   whole job budget is deliberately NOT part of this local-child horizon,
   because the reservation is taken immediately before upload. This timestamp
   proves only that Nexus has stopped or killed every local process that can
   initiate another provider request; it never proves that an already accepted
   R2 request cannot finish later. `VIDEO_MULTIPART_UPLOAD_TIMEOUT_SECONDS=3600`
   is a committed, validated whole-upload deadline no greater than the copy
   wall budget; it joins the upload-protocol manifest, task digest, release horizon,
   and resource-envelope proof. Existing callers pass the current global
   setting unchanged; `_validate_storage_lifecycle` checks the derived
   per-kind horizon. Do not renew a reservation the cleanup worker has
   claimed.
5. Upload outside a transaction through a bounded multipart upload added to
   the storage client (`create_multipart_upload` / `upload_part` with a
   64 MiB part size / `complete_multipart_upload`). Immediately after create,
   persist only `{storage_object_id, upload_id}` in
   `media_video_multipart_allocations` under the lease fence before sending a
   part; token/path/attempt/run remain solely on the neutral storage row. If a
   crash lands after provider-side create but before upload-id persistence, the
   committed random path lets the reconciler use `ListMultipartUploads` for
   that exact key. Its settle transaction inserts one immutable complete-set
   observation plus every discovered member. Exactly one upload may be adopted
   and then `ListParts` reconstructs its checkpoint. Zero follows the typed
   no-upload path. Two or more are never heuristically chosen: every member is
   `CleanupRequired`, each gains an exact generic cleanup multipart target, the
   producer is cancelled/fails only after absence, and the reserved cleanup is
   CAS-activated. Release preflight certifies both LIST capabilities. The bucket abort lifecycle remains only a final
   backstop. Each part gets at
   most three attempts with 1 s then 4 s backoff, a
   120 s per-attempt deadline, and the enclosing upload/wall deadline; it
   retries in place without re-downloading from the provider. No creator or
   reconciler performs an in-child/best-effort Abort or Delete. Cancellation,
   ordinary failure, timeout, SIGKILL, or supervisor death persists the exact
   desired-cleanup targets and uses the durable allocation to activate the
   reserved lease-fenced generic cleanup; only its authenticated abort results
   or a definitive completed upload disposition permit allocation deletion. The
   max-object constant is checked against R2's ~4.995 GiB
   single-request and 10,000-part limits; `R2_READ_TIMEOUT_SECONDS` is a
   per-socket-read bound survived by part retry, never widened). The
   single-PUT-envelope claim is deleted — no such envelope exists. Release
   preflight selects and persists exactly one storage-integrity capability,
   never an automatic runtime fallback: `CompositeSha256` sends per-part
   `ChecksumSHA256`, verifies the composite completion response/checksum and
   matching deployed checksum metadata; `StreamedReadbackSha256` is used only
   when the provider does not support that protocol, omits unsupported
   checksum headers, and streams the entire completed object through local
   SHA-256 before publication. Both modes then `HEAD` and confirm exact length,
   content type, `Content-Disposition`, and `Cache-Control`. The selected mode
   is release-blocking configuration and its worst-case transfer volume must
   fit the same upload/wall deadline. Same-length corruption
   fails before publication either way; the B resource-envelope proof asserts
   total transfer volume fits the wall budget at a stated throughput floor,
   and the `Verify` stage reports this phase truthfully. A repository-owned
   R2 lifecycle rule (`deploy/cloudflare/r2-lifecycle.example.json` +
   apply/inspect script) aborts incomplete multipart uploads at age one day on the
   `media/` prefix — `ListObjectsV2` cannot enumerate them, so the orphan
   sweep is blind to them; exact allocation cleanup is primary, the bucket rule
   the final backstop. Release preflight reads deployed lifecycle state and
   proves the exact enabled rule/prefix/age; committing an example file is not
   deployed-state evidence.

   Every mutating R2 call goes through K1's one
   `services/storage_remote_writes.py` port. Its generic producer and
   `storage_remote_write_generations` row commit under the running-claim fence
   before socket handoff, including `CreateMultipartUpload` before an upload id
   can exist. The video dispatch row is only a composite-FK subtype association
   to that generic generation; mutation kind, canonical request, and arm time
   are read exclusively from the generic row and cannot be relabelled in B.
   Every generic generation for this video's creator or reserved cleanup has
   exactly one matching video subtype, and every subtype has exactly one generic
   row. Registry/static/runtime equality compares those sets, mutation kinds,
   producer OperationRefs, object generation, and path; wrong-kind same-producer
   substitution fails a real FK/owner proof. The subtype is one-to-one only by
   generic `remote_write_generation_id`; two socket attempts for the same part
   intentionally share a video action digest but have distinct generic mutation
   generations. Proofs accept that retry pair and reject cross-object pairing.
   Creator response-loss uncertainty
   references the exact subtype, so separate parts or later request generations
   cannot collapse.

   Failure, cancellation, removal, or teardown CAS-activates the exact reserved
   `StorageObjectCleanup` operation and admits/promotes its OperationRef; the
   heavy reconciliation parent observes it through an exact terminal dependency
   and never performs Abort/Delete itself. K1 seals the one-member object-
   generation set and complete creator-capable producer/write set in the sole
   canonical `storage_object_cleanup_remote_write_fences` row. Zero creator-
   capable generic write generations may use `StructuralNeverArmed` only under
   that fence's full typed-owner terminality rules. Fully authenticated terminal
   responses use `AllKnownWriteGenerationsFenced`. Any response-lost Create,
   part, Complete, or other creator-capable request requires
   `ProviderTerminalPath` for the exact path/generation; cleanup Abort/Delete
   generations remain attributable but are noncreator and excluded from the
   creator set. There is no video-specific fence, count, digest, or terminality
   enum.

   Generic `storage_object_cleanup` is a fully declared Light JobDefinition
   with strict `{ cleanupOperationId }`, handler
   `nexus.tasks.storage_object_cleanup:storage_object_cleanup`, `max_attempts=5`,
   `retry_delays_seconds=(60,300,900,3600,21600)`, `lease_seconds=300`,
   `heartbeat_interval_seconds=30`,
   `wall_timeout_seconds=STORAGE_OBJECT_CLEANUP_WALL_TIMEOUT_SECONDS(900)`, and
   `never_prune_dead=True`. Ordinary cleanup may reschedule the same operation
   within that finite definition without claiming success; exhaustion or
   invariant failure leaves it dead/operator-repairable and never manufactures
   absence. A `VideoComplianceMember` cleanup instead uses its reserved slot and
   absolute cutoffs: invocation one initiates/joins the exact bounded provider-
   terminal path and installs one authenticated terminal wake, invocation two
   consumes that wake and completes Abort/Delete/HEAD/settlement. It has no
   polling retry-delay arm; duplicate/lost wake recovery equality-joins the same
   phase within the one recovery reserve, and a missed cutoff blocks readiness.

   `StorageObjectCleanupAdmissionGate(cleanupOperationId)` serializes every
   target/observation insert, activation, fence, and settlement. A creator's
   complete LIST observation transfers its initial `CleanupRequired` members
   and exact generation-member/upload-id targets under that gate in the same
   transaction that activates cleanup. Cleanup first seals every creator-
   capable write or obtains `ProviderTerminalPath`; only then can a response-
   lost Create no longer materialize a late upload. Cleanup owns every later
   immutable LIST generation, inserts/equality-joins its exact count/digest and
   members/targets under the gate, and for each target alone arms
   `AbortMultipart` through `storage_remote_writes.py`. Arming atomically inserts
   the typed abort-generation association whose composite FKs bind
   `StorageObjectCleanup(cleanupOperationId)`, the exact cleanup producer,
   object generation/path, target, and provider upload id to a generic
   `mutation_kind=AbortMultipart` generation. A target completion must FK both
   that association and its exact authenticated terminal result; a terminal
   Abort for another target, cleanup, object, path, upload id, producer, or
   mutation kind is unusable. Cleanup persists the exact authenticated result/
   uncertainty and repeats a complete LIST until one
   post-creator-fence generation is empty. The final multipart settlement binds
   that empty observation plus the count/digest of all exact target completions
   to the remote-write fence. Prepare and settle rederive both sets under the
   gate; a late/phantom target, cross-generation/upload substitution, count/
   digest mismatch, or missing completion writes nothing. Only then may cleanup
   arm `DeleteObject` and perform the post-fence HEAD. An adopted upload never
   enters the target set; a two-or-more creator observation adopts none.

   `scope=NotApplicable` is a closed derived arm, not a caller choice. It is
   valid iff the remote-fence's exact sealed registry-derived creator capability
   and generation sets contain zero `CreateMultipart | UploadPart |
   CompleteMultipart`-capable producers, zero such mutation generations, and
   the cleanup owns zero multipart targets and zero multipart observations. An
   opaque creator is conservatively multipart-capable unless the signed provider
   contract proves that exact producer/path incapable of multipart. Any
   multipart-capable producer or generation, or any target/observation residue,
   requires `CompleteListSettled`: all observed uploads have exact completions
   and the named final complete LIST made after the creator fence is empty. The
   settlement persists both multipart-capable creator counts/digests, and settle
   recomputes them with the target/observation sets under the same admission gate.
   Wrong scope, an empty-list claim made before the fence, or any late creator/
   target/observation rolls back.

   The generic cleanup settles `Deleted` with a retain-domain callback only in
   the transaction that inserts/equality-joins the sole generic object-absence
   fact from a direct-S3 `HEAD NotFound` observed after that canonical fence and
   multipart settlement. The heavy parent then uses `ObserveTerminal`, verifies
   its receipt plus exact video-owner and generic absence-generation-member FKs,
   and inserts the sole `media_video_storage_absences` association; it never
   copies or authors HEAD/fence/settlement evidence. The generic fact's fence is
   mandatory even for `StructuralNeverArmed`, and its multipart settlement is
   mandatory even for `NotApplicable`. A local wall/socket/TERM deadline, successful Abort,
   `NoSuchUpload`, LIST omission, or `HEAD NotFound` before the fence/settlement is not
   terminal proof. Cloudflare's strong visibility after completed writes does
   not promise that an outstanding Complete-vs-Abort race cannot resolve later.
   Release certification must exercise response-lost Create/Complete and bind a
   provider operation/contract that closes those exact request/path identities.
   If deployed R2 cannot provide it, copy release remains `BLOCKED`; ambiguity
   stays discoverable and no elapsed-time absence is inserted. Random paths are
   never reused, so the conservative hold cannot endanger a newer object.

   `reconcile_video_multipart_storage` is the named handler for every copy
   reconciliation, with storage/allocation optional. It persists no parallel
   status checkpoint. One `derive_video_reconciliation_state` owner computes
   `AwaitingStorageObject | ReconcileRequired |
   VerifiedAwaitingPublication | AwaitingProducerTerminal | Published |
   Absent` exclusively from source-attempt terminality, storage/allocation,
   unresolved uncertainty, verification, per-run absence, and content rows.
   `Published` means content references this reconciliation's verification;
   `Absent` means a failed/cancelled producer with every possible run proven
   absent (or no external mutation/storage fact ever existed). Those terminal
   arms are mutually exclusive and are the OperationRef terminal predicates.
   The handler uses two bounded lease-fenced transactions around external I/O.
   Its prepare transaction asks coordination to ascending-lock the complete
   Acquire/Reconcile OperationRef set, then locks Media -> current-head ->
   Timeline -> attempt -> reconciliation -> storage-object -> optional
   allocation, inserts the next immutable reconciliation plan plus its unique
   active-plan row, and commits.
   The external step uses only the plan's immutable path/object/upload-id/part-
   cursor/action snapshots; it never follows a newly adopted allocation. It
   then performs only List/HEAD/readback with no DB transaction or row lock
   open; Abort/Delete are delegated to the reserved generic cleanup. Its settle transaction reacquires the same OperationRef and
   domain order, renews/revalidates claim and exact active plan identity/action,
   then re-reads cancellation/deletion intent, attempt status/run count,
   current Timeline/epoch, storage/allocation/upload identity,
   verification/absence/content presence, and write horizon from authoritative
   rows before recording the result. Exact agreement records `Settled` and
   deletes only that active-plan row. Claim loss writes nothing so the new
   owner reuses the active plan. Authoritative cancellation/teardown/Timeline/
   attempt/allocation/upload-id/part-cursor drift records immutable
   `Superseded { reason }`, deletes the active
   marker, discards the external observation as non-authoritative, and
   reschedules so the next prepare chooses a new action; it cannot leave a
   permanently active stale plan. A missing/resolved plan cannot settle. Proofs
   inject cancellation, teardown, Timeline drift, and allocation swap/adoption
   at every prepare -> I/O -> settle boundary. A unique expected
   pre-persistence upload is adopted by inserting its
   allocation under the lease fence; unmatched/duplicate uploads activate the
   reserved cleanup, which owns every abort. Thereafter an open upload activates
   that cleanup once no exact live writer remains; a completion-response loss with a final object is adopted
   only after the selected integrity mode verifies all expected measurements;
   a mismatching final object activates cleanup and requires its post-fence
   `HEAD NotFound`; and
   provider `NoSuchUpload` plus an absent final key does not by itself converge:
   it is only an observation to be interpreted under the certified remote-fence
   contract below.
   A valid final object inserts/reuses immutable verification, deletes
   allocation, thereby derives `VerifiedAwaitingPublication`, and promotes the same copy
   OperationRef to publish after commit. Confirmed no-upload/no-object after the
   local writer horizon activates/observes the generic cleanup; only its retained
   terminal receipt and canonical provider-proven fence permit deletion of the
   allocation and insertion of the immutable per-run absence. If the producer may replay the same attempt, the reconciliation
   derives nonterminal `AwaitingProducerTerminal`; a run N+1 storage object
   makes it `ReconcileRequired` again without updating a status row. It does not
   complete or replace its queue operation. It derives terminal `Absent` only when the source attempt is itself terminal
   failed/cancelled and every run has an absence fact. If cancellation/failure arrives after
   verification but before content publication, the same owner activates and
   observes generic cleanup, then inserts absence alongside the
   historical verification (permitted only because no content references it).
   Content publication or terminal absence, never verification alone and never
   a prunable queue result, excludes the reconciliation from future scans. A
   verification without content/absence remains scan-eligible. Every
   timeout/lost response from Create/part/Complete inserts one immutable
   uncertainty, deriving `ReconcileRequired`; a definitive error is classifiable only after these
   List/HEAD rules converge. The copy's direct handler may invoke the same pure
   owner while it holds the heavy lane; after a crash the reconcile job does.
   Lifecycle expiry is a backstop, not state convergence.

   `scan_video_multipart_reconcile_reservations` is one domain/coordination adapter
   called once by `worker-media` before it claims work and by the existing
   periodic `storage_orphan_sweep`. For every nonterminal reconciliation it
   validates the typed OperationRef correlation and strict payload,
   promotes a due unclaimed target in any derived nonterminal state, and
   alerts/refuses on a dead or terminal-inconsistent target so the
   same-job operator repair owns it; it never performs object I/O or invents a
   replacement job. A verification with no content/absence promotes the
   original copy OperationRef to publication/settlement only while that attempt
   remains publishable. A dead producer without cancellation/teardown retains
   derived `VerifiedAwaitingPublication`, projects `Suspended`, and waits for same-job
   repair, which publishes those verified bytes without a provider call.
   Cancellation, classified terminal failure, or teardown promotes the
   reconcile OperationRef to delete, prove absence, and settle instead. An
   absence is terminal and excluded. A copy failure/cancellation before storage-object creation
   derives `Absent` after the
   terminal attempt fact; an unexpected dead copy or dead reconcile before any
   storage row inserts the appropriate suspension keyed to attempt or
   reconciliation and leaves both OperationRefs for same-operation repair.
   Crash points cover reservation fire,
   startup scan, dead repair, Create-before-persist, every part, Complete and
   abort response loss, lifecycle expiry, verification/absence commit, the gap
   before queue completion, and publication adoption, and assert no
   unreconciled DB residue or second provider acquisition.

   The two no-object derived arms have an exhaustive liveness table. With an
   active/pending/retryable producer and no storage object,
   `AwaitingStorageObject | AwaitingProducerTerminal` reschedules without
   consuming a reconcile attempt until the producer's current due time, lease,
   and possible write horizon close. A new producer run transitions it to
   `Armed`; producer failed/cancelled plus absence for every run transitions to
   `Absent`; producer succeeded without `Published` content is a quarantined
   invariant defect; producer `dead` preserves suspension and waits for
   same-job repair; teardown first requests producer cancellation and only then
   converges `Absent`. Proofs cover a copy queued beyond 7,200 seconds,
   retryable producer reschedule, dead-before-storage repair, prior-run absence
   followed by same-attempt run N+1, and dead-after-verification -> requeue ->
   publish with no new provider acquisition.
6. Publication uses
   `with_owned_operation_claim_set(ownedRef, peerRequirements, ...)` over the
   exact `AcquireVideoCopy(attemptId)` and `ReconcileVideoCopy(reconciliationId)`
   refs; a singular running-claim lock is forbidden. The caller owns one live
   claim and names the other as `ObserveTerminal` or the statically declared
   `DelegateUnclaimedRecovery` relationship. A claimed, dead, expired-but-
   unrecovered, ambiguously correlated, or domain-inconsistent peer makes the
   transaction write nothing and return typed retry/operator repair. Delegation
   makes that peer non-runnable in the same transaction as publication, so a
   later claimant cannot race terminal truth. In global lock order the helper
   then inspects cancellation; when set, it uses only the `CancelOnly` arm,
   never publishes, promotes the linked reconciliation to prove absence, and
   finishes cancellation only with that fact. Otherwise it
   locks Media -> current-head -> Timeline -> attempt and rechecks teardown
   and the binding/epoch. It requires the run's immutable storage verification
   and rechecks no absence exists;
   every successful run inserts a new immutable measured content row that
   references that verification. First
   publication: recheck the absence of every Tier-1 pre-copy timed fact,
   additionally insert the one immutable owned identity, set the probed
   `duration_ms` on Timeline, delete the exact binding,
   increment epoch. Re-Keep publication: verify the current Timeline owned
   identity equals the latest removal in this Timeline generation — no binding
   to clear and NO epoch increment (identical bytes; existing handles stay
   valid) — and reference that existing identity from the new content row.
   Insert the sole asset publication referencing the new content plus one
   `YouTubeVideoCopyLifecycle(lifecycleOperationId)` as `AwaitingDispatch`,
   whose live compliance authority derives through the unchanged typed video
   allocation's exact approval/policy/disposition/purge/deadline facts; in that
   same transaction insert the live schedule pointing to the **same** neutral +
   typed video capacity allocation, then delete only its admission-time
   reservation state row before the asset is visible;
   terminalizes the attempt and both domain operations and touches Media in that
   same managed transaction. Commit makes `Kept` visible and leaves no owner
   gap. After commit, invoke `settle_terminal_operation` for the Acquire and
   Reconcile refs in canonical order; each writes/links its coordination receipt
   and alone removes its queue/correlation/domain row after the exact terminal
   predicate. Then admit the lifecycle ref. Publish-vs-
   reconcile, claim-vs-delegation, cancellation, peer death, and lease-loss
   proofs assert one publication and no second Heavy-capacity holder.
7. Ensure the multipart allocation is absent and settle both coordination refs.
   A crash before publication keeps/promotes the reconcile owner to activate the generic cleanup for the
   orphan; a crash after publication retains the live asset; a worker killed
   between the publication commit and the queue success transition replays
   step 2's reservation/allocation convergence before queue success (covered
   by the B publication proof).

`youtube_video_copy_lifecycle` is a no-provider-I/O JobDefinition with
`resource_class=Light`, strict `{ lifecycleOperationId }`,
`handler_path=nexus.tasks.youtube_video_copy_lifecycle:youtube_video_copy_lifecycle`,
`deadline_lane_policy=StaticCompliance { laneKind=VideoCopy }`,
`max_attempts=5`,
`retry_delays_seconds=(60,300,900,3600)`, `lease_seconds=300`,
`heartbeat_interval_seconds=30`,
`YOUTUBE_VIDEO_COPY_LIFECYCLE_WALL_TIMEOUT_SECONDS=900`, and
`never_prune_dead=True`. Its purge time honors only the approval artifact's
closed `MayRetainUntil` or `UnpublishAndDeleteBy` arm.

Hard deletion is capacity-scheduled, not inferred from a one-row wall-time sum.
The sole seeded `provider_compliance_schedule_gate` row has literal kind
`YouTubeRestrictedData`; startup/readiness require exactly that one row and the
exact fixed worker topology: two `VideoCopy` slots, one `Caption`, one
`OwnedAsr`, and one `OAuth`. These five `worker-provider-compliance` processes
never lend to or borrow from interactive, background, or TimedMediaHeavy work.
Every JobDefinition adds a mandatory registry-digested
`deadline_lane_policy`: static for the lifecycle roots, and the closed
`VideoComplianceMember` resolver for the exact realized removal and reserved
storage cleanup. A compliance-bound removal/cleanup is claimable only by its
schedule's named video slot; an ordinary product removal/cleanup remains on
`worker-background`. Static/runtime equality covers registry, claim SQL,
topology, and both resolver arms.

Before Keep performs provider or storage I/O, its admission transaction locks
the schedule gate before Media, rederives the canonical active union of schedule
reservations and live schedules, and enforces
the signed-notice-derived `YOUTUBE_VIDEO_COPY_EFFECTIVE_MAX_ACTIVE_CONTENTS`
below, never above the absolute design ceiling 32. It chooses the latest feasible
nonoverlapping half-open interval on one of the two video slots, with stable
tie-break `(scheduled_window_end, slot_no, source_attempt_id)`, inserts the
append-only placement generation, neutral + typed video capacity allocation,
and pre-I/O reservation state row, and rejects with
`E_VIDEO_COMPLIANCE_CAPACITY` before dispatch if no interval fits. The gate
transaction rejects any same-slot interval overlap; startup independently
recomputes the interval union from neutral allocations and blocks on overlap, split-gate identity, a
third/missing slot, or count above the effective cap. Publication atomically creates the
lifecycle and live schedule referencing the reservation's unchanged neutral +
typed allocation, then deletes only the attempt-bound reservation state
row. Failure/cancellation retains the reservation until every partial object is
generically proved absent, then deletes reservation -> typed allocation ->
neutral allocation. Exactly one reservation-or-live-schedule owner exists for
each live video allocation; zero/two owners block readiness. No abandoned
attempt releases capacity while bytes may remain.

Admission also enforces one current restricted owned-ASR allocation per video
content (`N in {0,1}`). The signed provider disposition contract supplies a
positive bounded `PROVIDER_MIN_DISPOSITION_NOTICE_SECONDS`; the deployed
artifact and typed video allocation bind that value and contract digest.
Capacity is derived from the work that can actually finish inside that notice.
The absolute 32 is a schema/test ceiling, not a promise that every approval
supports 32:

```text
YOUTUBE_VIDEO_COPY_ABSOLUTE_MAX_ACTIVE_CONTENTS = 32
VIDEO_COMPLIANCE_RESERVED_EXECUTION_SLOTS = 2
PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS = 60
VIDEO_COMPLIANCE_ROOT_INVOCATION_CEILING = 4
VIDEO_COMPLIANCE_OWNED_ASR_FINALIZE_INVOCATION_CEILING = 1
VIDEO_COMPLIANCE_REMOVAL_INVOCATION_CEILING = 2
VIDEO_COMPLIANCE_CLEANUP_INVOCATION_CEILING = 2
VIDEO_COMPLIANCE_QUEUE_HANDOFF_CEILING = 8
VIDEO_COMPLIANCE_RECOVERY_INVOCATION_CEILING = 4
VIDEO_COMPLIANCE_RECOVERY_SECONDS =
  VIDEO_COMPLIANCE_RECOVERY_INVOCATION_CEILING(4) *
    (YOUTUBE_VIDEO_COPY_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
     PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60)) = 3840

VIDEO_COMPLIANCE_PER_CONTENT_SECONDS =
  MEDIA_TRANSCRIPT_WALL_TIMEOUT_SECONDS(14400) +
  BACKGROUND_PROCESS_TERM_GRACE_SECONDS +
  BACKGROUND_PROCESS_KILL_GRACE_SECONDS +
  VIDEO_COMPLIANCE_OWNED_ASR_FINALIZE_INVOCATION_CEILING *
    YOUTUBE_OWNED_ASR_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
  VIDEO_COMPLIANCE_ROOT_INVOCATION_CEILING *
    YOUTUBE_VIDEO_COPY_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
  VIDEO_COMPLIANCE_REMOVAL_INVOCATION_CEILING *
    VIDEO_COPY_REMOVAL_WALL_TIMEOUT_SECONDS(900) +
  VIDEO_COMPLIANCE_CLEANUP_INVOCATION_CEILING *
    STORAGE_OBJECT_CLEANUP_WALL_TIMEOUT_SECONDS(900) +
  PROVIDER_TERMINAL_PATH_MAX_SECONDS +
  VIDEO_COMPLIANCE_QUEUE_HANDOFF_CEILING *
    PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60) +
  VIDEO_COMPLIANCE_RECOVERY_SECONDS(3840)

YOUTUBE_VIDEO_COPY_EFFECTIVE_MAX_ACTIVE_CONTENTS =
  min(YOUTUBE_VIDEO_COPY_ABSOLUTE_MAX_ACTIVE_CONTENTS(32),
      VIDEO_COMPLIANCE_RESERVED_EXECUTION_SLOTS(2) *
        floor((PROVIDER_MIN_DISPOSITION_NOTICE_SECONDS -
               PROVIDER_COMPLIANCE_SWEEP_INTERVAL_SECONDS(60)) /
              VIDEO_COMPLIANCE_PER_CONTENT_SECONDS))

VIDEO_COMPLIANCE_MAX_WAVES =
  ceil(YOUTUBE_VIDEO_COPY_EFFECTIVE_MAX_ACTIVE_CONTENTS /
       VIDEO_COMPLIANCE_RESERVED_EXECUTION_SLOTS(2))

YOUTUBE_VIDEO_COPY_COMPLIANCE_MARGIN_SECONDS =
  PROVIDER_COMPLIANCE_SWEEP_INTERVAL_SECONDS(60) +
  VIDEO_COMPLIANCE_MAX_WAVES *
    VIDEO_COMPLIANCE_PER_CONTENT_SECONDS
```

Startup/release require effective capacity at least one and require
`PROVIDER_MIN_DISPOSITION_NOTICE_SECONDS >=
YOUTUBE_VIDEO_COPY_COMPLIANCE_MARGIN_SECONDS` for the current cohort. Supporting
the absolute ceiling 32 therefore requires notice for all 16 waves (about 4.92
days before TERM/KILL and the signed provider-terminal-path component); a
24-hour contract intentionally derives a much smaller cap. A missing,
unbounded, expired, or shorter-notice contract keeps AC18 `BLOCKED`.

Approval replacement, expiry acceleration, or a changed disposition is one
schedule-owner transaction, not a projection-only recheck. It nonlocking-
resolves the complete affected reservation/live-schedule union, takes the
singleton schedule gate and exact allocations before ascending Media locks,
and orders the cohort by `(newComplianceDeleteDeadline, ownerKind, ownerId)`.
Before committing the new approval/disposition head, it validates the signed
notice against the exact current cohort, inserts one append-only placement
generation whose input digest covers every owner/artifact/deadline, creates all
replacement neutral + typed video allocations with earlier-or-equal windows,
swaps every reservation/live schedule plus current wake to the new allocation/
placement generation, and only after full equality deletes the old typed then
neutral allocations. Readers lose playback/caption capability in that same
commit. No per-row prefix, stale worker revision, or later-window substitution
can commit. If the provider supplies less than its signed notice or no feasible
placement exists, Nexus still unpublishes immediately, enters fail-stop cleanup
readiness, and records a contract incident; it cannot claim the impossible
deadline as achieved. Proofs accelerate the maximum effective cohort at once,
crash at every allocation/wake swap, reject stale/cross-owner revisions and a
deadline inside the computed margin, and exercise the 32-content case only with
the full 16-wave notice.

The four root invocations are Fence, writers-finalized/removal admission,
removal-absent/domain receipt, and singleton settlement. The two removal
invocations are cleanup activation and the one terminal-dependency wake that
records completion. The two cleanup invocations are provider-terminal-path
initiation and the one authenticated terminal wake that performs Delete/HEAD/
settlement. None of these compliance arms uses polling backoff: dependency
settlement and the provider's bounded terminal signal each enqueue exactly one
same-ref wake. Duplicate wakes equality-join the same fact and consume no new
invocation. The recovery reserve permits at most four additional idempotent
900-second re-entries plus their four 60-second scanner/queue handoffs for one
declared process/host outage; it never repeats a provider mutation or extends a
phase cutoff. A second exhausted recovery window,
missing authenticated wake, or late phase is a deadline incident that disables
normal service; it is never converted into another retry or a false receipt.

Placement computes and stores every absolute cutoff forward from
`scheduled_window_start`: scan+Fence, concurrent writer drain+TERM/KILL,
owned-ASR receipt conversion, writers Finalize, removal admission, generic
cleanup terminality (including provider-terminal path), removal completion,
root Finalize, root settlement, then recovery. `scheduled_window_end` is no
later than `compliance_delete_deadline`; `purge_due_at` equals the window start.
Every phase entry, postcommit admission, event wake, and response-loss replay
checks its own `*_not_after` plus the complete remaining tail before mutation.
It cannot reschedule past that point. Slot placement under the singleton gate
proves same-slot intervals do not overlap; the derived wave count proves a
feasible window for the exact effective cohort, including the 16-wave/32-content
case only when the signed notice supports it.

`PROVIDER_TERMINAL_PATH_MAX_SECONDS` is not an operator guess: it is required
from the signed deployed provider-terminal-path contract and exact bucket/
account evidence, and the pre-mutation manifest binds its value and evidence
digest. Missing, zero, unbounded, expired, or drifted provider evidence blocks
startup/release and contributes to AC18 `BLOCKED`. Configuration, Keep
admission, publication transfer, lifecycle admission, startup, and release
reject a nonpositive/drifted constant, count, digest, interval, phase cutoff, or
margin.

`tasks/youtube_video_copy_lifecycle.py` and
`services/youtube_video_copy_lifecycle.py` are its only task/transition owners.
At due, the handler calls `VideoCopyComplianceFence` with replay-stable
preallocated set/fence/removal ids. That port—not an ordinary owned-claim set—
pre-resolves and seals the complete root/writer/removal set before Media locks,
unpublishes the exact current content, inserts the no-new-transcription/result/
publication fence, and returns without deleting a child. A dead, expired,
unclaimed, running, or dispatch-uncertain writer is never generically
superseded. After commit, the supervisor cancellation-fences all sealed
processes, starts their TERM/KILL timers concurrently, and records typed
termination-event wakes; this handler invocation then returns. Later
invocations drive the typed owned-ASR deadline Fence/Finalize transitions from
their durable wake facts. Those transitions preserve
only approved content-free accounting/dispatch receipts and atomically convert
each active member to its receipt-backed member before restrictive-FK deletion.

After the current DrainDue wake, the handler calls
`VideoCopyComplianceFinalize` to prove the sealed writer set settled and
revalidate the already-realized planned removal pair/member. Writer-terminal
receipts plus the admitted removal ref derive removal-awaiting truth; no mutable
checkpoint records that transition. Historical content never touches a newer asset.
Postcommit coordination admits `VideoCopyRemoval`; the lifecycle reschedules
without holding Media or settlement gates. The generic cleanup alone fences
remote writes, owns Abort/Delete/HEAD, and its provider-terminal-path proof must
finish inside the bound above. A later typed Finalize requires the exact removal
coordination receipt, completion, generic fence, and verified physical absence,
writes `Removed | DeadExpired`, and only then ordinary singleton settlement
writes/links the root receipt and deletes active/settled/removal members, the
current wake head/registrations/typed sequence owner/sequence, the fence set,
compliance schedule, typed video capacity allocation, and neutral
capacity allocation before deleting the lifecycle in
its deletion-only callback. The user Remove guard may still require explicit transcript
cancel; compliance uses this bounded typed path and never calls that product
command.

Approval replacement/expiry immediately removes playback and transcript-
publication capability even before physical convergence. Startup emergency
cleanup invokes the same fence/finalize port; it does not invent a late lock or
elapsed-time terminal fact. Readiness blocks any content, staged plaintext,
live writer, missing receipt-backed member, or unfenced path past deadline.
Proofs cover exact seeded-slot/topology equality, no-overlap latest-fit
placement, capacity rejection before I/O, same-allocation reservation-to-live
swap (including zero/two-owner and cross-attempt/slot/window substitution), release,
maximum-effective-cohort same-deadline execution plus the conditional
32-content/full-notice case, simultaneous disposition re-placement, every absolute cutoff and the margin/
manifest equations; zero/one member algebra; clock crossing; replacement; every writer state; concurrent process
termination; dispatch uncertainty; current/historical content; dead/expired
root and children; restrictive-FK member conversion; planned-removal pair;
crash before/after fence, unpublish, every child receipt, removal transfer,
admission, provider fence, generic absence, and root receipt; recovery-window outage/exhaustion;
deadline startup cleanup; and response-loss replay.
8. Remove first dismisses the active session only when that session's frozen
   source is this Media's `OwnedVideo` asset — any other session, its
   transport, and device-local history are untouched. It pre-generates
   replay-stable removal and cleanup-attempt ids (Retry pre-generates only the
   next domain cleanup-attempt id), takes `MediaJobAdmissionGate`, then locks
   Media -> head -> Timeline and persists the immutable removal row
   referencing content, arms the
   `VideoCopyRemoval` cleanup keyed only by `{removalId, removalAttemptId}` as
   `AwaitingDispatch`, deletes the asset row, CAS-activates the content's exact
   reserved `StorageObjectCleanup`, and records the exact parent -> cleanup
   domain dependency in the same transaction. After commit it awaits one
   canonical coordination transaction that admits either missing OperationRef
   and creates/joins the matching terminal dependency; startup reconciliation
   closes every domain/correlation/dependency gap, while teardown uses the
   registered both-absent settlement arm for a not-yet-correlated parent.

   `VideoCopyRemoval` is a coordinator and never calls a raw storage mutator,
   Abort, Delete, or HEAD. Its owned claim promotes/awaits the generic cleanup;
   a
   live writer includes any nonterminal transcript attempt bound to the same
   Timeline, so **Remove copy** is inapplicable while one exists (**Nexus is
   transcribing this item. Remove the copy after transcription finishes or is
   cancelled through the explicit transcript command.**), rechecked under the
   Media -> head -> Timeline lock before activation. The generic cleanup alone
   takes `DeleteRequired`, owns Abort/Delete, seals the canonical writer set, and
   records the sole generic post-fence object-absence fact. The removal parent then enters
   `with_owned_operation_claim_set(removalRef=Mutate,
   storageCleanupRef=ObserveTerminal, ...)`, verifies the exact terminal receipt/
   video-owner/generic-absence-generation-member FKs, inserts the per-run storage
   absence association if needed and the exact
   removal completion in one transaction, and settles only its parent ref with
   the registered retain-domain callback: queue/correlation are removed, while
   immutable removal/attempt/completion history remains available to the
   compliance member and product history. There is no duplicate terminal
   checkpoint. Path and write horizon are derived through
   removal -> content -> verification -> storage object on every prepare and
   settle, never copied onto the attempt. The `video_copy_removal` coordinator
   is a fully declared JobDefinition with `resource_class=Light`, strict
   `{ operationRef: VideoCopyRemoval(removalAttemptId), mediaId }`,
   `handler_path=nexus.tasks.video_copy_removal:video_copy_removal`,
   `max_attempts=5`,
   `retry_delays_seconds=(60,300,900,3600,21600)`, `lease_seconds=300`,
   `heartbeat_interval_seconds=30`,
   `wall_timeout_seconds=VIDEO_COPY_REMOVAL_WALL_TIMEOUT_SECONDS(900)`, and
   `never_prune_dead=True`. A user-command-owned attempt may consume that
   finite budget for the closed expected storage dependency failures;
   exhaustion atomically inserts the classified removal-failure row and
   terminal domain result without disturbing the still-discoverable generic
   cleanup. A compliance-realized attempt is different: the realized member
   and sealed set are its authority. Its first invocation activates/joins
   cleanup, installs exactly one terminal-dependency wake, and parks the same
   OperationRef with no timed retry/backoff; that authenticated wake causes the
   second and final invocation to record absence/completion. Duplicate wakes
   equality-join that phase. It never writes `RemovalFailed`, and neither
   product Retry nor a replacement removal ref is callable. An unexpected exception or
   invariant defect instead inserts `RemovalSuspended` and leaves the dead job
   for same-operation repair. The compliance scanner may use only the typed
   video-compliance authority to requeue that exact sealed dead ref before its
   computed cutoff and the single recovery reserve; if same-ref repair cannot prove physical absence inside the
   bound, startup/readiness blocks rather than terminalizing or resealing a new
   member. Proofs kill and recover the same ref at every event-wake/dead/cutoff
   boundary. For the product-owned arm, **Retry removal** retains the failed attempt and
   commits one fresh `AwaitingDispatch` attempt with a full budget for that
   same removal, then admits it through OperationRef; the command, startup gap
   reconciler, and operator repair all take `MediaJobAdmissionGate` and refuse
   this creation whenever a `FenceCommitted | WritersSettled | RemovalAwaiting |
   RemovalAbsent` compliance set binds the content, returning/joining its exact
   already-realized attempt instead. It preserves terminal
   job/result history and never
   double-retries or replaces the removal identity. Then the owner
   touches Media for SSE.

Run-fenced paths never collide. Concurrent commands converge through provider
identity, mutation replay, serializable retry, and Media locking. Copy
failure is settled supervisor-side, composed with the queue transition in the
queue-first lock order. Before any storage row it records the supplemental
attempt failure, deletes only its exact matching Timeline binding row, and
increments epoch. After storage may exist it persists the classified code as
an immutable linked reconciliation uncertainty, keeps the attempt nonterminal, and
terminalizes failure/binding/producer only in the same transaction that inserts
absence; user `Failed` is not projected while external ownership is unresolved.
A claimed run
whose attempt is already terminal completes immediately as a typed no-op
success; failure supervision never overwrites an already-terminal attempt.
Expected classified copy failures never enter dead-letter: the supervisor or
reconcile owner terminalizes the attempt with its closed durable code,
compare-and-deletes the binding with an epoch increment only when that CAS
transitions, completes the jobs, and touches Media at the safe boundary above.
The unexpected dead-letter path leaves the attempt and
matching binding nonterminal/operator-owned; `never_prune_dead=True` keeps the
row discoverable and `requeue_dead_job` repairs the same operation. A stale
attempt can neither clear a newer binding nor turn an invariant defect into a
user Retry.

Copy and timed-transcript attempts are supplemental: admission, progress,
success, and failure never write Media `processing_status` or its failure
fields — `source_attempt_failures.py` is hard-cut into the existing
primary-ingest publisher and a new
`publish_supplemental_source_attempt_failure` that terminalizes only the
exact attempt row, compare-and-deletes its binding, and touches
`media.updated_at`, never calling `mark_media_failed_by_id` or
`bump_all_media_fact_collections`; `source_attempt_failure_stage` becomes
exhaustive over source types instead of defaulting to `'extract'`. A
supplemental failure leaves any previously readable transcript mounted. A
residue gate asserts no supplemental source type can reach
`mark_media_failed_by_id`. New tickets stop at DB unpublication; an
already-issued bearer can make origin requests only until verified physical
deletion, with no false scheduling-time bound, and already-buffered bytes are
not revocable.

Cancellation is queue-owned. The queue adds an exact `request_cancel(job_id)`
transition and changes heartbeat truth from `bool` to
`Owned | CancelRequested | Lost`; a `CancelRequested` heartbeat still RENEWS
the exact lease so the settlement stays fenced, and the worker's synchronous
pre-execution `still_owned` check decodes the same union. `CancelRequested`
before child start executes the same lease-fenced cancellation settlement and
completes the job; it never merely abandons a live claim.
`cancel_requested_at` semantics across existing transitions are explicit: it
SURVIVES `fail_job`, `reschedule_running_job`, and `requeue_dead_job` because
repairing the same operation must preserve cancellation. Only the separately
authorized `reset_unclaimed_job_for_new_intent` may clear it after proving the
old intent terminal; `promote_unclaimed_job` leaves it untouched; the worker's
shutdown-release path is never conflated with cancellation. Waiting work is
cancelled immediately only while its reconciliation derives
`AwaitingStorageObject` and no storage-object/uncertainty row exists: the command
supersedes both exact queued targets, terminalizes the attempt as `cancelled`,
compare-and-deletes its binding, and increments epoch. Once any storage row or
external mutating call may exist, the command persists the generation-wide
cancellation request across both queue targets and projects `Cancelling`; it
cannot terminalize until the linked reconcile owner proves every run Absent.
For claimed work the SUPERVISOR, not the task, acts: the worker sets a
`cancel_requested` event alongside the
existing `claim_lost`, `_await_child_exit` observes it, the executor kills
the whole child process group (yt-dlp and ffmpeg die with the group; no
in-child handler or poller), and a new closed `ChildCancelled` result
returns. The supervisor then settles in one lease-fenced transaction —
lock the exact producer/reconcile claims in ascending order and stop the child.
When no storage exists it terminalizes the attempt `cancelled` via a new
SQL-only `services/source_attempt_cancellation.py` owner (mirroring
`source_attempt_failures.py`, no storage/provider imports),
compare-and-delete with epoch increment only if the CAS deletes the exact row, and
completes both jobs with the typed `Cancelled`/`AbsentNoObject` results. When
storage may exist it promotes the derived verified/unresolved reconciliation,
and that same owner atomically inserts absence, terminalizes attempt/binding,
and completes/clears both jobs only after List/HEAD proof. Temp removal remains
the `ChildExitCleanup` arm; the supervisor never relies on a killed child to
clean external state. On a healthy
supervisor, cancellation is observed at the next job-specific 5-second
heartbeat plus TERM grace and normally resolves within 30 seconds; during a
worker or host outage the truthful bound is lease expiry plus queue recovery,
so the UI makes no universal time promise. A
cancel is too late only when publication committed strictly before the
cancel command's job-row write — `Cancelling` genuinely has no transition to
`Kept`. No domain service reads queue internals, no poller is added, the
wrong job cannot be cancelled, and cancelled/lost work cannot publish.
Cancel-during-readback/Complete-ambiguity and wrong-generation proofs cover
both children. Terminal cancellation retains its audit row, projects `NotKept`, and emits
**Copy cancelled** feedback. Every terminal failure/supervision path uses the
same compare-and-delete binding helper, which increments `binding_epoch` if
and only if the attempt-id CAS actually deletes the exact binding row — a stale
attempt cannot clear a newer reservation, and a
replayed settlement can never bump the epoch under a later generation.

## Timed-media player

Hard-cut `FooterAudio` to one `TimedMedia` activation. `Readable` and genuine
non-playable `OpenPane` remain. `NextCapability`/`next_capability` becomes the
closed union `"Stop" | "TimedAudio" | "TimedMedia" | "Readable"`, renamed
across the consumption schemas/service, `lib/lectern/contract.ts`,
`playerSession.ts`, `LecternProvider.tsx`, and the Android protocol;
`SettleNaturalEndCommand.next_capability` narrows accordingly. Only an ordinary
owned-video engine or a currently `Tracked` YouTube engine may settle video
natural end through the existing `SettleNaturalEnd` command with its terminal
position and Timeline handle, exactly as podcast audio. Every `Untracked`
YouTube profile has no settlement capability and neither settles completion nor
auto-advances; a raw no-JS embed cannot report a trustworthy end at all.
Successor capability is engine-scoped: automatic natural-end advance and
**Play next** select only a successor the currently selected engine can play
— an Android native ExternalAudio session never auto-advances into video (it
retains `PausedAtEnd`), and a row resolving `Unavailable` is skipped as a
successor and, when explicitly activated, presents its Unavailable state
instead of starting a session.

A descriptor carries the strict playback union, Timeline, playback fences,
title/artwork, origin/history, chapters, completion, and engine capabilities.
It does not carry an expiring ticket. V1 deliberately persists no YouTube API
presentation metadata: `_persist_youtube_metadata` and every downstream write
of provider description, title, thumbnail, published date, language,
channel/publisher/contributor facts are deleted. Add stores only the canonical
provider id/watch URL derived from the user-supplied URL plus an independently
user-authored Nexus title when one is explicitly supplied; otherwise every
surface uses **YouTube video**. Artwork is a bundled, generic Nexus video
placeholder, never a YouTube CDN URL or cached provider thumbnail, so cards,
poster, history, Android, and offline reads make no third-party image request
before the per-activation privacy/policy decision. Legacy canonical-YouTube
titles follow the conservative no-digest fallback cut specified above because
no title-authorship ledger exists; none is relabelled user-authored. Separately
proven non-title author/search facts may migrate only through their own exact
provenance owner; provider-derived facts are deleted and every remaining
ambiguity aborts with exact row ids rather than laundering API data into user
truth.

Every page, card, player/history row, transcript source label, and owned-copy
surface for a YouTube-origin Media renders an adjacent visible, accessible
**YouTube** source-attribution link to the canonical watch URL using the
repository-held approved brand asset. Keyboard activation is the same explicit
**Open source** navigation and never starts hidden playback; its accessible
name identifies YouTube and the current Nexus title. It is not inferred from
iframe chrome and cannot be confused with the user's Nexus title. At 320 px
and in forced colors the text alternative remains visible. OS/browser
`MediaSession` is `Unsupported` for YouTube-origin
`OwnedVideo` in v1 because lock-screen chrome cannot guarantee the approved
brand treatment; no provider title/artwork enters OS metadata. This sacrifices
rich artwork and OS transport integration to avoid an unbounded API-data/cache
lifecycle and unbranded presentation.

Device-local player history and the Lectern snapshot store only Media identity
plus those Nexus-owned presentation fields — never a resolved `playback` arm.
For YouTube, the MFK activation decision described below precedes creation of
any history/snapshot entry. Every activation (explicit Play, Previous, Next, natural-end advance, reload
restore) re-resolves the union from fresh truth before a source is frozen.

`PlayerSession` carries one kind discriminator
`CanonicalTimedMedia | PreviewAudio`; the existing `GlobalPlayerState`
lifecycle arms (Absent, UpdateRequired, RuntimeFailed, Active, Completing,
CompletionFailed, PlaybackFailed, PausedAtEnd, PreviewAudio,
PreviewAudioFailed, PreviewAudioAtEnd) and the `CompletionAttempt` FSM are
preserved unchanged. The selected source is frozen for the session: copy
completion/removal never swaps bytes underneath playback. A later activation
resolves fresh truth. The media SSE push re-decodes the snapshot in place; a
Timeline epoch mismatch pauses and dismisses the stale canonical session with
a notice derived from the refreshed copy projection —
`Queued`/`Keeping`/`Cancelling`: **Playback paused while Nexus verifies the
copy. Play again once keeping finishes, fails, or is cancelled.**; `Kept`:
**The kept copy is ready. Play again to use it.**;
`NotKept`/`Failed`/`Suspended`/`RemovalFailed`/`RemovalSuspended`: **Playback stopped because this item’s
copy changed. Play again.** It never continues with writes disabled or
silently adopts another source. A stale-Timeline or binding rejection of a
playback-state write is itself terminal for that heartbeat generation: the
client retires the dirty sample, stops the generation without GET re-sync or
retry, and enters the same paused-and-dismissed state — SSE is a redundancy,
not the only path.

### Canvas projection

One shell-owned `PlayerEngineHost` owns the actual audio/video/iframe node,
created once per healthy session at `lib/player/PlayerVideoCanvas.tsx` and
never reparented (an iframe reparent reloads the provider player) — only
repositioned, clipped, and hidden. Safety fail-stop, terminal engine failure,
or session end destroys that exact player/node and invalidates the session; it
is never hidden while potentially still playing. Pane/Now Playing components
publish a `VideoCanvasOutlet` containing bounds and visibility; they never
mount media. The outlet publishes its own rect plus the rects of its
clipping/scrolling ancestors (the media pane's `.documentViewport`; the
desktop pane canvas). One `VisibleRegion` owner intersects those with
`window.visualViewport` using exact `offsetLeft`, `offsetTop`, `width`, and
`height`, then subtracts the geometric union of every higher-layer owned
occluder. It preserves disjoint rectangles and computes union area; it never
approximates visibility as one bounding rectangle minus overlaps. Nonfinite,
negative, stale-generation, or unstable measurements fail closed. The host
applies a clip from that region, re-measured on every ancestor scroll, window
and visualViewport scroll/resize, `ResizeObserver`, keyboard/browser-chrome/
pinch-zoom/safe-area change, pane visibility, and mobile-chrome reveal. A new
`--z-video-canvas` layer token joins the global scale with its ordering
stated against `--z-raised`/`--z-overlay`/`--z-modal`/`--z-nexus`/ActionMenu/
`--z-toast`; Now Playing chrome, the selection popover, Dialog, ActionMenu,
mobile sheets, and the MiniPlayer occlude an owned-video canvas. A YouTube
iframe permits zero intersection with a higher-layer occluder: before one
opens or crosses its bounds,
the host runs `pauseAndConfirm(reason, sessionId, commandId)`. A fresh,
identity-checked `getPlayerState()` in `Ended | Paused | Cued` is
`AlreadyStopped`. `Unstarted` qualifies only when no `playVideo()` command
generation is armed; with a pending start the host synchronously invalidates
that generation and destroys the player, and a late `Playing` callback is
ignored. Only `Playing | Buffering` receives `pauseVideo()` and must
produce a fresh official `PAUSED | ENDED` callback for the exact player/video
under `YOUTUBE_PAUSE_ACK_TIMEOUT`. Only then may the host hide/reflow the provider
viewport. Missing or
mismatched acknowledgement destroys the player/node, closes/discards the open
observation, focuses the stable **Open source**/error control, and reports
`PauseUnconfirmed`; the overlay may then open safely. It restores playback only
after compliant visibility returns and a new explicit play intent. The Feedback
owner places nonmodal status outside the active player geometry
whenever the current layout has such a region; it may not cover provider
controls merely to avoid a reflow. When a required toast/sheet/dialog/popover
would intersect, the same pause/destroy protocol completes before it appears.
The canvas is
hidden (not merely clipped) whenever its visible rect is empty, during
reader view transitions, and while parked. Pointer ownership: the canvas is
`pointer-events: none` while parked or when its outlet is not the active
surface; attached, pointer events remain enabled and are never captured or
synthetically forwarded to another scroller. An ordinary or tracked owned
`<video>` renders with native `controls` off under Nexus chrome. The strict
untracked YouTube-origin owned arm below instead uses user-agent controls with
no Nexus player chrome; the YouTube iframe retains its own native pointer
behavior. Accessibility: exactly one owner holds the
`Media player` landmark while a canvas is attached (the shell chrome; no
other surface renders the role for that duration). A visible **Enter video
player** control precedes the iframe and moves focus into it; a visible
**Return to Nexus controls** control follows it and restores the exact entering
control. There are no invisible focus sentinels or automatic focus forwarding.
The iframe title is exactly **{title} — YouTube video player**. Before an
iframe is hidden/reflowed while it contains focus, the host moves focus to the
corresponding visible return control; the hidden wrapper becomes both `inert`
and `aria-hidden`, and focus is restored to the player only after an explicit
visible/open action. Escape dispatch is ordered: browser fullscreen, then
modal/popover, iframe-exit control, player chrome, and
transcript; each handled layer calls `preventDefault` and returns to its exact
opener. This order applies only to key events Nexus receives: keystrokes while
focus is inside the cross-origin provider document are provider-owned and
Nexus does not claim it can intercept Escape; keyboard users Tab to the visible
**Return to Nexus controls** control. A parked owned-video canvas is
`aria-hidden` and `inert`. Fullscreen is engine-owned: `OwnedVideo` requests
fullscreen on the stable host wrapper containing its media node and the single
Nexus chrome/caption subtree, then suspends outlet tracking while that wrapper
is `document.fullscreenElement`. It records the invoking control;
`fullscreenchange` on user/UA exit restores focus there if it remains present,
or to the stable Play/Pause control. A request rejection first moves focus to
that stable control, announces **Fullscreen isn’t available here.** once in the
polite player status, and only then removes the fullscreen capability/control.
Provider error or safety teardown while a focused iframe is inline first moves
focus to the visible error/**Open source** action before destroying the node.
If provider-owned fullscreen is active, safety wins: stop/destroy immediately,
request/await fullscreen exit, then on `fullscreenchange` focus the now-visible
stable error/**Open source** action and announce once. A bounded fallback after
UA exit failure focuses the stable player status only when it is actually in
the fullscreen top layer; it never focuses an obscured background control.
YouTube exposes only `ProviderOwned`
fullscreen with no Nexus overlay in browsers. Android WebView passes `fs=0`
and publishes `Unsupported` in v1 so no dead or unreachable custom-view
control renders. No visual element obscures provider controls.

A parked non-YouTube-origin `OwnedVideo` session may keep playing as audio —
parked means hidden, never paused — with the surfaces showing **Audio only —
open the video to watch** beside **Open video**; that playback records
`Listening`, never `Viewing`. A YouTube-origin `OwnedVideo` is provenance-
restricted exactly like the embed: unless a future signed approval adds a
separate closed background-play capability, it must pause/fail-stop whenever
hidden, parked, or without a compliant visible outlet. YouTube policy forbids
hidden/background playback: neither YouTube engine is constructed or may play
unless its actual media viewport (iframe for External, video element for owned
bytes) is at least 200 CSS px wide and 200 CSS px high, its shared disjoint
`VisibleRegion` union area is strictly greater than 50% of that actual viewport
area, and no higher-layer occluder intersects it; the same predicate is
monitored continuously and is the only YouTube Viewing predicate. The 320 px layout therefore
uses a minimum 200 px block-size with letterboxing instead of a 16:9 180 px
slot. If safe-area/chrome/400% zoom cannot leave that rectangle, Nexus shows
**This window is too small for the YouTube player.** with **Open source** and
does not construct (or destroys) the current YouTube media node. Losing every compliant outlet
uses the confirmed pause/fail-stop protocol and presents **Video paused — open
the video to continue**. Desktop: the media pane is the canvas
outlet; the Listening
Shelf never hosts the canvas. Mobile: the media pane is the primary watch
outlet and the expanded Now Playing overlay the secondary; the MiniPlayer
never hosts the canvas; when both are present Now Playing wins while open
and the canvas returns to the pane outlet on collapse without reloading the
engine. Leaving a pane preserves only non-YouTube owned playback and exposes
**Open video**. Tracked YouTube preserves only its last authorized sampled
paused position; either strict untracked profile fail-stops/destroys, loses
position, and never becomes background audio.

### Clock and engines

`lib/player/timedMediaTiming.ts` is the sole nominal-`Duration`/schedule owner:
`YOUTUBE_OBSERVATION_AUTHORIZATION_TTL=60_000ms`,
`YOUTUBE_OBSERVATION_RENEW_AT=45_000ms`,
`YOUTUBE_POSITION_SAMPLE_PERIOD=250ms`,
`YOUTUBE_IFRAME_API_LOAD_TIMEOUT=10_000ms`,
`YOUTUBE_PLAYER_READY_TIMEOUT=10_000ms`,
`YOUTUBE_PLAY_ACK_TIMEOUT=2_000ms`, `YOUTUBE_PAUSE_ACK_TIMEOUT=500ms`,
`YOUTUBE_RATE_ACK_TIMEOUT=2_000ms`, `PLAYER_CANVAS_HANDOFF_TIMEOUT=500ms`, and
`ANDROID_VIDEO_SUSPEND_ACK_TIMEOUT=750ms`. Cadence and termination live
together; call sites import typed values and cannot restate raw numbers. The
Android protocol corpus carries the cross-runtime values/digest. Script/global
load or constructor-to-`onReady` expiry destroys the exact generation, ignores
late callbacks, and projects `ProviderInitializationTimeout`; Retry creates a
fresh authorization/generation. Play/rate timeout follow their exact
NeedsGesture/revert contracts, while pause/suspend/handoff timeout fail-stops.
Unit, browser, corpus, and device proofs assert every constant and boundary.

Every ordinary or `Tracked` session with Nexus time capabilities has one
session-owned `TimelineClock` feeding chrome, transcript, playback heartbeat,
and Activity; a `ProviderControlled` untracked profile constructs none. Browser
media uses engine events. Before any YouTube
provenance activation-side persistence and immediately before either provider
iframe construction or YouTube-origin owned playback, the
client obtains the no-store observation decision from
`POST /media/{id}/youtube-observation-authorization`, verifies the echoed
session/source and installs its closed arm in the local engine FSM. Host is not
part of that server authority; each host separately proves only the construction
capabilities it actually owns.

Every ExternalYouTube `Untracked` reason—`MadeForKids`,
`TimedObservationNotApproved`, or `PolicyUnknown`—uses the separately release-
certified `YouTubeUntrackedEmbedProfile`: a raw privacy-enhanced
`https://www.youtube-nocookie.com/embed/{id}` iframe with provider controls and
`autoplay=0`, no `enablejsapi`, no IFrame API script or `YT.Player`, no
application `message` listener/callback/command/sampler, and no Nexus overlay.
If the signed deployment artifact cannot certify that exact no-observation
profile, authorization returns `Unavailable {
UntrackedEmbedProfileUncertified }` and constructs
nothing, and offers only **Open source**. Since raw iframe state cannot be
safely queried or paused, visibility loss, outlet/size failure, or any occluder
intersection synchronously destroys it; reopening is explicit and position is
not preserved. YouTubeOriginOwnedVideo uses a second exact strict profile,
`YouTubeUntrackedOwnedProfile`, for all three reasons. Its stable wrapper is the
`Media player` named landmark and owns a visible **Open source** action; only
after host certification it constructs a newly visible
`<video aria-label="Video playback" controls playsinline
controlsList="nodownload nofullscreen noremoteplayback"
disablePictureInPicture disableRemotePlayback>` with no autoplay. It has no
Nexus player chrome, captions, time/rate/seek/fullscreen command, `TimelineClock`,
media-state event listener, position/sample read, heartbeat, TextTrack, app
Media Session, PiP, remote-playback, custom-fullscreen, or download capability.
The browser release matrix proves the forbidden native controls/actions are
actually absent on each exact supported browser—not merely that attributes are
present. Before either strict profile constructs, the local host equality-
checks the server-returned profile id/version/SHA-256 and exact browser or
WebView/OS version against that artifact. Artifact drift is
`UntrackedProfileArtifactMismatch`; an unsupported host is the source-specific
local `...UnsupportedHost` engine failure. The Android WebView additionally requires user gesture for media,
disables multiple windows, registers no custom-view/fullscreen or PiP path, and
creates no Android MediaSession/notification transport; the bound-device proof
inspects the resulting UA controls and OS surfaces. A local failure constructs
nothing and offers only **Open source**. This is a closed UX capability profile, not a claim that developer
tools cannot copy user-readable private bytes. Its capability projection is
`ProviderControlled`—meaning the user agent owns presentation timing, not that
Nexus may observe a provider—and its only action while the node is live is
**Open source** outside the media element; a destroyed recoverable surface may
add **Open video** to construct a fresh node. Shell **Previous**/**Next** remain
navigation-only, expose no timing fact, and **Next** starts a separately
authorized activation. The general outlet/document-visibility owner may
observe geometry and document visibility, but never media state; any visibility
loss, outlet/size failure, occluder intersection, or source drift synchronously
destroys the element. Recoverable ticket-expiry or geometry/visibility teardown
moves in-wrapper focus to visible **Open video**; ticket expiry uses **Playback
expired. Open the video to continue.**, while geometry/visibility uses **Video
paused — open the video to continue.** Source/profile drift or a safety failure
instead moves focus to stable visible **Open source** (or the visible navigation
target when provenance is unavailable) and announces that exact failure copy
once. Teardown is exactly `pause()`; remove
`src`; `load()`; detach; invalidate the constructor generation; ignore every
late native event. Reopening is explicit, obtains a fresh decision, and loses
position. Both untracked source profiles disable Timeline sampling, playback
heartbeat/history/position/completion, Activity, temporal Highlight, transcript
follow/seek, PlayerSession history/Lectern snapshot, and Nexus analytics; only
transient in-memory presentation identity may exist, and no player-derived fact
is persisted. The decision gate precedes every generic activation/history
write. The proof asserts both branches, native focus/teardown, actual forbidden-
control absence, activation-before-persistence ordering, and every unknown or
stale response.
Untracked never invokes `SettleNaturalEnd`, never auto-advances from an ended
observation, and writes no next-history; only explicit **Next** may start a
fresh independently authorized activation. The raw embed cannot observe end.

Only `Tracked` carries a bounded token. Clock-skew, wall-clock change, and late
response cannot extend its TTL. Renewal begins at the named schedule and every
observation closes at the old token's window boundary. Renewal failure,
unknown/MFK drift, source mismatch, or expiry immediately stops all Nexus
sampling/history/heartbeat/Activity/Highlight/analytics writes, closes the
current span at the last authorized sample, and runs the correlated
pause-confirm protocol. A missing pause acknowledgement destroys the player;
a confirmed pause also destroys the tracked engine and presents
`ObservationAuthorizationExpired`, requiring fresh authorization/explicit
play. It never continues playback with frozen Nexus state. A newly untracked result
may be opened only as the source-appropriate fresh untracked activation above,
with no prior history carryover.
Tracked YouTube playback
uses only Google's documented `YT.Player` IFrame API with `enablejsapi=1` and
the exact first-party `origin`; Nexus never implements or depends on the
private raw `postMessage` wire. The official script is lazy-loaded only after
explicit activation from `https://www.youtube.com/iframe_api`, the exact
origin joins `script-src`, and load failure is a typed engine failure. This is
an explicit security/privacy tradeoff: documented provider control and policy
compliance require a third-party script, so CSP is narrowly widened and no
other script origin is admitted. All embeds set `autoplay=0`; Android WebView
loads only the owned HTTPS page; Nexus does not pretend `loadUrl` headers can
inject a child iframe Referer. The owned page response sets
`Referrer-Policy: strict-origin-when-cross-origin`, the iframe receives the
standards-derived owned origin, and constructor parameters pass exact
`origin`/`widget_referrer` identity. WebView Media Integrity defaults Disabled
for every origin and is explicitly Enabled with app identity only for the
closed, no-wildcard origin set `{ https://www.youtube.com,
https://www.youtube-nocookie.com }`; every other scheme/host/port remains
Disabled. The signed bound-device proof loads tracked playback from the first
origin through correlated `onReady` and separately demonstrates raw-untracked
provider controls from the second without relying on a nonexistent raw-iframe
error callback. Package
name, version, signing certificate, and configured cloud project/app identity
are release-manifest facts. The adapter exhaustively maps documented `onError`
codes: `2 -> InvalidVideoParameter`, `5 -> Html5PlaybackError`, `100 ->
VideoUnavailable`, `101 | 150 -> EmbedNotAllowed`, and `153 ->
ProviderClientIdentityInvalid`; any other/non-integer value is
`ProviderProtocolUnknown`. Error 153 is non-retryable for that session/host and
blocks release/device acceptance, never a transient failure. Player states are
the closed documented set `-1 Unstarted | 0 Ended | 1 Playing | 2 Paused | 3
Buffering | 5 Cued`; every other/nonfinite state fail-stops as
`ProviderProtocolUnknown`.

The documented `onAutoplayBlocked` callback is separately correlated to the
exact player and identity-checked video, stops any pending-start deadline, and
projects `NeedsGesture`; it is neither `onError` nor silent `Buffering`.

The adapter accepts an official callback only when `event.target` is the exact
active `YT.Player` instance correlated to the unique session/player id and
constructor generation. An exact-correlated `onError` is the sole loaded-URL
exception: it maps the closed code, closes/discards observation, destroys that
generation, and performs no write even when `getVideoUrl()` is unavailable or
malformed. A late error from a retired generation is ignored. Before issuing
every other provider command and before accepting onReady/state/rate/time,
command acknowledgement, sample, or downstream write, it calls the documented
`getVideoUrl()`, strictly parses its video id,
and equality-checks it to the provider id frozen in the current observation
token/session. Missing, malformed, or mismatched identity closes/discards the
sample/span, stops writes, calls pause, destroys the player/node regardless of
acknowledgement, and requires fresh authorization; it cannot mutate Media
truth. Only the unconditional safety pause/destroy path is exempt from the
pre-command gate. Finite state/time/rate values are then validated. Nexus installs no
application `message` listener for the private iframe wire; sibling-frame
events therefore have no accepted bridge. Browser proofs enumerate every
error/state code plus unknowns, every pre-ready error, a retired-generation
late error, and a loaded-video swap before every other command/callback/sample/
write boundary.

The `Tracked` YouTube adapter samples `getCurrentTime()` at
`YOUTUBE_POSITION_SAMPLE_PERIOD` only while the
document is visible and the compliant player is Ready (display and bounded-
staleness cadence), and starts an immediate asynchronous read on each reported
state/rate change. Provider seek is detected by a clock discontinuity plus that
fresh read; the API has no documented seek event. Thus a paused or
provider-scrubbed clock converges without inventing synchronous transport;
provider-native transport (in-player play/pause/seek/rate, YouTube's own
shortcuts) is a first-class input the engine reconciles. Activity
observation is visibility-gated. On `visibilitychange` -> hidden, YouTube is
fail-stopped synchronously: Nexus closes the authorized span at the latest
cached sample, disables every write source, calls `pauseVideo()`, then destroys
the player/node without waiting for an asynchronous callback. A fresh read/
keepalive flush begun before destruction is best effort and cannot delay it.
`pagehide`/`beforeunload` uses the same cached-sample rule and therefore makes
no exact final-position promise beyond the last observed sample. Returning
visible requires a fresh authorization and explicit play; no hidden engine is
resumed.
Non-YouTube-origin `OwnedVideo` uses synchronous `currentTime` and may continue
hidden according to browser policy. `Tracked` YouTube-origin OwnedVideo follows
the same visible fail-stop and fresh observation-authorization rule as its
provenance. The `ProviderControlled` strict-owned profile uses only the state-
blind geometry/ticket teardown above and never enters this Timeline port.
The engine Timeline port becomes
`readPosition(): Promise<PositionSample>`: **Highlight this moment**, seek-bar
commits, and playback-state writes await a fresh sample while the page is live;
the action is single-flight while awaiting. No pane creates a clock or polls
lifecycle state; the timed-transcript
controller subscribes through a selector, updating only the active cue's
`aria-current`/cursor — cue advance never re-renders the cue list.

All engines implement the same Commands/Session/Settings/Timeline capability
ports. Every setting is enumerated Supported/Unsupported per engine, the
chrome renders no control for an Unsupported capability, and no surface
branches on engine identity:

- timeline presentation is the closed
  `ProviderControlled | PositionOnly { relativeSeek: Supported | Unsupported }
  | Bounded { durationMs, absoluteSeek: Supported | Unsupported }` union.
  Only authoritative `media_timelines.duration_ms` can create `Bounded`; a
  provider `getDuration()` value is transient engine state and never upgrades
  it. Tracked unbound ExternalYouTube is `PositionOnly` with supported relative
  seek when the documented API is ready: Nexus shows elapsed source time and
  Back/Forward but omits range, total, completion fraction, markers, and
  absolute scrub, while the provider iframe retains its native scrubber.
  External raw untracked embed and the exact YouTube-origin
  `YouTubeUntrackedOwnedProfile` are `ProviderControlled`; Nexus exposes no time
  chrome. Ordinary or tracked owned video and Podcast are `Bounded` when their
  Timeline duration is present. A duration-absent elapsed clock uses fixed `H:MM:SS` width from the
  first frame (for example `0:00:03`), so crossing one hour cannot relayout.
  Strict capability decoding and UI tests cover every source/duration arm;

- rate: each ready engine publishes `Continuous { minRate, maxRate,
  stepRate }` (browser audio/video; Android audio publishes the committed
  existing `0.5x–3x` kernel with `defaultRate` `1x` as constants, not an
  engine report) or `Discrete { rates }` (YouTube, from the embed API,
  intersected with `0.5x–3x`). Continuous keeps today's slider, stepper, and
  presets; Discrete renders the intersected preset list only — stepper moves
  to the next available rate, no slider; the control is absent when the
  engine publishes neither. `playbackRate.ts` owns the discrete projection.
  An engine-reported rate outside the kernel is adopted as observed, clamped
  for display, never persisted, and never a session failure (replacing the
  `InvalidPlaybackRate` failure path). `PodcastSubscriptionSettingsDialog`
  keeps the Continuous editor (it edits a preference, not an engine);
- Android audio keeps `Shorten pauses`; browser audio/video and YouTube omit
  it;
- volume: Unsupported for YouTube (provider-owned) and Android audio
  (device-owned); output effects (Volume boost, Mono): Unsupported for
  YouTube and for any cross-origin media source — including every
  `OwnedVideo` ticket, since `createMediaElementSource` requires same-origin
  — Supported only for same-origin browser media;
- fullscreen and Media Session are separate host-qualified capabilities. In a
  browser host, ordinary or currently tracked OwnedVideo fullscreen is
  `Supported` only when
  `document.fullscreenEnabled`, the stable wrapper exposes
  `requestFullscreen`, and the host/Permissions Policy permits the call; a
  rejection updates it to `Unsupported` and removes the control, with no
  media-element native-fullscreen fallback that would drop Nexus chrome or
  captions. `YouTubeIframe.fullscreen=ProviderOwned` only when its iframe has
  `allowfullscreen` plus `allow="fullscreen"`, `playerVars.fs=1`, and the
  existing Permissions Policy delegates it. Otherwise it is `Unsupported`,
  passes `playerVars.fs=0`, and omits both delegation attributes so provider
  chrome cannot expose an unreachable fullscreen path. BrowserAudio fullscreen
  is `Unsupported`; `BrowserAudio` and non-YouTube-origin `OwnedVideo` publish
  `mediaSession: Supported` through the generalized adapter. YouTube-origin
  `OwnedVideo` publishes `Unsupported`, while `YouTubeIframe` publishes
  `ProviderOwned` (Nexus registers no metadata, state, or handlers). In the
  Android WebView host, both OwnedVideo and YouTube publish fullscreen and
  Media Session as `Unsupported` in v1: the native Media3 session has already
  been dismissed, `fs=0` is set for YouTube, and the WebView installs no
  `navigator.mediaSession` metadata, state, or handlers. No engine-only matrix
  may erase the host dimension;
- **Highlight** creates a durable time point; existing **Capture** keeps
  Walknotes semantics;
- natural end, Reset progress, previous/next, dismissal, focus, safe-area,
  and one-live-region rules remain canonical.

Activation applies the stored rate only if supported, otherwise the
engine-reported `defaultRate`. The rate capability carries a
`Pending { requestedRate, deadlineMs }` arm: a rate absent from the
published set is rejected at the control and never commanded; a commanded
rate renders pending until the engine's confirmation event (`ratechange`;
the embed's rate-change notification; the Android protocol round trip);
deadline expiry reverts the control to the engine-observed rate without
failing the session; persistence happens only on confirmation.

Player presentation is exhaustive: `Resolving` shows **Loading media…**;
`Buffering` shows **Buffering…** without stealing controls; `NeedsGesture`
shows **Tap to play** with one affordance that calls the engine's play under
a real user gesture — every adapter classifies a rejected start
(`NotAllowedError`; a YouTube player still unstarted after `playVideo()`) as
`NeedsGesture`, never `Failed` or silent `Buffering`, and the playback
ticket is prefetched on activation intent so no user-visible play depends on
a network round trip inside the gesture; `Ready` shows the
engine/capabilities; terminal `Failed` renders the exact
`YouTubeEngineFailure`/owned-engine copy and only the action authorized by that
arm—Retry is absent for non-retryable provider/identity/protocol failures. Each
`PlaybackUnavailableReason` has its matching presentation
arm. **Open source** is available when provenance permits but is always an
explicit navigation action, never source fallback. A kept-object failure
uses **Couldn’t play the kept copy** and cannot switch engine implicitly.

When a readable transcript publication exists for a non-YouTube `OwnedVideo`
session, or for a YouTube-origin `OwnedVideo` session whose current observation
decision is `Tracked`, the engine
host owns one `TextTrack` created through `addTextTrack('captions', 'Nexus
transcript', language || 'und')`, inserts validated `VTTCue`s from the current
publication, and exposes a **Captions** toggle — absent when no publication
exists or that YouTube session is `Untracked`/unavailable. A restricted
YouTube-caption publication reaches this path only after
the same authorizer/live-approval/use-policy check as cue read; expiry or head
removal synchronously clears cues and the toggle before repaint. It starts disabled unless the live session already enabled it; replacing
or observation downgrade, ending the session removes every old cue before
reuse/teardown. `Untracked` YouTube-origin owned playback never installs cues,
caption toggle, transcript-follow/seek, or a temporal action even when metadata
still names a publication. This avoids
an unowned Blob URL and CSP exception. The ordinary/tracked OwnedVideo
fullscreen wrapper keeps
the single Nexus chrome and caption toggle; provider-owned YouTube fullscreen
uses provider captions and receives no Nexus overlay.

`listeningHeartbeat.ts` is renamed, not deleted:
`lib/player/playbackHeartbeat.ts` preserves its contract verbatim (one
in-flight PUT with newest-sample coalescing and dirty-version retirement,
injected generation + per-send sequence with mandatory server echo
verification, the 20-second deadline, GET-based recovery adopting a changed
`reset_epoch` with a seek, Suspended/Resumed persistence states,
`drainAndStop` before ResetProgress, the `beforeunload` keepalive flush) and
gains the sealed `timelineHandle` in the body plus the new epoch-mismatch
rejection evaluated before the existing CAS.

### Android

`globalPlayer.tsx` stops being an exclusive per-platform provider selector
and becomes the one shell-level `PlayerEngineHost` composing the native
Media3 adapter (ExternalAudio + PreviewAudio) and the browser adapters
(OwnedVideo, YouTubeIframe) under a single session owner;
`AndroidPlayerRuntimeProvider` becomes an engine adapter, not a whole
runtime. In the Android shell the WebView owns the video/iframe node,
TimelineClock, playback-state heartbeat, and engine-observation emission.
Cross-runtime exclusivity is Nexus-owned, never OS audio focus: activating a
WebView video engine first issues the existing native `Dismiss` for the
canonical native session (not `Pause` — ExoPlayer's focus handling would
auto-resume the podcast when the video pauses) and releases its
notification; activating native audio tears down the WebView engine node
first. Both directions are a session-bound two-phase handoff: await the exact
matching native `Dismissed` or WebView `EngineTornDown` acknowledgement under
a committed bounded deadline, then start the requested engine. Stale or
session-mismatched acknowledgements are ignored; timeout/failure leaves the
requested engine unstarted and projects a typed handoff failure, so two
runtimes can never overlap. The closed bridge corpus defines native
`Dismiss { commandId, sessionKey }` -> `Dismissed { commandId, sessionKey,
outcome: Released | AlreadyAbsent }`, WebView `TearDownEngine { commandId,
documentGeneration, sessionKey }` -> `EngineTornDown { commandId,
documentGeneration, sessionKey, outcome: Destroyed | AlreadyAbsent }`, and
native `HostSuspendRequested { documentGeneration, lifecycleGeneration,
expectedSession: Presence<SessionKey> }` -> web `HostSuspendAcknowledged {
documentGeneration, lifecycleGeneration, observedSession:
Presence<SessionKey>, outcome: PausedAndFlushed | PausedFlushDeferred |
NoActiveEngine }`. The host always performs this exchange because native state
may be stale. `PausedAndFlushed | PausedFlushDeferred` require both Presence
values and exact session equality; `NoActiveEngine` requires both Absent. Any
other pairing is malformed and triggers document destruction.
`PausedFlushDeferred` proves playback
and observation stopped but honestly leaves outbox delivery pending. Unknown
keys/tags/outcomes, strings over their field bounds, or a message over 64 KiB
are rejected. Web messages are accepted only from the configured owned HTTPS
origin, top-level main frame, current document generation, and exact bridge;
the YouTube child frame can never speak this channel. Native commands/events
use the same closed correlation decoder. Corpus fixtures cover every accepted
arm and rejection, and its exact bytes own the digest. The protocol hard-cuts vocabulary — `ListeningState` ->
`PlaybackState`, `AdoptListeningState` -> `AdoptPlaybackState`,
`FooterAudio` -> `TimedMedia`, `AudioSession` -> `TimedMediaSession`,
`LoadCanonical.session` accordingly — and the `TimedMedia` activation,
`PlayerSnapshot.Canonical`, the native playback-state PUT body, and
`AdoptPlaybackState` all carry the sealed `timelineHandle` as a bounded,
strictly decoded opaque string; the native side maps epoch-mismatch/binding
rejection to a distinct non-retrying persistence outcome that ends the
native session. Native Listening spans carry the handle through a new
`NativeActivityOutbox` column and upload field. The protocol version stays
`2`: the corpus bytes change, so the corpus digest is the whole identity
bump; `release_artifact.py`, the manifest schema, and `/version` are
unchanged, and the corpus stays byte-exact (UTF-8, no BOM, LF, one trailing
LF) with its digest updated in `testdata/manifest.json` in the same commit.
`NexusWebView.configure` keeps
`mediaPlaybackRequiresUserGesture = true` for every caller, including
`MainActivity`'s primary owned-origin WebView; no `TimedMediaHost` autoplay
exception exists. A rebuilt document, ticket/profile handoff, or new engine
therefore returns paused and requires an explicit user gesture. This costs one
tap after those transitions, but it keeps strict-untracked activation and the
shared secure default identical and mechanically auditable. Media Integrity
configuration is scoped to `MainActivity`'s primary host and cannot leak
through the shared configure helper. Before authorizing or constructing an
Android `ExternalYouTube` iframe, the host requires
`WebViewFeature.isFeatureSupported(WEBVIEW_MEDIA_INTEGRITY_API_STATUS)` and
successfully applies the origin-scoped app-identity configuration for the
exact `youtube.com` tracked or `youtube-nocookie.com` raw-no-JS origin;
absence or configuration rejection is local `MediaIntegrityUnavailable` and
no iframe is constructed. `YouTubeOriginOwnedVideo` uses certified private R2
bytes in `<video>` and never requests or treats Media Integrity as its trust
primitive; its independent asset authorization, profile binding, and origin
ticket remain mandatory. `MainActivity` gains exact
`android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|
uiMode|fontScale|density"` so the WebView document — and the active video
session — survives rotation, fold/multiwindow, font-scale, density, and theme
changes. `onConfigurationChanged` reapplies theme/resources/window insets
without recreating the WebView; physical rotation, fold/multiwindow, theme,
font-scale, and density changes are device proofs. Every pause/resume cycle
increments a host-owned `lifecycleGeneration`. `onPause` starts a non-blocking
`HostSuspendRequested` handshake carrying that generation; the web side first
stops sampling/writes, pauses and confirms the exact engine (destroying an
unconfirmed provider engine), closes the open Viewing span, and enqueues the
final playback-state write before its typed reply. The committed
`ANDROID_VIDEO_SUSPEND_ACK_TIMEOUT`
deadline never blocks the Android main thread. On a current matching
acknowledgement, Android calls only the instance-scoped `webView.onPause()`; it
never calls process-global `pauseTimers()`. On missing,
malformed, or stale acknowledgement, it first removes and destroys the entire
WebView/document (not merely timers), records no open span or successful flush,
and only then completes host pause; if stop cannot be proved, document
destruction is the proof. `onResume` advances the generation so late replies
are ignored only after the host lifecycle FSM resolves
`Active -> SuspendPending(document,generation,expectedSession) ->
SuspendProven | Destroyed`. If `onResume` arrives while SuspendPending, Android
synchronously destroys that document before advancing the generation; only a
SuspendProven document may survive and call only instance-scoped `onResume()`.
`onStop`/`onDestroy` immediately destroy any Pending document because a timer
cannot be trusted after lifecycle/process suspension. A destroyed document is
rebuilt from the owned origin. Either way the exact
bridge/session is re-established paused and playback requires explicit user
intent. Rapid pause/resume before acknowledgement, pause->stop before timeout,
late reply, renderer hang, and a physical
speaker/audio probe prove no playback survives backgrounding. This deliberate
fail-stop can lose WebView presentation continuity after a hung bridge; policy
and cross-runtime exclusivity take precedence. These races and Media Integrity
feature absence are observable device evidence. A multi-WebView device proof
keeps popup/ShareActivity timers independent and asserts no production call to
global `pauseTimers`/`resumeTimers`. Its engine accepts
`ExternalAudio` and `PreviewAudio`; OwnedVideo/ExternalYouTube are handled by
the WebView browser engines, foreground-only in v1.

## Transcript and temporal Highlight behavior

Transcription is always durable and explicit. The request transaction performs
no provider call. The worker tries, in order:

1. a declared Podcast publisher sidecar;
2. YouTube captions only when `CaptionTransformApproved`, through the official
   Data API: the one secret-owner refresh credential is bound to the sole Nexus
   user, exact OAuth client/project and exactly
   `https://www.googleapis.com/auth/youtube.force-ssl` (no broader scope), and its
   `channels.list(mine=true)` channel; startup, admission, immediately before
   list/download, and publication all require that binding and the signed
   approval artifact to agree. Access tokens are memory-only. The credential
   authorized to edit the exact video calls `captions.list`, selects in order
   with one pure stable key over proven metadata: exact canonical
   Media/Timeline language match first, then manual before generated, then
   canonical language tag, NFC-normalized track name, and caption id as
   ascending UTF-8 bytes. Thus exact-language automatic captions outrank a
   manual track in an unrelated language, while manual wins within the same
   language class. It calls `captions.download` for that exact id. Shuffled API
   responses must select the same id. Missing edit permission, OAuth, track
   metadata, or download authorization means this source is unavailable; Nexus
   never scrapes watch/embed pages, player responses, or caption URLs. A
   provider response that cannot prove an eligible exact `snippet.trackKind`
   (`standard` or `ASR`) records
   `E_TRANSCRIPT_CAPTION_METADATA_UNPROVEN` and stops without dispatching a
   paid source; it is never a guess. A revoked/disconnected credential removes
   caption admission immediately and arms the lifecycle deletion deadline.
   Explicit **Disconnect YouTube captions** first commits local fail-close:
   insert the exact binding deactivation while retaining the active-binding row
   solely as the no-new-use drain fence, create/advance the early purge for every
   companion/publication authorized by that credential, transfer the neutral
   credential to one `YouTubeCredentialRevocation(revocationId)`, and promote the
   binding lifecycle. Only `OAuthBindingDeadlineFinalize` deletes that active row
   after every earlier credential use is terminal; the binding/head/snapshots remain as
   nonauthorizing cleanup ownership until that lifecycle settles. No query can
   forget a mutable status predicate because row existence is the authorization
   boundary.
   Local unpublication/deletion proceeds independently of Google and removes
   the binding/channel/consent Authorized Data by the compliance deadline.
   After commit, the minimal revocation worker uses prepare/I/O/settle. Under
   its claim it prepares/reuses the exact credential/ref; outside DB it calls
   Google's token-revocation endpoint; then a fenced DB transaction records
   immutable `Revoked | AlreadyInvalid` disposition and response digest. At
   the early `retry_until`, the typed due transition
   instead records `RemoteUnconfirmed` and supersedes even a dead correlation.
   Either disposition then invokes
   `settle_terminal_operation(YouTubeCredentialRevocation(revocationId),
   RevocationDispositionTransition, callback)`. After settlement/queue/
   correlation and account locks, the registered transition revalidates the
   exact disposition and append-only reason set, deletes the refresh-secret hold
   before its typed ciphertext row, and writes the content-free domain receipt
   with the reason-set digest before the coordination receipt. For
   `RemoteUnconfirmed` only, after that domain receipt and before the coordination
   receipt, the same registered transition creates/joins the unique
   `reason=RevocationRemoteUnconfirmed` actionable marker plus its typed
   revocation owner FK to that exact receipt; `Revoked | AlreadyInvalid` require
   both marker arms absent. A conflicting current marker or wrong receipt rolls
   back rather than losing the reconnect fence. Coordination
   alone terminalizes and removes the queue/correlation pair. The live Postgres
   commit is the secret-absence proof; there is no external delete/lookup/
   materialization step. Its deletion-only callback removes disposition,
   reasons, and revocation operation child-first; it removes the neutral
   credential only when pending/binding lifecycle ownership is already absent,
   otherwise that later owner deletes it behind the same non-FK receipt.
   Response loss repeats
   the provider revoke only as its documented idempotent endpoint permits and
   never invents a provider disposition. A missing KEK may prevent the remote
   call but cannot prevent deleting the exact ciphertext at the hard deadline;
   the outcome is `RemoteUnconfirmed` and the separate security incident stays
   release-blocking. The UI links
   the user to Google account security to revoke remotely. Multi-publication
   binding, provider outage beyond seven days, replay, and no-use-after-click
   proofs kill after provider response, disposition commit, ciphertext-delete/
   receipt settlement, binding cleanup, and terminalization;
3. existing hosted ASR for Podcast audio, or for a ready YouTube-origin owned-
   video asset only while the independent `OwnedVideoAsrApproved` arm is live;
   forecast, admission, pre-extraction, pre-dispatch, and publication all
   revalidate the exact artifact/asset/use-policy/disposition tuple.

Provider approval is not user OAuth consent. When—and only when—the signed
caption arm is enabled, Settings exposes **Connect YouTube captions**. The
server-side flow uses the exact request and callback contracts above: the
deterministic sealed one-use state capability, PKCE S256, `response_type=code`,
one HTTPS redirect/client,
exact `youtube.force-ssl`, `access_type=offline`, `prompt=consent`, and
`include_granted_scopes=false`. The callback never performs token exchange. It
atomically stores the short-lived authorization code and transferred verifier
as typed application-AEAD Postgres materials/holds, preallocates the neutral
refresh-credential resource, commits `YouTubeOAuthExchange`, scrubs the URL,
and redirects.

The exchange JobDefinition is Light, zero provider retries, and has strict
payload `{ exchangeIntentId }`. Its resolver follows the exact
attempt-to-credential allocation; no independent attempt/result/credential ids
can be substituted. Under its owned claim it resolves the raw code and verifier
only inside the secret owner, validates client/redirect/expiry, then
lease-fenced commits the immutable dispatch intent immediately before calling
the token endpoint exactly once. Absence of that dispatch intent proves the
POST was not armed and permits the same claim to continue; its presence without
a committed exact exchange result/refresh hold is uncertainty even if the
process may have died before socket write. It accepts only exact returned
scope, `token_type=Bearer`, and a nonempty refresh token; access tokens remain
memory-only. One transaction envelope-encrypts that token and inserts the typed
refresh material, exact credential hold, and exchange result; a committed result
can never point at absent ciphertext. A crash before dispatch-intent commit
can retry because no request was armed. At or after that commit, absence of a
committed result/refresh hold is `E_YOUTUBE_OAUTH_EXCHANGE_UNCERTAIN` and is
never resubmitted or guessed recoverable from an external store. Its only
resolution is `UnrecoverableRemoteGrant`: delete transient ciphertext, clear
the active marker, and instruct the user to revoke in Google account security.
A committed result resumes from Postgres without repeating the authorization-
code POST. Missing refresh token is the same fail-closed path, not an access-
token-only binding.

After a proven result, the worker exhaustively pages
`channels.list(mine=true)` through the bounded page/byte/label owner above. In
its owned claim it first seals the exact credential-use request/result set and
creates one immutable per-channel allocation plus duplicate-Presence child for
every bounded eligible channel. It then calls
`settle_terminal_operation(YouTubeOAuthExchange(exchangeIntentId),
ExchangeOutcomeTransition, callback)`. Under settlement/queue/correlation and
account locks, the registered terminal transition creates exactly one durable
successor: a pending row whose allocation-set count/digest and associations
equal that completion plus `YouTubeOAuthPendingExpiry` as `AwaitingDispatch`, or
`YouTubeCredentialRevocation` for zero eligible channels/unclosed or over-limit
pages. It transfers the refresh hold, creates the successor/dependency, and
writes the content-free exchange domain receipt before the coordination
  receipt. It never deletes the sole refresh credential before a durable successor
  owns it. The deletion-only callback follows the restrictive-FK order: active-
  attempt marker and exchange result; exchange dispatch intent; code/PKCE holds,
  then their materials; exchange intent/domain operation; then the attempt-to-
  credential allocation; and—if replay retention already ended and no remaining
  owner references it—the neutral attempt. The transferred refresh hold,
  credential, pending-owned channel allocations, and their credential-use
  provenance remain.

Invalid token response or `UnrecoverableRemoteGrant` uses another registered
terminal transition to create the typed `ExchangeGrantUnrecoverable` actionable
  marker and domain receipt before coordination settlement. Its deletion-only
  callback then follows the restrictive-FK order: active-attempt marker;
  resolution before uncertainty; exchange result before refresh hold, and refresh hold before refresh material;
  credential-use duplicate/association children, completion members, completion
  seal, terminal results, dispatch intents, typed use owner, then neutral use;
  exchange dispatch intent; code/PKCE holds then materials; exchange intent/
  domain operation; attempt-to-credential allocation; and only then the now-
  unowned credential. Optional/absent rows are skipped, never reordered. It preserves
the neutral authorization attempt, host binding, expiry operation, and callback
replay tombstone until their already-committed replay-retention owner deletes
them; no unusable credential survives and the projection cannot remain
`Connecting`. Only after settlement commits does postcommit admission enqueue
pending-expiry or revocation. There is no external secret deletion, lookup,
absence row, or post-dispatch recovered-secret arm.
Startup blocks all caption use while any exchange is uncertain and scans exact
expiry/exchange correlations, active markers, typed holds, and materials before
serving caption routes. Crash proofs cover every callback-material/dispatch/
POST/result/successor/ciphertext-delete/settle prefix and reject uncertainty
plus result, cross-user pairing, an unowned material, or more than one hold.

`services/youtube_oauth_access_tokens.py` is the only refresh-token grant
owner used before channel enumeration, binding refresh, or caption list/download.
Revocation is deliberately outside this owner: it decrypts the refresh
credential only for Google's documented revocation request and never obtains an
access token. `jobs/youtube_oauth_credential_use_capabilities.py` is an
exhaustive registry of caller OperationRef resolver, terminal predicate, and
allowed ordered dispatch kinds; an unregistered caller cannot allocate or arm
provider use. The only entry paths are currently owned
`YouTubeOAuthExchange`, `YouTubeOAuthBindingLifecycle`, and
`YouTubeCaptionLifecycle`/registered caption-source OperationRefs. Access-token
prepare runs inside `with_owned_operation_claim(callerRef, workerId, attemptNo,
domainMutation)`: it renews and locks the exact queue/correlation before the
account gate, proves the caller domain identity and live claim, the exact active
binding or exchange/pending credential hold, absence of deactivation, and the
current project/client/scope/approval. That transaction allocates one neutral
credential-use generation plus its exact caller-owner arm. A stale, dead,
cancelled, mismatched, or lease-lost caller cannot create a use.

Immediately before every provider socket handoff, another owned-claim
transaction renews the same claim, revalidates those account facts, and commits
the next exact child dispatch intent/canonical request/deadline. The first arm
is `RefreshGrant`; later arms are the registry-permitted fully paginated
`ChannelsList`, or `VideosList -> CaptionsList -> CaptionDownload`, sequence.
That committed child is the authorization linearization point. With no DB lock
or transaction open, the envelope owner decrypts the refresh credential for the exact Google token
POST (`grant_type=refresh_token`, configured client authentication, no scope
escalation), then drops the raw credential. A closed response requires a
nonempty access token, `token_type=Bearer`, and bounded positive `expires_in`;
if `scope` is present it must equal the stored exact scope, while Absent means
the already-granted stored scope per the refresh-token contract—not a broader
grant. A returned refresh token, ID token, unknown decision field, malformed
value, or broader/different scope fail-closes and deactivates with
`RefreshFailed`. `invalid_grant` performs the same local deactivation and joins
revocation; network/429/closed 5xx is bounded retryable and leaves the binding
active. Response loss may repeat only this non-mutating refresh grant, never the
one-use authorization-code exchange. Settle retakes the account gate and the
same owned claim, rechecks active binding/credential/approval and absence of
deactivation, and writes the exact terminal result; claim or authorization
drift writes only a fenced result and discards the token/response. Once the
bounded parser proves the required terminal page, every armed child has a
terminal result, and the chosen response chain is authenticated and complete,
that same claim transaction inserts the immutable completion seal plus one
member for every request/result. Count and ordered request/result digests must
equal the complete child set. A missing/extra member, mixed caller, cross-use
result, unfinished page, response-lost selected response, or changed request
rejects the seal. The pending channel-list owner, binding channel-data owner, or
caption-data allocation is inserted in that transaction and composite-FKs the
exact completion; provider bytes cannot be allocated first and attached to a
later use. Access-token bytes/response bodies
are never persisted, cached, queued, or logged and expire in memory no later
than the provider deadline.

Disconnect/deactivation linearizes at the deactivation row: every capability
read fails closed and no new dispatch intent can arm. A provider call whose
intent committed earlier may still reach/finish at Google after the user's
click; this bounded residual is explicit and its late bytes can never publish.
The disconnect owner enumerates those exact armed intents, requests
cancellation, fences their caller claims, persists the exact DrainDue wake for
their latest request deadline plus TERM/KILL grace, and returns. Termination/
result events can advance the same ref; a later invocation continues only after every intent has a
terminal result does it delete the active-binding marker and proceed to
revocation. Therefore zero provider use occurs after the active marker
disappears, without holding an account lock across network I/O. This trades a
bounded `Revoking` drain and possible already-authorized provider request after
click for a race-free capability boundary. Tests pause at claim renewal, use
allocation, every arm, socket handoff, response, member/seal creation, and data
allocation. They cover lease loss/dead caller, cross-operation/use/result
substitution, wrong or unfinished page sets, `videos.list` omission, response
loss, invalid grant, transient exhaustion, concurrent Disconnect/revocation,
scope absent/equal/drift, token expiry, redaction, late-result suppression, and
zero use after active-marker removal.

Credential-use rows are restricted lifecycle evidence, not permanent audit
history. A failed or no-data caller child-first deletes terminal results,
intents, owner, and neutral use after its claim consumes the outcome. A
completion-linked set remains only while its channel/caption allocation needs
that provenance. Its exact restrictive-FK purge order is semantic associations/
duplicate-or-cue children -> channel/caption allocation(s) -> completion members
-> completion seal -> terminal results -> dispatch intents -> operation owner ->
neutral use, in one account-gated owner transaction. Disconnect/revocation first settles every use, then deletes all
restricted allocations and their provenance before active-marker/credential
deletion; an unterminated child or restrictive FK prevents the credential from
disappearing. Account erasure's generated FK inventory includes the full use/
seal/member/allocation graph. Crash/replay proofs stop after every child-first
boundary and prove no lost live arm, detached data allocation, or indefinite FK
blocker; a fault is injected after every boundary in that order.

The pre-consent surface displays the exact scope, what caption/channel data Nexus
will retrieve, private-display/timing/plain-copy purposes, day-28 refresh/day-30
and revocation deletion rules, prohibited uses, the channel the user will
choose after Google authorization, how to
disconnect/revoke, a concrete support/privacy contact, and links to YouTube
Terms of Service, Google Privacy Policy, Google account security/revocation,
and Nexus Privacy/Terms. Every nonempty bounded `mine` result—even one channel—
creates a pending row, one association per immutable per-channel allocation, and exact due
`YouTubeOAuthPendingExpiry` operation, and requires a final Nexus
confirmation showing the exact channel through a sealed, one-use
`YouTubeOAuthPendingHandle`; the
refresh token is already secret-owned, never the browser. Selection unseals
identity, then reauthorizes current user/expiry/unused row, exact completion/set
digest, and associated `mine` allocation before the registered terminal
settlement transition creates binding plus active marker/first snapshot head/
lifecycle and writes the pending-expiry `Connected` domain receipt. Its post-
receipt callback deletes pending associations and every unselected allocation;
the selected allocation is transferred by FK, never copied. Cancel or the
independently scanned ten-minute expiry uses the same settlement boundary to
atomically transfer the neutral credential to the durable revocation operation
(`PendingCancelled` or `PendingExpired`) and write `RevocationTransferred`
before its coordination receipt; the deletion callback removes all pending data
and provenance, and postcommit only admits revocation. No path deletes
the sole refresh secret before a
`Revoked | AlreadyInvalid | RemoteUnconfirmed` receipt.
Callback/state or pending-handle replay, invalid selection, and an already
active binding fail closed; reconnect requires completed Disconnect rather
than silently replacing credentials. The neutral credential records the
accepted consent-document SHA separately from compliance approval; callback
without the current consent version fails. `apps/web/src/app/privacy/page.tsx` names
YouTube API use, purposes, retention/deletion, sharing prohibition, security,
revocation/disconnect, and contact; `terms/page.tsx` links and requires
agreement to YouTube Terms. Browser/route tests cover cancel, CSRF/state/PKCE,
scope escalation, multi-channel selection, revocation pending/success, policy-
version change, callback replay/abandonment/expiry/reconnect, every exchange
crash boundary (before/after code allocation/write/materialization and before/
after dispatch intent, POST, refresh-secret write, materialization, result),
secret-orphan cleanup, and both public documents. No caption
feature ships with placeholder legal copy.

Channel id/label are Authorized Data, not permanent account decoration.
Selection transfers exactly the chosen per-channel allocation from the pending
association set into one binding selection, deletes every unselected allocation,
and creates generation-one immutable channel snapshot/head plus
`YouTubeOAuthBindingLifecycle` and admits its strict Light
`youtube_oauth_binding_lifecycle { lifecycleOperationId }` job postcommit. It
re-lists the exact selected channel no later than day 28. An authenticated,
bounded, fully paginated exact-identity response first commits the exact
credential-use completion, one immutable per-channel allocation, and a binding
selection/refresh-result association for the matching channel under the old
owned claim; every nonselected refresh allocation is deleted in that same
transaction. The refresh result composite-FKs the allocation's completion owner
to that exact lifecycle OperationRef. It never copies channel id/label/expiry
between pending, selection, snapshot, result, or lifecycle rows.
Publication then enters a fresh
`with_owned_operation_claim_set(currentLifecycleRef=Mutate,
priorSameBindingRefs=ObserveTerminal, ...)` transaction: the complete
same-binding generation set is resolved and queue/correlation ownership is
renewed/locked, then the singleton schedule gate and current OAuth allocation
are locked before the account gate, binding/head/current snapshot,
deactivation, result identity, approval, and deadline. A prior generation with
nonterminal domain or queue truth causes a no-write reconciliation retry; it is
never ignored because the head advanced. Only that transaction inserts
generation N+1 snapshot referencing that same allocation plus successor
lifecycle as `AwaitingDispatch`,
creates a successor neutral capacity allocation/schedule owner/typed binding arm
or transfers the unchanged earlier allocation when it remains stricter,
deletes the old typed arm/schedule owner and any replaced allocation,
creates the successor -> old terminal dependency, CAS-swaps the head, and
writes old-domain `RefreshedSuccessor`; claim loss,
cancellation/deactivation, expiry, or competing recovery writes nothing. After
commit `settle_terminal_operation(oldLifecycleRef, RefreshedSuccessor,
callback)` writes/links the coordination receipt, removes the old queue target,
then its deletion-only callback child-first erases the old refresh-result
association/lifecycle/snapshot (whose schedule owner is already gone), prior selection/allocation and its use
completion provenance once unreferenced; postcommit admits the successor.
`Connected.selectedChannelLabel` reads only the current head. Same-binding
composite FKs reject a refresh result/allocation from another binding or another
lifecycle on the same credential.
Crash/replay at result, schedule allocation/typed-owner swap, head swap,
dependency, coordination receipt/job/
correlation removal, old-data erase, and
successor admission converges; two complete refresh generations are canonical
proof, so monthly refresh is not a one-shot row update.

Missing/revoked/ambiguous results nonlocking-resolve, then take the singleton
schedule gate/exact allocations before the account gate for one
`deactivate_youtube_caption_binding` transition: insert exact deactivation,
create/join credential revocation plus its reserved-headroom neutral/typed
OAuth schedule owner, drain/fence earlier credential uses, then
delete the active marker. For explicit
Disconnect the deactivation is inserted first and active-marker deletion waits
for the credential-use drain above; provider-failure/deadline paths use the same
fenced drain. Disconnect uses the typed `OAuthBindingDeadlineFence` then
`OAuthBindingDeadlineFinalize` ports over every live/dead/expired same-binding
lifecycle ref before binding deletion; ordinary claim-set supersession is
forbidden. No OAuth/user/account gate is held while a Media lock is
acquired. After commit, the owner enumerates exact restricted-publication refs
and invokes each through a fresh per-Media gate in ascending Media order; each
rechecks absent authorization and promotes its own lifecycle, while a missing
or tearing-down Media is typed no-op. The account operation never directly
mutates Media. Revocation settlement erases binding head/snapshots/lifecycles/
deactivation only through the settlement primitive after their coordination
receipts exist and credential secret
absence is proved. At early purge due, the same transition deauthorizes
locally; startup/readiness refuses any Authorized Data beyond day 30 rather
than inventing deletion. Proofs cover two refresh cycles, refresh-result versus
disconnect, refresh/disconnect versus caption publish and whole-Media teardown
in opposing lock order, dead-through-deadline, exact-label projection, and zero
Authorized Data after settlement.

Desktop Connect opens a top-level browser navigation. Android opens the Nexus
Settings HTTPS page itself in a system Custom Tab before Start; Google
authorization never runs inside WebView. The user authenticates to Nexus in
that browser context when its cookie jar lacks a session, then the ordinary
Settings form performs the exact Browser start POST and receives the Google
303. The same Custom Tab therefore owns the authenticated Nexus session,
per-attempt `__Host-` cookie, Google navigation, server callback, and query-free
Settings completion; there is no state-only Android callback or cookie-jar
handoff. Completion shows a visible **Return to Nexus** verified App-Link that
only resumes Settings and carries no state/code/handle. `MainActivity` accepts
that link only for the exact HTTPS origin/path and otherwise leaves it to the
browser. Cancellation/process death simply leaves the server-owned Browser
attempt for its expiry owner; reopening Settings projects current truth.
Native code never owns state, PKCE, an authorization URL, token exchange, or a
new JS/native protocol boundary. This deliberately accepts possible Custom Tab
Nexus re-login and one explicit return tap to avoid a weaker mobile OAuth
security model. A real-device trace proves Google content never commits in
WebView and both desktop/Custom Tab callbacks require the same session+cookie.

Source advancement is a closed owner result, not exception folklore:
`Found | DefinitivelyUnavailable | RetryableDependencyFailure |
InvalidOrPolicyFailure { code }`. Only `DefinitivelyUnavailable` (proven
absence or authorization ineligibility) advances to the next source already
named in the confirmed forecast. A retryable network/quota/5xx response stops
with its retryable code, and invalid bytes, provenance ambiguity, or policy
failure stops with its non-retry code; neither can silently convert a free
source failure into a billed dispatch. The forecast, reservation, runtime
selector, and fault proof share this exact transition table.

Every provider adapter returns a closed provenance union, never a bag with an
ambiguous `isGenerated` boolean:
`PublisherSidecarFetch { rawBytes, contentType, language, segments } |
YouTubeCaptionFetch { rawBytes, contentType, language, segments, captionId,
videoId, trackKind: Manual | Automatic, authorizingUserId, channelId,
oauthBindingSha256, approvalArtifactSha256, credentialUseCompletionId,
retrievedAt, expiresAt } |
HostedAsrFetch { rawBytes, contentType, language, provider, modelId,
segments }` — always the exact bytes parsed. Podcast publisher
sidecars go through `safe_get` with explicit `max_bytes` and content-type
checks; YouTube caption listing/download use only the official authenticated
API adapter on `http_retry` with the same byte bound. Closed transient
sidecar/caption dependency outcomes map to `E_TRANSCRIPT_SOURCE_DEPENDENCY`;
invalid content type or bounded payload maps to
`E_TRANSCRIPT_SOURCE_INVALID`. Any other outbound
HTTP in the transcript or copy lane is a defect (residue-gated). Podcast
hosted ASR switches from URL submission to a bounded streamed read Nexus
digests and submits through the provider's raw-audio path; Nexus never
digests a URL string. Origin and digest are keyed by input kind: publisher
sidecar bytes -> `origin=Publisher`, `input_kind=SidecarBytes`; either approved
YouTube caption kind -> `origin=Imported`, `provider='youtube_captions'`,
`input_kind=CaptionBytes` plus its mandatory restricted publication-data/
allocation/lifecycle association; Nexus hosted ASR -> `origin=Generated`,
`provider='deepgram'`, `model_id` present, `input_kind=StreamedAudioBytes`
(podcast) or approval-gated `ExtractedAudioBytes` (YouTube owned video), with
the latter's mandatory restricted-ASR companion/lifecycle; migrated rows use only the
canonical migration digest. `input_sha256` is always the digest of the bytes
actually read/submitted, never copied from a stored identity, and is NOT
NULL because every origin now has exactly one defined byte source.
`provider`/`model_id`/`language` populate only from the adapter result and
are Absent when unprovable. The projection derives provenance structurally:
publisher sidecar -> `PublisherProvided`; caption publication-data association
and its allocation's manual/automatic fact ->
`YouTubeCaption { kind: Manual | Automatic }`; other imports -> `Imported`;
hosted Nexus ASR -> `Machine { producer=Nexus }`, with use policy still derived
from its companion rather than provenance label. It never asks the frontend to
infer producer or billing from the ambiguous word `Generated`. A machine
publication is replaceable exactly when its producer is not Nexus and a
current owned asset plus live `OwnedVideoAsrApproved` makes hosted ASR admissible.

The caption adapter first requires one exact official
`videos.list(part=id,snippet,status)` item for the frozen provider id and
equality-checks its `snippet.channelId` to the selected binding channel; absent,
duplicate, mismatched, or unknown identity fields fail closed before caption
bytes. It then equality-checks each caption `snippet.videoId` to that same id,
requires `status=serving`, `isDraft=false`, and the primary audio-track policy,
maps only `trackKind=standard` to `Manual` and `trackKind=ASR` to `Automatic`,
and treats `forced`/unknown track kinds and commentary/descriptive/unknown
audio tracks as ineligible rather than relabelling them. Selection is over
these eligible facts only. `captions.download` requests one fixed `tfmt=vtt`
and uses the one VTT parser; no content-negotiated format fallback exists.
`channels.list(mine=true)` must contain the explicitly configured selected
channel id; zero or multiple results without that selection fail closed, so
the adapter never infers a sole owner from response order. Adapter, schema,
shuffled-selection, wrong-video/status/draft/track-kind/audio-track/channel,
and fixed-format proofs populate every mandatory companion field.
For an initial official-caption attempt, the owned `TranscribeMedia` claim
first nonlocking-resolves its source/credential facts, then takes coordination,
the singleton schedule gate/exact allocation rows, account, and Media locks in
the canonical order. Before decrypting a credential, arming a provider request,
or accepting any restricted byte, that transaction creates the exact
credential-use OperationRef owner and one
`media_youtube_caption_initial_capacity_reservations` row composite-FKed to
the same transcription job, source attempt, credential use, Media, and neutral
`Caption` allocation. If the reservation-or-live cohort is already 16 or no
deadline window fits, it creates neither provider capability nor data and
Default advances to the next already-authorized source. The owned claim later
creates the restricted allocation, cues, and exactly one initial-use owner in
one provider-result transaction; that owner composite-FKs both the adapter
completion and the unchanged capacity reservation to the same transcription
job and Media; staged truth derives from that typed owner/cue set rather than a
reservation status. That association
is staged-only: the initial publication transaction validates it, creates the
publication-data association, lifecycle, and live caption schedule on the
same neutral allocation, then deletes the initial-use owner and reservation in
that one transaction. Stable completion provenance remains on the allocation,
so later pruning of `TranscribeMedia` is FK-safe. A failed/cancelled/teardown
attempt retains the reservation until its exact credential dispatch, provider
write, staged cues/allocation, and late-result path are terminal or absent;
only registered child-first cleanup then deletes the reservation followed by
the neutral allocation. A refresh creates exactly the mutually exclusive
staged lifecycle-use owner described below and continues to use the existing
live schedule until its atomic successor swap.
Zero/two staged owner arms, a
BindingLifecycle completion, or another caption/Media OperationRef on the same
credential rejects before allocation. Real-FK proofs exercise both arms and
same-credential cross-operation/cross-Media substitution, plus crash before/
after pre-I/O reservation, provider dispatch, staged-owner creation, and
reservation-to-live transfer for initial publication, and staged-owner
consumption for refresh publication. They assert every neutral Caption
allocation has exactly one reservation-or-live owner at every committed prefix,
including cancellation, teardown, host death, and response loss.

The reservation id is also the stable
`YouTubeCaptionInitialLifecycle(initialReservationId)` domain OperationRef.
Its creation transaction inserts the exact initial -> `TranscribeMedia`
coordination dependency, immutable deadline ids, neutral wake sequence/typed
owner/current wake, and the domain ref as `AwaitingDispatch`; postcommit and
startup admit or join its due queue target. The
`youtube_caption_initial_lifecycle` Light JobDefinition has strict payload
`{ initialReservationId }`, literal kind/resolver/terminal-predicate checks,
`deadline_lane_policy=StaticCompliance { laneKind=Caption }`,
`max_attempts=5`, `retry_delays_seconds=(60,300,900,3600)`,
`lease_seconds=300`, `heartbeat_interval_seconds=30`,
`wall_timeout_seconds=900`, and `never_prune_dead=True`; only the Caption lane
may claim it. Its resolver follows the reservation's real FKs to the exact
source attempt, credential use, capacity allocation, and observed
`TranscribeMedia` ref. Its own handler never downloads or publishes.

Initial publication invokes the two-ref set primitive with
`authority=CaptionInitialPublicationTransfer(initialReservationId,
transcriptionJobId, workerId, attemptNo)`, never the singleton Initial
settlement port and never after independently taking work locks. The primitive
pre-acquires both settlement/queue/correlation sets, validates the exact owned
TranscribeMedia claim/lease plus unclaimed settleable Initial peer, then its
registered transition validates the exact completion/staged-owner/cue set,
materializes publication data plus `YouTubeCaptionLifecycle` and its successor
dependency, transfers the unchanged neutral + typed Caption allocation and
wake authority to a live Caption schedule, writes the content-free initial and
TranscribeMedia domain receipts, and only then lets coordination write both
receipts and remove both queue/correlation pairs. The deletion-only callback
removes initial
staged-owner and reservation-specific wake/operation rows; it never deletes the
transferred allocation or creates publication state. `NoData`
does not use singleton settlement: `CaptionInitialNoDataAdvance` proves the
official-caption source definitively unavailable, terminalizes/receipts Initial,
cleans its staging/wake/reservation/capacity, and atomically advances the still-
owned TranscribeMedia claim to its pre-sealed next source.
`CaptionInitialSourceFailed` covers retry-exhausted dependency and invalid/
policy failure, writes `SourceFailed`, terminalizes both refs, and never falls
through to paid ASR; `CaptionInitialCancelled` requires work cancellation and
terminalizes both. Both child-first delete any staging/use graph before wake,
reservation, and capacity. At the early boundary,
`CaptionInitialDeadlineFence` creates/equality-joins the preallocated exact
two-ref fence, rejects all later provider/result/staging acceptors by row
existence, persists the next wake, and returns. The later
`CaptionInitialDeadlineFinalize` requires terminated or content-free-settleable
work, deletes every staged restricted byte/use fact through registered terminal
transitions, writes `DeletedAtDeadline | DeadExpired | TeardownDeleted`, and
settles both refs without an in-process wait. Response-loss replay joins the
same receipts. Teardown, binding deactivation, approval loss, and account
erasure discover this ref and invoke the same Fence/Finalize authority; none
may delete or release its capacity directly. Proofs cover zero correlation,
dead/expired/claimed transcription, opposing Initial claim, TranscribeMedia
lease loss, NoData -> exact next source, failure/cancellation without fallback,
late provider response, two-ref publication/outcome transfer versus Fence,
crash at every transfer/receipt/delete, zero/two reservation-or-live
owners, and zero restricted/wake residue.

`services/transcripts/use_policy.py::TranscriptUsePolicy` is the sole
fail-closed consumer policy, derived server-side from the exact current
publication, its mutually exclusive restricted publication association/data
allocation, authorizing
principal, live matching approval artifact, and unexpired lifecycle deadline;
caption additionally requires the active OAuth binding. Its closed arms are
`Ordinary`, `RestrictedYouTubeCaption { plaintextResidualApproved: true }`, and
`RestrictedYouTubeOwnedAsr { plaintextResidualApproved: true }`. Both
restricted arms project semantic status `InapplicableByPolicy`, create no
semantic intent or general text index, and are rejected before text access by
transcript-Highlight/re-resolution, action facts, repository/search, resource
graph/link/note creation, Ask/Learn/context assembly, chat/evidence, public
share, Vault/export, and every AI disclosure path. Those entry points call this
owner rather than each carrying a provenance list; an exhaustive static
call-site inventory and server tests cover every sink. The cue endpoint also
requires the requesting viewer to equal `authorizing_user_id`. A restricted
response is never admitted to service-worker, application, search, resource,
or OS caches.

The Media projection and cue response expose the same closed `access` arm.
`Readable { Ordinary }` requires `removalDeadline=Absent`; either restricted
Readable arm requires `removalDeadline=Present` with the lifecycle's exact
`compliance_delete_deadline`, which is the sole `{date}` source. A restricted
publication whose approval, binding, authorizer, plaintext-residual permission,
or deadline check fails remains metadata-visible only as
`RestrictedUnavailable` and the cue route returns that same non-content arm,
never stale plaintext. Media SSE changes synchronously abort the cue resource,
remove installed DOM/VTTCues/caption overlay, clear selection, and remove Copy,
follow, seek, and every downstream action before rendering the unavailable
state. A late cue response is rejected against both current publication handle
and current access arm. Contract/browser proofs cover Ordinary Absent,
restricted Present, every unavailable reason, approval/binding loss while text
is selected or video is playing, and no plaintext after the transition.

The restricted transcript UI has timestamp seek/follow and owned-copy caption
overlay only because those exact timing uses are approval-gated above. Nexus's
own selection palette offers only plain **Copy**; Highlight, Link, Share, Learn,
Ask, note, and AI actions are structurally absent. The persistent explanatory
line is truthful and source-specific: **You can read, follow, and copy this
YouTube caption track here. Nexus won’t add it to Highlights, notes, search,
sharing, export, or AI, and removes its stored copy by {date}.** or **You can
read, follow, and copy this transcript from your kept YouTube copy here. Nexus
won’t add it to Highlights, notes, search, sharing, export, or AI, and removes
its stored copy by {date}.** Find operates
only over the already loaded in-memory cue list and stores no query/result.
Readable browser text cannot be made technically non-copyable through
selection, accessibility APIs, developer tools, or every UA/OS contextual
action; browsers may expose Search/Share/Translate/Process Text outside Nexus.
Android disables `MENU_ITEM_SHARE`, `WEB_SEARCH`, `PROCESS_TEXT`, and custom
action-mode extras where supported without defeating selection/accessibility,
but that mitigation is not claimed for desktop browser chrome. The relevant
approval arm and consent must expressly accept the remaining host-specific,
user-directed plaintext residual; otherwise restricted content is not exposed
on that host. Browser/WebView manual proofs inventory the actual menus. Generic
transcript capabilities and public-
share acceptance apply only to `Ordinary` publications.

Caption credentials and bytes never enter a queue payload/result, replay memo,
audit body, exception, or log. The OAuth client secret is deployment keyring
configuration; every refresh credential lives only in the typed Postgres AEAD
material plus its exact hold described above, and is decrypted in memory only
inside the credential owner around one provider request. There is no secret-
manager client, reference, lookup, or external absence protocol. Token,
credential, code, verifier, integrity-token, and API-response keys are
forbidden by the recursive redaction owner. A caption publication copies none
of the bounded Authorized-Data facts above; its publication-data association
references their one allocation. `provider_compliance_sweep` and
`YouTubeCaptionLifecycle(lifecycleOperationId)` implement the lifecycle:
the OperationRef resolves the lifecycle row id (publication id is only its
same-Media owned FK/routing fact). Under that operation lock, each actual
download allocates the next immutable refresh run and exact
`youtube_caption_refresh` source attempt; retry reuses a nonterminal run and a
new run is created only after a definitive terminal source outcome. The
replacement publication must FK that run's source attempt. Uniqueness and the
owned-claim fence prevent duplicate refresh attempts/publications across a
crash. Projection
and cue reads fail closed as soon as approval, credential binding, or
`expires_at` is invalid; refresh is durably due by the computed pre-purge cohort
cutoff below and deletion is authoritative no later than day 30, approval disposition, or seven days after
revocation, whichever is earliest. Caption capacity is also closed:
`YOUTUBE_CAPTION_MAX_ACTIVE_RESERVATIONS_OR_PUBLICATIONS=16`, with the one
reserved `Caption` execution slot above. Initial acquisition uses the pre-I/O
reservation and atomic same-allocation transfer above; refresh and compliance
use the live lifecycle schedule. The schedule gate counts the exact union of
reservation and live owners, rejects zero/two owners or cross-attempt/window
substitution, and never counts only already-published data. If the union is
already 16 or no window fits, this source is inadmissible and Default proceeds
to the next already-authorized source; no caption credential use or bytes are
created.

The timing owner commits the sequential, backlog-inclusive bound:

```text
YOUTUBE_CAPTION_RECOVERY_INVOCATION_CEILING = 4
YOUTUBE_CAPTION_RECOVERY_SECONDS =
  YOUTUBE_CAPTION_RECOVERY_INVOCATION_CEILING(4) *
    (YOUTUBE_CAPTION_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
     PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60)) = 3840

YOUTUBE_CAPTION_PER_PUBLICATION_COMPLIANCE_SECONDS =
  MEDIA_TRANSCRIPT_WALL_TIMEOUT_SECONDS(14400) +
  BACKGROUND_PROCESS_TERM_GRACE_SECONDS +
  BACKGROUND_PROCESS_KILL_GRACE_SECONDS +
  PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60) +
  YOUTUBE_CAPTION_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
  YOUTUBE_CAPTION_RECOVERY_SECONDS(3840)

YOUTUBE_CAPTION_COMPLIANCE_MARGIN_SECONDS =
  PROVIDER_COMPLIANCE_SWEEP_INTERVAL_SECONDS(60) +
  YOUTUBE_CAPTION_MAX_ACTIVE_RESERVATIONS_OR_PUBLICATIONS(16) *
    YOUTUBE_CAPTION_PER_PUBLICATION_COMPLIANCE_SECONDS

YOUTUBE_CAPTION_REFRESH_MAX_ATTEMPTS = 5
YOUTUBE_CAPTION_REFRESH_RETRY_DELAY_SUM_SECONDS = 60 + 300 + 900 + 3600 = 4860
YOUTUBE_CAPTION_REFRESH_PER_PUBLICATION_SECONDS =
  YOUTUBE_CAPTION_REFRESH_MAX_ATTEMPTS(5) *
    (YOUTUBE_CAPTION_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
     PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60)) +
  YOUTUBE_CAPTION_REFRESH_RETRY_DELAY_SUM_SECONDS(4860) +
  (YOUTUBE_CAPTION_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
   PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60)) # publication/settlement

YOUTUBE_CAPTION_REFRESH_COHORT_MARGIN_SECONDS =
  PROVIDER_COMPLIANCE_SWEEP_INTERVAL_SECONDS(60) +
  YOUTUBE_CAPTION_MAX_ACTIVE_RESERVATIONS_OR_PUBLICATIONS(16) *
    YOUTUBE_CAPTION_REFRESH_PER_PUBLICATION_SECONDS
```

This is a sum because Fence/drain necessarily precedes Finalize; those phases
cannot overlap. It computes
`purge_due_at <= compliance_delete_deadline -
YOUTUBE_CAPTION_COMPLIANCE_MARGIN_SECONDS` and, for a refreshable publication,
`refresh_due_at <= purge_due_at -
YOUTUBE_CAPTION_REFRESH_COHORT_MARGIN_SECONDS`. Refresh due is therefore never
a fixed day-28 promise. Configuration, startup, release,
forecast/request, and lifecycle admission refuse a nonpositive or mismatched
constant/margin or a retention window unable to contain both refresh and purge
cohorts. Fake-clock proof places 16 publications at one deadline and requires
every successful refresh/publication/old-ref settlement before any purge; retry
exhaustion safely falls into the already-reserved deletion window. The
`youtube_caption_lifecycle` Light JobDefinition has strict payload
`{ lifecycleOperationId }`, declares
`deadline_lane_policy=StaticCompliance { laneKind=Caption }`, and is claimable
only by the named `worker-provider-compliance` Caption slot. Pre-deadline refresh
may use that same ref only when the schedule owner proves no due lifecycle and
enough EDF slack remains for every earlier cutoff; it never falls back to
background. It uses
`max_attempts=5`, `retry_delays_seconds=(60,300,900,3600)`,
`lease_seconds=300`, `heartbeat_interval_seconds=30`,
`YOUTUBE_CAPTION_LIFECYCLE_WALL_TIMEOUT_SECONDS=900`, sets
`never_prune_dead=True`, and
has one `StableOperationRef` resolver/terminal predicate. Before expiry its
owned claim re-lists and re-downloads through a fenced source attempt. The
provider-result claim transaction requires the exact completed
`RefreshGrant/VideosList/CaptionsList/CaptionDownload` use, creates one immutable
restricted caption-data allocation whose typed refresh-use owner composite-FKs
that same lifecycle OperationRef and Media, and stores the exact
caption/channel/kind/language/retention facts,
every bounded normalized cue as ordered staging children, aggregate/per-cue
digests, and the refresh-result association. No result or publication copies
those semantic-owner facts. A same-credential result from another binding,
lifecycle, or Media cannot satisfy the FKs. Publication nonlocking-resolves the
successor placement first. `with_owned_operation_claim` takes settlement/
queue/correlation ownership, then locks the singleton schedule gate and exact
allocation at the canonical rank, then Media; under those locks it rederives a
successor capacity allocation. It normally places a later neutral allocation
for the refreshed deadline; if placement is unavailable but the old immutable
allocation's earlier deadline/window is still valid for the successor, it
transfers that exact allocation unchanged. It may never weaken to a later
deadline. If neither arm is feasible, it leaves the old publication/lifecycle/
schedule live and disposes the staged refresh under that lifecycle rather than
creating an unscheduled successor. This is the one
`with_owned_operation_claim(oldLifecycleRef, workerId, attemptNo,
domainMutation)` transaction—not a preflight followed by a second lock set.
Under its already-held claim/schedule/Media locks it revalidates teardown,
cancellation, head, approval, binding, and result, then materializes the standard
transcript publication and segments exactly once from those staging cues,
deletes the staging cue children after their segment insertions, creates the
publication-data association and successor lifecycle referencing the same
allocation, consumes/deletes the refresh result and staged refresh-use owner,
creates the successor -> old terminal dependency, swaps the head,
atomically deletes the old schedule owner and inserts the successor schedule
owner referencing the selected neutral allocation, releases a replaced old
allocation only after the swap, and marks the old domain operation `Replaced` plus its content-free domain
receipt before coordination settlement. The
allocation is therefore in exactly one closed arm: `Staged` (one typed source
association, one refresh-result association, the complete cue set, and no
publication association), `PublishedAwaitingConvergence` (one publication
association and no staged source/result/cues), or `Published` (the same
allocation association after old-operation settlement). The middle arm is the durable post-head-swap/
pre-correlation-cleanup prefix and may only converge forward without a provider
call. Any other combination or a partial cue-to-segment move is a transaction/
readiness defect. Claim loss,
deadline crossing, teardown, or a competing resolver writes nothing. Even an
equal digest is a new allocation/refresh fact. Postcommit
`settle_terminal_operation(oldLifecycleRef, Replaced, callback)` writes/links
the coordination receipt, removes the old queue target, and invokes the
deletion callback before admitting the successor.
Crash-safe prefixes are old-active; result-ready; head-swapped/new-awaiting-
dispatch with old correlation; and old-terminal/new-correlated. Startup verifies
and consumes those durable cue bytes and converges each with zero provider calls,
no duplicate download, and no invisible successor. The settlement callback
writes no business fact; the head-swap already removed the old schedule, so it
child-first deletes the consumed run and old
suspension/operation, then prior segments/Fragments/publication association,
publication, prior data allocation, typed use owner, and its completion/member/
request provenance after restricted caches are absent. The
new allocation remains owned solely by its publication association/lifecycle
until that publication is refreshed or purged. Restrictive FKs are never
weakened/cascaded. Failure before expiry
reschedules the same operation. Schedule-gate/head-swap proofs crash before and
after each old-owner deletion/new-owner insertion/allocation release, reject
cross-successor and later-window substitution, and prove exactly one schedule
owner after every committed refresh.

At `purge_due_at` (never waiting until the compliance deadline),
`expire_restricted_caption_in_txn` is a typed compliance transition, not an
ordinary worker claim. Its first phase takes the settlement gate before exact
queue/correlation and Media/head/publication/lifecycle locks, installs the
deadline cancellation/fence for a pending, running, expired-lease, or dead
target, and prevents any new credential-use/provider dispatch. It atomically
persists the exact DrainDue wake for the
maximum transcript/caption wall envelope plus TERM/KILL grace, request
termination, and return. The later Finalize invocation invokes
`settle_terminal_operation` and rechecks that
fence, then locks the published allocation and optional refresh-result
allocation plus every staging cue, deduplicated by allocation id when the post-
head-swap prefix references the published allocation. Its registered terminal
transition removes the head/restricted capability without an API call and writes
the content-free `DeletedAtDeadline` or `DeadExpired` domain receipt (only
domain-separated identity/defect digests) before the coordination receipt. Its
deletion-only callback child-first deletes staged allocation cues/
refresh result, suspension resolutions/suspensions/runs/completion/operation,
segments/Fragments, publication association/publication, and the deduplicated
staged/published allocation set plus use provenance only after the coordination
receipt exists.
The schedule's immutable absolute cutoffs are `deadline_fence_not_after`,
`writer_drain_not_after`, `deadline_finalize_not_after`, and
`deadline_settlement_not_after`; they are computed backward from the neutral
allocation's deadline/window for canonical `wave_no`. Every scanner promotion,
phase entry, handoff, and replay checks its cutoff plus the complete remaining
tail and cannot poll/reschedule past it. On approval change or binding
deactivation, one transaction takes the schedule gate before the account gate
and atomically re-places the entire active initial-reservation/live-publication
cohort in canonical `(newDeadline, ownerKind, ownerId)` order, swaps each owner
to new neutral + typed Caption allocations and matching wake placements, and
only then releases old allocations; the 16-item margin reserves the
simultaneous-revocation case.
No provider/API bytes or raw ids survive, and a late worker/provider result
cannot reacquire the fenced attempt. Reads have already failed closed. Before
the deadline an unexpected dead refresh
still requires same-job repair; at the early purge boundary this compliance transition
supersedes it without operator availability while preserving the content-free
defect receipt. It must finish and prove absence by
`compliance_delete_deadline`; crossing that deadline with any restricted row is
a startup/readiness/release incident, and normal API service remains disabled
until the first startup transaction deletes it. Startup and the same committed
no-greater-than-60-second compliance cycle perform this idempotent DB-first
expiry sweep before attempting refresh.
Teardown uses the same ref and never races a head swap. Settlement deletes the
current wake graph, schedule, typed Caption allocation, then neutral capacity
allocation before its lifecycle. Real-Postgres clock-
boundary, exact `YOUTUBE_CAPTION_COMPLIANCE_MARGIN_SECONDS`, maximum-cadence/
sequential wall/TERM/KILL/handoff/recovery margin, 16-item same-deadline backlog,
placement overlap/capacity refusal, process outage within that
margin, late-start emergency deletion, credential revocation,
pending/running/expired/dead job through expiry, late provider response,
settlement-boundary crash/replay,
restrictive-FK deletion, equal/changed digest, stale worker,
teardown, authorizer mismatch, forbidden-sink, and no-log/cache proofs bind the
feature. This is the concrete owner behind the top-level compliance promise,
not a best-effort timer.

`YouTubeOwnedAsrLifecycle(lifecycleOperationId)` is the corresponding no-
provider-I/O Light JobDefinition with
`deadline_lane_policy=StaticCompliance { laneKind=OwnedAsr }`, claimable only
by the reserved `worker-provider-compliance` OwnedAsr slot, with strict payload
`{ lifecycleOperationId }`, `max_attempts=5`,
`retry_delays_seconds=(60,300,900,3600)`, `lease_seconds=300`,
`heartbeat_interval_seconds=30`,
`YOUTUBE_OWNED_ASR_LIFECYCLE_WALL_TIMEOUT_SECONDS=900`,
`never_prune_dead=True`, and its own stable-ref resolver/terminal predicate.
The global admission ceiling is
`YOUTUBE_OWNED_ASR_MAX_ACTIVE_ALLOCATIONS=16`, in addition to the relational
one-current-allocation-per-video-content rule. One reserved `OwnedAsr` slot
never serves other work. Forecast omits hosted owned-video ASR at capacity;
request revalidation locks the schedule gate before Media and refuses a stale
forecast before reservation/provider/plaintext work unless it can create one
nonoverlapping neutral capacity allocation and typed current schedule.

The timing owner commits:

```text
YOUTUBE_OWNED_ASR_RECOVERY_INVOCATION_CEILING = 4
YOUTUBE_OWNED_ASR_RECOVERY_SECONDS =
  YOUTUBE_OWNED_ASR_RECOVERY_INVOCATION_CEILING(4) *
    (YOUTUBE_OWNED_ASR_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
     PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60)) = 3840

YOUTUBE_OWNED_ASR_PER_ALLOCATION_COMPLIANCE_SECONDS =
  MEDIA_TRANSCRIPT_WALL_TIMEOUT_SECONDS(14400) +
  BACKGROUND_PROCESS_TERM_GRACE_SECONDS +
  BACKGROUND_PROCESS_KILL_GRACE_SECONDS +
  PROVIDER_COMPLIANCE_QUEUE_HANDOFF_MAX_SECONDS(60) +
  YOUTUBE_OWNED_ASR_LIFECYCLE_WALL_TIMEOUT_SECONDS(900) +
  YOUTUBE_OWNED_ASR_RECOVERY_SECONDS(3840)

YOUTUBE_OWNED_ASR_COMPLIANCE_MARGIN_SECONDS =
  PROVIDER_COMPLIANCE_SWEEP_INTERVAL_SECONDS(60) +
  YOUTUBE_OWNED_ASR_MAX_ACTIVE_ALLOCATIONS(16) *
    YOUTUBE_OWNED_ASR_PER_ALLOCATION_COMPLIANCE_SECONDS
```

Fence/drain and Finalize are sequential, not a `max`. `purge_due_at` is no
later than `compliance_delete_deadline -` that complete margin. Startup,
release, forecast, and admission reject a nonpositive margin; forecast omits
the owned-ASR arm and admission rejects a stale forecast whenever the exact
approval/disposition has insufficient remaining lifetime. This intentionally
makes long work unavailable several hours before a provider deadline rather
than promising cleanup that the four-hour worker envelope cannot meet.
The transcript request transaction creates the neutral restricted-data
allocation plus this lifecycle as `AwaitingDispatch` before any provider call
or restricted plaintext can exist, and in that same transaction creates its
neutral capacity allocation/current schedule; it admits postcommit only after
that margin and slot check. The allocation
owns exact work/Media/asset/authorizer/approval/policy/purge/deadline; staged
result and later publication association reference it instead of copying those
facts. A work terminalized with no restricted data writes `NoData` and closes
the lifecycle. The compliance scanner promotes it at the computed early
`purge_due_at`. Cue reads fail closed immediately on drift.

Each schedule revision stores backward absolute Fence, writer-drain, Finalize,
and settlement cutoffs for its canonical wave. Every phase/handoff/replay checks
its own cutoff and remaining tail; there is no polling past a cutoff. Approval/
disposition acceleration re-places the complete active OwnedAsr cohort under the
singleton schedule gate before exposing the new deadline, swaps current
schedules to new neutral + typed OwnedAsr allocations and wake placements, then
releases old ones. The 16-wave
margin covers simultaneous invalidation. Terminal settlement deletes schedule
and wake graph, then typed and neutral allocation before lifecycle/allocation deletion. Fake-clock proofs
run all 16 at one deadline and reject overlap, capacity bypass, stale revision,
and a Fence/Finalize `max` regression.

At due, the lifecycle owner—or typed dead/expired supersession—invokes
`settle_terminal_operation_set` with
`authority=OwnedAsrDeadlineFence(lifecycleOperationId,
ownedAsrDataAllocationId, transcriptionJobId, preallocatedDeadlineSetId,
preallocatedFenceGenerationId)` over the exact same-allocation
`YouTubeOwnedAsrLifecycle` and its allocation's unique `TranscribeMedia`
OperationRef. The coordination-owned fence phase seals those two refs,
cancellation/fences every unclaimed, claimed, dead, expired-lease, or dispatch-
uncertain writer, and commits the allocation-linked deadline-set row. Every
provider dispatch, result acceptor, and publication transaction locks that
allocation and rejects while the row exists, including a stale pre-fence worker
and late response; no copied generation comparison is authoritative. In that
commit the supervisor persists the exact DrainDue wake for the maximum horizon,
requests termination, and returns within the handler wall. A later invocation
invokes the same port with
`authority=OwnedAsrDeadlineFinalize(deadlineSetId, fenceGenerationId)`, then
reacquires the sealed complete set and Media/head/allocation,
requires process termination and late-result rejection, then exhaustively
derives exactly one arm: `NoLocalData`, `InFlightOrUncertain`, `StagedResult`, or
`Published { head: Current | Historical }`. The first closes without plaintext;
the second settles billing/dispatch truth content-freely after the fence; the
third deletes all staged result-cue children/result; the fourth compare-deletes
the head only when it still names this publication and always deletes that
allocation's segments/Fragments/publication association/publication child-first,
even when a newer head is current. Zero or multiple arms is a readiness defect;
the registered deadline transitions still enumerate and delete the complete
allocation-owned set rather than preserve unauthorized bytes. The registered
`TranscribeMedia` deadline transition writes exactly one
`media_transcription_compliance_receipts` outcome
`DeadlineNoData | DeadlineDeleted | DeadlineDeadExpired`; the lifecycle
transition writes the matching `media_youtube_owned_asr_compliance_receipts`
outcome, and both equality-bind the sealed member-set digest. Those two content-
free domain receipts and the lifecycle -> work dependency are materialized
before either coordination receipt; only after every receipt is linked are every
queue target/correlation removed. The one deletion-only callback follows the
generated restrictive-FK inventory: staged/publication cues, segments,
Fragments, associations/publication and active marker; result cues/result;
deadline set; lifecycle suspension/resolution/operation; allocation; then the
remaining work-owned dispatch resolution/uncertainty/intent, submission,
result-receipt, request-audit, reservation-settlement/reservation, source-attempt
children, and `media_transcription_jobs` operation. Account-owned usage charges
and the two non-FK content-free compliance receipts remain. No deadline path
directly deletes a queue row, correlation, operation, or allocation. Forbidden-sink
proof is scoped to artifacts carrying explicit provenance from this restricted
publication; new transcript Highlights are impossible at mutation time.
Pre-existing ordinary Timeline/time/quote Highlights are preserved, their
disposable Fragment locators stay Absent, and painting/re-resolution is
suppressed while current policy is restricted. It writes only content-free
`NoData | DeletedAtDisposition | DeadExpired`. Crossing the hard deadline with allocation, staged
plaintext, or published restricted data disables normal API readiness until
startup proves absence. Proofs use the maximum-duration work envelope and cover
live, dead, expired-lease, dispatch-uncertain, late provider result, staged,
current-published, historical-published, zero/multiple-arm defect, scanner
outage within the recovery margin, startup emergency deletion, and
dead-after-result through deadline,
ordinary Highlight -> restricted replacement -> purge -> later ordinary
publication, teardown, zero forbidden derived data/plaintext, and restrictive
FK deletion; no ordinary user-authored fact is deleted.

Podcast input verification is its own durable operation, not a synchronous
URL probe. `probe_transcript_input` is a named `TimedMediaHeavy` JobDefinition
on the single-capacity `worker-media` lane with strict payload
`{ preparationId }`, `resource_class=TimedMediaHeavy`, `max_attempts=3`,
`retry_delays_seconds=(30,120)`, `lease_seconds=30`,
`heartbeat_interval_seconds=5`, `wall_timeout_seconds=14400`, and
`never_prune_dead=True`. Its OperationRef resolves only the immutable
preparation. It reserves `4 GiB + 512 MiB` under the existing media temp-root
reservation owner and preserves the configured 2 GiB host free-space floor
before dispatch; absence of capacity is a closed retryable dependency, never an
unbounded write. Claim loss/cancel kills the whole child group, removes its
0600 private attempt directory, and cannot publish progress/probe/failure.

`services/safe_stream.py::safe_stream_to_private_file` is the sole Podcast
audio fetch port used by both this probe and the later exact-byte ASR recheck.
It accepts only a canonical credential-free HTTPS URL with no userinfo,
fragment, noncanonical host, IP-literal host, or port other than 443. It sends
no cookies, Authorization, origin client certificate, proxy-environment
setting, cloud-instance credential, or ambient header; `Accept-Encoding:
identity` is fixed. The only body-bearing success is exact `200`; `206`, a
`Content-Range`, multipart response, or any nonidentity `Content-Encoding` is
rejected before bytes are treated as the episode, so a partial or decompressed
representation cannot masquerade as the forecast input. It explicitly selects the authenticated
`PodcastAudioFetchV1` gateway client—never ambient proxy configuration—and
equality-checks the gateway's policy/normalized-destination receipt for each
hop. Initial validation and every redirect (maximum five) require the gateway's
bounded A/AAAA set to contain only globally routable unicast addresses; loopback,
private, link-local, carrier-grade NAT, multicast, unspecified, reserved,
documentation, IPv4-compatible/mapped and NAT64 translation prefixes, and
cloud/container metadata ranges are denied; an embedded IPv4 address is
classified by its underlying address rather than the wrapper prefix.
The gateway pins one approved address for the origin socket while preserving
end-to-end TLS SNI/hostname verification, equality-checks its connected peer,
and repeats resolution/pinning on each fresh CONNECT, so DNS rebinding or a
public-to-private redirect cannot change the peer after validation. The client
also revalidates every Location before issuing that CONNECT. Redirect credentials
and sensitive headers never carry forward. Any future network topology adds
its metadata/service ranges to this central deny owner before release.

The fetch has named configuration for DNS/connect/TLS/header/idle timeouts,
`TRANSCRIPT_INPUT_FETCH_WALL_TIMEOUT_SECONDS=13200`,
`TRANSCRIPT_INPUT_FFPROBE_WALL_TIMEOUT_SECONDS=600`, and
`TRANSCRIPT_INPUT_CLEANUP_RESERVE_SECONDS=600`; startup and the resource proof
require their sum to be no greater than the 14,400-second job wall. ffprobe is
supervised under its named limit and the reserve remains available to kill its
process group, fsync terminal facts, and remove temp. The fetch also enforces a 64 KiB aggregate
response-header limit, maximum five redirects, and a hard `4 GiB + 1 byte`
read fence using uint64 counters. A validated Content-Length over the limit
fails before body read; absent/chunked/lying length remains indeterminate and
the byte fence is authoritative. Content-Type is advisory and bounded; the
same file must pass the pinned ffprobe demuxer/codec allowlist, one audio
program/track, finite positive rational timestamps, no attachments/scripts/
subtitles/video, and no external-reference protocol. ffprobe runs in a no-
network mount namespace exposing only that exact inode read-only, with literal
`-protocol_whitelist file` (and the corresponding deny-by-default demuxer
profile) before it opens input; a playlist/manifest or demuxer cannot fetch or
read a sibling path and then be rejected after the fact. Output is created with
exclusive/no-follow semantics inside the reserved randomized directory, is
never executable or served, is SHA-256 hashed while written, fsynced, then
reopened by inode under no-follow for ffprobe. Probe and later ASR consume those
exact bytes; the latter re-fetch must equal the unexpired probe SHA/size/duration
before provider dispatch. Every exit unlinks temp content.

Worker outcomes are exhaustive: `RetryableDependency` covers bounded DNS,
connect, TLS, 408/429/closed 5xx, idle/wall/disk-capacity failures and consumes
the declared retry budget; exhaustion publishes `E_TRANSCRIPT_INPUT_DEPENDENCY`
with user Retry. `UnsafeSource` covers scheme/URL/host/DNS/peer/redirect/gateway-
receipt policy violations and publishes `E_TRANSCRIPT_INPUT_SOURCE_UNSAFE` with
no queue or user retry. `SourceUnavailable` covers closed nonretryable HTTP
status and publishes `E_TRANSCRIPT_INPUT_SOURCE_UNAVAILABLE`. `InvalidInput`
covers bounded content-header/type/demux/codec/timestamp violations and
publishes `E_TRANSCRIPT_INPUT_FORMAT` once with no queue retry. `TooLarge` and
`TooLong` publish their exact permanent
codes without retry. `Cancelled` writes only the exact cancellation settlement.
Any unclassified exception leaves the same ref dead/Suspended for repair.
Progress commits under the owned claim, generation-CASes one Fetch or Probe
row, permits the total Presence child exactly for Fetch and only when validated
and `total >= bytesDone`, and is advisory—not lifecycle truth. Proofs use a
real adversarial HTTP/TLS harness for redirects, mixed DNS answers, peer-IP
swap, rebinding, metadata/private IPv4+IPv6, header/body bombs, slowloris,
compression, lying length, malformed media, cancellation and temp cleanup,
then kill before/after progress/hash/probe/failure publication and require the
closed projection/copy for every outcome.

Owned-video ASR input exists only under the exact live
`OwnedVideoAsrApproved` capability; absence means no forecast source, temp
file, network call, or publication. Hosted ASR never receives the playback
object or a viewer ticket. The transcription task revalidates approval/asset/
use-policy/disposition, then fetches the owned MP4 (stream-hashing
it and verifying it equals the recorded owned-asset SHA before any provider
work), extracts one bounded audio-only rendition with the pinned ffmpeg
(`-vn`, AAC/M4A) under the same private temp discipline and disk envelope as
`acquire_video_copy`, digests it, and streams those exact bytes to the
provider; the extracted-audio SHA is the publication `input_sha256`. It repeats
approval immediately before dispatch. The publication transaction rechecks the
same allocation/asset row, approval artifact, restricted-use policy and
disposition, then atomically creates the publication and mandatory ASR
companion referencing the existing lifecycle allocation; a
transient read/dependency error is `E_TRANSCRIPT_OWNED_ASSET_READ` and may be
retried, while definitive `NotFound`, hash mismatch, or content/asset
disagreement is `E_TRANSCRIPT_OWNED_ASSET_INTEGRITY` with only
**Remove broken copy…** recovery. Neither publishes or dispatches provider
work. Approval expiry/replacement at any boundary fail-stops, purges temp, and
publishes nothing; an already published restricted result is fail-closed and
deleted through its disposition owner. The ASR wall budget is its own configured constant sized for the
4-hour profile; the requested language comes from the Timeline/Media, never
a hardcoded default. Hosted ASR on an owned asset is admissible only while
no removal row post-dates the asset and the exact approval remains live. Remove remains blocked while transcript
work is nonterminal; the explicit transcript-cancel command releases the exact
quota amount proven unused and atomically settles any charged/uncertain amount
before Remove becomes applicable.

`transcribe_media` is a named `TimedMediaHeavy` JobDefinition on the
single-capacity `worker-media` lane with `max_attempts=3`,
`retry_delays_seconds=(30, 120)`, `lease_seconds=30`,
`heartbeat_interval_seconds=5`, `never_prune_dead=True`, and explicit validated
`MEDIA_TRANSCRIPT_WALL_TIMEOUT_SECONDS=14400`. Sidecar/caption/ASR phases,
cancellation, temp cleanup, and the wall constant join the task digest and
resource-envelope proof. A lost lease may replay only the same work identity;
the current Deepgram pre-recorded endpoint has no caller-supplied idempotency
key or cancellation contract. Immediately before its POST, Nexus persists the
exact dispatch-intent/input digest. If the response is not durably recorded as
a submission/result, the first detecting run does not call generic `fail_job`:
one queue-owned, lease-fenced
`suspend_running_job_for_domain_resolution` transaction inserts
`dispatch_uncertainty`, conservatively settles the maximum, moves that exact
running row to non-runnable `dead`, clears claimant/lease, preserves
`cancel_requested_at`, and releases `TimedMediaHeavy` capacity. This is a
domain-resolution hold, not a generic defect suspension; the generic
dead-letter projector inserts no `media_transcription_suspension` when an
unresolved dispatch uncertainty exists. It never resubmits, including on the
first attempt. The provider's returned request id is persisted only after
receipt and cannot retroactively close that gap. The existing second billed
non-diarized fallback call is deleted: one work dispatches one pinned
Deepgram request profile, and an unsupported/failed diarization response is a
terminal `E_TRANSCRIPT_PROVIDER_PROFILE_UNSUPPORTED` rather than another
charge; a closed transient dependency response is
`E_TRANSCRIPT_PROVIDER_UNAVAILABLE`. Expected source/provider/quota outcomes complete on the first run;
expected wall/memory envelope exhaustion maps to the closed resource codes;
an extraction/conformance invariant defect or other unexpected infrastructure
failure projects the exact work `Suspended`.

A successful hosted-provider response is not published directly from memory.
After authenticating its request id, work/input digest, profile, response
bytes, and bounded normalized cues, one owned-claim transaction inserts/reuses
the exact submission, immutable `media_transcription_results` row, and every
ordered cue child. That commit is nonterminal `ResultReady`; it performs no
publication or quota settlement. Every worker/resolver entry checks this fact
before dispatch, so restart after result commit makes zero provider calls. A
fresh owned-claim transaction then locks/revalidates cancellation, Media/head/
Timeline/source attempt, approval/use policy, reservation, and the exact result.
For a current authorized result it atomically creates the publication/segments
and any mandatory restricted companion/lifecycle, settles quota, inserts
completion plus a content-free result receipt, clears active work, terminalizes
the source attempt, and child-first deletes all staged cue children/result.
Cancellation, approval drift, or teardown instead publishes nothing, settles
honestly, inserts cancellation/typed failure plus the same digest-only receipt,
and deletes staged plaintext in that same terminal transaction. Submission,
dispatch intent, receipt digests, and accounting audit may remain; staged
language/cue text may not. Whole-Media teardown orders result-cue children ->
result -> work after first cancelling/fencing its OperationRef. The uncertainty
resolver authenticates and stages/reuses this identical result, then its one
terminal managed transaction points the resolution at the exact work-scoped
result receipt; A-uncertainty/B-result is storage-invalid. Proofs kill after
result commit/before publication, at every terminal write/delete, and race
cancel/teardown/approval disposition, asserting zero second POST and zero
residual result plaintext, including `RestrictedYouTubeOwnedAsr`.

Budget lifecycle is explicit: `Reserved` precedes provider work,
`SubmissionPending` means no provider acceptance is proved, and `Submitted`
exists only with the durable provider operation reference. Cancellation before
submission releases the full reservation. Every terminal path that proves no
dispatch intent/network handoff occurred — free-source absence/invalid/
dependency stop, input preparation or exact-byte drift, owned-asset read/
integrity, approval/policy expiry, cancellation, and wall/memory/resource
failure during preflight — atomically inserts a zero-minute charge, releases
the entire reservation, inserts its terminal fact, and clears the active marker
under the owned-claim fence. No generic settlement default may commit nonzero
usage for these arms. The intent is persisted only after every local/source
preflight passes and immediately before the one POST; from that point a lost
response is conservatively ambiguous because provider receipt cannot be
proved. The settlement proof enumerates every `TranscriptFailureCode`: each
classified failure before intent must produce zero/full release, while a crash
after intent and before the call is deliberately the first uncertainty/max-
commit case because no atomic provider handoff exists. After submission the current
Deepgram adapter cannot cancel provider work and releases only usage proven unused;
known used minutes are committed, while an unknown provider outcome
conservatively commits the reserved maximum and raises operator reconciliation
rather than gifting quota or double-charging later. The terminal settlement
and cancellation rows are written atomically, the UI says **Transcription
cancelled** and **Used transcription minutes may not be returned after the
provider starts**, and repair preserves the user's cancel request.

Dispatch uncertainty has one typed operator-only boundary,
`services/transcripts/dispatch_resolution.py::resolve_transcription_dispatch_uncertainty`,
available only to an authenticated `OperatorRepair` actor with required
idempotency key, exact uncertainty id/work handle, and authorization-context
digest. The managed coordination mutation nonlocking-resolves
`TranscribeMedia(workId)`, locks its exact `background_jobs` row then
`coordination_operation_jobs` correlation, then Media -> current head ->
Timeline -> source attempt -> operator user (viewer layer) -> work/uncertainty/
reservation domain rows on the same connection, locking the actor before the
resolution FK insert. Account-erasure vs resolver
is part of the deadlock proof. `RecoveredResult` requires an authenticated provider
request id and exact response bytes whose input/work correlation and digest
verify. `LegacyPreFence` cannot use this arm unless independently retained
contemporaneous submitted bytes/digest satisfy that same proof; the current
source is never substituted. If `cancel_requested_at` is absent, it stages the
exact work-scoped result and proceeds through normal fenced consumption and
publication. If cancellation is present, the authenticated result is staged
and consumed only to prove evidence: it is not published; the resolver writes
the digest-only result receipt, deletes result cues/result, reuses the
conservative settlement, inserts terminal cancellation, clears the active
marker, and terminalizes the queue. `ChargedNoResult` likewise retains
intent/uncertainty and the conservative settlement, inserts terminal
cancellation when cancel was requested or
`Failed { failure: { code: E_TRANSCRIPT_PROVIDER_OUTCOME_UNKNOWN, recovery:
Retry } }` otherwise, clears the active marker, and terminalizes the queue.
Either arm atomically inserts the one immutable operation-scoped
dispatch-resolution row with operator/authorization provenance and exact
result-receipt/evidence digest alongside its
publish/cancel/fail, settlement, active-clear, and the coordination-owned
`resolve_dead_operation_with_domain_result` dead -> succeeded transition in
that same managed transaction. This
transaction also invokes `terminalize_transcript_work_in_txn` for the exact
source attempt. The queue transition does not require a fictional live claim; it preserves cancellation
and is the only exit from the hold. Concurrent resolver arms/replay converge to
the same row or an idempotency mismatch. `requeue_dead_job` detects an
uncertainty row and refuses to dispatch; resolver-vs-requeue and first-attempt
response-loss/capacity-release are required proofs. After terminal resolution
the user may start a new work id explicitly. Thus uncertainty can
unblock Remove/Discard without ever repeating an ambiguous billed POST.

Transcription usage is media-level but input-specific, never guessed. The sole
owner accepts the closed duration proof
`OwnedVideoTimelineDuration { timelineId, bindingEpoch, assetId, durationMs,
approvalArtifactSha256, usePolicyVersion, disposition } |
PodcastInputProbeDuration { probeId, inputSha256, expiresAt, durationMs }`.
Owned video uses only the current kept asset plus `duration_source=
OwnedVideoProbe`; Podcast hosted ASR uses only the current unexpired exact-byte
input probe. Advisory Podcast metadata/Timeline duration never authorizes or
prices paid work, and the ephemeral probe does not mutate the global Timeline.
The owner computes `ceil(duration_ms / 60_000)` with overflow-safe
nonnegative int64 division (`duration_ms / 60_000 +
Presence(duration_ms % 60_000)`); zero-cost-only plans reserve `0`. The same
function supplies single/batch forecast, sealed-handle recomputation,
selection fingerprint, reservation, settlement ceiling, and projection, and
request admission rechecks every proof field. Boundary proofs cover 1, 59,999,
60,000, and 60,001 ms plus probe expiry/digest drift and advisory-duration
disagreement. The one-minute fallback is deleted. YouTube-origin video hosted
ASR is admissible only when a copy is Kept and `OwnedVideoAsrApproved` is live;
Podcast hosted ASR only after **Verify
episode length…**. Otherwise the forecast retains eligible zero-cost sources
but projects `SourceRequired`/`DurationUnknown` for hosted ASR.

Provider cues are never a Nexus contract. Ingress requires strict UTF-8,
parses only the adapter's declared format into text, normalizes text/speaker to
NFC, canonicalizes a valid BCP 47 language tag, rejects disallowed C0/C1
controls (except normalized line breaks) plus explicit bidi formatting-control
code points, and maps every such expected rejection to
`E_TRANSCRIPT_SOURCE_INVALID`; it applies one named whitespace/
line-break policy. Limits apply after normalization to the entire publication:
at most 1,000,000 Unicode scalars and 4 MiB normalized UTF-8, 4,000 cues, 2,000
scalars per provider segment, and 128 scalars per speaker. Persisted/rendered
text uses DOM `textContent`; speaker and cue prose render separately in
`<bdi dir="auto">` while `lang` appears only on the list/track. `VTTCue` text
escapes `&`, `<`, and `>` before insertion. Adversarial markup, bidi controls,
combining sequences, invalid UTF-8/language tags, and the exact aggregate
ceiling run in real worst-case Chromium and Android WebView proofs.

Every normalized cue uses int64 milliseconds and must satisfy
`0 <= start_ms < end_ms`. Owned-video cues additionally require
`end_ms <=` the exact trusted Timeline duration; hosted-Podcast cues require
`end_ms <=` the exact input-probe duration bound to that work. A publisher
sidecar without a trusted duration still obeys the four-hour v1 source profile
ceiling; it never writes or upgrades Timeline duration. Out-of-bound timing is
`E_TRANSCRIPT_SOURCE_INVALID`, not clamped. Exact-end, one-ms-over, negative,
overflow, and probe/Timeline-drift proofs cover each source arm.

After normalization, deterministic pure
`services/transcripts/segmentation.py` assembles prose cues: merge consecutive
cues while the merged text has no sentence terminator, the speaker is
unchanged, and both the 30-second and 320-scalar merge ceilings hold; never
fabricate sub-segment timings to split a provider segment. The merged interval
is `[first.start, last.end)`. Published cues must be strictly increasing and
pairwise disjoint. Overlap is resolved only by merging adjacent overlapping
segments when their normalized speaker values are equal (including both
Absent) and the resulting cue still satisfies the 30-second and 320-scalar
caps; otherwise publication rejects with `E_TRANSCRIPT_CUES_OVERLAP`. An
alternating-speaker overlap is a required rejection fixture. The
owner never clamps an endpoint, drops a zero-length text-bearing cue, trims
text, or fabricates timing to force acceptance. The v1 unvirtualized list is
therefore bounded and proved responsive at the full aggregate ceiling.

Terminal failure classification is one typed mapping in
`transcripts/state.py`, used by both failure owners and exhaustive over
`TranscriptFailureCode`: definitive provider absence -> `unavailable`; quota
-> `quota_blocked`; only a `DefinitivelyUnavailable` source outcome advances
to the next pre-admitted source; every terminal code projects exactly the recovery
declared in the error-code table, never a blanket Retry.
`E_TRANSCRIPT_SOURCE_REQUIRED` is terminal on first attempt — a deterministic
condition the queue never retries. Publication
and operation are orthogonal: queued/running/cancelling/failed replacement
work leaves the previous publication mounted, and only successful replacement
changes it. Expected classified failure completes the queue and sets the
operation arm. Unexpected dead-letter leaves the exact operation `Suspended`
and operator-owned for same-job repair; it does not overwrite readable content
or become a user Retry. "Nonterminal transcript work" is read from the domain
operation owner, never inferred from queue rows. `Idle.action` becomes
`Requestable { intent=ReplaceWithNexus }` when a current owned asset exists and
the publication provenance is PublisherProvided, Imported, or ThirdParty
machine; Nexus-machine publication yields `NoAction`. Caption-first is a
default, not a trap.

| Transcript state | Content / action |
| --- | --- |
| Publication Absent + Idle/Requestable | **No transcript yet.** / **Transcribe…** |
| Publication Absent + Idle/Blocked `BillingRequired` | **Transcription is included with AI plans** / Review billing |
| Idle/Blocked `TimelineBinding` | **Playback and transcription pause while Nexus verifies the copy.** / none |
| Podcast Idle/Blocked `DurationUnknown` | **Nexus needs to verify this episode’s length before it can transcribe it.** / **Verify episode length…** |
| Video Idle/Blocked `DurationUnknown` | **Nexus needs a verified kept copy before it can measure this video.** / **Keep a copy…** only when current `videoCopy` is Keepable; otherwise the exact truthful copy block action or none |
| Forecasting (client transient) | **Preparing transcription…** |
| Queued / Running / Cancelling | **Transcription queued** / **Transcribing…** / **Cancelling transcription…**; current publication, if present, remains readable |
| Publication Present | content + quiet structural provenance (publisher-provided / imported / YouTube captions / YouTube automatic captions / third-party machine / Nexus machine) |
| Publication Present + Idle/Requestable `ReplaceWithNexus` | **Re-transcribe with Nexus…** |
| Quota blocked | **Not enough transcription time for this item** / Review billing |
| Retryable failure | **Couldn’t transcribe this item** / Retry |
| Free-source `E_TRANSCRIPT_CUES_OVERLAP` / `E_TRANSCRIPT_SOURCE_INVALID` | **Nexus couldn’t use this transcript’s timing or text safely.** / current authorized Podcast stream or owned-video asset: **Transcribe with Nexus…** (fresh hosted-only forecast/confirmation); otherwise **Check again** |
| `E_TRANSCRIPT_CAPTION_METADATA_UNPROVEN` | **Nexus couldn’t verify who created this caption track.** / current owned-video asset with live `OwnedVideoAsrApproved`: **Transcribe with Nexus…**; otherwise **Check again** |
| Hosted-ASR invalid/overlap | **Nexus couldn’t use the transcript returned for this item.** / none |
| `E_TRANSCRIPT_PROVIDER_PROFILE_UNSUPPORTED` | **This transcription provider couldn’t produce the transcript Nexus requires.** / none |
| Broken kept-copy integrity | **Nexus can’t verify the kept copy for transcription.** / canonical **Remove copy…** |
| Suspended | current publication if present + **Nexus needs repair before transcription can continue.** / none |
| Idle/Blocked `SourceRequired`, copy keepable | **Keep a copy to transcribe this video** / Keep a copy… |
| Idle/Blocked `SourceRequired`, copy blocked | **Transcribing this video needs a kept copy** + **Nexus can’t keep a copy while this item has a transcript, chapters, time highlights, or other authored timing it can’t verify.** / Discard saved timeline… |
| Unavailable `NoProviderTranscript` | **No transcript is available for this item** / **Check again** (fresh ordinary forecast/request + new key; no new route) |
| Readable transcript, Timeline not playable | timestamp controls, **Return to {time}**, and Highlight seek are absent (not disabled); cues render as prose with non-interactive timestamps; one truthful line reuses the playback reason (`CopyBinding` / `KeptCopyRemoved` + **Open source**) |

The transcript component and accessibility oracle enumerates those exact six
visible provenance labels—**publisher-provided**, **imported**, **YouTube
captions**, **YouTube automatic captions**, **third-party machine**, and **Nexus
machine**—and rejects a generic/generated fallback or an accessible-name
mismatch for either official-caption arm.

Confirmation title is **Transcribe this video?** or **Transcribe this
episode?** A free-source-then-hosted plan presents its truthful worst case:
**May use up to {requiredMinutes} transcription
minutes. {remainingMinutes} minutes remain this month.** for the explicit
`Fits` budget arm, and **May use up to {requiredMinutes} transcription minutes.
Your plan has no monthly limit.** only for the explicit `Unlimited` account
policy arm. Actions are **Start
transcription**, **Cancel**. A zero-cost-only plan says Nexus will try the named
free source and may find none; it never claims an unobserved caption/sidecar
exists. Admission reserves the displayed worst case and settlement releases it
when a free source wins. For a video whose copy capability is
`NotKept { keep: Keepable { ... } }` and which has no kept copy, the confirmation
renders a blocking notice above the actions — **If you transcribe first,
keeping a copy later requires discarding this saved transcript and timeline.**
— and offers **Keep a copy…**
as the primary action with **Transcribe anyway** secondary; the video pane's
**Keep a copy…** affordance is visible from first open so the ordering is
discoverable without a banner.

If YouTube captions are absent and no kept copy exists, fail with
`E_TRANSCRIPT_SOURCE_REQUIRED`, projected as
`Idle { Blocked { reason: SourceRequired } }` from current facts — the
`videoCopy` projection supplies the recovery action per the content table. A
later successful Keep immediately makes the operation Requestable; the old
attempt outcome remains audit only.
During a first-copy binding reservation, transcript capability is not
applicable and direct timed commands fail `E_MEDIA_TIMELINE_BINDING`; no
competing transcript job is admitted (and first-copy admission requires no
nonterminal transcript work, closing the reverse order).
Provider/network/quota failure leaves the previous readable transcript
mounted. Success atomically replaces current segments/fragments/state and
records input digest and provenance. For an `Ordinary` publication only, the
same transaction creates the one generic semantic-index operation; a
restricted YouTube caption sets `InapplicableByPolicy` and creates none.
Publication is the sole conditional admitter: the
`enqueue_semantic=False` variant of `publish_source_transcript` is deleted
and both callers use one publication path, deleting the
`transcript_semantic_intent`/`transcript_request_reason` source-result keys
and the `media_source_ingest.py` terminal-phase block that consumes them.
The current publication changes only on successful replacement. Transcript
paths stop mutating Media processing state at every named call site —
`begin_extraction` (YouTube and podcast-transcript runs),
`mark_ready_for_reading_by_id` (`transcripts/current.py`), and
`mark_media_failed_by_id` (`podcasts/transcription_failure.py`,
`source_attempt_failures.py`) — reserving
`processing_status`/`failure_stage`/`last_error_code` for primary ingest;
`TranscriptRequestResponse.processing_status` is deleted.

V1 stores segment intervals only. A cue is active exactly when
`startMs <= positionMs < endMs`; the disjointness invariant guarantees
exactly zero or one active cue, and binary-search selection, `aria-current`,
follow, **Return to {time}**, and one-cue Highlight derivation all rely on
it; gaps have no active cue. The ready view is one continuous selectable
list: timestamp button + optional truthful speaker + paragraph. Text is
never a seek button. The cue list carries publication `lang` when present;
speaker and prose each use `<bdi dir="auto">`. Only the normalized prose node
is a `data-transcript-highlight-root`; highlight offsets are Unicode-scalar
offsets relative to that prose, never the timestamp or speaker. A selection
whose endpoints/interior intersect the timestamp, speaker, or more than one
prose root disables Highlight with **Select only transcript text within one
segment to highlight.**; copy-only actions may still use the user's visible
selection. Timestamp **Play from {time}**
seeks and resumes. The controller keeps independent `activeCueIndex`
(clock/`aria-current`/follow/Return) and `rovingFocusIndex`
(keyboard/tab/focus). Only the latter owns tabindex; Up/Down moves it,
Home/End move to first/last cue, and playback-driven active-cue changes never
move it or focus. A concise `aria-describedby` instruction names these keys
and Enter/Space activation. This avoids thousands of tab stops at the
4,000-cue ceiling while retaining a real button for assistive technology. The
one-list cut re-targets Find and highlight rendering for `Ordinary`
publications: `transcriptPaneFind.ts`
and `useMediaPaneFind.ts` move from fragment selection to cue-range
locators; `useHostedTextHighlights`/`HtmlRenderer` become the
highlight/evidence renderer over the continuous list, reading Highlights
media-wide through `GET /media/{id}/highlights` (the per-fragment keying and
per-fragment highlight read are replaced, not extended) and painting every
`transcript_time_text` anchor across the whole list; the
"Active transcript segment" region is deleted with its handlers rehomed onto
the cue list.

Follow starts attached. The transcript never introduces its own nested
scroller: follow scrolls the media pane's existing `.documentViewport`
reader container on both desktop and mobile, with the stable reading band
and **Return to {time}** computed against that element's client rect
(including the mobile content offsets), received through the pane
scroll-owner ref. Follow detaches only on an observed user gesture — a
trusted `wheel`, a trusted `touchmove` with non-zero delta, a trusted
scroll-key `keydown`, a text selection, or a scroll delta during a trusted
pointer drag — mirroring the reader's gesture classification; a raw `scroll`
event is never intent, and the controller's own reading-band correction and
**Return to {time}** set a programmatic-scroll guard released on the frame
after the target position is reached, never by a timer. The transcript
surface is a `[data-player-shortcuts-disabled]` scope with its own key
model: Up/Down move the cue cursor and detach follow; Enter/Space on a
focused timestamp performs **Play from {time}**; no transcript key seeks by
a skip interval or toggles playback; Escape reattaches. **Return to {time}**
scrolls to the current cue, or the nearest following cue (last preceding at
end), and reattaches without seeking. Its accessible name remains **Return to
playback position** while the changing visible clock fragment is
`aria-hidden`; activation resolves the fresh current cue. Assistive technology
therefore receives no cue-by-cue name-change announcement. The follow controller reads cue
geometry from a cached offset table rebuilt on resize and content commit,
never measuring per clock tick. A cross-cue selection still opens the
selection palette: for an `Ordinary` publication the Highlight/Note actions
render disabled with one truthful announced line — **Select within one
transcript segment to highlight.** — while other policy-permitted actions may
stay enabled. For either restricted YouTube-derived arm, the Nexus palette may
show only plain Copy and every save/share/AI action is absent; UA/OS residual
actions follow the explicitly approved host policy above. The selection is
never silently ignored.
The current cue
has a border/shape cursor plus `aria-current` that survives forced colors;
playback never moves focus or announces cue changes. Attached follow uses
smooth scrolling only when reduced motion is not requested and otherwise uses
immediate scrolling. At 400% zoom/320 px, timestamp and prose reflow without
horizontal document scrolling.

Moment Highlight awaits the engine's authoritative position at press time
through `readPosition()` — never blindly using the last clock tick — and fails
**Couldn’t highlight this moment** if the engine cannot report one; it
stores that position under the active Timeline and works without a
transcript. One press gesture mints one `Idempotency-Key` and samples
`positionMs` exactly once at mint time; the client holds the pair for the
request's life and suppresses further presses in flight, so a network retry
replays byte-identical bytes and the ledger returns the same Highlight; a
second press after settle is legitimately new — the server performs no
positional dedupe or tolerance window. The same derivation governs
`transcript-highlights`. The direct control uses the existing
`DEFAULT_COLOR` constant — there is no last-used-colour memory and no Undo
affordance in v1; colour changes post-creation through the existing
Highlight actions, and the creation feedback offers **Add note**.
Transcript selection reuses the normal Selection popover and existing
selection geometry/codepoint helpers, but persists `transcript_time_text`,
not FragmentOffsets. V1 accepts one cue only; the server locks the expected
current publication and derives exact/prefix/suffix, cue interval, and
disposable locator without trusting client quote text.

Markers have two surfaces. On the seek track, Highlight markers are
`aria-hidden` decorations exactly like chapter ticks — markers within one
track pixel collapse into one denser tick, no pointer or keyboard
interaction, scrubbing never intercepted — and the seek input carries an
`aria-describedby` naming the count. The accessible, activatable surface is
the `PlayerContentsSheet`, which gains a **Highlights** section beside
chapters whose rows are labelled **Highlight at {time}** / **Highlight from
{start} to {end}**, activate **Play from {time}**, and meet the 44 px rule;
the added **Highlight** transport control follows the same ≤360 px overflow
rule as **Capture**, both reachable at 320 px. Evidence-rail markers extend
`build_markers` with the Timeline duration: `locator_fraction` gains a time
branch (`position_ms / durationMs`, `t_start_ms / durationMs`) when duration
is Present; when Absent, temporal items render as an ordered list with no
rail position — a fraction is never fabricated, an item never dropped.
Busy/failure copy is **Highlighting…** / **Couldn’t highlight this moment**
with Retry.

`t_start_ms`/`t_end_ms` are the immutable authored anchor and the sole basis
for every time label, marker, Evidence position, and **Play from {time}**.
Transcript replacement may invalidate the locator but never deletes or
retimes the root. Re-resolution runs inside the publication transaction that
replaces cues (owned by `services/transcripts/*`, never a read path):
candidate cues are those intersecting `[t_start_ms − W, t_end_ms + W]` for a
committed constant `W = 15000 ms`, via the shared quote matcher's new
`within_ms` scope; a unique in-window hit rewrites the locator, a zero or
ambiguous result — or a quote resolving uniquely only OUTSIDE the window —
leaves the locator Absent. Review state derives solely from an Absent
locator; no deleted-publication UUID is persisted or exposed merely as unused
provenance. A review-state row stays visible in the
Highlights list and Evidence/Connections with saved quote/time, keeps
**Play from {time}**, colour, note, and delete fully actionable, loses only
text-anchored actions until it resolves, and is omitted from the cue list
(nothing to paint). It renders as **Highlight needs review**.

Walknotes Capture has no independent store — its materialize step always POSTs
the waypoint's Timeline handle/position to `time-highlights` and stores a
`media_time` anchor, then `saveHighlightNote`
still attaches the transcribed voice note to the returned Highlight. Capture
remains the deferred, reviewed batch form of the same anchor; player
**Highlight** is the immediate form. This intentionally forgoes an automatic
quote even when a transcript exists: Capture records what the user heard at a
moment and must not invent a text selection or call an offsets endpoint without
offsets. Only explicit one-cue text selection creates `transcript_time_text`.
Client-side fragment resolution, its materialize fetch, and
`E_WALKNOTE_NO_FRAGMENT` are deleted.

Anchor consumers are cut exhaustively, with authorization first: highlight
readability is a fail-closed predicate, so the anchor-kind child-row
existence rule is expressed ONCE in a shared anchor-validity helper emitting
both the raw-SQL (`highlight_readability_sql`) and ORM
(`highlight_readability_filter`) forms plus
`require_typed_highlight_or_404`, each gaining exhaustive
`media_time`/`transcript_time_text` arms requiring the child row with
matching `media_id` — a kind matching no arm is a defect, not a silent
exclusion. New locator/target arms:
`MediaTimePointLocator { media_time_point, media_id, position_ms }`
registered across the retrieval locator unions with order key
`time:{position_ms:012d}`; `MediaTimePointTargetOut` in the reader-target
union; `PublicMediaTimePointAnchorOut` in the public-share union;
`transcript_time_text` reuses the existing `transcript_time_range` locator
arm and a re-keyed `TranscriptTextOffsetsTargetOut`.
`reader_locations.highlight_locator` becomes an exhaustive match that raises
on unknown kinds; quoting a moment Highlight fails
`E_READER_SELECTION_NO_QUOTE`. Search: `_HIGHLIGHT_VISIBLE_ROWS_SQL` gains a
`transcript_time_text` arm (locator fragment optional) emitting a
`transcript_time_range` locator from the immutable interval, so a passage
Highlight is findable while unresolved; `media_time` Highlights are
deliberately excluded from full-text highlight search (no quote — a stated
rule with its own residue check), and `resolve_highlight_search_result`
resolves the new arm. Vault: `selector_kind` widens to all four kinds
(`media_time` frontmatter carries `position_ms`, no quote;
`transcript_time_text` carries the interval plus quote triple); time
selectors are export-and-note-edit only — authoring or moving one from a
file is a typed conflict, never silently applied — and
`_metadata_for_highlight`'s trailing `else` becomes an exhaustive raise.
`HighlightActionFacts` gains per-anchor applicability facts
(`note_applicable`, `link_applicable`, `learn_applicable`,
`quote_applicable`) gating `EditHighlight`/`LinkHighlight`/`LearnHighlight`
so no offered action can 404 (`learn_applicable` is false for `media_time`).
`recent_highlight_anchor_facts` counts all four kinds as recent activity.
One documented carve-out: `covering_evidence_span_for_highlight` returns
`None` as a best-effort miss (time anchors have no chunk coverage by
design), exempt from the no-default-branch residue rule.

## Observed activity

Video `Viewing` hard-cuts focused-visible pane dwell. The browser adapter emits
bounded spans only while the selected video engine reports Playing,
`document.visibilityState === "visible"`, and its active `VideoCanvasOutlet` is
fullscreen or the shared `VisibleRegion` has finite union area strictly greater
than 50% of the actual media/iframe area, with source-time start/end positions.
It consumes the exact canvas-owned disjoint-region result (visualViewport,
ancestor clips, and geometric-union subtraction of every registered higher-
layer occluder); Activity owns no second rectangle approximation or list.
Crossing to 50% or below, any occluder intersection for YouTube, an unstable
measurement, `hidden`, `pagehide`, or Android `onPause` immediately closes the
span and emits no Activity while suspended. For a still-visible non-YouTube-
origin owned video, continued parked/occluded or below-threshold playback
records Listening; hidden playback emits neither Viewing nor Listening. For
either YouTube-provenance source, Activity consumes the canonical engine-
construction predicate above—actual media viewport at least 200 CSS px in both
dimensions plus the disjoint `VisibleRegion` union/occluder test—without
restating or computing a second rectangle; false pauses/fail-stops playback.
Non-YouTube owned video below that threshold/parked records `Listening`—a true
observation of the same engine—never `Viewing`; ExternalYouTube and
YouTubeOriginOwnedVideo both pause/fail-stop instead of becoming background
Listening. Non-MFK authorized events from those two sources and non-YouTube
owned `<video>` events are the only web evidence. MFK/unknown status for either
YouTube arm emits no Nexus observation. No iframe/event
support means no observation, not a dwell fallback.

Wire shapes are exhaustive: `ViewingActivitySpanIn`/`ViewingActivitySpan`
gain paired `mediaPositionStartMs`/`mediaPositionEndMs` AND paired
`progressStart`/`progressEnd` under the same `Presence` pairing validator
`ListeningActivitySpanIn` uses. Video session rows populate progress only when
the Timeline has authoritative duration; unbound YouTube rows keep progress
Absent rather than dividing by guessed provider metadata.
`ActivityRequest`/`ActivityRecordIn` gain
a batch-level `timelineHandle: Presence<TimelineHandle>` required exactly
for `Listening`/`Viewing` batches over canonical timed media (the BFF
forward envelope carries the new field), plus
an `engineSource: NonYouTubeOwnedVideo | YouTubeOriginOwnedVideo |
ExternalYouTube | Audio` discriminator and
`youtubeObservationToken: Presence<YouTubeObservationToken>`
required exactly for both YouTube-provenance arms and forbidden for
`NonYouTubeOwnedVideo`/`Audio`; the owned arm's token binds exact asset/content.
Those same two arms require paired nonnegative
`captureStartOffsetMs`/`captureEndOffsetMs`; other arms require both Absent.
For interactive writes current source resolution must agree. For delayed
Activity, agreement means the captured historical Timeline/provider/source/
asset provenance, not the current playback arm, so Keep/Discard after capture
cannot invalidate an otherwise authorized observation. A batch is
homogeneous in Media, Timeline, engine source, token nonce/window, and capture
generation; renewal closes the old span/outbox record and opens a new batch, so
no request straddles capabilities. Each YouTube-provenance span is wholly inside one signed
60-second observation window and closes before renewal; MFK/unknown/expired/
mismatched tokens are rejected before ledger mutation. Browser and Android
WebView video use the ordinary web Activity recorder plus IndexedDB/BFF; it
retains the token only for the 24-hour delivery window, redacts it from
diagnostics, and deletes expired rows. `NativeActivityOutbox` remains solely
native Audio and requires the token to be Absent; no needless Activity bridge
arm is added.
the server persists only the first-party Activity fact plus a bounded
decision-verification receipt digest deleted by 30 days, never MFK/API response
payload. `forwardMediaPositionMs` is
redefined as forward source-time advance across all timed modalities, with
schema docs and Stats labels updated to say so.

Observations are timestamped facts, not commands: at delivery the shared
gateway records the observed epoch instead of enforcing it. It accepts the
span after verifying the sealed Timeline exists and belongs to the Media even
when it is a historical, non-head generation, then persists `timeline_id` plus
the client-reported `binding_epoch`. Stats projects position/progress only
where `timeline_id` equals the Media's current head AND the recorded epoch
equals that Timeline's current epoch; `activeMs` counts valid observations
across all historical generations. Rejecting Activity delivery
during a binding reservation is forbidden. The Timeline handle is part of
observation-lane identity: any change to the session's handle — including an
epoch bump observed through SSE — closes the open span at the change instant
and opens a new one, exactly as a media or modality change does. On
suspension (`document.visibilityState !== "visible"`, `pagehide`, Android `onPause`) the Activity adapter
closes its open span and issues the best available `keepalive` position write
before its runtime suspends; either YouTube-provenance source has already
paused, while non-YouTube owned video may continue under the session heartbeat
without emitting hidden Activity. A span
not closed before suspension is discarded, never
persisted open-ended.
The ledger proof delivers delayed spans on both sides of binding-epoch bumps
and Timeline Discard (including delayed captured source after either change),
non-MFK external/owned-token renewal/expiry/replay, MFK/unknown direct-write
rejection, owned asset mismatch, and dialog/sheet full occlusion, and independently verifies current
position versus total historical active time.

Podcast Listening capture moves with its host, not its owner: the browser
Listening observer in `browserPlayerRuntime.tsx` becomes the BrowserAudio
engine's observation emission under D, and `NativeConsumptionRecorder.kt`
keeps Android Listening spans under the renamed PlaybackState vocabulary;
both keep paired positions and now attach the session `timelineHandle`.

## Files and non-overlapping work

One owner edits each shared seam. Workstream 0 lands contracts before
consumers; H0 owns proof-control registration before each green boundary, H1
owns final residue/docs after integration, and workstream I alone composes shared existing files after producer
ports exist. Feature workstreams do not take turns editing the same file.
The dependency-free contracts step precedes A: the closed `ApiErrorCode`
additions with status mappings; the Timeline port type; the owner-neutral
published ports (`lib/consumption/observationPort.ts` `EngineObservation` —
media ref, modality, playing, canvas-attached, source start/end positions,
`timelineHandle`, closed `NonYouTubeOwnedVideo | YouTubeOriginOwnedVideo |
ExternalYouTube | Audio` source, `Presence<YouTubeObservationToken>`, and
paired capture-start/end offsets plus captured monotonic/window/capture-
generation identity with exact Presence
validation; the moment-Highlight client port; `VideoCanvasOutlet`;
the `TimelineClock` read port; and engine-capability types). Workstream I owns
router registration order, generated fixture-manifest edits, and calls from
shared orchestration seams. Directory-level
ownership in this table means the named files only, never the whole
directory.

| Workstream | Exclusive files / responsibility | Depends on |
| --- | --- | --- |
| 0. Contracts | `errors.py` HTTP additions, closed durable failure enums, Timeline/transcript/copy DTO modules, and new owner-neutral frontend ports/types only. No route registry, service orchestrator, or generated manifest edit. | none |
| A. Persistence | `migrations/alembic/versions/<next>_durable_video_copy_timed_media.py`, `python/nexus/db/models.py`, `python/nexus/db/retries.py`, migration proof. Owns all schema/backfill/job-row migration and the constraint/index rewrite list; no services. | contracts |
| K1. Storage/security substrate | `python/nexus/config.py`, `python/nexus/logging.py`, `storage/{paths,client}.py`, `jobs/storage_write_capabilities.py`, new `services/{storage_remote_writes,media_egress_gateway}.py`, existing `services/{remote_file_client,epub_ingest,email_ingest_service,media_upload_sessions,oracle_plates,library_governance}.py`, `deploy/hetzner/Caddyfile`, and the named media-egress gateway deployment/config/proof files. Makes raw object mutators private; owns canonical object/write generations, upload-credential issuance, the exhaustive typed storage-writer capability registry, exact AST/runtime mutator inventory, the two authenticated egress listeners, callback-query log suppression/redaction, and all shared configuration constants requested by downstream owners. `services/media_source_ingest.py` remains I's sole call-site edit and video multipart remains B's typed subtype; both consume K1 ports. | 0, A, J coordination types |
| B. Copy lifecycle/storage | new `schemas/video_copy.py`, `services/video_copy*.py`, `services/source_attempt_cancellation.py`, `tasks/{acquire_video_copy,reconcile_video_copy,video_copy_removal,storage_object_cleanup,storage_orphan_sweep,media_teardown}.py`, `api/routes/video_copies.py`; `services/{media_source_types,source_publication,source_attempt_failures,media_activity,public_source_urls,media_deletion,redact}.py`, `schemas/media_activity.py`; named R2 lifecycle/smoke files other than K1's Caddy/egress files. Uses K1's only storage-mutation port, J's coordination/topology port, and C/E published ports; no raw storage adapter, registry/queue/Compose, Media DTO, or player UI. Existing R2 CORS files remain untouched. | 0, A, K1, C Timeline port, E provider port, J coordination |
| J. Durable coordination/existing writers | `jobs/{registry,queue,worker,process_executor,dead_letter_projections,operation_coordination,media_write_capabilities}.py`, `services/{media_deletion_fk_inventory,content_indexing,semantic_chunks,metadata_dispatch,metadata_enrichment,native_agent_operations,media_intelligence}.py`, `tasks/{media_content_reindex,enrich_metadata,media_unit_build}.py`, `docker/{Dockerfile.backend,docker-compose.yml,docker-compose.worker.yml,docker-compose.test.yml}`, `deploy/hetzner/docker-compose.yml`, and `deploy/env/env-prod-worker.example`. Owns OperationRef admission/claim/discovery, exhaustive writer and per-lane control-scanner registries, existing-writer operation/ledger migration, embedding batch protocol, and the exact five-process worker/slot/watchdog deployment topology; exposes typed ports only. | 0, A |
| C. Media composition/playback API | new `services/media_timelines.py`; `services/{media,playback_source,youtube_provider_lock,sealed_handles,capabilities,document_embeds}.py`, `services/podcasts/ingest.py`, `api/routes/stream.py`, `_listening_store.py` -> `_playback_store.py` (rename in place), `_projection.py`, playback schemas/route incl. `preview-position`, Next BFF routes, `lib/media/{mediaDetail,playback,useMediaProcessingStatus,documentEmbeds}.ts`, `lib/lectern/contract.ts`. Sole owner of Timeline creation/lock/epoch gateway and `read_event_snapshot`; calls E's exported transcript operation. No Activity store, shared orchestration seam, or React runtime. | 0, A, B DTO, E operation |
| D. Player/runtime/platform | `apps/web/src/lib/player/*` (incl. `PlayerVideoCanvas.tsx`, `playbackHeartbeat.ts`), `components/player/*`, `lib/security/{csp,headers}.ts` + `lib/env.ts` media/script-origins entries, `apps/web/androidPlayerProtocolCorpus.ts`, `apps/web/{next.config.ts,vitest.config.ts}`, `apps/android/app/build.gradle.kts`, `AndroidManifest.xml`, `app/src/main/java/app/nexus/android/playback/*` (incl. `NativeActivityOutbox.kt`, `NativeConsumptionRecorder.kt` playback vocabulary), `NexusWebView.kt`, `MainActivity.kt`. Owns TimedMedia session, engines, canvas outlet, chrome, rate, and engine-observation emission against G's published port; hands the canonical protocol corpus bytes/hash to I without editing fixture/manifest. | 0, A, C, published ports |
| E. Transcript/OAuth kernel | `services/transcripts/*` (incl. new `segmentation.py`, `state.py` mapping), Podcast transcript admission/provider modules (`transcription_usage.py`, `transcription_reservation_settlement.py`, `transcription_failure.py`, `episodes.py` eligibility), `transcript_segments.py`, `jobs/youtube_oauth_credential_use_capabilities.py`, `services/{safe_stream,youtube_caption_oauth,youtube_caption_credentials,youtube_oauth_secret_envelopes,youtube_oauth_keyring,youtube_oauth_access_tokens,provider_compliance}.py`, transcript/OAuth schemas and backend routes incl. `api/routes/{podcast_transcripts,youtube_caption_oauth,youtube_observation}.py`, and tasks incl. `tasks/{probe_transcript_input,reconcile_stale_ingest_media,youtube_oauth_exchange,youtube_oauth_authorization_attempt_expiry,youtube_oauth_pending_expiry,youtube_oauth_binding_lifecycle,youtube_credential_revocation,youtube_caption_lifecycle,youtube_owned_asr_lifecycle,provider_compliance_sweep}.py`. Owns durable video transcript/generic naming, the exhaustive claim-qualified credential-use capability registry, OAuth secret/state/lifecycle, restricted-data deadlines, and Podcast input preparation through K1's exact egress client; exports the operation/job definition plus the exact primary-ingest seam change for I. No pane React, raw egress/storage adapter, or shared seam edit. | 0, A, K1, J coordination |
| F. Product/timed reading/Highlight | media-pane transcript components/styles/controllers: `app/(authenticated)/media/[id]/{MediaPaneBody,TranscriptPlaybackPanel,TranscriptContentPanel}.tsx`, `transcriptPaneFind.ts`, `useHostedTextHighlights.ts`, `lib/media/{transcriptView,transcriptChapters,timedTranscript,videoCopy,timedMediaCopy}.ts`, `lib/highlights/timeHighlights.ts`, `lib/actions/{resourceActions.ts,resourceActionRuntime.tsx}`, `lib/walknotes/walknoteSession.ts`, selection/copy clients, Highlight schema/routes/services and all non-shared anchor consumers — `auth/permissions.py` first, then `highlight_access.py`, `highlights.py`, `text_quote.py`, `passage_anchors.py`, `reader_locations.py`, `reader_evidence_markers.py`, `chat_reader_selection.py`, `schemas/{retrieval,reader}.py`, `vault.py`, `vault_contracts.py`, `services/resource_items/capabilities.py` (frontend `resourceCapabilities.ts` is regenerated, never hand-edited), `e2e/resourceActionProductOracle.ts`, `resourceActionApplicability.oracle.unit.test.ts`, `scripts/test-resource-action-surface-policy.mjs`, `e2e/journeys/resource-action-parity.journey.spec.ts`. Exports public-share/action-snapshot arms for I. Owns content sign-off, follow, selection, moment client, deletes pane dwell; no player or Activity policy. | 0, B, C, E, published ports |
| G. Activity | `schemas/consumption_activity.py`, `services/consumption/{_activity_store,_activity_stats}.py`, `api/routes/consumption_activity.py`, `lib/consumption/{activityContract,activityRecorder,activityRuntime,activityOutbox,historyBff.server}.ts`, and its published observation/command functions. D emits engine observations; G turns them into ledger spans and hands Consumption-service calls to I. It does not edit shared `service.py`, player/pane state, or replace reader activity. | 0, A, C handle type |
| H0. Proof control | Sole owner of `testdata/proofs.json`, `testdata/faults/**`, and `python/nexus_test_control/{model,policy,build}.py` for new risk/glob/proof/fault registration and ownership SHA. Lands each registration immediately before that boundary's committed red/green proof; never edits product/docs. | 0, then interleaved A-G/I/J/K1/K2 |
| H1. Residue/docs | Journey replacement, `docs/modules/*` (only named edits below), `docs/local-rules/codebase.md` (both normative native rules), `docs/architecture.md` stale references, and release checklist; hands final residue anchors to H0 rather than editing H0-owned control files. May only compose published contracts. | A-G, I, J, K1, K2, K3, H0 |
| I. Shared-seam integration | Sole owner of `api/routes/__init__.py`, `testdata/android/player-protocol.json`, `testdata/manifest.json`, `services/media_source_ingest.py`, `services/public_resource_sharing.py`, Consumption `service.py`, `services/resource_items/action_snapshots.py`, and `schemas/resource_action_snapshots.py`. Integrates only exported typed ports, orders static routes before `/media/{id}`, and lands protocol corpus plus manifest digest atomically in one integration commit; no new domain logic. | A-G, J, K1 |
| K2. Account erasure | new `services/{user_deletion_fk_inventory,user_account_erasure}.py`, `tasks/user_account_erasure.py`, `schemas/account_erasure.py`, `api/routes/account_erasure.py`, `apps/web/src/app/api/settings/account/route.ts`, and focused backend/BFF proofs. Owns logical-target discovery, physical-disposition/coverage sealing, typed domain delegation, closure, receipt, and the account-erasure BFF route; it invokes published J/B/C/E/K1 ports and edits none of their files. I registers its already-published backend route afterward. | A, B, C, E, J, K1 |
| K3. Release orchestration | `deploy/hetzner/release.py` and its focused unit/host-fixture controller proofs only. Owns the immutable pre-mutation manifest, maintenance/admission marker, durable release phases, immediate pre-DML revalidation, forward-fix recovery, and exact candidate/predecessor/schema/APK/protocol identity binding. It invokes published preflights and artifacts; it owns no migration, feature, Caddy, Compose, proof-control, or product file. | A-G, I, J, K1, K2, H0 |

Exact additions to those exclusive sets: C owns
`api/routes/media_user_titles.py`, `schemas/media_user_titles.py`, the matching
Next BFF `app/api/media/[id]/user-title/route.ts`, and decoder/client. D owns
`YouTubeOAuthCustomTab.kt`, the query-free App-Link completion handling in
`MainActivity.kt`, restricted-selection action-mode policy in `NexusWebView.kt`,
and their Android tests; it never owns PKCE/token exchange. E owns
the exact files enumerated in its row plus `services/transcripts/use_policy.py`
and runner-qualified backend tests. F owns
`app/(authenticated)/settings/youtube-captions/**`, all
`app/api/youtube-captions/**` BFF routes, transcript forecast/request/cancel and
input-preparation/input-preparation-cancel BFF routes, and exact edits to
`app/{privacy,terms}/page.tsx` plus browser/legal-content proofs. A owns all new
tables/DTO-generated model shapes; 0 owns closed OAuth/compliance DTOs/errors;
I alone registers every backend route and shared Settings navigation seam. D
owns the exact
`app/api/media/[id]/youtube-observation-authorization/route.ts` BFF beside its
player activation owner. K2 owns
`app/api/settings/account/route.ts`; I only supplies its backend registration.
No
wildcard grants ownership of a sibling file.

Named H1 doc edits: `docs/modules/jobs.md` lane sentence;
`docs/modules/storage.md` Owners row for the video asset path + narrowed
read-time invariant; `docs/modules/podcast.md` transcript-pointer retirement;
`docs/modules/consumption-activity.md` Viewing/Listening definitions, owner
table, and `media_playback_states` rename (retire "video-pane time");
`docs/modules/player.md` Android session ownership and the one-mounting-
component rule; `docs/modules/highlight.md` media-wide transcript highlight
read; `docs/local-rules/testing-standards.md` journey-count correction;
`docs/architecture.md` renamed tables/routes/stores.

Expected new frontend files are `lib/media/videoCopy.ts`,
`lib/media/timedTranscript.ts`, `lib/media/timedMediaCopy.ts`,
`lib/highlights/timeHighlights.ts`, `lib/player/playbackHeartbeat.ts`
(rename), `lib/consumption/observationPort.ts`, and
`lib/player/PlayerVideoCanvas.tsx` (the runtime owns the media node;
`components/player/*` stays presentation-only). Prefer extracting prop-driven
pieces from existing player/transcript components over cloning them.
New BFF route directories mirror `video-copy` + cancel, `playback-ticket`,
`timeline/discard`, `playback-state`, `preview-position`, transcript
forecast/request/cancel, transcript `input-preparation` + cancel,
`youtube-observation-authorization`, `time-highlights`, `transcript-highlights`,
YouTube-caption Settings/OAuth commands, and account erasure
exactly; delete the old
`listening-state` directory.

Cutover order is 0 contracts -> H0 registration interleaved immediately before
each A migration/J coordination+existing writers/K1 storage-security/C Timeline/
E transcript+OAuth/B copy/C projection/G activity/D player/F product proof ->
K2 account erasure -> I shared integration (including atomic Android
corpus/manifest) -> K3 release-controller integration -> H1 residue/docs -> H0
final ownership/residue digest.
Deployment is the repository's real release procedure:

1. Land the full implementation and protocol corpus without promoting web.
   Build, sign, checksum, and certify an immutable candidate APK and its protocol
   manifest from that exact SHA, but keep it staged/non-stable. Preflight the
   candidate artifact and signature directly; no stable channel points at a
   schema/protocol-incompatible APK before durable mutation begins.
2. Run the destructive multipart/checksum/list/reconcile exercise against the
   dedicated non-production release bucket. Separately, an authorized
   deployment-only, read-only production R2 preflight binds `candidateSha` and records exact account and
   bucket identity, lifecycle-rule canonical-JSON digest, integrity mode, and
   `ListMultipartUploads`/`ListParts`/`HEAD` capabilities. It also fully
   paginates the controlled prefix and requires the preliminary exact zero-count/
   empty-set digest; a nonempty result aborts so the deployed lifecycle can
   converge before another release attempt. A non-production
   success never stands in for that production configuration proof.
3. While the predecessor still accepts mutations, inventory every supported
   signed-in browser profile/device plus the exact installed stable Android
   build. For each browser profile, force and acknowledge all IndexedDB
   Activity-outbox delivery, prove zero pending client/server rows, unregister/
   update the old service worker as required, close every Nexus tab, and record
   a profile-specific receipt bound to candidate SHA. For Android, force native
   Activity-outbox upload through the acknowledged cursor, prove
   `activitySync=Synced` and zero pending rows on both sides, then close Nexus
   and prove its process/session stopped. Reopen checks find no predecessor tab/
   worker able to write. Missing inventory or any failure aborts before
   maintenance; no queued span is intentionally discarded.
4. While the predecessor is still restartable, build one closed immutable
   `PreMutationGateManifest` bound to candidate/predecessor/schema/APK/protocol
   SHA. It names the exact signed durable-copy and caption/owned-ASR approval
   artifacts, both versioned strict-untracked host-profile artifacts,
   exact-project `YouTubeOAuthProductionReady` artifact, expressly
   authorized encrypted-WAL/backup retention artifact, production-R2 preflight
   receipt, and provider-supported `ProviderTerminalPath` contract/evidence that
   covers response-lost server Create/Complete plus every issued or in-flight
   presigned PUT, its numeric `PROVIDER_TERMINAL_PATH_MAX_SECONDS`, and the
   signed `PROVIDER_MIN_DISPOSITION_NOTICE_SECONDS`, derived effective active
   cap/current cohort, and `YOUTUBE_VIDEO_COPY_COMPLIANCE_MARGIN_SECONDS`. It also binds the
   preliminary production multipart observation's complete continuation-chain,
   zero count, canonical empty-set, lifecycle-rule, bucket/account, and provider-
   fence digests. Validate artifact bytes, signatures, subjects, project/account/
   bucket/client identity, validity/disposition windows, and mutual digest
   equality; then durably fsync/rename release state phase
   `PreMutationGatePassed` with the manifest SHA. Missing, stale, unsigned,
   subject-mismatched, or unavailable evidence aborts before maintenance.
5. Atomically enable the release-owned maintenance/admission gate, binding its
   marker to that pre-mutation manifest, then cancel
   or settle every nonterminal supplemental/reconcile writer, gracefully
   release claims, prove zero old-kind running rows plus zero running rows in
   the transcript supplemental-attempt -> `ingest_media_source` join, and let `_stop_writers`
   stop `worker-background`, `worker-media`, `worker-interactive`, prove every
   reserved compliance lane idle with all due refs settled, stop
   `worker-provider-compliance`, then `api`.
6. Immediately before any schema/data DML, reopen every named artifact and
   revalidate the complete manifest, signatures/windows/identities, exact
   production R2 state, writer/client drain, and absence of any newly issued
   presigned capability. Under the terminal fence it fully paginates
   `ListMultipartUploads` again and requires the same exact empty set; the
   authenticated revalidation receipt/continuation-chain digest is written to
   release state and fsynced with `PreMutationGateRevalidated`. Then
   persist `DataMutationStarted` immediately before invoking the A migration
   one-off. Removal, expiry, replacement, or drift of any artifact aborts with
   the predecessor restartable and proves no schema/data mutation. The migration asserts zero old job-kind rows across all statuses;
   run the production release and exact-version/schema/routes smoke.
7. After candidate `/version` proves the new identity under maintenance,
   promote that already certified immutable APK/manifest to the stable non-draft
   channel, verify stable digest equality, install it, run the bound device
   smoke, prove `/media/{id}/listening-state` is 404 and
   `/media/{id}/playback-state` answers, then and only then disable maintenance.
   The predecessor APK shows non-retryable **Update Nexus for Android** during
   the window.

The gate is not a prose convention. `deploy/hetzner/release.py` adds
`ReleasePaths.release_state = /var/lib/nexus/releases/release-state.json`,
`ReleasePaths.pre_mutation_gate =
/var/lib/nexus/releases/pre-mutation-gate.json`, and
`ReleasePaths.maintenance_gate =
/var/lib/nexus/releases/maintenance-gate.json`. The controller writes a closed
release-state record `{candidateSha, predecessorSha, phase, schemaIdentity,
preMutationManifestSha256, updatedAt}`, the immutable closed artifact manifest,
and maintenance record `{candidateSha, predecessorSha, phase, schemaIdentity,
preMutationManifestSha256, enabledAt}` by same-directory temp file, file `fsync`,
atomic rename, and directory `fsync`.
The bundled Caddyfile and compose mount let Caddy read only that exact marker:
while `api` is live, GET/HEAD reads remain available but all mutation methods
receive `503`, `Retry-After`, and strict JSON `E_RELEASE_MAINTENANCE`; after the
API stops, reads receive the same typed update-in-progress response. The web
decoder renders one **Nexus is updating** surface with no Retry mutation. Only
the controller may advance/remove the record, and crash resume revalidates its
candidate/predecessor/schema/manifest identities before action. It never trusts
a digest without reopening and validating the named artifact. Unit, host-fixture, and
protected-release proofs amend the existing `immutable-production-release`
risk, kill the controller at every gate/state boundary, and remove, expire, or
subject-swap each manifest member after `PreMutationGatePassed`; every case
asserts no `DataMutationStarted`, migration invocation, or schema/data DML.

Release recovery is phase-explicit:

| Last completed phase | Allowed recovery |
| --- | --- |
| before `PreMutationGatePassed` | no mutation occurred; repair evidence and restart/retry the exact predecessor/candidate |
| `PreMutationGatePassed` or `PreMutationGateRevalidated`, before durable `DataMutationStarted` | reopen/revalidate every manifest member and predecessor schema/artifact; if any gate fails, remove maintenance only through the controller and restart that exact predecessor |
| `DataMutationStarted` persisted, even if the migration transaction reports rollback | `ForwardFixRequired`: keep maintenance enabled; only an exact candidate-schema-compatible forward fix may run |
| migration committed | `ForwardFixRequired`: keep maintenance enabled and deploy only an exact-schema-compatible forward-fix artifact; the predecessor MUST NOT restart |
| candidate postdeploy passed | normal later releases only; no ad hoc schema reversal |

The release controller records the phase and exact artifact/schema identities
durably and proves crash-resume at every boundary. This adds operational
machinery, but a destructive hard cut without a post-migration forward-fix
contract is not releasable.

F inventories every `anchor_kind` consumer before editing — the
authorization layer first (`auth/permissions.py`, `highlight_access.py`),
then highlight access and deletion, reader/evidence target resolution,
search retriever, resource graph and note/chat linkage, Vault,
sharing/export, API schemas, and frontend strict decoders. Each exhaustively
projects `media_time`/`transcript_time_text` or returns a typed
`UnsupportedAnchor`; no default branch, accidental 404, or document locator
fallback is permitted (sole documented carve-out: covering-evidence spans).

Delete, do not wrap:

- the full `listening_state.py` route inventory (GET/PUT
  `/media/{id}/listening-state`; `preview-position` moves to the renamed
  router), the PodcastListening wire/model names inside the renamed playback
  store, `MediaOut.listening_state` and its `mediaDetail.ts` decoder, the
  `duration_ms` playback-state column and wire field, their old Android
  protocol/native allowlist arms, and both old normative rules in
  `docs/local-rules/codebase.md` (`listeningHeartbeat.ts` and
  `_listening_store.py` are renamed in place, not deleted);
- `FooterAudio`, video `OpenPane` activation, and the audio-only public
  `PlayerSession` names by exact identifier (residue anchors): `AudioSession`,
  `playAudio`, `FooterAudioActivation`, `PlayerDescriptor.activation`,
  `NextCapability`/`next_capability` old values, `episodePlaybackRate`,
  `ListeningStateOut`/`decodeListeningState`, and the `FooterAudio` guard in
  `descriptorFromLecternItem`;
- `CapabilitiesOut.can_play` and its `mediaActionCapabilities.ts` decoder
  field; a provider embed URL on the wire (`embedUrl`);
- loose nullable `external_audio | external_video` PlaybackSource fields and
  permissive decoders, loose nullable transcript state/coverage, and the
  top-level `transcript_origin` Presence field superseded by publication
  provenance;
- synchronous YouTube caption fetch in the HTTP request; the `dry_run`
  two-call transcript request pattern, the dry-run forecast audit write, and
  `media_transcript_request_audits.dry_run` (existing forecast-outcome audit rows
  are preserved and reclassified as `ForecastOnly`; new forecasts write none);
- `VIDEO_TRANSCRIPT -> _run_youtube_video` and `YOUTUBE_VIDEO` transcript-source
  classification;
- `podcast_transcript_segments`, `PodcastTranscriptSegment`, and
  `podcast_reindex_semantic_job` shared names or retained job rows;
- supplemental copy attempts in generic primary-ingest `source_progress` or
  any latest-attempt consumer, raw private UUIDs on wire boundaries, or an
  unsealed generic handle;
- iframe URL-reload seeking, the video-to-global-audio seek branch
  (`MediaPaneBody.tsx` `handleTranscriptSeek`/`videoSeekTargetMs`), transcript
  paragraphs implemented as buttons, and `Seek to {token}` show-notes labels;
- transcript FragmentOffsets creation/decoding, generic fragment-highlight
  acceptance for transcript fragments, and Walknotes client-side fragment
  resolution (`resolveActiveTranscriptFragment`, the materialize fragments
  fetch, `E_WALKNOTE_NO_FRAGMENT`);
- JS `.length` for persisted quote offsets;
- focused-pane video dwell (the `TranscriptPlaybackPanel.tsx` observer) and
  every fallback to it, plus pre-cutover dwell-derived Viewing rows;
- any video bytes in `media_file`, raw object write without cleanup reservation,
  producer-authored `DeleteRequired`, attempt-only object path, or copy/transcript
  mutation of Media processing state;
- any duplicate player/highlight/rate implementation, non-exhaustive anchor
  consumer, unfenced content-bound timed writer, or duration-only Timeline
  identity check.

## Red / green / refactor and proof shape

Every boundary gets one canonical, runner-qualified outcome proof with one
named, REGISTERED risk. Declared faults are the default red mechanism for
this cutover: for each new priority node, register one entry in
`testdata/faults/manifest.json` (`{id, patch, sha256, proofs,
expected_failure}`) and record sensitivity with
`./scripts/test prove --proof <node> --against fault:<id>`; reserve
`--against base:<exact-cutover-base-SHA>` for proofs that already exist and
already collect at that base. Red must be a behavioral assertion failure
bound to the exact proof id — an import, collection, missing-Alembic-revision,
thrown-error, or timeout crash is not red — and `prove` requires a clean
committed checkout, so the proof is committed before red is recorded. Then
make it green and refactor only behind the same proof. Register priority
nodes in `testdata/proofs.json` (recomputing
`PRIORITY_RISK_OWNERSHIP_SHA256` in `nexus_test_control/model.py`, keeping
each risk's declared capabilities equal to the union of its proofs'); use
only `./scripts/test` for verdicts.

| Boundary | Canonical proof | Registered risk id | Independent oracle |
| --- | --- | --- | --- |
| A schema/timeline | `pytest:python/tests/migrations/test_durable_video_copy_timed_media_migration.py::test_cutover_converges_identity_and_job_rows` | `migration-compatibility` | real upgraded Postgres catalog + rows: exact constraint/index/FK list, digest constant, deleted-row counts, join-scoped zero-running transcript-source precondition/rewrite, `created_at` on every new row including `media_transcript_input_preparation_progress` and `user_account_erasure_physical_disposition_completion_heads`, and `updated_at` only on declared current-head/mutable rows |
| J operation claim/claim-set fence | `pytest:python/tests/service/test_operation_claim_fence.py::test_claim_set_serializes_queue_correlation_and_domain_commit` | `durable-operation-claim-fence` | real Postgres with opposing claim/terminalize/prune/teardown order, lease loss before commit, mixed Mutate/ObserveTerminal refs, and exact lock-topology equality; no in-memory queue double |
| K1 storage remote-write fence | `pytest:python/tests/service/test_storage_remote_write_fence.py::test_late_write_cannot_publish_after_cleanup_fence` | `storage-remote-write-fence` | real Postgres + MinIO/adversarial delayed transport proving canonical object/write generations, exactly one closed typed producer-owner arm, cross-producer/object/path substitution rejection, same-part retry as distinct generations, complete paginated multipart capability/generation count+digests, exact typed Abort-generation association and cross-target/wrong-kind rejection, strict `NotApplicable` zero-capability scope, generic post-fence object-absence generation members and cross-fence/settlement/HEAD-before-fence rejection, every production mutator in the AST/runtime registry equality inventory, creator-set exclusion of cleanup Abort/Delete, one `Reserved` cleanup per materialized object plus failure/removal/teardown activation, response-loss/issuance-before-sign, and release refusal for an untracked production multipart upload or missing provider fence |
| B admission | `pytest:python/tests/service/test_video_copy_admission.py::test_two_concurrent_keeps_publish_one_generation` | `durable-job-replay` | committed replay/attempt/job/binding rows under real Postgres and exact equations `AcquireVideoCopy producer=1`, applicable `ReconcileVideoCopy coordinator=1`, `Reserved StorageObjectCleanup=N materialized storage runs/objects` (zero before reservation); coordinator/cleanup excluded from producer count. Separate focused proofs own each idempotency mismatch, primary/supplemental interleave, progress boundary, and retry-applicability case |
| B queue cancellation substrate | `pytest:python/tests/service/test_job_cancellation_transitions.py::test_request_cancel_and_heartbeat_union_survive_all_transitions` | `durable-job-replay` | `Owned \| CancelRequested \| Lost` across claim, pre-execution heartbeat, `fail_job`, reschedule, shutdown release, requeue-dead, dead-letter |
| B resource envelope | `pytest:python/tests/service/test_video_copy_resource_envelope.py::test_peak_copy_tree_stays_inside_committed_envelope` | `durable-job-replay` | measured process tree (peak RSS/PIDs) and filesystem peak through production code; refusal, ENOSPC, cleanup, env/egress isolation, and production constants are separate focused/static/release proofs |
| B publication | `pytest:python/tests/service/test_video_copy_publication.py::test_crash_after_publication_commit_replays_without_duplicate` | `database-object-convergence` | real Postgres + MinIO content/publication/reservation/allocation rows before and after that exact crash; corruption, timestamp mapping, multipart abort, and writer interleaving remain separate focused proofs |
| B teardown | `pytest:python/tests/service/test_video_copy_teardown.py::test_remove_converges_to_verified_object_absence` | `database-object-convergence` | immutable removal attempts/completion + generic composite-FK object absence; typed teardown -> video-compliance active dependency and atomic receipt-backed conversion, exact active-or-settled plan equality, cross-Media/root/receipt-only rejection, adoption of the one compliance fence/removal/cleanup graph, classified repair, all writer races, full wake/schedule/capacity/absence child-first deletion, and Discard rejection before a fresh generation |
| B video-copy compliance deadline | `pytest:python/tests/service/test_youtube_video_copy_compliance.py::test_sealed_fence_finalize_removes_before_exact_deadline` | `youtube-video-copy-compliance-deadline` | real Postgres/worker/MinIO/provider-fake with fake clock: signed terminal-path + minimum-disposition-notice inputs, derived effective cap/two-slot placement and conditional 32/16-wave case; owned-ASR allocation count `{0,1}` and complete ref-member count `{2,4}`; full-cohort acceleration/re-placement, same-allocation reservation swap, immutable wake/current-head generation, cutoff/capacity rejection before I/O, no worker-held wait, duplicate/reorder/late/cross-placement rejection, active-to-receipt-backed members, planned removal pair, same-ref repair, provider absence/response loss, full-horizon host outage, and deadline fail-stop |
| H job-definition registry | `pytest:python/tests/jobs/test_job_registry.py::test_every_production_definition_is_explicit_and_topology_equal` | `durable-job-replay` | static/runtime equality over registry, dispatcher, strict payload, full field digest including mandatory `deadline_lane_policy`, five-process/four-lane execution-slot topology, per-lane control-loop scanner registry/cadence, handler import and resource ceilings; missing/defaulted/duplicate kind, cross-lane claim, scanner/topology drift, and invalid heartbeat/lease/wall fail closed |
| C playback/ticket | `pytest:python/tests/service/test_timed_media_playback.py::test_removed_asset_cannot_mint_or_reuse_origin_access` | `database-object-convergence` | sealed-handle API + object request/cache log after DB unpublication and physical delete; separate focused proofs own forged/cross-type/stale handles, SSE two-client invalidation, log redaction, and URL-path UUID absence |
| D session/engine/chrome | `vitest:apps/web/src/lib/player/timedMediaPlayer.browser.test.tsx` | `timed-media-session-ownership` | one real media node/session across pane navigation and a two-client epoch mutation; exact fault creates a competing node |
| D YouTube engine | `vitest:apps/web/src/lib/player/youtubeEngine.browser.test.tsx` | `youtube-iframe-contract` | documented fake `YT.Player` API + videos.list owner; exact-player callback, MFK no-tracking/unknown fail-closed, deployment profile id/version/hash binding, local artifact/unsupported-host fail-stop without fabricated server response, hidden pause, 200x200/50% visibility, visible Enter/Return focus, and no provider overlay |
| D ticket renewal | `vitest:apps/web/src/lib/player/ownedVideoTicketRenewal.browser.test.tsx` | `owned-video-ticket-continuity` | MinIO URL with forced expiry; Ordinary/Tracked paused safe-point swap restores position/paused/rate and removal clears source; strict-untracked is expressly excluded from this continuity owner |
| D strict-untracked host profile | `playwright:apps/web/e2e/proofs/youtube-untracked-host-profile.proof.spec.ts` | `youtube-untracked-host-profile` | exact versioned Chromium/Firefox/WebKit release matrix binds the signed profile id/version/hash; raw no-JS privacy embed and owned native-control arms; tracked-to-untracked/untracked-to-tracked rebuild; explicit gesture; actual controls and PiP/remote/download/custom-fullscreen/MediaSession absence; no state listener/read/writer; server-duration/monotonic safe deadline under maximum RTT, client-wall-clock skew, timer clamp, page/process suspension and lifecycle return; forced expiry tears down without renew/resume/new origin request, focuses Open video with exact polite copy, and reopens at UA default; unsupported/drifted host fails locally with only Open source |
| D canvas projection | `vitest:apps/web/src/lib/player/playerVideoCanvas.browser.test.tsx` | `video-canvas-containment` | clipping at pane scroll boundary, z-order, ordinary/tracked OwnedVideo wrapper fullscreen, strict untracked user-agent-control arm, focus order, and parked state |
| D responsive accessibility | `vitest:apps/web/src/lib/player/timedMediaResponsive.browser.test.tsx` | `timed-media-accessibility` | keyboard/visible focus, forced colors, reduced motion, 400% zoom, 320 px, safe areas, 44 px frequent targets, and one landmark |
| E OAuth secret/callback lifecycle | `playwright:apps/web/e2e/proofs/youtube-oauth-secret-lifecycle.proof.spec.ts` | `youtube-oauth-secret-lifecycle` | thin real browser -> Caddy-equivalent callback -> API -> real Postgres -> worker/provider-fake journey; session+cookie/state/PKCE/query secrecy and replay; typed five-arm schedule ownership, 12-ref bound with eight external roots/four successor headroom, seven-old-pass/eight-old-reject UX, internal successor non-failure, canonical schedule-before-account order, immutable wake generations, exact binding root+peer seal, active-marker drain, live/dead/expired/receipt arms, cross-kind/root/binding rejection, Fence/Finalize crash, and zero secret/Authorized Data/wake residue after deadline |
| E OAuth credential-use claim fence | `pytest:python/tests/service/test_youtube_oauth_credential_use.py::test_claim_owned_use_seals_exact_provider_response_set` | `youtube-oauth-credential-use-fence` | real Postgres + two runner claims/provider fake; claim/lease loss before every RefreshGrant/list/download arm, dispatch-intent/result/completion/member/channel-or-caption-allocation crash replay, exact complete-set sealing, same-credential cross-operation substitution, response loss, cancellation/deactivation race, and zero allocation from an unowned response |
| E Podcast input verification/SSRF | `pytest:python/tests/service/test_transcript_input_preparation.py::test_gateway_rejects_rebinding_and_binds_exact_bytes` | `transcript-input-ssrf` | real Postgres + worker + authenticated egress gateway + adversarial DNS/HTTPS/redirect/peer harness; private/metadata targets, rebinding, userinfo/ports, TLS, header/byte/time/disk ceilings, demux/protocol escape, exact-byte hash/duration forecast binding, progress, retry, cancel, and every typed terminal arm |
| E restricted-data deadline | `pytest:python/tests/service/test_youtube_restricted_data_deadline.py::test_maximum_work_is_fenced_and_deleted_before_deadline` | `youtube-restricted-data-deadline` | real Postgres/worker fake clock at the 14,400-second envelope; pre-I/O Caption initial lifecycle/reservation -> unchanged typed-allocation live transfer, two-ref owned publication and source-outcome transfers (`NoData` advances exact next source; `SourceFailed`/Cancelled never fall through) with lease/Fence races, initial and published exact two-ref fences, caption/owned-ASR 16-item cohorts on dedicated nonborrowing slots, refresh-cohort-before-purge schedule, immutable wake/head swaps, live/dead/expired/uncertain callers, stale/late-result rejection, matched receipts, response loss, full-horizon host outage/startup recovery, complete recovery-handoff margins, and forbidden-sink/secret/plaintext/wake/capacity absence |
| E transcript publication | `pytest:python/tests/service/test_media_transcript_publication.py::test_current_publication_replaces_atomically` | `citation-provenance-identity` | real work/reservation/dispatch/publication rows before/after interruption/epoch change; official-caption authorization, forecast equality, Deepgram uncertainty/no-resubmit, accounting, normalization/overlap/aggregate limits, and replacement are focused supporting proofs |
| K2 account-erasure closure | `pytest:python/tests/service/test_user_account_erasure.py::test_overlapping_targets_converge_to_one_physical_disposition` | `account-erasure-closure` | real Postgres/catalog with overlapping OAuth/credential/restricted-publication/Media/charge logical targets, cross-erasure and same-erasure cross-disposition owner/coverage substitution rejection, restrictive-FK deletion-topology equality, successor DAG, worker death at every phase, one physical mutation, complete closure seal, zero reusable user FK/plaintext/secret, and retained content-free receipts |
| F transcript follow | `vitest:apps/web/src/lib/media/timedTranscript.browser.test.tsx` | `citation-provenance-identity` | involuntary seek/focus; real selection, scroll, focus, media events; Find + highlight painting over the one-list view; responsiveness at the cue ceiling |
| F temporal Highlight | `pytest:python/tests/service/test_temporal_highlights.py::test_timed_anchors_survive_replay_and_transcript_replacement` | `citation-provenance-identity` | real rows with repeated quote and epoch fixtures; two presses 100 ms apart + one dropped response + retry; SQL/ORM readability twins agree for all four kinds; author list read-back via `GET /media/{id}/highlights` and search |
| G activity (browser) | `vitest:apps/web/src/lib/consumption/actualVideoActivity.browser.test.tsx` | `durable-consumption-activity` | emitted observations under play/hidden/parked/epoch states |
| G activity (ledger) | `pytest:python/tests/service/test_timed_media_activity_ledger.py::test_timed_spans_bind_timeline_and_survive_stale_epoch_delivery` | `durable-consumption-activity` | real Postgres rows across epoch bumps and Timeline Discard; delayed historical delivery counts active time while current position requires current head+epoch; MFK produces no rows |
| D Android protocol | `gradle:apps/android/app/src/test/java/app/nexus/android/playback/PlayerProtocolTest.kt` | `android-player-protocol-skew` — amend the already-registered node, do not create a second (`proof-unique-owner`) | canonical protocol fixture rejects old digest/vocabulary; covers a rejected stale-epoch native write; red = current corpus rejecting the new vocabulary at the base SHA |
| D Android WebView video | `gradle:apps/android/app/src/androidTest/java/app/nexus/android/playback/TimedMediaWebViewInstrumentedTest.kt::ownedVideoArbitratesRotationAndSuspend` | `android-timed-media-runtime` | real `NexusWebView` with exact app SHA, device, OS and installed WebView version; two-phase native/WebView handoff; gesture required after every rebuild/profile transition and after ordinary/tracked ticket-error recovery (`NeedsGesture`, never silent resume); tracked `youtube.com` and raw-no-JS `youtube-nocookie.com` external iframe Referer + Media Integrity/no error 153; owned R2 path proves no Media Integrity dependency; profile hash and supported/unsupported host; state-blind forced expiry across Android suspend/resume; UA controls plus PiP/remote/download/custom-view/MediaSession/notification absence; tracked↔untracked rebuild; `fs=0`, rotation/fold/multiwindow/theme/font/density continuity, and bounded suspend acknowledgement; routed through `./scripts/test release` with exact-SHA/device artifact |
| K3 pre-mutation release gate | `pytest:python/tests/deploy/test_release_pre_mutation_gate.py::test_gate_drift_aborts_before_any_data_mutation` | `immutable-production-release` | real release-state files + host-fixture controller with a DML invocation spy; remove/expire/subject-swap each manifest member after initial validation and crash at every phase, proving no maintenance-before-gate, no migration/schema/data DML before immediate revalidation, exact fsync/rename resume, and forward-fix-only truth after `DataMutationStarted` |

Workstream H0 also amends existing risk nodes: `database-object-convergence`
gains the video-copy/cleanup source globs and the B publication/teardown
proofs; `durable-job-replay` gains the queue-cancellation proof (its globs
and the job-definition registry proof (its globs already cover `jobs/**` and
`errors.py`); `durable-consumption-activity`
gains the renamed activity files and the new ledger proof.

H0 registers the new priority ids from the table exactly —
`durable-operation-claim-fence`, `storage-remote-write-fence`,
`youtube-video-copy-compliance-deadline`,
`youtube-oauth-secret-lifecycle`, `youtube-oauth-credential-use-fence`, `transcript-input-ssrf`,
`youtube-restricted-data-deadline`, `account-erasure-closure`,
`timed-media-session-ownership`, `youtube-iframe-contract`,
`owned-video-ticket-continuity`, `youtube-untracked-host-profile`,
`video-canvas-containment`,
`timed-media-accessibility`, and `android-timed-media-runtime` — with source
globs, the exact table proof, and capabilities equal to their proof union. Each
gets one narrow declared fault respectively: bypass one claim renewal; omit one
armed write generation; admit one late video-compliance member after the seal;
swap one same-kind secret semantic owner; bypass one
credential-use claim revalidation before response allocation; allow one private
redirect peer; admit work inside the computed deadline margin; double-
invoke one overlapping erasure target; mount a competing node; accept a
sibling-frame event/omit hidden pause; skip paused ticket state restoration;
install one strict-untracked media-state listener; bypass ancestor clipping;
remove the visible-focus/zoom constraint; or skip
native-session dismissal. These are real slug ids in `testdata/proofs.json`,
not prose labels. Other cases are supporting invariants and do not pretend to
be separately registered priority risks.

H0 is split operationally: `H0-register` commits a risk/proof/fault before its
red evidence; the feature owner commits the collecting proof, records governed
red, implements green, and records governed green; `H0-finalize` changes only
source globs/capability union/ownership SHA after all paths are stable. H1 docs
land after green and cannot be used as behavioral evidence.

`tasks/acquire_video_copy.py` exports one committed
`VIDEO_COPY_CRASHPOINTS` tuple with exactly: `after_storage_reservation`,
`after_create_before_allocation`, `after_allocation`, `after_part_checkpoint`,
`after_complete_response`, `after_integrity_verification`,
`after_publication_commit`, `after_reservation_finalize`, and
`before_queue_completion`. The parametrized crash proof imports that tuple and
asserts its collected parameter ids equal it exactly before exercising every
point; a test-only superset/subset cannot pass. Transcript dispatch uncertainty
has the analogous committed `TRANSCRIPT_DISPATCH_CRASHPOINTS` tuple covering
before intent, after intent/before POST, after POST/before response, and after
response/before durable submission. Its focused matrix includes
cancel-before-response-loss and cancel-after-response-loss for both resolver
arms, proving an authenticated recovered result is never published after that
work's cancellation. Removal and transcript dead-letter proofs each execute
two complete dead -> requeue -> dead cycles and assert monotonically allocated
domain `occurrence_no` values despite the queue retry counter reset.

AC16 is bound to owners: keyboard, visible focus, focus return,
`aria-current`, forced-colors, and reduced-motion assertions live in the D
player and F transcript-follow browser proofs; 320 px, 400% zoom, safe-area,
and 44 px checks live in the exact D responsive-accessibility proof above; the
Android row retains its governed device artifact; and the final work report
records a deliberate manual assistive-technology matrix at the exact candidate
SHA: macOS Safari + VoiceOver, Chromium keyboard-only at 400%/forced colors,
and the bound Android WebView + TalkBack. Safari/VoiceOver and Android/TalkBack
each cover both Enter/Return iframe focus and the certified untracked-owned
native-video landmark/name/control profile, including forced focused teardown
to the stable visible target and its one announcement; every row also covers
Escape priority, chrome names/state, cue roving/Home/End, active cue, selection,
follow detach/return, fullscreen capability, and error feedback.
Each row records reviewer/date/device/browser/OS/result/artifact; any missing
row is `NOT_RUN`, and automated browser assertions cannot substitute for it.

Register each fixture in `testdata/manifest.json` with exactly
`{path, sha256, source, license, purpose}` (the schema is closed); record
the generating ffmpeg command and byte length in a sibling
`testdata/media/README.md`; keep variants byte-distinct
(`corpus-duplicate-content`); store Chromium-consumed fixtures as `.b64`
text per convention. Use tiny self-created conforming, edit-listed, and
nonzero-PTS/A-V-skew MP4s. The yt-dlp proof uses the config-resolved
test-owned executable boundary (the Python socket guard is NOT relied on for
subprocess containment — the hardened child env removes it and ffmpeg is not
Python); ordinary suites never call YouTube, R2, or ASR; only
`python/tests/hosted/` may point at real binaries under its separately
authorized capability. The yt-dlp/YouTube canary lives in
`python/tests/hosted/nightly/` — scheduled, non-blocking; provider
availability is never a release gate. The release object-store check is a
real ranged GET against a presigned URL on a dedicated non-production bucket
asserting `206`, exact `Content-Range`, and byte-identical content; no test
workflow may contact the production bucket.

`playwright:apps/web/e2e/journeys/timed-media-playback.journey.spec.ts`
replaces `podcast-refresh-playback.journey.spec.ts` only after the
replacement preserves the retired entry's full oracle — Browse -> Subscribe
-> refresh-run completion, show-notes reconciliation after refresh,
episode-view URL/sort restore across a real reload, durable seek/resume —
carries forward its `source_globs` plus the new timed-media globs, declares
`test.use({ journeyId: "timed-media-playback" })` matching its file stem, is
registered to the same `durable-job-replay` risk, demonstrates red, and
passes. The final hard-cut commit swaps the files/registry entry atomically
and keeps 15 journeys. Add only one prepublished owned-video activation
proving the same session survives pane navigation; transcript details,
acquisition, faults, accessibility, and deletion remain focused proofs.

80/20 verification sequence:

1. During each workstream, run only its canonical proof and direct static owner
   paths with `./scripts/test changed <runner-qualified-proof> <owner-path>...`.
2. At boundary integration, run the renamed timed-media journey once.
3. Before handoff, run `./scripts/test confidence`.
4. Before merge, run `./scripts/test pr`.
5. Before release, route the Android signed/device proof (including the
   WebView video instrumented proof), the worker resource probe, the
   non-production object lifecycle/integrity check, exact compliance artifact,
   maintenance-gate proof, and bounded provider certification into and run
   `./scripts/test release`; the authorized read-only production R2 preflight
   and manual AT matrix remain separately named deployment/human gates.

Do not duplicate edge cases in the journey or claim production R2 recovery from
MinIO proof.

Acceptance is fail-closed through this exact evidence map. A criterion is PASS
only when every listed node/supporting artifact is green at the same candidate
SHA; a broader criterion never inherits PASS from one representative test.

| AC | Required exact evidence |
| --- | --- |
| 1 | B admission canonical row with exact `AcquireVideoCopy producer=1`, applicable `ReconcileVideoCopy coordinator=1`, and `Reserved StorageObjectCleanup=N materialized storage runs/objects` equations (zero before reservation; coordinator/cleanup excluded from producer count), signed-notice-derived effective capacity/reservation-before-I/O rejection, plus B queue-cancellation + J operation-claim-fence canonical rows; `test_video_copy_admission.py::{test_idempotency_mismatch,test_primary_supplemental_interleave,test_retry_applicability}` |
| 2 | B admission plus `test_media_timeline_discard.py::{test_tier_fences_and_reset,test_rejects_asset_removing_failed_suspended,test_fresh_generation_preserves_activity}` |
| 3 | B publication canonical row + integrity-mode/object-header focused cases |
| 4 | B publication + resource-envelope + K1 storage-remote-write-fence rows; parameter equality and all cases in `test_video_copy_crashpoints.py` plus multipart create/list/complete/abort response-loss and late-materialization cases |
| 5 | C playback/ticket + D YouTube-engine + D strict-untracked-host-profile canonical rows and exact timed-media journey: Tracked owned seeks to the last authorized position; strict untracked performs no seek/resume, forced ticket expiry tears down state-blind, and drifted/unsupported host fails locally with only Open source |
| 6 | C playback/ticket + D session rows; focused Previous/Next/binding/removal source-freeze cases |
| 7 | B teardown + B video-copy-compliance-deadline + K1 storage-remote-write-fence canonical rows; typed teardown-video active-to-receipt-backed dependency equality, product/compliance retry split, sealed same-ref repair, classified retry/suspension, full wake/schedule/absence graph child-first whole-Media deletion, R2 absence only after the exact provider fence, and generation-zero re-Add cases |
| 8 | D session, canvas, resource-envelope, and journey rows; concurrent ingest latency oracle |
| 9 | `vitest:apps/web/src/lib/player/timedMediaRate.browser.test.tsx` + Android Podcast rate/shorten-pauses protocol case |
| 10 | E transcript-publication + OAuth-secret-lifecycle + OAuth-credential-use-claim-fence + Podcast-input-SSRF + restricted-data-deadline canonical rows; pre-I/O Caption initial lifecycle/reservation and unchanged typed-allocation transfer, 16-item refresh-before-purge and owned-ASR cohorts, OAuth 12-ref/8+4 headroom with external-only capacity UX, exact binding root/peer seal, deactivation no-new-use, active-marker drain, all live/dead/expired/receipt arms, wake/schedule swaps, late/cross-binding rejection, fence/finalize crash and restrictive-FK order; `test_transcript_forecast_admission.py`, `test_transcription_accounting.py`, `test_transcription_dispatch_uncertainty.py`, exact-byte input preparation/retry/cancel, official-caption OAuth authorization, and supplemental-isolation cases |
| 11 | F transcript-follow canonical row, including independent active/focus cursor and full-ceiling performance |
| 12 | F transcript-follow timestamp/text-selection cases |
| 13 | F temporal-Highlight canonical row + player position-read failure/replay cases |
| 14 | F temporal-Highlight + transcript-follow selection/paint/replacement cases |
| 15 | G browser + ledger rows, including parked/hidden/MFK and historical-generation delivery |
| 16 | D responsive-accessibility + D strict-untracked-host-profile + F transcript-follow + D Android device rows AND the complete exact-SHA manual AT matrix |
| 17 | A migration catalog oracle (including exact timestamp-column and FK/index inventory), H job-definition-registry including mandatory lane policy/per-lane watchdog topology, J claim-fence and K2 account-erasure-closure canonical rows, H0 residue/static owners, strict decoder/type checks, journey-count oracle, and postdeploy SQL residue oracle |
| 18 | K3 pre-mutation-release-gate + B video-copy-compliance-deadline canonical rows plus `./scripts/test release` exact-SHA receipt, signed Android/device artifact, compliance/OAuth-production-readiness artifacts, non-production destructive R2 proof, signed bounded `PROVIDER_TERMINAL_PATH_MAX_SECONDS`, signed `PROVIDER_MIN_DISPOSITION_NOTICE_SECONDS`, derived effective-cap/current-cohort feasibility, and provider-supported terminal-path/write fence covering response-lost server mutations and issued/in-flight presigned PUTs, authorized fully-paginated zero-upload production R2 preflight, exact five-process lane/watchdog topology, durable maintenance/DataMutationStarted crash-resume proof, and exact production postdeploy receipts; this criterion cannot PASS in PR CI and remains `BLOCKED` while approval, minimum notice, or terminal fence is unavailable |

## Explicit tradeoffs

- Immutable Timeline generations, content rows, and lifecycle-specific rows
  add joins and migration work; they make Discard, removal, audit, and repair
  representable without mutating history or nullable state clusters.
- `Cache-Control: private, no-store` sacrifices browser range-cache efficiency.
  Tickets last up to 8h15m to cover 0.5x uninterrupted playback, increasing the
  bounded bearer window while the object exists; verified deletion and no-store
  are preferred to repeated disruptive source swaps. Clients retire them one
  full measured RTT plus 60 seconds early; this slightly shortens effective
  playback and can require a fresh ticket/tap after recovery, but avoids wall-
  clock skew or suspended timers extending origin authority. Already delivered bytes
  remain outside server revocation.
- The 12.5 GiB attempt cap, 15 GiB preflight, and single-capacity
  `worker-media` lane cost disk and a service process; they prevent arithmetic
  overcommit and keep copy/ASR from starving interactive/background work.
- Podcast input verification may use a 4.5 GiB private reservation and up to a
  13,200-second fetch before its separately bounded probe/cleanup. Exact bytes,
  SSRF resistance, and honest duration are preferred to an instant URL-based
  estimate or provider-side fetch.
- Google's documented player API requires a narrowly allowed third-party
  script and therefore a larger CSP/privacy surface. Raw private messaging
  would avoid that script but is undocumented and rejected. YouTube pauses
  when hidden, trading cross-pane audio continuity for playback-policy
  compliance; only non-YouTube-origin owned video retains audio-only parking.
- Durable YouTube acquisition remains blocked until written provider approval
  covers both storage and the exact adapter. Official caption download requires
  OAuth edit permission, so most arbitrary public-video captions are
  intentionally unavailable; Nexus falls back only to an authorized kept copy
  plus hosted ASR, never scraping.
- Provider-derived YouTube title, description, artwork, channel, and language
  decoration are removed. Unnamed items deliberately render **YouTube video**
  until the user supplies a Nexus title, and ambiguous legacy titles require a
  one-time reviewed cutover manifest rather than being laundered into authorship.
- MFK embeds remain playable through provider controls but disable Nexus time,
  history, Activity, transcript-follow, Highlight, and analytics collection.
  This materially reduces product capability to satisfy the no-tracking rule.
- Every untracked YouTube-origin owned copy likewise uses user-agent controls
  with no Nexus timeline chrome, captions, resume, rate, seek, temporal actions,
  or natural-end advance. Uniform chrome is deliberately sacrificed because
  ephemeral time sampling would still be observation. If the separately audited
  no-JS external embed profile or native owned-video profile is not certified
  for the exact release, that source is unavailable rather than silently using
  tracked controls. Because untracked mode persists no position, an observed
  source loss, engine destruction, or reopen may restart playback from the
  provider/user-agent default; preserving resume would require the forbidden
  observation. The state-blind ticket deadline also destroys a long-paused
  untracked owned session and requires explicit reopen rather than inspecting
  media state or silently renewing it.
- Observation authorization is host-neutral. Nexus gives up server-side
  Browser/Android differentiation rather than signing a spoofable host claim or
  adding an unapproved seventh native trust boundary. Exact host capability is
  release-certified locally, so a browser/WebView/OS upgrade can temporarily
  disable in-app untracked playback until that exact version is recertified.
  Android Media Integrity remains separately device-proved only for external
  YouTube iframe origins; owned R2 bytes use their independent trust chain.
- Every Android WebView media activation remains gesture-required. A rebuilt
  document, source/profile handoff, or expired strict ticket may therefore add
  one explicit tap instead of seamless auto-resume; the uniform secure default
  and truthful user intent are preferred to a primary-host autoplay exception.
- OAuth in Android uses the same authenticated Custom Tab browser flow as
  desktop. A Nexus re-login and explicit **Return to Nexus** tap are accepted in
  exchange for no state-only callback, cookie transfer, or native token path;
  an awaiting attempt has no pretend Cancel action and expires after ten
  minutes, while post-callback finalization is shown as a distinct phase.
- If provider revocation cannot be confirmed, automated reconnect remains
  blocked until the user revokes Nexus in Google account security and explicitly
  attests that action. This manual recovery burden is preferred to silently
  accumulating an untracked remote grant; Nexus still cannot claim provider-
  verified revocation.
- OAuth secret material stays in typed application-AEAD Postgres rows instead
  of adding an external secret store. This keeps one durable owner but means
  encrypted WAL/backups and decrypt-only KEKs must remain inside the expressly
  approved backup horizon; absent that approval, release is blocked rather
  than claiming live-row deletion erased backups.
- Toasts, sheets, dialogs, popovers, and other higher-layer occluders can pause
  or destroy YouTube playback. Nonmodal feedback is placed outside player
  geometry whenever space permits; truthful visibility compliance is preferred
  to uninterrupted playback beneath Nexus UI.
- Android YouTube fullscreen and WebView Media Session are omitted in v1;
  `fs=0`/Unsupported avoids an unreachable or conflicting host experience.
- Deepgram exposes no caller idempotency/cancel contract. An ambiguous dispatch
  therefore suspends, conservatively commits the maximum, and needs operator
  resolution; this is more expensive and less automatic than risking duplicate
  billing/submission.
- Composite checksum is preferred. A deployment that selects full streamed
  readback spends an extra object-sized read and needs a larger proven wall/
  transfer envelope in exchange for equal integrity without unsupported
  provider headers.
- A response-lost Create/Complete or issued presigned PUT is never declared
  terminal from elapsed time, Abort, LIST omission, or `HEAD NotFound`. Without
  a provider-supported terminal path/write fence, the copy release remains
  blocked and an ambiguity may stay durably unresolved; that operator burden is
  preferred to a late object appearing after Nexus reported deletion.
- Fail-closed provider identity/transcript migration may stop a release for
  operator repair. Silent partial-to-ready promotion or duplicate Media is
  worse.
- Activity history is retained across reset/discard; old-epoch positions stop
  contributing while elapsed activity remains. This preserves observed fact
  history at the cost of more epoch-aware queries.
- Walknotes Capture creates a time anchor even when transcript text exists.
  This forgoes an automatic quote but avoids inventing a user selection.
- Unexpected dead work remains `Suspended` for same-operation repair instead
  of becoming a convenient Retry. The operator burden preserves crash evidence
  and ownership.
- Restricted owned-video ASR is unavailable during the full four-hour worker,
  termination, removal, storage cleanup, provider-terminal-path, settlement,
  scan, and recovery margin before a provider deletion deadline. This can
  unpublish substantially earlier and sacrifices near-expiry transcription to
  make timely purge executable; an unbounded provider terminal path blocks the
  release instead of shrinking that margin.
- Account erasure adds sealed logical-target coverage and physical-disposition
  joins. The extra planning cost prevents OAuth/Media/user-FK overlap from
  invoking two deletion owners or fabricating closure.
- V1 has no byte/storage-spend quota and no automatic product retention policy,
  so absent user removal or provider invalidation, storage cost remains
  unbounded for this one user. It does have a strict compliance-capacity
  ceiling: at most 32 active video reservations/copies, further reduced by the
  signed minimum-disposition notice and two dedicated video slots. Caption and
  owned-ASR each reserve one lane and cap their reservation/publication cohort
  at 16; OAuth reserves one lane, permits eight external roots, and holds four
  successor slots. Five dedicated compliance processes, early unpublication,
  and sometimes rejecting Keep/Connect/transcription reduce availability and
  cost host capacity, but make the promised deletion windows executable. A
  24-hour notice generally yields far fewer than 32 video copies; claiming the
  higher number without the roughly 16-wave notice is rejected.

## Acceptance criteria

This specification-only PR satisfies none of these criteria by itself. Until
the implementation candidate and named governed evidence exist at one exact
SHA, every item below is `NOT_RUN`.

1. Two concurrent Keep commands for one YouTube identity converge to one Media,
   one active attempt and the exact typed counts `AcquireVideoCopy producer=1`,
   applicable `ReconcileVideoCopy coordinator=1` for every accepted attempt,
   and `Reserved StorageObjectCleanup=N materialized storage runs/objects`
   (zero before reservation, one per materialized object). Coordinator and
   reserved cleanup are excluded from the producer count, and concurrent Keep
   creates no duplicate in any class. Queued/running Cancel converges without bytes
   or a live lease. Classified terminal outcomes are never automatically
   retried; bounded crash/lease replay may rerun only the same domain attempt.
2. First Keep rejects Tier-1 pre-copy timed facts with `TimelineUnproven`;
   Tier-2 derived facts are reset only behind the acknowledged dialog;
   accepted work reserves/bumps Timeline, and every direct timed writer fails
   the shared epoch fence until publication/cancel/failure. **Discard saved
   timeline** deletes exactly the current-generation content-bound timed facts,
   publishes a fresh unbound generation, preserves Media/Library/Lectern/note
   prose/Media links/Activity time (detaching edges owned only by deleted
   Highlights), and restores structural Keep availability. It is rejected from
   Kept, Removing, RemovalFailed, RemovalSuspended, or any suspended/nonterminal
   content writer until Remove/settlement/operator repair proves safety.
3. No state says `Kept` before timeline conformance, local hash,
   selected-mode integrity verification, exact object `HEAD` headers, and lease-fenced DB publication
   that rechecks the binding and installs immutable Timeline identity plus
   the probed duration as the single authority.
4. Killing the worker at every external/DB boundary — including between the
   publication commit and the queue success transition — converges to one
   live asset or no object; exact-key multipart discovery/allocation abort or
   adoption converges, reservations finalize, every committed crash point is
   exercised, and stale work never publishes.
5. After the original returns a definitive unavailable result, reload selects
   the kept copy from private R2 without an external fallback. With current
   exact non-MFK policy proof and timed-observation approval, the tracked-owned
   arm seeks to the last authorized saved position. When provider policy is
   unprovable after disappearance, the certified strict-untracked-owned arm
   remains durably playable but deliberately has no Nexus seek/resume/history;
   the proof exercises both arms and an uncertified host's truthful unavailable
   result.
6. An unbound first-copy failure restores external playback. Kept-copy failure
   and bound-copy removal never silently open the original inside Nexus;
   Previous after a Remove presents `KeptCopyRemoved` + **Open source**, and
   natural end skips a mid-binding or unavailable successor.
7. Remove unpublishes first, stops new tickets, clears observing media sources,
   and remains `Removing` until durable verified object absence; it makes no
   false shared-queue time bound or already-buffered-byte claim. It preserves
   Media, current Timeline, transcript, progress, Highlights, notes, and
   relationships. Immutable removal/cleanup-attempt history retains every generation; Nexus
   stays unplayable until identical Re-Keep within that generation, and
   non-identical bytes cannot bind old state. Discard can start a fresh
   generation; whole-Media delete then Add-then-Keep yields generation zero
   with no residual object/allocation.
8. Podcast and video expose exactly one `Media player` landmark, one session,
   and one authoritative source-time timeline across pane navigation; the
   canvas clips at its pane's scroll boundary and never paints over the pane
   header, strip, or a neighbouring pane; an ingest admitted while a copy
   runs still completes within its normal envelope. Ordinary or currently
   tracked OwnedVideo wrapper
   fullscreen retains Nexus chrome; browser YouTube fullscreen remains
   provider-owned, plays only while visibly compliant, and never becomes hidden
   audio. Android YouTube fullscreen is Unsupported. MFK/policy status is
   checked before every YouTube-provenance activation and an untracked player
   produces no Nexus tracking facts or Nexus time controls.
9. A confirmed video rate change persists; an unconfirmed or unavailable rate
   is never shown as active and never fails the session; a discrete-rate
   engine offers only rates it can apply and every offered rate takes
   effect; `Shorten pauses` is absent for unsupported engines and still works
   for supported Android Podcast audio.
10. Transcription starts only after an exact Timeline/forecast-handle
   worst-case-cost confirmation that is recomputed under locks, survives
   reload, uses officially authorized captions through the production-ready
   session-and-cookie-bound OAuth lifecycle before hosted ASR, and does not
   offer Podcast hosted ASR until the SSRF-safe input-preparation worker has
   bound duration and hash to the exact bytes. It renders orthogonal
   publication/operation state, and atomically publishes timed current content.
   Replacement queued/running/failed/cancelled work leaves prior publication
   readable; exact cancellation settles only proven unused reservation and an
   ambiguous non-idempotent provider dispatch never resubmits. A supplemental
   attempt produces no Activity row, no
   needs-attention count, and never mutates Media processing state; Open
   source, source Retry/Refresh, and an existing public share all survive a
   completed Keep.
11. The active cue advances from playback without focus movement. Manual
    scroll/selection detaches follow; Return reattaches without seeking;
    Find-in-transcript and existing highlight/evidence markers work over the
    one-list view.
12. Timestamp buttons seek; transcript text remains selectable and never seeks.
13. Moment Highlight is single-flight/idempotent, immediately readable,
    linkable, and deletable by its author, works without a transcript, and
    survives reload/copy removal/original loss. When a conforming source is
    playable it opens at its saved source time; **Open source** carries `&t=`
    only while the Timeline is unbound.
14. One-cue transcript selection uses the existing popup and a durable
    `transcript_time_text` quote/time anchor; transcript replacement never
    deletes or silently retimes authored Highlights, and no Highlight is ever
    painted in a cue inconsistent with its stored time.
15. Video activity requires actual playing-engine evidence and source
    positions; parked non-YouTube-origin owned playback records `Listening`,
    never `Viewing`;
    YouTube pauses on hide/noncompliant visibility; MFK YouTube records no
    Nexus time/history/activity at all; hidden document and pane
    dwell alone record nothing. Thirty minutes of hidden-tab non-YouTube-origin
    **OwnedVideo** playback still persists the true resume position; no such background-play
    claim is made for YouTube.
16. Keyboard, screen reader, forced colors, reduced motion, 400% zoom, 320 px
    width, safe areas, and 44 px frequent mobile targets pass on real
   surfaces; captions render on non-YouTube-origin owned video, and on a
   currently `Tracked` YouTube-origin owned session, when a publication exists
   and the user enables them, including wrapper fullscreen. An untracked
   YouTube-origin session has no Nexus captions. Exact-version strict profiles
   additionally prove explicit gesture, state-blind ticket expiry, actual
   native-control/PiP/remote/download/fullscreen/MediaSession absence, local
   unsupported-host fail-stop, and tracked↔untracked rebuild. On Android: video plays with the native service
    dismissed and it never auto-resumes on video pause; a backgrounded
    podcast session at natural end never starts a video; an active WebView
    video session survives rotation, fold/multiwindow, theme, font-scale, and
    density changes; exact Referer/Media Integrity identity on both external
    iframe origins produces no error 153, while owned R2 playback proves no
    Media Integrity dependency.
17. Residue is mechanized by the owning layer: retired resource-action symbols
    only land in `RETIRED_RESOURCE_ACTION_RESIDUE`; typed protocol/player
    tokens land in strict decoder/ESLint policy; retired Python modules/routes
    land in `nexus_test_control/policy.py`; DB/catalog/job rows land in the
    migration and postdeploy SQL oracle. Zero old job-kind rows is
    asserted by the A proof and post-deploy smoke;
    `testdata/proofs.json#journeys` still holds exactly 15 entries with
    `podcast-refresh-playback` absent; single-owner, fence, unreserved-write,
    and exhaustive-anchor properties are asserted behaviorally by the
    canonical proofs and type checking. The migration oracle separately proves
    the transcript supplemental-attempt join has zero running
    `ingest_media_source` rows before its rewrite while primary-ingest rows of
    that shared kind remain untouched. Searches also cover: raw wire UUIDs,
    supplemental primary-progress leaks, unfiltered latest-attempt lookups,
    the old two-value terminal-status shorthand, `transcript_origin`,
    `can_play`, deleted lifecycle state keys, inline restatements of owned
    copy strings, private DB UUIDs in signed object paths, and direct
    `httpx`/`requests` or unrestricted subprocess egress in transcript/copy
    lanes.
18. Release evidence proves destructive non-production multipart/integrity
    behavior and separately proves the authorized read-only production bucket/
    lifecycle/capability digest, exact signed Android artifact, compliance
    approval artifact, and maintenance gate. Pre-`DataMutationStarted` rollback
    and at/post-`DataMutationStarted` `ForwardFixRequired` behavior survive controller death;
    postdeploy exact-version/schema/route/device smoke passes before maintenance
    is lifted. Human legal/policy approval remains separately required and is
    never inferred from the rights checkbox.

## Final state

Nexus owns one durable, immutable representation of an authorized video and can
play it after the original disappears; timed resume remains available only
while current observation authorization proves it, otherwise playback uses the
strict untracked profile from the start. Podcast and video are projections of one
timed-media substrate: one current Timeline generation, state, session, chrome, transcript
publication, Highlight system, and activity truth. Provider instability stays
behind durable jobs; storage truth stays behind verified DB publication; UI
claims only what those facts prove. Everything beyond this narrow cut has a
clean capability seam and no speculative implementation.
