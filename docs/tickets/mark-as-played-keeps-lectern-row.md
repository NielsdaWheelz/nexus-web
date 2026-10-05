# "Mark as played" keeps the lectern row; undo then moves it

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), player slice spec and harness · area: player / listening

## what is wrong

`EnsureMediaFinished` does not remove the row; undo sends `UndoCompletion` plus `PlaceItems First/After` (`resourceActionMenu.tsx:567-590`, `useCompletionUndo.ts:315-320`). related: "Add to Lectern" stays enabled for an item already on it and silently moves it to Last (`TranscriptPlaybackPanel.tsx:427-434`).

## fix

resolve in the player rewrite (`player-reauthor-ready.md`), or at the owning module if fixed first.

## acceptance

a player harness journey shows the corrected behaviour on desktop and android.
