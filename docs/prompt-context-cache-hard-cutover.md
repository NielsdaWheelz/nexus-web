# Prompt Context Cache Hard Cutover

## Purpose

Make Nexus chat context assembly cache-aware, provider-portable, observable, and
source-grounded by construction.

The target state is not "add Anthropic `cache_control` to the current string
prompt." The target state is a typed prompt plan:

- stable system, scope, artifact, and memory blocks form a cacheable prefix,
- dynamic retrieval, recent history, tools, and the current user message stay
  outside that prefix,
- Nexus owns semantic cache policy,
- provider adapters translate that policy into provider-specific APIs,
- usage and billing record cache writes and reads explicitly.

This is a hard cutover. The final state has no legacy string-only prompt path,
no silent no-op cache adapters, no provider fallback behavior, no compatibility
mode, and no prompt assembly that mixes stable and per-turn context into one
opaque system string.

## Source Baseline

The design follows current provider and product patterns:

- Anthropic prompt caching: explicit cache breakpoints, 5-minute default TTL,
  optional 1-hour TTL, and usage fields for cache creation and reads.
  <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- OpenAI prompt caching: automatic prefix caching, stable prefix requirements,
  prompt cache keys, retention controls, and cached token usage reporting.
  <https://developers.openai.com/api/docs/guides/prompt-caching>
- Gemini caching: explicit cached content objects and TTL-backed reuse.
  <https://ai.google.dev/gemini-api/docs/caching>
- Vertex AI context cache: cache resource model for repeated long context.
  <https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview>
- Bedrock prompt caching: provider-neutral cache points in Converse and model
  invocation APIs.
  <https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html>
- Anthropic context engineering: context should be deliberately partitioned,
  compacted, and treated as a finite runtime resource.
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- vLLM and SGLang serving patterns: automatic prefix caching and prefix-aware
  routing are the self-hosted serving analogs of provider prompt caching.
  <https://docs.vllm.ai/usage/automatic_prefix_caching.html>
  <https://docs.sglang.ai/router/router.html>

## Goals

- Cut input cost and latency for scoped chat turns by reusing stable prompt
  prefixes.
- Preserve answer quality by separating stable context from dynamic evidence.
- Make prompt assembly inspectable as a typed, versioned plan.
- Keep provider-specific prompt cache syntax out of Nexus business services.
- Persist normalized cache usage for billing, quota, and observability.
- Make cache misses explainable through block hashes, versions, and provider
  usage.
- Keep tenant, user, scope, provider, model, and key-mode cache isolation
  explicit.
- Keep citations and source grounding backend-owned.
- Leave a clean path for compiled document and library context artifacts.
- Make unsupported provider/model combinations impossible to use for cache-
  required chat execution.

## Target Behavior

### User-Visible Behavior

- Scoped media and library chats answer the same way they do without caching.
- Cache behavior is not exposed as a chat feature or user setting.
- Source citations remain rendered from backend-provided context and retrieval
  objects.
- If the scoped corpus does not support an answer, the assistant says so before
  any general guidance.
- Switching model/provider only offers options that can satisfy the scoped-chat
  prompt contract.

### Operator Behavior

- Every durable chat run records:
  - provider,
  - model,
  - key mode,
  - prompt plan version,
  - stable prefix hash,
  - estimated input tokens,
  - input tokens,
  - output tokens,
  - reasoning tokens,
  - cache write input tokens,
  - cache read input tokens,
  - cached input tokens when the provider reports that shape,
  - total tokens,
  - provider request id,
  - provider usage JSON.
- Logs include cache metrics and hashes, never raw prompt text.
- Dashboards can answer:
  - cache hit rate by provider/model/scope type,
  - cacheable token share,
  - write tokens versus read tokens,
  - cache miss causes,
  - cost by key mode,
  - latency with and without cache reads.

### Prompt Behavior

- Prompt assembly emits a `PromptPlan`, not a list of raw string turns.
- A prompt plan contains ordered `PromptBlock` values with:
  - stable block id,
  - lane,
  - text,
  - estimated tokens,
  - source refs,
  - source version,
  - stable hash,
  - cache policy,
  - privacy scope,
  - required provider capability.
