# Generation Backends Hard Cutover

**Status:** APPROVED IMPLEMENTATION SPECIFICATION; NOT IMPLEMENTED

**Date:** 2026-08-31

**Type:** atomic hard cutover; no compatibility period

**Open questions:** none

**Supersedes:**
[`codex-personal-generation-hard-cutover.md`](codex-personal-generation-hard-cutover.md)
and its change report. Those documents describe the rejected Codex-only source
state and are deleted when this cutover turns green.

## 1. Decision

Codex Personal is the seeded default for every Nexus generation operation.
Users may instead select any currently eligible model and reasoning value in the
complete configured `llm-calling` catalog. Chat owns an exact selection for
each run. AI Settings owns one exact Chat default and one exact default for
every background operation.

There are no generation-selection profiles, presets, intent tiers, or
Fast/Balanced/Deep shortcuts.
The only selection model is:

    execution route -> exact model -> exact supported reasoning value

Nexus has one generation service, one catalog projection, one durable
generation ledger, and one canonical tool authority. Codex Personal and API
providers remain separate transport adapters below that waist.

    domain owner -> GenerationIntent -> GenerationService -> frozen GenerationSpec
                               selection/default |
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

- Keep Codex Personal as the initial Chat and background default.
- Expose every model and supported reasoning value from every Nexus-configured
  `llm-calling` route, including OpenRouter and xAI.
- Let the user choose the exact selection for each Chat run.
- Persist a Chat default and a complete default map for all background
  operations in AI Settings.
- Freeze the exact selection and catalog evidence before dispatch so later
  settings or catalog drift cannot change a run.
- Give eligible Codex and API Chat targets identical canonical Nexus tool
  authority.
- Keep background final synthesis tool-free where its evidence contract is
  frozen; model choice does not widen operation authority.
- Split read authority from additive-write authority. Writes require a fresh
  explicit per-run grant and remain bounded, audited, idempotent, and undoable.
- Preserve prompts, evidence selection, output validation, citations,
  cancellation, publication transactions, and deterministic host retrieval.
- Preserve crash/replay truth across multi-call API tool loops.
- Reuse current Codex, provider, ledger, tool, settings, and proof primitives
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
- Live model tools in frozen-evidence synthesis.
- Adaptive Idea-research planning. Existing durable host-planned research and
  tool-free final synthesis remain unchanged.
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
targets remain representable in stored settings and generation history, but
cannot start a new run.

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
- per reasoning row: key, label, readiness, a complete tagged selection state
  for Chat and every background operation, and references to its
  target-capability and reasoning-wire qualification evidence;
- source-observed input facts and source-default reasoning, which must name one
  present, transport-supported reasoning row; and
- Nexus qualification for streaming, strict structured output, continuation,
  and the canonical Chat tool plan.

Codex native visibility and upgrade/retirement metadata are typed source facts;
API rows carry equivalent curated facts. `UpgradeFacts(target_key)` and
`RetirementFacts(retires_at)` are independent `Presence` fields. Upgrade alone
never implies a deadline. The lifecycle truth table is exact:

| Present source facts at observation | Product lifecycle |
|---|---|
| visible; no explicit `retires_at` | `Active` |
| visible; explicit future `retires_at` | `Retiring` |
| visible; `retires_at` reached | `Retired` |
| no longer visible | absent from live catalog; stored-unavailable/history only |

`Retiring` remains selectable while ready and before its boundary; `Retired`
never does. The catalog observation expires at the nearest retirement instant,
and crossing it produces a new product definition revision. Lifecycle is
semantic catalog data; quota, credential, host, and health observations are
volatile readiness data.

A source-present target that becomes unready or retired remains focusable,
visible, and explained in the catalog but is not selectable. A source-absent or
unconfigured saved/run selection remains a contextual unavailable row in
Settings or Chat history, not a general browse choice. It is never normalized
or used as a fallback. No pair is operation-eligible unless both its
target-capability proof and reasoning-wire proof are current for the catalog
definition.

### 3.2 Exact selections, not profiles

An exact `GenerationSelectionSpec` is the only user-selectable value:

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
selection against the named catalog definition and the operation's eligibility
before creating durable work. Unsupported combinations fail as
`InvalidGenerationSelection`; a known but non-runnable choice fails as
`GenerationSelectionUnavailable`.

