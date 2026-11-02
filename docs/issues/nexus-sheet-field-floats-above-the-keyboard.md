# the sheet's field sits a padding above the keyboard

status: open · origin: 2026-11-02 palette s4 · area: web / MobileSheet, nexus sheet

the palette's sheet uses `MobileSheet heightLimit="available"`, whose backdrop ends
at the keyboard inset (`MobileSheet.tsx`, `backdropStyle.bottom =
keyboardBottomInsetPx`). the panel keeps `padding-bottom: max(var(--space-2),
var(--viewport-safe-bottom))` (`MobileSheet.module.css`, `.panel`) in every height
policy, so the field, the sheet's last child, sits at least 8px (or the safe-area
inset) above the keyboard. `MobileFullScreenTask`, which the sheet replaced,
subtracted the keyboard inset from the safe-area padding.

impact: law 9 ("the field rides the keyboard inset") holds within a gap; on a
device with a bottom safe area the gap is the full inset (~34px on ios).
criterion 13 allows 12px.

evidence: inferred by reading; not measured (the keyboard-up pass is owner-run on
the emulator).

fix: under `.panel.available`, pad by `max(0px, var(--viewport-safe-bottom) -
<keyboard inset>)`, as `MobileFullScreenTask` does, owned by `MobileSheet`.

resolved when: on the emulator with the keyboard up, the field's bottom edge
equals the visual viewport's bottom within 1px.
