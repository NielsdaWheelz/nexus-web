# reading-division ranges stop before their owned content

status: open; four historical proposals withheld after independent source review
origin: 2026-10-15 book-repair retained-source review, operator `150328b65`
area: epub semantic hierarchy and extents

media `77e01dd8-264b-4169-9a53-e317b1219709` has consecutive source
chapters `1`, `2`, `3`, and `4`. each restarts a bracketed `[1]`, `[2]`, …
subdivision sequence. the outer numeral and bracketed headings all use `h3`.
the publisher destinations select the outer chapters; none selects the
bracketed headings.

the repair gives chapters 2–4 newly finite ranges `4:0–4:3`, `5:0–5:3`,
and `6:0–6:3`. each contains only its numeral and two separators. the
first bracketed subsection and all chapter prose fall outside it. the exact
source documents contain 12,075, 46,540, and 9,010 canonical characters.
their former publisher ends were absent. earlier standalone numeral-heading
ranges were already this short; copying that defect into the publisher
chapter is a new false coverage claim.

`python/nexus/services/epub_structure.py:806` pops equal-rank headings;
the bracketed subsections consequently share the chapter's part parent.
`reader_structure.py:105` closes a section at the next target of equal
ancestry depth. source numbering distinguishes these two levels even though
the html ranks do not. the subsection ranges and stored text survive; this
is not text deletion or an executed reader failure.

the historical proposal for `3b353574-730a-4a18-be83-55ff894058bf`
makes the same semantic mistake at the book/chapter level. source contents
names books ii and iii separately. book ii opens at `12:0` with chapter xi,
then chapters xii–xviii precede the explicit book-iii/chapter-xix opening at
`20:0`. the publisher book's formerly absent end becomes `13:0`, excluding
all seven later chapters. later chapter headings use the same `h2` rank as
the book title. an already short standalone book heading is retired; its
inherited error does not justify the new finite publisher extent. other
parent and range changes remain unadjudicated. independent review confirms
this fixed failure.

private proof: `a-maintenance/navigation77e-subdivision-scope-review-v1.json`,
sha256 `3461fe70015edd2c775b2f53e74f1668b3e835363931f8f34ba58c25e7db8380`.
it binds all four source documents, complete before/after projection,
surviving subsection ranges and the exact new chapter ends. source sha256
`979d06be25c4d3a88f02384361bfc312f41a2820c09458be8baa9e820810dd35`;
proposal sha256 `9b734c13b3211fda4633fd5f2084987957f89e6e2536ae82a0e1ce8dbcc11321`.
independent review: `b-reader/a77e-subdivision-independent-review.json`,
sha256 `8a9e707a8a0cbae4c5c116617b0bc5e313b7c7c32b40809b6a3fbdd51c80c03b`.
original navigation and other proposed changes are unadjudicated.

the book-level proof is `a-maintenance/navigation2-scope-failures-v1.json`,
sha256 `c232f5acb6e3155ff57b2c25b8760741f24f3982163fcb533323ddf9b722b940`.
it binds the retained contents and all nine source documents from book ii
through the next book opening, plus the complete candidate projection.
source `7ea273a85604887ae081a6ef7923f4535ea0e9de6947edc699a4f9696e4ced47`;
proposal file `6df6e9af6ad11da24399e4b90180facf136bfff6b4f1c4385e0247497791f537`;
full proposed metadata
`fb39f661ba78c490c17fad7d35cac10688d6a660e43f12ee2e8ff9ac63547196`.
this evidence concerns the frozen `150328b65` proposal; the newly integrated
stack has not yet been inspected for this case.
independent review `c-sources/a-two-scope-failures-independent-review.json`,
sha256 `3e3bbc25464eb5fba69c74408dd4c0a5af9135e8ac818ef98616fbb53356fed8`,
reparses the ten retained contexts and rebuilds the complete proposal.

