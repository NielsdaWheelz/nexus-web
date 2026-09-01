# Generation Backends Hard Cutover

**Status:** APPROVED IMPLEMENTATION SPECIFICATION; NOT IMPLEMENTED

**Date:** 2026-08-31

**Type:** atomic hard cutover; no compatibility period

**Open questions:** none

**Supersedes:**
[`codex-personal-generation-hard-cutover.md`](codex-personal-generation-hard-cutover.md)
and its change report. Those documents describe the rejected Codex-only source
state and are deleted when this cutover turns green.
This specification also supersedes every statement in
[`nexus-tool-runtime-hard-cutover.md`](nexus-tool-runtime-hard-cutover.md) that
restricts Native/model-callable exposure, grants, bearers, journal ownership,
rollout, proof, or acceptance to Chat, or says background models receive no
grants. Its tool declarations, executor, evidence, authorization, replay, and
effect contracts remain authoritative.

## 1. Decision

Codex Personal supplies the developer-owned initial Chat seed and shipped
background selections.
For each Chat run, users may instead select any currently Chat-eligible model
and reasoning value in the complete configured `llm-calling` catalog.
Background operations use exact developer-owned selections. There are no user
generation defaults or generation controls in AI Settings.
Every generation operation may also own a closed model-callable tool policy;
each admitted run freezes one exact plan from it. Foreground/background context
and model selection never grant tools; the developer-owned operation policy
does.

There are no generation-selection profiles, presets, intent tiers, or
Fast/Balanced/Deep shortcuts.
The only selection model is:

    execution route -> exact model -> exact supported reasoning value

Nexus has one generation service, one catalog projection, one durable
generation ledger, and one canonical tool authority. Codex Personal and API
providers remain separate transport adapters below that waist.

    domain owner -> GenerationIntent -> GenerationService -> frozen GenerationSpec
                            run/policy selection |
                                                 v
                                      GenerationCatalog
                                                 |
                       +-------------------------+-------------------------+
                       |                                                   |
            CodexPersonalBackend                               ProviderApiBackend
            llm-calling AgentRuntime                           llm-calling ProviderRuntime
                       |                                                   |
               configured HTTPS MCP                              native function calls
                       +-------------------------+-------------------------+
                                                 |
                                     one Nexus ToolAuthority
                                     one ToolExecutor/journal
                                                 |
                                     typed events and terminal
                                                 |
                                     domain validation/publication

Tool parity is semantic, not transport parity. Both adapters publish the same
frozen canonical tool plan and reach the same authorization, executor,
receipts, citations, effects, and Undo owners. They do not pretend an SDK-owned
MCP turn and an application-driven API continuation loop are the same protocol.

This is a hard cut. No Codex-only path, old provider stack, profile API, dual
ledger, automatic fallback, legacy decoder, compatibility alias, or preset
survives.

## 2. Goals and non-goals

### Goals

- Keep Codex Personal as the developer-owned initial Chat seed and background
  selection.
- Expose every model and supported reasoning value from every Nexus-configured
  `llm-calling` route, including OpenRouter and xAI.
- Let the user choose the exact selection for each Chat run.
- Keep one typed, source-controlled exact selection for each background
  operation; expose no user-editable generation defaults.
- Freeze the exact selection and catalog evidence before dispatch so later
  policy or catalog drift cannot change a run.
- Give eligible Codex and API targets identical canonical Nexus tool semantics
  for every operation-owned model tool plan.
- Let background operations use bounded model-callable tools where their exact
  policy grants them; keep closed-evidence operations tool-free.
- Split read authority from additive-write authority. Chat writes require a
  fresh explicit per-run grant. The shipped background plans are read-only;
  every effect remains bounded, audited, idempotent, and undoable.
- Preserve prompts, evidence selection, output validation, citations,
  cancellation, publication transactions, and deterministic host retrieval.
- Preserve crash/replay truth across multi-call API tool loops.
- Reuse current Codex, provider, ledger, tool, policy, and proof primitives
  where their semantics fit; delete superseded owners.

### Non-goals

- Automatic routing, fallback, cascades, judges, A/B routing, or quota overflow
  from subscription usage to API spend.
- Arbitrary model IDs, arbitrary OpenRouter marketplace entries, or reasoning
  values absent from the owning `llm-calling` model row.
- API-key entry or credential management in the browser.
- Claude Code subscription execution. `llm-calling` supports that agent lane,
  but Nexus configures only Codex Personal plus ProviderRuntime API routes in
  this cutover.
- Codex shell, filesystem, native Web search, skills, plugins, subagents,
  dynamic App Server tools, or approval-requiring built-ins.
- Provider-native Web search. `web.search` remains the sole model-facing Web
  search and stays Brave-backed.
- Publishing live model tools for a `NoModelTools` run; that mode has none by
  definition.
- Replacing Idea Dossier's existing durable host-planned research. It remains
  the deterministic baseline; a separate bounded read-only model plan may
  perform follow-up retrieval.
- A new workflow engine, one lowest-common-denominator agent/API runtime,
  multi-user billing, price estimation, or zero-downtime compatibility.

## 3. Target product behavior

### 3.1 Complete configured catalog

`llm-calling` is the sole owner of source model/reasoning facts and
transport-declared capabilities. Nexus composes them with deployment
configuration, credential readiness, qualification, disclosure, and operation
eligibility; it does not maintain a second model list.

| Route | Catalog source | Product inclusion |
|---|---|---|
| Codex Personal | new public AgentRuntime model-catalog capability backed by the authenticated native model list | every visible model and every reasoning value reported for it; hidden/internal models remain absent |
| Provider API | new immutable `api_model_catalog()` projection over ProviderRuntime's registry | every projected row whose provider is present in `GENERATION_API_PROVIDERS`; there is no second allowlist |

The Codex list is account- and time-dependent. It is fetched through
`llm-calling`; Nexus must not read `models_cache.json`, scrape CLI output,
or hard-code a second Codex list. Retired, unavailable, or no-longer-visible
targets remain representable in developer-policy diagnostics and generation
history, but cannot start a new run.

At the pinned `llm-calling` revision, the ProviderRuntime catalog is exactly:

| Provider | Model reference | Supported reasoning | Source default |
|---|---|---|---|
| OpenAI | `openai:gpt-5.6-sol` | `none, low, medium, high, xhigh, max` | `high` |
| OpenAI | `openai:gpt-5.6-terra` | `none, low, medium, high, xhigh, max` | `high` |
| OpenAI | `openai:gpt-5.6-luna` | `none, low, medium, high, xhigh, max` | `high` |
| Anthropic | `anthropic:claude-sonnet-5` | `low, medium, high, xhigh, max` | `high` |
| Anthropic | `anthropic:claude-fable-5` | `low, medium, high, xhigh, max` | `high` |
| Gemini | `gemini:gemini-3.5-flash` | `minimal, low, medium, high` | `medium` |
| Moonshot | `moonshot:kimi-k3` | `low, high, max` | `max` |
| OpenRouter | `openrouter:kimi-k3` | `low, high, max` | `max` |
| DeepSeek | `deepseek:deepseek-v4-pro` | `none, high, max` | `high` |
| DeepSeek | `deepseek:deepseek-v4-flash` | `none, high, max` | `high` |
| xAI | `xai:grok-4.5` | `low, medium, high` | `high` |

“Complete” means every visible Codex model plus exact set equality with the
`api_model_catalog()` rows belonging to configured API providers. The full-provider
fixture configures all seven families above and therefore exposes all eleven
API rows, including OpenRouter and xAI. Unconfigured providers are absent, not
presented as a credential marketplace. Complete does not mean every model a
vendor sells, hidden Codex rows, unpinned gateway routing, or an unconfigured
agent backend.

