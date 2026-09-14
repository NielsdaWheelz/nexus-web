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

the highlight popup pre-merge run `3437f4f57bad1930` reproduced the same
fixture-setup failure after 1,141 python passes on candidate
`91feee8a2c1ecf8047905220f11c40fe1c619e44`; see its
`kernel-python-1.log:434` and `summary.json`. all policy and static checks
passed. the affected CI workflow passed separately in run `2cbe5aecbc24dbf6`
(GitHub Actions `34803311960`), including both affected browser journeys.

the publication-date run `7e86b9532862af76` reproduced this setup failure after
1,121 python passes on `e12fb92074afe8706aaf95c0233404c687c54da4`, against
feature base `7fa89b88c8342bca9edfb46a6d20053c49555fb2`. see
`test-results/runs/7e86b9532862af76/kernel-python-1.log:441` and its
`summary.json`. policy and every static capability passed; later confidence
capabilities were blocked. focused metadata service/browser proofs and four
targeted fault checks passed independently.

prerequisite: decide the approved privilege boundary for this local host fixture.
fix its ownership setup or route the privileged proof to its explicit capability;
surface the captured command stderr when setup fails. preserve the root-ownership
invariant. related routing work: [gate budget](ci-gate-time-budget.md).

acceptance: the fixture executes through `./scripts/test` in its declared local
environment, routine confidence has no hidden sudo prerequisite, and setup errors
include the actionable stderr.
