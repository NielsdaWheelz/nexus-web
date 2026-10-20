# isolated generation catalog is unavailable

status: open; local qualification precondition, native catalog dependency identified
origin: 2026-10-16 principal-actions canonical build `140dc2e32`
area: local development / generation catalog

ordinary new-chat UI on the isolated full stack rendered couldn’t refresh
models. real `GET /llm-catalog` returned503 `E_GENERATION_RUNTIME_UNAVAILABLE`,
request `09bec00b-6f34-4ce4-9d57-64e15f106139`, 2026-10-17 02:22:03utc.
`python/nexus/api/routes/llm.py:28` maps `CatalogUnavailable` to this refusal.
no message or generation was submitted; this is not evidence of a bad result.

impact: first-message source-replacement qualification cannot start. other
principal-action journeys passed. do not infer a production outage from this
isolated runtime or conflate it with the older metadata catalog ticket.

establish the documented local catalog/host readiness prerequisite and its
actual failure, then repair at that owner. no fabricated catalog or stale fallback.

2026-10-19 cause: `services/generation/catalog.py:153–166` refuses the whole
catalog when no codex snapshot exists, before configured api-provider rows are
composed. `python/scripts/disposable_runtime.py` deliberately supplies a nonexistent
native socket; its live configuration does not admit native topology. runtime
`20261019-224140-6d3f71ae9163` reproduces 503 with explicitly configured openai
credentials. openai configuration alone cannot satisfy this prerequisite.

acceptance: ordinary local new-chat receives a real selectable catalog and can
submit its first message. record the runtime/catalog identity with the result.

2026-10-19 x-thread qualification reproduces `GET /api/llm-catalog`503 through
isolated next29730/bff/api29712. authenticated reader rendering and canonical
post actions load without page errors; chat catalog qualification remains
outside that reader evidence. no provider generation was submitted.
