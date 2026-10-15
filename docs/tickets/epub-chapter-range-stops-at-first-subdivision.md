# reading-division ranges stop at an internal subdivision

status: open; two historical proposals withheld after independent source review
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