The composed catalog is nested route -> model -> reasoning, but eligibility is
owned by the exact model/reasoning pair. It exposes:

- route/provider identity, human label, billing class, privacy/retention and
  processor chain, route readiness, reason, recovery action, and last check;
- per model: stable key, label, `Active | Retiring | Retired` lifecycle, and
  model readiness with reason, recovery action, and last check;
- per reasoning row: key, label, readiness, a product-facing Chat selection
  state, and references to its target-capability and reasoning-wire
  qualification evidence;
- source-observed input facts and source-default reasoning, which must name one
  present, transport-supported reasoning row; and
- Nexus qualification for streaming, strict structured output, continuation,
  and route-neutral model-tool transport. The product-facing `chat_state`
  composes both `ChatRead` and its `ChatReadAdditiveWrite` extension; background
  plan eligibility composes server-internally from the same receipts.

Codex native visibility and upgrade/retirement metadata are typed source facts;
API rows carry equivalent curated facts. `UpgradeFacts(target_key)` and
`RetirementFacts(retires_at)` are independent `Presence` fields. Upgrade alone
never implies a deadline. The lifecycle truth table is exact:

| Present source facts at observation | Product lifecycle |
|---|---|
| visible; no explicit `retires_at` | `Active` |
| visible; explicit future `retires_at` | `Retiring` |
| visible; `retires_at` reached | `Retired` |
| no longer visible | absent from live catalog; history-only unavailable state |

`Retiring` remains selectable while ready and before its boundary; `Retired`
never does. The catalog observation expires at the nearest retirement instant,
and crossing it produces a new product definition revision. Lifecycle is
semantic catalog data; quota, credential, host, and health observations are
volatile readiness data.

A source-present target that becomes unready or retired remains focusable,
visible, and explained in the catalog but is not selectable. A source-absent or
unconfigured run selection remains a contextual unavailable row in Chat
history, not a general browse choice; a matching developer-policy selection is
a configuration failure. Neither is normalized or used as a fallback. No pair
is operation-eligible unless both its
target-capability proof and reasoning-wire proof are current for the catalog
definition.

### 3.2 Exact selections, not profiles

Within Chat—the only user-selectable generation surface—an exact
`GenerationSelectionSpec` is the only selectable value:

    CodexPersonalSelection
      model: AgentModelKey
      reasoning: AgentReasoningKey

    ProviderApiSelection
      model_ref: ProviderModelRef
      reasoning: ReasoningLevel

`model_ref` already owns provider identity; no duplicate provider field is
stored in that arm. The tagged route prevents an OpenAI API model from being
confused with the same model name on Codex Personal.

`AgentModelKey` is the stable native catalog `id`, not the SDK dispatch string.
The source catalog carries `dispatch_model` for server-side resolution only;
it never crosses the product API. `GenerationSpec` and the ledger snapshot the
key, resolved dispatch target, Agent definition revision, and row fingerprint
under the product catalog definition. The browser submits only the key.

The browser never submits labels, native wire IDs, credentials, engine IDs,
capability claims, defaults, or fallback order. Nexus validates the complete
Chat selection against the named catalog definition and Chat eligibility before
creating durable work; background selection is exclusively policy-resolved.
Unsupported combinations fail as
`InvalidGenerationSelection`; a known but non-runnable choice fails as
`GenerationSelectionUnavailable`.

### 3.3 Chat

- An empty new-conversation draft seeds its composer from the catalog's
  developer-owned `chat_seed`; refresh never overwrites an existing draft.
- The composer always shows the exact backend/provider, model, and reasoning.
- The user may change all three before every run.
- A dispatched run freezes that exact selection; it writes no preference.
- The next draft starts from the last selection used in that conversation.
- Rerun/regenerate starts from the source run's exact selection, permits an
  explicit replacement, and always creates a new generation.
- Rerun/regenerate resets write authority to read-only.
- If the selected target becomes unavailable before creation, dispatch is
  refused with an actionable link to choose another target. There is no
  substitution.

The picker is one searchable, keyboard-accessible control with progressive
columns: backend/provider, model, reasoning. Desktop may use a popover; mobile
uses a sheet. It does not contain Fast, Balanced, Deep, Auto, Recommended,
profile cards, preset chips, or intent aliases.

Before confirmation, each candidate shows subscription versus metered API,
provider/processor chain, privacy/retention, readiness, and last check. The
closed trigger stays compact: route/provider, model, and reasoning.

Changing model initializes a visible, uncommitted reasoning choice from that
model's source default. If that row is not ready and eligible for Chat, it stays
visible but confirmation remains disabled until the user explicitly chooses a
runnable row. Confirm is enabled only for the server-projected `Selectable`
state; the browser does not reconstruct policy. The compound choice is not used
until confirmation.

Catalog-load failure preserves the draft, disables Send, and shows inline
Retry. A temporarily unavailable `chat_seed` does not block the picker: it is
focusable, explained, and announced, while Send requires an explicit
`Selectable` replacement. A refresh failure after one valid decode preserves
that exact semantic catalog, labels its readiness observation stale, and offers
Retry; dispatch still performs the server readiness check. A refresh-required
result preserves the uncommitted selection, reloads and revalidates it, and
requires a new confirmation. No failure path resets the draft to the seed or
another model.

Rerun opens the same picker preselected to the source selection. Confirming it
unchanged is allowed only while ready; an unavailable source blocks until an
explicit replacement is confirmed. `chat_seed` is never consulted.
Both unchanged and replacement reruns reset write authority.

The trigger names its current selection and implements `aria-haspopup`,
`aria-expanded`, and `aria-controls`. The labelled popover/sheet traps focus,
sets initial focus, supports Escape, backdrop and mobile Back dismissal, and
returns focus to the trigger. Search is a combobox controlling a listbox with
`aria-activedescendant`; Arrow keys, Home/End, Enter, and Escape work. Reasoning
is a labelled radio group or select. Unavailable rows remain focusable for their
explanation, status changes are announced, and Confirm stays disabled until a
complete ready pair exists.

### 3.4 Developer-owned generation policy

`generation_policy.py` owns one typed, source-controlled, content-derived policy
revision, one Chat seed, and a total
`BackgroundOperationKey -> BackgroundOperationPolicy` map. There is no
generation Settings page, preference API, or user generation-preference
persistence.

| Product label | Operation key | Shipped exact selection | Host preparation | Model tool plan |
|---|---|---|---|---|
| Metadata enrichment | `metadata_enrichment` | Codex Personal / `gpt-5.6-luna` / `low` | none | `NoModelTools` |
| Media summary | `media_summary` | Codex Personal / `gpt-5.6-luna` / `low` | none | `NoModelTools` |
| Synapse | `synapse` | Codex Personal / `gpt-5.6-luna` / `low` | none | `NoModelTools` |
| Dawn | `dawn_write` | Codex Personal / `gpt-5.6-terra` / `medium` | none | `NoModelTools` |
| Oracle | `oracle` | Codex Personal / `gpt-5.6-terra` / `medium` | none | `NoModelTools` |
| Page dossier | `dossier_page` | Codex Personal / `gpt-5.6-luna` / `low` | none | `NoModelTools` |
| Note dossier | `dossier_note` | Codex Personal / `gpt-5.6-luna` / `low` | none | `NoModelTools` |
| Media dossier | `dossier_media` | Codex Personal / `gpt-5.6-terra` / `medium` | none | `NoModelTools` |
| Conversation dossier | `dossier_conversation` | Codex Personal / `gpt-5.6-terra` / `medium` | none | `NoModelTools` |
| Library dossier | `dossier_library` | Codex Personal / `gpt-5.6-terra` / `high` | none | `LibraryDossierRead` |
| Podcast dossier | `dossier_podcast` | Codex Personal / `gpt-5.6-terra` / `high` | none | `NoModelTools` |
| Contributor dossier | `dossier_contributor` | Codex Personal / `gpt-5.6-terra` / `high` | none | `NoModelTools` |
| Idea dossier | `dossier_idea` | Codex Personal / `gpt-5.6-terra` / `high` | existing `IdeaHostResearch` | `IdeaDossierRead` |
| Idea resolution | `dossier_idea_resolve` | Codex Personal / `gpt-5.6-luna` / `low` | none | `NoModelTools` |

