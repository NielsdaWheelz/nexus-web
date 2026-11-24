# geometry-only pane resize can sample an already clamped offset

a uniform collection can publish a changed geometry frame after the layout
that shortened its scroll extent. at `9aff45f4b`,
`apps/web/src/lib/workspace/paneReturnMemento.tsx:437–446,539–545,783–790`
pairs the prior frame with live `oldTop` after `sampleTravel()` accepts a
native clamp. this can compute a second displacement from the wrong scroll
offset. the journal's before-layout snapshot and the tested sort exercise
different paths. the resize failure remains unverified.

to reproduce, open a library with more than 200 entries in a narrow desktop
firefox window, scroll the windowed list to its bottom, then widen the
window across the mobile breakpoint. keep the entries and order fixed.
`apps/web/src/components/ui/ResourceRow.module.css:284–294` gives mobile
and desktop rows different minimum control heights. require a measured
row-height reduction and native clamp in the same commit before comparing
the visible occurrence and old, clamped and final offsets. resolve when
only the residual relative correction is applied against the old line,
or measurements establish that this geometry publication cannot hit the
described clamp.
