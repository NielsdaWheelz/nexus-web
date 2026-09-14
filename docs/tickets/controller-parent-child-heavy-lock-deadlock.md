status: open
origin: 2026-09-14 09:53 utc bounded-workspace verification
area: test-controller / shared heavy lock

read-only `/proc/locks` inspection finds pid 908574 holds
`/tmp/nexus-test-heavy-66b1209622ac4977.lock` while its descendant pytest
915611 waits for the same lock. ancestry is 908574 -> uv 915608 -> pytest
915611; the parent is in `do_wait`, child in `locks_lock_inode_wait`.
both belong to the foreign `nexus-web-db0215-bridge.sii9up/checkout` run.
bounded-workspace client/native/capacity runs are queued behind it.

subsequent read-only inspection on 2026-09-14 confirms both pids have exited
and the shared lock has passed to another controller. the immediate queue
block is cleared; the recursive-acquisition cause remains unverified.

the foreign run's owner must retire its deadlocked command. do not signal it
or remove its lock/resources from this task. inspect its exact selected test
and lock composition, then prevent nested workflow tests from reacquiring an
ancestor's lock through an unowned real-system boundary. the separate
unselected-capability ordering correction does not establish this diagnosis's
exact triggering call.

acceptance: the actual parent/child path completes without recursive lock
waiting, while independent heavy work still serializes; interrupted ownership
is cleaned only by the originating controller.
