# Android Native Player and Pause Shortening — Hard Cutover

Status: IMPLEMENTED IN SOURCE — focused backend, web, Android, production-build,
and real-stack browser proof passed. Full Android instrumentation is host-limited;
physical-device, real-media, CI, signed-release, deploy, and production gates
remain pending — 2026-07-30

Type: hard cutover. One Android player, one pause-shortening contract, no
legacy silence detector, fallback player, compatibility protocol, dual
heartbeat, feature flag, or backward compatibility.

No blocking question remains.

## Decision

- Android podcast and PreviewAudio playback moves from the WebView
  `HTMLAudioElement` to one Media3 `MediaSessionService`.
- Product label: **Shorten pauses**.
- First release modes: `Off | Natural`; default `Off`.
- `Natural` uses Media3's built-in silence processor without Nexus-authored DSP
  thresholds.
- The durable default is Android-device-local. A canonical session may override
  it transiently, and an active subscription may override it with
  `Use device default | Off | Natural`.
- Original source time remains canonical for progress, resume, chapters,
  transcripts, captures, completion, and Media Session.
- Non-Android browsers retain the current browser player but do not support
  pause shortening.
- Android never falls back to WebView audio. A missing native capability is a
  visible player failure.

Assumptions:

- Android screen-off listening is the primary use case.
- [`playback-rate-policy-hard-cutover.md`](playback-rate-policy-hard-cutover.md)
  lands first; all of its rate semantics remain.
- Pin every Media3 artifact added here to exactly `1.10.1`. The offline cutover
  must use the same version; mixed Media3 versions are a defect.
- Background playback covers the current item. Starting a successor while the
  WebView is suspended is excluded.

## Governing and Superseded Contracts

- `docs/rules/{boundaries,cleanliness,codebase,concurrency,control-flow,
  correctness,database,effect,effect-services,errors,frontend}.md`
- `docs/rules/{keys-and-identities,layers,mutation-ordering,naming,retries,
  simplicity,tagged-unions,testing,timing}.md`
- `docs/local-rules/{codebase,testing_standards}.md`
- `docs/{architecture.md,chapbook.md}`
- `docs/modules/{player,podcast,consumption-activity}.md`
- `docs/cutovers/{lectern-player-lifecycle,global-player-surfaces,
  media-progress-reset,playback-rate-policy}-hard-cutover.md`
- `docs/cutovers/android-episode-offline-downloads-hard-cutover.md`, when
  present

This document supersedes:

- WebView audio, browser Media Session, heartbeat, activity, and silence-DSP
  ownership inside the Android shell;
- every playback-rate-spec silence-trim clause, including its temporary trim
  rate, observed-rate exclusion, and Media Session divergence;
- the playback-rate spec's `HTMLMediaElement` engine on Android;
- the lifecycle spec's blanket "SetUnread advances no fencing token" clause:
  heartbeat fences remain unchanged, but every explicit override write advances
  the new completion-only override revision;
- the offline-download spec's native-player non-goal and WebView local-range
  playback path, when that sibling cutover is present.

All session, origin, history, completion, Lectern, rate-resolution, download,
cache, and Consumption semantics not explicitly changed here remain
authoritative.

## Goals

1. Natural, opt-in pause shortening that never changes canonical source time.
2. Correct screen-off playback, progress, activity, notification, lock-screen,
   headset, interruption, and route behavior.
3. One semantic Player capability with exactly one runtime owner per platform.
4. Session, podcast, and device-default control without a generic preference
   subsystem.
5. Delete the unsafe CORS/rAF silence path and its hidden compressor coupling.
6. Reuse Media3, Consumption, Lectern, Player surfaces, subscription settings,
   exact WebKit transport, and offline cache owners.

## 80/20 Scope

Included:

- one Android `MediaSessionService`, `ExoPlayer`, `MediaSession`, notification,
  audio focus, becoming-noisy handling, and `MediaController`;
- canonical podcast and PreviewAudio transport through the native runtime;
- stock Media3 pause shortening, current-session control, device default,
  subscription override, and one device-local estimated time-saved counter;
- native listening heartbeat and Listening activity through the existing BFF
  APIs and fencing contracts;
- strict origin/account/session-fenced WebKit commands and pushed snapshots;
- one fenced natural-end settlement command plus one durable pending-end receipt
  used identically while connected and disconnected;
- bounded native persistence recovery and screen-off-visible suspension;
- browser-runtime cleanup and transparent output-effect bypass;
- shared Media3 cache/source selection when offline downloads exist;
- focused backend, web, Android, real-stack, and physical-device proof.

Excluded:

- additional aggressiveness modes or raw threshold controls;
- custom DSP, AudioWorklet pause shortening, CORS relay, transcoding, or a
  shortened audio derivative;
- VAD/ASR/ML, temporal-transform sidecars, intro/outro, ad, chapter, or
  semantic skipping;
- server-synced, cross-device, or per-podcast savings; analytics,
  recommendation, or learning;
- browser/PWA pause shortening, iOS, Cast, Remote Playback, or Android Auto
  browsing;
- native volume boost or mono; those remain browser-only output effects;
- sleep timer, end-of-episode timer, or timer notification state;
- background successor start, native Lectern/queue ownership, or native
  completion API execution;
- automatic player-session restoration after process death; canonical resume
  remains;
