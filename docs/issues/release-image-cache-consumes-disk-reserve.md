# production image cache lacks bounded retention

open deployment/storage follow-up. accumulated immutable runtime images can
consume the release disk reserve; there is no bounded cache-retention owner.
`deploy/hetzner/release.py:1045–1047` correctly checks free space after pulls and
refuses before stopping writers. the guard is not a retention policy.

the first e505 attempt refused with 802,902,016 bytes free, below the unchanged
2,147,483,648-byte floor. writers, schema and current runtime remained untouched.
explicit nonforced removal of 23 obsolete, unreferenced owned api/worker/postgres
images restored 15,274,299,392 bytes free. every container and its image, the
three selected candidate images, volumes and backups were preserved. the same
canonical continuation completed and e505 activated normally. exact failed
attempt and cleanup receipts remain under the existing e505 release owner;
successful manual recovery does not close the missing-retention contract.

this recurs after earlier selective manual recovery; neither successful cleanup
nor a later release establishes automatic retention. define bounded immutable
image retention at the existing release owner, preserving running/stopped
container references, selected candidates and explicit recovery needs. no global
prune, forced removal, volume, backup or credential-state deletion.

resolve when consecutive ordinary releases preserve the post-pull reserve and
those references through the enforced retention policy, with exact owned cleanup
provenance. no controller or policy change is selected during this recovery.
