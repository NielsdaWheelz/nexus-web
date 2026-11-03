# note attachment reload proof is blocked

both managed browsers at the held import cut show an actual confirmed epub in
the original note row before reload, then fail to find that same row's embed
after reloading its daily page. this leaves attachment persistence unqualified;
it does not yet establish that the authored content was lost.

reproduction: create a unique daily note, select its editing field with mod-a
and empty it, drop a real epub on that field, await its actual confirmation and
the exact media ref inside that note row, open and close import to check that
no duplicate intake line exists, then reload and inspect that same row/ref.

evidence: lab `20261103-002002-2f1baa7d0845`, source base `1b63b570`, temporary
`s2c-sources.spec.ts` sha `7cff97ae`; both note cases reach the confirmed embed
and no-duplicate assertions, then time out after reload. exact cleanup passed.
the original row, authored identity and route need diagnosis before changing
either the oracle or product. attachment redesign is an import non-goal.

resolved when real authored and rendered evidence explains the discrepancy
and the ordinary same-note reload proves the actual accepted attachment.
