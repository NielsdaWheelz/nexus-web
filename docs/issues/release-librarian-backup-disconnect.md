# librarian release: ssh loss during backup

`deploy/hetzner/release.py:1211` holds the backup lock in an ssh session, while
its remote compose child can survive disconnection. an unlocked host therefore
does not prove an earlier backup has ended; a blind retry can overlap it.

the release of `9b435d881b371d6bc5f7323bfe60c5e322ff3834` lost ssh during
backup with `no route to host` / `broken pipe`. inspection at
`2026-11-12T23:02Z` found `nexus-backup-run-9d63006cb56d` and its `pg_dump`
still running after the lock had disappeared. the host had not restarted and
neither container nor kernel reported an oom.

the operator waited for normal exit 0 and automatic removal at `23:03:12Z`,
verified retirement of the remote owners, then retried the canonical release.
it reused the verified receipt and completed deployment. no backup was killed,
overlapped or replaced; the immediate release is resolved.

make the lock cover the actual backup lifetime, or make canonical recovery
reconcile its surviving owner before another attempt. resolved when a deliberate
ssh disconnect cannot admit overlapping backup work and ordinary retry still
verifies the completed receipt. controller repair is outside librarian latency.
