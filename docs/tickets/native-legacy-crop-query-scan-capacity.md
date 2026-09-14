# legacy crop query cost

- status: open
- origin: 2026-09-13 bounded workspace implementation
- area: native schema1 conversion

`OfflineReadingLegacyCrop.kt:12–41` queries every overlapping HTML node using
`fragment_ordinal`, `start_cp`, and `end_cp`; the staging primary key orders by
fragment and node ordinal. each binary-search candidate can rescan the source
fragment. large installed documents can therefore require quadratic work despite
bounded returned rows.

prerequisite: retain ancestor reconstruction and indivisible source semantics.
use source-order range selection plus explicit ancestor lookup, or another exact
indexed query with bounded visited rows. do not add a dense document map.

acceptance: measured maximum installed-fragment conversion stays within its
foreground/background deadline and allocation budget; query plans and visited-row
counts rule out repeated full-fragment scans while existing crop proofs pass.
