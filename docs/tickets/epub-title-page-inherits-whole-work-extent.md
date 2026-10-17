# a title-page division inherits the whole work's extent

status: open; two whole-book repairs unsafe, neither applied
origin: 2026-10-15 book-repair original-source review, operator `150328b65`
area: epub coincident section boundaries

media `868bf466-0862-4770-a46b-bd398a23a718` has separate sections for
the work title and the publisher's `Title Page`, both at `2:0`. the original
ncx explicitly names the latter. its complete source document contains only
the work-title h1 and author h2; the opf declares a different document as the
text start. the candidate keeps the title-page identity and label but expands
its end from `3:0` to the book's eof at `41:18545`, through contents and narrative.

media `bfbce747-c3be-4652-b9e3-722dc04d13a2` has the same role collision.
the original ncx calls its `2:0` destination `Title Page`; that document holds
the work title, translator/introduction/notes credit and publisher image.
the separately named page and the coincident work-title heading both expand
from `3:0` to `7:0`, across contents, introduction, translator's note and maps.
the exact maps document contains its heading and three image blocks. an
edition heading might govern broader material; it cannot give the source-named
title page that broader scope. the unchanged ncx is corroboration of the page
role, not a requirement that the section hierarchy copy a flat outline.

the work-title division may legitimately span the book. it does not follow
that a separately named title page at the same coordinate has the same scope.
`python/nexus/services/reader_structure.py:103–107` gives coincident roots the
same natural end; no source container or qualified title-page boundary then
limits this publisher row. this is not a claim that every page should end at
a file boundary or that all flat publisher roots must remain section roots.

exact original page/opf/ncx and complete proposal are bound by
`c-sources/navigation-ra-eef-scope-review-v1.json`, sha256
`b4a100fe5ac91d0a3ff056bc281ba9c16dffceecd859e330b195c4e36dffbb0b`;
independent review `a-maintenance/ra-eef-scopes-independent-review.json`,
sha256 `3fc1e47c5f65330b4df0313b8337086d7249a8e4e8c9bfe546ec147b00e7b3ce`.
stored text and destinations remain intact. other changed fields are
unadjudicated; no api/browser/device behavior was executed.

the second case is bound by
`b-reader/two-title-scope-source-review-v2/receipt.json`, sha256
`c678a786a6bd54b617a369b705b5b6e788ae1e4bcf3eba3e1e9600804526e0bc`;
independent review `c-sources/two-title-scopes-independent-review.json`, sha256
`c2d54e8e3cd73ad247a05dce9245e9260acb16166cb5287cd8ce1fb2ef53875a`.
source sha256 is
`ae32fbcd52033e9e5e7be68c24c86e3eaf39023dc98ba95d005022876ba1efbc`;
complete proposal sha256 is
`355731caa695860ae6cea2ecfbb412cd278557a0c284e4676e5e4b57d8028b38`.
its 19 note bodies have a separate source proof; unrelated fields remain
unadjudicated. the same receipt's `33138ad0` case is source-unproved and is
recorded separately, not counted as this defect.

resolve each section's semantic ownership before assigning a shared endpoint.
preserve the proven title-page scope while independently resolving the work
division. do not add a global label blacklist, infer every file as a division,
or fabricate an endpoint where source ownership is unknown.

acceptance: both full proposals keep the title page at its authored page scope
and handle the independent work title correctly. verify coincident sections
with different roles and genuine equal-scope duplicates, then qualify complete
installed extents before applying these books. the shared range-owner repair is
outside the bounded campaign.