- cross-device device-default sync or a new user-preference table;
- new backend endpoints, event bus, workflow, generic bridge, or player state
  library; the existing Consumption-command endpoint gains one strict command.

## Target Behavior

### Policy

```text
PauseShorteningMode = Off | Natural

effectiveMode =
  Off
  when PreviewAudio
  else sessionPauseShorteningMode.value
  when sessionPauseShorteningMode is Present
  else subscription.pauseShorteningMode.value
  when subscription.pauseShorteningMode is Present
  else deviceDefaultPauseShorteningMode
```

- `Off` is acoustically and temporally transparent.
- `Natural` shortens eligible pauses through Media3 while retaining its stock
  padding/ramps.
- A newly loaded canonical session starts with no session override. Source
  replacement, dismissal, and natural successor clear it.
- The player control changes only the current session. It never silently writes
  a podcast override or device default.
- A successful podcast-settings PATCH or unsubscribe synchronously installs the
  decoded subscription state through the playback-rate cutover's shared
  settings-install primitive. When no session override exists, the active
  session immediately re-resolves and applies it. On Android that primitive
  sends one atomic `InstallPodcastPlaybackSettings`; the command installs only
  the already-decoded playback-rate and pause-shortening response and performs
  no server mutation.
- Changing the device default immediately re-resolves only an active canonical
  session with neither a session nor podcast override.
- PreviewAudio is always `Off` and writes no heartbeat, activity, preference,
  or saved-time fact.
- No raw dB, milliseconds, retention ratio, or algorithm branding reaches UI.

### UX

- Rename **Audio effects** to **Playback** as required by the playback-rate
  cutover.
- Android Playback panel order:
  1. playback-rate controls;
  2. **Shorten pauses** `Off | Natural`;
  3. provenance: `This session | This podcast | Device default`;
  4. applicable **Use podcast/device setting**,
     **Remember for this podcast**, and **Make default on this device** actions;
  5. `Saved on this device · {duration}` when greater than zero;
  6. output-effects unavailable copy only when the existing section would
     otherwise be shown.
- Subscription settings add **Shorten pauses**:
  `Use device default (currently {mode}) | Off | Natural`.
- The control remains interactive under every provenance. **Remember for this
  podcast** stores the current mode and clears the equal session override after
  the decoded response installs. **Make default on this device** is explicit;
  an existing podcast override still wins.
- Do not announce each shortened pause. Preference changes use the existing
  player status region.
- Browser Playback omits Shorten pauses. It does not show a nonfunctional
  toggle.

### Lifecycle

- Screen lock, Activity pause, or WebView timer suspension never pauses the
  native player or its recorders.
- Pause, source change, Reset Progress, dismiss, and failure best-effort flush
  the latest canonical source position and close current activity.
- Every Android canonical natural end, connected or disconnected:
  1. closes and best-effort flushes current activity, then captures the terminal
     source-position observation;
  2. persists one account-bound `PendingNaturalEnd` receipt containing that
     observation before publishing `Ended` or stopping;
  3. delivers or replays that same receipt to the web;
  4. settles it session-less through the existing Lectern FIFO and
     Consumption-command endpoint, atomically persisting terminal progress and
     completion;
  5. acknowledges it only after a replay-ledger-recorded terminal outcome and
     canonical response installation.
- Receipt settlement always executes. Matching the current native `Ended`
  session gates only `PausedAtEnd`/successor presentation. A stale or
  process-death receipt installs canonical results headlessly and starts
  nothing.
- A matching foreground settlement may start the canonical returned successor
  only after acknowledgement. Reconnect never auto-starts a successor.
- One receipt is allowed. While it is pending, canonical replay/replacement is
  transport-locked exactly like the current completion flow; no second receipt
  can overwrite it.
- A process killed during active playback stops audio. The next explicit Play
  resolves canonical resume state; no hidden session restoration exists.

## Final Architecture

```text
GlobalPlayerProvider                         semantic session/UI owner
├── playerSession.ts                         origin/history/end transitions
├── BrowserPlayerRuntime                     non-Android only
│   ├── one HTMLAudioElement
│   ├── browser Media Session
│   ├── existing listening heartbeat/activity
│   └── browser output effects
└── AndroidPlayerClient                      Android only
    └── exact nexusPlayer WebKit protocol
        └── MediaController
            └── NexusPlaybackService
                ├── one ExoPlayer
                ├── one MediaSession
                ├── Media3 silence processor
                ├── NativeConsumptionRecorder
                │   ├── listening heartbeat
                │   └── Listening activity batches
                ├── NexusOriginClient
                └── OfflineMediaStore/CacheDataSource, when present

canonical observations
  -> existing /api BFF
  -> existing Consumption service
```

| Concern | Sole owner |
|---|---|
| Session/origin/history/end presentation | `playerSession.ts` + `GlobalPlayerProvider` |
| Browser audio runtime | `BrowserPlayerRuntime` |
| Android audio/runtime lifecycle | `NexusPlaybackService` |
| Android web/native adaptation | `AndroidPlayerClient` / `NexusPlayerBridge` |
| Source-time progress and activity facts | existing Consumption service |
| Android heartbeat/activity capture | `NativeConsumptionRecorder` |
| Device default | Android app preferences |
| Podcast override | Podcasts subscription service/table |
| Download bytes/cache/index | existing `OfflineMediaStore` |
| Player presentation | existing shared player surfaces |

