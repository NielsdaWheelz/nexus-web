# Global Player Surfaces Hard Cutover

Status: IMPLEMENTED; focused local proof complete; real-stack, manual-device,
CI, deploy, and production gates pending; type: hard cutover; date: 2026-07-30

Playback-rate policy, controls, and Settings capability are superseded by
[`playback-rate-policy-hard-cutover.md`](playback-rate-policy-hard-cutover.md).
This document remains canonical for player-surface and dismissal behavior.

Android runtime, output-effects, pause-shortening, and natural-end ownership are
superseded by
[`android-native-player-pause-shortening-hard-cutover.md`](android-native-player-pause-shortening-hard-cutover.md).
The surfaces and dismissal grammar remain canonical.

## Decision

Replace `GlobalPlayerFooter` with one shell-owned player presentation system:

- desktop **Listening Shelf**;
- mobile **MiniPlayer**;
- mobile full-screen **Now Playing**.

Preserve the current Lectern, player-session, heartbeat, audio-effects,
Walknotes, PreviewAudio, Consumption, and Media Session owners. Add explicit
player dismissal. Split the monolithic React capability and presenter without
rewriting the playback engine.

This document supersedes the presentation clauses in
`lectern-player-lifecycle-hard-cutover.md` that retain the old footer and
expanded `MobileSheet`, and adds the one new lifecycle transition
`dismissSession`. The prior document remains authoritative for every other
origin, history, completion, heartbeat, and Lectern semantic.

Open questions: none.

## Governing Rules

- `docs/rules/{boundaries,cleanliness,control-flow,frontend,naming,simplicity,testing}.md`
- `docs/modules/{player,overlays,workspace}.md`
- `docs/chapbook.md` — Listening and watching; bottom-region arbitration

## Goals

1. Make listening calm, legible, fast, and platform-native.
2. Separate session lifetime, playback phase, and presentation mode.
3. Share one semantic model and control vocabulary across all player surfaces.
4. Preserve one audio session and every existing durable correctness contract.
5. Remove duplicated controls, raw glyphs, undersized targets, silent
   persistence failure, shortcut collisions, and implementation-facing copy.
6. Reduce high-frequency React fan-out without adding a state library.

## 80/20 Scope

Included:

- the three surfaces and their responsive, accessible presentation;
- `Pause`, `Resume`, `Collapse`, and `Dismiss` semantics;
- canonical and PreviewAudio states;
- cadence-aligned player capabilities and provider-owned `<audio>`;
- shared identity, timeline, transport, status, actions, and Capture controls;
- existing chapter markers plus one chapter/Contents surface using canonical
  descriptor data;
- focus, Escape/Back, safe area, Nexus clearance, reduced motion, forced
  colors, Media Session `stop`, and player shortcut hardening;
- stable player accessible names, focused tests, one real-stack mobile journey,
  and canonical docs.

Excluded:

- backend, database, BFF, wire-schema, or migration changes;
- a second queue, queue editor, or changes to Lectern ordering/successor rules;
- cross-device session transfer, remote control/output routing, downloads,
  sleep timer, video/PiP, AI chapters, generated artwork, waveform seeking,
  dynamic color extraction, analytics, preferences, or feature flags;
- transcript/chapter data duplication inside the player;
- queue browsing/editing, a remaining-time display mode, or new player
  preferences;
- a generic full-screen-surface framework;
- Media Session enhancements unrelated to dismissal.

## Target Behavior

| Intent | Session | Audio | Presentation | Durable/domain effect |
|---|---|---|---|---|
| Pause | retained | paused | unchanged | heartbeat observes position |
| Resume | retained | playing | unchanged | existing heartbeat |
| Collapse / Back / Escape | retained | unchanged | Now Playing → MiniPlayer | none |
| Close player | `Absent` | stopped and unloaded | all player chrome removed | best-effort final heartbeat; no reset/completion |
| Finish / natural end | existing lifecycle | existing lifecycle | successor or retained end state | existing completion command |

Rules:

- Player visibility derives from session presence, never from `isPlaying`.
- Pause never closes, collapses, navigates, or clears metadata.
- “Close player” is the product label for `dismiss()`. It has no confirmation.
- Dismiss while playing stops playback; hidden continuing audio is forbidden.
- Dismiss is always available, including while transport is locked for
  completion.
