# verify backup retention before deleting cutover receipts

status: open
origin: 2026-10-13 production release; read-only bucket lifecycle inspection
area: backup / later migration squash

`model_cutover_archives` stores the reviewed census, row hashes and disposition;
it does not contain the full original model-call history. at `3ea1b8e6e`,
`python/nexus/model_cutover_archive.py` serializes `ReviewedModelCutover` into
`reviewed_manifest`, and migration 0246 deletes the original history rows.
the complete old records therefore live in the pre-release backup immediately
after the cutover. the later squash removes the in-database cutover receipt.

the verified backup credentials can read and write backup objects, but `GetBucketLifecycleConfiguration`
returned `AccessDenied` on 2026-10-13. this does not establish whether a lifecycle
expiration policy exists. private receipt:
`/tmp/nexus-release-20261013/backup-retention.json`.

before dropping that table, use an account with bucket-configuration read
permission to inspect lifecycle expiration and any bucket retention policy.
report the applicable retention to the owner; preserve the reviewed backup
through the agreed recovery window. no archive rows are deleted by this release.

acceptance: record the effective policy for the exact release backup key, and
the owner's informed disposition, before the later squash drops the archives.