`LibraryDossierRead` grants `nexus.search`, `nexus.resource.read`,
`nexus.document.search`, `nexus.resource.inspect`, and
`nexus.relations.list`. Its scope contains the admitted Library subject and the
exact viewer-visible ResourceRefs in the frozen Library input manifest. Search
is filtered to those refs, and relation results omit endpoints outside them.
Its exact `RunLimits` are 16 calls, zero external attempts, 256 KiB cumulative
input, 4 MiB cumulative output, one call in flight, and 120 seconds elapsed.

`IdeaDossierRead` grants the same five Nexus read tools over the admitted Idea
subject and the exact viewer-visible ResourceRefs in the frozen Idea evidence
ledger. Search is filtered to those refs, and relation results omit endpoints
outside them. Its exact limits are 12 calls, zero external attempts, 128 KiB
cumulative input, 2 MiB cumulative output, one call in flight, and 120 seconds
elapsed. The existing
`IdeaHostResearch` independently owns exactly three Brave-backed `web.search`
steps: six maximum external attempts, 12,288 cumulative input bytes, 98,304
cumulative output bytes, one call in flight, and 60 seconds elapsed. An
unattended model turn never holds private Nexus reads and external-Web egress in
the same plan.

`NoModelTools` publishes no model-callable tool schema or MCP configuration.
The two named read plans are internal capability identities, not product
profiles or defaults. Each freezes exact grants, declaration/binding revisions,
per-tool limits, run limits, exposure, effect mode, scope derivation, and the set
of bindings required at admission. All five bindings are required for each
named background read plan. No background plan grants a write.

The Chat seed is Codex Personal / `gpt-5.6-terra` / `medium`. Selection and tool
policy values are exact, not `routine`, `standard`, `thorough`, `deep`, `fast`,
or `balanced` aliases. Developers change them only through reviewed source and
a deployment.

Release/startup validation requires every policy selection to exist and be
qualified for its operation's output and every policy-permitted model tool
plan, and every tool plan to compose from current declarations and bindings. A
missing, unsupported, retired, ineligible, or invalid pair/plan is a
configuration defect; temporary selection or required-tool unavailability
leaves the service up but blocks that operation at admission. Admission reads
one immutable policy object, resolves and validates its exact selection and tool
authority outside the database transaction, then atomically persists the parent
`GenerationSpec` and enqueues it.
Workers never reread process policy. Concurrent old/new deployments therefore
admit a complete old or new revision; neither can alter queued or running work.
A manual background rerun/rebuild is a fresh admission under the current
developer policy; users cannot replace its selection. Run/activity detail may
show the effective background selection and disclosure read-only.

## 4. Architecture and ownership

### Nexus owns

- configured route composition and product-facing catalog projection;
- developer generation policy, exact Chat-run selection, readiness, privacy,
  and billing copy;
- operation bounds and capability policy;
- credentials and process wiring;
- durable generation, model-turn, tool-position, and effect identity;
- tool catalog, grants, scope, budgets, execution, receipts, citations, trust,
  Undo, and cancellation;
- prompts, evidence, output schemas, validation, and publication;
- product API, SSE, and UI.

### `llm-calling` owns

- separate ProviderRuntime and AgentRuntime contracts;
- a public, typed AgentRuntime model catalog and selection validation;
- the ProviderRuntime model registry and exact reasoning wire facts;
- provider/SDK transport, native continuations, event normalization, usage,
  request identity, and per-call retry classification;
- function-tool lowering and canonical alias reversal;
- MCP configuration lowering and canonical tool observation;
- public Codex sandbox controls required by Nexus.

AgentRuntime never accepts API credentials. ProviderRuntime never reads Codex
subscription state. Neither chooses Nexus policy selections, operation authority,
credentials, durable identity, effects, or fallback.

### Composition

`GenerationCatalogService` creates one immutable projection from:

- AgentRuntime's authenticated Codex catalog definition revision and row
  fingerprints;
- the normalized `api_model_catalog()` rows for configured providers and
  their row fingerprints;
- Nexus enabled-provider configuration;
- Nexus lifecycle mapping, catalog-visible Chat eligibility/capability,
  target/reasoning qualification, and disclosure revisions.

The semantic `definition_revision` fingerprints those facts. It does not hash
the global provider-registry revision, so an unconfigured provider change
cannot invalidate an open form; that global revision remains ledger
provenance. Readiness and health are volatile observations with their own
`observed_at`; they do not change the definition revision. Dispatch rechecks
semantic validity and current readiness. `definition_revision` excludes
`GenerationPolicy.revision`, `chat_seed`, and exact background mappings. A
policy change affects it only when it changes a projected `chat_state` or
another catalog fact; seed- or background-only changes do not stale an explicit
Chat selection. This is the only catalog consumed by API schemas, Chat, policy
resolution, and ledger creation.

The Codex adapter obtains `AgentModelCatalog` through a typed command on the
existing confined host/UDS boundary; only its normalized, non-secret facts
cross into Nexus. The web/API process never opens the Codex SDK or reads its
state directory.

`GenerationPolicy` owns its revision, the Chat seed, and each background
operation's exact selection plus `OperationWorkflowSpec`: bounds, output
contract, timeout, optional host preparation, closed model tool policy, effect
mode, limits, and scope derivation. It contains no model tiers, aliases, user
overrides, or fallback. Both Chat and background admission read one immutable
`GenerationPolicy`; workflow and policy revision come from that object, and
background selection does too. Catalog validation uses one catalog snapshot;
tool composition uses one immutable tool-runtime snapshot. `GenerationService`
resolves the permitted policy arm, freezes one exact `GenerationSpec`, and
rechecks volatile readiness immediately before dispatch without changing that
spec. A worker constructs authority only from the frozen spec and admitted
domain scope, never current process policy.

