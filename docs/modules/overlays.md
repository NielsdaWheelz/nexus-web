# Mobile Modal Surfaces

## Scope

The overlays module owns the named mobile bottom-sheet and full-screen-task
presentations plus the modal lifecycle they share. Owners live under
`apps/web/src/components/ui/{MobileSheet,MobileFullScreenTask}.tsx`, their
stylesheets, `apps/web/src/components/ui/useMobileModalLifecycle.ts`, and
`apps/web/src/lib/ui/{useDialogOverlay,useModalLayer,useEscapeKey,useBodyOverflowLock,useHistoryDismiss,useKeyboardInset}.ts`.

Established by `docs/cutovers/mobile-sheet-keyboard-unification-hard-cutover.md`.
The current mobile Nexus projection is defined by
`docs/cutovers/mobile-nexus-full-screen-task-hard-cutover.md` and
`docs/cutovers/daily-pages-quick-capture-hard-cutover.md`.

## MobileSheet Capability Contract

`MobileSheet` is the single mobile bottom-sheet owner. It composes
`useMobileModalLifecycle` and owns:

- portal to `document.body`
- backdrop scrim with tap-to-dismiss
- grabber + drag-to-dismiss (96 px threshold, inert under reduced motion)
- keyboard avoidance: shrink + lift via `--keyboard-inset` on the panel
- reporting of that keyboard inset to the shell-owned mobile viewport
  capability through a scoped release; the newest active sheet owns the channel
  and releasing it restores the preceding sheet
- safe-area bottom padding
- the `useDialogOverlay` modal contract (body scroll lock, focus trap, initial
  focus, return focus, Escape)
- back-button dismissal via `useHistoryDismiss` (on by default)

It does not own open/close state, content, desktop variants, side-drawer
geometry, non-modal surfaces, or snap points.

`MobileSheet.module.css` is the only stylesheet allowed to contain bottom-sheet
geometry. Callers pass content and state only; size budgets are tuned via
`--mobile-sheet-max-size` / `--mobile-sheet-max-size-cap` in a `panelClassName`,
never with new geometry.

## MobileFullScreenTask Capability Contract

`MobileFullScreenTask` is the semantic owner for temporary sustained mobile
work. It owns one opaque child dialog frame fixed to the unobscured visual
viewport, modal projection, and the shared mobile modal lifecycle. Its
projection wrapper is unpainted; the child frame owns the canvas so suspending
the wrapper for a nested modal never exposes the workspace.

It has no scrim, backdrop action, grabber, rounded sheet edge, max-height,
detent, or drag dismissal. It adds no title, toolbar, scroll region, route, or
business state. The feature supplies one page-owned header and one content
scroll owner; those owners apply the exact top/side/bottom safe-area padding.

`MobileFullScreenTask` and `MobileSheet` are separate semantic primitives. Do
not add a full-screen variant to `MobileSheet` or options for layer, scrim,
geometry, edge, axis, detents, or gestures to the task.

## Mount Contract

`MobileSheet` and `MobileFullScreenTask` must stay mounted across the open/close
cycle and be driven with `active`. Never conditionally mount either active
surface. `useHistoryDismiss` (its C7 doc comment) must observe `active` going
false to pop its synthetic history entry; conditional rendering breaks
back-button dismissal.

## Shared Mobile Modal Lifecycle

`useMobileModalLifecycle` is the sole mobile-modal composition owner. It
combines `useDialogOverlay`, `useHistoryDismiss`, and `useKeyboardInset`, and
publishes active keyboard obstruction to `MobileViewportProvider`. It renders
no markup and owns no CSS, scrim, gesture, z-index, geometry application, or
semantic surface choice.

Its guarded dismissal path calls the feature's dismissal handler only after an
accepted request. History always uses that path; Escape uses `onEscape` when
supplied and otherwise uses the guarded request. Inactive mounted surfaces
consume no viewport context and publish no keyboard report; active surfaces
still require the provider. Releasing the newest active report restores the
preceding report.

## Shared Overlay-Layer Contract

`useDialogOverlay` is the only modal behavior facade. Active modals register
with `useModalLayer`; only the activation-topmost modal carries `aria-modal`,
accepts focus, traps Tab, and owns Escape. Every lower modal panel is `inert`,
and every modal backdrop consumes the shared `modalBackdropProjection`, which
suppresses its lower scrim and pointer handling with stateful inline styles
that cannot lose to component stylesheet order. A stable optional layer scope
lets feature commands identify their
own top interaction layer without mistaking a nested modal or menu for it.

The supporting registries are browser-local and composition-safe:

- `useEscapeKey` has one document listener; transient owners are associated
  with and outrank only their containing modal, peers are LIFO, and a transient
  in a suspended modal cannot steal Escape from a newer modal;
- `useBodyOverflowLock` changes body overflow only on zero-to-one and
  one-to-zero owner transitions;
- `useHistoryDismiss` keeps one marker/listener for the nonempty history-owner
  stack, dismisses only its topmost eligible owner, and safely handles blocked,
  nested, non-LIFO, simultaneous, delayed-pop, and owner-handoff closes;
- return focus is permitted only for the layer being exposed and is deferred
  while its explicit target remains inside an inert underlay.

