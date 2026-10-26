# blank tail has no visible writing hint

the flat editor hides the tail's bullet, while `NoteEditor` sets `data-empty=false`
for every projected outline. its root placeholder therefore cannot describe the
blank tail. the first firefox screenshot in run `20261025-221032-253850348541`
shows the final writing line without a bullet or hint. clicking its field works,
but the insertion point is difficult to discover.

give that existing field a visible empty-state affordance without another editor
or insertion button. verify it clears on the first input, remains outside copied
writing, and works with touch and screen-reader navigation.
