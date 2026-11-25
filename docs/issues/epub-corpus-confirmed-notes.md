# confirmed epub notes still open as ordinary links

the original-source audit checked all 9,878 flagged pairs in 57 editions.
9,877 are real notes with complete source intervals whose exact bodies are
absent from the `44f13a831` import replay. the remaining popper link is the
return from a note that already opens correctly.

the private audit under
`~/.local/state/nexus-web/epub-corpus-notes/pair-audit/` records all source
hashes, original addresses, body boundaries and body digests. the marked
groups include multi-paragraph notes, verse, quoted blocks and tables.

resolve by deriving those complete bodies and their links through fresh
import and retained repair. compare against the original-source ledger and
preserve previously working note bodies, links and locations. the replay
must still treat the popper return as an ordinary link.

on candidate `1d058e62f9e6`, fresh import matched all 9,878 oracle rows,
including the popper control. retained replay matched all 8,691 rows across
56 editions. the king james new testament expired at the 180 s parser
limit before its 1,187 retained rows could be checked. adversarial
source-boundary cases also remain open on that candidate. require exact
fresh, retained and negative evidence on the final seal before closure.

checkpoint `4d2cfb2b3a7e` matched 9,872 of 9,878 rows in each path. both
replays missed the same six source pairs across five editions.
`completion-implementation/serial-ledger-4d2cfb2b/ledger-summary.json` in
the private corpus state has sha256
`1786c8ff70170bc01aa9de995d818842f827b36a77ed3dde88604d33e22bf36b`.

`dc27a75af57c` matches all 9,878 audit rows through both projection paths,
including the ordinary popper return. all 434 readable originals in the
435-input parser replay succeed. the same seal restores the six remaining
working-note pairs, adds seven other source-proved pairs, and restores 12
source-supported section ends relative to `352634fb36ae`. the exact body,
locator and navigation comparisons are in `completion-spec/corpus-fresh-dc27a75a/`
in the private epub corpus state directory.

the scratch-index lifetime change at `f99763d0676a` preserves all 435 semantic
projections and matches all 9,878 oracle rows in both paths. evidence is in
`completion-spec/corpus-fresh-f99763d0/` and
`completion-implementation/serial-ledger-f99763d0/` in that same directory.

`3c28bf1e7a5d` matches `c7c026e172e7` on all 435 projections, including the
physical source member for all 119,841 directed note edges. all 9,878 oracle
rows still match in each path. the final replay directory suffix is `3c28bf1e`.

close after the [paired release and per-publication repairs](release-epub-structure.md)
verify the installed graphs and protected reader state.
