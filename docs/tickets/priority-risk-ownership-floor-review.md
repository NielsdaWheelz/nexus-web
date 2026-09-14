# the priority-risk ownership pin and the routing sha need their independent review

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: testdata/proofs.json, python/nexus_test_control/model.py, docs/local-rules/testing-standards.md

## what is wrong

`PRIORITY_RISK_OWNERSHIP_SHA256` (`python/nexus_test_control/model.py:167`) and
the `nexus-test-routing-sha256` line in `docs/local-rules/testing-standards.md`
are **review tokens**, not checksums of convenience. their only purpose is to
force a human to look at the ownership map and the routing contract before
either changes. the policy scan currently reports
`proof-ownership-floor: priority risk ownership differs from the independently
frozen floor` and a `repository-route-contract` mismatch, and
`docs/cutovers/bounded-workspace-progress.md:153` still cites a reviewed-policy
verdict taken before the registry moved.

recomputing and pasting both values makes the gate green and deletes the only
mechanism that forces the look. that is the cheap fix and it is wrong.

## prerequisites

`testdata/proofs.json` must be settled first — it is being edited in this same
review wave (new proof registrations, stale glob removal, journey glob
additions). a pin recomputed against a moving map is worth nothing.

## proposed fix

after the registry settles, diff the risk → proof → source-glob map against the
frozen floor and against the base commit (`git show
7fa89b88c8:testdata/proofs.json`), have the independent reviewer record the
verdict over the twenty-two categories, capabilities and journeys, then recompute
both pins **in the same change as that recorded audit** — never as a follow-up
commit — and replace the stale receipt at progress.md:153.

do not chase removed risk ids; the question is whether the current ownership map
is the reviewed one, not whether it equals the old one.

## acceptance

the policy scan reports zero `proof-ownership-floor` and zero
`repository-route-contract` violations, and the root dossier carries an audit
note naming what changed in the ownership map and in the routing contract, dated
in the same change that moved the pins.
