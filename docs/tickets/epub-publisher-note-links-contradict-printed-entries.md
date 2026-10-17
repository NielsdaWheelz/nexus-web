# publisher note links contradict printed entries

status: open; owner-deferred source correction, outside book57 body repair
origin: 2026-10-17 book57 complete original-source audit and owner disposition
area: epub publisher links

problem: five original links disagree with their printed editorial entry.
source-local entry structure still proves complete note-body boundaries; these
hrefs cannot prove the intended forward relation. retain original bytes and
repair the proved bodies. none of these links receives a passing consumer claim.

exact evidence (source hashes remain in the frozen book57 inventory):

- `24e67f54-353e-4791-8db5-72c935a4bf9c`, `text/part0024.html#PIIIC01_5`: printed marker5 links to
  `text/part0035.html#iPIIIC01_1`; body `iPIIIC01_5` returns to marker5.
- `20405d0e-4fda-4cc7-b5e0-04b6a8a724d6`, `OEBPS/Text/part0012.xhtml`, following `ch39_footnote_n22-7`:
  printed range22:14–23 links to `part0012.xhtml#ch39_footnote_f21-14`.
- same book, `OEBPS/Text/part0016.xhtml`, following `ch41_footnote_n20-6`:
  printed range20:7–12 links to `part0015.xhtml#ch41_footnote_f20-1`.
- `228d14cf-120c-495c-9e5c-5a3383658843`, `OEBPS/Text/part0044.xhtml`, following `ch14_footnote_n34-11`:
  printed range34:12–16 links to `part0042.xhtml#ch14_footnote_f34-1`.
- same book, `OEBPS/Text/part0052.xhtml`, following `ch19_footnote_n30-24`:
  printed range30:27–33 links to `part0051.xhtml#ch19_footnote_f30-7`.

private evidence: campaign `coordinator/followup57-20261016/five-malformed-publisher-links.json`,
sha256 `c09b3e89f440260d30fdac6b202d14e0263b9c1a1d701cd5531d77d674e6b913`,
and the complete source/body oracles. public records contain no book prose.

next: separately authorize an explicit source-link correction, prove the intended
authored target and publication identity, and preserve text/saved coordinates.
do not hide a source correction in retained metadata repair or guess an edge from
printed numbers.

acceptance: corrected links resolve to independently verified intended content
on web and phone, with explicit source/publication provenance and protected-state
proof. campaign closure does not close this ticket.
