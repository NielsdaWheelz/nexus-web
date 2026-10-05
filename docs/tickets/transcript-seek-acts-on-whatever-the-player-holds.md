# a transcript seek acts on whatever the global player holds

status: open · origin: 2026-10-05 reader rewrite pr2 review fixes (pre-existing on main) · area: web reader / player

an episode pane's seeks (a segment's time stamp, a chapter, a show-notes time, an
evidence jump, a deep link) call the global player's `seekTo` (and `resume`) with
no media: `playerRuntime.tsx` applies them to the loaded engine, whatever it plays.

- another episode loaded: it jumps to this transcript's time and plays.
- nothing loaded: the seek does nothing audible (the time stamp still moves the
  reading cursor).
- the chapters' active marker follows the global player's position for any media.

the old pane behaved the same (`handleTranscriptSeek` → `seekTo` + `resume`). a video
seeks its own embed and is not affected.

fix at the player: a command that plays a given descriptor from a time (loading it
when another or none is loaded); the pane calls it with its own descriptor, and the
active chapter reads the position only while the player holds this media.

done when: with another episode playing, a time stamp in this episode's transcript
plays this episode from that time, and with nothing loaded it starts this episode
there (a harness journey beside `R.T.J12.*`).
