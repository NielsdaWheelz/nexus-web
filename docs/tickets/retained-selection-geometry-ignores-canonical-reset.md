# retained selection geometry ignores a canonical reset

status: open; read from code, not run · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: reader selection

`useRetainedReaderSelectionGeometry` (`lib/reader/useRetainedReaderSelection.ts`
~239-271) keys its ResizeObserver and viewport scroll listener on `sourceKey`,
which `MediaPaneBody` passes as `activeContent?.fragmentId`. a canonical reset
remounts `TextDocumentReader` on the same fragment, so the listeners stay on the
detached viewport and retained-selection geometry stops refreshing until the
fragment changes. the reader layout readiness key already includes the reset
revision for the same reason.

fix: key `sourceKey` on the reset revision as well.

acceptance: after a canonical reset, a retained selection's geometry follows
scroll and resize.
