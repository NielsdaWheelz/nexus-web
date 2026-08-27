# Durable video copy and timed-media hard cutover

**Status:** Approved implementation specification · rev 2 (council-revised)
· 2026-08-26

**Type:** One-release hard cutover. No flag, alias, dual write, permissive
decoder, compatibility view, legacy route, or playback fallback survives.

## Decision

Nexus will let an authorized user **Keep a copy** of a regular public YouTube
VOD as one immutable, seekable H.264/AAC MP4 in private R2. Podcast episodes and
videos will then use one timed-media session, one playback-state contract, one
player shell, one current-transcript owner, and one Highlight aggregate.

This is the 80/20 cut:

- one source identity, timeline, account-held copy, and playback rendition;
- explicit copy and transcription commands only;
- segment-timed transcripts, soft follow, moment highlights, and one-cue text
  highlights;
- existing Postgres queue/Heavy lease, R2, media SSE, Consumption, player,
  transcript, Highlight, selection, feedback, and resource-action primitives;
- browser `<video>` for owned video, the existing allowlisted YouTube embed
  iframe driven over its `postMessage` protocol (`enablejsapi=1`; no
  third-party script) for reference playback, and the existing native Android
  audio engine for podcasts.

No question blocks implementation. Assumptions are: the user keeps only media
they own or may lawfully copy; v1 supports non-DRM, non-live, non-playlist,
public YouTube VODs; production remains Nexus Postgres + the existing background
worker + private R2; and video on Android is foreground WebView playback, not a
new Media3 video service.

Follow `docs/rules/*`, `docs/local-rules/*`, especially
`testing-standards.md`, and the owner contracts in `docs/modules/{video,player,
podcast,highlight,storage,consumption-activity}.md`.

## Goals and rules

- `Copy kept` means verified owned bytes that the canonical player can seek.
- The original URL is provenance and an explicit **Open source** action. It is
  never a silent recovery path for a broken kept copy.
- Media readiness, copy state, transcript state, progress, Highlights, notes,
  and Library/Lectern membership are independent.
- Media time always means original-source milliseconds. Speed, buffering, and
  pause shortening never transform stored time.
- One `MediaTimeline` owns playback, progress, transcript cues, chapters,
  activity positions, and temporal Highlights for one Media.
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
- One global lock order. Every transaction that composes queue and domain locks
  takes the queue row first — the exact running claim or the target job — then
  Media -> Timeline -> attempt -> viewer -> domain row.
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
  (inspection means the per-item `Kept { verifiedAt, sizeBytes }` projection
  only);
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
`verifiedAt` renders as a relative date. The one **Kept** detail sentence is
**Copy kept {relative date} · {size}.** Ellipsis discipline: openers that lead
to a dialog take `…`; status text does not.

Announcements: intermediate copy and transcript states (`Queued`, `Keeping`,
stages, `Cancelling`, `Removing`) update the projection silently and are never
announced. Exactly one terminal outcome per command (**Copy kept**, **Copy
cancelled**, **Couldn’t keep a copy**, **Couldn’t finish removing the copy**,
transcript ready/failed) emits one Polite Feedback notice through the existing
owner; Assertive is reserved for a failure the user must act on. The player's
single live region is never reused for copy lifecycle.

| Feature / content owner | Required content | “Good” means |
| --- | --- | --- |
| Copy designer | **Keep a copy…**, **Copy queued**, **Keeping copy…**, stage lines Resolve **Finding the video…**, Download **Downloading…**, Package **Preparing the file…**, Probe **Checking the file…**, Upload **Saving to Nexus…**, Verify **Verifying the upload…**, Finalize **Finishing…**, **Cancel**, **Cancelling…**, **Copy cancelled**, **Copy kept**, **Couldn’t keep a copy**, conditional **Retry**, **Remove copy**, **Removing copy…**, **Couldn’t finish removing the copy**, **Retry removal**, blocked lines **This item is being removed from Nexus.** and **A copy is already in progress.** | Keep is positioned as “in Nexus” while device downloads stay “on this device”; the Offline action remains absent for video so the two never co-occur. Bytes render only as “{done} of {total}” scoped to the named stage, never an overall percentage or a resetting bar; safe specific failure and only truthful recovery; success only after seekable publication. **Cancelling…** may persist until the running step notices and carries no action by design. |
| Player designer | **Media player**, **Play/Pause**, **Back 15 seconds**, **Forward 30 seconds**, **Playback speed**, **Highlight** (accessible name **Highlight this moment**), **Capture** (accessible name **Record a voice note here**), **Open video**, **Open source**, **Audio only — open the video to watch** | One vocabulary and landmark for podcasts/videos; changing time is not live-announced; unsupported controls are absent. For a video the speed control shows only the value — no podcast-inheritance scope line, no **Remember {rate}**, and none of their announcements. Only one of **Highlight**/**Capture** occupies the primary chrome slot on the 320 px MiniPlayer; the other lives in the overflow. **Open source** carries the saved source position (`&t=`) while the Timeline is unbound, and opens the plain watch URL once the Timeline carries owned identity or a removal row — Nexus can no longer prove the provider timeline matches. List/menu verbs are kind-aware: **Watch** for video, **Listen** for audio; **Play**/**Play next** apply to canonical timed video. |
| Transcript designer | **Transcribe…**, **Transcription queued**, **Transcribing…**, **Open transcript**, **Couldn’t transcribe this item**, **Retry transcription**, **Play from {time}**, **Return to {time}**, cross-cue line **Select within one transcript segment to highlight.**, pre-copy warning **Transcribing first means Nexus can’t keep a copy of this video later.** | Cues are readable prose with a separate timestamp control; provenance renders as three distinct quiet strings — publisher-authored, third-party machine, Nexus machine — so `Generated` never implies Nexus billing; no word-level implication or cue-by-cue announcement. **Play from {time}** is the single label for every timestamp affordance on a timed-media pane, including show-notes timestamps, and all share one seek-and-resume behavior. |
| Highlight designer | **Highlight this moment**, marker label **Highlight at {time}** / **Highlight from {start} to {end}**, **Couldn’t highlight this moment**, **Highlight needs review**, existing color/note actions | A moment is source time; a passage is exact/prefix/suffix text in one timed cue; Highlight and Walknotes Capture remain distinct (Highlight saves a time marker you can find later; Capture records a Walknote). A quoteless `media_time` Highlight presents as **{title} at {time}** everywhere a quote would otherwise appear — quick-note composer, Vault row, Evidence marker, chat citation, export — and is excluded from text search rather than indexed as an empty string. |
| Activity designer | Existing Viewing/Listening language | Video time comes from a playing engine, never pane dwell; parked playback records Listening, never Viewing; no state is promoted to an attention badge unless the user can act. |

Copy state is exhaustive, projected from queue-owned classifications (never
“due” timestamps):

| State | Source of truth | Action |
| --- | --- | --- |
| `Unsupported` | ineligible kind/provider/permission | omit copy UI |
| `NotKept { keep: Keepable }` | none of ready asset, active attempt, latest failure, active removal | **Keep a copy…** |
| `NotKept { keep: Blocked { reason } }` | typed block (see `VideoCopyBlockReason`) | reason-specific recovery; no Keep |
| `Queued` | exact accepted attempt + nonterminal job without a live lease (pending, failed-awaiting-retry, or running-with-expired-lease) | Cancel |
| `Keeping` | exact live lease; optional real stage/bytes | Cancel |
| `Cancelling` | exact cancellation request + nonterminal job | none |
| `Kept` | current verified asset row | Remove copy |
| `Failed` | latest terminal attempt failure and no asset — including wall-timeout/OOM resource limits and the dead-letter transition, each with its typed code | Retry when the failure is `Retryable`; otherwise Open source |
| `Removing` | latest removal row with `completed_at IS NULL` and no terminal failure marker | none |
| `RemovalFailed` | latest removal row with `completed_at IS NULL` and the terminal failure marker set | Retry removal (`DELETE` replay, see endpoints) |

Failure is typed as a closed discriminated union — retryability is the
discriminator, never a boolean:

```text
VideoCopyFailure =
  Retryable { kind: Network | Storage | Interrupted }
  | Permanent { kind: ProfileUnavailable | TooLong | TooLarge
                | SourceIneligible | TimelineUnsupported | TimelineChanged }
RemovalFailure = Retryable { kind: Storage | Interrupted }
```

Each member has exactly one approved sentence: `Retryable` -> **Couldn’t keep
a copy** + Retry; `ProfileUnavailable` -> **This video isn’t available in a
format Nexus can keep** + Open source; `TooLong` -> **This video is longer
than Nexus’s supported length** + Open source; `TooLarge` -> **This video is
too large to keep** + Open source; `SourceIneligible` (live, playlist,
private/member/age-gated, login required — adapter-classified, never folded
into `ProfileUnavailable`) -> **Nexus can only keep regular public videos** +
Open source; `TimelineUnsupported` -> **This video’s timing can’t be
verified, so Nexus can’t keep it** + Open source; `TimelineChanged` -> **The
original no longer matches this item’s saved timeline** + Open source;
removal failure -> **Couldn’t finish removing the copy** + Retry removal.
The projection maps `media_source_attempts.error_code` into this union
through the error-code table; an unrecognized durable code projects as
`Permanent` with the generic copy. `media_source_attempts.error_message` and
`background_jobs.last_error` are operator diagnostics no projection may read;
raw provider, subprocess, path, or object-store text never renders
(residue-gated).

Both copy dialogs render through the one canonical confirmation renderer:
`ResourceOperation.Media.VideoCopy` joins the catalog in the Consume group
(explicit order and tone, per-state presentations mirroring
`ResourceOperation.Media.Offline`) and `ResourceOperation.Media.VideoCopyRemove`
joins the Danger group. `ResourceActionConfirmation.Required` gains two
owned-absence fields — `addendum: Presence<string>` and
`acknowledgement: Presence<{ label }>` that gates the confirm button —
implemented once so Remove-copy and every future attested action reuse them.
No surface renders its own Keep or Remove-copy dialog.

The opener is **Keep a copy…**. Its dialog is:

- title: **Keep a copy?**
- body: **Save a durable playable copy in Nexus in case the original changes
  or disappears.**
- first-copy addendum: **Playback, transcription, and highlighting pause while
  Nexus keeps the copy, and resume as soon as it finishes, fails, or you
  cancel. Keeping runs in the background and can take a while for long
  videos.**
- progress-reset addendum, shown exactly when unproven derived facts exist
  (see the two-tier rule below): **Nexus can’t prove your saved position
  matches the copy it will make, so keeping will reset this item to the
  start. Your transcript, highlights, and notes are untouched.** with its own
  required acknowledgement checkbox.
- required checkbox: **I confirm I have the right to keep this copy.**
- actions: **Keep a copy**, **Cancel**; Keep is disabled until checked.

The tick is the attestation act; the command stores
`rightsBasis: UserAttestedAuthorized`, and the attempt actor and creation time
are its record. Do not build a legal taxonomy.

Remove always requires confirmation because Nexus does not maintain a second
remote-source health state:

- title: **Remove kept copy?**
- body: **Nexus will delete its playable copy. This item will stop playing in
  Nexus — keeping it again only works if the source still serves
  byte-identical video, which usually isn’t the case. You can still open the
  source.**
- actions: **Remove copy**, **Cancel**.

Removal preserves Media, timeline, transcript, Highlights, notes, progress, and
Library/Lectern relationships. Whole-Media deletion retains its existing,
separate destructive semantics.

The removal ledger is append-only, one immutable row per removed asset —
identity fields never rewritten, projection reads only the latest row for the
Media. Re-Keep is allowed after cleanup, but publication must reproduce the
latest removal row's exact SHA, profile, and pipeline and the Timeline owned
identity; the exact-SHA rule guarantees the identity fields are equal across
cycles. The probe stage additionally gates the new probe's duration against
`media_timelines.duration_ms` within 1,000 ms and fails
`E_MEDIA_TIMELINE_CHANGED` before download/upload cost — the removal row
stores no duration by design, and SHA equality already implies byte-identical
duration at publication. State this plainly: a provider re-encode or a
`pipeline_version` bump makes re-Keep permanently unavailable for that item;
the recovery is **Discard saved timeline** (below) or whole-Media Remove +
Add. A mismatch projects `Permanent { TimelineChanged }` and is not
retryable.

First-copy identity is fail-closed, in two tiers.

Tier 1 — authored, irreplaceable facts: a transcript publication, chapters,
temporal Highlights, or nonterminal transcript work. These block Keep:
`NotKept { keep: Blocked { reason: TimelineUnproven } }`, and the command
fails `E_MEDIA_TIMELINE_UNPROVEN`. Show title **This video can’t be kept
safely** and body **Nexus can’t verify that a copy made now matches the
version you already played, transcribed, or highlighted. To keep a copy,
discard this item’s saved timeline first, then keep the copy before using
it.** Actions are **Discard saved timeline…** and **Open source**; there is
no Retry.

Tier 2 — derived, regenerable facts: nondefault playback position, rate
memory beyond default, completion, and positioned Activity spans. These do
not block; the Keep dialog shows the progress-reset addendum above, and on
admission the Timeline gateway performs the existing Reset-progress
transition (advance `reset_epoch`, zero position and completion) and deletes
the Timeline's positioned Activity spans inside the binding transaction —
unproven derived state is discarded, never rebound. A default position/rate
row alone triggers nothing. When both tiers are present, Tier 1 wins.