### 3.3 Chat

- A new conversation seeds its composer from the saved Chat default.
- The composer always shows the exact backend/provider, model, and reasoning.
- The user may change all three before every run.
- A dispatched run freezes that exact selection; it does not change the saved
  default.
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
or saved until confirmation.

Initial catalog/default failure preserves the draft, disables Send, and shows
an inline Retry. A refresh failure after one valid decode preserves that exact
semantic catalog, labels its readiness observation stale, and offers Retry;
dispatch still performs the server readiness check. A refresh-required result
preserves the uncommitted selection, reloads and revalidates it, and requires a
new confirmation. No failure path selects a seed or another model.

Rerun opens the same picker preselected to the source selection. Confirming it
unchanged is allowed only while ready; an unavailable source blocks until an
explicit replacement is confirmed. The global Chat default is never consulted.
Both unchanged and replacement reruns reset write authority.

The trigger names its current selection and implements `aria-haspopup`,
`aria-expanded`, and `aria-controls`. The labelled popover/sheet traps focus,
sets initial focus, supports Escape, backdrop and mobile Back dismissal, and
returns focus to the trigger. Search is a combobox controlling a listbox with
`aria-activedescendant`; Arrow keys, Home/End, Enter, and Escape work. Reasoning
is a labelled radio group or select. Unavailable rows remain focusable for their
explanation, status changes are announced, and Confirm stays disabled until a
complete ready pair exists.

### 3.4 AI Settings

AI Settings contains:

1. one **Chat default**;
2. one explicit default for each background operation;
3. route readiness, last checked, privacy/retention, and API/subscription
   disclosure.

It is a normal `/settings/ai` child and reuses the Chat picker. Operations may
be grouped visually (for example, Dossiers), but grouping creates no shared
default or inheritance. Saving, typed failure, retry, and revision-conflict
states stay beside the edited control.

The background keys are the complete closed operation set:

| Product label | Operation key | Seeded selection |
|---|---|---|
| Metadata enrichment | `metadata_enrichment` | Codex Personal / `gpt-5.6-luna` / `low` |
| Media summary | `media_summary` | Codex Personal / `gpt-5.6-luna` / `low` |
| Synapse | `synapse` | Codex Personal / `gpt-5.6-luna` / `low` |
| Dawn | `dawn_write` | Codex Personal / `gpt-5.6-terra` / `medium` |
| Oracle | `oracle` | Codex Personal / `gpt-5.6-terra` / `medium` |
| Page dossier | `dossier_page` | Codex Personal / `gpt-5.6-luna` / `low` |
| Note dossier | `dossier_note` | Codex Personal / `gpt-5.6-luna` / `low` |
| Media dossier | `dossier_media` | Codex Personal / `gpt-5.6-terra` / `medium` |
| Conversation dossier | `dossier_conversation` | Codex Personal / `gpt-5.6-terra` / `medium` |
| Library dossier | `dossier_library` | Codex Personal / `gpt-5.6-terra` / `high` |
| Podcast dossier | `dossier_podcast` | Codex Personal / `gpt-5.6-terra` / `high` |
| Contributor dossier | `dossier_contributor` | Codex Personal / `gpt-5.6-terra` / `high` |
| Idea dossier | `dossier_idea` | Codex Personal / `gpt-5.6-terra` / `high` |
| Idea resolution | `dossier_idea_resolve` | Codex Personal / `gpt-5.6-luna` / `low` |

The Chat seed is Codex Personal / `gpt-5.6-terra` / `medium`. These values
are migration/account-creation seeds, not named plans or immutable policy.
`routine`, `standard`, `thorough`, `deep`, `fast`, and `balanced`
selection aliases are deleted.

Settings persists a complete pre-seeded map but mutates one default at a time.
Each mutation atomically replaces its model and reasoning. A stale
settings/catalog definition, invalid combination, or unavailable selection
fails only that edit. A missing or duplicate persisted operation is a defect,
never sparse preference behavior.

