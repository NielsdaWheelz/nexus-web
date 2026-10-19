# lectern rows of media removed before the fix linger

status: open (residue of a fixed defect)
origin: 2026-10-19 libraries + ordering re-slice (spec L2, owner ruling Q13: no migration)
area: lectern / media deletion

problem: before the re-slice, Remove from Nexus deleted a media's entries and
grant paths (and tombstoned a system-library path) but never the viewer's lectern
row (`services/media_deletion.py:_remove`). the row turned hidden, kept its slot,
counted toward the 2,000 cap with no ui to remove it, and came back at its old
place if the media was filed again. the fix removes the row on every new removal;
rows left by earlier removals stay.

impact: a viewer near the cap loses slots they cannot see; a re-saved media
reappears mid-lectern instead of being absent.

evidence: census C4 on `c3rh-pg` (8a67e218a backup, 2026-10-19,
`nexus-web-campaign-artifacts/2026-10-18/libs2/census/residue-c3rh-20261019.txt`):
1 user, 14 lectern rows, `tombstoned_rows` 0, `teardown_rows` 0, no non-dense
lectern. rows hidden by a removal without a tombstone cannot be told from rows
hidden by lost access (which must keep their slot), so the census bounds only the
tombstoned share.

resolved when: C4 `tombstoned_rows` is 0 on the backup taken for the release that
ships the fix (then delete this file), or the owner approves a cleanup migration
for a nonzero count.
