# suggestion feeds of former library admins linger

status: open (residue of a fixed defect)
origin: 2026-10-19 libraries + ordering re-slice (spec L5, owner ruling Q13: no migration)
area: suggestions / sharing

problem: before the re-slice, demotion, removal and leaving deleted nothing
(`services/library_members.py:set_member_role`, `remove_member`); only library
deletion deleted a library's feeds. a former admin's feed and its publication
stayed; reads refuse them (`suggestion_surface` requires admin). the fix deletes
the member's feed in the same transaction; feeds left earlier stay.

impact: harmless rows (no read serves them; a queued job for one finishes
superseded once the feed is gone).

evidence: census C6 on `c3rh-pg` (8a67e218a backup, 2026-10-19,
`nexus-web-campaign-artifacts/2026-10-18/libs2/census/residue-c3rh-20261019.txt`):
2 feeds (1 lectern, 1 default library), `without_admin` 0, no publication of a
feed without admin.

resolved when: C6 `without_admin` is 0 on the backup taken for the release that
ships the fix (then delete this file), or the owner approves a cleanup.
