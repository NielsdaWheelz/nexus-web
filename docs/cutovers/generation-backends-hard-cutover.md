# Generation Backends Hard Cutover

**Status:** IMPLEMENTATION CANDIDATE; EXACT-SHA VERIFICATION AND
EXTERNAL ACCEPTANCE PENDING; NOT ACCEPTED

**Date:** 2026-08-31

**Type:** atomic hard cutover; complete legacy Chat and historical-generation
reset; no compatibility period

**Open questions:** none

**Authority:** this specification is the sole current generation-backend
cutover owner. The superseded normative Codex-only cutover has been deleted
after its live MCP, capacity, confinement, and run-limit contracts moved to the
surviving owners named here; its change report remains historical evidence.

This specification and the same-commit amendment to
[`nexus-tool-runtime-hard-cutover.md`](nexus-tool-runtime-hard-cutover.md)
supersede that document's section 6 Chat profile row, section 8 durable-position
grammar, sections 9 and 14.14 no-MCP prohibition, section 10.1/14.12 Chat
profile-column ownership, and section 14.3 exactly-eleven-tool rule. Its
declaration, binding, executor, evidence, authorization, replay, effect, and
Undo contracts otherwise remain authoritative.

The generation-profile and generation-selection statements in
[`chat-interface-hard-cutover.md`](chat-interface-hard-cutover.md),
[`chat-composer-instrument-hard-cutover.md`](chat-composer-instrument-hard-cutover.md),
[`reader-highlight-quote-chat-hard-cutover.md`](reader-highlight-quote-chat-hard-cutover.md),
and
[`resource-chat-subject-hard-cutover.md`](resource-chat-subject-hard-cutover.md)
are also superseded. Their same-commit target-
amendment banners prevent a stale profile contract from remaining an apparent
owner.

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

At migration, delete the complete legacy Chat aggregate and all historical
generation/metering ledgers. Preserve users and the durable knowledge/media/
library domain exactly as section 7 defines. Every surviving Chat/generation
row is post-cutover and conforms to the one final schema.

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
- Preserve users and durable knowledge-domain data while deliberately deleting
  the complete legacy Chat aggregate and all legacy generation/metering
  history.
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
- Preservation, translation, display, replay, export, or recovery of legacy
  conversations, messages, citations, shares, Chat tool activity, Chat Undo,
  conversation dossiers, generation calls, agent turns, token-budget ledgers,
  or their historical route/cost facts.
- A migration-time network/catalog lookup, legacy selection mapping, historical
  `RunSelectionOut` arm, compatibility reader, or browser-draft decoder.
- Generation settings, a user Chat default, background controls, credential
  entry, profile preference persistence, or any of the settings surfaces
  proposed by earlier drafts of this document; those surfaces do not exist at
  the cutover base and must never be built.

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

At the implemented immutable `llm-calling` dependency and conformance pin
`16499e1c4783a890063f51bb16b64d48b0cdbe3b`, the ProviderRuntime catalog is
exactly:

| Provider | Model reference | Supported reasoning | Source default |
|---|---|---|---|
| OpenAI | `openai:gpt-5.6-sol` | `none, low, medium, high, xhigh, max` | `high` |
| OpenAI | `openai:gpt-5.6-terra` | `none, low, medium, high, xhigh, max` | `high` |
| OpenAI | `openai:gpt-5.6-luna` | `none, low, medium, high, xhigh, max` | `high` |
| Anthropic | `anthropic:claude-sonnet-5` | `low, medium, high, xhigh, max` | `high` |
| Anthropic | `anthropic:claude-fable-5` | `low, medium, high, xhigh, max` | `high` |
| Gemini | `gemini:gemini-3.5-flash` | `minimal, low, medium, high` | `medium` |
| Moonshot | `moonshot:kimi-k3` | `low, high, max` | `max` |
| OpenRouter | `openrouter:kimi-k3` | `low, high, max` | `Absent` until a source-cited provider default is verified in `llm-calling` |
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
- per model: stable key, source label, Nexus-authored one-line description,
  `source_context_window: Presence<TokenCount>`,
  `source_max_output_tokens: Presence<TokenCount>`,
  `Active | Retiring | Retired`
  lifecycle, and model readiness with reason, recovery action, and last check;
- per reasoning row: key, label, readiness, a product-facing Chat selection
  state, and references to its target-capability and reasoning-wire
  qualification evidence;
- source-observed input/bound facts and
  `source_default_reasoning: Presence<ReasoningKey>`; a present default must
  name one present, transport-supported reasoning row and `Absent` means the UI
  preselects nothing; and
- Nexus qualification for streaming, strict structured output, continuation,
  and route-neutral model-tool transport. The product-facing `chat_state`
  composes both `ChatRead` and its `ChatReadAdditiveWrite` extension; background
  plan eligibility composes server-internally from the same receipts.

Codex native visibility and upgrade metadata are typed source facts. The pinned
SDK publishes no retirement instant, so Codex `RetirementFacts` is always
`Absent` and a disappearing Codex row moves directly from `Active` to the
history-only unavailable state. API upgrade/retirement facts are curated,
source-cited row data. `UpgradeFacts(target_key)` and
`RetirementFacts(retires_at)` are independent `Presence` fields. Upgrade alone
never implies a deadline. The lifecycle truth table is exact:

| Present source facts at observation | Product lifecycle |
|---|---|
| visible; no explicit `retires_at` | `Active` |
| visible API row; explicit future `retires_at` | `Retiring` |
| visible; `retires_at` reached | `Retired` |
| no longer visible | absent from live catalog; history-only unavailable state |

`Retiring` remains selectable while ready and before its boundary; `Retired`
never does. The server clock is authoritative. `GenerationCatalogService`
recomputes lazily on the first read/admission at or after the nearest future API
retirement instant; an observation with no pending retirement has no
retirement expiry. Crossing the boundary produces a new product definition
revision. Lifecycle is semantic catalog data; quota, credential, host, and
health observations are volatile readiness data.

`GenerationCatalogService` is the sole observation/cache owner. It refreshes
source definitions at startup, on an operator refresh, after five minutes, and
at the retirement rule above. It refreshes readiness on catalog read when older
than 60 seconds; Chat keeps a decoded semantic catalog during a refresh failure
but labels readiness stale, while background admission requires a readiness
observation no older than 60 seconds. Every dispatch performs a final live
readiness check. The browser refreshes when the picker opens and once per minute
while it remains open. No caller has a private cache or alternate freshness
rule.

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

- An empty new-conversation draft seeds from the developer-owned `chat_seed`.
  Refresh never changes a draft that already has an explicit selection.
- A continuation draft inherits the `RunSelectionOut` of its causal assistant
  parent: the branch parent when branching, otherwise the selected-path leaf.
  It never inherits from an unrelated, more recent branch.
- The composer always shows route/provider, exact model, exact reasoning, and a
  subscription/metered marker. The user may change the complete selection before
  every run. Dispatch freezes it and writes no preference.
- If a causal selection is known but no longer `Selectable`, keep it selected,
  explain it, and require an explicit replacement. Every surviving causal run
  has a final-schema `RunSelectionOut`; a missing projection is an integrity
  failure, not a fallback to the seed. No failure path silently changes an
  existing selection.
- If the chosen pair becomes unavailable before creation, refuse dispatch and
  keep the draft plus choice intact. There is no substitution.

The picker contains one searchable listbox of exact models grouped by route.
Search matches model key, model label, and route/provider label. Reasoning is a
separate labelled radio group shown for the active model. There are no
progressive columns, Fast/Balanced/Deep/Auto/Recommended rows, profile cards,
preset chips, or intent aliases.

Route-invariant billing, privacy/retention, and processor-chain disclosure
lives once on each `role="group"` header and in an active-candidate details
region. An option's accessible name contains only its model label, lifecycle,
and readiness. The details region, referenced by `aria-describedby`, contains
the source/Nexus description, exact route/provider/model/reasoning,
subscription or metered billing, processor chain, privacy/retention,
source-reported context/output capacity or `Not reported`, the effective Chat
request budget, lifecycle/retirement instant, readiness, last check, and
recovery. A retired row with a valid upgrade target offers
`Switch to <target>`; that action merely preselects the target and still
requires confirmation.

Changing model initializes an uncommitted reasoning value only when
`source_default_reasoning` is `Present`. With `Absent`, or with an unready
default, no runnable value is silently invented and the user must choose.
Enter on a model with a ready `Selectable` default commits and closes; otherwise
it moves focus to the reasoning group. Only a server-projected `Selectable`
pair can commit. Dismissal discards the uncommitted compound choice; catalog or
dispatch failures preserve it for recovery.

The model picker and write authority are orthogonal. A composer-level checkbox
labelled **Allow this reply to add to Nexus** is off by default. Its accessible
description names `nexus.library.add`, `nexus.note.create`,
`nexus.highlight.create`,
`nexus.edge.create`, and `nexus.queue.add`, states that the grant covers this reply only,
and links to the trust/Undo detail. It is always visible while armed, its change
is announced, and every successfully admitted dispatch or rerun/regenerate
re-arms it to off.
The rerun surface states **Writes are off for reruns** beside the off control.
Each successful concrete write target is visibly labelled as assistant-created
and linked in trust detail to its canonical `generation/{generation_seq}/tool/{n}`
position. A legitimate idempotent no-op shows no fabricated target attribution.

Primary **Rerun** is one click with the source run's exact selection when its
current state is `Selectable`. Secondary **Rerun with a different model** opens
the picker. Both create a new generation, accept an explicitly confirmed
replacement, and reset write authority; the complete reset removes the old
write-attempt rerun prohibition. If the source selection is unavailable, the
primary action opens the picker with it explained. If its final projection is
missing, the server returns an integrity failure rather than fabricating
history.

Catalog-load failure preserves editable composer text, disables Send, and shows
inline Retry. A decoded catalog with no `Selectable` pair likewise keeps text
editable, disables Send, announces one polite operator-facing explanation, and
uses the route-level recovery action. An unavailable seed does not block the
picker. A refresh failure after one valid decode preserves that semantic
catalog, marks readiness stale, and offers Retry. `CatalogDefinitionStale`
reloads and revalidates the uncommitted pair, then requires confirmation again.

Desktop uses the existing non-modal anchored popover owner: initial focus on
search; outside-pointer and Escape dismissal; Tab exits and closes; return focus
to the trigger; `role="dialog"` without `aria-modal`; no focus trap, scroll
lock, or inert transcript.
Mobile uses `MobileSheet` and `useMobileModalLifecycle`: panel initial focus,
focus trap, keyboard inset, backdrop/Back/Escape dismissal, and return focus.
The trigger uses `aria-haspopup="dialog"`, `aria-expanded`, and
`aria-controls`; its accessible name updates after Confirm.