**Discard saved timeline** is one explicit, confirmed command owned by the
Timeline owner: title **Discard this item’s saved timeline?**, body naming
exactly what is deleted (saved position and completion, transcript with its
segments and cues, chapters, time-anchored highlights, timed activity) and
what is kept (the item, its Library and Lectern placement, notes, links),
confirm **Discard timeline**. It deletes exactly the content-bound timed
facts, increments `binding_epoch`, and leaves Media, Library, Lectern, notes,
and links intact. It is the recovery action in both fail-closed dialogs.
**Remove from Nexus** remains the ordinary danger action, never the
copy-feature workaround.

Admitting a clean first copy stores its exact attempt as the Timeline binding
reservation and increments `binding_epoch`. While reserved, Nexus pauses any
stale external session, projects playback as unavailable, and rejects direct
timed commands (playback-state PUT, transcript and chapter publication, both
temporal Highlight commands) with the typed binding error; positioned
Activity delivery is accepted with its epoch recorded (observations are
facts, not commands — see Observed activity). Copy failure/cancellation
clears only its own reservation; successful publication installs immutable
owned identity. Every exact terminal resolution increments the epoch again,
so a handle observed during binding is also stale. Re-Keep admission stores
no binding reservation and never bumps `binding_epoch` — the bytes are
identical and existing handles stay valid; its payload `bindingEpoch` is only
a sanity fence against whole-Media re-creation. This intentionally prevents
new timed facts from racing a two-hour acquisition.

## Final architecture

```text
YouTube Media + explicit Keep
  -> media_source_attempt(youtube_video_copy) + acquire_video_copy
     (dedicated worker-copy lane, VideoCopy capacity)
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
| object path and lifecycle | `storage/paths.py::build_video_copy_storage_path` + cleanup/teardown owners |
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

Conventions (per `docs/rules/database.md`): every new foreign key uses the
default non-cascading delete — cleanup is explicit in `media_deletion.py`; do
not copy the legacy `ondelete='CASCADE'` examples. Every new durable entity
table declares `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`; mutable-state
tables (`media_timelines`, `media_video_copy_removals`) also declare
`updated_at TIMESTAMPTZ NOT NULL`. All unmarked columns are `NOT NULL`. No new
`CHECK` constraint, trigger, or business-state index is created. Every
timed-media millisecond wire field uses the non-negative int64 bound already
used by `consumption_activity`, never `_NonNegInt32`.

```text
media_timelines
  id UUID PK
  media_id UUID UNIQUE FK media
  UNIQUE(id, media_id)
  duration_ms BIGINT nullable
  binding_epoch BIGINT
  binding_copy_attempt_id UUID nullable
  owned_sha256 TEXT nullable
  owned_profile TEXT nullable
  owned_pipeline_version TEXT nullable
  FK(binding_copy_attempt_id, media_id) -> media_source_attempts(id, media_id)

media_video_assets
  id UUID PK
  media_id UUID UNIQUE FK media
  timeline_id UUID
  source_attempt_id UUID UNIQUE
  source_run_count INTEGER
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
  FK(source_attempt_id, media_id) -> media_source_attempts(id, media_id)
  storage_path TEXT UNIQUE
  profile TEXT                         # CompatibleMp4V1
  pipeline_version TEXT
  content_type TEXT                    # exactly video/mp4 in v1
  size_bytes BIGINT
  sha256 TEXT                          # lowercase hex
  duration_ms BIGINT                   # conformance input; wire reads Timeline
  width INTEGER
  height INTEGER
  video_codec TEXT                     # h264
  audio_codec TEXT                     # aac
  source_to_presentation_offset_ms BIGINT  # exactly 0 in v1
  max_av_skew_ms BIGINT                # |first audio - first video| after edits
  verified_at TIMESTAMPTZ

media_video_copy_removals                 # append-only removal ledger
  id UUID PK                              # stable domain removal identity
  media_id UUID FK media
  UNIQUE(media_id, removed_asset_id)
  timeline_id UUID
  removed_asset_id UUID                  # immutable provenance; no FK
  removed_sha256 TEXT
  profile TEXT
  pipeline_version TEXT
  storage_path TEXT UNIQUE
  requested_at TIMESTAMPTZ
  completed_at TIMESTAMPTZ nullable
  last_error_code TEXT nullable
  FK(timeline_id, media_id) -> media_timelines(id, media_id)

media_transcript_publications             # exactly the current publication
  id UUID PK
  media_id UUID UNIQUE FK media
  timeline_id UUID
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
  UNIQUE(id, media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)

highlight_media_time_anchors
  highlight_id UUID PK
  media_id UUID
  timeline_id UUID
  position_ms BIGINT
  FK(highlight_id, media_id) -> highlights(id, anchor_media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)

highlight_transcript_time_anchors
  highlight_id UUID PK
  media_id UUID
  timeline_id UUID
  authored_publication_id UUID             # provenance; no FK by design
  t_start_ms BIGINT
  t_end_ms BIGINT
  fragment_id UUID nullable                # disposable current locator; no FK
  start_offset INTEGER nullable
  end_offset INTEGER nullable
  FK(highlight_id, media_id) -> highlights(id, anchor_media_id)
  FK(timeline_id, media_id) -> media_timelines(id, media_id)
```

`media_video_assets` publication is row existence. Unpublication is `DELETE`
of the exact asset row inside the removal transaction — no status, generation,
or `unpublished_at` column, and no soft-deleted asset row may exist.
`Removing`/`RemovalFailed`/`KeptCopyRemoved` derive from the latest removal
row (`completed_at`/`last_error_code`) plus the matching cleanup job; durable
proof of removed bytes lives only in the removal ledger and the immutable
Timeline owned identity.

Application owners enforce positive sizes/durations/dimensions, valid hashes,
the v1 codec/profile, time within the known timeline, and same-Media foreign
facts. Metadata-derived podcast Timeline duration is advisory and never a
write bound: the "time within the known timeline" rule applies only to
durations installed by the trusted probe on a verified owned asset; podcast
writers validate only non-negative, sanely bounded positions, and migration
never rejects or truncates an existing playback-state position that exceeds
episode metadata duration. Timeline owned identity fields are all absent or
all present and immutable; asset/removal identity must match them. Activity
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
  heartbeat client updated in the same release. Preserve position, rate,
  completion exactly; drop `duration_ms` (the Timeline is the sole duration
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
  not engine evidence: the migration DELETES them, plus any
  `consumption_completion_facts` row they alone justified, recording both
  counts in the migration proof — dwell is no longer activity truth.
  `timeline_id`/`binding_epoch` join the capture-key semantic identity tuple
  (`_activity_store._CAPTURE_SEMANTIC_FIELDS` and its existing-row SELECT); a
  capture key replayed with different Timeline facts is
  `E_ACTIVITY_CAPTURE_CONFLICT`, never a silent dedupe. The consumption-state
  discriminator widens to canonical timed-media kind
  (`_projection._AUDIO_READ_STATE_KINDS`, the completion branch in
  `consumption/service.py`), so video records first-completion facts with
  modality `Viewing` via `_policy.completion_modality_for_kind`; parked
  audio-only video playback records `Listening` (see Observed activity), so a
  Viewing completion with zero Viewing time cannot occur.
- `podcast_transcript_segments` -> `media_transcript_segments` and
  `PodcastTranscriptSegment` -> `MediaTranscriptSegment`. Segment rows
  reference `(publication_id, media_id)` with `publication_id NOT NULL` by
  design — segments are publication-scoped derived content. The rename drops
  `uq_podcast_transcript_segments_media_idx`,
  `ck_podcast_transcript_segments_segment_idx_non_negative`, and
  `ck_podcast_transcript_segments_time_offsets_valid`, creates
  `uq_media_transcript_segments_publication_idx(publication_id, segment_idx)`,
  and renames the start index to `ix_media_transcript_segments_media_start`.
- `media_transcript_publications` is the sole owner of origin, input kind,
  input digest, provider, model, language, and timing granularity, and its
  row's existence is the sole proof of a current publication.
  `media_transcript_states` retains only lifecycle (`transcript_state`,
  `semantic_status`, `last_request_reason`, `last_error_code`): the migration
  drops `transcript_origin` (after synthesizing publications) and
  `transcript_coverage` (deleted per Non-goals, not migrated), and adds no
  publication pointer — one invariant, checked inside the publication
  transaction, replaces `set_media_transcript_state`'s origin assertions: a
  readable lifecycle value exists if and only if the publication row exists.
  Transcript Fragments gain nullable `transcript_publication_id` with
  composite `FK(transcript_publication_id, media_id)`; non-transcript
  fragments keep it absent; `ck_fragments_time_offsets_paired_null` and
  `ck_fragments_time_offsets_valid` are dropped (application invariants).
- Hard-cut transcript lifecycle values to `not_requested | queued | running |
  ready | quota_blocked | failed | unavailable`. Migrate `partial -> ready`,
  `failed_quota -> quota_blocked`, `failed_provider -> failed`; delete old
  decoders and business-state checks (`ck_media_transcript_states_state` and
  `ck_media_transcript_states_coverage` dropped, not recreated).
  `ix_media_transcript_states_semantic_repair` is rebuilt with predicate
  `transcript_state = 'ready' AND semantic_status IN
  ('pending','failed','ready')` so no deleted value survives in the catalog.
  The same seven-value union cuts through the whole action surface in one
  release: `TranscriptResourceActionCapabilityOut.state` and
  `_TRANSCRIPT_ACTION_STATE` (`resource_items/action_snapshots.py`), the
  `resourceActionSnapshot.ts` strict decoder, the
  `ResourceOperation.Media.Transcript` catalog `states` record and
  `planTranscript` switch, and `resourceActionProductOracle.ts` — the
  `Partial`/`FailedQuota`/`FailedProvider` arms and the `coverage` field are
  deleted, and the relabelled presentations are `Transcribe…` /
  `Transcription queued` / `Transcribing…` / `Open transcript` /
  `Review billing` (QuotaBlocked, intent `ReviewBilling`, never retry) /
  `Retry transcription` / `No transcript available` (no intent).
- Rename the shared `podcast_reindex_semantic_job` task/kind to
  `media_transcript_reindex_job` — a `kind`-only data cut (payload is
  `{media_id, request_reason}`, kind-agnostic; no `dedupe_key`). The registry
  entry, topology tuple (`BACKGROUND_WORKER_JOB_KINDS`), task module/function
  including its literal `job.kind` self-check, and the two literals in
  `services/transcripts/semantic.py` (`enqueue_transcript_semantic_job`,
  `request_transcript_semantic_repair`'s `lock_jobs_for_payload`) move in the
  same commit. `reconcile_stale_ingest_media_job` is a live admission source
  for the renamed kind: its readable predicate drops `partial`, its segment
  existence probe is renamed, and `request_transcript_semantic_repair`'s
  `{ready, partial}` guard becomes `{ready}`.
- `podcast_transcription_jobs` -> `media_transcription_jobs`
  (`PodcastTranscriptionJob` -> `MediaTranscriptionJob`),
  `podcast_transcript_request_audits` -> `media_transcript_request_audits`,
  and `podcast_transcription_usage_daily` -> `media_transcription_usage_daily`
  — all serve podcast and video lanes. Their status and request-reason CHECK
  constraints are dropped, not extended; vocabulary moves to application
  owners. The forecast/reserve/settle seam (`transcription_usage.py`,
  `transcription_reservation_settlement.py`) moves under the generic
  transcript kernel (workstream E) and loses its podcast-episode kind guard.
  Only RSS/subscription/provider-sidecar adapters keep honest Podcast names.
- Add source type `youtube_video_copy` to `services/media_source_types.py`
  (deliberately NOT a member of `TRANSCRIPT_SOURCE_TYPES`). `youtube_video`
  remains metadata Add; `video_transcript` becomes real durable transcript
  work. `media_source_attempts` gains non-null `attempt_role`
  (`Primary | Supplemental`), backfilled by source type
  (`podcast_episode_transcript`/`video_transcript` = Supplemental, everything
  else Primary); `attempt_no` is monotonic per `(media_id, attempt_role)`;
  `_require_source_publication`'s latest-attempt supersede check is scoped to
  the attempt's own role, and its hardcoded `job.kind ==
  'ingest_media_source'` assertion becomes a caller-supplied expected-kind
  parameter. Normative invariant: a supplemental attempt never supersedes,
  and is never superseded by, a primary-ingest attempt; Refresh/Retry during
  a running copy neither cancels it nor is cancelled by it.
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
  video rows with YouTube URLs but NULL provider identity. Never guess a
  merge winner.
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
  binds `authored_publication_id` to that Media's synthesized publication,
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
- Every new failure code in this spec is added to the closed
  `nexus.errors.ApiErrorCode` enum (and `ERROR_CODE_TO_STATUS`) in the
  contracts step, before any task or service raises it: the background child
  boundary projects a `ModeledFailure` only for an `ApiError` whose code is a
  member and otherwise demotes it to a retried `E_WORKER_CHILD_DEFECT`,
  erasing the typed recovery. `errors.py` is a `durable-job-replay` source
  glob, so this change re-selects that risk's proofs.

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
(Unsupported | NotKept | Kept | Failed | RemovalFailed) AND transcript is a
terminal arm AND no binding reservation or nonterminal removal cleanup is
open`. `api/routes/stream.py` stops terminating on `ready_for_reading`
alone; the client `useMediaProcessingStatus.ts` derives `shouldStream` from
the projections (deleting its terminal gate and `expectExactRecord` key
list) and re-decodes the pushed snapshot in place — no `MediaOut` refetch.
The player runtime owns a shell-level subscription for the active session's
Media, independent of any open pane, so a Keep -> Kept transition and an
epoch bump both reach a session whose media pane is closed. Copy and
transcript attempts touch `media.updated_at` only to invalidate this read
model.

