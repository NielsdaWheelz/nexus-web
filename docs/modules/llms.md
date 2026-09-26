# LLMs

## Scope

Every Nexus text or structured-output generation runs through one Nexus
`GenerationService`, backed only by the two separate `llm-calling` lanes:

- Codex Personal through `AgentRuntime` and the isolated Codex host;
- configured metered APIs through `ProviderRuntime`.

The shipped developer policy selects Codex Personal for every background
operation. Chat alone lets the user choose an exact route, model, and reasoning
value for each run from the complete configured `llm-calling` catalog. There is
no generation profile, Fast/Balanced/Deep preset, user default, AI Settings
surface, fallback, or compatibility route. Embeddings and transcription remain
separate non-generation capabilities.

The product owns intent, exact selection, operation policy, tool authority,
durable coordination, and publication. `llm-calling` owns source catalog facts,
route-local lowering, provider continuations, and provider/agent protocol
events. Domain owners build prompts, accept generated output, and commit final
domain writes.

Primary owners:

- `generation_catalog.py`: composed configured catalog and readiness;
- `generation_policy.py`: one reviewed Chat seed and the total background map;
- `generation_service.py`: catalog validation, policy resolution, admission,
  and route composition;
- `generation_spec.py`: immutable admitted selection, budgets, output, and tool
  authority;
- `generation_backend.py`: route-neutral execution result;
- `codex_generation_*`: private Codex transport adapter;
- `provider_generation_*`: ProviderRuntime adapter and continuation loop;
- `llm_execution.py` and `llm_ledger.py`: parent/child/tool lifecycle and replay;
- `tool_authority.py`, `tool_runtime/`, and `agent_tools_mcp.py`: canonical
  tool authority and the API-function executor;
- `apps/codex_agent/`: isolated subscription-backed Codex host.

queue ownership is documented in [jobs.md](jobs.md).

## Catalog and exact selection

`GET /llm-catalog` is the only product catalog API. It composes the authenticated
Codex model catalog with `api_model_catalog()` rows for exactly the API providers
present in `GENERATION_API_PROVIDERS`. Nexus neither reads Codex cache files nor
maintains a second model/reasoning allowlist. A model exposes every reasoning
value the source catalog reports. the catalog keeps typed readiness for all
pairs; the picker offers only selectable pairs and retains an unavailable
current identity without substitution.

The strict Chat selection is one tagged value:

```text
CodexPersonalSelection(model_key, reasoning_key)
| ProviderApiSelection(model_ref, reasoning)
```

The tag prevents same-named models on different routes from aliasing. The
browser submits the exact selection plus the catalog-definition revision and
never submits dispatch strings, credentials, capabilities, defaults, or
fallback order. The developer-owned Codex Personal / GPT-5.6 Terra / medium
seed initializes a new composer only; it is not a saved user preference and
does not override a causal or explicit per-run selection.

Background operations resolve their exact Codex selection only from the total
source-controlled policy. Users can inspect the effective selection but cannot
edit background generation policy.

## Operation and tool policy

Every admitted run freezes one `GenerationSpec`: exact selection and dispatch
target, source/catalog/policy/backend revisions, prompt reference, conservative
budgets, output contract, timeout, host preparation, and model-tool authority.
Workers execute that snapshot and never reread mutable process policy.

Model selection does not grant tools. The operation policy independently
resolves one of:

- `NoModelTools`;
- `ChatReadAdditiveWrite` for every new chat send, rerun, and regeneration;
- `MetadataRead`;
- `LibraryDossierRead`;
- `IdeaDossierRead`.

chat uses `ExactModelTools` with `AdditiveWrites` and
`ChatAdmittedContext`: `web.search`, five nexus reads, and five owner-gated
additive writes. the prompt requires user-directed actions; existing scope,
limits, receipts, and undo govern execution. the two dossier plans grant
only the five Nexus reads over their exact frozen evidence scope. metadata
enrichment publishes `web.search`, `web.read`, `nexus.document.search`, and
`nexus.resource.read` through `MetadataRead`. no background plan grants a
write. the remaining background operations publish no model-tool
schema or MCP configuration. Idea host research remains a separate bounded,
durable three-search preparation plan.