The browser runtime is a canonical non-Android implementation, not an Android
fallback. `GlobalPlayerProvider` selects one runtime once from the render
environment; a successful native handshake is Android capability truth.

## Capability Contract

```text
PauseShorteningSettings =
  Unavailable { reason: RuntimeUnsupported }
  | Available {
      deviceDefaultMode: PauseShorteningMode
      podcastOverride: Presence<PauseShorteningMode>
      sessionOverride: Presence<PauseShorteningMode>
      effectiveMode: PauseShorteningMode
      provenance: Session | Podcast | Device
      mutation:
        Idle
        | Pending { scope: Podcast | Device }
        | Failed { scope, retryable, message, retry }
    }

PlayerSettingsCapability {
  ...
  outputEffects
  outputEffectsAvailability
  pauseShortening: PauseShorteningSettings
}

PlayerTimelineCapability {
  ...
  pauseShorteningSavedOnDeviceMs: Presence<nonnegative int>
}

PlayerCommandsCapability {
  ...
  setOutputEffects(patch)
  setSessionPauseShorteningMode(mode)
  clearSessionPauseShorteningMode()
  rememberPauseShorteningForPodcast()
  setDeviceDefaultPauseShorteningMode(mode)
}
```

Rules:

- `pauseShorteningSavedOnDeviceMs` is present only in the Android native
  capability. It is a device-local conservative estimate, survives sessions,
  and resets only when app data is cleared; there is no reset action.
- Remove `AudioEffectsState.silenceTrim`, `isSilenceTrimming`,
  `silenceTimeSavedMs`, and `setAudioEffects`.
- The playback-rate capability remains preferred/temporary/base/observed as
  specified. Android applies `base`; native heartbeat persists
  canonical `rateState.episodeRate`, not an inherited preferred value.
- Android snapshots are authoritative for audible phase, position, duration,
  buffered position, volume, observed base rate, persistence, failure,
  pause-shortening provenance, and saved time. React leaves never infer them.
- Remember/default actions freeze one intent while pending and use the existing
  player status region. Podcast `E_NOT_FOUND` installs an absent subscription
  override, retains the session mode, and fails non-retryably; other unknown
  outcomes expose same-intent Retry.

## Database and Backend API

Migration: the next actual Alembic head after the playback-rate migration. Read
the landed head immediately before implementation; do not reserve a number.

```text
NNNN_android_native_player_pause_shortening.py

podcast_subscriptions.pause_shortening_mode TEXT NULL
consumption_overrides.revision INTEGER NOT NULL
```

- `NULL` means `Use device default`.
- Canonical values are `Off | Natural`.
- The subscription column has no default, backfill, index, replacement check
  constraint, settings table, or downgrade path.
- Existing override rows initialize `revision = 0`. Every later explicit
  `Finished | Unread`, Undo, and natural-end write increments it in the sole
  Consumption state store. Reset deletion is separately fenced by
  `resetEpoch`.
- Add no index, alternate state table, or downgrade path.
- Subscription rows retain nullable storage shape. Domain/API output uses
  `Presence<PauseShorteningMode>`.

Extend the existing subscription settings mutation:

```text
PATCH /podcasts/subscriptions/{podcast_id}/settings

omit key: no change
set:       "pause_shortening_mode": { "kind": "Present", "value": "Natural" }
inherit:   "pause_shortening_mode": { "kind": "Absent" }
```

Raw `null`, lowercase values, unknown values, and legacy booleans are rejected.
Return the required Presence field from subscription status/list/detail/library
projections.

Extend the canonical player descriptor:

```text
FooterAudioActivation {
  ...
  playbackRate: PlaybackRateResolution
  pauseShorteningMode: Presence<PauseShorteningMode>
  consumptionOverrideRevision: Presence<nonnegative int>
}
```

- Podcasts exposes one narrow batch query for active-subscription overrides.
- Consumption composes that query while building both Lectern activations and
  batched Player descriptors. It does not read the subscription table directly.
- Missing subscription or override projects `Absent`.
- Both descriptor paths must emit the identical value.
- The shared podcast-settings client publishes the exact decoded PATCH response.
  The active player subscribes once and installs only a matching podcast ID.
- Heartbeat and activity schemas/endpoints do not change. The existing
  Consumption-command endpoint gains the one command below; no endpoint is
  added.

### Natural-end settlement

Hard-cut Android natural end away from the current two-command
`FinishLecternItem`/fallback flow. Manual Consumption actions retain their
existing commands.

```text
SettleNaturalEnd {
  kind: "SettleNaturalEnd"
  clientMutationId: UUID
  mediaId: MediaId
  origin: Direct | Lectern { itemId }
  terminalListening: {
    positionMs: nonnegative int
    durationMs: Presence<nonnegative int>
    episodePlaybackRate: Presence<float 0.5..3>
    expectedWriteRevision: nonnegative int
    expectedResetEpoch: nonnegative int
  }
  expectedConsumptionOverrideRevision: Presence<nonnegative int>
  nextCapability: "FooterAudio"
}

outcome =
  Completed
  | CompletedWithoutAdvance
  | Superseded
  | TargetGone
```

- Run inside the existing viewer lock, serializable transaction, replay ledger,
  canonical Lectern snapshot build, and projection-invalidation path.
