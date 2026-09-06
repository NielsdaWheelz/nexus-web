# Evaluate adopting llm-agent-kernel as the Nexus generation kernel

**Status:** open (not adopted in PR #203; decision recorded)
**Origin:** owner request during the PR #203 takeover, 2026-09-06; read-only
fit/gap analysis against the generation-backends spec
**Area:** generation runtime architecture; dependency pins

## Decision recorded in PR #203

Not adopted inside PR #203. Finish the cutover on `llm-calling` as specified
and evaluate "Nexus generation on llm-agent-kernel" as a separate hard cutover
once the prerequisites below exist. No coupling to the kernel (dependency,
docstring, or interface) was added, because its alpha API will move under those
prerequisites.

## What the kernel is (v0.1.0, `~/Documents/code/llm-agent-kernel`)

A small Python control plane for bounded, tool-using agents: immutable
`AgentDefinition` and containment fingerprints; exact Codex agent-session
request mapping; a closed provider-wire envelope decoding to the logical
`say | call_tool | finish` protocol; whole-step validation; exactly one serial
host tool call per model step; mid-loop input polling, preemption,
cancellation, settlement; per-run limits and cross-run admission reservations;
ports for session references, checkpoints, provider, context, dispatch, and
events; process-local fakes and a deterministic conformance suite. Jarvis is
the first consumer. It uses only the subscription-backed
`provider_runtime.agent_runtime.AgentRuntime` lane. Health at the time of the
analysis (re-checked 2026-09-06): 12 commits (2026-09-01 to 2026-09-05, head
670da13), deterministic suite `175 passed, 5 deselected` locally, CI green on
the last six pushes, seven ADRs under `docs/decisions/`, `Development Status ::
3 - Alpha`, live Codex qualification opt-in and never recorded.

Pins at the time: `provider-runtime` from `llm-calling` at main `2cfed97`,
`llm-tools` at `9e6d155`, `openai-codex==0.144.4`.

## Capability match against PR #203's approved behavior

| Target | Kernel today | Verdict |
|---|---|---|
| Background via Codex Personal | Codex `AgentRuntime` is the only lane, but `CodexProvider` (provider.py:149) takes a live `AgentRuntime` and holds its sessions in-process; Nexus keeps the SDK confined behind a UDS host and never opens it in the API process. `run_one_shot` requires `StructuredOutput` and no `Write` (12 of 14 background operations fit; `dawn_write` is text; Library and Idea Dossier need tools). | Partial; needs an out-of-process provider session port |
| Chat over the ProviderRuntime catalog | Stateless `ProviderRuntime.generate` is explicitly excluded (SPEC.md; `docs/decisions/0005-codex-agent-lane-and-serial-steps.md`); no catalog concept. | Excluded by design |
| One authority/executor/journal, operation-owned plans, budgets, write consent | Host supplies `FrozenToolPlan`, `ToolBudgetFactoryPort`, `ToolDispatchPort`; Nexus's executor could implement dispatch. But the kernel demands `HostTable` exposure while all Nexus model plans are `Native`; Chat `AdditiveWrites` is barred from one-shot, so Chat would need `run_thread` with claim/poll/settle/session-CAS ports Nexus has no analog for. | Possible with additions |
| Codex tools over HTTPS MCP vs the kernel's closed protocol | `mcp_servers` must be empty (SPEC.md:305-306); network `disabled`; one JSON-string-argument call per turn. Nexus passes MCP servers with `network="unrestricted"` behind its relay, and the spec fixes MCP as the Codex tool transport. Under the kernel every tool call is a full Codex turn (ChatRead allows 64 calls vs `max_provider_turns=8`). | Direct conflict |
| Strict refusal, no fallback | Typed stops, no rearm. One provider-session cold-bootstrap fallback on `SessionMismatch`, moot for Nexus (always `NewSession`). | Matches |
| Ledger, terminal fencing, API continuation replay | Host-owned; no parent/child turn or sealed-continuation concept (stateless-lane artifacts). | Neutral |
| Structured output for background | Supported, but wrapped in `finish.result` and subject to the kernel's schema limits; Nexus emits `JsonSchemaAgentOutput` directly. | Wire shape changes |
| Authorship/Undo/citations | Host-owned. | Neutral |
| Capacity/quota parking | `AgentQuotaExhausted` becomes a `quota_exhausted` stop that consumes input (`docs/decisions/0006-bound-work-across-runs.md`); Nexus requires a non-attempt `CapacityPaused` with `reset_at`/`next_check_at`. | Semantic conflict |

## Overlap and rewrite shape

The kernel would replace Nexus's `_AdmissionLifecycle`/turn slots,
`OperationBounds` timeouts, cancellation token, and context budgeting, but
neither of Nexus's two tool loops (the SDK-owned MCP loop and the
application-driven API loop): both are excluded. It leaves to the host exactly
what Nexus already owns (schemas, effect identity, ledger, reconciliation,
catalog, prompts). Adopting it for the Codex arm alone would rewrite
`codex_generation_operations.py`, `codex_generation_contract.py`,
`codex_generation_client.py`, `apps/codex_agent/host.py`, delete
`agent_tools_mcp.py`, rewrite `generation_backend._execute_codex`, convert the
tool-authority recorder to async, add `implementation_revision` to bindings,
flip four plans from `Native` to `HostTable` (which changes model-visible
declarations, prompts, and both eval corpora), and re-decide the "Codex
normally has one child" ledger rule. Spec sections 1, 3.4, 4, 5.1, 5.3, 6, 11
and acceptance criteria 9 and 12 would reopen, plus proof lanes C, T, E and
part of L. Order of magnitude: 5 to 7 thousand service/host lines plus tests.

