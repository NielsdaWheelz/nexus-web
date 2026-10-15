# heading rank overrides an authored publisher root

status: open; whole-book repair unsafe, not applied
origin: 2026-10-15 book-repair original-source review, operator `150328b65`
area: epub semantic hierarchy

media `a0b16180-2833-4854-8ceb-d3763884e096` declares chapter 14 and
appendix as adjacent root siblings in its original ncx. the original contents
also gives them adjacent equal-class sibling entries. their headings are h2
and h3 in separate source documents. the candidate makes the appendix a child
of chapter 14's heading and extends both chapter 14 sections from `23:0` to
`24:0`, through that appendix. the toc still records root siblings.

`python/nexus/services/epub_structure.py:245` sets publisher ancestry, but an
explicit publisher root remains indistinguishable from an unassigned parent.
`_assign_parents` at line 830 then assigns the previous heading as parent from
its rank stack across documents. preserve authored publisher roots when
adding inferred heading ancestry. verify legitimate inferred subheadings
still work; do not reset every hierarchy at a fragment boundary.

private evidence: `c-sources/navigation-two-original-boundary-review-v1.json`,
sha256 `b6c8e71e90e5bcb1360c1908b918218e97e0e3e82a9c1442a0cc721ebcca2dca`;
independent review `a-maintenance/c-two-original-boundary-independent-review.json`,
sha256 `072f169f882de3e22de3c3e55feb5737f0120630291a169695b750950d85e0a4`.
source `af0c0473793c2ac8b1de9e169ec4181ed5ba10108e980d02f54417ee7a5301ed`;
full proposal `f897758cf1178767b0a3d67a31833a2d0544f6eafd1296eaed6e18701db091fc`.
the receipts bind original navigation, retained headings and the complete
current proposal. remaining fields are not approved. stored text is intact;
apply and reader consumers were not executed.

acceptance: the real-source full proposal preserves appendix sibling ancestry
and chapter 14's authored scope, while retaining genuine source nesting.
qualify installed hierarchy/extents and reader consumers before applying this
book. this shared hierarchy fix is outside the bounded repair campaign and is
separate from local title-container clipping.
