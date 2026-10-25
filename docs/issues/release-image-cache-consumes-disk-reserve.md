# release image cache consumes the disk reserve

status: open
origin: 2026-10-14 x-title corrective release, pr 611
area: deployment / host storage

`3a80349b8` passed the 2-gib preflight floor, then image pulls left
1,460,740,096 bytes free at `23:36:11Z`. the controller completed with healthy
services; its preflight does not establish the post-pull reserve. accumulated
unreferenced application images consume that reserve. no volume, backup or
credential-state deletion is authorized by this finding.

define bounded retention of immutable application images at the release owner,
preserving every running/stopped container reference and recovery requirements.
measure the reserve after pulls and before handoff; refuse or perform the
explicitly owned cleanup before accepting the release. use no global prune.

acceptance: consecutive real releases retain at least 2,147,483,648 free bytes
after pulls, preserve referenced images and durable volumes, and record exact
cleanup/provenance. this release's selective manual cleanup is not that contract.

2026-10-17: `deploy/hetzner/release.py:689–694` now checks the same 2-gib
reserve after both image pulls and refuses before stopping writers. the
retained wire-10 handback reports successful canonical s3 deployment;
the [raw evidence was not retained](wire10-qualification-evidence-not-retained.md).
bounded image retention and consecutive-release qualification remain open.
manual selective cleanup does not establish a retention policy.

2026-10-25: frozen search candidate `3d81ef45e` correctly refuses after image
pulls leave1,618,907,136 bytes free, before writer shutdown, backup or migration.
nonforced removal of24 obsolete owned api/worker image references, after checking
all container references and recovery images, restores16,644,030,464 free bytes.
the unchanged release owner then completes; postdeployment free space is
14,458,458,112 bytes. referenced images, volumes and backups remain intact.
the2-gib gate remains unchanged. this successful manual recovery does not
establish a bounded cache-retention policy.
