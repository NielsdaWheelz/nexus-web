# codex host discards the original runtime failure

status: local fix; live correlation pending · origin: 2026-09-25 production chat investigation · area: codex host diagnostics

at deployed `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`,
`apps/codex_agent/host.py:1148-1168` converts runtime exceptions to closed
failure kinds without recording their original type or diagnostic cause.
`_runtime_error_kind` at lines 1436-1451 maps four distinct exceptions to
`invalid_request`. `GenerationFailure` carries only that kind. the host has
no retained-generation-terminal read route.

for run `ac2b162e-0bb1-4b66-90f5-a9aaec0b3f22`, worker logs prove
`invalid_request is a host defect`, but retained host logs contain no original
error. `llm_execution.py:743,991` rejects the defect during terminal
normalization before persisting the child terminal; the journal stays
uncertain. see [incident evidence](restored-chat-codex-dispatch-fails.md).

retain a bounded, sanitized operator diagnostic with generation/child identity
at the detecting host boundary. preserve the distinction between terminal
evidence, execution certainty and product failure; logging a defect must not
make it a retryable product error. use existing logging/support owners,
not a new observability service. never record credentials or full prompts.

acceptance: an invalid request identifies its original exception class and
safe cause at the same generation/child identity, survives failure of caller
normalization, and does not authorize duplicate execution or emit false done.
