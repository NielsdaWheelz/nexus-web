# historical epub sources name anchors absent from publication

status: open
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

acceptance: all seven cases either resolve against a proved retained target or
prove the absent anchor is irrelevant to installed navigation/apparatus. otherwise
inspect fails without writes and the combined reader cutover waits. no source-only
offset enters toc, sections or apparatus.
