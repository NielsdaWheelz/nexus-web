# notes-only scrolling can write a transcript reading position

source reviewed at `6199746fc671bf37e2c6c7b7a6fa3119b177f100` on 2026-10-23;
runtime not run. exposed by the always-expanded episode-notes design review.

`apps/web/src/lib/documentReader/text/geometry.ts:245-275` captures the first text
range below the reading line without requiring transcript text to intersect the
viewport. long host content in `TextSurface.tsx:415` can therefore leave only show
notes visible while capture still projects the first transcript point.
`scrollport.ts:184-186` records genuine wheel input; `runtime.ts:435-466` can report
that point to progress sync in restored reading mode.

impact: interaction with publisher notes can be attributed to transcript reading
and change its saved position, despite no transcript text being visible. this is
distinct from an explicit timestamp/read-from action and ordinary transcript
scrolling, which must continue to own reading progress.

reproduce with long notes and an already-readable transcript: scroll within the
notes while all transcript text remains below the viewport; observe reader
position writes and the next restored position. compare with scrolling actual
transcript text and with explicit timestamp activation.

repair eligibility at the shared text geometry/progress boundary; preserve
placement needed for restoration without inventing visible text. resolution
requires real-browser proof that notes-only input cannot overwrite transcript
position, while visible-text scrolling, explicit navigation, history restoration
and end-of-document progress still behave correctly. the owner explicitly kept
this repair separate from the episode-show-notes change on 2026-10-23.