- The cacheable prefix is ordered:
  1. system identity and invariant instructions,
  2. conversation scope metadata,
  3. compiled scope context artifact when present,
  4. stable memory or state snapshot.
- Dynamic blocks follow the cacheable prefix:
  1. attached per-message contexts,
  2. retrieved app evidence,
  3. web evidence,
  4. recent history,
  5. current user message.
- Retrieved snippets and web snippets are evidence, not instructions.
- Dynamic evidence never appears before or inside a cacheable stable block.
- Memory is cacheable only when represented as a versioned stable snapshot. A
  per-turn regenerated memory string is dynamic and is not eligible.
- The assembled provider request is derived from the prompt plan exactly once.

### Provider Behavior

- Anthropic:
  - receives system content as structured text blocks,
  - has explicit `cache_control` only at approved cache breakpoints,
  - uses 5-minute TTL for normal chat reuse,
  - uses 1-hour TTL only for large compiled artifacts with expected repeated
    reads,
  - parses streaming and non-streaming cache usage.
- OpenAI:
  - receives an exact stable message prefix,
  - receives a `prompt_cache_key` derived from the isolated stable prefix hash,
  - parses cached token usage from provider usage details.
- Gemini:
  - uses explicit cached content resources for large stable scope artifacts,
  - reuses cached content by stable hash and TTL,
  - parses cache usage where reported.
- Bedrock:
  - is supported only when its adapter implements cache points and usage
    normalization.
- Providers without a complete strategy for the selected model are not available
  for scoped chat. The adapter must not silently ignore a required cache policy.

### Cache Keys

Cache identity is scoped to:

- Nexus environment,
- owner user id,
- conversation id,
- conversation scope type and target id,
- provider,
- model name,
- key mode,
- provider account boundary,
- prompt plan version,
- system prompt version,
- scope metadata version,
- compiled artifact version,
- memory snapshot version,
- stable prefix hash.

Cache keys must not include raw prompt content. Hashes are derived from
canonical serialized block metadata and text.

### Cost And Quota

- Platform-key quota commits use normalized total tokens when available.
- Platform-key billing estimates use provider-specific effective cost:
  - cache writes use provider write pricing,
  - cache reads use provider read pricing,
  - uncached input uses normal input pricing,
  - output and reasoning use normal provider rules.
- BYOK usage is recorded but not charged to platform cost.
- Missing provider usage is an execution defect for supported chat providers,
  not an accepted production state.

## Final State

### Kept

- `POST /api/chat-runs` remains the only send endpoint.
- Durable chat runs remain the execution source of truth.
- Scoped conversations remain the source of retrieval boundaries.
- Backend services own prompt rendering and retrieval policy.
- App search and web search remain separate evidence channels.
- `chat_prompt_assemblies` remains the prompt assembly ledger, expanded to
  store the prompt plan manifest.
- External LLM calls remain behind `llm-calling`.

### Replaced

- Raw `Turn.content: str` with structured content blocks.
- `render_prompt(...) -> list[Turn]` with prompt-plan construction.
- `message_llm.prompt_tokens` and `completion_tokens` naming with normalized
  `input_tokens` and `output_tokens`.
- Provider-specific usage parsing with normalized usage plus provider usage
  JSON.
- String-length LLM accounting fallbacks with provider usage requirements.

### Removed

- Any string-only prompt path for durable chat execution.
- Any provider adapter that drops cache hints silently.
- Any scoped-chat model option without required cache capability.
- Any prompt structure that places retrieval, recent history, or the current
  user message inside the stable cacheable prefix.
- Any top-level system string that combines stable scope with per-turn context.
- Any cache key or log field containing raw user text or source text.
- Any feature flag for this cutover.
- Any compatibility wrapper around old `LLMRequest` or `Turn` shapes.

## Architecture

```text
Chat run execution
  loads conversation scope
  loads attached message contexts
  loads selected retrievals
  loads stable memory snapshot
  loads compiled scope context artifact

Prompt planning
  builds PromptBlock values by lane
  budgets blocks by lane
  validates stable prefix ordering
  computes block hashes and stable prefix hash
  assigns semantic cache policies
  persists prompt plan manifest

Provider request building
  checks provider/model capability contract
  translates PromptPlan to provider-native request
  applies provider-native cache controls
  sends request

Usage normalization
  parses provider usage
  normalizes input/output/reasoning/cache tokens
  persists provider usage JSON
  updates quota and cost
  emits cache observability
```