### Primary files

    sibling llm-calling/
      src/provider_runtime/registry.py
      src/provider_runtime/agent_runtime/model_catalog.py
      src/provider_runtime/agent_runtime/types.py
      src/provider_runtime/tool_adapter.py
      src/provider_runtime/generation_events.py

    python/nexus/services/
      generation_catalog.py
      generation_selection.py
      generation_intent.py
      generation_policy.py
      llm_execution.py
      llm_ledger.py
      generation_continuations.py
      codex_generation_*.py
      provider_generation_*.py
      llm_credentials.py
      tool_authority.py
      agent_tool_grants.py
      tool_runtime/**
      agent_tools_mcp.py

    python/nexus/
      schemas/llm.py
      api/routes/llm.py
      api/routes/chat*.py
      db/models.py
      db/migrations/versions/0224_*.py

    apps/web/src/
      components/chat/**
      lib/llm/**

    docs/
      modules/llms.md
      modules/chat.md
      architecture.md

Do not create a second model registry, profile registry, tool catalog, executor,
failure union, retry owner, or generation ledger.

## 5. Capability and API contracts

### 5.1 Resolved generation

`GenerationIntent` remains provider-free:

    GenerationIntent
      instructions: bounded text
      input: bounded text
      output: Text | JsonSchema(name, strict schema)

Policy first resolves route-neutral workflow authority:

    GenerationPolicy
      revision
      chat: ChatPolicy
      background_operations:
        BackgroundOperationKey -> BackgroundOperationPolicy

    ChatPolicy
      seed: GenerationSelectionSpec
      workflow: OperationWorkflowSpec

    BackgroundOperationPolicy
      selection: GenerationSelectionSpec
      workflow: OperationWorkflowSpec

    OperationWorkflowSpec
      operation
      bounds
      output_contract
      host_tool_plan: Presence<HostResearchPlan>
      model_tool_policy:
        NoModelTools
        | ExactModelTools(
            plan: FrozenToolPlan,
            effect_mode: ReadOnly | AdditiveWrites,
            scope_derivation: ToolScopeDerivation
          )
        | ChatPerRunTools(
            read_plan: FrozenToolPlan,
            additive_write_plan: FrozenToolPlan,
            scope_derivation: ChatAdmittedContext
          )

    ToolScopeDerivation
      ChatAdmittedContext
      | LibraryDossierManifest
      | IdeaDossierEvidenceLedger

Admission resolves that policy to one closed runtime mode:

    ResolvedModelToolMode
      NoModelTools
      | ModelTools(
          plan: FrozenToolPlanSnapshot,
          effect_mode: ReadOnly | AdditiveWrites,
          scope: FrozenToolScope
        )

`GenerationPolicy.revision` hashes the canonical `ChatPolicy` and complete
ordered background map, including every selection and workflow fact. It
excludes catalog definitions, readiness, and runtime health.

Host preparation and model-callable tools are separate explicit axes because
Idea Dossier legitimately uses both. A host plan is never exposed to the model.
`dossier_idea` retains the current bounded `IdeaHostResearch` and then receives
exact `IdeaDossierRead`; `dossier_library` receives exact
`LibraryDossierRead`; the other twelve background rows receive `NoModelTools`.
Chat has no host plan. `ChatPerRunTools` resolves only to `ChatRead`/`ReadOnly`
or, after an explicit request, the complete
`ChatReadAdditiveWrite`/`AdditiveWrites` plan. Every operation passes through
the same tool-capable generation service even when its frozen policy publishes
no model tools.

The domain owner completes or replays any host preparation and freezes its
evidence/manifest before generation admission. Scope derivation consumes only
that immutable domain input: Chat's admitted context, Library Dossier's exact
revision manifest, or Idea Dossier's frozen research evidence. It returns one
bounded, data-only `FrozenToolScope` containing canonical admitted refs and
closed predicate descriptors plus its digest. It never persists executable code.
Dispatch-time authorization may narrow that scope after access loss; it can
never add a resource or relation that admission did not authorize.

`GenerationService` freezes:

    GenerationSpec
      operation
      selection: GenerationSelectionSpec
      selection_source: ChatRun | BackgroundPolicy
      bounds
      output_contract
      host_tool_plan_snapshot: Presence<FrozenHostToolPlan>
      host_evidence_revision: Presence<HostEvidenceRevision>
      model_tool_plan_snapshot: Presence<FrozenToolPlanSnapshot>
      tool_effect_mode: Presence<ReadOnly | AdditiveWrites>
      admitted_tool_scope: Presence<FrozenToolScope>
      admitted_tool_scope_digest: Presence<ToolScopeDigest>
      catalog_definition_revision
      policy_revision
      backend_contract_revision
      provider_registry_revision: Presence<RegistryRevision>
      fingerprint

The structured selection and resolved tool authority snapshot are persisted,
not only mutable catalog or plan keys. `NoModelTools` maps every tool field to
owned `Absent`; either tool-bearing policy arm resolves to one exact plan and
maps every field to `Present`. A `ChatPerRunTools` admission cannot combine or
partially project its two alternatives. The fingerprint includes the exact
selection, catalog-definition and policy revisions, host/model plans, effect
mode, canonical scope plus digest, budgets, and every other dispatch-affecting
fact. Credentials, bearer values, and opaque continuations are never part of the
spec.

The backend event boundary remains a closed union:

    BackendEvent
      TextDelta | UsageObserved
      | ToolProposed
      | ToolObserved
      | PermissionDecision | NativeDiagnostic
      | Terminal(CodexTerminal | ProviderTerminal)

`ToolProposed` means an API call awaits Nexus execution.
`ToolObserved` means an SDK/MCP path already executed through the server.
Both variants are operation-neutral. Route-specific terminals retain their
complete native evidence.

### 5.2 Catalog and Chat API

`GET /api/llm/catalog` returns one strict object:

    GenerationCatalog
      definition_revision
      observed_at
      chat_seed:
        policy_revision
        selection: GenerationSelectionSpec
        state: SelectionState
        presentation: labels, billing, privacy, processor_chain
      routes[]
        route: CodexPersonal | ProviderApi(provider)
        label
        readiness: Readiness
        billing
        privacy
        processor_chain
        models[]
          key
          label
          lifecycle: Active | Retiring | Retired
          retires_at: Presence<RetiresAt>
          upgrade_target: Presence<UpgradeTarget>
          readiness: Readiness
          input_modalities[]
          qualified_capabilities
          source_default_reasoning
          reasoning[]
            key
            label
            readiness: Readiness
            chat_state: SelectionState
            target_qualification_revision
            reasoning_wire_qualification_revision

    Readiness
      Ready(last_checked)
      | OperatorActionRequired(code, explanation, action, last_checked)
      | TemporarilyUnavailable(code, explanation, action, last_checked)

    SelectionState
      Selectable
      | NonSelectableState

    NonSelectableState
      Ineligible(code, explanation)
      | OperatorActionRequired(code, explanation, action, last_checked)
      | TemporarilyUnavailable(code, explanation, action, last_checked)
      | Retired(explanation, upgrade_target: Presence<GenerationSelectionSpec>)

Routes, models, and reasoning rows use canonical server order and contain no
duplicates. Each source default equals exactly one reasoning key in its model.
`chat_seed` names one exact catalog pair and is returned atomically with its
current state and disclosure. `chat_seed.policy_revision` is exactly the
enclosing `GenerationPolicy.revision` from the immutable policy snapshot that
supplied the seed; it is not a seed-only or catalog revision. That revision is
separate from the semantic catalog definition, so a policy-only deployment does
not stale an open choice; caches key both revisions. `Selectable` already
incorporates route, model, reasoning, lifecycle, qualification, and Chat policy;
the browser derives none of them. Background operation eligibility remains
server-internal. The seed initializes only a new composer. `POST /api/chat-runs`
always requires an explicit exact selection and never interprets omission as the
seed; it intentionally omits a policy revision because admission reads current
workflow policy and the request supplies an explicit selection.

No credential, native continuation, price estimate, internal engine, hidden
model, private account fact, raw health diagnostic, or background-policy
selection crosses this API. There is no generation-settings query or mutation.

`POST /api/chat-runs` accepts the existing message/context fields plus:

    catalog_definition_revision
    selection: GenerationSelectionSpec
    tool_authority: ReadOnly | AdditiveWrites

Unknown fields and malformed tagged unions fail at ingress. A stale catalog
definition returns an explicit refresh-required outcome; it never reinterprets
the submitted selection. A health change returns the current unavailable
outcome without masquerading as semantic catalog drift.

Create responses, Chat history/message reads, and initial SSE metadata all
carry the same immutable projection:

    RunSelectionOut
      ReconstructableRunSelection(
        selection: GenerationSelectionSpec,
        catalog_definition_revision,
        display_at_dispatch: labels, billing, privacy, processor_chain
      )
      | RerunIneligibleRunSelection(
          reason,
          action,
          historical_display: Presence<HistoricalDisplaySnapshot>
        )

Only reconstructable rows carry an exact selection. These are safe
dispatch-time facts, not current catalog claims. The browser uses this server
projection—not draft or cache state—for reload, reconnect, and historical
rerun. A reconstructable but currently unavailable source opens preselected and
requires explicit replacement; an unreconstructable source cannot rerun and is
never assigned fabricated selection facts.

The existing canonical API failure owner gains these strict variants:

    InvalidGenerationSelection(code, field: Presence<Field>, explanation)
    | GenerationSelectionUnavailable(selection, state: NonSelectableState)
    | CatalogDefinitionStale(current_definition_revision)
    | RerunIneligible(reason, action)

Invalid ingress maps to HTTP 422; the other variants map to HTTP 409. API and
browser decoders reject unknown fields/variants. Every variant preserves the
draft or uncommitted choice and supplies typed recovery; none retries,
substitutes, or parses status text.

The old `GET /api/llm/profiles`, `profile_id`,
`profile_catalog_revision`, `ChatProfile`, fixed effort labels, and profile
inheritance fields are deleted with no aliases.

### 5.3 Tool authority

| Authority/plan | Exact grants |
|---|---|
| `NoModelTools` | none; no schemas or MCP configuration are published |
| `IdeaHostResearch` | existing HostTable `web.search` only; outside the model turn |
| `LibraryDossierRead` | `nexus.search`, `nexus.resource.read`, `nexus.document.search`, `nexus.resource.inspect`, `nexus.relations.list` |
| `IdeaDossierRead` | `nexus.search`, `nexus.resource.read`, `nexus.document.search`, `nexus.resource.inspect`, `nexus.relations.list` |
| `ChatRead` | `web.search` plus the five Nexus reads above |
| `ChatReadAdditiveWrite` | `ChatRead` plus `nexus.library.add`, `nexus.note.create`, `nexus.highlight.create`, `nexus.edge.create`, `nexus.queue.add` |

Model selection never selects tools. The operation selects its reviewed host
and model plans independently. Every Chat-eligible exact selection must be
qualified for both `ChatRead` and `ChatReadAdditiveWrite`; a read-only run
publishes only the former. Every exact selection named by developer background
policy must be qualified for that operation's text or strict structured-output
contract and exact model plan; `NoModelTools` requires no tool-wire
qualification. Background eligibility stays internal and does not create a
settings or catalog API.

`ToolAuthority` binds a frozen plan to user, generation, run/attempt, worker
lease, admitted resources, budgets, invocation position, and effect mode. MCP
bearers and API function execution are adapters to this same authority. Tool
output cannot widen it.

Reads execute automatically. Chat receives `ChatRead` at admission and can
receive `ChatReadAdditiveWrite` only after an explicit `AdditiveWrites` request.
Background admission automatically authorizes only the exact developer-owned
read plan in section 3.4; no background run pauses for approval or gains a
write. The same authenticated MCP mount and bearer shape serve every Codex
`ModelTools` run, and the same function-call executor serves every API
`ModelTools` run. There is no Chat-only tool executor, endpoint, or journal.

Every successful model read becomes immutable tool evidence tied to its durable
position and may become a citation candidate only through the owning domain's
existing evidence adapter. Output validation and final publication remain with
the domain owner. For Dossiers, that adapter deduplicates the read against the
existing build evidence ledger and returns its stable candidate identity before
the model continues; output validation accepts only registered candidates.
Known unavailability of a plan-required binding blocks admission; an
unavailability first observed mid-turn is returned as the typed tool result.
Neither case drops the plan, substitutes a tool, or switches the model. No
destructive, external-message, purchase, share, credential, or access-control
tool may reuse any grant.

### 5.4 `llm-calling` additions

- Add one public AgentRuntime query:

      AgentModelCatalog
        backend_contract_revision
        definition_revision
        native_revision: Presence<NativeCatalogRevision>
        observed_at
        models[]: AgentModelFacts

      AgentModelFacts
        key: AgentModelKey             # stable native id
        dispatch_model                 # server-only SDK value
        label
        input_modalities[]
        reasoning[]: AgentReasoningFacts(key, label, native_wire_value)
        source_default_reasoning
        upgrade: Presence<UpgradeFacts(target_key)>
        retirement: Presence<RetirementFacts(retires_at)>
        row_fingerprint

  It consumes the pinned SDK's authenticated, paginated public `model/list`,
  returns every non-hidden row in native order, rejects duplicate keys or
  incomplete pagination, and preserves typed upgrade/retirement facts rather
  than claiming the native response supplies Nexus lifecycle. The source
  default must name exactly one reasoning row. Claude returns
  `UnsupportedCapability`; Nexus does not configure that lane.

  `definition_revision` is a domain-separated hash of the canonical ordered
  row fingerprints and is stable for identical observations. Each row
  fingerprint covers key, dispatch value, label, ordered reasoning keys/native
  values/default, modalities, and exact upgrade/retirement source facts. It
  excludes `observed_at` and the optional opaque native revision, which are
  provenance only.
- Keep backend request contracts tagged:

      CodexCatalogSessionRequest(
        model_key, reasoning, agent_definition_revision, row_fingerprint, ...
      )
      | ClaudeNativeSessionRequest(existing Claude contract)

  The Codex arm validates all catalog-bound facts and resolves
  `dispatch_model` inside AgentRuntime before billable work; free-form Codex
  pass-through is impossible. Its optional validated MCP configuration is
  operation-neutral: absent means `NoModelTools`, present means the exact
  plan-derived allowlist and bearer. No `chat` literal controls SDK tool access.
  The Claude arm does not require an unsupported catalog, and Nexus can
  construct only the Codex arm.
- Add one immutable ProviderRuntime query:

      ApiModelCatalog
        registry_revision
        definition_revision
        models[]: ApiModelFacts

      ApiModelFacts
        model_ref: ProviderModelRef
        provider
        dispatch: model_id, engine, base_url, correlation, routing
        upgrade: Presence<UpgradeFacts(target_key)>
        retirement: Presence<RetirementFacts(retires_at)>
        context_window
        max_output_tokens
        input_modalities[]
        tools
        streaming
        structured: Native | JsonMode
        reasoning[]: ApiReasoningFacts(key, native_wire_fragment)
        source_default_reasoning
        continuation_codec
        row_fingerprint

  `api_model_catalog()` is the sole public catalog oracle. Its canonical tuple
  is duplicate-free, every default is a member of its nonempty reasoning tuple,
  and its definition revision is content-derived. A row with no native
  reasoning knob projects the explicit `none` selection. Nexus never imports
  or compares private `registry.ROWS`; catalog equality, filtering, revisions,
  and proofs all use this API.
- Promote provider-documented default reasoning from commentary into validated
  row data. Nexus filters the public tuple only by configured provider and does
  not recreate source defaults or a model allowlist.
- Keep readiness and Nexus capability qualification outside both source
  catalogs. Native model-list or registry presence and credential presence are
  not proof of successful generation, strict output, tools, or quota.
- Keep the existing operation-neutral function-tool adapter and add an adjacent
  plan-derived MCP publication/observation adapter. Both accept only the frozen
  canonical plan; neither chooses tools from product operation names.
- Add an additive event projection that preserves API proposals and MCP
  observations as distinct states.
- Preserve full route-specific terminal evidence as a tagged union.
- Expose typed Codex temporary-root/sandbox controls; remove Nexus's private
  configuration subclass.
- Add no cross-lane dispatcher, credential broker, product defaults, or
  fallback selector.

## 6. Persistence, execution, and security

### Ledger

`llm_calls` is one product generation. Child `llm_model_turns` records each
independently accepted/billable model call. Codex normally has one child; an
API function-tool loop has one child per provider call. Tools retain separate
journaled positions.

Each generation snapshots selection, resolved server dispatch target, source,
catalog/policy/backend revisions, host preparation, exact model tool plan,
effect mode, admitted scope and digest, limits, bounds, safe dispatch-time
display/disclosure, rerun reconstructability, and fingerprint. Each child
records route-native dispatch state, request identity, usage/billability, and
tagged terminal evidence. Each tool position records canonical id/input digest,
plan/binding revisions, scope and budget identity, result evidence, effect
identity where applicable, settlement, and replay status.

After a background worker owns the admitted attempt and lease, it mints a
short-lived bearer solely from that frozen snapshot. A bearer cannot outlive the
worker lease or transport deadline. Chat and background use the same claim
schema; their different authority comes only from the frozen plan, effect mode,
scope, and budgets. `NoModelTools` mints no bearer.

Provider continuation artifacts are bounded, target/codec-bound, sealed with
AES-256-GCM, never logged/rendered, and deleted when consumed or terminal.
Associated data binds generation, child position, target, codec, and policy.
Key rotation drains API generations and replaces the single key; no
compatibility reader ships.

### Failure and replay rules

- no database transaction spans UDS, SDK, MCP, provider HTTP, or Brave I/O;
- record uncertainty before dispatch and terminal evidence before publication;
- completed children and tool positions replay without redispatch;
- API model/tool/model continuation may resume only from its sealed next-child
  state; Codex MCP observations remain positions inside its single native turn;
- pre-accept refusal reschedules only under the existing bounded policy;
- after semantic output, accepted/uncertain dispatch, or a tool effect, never
  automatically repeat or switch selection;
- ProviderRuntime alone owns retry inside one API call; Nexus owns durable
  continuation between calls;
- Codex turns are not retried after acceptance;
- a transiently unavailable background selection or required tool blocks only
  that operation and never falls back to another selection, tool, plan, or
  `NoModelTools`;
- a background run is noninteractive: an approval request, out-of-plan call,
  widened scope, expired lease, or exhausted budget is refused rather than
  suspended for user input;
- manual rerun is a new generation, not recovery evidence.

### Configuration

`GENERATION_API_PROVIDERS` is a closed, duplicate-free configured subset of:

    openai, anthropic, gemini, moonshot, openrouter, deepseek, xai

The product catalog contains exactly the `api_model_catalog()` rows for that
subset.
Unconfigured providers are absent. The reference full-catalog fixture
configures all seven and proves all eleven rows, including OpenRouter and xAI.
A configured provider requires its generation-specific credential at startup:

- `OPENAI_GENERATION_API_KEY`
- `ANTHROPIC_GENERATION_API_KEY`
- `GEMINI_GENERATION_API_KEY`
- `MOONSHOT_GENERATION_API_KEY`
- `OPENROUTER_GENERATION_API_KEY`
- `DEEPSEEK_GENERATION_API_KEY`
- `XAI_GENERATION_API_KEY`

Any configured API provider also requires one base64-encoded 32-byte
`GENERATION_CONTINUATION_ENCRYPTION_KEY`. Anthropic Fable additionally
requires `NEXUS_FABLE_RETENTION_ACCEPTED_AT`.
`OPENAI_API_KEY` remains embedding-only. API credentials never enter the
Codex host, product API, evidence bundle, or logs.

## 7. Hard-cut migration and deletion

PR #203 is unmerged. Rewrite its `0224` migration into the final schema; do
not stack a corrective migration over an unshipped shape.

The migration:

- creates only the final parent/child ledger owners; it creates no generation
  preference/default schema and seeds no user selection;
- upgrades the supported pre-PR production snapshot directly;
- translates only known legacy selection facts through this immutable table:

  | Legacy id(s) | Exact selection |
  |---|---|
  | `fast`, `codex-fast` | Codex Personal / `gpt-5.6-luna` / `low` |
  | `balanced`, `codex-balanced` | Codex Personal / `gpt-5.6-terra` / `medium` |
  | `deep`, `codex-deep` | Codex Personal / `gpt-5.6-sol` / `high` |
  | `openai-fast` | `openai:gpt-5.6-luna` / `low` |
  | `openai-balanced` | `openai:gpt-5.6-terra` / `medium` |
  | `openai-deep` | `openai:gpt-5.6-sol` / `high` |
  | `anthropic-sonnet` | `anthropic:claude-sonnet-5` / `medium` |
  | `anthropic-fable` | `anthropic:claude-fable-5` / `high` |
  | `google-gemini` | `gemini:gemini-3.5-flash` / `medium` |
  | `moonshot-kimi` | `moonshot:kimi-k3` / `high` |
  | `deepseek-flash` | `deepseek:deepseek-v4-flash` / `high` |
  | `deepseek-pro` | `deepseek:deepseek-v4-pro` / `high` |

- translates legacy background plan facts `routine`, `standard`, `thorough`,
  and `deep` respectively to Codex Personal Luna/low, Terra/medium,
  Terra/high, and Sol/high;
- preserves terminal history when the table or existing exact facts reconstruct
  it, and marks every unknown/unreconstructable terminal row ineligible for
  rerun; and
- refuses affected nonterminal work.

The immutable tables above apply only to persisted generation/run history.
Preference-only legacy columns or rows are dropped, never translated into
developer policy or new per-user state.

The migration is deterministic and performs no network or catalog lookup.
Release/startup preflight reads the composed catalog and proves the Chat seed
and every section 3.4 background selection/tool-plan pair exist, compose, and
are semantically eligible. Missing qualification aborts deployment/startup
rather than choosing a replacement or deleting tools; account creation has no
generation seeding behavior.

The table above exists only inside the rewritten migration and is never
imported by runtime code. There is no downgrade, old-row reader, dual writer,
runtime profile translation, compatibility selector, preference fallback, or
coercion.

Prefer semantic undelete over reimplementation for:

- provider labels, privacy/retention copy, startup validation, and fixtures;
- provider-native continuation/tool-loop mechanics;
- credential construction and bounded hosted certification;
- prior model/reasoning selector UI primitives whose behavior fits the new
  catalog;
- proofs whose independent oracle still matches this target.

Fold reused behavior into the new owners. Do not restore the old provider
ledger, provider-specific tools, domain-direct dispatch, legacy Nexus-private,
cache/CLI, or provider-marketplace discovery, automatic routing/fallback,
generation preference/default behavior, or compatibility decoders. The new
authenticated AgentRuntime catalog is the sole Codex discovery path.

Delete:

- all Fast/Balanced/Deep UI, copy, shortcuts, profile cards, IDs, and tests;
- all twelve synthetic IDs (`codex-fast`, `codex-balanced`,
  `codex-deep`, and the nine provider aliases) and exact-three/exact-twelve
  decoders;
- `PlanId`, `PLANS`, `_BACKGROUND_PLAN`, `ChatProfile`,
  `CHAT_PROFILES`, `_CHAT_PLAN`, `_CHAT_POLICIES`, and
  `chat_policy(profile)`;
- generation `profile_id`, `default_profile_id`,
  `profile_catalog_revision`, `/api/llm/profiles`, `/llm-profiles`, and
  their frontend decoder, cache, draft, SSE, fixture, and persistence fields;
- any generation `/settings/ai` navigation/page, `/api/me/ai-settings` route,
  settings hook/cache/decoder, `AiGenerationSettings`, settings/default table,
  ORM/repository/service, disclosure snapshot, revision, fixture, and test;
- `ChatProfilePicker`, `useChatProfiles`, `chatProfileContract`,
  `chatProfileSelection`, the three-card CSS, and silent
  `UnavailableReplacement`;
- the `ChatTools` capability discriminant and every `operation == chat` check
  that controls MCP configuration, bearer minting, tool publication, or tool
  observation; replace them atomically with frozen `ModelTools` plan presence,
  with no compatibility literal or alias;
- Codex-only route literals in shared policy, API, ledger, product-health, and UI
  owners; retain exact Codex backend/SDK/auth/process facts only inside its
  private adapter and host-health owner, then project them to shared readiness;
- five-provider-only config/credential unions and fixed hosted-turn counts;
- deleted-era provider owners superseded by GenerationService;
- the Codex-only spec/change report, dead configuration, duplicate proofs, and
  source-grep tombstones.

Historical Git objects are history, not compatibility.
Unrelated application Settings surfaces are out of scope. Do not replace
`default_profile_id` or another deleted generation preference with a new one.

## 8. Non-overlapping implementation lanes

| Lane | Exclusive paths/concern | Depends on | Exit |
|---|---|---|---|
| U | sibling `llm-calling`: agent/provider catalog projection, selection validation, tool lowering, event projection, public Codex sandbox option, tests/docs | none | exact immutable pin and conformance green |
| S | Nexus selection/catalog/developer-policy services, config, schemas, pure proofs | U contract | complete catalog plus total exact selection/tool policy green |
| L | models, rewritten `0224`, ledger, continuations, reconciliation and migration/service proofs | S | replay, sealed continuation, migration green |
| T | route-neutral tool authority, tool runtime, grants, MCP adapter and proof | S, U | any operation-owned frozen plan works through both transports |
| C | Codex host/adapter, confinement, deployment/runbook proof | S, T, U | Codex catalog/dispatch and operation-neutral MCP green |
| A | API adapter, credentials, provider fixtures/canaries; no domain callers | S, L, T, U | API multi-turn adapter green |
| D | all background owners and Chat orchestration call sites | L, C, A | complete portfolio uses GenerationService and its frozen tool mode |
| W | FastAPI catalog/Chat routes and Web picker/disclosure/history UX | S, D | service and Chromium contracts green |
| V | shared proof registries, workflows, module docs, residue audit, final integration | all | sensitivity, PR, full, hosted, release evidence |

Lane V alone edits shared proof/fault registries and workflow routing. If a file
collision appears, sequence lanes; never use wholesale ours/theirs.

## 9. Red / green / refactor and 80/20 proof

Follow [Nexus testing standards](../local-rules/testing-standards.md).
`./scripts/test` is the only workflow verdict. Each proof names its risk,
asserts behavior through the highest useful public boundary, and records a
meaningful RED before GREEN.

| Ownership boundary | One dominant proof |
|---|---|
| `llm-calling` catalog | every source row and reasoning value survives each public immutable catalog; canonical order/default/fingerprint invariants and malformed, hidden, retired, or unsupported values fail correctly |
| Nexus catalog/selection | Codex rows equal the complete authenticated observation and API rows equal `api_model_catalog()` filtered only by configured provider; exact reasoning rows own eligibility; the all-provider fixture includes OpenRouter/xAI; semantic revisions ignore health |
| Developer selection policy | pure proof establishes one exact Chat seed, a total fourteen-operation selection/host/model-tool map, content revision, and fail-closed semantic validation; real PostgreSQL + worker prove admission snapshots matching catalog/policy/tool facts while replay never rereads policy |
| Transport projection | one operation-owned frozen plan lowers reversibly to function aliases and MCP allowlists; `NoModelTools` publishes neither; API proposal and MCP observation remain distinct |
| Backend adapters | deterministic protocol transcripts prove text, strict output, operation-neutral tools, continuation, usage, cancellation, and route-specific terminals |
| Durable execution | real PostgreSQL + real worker prove API background model/tool/model crash replay, Codex MCP observation, uncertainty, ordered children/positions, and no duplicate bill/effect/fallback |
| Tool authority | real PostgreSQL proves one Library Dossier read through Codex MCP and API functions plus one Chat additive write through both transports, including stable Dossier candidate registration, scope/lease/grant rejection, replay, receipt, and Undo |
| Credential/sensitive-data isolation | sentinel-secret process tests prove route-specific injection and rejection/redaction from the other adapter, catalog/API, evidence, and logs; sealed continuations never render; protected deployment evidence proves exact-SHA env/mount/confinement wiring |
| Operation portfolio | every background owner consumes its admitted selection, host plan, and model plan; Library proves scoped model reads, Idea proves host research plus bounded model follow-up, every `NoModelTools` row publishes no tools, and representative Metadata/Dawn owners prove terminal-before-publication |
| Migration | empty and supported production snapshots reach one final schema with no preference/default owner; policy qualifies before release; every historical id maps exactly, unknown terminal history becomes ineligible, and active incompatible work refuses |
| Product API/UI | real FastAPI + Chromium prove complete catalog, atomic developer seed/current state, server-owned Chat states and failures, exact create/history/SSE selection, picker disclosures, catalog/seed load and unavailable states, write grant, activity, unchanged/replacement/ineligible reruns, background selection/tool-plan/activity read detail, keyboard, focus, announcements, and mobile behavior; no generation Settings surface exists |
| Public wiring | adapt the existing grounded-chat journey for one Codex read and one API read; add no duplicate journey |
| Hard-cut residue | type/import graph, production build, strict API/browser decoders, rewritten schema, and one deletion-manifest audit prove legacy selection owners are absent without retaining source-grep tests as behavioral oracles |
| External reality | bounded per-target Codex and provider certification proves current model/auth/reasoning/strict-output/tool wires at the exact candidate SHA |

RED:

- author target proofs against the current Codex-only branch and retain their
  failing fingerprints;
- register one canonical owner per boundary and one representative fault for
  each critical/replacement proof;
- require sensitivity faults for partial-provider filtering, unsupported
  reasoning, unavailable-policy fallback, an unqualified tool-bearing target,
  wrong background scope, an unregistered Dossier citation, duplicate tool or
  candidate creation after replay, a worker rereading revised policy, an API key
  crossed into Codex, and a continuation emitted to evidence/logs;
- keep new production imports lazy in base-sensitivity overlays.

GREEN:

- implement only the owner required by the failing proof;
- use protocol-valid fakes only at SDK/provider boundaries; ordinary PR proof
  performs no external generation;
- run `./scripts/test changed <path-or-node>` after each lane.

REFACTOR:

- switch all callers atomically;
- delete superseded code, tests, schema, config, docs, and dependencies;
- run `./scripts/test confidence`, then clean-commit `./scripts/test pr`;
- run `full`, Codex nightly, provider certification, deployment, and release
  gates at the exact candidate SHA. Missing required hosted evidence is
  `not_run` and blocks promotion.

Live proof is linear, not Cartesian:

- one bounded canonical read-tool continuation for every Chat-eligible model
  target;
- one bounded real Library and Idea background model-tool turn through their
  selected Codex target, plus the existing bounded Idea HostTable research;
- one appropriate text/strict-structured turn for each distinct target actually
  selected by developer background policy when not already covered above;
- one additional minimal turn for each distinct reasoning wire encoding not
  already exercised by those target calls; and
- no model-by-operation matrix.

One call may satisfy multiple bullets. Each exact selection's eligibility
composes a current target-capability receipt with a current reasoning-wire
receipt; absent evidence means absent eligibility. Deterministic catalog/policy
proofs own the full cross-product. This is the 80/20 boundary: hosted evidence
proves each external target and wire mechanism once; owned proofs prove every
selection and operation mapping without model x reasoning x operation calls.

## 10. Acceptance criteria

1. The complete configured catalog contains every visible authenticated Codex
   model/reasoning pair and exactly every `api_model_catalog()` row belonging to
   a configured provider. The all-seven-provider fixture contains all eleven
   API rows, including OpenRouter and xAI, exactly once.
2. For each Chat run, users can select any server-projected `Selectable` exact
   pair.
   Unknown, unsupported, stale, retired, and unavailable choices fail
   explicitly; unavailable choices remain visible and explained.
3. An empty new Chat draft initializes from the read-only developer seed; every
   dispatch still submits an exact selection. There is no user generation
   default, preference API, persistence, or AI Settings surface. Create,
   history, and SSE project the immutable run selection or typed historical
   ineligibility for reload and rerun.
4. Developer policy owns a content-revisioned Chat seed and total exact
   selection/host/model-tool map for all fourteen background operations. The
   shipped values are section 3.4, require review/deployment to change, and are
   not generation profiles, defaults, or tiers.
5. No Fast, Balanced, Deep, Auto, Recommended, generation-selection profile,
   preset, tier, fixed model/effort shortcut, old API, compatibility ID, or
   fallback remains. Legitimate runtime auth-profile identity is unaffected.
6. One immutable GenerationSpec snapshots exact selection, source, host/model
   plans, effect mode, admitted scope plus digest, limits, host-evidence
   revision, bounds, revisions, and fingerprint before dispatch.
7. Background admission snapshots one complete developer-policy selection and
   tool authority before atomically persisting/enqueuing the generation. Workers
   never reread policy; a manual rebuild is a fresh admission under current
   policy.
8. An unavailable Chat seed leaves the picker usable but requires an explicit
   per-run replacement. An unavailable background selection or required tool
   blocks only that operation with an operator-facing failure. Neither
   substitutes another route/model/reasoning/tool/plan.
9. Every tool-enabled Codex or API Chat/background run executes its frozen
   canonical plan through one ToolAuthority, executor, journal, citation,
   trust, effect, and Undo path; only transport lowering differs.
10. Chat writes require a fresh per-run grant and rerun/regenerate never inherit
    it. Shipped background model plans are read-only, noninteractive, and gain
    no user or worker override.
11. `NoModelTools` publishes no live model tools. Library Dossier and Idea
    Dossier receive exactly their section 3.4 read plans; Idea independently
    retains its bounded host research. A Dossier can cite model-read evidence
    only through a stable registered build candidate. No failure silently drops
    either plan.
12. One parent generation records every independently accepted model turn and
    tool position. Crash/replay cannot duplicate billing or effects.
13. No accepted/uncertain call automatically repeats or changes selection.
14. Codex subscription state and API credentials remain isolated. Secrets,
    continuations, prompts, and raw private tool payloads never enter catalog
    APIs, hosted evidence bundles, logs, or the wrong process. Accepted bounded
    tool-result evidence remains only in its authorized product ledger.
15. Before Chat confirmation, the picker discloses effective
    route/provider/model/reasoning, processor chain, privacy/retention, billing
    class, readiness, last check, and actionable recovery. Background run detail
    exposes the admitted selection, tool plan, and tool activity read-only,
    without browser controls, credential entry, or fabricated prices.
16. The rewritten migration reaches one final schema, maps every supported
    historical legacy ID exactly, drops preference-only state, marks unknown
    terminal history ineligible, and refuses incompatible active work; runtime
    compatibility code does not survive.
17. Every ownership boundary has one independent, sensitive behavior proof and
    exact-SHA evidence in its named gate; the deletion-manifest proof confirms
    superseded selection owners are absent.
18. `changed`, `confidence`, `pr`, `full`, Codex nightly, provider
    certification, migration, deployment, and release requirements are green;
    `not_run` is never acceptance.

## 11. Explicit trade-offs

- Exact model/reasoning control increases cognitive load and makes model names
  product surface. Search, provider grouping, a clear initial seed, and
  progressive disclosure contain the cost; per-run user control is the chosen
  priority.
- A dynamic Codex catalog can drift independently of Nexus. Revisioned
  validation, persisted structured selections, lifecycle states, and
  fail-closed dispatch preserve truth, at the cost of occasionally requiring a
  different per-run Chat choice or developer policy change.
- A source that supplies an upgrade hint without a retirement instant gets no
  invented countdown; it may disappear directly into history-only unavailable
  state.
  Less advance warning is preferable to false lifecycle precision.
- Run history duplicates a small typed label/disclosure snapshot. That
  denormalized presentation data keeps historical choices explainable and is
  barred from validation and dispatch.
- Server-projected Chat states and closed failure variants enlarge the catalog
  slightly. This removes browser policy inference; background states stay
  server-internal.
- Exposing every configured API row adds credential, privacy, qualification,
  and hosted-canary work. This is accepted to preserve the complete configured
  `llm-calling` value rather than an arbitrary curated subset; all-provider
  deployments therefore expose all eleven rows.
- Removing generation preferences eliminates all generation-default controls,
  a settings API, tables, migration, concurrency, and unavailable-preference
  UX. The cost is deliberate: each new conversation starts from the developer
  seed, and background tuning requires review and deployment.
- One content-derived policy revision atomically covers Chat and every
  background operation. A background-only policy deployment may refresh the
  cached Chat seed even though it does not stale the explicit Chat selection;
  that small cache churn avoids a split revision vector.
- Authenticated policy preflight adds release/startup ordering. It prevents an
  impossible developer selection/tool-plan pair from shipping without putting
  network access inside schema migration.
- Claude Code subscription remains unconfigured. Adding it now would require a
  second enrolled local account, host image/SDK, security qualification, and
  tool proof unrelated to the approved Codex Personal plus API goal.
- Capability-scoped tools limit autonomy. They preserve evidence contracts,
  least privilege, replay identity, and prompt-injection containment.
- Model tools make Library and Idea Dossiers more adaptive but add model turns,
  latency, cost variance, and replay states. Exact scopes/limits and durable
  evidence accept that cost where retrieval can improve the result. Their tools
  can search and navigate only already admitted source refs, so they improve
  in-turn retrieval but do not discover a new corpus; the other twelve
  backgrounds keep their complete frozen-evidence contracts.
- Unattended background models receive read authority only. Keeping publication
  in domain-owned validated transactions gives up autonomous background writes
  to avoid invisible approvals, duplicate effects, and a second mutation path.
- Idea's deterministic HostTable owns external research while its model plan
  owns private Nexus follow-up. Forbidding private reads and external egress in
  one unattended model plan limits free-form research but materially reduces
  prompt-injection exfiltration risk.
- MCP remains the Codex tool transport. Dynamic App Server callbacks are absent
  from the pinned `llm-calling` contract and would create a second effect
  boundary.
- Child model-turn persistence and encrypted continuation add schema and
  sensitive-state complexity; API tool-loop crash recovery is otherwise
  dishonest.
- No automatic fallback lowers availability. It preserves exact privacy, cost,
  billing, tool, and effect truth.
- Live certification grows with the number of advertised models but not with
  model × reasoning × operation. That is the smallest proof shape that does
  not advertise an untested external target.

## 12. Authoritative references

- [Nexus testing standards](../local-rules/testing-standards.md)
- [Nexus tool runtime primitives; Chat-only limits superseded in this spec](nexus-tool-runtime-hard-cutover.md)
- [LLM tools library](llm-tools-library-hard-cutover.md)
- [Generation runtime composition](generation-run-harness-hard-cutover.md)
- [LLM module](../modules/llms.md)
- [Boundaries](../rules/boundaries.md)
- [Cleanliness](../rules/cleanliness.md)
- [Keys and identities](../rules/keys-and-identities.md)
- [Operation types](../rules/operation-types.md)
- [Retries](../rules/retries.md)
- [`llm-calling` provider/agent contracts](../../../llm-calling/README.md)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex App Server](https://developers.openai.com/codex/app-server/)
