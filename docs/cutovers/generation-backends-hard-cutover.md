# Generation Backends Hard Cutover

**Status:** APPROVED IMPLEMENTATION SPECIFICATION; NOT IMPLEMENTED

**Date:** 2026-08-31

**Type:** atomic hard cutover; no compatibility period

**Open questions:** none

**Supersedes:**
[`codex-personal-generation-hard-cutover.md`](codex-personal-generation-hard-cutover.md)
and its change report. Those files describe the unaccepted Codex-only source
state and are deleted when this cutover turns green.

## 1. Decision

Codex Personal is the default backend for every Nexus generation operation.
Chat also offers the previously shipped, curated API-provider profiles as
explicit advanced choices. Nexus has one generation service, one product policy,
one durable generation ledger, and one canonical tool authority; Codex Personal
and API providers are transport-specific adapters below that waist.

```text
domain owner -> GenerationIntent -> GenerationService -> frozen GenerationSpec
                                                |
                         +----------------------+----------------------+
                         |                                             |
              CodexPersonalBackend                         ProviderApiBackend
              llm-calling AgentRuntime                     llm-calling ProviderRuntime
                         |                                             |
                 HTTPS MCP calls                           native function calls
                         +----------------------+----------------------+
                                                |
                                  one Nexus ToolAuthority
                                  one ToolExecutor/journal
                                                |
                                  typed events and terminal
                                                |
                                  domain-owned validation/publication
```

Tool parity is semantic, not transport parity: both adapters publish the same
frozen canonical tool plan and reach the same authorization, executor, receipts,
citations, effects, and Undo owners. They do not pretend an SDK-owned MCP turn
and an application-driven provider continuation loop are the same protocol.

This is a hard cut to that architecture. There is no Codex-only compatibility
path, old provider stack, dual ledger, automatic fallback, legacy decoder, or
old/new profile API.

## 2. Scope, goals, and non-goals

### Goals

- Keep Codex Personal as the default for all current background generation and
  new Chat.
- Restore the nine formerly shipped API profiles as optional Chat choices,
  using the pinned `provider-runtime` registry and only after live
  qualification.
- Preserve Fast, Balanced, and Deep as the primary product language; provider
  choice is progressive disclosure.
- Give Codex and API Chat identical canonical Nexus tool authority.
- Split read authority from additive-write authority; writes require an
  explicit per-run user grant and remain bounded, audited, idempotent, and
  undoable.
- Preserve domain prompts, evidence selection, strict output validation,
  citations, cancellation, publication transactions, and background retrieval.
- Preserve crash/replay truth across multi-call API tool loops without hiding
  accepted calls, billability, continuation state, or uncertain effects.
- Reuse the current Codex host, generation ledger, tool runtime, durable step
  journal, provider-runtime adapter, profile copy, and provider tests where
  their semantics still fit.
- Remove every superseded owner after the new path is green.

### Non-goals

- Automatic provider/model routing, fallback, cascades, judges, A/B routing, or
  quota overflow from Codex subscription to API spend.
- A model marketplace, arbitrary model IDs, reasoning controls, BYOK UI, or
  customer-editable API credentials.
- API-provider selection for background jobs in this cutover. Background policy
  remains Codex Personal; the backend seam makes a later reviewed policy change
  possible without another architecture.
- New OpenRouter or xAI product profiles. They remain library capabilities, not
  Nexus product surface.
- Codex shell, filesystem, native web, skills, plugins, subagents, dynamic App
  Server tools, or approval-requiring built-ins.
- Provider-native web/search tools. `web.search` remains the sole model-facing
  Web search and stays Brave-backed.
- Granting live model tools to frozen-evidence synthesis jobs.
- Adaptive Idea-research planning. The existing durable, host-planned three-query
  workflow and tool-free final synthesis remain unchanged.
