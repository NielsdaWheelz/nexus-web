# blank tail has no visible writing hint

the flat editor hides the tail's bullet, while `NoteEditor` sets `data-empty=false`
for every projected outline. its root placeholder therefore cannot describe the
blank tail. the first firefox screenshot in run `20261025-221032-253850348541`
shows the final writing line without a bullet or hint. clicking its field works,
but the insertion point is difficult to discover.

give that existing field a visible empty-state affordance without another editor
or insertion button. verify it clears on the first input, remains outside copied
writing, and works with touch and screen-reader navigation.

the source correction reuses the existing editor placeholder grid and pseudo
content on the reserved tail field, with the existing touch target size.
emptiness follows the current field node so pending receipt metadata cannot
cover the first character with a stale hint. adoption removes the hint attributes.
the focused first-note case blocks the real creation command and checks that
first character, clipboard, canonical writing, host and next tail. it passed on
`f07f1963eb`, canonical run `20261026-000347-391b5f12f965`, including actual
emulated-touch input and the 44px target. native composition appearance and
assistive-technology behavior remain unqualified.
