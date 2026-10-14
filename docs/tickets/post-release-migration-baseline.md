# migration baseline after release acceptance

status: deferred to the owner's post-release slice
origin: 2026-10-13 release instructions; updated after pr #577
area: migrations / cutover retirement

the owner plans to remove one-time repair/cutover code, replace the migration
chain with one baseline, and drop `model_cutover_archives` after this release
and its ordered repairs. #577 adds `0277`; use the final deployed head rather
than the earlier `0276` scope. deployment-tool reauthoring is a separate later
slice, rehearsed on the devbox before its first live use.

the archive table retains cutover evidence and disposition, not the old
model-call bodies. their full recovery source is the original `0241` backup:
`releases/3ea1b8e6e762963ca3cd2d3c9b367ccbe6287dc9/database.dump`, sha256
`64219d560730162f06019a8a5d1300fe834877349a8ea7bfcc9916941fc18790`.
later `0276` backups do not replace it. retention remains unknown; see
[the retention ticket](backup-retention-policy-unverified.md).

prerequisites: release/device acceptance and required repairs complete; owner
closes the rollback window; retention policy checked and reported before the
archive drop. remove only retired owners after proving their callers gone.

acceptance: one baseline creates the intended final schema; the supported
transition from a restored deployed database preserves retained data; archive
removal and the old-history backup limitation are explicit in the handoff.