- Dismiss preserves canonical listening progress, completion/activity history,
  explicit status, Lectern membership, notes, and annotations.
- Dismiss never invokes Finish, Unread, ResetProgress, Remove, or Preview
  acquisition.
- Dismiss clears device-local player back/forward history. A later explicit Play
  starts a new session and resolves resume position through the existing
  authority chain.
- Collapse and dismiss are separate visible actions. Gesture-only access is
  forbidden.

## Surface Contract

### Desktop Listening Shelf

- Shell-resident bottom region; present for every non-`Absent` state.
- One adaptive row, minimum 72 px block size; it grows for text zoom.
- Left: artwork, title link, source/current chapter, next provenance.
- Center: Previous, −15, Play/Pause, +30, Next, native seek range, elapsed /
  duration.
- Right: Capture, Playback speed, volume, More, Close.
- Play/Pause is the sole visually primary transport.
- Container queries move secondary labels/actions into More. Identity,
  Play/Pause, seek/time, status, and Close remain available.
- More is the exhaustive fallback inventory: Capture/Review, Open source, and
  Contents/Lectern. An action is direct or in More,
  never both. Close remains direct. Do not create an unnamed overflow owner.
- Preserve chapter tick markers on the seek track. Preview omits Previous, Next,
  Capture/Review, Contents/Lectern, and durable status actions instead of
  rendering them disabled.

### Mobile MiniPlayer

- One 64 px minimum shell-bottom accessory registered as obstruction `"Player"`;
  the existing clearance projection positions Nexus above it.
- Top-edge display-only progress; artwork; ellipsized title/current chapter;
  Play/Pause; +30; More.
- Capture is direct when width permits and otherwise first in More.
- A real `Button` containing artwork/title opens Now Playing; no clickable
  `div` or aggregate row handler.
- More contains Capture/Review, Playback speed, Previous/Next when applicable,
  Open source, Contents/Lectern, and Close player.
- Every frequent target is at least 44 × 44 CSS px.
- `MobileViewportProvider` owns `rootTextEntryFocused` through one document
  `focusin`/`focusout` observer and a new `isTextEntryTarget` predicate. It
  matches `textarea`, contenteditable/ARIA textboxes, and text-like `input`
  types (`text`, `search`, `email`, `url`, `tel`, `password`, `number`, or
  omitted); it excludes modal-layer focus, `select`, and non-text inputs. A
  deferred focusout re-reads `document.activeElement`. While true, keep the
  MiniPlayer mounted but hidden/inert and unregister `"Player"`; playback
  continues through system controls. Add no second `visualViewport` or keyboard
  geometry owner.
- Preview omits Previous/Next and canonical-only actions.

### Mobile Now Playing

- Shell-owned, portaled, full-viewport modal mode; not `MobileSheet`, a workspace
  pane, or a persisted route.
- Uses `useDialogOverlay`, `useHistoryDismiss`, `ModalLayerProvider`, and the
  shared backdrop projection from `lib/ui/useModalLayer.ts`. It stays mounted
  across active/inactive cycles.
- Covers root chrome; the modal focus/body/backdrop contract makes the underlay
  non-interactive. Root Nexus is hidden. MiniPlayer stays mounted for causal
  focus/motion but is hidden, inert, and obstruction-suspended.
- Header: Collapse (`ChevronDown`) and “Now Playing” only. Do not place a
  session-killing `X` in the conventional collapse position.
- Upper field: artwork or the owned placeholder, plus source identity.
- Reachable field, in priority order: status; native seek/time; Previous, −15,
  Play/Pause, +30, Next; Capture; Playback speed; current chapter/Contents and
  next provenance; Open source/Lectern and Review captures; labeled Close
  player.
- On short viewports artwork yields first, then secondary metadata compacts into
  one labeled More action in the lower field; status, seek/time, primary
  transport, Collapse, and Close remain reachable without horizontal scroll.
  Secondary rows may scroll vertically inside the owned viewport.
