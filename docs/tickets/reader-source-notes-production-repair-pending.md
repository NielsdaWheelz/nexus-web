# production reader corpus repairs are owner-deferred

status: owner-deferred postrelease; complete read-only census, no apply
origin: 2026-09-27 pr #398 acceptance; 2026-10-14 r3 disposition
area: reader / production repair

the complete production read-only census at released `58c7ecae6`, schema 0277,
selected 499 publications: 494 successful inspections and five real failures.
232 successful inspections propose changes; proposed apparatus removals are
zero. NO APPLY was submitted. the aggregate is failed input, invalid for apply;
current navigation/note metadata remains unrepaired. the owner explicitly
deferred remaining book navigation, note and contributor repairs from the
usable release. deferral does not convert failures into passes.

four failures are [parse-time refusals](reader-repair-epub-parse-budget.md);
one is [existing apparatus correspondence](reader-repair-existing-apparatus-correspondence.md).
the 30-second import setting's applicability to offline maintenance is
unestablished. draft #584 and local performance work remain isolated, with
only their recorded source/helper proofs; neither is a deployed corpus repair.

evidence: `release/attempts/58c7ecae6/r3-full-inspection-v2/`, manifest
`8ef9c4048ebd396e0d2055afec86295ca9ac0cb68e76f6f7c766599efcc2eb49`;
terminal reconciliation
`bc5bed119f2ec00f285129b560a56d597de8992d5b6cfd7f38ac4aded1389bf1`.
the owned inspection container exited 2 without oom/restarts and was removed.
original successful proposals and all failures remain preserved together.

historical schema-0245 clone proof applied 233 repairs excluding row 232 and
preserved fragment/highlight/cursor facts. that older rehearsal is not evidence
of current production publication or a valid apply of this failed 499-item input.
its receipt remains `/tmp/nexus-chapter-rehearsal.nx22kQ/source-notes-0245/corpus-receipts.json`.

next: review a bounded maintenance process and budget; rehearse the exact
candidate on a verified restored copy. obtain a fresh valid inspection for an
explicitly reviewed scope, generation and source identity. preserve fragment
bytes, publication/saved coordinates, highlights, cursors and all historical
apparatus identities; refuse any proposed apparatus item/edge deletion.

acceptance: separately reviewed fenced apply, unchanged reinspection and
protected-state comparison for every selected repair, or an explicit unresolved
disposition. no fabricated aggregate from failed or partial inputs. contributor
scope is tracked [separately](epub-contributors-production-repair-pending.md).
