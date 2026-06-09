# Overlays Module

## Scope

The overlays module owns mobile bottom-sheet presentation and the overlay
behavior primitives it composes. Owners live under
`apps/web/src/components/ui/MobileSheet.tsx` (+ `MobileSheet.module.css`) and
`apps/web/src/lib/ui/{useDialogOverlay,useHistoryDismiss,useKeyboardInset}.ts`.

Established by `docs/cutovers/mobile-sheet-keyboard-unification-hard-cutover.md`.

## MobileSheet Capability Contract

`MobileSheet` is the single mobile bottom-sheet owner. For every mobile bottom
sheet it owns:

- portal to `document.body`
- backdrop scrim with tap-to-dismiss
- grabber + drag-to-dismiss (96 px threshold, inert under reduced motion)
- keyboard avoidance: shrink + lift via `--keyboard-inset` on the panel
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

## Mount Contract

`MobileSheet` must stay mounted across the open/close cycle and be driven with
`active`. Never write `open && <MobileSheet …>`. `useHistoryDismiss` (its C7
doc comment) must observe `active` going false to pop its synthetic history
entry; conditional rendering breaks back-button dismissal.

## Keyboard Geometry Ownership

`useKeyboardInset` is the single keyboard-occlusion source and is importable
only by `MobileSheet` (ESLint-enforced). Values below its 60 px threshold
report 0. Do not add per-component `visualViewport` keyboard listeners.

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
- `default` (`--overlay-scrim`): app-level modals — Add Content tray, expanded
  player, palette

## Out Of Family

`NavSheet` is a left-anchored side drawer, not a bottom sheet. It keeps its own
geometry, uses `useDialogOverlay` directly, and wires `useHistoryDismiss`
itself. Do not fold it into `MobileSheet`.

## Underlying Primitives

- `useDialogOverlay` is the modal contract for all modal overlays, mobile and
  desktop. Backdrop-click dismissal stays caller-side (portal-safe pattern;
  `MobileSheet` is that caller for bottom sheets).
- `useHistoryDismiss` owns back-button dismissal, including the
  navigating-close microtask guard. It carries the stay-mounted contract above.

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
- `apps/web/src/lib/ui/useKeyboardInset.test.tsx`
- `apps/web/src/lib/ui/useDialogOverlay.test.tsx`
- `apps/web/src/lib/ui/useHistoryDismiss.test.tsx`
