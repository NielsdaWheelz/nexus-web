# row 232 needs source and consumer reconciliation

status: deferred; whole navigation proposal unsafe and unapplied
origin: 2026-09-27 pr #398 restored-clone source-note review
area: epub apparatus / historical repair

the historical clone of media `09f34c39-5c2c-481a-a713-9d83f7bbf320` had
reciprocal superscript markers. the reviewed correction proposed removing false target
`epub:8:target:fn1_1` and its edge after dependent checks. a second historical
item, `epub:8:ref:000001:fn1_1`, represents the authored return marker rather
than a note opener. pr #398 preserved it through
`reader_navigation_repair._verified_0245_legacy_backlink`, so that proposed
reader map could expose a misleading unavailable note. the 0245 clone
excluded this one publication from its 233 applied repairs. source sha256 is
`74fa6340b64edcb05cd2738993354155f00552d0dcd1b19344cd31bc5a3fa3c9`;
private inspection: `/tmp/nexus-chapter-rehearsal.nx22kQ/source-notes-0245/focus-232.json`.

2026-10-14 restored-clone evidence supersedes the current-membership premise:
generation 3 contains two items and one edge; both historical false identities
above are absent. the ordinary candidate proposes changes without removing
identities, and its before rows match the complete installed membership.
private receipt: `book-repair/b-reader/row232-item-before-v1/reviewed-receipt.json`
under the campaign root; snapshot sha256
`88cf0edd7940c692834e81f7a50c943d2557cc97c3e4120c758ce29c24010458`.
database `nexus:7696659211119792166`, operator source `2e4328dd3`.
the exact original `OPS/xhtml/chapter002.html` pair establishes one authored
note, its opener and return marker. the proposed 78-character body equals the
source paragraph at its preserved start; both named anchors match the retained
locators. no item or edge identity is added or removed. the historical count
of two substantive notes is not supported by this source evidence. this is
a proof of the reviewed pair, not a whole-book note census.

private source receipt: `b-reader/row232-anchor-source-v1/reviewed-receipt.json`,
sha256 `181909d86710e4f1ddbaf38d50c2609e8bd861a530981d00bc51623a8c5ff2bb`;
independent review `a-maintenance/row232-source-review.json`, sha256
`9941625c0547d15a4f26d6b2e0485d5001b0f0723f464b18216f8d1a7c6a59b3`.
the read-only probe and its database backend are reconciled as stopped.

the [new campaign](../book-repair-plan.md) removes the dataset-specific
exception and permits no existing item/edge deletions. historical deletion
approval is not carried into this campaign.

current whole-proposal review found three source-proved reading-division
containment contradictions. the proved note pair does not make that navigation
proposal safe. this is one of the 40 deferred navigation cases, outside the
current 168-repair campaign. evidence:
`b-reader/row232-navigation-original-review-v1.json`, sha256
`5ef0767c7c40053b98d5c4dec9b6f56bba7b09a1eec66f35d5c560fd67ecb593`;
independent source review
`66be276f25b9a8d214ebcb91446506de6aaaca855ffd0f364fa7c5704ef954d8`.
the shared cause is tracked in
[heading rank and publisher scope](epub-heading-rank-overrides-publisher-root.md).

next, separately: correct the shared cause, source-verify the complete proposal,
then rehearse fenced apply, unchanged reinspection and note open/return. a
source-proved no-change outcome also closes the deferred repair disposition;
it cannot waive the misleading-note product obligation below. do not recreate
a dataset-specific compatibility branch.

acceptance: source evidence establishes the expected authored notes and return
markers; every proved note opens from its actual marker after an idempotent
repair. no false note remains, and source bytes, fragments,
saved positions and unrelated apparatus identities match baseline. the planned
removal of one-off code alone does not meet that product acceptance.
