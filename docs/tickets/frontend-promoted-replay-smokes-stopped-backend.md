# frontend-promoted replay smokes a stopped backend

status: open · origin: 2026-09-15, forward-recovery independent review · area: release recovery

## evidence

the prepared forward-qualification change lets `_finalize_once` refresh stale
capacity evidence through `_activate_backend`. a transient refusal stops the
candidate writers and retains `FrontendPromoted`. however, `deploy.sh` skips
`apply` in that phase and runs public auth smoke before `finalize`. replay can
therefore permanently fail auth smoke against the stopped api before the owner
can restart it. the post-`set_current`, pre-`Succeeded` window is also affected.

this is a source-review finding, not an executed production failure. the user
requested a clean handoff before another validation or deployment cycle.

## next action and acceptance

resolve before merging the prepared forward fix. let owned `apply` reactivate
and prove an existing `FrontendPromoted` candidate without regressing its phase,
then invoke it before auth smoke. review current-record identity guards for the
post-publication window. retain auth smoke before final publication; do not
move `finalize` earlier to bypass it.

prove normal activation and resumed promotion ordering with a small deterministic
regression through `./scripts/test`. preserve exact candidate/config bindings,
immutable failed evidence, stopped-writer cleanup, and the no-use window. do not
reintroduce release simulation machinery.
