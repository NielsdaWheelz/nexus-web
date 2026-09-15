# release command failures lose their diagnostics

status: open · origin: 2026-09-15, restoration cutover at 06677a68 · area: release operations

## evidence

`deploy/hetzner/release.py:_run` captures subprocess output but exposes only
`bounded command failed: docker`. the 17:36 utc cutover exhausted its mcp
proof retries with that message. docker exec events were needed to identify
the failed operation; the network probe also suppressed its own cause.
the dns forward fix exposes that probe's bounded stage/type diagnostic, but
other command failures retain the same blind spot.

`_settle_compose_job` reads only one log line and removes the exact job before
raising for a nonzero exit. successful migration output is not retained either.
the 066 migration container was removed by its owner before the independent
observer's final inspection. retained memory samples and the controller's
exact-head transition remain evidence; they do not provide the removed final
container state or complete log.

private mac evidence: `/tmp/nexus-release-255/deploy-06677a68-retry2.log`,
`failed-06677a68-codex-exec-events.jsonl`, and
`migration-production-06677a68-observer.log`.

## next action and acceptance

at each command owner, report the operation and bounded safe failure details.
preserve useful one-off diagnostics before removing their container. do not
print runtime environments, credentials or raw private payloads, and do not add
a test controller or generalized receipt framework.

accept when a failed owned command identifies its stage and actionable cause
without docker-event archaeology, and failed migration diagnostics survive
normal settlement. verify the formatting/redaction boundary with cheap pure
units through `./scripts/test`; runtime checks remain manual.
