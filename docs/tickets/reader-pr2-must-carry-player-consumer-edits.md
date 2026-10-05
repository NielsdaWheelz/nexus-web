# reader pr2 and the player re-author edit the same two panes

status: open · origin: 2026-10-05 player re-author (branch `cleanup/player-reauthor`), owner decision P7 · area: reader / player coordination

## what is wrong

the reader's pr2 (branch `cleanup/reader-reauthor`) deletes `app/(authenticated)/media/[id]/MediaPaneBody.tsx` and `TranscriptPlaybackPanel.tsx` and rebuilds transcript seek on `lib/documentReader`'s `onSeekTime`. the player re-author changed only their calls into the player and the lectern:

- `MediaPaneBody`: "done & open next" calls `lectern.done(mediaId)` for a media with or without a row (was `finishLecternItem({…, nextCapability: "Readable"})`, or `ensureMediaFinished` without a row) and offers undo with `{mediaId, before, finishId: result.finishId, done: true}` (the server restores the prior state the finish recorded); the descriptor's artwork is `descriptor.artworkUrl`; activity status badges are gone (`activityRuntime` deleted).
- `TranscriptPlaybackPanel`: "Play next" places After the playing episode's lectern row (`playingEpisode(state)` matched against the snapshot), else First (was After the client-side lectern origin).

## what to do

whichever branch merges second re-applies the other's intent: the reader's new transcript and done surfaces use the calls above; the player's harness journey W12 (transcript segment and show-notes seek) must still pass.

## acceptance

both branches are on main, the reader's replacements use `done`/`UndoFinish{finishId}` and the row-based "Play next", W12 passes, and this ticket is deleted.
