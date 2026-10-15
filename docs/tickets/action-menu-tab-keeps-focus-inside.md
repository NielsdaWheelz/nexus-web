# action menus keep tab focus inside

status: open
origin: 2026-10-14 menu design audit
area: web / shared action menu / keyboard

`apps/web/src/components/ui/ActionMenu.tsx:204-210` wraps tab and shift-tab
between the menu's first and last focusable elements. command buttons at
`:305-312` also remain ordinary tab stops. `docs/modules/overlays.md:146-150`
documents the loop. this is a source-proven mismatch with the
[aria menu pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/): arrows
navigate items; tab exits and closes the menu. escape still exits, so this
finding alone does not establish a wcag keyboard-trap failure.

prerequisites: none. fix the shared menu's item focus and tab dismissal policy,
and update the overlay contract. preserve disabled-item explanations, arrows,
typeahead, escape return focus, and menu-to-dialog handoff. tab dismissal must
continue from the invoking control in page order, including portaled menus.

acceptance: manually open row and pane menus with keyboard; tab and shift-tab
close them and reach the adjacent page control in the intended direction.
arrows still navigate menu items; escape restores the opener. also check a
menu inside a modal, whose enclosing modal must retain its own focus boundary.
