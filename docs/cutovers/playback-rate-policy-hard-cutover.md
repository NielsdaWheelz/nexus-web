# Playback Rate Policy Hard Cutover

Status: APPROVED SPEC — revised 2026-07-30

Type: hard cutover. One final contract; no legacy scalar shape, client fallback,
dual read/write, compatibility decoder, feature flag, or backward compatibility.

No blocking question remains.

Android engine ownership and every silence-trim clause are superseded by
[`android-native-player-pause-shortening-hard-cutover.md`](android-native-player-pause-shortening-hard-cutover.md).
Rate resolution, preferred/base semantics, and podcast settings remain
canonical.

## Decision

Make podcast playback speed truthful, scoped, and durable:

- a normal change belongs to the current episode and resumes with it;
- **Remember for this podcast** explicitly changes new-episode inheritance;
- an untouched episode inherits the active subscription's default, then `1x`;
- an episode rate becomes established on first canonical playback or an explicit
  persistent rate change;
- PreviewAudio starts at `1x`, may change locally, and writes no preference;
- product range is `0.5x..3x`, adjustment step `0.05x`, product default `1x`;
- native `HTMLMediaElement.playbackRate` remains the engine with pitch preserved.

This cutover repairs the lost first-play inheritance contract and replaces the
lying preset-only control. It does not create a global preference system or
rewrite audio effects.

## Governing Rules

- `docs/rules/{boundaries,cleanliness,codebase,concurrency,correctness,database,frontend,mutation-ordering,naming,simplicity}.md`
- `docs/local-rules/testing-standards.md`
- `docs/architecture.md`
- `docs/modules/player.md`
- `docs/cutovers/{lectern-player-lifecycle,global-player-surfaces,media-progress-reset}-hard-cutover.md`

This document supersedes those documents only where they specify a scalar
`playbackSpeed`, preset-only speed control, `0.25x` minimum, or hard-coded
first-play `1x`.

## Goals

1. One server-owned resolution policy for every canonical player descriptor.
2. Visible rate, audible base rate, and Media Session rate agree; persistence
   records the preferred episode rate and never temporary/trim engine rate.
3. Episode, podcast, temporary, and product-default scopes are explicit.
4. Arbitrary valid rates such as `1.8x` remain truthful and editable.
5. A rate change while paused is durable without waiting for the 15-second
   heartbeat cadence.
6. The change reduces duplicated fields, constants, decoders, and fallback
   logic.

## 80/20 Scope

Included:

- podcast-episode canonical playback and PreviewAudio;
- episode resume rate plus active-subscription default inheritance;
- existing podcast subscription settings mutation;
- numeric rate control, presets, `+/- 0.05x`, native range input, `1x`, temporary
  normal-rate toggle, podcast remember/reset actions, and adjusted time left;
- explicit pitch preservation, `ratechange`, heartbeat, and Media Session
  behavior;
- desktop Listening Shelf, mobile MiniPlayer More, and mobile Now Playing;
- the existing podcast subscription-settings modal;
- exact backend, component, real-stack, and manual-device proof.

Excluded:

- account/global playback preference or a preference table;
- preferences independent of active subscription lifecycle;
- audiobooks, video, music, live streams, or a generic media-rate policy;
- speeds below `0.5x` or above `3x`, configurable steps, recent-speed history,
  voice commands, or hold-to-sprint;
- Cast/AirPlay/Remote Playback capability modeling or cross-device session
  transfer;
- silence-trim, volume-boost, mono, CORS, saved-time, or DSP changes;
- adaptive/semantic speed, transcripts/ASR inference, analytics, or ML;
- new endpoint, event bus, workflow, cache, state library, or generic settings
  framework.

## Canonical Semantics

```text
episodeRate = podcast_listening_states.playback_speed when present

podcastPreference =
  active podcast_subscriptions.default_playback_speed when present

resolvedPreferredRate =
  episodeRate
  ?? podcastPreference
  ?? 1

baseRate =
  1 when temporaryNormal
  else resolvedPreferredRate

audio.playbackRate =
  existing silence-trim rate while trimming
  else baseRate
```

