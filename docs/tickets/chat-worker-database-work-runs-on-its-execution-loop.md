# chat worker runs synchronous database work on its execution loop

status: open · origin: 2026-09-21 chat-database repair (cleanup/chat-database), main `8d6a9209b5` · area: chat execution / jobs worker

`python/nexus/tasks/llm_task.py:29-69` runs each chat job's async handler on a
private event loop (`loop.run_until_complete`). on that loop,
`python/nexus/services/chat_run_worker.py:266-692` executes synchronous
sqlalchemy work: `is_cancel_requested(db, ...)` (line 579),
`lock_chat_run_for_update`, event-store appends from the text coalescer flush,
and `db.commit()` (line 586). the same loop drives the provider stream, the
33 ms coalescer flush timer (`CHAT_TEXT_FLUSH_INTERVAL_MS`, line 116), and the
cancel watcher (`_watch_cancel`, lines 679-694), which opens a second session
and reads on the loop every 0.25 s.

impact: bounded to that job's loop, which runs one job in a worker process
separate from the api. a slow write or lock wait pauses stream consumption,
text flushes, and cancel detection for that run only. source-confirmed; no
live stall induced. the api-side sibling was repaired on cleanup/chat-database
by giving each api database phase its own session on a worker thread.

prerequisites: keep `execute_chat_run`'s single session under sequential
ownership. the retired MCP listener is no longer part of this boundary.

proposed fix: settle the execution owner in the chat reauthoring. either hand
each complete synchronous phase (with its own session) to a worker thread, as
api admission now does, or run the executor synchronously and confine async to
the provider stream. no per-query handoffs.

acceptance: while an event-store commit is blocked, an independent heartbeat
and cancellation polling can advance on the execution loop. preserve durable
write order, text publication and terminal events; `./scripts/test` passes.