Search is the sole combobox and keeps DOM focus while controlling the grouped
listbox with `aria-activedescendant`. Arrow keys and Home/End move through every
candidate. Unavailable rows use `aria-disabled="true"`, never HTML `disabled`,
remain in the arrow sequence, and reference their explanation; Enter does not
commit and re-announces it. The reasoning radio group uses roving tabindex and
the same `aria-disabled` rule. With a nonempty search query, Escape clears it
and stops propagation; otherwise Escape dismisses. Confirm remains focusable
with `aria-disabled="true"` and an exact `aria-describedby` blocker. One polite
status region reports result count, active readiness, and default/reasoning
changes; readiness refresh announces only when the current selection changes
state.

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
| Idea dossier | `dossier_idea` | Codex Personal / `gpt-5.6-terra` / `high` | existing `idea_dossier_research` | `IdeaDossierRead` |
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
`idea_dossier_research` independently owns exactly three Brave-backed `web.search`
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
developer policy; users cannot replace its selection. Build detail shows the
effective background selection, its dispatch-time disclosure, the frozen model
tool plan (`NoModelTools` or the exact plan id, revision, and effect mode), and
the journaled tool-position count read-only: the Dossier head projects the
build's latest ledger generation as `DossierBuildSummary.admitted_generation`,
`Absent` until a generation is admitted. No control, credential, price, or
current catalog state accompanies it; background eligibility stays
server-internal.

Subscription quota is capacity, not a defect retry. A background admission
blocked by an observed Codex quota window enters durable `CapacityPaused` with
the observation, `reset_at: Presence<Instant>`, and `next_check_at`; it is not a
generation attempt and does not consume the ordinary ~19-minute retry ladder.
The scheduler rechecks at the provider reset instant when known, otherwise with
bounded low-frequency readiness probes, and admits once current policy is
ready. The Dossier head projects the parked pause as
`DossierBuildSummary.capacity_pause` on the active build, and the Dossier
surface shows **Waiting for Codex capacity** with the reset or next-check
instant while keeping the existing build Cancel; no API spend, dead letter,
model switch, or per-operation manual replay occurs. A quota error
after provider acceptance remains terminal because repeating could duplicate
billing/effects.

Lane E owns `generation_plans.v2.json` and its policy-facts fingerprint. They
move atomically to the new `GenerationPolicy.revision`, catalog-definition
contract, and pinned `llm-calling` revision; the old plan/task-family corpus
is deleted.

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
- product API, SSE, and UI; and
- the route-neutral closed `BackendEvent` composition over the otherwise
  separate AgentRuntime and ProviderRuntime event families.

### `llm-calling` owns

- separate ProviderRuntime and AgentRuntime contracts;
- a public, typed AgentRuntime model catalog and selection validation;
- the ProviderRuntime model registry and exact reasoning wire facts;
- provider/SDK transport, native continuations, event normalization, usage,
  request identity, and per-call retry classification;
- function-tool lowering and canonical alias reversal;
- MCP configuration lowering and canonical tool observation;
- public Codex sandbox controls required by Nexus; and
- a canonical, bounded continuation JSON codec for ProviderRuntime artifacts.

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

Prompt budgeting is policy-owned and source-constrained. Each
`OperationWorkflowSpec` declares conservative Nexus request budgets. For an API
row, admission requires source capacity facts and clamps the effective budgets
to them. Codex's public `model/list` contract publishes neither context window
nor maximum output, so those source facts are `Absent`; absence does not make a
visible Codex row ineligible. Nexus freezes its operation-owned effective
budgets, and the Codex runtime remains the final context authority with one
explicit capacity failure—never truncation, substitution, a private-cache read,
or a guessed model table. `context_assembler.py` reads only effective budgets
frozen into `GenerationSpec`.

The Codex adapter obtains `AgentModelCatalog` through a typed command on the
existing confined host/UDS boundary; only its normalized, non-secret facts
cross into Nexus. The web/API process never opens the Codex SDK or reads its
state directory.

Codex worker routing keys only on frozen model-tool-plan presence. A
`ModelTools` Chat or background run enters the MCP-capable confined pool and
receives its exact bearer/config; `NoModelTools` enters with no MCP config.
Operation names such as `chat` never select host capability.

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

The Codex host's only network egress is the DNS/SNI-verifying relay whose
closed allowlist contains the Codex provider domains and authenticated Nexus
MCP origin. The SDK's `network = unrestricted` sandbox option is admissible
only behind that relay, with built-ins disabled and approvals denied. Changing
the admitted-host set is a separate security cutover.