- Resolve target visibility first; a missing/no-longer-readable target records
  `TargetGone`. For an existing target, compare both listening fences and the
  exact override-revision Presence before any progress, completion, read-state,
  Lectern, or collection write. A mismatch records `Superseded` with no domain
  writes.
- On a match, write `terminalListening` with zero dwell through the existing
  listening store, then apply completion in the same transaction. This is the
  durable terminal position after process death; it is not a second heartbeat
  protocol. The completion write advances the override revision.
- Exact `Lectern(itemId, mediaId)` agreement finishes/removes the item and may
  return the server-selected next `FooterAudio` item.
- `Direct`, or a stale Lectern origin, performs state-only completion and
  records `CompletedWithoutAdvance`; it never selects a successor.
- `TargetGone` performs no domain writes. Valid terminal no-op outcomes are
  responses, not thrown 4xx errors, so the receipt can be acknowledged.
- Record every terminal outcome memo before commit and return the canonical
  snapshot. Byte-identical replay reads that memo and rebuilds a fresh canonical
  snapshot without rerunning domain writes. Same ID/different body is the
  existing replay-mismatch defect.
- Add one narrow `LecternCapability.settleNaturalEnd(receipt)` that enters the
  existing FIFO without requiring a live `AudioSession`. Its promise resolves
  only after canonical installation. Retryable/unknown failure remains parked
  and visible through `LecternMutationNotice`; it never acknowledges the
  receipt.
- Before entering the FIFO, web verifies the receipt account against the
  authenticated account. The command body omits native-only `accountId` and
  `sessionKey`; the BFF viewer context remains the sole account authority.

## Web/Native Protocol

Install one AndroidX WebKit listener named `nexusPlayer`.

- Exact owned origin, main frame, verified `sourceOrigin`.
- Exact JSON keys, bounds, PascalCase variants, canonical UUIDs.
- `protocolVersion: 1`; mismatch is rejected, never negotiated.
- UUID `requestId`; replies echo it.
- `sessionKey` fences every session command and pushed state.
- Push changes; `GetSnapshot` is connect/resume reconciliation, never polling.
- `RenderEnvironment.androidShell` is only the expectation. Successful
  `Connect` is capability truth.
- Bound each request with
  `NATIVE_PLAYER_COMMAND_DEADLINE = 5.seconds`. An ambiguous timeout reconciles
  with `GetSnapshot`; it does not invent local state.

```text
Commands =
  Connect { requestId, protocolVersion, accountId }
  | GetSnapshot { requestId, protocolVersion }
  | LoadCanonical { requestId, protocolVersion, sessionKey, session, rateState }
  | LoadPreview { requestId, protocolVersion, sessionKey, descriptor }
  | Play | Pause | SeekTo | SkipBy | SetVolume
  | SetPlaybackRateState
  | SetSessionPauseShorteningMode
  | ClearSessionPauseShorteningMode
  | InstallPodcastPlaybackSettings
  | SetDeviceDefaultPauseShorteningMode
  | Drain
  | AdoptListeningState
  | RetryPersistence
  | Dismiss
  | AcknowledgeNaturalEnd

Reply =
  Connected { snapshot, pendingNaturalEnd }
  | Snapshot { snapshot, pendingNaturalEnd }
  | Accepted
  | Rejected {
      code:
        InvalidRequest | AccountMismatch | StaleSession |
        NaturalEndPending | PlayerUnavailable
    }

Event =
  SnapshotChanged { snapshot }
  | ControllerReconnected { snapshot, pendingNaturalEnd }
  | NaturalEndPending { receipt }
```

`LoadCanonical.session` is the existing `AudioSession`, including exact
`Direct | Lectern(itemId)` origin and canonical descriptor.
`SetPlaybackRateState` carries the already-owned flat tagged union
`Canonical { episodeRate, podcastPreference, preferred, temporaryNormal, base }
| Preview { preferred, temporaryNormal, base }`; native does not re-resolve
inheritance.
`InstallPodcastPlaybackSettings` carries `sessionKey`, `podcastId`, the decoded
subscription Presence containing both `defaultPlaybackSpeed` and
`pauseShorteningMode`, and the already-derived rate state. It is accepted only
for the matching active canonical session, atomically updates the in-memory
descriptor mirrors and rate/pause policy, and immediately applies both.
An unestablished episode derives from the installed podcast/product value; an
established episode retains its episode rate and updates only its inherited
scope. Unsubscribe installs absent subscription settings. The command never
performs a server mutation.
`SetDeviceDefaultPauseShorteningMode` is device-scoped and carries no
`sessionKey`; it remains available under `Absent`. Session-scoped commands keep
the exact `sessionKey` fence.
`AdoptListeningState` seeks to the returned Reset state, installs its fences,
and pauses before accepting another transport command.

Replaying an identical `Load*` for the same `sessionKey` is idempotent. Reusing
that key with different session data is `InvalidRequest`.

`PlayerSnapshot` is an exhaustive `Absent | Canonical | Preview` union.
`Absent` carries only `deviceDefaultPauseShorteningMode` and
`pauseShorteningSavedOnDeviceMs`, so device settings remain truthful before any
session loads without a second settings channel:

```text
Absent {
  deviceDefaultPauseShorteningMode
  pauseShorteningSavedOnDeviceMs
}
Canonical.phase = Buffering | Playing | Paused | Ended
Preview.phase   = Buffering | Playing | Paused | Ended
```

