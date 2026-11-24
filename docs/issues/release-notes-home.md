# notes home format cut

migration 0348 and authored format 7 require one paired release. old pages keep
their contents and have unknown writing time. the feed before the migrated head
is available through reprovisioning from current state. replica identity and
accepted source counters survive.

1. verify the actual installed wire and select the corresponding source bump
   under the once-per-release rule. build the api/helper, web/worker, firefox
   extension and android pair from the release commit.
2. on the installed pair, drain every writing device. verify local source
   counters against the account's accepted prefixes, empty outboxes and caught-up
   cursors. stop old writers and verify the restorable database backup.
3. migrate and check the selected alembic head, then start the matched release.
   reopen each drained device and verify snapshot completion, retained counters,
   old untimed pages, format refusal and a new writing round trip. release
   verification includes installed firefox and android. see [deployment](../../deployment.md).
4. before real format-7 writes, rollback can restore the verified backup and old
   pair. after writes, preserve new canonical state and outboxes. repair forward
   or explicitly reconcile those writes before any restore.

remove this issue once the paired cut and installed-device checks are recorded.
