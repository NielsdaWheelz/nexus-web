# Mobile Nexus Adjacent-Tab Swipe Hard Cutover

**Status:** IMPLEMENTED IN SOURCE · LOCAL VERIFICATION IN PROGRESS · PHYSICAL
USB GATE PENDING · 2026-08-24 · revision 3

**Type:** Atomic hard cutover — no legacy path, fallback, compatibility shim,
dual API, feature flag, or partial migration

**Scope:** Mobile Nexus pointer input plus the shared authenticated-workspace
adjacent-pane command

Follow [`docs/rules/`](../rules/index.md) and
[`docs/local-rules/testing-standards.md`](../local-rules/testing-standards.md),
especially cleanliness, simplicity, boundaries, frontend, control flow, and
behavior-first proof.

## Questions and locked decisions

Open questions: none.

- Tap keeps opening Nexus.
- Primary-touch horizontal swipe switches one adjacent visible primary pane.
- In the current LTR shell, left means `Next` and right means `Previous` in
  stable `primaryPaneOrder`; minimized panes are skipped.
- First/last clamp on every input. Traversal never wraps, restores, creates,
  ranks, or predicts. This deliberately replaces `WorkspaceHost`'s current
  keyboard modulo wraparound (`WorkspaceHost.tsx:1713-1714`, bound to
  `Meta+Shift+arrowright` / `Meta+Shift+arrowleft` in
  `apps/web/src/lib/keybindings.ts:9-10`, surfaced in settings as "Next pane" /
  "Previous pane", `settings/keybindings/KeybindingsPaneBody.tsx:52-53`),
  accepting divergence from the browser/editor wrap convention: one store-owned
  edge policy is the point of this cutover, random access to any tab is one tap
  away in Nexus / Manage Tabs, and the workspace holds few primary panes.
  Cycling past the last visible pane is removed deliberately and is restored by
  no option, preference, parameter, or fallback — a per-input `edge` option
  would re-create the duplicate policy being deleted. No existing test or
  normative doc asserts wraparound (verified across `apps/web/e2e/journeys`,
  workspace component tests, `docs/modules/`, and `docs/architecture.md`), so
  no supersession is owed for it and `WorkspaceHost.tsx` is the complete
  deletion surface for the old edge policy.
- Vertical, diagonal, long-press, multi-touch, mouse-drag, and pen-drag acquire
  no command.
- The 48px Nexus button is the complete gesture target. No invisible lane or
  whole-content swipe region exists. Pointers outside the 48px target are never
  observed by the recognizer and behave natively.
- Chromium and Android WebView are the supported browser matrix. No iOS/Safari
  compatibility path is added.
- Android edge conflict is a physical acceptance gate evaluated two ways.
  (a) Deterministic oracle: `NexusControlGestureTest.kt` resolves the fixture
  target's rectangle and asserts its overlap with the device-reported
  `WindowInsets.Type.systemGestures()` and `Type.mandatorySystemGestures()`
  right and bottom bands, recording the measured band widths, the back-gesture
  sensitivity setting, and the resolved `env(safe-area-inset-right)` in every
  failure message. This oracle does not depend on injected events reaching
  SystemUI. (b) Real-finger confirmation: the operator matrix below. Because
  Back on this shell is `webView.goBack()` (`MainActivity`'s back dispatcher;
  the manifest declares no `enableOnBackInvokedCallback`), a swipe lost to the
  system is a visible history navigation, not a silent no-op, and counts as a
  gate failure. If the current `right: max(16px, var(--viewport-safe-right))`
  geometry overlaps the measured back band on the attested handset at default
  sensitivity, this cutover stops and the single permitted revision is the
  wrapper inset in `switchboard.module.css`, re-proved through the same gate
  and re-checked against the existing mobile-geometry journey. Adding
  `setSystemGestureExclusionRects`, any production Android change, an invisible
  lane, or a relaxed acceptance row remains forbidden.

## Decision and final state

Add one deterministic accelerator to the existing Nexus control:

```text
NexusButton primary-touch Pointer Events
  -> Previous | Next
  -> NexusController.activateAdjacentPane
  -> WorkspaceStore.activateAdjacentPane
  -> resolve current visible primaryPaneOrder
  -> existing activate_pane reducer action
  -> existing active-pane, URL, persistence, title, and focus projection

useAdjacentPaneKeybindings (pane-next / pane-previous)
  -> the same WorkspaceStore command
  -> WorkspaceHost's existing keyboard focus request via Activated.paneId

tap / Enter / Space / assistive-technology activation
  -> existing Nexus open path
  -> existing Manage Tabs exact selection and minimized restore
```

The gesture is a shortcut to the workspace capability, not a second navigation
model. Sequential access is gestural; random access and management remain
visible in Nexus.

### Superseded clauses

Scope, non-goal, ownership-lock, and scope-acceptance statements in a prior
cutover record the boundary of that implementation; they are superseded by
name here rather than reinterpreted, and no clause of a prior cutover is
treated as a standing prohibition on later work unless this document leaves it
authoritative.

This specification supersedes only these clauses:

- in [`mobile-nexus-control-hard-cutover.md`](mobile-nexus-control-hard-cutover.md):
  - the non-goal `no Switchboard, Find, creation, Places, pane, …, workspace,
    persistence, backend, API, database, or schema change` (:83-84), insofar
    as it forbids the workspace-store command and controller/button API added
    here;
  - the non-goal `no new gesture, haptic, long-press, swipe, shared-element
    transition, or animation system` (:87-88);
  - the `NexusButtonProps` interface block (:146-152);
  - the bullet `` `onOpen` remains the only command. No counter-specific event
    exists.`` (:163);
  - the stale `beginSwitchboardPerformance(NEXUS_OPEN_PERFORMANCE)` reference
    (:165), which is corrected to the live `beginNexusPerformance`
    (`NexusButton.tsx:12,67`);
  - the clause `No public API, wire contract, persisted schema, capability
    registry, event name, controller state, or provider interface changes`
    (:168-169), insofar as it forbids controller state and the component
    interface;
  - AC9 — Scope (:329-330);
  - the ownership lock `Do not modify `useNexusController`, `Nexus`, …`
    (:290-293), with respect to `useNexusController.ts` and `Nexus.tsx` only.
- in [`mobile-nexus-switchboard-hard-cutover.md`](mobile-nexus-switchboard-hard-cutover.md):
  - the target-behavior clause `Tap opens Switchboard Root. The control has no
    swipe, long-press, context-menu, or multitouch behavior.` (:146-147);
  - the non-goal `No Nexus swipe/long-press accelerators or other hidden
    gesture vocabulary.` (:128);
  - the negative gate `No Nexus swipe/long-press/context-menu gesture
    handler.` (:752);
  - the term `no hidden gesture handlers` in AC4 (:794);
  - the item `absence of gesture handlers` in the Verification § Browser list
    (:842).
  - Its scope note that Nexus gestures are outside that cutover (:79) is a
    historical statement about that cut and is left unchanged.

Each superseded clause is rewritten in place to state the final contract;
deletion alone is insufficient wherever the surrounding bullet still carries
live requirements (48px target, `aria-haspopup="dialog"`, exact
singular/plural accessible name, aria-hidden counter, tap-opens-Root, and the
synchronous open-measurement ordering). The control doc's `NexusButtonProps`
block is additionally stale against shipped code — it declares
`onOpen: () => void` and omits `onButtonNodeChange`, while the live props are
`onOpen: (opener: HTMLButtonElement) => void` plus optional
`onButtonNodeChange` (`NexusButton.tsx:17-27`) — and is republished as the
full current interface from this document's Nexus composition section. The
no-hidden-gesture acceptance clause is replaced by the accessibility
acceptance criterion below, not merely deleted.