- Back, Escape, and Collapse return to MiniPlayer without changing playback.
- Collapse restores focus to the still-mounted MiniPlayer opener. Close
  dismisses the session, announces “Player closed,” and returns focus to
  `findPaneChromeFocusTarget(activePrimaryPaneId)`.
- Playback, Contents, and Walknote review use named
  `MobileSheet`/dialog primitives as short subordinate tasks. Every subordinate
  menu, sheet, and dialog uses history dismissal; Back/Escape unwinds exactly
  one layer before Now Playing collapses.
- Preview omits Previous/Next and all canonical-only actions.
- No drag-to-dismiss requirement. No backdrop-dismiss ambiguity.

### Visual and Accessibility Rules

- Pin the Lucide vocabulary: `ChevronDown`, `SkipBack`, `RotateCcw`,
  `Play`/`Pause`, `RotateCw`, `SkipForward`, `Gauge`, `Volume2`, `List`,
  `Mic`, `Ellipsis`, and `X` only where it means Close player. Use `Button`,
  `ActionMenu`, `Select`, `MediaImage`, existing tokens, and semantic labels.
  Delete raw Unicode transport glyphs.
- Use existing surfaces, typography, spacing, edge, radius, focus, shadow,
  duration, and easing tokens. Do not add a player-only token system.
- Visual floor: flat hairline-edged surfaces without cards/shadows; ghost
  transports with Play/Pause as the sole filled control; tabular-nums mono
  timecodes; the editorial kicker as the identity signature; a display-scale
  Now Playing title; and a typographic-monogram artwork placeholder.
- Now Playing enters from the MiniPlayer’s bottom edge with
  transform/opacity-only `translateY` motion at `--duration-slow`. Motion is
  interruptible. Reduced motion removes translation and preserves the state
  change through an immediate transition or short fade.
- Native `input[type=range]` remains the seek owner. Supply a visible timecode
  and human-readable `aria-valuetext`; retain keyboard and direct-tap behavior.
- Scrubbing owns a local draft position during pointer drag; the visual
  track/time preview follows input and `seekTo` commits once on release.
  Keyboard/native assistive changes commit discretely. Cancel/blur commits the
  last valid draft once; never send a per-input heartbeat firehose.
- Mobile reflows at 320 CSS px and 400% zoom without horizontal scrolling.
- Controls and meaningful state graphics meet non-text contrast; forced colors
  retain track, thumb, focus, and state visibility.
- Preserve one active surface landmark named `Media player`, transport names
  `Play media player`/`Pause media player`, and the runtime audio label
  `Media player audio`. These are public DOM contracts.
- `GlobalPlayerSurfaces` owns one provider-lifetime polite live region outside
  every inert/hidden surface. Announce track, error, suspension, materialized
  Capture results, and “Player closed”; never elapsed time.
- MiniPlayer and Now Playing reserve a compact status slot for buffering,
  playback failure, completion failure, and persistence suspension. Failures
  expose their existing Retry/Open-source action.
- Hidden chrome is inert and absent from the accessibility tree.
- Screenshot review at desktop, 390 px, 320 px, and short-height mobile is a
  release gate; token compliance alone is insufficient.

## Final Architecture

```text
LecternProvider
└── GlobalPlayerProvider
    ├── pure playerSession transitions
    ├── one provider-owned <audio> at a time
    ├── heartbeat / effects / activity / Media Session
    ├── PlayerCommandsContext          stable
    ├── PlayerSessionContext           semantic cadence
    ├── PlayerSettingsContext          settings cadence
    └── PlayerTimelineContext          playback/RAF cadence
         │
         └── GlobalPlayerSurfaces
             ├── projectPlayerChrome (session-only, pure)
             ├── one usePlayerCapture controller
             ├── DesktopListeningShelf
             ├── MobileMiniPlayer
             └── MobileNowPlaying
```

Ownership:

- `playerSession.ts`: canonical session/history/dismiss transition.
- `globalPlayer.tsx`: audio runtime, transition effects, async fences, four
  capabilities, Media Session binding.
- `playerChromeModel.ts`: exhaustive domain-to-presentation projection; no
  React, DOM, I/O, timers, or duplicated state.
- `GlobalPlayerSurfaces`: session projection, presentation-mode state, the one
  live region, and composition only; it does not subscribe to settings/timeline.