- A new workflow engine, generalized agent runtime, generic cross-lane
  dispatcher inside `llm-calling`, multi-user billing, or zero-downtime
  compatibility.

## 3. Target product behavior

### Chat profiles

The browser submits one closed `profile_id`. Each profile fixes route, exact
model, exact reasoning, disclosure, and eligibility; users never form arbitrary
provider/model/reasoning combinations.

| Profile id | Product label | Route target | Fixed reasoning |
|---|---|---|---|
| `codex-fast` | Fast | Codex Personal / `gpt-5.6-luna` | `low` |
| `codex-balanced` | Balanced | Codex Personal / `gpt-5.6-terra` | `medium` |
| `codex-deep` | Deep | Codex Personal / `gpt-5.6-sol` | `high` |
| `openai-fast` | OpenAI · Luna | `openai:gpt-5.6-luna` | `low` |
| `openai-balanced` | OpenAI · Terra | `openai:gpt-5.6-terra` | `medium` |
| `openai-deep` | OpenAI · Sol | `openai:gpt-5.6-sol` | `high` |
| `anthropic-sonnet` | Claude · Sonnet 5 | `anthropic:claude-sonnet-5` | `medium` |
| `anthropic-fable` | Claude · Fable 5 | `anthropic:claude-fable-5` | `high` |
| `google-gemini` | Gemini · 3.5 Flash | `gemini:gemini-3.5-flash` | `medium` |
| `moonshot-kimi` | Kimi · K3 | `moonshot:kimi-k3` | `high` |
| `deepseek-flash` | DeepSeek · V4 Flash | `deepseek:deepseek-v4-flash` | `high` |
| `deepseek-pro` | DeepSeek · V4 Pro | `deepseek:deepseek-v4-pro` | `high` |

`codex-balanced` is the new-chat default. Fast/Balanced/Deep appear first;
ready API profiles appear under **Advanced**. Unconfigured or unhealthy routes
are disabled with their exact operator-facing status and are never selected as
fallbacks. A profile is advertised as ready only when its exact registry row,
credential, tool/stream/continuation capabilities, and current qualification
are valid.

Rerun and regenerate inherit the source `profile_id`. They reset write
authority to `ReadOnly`; mutation authority must be granted again.

### Background operations

All current background policies remain Codex Personal and preserve the current
plan table:

- `routine`: metadata enrichment, media summary, Synapse, dossier page/note,
  and Idea resolve;
- `standard`: Dawn, Oracle, dossier media/conversation;
- `thorough`: dossier library/podcast/contributor/idea.

Their final turns use `FrozenSynthesis`: complete bounded evidence in, no live
model tools, strict output or text out. Existing deterministic or durable host
retrieval remains outside the generation turn.

## 4. Final architecture and ownership

### Nexus owns

- product profile and operation policy;
- exact route selection and readiness;
- credentials and process wiring;
- durable generation, model-turn, tool-position, and effect identity;
- tool catalog, grants, scope, budgets, execution, receipts, citations, trust,
  Undo, and cancellation;
- prompts, evidence, output schemas, validation, and domain publication;
- product API/SSE and user disclosure.

### `llm-calling` owns

- separate `ProviderRuntime` and `AgentRuntime` contracts;
- provider/SDK transport, native continuations, event normalization, usage,
  request identity, and per-call retry classification;
- exact model registry facts;
- function-tool lowering and canonical alias reversal;
- MCP configuration lowering and canonical tool observation;
- public Codex sandbox controls required by the Nexus host.

`AgentRuntime` never accepts API credentials. `ProviderRuntime` never reads
Codex subscription state. Neither chooses product policy, tools, fallback,
credentials, durable identity, or effects.

### Primary Nexus modules