All other control anatomy (AC1–AC8), count, full-screen task, focus, mobile
chrome, viewport obstruction, reader, player, and Switchboard contracts remain
authoritative, as do the control doc's persisted-schema, wire-contract,
capability-registry, and Android-native prohibitions, which this cut does not
touch. In particular, the full-screen Nexus task still has no swipe dismissal.
No other cutover is edited. `desktop-nexus-switchboard-hard-cutover.md:121`
(`WorkspaceHost` retains the `pane-next`/`pane-previous` bindings — still true:
the host remains the bindings' mount point and focus consumer; only combo
matching moves into the hook it calls) and
`pane-search-foundation-hard-cutover.md:561-563` (legacy ids un-renamed;
`Pane.Search` still arbitrated before pane-next/previous) remain true after
this cut and must not be touched; `mobile-nexus-full-screen-task-hard-cutover.md`
and `mobile-reader-unified-scroll-chrome-hard-cutover.md` are unaffected.

## Goals

1. Switch adjacent tabs without opening Nexus while preserving tap and access.
2. Give touch and keyboard one deterministic workspace-owned rule.
3. Delete `WorkspaceHost`'s duplicate traversal policy.
4. Prove each changed boundary once at its smallest reliable layer.

## Scope

In scope:

- one workspace relative-activation command over the existing reducer action;
- migration of existing `pane-next` / `pane-previous` keybindings to it,
  extracted into one workspace-owned keybinding hook with its own proof;
- one primary-touch Pointer Events recognizer on the inner Nexus button;
- click suppression for a consumed pointer gesture;
- static discoverability copy in Manage Tabs, on the mobile surface only;
- one test-only Android WebView pointer-delivery proof at the Player-absent
  worst-case target geometry, plus the two coupled test-control registrations
  it requires (`testdata/proofs.json`, `PRIORITY_RISK_OWNERSHIP_SHA256`);
- affected behavior proof, journey preservation, normative docs, and residue.

No persisted, transport, backend, database, production-native, or
cross-process schema changes exist.

## Non-goals

- No swipe on pane content, reader content, top chrome, Nexus task, or backdrop.
- No vertical action, overview, marking menu, scrubber, fling, inertia, pane
  animation, neighboring-pane mount, screenshot, preview, or prefetch.
- No preferences, onboarding state, learned/AI mapping, telemetry, haptics,
  Android production bridge, gesture inset schema, or exclusion rectangle.
- No generic `useSwipe`, carousel, gesture dependency, or reusable pointer
  framework.
- No pane reorder, minimize/restore, count, cap, history, or persistence redesign.
- No desktop visual redesign. Only existing next/previous end behavior changes
  from wrap to clamp; no per-input edge option is added.
- No new journey, performance mark, or raw pointer recording.

## Target behavior

| Input/state | Required result |
| --- | --- |
| Tap below movement slop | Existing `nexus-open` measurement starts, then Nexus Root opens |
| Enter, Space, AT click, mouse click, pen tap | Existing native-button open behavior |
| `pane-next` / `pane-previous` keybinding | Same visible order and clamp policy on every viewport |
| `pane-next` / `pane-previous` while Nexus is open | Unchanged: the keybinding listener stays unconditional and only the existing `isEditableTarget` guard applies. Do not add a Nexus-open guard to the keyboard path — the open-state block below is pointer arbitration owned by `NexusButton`, not a workspace-command rule, and the workspace layer must not consume Nexus state |
| Primary-touch left swipe | Activate the next visible pane once |
| Primary-touch right swipe | Activate the previous visible pane once |
| First/last visible pane | No state change; never wrap |
| One visible pane | No state change |
| Minimized neighbor | Skip it; never restore it implicitly |
| Jitter within slop | The recognizer stays out of the way; the platform's own tap/click decision governs and is never suppressed |
| Motion beyond slop but below commit threshold | Cancel; do not switch or open Nexus |
| Vertical/diagonal motion | Yield/cancel; do not switch or open Nexus |
| Reversal before release | Direction and commit resolve from final `dx` only; below the commit displacement it cancels |
| `pointercancel`, lost capture, unmount | Cancel with no command |
| Any additional `pointerdown` while tracking, including before slop | Arm suppression for that stream's compatibility click, then cancel with no command |
| Two rapid committed swipes | Reducer applies both against sequential current state |
| Button not operable (`motionPhase.kind` neither `Visible` nor `Pinned`) or Nexus already open — at acquisition or at release | No stream may begin; a stream that becomes inoperable arms same-stream click suppression, then cancels without dispatch |
| Successful swipe | Nexus stays closed; `nexus-open` is not started |
| Same-stream compatibility click after committed/cancelled non-tap intent | Suppressed before Nexus-open measurement |
| Fresh touch, mouse, or pen activation after a committed or cancelled swipe | Its Idle `pointerdown` consumes stale suppression before acquisition filtering, so native activation opens Nexus normally |
| Active pane change | Existing URL, document title, persistence, and mobile landmark focus apply; on a committed swipe focus therefore leaves the button for the activated pane's landmark and is not restored to the button, and the button's pressed state clears |
| Reduced motion | Same semantics; no new motion is required |

The pane count continues to include every ordered primary pane, including
minimized panes. Count inventory and sequential traversal intentionally have
different visibility policies.

## Capability contract and API design

### Workspace owner

Add one semantic type and one command to the existing workspace store:

```ts
export type WorkspaceAdjacentPaneDirection = "Previous" | "Next";

export type WorkspaceAdjacentPaneActivationResult =
  | { readonly kind: "Activated"; readonly paneId: string }
  | { readonly kind: "Unchanged" };

interface WorkspaceStoreValue {
  activateAdjacentPane(input: {
    readonly direction: WorkspaceAdjacentPaneDirection;
  }): WorkspaceAdjacentPaneActivationResult;
}
```

`readonly` matches the store's public result surfaces (`NexusController` in
`useNexusController.ts`, `NexusDispatchOutcome` in `lib/nexus/dispatch.ts`);
`Unchanged` matches the existing `WorkspaceTargetActivationResult` vocabulary
(`targetActivation.ts:46-56`). No discriminated `Unavailable` reason is added:
no surface in this cutover branches on one, and the only-visible-pane and
boundary conditions coincide at one visible pane, so a reason union could not
even be asserted deterministically.

Command rules:

1. Read ordered panes from `stateRef.current` at command time.
2. Filter to `visibility === "visible"`.
3. Defect if the active identity is absent from that visible sequence.
   `ensureActivePaneId` (`lib/workspace/workspaceRestore.ts:80-102`), the
   `minimize_pane` and `close_pane` replacement searches in `store.tsx`, and
   the persisted-state parse guard `workspace state.activePrimaryPaneId must
   identify a visible pane` (`lib/workspace/schema.ts`) together make an
   active-but-not-visible pane unrepresentable, so this is a broken workspace
   invariant, not an `Unchanged` product branch. The throw carries a
   `// justify-defect:` comment naming those owners, per `docs/rules/errors.md`
   and the precedents at `store.tsx:177` and `store.tsx:303`. Never clamp a
   missing index to `0` or `-1`, and never reintroduce modulo arithmetic that
   absorbs `-1`.
4. Resolve `Previous = -1`, `Next = +1`.
5. Return `Unchanged` without dispatch when the active pane is the only
   visible pane or when the requested neighbour would fall outside the visible
   sequence.
6. Otherwise commit the existing `{ type: "activate_pane", paneId }` action and
   return `Activated` with that exact identity. Because the helper reduces the
   action against `stateRef.current` before dispatch, the returned identity is
   always the pane the reducer will make active.

