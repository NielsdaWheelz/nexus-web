# LLM Provider Runtime Hard Cutover

**Status:** APPROVED SPECIFICATION
**Date:** 2026-08-11
**Type:** atomic hard cutover; no compatibility period
**Open questions:** none

## 1. Decision

Replace Nexus's pinned planning-era `provider_runtime` integration with the
upgraded direct-API runtime. Keep Kimi, add DeepSeek V4 Flash and V4 Pro as
user-selectable chat profiles, and leave every background-operation profile
mapping unchanged.

This pass is direct API only. Codex/Claude subscriptions, `AgentRuntime`, native
sessions, agent workers, subscription quota handling, and background rerouting
are a separate cutover. No subscription concept enters this design.

The cutover is one atomic Nexus change. Delete the old planner, catalog,
cache-plan, per-call credential, accounting, and wire-script paths in the same
change. There is no adapter, fallback, dual path, feature flag, or old-state
reader.

## 2. Goals and boundary

Goals:

- Pin one immutable, live-certified v2 `llm-calling` revision.
- Preserve all seven current direct profiles and add two DeepSeek profiles.
- Make `ProviderRuntime` the sole owner of registry resolution, credentials,
  provider transport, retries, normalized outcomes, and provider telemetry.
- Keep Nexus as the sole owner of product profiles, durable execution,
  entitlements, token admission, persistence, trust trails, and user UX.
- Remove v1-only state and duplicate schema/failure logic.
- Preserve the current HTTP chat/profile APIs and data-driven picker.

Non-goals:

- Subscription models or coding-agent features of any kind.
- Changing background routing, prompts, output schemas, tools, chat streaming,
  durable run semantics, or provider-facing product fallback.
- Dynamic model discovery, a router, health-based failover, per-user keys,
  availability toggles, a model marketplace, or provider-specific UI.
- xAI or OpenRouter product profiles. Their upstream registry rows remain
  library-owned and unconfigured in Nexus.
- Image input, sampling controls, `provider_options`, JSON repair, cache tuning,
  new pricing infrastructure, or a general workflow framework.
- Replacing Nexus's existing Postgres queue, leases, or durable step journal.

## 3. Upstream prerequisite

The pinned v2 revision is `llm-calling` commit
`4fd23f661e3553875c57e282b138565ac64ec16e`, registry revision
`2026-08-11.1`. Its upstream contract includes:

1. Change the current Flash registry row from `none | low | high | max` to
   `none | high | max`, matching Pro. Official current docs say `low`/`medium`
   alias to `high`; Nexus must not advertise a placebo level.
2. A DeepSeek thinking-mode tool round trip must replay the continuation
   artifact's native `reasoning_content` into the subsequent assistant message
   and omit unsupported `tool_choice`. The current adapter captures that field
   but strips it on replay and sends `tool_choice` whenever tools are present.
3. The live matrix proves the combined case—thinking, tool call, continuation,
   tool result, final answer—for both DeepSeek rows. Separate tool and reasoning
   probes are insufficient.
4. One unfiltered, checked-in live matrix passes every upstream registry row at
   the exact revision Nexus pins. Missing-key skips are not release evidence.

These are a small upstream prerequisite, not Nexus workarounds. No DeepSeek
profile ships until they pass.

Authoritative upstream contracts:

- [`llm-calling/README.md`](../../../llm-calling/README.md)
- [`docs/pivot-spec.md` §13](../../../llm-calling/docs/pivot-spec.md)
- [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek thinking/tool continuation](https://api-docs.deepseek.com/guides/thinking_mode)

## 4. Final product behavior

`GET /llm-profiles` returns this fixed order. `balanced` remains the default.

| Profile id | Label | Runtime target | Reasoning | Default |
|---|---|---|---|---|
| `fast` | Fast · Luna | `openai/gpt-5.6-luna` | `none, low, medium, high, xhigh, max` | `low` |
| `balanced` | Balanced · Terra | `openai/gpt-5.6-terra` | `none, low, medium, high, xhigh, max` | `medium` |
| `deep` | Deep · Sol | `openai/gpt-5.6-sol` | `none, low, medium, high, xhigh, max` | `high` |
| `claude` | Claude · Sonnet 5 | `anthropic/claude-sonnet-5` | `low, medium, high, xhigh, max` | `medium` |
| `fable` | Claude · Fable 5 | `anthropic/claude-fable-5` | `low, medium, high, xhigh, max` | `high` |
| `gemini` | Gemini · 3.5 Flash | `gemini/gemini-3.5-flash` | `minimal, low, medium, high` | `medium` |
| `kimi` | Kimi · K3 | `moonshot/kimi-k3` | `low, high, max` | `high` |
| `deepseek-flash` | DeepSeek · V4 Flash | `deepseek/deepseek-v4-flash` | `none, high, max` | `high` |
| `deepseek-pro` | DeepSeek · V4 Pro | `deepseek/deepseek-v4-pro` | `none, high, max` | `high` |

The existing model and effort selects render these rows without a frontend
branch or new control. Selecting a new profile resets effort to that profile's
default exactly as today. Flash's description is “Fast, cost-efficient
reasoning for everyday questions”; Pro's is “DeepSeek's strongest model for
harder reasoning.” DeepSeek uses the existing `StandardPrivacy` union with the
notice “Requests are sent directly to DeepSeek under the operator's API account
and DeepSeek's current terms.” Do not add another privacy type.

Background `OPERATION_PROFILES` is byte-for-byte unchanged. Kimi and DeepSeek
are chat choices only in this pass. A missing provider key never removes a row
or reroutes a call: staging/production startup fails if any product-provider
key, including `DEEPSEEK_API_KEY`, is absent.

## 5. Architecture and ownership

```text
HTTP/chat or durable job owner
  -> LlmProfile + GenerateIntent             Nexus product intent
  -> execute_generation[_stream]             entitlement, ledger, admission
  -> ExecutionRuntime                        narrow structural test seam
  -> ProviderRuntime                         registry, key, retry, OTel, engine
  -> direct provider API
  <- CallOutcome / RuntimeStreamEvent
  -> llm_outcomes -> llm_ledger              one normalization and audit write
  -> existing run/tool/publication owners    product result
```

Ownership laws:

- `provider_runtime.registry.ModelRow` owns wire model id, context/output
  limits, modalities, reasoning fragments, capabilities, continuation codec,
  and registry revision.
- `llm_profiles.py` owns labels, order, defaults, privacy copy, and
  operation-to-profile policy only. It contains no copied limits or wire
  behavior.
- `ProviderRuntime` owns all provider retries. SDK retries stay disabled.
- Registry rows own canonical provider endpoints. Nexus never rewrites a
  runtime request to an operator gateway or environment-selected base URL.
- Nexus execution composition owns whether an operation uses the default retry
  policy or a single provider attempt; it never implements retry mechanics.
- `llm_execution.py` owns the durable call order and token reservation.
- `llm_outcomes.py` owns the one exhaustive outcome/failure-to-ledger mapping.
- `llm_ledger.py` is the sole writer of `llm_calls`.
- Prompt/domain owners still build and validate content before execution. LLM
  output, tool arguments, schemas loaded from storage, and provider metadata
  remain untrusted at their boundaries.

## 6. Capability and internal API contract

### Product and registry

At app and worker startup, `validate_profiles()` calls
`provider_runtime.registry.resolve_target()` for every profile and defects
unless:

- the row supports text, tools, streaming, structured output, and a non-empty
  continuation codec;
- the profile's reasoning-option set exactly equals the row's reasoning keys;
- the default is a member of that set; and
- every operation mapping resolves to a product profile.

Live certification is a release gate, not a boolean copied into a registry row.
Nexus never imports `ROWS` to make product choices.

Nexus generation is text-only. `GenerationRequest` defects before its ledger
boundary if target/reasoning differ from its profile, an `ImageBlock` is
present, `provider_options` is non-empty, tools are combined with strict JSON,
`max_output_tokens` is not positive or exceeds the resolved row cap, or the
conservative input bound exceeds `row.context_window - max_output_tokens`.
Add capability only when a real product owner exists.

### Credentials and runtime

```python
def provider_credentials(settings: Settings) -> Credentials: ...

class ExecutionRuntime(Protocol):
    async def generate(
        self, intent: GenerateIntent, *, cancel: CancelSignal | None = None
    ) -> ProviderCallOutcome: ...

    def stream(
        self, intent: GenerateIntent, *, cancel: CancelSignal | None = None
    ) -> AsyncIterator[RuntimeStreamEvent]: ...

class ProviderRetryMode(StrEnum):
    Default = "Default"
    SingleAttempt = "SingleAttempt"

def build_execution_runtime(
    settings: Settings,
    client: httpx.AsyncClient,
    *,
    retry_mode: ProviderRetryMode = ProviderRetryMode.Default,
) -> ExecutionRuntime: ...
```

`provider_credentials` explicitly constructs `Credentials(openai=...,
anthropic=..., gemini=..., moonshot=..., deepseek=..., openrouter=None,
xai=None)`. The runtime selects the key. Delete generation-time provider maps
and credential arguments. Keep `embedding_credential` only because the v2
OpenAI embedding port still requires an explicit `ProviderCredential`; narrow
it to `embedding_credential(settings)` with no provider argument or lookup map.

Delete `ProductionExecutionRuntime`: `ProviderRuntime` satisfies the protocol
directly. One factory/composition site is used by `api/deps.py` and
`tasks/llm_task.py`; `semantic_chunks.py` uses the same credentials and client
construction for embeddings. `api/deps.py` exposes the explicitly named
single-attempt dependency used by the current Idea-resolver route; it does not
silently make a generic dependency ambiguity-sensitive.

`LlmTaskSpec` gains a closed retry mode. Every composition uses v2 default
retries unless it contains a durable `BilledOnce` LLM step. `chat_run`,
`dossier_build`, and `media_unit_build`, plus the API-owned Idea resolver, use
`SingleAttempt`; all other current LLM jobs use `Default`. The single-attempt
runtime receives exactly
`RetryPolicy(max_attempts=1, initial_delay_s=0, max_delay_s=0, jitter_s=0,
deadline_s=Absent())`, constructed once beside the factory. Remove the
per-call `single_dispatch` flag and plan mutation. Streaming is never resumed
after a semantic event. Tests prove a transient generate or stream signal
causes exactly one dispatch in this mode.

### Intent persistence and admission

Extract the strict, JSON-safe `GenerateIntentState` codec from
`chat_run_steps.py` to `llm_intent_state.py`. It is the single Nexus owner for:

- durable chat intent round trips;
- plain JSON-schema mappings for tools and strict output;
- continuation target/codec/opaque payload round trips; and
- a conservative token-admission bound.

Delete canonical-schema conversion and prompt stability/scope state. A
persisted prompt block is `{text}`. The token reservation is:

```text
utf8_bytes(GenerateIntentState.model_dump_json()) + intent.max_output_tokens
```

This deliberately preserves the old conservative bytes-as-tokens admission
philosophy without reconstructing provider wire requests. It is quota
admission, not tokenization or cost estimation. Chat context budgeting uses
`row.context_window - max_output_tokens`; there is no second reasoning reserve.
Chat keeps the existing 4,096 non-reasoning and 25,000 reasoning output caps,
each clamped to `row.max_output_tokens`.

### Execution order, failures, and cost

For every generation:

1. Validate domain prompt and `GenerationRequest` before execution.
2. Check entitlement.
3. Under the logical owner's advisory lock, atomically insert-or-reuse
   `llm_calls` with its replay-stable generation UUID and reserve the
   Nexus-owned conservative token bound.
4. Reject terminal UUID reuse; pre-dispatch budget denials are terminal and
   replay as the same expected failure.
5. Commit the durable owner's `Uncertain` checkpoint immediately before
   dispatch when that owner has one.
6. Call `runtime.generate(intent)` or `runtime.stream(intent)`.
7. Under the same owner lock and in one Postgres transaction, terminalize from
   `CallMeta` and settle the reservation from normalized usage and billability.
8. Raise defects after recording a safe defect terminal. Return closed expected
   outcomes unchanged.

`llm_outcomes.py` exhaustively maps the outcome/failure unions:

| Outcome/failure | Origin | Code |
|---|---|---|
| `Refused` | `provider_http` | `refused` |
| `Incomplete(status="refused")` | `provider_stream` | `refused` |
| other `Incomplete` | `provider_response` | `incomplete` |
| `ProviderContextTooLarge` | `provider_http` | `context_too_large` |
| `InvalidToolArguments` | `tool_arguments` | `invalid_tool_arguments` |
| `InvalidStructuredOutput` | `provider_response` | `invalid_structured_output` |
| exhausted rate limit | `provider_http` | `rate_limited` |
| exhausted timeout | `transport` | `timeout` |
| exhausted provider HTTP unavailable | `provider_http` | `provider_unavailable` |
| exhausted transport unavailable | `transport` | `provider_unavailable` |
| exhausted stream interruption | `provider_stream` | `stream_interrupted` |

Success and cancellation have no error facts. Remove the deleted local
`IntentContextTooLarge` branch. `InvalidRequest`, credentials, protocol breaks,
and impossible variants are defects, never modeled provider failures.

Call `estimate_cost(meta)` only after a terminal. `Absent` plus absent usage is
`missing_usage`; `Absent` plus present usage is `missing_pricing`. Never invent
component costs, retry costs, or a pre-dispatch monetary estimate.
Normalized cache read/write token counts remain usage facts when a provider
reports them; they do not reintroduce a Nexus cache plan or cache-control API.

## 7. Persistence hard cut

Add migration `0215_llm_provider_runtime.py` after `0214`.

`llm_calls` final delta:

| Action | Columns |
|---|---|
| Add | `requested_reasoning text NULL`, `native_reasoning text NULL`, `registry_revision text NULL`, `cost_source text NULL`, `cost_as_of date NULL` |
| Keep | provider/model/operation/streaming, normalized token fields, total cost, outcome/error, request id, attempts, latency, billability-derived settlement inputs |
| Drop | `reasoning_effort`, `catalog_revision`, `request_fingerprint`, `cache_strategy`, `cache_ttl`, `cached_input_tokens`, five component-cost columns, `pricing_snapshot`, `provider_usage` |
| Narrow | `cost_status` to `estimated | missing_usage | missing_pricing`; remove its old DB check rather than replacing it |

Migration data rules:

- copy old `reasoning_effort` to `native_reasoning` only where the old
  `catalog_revision` proves `commit_plan_facts` ran; otherwise set it null.
  Historical `requested_reasoning` stays null;
- old estimated totals remain, with `cost_source='provider-runtime-v1'` and
  null `cost_as_of`;
- rewrite `not_token_priced` to `missing_pricing`;
- drop old catalog/cache/accounting facts; do not rename them into new facts.

New rows record requested reasoning at start and native reasoning plus registry
revision at terminal. Application code validates terminal cost-field
correlation; do not add business `CHECK` constraints. Absent optional usage
components remain SQL `NULL`; never coerce absent reasoning/cache tokens to
zero.

Before dropping columns, the migration explicitly drops every dependent old
constraint: the token-count check that names `cached_input_tokens`, provider
usage JSON check, five component-cost checks, pricing-snapshot JSON check, and
old cost-status check. It also drops both prompt-assembly checks that name
cacheable or reasoning-reserve columns. Do not recreate them: current database
rules place these domain correlations in application validation and tests.

From `chat_prompt_assemblies`, its API projection, and stored JSON manifests,
remove `cacheable_input_tokens_estimate`, `reserved_reasoning_tokens`,
`cache_policy`, and dead `privacy_scope`/`required_provider_capability` fields.
Keep context/output/input budgets and source/inclusion evidence. The migration
deterministically rewrites historical `prompt_block_manifest.blocks` and every
`dropped_items[*].blocks` entry to remove those block keys, removes the
manifest's cacheable total, and removes `reserved_reasoning_tokens` from
`budget_breakdown`. A post-migration JSONPath census must return zero residue.

Old durable intent payloads are intentionally unreadable. The release first
stops LLM admission and both worker lanes, then proves zero running
`chat_run`, `dossier_build`, `oracle_reading_generate`, `media_unit_build`,
`enrich_metadata`, `synapse_scan`, or `dawn_write_job` rows before DDL. Every
non-succeeded chat job—including `dead` suspended journals—is repaired to
completion or explicitly domain-cancelled first; deleting a dead recovery
journal is forbidden. The migration defects if any non-succeeded chat job
remains, then deletes only succeeded `chat_run` queue rows. Durable `chat_runs`,
events, messages, and `llm_calls` remain. Other non-running jobs keep their
runtime-neutral payloads and resume only under new workers after deploy.
Never delete or rename `durable_step_journal.request_fingerprint`: it is replay
identity, not the retired provider-plan fingerprint.

## 8. Public API and UX

No chat/profile request, response, or event shape changes:

- `GET /llm-profiles` returns two additional rows.
- Existing chat create/send fields `profile_id` and `reasoning_option_id` stay
  authoritative.
- Existing SSE, reconnect, cancellation, failure cards, and message details
  remain unchanged. The trust-trail prompt-assembly projection hard-deletes the
  retired fields named in §7.
- No provider key, health, route, subscription, cost estimate, or availability
  endpoint is added.

The current data-driven picker is the complete 80/20 UI. Do not add badges,
logos, benchmarks, recommendations, automatic choice, or a second model
surface. Labels answer “what”; concise descriptions answer “why choose it.”

## 9. Hard deletions

Delete all Nexus uses of:

- `CATALOG`, `ChatModelContract`, `DirectCertification`, `plan_generate`,
  `FinalizedProviderCall`, `PlanRejected`, and `PlanningDefect`;
- `Accounting`, `CostBreakdown`, `cost_from_accounting`, plan cache helpers,
  and plan/request fingerprints;
- `Dynamic`, `Stable`, cache scopes, `BlockStability`, canonical-schema parser
  helpers, and reasoning-reserve facts;
- `generation_credential`, `transcription_credential`, and provider-runtime
  transcription certification. Real transcription remains Deepgram-owned and
  untouched;
- `ProductionExecutionRuntime`, per-call `single_dispatch`, old wire-level LLM
  scripts, old provider gateway fixtures, and tests of deleted behavior;
- `provider_http.py`, `OPENAI_API_BASE_URL`, its request hook, gateway fault
  corpus patch, and the LLM routes/environment owned only by that test seam;
- deployed `OPENROUTER_API_KEY` plumbing. Upstream live tests own their own
  OpenRouter key; Nexus has no OpenRouter product route.

Do not retain aliases, import shims, permissive old-state decoders, migration
fallbacks, skipped legacy tests, or stale v1 prose.

## 10. Non-overlapping work packages

The Nexus packages land atomically; the boundaries below are for ownership and
review, not compatibility commits.

| Package | Exclusive files/concern | Exit |
|---|---|---|
| 0. Upstream prerequisite | `../llm-calling/src/provider_runtime/{registry.py,engines/openai_chat.py}`, upstream conformance/live tests, evidence, docs | §3 passes and a verified immutable revision exists |
| 1. Product intent | `llm_profiles.py`; new `llm_intent_state.py`; `prompt_budget.py`; `chat_prompt.py`; `context_assembler.py`; `chat_run_steps.py`; `chat_runs.py`; prompt builders in `dawn_write.py`, `metadata_enrichment.py`, `structured_synthesis.py` | nine profiles validate; all owners build v2 intents; persisted IR round-trips |
| 2. Persistence | new `llm_outcomes.py`; `llm_ledger.py`; `db/models.py`; `schemas/conversation.py`; `message_trust_trails.py`; migration `0215` | old facts removed; start/terminal rows and historical migration are correct |
| 3. Runtime composition | `pyproject.toml`, `uv.lock`, setup-test pin; `config.py`; `app.py`; `llm_credentials.py`; `llm_execution.py`; `tasks/llm_task.py`; affected task specs; `api/deps.py` and the Idea-resolver dependency; `semantic_chunks.py`; delete `provider_http.py`; env/deploy key plumbing | direct generation and embedding use v2; every `BilledOnce` LLM owner is single-attempt; staging/prod require DeepSeek |
| 4. Proof and guidance | provider/service/migration/release tests; provider-only `testkit`/`nexus_test_control` cleanup; release workflow/fixtures; `docs/modules/llms.md`, `docs/architecture.md` | deterministic, migration, live, negative, and doc gates pass |

If a newly discovered file belongs to two packages, assign it to the semantic
owner before editing; do not split one file across packages.

## 11. Acceptance criteria

1. The dependency is one immutable upgraded revision and no v1 import resolves.
2. `/llm-profiles` returns the exact nine-row order and reasoning sets in §4;
   the current picker selects and persists both DeepSeek profiles.
3. All existing direct profiles retain chat, stream, tools, structured output,
   continuation, usage, failure, cancellation, and trust-trail behavior.
4. Both DeepSeek rows pass real `high`-reasoning streamed chat, strict JSON,
   and a reasoning + tool + continuation round trip through Nexus.
5. `OPERATION_PROFILES` is unchanged and no background operation targets Kimi
   or DeepSeek.
6. Missing `DEEPSEEK_API_KEY` fails staging/production startup. Missing or
   rejected keys never hide profiles or trigger fallback.
7. Every direct request uses the registry-owned canonical endpoint; no Nexus
   setting, hook, test server, or injected environment can rewrite it.
8. Every logical generation has one pre-dispatch ledger row and one terminal
   state; internal attempts stay in its `CallMeta.attempt_trace`; costs use
   `estimate_cost(CallMeta)` and preserve provenance.
9. Token reservations settle exactly once on success, expected failure,
   cancellation, consumer-close, and defect. Every `BilledOnce` LLM step makes
   at most one provider attempt; other calls use only the v2 retry owner.
10. Intent persistence round-trips plain schemas and continuation payloads;
   admission is deterministic and includes every persisted byte plus output.
11. Migration refuses live old chat coordination, preserves domain/run data,
    and removes every retired column/manifest field.
12. OpenAI embeddings retain success, malformed-vector, overflow, and transient
    behavior. Embedding queue attempts are at-least-once across process death;
    idempotent index materialization converges even when the provider request is
    repeated. A second durable embedding-effect ledger or response cache is out
    of scope. Deepgram transcription is unchanged.
13. Live direct-runtime production imports, executable tests/fixtures, and
    active module docs contain no v1 integration or product OpenRouter path;
    the head schema contains none of the retired columns. Negative tests and
    this cutover may name deleted symbols as strings. Historical migrations and
    decision records are immutable, and a later agent cutover is not governed
    by this residue gate.

Verification:

- Upstream: offline suite, static checks, full unfiltered paid live matrix.
- Nexus while implementing: `./scripts/test changed <owned paths>` per package.
- Nexus before handoff: `./scripts/test pr`.
- Release candidate: migration upgrade test, provider certification with all
  five product keys, and `./scripts/test release`.
- Prove test sensitivity once by breaking one DeepSeek reasoning/continuation
  expectation, then revert it.

## 12. Final-state laws

1. Product profile is policy; registry row is provider fact; runtime is
   mechanism. None duplicates another.
2. Direct API and native subscription execution are different systems.
3. One runtime owns retries; one Nexus boundary owns durable execution; one
   ledger owns audit facts.
4. Absence is explicit. Missing credentials, pricing, usage, or capability
   never becomes guessed data or fallback behavior.
5. Persist only product/replay/audit facts with a current owner. Provider wire
   requests, cache plans, and obsolete accounting snapshots are not product
   state.
6. The repository contains one v2 path and zero v1 residue.