## Structure

### Prompt Plan Layer

Add a Nexus service layer responsible for prompt plans:

- `PromptPlan`
- `PromptTurn`
- `PromptBlock`
- `PromptCachePolicy`
- `PromptPrivacyScope`
- `PromptPlanManifest`

This layer is provider-neutral. It may say "this block is required to be cached
with a 300 second TTL," but it must not say `cache_control`.

### Context Artifact Layer

Add versioned stable artifacts for expensive recurring context:

- media scope artifact,
- library scope artifact,
- stable memory snapshot.

The artifact content is compact, source-referenced, and invalidated by source
version changes. It is not a whole-document or whole-library dump.

### Provider Capability Layer

`llm-calling` owns a capability matrix for provider/model behavior:

- supports structured content blocks,
- supports prompt cache hints,
- supports explicit cached content resources,
- supports prompt cache keys,
- max cache breakpoints,
- supported TTL values,
- minimum cacheable tokens,
- usage fields reported in streaming,
- usage fields reported in non-streaming.

Chat execution refuses provider/model combinations that cannot satisfy the
prompt plan.

### Provider Adapter Layer

Adapters translate semantic cache policy:

- Anthropic maps cacheable text blocks to content blocks with `cache_control`.
- OpenAI preserves exact stable prefixes and adds the derived prompt cache key.
- Gemini creates or reuses explicit cached content resources.
- Bedrock maps breakpoints to cache points when Bedrock support exists.

Adapters do not decide what is semantically cacheable.

### Observability Layer

Normalized usage is persisted on `message_llm`. Provider usage is stored as
typed `jsonb`. Logs include cache counts and hashes. Metrics are grouped by
provider, model, scope type, and key mode.

## Data Model

### `message_llm`

Final normalized columns:

- `message_id`
- `provider`
- `model_name`
- `input_tokens`
- `output_tokens`
- `total_tokens`
- `reasoning_tokens`
- `cache_write_input_tokens`
- `cache_read_input_tokens`
- `cached_input_tokens`
- `billable_input_tokens`
- `key_mode_requested`
- `key_mode_used`
- `cost_usd_micros`
- `latency_ms`
- `error_class`
- `provider_request_id`
- `prompt_version`
- `prompt_plan_version`
- `stable_prefix_hash`
- `provider_usage`
- `created_at`

`provider_usage` is PostgreSQL `jsonb`, not text.

### `chat_prompt_assemblies`

Add prompt-plan observability:

- `prompt_plan_version`
- `stable_prefix_hash`
- `cacheable_input_tokens_estimate`
- `prompt_block_manifest`
- `provider_request_hash`

`prompt_block_manifest` stores block ids, lanes, stable hashes, source versions,
cache policies, estimated tokens, and included/dropped state. It does not store
raw prompt text.

### `scope_context_artifacts`

Add when implementing compiled scope artifacts:

- `id`
- `owner_user_id`
- `scope_type`
- `scope_media_id`
- `scope_library_id`
- `artifact_kind`
- `artifact_version`
- `source_version`
- `prompt_version`
- `content_text`
- `source_refs`
- `stable_hash`
- `estimated_tokens`
- `created_at`
- `invalidated_at`

`source_refs` is `jsonb`. Active artifacts have `invalidated_at IS NULL`.

## Rules

- Hard cutover only.
- No feature flag.
- No legacy prompt format.
- No fallback prompt path.
- No backward-compatible `Turn.content` string handling.
- No provider adapter may ignore required cache policy.
- No scoped-chat model may be exposed unless it satisfies the prompt contract.
- No provider-specific request syntax in Nexus services.
- No dynamic retrieval, web evidence, recent history, or current user block in
  the stable prefix.
- No cache key may contain raw prompt text.
- No cross-user, cross-tenant, cross-provider, cross-model, or cross-key-mode
  cache reuse.