Generalize `commitTargetActivation` (`store.tsx:1291-1304`) into one
`commitWorkspaceAction` owner and route target activation, adjacent
activation, and exact `activatePane` through it. For exact `activatePane` this
is a deliberate, intended change: it is a bare dispatch today
(`store.tsx:1206-1208`) whose URL projection happens later in the
`mounted`-guarded converge layout effect (`store.tsx:1200-1203`); after the
cut it reduces from `stateRef.current`, synchronously updates that ref,
projects the URL, then dispatches, exactly like target activation. The
projection stays idempotent (`projectWorkspaceStateToUrl` writes only when the
projected href differs from `window.location`), and `activatePane`'s callback
identity now depends on `commitWorkspaceAction`.

The existing state→URL layout effect is NOT deleted: it remains the owner of
initial-state convergence and of every command that still dispatches bare
(`minimize_pane`, `close_pane`, `go_back_pane`, `go_forward_pane`,
`restore_closed_pane`, `resize_primary_pane`, and `restore_pane` when
dispatched outside the helper — the target-activation restore plan already
commits it through the helper, `store.tsx:1372`). Its comment
is rewritten to name `commitWorkspaceAction` instead of
`commitTargetActivation`.

The linearization guarantee is scoped to the commands committed through this
helper — exact `activatePane`, target activation, and adjacent activation —
which therefore reduce against successive state inside one React batch. The
bare-dispatch commands above leave `stateRef.current` one render behind; this
cutover does not widen the helper to them, and none of them is reachable in
the same tick as a swipe because the gesture cannot begin while Nexus is open.
Do not select a target from a render-time array outside the store.

### Keyboard mapping

Move the keybinding mapping out of `WorkspaceHost` into one workspace-owned
hook, `useAdjacentPaneKeybindings({ onActivated })`, in
`apps/web/src/lib/workspace/adjacentPaneKeybindings.ts`. The hook owns its own
`document` keydown listener and reproduces the existing guards in order —
ignore `event.defaultPrevented`; ignore `isEditableTarget(event.target)`
(load-bearing: the shipped combos `Meta+Shift+arrowright` /
`Meta+Shift+arrowleft` are the platform text-selection combos); match
`pane-next` / `pane-previous` from `useKeybindings()` — then calls
`event.preventDefault()` on every matched combo regardless of result, so the
browser never receives the combo at a clamp boundary or with one visible pane
(today's behavior: `WorkspaceHost.tsx:1703` fires before the
`visible.length < 2` guard). It then calls the store command and emits
`Activated.paneId` to `onActivated`; on `Unchanged` it performs no further
action.

`WorkspaceHost` calls the hook after registering its existing keydown listener
so `Pane.Search` starts out arbitrated first. Document-listener order is not
durable — the host effect re-registers whenever its dependencies change
(`WorkspaceHost.tsx:1719-1725` include `state.activePrimaryPaneId`) — so the
load-bearing guarantees are that the default combos are disjoint (`Meta+f` vs
`Meta+Shift+Arrow`, `keybindings.ts:8-10`, exact-modifier matching at
`keybindings.ts:43-45`) and that a consumed `Pane.Search` calls
`preventDefault`, which the hook's `defaultPrevented` guard honors whichever
listener runs first. Registration order is defensive only. The `Pane.Search`
branch and the rest of `WorkspaceHost`'s listener are unchanged. After the
migration the `WorkspaceHost` keydown effect holds no render-time pane array:
`primaryPanes` (`WorkspaceHost.tsx:842-845`) and `handleActivatePane` leave
its dependency list; `state.activePrimaryPaneId` and `isMobile` stay because
the `Pane.Search` branch still reads them and must not go stale. Adjacency
itself reads none of them.

### Nexus composition

Extend the existing controller and required button prop with the same semantic
command:

```ts
interface NexusController {
  activateAdjacentPane(input: {
    readonly direction: WorkspaceAdjacentPaneDirection;
  }): void;
}

interface NexusButtonProps {
  paneCount: number;
  switchboardOpen: boolean;
  onOpen(opener: HTMLButtonElement): void;
  onActivateAdjacentPane(input: {
    readonly direction: WorkspaceAdjacentPaneDirection;
  }): void;
  onButtonNodeChange?(node: HTMLButtonElement | null): void;
}
```

`onActivateAdjacentPane` is the only member new in this cut; the rest matches
shipped code (`NexusButton.tsx:17-27`), which had already drifted from the
control doc's block. `NexusButtonProps` and `NexusController` are shapes
stated for review; the component keeps its existing inline prop type and no
exported props interface is introduced.

