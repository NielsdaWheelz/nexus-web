# Generation Runtime Composition

**Status:** current-to-target composition pointer

The approved target contract is
[`generation-backends-hard-cutover.md`](generation-backends-hard-cutover.md).
Until that atomic cutover turns green, source still implements
[`codex-personal-generation-hard-cutover.md`](codex-personal-generation-hard-cutover.md).
The older document describes current code only; it is not authority for target
behavior and is deleted with its change report at cutover.

The stable module views are [`../modules/llms.md`](../modules/llms.md) and
[`../modules/chat.md`](../modules/chat.md). They continue to describe shipped
source until Lane V updates them at the same commit that switches all callers.

## Approved target invariant

Every Nexus text or structured-output generation crosses one boundary:

```text
domain owner -> GenerationIntent -> GenerationService -> frozen GenerationSpec
              -> CodexPersonalBackend | ProviderApiBackend
              -> one ToolAuthority / ToolExecutor / journal
```

The domain owner retains prompt, evidence, output validation, and publication
authority. `GenerationPolicy` owns exact background selection and operation
workflow; Chat supplies an exact per-run selection. The generation layer owns
catalog validation, immutable admission, durable ambiguity, capacity,
continuation, transport, and normalized terminal facts. `llm-calling` owns the
Codex AgentRuntime and API ProviderRuntime adapters below that boundary.

Every operation resolves an explicit model tool mode. `NoModelTools` publishes
nothing. `ModelTools` lowers the same frozen canonical plan to authenticated
Codex MCP or API function calls, both backed by the same Nexus authority,
executor, evidence, journal, citations, effects, and replay identity. The
shipped Library and Idea Dossier background plans are read-only; Chat alone may
receive a fresh per-run additive-write grant. Idea's separate HostTable research
remains deterministic host preparation and is never model authority.

There is no alternate generation service, provider-specific tool owner,
user-selectable background policy, generation default, automatic fallback,
ambiguous-acceptance replay, or parallel generation ledger.

## Composition with durable Chat

Chat conversation state, citations, trust trails, stream folding, reversible
write receipts, and the durable tool journal remain app-owned. A backend session
owns one admitted generation, not conversation history. See
[`chat-durable-agent-step-journal-hard-cutover.md`](chat-durable-agent-step-journal-hard-cutover.md)
for the durable Chat protocol; the approved target generation contract owns
model selection, tool-plan lowering, grants, cancellation, and qualification.

This file intentionally defines no second schema, policy map, or rollout plan.
All implementation, migration, verification, and operational decisions come
from the approved target contract.