- shared player controls: cadence-scoped leaf consumers and semantic rendering
  only. Timeline leaves receive Timeline; speed/volume/effects leaves receive
  Settings; transport receives Session plus stable Commands.
- `usePlayerCapture`: the one mounted Walknotes tap/hold/record controller.
- `MobileViewportProvider`: the existing safe-area/player/Nexus/keyboard
  geometry owner plus root text-entry focus ownership.
- transcript/chapter panes and Lectern remain their current domain owners.

Do not add Redux, Zustand, an event bus, a generic player framework, a second
concurrent audio element, or mirrored session state.

## State and Capability Contract

The session union remains unchanged. Add one effect and one total transition:

```ts
type PlaybackEffect =
  | { kind: "None" }
  | { kind: "StartSession" }
  | { kind: "RestartCurrent" }
  | { kind: "ResetCurrent"; positionMs: number }
  | { kind: "StopSession" };

function dismissSession(
  state: PlayerSessionState,
  history: PlayerHistory,
): SessionTransition;
```

`Absent` is a no-op. Every other canonical state returns `Absent`,
`EMPTY_HISTORY`, and `StopSession`. Match exhaustively.

Hard-cut the single `GlobalPlayerCapability` and `useGlobalPlayer`:

```ts
interface PlayerSessionCapability {
  state: GlobalPlayerState;
  persistence: PlayerPersistence;
  nextPreview: NextPreview;
}

interface PlayerTimelineCapability {
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  currentChapter: Presence<ChapterOut>;
  pauseShorteningSavedOnDeviceMs: Presence<number>;
}

interface PlayerSettingsCapability {
  volume: number;
  playbackRate: {
    scope: CanonicalPlaybackRateScope | { kind: "Preview" };
    preferred: number;
    temporaryNormal: boolean;
    base: number;
    observed: number;
    remember: PlaybackRateRememberState;
  };
  outputEffects: OutputEffectsState;
  outputEffectsAvailable: boolean;
  pauseShortening: PlayerPauseShorteningCapability;
}

interface PlayerCommandsCapability {
  playAudio(input: PlayerDescriptor): void;
  playPreviewAudio(input: PreviewAudioDescriptor): void;
  stopPreviewAudio(target: DiscoveryTargetHandle): PreviewAudioPosition | null;
  dismiss(): void;
  resume(): void;
  pause(): void;
  seekTo(positionMs: number): void;
  skipBy(deltaMs: number): void;
  previous(): void;
  next(): void;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  toggleTemporaryNormalRate(): void;
  useInheritedPlaybackRate(): void;
  rememberPlaybackRateForPodcast(): void;
  setOutputEffects(patch: Partial<OutputEffectsState>): void;
  setSessionPauseShorteningMode(mode: PauseShorteningMode): void;
  clearSessionPauseShorteningMode(): void;
  rememberPauseShorteningForPodcast(): void;
  setDeviceDefaultPauseShorteningMode(mode: PauseShorteningMode): void;
}

usePlayerSession(): PlayerSessionCapability;
usePlayerTimeline(): PlayerTimelineCapability;
usePlayerSettings(): PlayerSettingsCapability;
usePlayerCommands(): PlayerCommandsCapability;
```

Every command reads mutable runtime/snapshot values through refs and has stable
identity for the provider lifetime. In particular, `stopPreviewAudio` does not
close over timeline state, and Play/Previous/Next do not close over a Lectern
snapshot. Memoize the Commands capability once; prove that time updates,
pause-shortening snapshots, settings changes, and Lectern installs do not
commit command-only consumers.

`bindAudioElement` is deleted from the public capability. The provider renders
the hidden, non-duplicative `<audio aria-label="Media player audio">` itself.

`projectPlayerChrome` accepts only `PlayerSessionCapability` and returns an
exhaustive semantic union aligned with the real state machines:

```ts
type PlayerChromeModel =
  | { kind: "Absent" }
  | {
      kind: "Canonical";
      state: Extract<
        GlobalPlayerState,
        { kind: "Active" | "Completing" | "CompletionFailed"
          | "PlaybackFailed" | "PausedAtEnd" }
      >;
      persistence: PlayerPersistence;
      nextPreview: NextPreview;
    }
  | {
      kind: "Preview";
      state: Extract<
        GlobalPlayerState,
        { kind: "PreviewAudio" | "PreviewAudioFailed" | "PreviewAudioAtEnd" }
      >;
    };
```

The canonical and Preview variants cannot express one another’s phases or
actions. `transportLocked` is derived from canonical
`Completing | CompletionFailed`; it is not stored in the model. Retry closures
project the already-decorated public state and are not new ownership.
Do not rebuild one aggregate model/prop object from all four contexts. Surface
roots consume the semantic model; cadence-scoped leaf controls subscribe
directly to Settings or Timeline.

This is an in-process API only. Add no network endpoint, wire field, stored
schema, cookie, query parameter, or local-storage presentation state.

## Dismiss Runtime Contract

`dismiss()` handles canonical and PreviewAudio variants exhaustively through one
private teardown path. It bypasses `transportLocked`:

1. Increment the existing start generation, renamed `runtimeGeneration`, before
   asynchronous work can install state. It is the only player generation
   counter.
2. Invalidate `completionAttemptRef`; it stores `{ generation, token } | null`,
   never a naked boolean.
3. Sample canonical position/duration once. Call the existing
   `heartbeat.flushKeepalive()` then `heartbeat.stop()`.
4. Imperatively publish the closing Consumption activity observation from that
   sample and unregister its observer before touching the media element. Effect
   cleanup must not publish a later position-zero observation.
5. Stop silence trimming/activity playback; pause audio; clear pending start;
   remove `src`; call `load()`.
6. Clear preview/canonical state, history, timeline/transient errors, and reset
   player persistence to `Ready`.
7. Derive a null Media Session track so metadata, position, playback state, and
   handlers clear through the existing adapter.

Every completion captures its generation and unique token. It may set/clear the
latch or install player state only when both still match; an old promise cannot
clear a newer completion latch. Its domain command and canonical Lectern install
may finish after dismiss, but stale work cannot install a successor,
`PausedAtEnd`, error, audio source, or latch value. A parked completion failure
falls through to the existing shell `LecternMutationNotice`; dismissal never
deletes its Retry.

Required race proof: canonical `Completing` → Dismiss → explicit Play of a new
session → natural end invokes the new completion command exactly once and
performs its normal advance/terminal transition.

`stopPreviewAudio(target)` remains the acquisition handshake that returns a
position snapshot. It and `dismiss()` reuse the same private Preview teardown;
they are not aliases.

Final heartbeat delivery remains subject to the existing network contract.
Dismiss does not add offline progress storage or claim delivery while offline.

### Audio Runtime

- The provider owns one hidden audio element at a time. Surfaces never mount or
  bind media elements.
- `runtimeGeneration` triggers source/start work and fences all asynchronous
  state, including completion-latch writes.
- Suspend the `AudioContext` while inactive; deliberately close it only when the
  provider unmounts.
- `createMediaElementSource` captures an element once. If its context closes
  unexpectedly, mark effects unavailable for that element and rotate to a fresh
  provider-owned element generation at the next explicit Play/session boundary
  before re-enabling effects. Never bind the same element to a second context.
- Rotation preserves the sampled source, position, user rate/volume, and
  play/pause intent; at no time may two audio elements be active.

## Intra-System Composition

- Starting/switching playback does not open Now Playing or navigate a pane.
- Open source/Lectern/transcript/chapter actions use canonical workspace target
  activation. They never write directly to router/workspace state.
- Contents uses the descriptor’s existing chapter data and one short player
  surface; it adds no chapter store, fetch, or workspace route.
- Now Playing presentation state resets to MiniPlayer when the session becomes
  `Absent` or mobile mode exits. Manual Next, Previous, and automatic advance
  replace its content without collapsing it.
- Mobile MiniPlayer alone registers obstruction `"Player"`. Full-screen Now
  Playing keeps the MiniPlayer mounted but hidden/inert and unregisters its
  obstruction; the modal owns the viewport.
- PreviewAudio exposes only Preview-safe actions. It has no Capture, Lectern
  origin/history, completion, or durable heartbeat.
