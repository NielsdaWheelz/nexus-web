# deployment entrypoint cannot pass the reviewed model census

status: open · origin: 2026-10-02 cleanup operations audit · area: deployment / migration 0246

## problem and evidence

`deploy/hetzner/deploy.sh:25` accepts exactly one argument and line 105 invokes
`release.py` with only the source sha. `release.py:610,624-626` requires a
reviewed `--model-cutover-snapshot` when crossing revision 0246; its cli exposes
that input at lines 728-733. the wrapper cannot supply it.

production was observed at revision 0241 and source `7dc68929b`; current main
expects 0252. even after the uncertain-work blocker is resolved, the sole
documented release entrypoint refuses this transition. calling the backend
controller directly bypasses the wrapper's coordinated frontend promotion.

## prerequisites and fix

preserve the reviewed census and stopped-writer comparison. expose the census
input through the sole wrapper and forward it explicitly; update
`deployment.md`. this does not resolve the separately tracked
[uncertain-work disposition](model-history-cutover-blocked-by-uncertain-work.md).

## acceptance

prove locally that a reviewed census reaches the backend controller through
the wrapper, absent census still refuses a crossing, and releases not crossing
0246 retain the existing command. do not deploy production as part of this fix.