## Pin conflicts (mutually exclusive today)

- The kernel constructs the flat `AgentSessionRequest(backend="codex", ...)`
  that `llm-calling` PR #24 replaced with the `CodexCatalogSessionRequest`
  union Nexus pins; the kernel's adapter fails at runtime on Nexus's pin.
- `model_catalog.py`, `tool_projection.py`, `continuation.py`,
  `CodexSandboxControls`, and `api_model_catalog` do not exist at the kernel's
  `llm-calling` pin; Nexus imports all of them.
- `llm-tools` 8df458a..9e6d155 (Nexus pin to kernel pin): `PositionRecorder`
  and `ToolExecutor` methods became async (Nexus's recorder is sync);
  `ToolBinding.implementation_revision` is a new required field that Nexus's
  bindings omit; every plan/authority/policy revision and both eval
  fingerprints change; `web.search` moves to policy epoch v2 with an
  operation deadline; `python/tests/llm_tools_contract/test_pinned_llm_tools.py`
  hard-pins `LLM_TOOLS_SHA` to 8df458a.

## Prerequisites for a later cutover (each an ADR-level change)

1. Repin the kernel to `llm-calling` main after PR #24 merges and adapt its
   session request to `CodexCatalogSessionRequest` (it has no catalog port).
2. An out-of-process provider session port (or transport abstraction) so a
   host can keep the SDK confined; `ProviderSessionLease.session` is
   constructible from a ref, so this is feasible but untested.
3. MCP application tools admitted as an exposure (reversing SPEC.md and
   ADR 0005 `codex-agent-lane-and-serial-steps`), or Nexus abandons MCP; an owner decision with prompt, eval, and
   security consequences either way.
4. `Native` exposure accepted by `require_host_plan`, or Nexus plans move to
   `HostTable`.
5. Pre-acceptance quota becomes a non-consuming deferred/park outcome
   (ADR 0006 `bound-work-across-runs`).
6. Text-output one-shots (for `dawn_write`) or explicit thread-mode routing.
7. A stateless ProviderRuntime lane, or the cutover is scoped honestly as
   "Codex arm only" with the API loop staying Nexus-owned (two orchestration
   owners, which the current spec forbids).
8. A recorded live Codex qualification at the exact pins.
9. Nexus repin to `llm-tools` >= 9e6d155 (async recorder, implementation
   revisions, `web.search` v2); independently valuable but a lane-T/E re-proof.

## Low-risk alignment inside PR #203

None. Pin alignment is not low-risk (item 9), and the kernel cannot be
installed beside Nexus's `llm-calling` pin.

## Acceptance for this ticket

A written cutover spec in `docs/cutovers/` that either lists the prerequisites
above as landed (with kernel ADR references) or scopes the adoption to the
Codex arm and states the two-owner trade-off explicitly; until then this stays
a decision record.