- Capture preserves existing tap waypoint, hold-to-record, transcription, red
  recording state, and review behavior. Mount its controller once; do not create
  one recorder per surface.
- Dismiss closes player-owned menus/sheets/review. If Capture is recording, stop
  the microphone immediately and finish the existing waypoint/transcription
  path without blocking dismissal.
- The provider-lifetime live region is a sibling of inert surface roots so
  Now Playing and text-entry hiding cannot silence it.
- Shell notices/toasts stack above the Listening Shelf/MiniPlayer and below the
  topmost modal layer; they do not alter obstruction geometry.
- Persistence suspension is visibly actionable while a player is present.
- Add the currently absent Media Session `stop` handler and route it to
  `dismiss`; play/pause remain phase-only.
- Player shortcuts ignore `defaultPrevented`, editable and interactive targets,
  ranges, modifier chords not owned by the player, and disabled scopes. Add no
  new shortcuts.

## Hard-Cut File Plan

Add:

- `apps/web/src/lib/player/playerChromeModel.ts`
- `apps/web/src/lib/player/playerChromeModel.test.ts`
- `apps/web/src/lib/ui/isTextEntryTarget.ts`
- `apps/web/src/lib/ui/isTextEntryTarget.test.ts`
- `apps/web/src/lib/walknotes/usePlayerCapture.ts`
- `apps/web/src/lib/walknotes/usePlayerCapture.test.tsx`
- `apps/web/src/lib/player/GlobalPlayer.runtime.test.tsx`
- `apps/web/src/components/player/GlobalPlayerSurfaces.tsx`
- `apps/web/src/components/player/GlobalPlayerSurfaces.module.css`
- `apps/web/src/components/player/PlayerControls.tsx`
- `apps/web/src/components/player/PlayerControls.module.css`
- `apps/web/src/components/player/DesktopListeningShelf.tsx`
- `apps/web/src/components/player/DesktopListeningShelf.module.css`
- `apps/web/src/components/player/MobileMiniPlayer.tsx`
- `apps/web/src/components/player/MobileMiniPlayer.module.css`
- `apps/web/src/components/player/MobileNowPlaying.tsx`
- `apps/web/src/components/player/MobileNowPlaying.module.css`
- `apps/web/src/components/player/PlayerPlaybackControls.tsx`
- `apps/web/src/components/player/PlayerOutputEffectsControls.tsx`
- `apps/web/src/components/player/PlayerContentsSheet.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerSurfaces.test.tsx`
- `apps/web/src/lib/player/usePlayerKeyboardShortcuts.test.tsx`

Modify:

- `apps/web/src/lib/player/{playerSession,globalPlayer,mediaSession,usePlayerKeyboardShortcuts}.ts*`
- `apps/web/src/lib/mobileViewport/MobileViewportProvider.tsx` and its test
- `apps/web/src/components/walknotes/WalknoteReviewPanel.tsx` and its test
- every current `useGlobalPlayer` consumer, mock, helper, and explanatory
  comment, including billing and Android-shell tests
- migrate, behavior-equivalently, `GlobalPlayerLifecycle`,
  `GlobalPlayerPersistence`, `GlobalPlayerOutputEffects`,
  `GlobalPlayerMediaSession`, and `GlobalPlayer.activity` tests to the split
  hooks/provider-owned audio
- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx`
- `apps/web/src/components/LecternMutationNotice.tsx`
- `e2e/tests/consumption-stats.spec.ts`
- `e2e/tests/lectern-player.spec.ts`
- `docs/{architecture,chapbook}.md`
- `docs/modules/{player,overlays,workspace}.md`
- `docs/cutovers/lectern-player-lifecycle-hard-cutover.md`

Delete:

- `apps/web/src/components/GlobalPlayerFooter.tsx`
- `apps/web/src/components/GlobalPlayerFooter.module.css`
- `apps/web/src/__tests__/components/GlobalPlayerFooter.test.tsx`
- old footer/minibar/sheet JSX, bespoke More popover, duplicated effects/status/
  seek controls, raw-glyph styles, dead selectors, stale tests, and
  implementation copy such as “Play in footer”.

Do not retain aliases, re-exports, deprecated hooks, compatibility components,
feature flags, old selectors, or dual tests.

## Implementation Order

This is one atomic PR. The sequence below is intra-PR authoring order, not
landable slices; no commit may expose adapters or mixed old/new APIs.

1. Red tests for every dismiss state, the completion-latch race, final activity
   sample, stable commands/render counts, root text-entry focus, DOM names,
   Pause/Collapse/Close, nested Back, and shortcut scoping.
2. Split capabilities; ref-route stable commands; add `dismissSession`; extend
   `startEpoch` into the one `runtimeGeneration`; add completion tokens, Media
   Session stop, imperative activity close, and owned-audio recovery.
3. Add the exhaustive chrome model and single Walknotes Capture controller.
4. Add shared controls/status/effects/Contents, Listening Shelf, MiniPlayer, and
   full-screen Now Playing.
5. Compose shell/mobile viewport, migrate every caller/test, and clean copy.
6. Delete legacy files; update canonical docs; run gates and focused proof.

## Acceptance Criteria

Functional:

1. Play creates the correct shelf/MiniPlayer; pane navigation never interrupts
   audio.
2. Pause retains the same surface and full-screen state. Resume continues.
3. Mobile identity Button opens full-screen Now Playing. Back, Escape, and
   Collapse return to the still-mounted MiniPlayer without an audio event.
4. Close from desktop, MiniPlayer, Now Playing, playback failure, completion,
   paused-at-end, and PreviewAudio reaches `Absent`, unloads audio, clears OS
   controls/history, resets persistence, and hides all surfaces. Completion lock
   never disables Close.
5. Closing then explicitly replaying canonical media resumes through existing
   progress authority and does not mark it Finished, Unread, reset, or removed.
6. Stale completion cannot mutate player state or a newer completion token.
   Completing → Close → new Play → natural end invokes and settles the new
   completion normally. A parked failure retains shell Retry.
7. Dismiss records the sampled final position in heartbeat and Consumption
   activity before unload; cleanup never replaces it with position zero.
8. Preview acquisition still receives its exact stop snapshot; ordinary Preview
   Close performs no acquisition or durable progress write.
9. Persistence suspension and every buffering/playback/completion state have a
   truthful, actionable slot on each applicable surface.
10. An unexpectedly closed effects context cannot be rebound to the captured
    element; the next explicit boundary rotates one fresh element and restores
    saved effects without concurrent audio.

UX/accessibility:

11. Desktop and 320/390 px/short-height mobile layouts satisfy the visual floor,
    expose no clipped primary action or horizontal scroll, and use 44 px mobile
    targets.
12. Now Playing owns modal focus/history/body lock. Every nested player
    menu/sheet/dialog unwinds first. Collapse returns to its MiniPlayer Button;
    Close returns to active pane chrome.
13. Canonical surfaces expose Previous/Next, chapter ticks, and Contents when
    available. Preview omits canonical-only actions.
14. Seek preview follows drag locally and commits once; keyboard and assistive
    operation retain native range semantics.
15. Exactly one active `Media player` landmark and the pinned transport/audio
    names survive the cutover. Screen-reader values, announcements, 200% text,
    400% reflow, forced colors, reduced motion, and non-text contrast pass.
16. Text entry, software keyboard, safe area, Nexus, sticky controls, notices,
    and focused content never collide with player chrome.
17. No document-global player shortcut steals Space/Arrow from a button, link,
    range, workspace control, editable/interactive surface, handled event, or
    unsupported modifier chord.

Structural/performance:

18. One provider, audio element at a time, session state machine, generation,
    heartbeat, Media Session adapter, Capture controller, and chrome model
    remain.
19. Commands stay identity-stable. Command-, session-, and settings-only
    consumers do not subscribe to playback/RAF cadence; timeline updates do not
    commit unrelated pane trees.
20. No backend/API/schema change exists. No legacy file/path/symbol survives.

## Required Proof

- Unit: every `dismissSession` state, idempotent Absent, history clear,
  exhaustive chrome projection, `isTextEntryTarget`, and seek-draft commit.
- Provider/browser: the exact completion-latch race; generation-gated latch and
  installs; sampled final activity; heartbeat flush then stop; Preview snapshot;
  effects-context element rotation; new Media Session stop; stable command
  identity.
- Render-count probe: timeupdate, buffering, silence-trimming RAF, settings
  change, and Lectern install prove only their owning capability consumers
  commit.
- Surface browser tests: all semantic states on all applicable surfaces,
  Preview action absence, chapter ticks/Contents, status/Retry slots,
  Pause/Collapse/Close, stable DOM names, live announcements, scrub commitment,
  root text-entry hiding, obstruction suspension, nested Back/Escape, both focus
  destinations, reduced motion, forced colors, and short viewport.
- Migrate the lifecycle, heartbeat, activity, effects, persistence, Media
  Session, Walknotes, reset, and shortcut suites to split hooks/provider audio;
  preserve behavior rather than keeping legacy imports.
- `e2e/tests/consumption-stats.spec.ts`: at 390 × 844, one owned audio item proves
  MiniPlayer → Now Playing → Pause → Back → Resume across pane navigation →
  Close; assert the pinned names and listening activity.
- `e2e/tests/lectern-player.spec.ts`: preserve the no-session `Media player`
  landmark canary and Lectern lifecycle assertions; it is not the audio journey.
- Browser/manual accessibility gate assigns 200% text, 400% zoom/reflow, forced
  colors, reduced motion, keyboard-only and screen-reader names/values, and
  non-text contrast. Attach reviewed screenshots for desktop, 390 px, 320 px,
  and short-height mobile.
- Manual primary-device gate: touch, Android Back through every nested player
  surface, rotation, safe area, software keyboard/text entry, background/lock
  screen controls, and media-key stop.

Negative gates:

```bash
rg "GlobalPlayerFooter|useGlobalPlayer|bindAudioElement|mobileExpanded|FOOTER_AUDIO_LABEL|buildFooterDescriptor" \
  apps/web/src e2e docs/architecture.md docs/chapbook.md docs/modules
