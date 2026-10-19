# historical epub sources name anchors absent from publication

status: open; six historical cases remain outside the accepted book57 case
origin: 2026-09-27 production corpus census, base `3029201f`
area: epub navigation repair / target identity

seven of 239 hash-verified ready epubs failed source/stored anchor comparison.
each first failing fragment has one source-only anchor name and no retained-only
name; private evidence: `/tmp/nexus-chapter-rehearsal.nx22kQ/census/receipts.jsonl`
(0600). `epub_ingest.py` currently rejects the whole publication; using the
source offset would invent a destination absent from retained html.

prerequisites: classify each name against authored toc links, apparatus refs and
existing item identities. source-only destinations may only be reported as
unresolved if no retained target exists; old exact apparatus locations remain
invariant.

acceptance: the six remaining cases either resolve against a proved retained target or
prove the absent anchor is irrelevant to installed navigation/apparatus. otherwise
the affected repair refuses without writes. no source-only
offset enters toc, sections or apparatus.

2026-10-17 book57 evidence: `260d82bd-251c-404c-ba1d-3cb30a65232c`
names `toc.xhtml#calibre_generated_inline_toc` on its original body, but retained
fragment1 contains no matching id/name. exact member sha256
`18584ba50d46301243df8c36593e3f0091b6ccea708f2ad594ef152befd98f96`;
campaign `coordinator/followup57-20261016/source-navigation-anchor-facts.json`.
the complete original body has exact retained correspondence and its body id is
unique. the book57 correction binds that proved boundary to retained offset0;
local positive/negative checks and the complete0292 clone cli/apply/no-op pass.
ambiguous aliases remain unbound and existing valid anchors are preserved.
the complete source/projection and required consumer checks for this book57 case
are accepted. source-member existence alone still proves no retained point.
the other six historical cases remain unqualified; this repair does not close
or authorize changes to them.

2026-10-18: the repair purge deleted the navigation repair operator (`services/reader_navigation_repair.py`, `ops/reader_navigation_repair.py`) and `epub_ingest`'s retained-fragment branch. the affected books keep their published state; a fix restores the operator from git history or replaces it.
