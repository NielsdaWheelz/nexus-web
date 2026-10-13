# legacy codex host signal termination during the reviewed reset

status: open until the production cutover is qualified
origin: 2026-10-13 release; deployed `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`
area: release / native host shutdown

the production codex host exited 143 immediately after `compose stop --timeout
45`. its last shutdown logs were `Shutting down` and `Finished server process
[7]`; docker reported exited, pid 0, no OOM and no runtime error. the api and both
workers exited 0; no queue rows were pending, running or failed before stopping.
the controller refused before backup or migration; production remains at 0241.

the old `apps/codex_agent/main.py:119-126` awaits uvicorn 0.40.0 inside an outer
cleanup `finally`. uvicorn's `server.py:314-331` restores the default signal
handler and re-raises SIGTERM after its server shutdown, bypassing that cleanup.
the surviving `agent.sock` corroborates the skipped cleanup. exit 143 is not a
clean exit 0, and says nothing about remote provider completion.

`deploy/hetzner/release.py` now bounds acceptance to the reviewed pre-0246 reset,
the exact deployed source and immutable image revision, the old host alone,
exited/non-running/pid 0/no OOM/no runtime error, and zero running background
jobs. every writer and all other hosts require exit 0. the frozen census and
reviewed disposition must preserve every original uncertain provider outcome.

recovery to the old host requires shared socket directory mode `0770`; the new
host uses `0700`. preserve the socket volume and encrypted codex state. after a
schema change, restore the matched backup before starting old applications.

acceptance: the new candidate passes the static gate and the stop-state refusal
matrix; repeat the fresh drained census, backup and whole-chain restored replay;
complete production migration and prove the new host healthy. retain the actual
143 observation and archival evidence, then delete this ticket.