Every non-`Absent` snapshot carries the full in-memory canonical `AudioSession`
or Preview descriptor, not only descriptor identity, plus session key,
source-time position/duration/buffered values, volume, that full tagged
`rateState`, observed base rate, typed
`persistence`, `playbackFailure`, and pause-shortening capability values. A
suspended persistence value carries its reason and localized nonfatal message.
This
rehydrates ordinary WebView/Activity recreation while the service lives.
Neither snapshot nor session is persisted after service/process death.

`PendingNaturalEnd` contains only:

```text
accountId
sessionKey
mediaId
origin
clientMutationId
terminalListening
expectedConsumptionOverrideRevision
```

Native mints the mutation ID once and captures the most recently accepted
heartbeat fences, override revision, and terminal listening observation before
persisting the receipt. Every delivery/retry reuses the exact receipt.

Do not persist media URLs or duplicate a player session record for this
receipt.

`Connect(accountId)` exposes and replays only a matching receipt. A different
account atomically stops/clears the in-memory session and securely discards the
foreign receipt before `Connected`; it never exposes or settles cross-account
state.

`AcknowledgeNaturalEnd` must identify the exact `sessionKey` and
`clientMutationId`. Native clears only that matching committed receipt. The web
sends it only after `settleNaturalEnd` resolves to a recorded terminal outcome
and installs the response; 401, timeout, network failure, and parked
reconciliation leave the receipt intact.

Whichever Android media cutover lands first extracts narrow shared helpers for
owned-origin validation, exact framing, request correlation, connection
generation, and account fencing. The second reuses them. Keep `nexusPlayer` and
`nexusOfflineMedia` as separate semantic protocols; the shared helper contains
no domain command, arbitrary dispatch, or generic command bus.

## Native Runtime

- Add one `MediaSessionService` with one service-scoped `ExoPlayer` and one
  `MediaSession`, created in `onCreate` and released in `onDestroy`; no
  Application or Activity singleton.
- Pin `media3-exoplayer`, `media3-session`, `media3-datasource`,
  `media3-datasource-okhttp`, and every other Media3 artifact to exactly
  `1.10.1`; reject mixed versions.
- Build its `DefaultAudioSink` with one service-owned
  `DefaultAudioProcessorChain` containing Media3's stock
  `SilenceSkippingAudioProcessor` and `SonicAudioProcessor`; retain that chain
  for `getSkippedOutputFrameCount()`. Do not add a second detector.
