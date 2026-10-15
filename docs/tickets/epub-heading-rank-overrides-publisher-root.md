# heading rank overrides an authored publisher root

status: open; nine whole-book repairs unsafe, not applied
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
its rank stack across documents. preserve source-proved sibling and division
scope when adding inferred heading ancestry. full toc nodes preserve the
publisher outline; routine sections may group a flat outline when independent
authored division evidence justifies it. root mismatch alone is not a refusal.
verify legitimate inferred subheadings still work; do not reset every hierarchy
at a fragment boundary.

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
fields are unadjudicated. preserving these source-proved peer divisions through
`_assign_parents` addresses both cases.

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

four further sources explicitly end the named literary work before a separate
publisher licensing footer. each original footer is marked `pg-boilerplate`
(one also uses the html `footer` element) and contains a work-end separator
before the license heading. the candidate newly makes that license a child of
the literary-title section and extends the title's reading extent through the
complete footer:

- `a19df1fb-4675-46a7-9b6c-b551a3dabce9`, frankenstein;
- `b09352f1-a394-46ba-a6b4-3e7a546fb291`, mosses from an old manse;
- `ce72f700-7416-44a5-ac80-9a2fb8d23717`, the separately owned frankenstein;
- `fbc9bf7f-b48a-4b53-b14e-e6fff10f1934`, paradise lost.

the work-end declaration and separate footer role establish false new literary
containment; flat publisher roots only corroborate it. license destinations
and stored text survive. exact eight source documents, five source outlines
and four complete proposals are bound by
`c-sources/navigation-four-license-boundary-review-v1.json`, sha256
`d365bd7dd6f0e539c7b912e0d8980500da4b642438849cdfd712cefd85e6faea`,
and `a-maintenance/four-license-boundaries-independent-review.json`, sha256
`c586e02c249eb3287a257bd648c711eae3c57211f41352977eac00288e438b13`.
ce72's original bytes were verified from its existing rehearsal copy; present
production-source availability was not rechecked. this navigation refusal
does not supersede its independently qualified credit correction or ownership.

media `781fc83c-3804-4611-9a7a-b475dbacebdf` has the same explicit
work-end/footer boundary. the original names the literary work in its end
separator before `pg-footer-heading` within `pg-boilerplate`. the candidate
newly parents the license under that work and moves the work end from `2:0`
to `40:38481`, the license end. source role and the named end declaration
establish the contradiction; the separately proved two notes do not approve
this whole proposal. evidence:
`b-reader/three-navigation-boundary-review-v3/781fc83c-3804-4611-9a7a-b475dbacebdf.json`,
sha256 `a0d2ee245142e9efed1649c9d27a27146d48b75fde91a367fb4fb2720751bd05`;
independent `a-maintenance/two-b-navigation-boundaries-independent-review.json`,
sha256 `1d080de77eb5ea87f1a6c0318ac8ae33af6c63e06240f2acd8c73b7495f30822`.
both bind the exact original documents and complete proposed metadata.

media `eef19922-06e4-4d10-bd49-2445057bf4c1` provides a separate concrete
scope contradiction. its original appendix explicitly describes a dramatis
personae across both *dust of dreams* and *the crippled god*. the candidate
newly parents this shared reference list under the last part's title, `YOUR
PRIVATE SHORE`, extending that division from `53:0` through the appendix to
`63:0`. the appendix's h3 styling does not authorize narrowing its declared
cross-book role to that part. this does not reject the part's own chapter
grouping merely because the publisher outline is flat.

exact appendix declaration and complete proposal:
`c-sources/navigation-ra-eef-scope-review-v1.json`, sha256
`b4a100fe5ac91d0a3ff056bc281ba9c16dffceecd859e330b195c4e36dffbb0b`;
independent `a-maintenance/ra-eef-scopes-independent-review.json`, sha256
`3fc1e47c5f65330b4df0313b8337086d7249a8e4e8c9bfe546ec147b00e7b3ce`.
other proposed fields are unadjudicated; text and appendix destination remain
intact, with no runtime consumer failure executed.

acceptance: the real-source full proposal preserves appendix sibling ancestry
and chapter 14's authored scope, and keeps chapter eleven a peer of chapter
four with four ending at `43:0`. row232 preserves publisher history outside
chapter 15 and source-proved part/chapter membership; independently justify
any reading-division regrouping without changing its full publisher outline.
the five literary-title extents exclude the separately declared licensing
footers while preserving their destinations. retain genuine source nesting
in all cases, and keep eef's cross-book reference appendix outside the last
part's scope; do not infer a universal flat-outline rule.
qualify installed hierarchy/extents and reader consumers before applying this
scope. this shared hierarchy fix is outside the bounded repair campaign and is
separate from local title-container clipping.
