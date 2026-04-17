# mobile selection popover

this brief defines the target behavior for the text-selection popup on mobile.

it builds on:

- [docs/reader-implementation.md](./reader-implementation.md)
- [docs/reader-research.md](./reader-research.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/sdlc/testing_standards.md](./sdlc/testing_standards.md)

## goal

keep a popup beside the user selection on mobile, but stop fighting the native
selection menu.

the popup must stay close to the selected text, remain tappable, and work in
both reflowable readers and pdf.

## scope

this change covers the initial selection popup only.

it does not redesign the highlight edit popover, linked items, or general app
overlay behavior.

## product decision

mobile keeps a popup.

mobile does **not** switch the initial selection actions to a bottom sheet.

desktop behavior remains the baseline and should not be redesigned as part of
this work.

## implementation rules

- keep one `SelectionPopover` capability. do not create a second popup system.
- add an explicit mobile branch inside the existing selection popup flow.
- keep the control flow local and linear in the selection popup and the two
  selection entry points.
- do not add a positioning library, shared overlay engine, or generic collision
  framework.
- do not add new intermediate models or reusable geometry abstractions unless a
  block becomes materially hard to read.
- use `Range.getClientRects()` on mobile so placement can anchor to a line box,
  not only the union rect.
- use `window.visualViewport` when available for mobile clamping.
- respect safe-area insets and the current mobile bottom-nav spacing.
- use `pointerdown` for outside dismissal on the popup.
- preserve a stable selection snapshot long enough for the user to tap a color.
- keep the mobile popup compact. prioritize the color chips first.

## mobile placement rules

mobile placement should be explicit and ordered.

1. try below the last selected line.
2. if that does not fit, try above the first selected line.
3. if that does not fit, try to the right of the selection.
4. if that does not fit, try to the left of the selection.
5. if none fit cleanly, pin a small popup to the nearest visible viewport edge.

additional mobile rules:

- default to **below** on mobile.
- treat the region immediately above the selection as hostile space because the
  native selection menu commonly appears there.
- do not rely on z-index to beat the native menu.
- do not try to infer the exact native menu rect; the platform does not expose
  it reliably.
- when the selection spans multiple lines, use the first line for above
  placement and the last line for below placement.

## timing rules

- do not render the mobile popup immediately on every `selectionchange`.
- wait for a short stabilization window so the native menu and handles can
  settle first.
- if the selection collapses before the popup is shown, do not show it.
- once the popup is shown, the highlight action must use the preserved
  selection snapshot, not a fragile assumption that the live dom selection is
  still present.

## cases to cover

- single-line selection in the middle of the viewport
- multi-line selection
- selection near the top edge
- selection near the bottom edge
- selection near the left edge
- selection near the right edge
- selection while the browser chrome is expanded or collapsed
- selection after page scroll
- selection in reflowable reader content
- selection in pdf
- selection followed by tapping a color chip
- selection followed by tapping outside the popup
- selection followed by `Ask in chat`, if that action remains in the mobile popup

## acceptance criteria

- on desktop, the current selection popup behavior remains materially unchanged.
- on mobile, the popup appears adjacent to the selected text, not detached from
  it and not promoted to a sheet.
- on mobile, the default placement is below the selection when that fits.
- on mobile, the popup avoids rendering above the selection unless below does
  not fit.
- on mobile, the popup stays within the visible viewport and safe areas.
- on mobile, the popup remains usable when the selection is near any viewport
  edge.
- on mobile, a user can select text and tap a color chip without the highlight
  action failing because the live selection disappeared.
- the same mobile popup behavior works for both reflowable readers and pdf.
- the implementation stays local to the existing selection popup path and does
  not introduce a new reusable overlay subsystem.

## non-goals

- exact measurement of the native android or ios selection menu
- disabling the native selection menu
- introducing css anchor positioning as a required runtime dependency
- adding a third-party floating-positioning library
- redesigning all app popovers around a shared framework

## regression coverage

- add browser-mode component tests for the mobile popup placement order and
  viewport clamping
- add browser-mode component tests for selection snapshot survival through the
  tap action
- cover both html selection flow and pdf selection flow
- keep existing highlight edit popover mobile behavior unchanged
