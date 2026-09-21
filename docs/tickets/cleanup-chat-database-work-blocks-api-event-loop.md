# chat database work blocks the api event loop

status: open · origin: 2026-09-21 cleanup audit, `93563d12b6` · area: chat admission / api

the chat routes are async because they await the generation catalogue, but then
run synchronous sqlalchemy work on that same event loop. `api/routes/chat_runs.py:73-80`,
`:92-99` and `:110-116` call synchronous read/cancel services directly;
`services/chat_runs.py:621-665` and `services/chat_run_candidates.py:83-121`
execute blocking locks, reads, mutations and commits inside async functions.
the engine is synchronous (`db/engine.py:44`). no thread handoff exists along
these call paths. a slow query or lock wait stalls unrelated requests and sse
delivery in that api process. this is source-confirmed; no live stall was induced.

prerequisite: preserve admission's replay-before-domain-check rule, lock order,
atomic receipt/messages/run/job commit, and the current repeat-operation wire
contract. do not share a session between concurrent tasks.

fix: give chat admission one synchronous transaction owner. await the catalogue,
run the complete database phase in the existing threadpool mechanism, then
await any subsequent catalogue work. hand off complete synchronous read/cancel
phases too. fold the single-use preparation/validation seams into that owner
when reauthoring chat; preserve independent citation and event-store owners.

acceptance: `./scripts/test` passes; a disposable integration probe holds an
admission lock while a chat request waits and observes another request and an
sse heartbeat advance; send, same-key replay, cancellation and rerun still
produce their existing receipts and terminal events. remove the probe afterward.
