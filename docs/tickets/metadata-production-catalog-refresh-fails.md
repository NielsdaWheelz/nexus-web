# production metadata catalog refresh fails

status: open
origin: 2026-10-01 read-only production metadata investigation; updated 2026-10-10 generation rewrite
area: generation catalog

since the generation rewrite an unavailable catalog is a `runtime_unavailable`
generation that never reached codex: the job takes its one immediate retry and
then settles a terminal `model_unavailable`. the production cause and
the three reviewed retry dispositions below remain unresolved.

problem: three lewis jobs created at 15:12 utc on deployed sha 7dc68929b4d5ddfd77eb1a50228d477fa0148b5d died after two attempts with `E_WORKER_HANDLER_FAILED` and `generation catalog definition refresh failed`: `b21724fa-c747-4b09-8124-2c4a62c0a568` (english literature), `ffe776a3-e201-4ff1-bb7e-e3f9d1e74700` (mere christianity), `ae7d9981-ca00-4a81-b210-25f3943ab3d4` (three ways of writing for children). queue aggregates show four such dead metadata jobs in total. no underlying refresh exception has been established.

prerequisite: correlate the catalog failure with the exact host/session/catalog revision. repair the failing catalog or its host dependency at its owner, without fallback or stale catalog substitution.

acceptance: ordinary metadata admission reads the codex catalog and an availability failure ends as `model_unavailable`. each of the three jobs has a reviewed retry disposition after runtime repair (0256 deletes every enrich_metadata job at the release that crosses it).
