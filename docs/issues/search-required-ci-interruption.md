# unexplained self-hosted ci subprocess termination

two required pr866 checks ended unexpectedly on `nexus-dev-server-2`. runtime
`1d9aa51ea` has accepted local static/functional proof; neither failed ci log
establishes a product or runner cause. static ci now selects github-hosted
`ubuntu-24.04` with explicit tooling. completion there can satisfy the required
check but cannot diagnose these historical terminations.

- head `d011fd9b719224b7c8b8839ad0224f171384755e`,
  [run40951038815](https://github.com/NielsdaWheelz/nexus-web/actions/runs/40951038815):
  runner `nexus-dev-server-2`, check exit143 during eslint, no lint diagnostic.
  check ran20:40:09–20:41:13 utc, below the five-minute workflow limit.
- docs-only head `f89a92816e2cd56db09a7e22c48baa5fb402ea37`,
  [normal retry40951698561](https://github.com/NielsdaWheelz/nexus-web/actions/runs/40951698561):
  `gen:wire` failed at `apps/web/scripts/gen-wire.mjs:13:16` because
  `uv run --frozen --no-sync python -m nexus.wire_schema` returned status143,
  signal null. node24.22.1 reports command failure; outer check exits1.
  check ran20:44:38–20:45:39 utc. no schema diagnostic establishes the cause.
  vercel and secret checks passed separately; that required check failed.

one authorized read-only runner observation covered both windows. existing
worker logs record shell pid3388546 exiting143 after63.9389126s and pid3391600
exiting1 after61.7578271s (`_diag/Worker_20261029-203956-utc.log:5012` and
`Worker_20261029-204425-utc.log:5012`, under `/home/niels/actions-runner`).
neither window records a preceding runner cancellation or timeout. the listener
records job-renewal cancellation at20:41:17, after the first shell exit and job
completion; that does not explain the termination. the service journal returned
no relevant termination/limit event in either window.

the runner service has `RuntimeMaxUSec=infinity`, cpu/address-space limits
infinite, watchdog0, memory high/max infinite, `KillMode=process`, and no
drop-ins. it has run since2026-10-17 with restart count0. the workflow's job
limit remains five minutes. these observations identify no one-minute limit or
signal sender; configured limits are not historical proof against every
external termination. `oom_score_adj=500` in the worker log is setup metadata,
not an oom-kill observation.

the failed check used node24.22.1 while `.node-version:1` requires22. this is a
separate environment mismatch, not an established explanation for143.

both failed outcomes and the inconclusive observation remain evidence. the
supported execution environment is now a fresh hosted vm; no self-hosted
restart, configuration/package change, reproduction or new monitoring was
performed. no further signal-source investigation is selected. this operations
issue remains open even if hosted ci passes. resolve when the runner owner
identifies the termination source and establishes its intended execution policy
or responsible correction; success on another runner alone does not resolve it.
