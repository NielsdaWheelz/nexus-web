# document-map return drifts a line per round trip

status: open; pre-existing · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: reader navigation

the document-map return restores the departure's text locator (semantic
viewport primary locator via `positionFromDocumentMap` ->
`restoreDocumentMapOrigin` -> `applyReaderLocator` in `MediaPaneBody.tsx`), not
its scroll position. from a mid-section origin the reader returns up to one
prose line (26px) higher, and repeated jump/return trips drift: 3000 -> 2974 ->
2948; single trips 2663 -> 2636, 3243 -> 3229.

fix: capture the departure as locator plus viewport-top delta (as epub find's
origin does) and restore both.

acceptance: repeated contents jump/return round trips return to the same
scrollTop within 1px.
