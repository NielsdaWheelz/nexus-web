# fresh member lists can erase an unsettled command

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src, native paths under apps/android/app/src/main/java/app/nexus/android.

problem and impact: fresh member lists can erase an unsettled command.

evidence: components/libraries/LibraryMembers.tsx:89-90 settles unknown when members.fresh && invitations.fresh, without checking command or desired state. :100 creates unknown after modeled sent uncertainty, retaining only attempt. python/nexus/services/library_members.py:77-94 list_members and :268-289 invitations perform ordinary SELECTs; no barrier orders them after the unknown transaction.

counterexample: a role-change POST times out before commit. both fresh GETs read the old role and pending invitations. Hold is removed; original later commits. member list freshness and idempotence of a later action cannot prove original settlement.

smallest truthful fix: retain the exact member command and evaluate its actual desired-state or permanent fence; opposite-state fresh snapshots retain uncertainty. preserve explicit retry identity.

resolved when: fresh opposite role/invitation snapshots retain the unknown and exact callback; an actual acknowledgement/desired-state proof retires it. no runtime induced; source-established concurrency counterexample.

verification: source only; no lab run. root owns repository records and implementation.