```text
python/nexus/services/
  generation_intent.py       provider-free content/output request
  generation_policy.py       sole operation/profile -> GenerationSpec catalog
  llm_execution.py           GenerationService semantic boundary
  llm_ledger.py              parent generation + child model-turn owner
  generation_continuations.py  bounded authenticated encryption at rest
  codex_generation_*.py      Codex adapter/private host wire only
  provider_generation_*.py   ProviderRuntime adapter/continuation loop only
  llm_credentials.py         enabled API-provider credential handle
  tool_authority.py          route-neutral principal/scope/effect authority
  tool_runtime/**            canonical declarations/plans/executor
  agent_tools_mcp.py         MCP bearer/transport adapter only
```

Do not create a second profile registry, tool catalog, executor, failure union,
or generation ledger.

### Intra-system composition

- Codex: `GenerationService` freezes the spec and parent/child identity, the
  Codex adapter sends one strict UDS command, the host opens one `AgentRuntime`
  turn, MCP translates each allowed call to `ToolAuthority`, and the adapter
  retains the complete agent terminal.
- API: `GenerationService` freezes the same facts, the provider adapter starts
  one `ProviderRuntime` call, persists its terminal/tool proposal and native
  continuation, executes the canonical tool position, appends the tool result,
  and starts the next child call until text terminal or failure.
- Both: product events derive from canonical text/tool/usage observations;
  route-native evidence remains in the ledger and never leaks into product
  authority or UI decoding.

## 5. Capability and API contracts

### Generation intent and resolved spec

`GenerationIntent` remains provider-free:

```text
GenerationIntent
  instructions: bounded text
  input: bounded text
  output: Text | JsonSchema(name, strict schema)
```

The policy resolves and freezes:

```text
GenerationSpec
  operation
  profile_id: Presence<ChatProfileId>
  route: CodexPersonalRoute | ProviderApiRoute
  model_ref
  reasoning
  bounds
  capability: FrozenSynthesis | ChatRead | ChatReadWrite
  tool_plan: Presence<FrozenToolPlan>
  policy_revision
  backend_contract_revision
  registry_revision: Presence<RegistryRevision>
  fingerprint
```

`CodexPersonalRoute` carries the fixed Codex model/effort and auth-profile
identity. `ProviderApiRoute` carries one exact `provider-runtime` target and
registry revision. Neither contains secret material. The caller cannot submit a
route, model, reasoning value, credential, retry, continuation, arbitrary tool,
or fallback policy.

The internal event boundary is a closed union:

```text
BackendEvent
  TextDelta | UsageObserved
  | ToolProposed          # API; Nexus has not executed it
  | ToolObserved          # Agent/MCP; server owns execution evidence
  | PermissionDecision | NativeDiagnostic
  | Terminal(CodexTerminal | ProviderTerminal)
```

The terminal arms retain their complete existing route evidence; nullable
lowest-common-denominator fields are forbidden. The product projection emits
only canonical text, tool activity/result, usage, failure, and terminal events.

### Tool authority

The catalog stays unchanged; profiles become:

| Capability | Exact grants |
|---|---|
| `FrozenSynthesis` | none |
| `IdeaResearchHost` | existing HostTable `web.search` only |
| `ChatRead` | `web.search`, `nexus.search`, `nexus.resource.read`, `nexus.document.search`, `nexus.resource.inspect`, `nexus.relations.list` |
| `ChatReadWrite` | `ChatRead` plus `nexus.library.add`, `nexus.note.create`, `nexus.highlight.create`, `nexus.edge.create`, `nexus.queue.add` |

`ToolAuthority` binds one frozen plan to the user, generation, run/attempt,
worker lease, admitted-resource scope, budgets, invocation position, and
effect-authority mode. MCP bearer claims and in-process API execution are two
adapters to this authority. Tool output and retrieved content can never widen
it.

API providers receive function definitions from the frozen plan. A provider
tool proposal is decoded to canonical `ToolId`, authorized, executed by the
existing `ToolExecutor`, durably recorded, then returned as a native tool-result
message. Codex receives an MCP allowlist derived from the same frozen plan; the
MCP server executes the same authority and executor. Provider aliases and MCP
wire names never become durable identity.

