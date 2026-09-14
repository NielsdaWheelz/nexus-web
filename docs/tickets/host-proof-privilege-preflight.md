# Host proof privilege is discovered mid-gate

status: open  
origin: 2026-09-14, PR #243 release session  
area: test control

## Issue

`./scripts/test changed python/nexus_test_control/runtime.py
python/tests/kernel/nexus_test_control/test_runtime.py` reached receipt
`03d0bc7ac52c6447`, then failed after 539 passing tests because
`python/tests/testkit/host_oracle_reconcile.py:69-78` invoked `sudo chown`.
The caller had `NoNewPrivs: 1`, so sudo returned: `The "no new privileges" flag
is set`. The self-hosted GitHub runner has `NoNewPrivs: 0`; the controller does
not currently qualify that required host-proof boundary before work starts.

## Prerequisite and proposed fix

Keep the real uid/gid and mode oracle; do not substitute writable user-owned
files. Define the host-release proof's privilege requirement in the typed
capability contract. Have `doctor` and workflow admission either select a
qualified self-hosted runner or return `not_run` before the portfolio starts.

## Acceptance

- privilege availability is checked before any selected host-release proof;
- an unqualified caller exits `not_run` with the exact missing prerequisite;
- the qualified self-hosted lane still proves real root ownership and modes;
- no production ownership assertion or sensitivity proof is weakened.
