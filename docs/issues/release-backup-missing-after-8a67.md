# no release backup exists after 8a67e218a, though d6f04890c is recorded as deployed

status: open · origin: 2026-10-20 migration rehearsal · area: release / backup

`docs/issues/release-reader-connections.md:7` records that `d6f04890c` (schema
0297, wire 12) went to production on 2026-10-19. `deploy/hetzner/release.py`
backs up the database to `releases/<sha>/database.dump` before it migrates. r2
holds no such object for any main commit after `8a67e218a` (0292, written
2026-10-18 00:09 utc).

so either:
- no backend release ran after `8a67e218a`, and production is still at 0292
  (the 10-19 deploy was web-only, or the record is wrong); or
- production migrated 0292 → 0297 with no pre-migration backup in the bucket.
  0293–0297 are irreversible; the only rollback would be the 0292 backup plus
  whatever was written since.

impact: in the second case, rollback loses a day of writes, and no backup at
0293 or later exists to rehearse 0298–0303 on (the register requires one; the
`model_cutover_archives` drop waits on it).

evidence (read-only, 2026-10-20): a full list of `releases/` (50 keys, not
truncated), the bucket root (`maintenance/`, `releases/`), `maintenance/`
(newest 2026-10-17), and HEADs of `releases/<sha>/database.dump` for all 39
first-parent main commits after `8a67e218a`: every one 404.
receipts: `nexus-web-campaign-artifacts/2026-10-14/rehearsal/r20261020-no-newer-backup/`.

step (owner, touches production): read production's `alembic current` and
`/var/lib/nexus/releases/current`; if past 0292, find where that release's
backup went (`/var/backups/nexus/r2`, the release log) and why it is not in r2.

resolved when: production's revision is recorded here, and either a release
backup at that revision is in r2 or the gap is explained and closed in
`release.py`.
