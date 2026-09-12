# Oracle-host replay received an unowned SIGTERM

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

## Prerequisites

Capture the sender PID, UID, process, and cgroup when the failure recurs. Run
the signal audit around the full kernel portfolio, where the unexplained
lifecycle interaction occurred.

## Proposed fix

Identify the external owner first. If the evidence proves delayed PAM, sudo,
or service cleanup can reach the replay, give the injected-crash and replay
harness one explicit isolated lifecycle boundary. Do not add a retry, delay,
or ignored signal.

## Acceptance

A deterministic fault reproduces the external termination, the repair removes
it, and the full canonical gate passes on its first attempt under the intended
devbox user context.
