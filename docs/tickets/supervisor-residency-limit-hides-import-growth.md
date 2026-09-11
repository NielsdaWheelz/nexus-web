# The supervisor residency limit is 19 MiB looser than the supervisor it guards

**Status:** open
**Origin:** Imports workspace cutover, Phase 9, 2026-09-10
**Area:** `python/tests/testkit/background_process_containment_probe.py`

## What is wrong

`SUPERVISOR_RESIDENT_KIB_LIMIT` is 96 MiB and is asserted once, at the end of a
real eight-job containment run. On `origin/main` the supervisor's import-only
residency is 73 MiB, so the limit tolerated a 19 MiB regression before it bit:
the cutover pulled `nexus.db.models` and `nexus.schemas.media` into the
supervisor through `jobs/registry -> jobs/history_projections ->
schemas/import_history -> schemas/media`, import-only residency went to 92 MiB,
and the proof only failed once run-time allocation pushed the total past 96 MiB
(99736 KiB observed), which reads as flakiness rather than as the import leak it
was.

Phase 9 removed that leak (77 MiB import-only) and named `nexus.db.models` and
`nexus.schemas.media` in `_FORBIDDEN_MODULE_NAMES`, which is now the sharp part
of the invariant. The residency number is still a loose backstop, and 4 MiB of
the remaining growth over main is unexamined: `nexus.schemas.import_history`
(+1 MiB of pydantic models) and `nexus.services.import_history` (+3 MiB, of which
~2 MiB is `from sqlalchemy.dialects.postgresql import JSONB`, which the
supervisor also loads on main at its first database connection).

## Evidence

- An ad-hoc probe (a fresh interpreter importing the supervisor's set in order —
  `sqlalchemy.orm`, `nexus.config`, `nexus.db.engine`, `nexus.jobs.process_executor`,
  `nexus.jobs.registry`, `nexus.jobs.worker`, `apps.worker.main` — and reading
  `VmRSS` from `/proc/self/status` after each) in the cutover's Linux runner: main 73 MiB /
  28 `nexus.*` modules; merge `e7c6d9fe` 92 MiB / 45; after Phase 9 77 MiB / 36;
  main plus `sqlalchemy.dialects.postgresql` 75 MiB. Three runs each, no jitter.
- `python/tests/service/test_background_worker_process_containment.py:182-183`.

## Prerequisites

None.

## Proposed fix

Assert the supervisor's *import-only* residency in its own cheap kernel case (a
fresh interpreter importing exactly the supervisor's module set, limit set just
above the measured value), and keep the 96 MiB run-time limit as the backstop it
is. That makes an import leak fail in seconds, at the boundary that owns it,
instead of surfacing as a marginal run-time overshoot in a heavy service proof.

## Acceptance

Re-adding a module-scope import of `nexus.db.models` to any module the registry
reaches fails a kernel case naming the module, without running the containment
supervisor.
