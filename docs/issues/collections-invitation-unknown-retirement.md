# fresh pending invitations can erase an unsettled answer

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src, native paths under apps/android/app/src/main/java/app/nexus/android.

problem and impact: fresh pending invitations can erase an unsettled answer.

evidence: components/libraries/LibraryInvitations.tsx:51 clears unknown solely on list.fresh. :64 creates unknown after outcomeUnknown; :67-68 increments answered for a new GET. useServerList.ts:454 fresh proves only live source + matching stale key. python/nexus/services/library_members.py:295-314 performs an ordinary pending SELECT; :326-374 response transaction has no ordering fence with that read.

counterexample: original accept/decline POST remains in flight after timeout. a subsequent GET reads the still-pending MVCC state, matches the new stale key and clears Hold. the original later commits. idempotent same-answer replay is safe but no replay owner remains.

smallest truthful fix: retain exact invitation id + answer while outcome is unknown; a still-pending read is not settlement. retire on acknowledgement or typed desired-state/permanent-fence proof. no new storage/protocol required.

resolved when: a fresh still-pending snapshot retains the original unknown; same-answer deliberate retry stays exact. no runtime induced; source-established concurrency counterexample.

verification: source only; no lab run. root owns repository records and implementation.