The semantic-job rename is also a data cut, run at the real quiescence
boundary this repository has — there is no "maintenance mode" or drain
mechanism, and the wording is banned. The release controller's existing
`_stop_writers` step (compose stop of `worker-background`, then
`worker-interactive` and `api`) stops all writers; the migration then runs in
the release migration one-off and rewrites `background_jobs.kind` for EVERY
old-kind row in EVERY status — including `running` rows stranded by the stop,
which are safe because no worker process survives; it clears
`claimed_by`/`lease_expires_at` on rewritten `running` rows so no restarted
worker can settle a pre-rename claim — and asserts zero old-kind rows across
all statuses before commit. Retained dead rows are not exempt.

Transcript synthesis is total, in three cases. (1) For every Media whose
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
locators are never orphaned. (3) Migration never deletes `fragments`,
`highlights`, or any anchor row. Only a readable state with missing
provenance or state/segment/Fragment disagreement aborts for explicit
operator repair; no publication is guessed. Post-migration assertions: zero
unbound segment rows, zero timed Fragments without a publication where their
Media's transcript is readable (both residue-listed and in the A proof).

Migration creates one Timeline for every existing podcast/video. Podcast
duration backfills only from canonical episode metadata (advisory, never a
write bound); video duration stays absent until the conforming probe on a
verified owned asset establishes it — `youtube_video_ingest` is NOT extended
to fetch provider `contentDetails` in this cut, so no provider-reported
duration ever binds a Timeline. The first publication transaction (and any
re-Keep publication) sets `media_timelines.duration_ms` from the conforming
probe in the same commit that installs owned identity;
`media_video_assets.duration_ms` must equal it exactly, and every wire
duration projects from the Timeline. Binding epoch starts at zero and no
video owned identity is inferred. Duration alone never proves content
identity.

Whole-Media teardown is hard-cut to cover video: the document-kinds teardown
owner (`_DOCUMENT_KINDS`, `delete_document_media_if_unreferenced`,
`_claim_document_media_teardown`) is renamed kind-agnostic and covers pdf,
epub, web_article, and video; `enumerate_media_storage_paths` unions
`media_video_assets.storage_path` so teardown deletes the R2 object; re-Add
after teardown cannot resolve the torn-down row through the
reuse-by-canonical-URL branch. `services/media_deletion.py` gains, in order:
deletes for both highlight time-anchor tables immediately before
`DELETE FROM highlights`; then `media_video_assets`,
`media_video_copy_removals`, `media_transcript_publications`, and
`media_transcript_segments`; Consumption-owned playback-state and activity
Timeline references through `delete_media_consumption_state_in_txn`; then
`media_timelines` — all strictly before `DELETE FROM media_source_attempts`,
which both new attempt FKs target.

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
`ix_media_transcript_states_semantic_repair` (new predicate),
`ck_highlights_anchor_kind_valid` / `ck_highlights_anchor_fields_paired_null`
(dropped), and the segment/fragment constraint set named above.

Do not overload `media_file`, `media.processing_status`, attempt JSON, or a
transcript fragment as an owned-video publication.

## Capability and API contract

`GET /media/{id}` exposes four strict projections. It deletes the loose
nullable `transcript_state`/`transcript_coverage` fields, folds the existing
`Presence<TranscriptOrigin>` field into `transcript.Ready.origin`, deletes
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
  | NotKept { keep: Keepable | Blocked { reason: VideoCopyBlockReason } }
  | Queued { copyHandle }                    # Cancel implied by the arm
  | Keeping { copyHandle, progress: Presence<VideoCopyProgress> }
  | Cancelling
  | Kept { verifiedAt, sizeBytes }
  | Failed { failure: VideoCopyFailure }
  | Removing
  | RemovalFailed { failure: RemovalFailure }

playback:
  Unavailable { reason: PlaybackUnavailableReason }
  | ExternalAudio { streamUrl }
  | ExternalYouTubeVideo { providerVideoId, watchUrl }
  | OwnedVideo { assetHandle, contentType, sizeBytes, width, height }

transcript:
  Unsupported
  | NotRequested { canRequest, blockReason: Presence<TranscriptBlockReason> }
  | Queued
  | Running
  | Ready { publicationHandle,
            origin: Publisher | Imported | Generated,
            language: Presence<string>,
            canReplace }               # a higher-fidelity source exists unused
  | QuotaBlocked { requiredMinutes, remainingMinutes: Presence<int> }
  | Failed { failure: TypedFailure }
  | Unavailable { reason: TranscriptUnavailableReason }