`useNexusController` delegates directly to the workspace command. `Nexus`
wires it to `NexusButton`. Neither layer derives panes, direction, or
boundaries. The controller/button need no result; `WorkspaceHost` consumes
`Activated.paneId` (via the keyboard hook's `onActivated`) to preserve its
existing keyboard focus request, and on `Unchanged` performs no focus request
and no other action.

Touch-swipe activation receives mobile landmark focus through
`WorkspaceHost`'s existing active-pane layout effect — the `useLayoutEffect`
keyed on `state.activePrimaryPaneId` that calls `findPaneLandmarkFocusTarget`
while `isMobile` (`WorkspaceHost.tsx:1610-1630`, `paneDom.ts:15-22`). That
effect keys on the store's active identity, not on the dispatcher, so it must
be retained behavior-for-behavior by slice A; deleting or re-keying it is a
contract violation, not a refactor. `Activated.paneId` feeds only the keyboard
`requestAnimationFrame` focus request; `NexusButton`, `Nexus`, and
`useNexusController` never touch focus.

`NexusButton` already computes operability from `useMobileChrome()` and its
`switchboardOpen` prop (`NexusButton.tsx:38,47-48,62-63`); the recognizer
reads those same two values and adds no prop, no `disabled` attribute, and no
new provider subscription. Do not rely on the user agent suppressing pointer
events inside an `inert` subtree — during `Tracking` and `Settling` the button
is still painted and animating (`switchboard.module.css:447-449`).

No alternate callback, optional gesture prop, public event, wire API, persisted
field, or capability registry entry is added.

## Pointer capability contract

Use Pointer Events on the native button and CSS
`touch-action: pan-y pinch-zoom`. Do not add parallel Touch Events.

Calibration constants are private implementation constants:

```text
movement slop:       8 CSS px
horizontal lock:     abs(dx) >= 1.5 * abs(dy), evaluated once at slop
commit displacement: 20 CSS px
duration/velocity:   unconstrained
```

**Platform slop invariant.** Movement slop MUST NOT exceed the platform tap
slop anywhere on the supported matrix — Android WebView derives Chromium's tap
slop from `ViewConfiguration.getScaledTouchSlop()` (8dp ≈ 8 CSS px at
`width=device-width`), and slop is measured as Euclidean distance from the
origin. A recognizer window wider than the platform's would promise taps the
platform has already cancelled and will never deliver a click for.

**Reachable travel.** The control is pinned at
`right: max(16px, var(--viewport-safe-right))` with a 48px target
(`switchboard.module.css:365-374, 376-395`) and `--viewport-safe-right` is `0`
in portrait, so a rightward `Previous` stream beginning `p` CSS px from the
target's right edge can report at most `p + 16` CSS px of displacement before
the contact reaches the display edge. Commit displacement is calibrated
against that budget and may not be raised. Moving the wrapper, widening the
target, adding an invisible lane, or making the threshold direction-dependent
are all out of scope; if the calibrated value still cannot be reached in
practice, the locked Android-edge decision applies — stop and revise this
specification.

Rules:

- On every `pointerdown` while **Idle**, consume any armed click suppression
  before filtering. Then accept a stream only when
  `isPrimary && pointerType === "touch"`.
- Retain only the tracked pointer id, origin, and axis state in refs. Derive
  displacement from the current `pointermove` or `pointerup` and the retained
  origin; do not retain displacement or render per move.
- Recognizer states: **Idle** → accepted `pointerdown` → **Tracking** (native
  behavior fully preserved; nothing suppressed) → at the first move whose
  Euclidean displacement from the origin reaches movement slop, evaluate the
  axis test exactly once: `abs(dx) >= 1.5 * abs(dy)` latches **Locked**;
  otherwise the stream becomes **Yielded** for its remainder — it never
  dispatches, never opens Nexus, and arms click suppression. In **Locked** the
  axis ratio is never re-evaluated. On `pointerup` from **Locked**, commit if
  and only if `abs(final dx) >=` commit displacement; direction is the sign of
  final `dx` (negative = `Next`, positive = `Previous` in the LTR shell of the
  locked decisions); final `dy` is ignored. Below the commit displacement the
  stream cancels with suppression armed. Every terminal returns the machine to
  **Idle**.
- Call `setPointerCapture(pointerId)` in the accepted `pointerdown`,
  formalizing the implicit touch capture (precedent `MobileSheet.tsx:111`).
  Never call `releasePointerCapture`: the browser releases implicitly when it
  fires `pointerup`/`pointercancel`, and an explicit release for a pointer that
  is no longer active throws `NotFoundError` on the remaining terminal paths
  (unmount, Nexus open, second pointer).
- `lostpointercapture` cancels only a stream that is still being tracked.
  Implicit release fires it after every `pointerup`, so once the stream has
  terminated the handler is a no-op: it must never re-run the cancel path over
  a completed commit and must never clear the armed click-suppression flag.
- Arm click suppression whenever a tracked stream resolves beyond slop — on
  commit, on cancel, and on axis yield alike — and whenever any additional
  `pointerdown` reaches the button while a stream is tracked, even before slop.
  Also arm before reset when an accepted tracked stream becomes inoperable,
  including before slop. The armed flag belongs to the button, not to the
  stream: terminal stream reset never clears it.
- The armed flag is consumed by whichever happens first: (a) the same stream's
  or next pointer-generated click on the button (`event.detail > 0`), which the
  existing `onClick` tests and early-returns from **before**
  `beginNexusPerformance`, or (b) any fresh `pointerdown` that reaches the
  button while the recognizer is **Idle**. Consumption in (b) happens before
  primary-touch acquisition filtering, regardless of `pointerType`,
  `isPrimary`, or current operability. Thus a same-stream compatibility click
  after a consumed/cancelled non-tap is intercepted, while a fresh mouse, pen,
  touch, or native activation can never inherit stale suppression. Chromium
  fires no click once movement passes its own tap slop, so (b) is the normal
  consumer after a committed swipe on Android.
- A click with `event.detail === 0` (Enter, Space, assistive technology) never
  consults the flag and always opens Nexus.
- For one tracked stream that stays before slop, receives no additional
  `pointerdown`, and remains operable for its lifetime, preserve native click
  behavior.
- After non-tap intent, exactly one outcome is possible: one adjacent command
  on qualified `pointerup`, otherwise no-op. Nexus must not open.
- While a stream is tracked, any further `pointerdown` delivered to the Nexus
  button — including a non-primary pointer and any `pointerType` — arms click
  suppression before clearing the stream without dispatch. This ordering also
  applies before movement slop, so the cancelled stream cannot leak a
  compatibility click into Nexus open. The acquisition filter above governs
  stream acquisition only, never cancellation. The recognizer registers no
  `window`, `document`, or ancestor listeners: a pointer that lands anywhere
  else is not observed, and a multi-finger gesture that recruits the tracked
  pointer already arrives as `pointercancel`.
- `pointercancel`, `lostpointercapture` (while tracked), a second pointer on
  the button, `motionPhase.kind` leaving `Visible`/`Pinned`, `switchboardOpen`
  becoming true, and unmount clear the stream without dispatch. Terminal reset
  clears only the tracked pointer id, origin, and axis state; suppression arming
  is cleared solely by its own consumption rule.
- Operability is re-validated synchronously at `pointerup`, immediately before
  dispatch, by reading the live `switchboardOpen` prop, the current
  `motionPhase`-derived inert state, and mount state from refs. A stream whose
  button became inoperable at any point after acquisition resolves as cancel
  with suppression armed, no command, and no open. There is no per-move
  operability polling, and `pointercancel` is not relied on for inertness,
  `visibility: hidden`, or Nexus open.
- `touch-action: pan-y pinch-zoom` on the button is the sole scroll-arbitration
  mechanism. Effective touch-action is the intersection along the ancestor
  chain, so no ancestor can re-enable horizontal panning for a stream that
  starts on the button. The recognizer calls `preventDefault` on no pointer
  event: in Chromium pointer events cannot cancel scrolling — that requires a
  non-passive `touchmove` listener, which this cutover forbids (see
  `PaneShell.tsx:510,535` for the Touch-Events precedent that exists only
  because of this limit) — and `preventDefault` on `pointerdown` does not
  suppress the `click`. Tap preservation and click interception happen
  exclusively in the click handler, per the suppression rule. A browser-claimed
  vertical pan surfaces as `pointercancel` and is handled by the cancel rule.
  The Android system back/home edge gesture cannot be pre-empted by
  `touch-action` or `preventDefault`; the physical acceptance gate in the
  locked decisions is the only defense.
- Do not retain coordinates, pressure, contact geometry, duration, velocity,
  pointer id, or gesture history after the stream ends.

Chromium drops `:active` once movement exceeds the platform tap slop — at this
specification's own movement slop — so a tracked stream past slop
intentionally shows no in-flight visual. The pre-slop pressed face and the
committed active-pane change are the only feedback. Add no pane animation,
toast, live region, boundary error, and no gesture-phase class, data
attribute, or style on the button, face, count, or wrapper.

## Composition and ownership

| Concern | Sole owner | Rule |
| --- | --- | --- |
| Physical pointer arbitration | `NexusButton` | Converts one touch stream to semantic direction |
| Relative-pane semantics | workspace store | Stable visible order, clamp, existing reducer action |
| Keyboard mapping | `useAdjacentPaneKeybindings` (workspace) | Owns combo matching and guards; calls `preventDefault()` on every matched combo regardless of result; emits `Activated.paneId` to its host |
| Keyboard focus | `WorkspaceHost` | Requests pane focus for the emitted `paneId` through its existing path |
| Nexus wiring | `useNexusController` + `Nexus` | Passes the semantic command; derives no policy |
| Exact/random tab selection | Nexus Root / Manage Tabs | Existing activate/restore behavior remains |
| URL and session projection | existing workspace owners | No new persistence or navigation path |
| Focus and title | existing `WorkspaceHost` owners | The active-pane focus layout effect (`WorkspaceHost.tsx:1610-1630` → `focusPane` → `findPaneLandmarkFocusTarget`) already lands mobile activation on the pane landmark for **any** dispatcher, so the touch path adds no focus wiring; this effect must not be altered by the extraction |
| Motion/inertness | `MobileChromeProvider` | Gesture exists only while the button is operable |
| Obstruction and safe area | `MobileViewportProvider` + Android inset contract | Wrapper geometry is unchanged |

`MobileChromeProvider`, `MobileViewportProvider`, pane bodies, and Android
native code do not receive gesture APIs.
`MobileNexusActivationAdapter` remains the typed quick-note handoff owner; it is
not a pointer or workspace-command seam and is unchanged.
`WorkspaceHost`'s render-time active-pane fallback
(`panes.find(active && visible) ?? panes.find(visible) ?? null`,
`WorkspaceHost.tsx:1574-1581`) is title/render presentation only; it is not a
supported activation state and is unchanged by this cutover.

Manage Tabs teaches the gesture only on the surface that has the gesture
target. `ManageTabsPage` stays presentational and gains one required
`readonly teachAdjacentSwipe: boolean` prop. When `true` it renders one extra
static sentence after its existing helper copy — "Open, close, or restore a
workspace tab. Swipe the Nexus button left or right to switch visible tabs." —
and otherwise renders the existing single sentence unchanged. `SwitchboardTask`
(the mobile surface) passes `true` when at least two panes in the `panes` prop
have `visibility === "visible"`; `Nexus`'s `desktopWorkflow` passes `false`,
because `NexusButton` mounts only under `viewport.isMobile`
(`Nexus.tsx:299-306`) and no swipe target exists on desktop. Both call sites
derive the count from the `managedPanes` they already pass; no new state,
hook, provider, or viewport read is added inside `ManageTabsPage`. The button
name remains `Open Nexus, 1 tab` / `Open Nexus, {count} tabs`; do not put
instructions in it.

## Reuse, consolidation, and deletion

Reuse:

- workspace order/visibility, exact reducer action, URL/session/title/focus;
- current `pane-next` / `pane-previous` keybindings and their ids;
- the existing keydown guard set and order — `event.defaultPrevented` early
  return, `Pane.Search` arbitrated first, `isEditableTarget(event.target)`,
  `preventDefault` immediately after a combo match before the outcome is known
  — reproduced exactly in the extracted hook;
- `NexusButton` native semantics, chrome/wrapper/count/focus/press/open timing;
- Nexus/Manage Tabs exact selection and restore; current proofs and routing.

Consolidate:

- move relative-pane semantics to the store and the keybinding mapping into
  `useAdjacentPaneKeybindings`, and route both inputs to the one command;
- generalize the existing synchronous workspace-action commit helper;
- extract one local `requestPaneFocus(paneId)` from the existing focus half of
  `handleActivatePane` (`WorkspaceHost.tsx:1649-1654` — set
  `pendingPaneFocusPaneIdRef` synchronously in the handler, then one
  `requestAnimationFrame` re-check before `focusPane`) and call it from both
  exact activation and the adjacent keyboard path, so pane activation keeps
  exactly one requestAnimationFrame focus request and the mobile landmark
  layout effect that reads that ref still resolves the same target.
  `handleActivatePane`'s `{ focusPane: false }` option stays (pane-wrap
  `onMouseDown`, `WorkspaceHost.tsx:1768-1770`). The unrelated
  secondary-surface opener-refocus paths (`WorkspaceHost.tsx:1416-1418`,
  `1491-1493`, contract comment at `1472-1476`) are out of scope: do not
  merge, move, or delete them;
