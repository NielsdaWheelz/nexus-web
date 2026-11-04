# chromium's duration grows after a seek to the end of an mp3 with an `Info` header

problem: a seek near the end of a file with libmp3lame's default header lands by table of contents,
past the header's duration, and chromium raises `audio.duration` to match. `durationMs` follows the
element, so the shown duration and the `duration_ms` a listening sample stores both rise.

evidence: lab `20261101-224136-a018c2a71c8a`, chromium: `currentTime` 7510, `duration` 7512.218948,
`ended` false. firefox on the same file: 7510 and 7510. `browserEngine.ts` `durationMs()` prefers
`ms(audio.duration)`.

impact: two seconds on a two-hour file. the rest at the end, replay and the real end are unaffected:
the engine holds the rest itself and reports the position as the end. idk how far real files drift.
the folio (lane 5) would read `2:05:12` for a `2:05:10` episode after such a seek.

proves it resolved: on chromium with the fixture's spec audio, `durationMs` and the stored
`duration_ms` are the same before and after a seek to the end.
