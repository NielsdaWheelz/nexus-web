# host oracle fixture ownership blocks local confidence

- status: open
- origin: 2026-09-14 annotation focus/submit verification; candidate `eb0f408c44`
- area: test control / host release fixtures

`./scripts/test confidence` stopped after 1,121 python passes at
`tests/kernel/test_oracle_host_release.py::test_host_oracle_reconcile_replays_every_durable_phase_after_sigkill[Prepared]`.
fixture setup at `python/tests/testkit/host_oracle_reconcile.py:74` runs
`sudo --non-interactive chown 0:0 -- ...` over its temporary release inputs;
the command exited 1. captured stderr is absent from the failure report, so the
underlying sudo error is unknown. later workflow capabilities were blocked.

evidence: `test-results/runs/d4ff867aa306ba96/summary.json` and
`test-results/runs/d4ff867aa306ba96/kernel-python-1.log:437`.
the annotation browser proofs and all static checks passed independently.

prerequisite: decide the approved privilege boundary for this local host fixture.
fix its ownership setup or route the privileged proof to its explicit capability;
surface the captured command stderr when setup fails. preserve the root-ownership
invariant. related routing work: [gate budget](ci-gate-time-budget.md).

acceptance: the fixture executes through `./scripts/test` in its declared local
environment, routine confidence has no hidden sudo prerequisite, and setup errors
include the actionable stderr.