Provider API function proposals reach the canonical `GenerationToolExecutor`,
authority checks, receipts, evidence, citations, trust, and Undo. The sole
tool-position grammar is
`generation/{generation_seq}/tool/{n}`, with a one-based ordinal monotonic
across the parent generation. An API model/tool/model loop never restarts it at
a child call. Codex model-tool plans remain ineligible until the pinned native
runtime can prove their containment; model selection cannot weaken that gate.

Untrusted tool arguments or output cannot widen the frozen plan, principal,
scope, limits, or effect authority. There is no tool-shaped text parser,
provider-native Web search, alternate executor, or transport fallback.

## Backend composition

Codex Personal uses one private UDS command/NDJSON stream. The adapter binds the
catalog-validated native model key before dispatch. This pinned host admits
only generations without model tools. The host has no database credential,
application secret, generation API key, product data mount, or TCP listener. It
owns one private per-turn root and deletes it after the pinned runtime closes.

The private authenticated MCP service at `/internal/agent-tools/mcp` remains a
separate tool boundary; the pinned Codex host does not publish or connect to
it. Restoring a tool-bearing Codex route requires a native control and effect
proof for the exact runtime, configuration, and output/tool combination.

Provider API execution uses `ProviderRuntime` with the selected configured
credential. Each independently accepted provider call is a child model turn.
Tool proposals are executed only after durable admission; the sealed,
target-bound continuation advances only after the child terminal and tool
result are persisted. Unsupported strict-output-plus-tool combinations are
rejected before dispatch rather than silently losing strictness or tools.

Both lanes project into the route-neutral `GenerationEvent` family without
importing one another. No cross-lane dispatcher shares credentials or protocol
state.

## Durable ownership and replay

One parent generation row records the frozen spec and terminal truth. One child
row records each independently accepted model call: normally one for Codex and
one per ProviderRuntime call in an API tool loop. Tool positions and their
effect receipts are separate durable children. Credentials, MCP bearers, raw
prompts, and decrypted continuation bytes never enter catalog, history,
evidence, or logs.

Completed children and tool positions replay without redispatch. A provider
loop may resume from its sealed next-child continuation; `ReDispatchable` tools
may retry after lease recovery. An unresolved external dispatch grants no retry
authority and remains suspended/terminal according to its owner contract.
There is no application entry point for resetting an uncertain generation or
attaching an out-of-band terminal result.

Subscription quota observed before Codex acceptance is capacity, not ordinary
failure. Background work enters durable `CapacityPaused`, waits for the known
reset or a bounded low-frequency recheck, and neither spends API money nor
switches models. Chat reports the typed capacity refusal directly. A capacity
error after acceptance is terminal because replay could duplicate billing or
effects.

## Product API and reset boundary

`POST /chat-runs`, rerun, and regenerate carry an explicit selection and
`catalog_definition_revision`. requests reject the retired `tool_authority`
field. policy owns new tool authority.
Chat history, SSE meta, and trust projections expose the same immutable
selection and frozen authority, including historical read-only facts, plus safe
execution disclosure. they never expose
credentials, dispatch aliases, continuation bytes, or a generation default.

The hard-cut migration deletes the complete legacy Chat aggregate and all
historical generation/metering rows. Users, media, libraries, knowledge,
resource graph data not owned by conversations, and non-conversation artifacts
remain. Consequently every surviving Chat run was admitted under this contract;
there is no legacy eligibility decoder or historical selection translation.

## Invariants

- One configured catalog is the source of every selectable Chat pair.
- One developer policy owns the Chat seed and all background selections.
- One frozen `GenerationSpec` owns selection, budgets, output, and tool policy.
- One parent/child ledger owns generation truth across both routes.
- One canonical tool authority serves eligible Chat and background operations.
- Domain owners alone accept model output and publish semantic results.
- No user generation defaults, profiles, presets, fallback, or compatibility
  path exists.
