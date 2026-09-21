# highlight interaction exposes unused state adapters

status: open · origin: 2026-09-21 reader cleanup audit, base `93563d12b` · area: browser highlight interaction

`apps/web/src/lib/highlights/useHighlightInteraction.ts:106` accepts an optional
focus callback, but its only caller, `MediaPaneBody.tsx:1155`, supplies none.
the hook also returns `isHighlightFocused` at line 246, which has no caller,
and stores `lastClickedSegment.highlightIds`, which is never read. references
occur only in this hook and its own example/comment declarations.

prerequisites: none. remove the dead callback contract, unused selector, and
duplicated highlight-id field while retaining focus, bounds editing, and
overlap cycling.

acceptance: no dead members remain; selecting, clearing, bounds editing, and
cycling overlapping highlights still work; `./scripts/test` passes.
