# Test subprocesses received unowned SIGTERMs

**Status:** open
**Origin:** 2026-09-12 deployment session, cleanup canonical run
**Area:** `python/tests/kernel/test_oracle_host_release.py`, test execution control

## What is wrong

Canonical run `e39593aa61570b22`, from checkout head
`7fa89b88c8342bca9edfb46a6d20053c49555fb2` plus the uncommitted process-scope
repair, passed policy, static Python, and policy self-tests, then failed in
`test_host_oracle_reconcile_converges_after_success_before_phase_write[publish-SupportReconciled]`.
The first subprocess intentionally stopped after persisting phase
`SupportReconciled` and one `publish` effect. Its replay began 16 ms after the
first sudo session closed, then exited 106 ms later with `returncode=-15`
before issuing a fake-Docker command. The enclosing systemd test service did
not fail until 15 seconds later.

The journal timestamps were `00:02:21.812819` for the first session closing,
`00:02:21.828528` for replay launch, and `00:02:21.936200` for replay exit.
The now-cleaned receipt
`test-results/runs/e39593aa61570b22/kernel-python-1.log` reported the subprocess
failure at lines 437-449. Its state file was
`/tmp/pytest-of-niels/pytest-714/test_host_oracle_reconcile_con2/fake-oracle-host-state.json`:
phase `SupportReconciled`, `post_effect_interrupts=["publish"]`, one publish
effect invocation, and no replay commands.

Twelve bounded, exact, signal-traced reproductions all passed. None of 2,301
trace files recorded a SIGTERM. That is diagnostic evidence, not a passing
canonical gate, and it does not identify the signal's owner.

The failure recurred in first-attempt main CI run `34666110694` at exact main
SHA `c2ab56d677c74d3da797342252d378a92311a08d`. Run
`e73384873e999003` passed the first six capabilities, then the top-level
`kernel-python` pytest process exited `143` during
`test_host_apply_reconstructs_codex_host_no_restart_privilege_contract`.
Artifact `nexus-test-full-34666110694` records the interruption and every later
capability as `not_run`; its `kernel-python-1.log` lines 419-451 show the
preceding tests passing through 86 percent before the abrupt terminal line.

The test's privileged driver opened its sudo session at
`2026-09-12T02:20:03.949624Z` and closed it at
`2026-09-12T02:20:13.567113Z`. The CI controller observed the interruption by
`02:20:15Z`. The system journal records no OOM, runner cancellation, sibling
runner completion, or systemd unit stop in that interval. The runner service
has no runtime or memory ceiling. Unlike the first occurrence, this SIGTERM
reached the portfolio's top-level pytest group, so the defect is not confined
to the Oracle replay helper.

## Prerequisites

Capture the sender PID, UID, process, and cgroup. Run the signal audit around
the full kernel portfolio, where the unexplained lifecycle interaction now
recurred.

## Proposed fix

Identify the signal owner first. If the evidence proves a repository cleanup
or harness lifecycle can reach an unrelated command, repair that ownership
boundary. If it proves host supervision, isolate the full test command from
that exact owner. Do not add a retry, delay, or ignored signal.

## Acceptance

A deterministic fault reproduces the external termination, the repair removes
it, and the full canonical gate passes on its first attempt under the intended
devbox user context.