- No whole-corpus prompt stuffing.
- No model-authored citations.
- No client-provided quote text as source evidence.
- No business logic in Next.js BFF routes.
- Escape prompt XML values inline at generated-text boundaries.
- Persist structural metadata as `jsonb`, not stringified JSON.
- External LLM APIs are external test boundaries and must be mocked at the HTTP
  boundary in adapter tests.

## Non-Goals

- No user-facing cache controls.
- No full wiki/notebook authoring product in this cutover.
- No self-hosted inference, KV-cache server, or prefix-aware router.
- No semantic answer cache.
- No sharing cache entries across users to improve hit rate.
- No provider pricing UI.
- No best-effort provider fallback when caching is required.
- No attempt to cache highly dynamic retrieval or web-search evidence.

## Acceptance Criteria

### Prompt Plan

- A scoped chat run produces a persisted prompt plan manifest.
- The manifest has cacheable `system`, `scope`, compiled artifact, and stable
  memory blocks before all dynamic blocks.
- The manifest records stable hashes and cache policies for cacheable blocks.
- Tests fail if retrieved evidence, recent history, or current user content
  appears inside the stable prefix.
- Prompt budget tests operate on prompt blocks, not raw strings.

### Provider Adapters

- Anthropic request tests prove `system` is sent as structured text blocks with
  cache controls at expected breakpoints.
- Anthropic streaming tests parse input, output, cache write, and cache read
  token usage.
- OpenAI request tests prove the exact stable prefix is preserved and the
  prompt cache key is sent.
- OpenAI usage tests parse cached input tokens.
- Gemini tests prove explicit cached content creation and reuse for large stable
  artifacts, if Gemini remains enabled for scoped chat.
- Unsupported provider/model combinations raise a capability error before any
  network call.

### Persistence And Accounting

- `message_llm` persists normalized token fields and provider usage JSON.
- `chat_prompt_assemblies` persists the prompt block manifest and stable prefix
  hash.
- Platform-key quota commits use normalized total tokens.
- Cost calculation distinguishes cache writes, cache reads, uncached input,
  output, and reasoning.
- No production chat execution relies on character-count token fallback.

### Observability

- Success logs include `cache_write_input_tokens`, `cache_read_input_tokens`,
  `cached_input_tokens`, `stable_prefix_hash`, provider, model, scope type, and
  key mode.
- Logs and manifests do not include raw prompt text.
- A dashboard or query can report hit rate by provider/model/scope type.
- Cache miss triage can compare stable prefix hashes across adjacent turns.

### Product And Retrieval

- Scoped-chat answers and citations remain behaviorally equivalent apart from
  cost and latency.
- App search scope remains explicit and is not widened to create larger cache
  prefixes.
- Web search remains a separate explicit evidence path.
- If memory changes, the stable prefix hash changes and the next turn records a
  cache write rather than a misleading read expectation.

## Key Decisions

1. Prompt caching is a context architecture concern.

   Provider APIs expose different cache mechanisms, but Nexus must decide which
   context is stable, private, source-grounded, and reusable.

2. Cache semantics live above adapters. Cache syntax lives inside adapters.

   Nexus services emit `PromptCachePolicy`. Anthropic emits `cache_control`.
   OpenAI emits cache keys and stable prefixes. Gemini emits cached content
   handles.

3. The stable prefix is small, deliberate, and ordered first.

   Caching only works reliably when the prefix is exact and dynamic blocks do
   not perturb it.

4. Memory must be versioned to be cacheable.

   A memory string regenerated every turn defeats prefix reuse. Cacheable memory
   is a stable snapshot with source refs and a stable hash.

5. Usage accounting is part of the feature.

   Without cache write/read tokens in the database, Nexus cannot prove savings,
   bill correctly, or diagnose misses.

6. Unsupported provider support is disabled, not degraded.

   A no-op provider adapter would make cost behavior unpredictable and hide
   production regressions.

7. Cache isolation follows data isolation.

   User, tenant, scope, provider, model, account boundary, and key mode are all
   part of cache identity.

8. Compiled artifacts are the long-term scale layer.

   Retrieval handles per-turn evidence. Compiled artifacts provide stable,
   compact, cacheable scope context. They are distinct from whole-corpus prompt
   stuffing.