- keep pointer recognition local to `NexusButton`; extract no one-use wrapper.

`MobileSheet` pointer capture and `PaneShell` axis gating are implementation
precedents, not reusable capabilities. Do not couple Nexus to either owner.

Delete in the same implementation:

- `WorkspaceHost`'s wraparound
  `(index + step + visible.length) % visible.length` and its local
  `visible`/`targetIndex` derivation (`WorkspaceHost.tsx:1704-1715`);
- the stale `commitTargetActivation` reference in the state→URL layout-effect
  comment in `store.tsx`;
- normative "no Nexus swipe" and `onOpen`-only claims, per the superseded
  clause list above;
- any superseded test assertion that absence of all gesture handlers is product
  behavior.

Do not retain modulo fallback, old/new policy branches, optional callbacks,
Touch Events, dead constants, aliases, deprecated APIs, or tombstone tests.

## Files and non-overlapping implementation slices

| Slice | Owned files | Deliverable |
| --- | --- | --- |
| A — workspace semantics | `apps/web/src/lib/workspace/store.tsx`; `apps/web/src/lib/workspace/store.browser.test.tsx`; `apps/web/src/lib/workspace/adjacentPaneKeybindings.ts` (new); `apps/web/src/lib/workspace/adjacentPaneKeybindings.browser.test.tsx` (new); `apps/web/src/__tests__/helpers/workspaceSessionBff.ts` (new); `apps/web/src/components/workspace/WorkspaceHost.tsx`; `python/nexus_test_control/sensitivity.py`; `python/tests/kernel/nexus_test_control/test_sensitivity.py` | Store command/result, commit reuse, clamp/visibility/rapid-command proof, keybinding-hook extraction with its own proof, one narrow shared workspace-session BFF stub and its two-proof-only BASE overlay contract, `WorkspaceHost` focus-request retention (`requestPaneFocus`), retention of the mobile active-pane landmark-focus layout effect, old algorithm deletion |
| B — Nexus input | `apps/web/src/components/switchboard/NexusButton.tsx`; `apps/web/src/components/switchboard/switchboard.module.css`; `apps/web/src/components/switchboard/SwitchboardTask.tsx`; `apps/web/src/components/nexus/Nexus.tsx`; `apps/web/src/components/nexus/useNexusController.ts`; `apps/web/src/components/nexus/Nexus.browser.test.tsx`; `apps/web/src/components/nexus/ManageTabsPage.tsx` | Pointer arbitration, click preservation/suppression, wiring, discoverability copy, real-Chromium trusted-touch proof |
| C — Android boundary | create `apps/android/app/src/androidTest/java/app/nexus/android/NexusControlGestureTest.kt`; add the node-qualified proof `gradle:apps/android/app/src/androidTest/java/app/nexus/android/NexusControlGestureTest.kt::<testMethod>` to the `native-system-insets` risk in `testdata/proofs.json`; update `PRIORITY_RISK_OWNERSHIP_SHA256` in `python/nexus_test_control/model.py` in the same commit | Real-WebView pointer delivery at the Player-absent worst-case target geometry; system-gesture inset-overlap oracle; no product seam |
| D — contract integration | this document; `docs/architecture.md`; `docs/modules/workspace.md`; `docs/modules/panes-tabs.md`; `docs/modules/app-navigation.md`; `docs/local-rules/testing-standards.md`; `docs/cutovers/mobile-nexus-control-hard-cutover.md`; `docs/cutovers/mobile-nexus-switchboard-hard-cutover.md`; create `docs/cutovers/mobile-nexus-adjacent-tab-swipe-device-matrix.md` (the operator checklist) | Supersession rewrites, final owner prose (passage-anchored below), operator checklist, residue audit, evidence report |

Slice-D doc deliverables, passage-anchored:

- Amend `docs/modules/workspace.md:39-40` so mobile pane switching reads:
  sequential adjacent switching by primary-touch swipe on the Nexus control;
  random access, recently-closed restoration, and minimized restore through
  the shell-mounted full-screen Nexus task and its Manage Tabs page.
- Record the all-viewport traversal contract — visible-only, stable
  `primaryPaneOrder`, first/last clamped, never wrapping — in
  `docs/modules/panes-tabs.md`, stating that the workspace store is its sole
  owner and the `pane-next`/`pane-previous` keybindings use that command on
  every viewport. State separately that mobile maps the Nexus swipe to the same
  command, and name the workspace store as sole owner in
  `docs/modules/workspace.md`.
- In `docs/modules/app-navigation.md`, state that the Nexus control's native
  button-activation path is unchanged and the gesture adds no second ingress or
  event.
- In `docs/architecture.md` §8.10, add one clause that the mobile Nexus
  control carries the adjacent-tab accelerator over that same command.
