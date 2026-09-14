# unsaved hosted reader cursors lose their owner on teardown

- status: open
- origin: 2026-09-13 reader-save investigation; revision `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: hosted reader progress durability

## evidence

`apps/web/src/lib/reader/useReaderProgress.ts:191-196` retains pending cursor
state only in the mounted reducer. `readerProgress.ts:292-301` correctly retains
a failed save there, but lifecycle flush returns immediately when any save is
in flight (`useReaderProgress.ts:583-585`). teardown flushes, increments the
generation, and drops the owner (`:651-655`); completion from that generation
is then ignored (`:272-274,305-307`). a newer locator queued behind the in-flight
write can therefore be lost even when the older write succeeds. a failed
keepalive at teardown likewise has no surviving retry owner.

deployed revision `7e8fd48244b3b436965037738e05785bb4931be1` has the same behavior
at hook `:122-124,185-186,208-210,472-474,523-527`. the reported cursor `502`
failures make this loss window relevant, but do not prove that a particular
position was lost or that reader saving caused the workspace crash.

## prerequisites and fix

define the hosted reader's acknowledged-versus-locally-retained durability
contract. retain the latest account/media/content-generation-bound cursor and
its base revision before relinquishing the renderer; replay through the
existing compare-and-swap/conflict contract after restoration. a page unload
keepalive is an optimization, not the sole durability mechanism. avoid silently
overwriting a newer position from another reader.

## acceptance

through `./scripts/test`, move again while a save is pending, tear down the
reader, and restore it after both successful and failed transport completions.
the latest position remains recoverable; ambiguous commits reconcile;
cross-reader conflicts remain explicit. verify account and document-generation
isolation and demonstrate failure against the current implementation.