Rules:

- `episodeRate` is established episode-resume state, not a reusable preference.
- `episodeRate` becomes present on the first canonical `playing` transition, an
  explicit normal rate change, **Use podcast speed**, or an adopted external
  `ratechange`. Each immediately checkpoints the resolved preferred rate.
- A loaded-but-never-played episode remains unestablished through pause,
  dismissal, source switch, unload, and blocked autoplay unless the user made
  one of those explicit persistent changes. Empty pre-play checkpoints are
  suppressed and do not create listening engagement.
- Started or explicitly configured episodes preserve their rate when the
  podcast default later changes.
- Synthetic state created by Preview transfer, Mark Played, or reset without
  prior canonical playback has no episode rate and cannot shadow inheritance.
- A normal rate change clears `temporaryNormal`, changes `episodeRate`, applies
  immediately, and requests an immediate coalesced heartbeat.
- Temporary `1x` changes only `temporaryNormal`. The heartbeat persists
  `episodeRate`; returning restores it.
- **Use podcast speed** sets this episode to the currently resolved podcast
  preference, or `1x` when none exists. It does not create follow-mode.
- **Use podcast speed** is offered only when persistent `preferredRate` differs
  from that inherited value; temporary normal mode is not part of the
  comparison.
- **Remember for this podcast** writes the current episode rate to the existing
  subscription preference. It does not mutate another episode.
- Clearing a podcast default remains in Subscription settings and affects only
  episodes without an established rate.
- Reset Progress preserves present/absent episode-rate state.
- PreviewAudio always starts at `1x`; its changes are device-session local.
- Every source/session replacement, dismissal, Preview/canonical transition,
  history move, and natural successor clears `temporaryNormal` before installing
  the next source.
- Source position/duration remains canonical. Adjusted time left is a separate
  estimate: `ceil((durationMs - positionMs) / baseRate)`.

## Capability Contract

Hard-cut `FooterAudioActivation.playbackSpeed: number` to:

```text
PlaybackRateResolution {
  value: float 0.5..3
  source: "Episode" | "Podcast" | "Product"
  podcastPreference: Presence<{
    podcastId: UUID
    value: Presence<float 0.5..3>
  }>
}

FooterAudioActivation {
  ...
  playbackRate: PlaybackRateResolution
}
```

`podcastPreference` is present only for an active subscription. Its nested value
is absent when the subscription inherits product `1x`.

Resolution invariants:

| Episode rate | Active subscription default | Result |
| --- | --- | --- |
| Present `E` | any | `value=E`, `source=Episode` |
| Absent | Present `P` | `value=P`, `source=Podcast` |
| Absent | Absent/no subscription | `value=1`, `source=Product` |

One pure resolver constructs this immutable source-boundary record. Both
Lectern activation and batched `PlayerDescriptor` projection call it. Invalid
trusted values defect; there is no clamp or `1x` fallback at runtime.

Frontend capability:

```text
PlayerSettings.playbackRate {
  scope:
    | {
        kind: "Canonical"
        episodeRate: Presence<number>
        podcastPreference: Presence<{
          podcastId: UUID
          value: Presence<number>
        }>
      }
    | { kind: "Preview" }
  preferred: number          # derived; preview-local for Preview
  temporaryNormal: boolean
  base: number               # temporaryNormal ? 1 : preferred
  observed: number           # last accepted product-range element rate; excludes trim
  remember:
    | { kind: "Unavailable" }
    | { kind: "Ready" }
    | { kind: "Pending" }
    | { kind: "Failed", error: FeedbackContent, retryable: boolean }
}

PlayerCommands
  setPlaybackRate(rate)
  toggleTemporaryNormalRate()
  useInheritedPlaybackRate()
  rememberPlaybackRateForPodcast()
```

