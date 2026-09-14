# offline web navigation repeatedly scans and expands preceding text

- status: open
- origin: 2026-09-13 workspace architecture review; local sha `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: shared reader session and offline web article navigation

`apps/web/src/lib/reader/DocumentReaderSession.ts:190–224` constructs web
navigation by finding each section's fragment, filtering all preceding
fragments, and recounting their canonical text. `textOffsets.ts:2–3`
implements each count as `Array.from(text).length`, allocating an array
of code points. navigation therefore repeats prefix text scans and
temporary allocations for every section. the branch is used when a text
source supplies navigation (`DocumentReaderSession.ts:265–268`), including
`apps/web/src/lib/offlineReading/OfflineReaderAdapters.ts:105`.

this is a source-level browser/native-webview cost. it is not evidence
about the server allocation that caused the production api memory kills.

prerequisites: retain canonical unicode-code-point coordinates and the
existing fragment ordering/section offset contract.

proposed fix: calculate each fragment's canonical length once, derive
prefix offsets once in canonical order, and look up the section's fragment
projection. count code points without materializing a character array when
only the count is needed. retain strict behavior for absent/invalid targets.

acceptance: navigation remains coordinate-identical for multi-fragment
articles containing supplementary-plane characters. representative large
offline articles show linear total text counting and bounded temporary
allocation; verification runs through `./scripts/test`.
