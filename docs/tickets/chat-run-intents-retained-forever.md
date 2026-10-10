# every chat run keeps its whole frozen prompt forever

status: open · origin: 2026-10-10 chat runs rewrite (design T10) · area: chat storage

`chat_runs.generation_intent` holds each run's complete frozen prompt (the system
prompt, the turn's context, the whole admitted history, the turn). nothing reads it
after the worker starts the run. history grows with the path, so a chat of n turns
stores O(n²) bytes of repeated history; one turn of a long chat stores up to chat's
512 KiB input bound. the old `chat_prompt_assemblies` row had the same retention;
the rewrite moved it onto the run (migration 0271) without changing it.

proposed fix: clear `generation_intent` (or drop it to a digest) when the run
reaches a terminal status, in `events.finalize`; make the column nullable in one
migration. a rerun re-assembles from live context, so nothing needs the old prompt.

acceptance: a terminal run holds no full prompt; a queued or running run still
holds it; the chat harness passes (C41 replays a pre-migration queued run).
