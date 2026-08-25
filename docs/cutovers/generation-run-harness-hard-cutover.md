# Generation Runtime Composition

**Status:** current composition pointer

The executable generation contract is
[`codex-personal-generation-hard-cutover.md`](codex-personal-generation-hard-cutover.md).
The stable module views are [`../modules/llms.md`](../modules/llms.md) and
[`../modules/chat.md`](../modules/chat.md).

## Current invariant

Every Nexus text or structured-output generation crosses one boundary:

```text
domain owner -> GenerationIntent -> generation_policy -> durable owner + llm_calls
             -> private UDS -> isolated Codex host -> codex-personal
```

The domain owner retains prompt, evidence, schema, validation, and publication
authority. The generation layer owns fixed-plan resolution, durable ambiguity,
capacity handling, transport, and normalized terminal facts. The isolated host
owns the enrolled ChatGPT credential, Codex SDK lifecycle, sandbox policy, and
the single active turn slot.

Synthesis operations are tool-free. Chat alone receives the canonical Nexus
tool catalog through the run-scoped MCP boundary; Nexus remains the only domain
authorization and side-effect authority.

There is no alternate generation runtime, caller-selected model or effort,
credential fallback, automatic replay after ambiguous acceptance, or parallel
generation ledger.

## Composition with durable chat

Chat conversation state, citations, trust trails, stream folding, reversible
write receipts, and the durable tool journal remain app-owned. The Codex host
opens one native session for one generation and does not own conversation
history. See
[`chat-durable-agent-step-journal-hard-cutover.md`](chat-durable-agent-step-journal-hard-cutover.md)
for the durable chat protocol and the generation authority for the MCP wire,
grant, cancellation, and live-qualification rules.

All implementation, migration, verification, and operational decisions must be
derived from those current authorities; this file intentionally defines no
second schema or rollout plan.
