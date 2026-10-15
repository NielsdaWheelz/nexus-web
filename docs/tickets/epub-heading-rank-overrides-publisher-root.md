# heading rank overrides an authored publisher root

status: open; three whole-book repairs unsafe, not applied
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

the same path also changes media `c5caf377-cbf0-43e1-8aee-906e338d6f90`:
the retained headings literally name `CHAPTER FOUR` and `CHAPTER ELEVEN`,
both beginning separate source documents. the candidate coalesces their
publisher sections with those headings, then the h1/h2 rank difference makes eleven a
child of four. chapter four's end moves from `43:0` to `85:0`, across 42
additional fragments. both stored toc entries remain roots. the retained
same-type chapter labels establish peer divisions; the stored flat toc only
corroborates that reading. the original ncx was not acquired, and remaining
fields are unadjudicated. preserving the explicit publisher-root decision
through `_assign_parents` addresses both cases.

second-case evidence: `c-sources/navigation-c5-numbered-chapter-facts-v2.json`,
sha256 `847b7d454903af18529ceb7d5d473085ff2aef11a49e3a9ea115cdb09e339715`;
independent `b-reader/navigation-c5-independent-review.json`,
sha256 `aeac72096eb3a0cad6c25d0b650d0b3d8e073a241bcb656a758999ebd9442e8f`.
source `c0a780a9617c39166ac21d5e69cd2ed13d3c449df0f863511d01a4c7ffe9b80f`;
full proposal `dedfff2b973c7d5253665f8c097d39f9ed62c58866b37c0362f7d3604da15a60`.
the whole proposal is unsafe and unapplied; stored text is intact.

row232, media `09f34c39-5c2c-481a-a713-9d83f7bbf320`, has the same
defect. its original nested ncx declares both parts and publisher history
(`OPS/xhtml/fmatter.html`) as roots beside the title; chapter 15 belongs to
part two. the proposal instead parents both parts under the title heading and
publisher history under chapter 15. chapter 15's previous end is null; its
new `24:0` end includes publisher history at fragment 23. this proves new
containment, not a measured expansion from a known old endpoint.

third-case evidence: `b-reader/row232-navigation-original-review-v1.json`,
sha256 `5ef0767c7c40053b98d5c4dec9b6f56bba7b09a1eec66f35d5c560fd67ecb593`;
independent `c-sources/row232-navigation-original-independent-review.json`,
sha256 `66be276f25b9a8d214ebcb91446506de6aaaca855ffd0f364fa7c5704ef954d8`.
source `74fa6340b64edcb05cd2738993354155f00552d0dcd1b19344cd31bc5a3fa3c9`;
full proposal `9098a147db40c56dd0d37a721e6ca3c95616b5d7b9ba8b8895dc85b471d588e0`,
generation 3. the receipts bind the original opf/ncx, six requested source
documents and complete final proposal. the separately proved one-note
opener/return pair remains valid; it cannot approve this unsafe whole-book
navigation change. no apply or consumer acceptance is claimed.

acceptance: the real-source full proposal preserves appendix sibling ancestry
and chapter 14's authored scope, and keeps chapter eleven a peer of chapter
four with four ending at `43:0`. row232 preserves both part roots, their
authored chapter nesting and publisher history outside chapter 15. retain
genuine source nesting in all cases.
qualify installed hierarchy/extents and reader consumers before applying this
scope. this shared hierarchy fix is outside the bounded repair campaign and is
separate from local title-container clipping.