On descriptor install, the provider converts `PlaybackRateResolution` into
canonical `episodeRate` plus `podcastPreference`; it never retains the descriptor
record as mutable live state. It derives `preferred`, `base`, and provenance
after every local mutation or subscription-settings install. Thus scope copy
cannot retain stale descriptor `value`/`source`.

The provider owns these transitions and the remember mutation state. Leaves
render capability state and invoke commands; they do not call APIs, derive
inheritance, own pending/error state, or mutate descriptors. The playback panel
reads `PlayerTimeline` separately and derives adjusted remaining time from
Timeline position/duration plus Settings base rate; position cadence never
enters `PlayerSettings`.

## Backend Composition

```text
Consumption descriptor request
  -> _lectern_store.LecternRow and _projection._PlayerDescriptorRow include
     podcast_id from their existing podcast_episodes joins
  -> Podcasts leaf public batch query:
       load_subscription_playback_preferences(db, viewer_id, podcast_ids)
  -> Consumption loads listening rows
  -> one pure resolve_playback_rate(...)
  -> canonical FooterAudioActivation.playbackRate
  -> strict frontend decoder
  -> GlobalPlayerProvider installs preferred/base/observed rate
```

Ownership:

- Podcasts owns `podcast_subscriptions.default_playback_speed` and the narrow
  public batch query in `services/podcasts/playback_preferences.py`. That leaf
  imports no Consumption, library-entry, episode, or subscription-command
  module, preventing the existing Podcasts -> Consumption import cycle.
- Consumption imports only that Podcasts leaf and never reads
  `podcast_subscriptions` directly.
- Consumption owns nullable episode rate, resolution, descriptor projection,
  and heartbeat persistence.
- `GlobalPlayerProvider` owns episode/preference/temporary/base/observed and
  remember state plus the audio element.
- Player surfaces own presentation only.

No leaf Media/Podcast/Library component performs `episode ?? subscription ?? 1`.

## Database

Migration: the next actual Alembic head after the Podcast Freshness cutover,
named `NNNN_playback_rate_policy_hard_cutover.py`. Do not reserve or reuse a
numeric revision before re-reading the landed head.

Hard-cut `podcast_listening_states.playback_speed`:

- nullable `double precision`;
- no server default;
- `NULL` means no canonical episode rate has been established;
- non-null means an established episode rate;
- existing non-null rows remain established except the deterministic synthetic
  Mark-Played row shape below; remaining values are clamped once to `0.5..3`;
- an absent-row heartbeat with `episodePlaybackRate=Absent` inserts `NULL`;
- an existing-row heartbeat with `episodePlaybackRate=Absent` preserves the
  stored nullable value;
- `episodePlaybackRate=Present(rate)` inserts or updates non-null and therefore
  establishes the episode rate;
- Preview transfer, Mark Played synthetic insertion, and absent-row Reset write
  `NULL`;
- Reset of an existing row preserves its nullable value.

Before clamping, set `playback_speed=NULL` only for the complete row shape
written by Mark Played without prior listening:

```text
position_ms = 0
duration_ms IS NULL
playback_speed = 1
is_completed IS TRUE
write_revision = 0
reset_epoch = 0
last_engaged_at IS NULL
```

This is a deliberate semantic classification, not a provenance claim.
Migration `0182` assigned `write_revision=0` to every historical row, so
`write_revision=0 AND position_ms=0` alone is forbidden as purported proof.
All other ambiguous historical rows remain established.

Drop both playback-rate business checks:

- `ck_podcast_listening_states_playback_speed_positive`;
- `ck_podcast_subscriptions_default_playback_speed_range`.

Application boundary types enforce `0.5..3`; trusted invalid stored data defects.
Do not add a replacement check, index, table, provenance column, backfill
heuristic beyond the exact semantic classification above, trigger, or downgrade
compatibility path. Downgrade raises.

## Sibling Cutover Order

Actual integrated order:

