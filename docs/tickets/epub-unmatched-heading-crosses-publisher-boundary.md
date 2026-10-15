# an unmatched heading range crosses later publisher divisions

status: open; whole-book repair unsafe, not applied
origin: 2026-10-15 book-repair original-source review, operator `150328b65`
area: epub semantic extents

media `895cc902-b1b6-4e69-93ca-30fff2ace5b6` declares epigraph and introduction
as consecutive sibling entries under the book in its original ncx. the source
h2 titles explicitly name those roles. the retained epigraph heading stays a
root with the same label and target, but its proposed end changes from the
introduction boundary `4:0` to book end `43:5636`. a prefatory epigraph becomes
a range over the remaining book.

`python/nexus/services/epub_structure.py:276` coalesces matching later
headings into their publisher sections; the unmatched epigraph heading stays
separate. `reader_structure.py:100` defaults each natural end to book end;
lines 104–106 close ranges only when the next group has equal or lower
ancestry depth. later publisher divisions are children of a different root,
so they do not close this unmatched root. no new parent assignment is needed
to produce the failure.

resolve boundaries through actual ancestry and authored division meaning,
not depth alone: the introduction is not a descendant of the epigraph heading.
do not reparent the epigraph merely to accommodate the depth heuristic.
preserve legitimate ranges spanning source documents; clipping every heading
to its local fragment would introduce a different defect.

private evidence: `c-sources/navigation-two-original-boundary-review-v1.json`,
sha256 `b6c8e71e90e5bcb1360c1908b918218e97e0e3e82a9c1442a0cc721ebcca2dca`;
independent review `a-maintenance/c-two-original-boundary-independent-review.json`,
sha256 `072f169f882de3e22de3c3e55feb5737f0120630291a169695b750950d85e0a4`.
source `1bf23af87f71ff62e5ef28b43d5f9a994854ceedcc16bfe700f6851eacd3fc2f`;
full proposal `d5b298d401327679b01851fa8c63b3997127afd3ca4616fb9e7dfcef2ea0e359`.
the receipts bind original roles/navigation, retained text and the complete
current proposal. remaining fields are not approved. stored text is intact;
apply and reader consumers were not executed.

acceptance: the real-source epigraph ends at the introduction's authored
boundary; unrelated publisher ancestry cannot hide that boundary. also
qualify a genuine multi-document division and installed reader extents before
applying this book. this shared range fix is outside the bounded campaign,
separate from both publisher-root reassignment and title-container clipping.