rg "Play in footer|global player footer|Expanded player" \
  apps/web/src e2e docs/architecture.md docs/chapbook.md docs/modules
rg "⏮|⏭|◄◄|►►|More ▾" \
  apps/web/src/components apps/web/src/lib/player docs/chapbook.md
rg "MobileSheet" apps/web/src/components/player/MobileNowPlaying.tsx
```

All searches return empty.

Focused verification:

```bash
cd apps/web
bun run test:unit -- \
  src/lib/player/playerSession.test.ts \
  src/lib/player/playerChromeModel.test.ts \
  src/lib/ui/isTextEntryTarget.test.ts
bun run test:browser -- \
  src/__tests__/components/GlobalPlayerSurfaces.test.tsx \
  src/__tests__/components/GlobalPlayerLifecycle.test.tsx \
  src/__tests__/components/GlobalPlayerPersistence.test.tsx \
  src/__tests__/components/GlobalPlayerOutputEffects.test.tsx \
  src/__tests__/components/GlobalPlayerMediaSession.test.tsx \
  src/lib/player/GlobalPlayer.runtime.test.tsx \
  src/lib/player/GlobalPlayer.activity.test.tsx \
  src/lib/player/usePlayerKeyboardShortcuts.test.tsx \
  src/lib/mobileViewport/MobileViewportProvider.test.tsx \
  src/lib/walknotes/usePlayerCapture.test.tsx \
  src/components/walknotes/WalknoteReviewPanel.test.tsx
bun run typecheck
bun run lint:css-tokens
bun run lint
cd ../..
PLAYWRIGHT_ARGS='tests/consumption-stats.spec.ts tests/lectern-player.spec.ts --project=chromium' make test-e2e
git diff --check
```

Focused local proof, real-stack E2E, manual device proof, CI, deploy, and
production proof must be reported separately.

## Final State

Nexus has one durable player runtime and one coherent interaction grammar.
Desktop renders a Listening Shelf; mobile renders a compact MiniPlayer that
expands into true full-screen Now Playing. Session presence, playback phase, and
presentation mode are independent. Pause retains; Back collapses; Close stops
and dismisses. The old footer, expanded player sheet, monolithic capability,
duplicated controls, legacy copy, and compatibility residue do not exist.