Read calls execute automatically. `ChatReadWrite` is created only from the
explicit `AdditiveWrites` run request. No future destructive, external-message,
purchase, share, credential, or access-control tool may reuse that grant.

### `llm-calling` additions

- Keep the existing `lower_tools()` function-call adapter; add one adjacent
  plan-derived MCP publication/observation adapter instead of renaming a stable
  public API.
- Add an additive event projection that preserves `ToolProposed` for API calls
  and `ToolObserved` for SDK/MCP calls; never flatten them into one lifecycle.
- Preserve complete route-specific terminal evidence as a tagged union.
- Expose typed Codex temporary-root/sandbox controls; remove Nexus's private
  `_codex_config()` subclass.
- Add no cross-lane runtime or fallback selector.

### Product API

`GET /api/llm/profiles` returns one strict revisioned object:

```text
ChatProfileCatalog
  revision
  default_profile_id = codex-balanced
  profiles[]
    id, intent, label, description
    executor: CodexPersonal | ProviderApi(provider_label, model_label)
    availability: Ready | OperatorActionRequired | TemporarilyUnavailable
    privacy: Subscription | StandardApi(notice) | ExceptionalRetention(notice)
```

`POST /api/chat-runs` accepts the existing message/context fields plus exactly:

```text
profile_catalog_revision
profile_id: ChatProfileId
tool_authority: {type: ReadOnly} | {type: AdditiveWrites}
```

Unknown fields and stale catalog revisions fail at ingress. Same-system SSE and
snapshot payloads expose product tool activity and the effective profile/route;
they do not expose credentials, continuations, native payloads, internal IDs,
or model reasoning.

The UI provides:

- Fast/Balanced/Deep first, Advanced provider choices second;
- provider/model/privacy and API-metering disclosure before dispatch;
- one compact, explicit additive-write grant;
- visible tool activity, receipts, Undo, and effective route in Details;
- actionable profile-catalog retry;
- an **AI & tools** readiness surface with coarse status and last check;
- Brave query disclosure on the privacy page;
- a compact mobile picker rather than three expanded rows.

No API-key entry, automatic router, price fiction, or provider control panel is
added.

## 6. Execution, durability, and failure rules

`llm_calls` is one product generation. A child `llm_model_turns` owner records
each independently accepted/billable model call. Codex has one child;
an API function-tool loop has one child per provider call. Tool invocations
remain separately journaled positions.

Each child records its position, frozen route facts/revisions, dispatch state,
provider request identity, usage/billability, and tagged terminal evidence.
The database enforces only identity, reachability, nullability, and true
uniqueness; application types enforce route/state consistency.

Provider continuation artifacts are bounded, target/codec-bound, sealed with
AES-256-GCM by `generation_continuations.py`, retained only as durable
coordination replay state, never logged/rendered, and removed under the owning
generation as soon as the next child accepts it or the parent terminates.
Associated data binds generation id, child position, target, codec, and policy
revision. Key rotation drains API generations and replaces the single key; no
multi-key compatibility reader ships. This extra sensitive state is accepted
because reconstructing or dropping native reasoning state would make crash
recovery incorrect.

Rules:

- no database transaction spans UDS, SDK, MCP, provider HTTP, or Brave I/O;
- record uncertainty before dispatch and terminal evidence before publication;
- a completed child or tool position replays without redispatch;
- pre-accept refusal reschedules only under the existing bounded policy;
- after any semantic event, accepted request, uncertain dispatch, or tool
  effect, never switch route or automatically repeat the call;
- `provider-runtime` is the sole retry owner inside one API call; Nexus owns
  durable replay/reconciliation between calls;
- Codex turns are not retried after acceptance;
- unknown provider/SDK states, invalid owned data, policy drift, and retry
  exhaustion defect unless the closed product failure union explicitly owns the
  outcome;