### Primary files

    sibling llm-calling/
      .github/workflows/ci.yml
      pyproject.toml
      src/provider_runtime/continuation.py
      src/provider_runtime/registry.py
      src/provider_runtime/runtime.py
      src/provider_runtime/types.py
      src/provider_runtime/agent_runtime/__init__.py
      src/provider_runtime/agent_runtime/model_catalog.py
      src/provider_runtime/agent_runtime/runtime.py
      src/provider_runtime/agent_runtime/types.py
      src/provider_runtime/agent_runtime/tool_projection.py
      src/provider_runtime/tool_adapter.py

    python/nexus/services/
      generation_catalog.py
      generation_selection.py
      generation_intent.py
      generation_admission.py
      generation_backend.py
      generation_policy.py
      generation_runtime.py
      generation_service.py
      generation_spec.py
      llm_execution.py
      llm_ledger.py
      generation_events.py
      generation_continuations.py
      codex_generation_*.py
      provider_generation_*.py
      llm_credentials.py
      tool_authority.py
      agent_tool_grants.py
      tool_runtime/**
      agent_tools_mcp.py
      assistant_write_authorship.py
      context_assembler.py
      chat_run_idempotency.py
      chat_failure.py
      artifacts/model_tools.py
      artifacts/revisions.py

    apps/codex_agent/
      confined_runtime.py

    python/nexus/
      schemas/llm.py
      schemas/machine_authorship.py
      api/routes/llm.py
      api/routes/chat*.py
      db/models.py

    migrations/alembic/versions/
      0224_codex_personal_generation.py

    apps/web/src/
      app/api/llm-catalog/route.ts
      app/privacy/page.tsx
      app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx
      components/chat/**
      lib/llm/**
      lib/conversations/generationCatalog.ts
      lib/conversations/trustToolCallWire.ts

    docs/
      modules/llms.md
      modules/chat.md
      architecture.md
      runbooks/codex-personal-agent-host.md

    testdata/
      proofs.json
      faults/**

    python/nexus_test_control/
      model.py
      runner.py
      policy.py
      sensitivity.py

    deploy/
      hetzner/sync-env.sh
      vercel/sync-env.sh
      env/env-prod-*.example

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
      bounds                         # byte/time/stream limits
      request_budget                 # Nexus max context and reserved output
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
`dossier_idea` retains the current bounded `idea_dossier_research` and then
receives exact `IdeaDossierRead`; `dossier_library` receives exact
`LibraryDossierRead`; the other twelve background rows receive `NoModelTools`.
Chat has no host plan. `ChatPerRunTools` resolves only to `ChatRead`/`ReadOnly`
or, after an explicit request, the complete
`ChatReadAdditiveWrite`/`AdditiveWrites` plan. Every operation passes through
the same tool-capable generation service even when its frozen policy publishes
no model tools.

`NoModelTools` plus a `Present` host plan is legal: host preparation is
domain-owned and never becomes a model declaration.

`NoModelTools` publishes no model-callable declarations. `ModelTools` derives
every declaration, model-visible tool document, limit, and transport alias from
the exact frozen plan; a domain prompt cannot introduce another tool authority.
Chat additionally renders its write-safety instructions from the same typed
per-run authority before hashing or persisting the prompt: `ReadOnly` names no
additive-write tool, while `AdditiveWrites` names all five. The prompt revision,
payload digest, and instruction digest therefore cover the user-consent clause.
Background Dossiers do not duplicate the read-tool catalog in prose; the
canonical declarations own model guidance, and only operation-owned
`dossier_citation_candidates` reconstructed from successful durable reads may
extend the initially supplied candidate set.

Output/tool composition remains route-specific rather than collapsing to a
lowest common denominator. Codex Personal may combine strict structured output
with an exact MCP plan; the shipped Library and Idea Dossier policies use that
qualified composition. ProviderRuntime refuses strict structured output plus
function tools in one model call, so API qualification never advertises that
pair. Shipped API Chat is Text and all shipped strict tool-bearing backgrounds
are Codex Personal. A future API background needing both must use an explicit
multi-generation workflow or first add and qualify an upstream provider
contract; it may not silently drop tools or downgrade strict output.

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
      resolved_dispatch_target
      source_catalog_definition_revision
      source_row_fingerprint
      agent_definition_revision: Presence<AgentDefinitionRevision>
      source_context_window: Presence<TokenCount>
      source_max_output_tokens: Presence<TokenCount>
      effective_context_budget_tokens
      effective_output_budget_tokens
      bounds
      prompt_template_revision
      prompt_payload_ref: ImmutablePromptPayloadRef
      instructions_digest
      input_digest
      output_contract
      output_contract_fingerprint
      display_at_dispatch: labels, billing, privacy, processor_chain
      host_tool_plan_snapshot: Presence<FrozenHostToolPlan>
      host_evidence_revision: Presence<HostEvidenceRevision>
      model_tool_plan_snapshot: Presence<FrozenToolPlanSnapshot>
      tool_effect_mode: Presence<ReadOnly | AdditiveWrites>
      admitted_tool_scope: Presence<FrozenToolScope>
      admitted_tool_scope_digest: Presence<ToolScopeDigest>
      catalog_definition_revision
      policy_revision
      backend_contract_revision:
        AgentBackendContractRevision | ProviderBackendContractRevision
      provider_registry_revision: Presence<RegistryRevision>
      fingerprint

The structured selection and resolved tool authority snapshot are persisted,
not only mutable catalog or plan keys. `prompt_payload_ref` addresses the exact
immutable rendered instructions/input admitted atomically by the domain owner;
the worker verifies both digests before dispatch. Raw prompt bytes stay in that
protected payload owner and never enter catalog/history/evidence/log output.
`NoModelTools` maps every model-tool field
(`model_tool_plan_snapshot`, `tool_effect_mode`, `admitted_tool_scope`, and
`admitted_tool_scope_digest`) to owned `Absent`; either tool-bearing policy arm
resolves to one exact plan and maps every field to `Present`. A
`ChatPerRunTools` admission cannot combine or partially project its two
alternatives. The fingerprint includes the exact
selection and dispatch target, both catalog revisions, row fingerprint,
route-owned backend contract revision, policy/prompt/input/output identity,
display snapshot, host/model plans, effect mode, canonical scope plus digest,
budgets, bounds, and every other dispatch-affecting fact. Agent-only fields are
`Present` only for Codex; `provider_registry_revision` is `Present` only for an
API row. Credentials, bearer values, and opaque continuations are never part of
the spec.

The Nexus backend event boundary becomes a closed union:

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

The projection is exact: AgentRuntime `AgentText` and ProviderRuntime
`TextDelta` become `TextDelta`; `AgentUsage`/`UsageEvent` become
`UsageObserved`; API `ToolCallStart|Delta|Done` becomes `ToolProposed`;
`AgentToolUse` becomes `ToolObserved`; `AgentPermissionRequest` becomes
`PermissionDecision`; `AgentNative` becomes `NativeDiagnostic`; and
`AgentTerminal|CallOutcome` becomes the matching tagged terminal. Neither
`llm-calling` lane imports the other to manufacture this union.

### 5.2 Catalog and Chat API

FastAPI `GET /llm-catalog` returns one strict object. The Web BFF is
`GET /api/llm-catalog`; the two paths are not interchangeable in proofs.

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
          description
          source_context_window: Presence<TokenCount>
          source_max_output_tokens: Presence<TokenCount>
          lifecycle: Active | Retiring | Retired
          retires_at: Presence<RetiresAt>
          upgrade_selection: Presence<GenerationSelectionSpec>
          readiness: Readiness
          input_modalities[]
          qualified_capabilities
          source_default_reasoning: Presence<ReasoningKey>
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
      | CapacityPaused(code, explanation, reset_at, next_check_at, last_checked)

    SelectionState
      Selectable
      | NonSelectableState

    NonSelectableState
      Ineligible(code, explanation)
      | OperatorActionRequired(code, explanation, action, last_checked)
      | TemporarilyUnavailable(code, explanation, action, last_checked)
      | CapacityPaused(code, explanation, reset_at, next_check_at, last_checked)
      | Retired(explanation, upgrade_target: Presence<GenerationSelectionSpec>)

Routes, models, and reasoning rows use canonical server order and contain no
duplicates. Each present source default equals exactly one reasoning key in its model.
`Absent` is valid only when the source has no verified default and never causes
Nexus to invent one. A present model-level upgrade becomes
`upgrade_selection` only when the target's source default is present and the
resulting exact pair is `Selectable`; otherwise it is `Absent`.
`chat_seed` names one exact catalog pair and is returned atomically with its
current state and disclosure. `chat_seed.policy_revision` is exactly the
enclosing `GenerationPolicy.revision` from the immutable policy snapshot that
supplied the seed; it is not a seed-only or catalog revision. That revision is
separate from the semantic catalog definition, so a policy-only deployment does
not stale an open choice; caches key both revisions. `Selectable` already
incorporates route, model, reasoning, lifecycle, qualification, and Chat policy;
the browser derives none of them. Background operation eligibility remains
server-internal. The seed initializes only a new composer. FastAPI
`POST /chat-runs` (browser `/api/chat-runs`) always requires an explicit exact
selection and never interprets omission as the
seed; it intentionally omits a policy revision because admission reads current
workflow policy and the request supplies an explicit selection.

No credential, native continuation, price estimate, internal engine, hidden
model, private account fact, raw health diagnostic, or background-policy
selection crosses this API. There is no generation-settings query or mutation.

That create endpoint accepts the existing message/context fields plus:

    catalog_definition_revision
    selection: GenerationSelectionSpec
    tool_authority: ReadOnly | AdditiveWrites

Unknown fields and malformed tagged unions fail at ingress. A stale catalog
definition returns an explicit refresh-required outcome; it never reinterprets
the submitted selection. A health change returns the current unavailable
outcome without masquerading as semantic catalog drift.

Create/rerun/regenerate responses, Chat history/message reads, initial SSE
metadata, and the assistant trust-trail read model all carry the same immutable
dispatch fields plus server-owned current-state projection:

    RunSelectionOut
      selection: GenerationSelectionSpec
      catalog_definition_revision
      source_catalog_definition_revision
      display_at_dispatch: labels, billing, privacy, processor_chain
      tool_authority: ReadOnly | AdditiveWrites
      current_state: SelectionState
      current_state_observed_at
      rerun_eligibility

The complete reset means every surviving Chat run was created under this final
schema and has the complete frozen fields above; there is no historical union
or ineligible legacy arm. `current_state` is a server-composed volatile
observation, never a dispatch fact or browser inference. `RunSelectionOut`
composes into the existing single
server-owned `rerun_eligibility` policy rather than competing with it. A
missing/corrupt final-schema projection is an integrity defect, not a third
product state. The browser uses this server projection—not draft/cache state—
for reload, reconnect, trust detail, causal inheritance, and rerun.

The existing canonical API failure owner gains these strict variants:

    InvalidGenerationSelection(code, field: Presence<Field>, explanation)
    | GenerationSelectionUnavailable(selection, state: NonSelectableState)
    | CatalogDefinitionStale(current_definition_revision)

Invalid ingress maps to HTTP 422; the other variants map to HTTP 409. API and
browser decoders reject unknown fields/variants. Every variant preserves the
draft or uncommitted choice and supplies typed recovery; none retries,
substitutes, or parses status text.

`POST /chat-runs/{run_id}/rerun` and the regeneration endpoint accept the same
`catalog_definition_revision`, `selection`, and `tool_authority` triple as
create and return `RunSelectionOut`; neither is bodyless. The canonical
`chat_run_idempotency.compute_payload_hash`, `compute_rerun_payload_hash`, and
`compute_regeneration_payload_hash` include the exact tagged selection and
authority. A confirmed replacement therefore mints a distinct answer identity
instead of colliding with source-selection replay.

The old FastAPI `GET /llm-profiles`, browser `/api/llm-profiles`,
`LlmProfilesOut`, `LlmProfileOut`, `ChatProfileId`, `profile_id`,
`profile_catalog_revision`, fixed effort labels, and profile inheritance fields
are deleted with no aliases.

### 5.3 Tool authority

| Authority/plan | Exact grants |
|---|---|
| `NoModelTools` | none; no schemas or MCP configuration are published |
| `idea_dossier_research` | existing HostTable `web.search` only; outside the model turn |
| `LibraryDossierRead` | `nexus.search`, `nexus.resource.read`, `nexus.document.search`, `nexus.resource.inspect`, `nexus.relations.list` |
| `IdeaDossierRead` | `nexus.search`, `nexus.resource.read`, `nexus.document.search`, `nexus.resource.inspect`, `nexus.relations.list` |
| `ChatRead` | `web.search` plus the five Nexus reads above |
| `ChatReadAdditiveWrite` | `ChatRead` plus `nexus.library.add`, `nexus.note.create`, `nexus.highlight.create`, `nexus.edge.create`, `nexus.queue.add` |

| Plan | Calls | External attempts | Input | Output | In flight | Elapsed | Extra effect bound |
|---|---:|---:|---:|---:|---:|---:|---|
| `ChatRead` | 64 | 128 | 4 MiB | 16 MiB | 1 | 900 s | none |
| `ChatReadAdditiveWrite` | 64 | 128 | 4 MiB | 16 MiB | 1 | 900 s | eight non-reverted writes |
| `LibraryDossierRead` | 16 | 0 | 256 KiB | 4 MiB | 1 | 120 s | none |
| `IdeaDossierRead` | 12 | 0 | 128 KiB | 2 MiB | 1 | 120 s | none |

`ChatRead` publishes exactly six declarations; `ChatReadAdditiveWrite`
publishes exactly eleven. The lowered definition set for either plan remains at
or below 12,288 bytes. The additive plan retains the durable trust trail and
one-tap Undo in addition to its eight-live-write cap.

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

The surviving Codex transport is authenticated HTTPS MCP at
`/internal/agent-tools/mcp`, package pin `mcp==2.1.0`, protocol revision
`2025-06-18`. Its short-lived route-neutral bearer contains only subject/user,
generation, attempt, lease fence/expiry, plan and binding revisions, scope
digest, budgets, effect mode, audience, issuer, and nonce identity. It never
contains provider/model selection or a `chat` capability literal. The MCP
mount is private to confined Codex workers; this cutover creates no public or
general-purpose MCP surface.

Reads execute automatically. Chat receives `ChatRead` at admission and can
receive `ChatReadAdditiveWrite` only after an explicit `AdditiveWrites` request.
Background admission automatically authorizes only the exact developer-owned
read plan in section 3.4; no background run pauses for approval or gains a
write. Every binding in a frozen Chat plan is admission-required: known
unavailable bindings refuse the request before any durable Chat state is
committed. All five Nexus-read bindings are likewise admission-required for
`LibraryDossierRead` and `IdeaDossierRead`; a known missing binding blocks those
unattended admissions. A binding that becomes unavailable only after admission
remains declared and terminalizes `ToolUnavailable` before its dispatch.
The same authenticated MCP mount and bearer shape serve every Codex
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

Every concrete target created by the five additive Chat tools is atomically
associated with its canonical generation, tool position, and stable effect.
Created-target cardinality is exact: `nexus.library.add` and `nexus.queue.add`
associate either zero targets for a legitimate idempotent no-op or exactly one
`library_entry`/`queue_item`; `nexus.note.create` associates exactly one
`note_block`; `nexus.edge.create` associates exactly one `resource_edge`; and
`nexus.highlight.create` associates exactly one `highlight` plus zero or one
attached `note_block` according to its request. A second target of any permitted
kind is extra. Missing, extra, duplicate, foreign, or mismatched associations
are integrity defects and fail closed. Later model reads expose bounded
provenance for notes, highlights, and relations; trust detail visibly attributes
assistant-created targets; Undo preserves the provenance fact.

The closed projection is `target_kind`, `target_id`, `generation_id`,
`generation_seq`, `tool_position`, `position_path`, and `effect_id`.
`generation_seq` and `tool_position` are strict integers in
`[1, 2_147_483_647]`, and `position_path` must equal
`generation/{generation_seq}/tool/{tool_position}`. Undoing the effect does not
rewrite this audit fact.

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
        source_context_window: Presence<TokenCount>
        source_max_output_tokens: Presence<TokenCount>
        input_modalities[]
        reasoning[]: AgentReasoningFacts(key, label, native_wire_value)
        source_default_reasoning: Presence<AgentReasoningKey>
        upgrade: Presence<UpgradeFacts(target_key)>
        retirement: Absent
        row_fingerprint

  It must not use the convenience `Codex.models()`/`model_list()` methods.
  Drive the public generic async RPC
  `request("model/list", {includeHidden: false, cursor}, ModelListResponse)`,
  loop on `next_cursor`, and fail on a repeated cursor, an unterminated cursor,
  or more than 64 pages—never return a truncated account. Return every
  non-hidden row in native order and reject duplicate/incomplete facts. A
  present source default names exactly one reasoning row. Native upgrade text
  resolves against both observed `id` and dispatch `model` with exactly one
  match, then stores that row's `id`; zero/ambiguous matches yield `Absent` plus
  a typed diagnostic. The SDK exposes no retirement instant. Claude returns
  `UnsupportedCapability`; Nexus does not configure that lane.

  `definition_revision` is a domain-separated hash of the canonical ordered
  row fingerprints and is stable for identical observations. Each row
  fingerprint covers key, dispatch value, label, both capacity `Presence`
  values, ordered reasoning
  keys/native values/default, modalities, and exact upgrade source facts. It
  excludes `observed_at` and the optional opaque native revision, which are
  provenance only.
- Replace the flat string-discriminated `AgentSessionRequest` with the tagged
  union required by [tagged-unions](../rules/tagged-unions.md):

      CodexCatalogSessionRequest(
        model_key, reasoning, agent_definition_revision, row_fingerprint, ...
      )
      | ClaudeNativeSessionRequest(...)

  The Codex arm validates all catalog-bound facts and resolves
  `dispatch_model` inside AgentRuntime before billable work; free-form Codex
  pass-through is impossible. Its optional validated MCP configuration is
  operation-neutral: absent means `NoModelTools`, present means the exact
  plan-derived allowlist and bearer. No `chat` literal controls SDK tool access.
  The Claude arm does not require an unsupported catalog, and Nexus can
  construct only the Codex arm. This is a breaking `llm-calling` API change:
  runtime, adapters, session store, tests/fakes, and public exports switch in
  one library commit; the old cross-field validators and free-form Codex
  `model: str | None` path are deleted, not retained alongside it.
- Add one immutable ProviderRuntime query:

      ApiModelCatalog
        backend_contract_revision
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
        source_default_reasoning: Presence<ReasoningLevel>
        continuation_codec
        row_fingerprint

  `api_model_catalog()` is the sole public catalog oracle. Its canonical tuple
  is duplicate-free, every present default is a member of its nonempty reasoning tuple,
  and its definition revision is content-derived. A row with no native
  reasoning knob projects the explicit `none` selection. Nexus never imports
  or compares private registry rows; catalog equality, filtering, revisions,
  and proofs all use this API.
- Rename `ROWS`, `resolve`, and `resolve_target` to module-private owners;
  ProviderRuntime is their only production caller. Update the package facade
  and add a negative architecture gate proving no external module can obtain a
  `ModelRow`.
- Promote provider-documented default reasoning into source-cited, validated
  row data. OpenRouter Kimi remains `Absent` until its exact endpoint default
  has a provider source and verified date. Add source-cited
  `upgrade: Presence<UpgradeFacts>` and
  `retirement: Presence<RetirementFacts>` to each row; an upgrade target must
  resolve to a present row. Initial values are honestly `Absent` where no
  vendor fact exists. Nexus filters the public tuple only by configured
  provider and recreates neither defaults nor an allowlist.
- Make `ContinuationArtifact.opaque_payload` a frozen bounded `JsonValue`
  using one shared `freeze_json_value`/`FrozenJsonDict` owner. Its constructor
  enforces a 16 MiB maximum canonical encoding; a caller may impose a lower run
  bound. Public `encode_continuation` and
  `decode_continuation(bytes, target, codec_id)` own canonical serialization
  and reject target/codec mismatch; Nexus seals only those canonical bytes.
- Keep readiness and Nexus capability qualification outside both source
  catalogs. Native model-list or registry presence and credential presence are
  not proof of successful generation, strict output, tools, or quota.
- Keep the existing operation-neutral function-tool adapter and add an adjacent
  plan-derived MCP publication/observation adapter. The MCP adapter remains the
  deep optional module `provider_runtime.agent_runtime.tool_projection`; it is
  not re-exported from the dependency-light AgentRuntime root. A clean base wheel
  imports without `llm_tools`, `openai_codex`, or `claude_agent_sdk`. Both
  adapters accept only the frozen canonical plan; neither chooses tools from
  product operation names.
- Keep lane-local API proposal projection in ProviderRuntime and canonical MCP
  observation projection in AgentRuntime. Nexus alone composes them into
  `BackendEvent`.
- Preserve full route-specific terminal evidence as a tagged union.
- Expose typed Codex controls for both the child `TMPDIR` root and
  `sandbox_workspace_write.exclude_slash_tmp`/
  `exclude_tmpdir_env_var`, and apply them on every session-opening path.
  Remove Nexus's private SDK configuration subclass; Nexus retains only its
  confined turn-layout, mode-0700, and no-symlink policy.
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
display/disclosure, prompt/input/output identity, and fingerprint. Each child
records route-native dispatch state, request identity, usage/billability, and
tagged terminal evidence. Each tool position records canonical id/input digest,
plan/binding revisions, scope and budget identity, result evidence, effect
identity where applicable, settlement, and replay status.

`assistant_write_authorships` has a deterministic identity and one true unique
key on `(target_kind, target_id)`. It links only to the canonical tool position;
it deliberately has no target FK so deletion or Undo cannot erase authorship
history. Application validation owns its closed target vocabulary, exact
cardinality, target visibility/ownership, and correspondence to the tool receipt.

The sole durable tool-position grammar is:

    generation/{generation_seq}/tool/{n}

`n` is one-based and monotonically allocated under the parent generation fence
across every child model turn. An API model/tool/model loop does not restart the
ordinal at a child boundary; Codex MCP observations use the same grammar inside
its single child. No `turn/{i}/tool/{j}` identity survives.

After a background worker owns the admitted attempt and lease, it mints a
short-lived bearer solely from that frozen snapshot. A bearer cannot outlive the
worker lease or transport deadline. Chat and background use the same claim
schema; their different authority comes only from the frozen plan, effect mode,
scope, and budgets. `NoModelTools` mints no bearer.

Provider continuation artifacts are bounded, target/codec-bound, sealed with
AES-256-GCM, never logged/rendered, and deleted when consumed or terminal.
Associated data binds generation, child position, target, codec, and policy.
Each seal uses a fresh random 96-bit nonce and a versioned envelope; a nonce is
never derived from counters or durable positions. Decrypt/authentication
failure is a typed terminal refusal, never a retry, alternate-key attempt, or
downgrade. A child's terminal evidence and the sealed continuation for its
successor are committed in one database transaction after all external I/O.
Key rotation drains API generations and replaces the single key; no
compatibility reader ships.

### Failure and replay rules

- no database transaction spans UDS, SDK, MCP, provider HTTP, or Brave I/O;
- record uncertainty before dispatch and terminal evidence before publication;
- completed children and tool positions replay without redispatch;
- API model/tool/model continuation may resume only from its sealed next-child
  state; Codex MCP observations remain positions inside its single native turn;
- neither bearer validation nor replay compares a frozen run against the
  listener's current policy revision; DB-locked run, attempt, lease, and frozen
  plan/scope facts are the sole authority;
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

It is required, present, and nonempty in staging and production. Local/test
environments must choose an explicit value, including an explicit empty fixture
only where the test contract calls for it. The product catalog contains exactly
the `api_model_catalog()` rows for that subset.
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

The cutover rotates/renames the five deployed generation credentials and adds
OpenRouter and xAI before application rollout. Startup refuses any retired
generation `*_API_KEY` name; embedding-only `OPENAI_API_KEY` is the sole
exception. `deploy/hetzner/sync-env.sh` and the backend production env example
publish `GENERATION_API_PROVIDERS`, exactly the credentials named by that set,
`GENERATION_CONTINUATION_ENCRYPTION_KEY`, and conditional Fable acceptance;
unconfigured credentials are refused. `deploy/vercel/sync-env.sh` removes and
rejects every provider-generation key, continuation key, provider list, and
retention acceptance because the BFF never owns provider execution. Frontend
and worker examples contain none of them. No half-configured Codex-only
production catalog is accepted.

## 7. Hard-cut migration and deletion

PR #203's `0224_codex_personal_generation.py` is unshipped. Rewrite it in place
into the one final schema; do not stack a corrective migration over an
unreleased shape. The migration deliberately resets the complete legacy Chat
aggregate and every historical generation/metering ledger. There is no legacy
ID table, exact-fact reconstruction, historical selection projection, or
rerun-ineligible arm.

### 7.1 Preservation boundary

Preserve every row and durable blob outside the closed deletion set below,
including:

- users, identities/sessions, memberships/invitations, billing accounts and
  current entitlements;
- libraries, entries, media/files/uploads, transcripts/fragments/indexes,
  contributors, podcasts, reader state/profile/progress, pages, note blocks,
  highlights, queue/consumption state, and non-conversation graph data;
- non-conversation Artifacts/Dossiers, Idea state, Oracle corpus/readings,
  Dawn, Synapse, summaries, and other published domain outputs; and
- domain objects created by old Chat writes—library membership, notes,
  highlights, non-conversation edges, and queue entries—as ordinary durable
  content.

Old Chat-level authorship, tool receipts, trust detail, and Undo handles for
those retained objects are intentionally lost. Delete graph rows whose endpoint
is a deleted `conversation` or `message`; retain a Chat-created edge between
two preserved non-conversation resources. Delete conversation-subject Dossiers
and their builds/revisions/events/citation edges; they cannot survive without
their subject. No other Artifact is touched.

The reset set is the explicit transitive closure of every real FK and typed
polymorphic reference to a deleted conversation, message, Chat run/tool row, or
conversation Artifact. Preflight inventories that closure and refuses an
unclassified reference; a new table cannot become an accidental orphan or an
accidental deletion. A preserved domain object may retain domain-owned
machine-origin metadata that contains no deleted identity; never rewrite
assistant authorship to user authorship. Only Chat-run/tool provenance and Undo
authority disappear.

Before mutation, the migration records row counts and deterministic primary-key
digests for each preservation family in a transaction-local temporary manifest;
afterward it asserts equality and drops the manifest before commit. Tests query
the same fixture rows independently. This is not an application audit table or
a log of user identifiers.

### 7.2 Drain and transaction

Deployment first stops generation workers and refuses new Chat/generation
admission. Migration preflight refuses:

- any nonterminal `chat_runs`, `llm_calls`, or `agent_turns` row;
- any pending/running/failed/dead generation-kind background job;
- any uncertain generation/tool dispatch journal; or
- an Artifact build or Learn resolver whose outcome could still publish.

Operators drain or explicitly cancel those exact rows and rerun the migration;
the migration never guesses. A production backup/PITR checkpoint is a prudent
operator safeguard but is outside repository acceptance and is not represented
as a tested disaster-recovery guarantee.

Within one deterministic PostgreSQL migration transaction, using explicit
child-first deletes rather than broad cascade:

1. Snapshot the IDs for legacy conversations/messages, conversation Artifacts,
   and generation-kind jobs.
2. Delete conversation Artifact children and heads, their citation/evidence
   edges, graph/view/version rows whose endpoint is a deleted conversation or
   message, and other typed conversation-only projections.
3. Empty `chat_run_events`, `chat_prompt_assemblies`,
   `chat_run_turn_contexts`, `message_retrievals`, `message_tool_calls`,
   `conversation_active_paths`, `conversation_branches`, `conversation_shares`,
   `chat_runs`, `messages`, and `conversations`. This removes every legacy Chat
   tool receipt, result-ref association, trust projection, and effect/Undo state
   owned by `message_tool_calls` and `message_retrievals`; 0223 has no separate
   machine-authorship table.
4. Delete generation-kind `background_jobs` and their coordination journals;
   leave unrelated queue rows byte-for-byte unchanged.
5. Drop legacy `llm_calls`, `agent_turns`, `token_budget_charges`,
   `token_budget_reservations`, and `token_budget_daily_usage`; remove only the
   retired platform-token limit/quota fields from billing override rows.
6. Retain the existing deterministic historical-failure retagging required by
   preserved Artifact and Oracle domain event unions. Retagging preserves those
   domain outcomes; it does not preserve their model-call history.
7. Create only the final parent generation, child model-turn, sealed
   continuation, tool-position, and empty `assistant_write_authorships` schema.
   Rebuild the empty Chat tables into their final exact-selection/authority
   shape. `GenerationSpec` subsumes
   `chat_runs.profile_id`, `tool_profile_id`, `tool_profile_revision`, and
   `tool_profile_snapshot`; those columns and `llm_calls.capability_kind` do not
   survive.
8. Assert zero rows in every reset set and in the new authorship association,
   no dangling conversation/message polymorphic refs, equality of all
   preservation digests, and one final schema with no legacy
   column/table/constraint.

There is no downgrade, network/catalog lookup, backup reader, dual writer,
translation function, compatibility selector, or coercion. Release/startup
preflight—not the migration—loads the composed catalog and proves the Chat seed
and every section 3.4 background selection/output/tool-plan pair. Missing
qualification aborts rollout/startup; account creation seeds nothing.

### 7.3 Browser reset

The draft namespace advances from `nx_chat_draft.v2:` to
`nx_chat_draft.v3:`. V2 is never decoded or migrated and is purged on first
load. A discarded v2 `Submitting`/`ReconcileRequired` command produces one
visible notice that old Chat history was reset and the ambiguous send cannot be
reconciled. V3 stores only bounded composer text/context, exact
`GenerationSelectionSpec`, and per-run `tool_authority`; it contains no profile
ID or default.

### 7.4 Reuse boundary

Prefer semantic undelete over reimplementation for:

- provider labels, privacy/retention copy, startup validation, and fixtures;
- provider-native continuation/tool-loop mechanics;
- credential construction and bounded deterministic provider conformance;
- prior model/reasoning selector UI primitives whose behavior fits the new
  catalog;
- proofs whose independent oracle still matches this target.

Fold reused behavior into the new owners. Do not restore the old provider
ledger, provider-specific tools, domain-direct dispatch, legacy Nexus-private,
cache/CLI, or provider-marketplace discovery, automatic routing/fallback,
generation preference/default behavior, or compatibility decoders. The new
authenticated AgentRuntime catalog is the sole Codex discovery path.

### 7.5 Verified deletion manifest

The machine-checkable deletion manifest is limited to owners verified present
at PR source SHA `38df77279bd67a438db637677857f7f47a2f1d51` or production
snapshot `42f33dc4fc896d0e01287f68ef1d300d47440db1`. Each manifest row must
exist at its named base and be absent at the candidate; absent-at-both is a
manifest defect, not green.

- [both] all Fast/Balanced/Deep UI/copy/shortcuts/profile cards and all nine
  shipped generation profile IDs (`fast`, `balanced`, `deep`, `claude`,
  `fable`, `gemini`, `kimi`, `deepseek-flash`, `deepseek-pro`) from runtime
  owners and decoders; historical Git/migration text is not runtime support;
- `PlanId`, `PLANS`, `_BACKGROUND_PLAN`, `ChatProfile`,
  `CHAT_PROFILES`, `_CHAT_PLAN`, `_CHAT_POLICIES`, and
  `chat_policy(profile)` [PR branch];
- FastAPI `GET /llm-profiles`, browser `/api/llm-profiles`,
  `LlmProfilesOut`, `LlmProfileOut`, `ChatProfileId`, the server-owned
  `default_profile_id` response field, `_PROFILE_ORDER`, `_PROFILE_LABELS`,
  `_MODEL_LABELS`, `_EFFORT_LABELS`, and generation `profile_id`/
  `profile_catalog_revision` fields [both/PR as applicable];
- `ChatProfilePicker`, `useChatProfiles`, `chatProfileContract`,
  `chatProfileSelection`, the three-card CSS, and silent
  `UnavailableReplacement` [PR branch];
- `MODEL_BOUNDS` and every model-name label/bounds table; catalog facts replace
  them [PR branch];
- `profile_selection_active`, `active_profile_run_ids`, the old profile rows in
  the assistant trust read model, and their profile-based rerun policy [PR
  branch];
- the `ChatTools` capability discriminant and every `operation == chat` check
  that controls MCP configuration, bearer minting, tool publication, or tool
  observation; replace them atomically with frozen `ModelTools` plan presence,
  with no compatibility literal or alias [PR branch]; specifically replace
  `agent_tools_mcp._grant_matches_generation`,
  `AgentToolAuthority.from_claimed_chat_attempt`, and
  `llm_ledger.current_tool_plan_fingerprint` process-policy comparisons with
  frozen `GenerationSpec` comparisons;
- [PR branch] Codex-only route literals in shared policy, API, ledger, product-health, and UI
  owners; retain exact Codex backend/SDK/auth/process facts only inside its
  private adapter and host-health owner, then project them to shared readiness;
- [both] five-provider-only config/credential unions and fixed hosted-turn counts;
- [both] deleted-era provider owners superseded by GenerationService;
- [PR branch] `generation_plans.v1.json`, `tool_safety.v3.json`, stale proof/fault registry
  rows, and every reference to the deleted normative Codex-only filename;
- [PR branch] the normative Codex-only spec after live contracts migrate; retain its change
  report as historical evidence.

Historical Git objects are history, not compatibility.
Unrelated application Settings surfaces are out of scope. Preserve
`llm_tools.CapabilityProfile`, `ProfileId`, `ToolPlan`, runtime auth-profile
identity, and `tool_runtime/profiles.py`; they are tool/transport identities,
not generation-selection profiles. Their plan identities become only
`ChatRead`, `ChatReadAdditiveWrite`, `LibraryDossierRead`,
`IdeaDossierRead`, and `idea_dossier_research` where relevant.

Never build the generation Settings/page/API/table/default owners proposed only
by earlier drafts. Do not replace the deleted server response
`default_profile_id` or any removed selection surface with a user preference.

## 8. Non-overlapping implementation lanes

One explicit integration precursor is allowed: **T0** replaces `ChatTools` /
`capability_kind` with frozen `ModelTools` plan presence across S/T/C/D and the
rewritten `0224` in one commit. All lanes branch from T0; no compatibility
discriminant exists between commits.

| Lane | Exclusive paths/concern | Depends on | Exit |
|---|---|---|---|
| U | sibling `llm-calling`: two public catalogs, tagged Agent request restructure, private provider registry, continuation codec, lane-local tool projections, sandbox controls, conformance/docs | none | breaking callers switched atomically; exact immutable pin green |
| S | Nexus selection/catalog/developer policy, config/schema, prompt bounds and pure proofs | U | complete catalog plus total exact policy green |
| L | models, rewritten `0224`, aggregate reset, parent/child ledger, continuations, capacity wait and migration/service proofs | S, T0 | empty and synthetic-0223 reset/replay green |
| T | route-neutral tool authority, tool runtime, grants, MCP adapter and proof | S, U | any operation-owned frozen plan works through both transports |
| C | Codex host/adapter, confinement, deploy env sync, MCP/module/runbook contracts | S, T, U | Codex catalog/dispatch and operation-neutral MCP green |
| V0 | test-control-plane `PROVIDER_API_PEER`: `ResourceKind`, recovery ledger, controller-owned loopback TLS/ports/base-URL substitution, fixture credentials and cleanup | U | deterministic seven-provider peer green; product code has no fixture branch |
| A | API adapter, credentials and provider transcripts; no domain callers | S, L, T, U, V0 | API multi-turn/strict/tool adapter green only through `PROVIDER_API_PEER` |
| D | all background owners and Chat orchestration call sites | L, C, A | complete portfolio uses GenerationService and its frozen tool mode |
| W | FastAPI catalog/Chat routes, v3 draft reset, Web picker/consent/disclosure/history UX | S, D | service and Chromium contracts green |
| E | `generation_plans.v2`, `tool_safety.v4` and unattended prompt-injection evals | S, T, D | `llm-eval` green |
| V | final registry/digest/workflow reconciliation, cross-doc banners, residue audit and integration | all | sensitivity, `pr`, `full`, `nightly`, and `release` evidence |

Each lane owns and lands the proof-registry rows and fault patches for files it
creates/deletes in the same commit; otherwise intermediate `changed` gates are
invalid. Lane V owns only final `PRIORITY_RISK_OWNERSHIP_SHA256`/routing digest,
workflow YAML, and duplicate-owner reconciliation. If paths collide, sequence
the exact commits; never use wholesale ours/theirs.

V0's controller environment replaces every provider `base_url` with its owned
TLS loopback origin and denies every other provider host. It supplies the seven
fixture generation keys and continuation key through the canonical run
environment only; production code contains no fixture conditional.

## 9. Red / green / refactor and 80/20 proof

Follow [Nexus testing standards](../local-rules/testing-standards.md).
`./scripts/test` is the only workflow verdict. Each proof names its risk,
asserts behavior through the highest useful public boundary, and records a
meaningful RED before GREEN.

| Ownership boundary | Canonical proof owner | Named scenarios |
|---|---|---|
| `llm-calling` model catalogs | `llm-calling@16499e1c4783a890063f51bb16b64d48b0cdbe3b` `pytest:tests/test_model_catalogs.py` | two-page/repeated-cursor Codex catalog; incomplete-source refusal; exact immutable API rows/default Presence/private registry |
| `llm-calling` authenticated catalog query | `llm-calling@16499e1c4783a890063f51bb16b64d48b0cdbe3b` `pytest:tests/test_agent_runtime.py::test_model_catalog_is_an_authenticated_route_query_without_session_effects`; `pytest:tests/test_agent_codex_sdk.py::test_model_catalog_accepts_initialize_user_agent_without_server_info` | authenticated query; no session-open effect; exact low-level initialize response without optional `serverInfo` |
| `llm-calling` tagged Agent request | `llm-calling@16499e1c4783a890063f51bb16b64d48b0cdbe3b` `pytest:tests/test_agent_runtime.py::test_open_session_rejects_values_outside_the_tagged_request_union` | closed request union; foreign value refused before auth or adapter effect |
| `llm-calling` continuation codec | `llm-calling@16499e1c4783a890063f51bb16b64d48b0cdbe3b` `pytest:tests/test_continuation.py::test_continuation_round_trip_is_canonical_bound_and_recursively_immutable` | canonical round trip; recursive immutability |
| `llm-calling` continuation binding | `llm-calling@16499e1c4783a890063f51bb16b64d48b0cdbe3b` `pytest:tests/test_continuation.py::test_continuation_decode_rejects_target_codec_and_noncanonical_bytes` | target/codec mismatch and noncanonical bytes refuse |
| `llm-calling` package surface | `llm-calling@16499e1c4783a890063f51bb16b64d48b0cdbe3b` devbox workflow-equivalent `test` and `test-without-optional-sdk` lanes | clean base wheel imports AgentRuntime without `llm_tools` or either SDK; each optional extra remains independently installable |
| Nexus catalog/selection | `pytest:python/tests/service/test_generation_catalog.py::test_complete_catalog_and_selection_contract` (canonical node; the whole file stays registered, so its sibling nodes remain priority-routed) | complete configured set; source-controlled qualification binding; private HTTP projection; semantic-vs-readiness revision; stale/invalid exact pair |
| Developer policy facts | `pytest:python/tests/kernel/test_generation_policy.py::test_exact_generation_policy_is_total_content_derived_and_profile_free` | exact seed and fourteen rows; content-derived revision; no profile vocabulary |
| Developer policy/admission | `pytest:python/tests/service/test_generation_policy.py::test_total_policy_and_frozen_admission_contract` | exact frozen selections/specs/policy revision/tool modes |
| Background capacity admission | `pytest:python/tests/service/test_generation_capacity_pause.py` | exact durable `CapacityPaused`; ready admission clears it; reschedule preserves retry budget; rebuild admits current policy; frozen admission unchanged under revision |
| Transport projection | `pytest:python/tests/kernel/test_generation_transport_projection.py::test_one_plan_lowers_to_both_transport_contracts` | function alias reversal; MCP allowlist; `NoModelTools`; proposal vs observation |
| Route-neutral backend runtime | `pytest:python/tests/kernel/test_generation_backend_runtime.py::test_closed_backend_event_projection_retains_codex_terminal_truth` (canonical node; the whole file stays registered, so its sibling nodes remain priority-routed) | closed event projection; pre-admission capacity; Codex cancellation; API child/tool/successor ordering and resume; strict-plus-tools route difference |
| ProviderApi qualification | `pytest:python/tests/service/test_provider_generation_backend.py::test_route_local_transcripts_preserve_terminal_truth` | all eleven targets and 47 reasoning wires; seven strict engine shapes; fourteen qualified tool continuations; usage and succeeded terminals |
| Durable execution | `pytest:python/tests/service/test_generation_execution.py::test_provider_crash_after_accepted_child_resumes_one_successor_without_redispatch` (canonical fault-bound node; the whole file stays registered, so `test_parent_child_tool_replay_is_exactly_once` and `test_foreign_provider_failure_is_refused_not_relabelled` remain priority-routed) | API crash after accepted child; one successor; exact tool-position replay; two model turns; zero continuations; no duplicate usage; foreign provider failure refused before ledger landing |
| Tool authority | `pytest:python/tests/service/test_generation_tool_authority.py::test_frozen_plan_is_transport_neutral_and_fenced` | transport-neutral read execution; durable position order and exact replay; scope, foreign-generation, bearer, and lease fences; write plan without revert-owning projection refused |
| Codex MCP transport gate | `pytest:python/tests/service/test_agent_tools_mcp_gate.py::test_public_mcp_mount_admits_only_a_live_bearer_on_the_exact_protocol` | live bearer and initialize journal one position; unmounted, tampered, expired, absent bearer 401; protocol/session 400; body 413; source and grant 429 |
| Chat write/Undo authority | `pytest:python/tests/service/test_llm_tool_safety.py::test_all_mutating_tools_enforce_owner_persistence_and_idempotent_undo` | persisted `ReadOnly`/`AdditiveWrites` prompts match the frozen authority; five additive write tools; owner persistence; idempotent Undo |
| Machine-authorship lifecycle | `pytest:python/tests/service/test_machine_authorship.py::test_all_additive_writes_publish_durable_authorship_into_later_model_reads` | all five creating writes; highlight plus note; exact persisted targets; later note/highlight/relation reads; Undo; missing/stable-identity corruption refused |
| Machine-authorship wire | `vitest:apps/web/src/lib/conversations/trustToolCallWire.unit.test.ts` | exact closed decode; missing/extra fields, nonpositive or int32-overflow positions, and incoherent path refused |
| Chat write/Undo presentation | `vitest:apps/web/src/components/chat/AssistantWriteTrail.browser.test.tsx` | visible attribution and owned Undo; no-target and unhydrated states |
| Artifact generation provenance | `pytest:python/tests/service/test_artifact_revision_generation_provenance.py::test_revision_reads_project_retired_frozen_generation_identity_without_mutation` | immutable retired-generation identity is projected without mutating the revision |
| Background run detail | `pytest:python/tests/service/test_dossier_build_generation_detail.py::test_head_projects_capacity_pause_and_admitted_selection_read_only`; `vitest:apps/web/src/components/dossier/DossierSurface.browser.test.tsx` | durable `CapacityPaused` with `next_check_at`/`reset_at` and the admitted selection, disclosure, and exact tool plan on the public Dossier head; "Waiting for Codex capacity" with the existing Cancel and a read-only detail line exposing no control, credential, or price |
| Secrets/confinement | `pytest:python/tests/service/test_generation_secret_isolation.py::test_route_secrets_and_continuations_never_cross_boundaries` | cross-route credential projection; sealed-continuation non-disclosure; terminal redaction; ProviderApi header/body observation; native process, bearer/lease, and egress stay with their existing named owners |
| Provider loopback control | `pytest:python/tests/kernel/nexus_test_control/test_provider_api_peer.py::test_provider_peer_is_controller_owned_and_recovered` | resource/port/credentials; TLS/base URL; recovery/cleanup; no fixture branch |
| Operation portfolio | `pytest:python/tests/kernel/test_generation_operation_adapters.py` | exact fourteen intent/policy rows; exactly Library/Idea `ExactModelTools`; exactly twelve `NoModelTools`; Dawn, Media Unit, Oracle, and Synapse task adapters delegate one frozen route-neutral generation; content owners cannot choose runtime policy |
| Reset migration admission | `pytest:python/tests/migrations/test_generation_backends_cutover_admission.py::test_0224_refuses_the_only_undrained_generation_job_before_history_reset` | otherwise-empty 0223; one pending generation job is the sole violated preflight invariant; exact refusal before mutation |
| Reset migration convergence | `pytest:python/tests/migrations/test_generation_backends_cutover.py::test_0223_aggregate_reset_preserves_domain_data` | empty DB; synthetic 0223; domain-reference refusal; preservation digests; empty final authorship table; zero legacy refs |
| Product Chat API | `pytest:python/tests/service/test_generation_chat_api.py::test_exact_selection_and_authority_cross_every_chat_projection` (canonical node; the whole file stays registered, so its sibling nodes remain priority-routed) | create/idempotency/frozen spec/history/trust; rerun/regenerate authority; strict legacy/bodyless ingress; typed selection failures; pre-durable binding refusal; closed failure projection and rerun eligibility |
| Product catalog API | `pytest:python/tests/service/test_generation_catalog.py` (sibling nodes of the registered whole-file owner; canonical node above) | strict private catalog projection and typed source failure |
| Product SSE selection wire | `vitest:apps/web/src/lib/api/sse/events.selection.unit.test.ts`; `pytest:python/tests/kernel/test_generation_selection_wire_contract.py` | complete immutable selection decode; incomplete/widened projection refusal; closed selection-state and readiness unions pinned identically on both sides; retired codes refused |
| Product UI | `vitest:apps/web/src/components/chat/GenerationSelection.browser.test.tsx` | provider/model/reasoning dispatch; billing/privacy/processor disclosure; retired-row refusal; one-run write consent/reset; stale/no-selectable draft retention; desktop Escape/focus return; unavailable rerun replacement |
| Billing disclosure | `vitest:apps/web/src/app/(authenticated)/settings/billing/GenerationBillingDisclosure.browser.test.tsx` | Codex subscription and metered Provider API facts; no generation controls |
| Privacy disclosure | `vitest:apps/web/src/app/privacy/PrivacyPage.browser.test.tsx` | all configurable Provider API processors/routes and background Codex statement |
| Catalog public wiring | `playwright:apps/web/e2e/journeys/durable-ingest-reader-open.journey.spec.ts` | browser to `/api/llm-catalog` BFF to FastAPI catalog boundary |
| Chat public wiring | `playwright:apps/web/e2e/journeys/grounded-chat-citation.journey.spec.ts` | one admission; admitted catalog-revision shape; durable citation; reload; exact reader activation |
| Oracle/Dossier failure wire | `pytest:python/tests/kernel/test_oracle_wire_contract.py`; `pytest:python/tests/kernel/test_dossier_failure_wire_contract.py`; `vitest:apps/web/src/lib/oracle/oracleReadingWire.unit.test.ts`; `vitest:apps/web/src/lib/dossiers/dossierFailureContract.unit.test.ts` | current and preserved historical failure unions remain exact across backend/Web codecs |
| LLM evaluation | `pytest:python/tests/evals/test_tool_safety_eval.py::test_generation_tool_plans_refuse_untrusted_escalation` | poisoned Library scope widening; Idea Web-egress attempt; zero mutation |
| Hard-cut residue | `pytest:python/tests/kernel/test_generation_cutover_residue.py::test_only_final_generation_owners_remain` | deletion manifest; strict decoders/build/import graph; zero stale doc references |
| External reality | `deploy/hetzner/prove-codex-capacity.sh <candidate-sha>` at release time | subscription-authenticated Codex generation on the existing VPS at the exact candidate SHA; no hosted Codex canary exists |

Each implementation lane registers the files and proof owners it changes under
the existing priority risks below in the same commit, as section 8 requires.
Lane V only reconciles duplicate ownership and freezes the final routing digest.
Add no parallel risk portfolio. `testdata/proofs.json` is the sole source-glob
authority; duplicating its path lists here would create a second routing owner.
It routes at risk granularity, so every source glob selects every proof owner in
its risk row.

The final manifest registers these boundaries under the existing
`auth-privacy-secrets`, `citation-provenance-identity`, `codex-generation-host`,
`costly-effects`, `durable-job-replay`, `generation-ledger-contract`,
`generation-reconciliation`, `llm-tool-safety`, `migration-compatibility`, and
`production-release-test-control` risks. Its exact proofs and capabilities are
not duplicated here: `testdata/proofs.json` is authoritative and its normalized
priority-risk ownership digest is frozen by `nexus_test_control.model`.

RED:

- Every registered canonical proof must reach a controller-classified
  `behavioral_assertion_failure`. A collection/import/setup error is rejected
  evidence. Automatic PR sensitivity follows the repository's fail-closed
  owner rule: a new owner or a materially changed exact owner/support graph uses
  BASE even when a fault is registered; only an unchanged exact owner may use
  its registered FAULT automatically. The sole typed exception is an exact
  module-level Python owner whose one registered fault explicitly declares
  `changed_owner_red: coherent-fault`. That declaration is allowed only when a
  hard-cut interface or behavior-preserving ownership refactor makes BASE an
  incoherent witness; policy validates its exact owner, version-stable
  source-slice owner/support digest, patch, checksum, and assertion fingerprint,
  while this spec and the work report own the rationale. Any exact-owner or
  shared-support drift invalidates the exception until it is reviewed and
  repinned. The exception controller has its own standalone canonical BASE
  sensitivity proof.
  The three cutover-selected exceptions are the durable same-worker attempt
  fence, process-containment dimension, and ingest-readiness owners. All three
  candidate proofs call the hard-cut terminal queue API with required
  `attempt_no`, while BASE lacks that signature and therefore cannot complete or
  falsify their retained scenarios. The durable and process-containment owners
  fail before their target assertion; readiness reaches its pre-success
  assertion, then fails before the success/freshness transitions under test.
  The parser-dimension owner does not use the exception because its exact owner
  remains coherent on BASE. A BASE proof checks an absent
  `find_spec`, absent public route/schema field, or old public behavior before
  candidate code executes. Candidate-only imports are either inside the
  post-assertion scenario or guarded by `TYPE_CHECKING or _CUTOVER_PRESENT`, so
  BASE collection cannot import them. Record the exact failing assertion
  fingerprint before green.
- A materially adapted pre-existing owner needs both witnesses when BASE can
  prove only the new setup/cutover dependency: automatic BASE red/green plus an
  explicit governed FAULT red/green against the coherent candidate. The FAULT
  is supplemental and never replaces BASE unless the exact owner uses the
  policy-validated coherent-fault exception above. This keeps proof rewrites
  fail-closed while demonstrating that the retained privacy, revocation,
  replay, authority, confinement, operation, and evaluation assertions still
  detect their production defect.
- Base RED owns new catalog/selection, policy/capacity, route-neutral backend,
  ProviderApi qualification, ledger, API/UI, secret-isolation, provider-peer,
  and residue owners. Registered fault RED owns adaptations of existing replay,
  authority, confinement, operation, and evaluation owners.
- Whole-file owners are not machine-gated. The controller requires same-run
  sensitivity for a changed proof only when its canonical registered owner is
  one exact node or carries a registered fault; a changed whole-file owner with
  neither resolves to itself and its `sensitivity_required` is cleared. The
  section 9 owners that remain whole-file are therefore not sensitivity-gated
  by `pr`: the Web owners `trustToolCallWire.unit.test.ts`,
  `AssistantWriteTrail.browser.test.tsx`, `DossierSurface.browser.test.tsx`,
  `events.selection.unit.test.ts`, `GenerationSelection.browser.test.tsx`,
  `GenerationBillingDisclosure.browser.test.tsx`,
  `PrivacyPage.browser.test.tsx`, `oracleReadingWire.unit.test.ts`, and
  `dossierFailureContract.unit.test.ts`; the adapted journeys
  `durable-ingest-reader-open` and `grounded-chat-citation`; and the Python
  owners `test_generation_selection_wire_contract.py`,
  `test_oracle_wire_contract.py`, `test_dossier_failure_wire_contract.py`,
  `test_generation_operation_adapters.py` (its fault names the whole file), and
  `test_generation_capacity_pause.py` (a whole-file owner with no exact
  canonical node; its nodes reach their base assertion, so registering one
  canonical node would gate it). Their red-before-green evidence is the
  per-proof RED recorded in
  the work report, not a controller verdict. `test_generation_catalog.py`,
  `test_generation_backend_runtime.py`, and `test_generation_chat_api.py`
  register one exact canonical node beside the whole-file owner, so `pr` gates
  that node with BASE; their sibling scenarios rest on the same recorded RED.
- Register each exact fault patch, SHA-256, layer, expected assertion, and
  canonical node in `testdata/faults/manifest.json`:

  | Fault id | Layer / expected behavioral failure |
  |---|---|
  | `auth-chat-run-ownership-bypass` | privacy: a stranger can read another owner's Chat run |
  | `conversation-chat-job-revocation-bypass` | deletion: a deleted conversation retains its private Chat job journal |
  | `codex-generation-migration-admission-bypass` | migration: active work reaches the destructive reset |
  | `durable-generation-accepted-loss-redispatch` | replay: accepted model work is automatically reissued |
  | `agent-tool-receipt-lease-fence-bypass` | authority: a lost lease can land a tool receipt |
  | `generation-reconciliation-fingerprint-bypass` | reconciliation: a mismatched immutable request is accepted |
  | `agent-tool-grant-scope-bypass` | authority: a bearer can widen its frozen scope |
  | `agent-tool-mcp-grant-gate-bypass` | authority: a signed bearer without live authority crosses the public MCP mount |
  | `llm-tool-safety-prompt-bypass` | eval: reviewed prompt-injection containment disappears |
  | `codex-generation-policy-plan-bypass` | policy: the exact generation portfolio drifts |
  | `durable-codex-operation-revision-shadow` | adapters: a domain owner shadows runtime policy |
  | `codex-temporary-confinement-bypass` | process: the confined temporary/workspace policy weakens |
  | `durable-codex-diagnostic-retention-bypass` | evidence: raw Codex diagnostics survive redaction |
  | `codex-egress-allowlist-bypass` | process: Codex egress escapes the reviewed allowlist |
  | `durable-job-fence-bypass` | replay: an expired attempt settles a reclaimed attempt under the same worker identity |
  | `document-import-time-dimension-bypass` | process: a resource-limited child loses its exact time dimension |
  | `document-import-parser-dimension-bypass` | parser: a resource failure loses its typed dimension carrier |
  | `document-import-reconciler-readiness-bypass` | readiness: a database is admitted without a fresh reconciler success |

  When either adapted Chat owner routes to BASE, retain these additional
  exact-SHA acceptance receipts:

  ```text
  ./scripts/test prove --proof pytest:python/tests/service/test_chat_execution_privacy.py::test_suspended_chat_exposes_only_phase_and_masks_its_private_journal --against fault:auth-chat-run-ownership-bypass
  ./scripts/test prove --proof pytest:python/tests/service/test_conversation_deletion.py::test_conversation_delete_removes_its_dead_chat_journal_only --against fault:conversation-chat-job-revocation-bypass
  ```

  Every registered fault patch must pass checksum, product-owner, canonical
  node, and current-tree applicability policy before either automatic or
  supplemental evidence is admissible.

GREEN:

- implement only the owner required by the failing proof;
- use protocol-valid fakes only at SDK/provider boundaries; ordinary PR proof
  performs no external generation;
- run `./scripts/test changed <path-or-node>` after each lane.
- Migration GREEN is concrete: an empty owned database and a synthetic
  0223-shaped baseline seeded by the migration testkit—with one row in every
  reset table, every preservation family, one active-work refusal case, and no
  personal data—reach the same head and preservation digests.

REFACTOR:

- switch all callers atomically;
- delete superseded code, tests, schema, config, docs, and dependencies;
- run `./scripts/test confidence`, then clean-commit `./scripts/test pr`;
- run only real workflows: `./scripts/test full`, `./scripts/test nightly`,
  and `release` at the exact candidate SHA. `Capability.MIGRATIONS` is owned
  by `pr`/`full`; it is not a standalone gate.
- Live Codex evidence is the release-time existing-VPS capacity
  qualification at the exact candidate SHA. `diagnose` and lower-lane
  artifacts never satisfy promotion.

Ordinary `pr` remains network-free with less than ten minutes intended added
runtime inside its existing 90-minute ceiling; order is static/kernel, service,
component, journey, sensitivity.

ProviderApi qualification is deliberately deterministic. A source-controlled
manifest binds every pinned `api_model_catalog()` row fingerprint, exact
reasoning set, capability class, and eligible tool-plan revision to the pinned
`llm-calling` conformance suites and the controller-owned TLS peer. The peer
exercises every provider engine/request shape, every declared reasoning wire
selection, strict structured output, and each qualified function-tool/
continuation shape. Any source fingerprint, reasoning set, or authority
revision drift leaves the row visible but ineligible until review updates the
manifest. Credential presence is readiness only.

No paid provider-hosted capability or release job is added. The local proof
does not certify a provider account's live quota, entitlement, regional route,
or transient service health. That omission is the explicit 80/20 boundary for
this one-user prototype; a future multi-user or billed launch must add a
protected, spend-capped, exact-SHA provider canary before promotion.

## 10. Acceptance criteria

1. The complete configured catalog contains every visible authenticated Codex
   model/reasoning pair and exactly every `api_model_catalog()` row belonging to
   a configured provider. The all-seven-provider fixture contains all eleven
   API rows, including OpenRouter and xAI, exactly once; source-reported capacity
   presence, optional defaults, lifecycle and fingerprints come only from their
   source catalogs. Nexus request budgets are separately policy-owned and never
   presented as source capacity.
2. For each Chat run, users can select any server-projected `Selectable` exact
   pair.
   Unknown, unsupported, stale, retired, and unavailable choices fail
   explicitly; unavailable choices remain visible and explained.
3. An empty new Chat draft initializes from the read-only developer seed; every
   dispatch still submits an exact selection. There is no user generation
   default, preference API, persistence, or AI Settings surface. Create,
   rerun, regenerate, history, SSE, and trust detail project one complete
   immutable `RunSelectionOut`. Causal inheritance follows the branch parent.
4. Developer policy owns a content-revisioned Chat seed and total exact
   selection/host/model-tool map for all fourteen background operations. The
   shipped values are section 3.4, require review/deployment to change, and are
   not generation profiles, defaults, or tiers.
5. No Fast, Balanced, Deep, Auto, Recommended, generation-selection profile,
   preset, tier, fixed model/effort shortcut, old API, compatibility ID, or
   fallback remains. `llm_tools.CapabilityProfile` and route authentication
   identity survive because they are not model-selection profiles.
6. One immutable GenerationSpec snapshots exact selection, source, host/model
   plans, effect mode, admitted scope plus digest, limits, host-evidence
   revision, resolved dispatch/row facts, prompt/input/output digests, bounds,
   display, revisions, and fingerprint before dispatch.
7. Background admission snapshots one complete developer-policy selection and
   tool authority before atomically persisting/enqueuing the generation. Workers
   never reread policy; a manual rebuild is a fresh admission under current
   policy.
8. An unavailable Chat seed leaves the picker usable but requires an explicit
   per-run replacement. An unavailable background selection or required tool
   blocks only that operation with an operator-facing failure. Codex quota parks
   pre-admission work in `CapacityPaused` until readiness recovers. None
   substitutes another route/model/reasoning/tool/plan or dead-letters a normal
   quota window.
9. Every tool-enabled Codex or API Chat/background run executes its frozen
   canonical plan through one `ToolAuthority`, `GenerationToolExecutor`, and
   durable position journal. Transport lowering and operation-owned evidence or
   presentation adapters may differ; citations, trust, effects, and Undo are
   produced only by the relevant domain adapter. Canonical model-visible
   declarations derive from the frozen plan and cannot contradict its
   authority. Chat alone renders the additional write-safety clause before
   prompt hashing: its persisted prompt names no write tools for `ReadOnly` and
   all five for `AdditiveWrites`. Every concrete successful Chat
   write target is atomically
   associated with its exact generation, tool position, and stable effect;
   missing, extra, duplicate, foreign, or mismatched associations fail closed.
   Authorship generation and tool positions are strict positive int32 values,
   and the position path is derived coherently from both.
10. Chat writes require a fresh per-run grant and rerun/regenerate never inherit
    it. The visible, off-by-default composer control names all five writes,
    announces changes, remains visible while armed, and resets after dispatch.
    Trust detail visibly attributes assistant-created targets; later note,
    highlight, and relation model reads carry bounded authorship; Undo preserves
    that provenance. Legitimate idempotent no-op writes fabricate no target.
    Shipped background model plans are read-only, noninteractive, and gain no
    user or worker override.
11. `NoModelTools` publishes no live model tools. Library Dossier and Idea
    Dossier receive exactly their section 3.4 read plans; Idea independently
    retains bounded `idea_dossier_research`. A Dossier can cite model-read evidence
    only through a stable registered build candidate. No failure silently drops
    either plan.
12. One parent generation records every independently accepted model turn and
    globally ordered `generation/{generation_seq}/tool/{n}` position.
    Child-terminal/successor continuation is atomic; crash/replay cannot
    duplicate billing or effects.
13. No accepted/uncertain call automatically repeats or changes selection.
14. Codex subscription state and API credentials remain isolated. Secrets,
    continuations, prompts, and raw private tool payloads never enter catalog
    APIs, logs, or the wrong process. Accepted bounded
    tool-result evidence remains only in its authorized product ledger.
15. Before Chat confirmation, the picker discloses effective
    route/provider/model/reasoning, processor chain, privacy/retention, billing
    class, context/output bounds, lifecycle/retirement, readiness, last check,
    actionable recovery, and current write authority. The closed composer shows
    billing class and any armed write grant. Background run detail exposes the
    admitted selection, tool plan, capacity/tool activity read-only, without
    controls, credential entry, or fabricated prices.
16. Rewritten `0224` refuses active work, wipes the complete legacy Chat
    aggregate plus generation/metering ledgers, drops all conversation Dossiers
    and conversation/message graph refs, deletes every legacy Chat tool receipt,
    result-ref association, trust projection, and effect/Undo state from
    `message_tool_calls` and `message_retrievals`, and reaches one empty final
    Chat/generation schema plus the empty final `assistant_write_authorships`
    table. Preservation-family counts/digests match exactly; users, media,
    libraries, knowledge content, non-conversation outputs, and durable
    Chat-created domain effects remain. V2 drafts are visibly discarded and
    only v3 is read.
17. Every ownership boundary has one independent, sensitive behavior proof and
    exact-SHA evidence in its named gate; the deletion-manifest proof confirms
    superseded selection owners are absent.
18. `changed`, `confidence`, `pr` (including migrations), `full` (including
    `llm-eval`), `nightly`, and `release` are green at one
    exact SHA. A required `not_run` is never acceptance. ProviderApi
    conformance is owned by the network-free pinned-library and
    controller-loopback proofs; no provider-hosted capability is claimed.

## 11. Explicit trade-offs

- Exact model/reasoning control increases cognitive load and makes model names
  product surface. Search, provider grouping, a clear initial seed, and
  one active-candidate detail panel contain the cost; per-run user control is the chosen
  priority.
- The complete reset permanently deletes every old conversation, message,
  share, citation, Chat trust/Undo record, conversation Dossier, generation
  call, usage/cost fact, and old browser draft. It is chosen because this is a
  greenfield one-user prototype. Users, libraries, media, knowledge objects,
  non-conversation outputs, and durable Chat-created effects are preserved;
  repository acceptance makes no selective-restore claim about an operator
  backup.
- A dynamic Codex catalog can drift independently of Nexus. Revisioned
  validation, persisted structured selections, lifecycle states, and
  fail-closed dispatch preserve truth, at the cost of occasionally requiring a
  different per-run Chat choice or developer policy change.
- The durable Codex model key is native `id`; the SDK does not promise its
  stability. An upstream ID change fails closed as an unavailable historical
  selection rather than dispatching a guessed model.
- Codex's public model list does not report context or maximum-output capacity.
  The product therefore displays those source facts as `Not reported` and uses
  conservative operation-owned request budgets, while the native runtime owns
  final capacity refusal. This can reject an oversized request later than an API
  route would; the alternative would depend on an undocumented private cache or
  fabricate per-model facts.
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
- Exposing every configured API row adds credential, privacy, and qualification
  work. This is accepted to preserve the complete configured `llm-calling`
  value rather than an arbitrary curated subset; all-provider deployments
  therefore expose all eleven rows.
- OpenRouter Kimi has no verified default at the pin, so selecting it requires
  one extra reasoning choice. An honest `Absent` is preferable to laundering a
  Nexus preference as a provider fact.
- Removing generation preferences eliminates all generation-default controls,
  a settings API, tables, migration, concurrency, and unavailable-preference
  UX. The cost is deliberate: each new conversation starts from the developer
  seed, and background tuning requires review and deployment.
- One content-derived policy revision atomically covers Chat and every
  background operation. A background-only policy deployment may refresh the
  cached Chat seed even though it does not stale the explicit Chat selection;
  that small cache churn avoids a split revision vector.
- Chat creation intentionally omits `policy_revision`: the exact model pair is
  revision-checked, but a developer deployment racing confirmation may change
  bounds/tool plans before admission. Current reviewed safety policy is
  preferred to stale authority; the admitted run discloses and persists the
  effective frozen policy.
- Five-minute catalog and 60-second readiness bounds add refresh work and can
  briefly show stale health. Final dispatch recheck prevents stale admission;
  one shared freshness owner is preferable to per-caller behavior.
- Authenticated policy preflight adds release/startup ordering. It prevents an
  impossible developer selection/tool-plan pair from shipping without putting
  network access inside schema migration.
- Claude Code subscription remains unconfigured. Adding it now would require a
  second enrolled local account, host image/SDK, security qualification, and
  tool proof unrelated to the approved Codex Personal plus API goal.
- Capability-scoped tools limit autonomy. They preserve evidence contracts,
  least privilege, replay identity, and prompt-injection containment.
- Uniform Chat eligibility requires both six-tool read and eleven-tool
  additive-write lowering even when writes remain off. This can hide a target
  that supports reads only; the uniform contract avoids a per-target consent
  matrix whose meaning changes by model.
- Model tools make Library and Idea Dossiers more adaptive but add model turns,
  latency, cost variance, and replay states. Exact scopes/limits and durable
  evidence accept that cost where retrieval can improve the result. Their tools
  can search and navigate only already admitted source refs, so they improve
  in-turn retrieval but do not discover a new corpus; the other twelve
  backgrounds keep their complete frozen-evidence contracts.
- Codex can enforce strict structured output while using the two background MCP
  plans; ProviderRuntime intentionally cannot combine strict output and
  function tools in one call. This route-specific capability keeps the shipped
  Codex backgrounds strong without falsely advertising provider parity. The
  cost is that a future developer policy cannot move those two operations to an
  API route without an explicit split-generation design or a newly qualified
  upstream contract.
- Unattended background models receive read authority only. Keeping publication
  in domain-owned validated transactions gives up autonomous background writes
  to avoid invisible approvals, duplicate effects, and a second mutation path.
- Background read-tool guidance lives in canonical model-visible tool
  declarations rather than a second prose catalog in each Dossier prompt. This
  avoids drift and keeps prompts focused, at the cost of not giving background
  models a redundant natural-language summary; Chat alone duplicates the five
  write names because visible per-run user consent is a distinct safety fact.
- Idea's deterministic HostTable owns external research while its model plan
  owns private Nexus follow-up. Forbidding private reads and external egress in
  one unattended model plan limits free-form research but materially reduces
  prompt-injection exfiltration risk.
- Attended `ChatRead` deliberately combines auto-executing private Nexus reads
  with bounded Brave query egress. Streaming/tool activity is detection, not
  prevention, and model-authored query text reaches the search processor.
  Selecting a third-party API target also sends authorized private read results
  through its disclosed processor chain. Scoped grants, budgets, journaling,
  attribution, cancellation, and visible activity contain—but do not
  eliminate—prompt-injection exfiltration. An egress-free Chat plan or per-run
  Web-search opt-out is a later cutover.
- Model-created notes/highlights/edges can be retrieved in later turns, so
  stored prompt injection remains possible. Machine-authorship provenance in
  retrieval/prompt evidence plus visible trust and Undo is the chosen one-user
  containment; the content is not silently treated as user-authored.
- MCP remains the Codex tool transport. Dynamic App Server callbacks are absent
  from the pinned `llm-calling` contract and would create a second effect
  boundary.
- Child model-turn persistence and encrypted continuation add schema and
  sensitive-state complexity; API tool-loop crash recovery is otherwise
  dishonest.
- No automatic fallback lowers availability. It preserves exact privacy, cost,
  billing, tool, and effect truth. Durable `CapacityPaused` accepts delayed
  background work instead of turning predictable quota into dead letters or API
  spend.
- Whole-file proof owners for the new Web modules, the two adapted journeys,
  and the wire-contract kernels are not controller sensitivity-gated. The
  Vitest and Playwright runners accept no exact node, and narrowing a Python
  owner to one node would drop its sibling scenarios from priority routing, so
  each Python owner with a BASE-reaching node registers that node beside the
  whole file instead. The accepted cost is that the remaining whole-file owners'
  red-before-green rests on recorded per-proof evidence rather than a `pr`
  verdict.
- Background run detail ships on the Dossier build head only, because it is the
  one background operation with a user-facing per-run surface. Metadata
  enrichment, Media summary, Synapse, Dawn, Oracle, and Idea resolution keep
  their existing status projections and expose no admitted selection or
  capacity wait to the user; their quota pauses remain visible only in the
  durable job journal until those surfaces gain per-run detail.
- Deterministic ProviderApi qualification grows with catalog rows and reasoning
  wire shapes, not model × reasoning × operation. It catches application and
  pinned-library drift without paid calls. It does not prove live provider
  quota or account entitlement; adding that launch-grade assurance requires a
  separately approved, spend-capped hosted capability.
- No hosted Codex canary exists. The dedicated subscription runner, its GitHub
  environment, and the `codex-nightly` lane were retired on 2026-09-05 without
  ever passing. Live Codex proof is the ordinary `./scripts/test nightly` plus
  the release-time existing-VPS capacity qualification at the shipped SHA. This
  gives up scheduled subscription-authenticated coverage of every Chat target
  rather than maintain a second enrolled account, encrypted host, and runner.

## 12. Authoritative references

- [Nexus testing standards](../local-rules/testing-standards.md)
- [Nexus tool runtime primitives; amended for operation-owned plans and private MCP](nexus-tool-runtime-hard-cutover.md)
- [LLM tools library](llm-tools-library-hard-cutover.md)
- [Generation runtime composition](generation-run-harness-hard-cutover.md)
- [LLM module](../modules/llms.md)
- [Chat module](../modules/chat.md)
- [Architecture](../architecture.md)
- [Boundaries](../rules/boundaries.md)
- [Cleanliness](../rules/cleanliness.md)
- [Keys and identities](../rules/keys-and-identities.md)
- [Operation types](../rules/operation-types.md)
- [Retries](../rules/retries.md)
- [`llm-calling` provider/agent contracts (sibling checkout)](../../../llm-calling/README.md)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex App Server](https://developers.openai.com/codex/app-server/)
