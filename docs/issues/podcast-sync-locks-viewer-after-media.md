# podcast sync locks the viewer after episode media

status: open (latent deadlock, not reproduced)
origin: 2026-10-19 libraries + ordering re-slice (review of the Remove from Nexus lock order)
area: podcasts / lectern lock order

problem: the lectern's lock order is viewer, then media (teardown,
`services/media_deletion.py:run_teardown_job`; Remove from Nexus `_remove` since
the re-slice). podcast sync takes them the other way in one transaction:
`services/podcasts/ingest.py:_update` locks each existing episode's media row
(`FOR UPDATE OF m`), then `services/podcasts/sync.py:_auto_queue` locks the
subscriber's users row before `lectern.append_missing_in_txn`.

impact: a sync with auto-queue on, racing the same viewer's Remove from Nexus (or
a teardown) of one of that show's episodes, can deadlock. postgres aborts one
side (40P01): `_remove` retries it; the sync attempt fails and its job retries.
no data is lost; the user may see a slow removal or a delayed auto-queue.

proposed fix: when `auto_queue` is on, take the subscriber's viewer lock first in
the sync's write transaction, before `ingest_episodes`.

resolved when: sync acquires the viewer lock before any media lock, or a harness
race of sync against removal of one of its episodes shows no 40P01.
