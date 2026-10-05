# a codex event burst overflows the native buffer and strands the run

status: open · origin: 2026-10-04 chat harness (C24 fixture) · area: generation / codex runtime

When the codex app-server sends about 1,200 response events at once (400
commentary messages), the worker's consumer falls behind: the provider
runtime raises `ProtocolDefect("native pending event buffer exceeded its
finite bound")` (`provider_runtime/agent_runtime/codex_sdk.py:2542`), the
generation fails after durable dispatch, and every retry fails with "has no
authoritative native recovery evidence". The run stays running, then
suspended ("Recovering response", then "Response paused"); 163 of the 400
commentary deltas were committed.

impact: a fast or bursty codex stream can strand a chat run with no user
remedy. production likelihood is unmeasured: the harness burst is synthetic,
and paced at 20 ms per message the same run completes.
evidence: the C24 diagnostic cycle, 2026-10-04 (worker `chat_run.attempt_failed`
traceback; run `running`, job `failed` attempt 2, `E_WORKER_HANDLER_FAILED`).
the per-delta inline commit in `ChatRunEventEmitter` is the slow consumer.

resolved when: a burst of that size either drains (backpressure or batched
event commits) or fails the run terminally with a support id, and the
harness's unpaced burst variant completes or ends with a terminal failure card.