```

Every reason union is closed in v1 and decoded with no default branch on
either side of the wire (residue-gated):

- `VideoCopyBlockReason = TimelineUnproven | UnprovenProgress |
  ItemBeingRemoved | CopyInProgress` — the latter two render **This item is
  being removed from Nexus.** / **A copy is already in progress.**;
  `UnprovenProgress` is informational (Keep stays available behind the
  acknowledged reset). `Unsupported` covers only ineligible kind, provider,
  or permission.
- `PlaybackUnavailableReason = CopyBinding | KeptCopyRemoved |
  NoPlayableSource | UnsupportedProvider` — bodies **Playback is paused while
  Nexus keeps a copy.** / **The kept copy was removed. You can still open the
  source.** / **This item has no playable source.** / provider not canonical
  YouTube (copy projection `Unsupported`, **Open source** the only action).
  A `video` Media whose provider identity is not a supported YouTube VOD
  resolves to `UnsupportedProvider` — the non-YouTube `external_video`
  fallback in `playback_source.py` is deleted, not carried forward.
- `TranscriptBlockReason = BillingRequired | CopyRequired | TimelineBinding |
  DurationUnknown` — `BillingRequired` renders **Transcription is included
  with AI plans** + Review billing (`E_BILLING_REQUIRED` is projected, never
  thrown from the read path; `NotRequested { canRequest=false }` without a
  reason is illegal); `TimelineBinding` renders the binding pause line;
  `DurationUnknown` renders **Nexus needs the item’s length before it can
  transcribe it.**
- `TranscriptUnavailableReason = SourceRequired | NoProviderTranscript |
  UnsupportedMedia` — `SourceRequired` renders **Keep a copy to transcribe
  this video** (the `videoCopy` projection supplies the Keep action);
  `NoProviderTranscript` is the genuinely terminal provider result.
- One shared `TypedFailure { code, recovery: Retry | OpenSource | KeepCopy |
  ReviewBilling | None }` populates `transcript.Failed`, with `code` closed
  to the error-code table below.

Database UUIDs remain private. `TimelineHandle` seals private Timeline
identity plus `binding_epoch`: a payload-carrying variant of
`_EntityHandleSpec` in `services/sealed_handles.py` with wire grammar
`nmt1.{b64url(uuid16 || be-uint64 epoch)}.{b64url(tag16)}`, exposing
`seal_media_timeline(timeline_id, binding_epoch)` and
`unseal_media_timeline(raw) -> (UUID, int)`. `VideoCopyHandle`,
`VideoAssetHandle`, and `TranscriptPublicationHandle` are ordinary
single-UUID `_EntityHandleSpec` entries with distinct prefixes and domains.
Every handle's MAC input is domain-separated per type and covers every field
the wire string carries, so a modified epoch or a handle replayed at a
different endpoint fails verification. Handlers unseal to recover identity
and the epoch fence, then authorize the request from the viewer and re-read
row currency from the database inside the gateway transaction — handles
identify but never authorize. `copyHandle` is only the exact
active-generation fence needed for cancellation, never a raw attempt ID.

Resolution is deterministic: a current verified asset yields `OwnedVideo`; an
unbound Timeline may yield a valid external arm; an active first binding yields
`Unavailable { reason=CopyBinding }`; a bound Timeline without its asset yields
`Unavailable { reason=KeptCopyRemoved }` plus Open source. Failure never changes
source inside an active session, and owned identity never auto-falls back to the
provider.

`VideoCopyProgress` is `Stage` or `Bytes`; stages are monotonic in exactly
this order: `Resolve | Download | Package | Probe | Upload | Verify |
Finalize` (`Probe` = local ffprobe/conformance/hash; `Verify` = post-upload
integrity confirmation). Byte totals appear only when the provider reports a
real stable total, rendered per stage, never as an overall percentage. No
ETA is invented. Copy progress persists in the supplemental attempt's
existing `processing_stage`/`progress_*` columns under the copy decoder.

Error codes are a closed table; each row is `name · HTTP status · raiser ·
retryability · projected state`:

| Code | Status | Raised by | Retry | Projects |
| --- | --- | --- | --- | --- |
| `E_MEDIA_TIMELINE_UNPROVEN` | 409 | Keep admission | no | `Blocked { TimelineUnproven }` |
| `E_MEDIA_TIMELINE_BINDING` | 409 | direct timed commands during binding | after settle | binding pause |
| `E_MEDIA_TIMELINE_STALE` | 409 | stale handle before the revision CAS | fresh handle | session dismissal |
| `E_MEDIA_TIMELINE_CHANGED` | 409 | re-Keep probe/publication, stale expected fence | no | `Permanent { TimelineChanged }` |
| `E_TRANSCRIPT_SOURCE_REQUIRED` | 409 | transcript admission/worker (terminal on first attempt, never queue-retried) | no | `Unavailable { SourceRequired }` |
| `E_VIDEO_COPY_SOURCE_INELIGIBLE` | — | worker (durable attempt code) | no | `Permanent { SourceIneligible }` |
| `E_VIDEO_PROFILE_UNAVAILABLE` | — | worker (durable attempt code) | no | `Permanent { ProfileUnavailable }` |
| `E_VIDEO_TIMELINE_UNSUPPORTED` | — | worker (durable attempt code) | no | `Permanent { TimelineUnsupported }` |
| `E_VIDEO_TOO_LARGE` / `E_VIDEO_TOO_LONG` | — | worker (durable attempt codes) | no | `Permanent { TooLarge / TooLong }` |
| `E_HIGHLIGHT_ANCHOR_UNSUPPORTED` | 422 | `POST /fragments/{id}/highlights` on a transcript fragment | no | typed rejection |
| `E_READER_SELECTION_NO_QUOTE` | 422 | quoting a moment Highlight | no | **A moment highlight has no text to quote. Highlight the transcript passage instead.** |
| `E_ACTIVITY_CAPTURE_CONFLICT` | 409 | capture key replayed with different Timeline facts | no | typed conflict |
| `E_STALE_PLAYBACK_REVISION` | 409 | renamed existing CAS rejection | fresh state | heartbeat recovery |

Worker-terminal codes marked `—` never reach an HTTP boundary; they are
durable attempt failure codes the projection maps through `VideoCopyFailure`.

Endpoints. Every new command binds its replay identity to canonical
`{method, exact path including the media id, body}` bytes hashed through
`resource_mutation_replay.canonical_json_bytes` (following
`podcasts/control_replay.py`), recorded inside the admission transaction
under one named scope per concern (`video-copy:command`,
`timed-media:highlight`, `timed-media:transcript`). Replay of the SAME
`Idempotency-Key` returns the memoized response for that admitted decision —
mismatched bytes, cross-media reuse, or cross-endpoint reuse raise
`E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`, never a silent memo hit. A NEW key
issued after the target generation is terminal or superseded is a fresh
command that returns current truth with no side effects and never removes a
kept asset.

| Endpoint | Contract |
| --- | --- |
| `POST /media/{id}/video-copy` | Required `Idempotency-Key`; `{ profile: "CompatibleMp4V1", rightsBasis: "UserAttestedAuthorized", acknowledgeProgressReset: Presence<bool> }`; join exact active/ready work, retry retryable failure, reject timeline mismatch; returns `200` + the copy projection (house command convention, not `202`). |
| `POST /media/{id}/video-copy/cancel` | Required `Idempotency-Key` and `{ copyHandle }`; supersede that exact queued generation transactionally (the unclaimed-supersede doorway, which already accepts pending/failed and covers expired-lease-unclaimed) or set `cancel_requested_at` on its running claim; too-late replay returns current truth. The wrong job cannot be cancelled. |
| `DELETE /media/{id}/video-copy` | Required `Idempotency-Key`; state-directed. From `Kept`: atomically unpublish the asset, persist the removal row, admit the exact `Armed` cleanup. From `RemovalFailed`: re-admit cleanup for the same `removalId`/`storagePath`, clear `last_error_code`, return `Removing` — this is **Retry removal**. From `Removing`/`NotKept`: return current truth unchanged. |
| `GET /media/{id}/playback-ticket?assetHandle=...` | Viewer-authorized; unseals the handle then re-reads exact asset currency from the DB (a handle for a removed or superseded asset is rejected); response `Cache-Control: no-store`; returns a bounded private R2 signed GET URL and expiry. Never proxies bytes. |
| `GET/PUT /media/{id}/playback-state` | Hard-replaces `/listening-state`; existing CAS/fence semantics plus expected `timelineHandle` in the body, rejected as `E_MEDIA_TIMELINE_STALE` (epoch mismatch) or `E_MEDIA_TIMELINE_BINDING` (reservation) before the revision CAS; now any canonical timed Media, with completion recording and collection-family bumps kind-derived (a video heartbeat records a video completion and bumps only `LibraryEntries`). No duration field. |
| `POST /media/{id}/preview-position` | Moves with the renamed router; keeps its Podcast-episode-only admission (never subject to a video binding), gains the Timeline gateway + `timelineHandle`. |
| `POST /media/{id}/transcript/forecast` | Read-only forecast; no provider call, no audit mutation, no durable trace (the `dry_run` audit write and `media_transcript_requests.dry_run` column are deleted). Resolves the current Timeline server-side from the path id; `timelineHandle` is an OPTIONAL expected fence, verified when supplied. Response: `TranscriptForecast { admissible, cost: ZeroCostCaption \| ZeroCostSidecar \| HostedAsr { requiredMinutes, remainingMinutes: Presence<int>, fitsBudget } }`. |
| `POST /media/{id}/transcript/request` | Required `Idempotency-Key`; real explicit command only; resolves the Timeline server-side under the Media -> Timeline lock, `timelineHandle` optional expected fence (stale -> `E_MEDIA_TIMELINE_CHANGED`); worker persists the fence; no `dryRun`. Response replaces the loose state strings with the strict `transcript` projection. |
| `POST /media/transcript/forecasts`, `POST /media/transcript/request/batch` | Podcast batch surfaces survive on the same contract: server-resolved episode selection with the existing selection fingerprint, one `Idempotency-Key` for the batch, each Media's Timeline resolved server-side inside the batch transaction, no `dryRun`. `resolve_transcript_eligible_episode_ids` is rewritten value-for-value to `not_requested \| failed \| quota_blocked`. |
| `POST /media/{id}/time-highlights` | Required `Idempotency-Key`; `{ timelineHandle, positionMs, color }` (`color` = existing `HIGHLIGHT_COLORS`); returns `201` + `TypedHighlightOut` (replay returns the same body); rejects a stale session. |
| `POST /media/{id}/transcript-highlights` | Required `Idempotency-Key`; `{ publicationHandle, segmentIndex, startOffset, endOffset, color }` — segment index is the publication-unique key; the server derives `exact`/`prefix`/`suffix`, `tStartMs`/`tEndMs`, and the disposable locator from that tuple under the publication lock; returns `201` + `TypedHighlightOut`; rejects a stale publication. |
| existing `PATCH /highlights/{id}` | Accepts a colour-only update for every anchor kind (the colour branch precedes any anchor-kind requirement); rejects an `anchor` update for time kinds with typed `E_INVALID_REQUEST` (**Time anchors cannot be moved**), never a 404. |
| existing `POST /fragments/{id}/highlights` | Rejects transcript fragments with `E_HIGHLIGHT_ANCHOR_UNSUPPORTED` (422); remains the document-only FragmentOffsets command. |
| existing `GET /media/{id}/highlights` | Adds exhaustive `media_time` and `transcript_time_text` anchor arms. On timed Media the response merges both time kinds ordered by source time ascending (`t_start_ms`/`position_ms`), then `start_offset`, then `created_at ASC, id ASC`; unresolved-locator rows sort last with an Absent locator, never dropped. The fragment-cache repair pass runs only over `fragment_offsets` rows; transcript-anchor re-resolution is owned by the publication transaction, never this read. |

Highlight anchor wire shape: `anchor` is a discriminated union
(`Field(discriminator='type')`) of four arms; the quote triple moves off the
flat root and into the arms that own one (`fragment_offsets`,
`pdf_page_geometry`, `transcript_time_text` each carry required
`quote { exact, prefix, suffix }`; `media_time` carries none — quote absence
is structural). The two new arms in full:
`media_time { type, mediaId, timelineHandle, positionMs }` and
`transcript_time_text { type, mediaId, timelineHandle,
authoredPublicationHandle, tStartMs, tEndMs, quote,
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
(`ServerActionAvailabilityBlockedOut.reason` is not extended). Timed-media
annotation is decoupled from text readability: `canHighlightMoment` is true
exactly when the Media has a Timeline, playback resolves non-`Unavailable`,
and no binding is active — independent of `transcript_state`;
`_require_media_readable_for_highlight` splits so `time-highlights` requires
only the Timeline gateway, `derive_capabilities` stops deriving
`can_highlight` from transcript state for timed media, and the text-quote
capabilities keep requiring a readable publication. `CapabilitiesOut.can_play`
and its frontend decoder field are deleted — playability derives exclusively
from the `playback` union arm (residue-gated).

The Timeline gateway is mandatory for playback state, transcript/chapter
publication, both temporal Highlight commands, and `Listening`/`Viewing`
Activity delivery for canonical timed Media (`Reading` batches and
Timeline-less media bypass it and store absent fields). In the global lock
order it locks Media -> Timeline, unseals/checks epoch, rejects a binding
reservation for direct timed commands, then invokes the domain writer in that
transaction; for Activity delivery it records the observed epoch instead of
rejecting (see Observed activity). Where transcript publication composes with
it, the gateway lock is taken first, then the existing
`pg_advisory_xact_lock('transcript-current:{media_id}')` inside the same
transaction, and `transcripts.current` remains the sole writer of segments,
fragments, and transcript state (retiring `docs/modules/podcast.md`'s "no
active transcript pointer" sentence). Async jobs persist their expected
handle at admission. No owner reimplements this fence.

`media_source_attempts.job_id` remains the one sanctioned domain -> queue
reference (real FK, `ON DELETE SET NULL`); the copy attempt sets it in the
same admission transaction that enqueues the job, so the source-attempt
fence, `parser_operation_has_live_job`, and `ingest_operation_health` all
recognize the work. No NEW domain table introduced by this cutover references
`background_jobs`. Cleanup correlation uses the queue owner's typed
payload-containment lookups with a THIRD validated owner arm added to the
closed `Media | UploadSession` union in `tasks/storage_object_cleanup.py`:
`ownerKind: "VideoCopyRemoval"`, payload `{ ownerKind, removalId, mediaId,
storagePath, writeMayLandUntil, checkpoint }`, owner-row lock on `media`,
live-owner recheck via `path_has_live_db_owner`, and domain completion
write-back to `media_video_copy_removals`. The cleanup worker records
completion or failure only when the `removalId` it carries names a row whose
`storage_path` equals its payload path; both must match and neither is ever
mutated. `path_has_live_db_owner` additionally consults
`media_video_assets.storage_path` and explicitly does NOT consult the
removal ledger — a removal row is provenance, never ownership.

Playback-ticket authorization repeats viewer access and exact asset currency.
The signed URL exists only as the ticket service's return value and the HTTP
response body — never assigned to a variable that reaches a logger, never
stored in a row or replay memo, never embedded in an exception, never in
`MediaOut`; `url`/`signed_url`/`playback_url`/`location` join
`redact.py::FORBIDDEN_KEYS` so a future `safe_kv` call site raises in
dev/test, and the C proof asserts no captured log record or persisted row
contains `X-Amz-Signature`.

Owned-video delivery is a no-CORS media fetch: the committed R2 CORS policy
already permits `GET`/`HEAD` with the `range` request header and exposes
`ETag`/`Accept-Ranges`/`Content-Range`/`Content-Length`, and
`deploy/cloudflare/*` is unchanged by this cutover. The `<video>` element
must NOT carry a `crossorigin` attribute — that would turn every range
request into a CORS request and couple playback to bucket policy. The binding
browser constraint is CSP: the storage origin is named explicitly in
`media-src` — the deployed R2 origin joins `mediaOrigins` in
`apps/web/src/lib/env.ts`, and the local/test build emits the MinIO endpoint
into `CSP_MEDIA_ORIGINS` via `nexus_test_control/build.py`; the D proof
asserts an owned-video element loads locally with zero CSP violations.

Owned objects are written with `Content-Type: video/mp4`,
`Content-Disposition: inline`, and `Cache-Control: private,
max-age=<ticket TTL seconds>, immutable`, applied at write time through new
explicit `content_disposition`/`cache_control` parameters on the storage
client's upload path (defaulting absent for existing callers). Caching is
safe because the object key is run-fenced and the object immutable — a
cached range can never shadow a later publication, and Remove revokes by
deleting the object, inside the accepted `Removing` window. Only the
`playback-ticket` JSON response is `no-store`. Neither a CDN nor a browser
cache becomes a second publication owner.

Ticket lifetime is owned by dedicated settings
(`VIDEO_PLAYBACK_TICKET_MIN_SECONDS`, `VIDEO_PLAYBACK_TICKET_MAX_SECONDS`)
with the derived formula `clamp(durationMs + 15m, 30m, profile max duration
+ 15m)` so one ticket always covers a full uninterrupted watch of any video
inside the profile cap; `_validate_storage_lifecycle` rejects min <= 0,
max < min, and max above the SigV4 presign ceiling. `SIGNED_URL_EXPIRY_S` is
untouched and keeps governing document URLs. While a canonical `OwnedVideo`
session exists, the engine MUST proactively fetch a replacement ticket at a
named fraction of remaining lifetime (80%), swap `src` only at a safe point,
capture `{ currentTime, paused, playbackRate }`, restore them after
`loadedmetadata`, and suppress the `emptied` reset for the in-flight swap; a
ticket is never reused across sessions. On a media error, exactly one silent
re-ticket-and-resume is attempted when the ticket is expired or inside its
refresh window; a second failure renders **Couldn’t play the kept copy**, and
neither path may resolve `ExternalYouTubeVideo`. Signed R2 URLs are
protected by the existing document `Referrer-Policy:
strict-origin-when-cross-origin` (media elements do not support a
per-element `referrerPolicy`; the invalid attribute claim is deleted), and
neither URL nor query enters history or router state.

Remove revokes new tickets at DB commit and ends in `KeptCopyRemoved`, never
external playback. A removal-initiated cleanup is a distinct transition with
a ZERO write horizon: the asset is published-then-unpublished in one
transaction, so no writer can hold the path; the removal reservation is
admitted with `writeMayLandUntil = now` and `available_at = now`, the first
claim takes `DeleteRequired` and deletes immediately, and `Removing`'s bound
is one post-commit delete attempt plus its declared retry backoff — that
stated bound is the one-user bearer-revocation window, asserted against
MinIO in the B teardown proof. `Removing` does not become complete before
object absence is verified.

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
8.5 GiB attempt directory, 10 GiB free-space precondition, 1.5 GiB host
floor, 7200 s wall budget) — never a test-selected branch or fixture flag in
product code. The worker image pins yt-dlp and ffmpeg/ffprobe; their
executable paths are validated configuration settings, not `PATH` lookups, so
ordinary proofs point them at a test-owned fake executable.

Stream selection is a pinned deterministic yt-dlp format expression, a
committed profile constant (e.g.
`bv*[vcodec^=avc1][width<=1920][height<=1920]+ba[acodec^=mp4a]` with an
explicit sort and fixed tie-break): the highest available H.264 rendition at
or below the resolution cap whose predicted `(video+audio)` size — from
provider format metadata at Resolve — fits 4 GiB with a fixed container
margin. A 720p-or-lower-only H.264 ladder is Kept, not failed (still exactly
one rendition; "Kept at 720p" is honest and does not violate the
multiple-qualities non-goal). `E_VIDEO_PROFILE_UNAVAILABLE` is reserved for
"no H.264 video or no AAC audio rendition exists at all";
`E_VIDEO_TOO_LARGE` fires only when even the lowest H.264 rendition cannot
fit, and at runtime via an attempt-directory byte watchdog when observed
bytes exceed the predicted envelope (`--max-filesize` is unreliable for
merged DASH streams); `E_VIDEO_TOO_LONG` gates the duration cap. The
expression is part of `pipeline_version`, so changing it invalidates re-Keep
identity.

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
provider subprocess (asserted by the B resource-envelope proof). `shorts`/
`live`/`embed` paths normalize to a canonical watch URL in
`youtube_identity`, so eligibility cannot be pre-judged from stored identity.

The packaging argv is a committed profile constant beside the pinned tool
versions: `ffmpeg -nostdin -i <video> -i <audio> -c copy -movflags
+faststart+negative_cts_offsets -avoid_negative_ts make_zero -fflags
+bitexact -max_muxing_queue_size <N> -f mp4 <out>`. `-fflags +bitexact` plus
the pinned format expression make an unchanged provider genuinely reproduce
bytes, which is what makes exact-SHA re-Keep achievable at all. The
conformance contract is the checkable post-conditions of exactly that
recipe: (a) per-track strictly increasing DTS over a full `ffprobe
-show_packets` scan; (b) either no `elst` box at all, or at most one
non-empty start-trim edit per track with `media_time <= 200 ms` and no empty
edits (the standard AAC-priming edit is legal — rejecting all edit lists
would reject most legitimately remuxed videos); (c) first video presentation
timestamp exactly 0 and first audio presentation timestamp in [0, 100 ms]
after edits are applied; (d) `max_av_skew_ms = |first audio presentation −
first video presentation|` after edits, `<= 100 ms`, persisted as exactly
that quantity; (e) intra-track DTS gaps bounded by `max(500 ms, 2x nominal
frame/sample duration)` — larger is a discontinuity; (f)
`source_to_presentation_offset_ms = 0`, defined as no leading trim relative
to provider t=0; (g) a recorded-but-tolerated tail rule `|video track
duration − audio track duration| <= 1,000 ms`. Anything else fails
`E_VIDEO_TIMELINE_UNSUPPORTED`. Changing the argv changes
`pipeline_version`. Conforming and edit-listed fixtures both live under
`testdata/media/` so the probe gate is proven against each.

`acquire_video_copy` runs on a dedicated third production lane, not the
shared background worker: a `worker-copy` compose service with its own
memory/pids budget (yt-dlp + ffmpeg cannot fit today's background limits; the
compose `mem_limit`/`memswap_limit` and the cgroup readiness check move
together), its own `COPY_WORKER_JOB_KINDS` tuple disjoint from
interactive/background, and its own `JobResourceClass.VideoCopy` capacity row
seeded by migration A, with the capacity SQL parameterized by resource class
— a two-hour copy can never monopolize ingest, cleanup, or teardown, and the
`docs/modules/jobs.md` two-lane sentence is amended by workstream H.
`apps/worker/main.py` defects at startup unless the registry key set equals
the topology exactly, so registry, topology tuples, and migration land
together. It reuses the queue, lease, process executor, source-attempt fence,
and failure supervision, with its complete `JobDefinition` stated as
committed constants: `resource_class=VideoCopy`, `max_attempts=1`,
`retry_delays_seconds=()` (no automatic retry — every terminal outcome
projects `Failed` and only the user's Retry admits new work, so the
exact-attempt `copyHandle` is stable for the life of one generation),
explicit `lease_seconds` and heartbeat cadence that keep a two-hour claim
continuously owned, `wall_timeout_seconds` from a dedicated validated
`VIDEO_COPY_WALL_TIMEOUT_SECONDS` (default 7200), `never_prune_dead=True`, a
third `ChildExitCleanup` arm keyed on the copy attempt id, a `VideoCopy`
dead-letter projection arm, and `resource_failure_projection="Job"` (never
`"SourceAttemptMedia"`). `JobDefinition.wall_timeout_seconds` already exists
and is already task-digested; the cut deletes its 900 s default so every
kind declares its budget explicitly, and raises the two committed ceilings
(`process_executor._WALL_TIMEOUT_MAX_SECONDS` and the config validator) as
per-resource-class maxima — copy 7200 s, everything else unchanged at 900 s;
`BACKGROUND_PROCESS_WALL_TIMEOUT_SECONDS` remains the ingest budget and its
compose value stays "900".

Temp space is a validated absolute `VIDEO_TEMP_ROOT` setting (default
`/var/lib/nexus/video-tmp`) mirroring `PARSER_TEMP_ROOT`: an entry in the
worker env example, a bind mount on `worker-copy` in the compose file, a
cloud-init `install -d -o 10001 -g 10001 -m 0700` line for fresh hosts plus
an idempotent `install -d` in the release path (cloud-init runs once and the
live host is already provisioned), and a release preflight gate mirroring
the parser-temp gate (exact directory metadata plus 10 GiB free, blocking
the release). Use one private attempt/execution directory. Bound input
streams to 4 GiB aggregate, final output to 4 GiB, and the attempt directory
to 8.5 GiB — the disk envelope covers a second full-size output because
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
supervisor + child + yt-dlp + ffmpeg tree under the `worker-copy` cgroup.

Publication order:

1. In one serializable admission transaction, lock Media -> Timeline, validate
   capability, claim replay, create the supplemental source attempt, enqueue
   the job, set `attempt.job_id` to the enqueued job id, and record replay.
   For a first copy, store the exact binding attempt and increment Timeline
   epoch; touch Media for SSE.
2. Under the lease fence, before any external work, the run reads its attempt
   and asset state: an already terminal-succeeded attempt with its published
   asset completes as succeeded immediately (no provider call, no
   reservation); a terminal-failed or cancelled attempt completes reflecting
   that truth; only a nonterminal attempt proceeds. The claiming lease then
   increments `attempt.run_count` inside a lease-fenced transaction, exactly
   as `mark_running` does — a stale lease that later resumes computes a
   different run number and can only ever write its own path. The worker
   resolves/downloads/packages in its private temp dir, reporting only fenced
   monotonic progress.
3. Probe duration/codecs/dimensions, compute SHA-256 and exact length, and
   validate the complete Timeline-conformance contract. For re-Keep, gate the
   probed duration against `media_timelines.duration_ms` (1,000 ms) here,
   before upload cost.
4. Reserve `build_video_copy_storage_path(media_id, attempt_id, run_count)`
   (`storage/paths.py` owns the grammar and rejects `run_count < 0`; no call
   site interpolates the key) through the storage-cleanup owner immediately
   before upload. The reservation entry point gains a required caller-supplied
   `write_window_seconds`: the copy passes `bounded upload deadline +
   BACKGROUND_PROCESS_TERM_GRACE_SECONDS + R2_READ_TIMEOUT_SECONDS` — the
   whole job budget is deliberately NOT part of the horizon, because the
   reservation is taken immediately before the upload and no write can land
   after the upload deadline. Existing callers pass the current global
   setting unchanged; `_validate_storage_lifecycle` checks the derived
   per-kind horizon. Do not renew a reservation the cleanup worker has
   claimed.
5. Upload outside a transaction through a bounded multipart upload added to
   the storage client (`create_multipart_upload` / `upload_part` with a
   committed part size / `complete_multipart_upload`, and
   `abort_multipart_upload` on every failure, cancellation, and wall-timeout
   path; a failed part retries in place without re-downloading from the
   provider; the max-object constant is checked against R2's ~4.995 GiB
   single-request and 10,000-part limits; `R2_READ_TIMEOUT_SECONDS` is a
   per-socket-read bound survived by part retry, never widened). The
   single-PUT-envelope claim is deleted — no such envelope exists. Integrity
   is established at write time: per-part `ChecksumSHA256` with composite
   verification on complete (single PUT sends the locally computed
   `ChecksumSHA256`), then `HEAD` confirms exact length and content type — a
   full streamed read-back is required only when the release preflight cannot
   prove checksum support on the deployed bucket. Same-length corruption
   fails before publication either way; the B resource-envelope proof asserts
   total transfer volume fits the wall budget at a stated throughput floor,
   and the `Verify` stage reports this phase truthfully. A repository-owned
   R2 lifecycle rule (`deploy/cloudflare/r2-lifecycle.example.json` +
   apply script) aborts incomplete multipart uploads at age one day on the
   `media/` prefix — `ListObjectsV2` cannot enumerate them, so the orphan
   sweep is blind to them; the in-task abort is primary, the rule the durable
   backstop.
6. In one publication transaction, in the global lock order: lock and renew
   the exact running claim (`lock_and_renew_running_job_claim` semantics),
   abort into the cancellation settlement if `cancel_requested_at` is set,
   then lock Media -> Timeline -> attempt and recheck teardown and the
   binding attempt/epoch. First publication: recheck the absence of every
   Tier-1 pre-copy timed fact, install immutable SHA/profile/pipeline and the
   probed `duration_ms` on Timeline, compare-and-clear the binding, increment
   epoch. Re-Keep publication: verify the Timeline's owned identity and the
   latest removal row's SHA/profile/pipeline are equal — no binding to clear
   and NO epoch increment (identical bytes; existing handles stay valid).
   Insert the sole asset, terminalize the attempt, touch Media. Commit makes
   `Kept` visible.
7. Finalize the cleanup reservation. A crash before publication deletes the
   orphan; a crash after publication retains the live asset; a worker killed
   between the publication commit and the queue success transition replays as
   step 2's terminal-success no-op (covered by the B publication proof).
8. Remove first dismisses the active session only when that session's frozen
   source is this Media's `OwnedVideo` asset — any other session, its
   transport, and device-local history are untouched. Then in one transaction
   it persists a new immutable removal row, enqueues the `Armed`
   `VideoCopyRemoval` cleanup keyed by `{removalId, mediaId, storagePath}`
   with a zero write horizon, and deletes the asset row. Only the cleanup
   worker may take `DeleteRequired` after rechecking no live owner/writer — a
   live writer includes any nonterminal transcript attempt bound to the same
   Timeline, so **Remove copy** is inapplicable while one exists (**Nexus is
   transcribing this item. Remove the copy after transcription finishes or is
   cancelled.**), rechecked under the Media -> Timeline lock. It deletes
   post-commit and, in the same transaction as its `Deleted` checkpoint, sets
   `completed_at` when `removalId` and `storagePath` still match; each failed
   attempt sets a typed `last_error_code`; the dead-letter transition records
   the terminal failure marker the `RemovalFailed` projection reads. Then it
   touches Media for SSE.

Run-fenced paths never collide. Concurrent commands converge through provider
identity, mutation replay, serializable retry, and Media locking. Copy
failure is settled supervisor-side, composed with the queue transition in the
queue-first lock order: it records the supplemental attempt, clears only its
matching Timeline binding reservation, and increments epoch. A claimed run
whose attempt is already terminal completes immediately as a typed no-op
success; failure supervision never overwrites an already-terminal attempt.
The dead-letter path is a `VideoCopy` arm in the closed
`DeadLetterProjection` union, applied in the same transaction as the dead
transition: terminalize the attempt failed with the job's typed code,
compare-and-clear with epoch increment only when the CAS actually clears,
touch Media; `never_prune_dead=True` keeps the row operator-discoverable
with `requeue_dead_job` as its repair transition.

Copy and timed-transcript attempts are supplemental: admission, progress,
success, and failure never write Media `processing_status` or its failure
fields — `source_attempt_failures.py` is hard-cut into the existing
primary-ingest publisher and a new
`publish_supplemental_source_attempt_failure` that terminalizes only the
exact attempt row, compare-and-clears its binding, and touches
`media.updated_at`, never calling `mark_media_failed_by_id` or
`bump_all_media_fact_collections`; `source_attempt_failure_stage` becomes
exhaustive over source types instead of defaulting to `'extract'`. A
supplemental failure leaves any previously readable transcript mounted. A
residue gate asserts no supplemental source type can reach
`mark_media_failed_by_id`. New tickets stop at DB unpublication; an
already-issued bearer may work until physical deletion, inside the stated
`Removing` bound.

Cancellation is queue-owned. The queue adds an exact `request_cancel(job_id)`
transition and changes heartbeat truth from `bool` to
`Owned | CancelRequested | Lost`; a `CancelRequested` heartbeat still RENEWS
the exact lease so the settlement stays fenced, and the worker's synchronous
pre-execution `still_owned` check decodes the same union, abandoning a job
already marked `CancelRequested` without starting the child.
`cancel_requested_at` semantics across existing transitions are explicit: it
SURVIVES `fail_job` retry and `reschedule_running_job`; it is CLEARED by
`requeue_dead_job` and `reset_unclaimed_job_for_new_intent` (both establish
new intent); `promote_unclaimed_job` leaves it untouched; the worker's
shutdown-release path is never conflated with cancellation. Waiting work is
cancelled in one command transaction that supersedes the exact queued job
(extending the existing `supersede_unclaimed_job` doorway) with a typed
`Cancelled` result, terminalizes the attempt as `cancelled`,
compare-and-clears its binding, and increments epoch — the projection
reaches `NotKept` immediately. For claimed work the SUPERVISOR, not the
task, acts: the worker sets a `cancel_requested` event alongside the
existing `claim_lost`, `_await_child_exit` observes it, the executor kills
the whole child process group (yt-dlp and ffmpeg die with the group; no
in-child handler or poller), and a new closed `ChildCancelled` result
returns. The supervisor then settles in one lease-fenced transaction —
lock the exact running claim, terminalize the attempt `cancelled` via a new
SQL-only `services/source_attempt_cancellation.py` owner (mirroring
`source_attempt_failures.py`, no storage/provider imports),
compare-and-clear with epoch increment only if the CAS clears, and
`complete_job` succeeded with the typed `Cancelled` result — with temp
removal handled by the `ChildExitCleanup` arm and unpublished-object
deletion left to the existing `Armed` reservation; the worker never deletes
objects in-line. Cancellation latency is bounded: observed at the next
heartbeat (`WORKER_HEARTBEAT_INTERVAL_SECONDS` + TERM grace);
`acquire_video_copy` declares a heartbeat interval short enough that
`Cancelling` resolves within 30 seconds, so **Cancelling…** is truthful. A
cancel is too late only when publication committed strictly before the
cancel command's job-row write — `Cancelling` genuinely has no transition to
`Kept`. No domain service reads queue internals, no poller is added, the
wrong job cannot be cancelled, and cancelled/lost work cannot publish.
Terminal cancellation retains its audit row, projects `NotKept`, and emits
**Copy cancelled** feedback. Every terminal failure/supervision path uses the
same compare-and-clear binding helper, which increments `binding_epoch` if
and only if the attempt-id CAS actually transitions the reservation from set
to cleared — a stale attempt cannot clear a newer reservation, and a
replayed settlement can never bump the epoch under a later generation.

## Timed-media player

Hard-cut `FooterAudio` to one `TimedMedia` activation. `Readable` and genuine
non-playable `OpenPane` remain. `NextCapability`/`next_capability` becomes the
closed union `"Stop" | "TimedAudio" | "TimedMedia" | "Readable"`, renamed
across the consumption schemas/service, `lib/lectern/contract.ts`,
`playerSession.ts`, `LecternProvider.tsx`, and the Android protocol;
`SettleNaturalEndCommand.next_capability` narrows accordingly, and video
natural end settles through the existing `SettleNaturalEnd` command with the
engine's terminal position and the Timeline handle, exactly as podcast audio.
Successor capability is engine-scoped: automatic natural-end advance and
**Play next** select only a successor the currently selected engine can play
— an Android native ExternalAudio session never auto-advances into video (it
retains `PausedAtEnd`), and a row resolving `Unavailable` is skipped as a
successor and, when explicitly activated, presents its Unavailable state
instead of starting a session.

A descriptor carries the strict playback union, Timeline, playback fences,
title/artwork, origin/history, chapters, completion, and engine capabilities.
It does not carry an expiring ticket. Video artwork is a persisted fact:
YouTube Add stores the provider thumbnail the Browse adapter already
resolves, projected through the same `artworkUrl` Presence field as podcasts,
and the `OwnedVideo` engine sets the `<video>` `poster` from it.
Device-local player history and the Lectern snapshot store only Media
identity plus presentation fields — never a resolved `playback` arm; every
activation (explicit Play, Previous, Next, natural-end advance, reload
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
`NotKept`/`Failed`/`RemovalFailed`: **Playback stopped because this item’s
copy changed. Play again.** It never continues with writes disabled or
silently adopts another source. A stale-Timeline or binding rejection of a
playback-state write is itself terminal for that heartbeat generation: the
client retires the dirty sample, stops the generation without GET re-sync or
retry, and enters the same paused-and-dismissed state — SSE is a redundancy,
not the only path.

### Canvas projection

One shell-owned `PlayerEngineHost` owns the actual audio/video/iframe node,
created once per session at `lib/player/PlayerVideoCanvas.tsx` and NEVER
reparented or removed from the DOM (an iframe reparent reloads the provider
player) — only repositioned, clipped, and hidden. Pane/Now Playing components
publish a `VideoCanvasOutlet` containing bounds and visibility; they never
mount media. The outlet publishes its own rect plus the rects of its
clipping/scrolling ancestors (the media pane's `.documentViewport`; the
desktop pane canvas), and the host applies a `clip-path` from their
intersection, re-measured on scroll of every scrolling ancestor, resize,
`ResizeObserver`, pane visibility change, and mobile-chrome reveal. A new
`--z-video-canvas` layer token joins the global scale with its ordering
stated against `--z-raised`/`--z-overlay`/`--z-modal`/`--z-nexus`/ActionMenu/
`--z-toast`; Now Playing chrome, the selection popover, Dialog, ActionMenu,
mobile sheets, and the MiniPlayer must all occlude the canvas. The canvas is
hidden (not merely clipped) whenever its visible rect is empty, during
reader view transitions, and while parked. Pointer ownership: the canvas is
`pointer-events: none` while parked or when its outlet is not the active
surface; attached, it sets `touch-action: manipulation` and forwards
vertical pans starting on non-control areas to the pane scroller; the owned
`<video>` renders with native `controls` off under Nexus chrome; only the
YouTube canvas requires pointer capture, and pane scrolling started inside
it is not forwarded. Accessibility: exactly one owner holds the
`Media player` landmark while a canvas is attached (the shell chrome; no
other surface renders the role for that duration); the pane publishes a
focusable placeholder at the outlet's DOM position that forwards focus into
the canvas so tab and reading order match visual order, Escape returns focus
to the placeholder, and a parked canvas is `aria-hidden` and `inert`.
Fullscreen: the canvas node itself is the fullscreen element (never a
wrapper); the host suspends outlet tracking and clipping while
`document.fullscreenElement` is the canvas; the YouTube iframe keeps
`allowfullscreen`; the Android WebView engine publishes
`fullscreen: Unsupported` in v1 so no dead control renders.

A parked canonical video session keeps playing as audio — parked means
hidden, never paused — with the surfaces showing **Audio only — open the
video to watch** beside **Open video**; parked playback records `Listening`,
never `Viewing`. Desktop: the media pane is the canvas outlet; the Listening
Shelf never hosts the canvas. Mobile: the media pane is the primary watch
outlet and the expanded Now Playing overlay the secondary; the MiniPlayer
never hosts the canvas; when both are present Now Playing wins while open
and the canvas returns to the pane outlet on collapse without reloading the
engine. Leaving a pane preserves the session and exposes **Open video**.

### Clock and engines

One session-owned `TimelineClock` feeds chrome, transcript, playback
heartbeat, and Activity. Browser media uses engine events. YouTube playback
is driven through the existing allowlisted `YouTubeEmbedFrame` iframe with
`enablejsapi=1` and a first-party `origin` parameter via the `postMessage`
protocol (fixed `targetOrigin` from `YOUTUBE_EMBED_ORIGINS`, inbound messages
accepted only from that allowlist) — no third-party script enters the app
origin and `script-src` is unchanged. The YouTube adapter samples
`getCurrentTime()` at a bounded 4 Hz whenever the player is Ready and the
document visible (a display cadence, not the source of truth), and
additionally resynchronizes synchronously on every reported state change —
play, pause, buffering, ended, cued — and on every reported seek and rate
change, so a paused or provider-scrubbed clock is never stale;
provider-native transport (in-player play/pause/seek/rate, YouTube's own
shortcuts) is a first-class input the engine reconciles. Activity
observation is visibility-gated but the durable position source never goes
stale: while the engine reports Playing in a hidden document, sampling
continues for the heartbeat (only the Activity adapter stops), and the
engine takes a fresh position read on `visibilitychange` -> visible, on
pause, and in the `pagehide`/`beforeunload` keepalive flush. The engine
Timeline port gains `readPositionNow()`: **Highlight this moment**, seek-bar
commits, and every playback-state write read it rather than the cached
tick. No pane creates a clock or polls lifecycle state; the timed-transcript
controller subscribes through a selector, updating only the active cue's
`aria-current`/cursor — cue advance never re-renders the cue list.

All engines implement the same Commands/Session/Settings/Timeline capability
ports. Every setting is enumerated Supported/Unsupported per engine, the
chrome renders no control for an Unsupported capability, and no surface
branches on engine identity:

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
- fullscreen and Media Session are engine capabilities beside them:
  `BrowserAudio`/`OwnedVideo` publish `mediaSession: Supported` through a
  generalized adapter taking a position/duration/rate reader plus transport
  callbacks; `YouTubeIframe` publishes `ProviderOwned` (Nexus registers no
  metadata, state, or handlers and claims no OS-control behavior); the
  Android WebView engines publish `HostOwned` — the native Media3
  `MediaSession` is the sole OS media session, and the WebView installs no
  `navigator.mediaSession` anything;
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
engine/capabilities; terminal `Failed` shows **Couldn’t play this item**
with Retry. Each `PlaybackUnavailableReason` has its matching presentation
arm. **Open source** is available when provenance permits but is always an
explicit navigation action, never source fallback. A kept-object failure
uses **Couldn’t play the kept copy** and cannot switch engine implicitly.

When a `Ready` transcript publication exists for an `OwnedVideo` session, the
engine host attaches its cues as a timed-text track on the `<video>` node
and exposes a **Captions** toggle among engine capabilities — absent when no
publication exists — and fullscreen keeps Nexus chrome and the caption
toggle.

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
first. The protocol hard-cuts vocabulary — `ListeningState` ->
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
`NexusWebView.configure` sets `mediaPlaybackRequiresUserGesture = false`
(justified: the WebView loads only the owned origin under strict CSP with
`frame-src` limited to the YouTube embed origins), recorded in the
codebase-rules owner line and the release evidence. `MainActivity` gains
`android:configChanges` for orientation/screen/uiMode/fontScale/density so
the WebView document — and the active video session — survives rotation and
theme changes; `onPause` first drives a suspend step (pause the engine,
close the open Viewing span, flush the final playback-state write) and only
then calls `webView.onPause()`/`pauseTimers()`; any span not closed before
suspension is discarded, never persisted open-ended. Its engine accepts
`ExternalAudio` and `PreviewAudio`; OwnedVideo/ExternalYouTube are handled by
the WebView browser engines, foreground-only in v1.

## Transcript and temporal Highlight behavior

Transcription is always durable and explicit. The request transaction performs
no provider call. The worker tries, in order:

1. a declared Podcast publisher sidecar;
2. YouTube captions — the synchronous in-request caption fetch is replaced by
   a worker-side caption-track fetch through `safe_get`: list tracks, select
   in order a manually-created track in the Media/Timeline language, a
   manually-created track in any language, then an automatically-generated
   track, recording the chosen track's language code and generated flag; a
   provider response that cannot report the generated flag is a typed
   failure, never a guess;
3. existing hosted ASR for Podcast audio or a ready owned-video asset.

Every provider adapter returns
`TranscriptFetch { rawBytes, contentType, language, provider, modelId,
isGenerated, segments }` — the exact bytes it parsed. All sidecar/caption
fetches go through `safe_get` with explicit `max_bytes` and content-type
checks; first-party provider APIs stay on `http_retry`; any other outbound
HTTP in the transcript or copy lane is a defect (residue-gated). Podcast
hosted ASR switches from URL submission to a bounded streamed read Nexus
digests and submits through the provider's raw-audio path; Nexus never
digests a URL string. Origin and digest are keyed by input kind: publisher
sidecar bytes -> `origin=Publisher`, `input_kind=SidecarBytes`; manual
caption bytes -> `origin=Imported`, `input_kind=CaptionBytes`; automatic
caption bytes -> `origin=Generated`, `provider='youtube_asr'`,
`input_kind=CaptionBytes`; Nexus hosted ASR -> `origin=Generated`,
`provider='deepgram'`, `model_id` present, `input_kind=StreamedAudioBytes`
(podcast) or `ExtractedAudioBytes` (owned video); migrated rows use only the
canonical migration digest. `input_sha256` is always the digest of the bytes
actually read/submitted, never copied from a stored identity, and is NOT
NULL because every origin now has exactly one defined byte source.
`provider`/`model_id`/`language` populate only from the adapter result and
are Absent when unprovable.

Owned-video ASR input: hosted ASR never receives the playback object or a
viewer ticket. The transcription task fetches the owned MP4 (stream-hashing
it and verifying it equals the recorded owned-asset SHA before any provider
work), extracts one bounded audio-only rendition with the pinned ffmpeg
(`-vn`, AAC/M4A) under the same private temp discipline and disk envelope as
`acquire_video_copy`, digests it, and streams those exact bytes to the
provider; the extracted-audio SHA is the publication `input_sha256`. The
publication transaction rechecks the same asset row is still current; a
hash mismatch or object absence is a typed retryable failure that publishes
nothing. The ASR wall budget is its own configured constant sized for the
4-hour profile; the requested language comes from the Timeline/Media, never
a hardcoded default. Hosted ASR on an owned asset is admissible only while
no removal row post-dates the asset, and a transcript attempt cancelled by
an accepted removal releases its quota reservation through the same
compare-and-clear settlement.

Transcription usage is media-level: required minutes derive from
`media_timelines.duration_ms`, never guessed — the one-minute fallback is
deleted for timed media. Video hosted ASR is therefore admissible only when
the Timeline carries a probed duration (a copy is Kept); with duration
absent, the forecast returns only the caption-only zero-cost arm and the ASR
path projects `SourceRequired`/`DurationUnknown` instead of a quota
forecast.

Provider cues are never a Nexus contract: before publication, a
deterministic pure `services/transcripts/segmentation.py` assembles prose
cues — merge consecutive cues while the merged text has no sentence
terminator, the speaker is unchanged, and duration/character ceilings hold
(30 s, stated character cap); the merged interval is `[first.start,
last.end)`. Published cues form a strictly increasing, pairwise-disjoint
sequence (the owner clamps `cue[i].end = min(cue[i].end, cue[i+1].start)`,
drops zero-length cues, and publication rejects residual overlap with typed
`E_TRANSCRIPT_CUES_OVERLAP`), and the same owner bounds cue count (4,000
cues for a 4-hour item) so the v1 unvirtualized list — required by native
selection, Find, and highlight painting — stays responsive; publication
rejects a sequence exceeding the ceiling.

Terminal failure classification is one typed mapping in
`transcripts/state.py`, used by both failure owners: definitive provider
absence -> `unavailable`; quota -> `quota_blocked`; every other terminal
code -> `failed` with Retry. `E_TRANSCRIPT_SOURCE_REQUIRED` is terminal on
first attempt — a deterministic condition the queue never retries. Failure
is non-destructive: when a publication exists, the state row keeps its
readable lifecycle and publication, the projection stays `Ready`, and the
failure surfaces as a separate retry affordance; only successful replacement
changes the publication. The transcript job kind declares
`never_prune_dead=True` and a `MediaTranscript` dead-letter arm sets
`transcript_state='failed'` with the typed code in the dead transition's
transaction, so "nonterminal transcript work" (read from domain state, never
queue rows) converges and a stuck transcript can never deadlock Keep without
an operator path.

`Ready.canReplace` is true when a ready owned asset exists while
`origin != Generated`: the transcript owner exposes **Re-transcribe with
Nexus…** through the normal forecast/confirm/replace path, so caption-first
is a default, not a trap.

| Transcript state | Content / action |
| --- | --- |
| Not requested | **No transcript yet.** / **Transcribe…** |
| Not requested + `BillingRequired` | **Transcription is included with AI plans** / Review billing |
| Not requested + `TimelineBinding` | **Playback and transcription pause while Nexus verifies the copy.** / none |
| Not requested + `DurationUnknown` | **Nexus needs the item’s length before it can transcribe it.** / Keep a copy |
| Forecasting (client transient) | **Preparing transcription…** |
| Queued / Running | **Transcription queued** / **Transcribing…** |
| Ready | content + quiet provenance (publisher-authored / third-party machine / Nexus machine) |
| Ready + `canReplace` | **Re-transcribe with Nexus…** |
| Quota blocked | **Not enough transcription time for this item** / Review billing |
| Retryable failure | **Couldn’t transcribe this item** / Retry |
| Unavailable `SourceRequired`, copy keepable | **Keep a copy to transcribe this video** / Keep a copy… |
| Unavailable `SourceRequired`, copy blocked | **Transcribing this video needs a kept copy** + **Nexus can’t keep a copy while this item has saved progress, highlights, or a transcript it can’t verify.** / Discard saved timeline… |
| Unavailable `NoProviderTranscript` | **No transcript is available for this item** |
| Readable transcript, Timeline not playable | timestamp controls, **Return to {time}**, and Highlight seek are absent (not disabled); cues render as prose with non-interactive timestamps; one truthful line reuses the playback reason (`CopyBinding` / `KeptCopyRemoved` + **Open source**) |

Confirmation title is **Transcribe this video?** or **Transcribe this
episode?** Usage says **May use up to {requiredMinutes} transcription
minutes. {remainingMinutes} minutes remain this month.** when remaining is
Present, and **May use up to {requiredMinutes} transcription minutes. Your
plan has no monthly limit.** when Absent. Actions are **Start
transcription**, **Cancel**. A zero-cost caption/sidecar forecast says so;
the forecast never claims captions exist. For a video whose copy capability
is `NotKept { keep: Keepable }` and which has no kept copy, the confirmation
renders a blocking notice above the actions — **Transcribing first means
Nexus can’t keep a copy of this video later.** — and offers **Keep a copy…**
as the primary action with **Transcribe anyway** secondary; the video pane's
**Keep a copy…** affordance is visible from first open so the ordering is
discoverable without a banner.

If YouTube captions are absent and no kept copy exists, fail with
`E_TRANSCRIPT_SOURCE_REQUIRED`, projected as
`Unavailable { reason: SourceRequired }` regardless of copy state — the
`videoCopy` projection supplies the recovery action per the content table.
During a first-copy binding reservation, transcript capability is not
applicable and direct timed commands fail `E_MEDIA_TIMELINE_BINDING`; no
competing transcript job is admitted (and first-copy admission requires no
nonterminal transcript work, closing the reverse order).
Provider/network/quota failure leaves the previous readable transcript
mounted. Success atomically replaces current segments/fragments/state,
records input digest and provenance, and admits the one generic
semantic-index job — publication is the sole admitter: the
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
never a seek button. Timestamp **Play from {time}** seeks and resumes. The
one-list cut re-targets Find and highlight rendering: `transcriptPaneFind.ts`
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
end), and reattaches without seeking. The follow controller reads cue
geometry from a cached offset table rebuilt on resize and content commit,
never measuring per clock tick. A cross-cue selection still opens the
selection palette: the Highlight/Note actions render disabled with one
truthful announced line — **Select within one transcript segment to
highlight.** — while actions needing no timed anchor (Link, Share, Learn,
Ask) stay enabled; the selection is never silently ignored. The current cue
has a non-color cursor plus `aria-current`; playback never moves focus or
announces cue changes.

Moment Highlight reads the engine's authoritative position at press time
through `readPositionNow()` — never the last clock tick — and fails
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
locator, never from `authored_publication_id` inequality (provenance only,
never compared for presentation). A review-state row stays visible in the
Highlights list and Evidence/Connections with saved quote/time, keeps
**Play from {time}**, colour, note, and delete fully actionable, loses only
text-anchored actions until it resolves, and is omitted from the cue list
(nothing to paint). It renders as **Highlight needs review**.

Walknotes Capture has no independent store — its materialize step is a
Highlight write, re-targeted onto the new commands: with a current
publication it POSTs `transcript-highlights` with the waypoint position and
the server derives cue, quote, interval, and locator (client-side fragment
resolution, the fragments fetch in the materialize path, and
`E_WALKNOTE_NO_FRAGMENT` are deleted); without one it POSTs
`time-highlights` and stores a `media_time` anchor. `saveHighlightNote`
still attaches the transcribed voice note to the returned Highlight. Capture
remains the deferred, reviewed batch form of the same anchor; player
**Highlight** is the immediate form.

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
bounded spans only while the selected video engine reports Playing, the app
document is visible, and its active `VideoCanvasOutlet` is visibly attached,
with source-time start/end positions. Parked/audio-only video playback records
`Listening` — a true observation of the same engine — never `Viewing`.
YouTube embed events and owned `<video>` events are the only web evidence. No
iframe/event support means no observation, not a dwell fallback.

Wire shapes are exhaustive: `ViewingActivitySpanIn`/`ViewingActivitySpan`
gain paired `mediaPositionStartMs`/`mediaPositionEndMs` AND paired
`progressStart`/`progressEnd` under the same `Presence` pairing validator
`ListeningActivitySpanIn` uses, so video session rows populate
first/last progress like podcasts; `ActivityRequest`/`ActivityRecordIn` gain
a batch-level `timelineHandle: Presence<TimelineHandle>` required exactly
for `Listening`/`Viewing` batches over canonical timed media (the BFF
forward envelope carries the new field). `forwardMediaPositionMs` is
redefined as forward source-time advance across all timed modalities, with
schema docs and Stats labels updated to say so.

Observations are timestamped facts, not commands: at delivery the shared
gateway records the observed epoch instead of enforcing it. It accepts the
span, persists `timeline_id` plus the client-reported `binding_epoch`, and
Stats projects positions only where the recorded epoch equals the Timeline's
current epoch while `activeMs` always counts; rejecting Activity delivery
during a binding reservation is forbidden. The Timeline handle is part of
observation-lane identity: any change to the session's handle — including an
epoch bump observed through SSE — closes the open span at the change instant
and opens a new one, exactly as a media or modality change does. On
suspension (document hidden, `pagehide`, Android `onPause`) the adapter
closes its open span and issues a `keepalive` position write before the
runtime suspends; a span not closed before suspension is discarded, never
persisted open-ended.

Podcast Listening capture moves with its host, not its owner: the browser
Listening observer in `browserPlayerRuntime.tsx` becomes the BrowserAudio
engine's observation emission under D, and `NativeConsumptionRecorder.kt`
keeps Android Listening spans under the renamed PlaybackState vocabulary;
both keep paired positions and now attach the session `timelineHandle`.

## Files and non-overlapping work

One owner edits each shared seam. Contracts land before consumers, in a
dependency-free contracts step that precedes A: the closed `ApiErrorCode`
additions with status mappings; the Timeline port type; the owner-neutral
published ports (`lib/consumption/observationPort.ts` `EngineObservation` —
media ref, modality, playing, canvas-attached, source start/end positions,
`timelineHandle`; the moment-Highlight client port; `VideoCanvasOutlet`;
the `TimelineClock` read port; engine-capability types); and
`api/routes/__init__.py` as an append-only registration slot each backend
workstream fills in its own commit, ordered so every router owning a static
`/media/<literal>` path registers before the `media` router. Directory-level
ownership in this table means the named files only, never the whole
directory.

| Workstream | Exclusive files / responsibility | Depends on |
| --- | --- | --- |
| A. Persistence | `migrations/alembic/versions/<next>_durable_video_copy_timed_media.py`, `python/nexus/db/models.py`, `python/nexus/db/retries.py`, migration proof. Owns all schema/backfill/job-row migration and the constraint/index rewrite list; no services. | contracts |
| B. Copy lifecycle/storage/queue | new `schemas/video_copy.py`, `services/video_copy*.py`, `services/source_attempt_cancellation.py`, `tasks/acquire_video_copy.py`, `api/routes/video_copies.py`; `services/{media_source_types,source_publication,source_attempt_failures,media_activity,public_source_urls,public_resource_sharing,media_deletion,redact}.py`, `schemas/media_activity.py`, `tasks/{storage_object_cleanup,storage_orphan_sweep,media_teardown}.py`; `jobs/{registry,queue,worker,process_executor,dead_letter_projections}.py`; `storage/{paths,client}.py`; `config.py`; backend image/Compose (`worker-copy` service), `deploy/hetzner/{docker-compose.yml,cloud-init.yml,release.py}`, `deploy/cloudflare/{r2-lifecycle.example.json,apply-r2-lifecycle.sh}`, `deploy/smoke/*`. Calls C's Timeline port and integrates E's exported job definition; no Media DTO/player UI. `deploy/cloudflare/r2-cors*` is NOT edited. | contracts, A, C Timeline port, E provider port |
| C. Media composition/playback API | new `services/media_timelines.py`; `services/{media,media_source_ingest,playback_source,youtube_provider_lock,sealed_handles,capabilities,document_embeds}.py`, `services/podcasts/ingest.py`, `services/resource_items/action_snapshots.py`, `schemas/resource_action_snapshots.py`, `api/routes/stream.py`, Consumption `service.py` (playback half), `_listening_store.py` -> `_playback_store.py` (rename in place), `_projection.py`, playback schemas/route incl. `preview-position`, Next BFF routes, `lib/media/{mediaDetail,playback,useMediaProcessingStatus,documentEmbeds}.ts`, `lib/lectern/contract.ts`. Sole owner of Timeline creation/lock/epoch gateway and `read_event_snapshot`; calls E's exported transcript operation. No Activity store or React runtime. | contracts, A, B DTO, E operation |
| D. Player/runtime/platform | `apps/web/src/lib/player/*` (incl. `PlayerVideoCanvas.tsx`, `playbackHeartbeat.ts`), `components/player/*`, `lib/security/{csp,headers}.ts` + `lib/env.ts` media-origins entry, Android playback/protocol sources and fixture: `testdata/android/player-protocol.json`, `testdata/manifest.json` (protocol artifact entry), `apps/web/androidPlayerProtocolCorpus.ts`, `apps/web/{next.config.ts,vitest.config.ts}`, `apps/android/app/build.gradle.kts`, `AndroidManifest.xml`, `app/src/main/java/app/nexus/android/playback/*` (incl. `NativeActivityOutbox.kt`, `NativeConsumptionRecorder.kt` playback vocabulary), `NexusWebView.kt`, `MainActivity.kt`. Owns TimedMedia session, engines, canvas outlet, chrome, rate, and engine-observation emission against G's published port (never imports F or G). | contracts, A, C, published ports |
| E. Transcript kernel | `services/transcripts/*` (incl. new `segmentation.py`, `state.py` mapping), Podcast transcript admission/provider modules (`transcription_usage.py`, `transcription_reservation_settlement.py`, `transcription_failure.py`, `episodes.py` eligibility), `transcript_segments.py`, transcript schemas/routes/tasks incl. `api/routes/podcast_transcripts.py`, `tasks/reconcile_stale_ingest_media.py`, `services/transcripts/semantic.py`; a named carve-out for the `begin_extraction`/semantic-intent deletions in `media_source_ingest.py` (landed on C's contract). Owns durable video transcript/generic naming and exports the operation/job definition; no pane React. | contracts, A |
| F. Product/timed reading/Highlight | media-pane transcript components/styles/controllers: `app/(authenticated)/media/[id]/{MediaPaneBody,TranscriptPlaybackPanel,TranscriptContentPanel}.tsx`, `transcriptPaneFind.ts`, `useHostedTextHighlights.ts`, `lib/media/{transcriptView,transcriptChapters,timedTranscript,videoCopy,timedMediaCopy}.ts`, `lib/highlights/timeHighlights.ts`, `lib/actions/{resourceActions.ts,resourceActionRuntime.tsx}`, `lib/walknotes/walknoteSession.ts`, selection/copy clients, Highlight schema/routes/services and all anchor consumers — `auth/permissions.py` first, then `highlight_access.py`, `highlights.py`, `text_quote.py`, `passage_anchors.py`, `reader_locations.py`, `reader_evidence_markers.py`, `chat_reader_selection.py`, `schemas/{retrieval,reader}.py`, `public_resource_sharing.py` anchor arms, `vault.py`, `vault_contracts.py`, `services/resource_items/capabilities.py` (frontend `resourceCapabilities.ts` is regenerated, never hand-edited), `e2e/resourceActionProductOracle.ts`, `resourceActionApplicability.oracle.unit.test.ts`, `scripts/test-resource-action-surface-policy.mjs`, `e2e/journeys/resource-action-parity.journey.spec.ts`. Owns content sign-off, follow, selection, moment client, deletes pane dwell; no player or Activity policy. | contracts, B, C, E, published ports |
| G. Activity | `schemas/consumption_activity.py`, `services/consumption/{_activity_store,_activity_stats}.py`, the activity command surface of Consumption `service.py` (`record_activity_batch`, `_record_activity_batch_op`, `_validate_activity_batch` — edited only after C's rename commit), `api/routes/consumption_activity.py`, `lib/consumption/{activityContract,activityRecorder,activityRuntime,activityOutbox,historyBff.server}.ts`, and its published observation port. D emits engine observations; G turns them into ledger spans. It does not edit player/pane state or replace reader activity. | contracts, A, C handle type |
| H. Integration/residue/docs | composition/residue/docs only: `testdata/proofs.json` + `testdata/faults/**` + `testdata/manifest.json` fixture entries, `python/nexus_test_control/{model,policy,build}.py` (risk ownership SHA, retired paths, CSP media origins), journey replacement, `docs/modules/*` (named edits below), `docs/local-rules/codebase.md` (both normative native rules), `docs/architecture.md` stale references, release checklist. May only compose published contracts. | A-G |

Named H doc edits: `docs/modules/jobs.md` lane sentence;
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
`playback-state`, `preview-position`, transcript forecast/request,
`time-highlights`, and `transcript-highlights` exactly; delete the old
`listening-state` directory.

Cutover order is contracts (error codes, Timeline port, observation port,
router slots) -> A migration proof -> C Timeline port -> E ports -> B -> C
projections -> G -> D -> F -> H residue. Deployment is the repository's real
release procedure — there is no maintenance mode or drain: (1) land the full
implementation and protocol corpus without promoting web; (2) tag, certify,
and publish the stable non-draft signed Android release from that exact
source with the new corpus digest, so the `deploy/hetzner/release.py`
player-protocol stable-manifest preflight can pass; (3) close Nexus on
Android, stop admission, cancel every nonterminal `acquire_video_copy`
(the 30-second container stop budget cannot drain a two-hour job), then let
`_stop_writers` stop `worker-background`/`worker-copy`, `worker-interactive`,
and `api`; (4) run the A migration in the release one-off — it asserts zero
old job-kind rows across all statuses — then the production release; (5)
after `/version` proves the new identity, install the new APK, run the
device smoke, and verify post-deploy smoke: `/media/{id}/listening-state`
404s and `/media/{id}/playback-state` answers. The previously installed APK
shows the non-retryable **Update Nexus for Android** state for the whole
window; before the window, the operator confirms the native activity outbox
is drained (`activitySync = Synced`) — any span still queued at APK
replacement is intentionally discarded.

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
  top-level `transcript_origin` Presence field superseded by `Ready.origin`;
- synchronous YouTube caption fetch in the HTTP request; the `dry_run`
  two-call transcript request pattern, the dry-run forecast audit write, and
  `media_transcript_requests.dry_run` (existing forecast-outcome audit rows
  are deleted by the migration);
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
| A schema/timeline | `pytest:python/tests/migrations/test_durable_video_copy_timed_media_migration.py::test_cutover_converges_identity_and_job_rows` | `migration-compatibility` | real upgraded Postgres catalog + rows (constraint list, digest constant, deleted-row counts) |
| B admission/cancel/progress | `pytest:python/tests/service/test_video_copy_admission.py::test_keep_cancel_and_progress_converge_exact_work` | `durable-job-replay` | committed rows + queue lease + timed writer on both sides of the Timeline lock; two concurrent Adds; concurrent primary ingest + Keep both publish; cross-media Idempotency-Key mismatch; dead-letter leaves `Failed` + cleared binding |
| B queue cancellation substrate | `pytest:python/tests/service/test_job_cancellation_transitions.py::test_request_cancel_and_heartbeat_union_survive_all_transitions` | `durable-job-replay` | `Owned \| CancelRequested \| Lost` across claim, pre-execution heartbeat, `fail_job`, reschedule, shutdown release, requeue-dead, dead-letter |
| B resource envelope | `pytest:python/tests/service/test_video_copy_resource_envelope.py::test_copy_respects_process_and_disk_bounds` | `durable-job-replay` | measured process tree (peak RSS, peak PIDs) + filesystem bytes, driving the production code path with controller-supplied small settings; fail-closed refusal, short-write/`ENOSPC`, exact-directory cleanup, no secret env in the child; production values asserted by a static configuration proof + the release probe |
| B publication | `pytest:python/tests/service/test_video_copy_publication.py::test_copy_publication_converges_across_faults_and_corruption` | `database-object-convergence` | real Postgres + MinIO bytes, same-length corruption, timed-writer interleaving, kill between publication commit and queue success, served object headers |
| B teardown | `pytest:python/tests/service/test_video_copy_teardown.py::test_remove_and_cleanup_converge_exact_object` | `database-object-convergence` | removal ledger + cleanup ledger + MinIO listing before/after a full orphan sweep; `RemovalFailed -> Removing -> completed`; deletion within the stated `Removing` bound; teardown of a Media with copy/timeline/publication/anchors; re-Add-then-Keep yields a fresh Timeline at epoch 0 |
| C playback/ticket | `pytest:python/tests/service/test_timed_media_playback.py::test_source_and_ticket_authorization_fail_closed` | `database-object-convergence` | sealed-handle API + object request log; forged handle, cross-type replay, stale epoch; no signed query in any log/row; SSE stays open on `ready_for_reading` and delivers `Queued -> Keeping -> Kept` |
| D session/engine/chrome | `vitest:apps/web/src/lib/player/timedMediaPlayer.browser.test.tsx` | `android-player-protocol-skew` | competing/stale timelines; real browser media node + manifested tiny MP4 + SSE epoch change; zero CSP violations; landmark/focus/parked a11y assertions |
| D YouTube engine | `vitest:apps/web/src/lib/player/youtubeEngine.browser.test.tsx` | provider-native transport invisible to Nexus | locally served fake embed API (`getCurrentTime`/rates/state/rate-change events) |
| D ticket renewal | `vitest:apps/web/src/lib/player/ownedVideoTicketRenewal.browser.test.tsx` | lost position / silent stall at ticket expiry | MinIO URL with forced expiry; mid-playback swap restores position/paused/rate |
| D canvas projection | `vitest:apps/web/src/lib/player/playerVideoCanvas.browser.test.tsx` | video escapes its outlet or occludes required chrome | clipping at the pane scroll boundary, occlusion vs Now Playing/selection popover, focus order, parked state |
| E transcript publication | `pytest:python/tests/service/test_media_transcript_publication.py::test_current_publication_replaces_atomically` | `citation-provenance-identity` | real rows/fragments before and after interruption/epoch change; two-word-per-cue caption fixture publishes sentence-scale disjoint cues |
| F transcript follow | `vitest:apps/web/src/lib/media/timedTranscript.browser.test.tsx` | `citation-provenance-identity` | involuntary seek/focus; real selection, scroll, focus, media events; Find + highlight painting over the one-list view; responsiveness at the cue ceiling |
| F temporal Highlight | `pytest:python/tests/service/test_temporal_highlights.py::test_timed_anchors_survive_replay_and_transcript_replacement` | `citation-provenance-identity` | real rows with repeated quote and epoch fixtures; two presses 100 ms apart + one dropped response + retry; SQL/ORM readability twins agree for all four kinds; author list read-back via `GET /media/{id}/highlights` and search |
| G activity (browser) | `vitest:apps/web/src/lib/consumption/actualVideoActivity.browser.test.tsx` | `durable-consumption-activity` | emitted observations under play/hidden/parked/epoch states |
| G activity (ledger) | `pytest:python/tests/service/test_timed_media_activity_ledger.py::test_timed_spans_bind_timeline_and_survive_stale_epoch_delivery` | `durable-consumption-activity` | real Postgres rows across an epoch bump; backfilled rows at epoch zero; Stats `forwardMediaPositionMs`/`viewingActiveMs` on both sides |
| D Android protocol | `gradle:apps/android/app/src/test/java/app/nexus/android/playback/PlayerProtocolTest.kt` | `android-player-protocol-skew` — amend the already-registered node, do not create a second (`proof-unique-owner`) | canonical protocol fixture rejects old digest/vocabulary; covers a rejected stale-epoch native write; red = current corpus rejecting the new vocabulary at the base SHA |
| D Android WebView video | instrumented `androidTest` under the `android-device` capability | `android-player-protocol-skew` | real `NexusWebView`: gesture-free play after awaited ticket fetch; video start dismisses native session and native never auto-resumes; rotation preserves session/position; backgrounding closes the span and flushes position — routed into `./scripts/test release`; the Chromium proof is not Android evidence |

Workstream H also amends existing risk nodes: `database-object-convergence`
gains the video-copy/cleanup source globs and the B publication/teardown
proofs; `durable-job-replay` gains the queue-cancellation proof (its globs
already cover `jobs/**` and `errors.py`); `durable-consumption-activity`
gains the renamed activity files and the new ledger proof.

AC16 is bound to owners: keyboard, visible focus, focus return,
`aria-current`, forced-colors, and reduced-motion assertions live in the D
player and F transcript-follow browser proofs; 320 px, 400% zoom, safe-area,
and 44 px checks in a named mobile-surface proof; and the final work report
records a deliberate manual assistive-technology review of the player chrome
and transcript follow (apps/web has no automated a11y harness).

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
   non-production ranged-GET object check, and bounded provider certification
   into and run `./scripts/test release`.

Do not duplicate edge cases in the journey or claim production R2 recovery from
MinIO proof.

## Acceptance criteria

1. Two concurrent Keep commands for one YouTube identity converge to one Media,
   one active attempt and one job; queued/running Cancel converges without bytes
   or a live lease; a copy attempt is never automatically retried.
2. First Keep rejects Tier-1 pre-copy timed facts with `TimelineUnproven`;
   Tier-2 derived facts are reset only behind the acknowledged dialog;
   accepted work reserves/bumps Timeline, and every direct timed writer fails
   the shared epoch fence until publication/cancel/failure. **Discard saved
   timeline** deletes exactly the content-bound timed facts, bumps the epoch,
   preserves Media/Library/Lectern/notes/links, and restores `canKeep`.
3. No state says `Kept` before timeline conformance, local hash,
   checksum-verified upload, object `HEAD`, and lease-fenced DB publication
   that rechecks the binding and installs immutable Timeline identity plus
   the probed duration as the single authority.
4. Killing the worker at every external/DB boundary — including between the
   publication commit and the queue success transition — converges to one
   live asset or no object; stale work never publishes.
5. After the original returns a definitive unavailable result, reload selects
   and seeks the kept copy from private R2 without an external fallback.
6. An unbound first-copy failure restores external playback. Kept-copy failure
   and bound-copy removal never silently open the original inside Nexus;
   Previous after a Remove presents `KeptCopyRemoved` + **Open source**, and
   natural end skips a mid-binding or unavailable successor.
7. Remove unpublishes first, deletes bytes durably within the stated
   `Removing` bound, and preserves Media, Timeline, transcript, progress,
   Highlights, notes, and relationships. The append-only removal ledger
   retains every removal generation; Nexus stays unplayable until identical
   Re-Keep, and non-identical bytes cannot bind old state. After whole-Media
   delete, Add-then-Keep yields a fresh Timeline at epoch zero with no
   residual object.
8. Podcast and video expose exactly one `Media player` landmark, one session,
   and one authoritative source-time timeline across pane navigation; the
   canvas clips at its pane's scroll boundary and never paints over the pane
   header, strip, or a neighbouring pane; an ingest admitted while a copy
   runs still completes within its normal envelope.
9. A confirmed video rate change persists; an unconfirmed or unavailable rate
   is never shown as active and never fails the session; a discrete-rate
   engine offers only rates it can apply and every offered rate takes
   effect; `Shorten pauses` is absent for unsupported engines and still works
   for supported Android Podcast audio.
10. Transcription starts only after the explicit command, survives reload, uses
   captions before hosted ASR, renders every closed lifecycle state, and
   atomically publishes timed current content. A queued/running/failed/
   cancelled supplemental attempt produces no Activity row, no
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
    positions; parked playback records `Listening`, never `Viewing`; hidden
    document and pane dwell alone record nothing; 30 minutes of hidden-tab
    playback still persists the true resume position.
16. Keyboard, screen reader, forced colors, reduced motion, 400% zoom, 320 px
    width, safe areas, and 44 px frequent mobile targets pass on real
    surfaces; captions render on owned video whenever a publication exists,
    including fullscreen. On Android: video plays with the native service
    dismissed and it never auto-resumes on video pause; a backgrounded
    podcast session at natural end never starts a video; an active WebView
    video session survives rotation and theme change.
17. Residue is mechanized, not grepped ad hoc: deleted frontend symbols and
    routes land in `RETIRED_RESOURCE_ACTION_RESIDUE` (enforced by the surface
    policy script); deleted Python modules/paths land in
    `nexus_test_control/policy.py` retired tuples; zero old job-kind rows is
    asserted by the A proof and post-deploy smoke;
    `testdata/proofs.json#journeys` still holds exactly 15 entries with
    `podcast-refresh-playback` absent; single-owner, fence, unreserved-write,
    and exhaustive-anchor properties are asserted behaviorally by the
    canonical proofs and type checking. Searches also cover: raw wire UUIDs,
    supplemental primary-progress leaks, unfiltered latest-attempt lookups,
    the old two-value terminal-status shorthand, `transcript_origin`,
    `can_play`, deleted lifecycle state keys, inline restatements of owned
    copy strings, and direct `httpx`/`requests` in transcript/copy lanes.

## Final state

Nexus owns one durable, immutable representation of an authorized video and can
play it after the original disappears. Podcast and video are projections of one
timed-media substrate: one Timeline, state, session, chrome, transcript
publication, Highlight system, and activity truth. Provider instability stays
behind durable jobs; storage truth stays behind verified DB publication; UI
claims only what those facts prove. Everything beyond this narrow cut has a
clean capability seam and no speculative implementation.
