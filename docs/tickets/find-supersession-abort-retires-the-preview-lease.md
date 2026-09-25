# find supersession abort retires the preview lease

status: open; read from code, not run · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: reader find

`returnToReadingPosition` and `restorePreviewOriginOrRetire` in
`useEpubPaneFind.ts` dispose the adapter and call `previewLease.retire()` on any
failure while the generation is current, including supersession aborts (the
override superseded by ordinary navigation, or a fragment change seen while
positioning). `usePaneFind` swallows aborts, so the pane keeps a disposed
adapter (later find operations abort silently) and a retired lease (semantic
viewport intent stays "Preview", progress capture stops) with no visible error.

fix: treat supersession as the end of the preview only; dispose and retire only
for a genuine defect.

acceptance: after navigation supersedes a preview, find keeps working and
progress capture resumes.
