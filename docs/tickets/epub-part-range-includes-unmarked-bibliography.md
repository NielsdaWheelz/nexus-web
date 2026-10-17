# part range includes a separately labelled bibliography

status: open; new part scope independently confirmed unsafe
origin: 2026-10-15 book-repair retained-content review, operator `150328b65`
area: epub reading-division boundaries

media `02b3b38c-ed34-4a34-83b0-bce8f8850e75` has a separately labelled
bibliography after its last chapter. fragment 208, `OEBPS/Text/afewbook.xhtml`,
contains the label “A Few Books About Stalinist Russia and Vasily Grossman”
and sixteen entries with italic book titles and publication dates. the complete
1,339-character document uses divs, with no heading or structural-container
element. the following copyright document starts at `209:0`.

the candidate expands `PART THREE` from `146:0–147:0` to `146:0–209:0`,
including that reference list. its final chapter's new publisher extent also
reaches `209:0`. the retired chapter heading already had that overbroad tail;
the part's expanded scope is new. this is a reading-division ownership claim,
not deletion of stored text or a lost navigation destination. other proposed
fields remain unadjudicated.

`python/nexus/services/reader_structure.py:103–126` closes ranges using admitted
section targets, ancestry and containers. no admitted boundary represents this
div-based bibliography, so the part closes at copyright instead. establish the
bibliography's source role at the epub structure owner and carry its boundary
into range derivation. do not treat every file boundary as a section or invent
a heading from an arbitrary div.

private evidence: `a-maintenance/navigation02b-bibliography-scope-review-v1.json`,
sha256 `1733da80600cd1dab56539173d7f86f76fa8844ef03e493f0860cc24a0273bbb`;
fixed helper `6d1fe24b1826adad190b9eb177b9f05b6502d30b02c9ca189e23b3cf1e9654ea`
passed once with empty stderr. source
`f9764d38191b84661bcd4cbc7839a39984ebdc6568af645e256d0340b9cd397d`;
snapshot `88b803f074eae062ad8cd0c68abc50b1eb0f01be835824e125d8fa8e9cb1367b`;
proposal `13e52936bc3a6a91b905e29cde35d5c8414bf30c6887fbef0726128663f089bc`.
exact retained html/text and full-row hashes bind the source reading; original
navigation was not acquired. independent source and complete-projection review:
`c-sources/a02b-bibliography-independent-review.json`, sha256
`deaec00af30ccaed68bc578861e5845c1bd5102f8958cad0250f11b68709b64b`.
no apply or reader consumer was run.

acceptance: independently settle this reference-list ownership, then verify
that part/chapter scopes exclude the separate bibliography while preserving
all source text, anchors, legitimate chapter coverage and navigation. inspect
the complete proposal and normal reader behavior before applying a correction.
