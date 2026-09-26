# latest model worker replay not qualified

status: open · origin: 2026-09-26 latest-model qualification · area: durable generation

## problem and evidence

the final `75b60bf` stack replayed a completed chat's persisted sse frames twice
without another dispatch. host admission replay also passed before dispatch.
neither proves a worker restart after an accepted generation but before chat
publication. the final child, parent terminal and step memo commit atomically
in `llm_execution.py:736-788`; normal chat finalization later clears the
`generation/1` journal. reproducing the real crash window needs a distinct
disposable operation, not a retry of an existing completed or uncertain run.
`_read_replay` returns a completed memo before backend io, but the full worker
path was **not run**. see
`/tmp/nexus-fullstack-cancel-20260926.md` and the end-to-end qualification ticket.

## prerequisite and acceptance

in a disposable migrated database, stop a fresh worker after its atomic
generation terminal/memo commit but before chat-run publication; restart
through the actual worker entrypoint. prove one paid dispatch, one child, one
tool effect at most, and an exact final parent/run result. never requeue the
existing uncertain `web.search` run by inference.