- manual rerun creates a new generation with visible route choice; it is not
  recovery evidence for the old generation.

API credentials are server-side only. Configuration names enabled providers
explicitly; each enabled provider requires its generation-specific credential
at process wiring. `OPENAI_API_KEY` remains embedding-only. Disabled providers
boot as `OperatorActionRequired`; an enabled provider with a missing/invalid
credential is a startup defect. API credentials never enter the Codex host.

The exact new environment surface is `GENERATION_API_PROVIDERS` plus
`OPENAI_GENERATION_API_KEY`, `ANTHROPIC_GENERATION_API_KEY`,
`GEMINI_GENERATION_API_KEY`, `MOONSHOT_GENERATION_API_KEY`, and
`DEEPSEEK_GENERATION_API_KEY`. Enabling any API provider also requires a
base64-encoded 32-byte `GENERATION_CONTINUATION_ENCRYPTION_KEY`. The
enabled-provider value is a closed, duplicate-free list. `anthropic-fable`
additionally requires the restored `NEXUS_FABLE_RETENTION_ACCEPTED_AT`
timestamp. No old generation credential name is accepted as an alias.

## 7. Hard-cut migration and reuse

PR #203 is unmerged, so rewrite its `0224` migration into the final schema; do
not stack a corrective migration over an unshipped schema.

The migration upgrades the supported pre-PR production snapshot directly to
the final parent/child ledger and profile contract, rewrites terminal history
where exact route facts exist, marks unreconstructable history ineligible for
rerun, and refuses affected nonterminal work. There is no downgrade, old-row
reader, dual writer, compatibility profile id, or runtime coercion.

Prefer semantic undelete over reimplementation for:

- the former curated profile labels/privacy notices and startup validation;
- the provider-native Chat continuation/tool loop;
- provider credential construction and deterministic protocol fixtures;
- hosted provider certification and bounded-budget evidence;
- behavior proofs whose oracle still matches this target.

Fold restored behavior into the new owners. Do **not** restore the former dual
ledger, arbitrary reasoning selector, provider-specific tool declarations,
domain-direct provider dispatch, automatic retry/fallback ownership, old
migration, compatibility decoder, or stale tests/docs.

Final cleanup deletes the superseded Codex-only spec/change report, deleted-era
profile/outcome owners, dead configuration, duplicate tests, and source-grep
tombstones. Historical Git objects are history, not compatibility.

## 8. Non-overlapping implementation lanes

One lane owns each path. If a file collision appears, sequence the lanes; do not
resolve semantic conflicts with wholesale ours/theirs.

| Lane | Exclusive paths/concern | Depends on | Exit |
|---|---|---|---|
| U | sibling `llm-calling`: tool lowering, event projection, public Codex sandbox option, its tests/docs | none | exact immutable pin with conformance green |
| P | `generation_intent.py`, `generation_policy.py`, `config.py`, `schemas/llm.py`, profile kernel proof | U contract | closed profiles/spec/config green |
| L | `db/models.py`, rewritten `0224`, `llm_execution.py`, `llm_ledger.py`, `generation_continuations.py`, reconciliation and migration/service proof | P | parent/child replay, sealed continuation, and migration green |
| T | `tool_authority.py`, `tool_runtime/**`, `agent_tool_grants.py`, `agent_tools_mcp.py`, tool authority proof | P, U | one frozen plan works through MCP and function calls |
| C | `apps/codex_agent/**`, `codex_generation_*.py`, Codex deployment/runbook/host proof | P, T, U | Codex adapter and confinement green |
| A | `provider_generation_*.py`, `llm_credentials.py`, restored provider fixtures/canaries; no domain callers | P, L, T, U | provider multi-turn adapter green |
| D | background domain services/tasks and Chat orchestration call sites | L, C, A | complete operation portfolio uses `GenerationService` |
| W | FastAPI profile/chat routes and `apps/web` profile, readiness, privacy, write-grant UX | P, D | component contract green |
| V | `testdata/**`, test controller/workflows, module docs, residue audit, final integration | all | sensitivity, PR, full, hosted, release evidence |