Each Settings trigger is named by operation. Initial load failure leaves the
pane unavailable with Retry; a failed refresh retains the last strictly decoded
value, marks readiness stale, and never fabricates a default. A revision
conflict keeps the uncommitted selection, reloads and revalidates the catalog,
and requires explicit reconfirmation. Catalog and settings values compose only
when their catalog revisions match. A mismatch preserves local state and
refetches both once; continued churn becomes an explicit Retry state.

Preference changes affect future admissions only. In the same PostgreSQL
transaction that admits/enqueues background work, the service locks the
settings revision, validates the operation default, and creates the parent
generation with its exact selection and catalog/policy evidence. A later worker
uses only that admitted snapshot and never rereads Settings. A concurrent
settings write therefore linearizes wholly before or after admission and cannot
alter queued or running work.

If a saved default becomes unavailable, Settings preserves and marks it. New
work for that operation refuses with `GenerationSelectionUnavailable` until
the user chooses a runnable selection. There is no implicit product default
after initial seeding and no database default. The API presents an active row
from the current catalog or a typed stored-unavailable value containing the
exact saved selection, saved labels and billing/privacy/processor disclosure,
and the current unavailability reason. This display snapshot is not dispatch
authority, a compatibility alias, or a fallback.

## 4. Architecture and ownership

### Nexus owns

- configured route composition and product-facing catalog projection;
- user settings, exact run selection, readiness, privacy, and billing copy;
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
subscription state. Neither chooses Nexus defaults, operation authority,
credentials, durable identity, effects, or fallback.

### Composition

`GenerationCatalogService` creates one immutable projection from:

- AgentRuntime's authenticated Codex catalog definition revision and row
  fingerprints;
- the normalized `api_model_catalog()` rows for configured providers and
  their row fingerprints;
- Nexus enabled-provider configuration;
- Nexus lifecycle mapping, operation capability, target/reasoning qualification,
  and disclosure revisions.

The semantic `definition_revision` fingerprints those facts. It does not hash
the global provider-registry revision, so an unconfigured provider change
cannot invalidate an open form; that global revision remains ledger
provenance. Readiness and health are volatile observations with their own
`observed_at`; they do not change the definition revision. Dispatch rechecks
semantic validity and current readiness. This is the only catalog consumed by
API schemas, Settings, Chat, policy resolution, and ledger creation.

The Codex adapter obtains `AgentModelCatalog` through a typed command on the
existing confined host/UDS boundary; only its normalized, non-secret facts
cross into Nexus. The web/API process never opens the Codex SDK or reads its
state directory.

