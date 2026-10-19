# action menus keep tab focus inside

status (2026-10-18): deleted on main by #651 without a recorded resolution, while an uncommitted 2026-10-16 recheck (below) was still adding evidence; restored from that recheck. unverified: `ActionMenu.tsx:174` and `:339` still handle Tab inside the menu.

status: open
origin: 2026-10-14 menu design audit
area: web / shared action menu / keyboard

rechecked on 2026-10-16: `apps/web/src/components/ui/ActionMenu.tsx:208-214`
wraps tab and shift-tab between the menu's first and last focusable elements.
command buttons at `:309-318` also remain ordinary tab stops.
`docs/modules/overlays.md:166-172`
documents the loop. this is a source-proven mismatch with the
[aria menu pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/): arrows
navigate items; tab exits and closes the menu. escape still exits, so this
finding alone does not establish a wcag keyboard-trap failure.

prerequisites: none. fix the shared menu's item focus and tab dismissal policy,
and update the overlay contract. preserve disabled-item explanations, arrows,
typeahead, escape return focus, and menu-to-dialog handoff. tab dismissal must
continue from the invoking control in page order, including portaled menus;
it must not run the escape-style return-focus path after focus has advanced.
the menu stops key propagation (`ActionMenu.tsx:189-195`), so its tab policy
must also respect the containing modal's boundary, owned by
`lib/ui/overlay.ts:215-230`. loading and empty surfaces need the same exit rule.

acceptance: manually open row and pane menus with keyboard; tab and shift-tab
close them and reach the adjacent page control in the intended direction.
arrows still navigate menu items; escape restores the opener. also check a
menu inside a modal, whose enclosing modal must retain its own focus boundary;
check loading, failed, disabled-only, and directly anchored menus too.