Lane V is the sole editor of shared proof/fault registries and workflow routing.
Every other lane owns its closest-seam proof file but does not edit the shared
registry concurrently.

## 9. Red / green / refactor and 80/20 proof

Follow [`testing-standards.md`](../local-rules/testing-standards.md).
`./scripts/test` is the only workflow verdict. Proof asserts behavior through
public boundaries, uses real owned code/PostgreSQL/Chromium where required,
stubs only external protocols, and records a meaningful red before green.

| Ownership boundary | One dominant proof | Lane |
|---|---|---|
| Policy/profile/spec | all operations and twelve Chat profiles resolve to exact closed specs; arbitrary route/model/reasoning is unrepresentable | kernel / PR |
| `llm-calling` transport projection | same frozen plan lowers to reversible function aliases and MCP allowlist; API proposal and MCP observation remain distinct | upstream conformance / U |
| Backend adapters | one shared deterministic transcript proves text, tool, continuation, usage, cancellation, and terminal behavior for each adapter without equating native evidence | service / PR |
| Durable execution | real PostgreSQL + real worker prove API model/tool/model crash replay, accepted-loss uncertainty, one parent, ordered children, no duplicate provider call/effect, and no fallback | service / PR |
| Tool authority | real PostgreSQL proves one read and one additive write through both presentations, scope/lease/write-grant rejection, identical canonical receipts, replay, and Undo | service / PR |
| Operation portfolio | every background owner resolves Codex `FrozenSynthesis`; Idea retains HostTable research; representative Metadata and Dawn owners prove terminal-before-publication | kernel + service / PR |
| Migration | empty and supported production snapshot reach one final schema; active incompatible work refuses; terminal history is preserved or explicitly ineligible | migrations / PR |
| Product API/UI | real FastAPI + Chromium prove default/Advanced profiles, readiness/privacy, catalog retry, write grant, streaming/tool activity, rerun grant reset, and mobile picker | service + component / PR |
| Public wiring | adapt the existing grounded-chat-citation journey for one Codex read and one API-provider read; add no new journey | existing journey / PR |
| External reality | Codex nightly proves each distinct Codex plan plus read-only MCP; provider certification proves each advertised API target's exact credential/model/tool continuation | protected hosted gates |

RED:

- author the target proof against the current Codex-only branch and retain its
  failing fingerprint;
- register one canonical proof owner per boundary and one representative fault
  for each critical/replacement owner;
- avoid collection-time imports of new production modules in base-sensitivity
  overlays.

GREEN:

- implement only the owner required by the failing proof;
- use a test-owned protocol-valid loopback/UDS peer for provider and Codex
  transport; ordinary PR proof performs no external calls;
- run `./scripts/test changed <path-or-node>` after each lane.

REFACTOR:

- switch all callers atomically;
- delete superseded code, tests, migration shapes, config, docs, and dependencies;
- run `./scripts/test confidence`, then clean-commit `./scripts/test pr`;
- run `full`, Codex nightly, provider certification, deployment/release gates at
  the exact candidate SHA. Missing required hosted evidence is `not_run` and
  blocks promotion.

Live certification is intentionally bounded: four Codex plan turns plus one
bounded turn per advertised API target. It proves current auth/model/tool wire,
not semantic quality for every domain operation. Deterministic policy and
domain proofs own that mapping.

## 10. Acceptance criteria

1. Every current background generation resolves to Codex Personal through one
   `GenerationService`; new Chat defaults to `codex-balanced`.
2. The exact twelve profiles above are the only Chat choices. API profiles are
   advanced, server-configured, disclosed, and selectable only when qualified.
