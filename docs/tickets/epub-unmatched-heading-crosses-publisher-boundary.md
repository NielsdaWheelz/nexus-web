# an unmatched heading range crosses later publisher divisions

status: open; three whole-book repairs unsafe, none applied
origin: 2026-10-15 book-repair original/retained-source review, operator `150328b65`
area: epub semantic extents

media `895cc902-b1b6-4e69-93ca-30fff2ace5b6` declares epigraph and introduction
as consecutive sibling entries under the book in its original ncx. the source
h2 titles explicitly name those roles. the retained epigraph heading stays a
root with the same label and target, but its proposed end changes from the
introduction boundary `4:0` to book end `43:5636`. a prefatory epigraph becomes
a range over the remaining book.

media `2baa6224-e88b-4c25-a416-074064cde3d2` has the same new range failure.
its unmatched heading for the introduction to *savage messiah* keeps its
identity, target and root parent, but changes `32:0–33:0` to `32:0–39:1181`,
the book end. six later essays each have a distinct title and body; the
retained contents lists all seven separately, and their stored publisher
entries remain peers under the part. the source heading's edition suffix
differs from its publisher label, so it remains unmatched while the six later
headings coalesce. those later publisher children cannot close the unrelated
root under the depth-only rule. their inherited missing extents are separate
from this newly expanded essay range.

media `9edf7d20-68e3-406c-8af3-6b9f1056b262` repeats the failure within notes.
four original documents separately name combray i, combray ii, swann in love,
and place-names: the name, containing 88, 155, 202, and 57 notes respectively.
the unmatched combray i heading changes from `20:0–21:0` to `20:0–23:16787`,
covering all four divisions. the later three publisher sections remain
children of the separate footnotes aggregate. this is false scope for a
specifically named note division, not an objection to a flat outline or to
the aggregate spanning all notes. the 502 note bodies have a separate,
successful original-source proof; that does not authorize the range change.

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

the fixed essay evidence is
`a-maintenance/navigation2baa-essay-scope-review-v1.json`, sha256
`6631926070dac52e3bb9cb6993c243b0ed0011f74c2fa394834384650a1087e9`.
it binds the complete proposal and ten retained documents: contents, part
title, all seven essay documents and final backmatter. source sha256 is
`5d53a9e44f064f217574d6672c00b4b2c33d0f83cfb432ca173cd10664c3e542`.
original ncx was not acquired for this case. independent semantic review:
`c-sources/a2baa-essay-scope-independent-review.json`, sha256
`7e0c12d205530f107cb689ac2873626e64ca5768d2022914511c616abcea0030`.
the full proposal is
`d9c0a0ed042e15c8d462f29b7114d1a6fb0e60f6150ca60ad9a6d957765cf5a3`.
other changed fields remain unadjudicated.

the note-division evidence is
`b-reader/note-division-boundary-review-v1.json`, sha256
`f891dc42b7383debe9183e7bc0b3627d53b2069b28fcfc78ebd2138b80714ada`.
it binds the four original members, exact retained rows and complete proposal.
independent review: `c-sources/9edf-note-division-independent-review.json`,
sha256 `ab68551cee9cbe72ebfea749a15ee67ff0689f08c720e8f4c6e8390ed0b911ae`.
unrelated changed fields remain unadjudicated; no stored-text loss or reader
consumer failure is claimed.

acceptance: the real-source epigraph ends at the introduction's authored
boundary, the first essay ends at the next separately titled essay, and
combray i ends at combray ii; unrelated publisher ancestry cannot hide those
boundaries. also
qualify a genuine multi-document division and installed reader extents before
applying these books. this shared range fix is outside the bounded campaign,
separate from both publisher-root reassignment and title-container clipping.