1. `podcast-freshness-and-pane-refresh-hard-cutover.md`;
2. `global-player-surfaces-hard-cutover.md`;
3. `android-episode-offline-downloads-hard-cutover.md`;
4. this playback-rate cutover.

Android offline downloads landed while this cutover was under review. Playback
therefore rebases onto that landed runtime and owns the final composed
`globalPlayer.tsx`; do not rewrite history or preserve the scalar-rate player.
The focused runtime proof must continue to cover Android's capture-once offline
source boundary after composition.

Freshness owns migration `0203` and edits `podcast_subscriptions`,
`schemas/podcast.py`, and the former route-owned settings client. Playback owns
the sole successor migration `0204` and relocates the final settings client.
Any later player or Android cutover must rebase onto this final runtime and the
landed migration head. Do not merge independently numbered competing heads.

## API

### Canonical player and listening shapes

`FooterAudioActivation.playbackRate` is required and resolved. The old scalar
key is rejected.

Hard-cut Consumption listening state:

```text
ListeningStateOut {
  positionMs: nonnegative int
  durationMs: Presence<nonnegative int>
  episodePlaybackRate: Presence<float 0.5..3>
  writeRevision: nonnegative int
  resetEpoch: nonnegative int
}
```

Heartbeat input remains a strict canonical-session sample:

```text
ListeningHeartbeatIn {
  positionMs
  durationMs
  episodePlaybackRate: Presence<float 0.5..3>
  expectedWriteRevision
  expectedResetEpoch
  heartbeatGeneration
  heartbeatSequence
}
```

`Present` carries the preferred episode rate, never temporary `1x` or the
silence-trim engine rate. `Absent` is an explicit non-establishing sample:
insert `NULL` for an absent row and preserve the stored nullable rate for an
existing row.

Remove playback rate from non-canonical Media and podcast-episode raw listening
DTOs; consumers use `playerDescriptor.playbackRate`. Remove
`MediaOut.subscription_default_playback_speed`; the canonical resolution owns
that fact.

### Podcast setting

Keep the existing
`PATCH /podcasts/subscriptions/{podcast_id}/settings` and BFF proxy. Add no
route.

Hard-cut nullable default-speed API values to owned absence:

```text
set:   { "default_playback_speed": { "kind": "Present", "value": 1.25 } }
clear: { "default_playback_speed": { "kind": "Absent" } }
```

Omitting the key means no change. Raw `null`, the old scalar response absence,
unknown fields, and out-of-range values are rejected. Responses and subscription
DTOs expose `default_playback_speed: Presence<float>`.

The optional PATCH key is a deliberate partial-update boundary: key omission
means “do not mutate this field,” while an included key always carries the
repository-owned `Presence` representation. This is the intentional
optional-key exception to the otherwise always-present owned-absence rule.

The player and modal reuse this mutation through one shared podcast-settings
client. After decoding a successful response, that module publishes one narrow,
synchronous, module-local settings install. The active player subscribes once;
adapt the process-local subscriber shape from
`consumption/projectionRevision.ts`, but carry the exact installed response
instead of a revision. This is not a DOM event, generic event bus, cache, or
alternate state owner.

The provider installs the response only when its `podcastId` matches the active
canonical source:

- an unestablished episode replaces its provider-owned podcast-preference mirror
  and immediately re-derives preferred/base/audio;
- an established episode retains its episode rate and updates only the podcast
  preference and scope/actions;
- Preview and a different podcast ignore the install.

`E_NOT_FOUND` during Remember means the subscription lapsed: install
`podcastPreference=Absent`, make Remember/Use-podcast unavailable, retain the
episode rate, and enter `remember=Failed(retryable=false)` with “Podcast
subscription no longer exists.” Other failures enter
`remember=Failed(retryable=true)`; retry invokes the same single mutation. The
Podcasts write is one ordinary single-row `UPDATE` transaction with
collection-revision bumps, not a serializable mutation.

