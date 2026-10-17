# navigation heading becomes a book-wide parent

status: open; existing guide defect preserved; separate new contents containment independently confirmed unsafe
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

media `2ce4bf54-f9dd-472e-8005-e8a9582f212d` shows a new effect of the same
navigation-heading inference. its complete retained contents document at
fragment 4 has 21 links; all non-link text is the `CONTENTS` heading. one link
points to the separately headed preface in fragment 5. the candidate newly
parents that preface and its closing note under the contents h1, and expands
the contents range from `4:0–5:0` to `4:0–6:0`, across all 6,843 characters
of the next document. a navigation link does not establish reading-division
ownership of its target. the preface and note ranges and stored text survive.

this complete proposed regression is bound by
`a-maintenance/navigation2ce-contents-scope-review-v1.json`, sha256
`607e511290b7fed578f9eb8dea555cfd9cb1cb9de6862ea61e82797bc4b6d70f`;
executed fixed helper `9580b329a9c3bfa40ceb988a0c29bc87793e68850189ca4a65ac89364f2280fe`
passed once with empty stderr. source `017f10daa86f649a67a5eddcb2a86a8d087400745f3f99432593f626e41adb6c`;
proposal `55cd44a6311419e68714da441ed262e2c01fe349b97e183e42abe0d2ca87f0d9`. exact retained html/text and full-row hashes
bind the source reading. original navigation was not acquired; this conclusion
does not require flat publisher-outline parity. other proposed fields remain
unadjudicated, and no apply or reader consumer was executed. independent
source and complete-projection review is recorded in
`c-sources/a2ce-contents-independent-review.json`, sha256
`65e57edf36a8a4d6719266f51eafca0ccb3b10310cfc2529dd1f152880346ad8`.

acceptance: this real retained/source case produces no routine guide section
or guide-parented chapter/back-matter divisions. authored links, text,
chapter identities and legitimate nested divisions remain intact. inspect
the full proposed metadata and verify normal navigation/reading consumers
before repairing this existing state. the second case keeps the contents
page bounded to its navigation role and leaves preface/note outside it, while
preserving the authored links and their destinations.
