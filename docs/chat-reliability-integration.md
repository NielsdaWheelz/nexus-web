# chat reliability integration receipt

2026-09-25, local branch `feature/chat-reliability`, based on
`cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`. no production mutation,
merge, paid generation or release was performed. the dependency commits below
were published as isolated feature branches; no dependency or nexus pull
request was merged.

both dependency branches descend from the repository's already pinned but
unmerged embedding-memory maintenance commits. a pull request against each
repository's `main` would include that unrelated maintenance history, so no
pull requests were opened. the nexus branch is one unrelated collection-pane
commit behind `main`; integration should reconcile that independently.

| boundary | result and limit |
| --- | --- |
| exact pins | nexus locks provider-runtime `7008b669a5bbee545a0b93c90a1786a0ce07c9c5` and llm-agent-kernel `112fae14727acec52141dcdebc323f87dfae6d47`; codex sdk/cli remains `0.144.4`. the provider commit is a direct child of the prior `97fbac7` pin; the kernel commit changes its matching dependency pin. `uv lock --check --offline` passed using the local commits. |
| static | `./scripts/test` passed on the locked candidate: actionlint, shellcheck, ruff, pyright, browser builds/lints/types, and one alembic head `0242`. this is static consistency, not a chat journey. |
| provider contract | a disposable provider-runtime proof covered all catalog rows/reasoning, output kinds and tool presence; strict-json-plus-tools is refused before i/o. 93 targeted provider tests and 265 kernel tests passed in their isolated worktrees. every other resolver result is source-`unqualified`, not a live-provider pass. nexus therefore leaves tool-bearing api cells ineligible. |
| codex admission and diagnostics | disposable asgi/native-boundary proof passed for pre-slot tool refusal, no-tool lowering, and bounded first/secondary failure logging. no real authorized mcp call or negative-effect sentinel passed on the pinned native runtime. codex tool-bearing chat and fixed background policies requiring tools remain release blockers. |
| cancellation | disposable postgres at migration `0242` passed no-step, prepared, completed-memo replay, uncertain, duplicate, fingerprint and ledger-contradiction cases. a concurrent journal arm waited behind the dead-job lock and rolled back; uncertain work remained dead with persisted stop intent. temporary proof scripts were deleted. no live provider process/effect proof ran. |
| history and startup | one pre-cutover `meta` event failed the new decoder before migration and decoded after `0241` to `0242`; event identity, sequence, timestamp and immutable payload fields were unchanged. with the catalog host unreachable, local api startup and a saved run read succeeded; that run projected `Suspended` plus `cancel_requested=true`. catalog recovery and authenticated browser history were not exercised. |
| revision and browser | disposable route integration returned 409 for stale run create, read and cancel before handler work; direct sse returns 401 without a stream token and 409 for an authenticated stale client. a current-revision read returned the same run without another admission. seven temporary browser integration tests passed with 19 assertions for liveness, stop targeting, reload and candidate selection, then were deleted. no authenticated real-browser journey ran. |
| telemetry | local route and logging-context proofs retained distinct ingestion `request_id` and browser `origin_request_id`. no production client-defect event was observed. |
| original pane crash | the user reports it occurred one or two weeks earlier and is not reproducible. no initiating browser exception or failed request was retained. its cause and repair are unproved. |
| memory | no representative tool-bearing work or attributable cgroup/process peak was measured. no cap was raised. |

the deliberate trade-off is fail-closed tool-bearing generation. it prevents a
known incompatible codex request from producing another ambiguous dispatch,
but it cannot provide a chat reply through the default codex route. api text
plus tools also stays ineligible until exact live completion/effect proof;
source compatibility alone is insufficient.
uncertain work may remain suspended for operator repair rather than repeat
effects. the strict chat revision requires a coordinated browser reload; an
already-open old client may still show its old pane boundary during cutover.
the existing incident run was not reset or requeued.

release remains blocked by codex and api authority proofs, fixed background-policy
qualification, and real chat/browser and memory observations. the original crash remains a separate open
incident pending a reproducible exception. see
[the implementation plan](chat-reliability-plan.md) and
[tracked issues](outstanding-issues.md).