`LibraryEntryPodcastSubscriptionOut.default_playback_speed` and every other
owned subscription projection hard-cut to the same `Presence<float>` response;
`schemas/library.py` is not left raw-nullable.

## Runtime and Concurrency

- The server descriptor is authoritative at every source boundary.
- `setPlaybackRate` validates user input once, clears `temporaryNormal`,
  establishes `episodeRate=Present(rate)` for canonical playback, updates
  preferred/base/audio and Media Session synchronously, then marks the latest
  heartbeat sample dirty. It works before first play, while playing, and while
  paused. Preview performs only the local updates.
- Rapid adjustments coalesce to the latest sample; do not create a request per
  range `input` event.
- The existing heartbeat generation, sequence, `writeRevision`, `resetEpoch`,
  single-flight, Retry, and persistence-suspension contracts remain, with this
  stronger dirty-sample invariant:
  - every requested checkpoint records that the newest semantic sample is dirty,
    including while Recovering or Suspended;
  - timeout/network/409 recovery retains dirty state, GETs the canonical fences,
    then immediately resends the newest sample under the new generation;
  - successful suspended recovery does the same before reporting persistence
    Ready;
  - a same-epoch GET refreshes fences without overwriting the latest dirty local
    episode rate; an advanced reset epoch adopts canonical state and retires
    every pre-reset dirty sample;
  - only an accepted PUT for the current generation/sequence clears dirty state,
    and only when no later sample was requested;
  - `flushKeepalive` is best-effort and never clears dirty state.
- Pause, dismissal, source switch, and unload do not send an empty
  never-played/unestablished zero-position sample. Once canonical play or an
  explicit persistent change establishes the rate, those checkpoints use its
  `Present` value.
- On the first canonical `playing` event, establish
  `episodeRate=Present(resolvedPreferredRate)` and request one immediate
  checkpoint before relying on cadence.
- Remember enters `Pending` before its ordinary Podcasts update; the action is
  disabled and repeated submits are ignored until the attempt settles.
- One provider helper performs every owned `audio.playbackRate` assignment,
  including source install, normal/temporary changes, audio-element rotation,
  and silence-trim enter/exit. After an actual assignment it records
  `{element, target, cause}` as the element-scoped last-owned-rate token. A
  tolerance early-return does not replace that token.
- On `ratechange`, an observed value matching the current element's last-owned
  target is an owned echo. Silence-trim targets/transitions never feed back. A
  different valid product-range value is adopted exactly as a normal change:
  clear `temporaryNormal`, establish/update the canonical episode rate, install
  preferred/base/observed, update Media Session, and mark the sample dirty;
  Preview installs it locally. Invalid unexplained values enter the existing
  modeled playback failure.
- Assign `audio.preservesPitch = true` on every owned audio element.
- If the browser rejects an in-range rate, enter the existing modeled playback
  failure; never silently restore `1x`.
- Media Session position state uses `baseRate`; existing silence-trim divergence
  remains named out of scope.

## UX

Product label is **Playback speed**. Technical code may use playback rate.

- Full desktop and mobile Now Playing show one always-visible numeric button:
  `1x`, `1.25x`, `1.8x`, etc.
- MiniPlayer More labels the action `Playback speed, {rate}`.
- Accessible name is `Playback speed, normal` at `1x`, otherwise
  `Playback speed, {rate} times`.
- The numeric button opens existing overlay primitives:
  - desktop shared `Dialog`;
  - mobile internal `PlayerPlaybackSheet` using `MobileSheet`.
- Both render one shared internal `PlayerPlaybackPanel` from
  `PlayerPlaybackControls.tsx`; no new popover primitive or wrapper file.
- `PlayerPlaybackControls.tsx` also exports one pure
  `PlaybackRateEditor(value, onChange)` used by the panel and subscription
  settings modal. It owns numeric/preset/step presentation only, not persistence
  or scope.