- Declare `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, the
  `mediaPlayback` service type, and use Media3's notification owner.
  Media-session notifications are exempt from Android 13 notification runtime
  permission; playback never depends on `POST_NOTIFICATIONS`. A separately
  installed offline-download permission remains that capability's concern.
- Do not declare `MediaButtonReceiver`, an `ACTION_MEDIA_BUTTON` receiver, or
  implement `onPlaybackResumption`. Bluetooth/System UI cannot resurrect
  playback after service/process death.
- Playing remains foreground. After pause, stop, failure, or end, accept
  Media3's maximum ten-minute non-playing grace and possible destruction when
  unbound. A null-intent/sticky recreation restores no item or synthetic
  session and stops when unbound.
- `onCreate` and `onGetSession` perform no network, cookie, or auth work.
- Use `MediaController` from `MainActivity`; no direct service singleton or
  Activity-owned player.
- A replacement `MediaController` performs one internal same-account
  `Connect`, installs native fences, then pushes one authoritative
  `ControllerReconnected` snapshot and receipt Presence. Web replaces stale
  state and never replays a lost transport intent.
- Configure media audio attributes, audio-focus handling, becoming-noisy
  behavior, wake behavior, and source metadata.
- Standard transport commands use `MediaController`; Nexus-only load,
  persistence, and policy commands use named custom session commands.
- One service-owned supervised task scope owns snapshot publication,
  heartbeat, activity, and pending-end work. No detached tasks or JS timers.
- Publish timeline snapshots at named
  `NATIVE_PLAYER_TIMELINE_INTERVAL = 250.milliseconds` while the Activity is resumed;
  publish state changes immediately. Stop web-facing cadence while hidden and
  send one current snapshot on reconnect.
- One `NexusPlayerPreferences` owner stores only the device-default mode,
  estimated saved-on-device milliseconds, and
  `Presence<PendingNaturalEnd>`. Commit the receipt before publishing `Ended`
  or stopping; clear it only after exact acknowledgement. Do not create a
  generic settings store.

Pause shortening:

- `Off` calls `setSkipSilenceEnabled(false)` and permits audio offload.
- `Natural` calls `setSkipSilenceEnabled(true)` and accepts the required PCM
  processing/offload cost.
- Do not fork or configure Media3's stock thresholds in this cutover.
- Treat failure to install requested processing as a player failure; do not
  silently play with a lying `Natural` state.
- Use Media3 skipped-frame accounting as a conservative estimate. For each
  processor epoch, convert a positive frame delta using that epoch's
  processor/output sample rate, then divide source-skipped time by the actually
  applied base rate.
- Checkpoint before owned rate, mode, seek, source, pause, and end transitions.
  Start a new epoch on counter rollback, flush, reset, or audio-format change.
  Admit a counter delta only against positive source-position advance observed
  in the same epoch; never count processor-ahead frames beyond that position.
  Discard ambiguous/uncheckpointed boundary deltas rather than extrapolate.
  Processor buffering or internal flush timing may omit the final segment of
  an epoch; errors therefore bias toward bounded undercount. The device total
  never decreases or double-counts.
- Persist the accumulated device total at those lifecycle checkpoints, not on
  every sample. Speed, manual seek, Preview, and nonpositive deltas contribute
  nothing.

Source and time:

- Capture remote-versus-ready-offline source once during `LoadCanonical`.
- Use one credential-free public-media `OkHttpClient` through
  `OkHttpDataSource.Factory`, wrapped by `DefaultDataSource.Factory`. Name its
  user agent, deadlines, HTTPS/public-media redirect policy, and logging
  redaction. It has no cookie jar, authenticator, Nexus headers, or owned-origin
  interceptor.
- Whichever media cutover lands first owns that public-media factory. If offline
  storage exists, compose the same upstream through its Media3 cache owner. Do
  not instantiate `DefaultHttpDataSource` in parallel or serve cached bytes
  through a WebView range route.
- Never switch an active session when download state or enclosure metadata
  changes.
- Never send Nexus cookies, authorization, or internal headers to the external
  audio origin.
- ExoPlayer position, Media Session position, heartbeat position, chapters,
  seeks, and reset use original source milliseconds.
- Use Media3's one `DefaultLoadErrorHandlingPolicy` for remote-source retry.
  Retryable loads remain `Buffering`; only its exhausted/fatal result enters
  player failure.

Native Consumption:

- `NexusOriginClient` calls only fixed owned-origin BFF paths. It accepts no
  arbitrary path, host, or headers.
- For each request, read owned-origin cookies from `CookieManager`, send the
  exact `Origin`, and install/flush returned `Set-Cookie` values.
- `NativeConsumptionRecorder` reuses the existing heartbeat
  generation/sequence/write-revision/reset-epoch protocol, cadence, deadline,
  GET recovery, and persistence-suspension semantics.
- It emits bounded `Listening` activity spans with monotonic duration,
  source-position endpoints, stable mutation IDs, and existing API limits.
- Only canonical playing time accrues. Buffering, pause, Preview, and
  ambiguous suspension gaps do not.
- Close the current Listening span immediately before manual seek, Reset,
  source replacement, or any non-silence position discontinuity; reopen only
  after canonical playback resumes. Never bridge pre/post-discontinuity
  position endpoints in one span.
- Media3 `DISCONTINUITY_REASON_SILENCE_SKIP` advances canonical source position
  but is not a user seek, does not terminate/split a Listening span, and does
  not trigger completion by itself.
- Android web code registers no duplicate heartbeat or activity observer.
- Reset Progress drains native persistence, runs the existing server mutation,
  then installs the returned listening snapshot through
  `AdoptListeningState`, which seeks and pauses.
- The Android-wide categorical retry catalog owns
  `SAME_SYSTEM_CLIENT_RECOVERY = [1s, 2s, 5s, 15s, 30s]` as one self-bounding
  schedule. Timeout, network, and retryable 5xx recover through the existing GET
  reconciliation with that policy; validated-network return starts one fresh
  series. Exhaustion is the explicitly modeled
  `PersistenceSuspended.Network`, keeps the latest dirty sample, and sends the
  notification controller a localized nonfatal progress-sync session error.
- A 401 immediately publishes `PersistenceSuspended.AuthExpired`, performs no
  same-credential retry loop, keeps playback/notification transport usable,
  and sends the notification controller a localized nonfatal authentication
  session error. `RetryPersistence` and the next authenticated bridge
  connection perform GET-only recovery.
- Exhausted source loading is a player failure and remains visible in the Media3
  session/notification. Persistence failure never calls
  `setPlaybackException`.
- Same-system schema mismatch, impossible fence echo, or invalid state
  transition is a defect.

## Browser Runtime and Hard Cuts

Keep browser playback, volume boost, and mono. Hard-cut silence behavior:

- rename `audioEffects.ts` to `outputEffects.ts`;
- remove silence mode, constants, RMS calculation, analyser node, frame loop,
  timestamps, counters, state, commands, copy, and tests;
- remove localStorage key `podcast_effects_silence_trim` without migration;
- remove the compressor from `Off` output paths;
- before graph creation, Off uses raw element output; after graph creation, Off
  routes a same-origin source node directly to destination;
- never graph-capture the external enclosure element without CORS. Mark output
  effects unavailable for that source and retain raw output; when a
  graph-captured same-origin element is replaced by an external source, rotate
  the element at that source boundary before load;
- include gain/compressor only for volume boost and channel mixing only for
  mono;
- do not render the owned `<audio>` or bind browser Media Session,
  heartbeat, activity, or output effects inside the Android shell;
- if Android `Connect` fails, render the existing player failure surface and
  Retry connection. Never mount browser audio.

Delete any local native-range playback route/read-lease code from the offline
cutover if it has landed. `OfflineMediaStore` remains the sole
download/cache/index owner.

## Files

Backend:

- `migrations/alembic/versions/NNNN_android_native_player_pause_shortening.py`
- `python/nexus/db/models.py`
- `python/nexus/schemas/{consumption,podcast,library}.py`
- `python/nexus/services/podcasts/{subscriptions,subscriptions_query}.py`
- `python/nexus/services/consumption/{_listening_store,_projection,_state_store,
  service}.py`
- `python/nexus/services/library_entries.py`
- focused migration, Podcasts, descriptor, projection, fenced settlement, and
  replay tests.

Web:

- `apps/web/src/lib/lectern/contract.ts`
- `apps/web/src/lib/lectern/LecternProvider.tsx`
- `apps/web/src/components/LecternMutationNotice.tsx`
- `apps/web/src/lib/player/{globalPlayer,playerSession,playerChromeModel}.ts[x]`
- add one narrow runtime contract plus browser and Android runtime owners under
  `apps/web/src/lib/player/`;
- replace `audioEffects.ts` with `outputEffects.ts`;
- add the exact Android player client/protocol beside the Android runtime;
- reuse `apps/web/src/lib/androidShell.ts`,
  `renderEnvironment`, existing Presence/exact-decode helpers, and the shared
  podcast settings client from the playback-rate cutover;
- extend that shared settings-install subscription; add no second client/event;
- update `PlayerPlaybackControls`, player surfaces, subscription modal/controller,
  and strict DTO adopters;
- replace owned lifecycle/effects/Media Session tests; do not retain old mocks
  to prove deleted behavior.

Android:

- `apps/android/app/build.gradle.kts`
- `apps/android/app/src/main/AndroidManifest.xml`
- `MainActivity.kt` and `NexusWebView.kt`
- one focused `playback/` package:
  - `NexusPlaybackService.kt` — player, MediaSession, snapshot, pending end;
  - `NexusPlayerBridge.kt` — origin-bound WebKit/MediaController adapter;
  - `PlayerProtocol.kt` — exact protocol/domain parsing;
  - `NexusOriginClient.kt` — fixed owned-origin BFF transport;
  - `NativeConsumptionRecorder.kt` — heartbeat, activity, persistence recovery;
  - `NexusPlayerPreferences.kt` — exact three-field device persistence.
- `apps/android/app/src/main/java/app/nexus/android/RetryPolicies.kt` —
  Android-wide categorical schedules;
- one narrow shared `webkit/OwnedOriginWebMessage.kt` boundary helper, created
  by whichever Android cutover lands first;
- one narrow shared `media/PublicMediaDataSources.kt` credential-free
  OkHttp/Media3 owner, created by whichever media cutover lands first;
- reuse `OfflineMediaStore`/Media3 cache primitives when present.
- Android unit and instrumentation tests.

Docs:

- `docs/{architecture.md,chapbook.md}`
- `docs/modules/{player,podcast,consumption-activity}.md`
- `docs/local-rules/codebase.md` before adding the bridge or native product API
  client;
- superseded clauses in the governing cutover docs.

Touch further files only when the compiler, exact decoders, descriptor
projection, or residue search proves they adopt a deleted contract.

## Acceptance Criteria

1. Android canonical and Preview sessions use the native service; no Android
   `<audio>`, Web Audio, browser Media Session, heartbeat, or activity owner
   exists.
2. Browser canonical/Preview playback remains unchanged except that pause
   shortening is absent and output-effects Off is transparent.
3. `Off` produces no skipped frames. `Natural` uses Media3 stock shortening and
   remains effective through screen lock/background playback.
4. Session override wins, then podcast override, then device default. The player
   edits the session; explicit Remember/default actions persist. `Use device
   default` and unsubscribe install live without a stale loaded-session mode.
5. Existing rows inherit `Off`; the removed localStorage boolean is ignored.
6. Playback rate, pause shortening, Media Session, heartbeat, chapters,
   transcript jumps, seeks, and Reset agree on original source time.
7. Saved on this device is a monotonic conservative estimate, sample-rate- and
   applied-rate-aware, survives sessions, handles processor epoch resets, and
   never includes playback speed, manual seeks, or Preview.
8. Pause, dismiss, switch, Reset, and interruption best-effort flush once.
   Natural end durably carries terminal progress in its receipt-backed
   settlement. Android and web never duplicate a write owner.
9. Heartbeat fencing conflict adopts the server snapshot and seeks native
   playback exactly as the existing browser contract requires; Reset adopt also
   pauses. Real seeks/resets split activity spans; silence-skip discontinuities
   do not.
10. Every Android natural end persists one receipt and executes the same
    `SettleNaturalEnd` command. Exact replay is idempotent; a newer heartbeat,
    Reset, Unread, Finished, or Undo returns `Superseded` without writes; stale
    origin never advances.
11. Receipt acknowledgement follows recorded terminal commit and canonical
    install. A matching `Ended` session alone may transition/start a foreground
    successor; stale/process-death settlement is headless.
12. Bridge reconnect installs an authoritative full-session
    `Absent | Canonical | Preview` snapshot with explicit `Ended`. Stale session
    commands/events cannot mutate the current session. Account switch exposes
    neither a foreign session nor receipt.
13. Missing/malformed bridge, account mismatch, invalid protocol, invalid
    source, and processor failure never start browser fallback playback.
14. Notification, lock-screen, headset, audio-focus interruption, becoming
    noisy, Bluetooth route change, and Activity recreation control the same
    session. Notification denial does not block media controls; no receiver or
    playback-resumption path can resurrect a killed session.
15. Transient persistence failure retries boundedly; network exhaustion and 401
    are typed, screen-off-visible suspensions that do not become player errors.
16. Ready offline audio, when present, uses the one Media3 cache and plays/seeks
    in airplane mode without a WebView range server.
17. Subscription setting copy, focus, touch targets, keyboard, screen reader,
    320 px/400% zoom, reduced motion, and forced colors pass.
18. No legacy silence symbol, storage key, analyser/rAF detector, compatibility
    decoder, alternate protocol version, dual runtime, or dead test remains.

## Required Proof

- Unit: three-level policy precedence, exact protocol parsing, account/session
  fencing, skipped-time accounting across sample rate/applied rate/counter
  rollback, pending-end replay, activity discontinuities, retry classification,
  and output routing.
- Integration: migration, subscription Presence patch/read, both descriptor
  projections, all `SettleNaturalEnd` outcomes/replay/progress/status-fence
  precedence, heartbeat CAS/recovery, and activity API through real database.
- Web component/runtime: runtime selection, no Android `<audio>`, controls,
  live settings install, bridge failure, Reset drain/adopt/pause, session-less
  settlement, `Ended`/full-session snapshots, strict acknowledgement, and
  accessibility.
- Android instrumentation: real WebView origin/frame rejection, service and
  controller lifecycle, account switch, MediaSession controls, background
  playback, bounded persistence retry/auth suspension, notification denial,
  absent MediaButtonReceiver/resumption, process/Activity recreation
  boundaries, and no duplicate player.
- Real media: quiet speech, noise bed, long dead air, music, laughter, and
  non-CORS external enclosures; verify intelligibility and canonical time.
- Physical device: 30-minute screen-off stream at `Off` and `Natural`, natural
  end during bridge/network loss plus process death then reconnect settlement,
  lock controls, call/audio focus, wired/Bluetooth changes, 401/5xx/network
  recovery, battery/thermal, and offline playback when available.
- Static/type/build, migrations, focused tests, real-stack E2E, residue search,
  `git diff --check`, CI, release APK, deploy, and production smoke are reported
  separately.

## Verification Status

Passed locally on 2026-07-30:

- focused backend database/API/migration tests, Ruff, and production Pyright;
- the 105-test audited web set plus a final 47-test affected subset, scoped
  ESLint, CSS-token lint, E2E TypeScript, and a production Next build;
- direct initial-Lectern-failure receipt settlement, post-acknowledgement
  successor fencing, account-switch isolation, and serialized unsubscribe/live
  settings-install regressions;
- 47 Android JVM tests, including the stock Media3 silence processor,
  three-level policy, offload/processor-install failure, saved-time, activity
  discontinuity, recorder recovery, protocol, origin, and fencing owners;
- `lintDebug`, debug app APK, and instrumentation APK;
- API 35 instrumentation for retry/auth suspension, pure owned-origin matching,
  and the manifest/service contract;
- the exact authenticated pause-shortening settings/Lectern browser E2E
  (`2 passed`), including keyboard selection, 44 px targets, 320 px reflow,
  400% zoom, reduced motion, and forced colors, with Podcast routes enabled by
  test-only credentials;
- migration head `0206`, hard-cut residue search, and `git diff --check`.

Still required:

- the remaining API 35 WebView/service lifecycle instrumentation. This host has
  no KVM; Android's process-start watchdog killed Chromium/app startup before
  assertions while other system processes failed similarly;
- execution of the compiled fresh-preferences-owner receipt replay/ack
  instrumentation test; no Android device is attached;
- the real-media and physical-device matrix above, CI, signed release APK,
  deploy, and production smoke. The signed build additionally requires the
  unavailable release keystore/version/Google client inputs.

Browser tests do not prove Android lifecycle, Media3 DSP, real-source playback,
battery, or release behavior.

## Implementation Order

1. Land the playback-rate hard cutover; reconcile migration head.
2. Update `docs/local-rules/codebase.md`; establish the shared exact WebKit and
   public-media data-source boundary owners.
3. Write failing backend settlement, web runtime, protocol, native service, and
   instrumentation tests.
4. Add the subscription field, canonical descriptor projection, and fenced
   `SettleNaturalEnd`; hard-cut strict decoders together.
5. Build the pinned native service, MediaSession, origin client, Consumption
   recorder/recovery, preferences, and bridge.
6. Extract the real two-runtime seam from `GlobalPlayerProvider`; install
   Android snapshot/command composition, live settings, Reset, and session-less
   settlement handoffs.
7. Ship Off/Natural UI and session/podcast/device-default actions using existing
   surfaces.
8. Delete the browser silence implementation, Android web runtime bindings,
   duplicate offline local-serving path, stale docs, fixtures, and tests.
9. Run focused proof, then real-stack, physical-device, release, CI, deploy,
   and production gates.

## Final State

Nexus has one semantic player and one runtime owner per platform. Browser audio
remains direct and has no pause-shortening promise. Android audio is owned
end-to-end by Media3 and remains correct when the WebView sleeps. Consumption
still owns durable source-time progress and activity; Podcasts owns the only
show override; Android owns the session/device modes, one conservative
saved-on-device estimate, and one pending-end receipt. Android natural end is
one fenced, replayable Consumption settlement regardless of connection state.
`Natural` is a conservative vendor primitive, not a custom algorithm. The old
CORS-sensitive rAF detector, silence localStorage flag, hidden compressor
coupling, Android two-command natural-end path, WebView background clock, Android
browser fallback, playback-resumption receiver, and duplicate offline
byte-serving path do not exist.