A modal-local `ActionMenu` derives that ownership from modal context, portals
into its containing dialog, becomes a transient Escape/history owner, and does
not claim `aria-modal`. Escape closes the top menu or modal one layer at a
time. Back closes a modal-local menu and then the top history-enabled dialog,
sheet, or drawer. Dialog owners opt into history only when their product
contract requires platform Back; player-owned subordinate dialogs do so, which
prevents Back from reaching full-screen Now Playing first.

Shared `Dialog` uses the `--z-nexus` top-modal band so activation order places a
dialog opened by opaque Nexus above it; `ActionMenu` remains at 1200. `Dialog`
defaults to no history ownership; product flows that require platform Back, such
as Nexus Add's dirty-work confirmation, opt into `historyDismiss`.

## Keyboard Geometry Ownership

`useKeyboardInset` is the single modal keyboard-geometry source and is
importable only by `useMobileModalLifecycle` (ESLint-enforced). It returns the
thresholded bottom keyboard inset and the raw nonnegative visual-viewport top
offset. The lifecycle publishes active bottom inset through
`reportMobileOverlayKeyboardInset`; `MobileFullScreenTask` consumes the top
offset locally. No other modal reads `visualViewport` to infer keyboard
geometry.

The platform layer is `interactiveWidget: "resizes-content"` in the root
`viewport` export (`apps/web/src/app/layout.tsx`): Android/Firefox resize the
layout viewport with zero JS, the measured inset is ~0 there, and the hook is
the iOS-only shim. No code branches on user agent.

`FloatingActionSurface` is the separate, documented non-modal owner
(`docs/modules/chat.md`). It keeps its own raw `visualViewport` clamping — a
different concern — and must not migrate to `MobileSheet`.

## Scrim Rule

Scrim is a two-value semantic choice:

- `soft` (`--overlay-scrim-soft`): in-context companion sheets — workspace
  secondary surfaces, model settings
- `default` (`--overlay-scrim`): app-level sheet modals

Full-screen Nexus and full-screen Now Playing own opaque canvases rather than
scrims. Now Playing composes the underlying modal primitives directly; it is
not `MobileSheet` or `MobileFullScreenTask`.

## Mobile Nexus

Mobile Nexus is the sole mobile global-access task. One mounted
`SwitchboardTask` uses `MobileFullScreenTask` for the autofocused Root,
Choose Create, Choose Browse, Manage Tabs, Add, and recovery pages; those pages
replace one another inside the task. Root owns query and canonical Nexus groups;
there is no separate Find page or scope state. Each page's header is the only
header and its content region is the only vertical scroll owner. Quick Note
uses the task-owned typed gesture-time handoff only until the destination Page
editor claims input. Mobile Nexus has no global navigation drawer, bottom
sheet, outside-click target, swipe dismissal, or stacked workflow task.

Nested Back, Escape, browser Back, and Android Back request the Nexus
controller's guarded transition: nonblank Root clears its query first; blank
Root dismisses; a nested page restores the exact Root query and active identity;
dirty or running work remains open behind its existing confirmation. Ordinary
dismissal restores the Nexus control; accepted workspace activation leaves
focus with the destination. Rotation and mobile/desktop breakpoint changes
preserve controller state.

## Player Surfaces

Full-screen Now Playing is a shell-owned modal mode, not a bottom sheet. It
stays mounted, composes `useDialogOverlay`, `useHistoryDismiss`, and
`ModalLayerProvider`, and uses the shared backdrop projection. Its short
subordinate tasks—Contents, speed/effects, menus, and capture review—reuse the
named overlay primitives and own one-layer Back/Escape dismissal.

## Underlying Primitives

- `useMobileModalLifecycle` is the shared mobile composition owner for dialog,
  history, keyboard, viewport publication, and return focus. It renders no
  markup and owns no geometry.
- `useDialogOverlay` is the modal contract for all modal overlays, mobile and
  desktop. It owns modal-stack projection, shared scroll locking, focus entry,
  trapping/return, and topmost Escape. Backdrop-click dismissal stays
  caller-side (`MobileSheet` is that caller for bottom sheets).
- `useMobileModalLifecycle` is the one composition of dialog, history, and
  keyboard mechanics for the two named mobile modal presentations.
- `useHistoryDismiss` owns the one shared synthetic history marker, topmost
  Back dismissal, blocked-dismiss rearming, delayed-pop drain, and
  navigating-close guard. It carries the stay-mounted contract above.

## Rejected Hacks

None of these may appear in the implementation:

- `--vh`-style `window.innerHeight` CSS polyfills
- `setTimeout`-after-focus `scrollIntoView`
- `maximum-scale=1` zoom suppression
- global `touchmove` `preventDefault`
- user-agent sniffing
- the VirtualKeyboard API

## Contract Tests

Keep these tests aligned with this module contract:

- `apps/web/src/components/ui/MobileSheet.test.tsx`
- `apps/web/src/components/ui/MobileFullScreenTask.test.tsx`
- `apps/web/src/lib/ui/useKeyboardInset.test.tsx`
- `apps/web/src/lib/ui/useDialogOverlay.test.tsx`
- `apps/web/src/lib/ui/useHistoryDismiss.test.tsx`
- `apps/web/src/lib/ui/useEscapeKey.test.tsx`
- `apps/web/src/components/ui/HoverPreview.test.tsx`
- `apps/web/src/components/contributors/AuthorSearchField.test.tsx`