- Rename **Audio effects** to **Playback**. Existing effects remain below the
  speed controls unchanged.

Panel order:

1. actual base-rate value and adjusted time left;
2. preset buttons: `0.75x`, `1x`, `1.25x`, `1.5x`, `2x`;
3. `-`, native range `0.5..3 step 0.05`, `+`;
4. temporary `1x` / `Return to {preferred}` when preferred is not `1x`;
5. canonical scope text:
   `This episode {E} · Podcast default {P|1x}` when subscribed, otherwise
   `This episode {E} · Default 1x`;
6. **Use podcast speed {P|1x}** or **Use default speed 1x** when persistent
   preferred differs from inherited;
7. **Remember {E} for {podcast}** when subscribed and persistent preferred
   differs from the podcast preference.

Preview omits scope and remember actions. Unsupported actions are omitted, not
disabled.

Subscription settings replaces its preset-only `<Select>` with the same
`PlaybackRateEditor` plus **Use app default (1x)**:

- Presence `Absent` selects app default without inventing a stored `1`;
- Presence `Present(rate)` displays the exact valid value, including a value
  installed by Remember that is not a preset;
- opening and saving without editing round-trips the exact value and cannot
  silently coerce it;
- Save is disabled while pending and its existing controller owns modal
  feedback; the shared client publishes the decoded install after success.

Formatting:

- round to the nearest hundredth for display, tolerate floating-point noise,
  use at most two decimals, and trim trailing zeros;
- perform `0.05` step arithmetic in integer hundredths; preserve an installed
  canonical value unchanged until the user edits it;
- multiply sign is `x` in current product copy;
- never substitute a preset for an arbitrary current value;
- `-`/`+` disable at bounds;
- range supports Arrow keys, Home/End, direct pointer/touch, visible focus, and
  `aria-valuetext="Normal speed"` at `1x` or `"{rate} times normal"` otherwise;
  an installed off-grid value temporarily uses native `step="any"` so the
  browser cannot sanitize it, while the first pointer/key edit still applies
  the product-owned `0.05x` step;
- each preset/action is a real button; drag and long-press are never required;
- targets remain at least 44 CSS px on mobile;
- focus returns to the invoking numeric control;
- remember status/error uses its capability state and the existing player live
  region; do not overload heartbeat persistence state.

Adjusted time is labeled approximate and never replaces source elapsed/duration,
chapters, transcript timestamps, or seek values.

## Hard Cuts and Consolidation

Delete or replace in the same change:

- `subscriptionPlaybackSpeed.ts`; replace it with one player-owned
  `playbackRate.ts` for bounds, step, presets, parsing, formatting, and adjusted
  remaining time;
- both preset-only speed `<Select>` surfaces, the `PlayerSpeedControl`
  exact-option guard, and every visual `1x` substitution;
- scalar `FooterAudioActivation.playbackSpeed` and every compatibility decoder,
  fixture, and test;
- frontend `SPEED_MIN=0.25`, runtime clamping, and all `0.25x` contracts;
- raw Media/episode listening speed and Media subscription-default playback
  fields that duplicate the canonical descriptor;
- direct/default inheritance in leaf components and stale comments/tests that
  describe it;
- the effects-only sheet name and copy; retain its existing effects behavior
  inside `PlayerPlaybackControls`;
- duplicated subscription option constants and formatting;
- speculative `temporary: Presence<number>` state and any retained mutable
  descriptor `resolution`; use `temporaryNormal` plus provider-derived values.

Move the reusable podcast settings transport/decoder from the route-owned
`podcastSubscriptions.ts` surface into
`apps/web/src/lib/podcasts/subscriptionSettings.ts`; the modal and player use
that one client and its narrow settings-install subscription. Do not create a
barrel, generic settings client, DOM event, or general event bus.

Residue searches must find no old scalar descriptor key, `0.25` player bound,
subscription-default client fallback, nullable settings wire value, or
preset-membership display coercion.

## Files

