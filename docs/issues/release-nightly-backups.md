# release nightly backups

the next release installs and enables `nexus-nightly-backup.timer`, hands
`/var/backups/nexus/r2` to the backup one-off (uid 10001), and prunes after its
own backup. that first prune deletes nothing: `releases/99320b630…` is the only
other archive, and the rule keeps the newest week-old one. `99320b630` and its
receipt go at the first prune after the next release's own archive turns seven
days old.

after that release, on the host:

- `sudo systemd-analyze verify /etc/systemd/system/nexus-nightly-backup.service
  /etc/systemd/system/nexus-nightly-backup.timer` is clean and
  `systemctl list-timers nexus-nightly-backup.timer` shows the next 03:30 utc run.
- the first nightly's journal ends in verified evidence for
  `nightly/<date>/database.dump`. it is the first backup one-off (512 mib cap)
  and `pg_dump` to run beside all seven live services; no qualification covers
  that working set, so check it for memory pressure.
- `release.py --check` reports that archive and passes.
- optional: the receipts of the archives deleted by hand on 2026-10-22 stay
  under `/var/backups/nexus/r2/<sha>/`. remove those whose
  `releases/<sha>/database.dump` no longer exists.

the util-linux `flock`, the systemd units and r2 deletion have run only against
stand-ins. the backup credentials first delete at the first prune that expires
an archive, about a week after the release.

resolved when a nightly or release prune has deleted an expired archive with its
manifest and receipt, and the bucket holds what the rule keeps.