9. Cache affects cost and latency only.

   Correctness still comes from scoped retrieval, source refs, prompt rules, and
   citations.

## Files

### Add In Nexus

- `docs/prompt-context-cache-hard-cutover.md`
  - This behavior and architecture contract.

- `python/nexus/services/prompt_plan.py`
  - Typed `PromptPlan`, `PromptTurn`, `PromptBlock`, cache policy, privacy
    scope, stable hashing, and manifest generation.

- `python/nexus/services/prompt_cache_policy.py`
  - Cache policy selection by scope type, block lane, estimated tokens, provider
    capability, key mode, and TTL.

- `python/nexus/services/scope_context_artifacts.py`
  - Load, create, invalidate, and render stable media/library context artifacts.

- `python/nexus/services/llm_usage.py`
  - Normalize provider usage, calculate billable input, and calculate cost.

- `migrations/alembic/versions/<next>_prompt_context_cache_cutover.py`
  - Rename usage columns, add cache usage fields, add provider usage JSON, add
    prompt plan fields, and create scope context artifact table.

- `python/tests/test_prompt_plan.py`
  - Block ordering, stable hashing, cache policy, privacy scope, and manifest
    tests.

- `python/tests/test_prompt_cache_policy.py`
  - TTL and provider capability decisions.

- `python/tests/test_llm_usage.py`
  - Normalized usage and cost accounting.

- `python/tests/test_prompt_context_cache_chat_runs.py`
  - Durable chat-run integration tests for prompt manifest persistence and usage
    persistence.

### Update In Nexus

- `python/nexus/services/context_assembler.py`
  - Build and budget a `PromptPlan` instead of rendering raw prompt strings.
  - Load stable memory and scope artifacts before dynamic evidence.

- `python/nexus/services/chat_prompt.py`
  - Replace with block renderers or reduce to invariant instruction text
    helpers.

- `python/nexus/services/context_rendering.py`
  - Render source-grounded context blocks with block metadata and inline XML
    escaping.

- `python/nexus/services/prompt_budget.py`
  - Budget `PromptBlock` values and preserve cacheable-prefix ordering.

- `python/nexus/services/chat_runs.py`
  - Persist prompt manifests, call providers with structured requests, log cache
    metrics, and finalize normalized usage.

- `python/nexus/db/models.py`
  - Apply `message_llm`, `chat_prompt_assemblies`, and
    `scope_context_artifacts` schema changes.

- `python/nexus/schemas/context_memory.py`
  - Expose prompt assembly manifest fields for operator/debug APIs if this
    schema remains the prompt assembly response owner.

- `python/nexus/services/models.py`
  - Hide or reject provider/model combinations that cannot satisfy scoped-chat
    prompt cache requirements.

- `python/pyproject.toml`
  - Point `llm-calling` to the cutover revision.

### Update In `llm-calling`

- `src/llm_calling/types.py`
  - Replace string-only turns with structured content blocks and normalized
    usage fields.

- `src/llm_calling/capabilities.py`
  - Provider/model capability matrix.

- `src/llm_calling/router.py`
  - Enforce provider capability contracts before dispatch.

- `src/llm_calling/anthropic.py`
  - Structured system blocks, cache controls, streaming usage parsing, and
    non-streaming usage parsing.

- `src/llm_calling/openai.py`
  - Stable prefix preservation, prompt cache key support, cached token usage
    parsing.

- `src/llm_calling/gemini.py`
  - Explicit cached content resource support or scoped-chat disablement.

- `tests/test_anthropic_prompt_cache.py`
  - Request body and usage parsing tests.

- `tests/test_openai_prompt_cache.py`
  - Cache key and cached token parsing tests.

- `tests/test_gemini_cached_content.py`
  - Cached content lifecycle tests if Gemini remains enabled.

### Remove

- String-only `LLMRequest.messages` and `Turn.content` handling.
- Character-count token fallback for successful provider calls.
- Any scoped-chat provider availability that cannot satisfy the prompt cache
  contract.
- Any tests that assert internal helper calls instead of behavior or persisted
  usage.
