# the transcript poll spreads a raw MediaOut into the pane

**problem**: while a transcript is queued or running, `TranscriptState` polls
`GET /media/{id}` every 3 s and hands the raw `MediaOut` to `onChange`, which spreads it
onto the pane's `MediaDetail`: the raw response carries unnormalized `chapters` (no trim,
no time order) and snake `player_descriptor`, which `mediaDetailFromResponse` maps for
the pane's first load. a poll also costs a whole detail read for three fields.

**impact**: after a poll the pane's chapters may show untitled or out-of-order entries
until reload; the poll reads far more than it needs. the processing stream already
carries these facts and stays open while a requested transcript is queued or running
(I15), but the pane's own "Transcribe this episode" request does not reopen it (a menu
request does: it invalidates Imports).

**evidence**: `apps/web/src/app/(authenticated)/media/[id]/Transcript.tsx:55-64`
(`reread` → `onChange(data)`, `useIntervalPoll`); the pane spreads `onChange`'s value.
the pane is #578's file (media core design D15).

**resolved when**: the transcript state follows the processing stream (or its poll maps
the response through `mediaDetailFromResponse` and keeps only the transcript facts), and
a pane with a transcript in flight shows the same chapters before and after it lands.
