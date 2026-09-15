# Bring the local `pr` gate back inside its budget

**Status:** open
**Origin:** 2026-09-06, PR #203 release work (owner asked for a five-minute CI)
**Area:** `python/nexus_test_control` lanes and sensitivity; `python/tests/kernel`

## Measured

Green local `pr` run (receipt 23ce5546bbf1e6e0, Mac Linux runner): 43.5 min.

| Phase | Time |
|---|---|
| complete kernel-python lane | 22 min (30 min in a `confidence` run) |
| sensitivity red/green (53 proofs, 106 separate pytest/vitest processes, base checkout + `uv sync`) | 12 min |
| service 1.7, component 1.3, journeys-critical 1.0, policy-self-tests 0.9, migrations 0.6, kernel-web 0.5, static/bundle < 1 | 7 min |

Kernel profile (`pytest --durations=40 tests/kernel`, 1361 tests, 25:57 serial):
39 of the 40 slowest tests are in `python/tests/kernel/test_production_release.py`
(96 tests, 10 to 22 s each, about 16 of the 26 minutes). Each boots a fake
systemd/Compose host and drives a release-controller scenario end to end. The
other roughly 1265 tests take about 10 minutes serially. Next slowest file:
`nexus_test_control/test_provider_api_peer.py` (one 16 s test).

On the self-hosted `nexus-dev-server` (4 CPU, 7 GB) the same `pr` gate did not
finish inside the job's 90-minute timeout (run 34047519720 attempt 3,
cancelled). GitHub-hosted runners took about 75 minutes.

`docs/local-rules/testing-standards.md` section 7 states the `pr` warm target
as 3 to 5 minutes locally.

2026-09-12 evidence: main run `34712797648`, receipt `28bf282776b0105f`,
passes in 99m40s of controller execution (101m24s for the job); kernel-python
takes 73m44s. ordinary changed run `34718249742` selects the complete kernel
after proof-ownership changes, then exceeds its 90-minute job limit during
service verification. its annotation reads `The job has exceeded the maximum
execution time of 1h30m0s`; evidence upload is skipped. the ordinary job envelope
is now 120 minutes. this preserves the portfolio but does not resolve
the latency target or establish a p95 bound; this ticket remains open.

## Done on 2026-09-06

The `pull_request` CI job now runs `./scripts/test changed --base <base sha>`;
`pr` stays the local pre-merge portfolio and `full` on the `main` push is the
release proof (policy pin, kernel tests and docs updated in PR #203).

## Proposed (in order of payoff per effort)

1. Keep the release-controller simulation out of the `pr` kernel lane unless the
   diff touches `deploy/` or that suite; always run it in `full`. About 16 min.
   Controller: a `pr`-scope deselection for that owner (or a distinct
   capability such as `release-controller` in `_FULL_NON_BROWSER`), policy
   self-tests, testing-standards table row.
2. Batch the red runs per lane on BASE instead of one process per proof
   (`sensitivity.py`): 12 min to about 4.
3. Parallelize the remaining kernel tests (`pytest-xdist`, not installed;
   tests that spawn docker/systemd/subprocess need a serial marker or their
   own group): 10 min to about 3 on four cores.
4. Warm caches on the lab runner (uv, bun, Playwright) so setup is about 1 min.

Expected `pr` after 1 to 4: 10 to 15 minutes on the lab runner; `full` on `main`
proportionally shorter.

## Acceptance

- `./scripts/test pr` on the lab runner completes inside 20 minutes with the
  same capability set and sensitivity evidence.
- testing-standards section 7 budget row for `pr` is either met or restated
  with the measured number.