- Amend the enumerated native-instrumentation ownership list in
  `docs/local-rules/testing-standards.md` (the "Android instrumentation covers
  native ownership" paragraph) to include measured system-gesture inset
  geometry, arbitration preconditions, and WebView pointer delivery at owned
  fixed-control geometry. State in the same paragraph that real SystemUI
  conflict arbitration remains owned by the physical operator matrix, while
  recognizer semantics, direction resolution, clamping, and click suppression
  remain owned by the real-Chromium component proof. The `Do not duplicate web
  behavior` rule is thereby narrowed by enumeration, not weakened.
- Retire every superseded clause by hand, not by pattern luck, per the
  line-anchored list in "Superseded clauses" above, rewriting the control
  doc's props block to the live shape and correcting its stale
  `beginSwitchboardPerformance` reference to `beginNexusPerformance`.

Slices A and B share only the API above. C is test-only: its only non-Android
edits are the two coupled test-control files above —
`policy.py::proof_contract_violations` recomputes the frozen ownership digest
over every risk's sorted `source_globs`/`proofs`/`capabilities` and fails
`proof-ownership-floor` on the first `./scripts/test changed` if `model.py` is
not updated with it. That edit is in scope for slice C and is not "unrelated
work". D begins after A+B are green. No slice touches product backend, Android
production code, persisted schemas, or unrelated work.

Add the Android proof to the existing `native-system-insets` risk and extend
that risk's `source_globs` with
`apps/web/src/components/switchboard/switchboard.module.css` and
`apps/web/src/components/switchboard/NexusButton.tsx`, the files that own the
target geometry the fixture models, so a later change to the Nexus target's
geometry, `touch-action`, or `--nexus-bottom-gap` re-selects the device proof
on `changed`/`confidence` and reports it as deferred to its owning workflow
instead of silently routing nothing. (The proof still executes completely in
`nightly`/`release`, which request `android-device` at COMPLETE scope; the
globs exist to make the deferral visible.) Both glob additions are part of the
same `testdata/proofs.json` edit and the same ownership-floor recomputation.
Add no journey, priority risk, or fault-manifest entry.

## Red / green / refactor order

1. **Red — workspace.** Extend `store.browser.test.tsx` through the public
   store capability for the reducer cases above. Record failure before
   production edits.
2. **Red — workspace keyboard.** First extract `useAdjacentPaneKeybindings`
   behavior-preserving (guards and current wrap intact — a mechanical move).
   Then author `adjacentPaneKeybindings.browser.test.tsx` with real
   `KeybindingsProvider` + `WorkspaceStoreProvider` over three panes with one
   minimized, asserting the store-command routing and clamp semantics, and
   record its failure against the extracted-but-unmigrated hook. (A base-
   worktree overlay cannot produce this red: the proof imports a module that
   does not exist at the merge base, which the controller classifies as a
   setup failure, so this added proof's red is recorded in-worktree and cited
   in the work report.)
3. **Red — Nexus.** Parameterize the existing `renderNexus` helper with an
   initial workspace state built by `createWorkspaceStateFromPrimaryPanes`
   (`apps/web/src/lib/workspace/schema.ts:141`) —
   `createDefaultWorkspaceState` hard-codes one `visible` pane and cannot
   express the matrix. Add mobile cases for (i) three ordered primary panes
   whose middle pane is `visibility: "minimized"`, which alone exercises the
   skip, boundary-clamp, and two-rapid-swipe rows, and (ii) a single visible
   pane for the no-op row. Existing single-pane cases keep their current
   assertions. Providers stay real. Touch is delivered through the real
   Chromium input pipeline over the browser project's `cdp()` session:
   `cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true,
   maxTouchPoints: 1 })` is existing in-repo precedent
   (`ChatComposer.browser.test.tsx:138,339`;
   `SelectionActionDock.browser.test.tsx:533,561`); the
   `Input.dispatchTouchEvent` move sequences driven over that same session are
   new CDP usage this proof introduces — no current test dispatches CDP touch
   streams, so name and encapsulate the helper inside this proof file only.
   Disable emulation again in teardown, and order the touch scenarios after
   the fine-pointer scenarios: disabling touch emulation leaves the page
   `pointer: none` rather than restoring `fine`
   (`SelectionActionDock.browser.test.tsx:495-502`), so a fine-pointer
   assertion sequenced after a touch scenario would be unfalsifiable. Record
   failure first.
4. **Green — workspace.** Add the store command/result, reuse the exact reducer
   action, and migrate the hook onto the command with `requestPaneFocus`.
   Make only the owner proofs green.
5. **Green — Nexus.** Wire the command and add the minimal Pointer Events
   recognizer/CSS. Make only the owner proof green.
6. **Platform.** Add the real-WebView pointer-delivery proof without production
   Android changes.
7. **Refactor/integrate.** Delete old policy, add help copy, update docs, run
   residue and affected proof. There is no coexistence phase; rollback is
   revert.

Proof expectations come from this specification, not current output. Do not
mock the workspace store, Nexus controller, button, browser pointer model, or
mobile providers. No proof may dispatch untrusted `PointerEvent` objects in
place of trusted touch for the committed-swipe or capture-loss rows, stub or
wrap `setPointerCapture`/`releasePointerCapture`, or catch and ignore a
capture failure. Trusted OS touch delivery at production geometry remains the
Android WebView proof's boundary.

The Nexus component proof distinguishes both suppression consumers: a
same-stream compatibility click after non-tap intent is intercepted, while any
fresh Idle `pointerdown` clears stale suppression before acquisition filtering,
including mouse, pen, non-primary, and inoperable input. It also proves that an
additional pointerdown while tracking arms suppression before cancellation,
including when the first stream has not crossed movement slop, and that a
tracked stream becoming inoperable arms suppression before reset.

Existing BFF stubs in the Nexus component harness remain at the permitted HTTP
boundary. The recognizer itself issues no request; activation still flows into
the existing debounced workspace-session write
(`apps/web/src/lib/workspace/useWorkspaceSession.ts`, 1000 ms), which the
harness already stubs at `PUT /api/me/workspace-session` — no new stub,
endpoint, or fetch boundary is introduced. Component proofs assert the swipe's
observable UI/store outcome and MUST NOT wait on that write — session
projection is proven by the journey row below. Never insert a sleep to reach
the debounce; wait on an observable condition with a bounded deadline.

## Acceptance criteria

- [ ] Every observable target-behavior row passes through the public UI/store
  surfaces, including the `pane-next`/`pane-previous` rows, which are proved at
  the keyboard hook owner. Unmount reset is the sole construction-only row:
  React removes the button's only event surface at unmount, no document/window/
  ancestor listener survives, and the layout-effect cleanup resets the private
  stream refs; inventing a post-unmount seam would prove test machinery rather
  than product behavior.
- [ ] Touch and keyboard use one stable-order, visible-only, clamped store
  command; keyboard adjacency clamps at both ends under its own proof, with no
  wrap remaining at any viewport.
- [ ] Tap/keyboard/AT open remains exact; consumed or cancelled non-taps never
  open. A same-stream compatibility click is suppressed, and a fresh Idle
  pointerdown consumes stale suppression before filtering so mouse, pen, touch,
  and native activation are never eaten.
- [ ] Switching updates existing active-pane, URL, session, title, and landmark
  focus; A → B → A preserves the existing visit/return contract.
- [ ] The native 48px target, count, wrapper, Player/safe-area clearance,
  chrome motion, reduced motion, forced colors, the button's own focus and
  press semantics, and open timing remain exact.
- [ ] Accessibility contract replacing superseded AC4: the swipe is a
  redundant accelerator, not a sole path — tap-then-select in Nexus / Manage
  Tabs is the non-path, single-pointer alternative (WCAG 2.5.1); the gesture
  commits only on a qualified up-event and is cancellable by reversal below
  threshold before release (WCAG 2.5.2); keyboard and assistive-technology
  activation stay on the native button path via the `event.detail === 0`
  carve-out; and no live region is added because mobile activation moves focus
  to the pane landmark, which is the assistive-technology commit announcement.
- [ ] Physical Android proof, executed on the wired handset with the
  navigation mode and the device's back-gesture sensitivity setting recorded,
  finds no Nexus/System Back/Home/quick-switch conflict; an emulator run of
  the same test does not satisfy this box.
- [ ] Manage Tabs retains exact selection/restore, teaches the gesture on the
  mobile surface only when at least two visible panes exist, and never teaches
  it on desktop.
- [ ] Old modulo traversal, contradictory docs/tests, and every forbidden
  fallback/framework/vertical/native/backend path are absent.

## Proof and 80/20 verification

Follow the repository's smallest-boundary and independent-oracle rules.
Risk score: `5 / medium` per `docs/local-rules/testing-standards.md:180-194` —
consequence, reversible UI context (`2`); runtime/provider/device boundaries
crossed, browser plus Android WebView (`2`); concurrency, replay, or
irreversibility, rapid-input ordering only (`1`); change frequency and escape
history, none (`0`). Medium prescribes a service/component proof; the physical
device proof is added above the band solely for the OS/WebView boundary, which
no component proof can observe.

| Boundary | One proof | What it alone proves |
| --- | --- | --- |
| Workspace semantics | `apps/web/src/lib/workspace/store.browser.test.tsx` | Public command, exact-then-adjacent current-state linearization in one React batch, synchronous URL projection after each command, stable visible order, clamp, and no-op cases |
| Workspace keyboard mapping | new `apps/web/src/lib/workspace/adjacentPaneKeybindings.browser.test.tsx` | Real-Chromium `keydown` for `Meta+Shift+ArrowRight`/`ArrowLeft` inside real `KeybindingsProvider` + `WorkspaceStoreProvider` over three panes with one minimized: reaches the store command, skips the minimized pane, clamps at both ends with no `activePrimaryPaneId` change, calls `preventDefault` at the boundary as well as mid-sequence, leaves a plain/missing-modifier Arrow unprevented and inert, ignores `defaultPrevented` and editable targets, and emits the activated pane id to `onActivated` |
| Nexus/browser input | `apps/web/src/components/nexus/Nexus.browser.test.tsx` | Trusted touch Pointer Events, tap arbitration, accessibility, composed activation, and dialog absence; same-stream compatibility-click interception; fresh Idle pointerdown consumption before touch/mouse/pen acquisition filtering; pre-slop additional-pointer and operability-loss suppression before cancellation/reset; a `Previous` commit driven at 390×800 from the outer target third using only in-viewport coordinates; and a narrow Android-fixture parity/drift guard for the duplicated 48px, wrapper/button `pointer-events`, `touch-action`, `will-change`, and Player-absent right/bottom envelope values — not dynamic product-geometry ownership |
| Real-stack workspace preservation | existing `apps/web/e2e/journeys/nexus-search-open-restore.journey.spec.ts` | URL/session/title/focus wiring for exact activation only; it drives no traversal chord and is not evidence for the migrated keyboard path |
| Mobile geometry | existing `apps/web/e2e/journeys/mobile-reader-bottom-geometry.journey.spec.ts` | Sole dynamic product-geometry owner: Nexus wrapper, reader, Player, and safe-area behavior remain correct; no semantic duplication |
| Android OS boundary (automated) | new `NexusControlGestureTest.kt` on the USB-attested handset | Pointer delivery to the page at the Player-absent worst-case production target geometry, under the device's current navigation mode, which the proof reads and records; plus the system-gesture inset-overlap oracle. Injected streams are not arbitrated by SystemUI, so this proof never claims cross-navigation-mode behavior |
| Android edge conflict (operator) | manual physical matrix on the wired handset | Zero tap→switch, swipe→Nexus, Nexus→Back/Home, or Back/Home→Nexus ambiguity across the ambient dimensions below |

The exact geometry/CSS values asserted in `Nexus.browser.test.tsx` are inputs
duplicated by the Android fixture, so that assertion is only a parity/drift
guard between the fixture and rendered control. It is not a second owner for
dynamic Player, reader, inset, or safe-area behavior; the existing
`mobile-reader-bottom-geometry` journey remains the sole product-geometry owner.

The target-behavior row for landmark focus is inherited by construction rather
than re-proved: it depends only on the store's active identity through the
retained `WorkspaceHost` layout effect, so slice A's store proof plus the
retained effect cover it, and the existing `nexus-search-open-restore` journey
remains its sole real-stack oracle. No new focus proof owner is added. No new
journey, snapshot, interaction mock, production seam, or second owner for an
already-owned boundary is allowed; the keyboard mapping is a distinct boundary
from workspace semantics and from Nexus pointer input, and owns exactly one
proof.

### Android fixture

The Android fixture is loaded into the real `MainActivity` WebView through
`loadDataWithBaseURL("${BuildConfig.NEXUS_BASE_URL}/android-test-nexus-gesture", …)`
— the same owned-origin form `SystemInsetsTest` and `NativeAuthHandoffTest`
use, never a `data:` URL, whose opaque origin would change WebView defaults —
so the target is measured inside the real Activity window under the real
`NexusWebView.configure` settings, with no production Android seam. Following
`SystemInsetsTest`, the proof asserts the System WebView M144+ floor before
anything else and fails with the found version when the floor is unmet, then
loads the fixture through the same title-plus-progress load barrier.

The fixture reproduces the production pointer environment exactly, not merely
the production geometry. Its meta viewport is
`width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content`,
matching `apps/web/src/app/layout.tsx`. Its target is a
`pointer-events: auto` 48×48 `<button>` inside a `pointer-events: none`
`position: fixed` 48×48 wrapper, matching `NexusButton`'s wrapper/button
split; the button carries the same `touch-action: pan-y pinch-zoom` and
`will-change: transform` declared for `.nexusButton` in
`switchboard.module.css`. The fixture asserts these computed values on the
target before injecting anything and names any divergence in the failure
message: drift between the fixture rule set and `.nexusWrapper`/`.nexusButton`
invalidates the proof rather than silently weakening it.

It places one 48px target at `right: max(16px, env(safe-area-inset-right))`
and `bottom: calc(env(safe-area-inset-bottom) + 12px)`. Production resolves
that bottom as `--mobile-nexus-bottom-offset + --nexus-bottom-gap`, where the
offset is `max(ceil(safe-bottom), player band)` (`switchboard.module.css:366-370`,
default `globals.css:127`, resolver
`lib/mobileViewport/model.ts::resolveNexusBottomOffsetPx`); the fixture pins
the Player-absent evaluation deliberately, because that is the lowest the
control ever sits and therefore its worst case against the bottom
system-gesture band, and the right-edge back band spans the full screen height
regardless of vertical position. Player-present placement only raises the
control and is covered by the operator matrix; the fixture stays a standalone
page and imports no product token. The fixture's geometry is taken from this
specification, not from the current stylesheet, and is a worst-case envelope:
if `switchboard.module.css` ever specifies a target smaller or closer to a
system edge than this envelope, the fixture is stale and must be revised with
the geometry change.

It resolves the target rectangle in screen coordinates from
`getBoundingClientRect()` × `devicePixelRatio` plus
`webView.getLocationOnScreen`, then injects each horizontal stream globally
with `InstrumentationRegistry.getInstrumentation().sendPointerSync(...)` over
`MotionEvent`s sourced `InputDevice.SOURCE_TOUCHSCREEN` (one `ACTION_DOWN`, at
least eight interpolated `ACTION_MOVE`s, one `ACTION_UP`).
`View.dispatchTouchEvent` and any other in-process delivery is forbidden: it
bypasses the system input dispatcher, so a system-gesture steal becomes
structurally invisible and the proof can only pass. The oracle is exact and
asserted, not merely recorded: for a down in the outer (screen-edge) half and
again in the inner half of the target, the page MUST observe `pointerdown`
with `pointerType === 'touch'`, at least one `pointermove` whose horizontal
displacement exceeds the commit displacement (20 CSS px), and `pointerup`,
with no `pointercancel` and no truncated stream.

The proof never changes device-global state: it does not set navigation mode,
back-gesture sensitivity, or any overlay, because `android-device` globs every
`androidTest` source and an unrestored global would leak into the rest of the
sweep. Immediately after the WebView-version floor it reads the active
navigation interaction mode, the back-gesture sensitivity value, and the
resolved `WindowInsets.Type.systemGestures()` /
`Type.mandatorySystemGestures()` insets, asserts gesture navigation is active
for a gate run, and names all of them — plus the target rectangle's overlap
with the right and bottom gesture bands — in every failure message, so a
failure names the band that stole the stream. Three-button navigation is
covered only by the operator matrix. If the proof exercises more than one
orientation, it re-establishes the fixture and re-resolves the target
rectangle after every configuration change, because `MainActivity` declares no
`android:configChanges` and rotation destroys the inline page; querying a
pre-rotation page is a defect, not a delivery failure. It observes events and
insets only; it does not duplicate the recognizer.

### Sensitivity

Sensitivity is machine-enforced, not asserted. `./scripts/test pr` derives it
itself and does not accept preserved external evidence: `selection.py` marks
every materially changed test file `sensitivity_required`,
`cli.py::_workflow_sensitivity` runs `prove` per proof, and the run fails with
`materially changed proofs lack same-run red/green evidence` if any is
missing. For the new store and Nexus behavior, no fault may be declared — a
deliberate production defect must not be committed merely to preserve the
demonstration — so the method is `BASE`: the proof file is overlaid onto the
merge-base worktree, with production sources at their base revision. For
exactly the store and adjacent-keybinding proof paths, `_base_overlays` also
includes their proof-owned shared
`apps/web/src/__tests__/helpers/workspaceSessionBff.ts` fixture. The fixture
accepts only the existing workspace-session PUT used by those proofs; unrelated
web proofs never receive it, while the store behavioral red cannot degrade into
missing-module setup failure.

The controller also changes sibling tests in existing Python proof files. An
unchanged exact module-level Python owner retains its declared `FAULT`; only a
change to that selected test or its imports/non-test module support selects
`BASE`. Sibling tests are excluded from that owner fingerprint. Unsupported,
missing, duplicate, unparsable, or unreadable owner shapes fail closed to
`BASE`; the fault execution remains the behavioral backstop.

The recorded red MUST be a behavioral assertion failure; a thrown
`TypeError`/`ReferenceError` from a missing API is classified
`setup_or_execution_failure` and rejected. Both modified owner proofs MUST
therefore be authored so that at the base revision they fail on an
observable-outcome assertion rather than crashing. For
`store.browser.test.tsx`, resolve the new command through a nullable
reference and assert its result and the projected active pane — e.g.
`const activateAdjacent = store.activateAdjacentPane as
ReturnType<typeof useWorkspaceStore>["activateAdjacentPane"] | undefined;
expect(activateAdjacent?.({ direction: "Next" })).toEqual({ kind: "Activated",
paneId: secondPaneId });` (`WorkspaceStoreValue` itself is not exported; the
hook's return type is the public anchor) — never a `typeof`/existence guard,
which the testing standard forbids. For `Nexus.browser.test.tsx`, drive the real touch
stream on the rendered button and assert the rendered active-pane identity,
which fails behaviorally at base because the un-migrated button ignores the
gesture. The added keyboard proof records its red in-worktree against the
behavior-preserving extraction, as ordered above. A first-run green test is
not accepted as red evidence. Produce and cite the evidence ahead of merge
with `./scripts/test prove --proof
vitest:apps/web/src/lib/workspace/store.browser.test.tsx --against
base:<exact-merge-base>` and the equivalent for `Nexus.browser.test.tsx`, and
record the run ids (evidence lands at the uncommitted
`test-results/runs/<run-id>/summary.json`), the sensitivity method (`BASE`),
and the keyboard proof's in-worktree red in the work report.

### Verification shape

1. Exact red, then green, for the three owner proof files through
   `./scripts/test changed <path>...`.
2. `./scripts/test changed --base <exact-merge-base>` after integration.
3. One `./scripts/test confidence --base <exact-merge-base>` run.
4. One `./scripts/test pr` run before merge, whose evidence must include the
   same-run red/green records above.
5. Physical Android acceptance. `NexusControlGestureTest.kt` is routed to the
   `android-device` capability, which by contract accepts either a locally
   started emulator or a USB-attested handset
   (`nexus_test_control/services.py::authorized_instrumentation_device`); an
   emulator execution therefore does NOT satisfy this gate, and `nightly`'s
   hosted-emulator run of the same instrumentation is regression signal only.
   The run counts only when the bound candidate is the wired handset carrying
   adb's `usb:` topology fact — either `./scripts/test release`, whose
   android-device proof requires a physical device outright
   (`_android_device_requires_physical`, and never with
   `NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE=true`), or an
   android-device-carrying workflow run with every emulator stopped. The
   passing capability evidence references exactly one bounded, redacted
   `test-results/runs/<run-id>/android-device-instrumentation.json`; it retains
   the exact selected `adb devices -l` row, bound serial, proof/scope and
   command identity, exit code, and successful instrumentation diagnostics.
   The Nexus proof emits `NEXUS_CONTROL_GESTURE_DIAGNOSTICS:` through
   `Instrumentation.REPORT_KEY_STREAMRESULT`; a selected Nexus owner whose
   captured stdout lacks that marker is `not_run`. Failure to retain the
   artifact is likewise `not_run`. `./scripts/test android-visual` runs no
   instrumentation and is not this evidence (it may
   capture accompanying screenshots). Any
   emulator-backed execution of this node is recorded `not_run` for this gate,
   never pass; missing, wireless, or emulator-only device evidence is
   `not_run`, never pass.

Do not add or run `full` merely to repeat the same signal. Run it only when the
typed controller selects an uncovered capability or release policy requires it.
Report exact, browser, journey, device, and operator evidence separately.

Operator matrix — owner: a human on the attested USB handset, recorded as the
dated checklist file `docs/cutovers/mobile-nexus-adjacent-tab-swipe-device-matrix.md`
(slice D) committed with the cutover and cited by name from the run's evidence
report. Rows cover the outer and inner thirds of the button;
portrait/landscape; gesture/three-button navigation; default and maximum
Android back-gesture sensitivity; Nexus visible/retreated; Player
absent/present; IME open; reduced motion; TalkBack; and slow/diagonal
movement. The checklist header names the device model, Android version, System
WebView version, navigation mode, and back-gesture sensitivity; every row
is initially `Pending` and records pass or fail only after the observed outcome
is read from the device. Required result: zero tap→switch, swipe→Nexus,
Nexus→Back/Home, or Back/Home→Nexus ambiguity, AND both `Next` and `Previous`
commit from the inner third and the outer third of the target, in portrait and
landscape, under gesture and three-button navigation, at default and maximum
back-gesture sensitivity. A direction that cannot commit from any third, or a
contact the WebView never receives, is a failed gate: stop and revise this
specification
per the locked Android-edge decision; do not add an exclusion rectangle, inset
schema, or production bridge to pass it. An unrecorded or unreproducible row
blocks acceptance and is reported as missing device evidence, never as pass;
`not_run` remains a typed-controller verdict and is never asserted on the
checklist's behalf. The automated fixture's green result never fills a matrix
cell; this matrix, not `NexusControlGestureTest.kt`, is the sole owner of the
three-button, Player-present, IME, reduced-motion, and TalkBack dimensions.

## Hard-cut residue guard

After implementation:

```sh
rg -n 'onTouch(Start|Move|End)|touchstart|touchmove' \
  apps/web/src/components/switchboard \
  apps/web/src/components/nexus
```

This is the durable forward guard on the Touch-Events prohibition. It returns
no result; Pointer Events remain the sole gesture input path.

As part of residue, `./scripts/test changed testdata/proofs.json
python/nexus_test_control/model.py` returns a green `policy` capability (an
unresolvable proof node reports `proof-node`; a stale digest reports
`proof-ownership-floor`).

Durable traversal and documentation behavior stays in the owner proofs and
normative contracts above; no one-time deletion-proof grep remains.