`GenerationPolicy` owns each `OperationWorkflowSpec`: bounds, output contract,
timeout, optional host-research plan, and model-tool capability. It contains no
model tiers or route defaults. `AiGenerationSettings` owns defaults.
`GenerationService` accepts a Chat selection or transactionally resolves a
background default at admission, freezes one `GenerationSpec`, and rechecks
volatile readiness immediately before dispatch without changing that spec.

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
      ai_generation_settings.py
      generation_intent.py
      generation_policy.py
      llm_execution.py
      llm_ledger.py
      generation_continuations.py
      codex_generation_*.py
      provider_generation_*.py
      llm_credentials.py
      tool_authority.py
      tool_runtime/**
      agent_tools_mcp.py

    python/nexus/
      schemas/llm.py
      api/routes/llm.py
      api/routes/chat*.py
      db/models.py
      db/migrations/versions/0224_*.py

    apps/web/src/
      app/(authenticated)/settings/ai/**
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

    OperationWorkflowSpec
      operation
      bounds
      output_contract
      host_tool_plan: Presence<HostResearchPlan>
      model_tool_capability:
        FrozenSynthesis
        | ModelTools(FrozenToolPlan, ReadOnly | AdditiveWrites)
      policy_revision

`dossier_idea` alone retains the current bounded `HostResearchPlan` for three
host-executed `web.search` steps and then uses `FrozenSynthesis`. No host tool
plan is exposed to the model. All other background operations have no host tool
plan and use `FrozenSynthesis`; Chat has no host plan and uses `ModelTools`.

`GenerationService` freezes:

    GenerationSpec
      operation
      selection: GenerationSelectionSpec
      selection_source: ChatRun | UserOperationDefault
      bounds
      output_contract
      model_tool_capability
      host_evidence_revision: Presence<HostEvidenceRevision>
      catalog_definition_revision
      policy_revision
      backend_contract_revision
      provider_registry_revision: Presence<RegistryRevision>
      fingerprint

The structured selection itself is persisted, not only a mutable catalog key.
The fingerprint includes every dispatch-affecting fact. Credentials and opaque
continuations are never part of the spec.

The backend event boundary remains a closed union:

    BackendEvent
      TextDelta | UsageObserved
      | ToolProposed
      | ToolObserved
      | PermissionDecision | NativeDiagnostic
      | Terminal(CodexTerminal | ProviderTerminal)

`ToolProposed` means an API call awaits Nexus execution.
`ToolObserved` means an SDK/MCP path already executed through the server.
Route-specific terminals retain their complete native evidence.

### 5.2 Catalog and settings API

`GET /api/llm/catalog` returns one strict object:

    GenerationCatalog
      definition_revision
      observed_at
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
            operation_states[]
              operation: GenerationOperationKey
              state: SelectionState
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

Routes, models, reasoning rows, and operation keys use canonical server order
and contain no duplicates. Every reasoning row has exactly one state for Chat
and each of the fourteen background operations. Each source default equals
exactly one reasoning key in its model. `Selectable` already incorporates route,
model, reasoning, lifecycle, qualification, and operation policy; the browser
derives none of them.

No credential, native continuation, price estimate, internal engine, hidden
model, private account fact, or raw health diagnostic crosses this API.

`GET /api/me/ai-settings` returns:

    AiGenerationSettings
      revision
      catalog_definition_revision
      chat_default: GenerationDefaultOut
      background_defaults[]
        operation: BackgroundOperationKey
        default: GenerationDefaultOut

    GenerationDefaultOut
      selection: GenerationSelectionSpec
      presentation:
        ActiveCatalogSelection(current labels, billing, privacy, processor_chain)
        | StoredUnavailableSelection(
            saved labels, saved billing, saved privacy, saved processor_chain,
            unavailability reason and action
          )

The persisted typed disclosure snapshot is refreshed on a successful setting
write and exists only to explain an exact saved choice after its source row
disappears. It contains no credential or dispatch fact and cannot make a choice
runnable.

The browser joins catalog and settings only when their catalog definition
revisions are equal. No best-effort cross-revision composition is valid.

`PATCH /api/me/ai-settings` accepts one strict command plus
`expected_settings_revision` and `catalog_definition_revision`:

    SetChatDefault(selection)
    | SetBackgroundDefault(operation, selection)

The command atomically replaces one complete selection and returns the complete
new settings value. It cannot create/delete operation keys or write a partial
model/reasoning pair.

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
    | SettingsRevisionConflict(current_settings_revision)
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
| `FrozenSynthesis` | none |
| `HostResearchPlan` | existing HostTable `web.search` only; outside the final model turn |
| `ModelRead` | `web.search`, `nexus.search`, `nexus.resource.read`, `nexus.document.search`, `nexus.resource.inspect`, `nexus.relations.list` |
| `ModelReadAdditiveWrite` | `ModelRead` plus `nexus.library.add`, `nexus.note.create`, `nexus.highlight.create`, `nexus.edge.create`, `nexus.queue.add` |

Model selection never selects tools. The operation selects its reviewed host
plan and model capability independently. Every Chat-eligible exact selection
must be qualified for the canonical plan; every background-eligible exact
selection must be qualified for that operation's text or strict structured
output contract.

`ToolAuthority` binds a frozen plan to user, generation, run/attempt, worker
lease, admitted resources, budgets, invocation position, and effect mode. MCP
bearers and API function execution are adapters to this same authority. Tool
output cannot widen it.

Reads execute automatically. `ModelReadAdditiveWrite` exists only after an
explicit `AdditiveWrites` request; only Chat selects model tools in this
cutover. No destructive, external-message, purchase, share, credential, or
access-control tool may reuse that grant.

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
  pass-through is impossible. The Claude arm does not require an unsupported
  catalog, and Nexus can construct only the Codex arm.
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
- Keep the existing function-tool adapter and add an adjacent plan-derived MCP
  publication/observation adapter.
- Add an additive event projection that preserves API proposals and MCP
  observations as distinct states.
- Preserve full route-specific terminal evidence as a tagged union.
- Expose typed Codex temporary-root/sandbox controls; remove Nexus's private
  configuration subclass.
- Add no cross-lane dispatcher, credential broker, product defaults, or
  fallback selector.

## 6. Persistence, execution, and security

### Preferences and ledger

`ai_generation_settings` owns one user revision. Child
`ai_generation_defaults` rows own exactly one `Chat` key and one row per
background operation. Each row persists the structured tagged selection in
route-specific columns plus a typed, non-authoritative disclosure snapshot in
explicit fields; no generic dispatch descriptor, database default, or profile
foreign key is added. The service validates the complete set and tagged union
on every read/write.

`llm_calls` is one product generation. Child `llm_model_turns` records each
independently accepted/billable model call. Codex normally has one child; an
API function-tool loop has one child per provider call. Tools retain separate
journaled positions.

Each generation snapshots selection, resolved server dispatch target, source,
catalog/policy/backend revisions, host-evidence and model capability, bounds,
safe dispatch-time display/disclosure, rerun reconstructability, and fingerprint.
Each child records route-native dispatch state, request identity,
usage/billability, and tagged terminal evidence.

Provider continuation artifacts are bounded, target/codec-bound, sealed with
AES-256-GCM, never logged/rendered, and deleted when consumed or terminal.
Associated data binds generation, child position, target, codec, and policy.
Key rotation drains API generations and replaces the single key; no
compatibility reader ships.

### Failure and replay rules

- no database transaction spans UDS, SDK, MCP, provider HTTP, or Brave I/O;
- record uncertainty before dispatch and terminal evidence before publication;
- completed children and tool positions replay without redispatch;
- pre-accept refusal reschedules only under the existing bounded policy;
- after semantic output, accepted/uncertain dispatch, or a tool effect, never
  automatically repeat or switch selection;
- ProviderRuntime alone owns retry inside one API call; Nexus owns durable
  continuation between calls;
- Codex turns are not retried after acceptance;
- unavailable saved defaults block new work and never fall back;
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

- creates the final settings/default and parent/child ledger owners;
- seeds the explicit Chat and fourteen background selections for every
  existing user from section 3.4;
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

The migration is deterministic and performs no network or catalog lookup.
Before any production migration, release preflight must read the authenticated
AgentRuntime catalog and prove every section 3.4 Codex seed exists with its
reasoning and operation eligibility; account creation enforces the same gate.
Missing seed qualification aborts deployment/account creation rather than
choosing a replacement.

The table above exists only inside the rewritten migration and is never
imported by runtime code. There is no downgrade, old-row reader, dual writer,
runtime profile translation, compatibility selector, missing-preference
fallback, or coercion.

Prefer semantic undelete over reimplementation for:

- provider labels, privacy/retention copy, startup validation, and fixtures;
- provider-native Chat continuation/tool-loop mechanics;
- credential construction and bounded hosted certification;
- prior model/reasoning selector UI primitives whose behavior fits the new
  catalog;
- proofs whose independent oracle still matches this target.

Fold reused behavior into the new owners. Do not restore the old provider
ledger, provider-specific tools, domain-direct dispatch, legacy Nexus-private,
cache/CLI, or provider-marketplace discovery, automatic routing/fallback,
sparse preference behavior, or compatibility decoders. The new authenticated
AgentRuntime catalog is the sole Codex discovery path.

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
- `ChatProfilePicker`, `useChatProfiles`, `chatProfileContract`,
  `chatProfileSelection`, the three-card CSS, and silent
  `UnavailableReplacement`;
- Codex-only route literals in shared policy, API, ledger, product-health, and UI
  owners; retain exact Codex backend/SDK/auth/process facts only inside its
  private adapter and host-health owner, then project them to shared readiness;
- five-provider-only config/credential unions and fixed hosted-turn counts;
- deleted-era provider owners superseded by GenerationService;
- the Codex-only spec/change report, dead configuration, duplicate proofs, and
  source-grep tombstones.

Historical Git objects are history, not compatibility.

## 8. Non-overlapping implementation lanes

| Lane | Exclusive paths/concern | Depends on | Exit |
|---|---|---|---|
| U | sibling `llm-calling`: agent/provider catalog projection, selection validation, tool lowering, event projection, public Codex sandbox option, tests/docs | none | exact immutable pin and conformance green |
| S | Nexus selection/catalog/settings services, config, schemas, pure proofs | U contract | complete catalog plus atomic defaults green |
| L | models, rewritten `0224`, ledger, continuations, reconciliation and migration/service proofs | S | preferences, replay, sealed continuation, migration green |
| T | route-neutral tool authority, tool runtime, grants, MCP adapter and proof | S, U | one frozen plan works through both transports |
| C | Codex host/adapter, confinement, deployment/runbook proof | S, T, U | Codex catalog/dispatch and MCP green |
| A | API adapter, credentials, provider fixtures/canaries; no domain callers | S, L, T, U | API multi-turn adapter green |
| D | all background owners and Chat orchestration call sites | L, C, A | complete operation portfolio uses GenerationService |
| W | FastAPI catalog/settings/chat routes and Web Settings/picker/disclosure UX | S, D | service and Chromium contracts green |
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
| Settings/default resolution | real PostgreSQL + API prove one Chat plus all fourteen defaults exist, one-row changes are atomic and isolated, invalid/stale writes fail, and an enqueue-vs-settings race freezes exactly the before-or-after value at admission |
| Transport projection | one frozen plan lowers reversibly to function aliases and MCP allowlists; API proposal and MCP observation remain distinct |
| Backend adapters | deterministic protocol transcripts prove text, tools, continuation, usage, cancellation, and route-specific terminals |
| Durable execution | real PostgreSQL + real worker prove API model/tool/model crash replay, uncertainty, ordered children, and no duplicate bill/effect/fallback |
| Tool authority | real PostgreSQL proves one read and one additive write through both transports, including scope/lease/grant rejection, replay, receipt, and Undo |
| Credential/sensitive-data isolation | sentinel-secret process tests prove route-specific injection and rejection/redaction from the other adapter, catalog/API, evidence, and logs; sealed continuations never render; protected deployment evidence proves exact-SHA env/mount/confinement wiring |
| Operation portfolio | every background owner consumes its admitted exact selection plus `FrozenSynthesis`; Idea alone proves separate host research; representative Metadata and Dawn owners prove terminal-before-publication |
| Migration | empty and supported production snapshots reach one final schema; seeds qualify before migration; every legacy id maps exactly, unknown terminal history becomes ineligible, and active incompatible work refuses |
| Product API/UI | real FastAPI + Chromium prove complete catalog, server-owned operation states and failures, catalog/settings revision coherence, exact create/history/SSE selection, picker disclosures, all Settings rows, load/refresh failures, saved unavailable state, write grant, activity, unchanged/replacement/ineligible reruns, keyboard, focus, announcements, and mobile behavior |
| Public wiring | adapt the existing grounded-chat journey for one Codex read and one API read; add no duplicate journey |
| Hard-cut residue | type/import graph, production build, strict API/browser decoders, rewritten schema, and one deletion-manifest audit prove legacy selection owners are absent without retaining source-grep tests as behavioral oracles |
| External reality | bounded per-target Codex and provider certification proves current model/auth/reasoning/strict-output/tool wires at the exact candidate SHA |

RED:

- author target proofs against the current Codex-only branch and retain their
  failing fingerprints;
- register one canonical owner per boundary and one representative fault for
  each critical/replacement proof;
- require sensitivity faults for partial-provider filtering, unsupported
  reasoning, unavailable-default fallback, the enqueue/settings race, an API
  key crossed into Codex, and a continuation emitted to evidence/logs;
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
- one strict-structured turn for every background-eligible model target;
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
2. Users can select any server-projected `Selectable` exact pair.
   Unknown, unsupported, stale, retired, and unavailable choices fail
   explicitly; unavailable choices remain visible and explained.
3. Chat accepts an exact selection per run. AI Settings persists one Chat
   default and exactly one default for every background operation. Create,
   history, and SSE project the immutable run selection or typed historical
   ineligibility for reload and rerun.
4. Codex Personal seeds every default using section 3.4. Seed values are
   qualified before migration/account creation and remain ordinary editable
   selections, not generation profiles or policy tiers.
5. No Fast, Balanced, Deep, Auto, Recommended, generation-selection profile,
   preset, tier, fixed model/effort shortcut, old API, compatibility ID, or
   fallback remains. Legitimate runtime auth-profile identity is unaffected.
6. One immutable GenerationSpec snapshots exact selection, source, operation
   model capability, host-evidence revision, bounds, revisions, and fingerprint
   before dispatch.
7. Background admission and Settings writes linearize in PostgreSQL. A worker
   never rereads Settings; queued/running work and historical reruns preserve
   their exact selection, and rerun may explicitly choose a replacement.
8. A missing/unavailable saved default blocks new work with an actionable
   failure, remains honestly presentable, and never silently substitutes another
   route/model/reasoning.
9. Codex and API Chat execute the same frozen canonical read or read/write plan
   through one ToolAuthority, executor, journal, citation, trust, effect, and
   Undo path.
10. Writes require a fresh per-run grant. Rerun/regenerate never inherit it.
11. Frozen synthesis has no live model tools. Existing Idea research remains
    host-planned and its final synthesis remains tool-free.
12. One parent generation records every independently accepted model turn and
    tool position. Crash/replay cannot duplicate billing or effects.
13. No accepted/uncertain call automatically repeats or changes selection.
14. Codex subscription state and API credentials remain isolated. Secrets,
    continuations, prompts, and private tool data never enter catalog APIs,
    evidence, logs, or the wrong process.
15. The product discloses effective route/provider/model/reasoning,
    processor chain, privacy/retention, billing class, readiness, last check, and
    actionable recovery before confirmation, without browser credential entry
    or fabricated prices.
16. The rewritten migration reaches one final schema, maps every supported
    legacy ID exactly, marks unknown terminal history ineligible, and refuses
    incompatible active work; runtime compatibility code does not survive.
17. Every ownership boundary has one independent, sensitive behavior proof and
    exact-SHA evidence in its named gate; the deletion-manifest proof confirms
    superseded selection owners are absent.
18. `changed`, `confidence`, `pr`, `full`, Codex nightly, provider
    certification, migration, deployment, and release requirements are green;
    `not_run` is never acceptance.

## 11. Explicit trade-offs

- Exact model/reasoning control increases cognitive load and makes model names
  product surface. Search, provider grouping, honest defaults, and progressive
  disclosure contain the cost; user control is the chosen priority.
- A dynamic Codex catalog can drift independently of Nexus. Revisioned
  validation, persisted structured selections, lifecycle states, and
  fail-closed dispatch preserve truth, at the cost of occasionally requiring
  the user to update a saved default.
- A source that supplies an upgrade hint without a retirement instant gets no
  invented countdown; it may disappear directly into stored-unavailable state.
  Less advance warning is preferable to false lifecycle precision.
- Settings and run history duplicate small typed label/disclosure snapshots.
  That denormalized presentation data is accepted so removed and historical
  choices remain explainable; it is barred from validation and dispatch.
- Server-projected per-operation states and closed failure variants enlarge the
  catalog/API slightly, and revision churn can require one extra read. This
  removes browser policy inference and cross-revision composition.
- Exposing every configured API row adds credential, privacy, qualification,
  and hosted-canary work. This is accepted to preserve the complete configured
  `llm-calling` value rather than an arbitrary curated subset; all-provider
  deployments therefore expose all eleven rows.
- Per-operation defaults add a settings table and fourteen choices. They avoid
  hidden global policy and let expensive or specialist models be assigned
  deliberately; there is no inheritance shortcut.
- Authenticated seed preflight adds release ordering before a deterministic
  migration. It prevents a fresh account from starting with impossible Codex
  defaults without putting network access inside schema migration.
- Claude Code subscription remains unconfigured. Adding it now would require a
  second enrolled local account, host image/SDK, security qualification, and
  tool proof unrelated to the approved Codex Personal plus API goal.
- Capability-scoped tools limit autonomy. They preserve evidence contracts,
  least privilege, replay identity, and prompt-injection containment.
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
- [Nexus tool runtime](nexus-tool-runtime-hard-cutover.md)
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
