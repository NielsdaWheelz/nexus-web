# failed published release cannot converge its successor

status: open · origin: 2026-09-15, restoration forward-recovery review · area: release recovery

## evidence

`deploy/hetzner/release.py:_finalize_once` creates the immutable record and sets
`current` before completing the attempt as `Succeeded`. a crash can leave the
current candidate in `FrontendPromoted`. if its resumed backend/public checks
then fail permanently, `_record_permanent_failure` settles
that same attempt to `ForwardFixRequired` without undoing the published record.

the next fresh candidate reaches `_converge_resource_limits`, which rejects
any current attempt that is not exactly `Succeeded`. it therefore cannot enter
the otherwise supported stopped-writer forward-fix path. this is a source-proven
limitation in `06677a684ba7e30bab987319d11e5dd45537ac37`, not the observed 066
failure: that failure left the succeeded a1 predecessor as current.

## next action and acceptance

after the current restoration, reconcile the convergence owner's identity
authority with committed publication and forward-fix state. preserve exact
immutable current-record and infrastructure bindings, stopped writers, and
the prohibition on restarting failed code. do not manufacture a succeeded
attempt.

accept when a failed published-prefix candidate permits its fresh successor's
owned preflight while invalid record/attempt combinations remain refused.
manually verify the affected recovery path; do not recreate a release harness.