media `c1260306-6a98-4282-b6c7-c682913beb90` supplies a third, distinct
changed-endpoint case. original `OEBPS/056_chapter.xhtml` has one authored
chapter container owning all 56 headings and 8,879 canonical characters.
the publisher chapter's endpoint changes from `55:12` to `55:409`, an
internal heading. 44 of its 46 preserved child divisions start beyond that
endpoint. the old endpoint was already incomplete: this change improves
coverage, but its newly asserted endpoint still contradicts the authored
chapter. no new text loss, regression from complete coverage, or changed
child membership is claimed. the source's classed `div` does not enter the
structural-container owner; equal-rank heading closure supplies the
incomplete end. other proposed fields remain unadjudicated.

private proof: `b-reader/c126-chapter-scope-review-v1.json`, sha256
`504ef8e90bb51d75d1197739d1250a4c37f8bd2b42730d058cee06c4489147c7`;
independent review `a-maintenance/c126-chapter-scope-independent-review.json`,
sha256 `6038a2ddbf31194e2c76ffd314d2b8d6c51cb1665cea43abecba884fe5ff79b6`.
the exact additional original member was separately admitted and hashes to
`5d46b3d7412b9610bbe86873324435500d8124f46aa79014a6d39ad9a019ebc3`.
source `3d958df06c2c32002013cdd92a176d78bc9580edf8562b1462f07bc165540e26`;
full historical proposed metadata
`6b06fc871f48b116a204cf07d1e81e536b14445b4b4361f123a51c89e6cdde95`.
the 48-note source proof remains a separate, limited success; fresh-stack
inspection and runtime acceptance remain unrun.

media `e838122f-a37f-40bd-90b1-2d1b5bd610cc` exposes the same unchecked
finite-extent claim at a mismatched arrival point. seven publisher chapter-i
rows, one in each of parts 2–8, keep their inherited start at offset zero.
that point selects the preceding part title. their formerly absent ends
become offsets 10, 11, or 12, exactly before the authored chapter-i heading
and its prose. each new interval contains only the part title and separators.
the separate, correctly bounded chapter headings survive. part 1 already had
an incorrect finite end and is excluded from this finding. this is neither
new text loss nor loss of the surviving chapter intervals.

`epub_structure.py:358` cannot match the publisher label `I` to the leading
part title or the joined part/chapter labels. the unmatched publisher row
still reaches `reader_structure.py:105`, whose next equal-depth heading
supplies the new end. the responsible gap is asserting a finite division
without establishing what that publisher point owns; skipping the part title
or copying the separate chapter range needs its own source justification.

private proof: `b-reader/e838-first-chapter-scope-review-v1.json`, sha256
`8aa3ec3b1ecbe5c2f6005ee4c973cc0be94649c0e06ae015854fa5b6ad72b7ab`;
independent review `a-maintenance/e838-first-chapter-independent-review.json`,
sha256 `dabc30d16849eafd98a61bbabf0b90bed88f118a753a7391f14e98b3a070d103`.
the seven retained documents and complete proposal are bound to source
`5dd0d16248a59ba947e2cecae18f5ea8ad9486d00c08869f241e87ed6973298a`;
full historical proposed metadata
`f2320b7a76f7e5337a8cfbbeb29d3e565604794fe325b9434151fb6b13738599`.
other proposed fields and fresh-stack behavior remain unadjudicated.

fix the semantic hierarchy/range owner to require source-supported division
boundaries before asserting a finite extent. equal html rank alone cannot
certify that a division ends at an internal subdivision. preserve an absent
extent if source ownership remains unresolved; do not add a book-specific
label exception or change source text to satisfy the heuristic.

acceptance: these three chapters include their proved subdivisions without
crossing the next chapter. preserve the subsection identities and ranges,
then verify the complete installed projection. also qualify a genuinely
separate following division so ordinary sibling closure still works.
book ii must include its explicit chapters xi–xviii and stop before book iii;
do not infer that grouping from filename stems or html rank alone.
the chapter-40 case must include all its source-owned child divisions within
the proved chapter boundary; do not preserve an internal endpoint merely
because it improves an earlier incorrect one.
the seven chapter-i ranges must establish their authored arrival and extent
before receiving finite bounds; a range ending before its own heading fails
that contract even when another row exposes the correct chapter.