Backend:

- `migrations/alembic/versions/NNNN_playback_rate_policy_hard_cutover.py`
- `python/nexus/db/models.py`
- `python/nexus/schemas/{consumption,media,podcast,library}.py`
- `python/nexus/services/consumption/{_lectern_store,_listening_store,_projection,service}.py`
- `python/nexus/services/podcasts/{playback_preferences,subscriptions,subscriptions_query,episodes}.py`
- `python/nexus/services/{media,library_entries}.py`
- existing listening-state, podcast-settings, and BFF routes remain thin.

`_lectern_store.py` adds `podcast_id` to `LecternRow`; both descriptor builders
and `_PlayerDescriptorRow` remain in `_projection.py`. Do not move either
builder into the store.

Frontend:

- `apps/web/src/lib/lectern/contract.ts`
- `apps/web/src/lib/player/{playbackRate,globalPlayer,listeningHeartbeat,mediaSession,playerChromeModel}.ts[x]`
- `apps/web/src/lib/podcasts/subscriptionSettings.ts`
- `apps/web/src/components/player/{PlayerControls,PlayerPlaybackControls,DesktopListeningShelf,MobileMiniPlayer,MobileNowPlaying,GlobalPlayerSurfaces,PlayerOutputEffectsControls}.tsx`
- `apps/web/src/app/(authenticated)/podcasts/{PodcastSubscriptionSettingsModal,usePodcastSubscriptionSettingsModal,PodcastsPaneBody}.ts[x]`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/{PodcastDetailPaneBody,episodeTranscript}.ts[x]`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/lib/libraries/entryListItem.ts`
- the current route-owned `podcastSubscriptions.ts`, which loses the moved
  settings transport but retains unrelated subscription actions.

Tests/docs:

- focused Consumption projection/listening, Podcasts, migration, player contract,
  runtime, Media Session, surfaces, accessibility, and E2E tests;
- `docs/{architecture.md,modules/player.md}`;
- superseded playback-rate clauses in the three governing cutover documents.

Touch additional adopters only when the hard-cut type/compiler or residue search
proves they consume a deleted shape. Delete ownerless code; do not perform
adjacent refactors.

## Acceptance Criteria

1. One pure resolver passes the full three-row truth table and both Lectern and
   batched descriptors emit identical resolution.
2. An untouched episode with podcast default `1.5x` starts at `1.5x`; without
   one it starts at `1x`.
3. Preview/Mark Played/reset-created synthetic state does not shadow podcast
   inheritance.
4. Blocked autoplay followed by pause, dismissal, source switch, or unload
   creates no listening row, episode rate, or listening recency.
5. First canonical `playing` establishes and immediately checkpoints the
   resolved preferred rate; reload preserves it after the podcast default
   changes.
6. An explicit `1.8x` change before play, while playing, or while paused
   establishes the episode rate and immediately changes audio, UI, Media
   Session, and the latest coalesced sample.
7. A paused rate change survives a failed PUT, 409 recovery, and persistence
   suspension: successful recovery resends it without requiring playback or a
   cadence tick, and reload remains `1.8x`.
8. The next untouched episode still uses the podcast default, not the prior
   episode rate.
9. **Remember for this podcast** has Ready/Pending/Failed behavior, installs only
   for the matching active podcast, affects later untouched episodes, and does
   not change established episodes.
10. A lapsed-subscription `E_NOT_FOUND` retains the episode rate, removes
    podcast-scope actions, and announces a non-retryable failure.
11. The subscription modal round-trips `Absent`, presets, and arbitrary valid
    values such as `1.85x` without coercion or silent clobbering.
12. **Use podcast speed** compares persistent preferred against inherited,
    excludes temporary normal mode, changes only the current episode, and
    checkpoints it.
13. Temporary `1x` sounds and displays `1x`, persists the preferred episode
    rate, and returns exactly to it.
14. Every source/session boundary clears temporary normal mode before installing
    the next source, including history and natural successor transitions.
