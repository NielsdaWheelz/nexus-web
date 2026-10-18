# navigation heading becomes a book-wide parent

status: open; outside57 installed guide ownership remains unqualified
origin: 2026-10-15 book-repair retained-content review, operator `150328b65`
area: epub reading-division inference

media `e2fc380b-f574-4fb2-a3fb-820f9234f428` has a retained `h1` labelled
`Guide` directly inside `nav` in `OEBPS/text/nav.xhtml`. its following list
links to the cover, contents and first chapter. the verified original opf
declares this file with `properties="nav"`; the full original navigation
markup was not acquired.

the restored installed section `heading:df24dfb4-94f4-5ad5-93d3-78c05e7c3b60`
starts at `4:228` and ends at book eof `16:637`. it parents all six chapters
and five back-matter divisions, plus six duplicate title headings. the
candidate removes those duplicates but preserves the guide's range and all
eleven surviving parent relationships. only its ordinal changes. this is an
existing false reading division, not a regression introduced by the six
proposed adjacent number/title unions.

`python/nexus/services/epub_structure.py:265` admits routine headings without
checking whether they label navigation. `_assign_parents` at line 830 then
uses the preceding heading rank across documents. canonical structure tracks
section/article containers, not navigation ancestry
(`python/nexus/services/canonicalize.py:29`, line 147). fix semantic heading
eligibility at the structure owner, carrying source navigation context if
needed. preserve source text, navigation links and legitimate publisher
divisions; deleting navigation markup from canonical content is not a fix.

private evidence: `c-sources/navigation-e2fc-union-review-v1/receipt.json`,
sha256 `8842761f4cd95b3092d64463187f759287225075ea95203c18d1380205c67359`.
it binds the complete installed/proposed metadata, retained html/text and
original opf. source
`78bc653550a123d9fcb8de976f744b2bd336c930fd9c438bc272c09e509d957b`;
snapshot `29309415dd7e14a53b11b2c56b4f66fea9ddf1fff4dc17e39241885edcca7089`;
proposal `fff3cf544f836edabcaf79a4fd7e634e66d011a9802d13c465f03510c2197312`.
no database mutation or consumer execution establishes a live symptom here.
the union changes need their own disposition; this record does not approve
the existing hierarchy or the whole repair.

the shared source owner changed during book57, but this media is outside its
57-id inventory. that source correction proves neither this installed repair
nor its consumer behavior. the separate `2ce4bf54` contents-containment case is
accepted under book57; its original failure remains in the private archive.

acceptance: source-verify the complete correction for this exact media, then
perform a fenced repair and ordinary navigation/reading checks. no routine guide
section may own chapter or back-matter divisions. preserve authored links, text,
chapter identities and legitimate nested divisions. acquire the missing original
navigation evidence before treating a new complete proposal as source-approved.
