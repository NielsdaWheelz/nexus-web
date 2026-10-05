# sse listen-cap rejection is misnamed and fatal to the client

status: open · origin: 2026-09-28, cleanup/delete-rate-limiter (pr-04, claude session) · area:
sse transport

after the rate limiter's deletion (migration 0248), the only emitter of 429
`E_RATE_LIMITED` is the process-local LISTEN cap: `StreamListenCapacityError`
(`python/nexus/db/listen.py:39-46`, raised at `:184-192` once 64 listeners are
active). it fires in `open_sse_listener` before `StreamingResponse`
(`python/nexus/api/routes/stream.py:135,222,257`), with the message "retry
shortly".

the web SSE client reconnects only on 401 or ≥500
(`apps/web/src/lib/api/sse-client.ts:193`), so this 429 ends the stream with an
error instead of retrying. the code's name also misdescribes a capacity
condition as a per-user rate limit. afaict most of the ~30 web `E_RATE_LIMITED`
arms sit on non-stream commands that never received the code: before 0248 its
only emitters were the limiter's three callers (chat send, oracle create, the
stream-token mint) and this cap.

fix (owner's choice): give the cap a capacity code whose response carries a
`Retry-After` header, let sse-client back off on it, and prune the dead web
arms. the handler has to render that header itself:
`ApiError.retry_after_seconds` never reached a response (`api_error_handler`
ignored it) and pr-09 (cleanup/prune-write-only-schema) deleted it along with
`E_OFFLINE_READING_PACKAGE_BUSY`'s unused 30 s hint.

acceptance: a 65th concurrent stream in one process reconnects after backoff
instead of erroring.

2026-10-04 chat rewrite: chat now recovers from this 429. a refused tail is an
ordinary lost stream: the run is read once, the answer shows Connection lost,
and Reconnect (or the browser's `online` event) tails the same run again. the
misnamed code and the transport's fatal treatment remain for the other
streams.