15. Every valid product value displays truthfully; formatting removes
    floating-point noise and no non-preset value renders as `1x`.
16. Provider-owned and silence-trim `ratechange` echoes do not mutate durable
    state; a valid unexplained external change behaves exactly as a normal
    change and clears temporary normal mode.
17. Preview starts at `1x`, may change locally, and emits no heartbeat or podcast
    mutation.
18. Every owned audio element preserves pitch; in-range rejection and invalid
    unexplained `ratechange` enter modeled playback failure without a `1x`
    fallback.
19. Adjusted time left derives in the panel from Timeline plus base rate while
    source time and Settings render cadence remain unchanged.
20. Keyboard, screen reader, focus return, 320 px/400% zoom, touch targets,
    reduced motion, and forced colors pass.
21. Old scalar/null/fallback/range paths, preset-only controls, stale descriptor
    resolution state, and dead tests are absent.

## Required Proof

- Unit: resolver, parsing/FP-robust formatting, bounds/step, derived capability,
  expected-rate token classification, and adjusted remaining time.
- Integration: real database and public APIs for inheritance, nullable synthetic
  rows and migration classification, Presence heartbeat CAS, Remember/clear,
  lapsed subscription, Reset, and both descriptor paths.
- Heartbeat engine: dirty coalescing, failure/409 recovery, ticks during
  suspension, recovery resend while paused, keepalive non-acknowledgement, and
  empty-preplay suppression.
- Component/runtime: arbitrary rate in player and modal, matching-podcast
  settings install, paused immediate checkpoint, temporary `1x`, owned/external
  `ratechange`, pitch, Media Session, every source boundary, Preview, Settings
  versus Timeline render cadence, overlays, focus, and accessibility.
- E2E real stack:
  `set podcast 1.5 -> untouched episode starts 1.5 -> set episode 1.75 ->
  reload resumes 1.75 -> next untouched episode starts 1.5`.
- Manual Chrome and Android WebView at `0.5x`, `1x`, `2x`, and `3x`: pitch,
  background/interruption, Bluetooth, and lock-screen position.
- Static, migration, focused tests, `git diff --check`, residue search, and
  screenshot review.

Focused local proof is not real-stack, device, CI, deploy, or production proof.
Report each gate separately.

## Implementation Order

1. Land Podcast Freshness; re-read the actual Alembic head and reconciled
   settings-client surface.
2. Write failing resolver, migration, Presence-heartbeat, recovery, contract,
   runtime, modal, cadence, and E2E tests.
3. Apply the destructive migration and hard-cut backend schemas/storage.
4. Add the cycle-free Podcasts leaf batch query and Consumption resolver; add
   `podcast_id` to both row types and cut both descriptor builders together.
5. Hard-cut wire decoders and every explicit adopter; remove duplicate raw
   fields/fallbacks.
6. Install provider-owned episode/preference/temporary/observed/remember state,
   dirty recovery, expected-rate ownership, immediate checkpoint, pitch, and
   Media Session behavior.
7. Build the shared Playback panel/editor with existing Dialog/MobileSheet
   primitives; replace the subscription modal Select and install the shared
   settings-client notification.
8. Delete legacy files/branches/tests, update canonical/sibling docs, and run
   residue searches.
9. Run focused proof, then real-stack and manual-device gates.

## Final State

Consumption resolves one canonical playback-rate policy through a cycle-free
Podcasts leaf. Podcasts owns the only reusable source preference. Listening state
records only explicitly established episode resume rate; absence survives every
wire and synthetic-row path. The global player derives live policy state,
applies it through one owned audio-rate writer, and durably checkpoints the
latest dirty sample through recovery. Every player and subscription-settings
surface displays the same truthful numeric value and explicit scope. No stale
descriptor resolution, preset-only editor, client fallback, duplicate default
field, legacy scalar shape, global preference platform, generic event bus, or
alternate playback engine remains.