3. One immutable `GenerationSpec` owns route, model, reasoning, bounds,
   capability, revisions, and fingerprint; callers cannot override its parts.
4. Codex and API Chat publish the same frozen canonical read or read/write plan
   and execute through one `ToolAuthority`, `ToolExecutor`, journal, citation,
   trust, effect, and Undo path.
5. Writes require a fresh explicit per-run grant. Rerun/regenerate never inherit
   mutation authority.
6. Frozen synthesis has no live tools. Existing Idea research remains
   host-planned and its final synthesis remains frozen/tool-free.
7. One parent generation records every independently accepted model turn and
   tool position. Crash/replay cannot duplicate billing or effects, and every
   committed external effect is discoverable.
8. No accepted or uncertain call automatically redispatches or changes route.
   API-call retry has one owner in `provider-runtime`; Codex has no accepted-turn
   retry.
9. Codex subscription state and API credentials remain isolated. Secrets,
   continuation payloads, prompts, and private tool data never enter logs,
   profile APIs, evidence, or the wrong process.
10. The product shows effective provider/model/privacy/readiness and actionable
    failure/retry UI without exposing API-key entry, arbitrary controls, or
    fabricated Codex price.
11. The rewritten migration reaches one final schema and refuses incompatible
    active work; no old decoder, dual writer, fallback, or compatibility branch
    remains.
12. Superseded provider and Codex-only owners are either semantically reused in
    the new owner or deleted. No duplicate profile, tool, ledger, retry, failure,
    or dispatch path survives.
13. Each ownership boundary has one behavior proof with an independent oracle,
    demonstrated sensitivity proportional to risk, and exact-SHA evidence in
    its owning gate.
14. `changed`, `confidence`, `pr`, `full`, Codex nightly, provider
    certification, migration, deployment, and release requirements are green;
    `not_run` is never acceptance.

## 11. Explicit trade-offs

- Hybrid execution adds credential, disclosure, qualification, and persistence
  work; it preserves user choice and avoids deleting already supported value.
- Curated fixed profiles give up arbitrary experimentation; they keep policy,
  replay, UX, and the certification matrix bounded.
- Background remains Codex-only in product policy; this avoids a combinatorial
  operation/provider UI and proof matrix while retaining a reusable backend
  seam.
- Capability-scoped tools reduce opportunistic autonomy; they preserve evidence
  contracts, least privilege, replay identity, and prompt-injection containment.
- A per-run write grant adds one interaction; it prevents the model from
  inferring mutation authority and makes reruns safe by default.
- MCP remains the Codex tool transport; dynamic App Server callbacks could be
  tighter later but are experimental and absent from the pinned contract.
- Child model-turn persistence and encrypted continuation state add schema and
  sensitive-state complexity; without them an API tool loop cannot recover
  honestly after a crash.
- No automatic fallback lowers availability; it preserves exact privacy, cost,
  billing, tool, and effect truth.
- Adaptive Idea research is deferred; this keeps the cutover about execution
  parity and avoids changing research quality and generation infrastructure in
  one acceptance boundary.
- Live certification spends up to thirteen bounded turns per promotion; fewer
  turns would advertise exact models whose availability/tool wire was not
  actually proven.

## 12. Authoritative references

- [Nexus testing standards](../local-rules/testing-standards.md)
- [Nexus tool runtime](nexus-tool-runtime-hard-cutover.md)
- [LLM tools library](llm-tools-library-hard-cutover.md)
- [Generation runtime composition](generation-run-harness-hard-cutover.md)
- [LLM module](../modules/llms.md)
- [Boundaries](../rules/boundaries.md)
- [Cleanliness](../rules/cleanliness.md)
- [Operation types](../rules/operation-types.md)
- [Retries](../rules/retries.md)
- [`llm-calling` provider/agent contracts](../../../llm-calling/README.md)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex App Server](https://developers.openai.com/codex/app-server/)
