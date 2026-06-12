# LLM Provider Runtime Hard Cutover

## Status

Implementation tracker and hard-cutover contract for the provider runtime layer.
The current cutover scope is `provider_runtime` plus Nexus. Additional
consumers are not acceptance targets for this pass. This document supersedes
the provider client assumption in
`docs/cutovers/generation-run-harness-hard-cutover.md` while preserving that
document's durable generation harness: worker-owned runs, server-side key
resolution, provider-call ledger rows for generation paths, persisted stream
events, and surface-owned domain finalization.

Current state as of 2026-06-12:

- `llm-calling` has been reworked into the `provider_runtime` package with
  first-class `catalog.py`, `lowering.py`, `runtime.py`, `testing.py`, and
  `usage.py`; OpenAI Responses, Anthropic Messages, Gemini, OpenRouter,
  Cloudflare OpenAI-compatible chat, OpenAI/OpenAI-compatible embeddings,
  normalized errors, bounded runtime retries, stream retry-before-first-chunk
  only, usage/request-id capture, key probes, advisory cost policy, integer USD
  scripted runtimes, verified catalog pricing with provenance and
  fail-closed context thresholds, and typed opaque provider-artifact replay
  carriers.
- Nexus generation paths use `provider_runtime` for chat, oracle, library
  intelligence, media-unit synthesis, metadata enrichment, key probes, and
  transcript embeddings. Nexus sends high-level cache/reasoning/structured
  intent only; provider capability validation and cache lowering live in
  `provider_runtime.lowering`. The remaining exception is that transcript
  embeddings are not yet written to `llm_calls`; they are indexing
  infrastructure calls, not generation-owner rows.
- `python/nexus/services/podcasts/deepgram_adapter.py` remains an explicitly
  documented non-LLM modality exception. It owns podcast-grade Deepgram
  diarization fallback and RSS/fixture normalization, is live-gated through
  `make test-live-providers`, and must move behind `provider_runtime` only if
  the shared package grows a first-class podcast transcription port that can
  preserve those semantics.
- Additional consumer ports are explicitly deferred; this Nexus/provider-runtime
  pass does not claim their adapter, event, import-removal, or live-provider
  proof.
- Nexus now pins `provider-runtime` to the pushed
  `NielsdaWheelz/llm-calling` git revision
  `16ab8457e7730cc1dd4e3483e91fbcd2b971dca5`; the sibling editable path is not
  used by production app code.
- The provider-runtime live matrix now passes through the Nexus pin for OpenAI,
  Anthropic, Gemini, OpenRouter, Cloudflare, embeddings, and OpenAI
  transcription. Nexus-owned Podcast Index/Deepgram, YouTube transcript, and X
  live proofs are non-LLM media gates outside the provider-runtime acceptance
  target. YouTube transcript egress remains optional because datacenter hosts
  may require an operator-owned transcript proxy. Runtime ingest fails closed as
  `E_TRANSCRIPT_UNAVAILABLE` when the proxy is absent or blocked.

Repos involved:

- `nexus-web`: durable chat/generation harness, `/models` catalog API, BYOK,
  ledger, frontend model settings.
- `llm-calling`: provider-behavior reference implementation, goldens, and
  type vocabulary to fold forward. This existing repo is renamed/reworked in
  place as the shared runtime repo.
- Shared package: `provider_runtime`, a DB-free Python provider runtime that
  replaces `llm-calling`.

Hard cutover means no compatibility layer, no dual provider stacks, no legacy
fallback flags, and no provider-call path that bypasses the new runtime.

Second-pass survey verdict:

- `llm-calling` is valuable as provider-behavior evidence and fixture material,
  not as the final architecture. Keep its provider-specific request/response
  semantics, error taxonomy, and terminal-stream invariants; rewrite the
  framework, transport, retry, catalog, and SSE/parser edges.
- Nexus owns the production harness: API-key resolution, durable run
  idempotency, `llm_calls`, budget accounting, SSE, citations, prompts,
  search/resource tools, and all DB writes.
- Raw HTTP/provider adapters are the current substrate because they preserve
  request IDs, usage fields, stream terminal semantics, and opaque reasoning /
  thinking artifacts exactly. Pydantic AI remains only a possible future
  implementation detail for routes whose artifact-fidelity tests pass.
- LiteLLM is a later optional gateway/control-plane candidate for virtual keys,
  budgets, proxy routing, rate limits, and response caching. It is not the
  source of truth for provider reasoning/tool-continuation semantics.

Implementation decisions for the first build:

- Rework `/home/niels/src/personal/llm-calling` in place. The Python
  import/package name is `provider_runtime`, and Nexus consumes it through an
  immutable git revision rather than a sibling editable path.
- Implement the shared runtime first, then port Nexus against the same pinned
  package revision. Additional consumers are out of scope for this pass.
- First provider scope is OpenAI Responses, Anthropic Messages, Gemini,
  OpenRouter, Cloudflare/OpenAI-compatible, and embeddings.
- Groq and other future routes are deferred until they have an explicit catalog
  entry, adapter support, tests, and a consuming app requirement.
- Use raw provider adapters by default. Higher-level library adapters are allowed
  only after artifact-fidelity tests prove the route preserves exact replay,
  streaming terminal semantics, request IDs, and provider-specific usage/error
  data.
- Remove old `llm-calling` imports, duplicated lowerers, stale dependency pins,
  and provider-bypass paths as part of the cutover. Compatibility shims are not
  required.
- Unit, golden, fake-runtime, static, typecheck, app integration, and the
  provider-runtime live matrix now gate the cutover. Nexus-owned media live
  proofs remain optional release evidence and require their own provider
  credentials or egress paths.

## Current Failure

Prod chat run `82d85414-6106-4c46-a09c-c82224f4cd99` failed before reaching
OpenAI. Nexus emitted a cached OpenAI turn with `prompt_cache_key=None`, and
`llm-calling` raised:

```text
E_LLM_BAD_REQUEST: OpenAI prompt cache turns require prompt_cache_key
```

The defect was structural:

- prompt assembly marked a stable system block cacheable;
- request construction lowered that cache intent directly to `Turn.cache_ttl`;
- provider capabilities did not decide whether cache TTL was legal or whether a
  provider cache key was required.

The same latent issue existed in structured synthesis.

## Goals

- Restore prod chat for OpenAI reasoning models.
- Make provider/model capabilities server-owned truth.
- Make `/models` the complete frontend model-selection contract.
- Keep Nexus durable generation lifecycle intact.
- Replace ad hoc provider wire handling with a shared typed provider runtime.
- Normalize usage, cache tokens, reasoning tokens, request IDs, retries, and
  typed errors once.
- Preserve provider reasoning artifacts exactly while keeping them opaque.
- Add invariant and live-provider gates that prove provider behavior instead of
  relying on catalog prose.

## Non-Goals

- Do not move Nexus chat persistence, SSE, citations, search tools, or branch
  logic into the shared package.
- Do not move product prompts, memory, proactivity, approvals, or capability
  policy from any consuming app into the shared package.
- Do not introduce LangChain/LangGraph-style orchestration.
- Do not use Pydantic AI or LiteLLM fallback layers. Do not stack hidden
  provider SDK retries with runtime retries; `provider_runtime` owns bounded
  provider retries, and Nexus job retries own durable re-execution only.
- Do not preserve `llm-calling` imports after the shared runtime cutover.

## Target Behavior

User-visible behavior:

- Chat send works for every model returned by `/models`.
- The model settings UI only offers server-authorized providers, models,
  reasoning modes, and key modes.
- A model switch cannot select a reasoning mode unsupported by that model.
- BYOK-only mode only offers models usable through a user's key.
- Cloudflare is platform-only in Nexus until the credential contract carries
  both token and account id; it remains a runtime/model provider.
- Stream disconnects do not cancel durable chat work.
- Provider failures surface as typed run/message errors with retry affordances
  only where product semantics allow retry.

Operator-visible behavior:

- Every generation provider operation produces exactly one `llm_calls` row.
  Provider-runtime retries are captured in that row's bounded attempt trace
  rather than split into separate durable ledger rows. Transcript embeddings use
  `provider_runtime.embed()` but are not yet ledgered.
- Cache read/write tokens and reasoning tokens are recorded using normalized
  fields.
- Provider request IDs are retained when available, including provider-error and
  key-probe paths.
- Prompt cache hit behavior can be inspected through usage and latency.
- Catalog/capability mismatches are defects, not product states.
- `chat_runs.reasoning` and `chat_runs.key_mode` are constrained to the
  explicit post-cutover request vocabularies.

Provider behavior:

- OpenAI cached turns always have a deterministic `prompt_cache_key`.
- Anthropic cache TTL stays on cacheable content blocks and never gets an
  OpenAI cache key.
- Providers without implemented cache support receive no cache TTL payload.
  OpenRouter is currently in this category until provider-specific cache routing
  is implemented and tested.
- OpenAI encrypted reasoning, Anthropic thinking/redacted thinking, and Gemini
  thought signatures are replayed exactly when required for tool continuation.
- Hidden reasoning artifacts are never parsed, logged, rendered, or persisted as
  product data.

## Final Architecture

```text
Nexus surface code
  prompts / tools / run persistence / citations / finalization
        |
        v
Nexus LLM harness
  resolve_api_key -> provider runtime -> llm_ledger -> run_kit terminal state
        |
        v
provider_runtime
  catalog -> validation -> lowering -> runtime retry/transport -> raw provider adapters
```

The shared runtime is a provider adapter, not an application service. It knows
how to call models. It does not know why Nexus or a future consumer is calling
them.

## Source Repo Extraction Boundaries

Move from `llm-calling`:

- normalized request/response vocabulary;
- provider body golden tests for OpenAI Responses, Anthropic Messages, Gemini
  GenerateContent, OpenRouter, Cloudflare, and OpenAI-compatible routes;
- provider parsing for usage, request IDs, status/incomplete details, reasoning
  tokens, cache tokens, encrypted reasoning, thinking blocks, thought
  signatures, function calls, and structured JSON;
- terminal-stream invariant: usage/status/incomplete details only appear on the
  terminal chunk.

Do not keep from `llm-calling`:

- router/client lifecycle as the final API;
- lack of retry/idempotency controls;
- shallow error objects;
- provider capability policy spread across adapters;
- unsupported structured streaming semantics;
- any behavior that treats provider-specific cache/reasoning knobs as caller
  literals.

Move from Nexus:

- request lowering for cache/reasoning/structured-output/provider extras,
  duplicate capability literals, normalized usage parsing, model catalog
  capability truth, fake provider runtime patterns, and provider negative-gate
  scans.

Keep in Nexus:

- key resolution, BYOK/platform policy, entitlements, budgets, `ChatRun`, job
  envelopes, `llm_calls`, run terminal writes, SSE, search/resource tools,
  citations, prompt assembly, domain schemas, repair/finalization, and all DB
  ownership. Transcript embeddings now use `provider_runtime.embed()` but remain
  an explicit non-ledgered indexing exception for this cutover.

## Shared Package API

Package name: `provider_runtime`.

The package is importable by Nexus and future projects. It has no DB
dependency, no product prompt dependency, no web-framework dependency, and no
knowledge of app persistence. Only symbols exported from
`provider_runtime.__init__` are public after `1.0`; adapter internals remain
private.

Current public API shape:

```python
runtime = ModelRuntime(
    http_client,
    catalog=DEFAULT_CATALOG,
    base_urls=ProviderBaseUrls(...),
    enable_openai=True,
    enable_anthropic=True,
    enable_gemini=True,
    enable_openrouter=True,
    enable_cloudflare=True,
)

call = ModelCall(
    model=ModelRef(provider="openrouter", model="moonshotai/kimi-k2.6", route="openrouter"),
    messages=[...],
    tools=[...],
    tool_choice="required",
    reasoning=ReasoningConfig(effort="high"),
    max_output_tokens=12_000,
    retry=RetryPolicy(max_attempts=2),
)

response = await runtime.generate(call, key=provider_key)
async for chunk in runtime.stream(call, key=provider_key):
    ...

embedding = await runtime.embed(embedding_call, key=provider_key)
transcription = await runtime.transcribe(transcription_call, key=provider_key)
probe = await runtime.probe_key(provider="openai", key=provider_key)
capabilities = runtime.capabilities(ModelRef(provider="openai", model="gpt-5.5"))
```

Core types:

- `ProviderName`: closed vocabulary for this cutover: `openai`, `anthropic`,
  `gemini`, `openrouter`, `cloudflare`; future providers are added explicitly.
- `ModelRef`: provider, provider model id, optional route id. Route is distinct
  from provider so a model can run through OpenRouter, a direct SDK, or an
  OpenAI-compatible gateway without changing product model identity.
- `ProviderApiKey`: opaque key plus source metadata such as `platform` or
  `byok`. It never exposes raw key text through logs/errors/reprs.
- `ReasoningConfig`: canonical effort enum `none`, `minimal`, `low`, `medium`,
  `high`, `max`, optional `budget_tokens`, and provider-native passthrough only
  inside the adapter boundary.
- `ModelMessage`: role, content parts, tool calls, tool results, provider
  artifacts, and per-turn cache TTL intent. It can carry text and binary
  content parts; route-specific multimodal lowering for future consumers is a
  separate proof item.
- `ToolSpec`, `ToolCall`, `ToolResult`: strict tool contract.
- `ToolCall.arguments`: parsed JSON only. If a provider returns repairable
  argument text, the runtime returns `argument_status="repaired"`; unrepaired
  malformed arguments raise `ModelCallError(code="tool_arguments_invalid")`.
- `ProviderArtifact`: opaque provider reasoning/signature item with provider,
  model, purpose, replay payload, and retention policy metadata. It is never
  rendered, logged, or stringified.
- `StructuredOutputSpec`: strict JSON/schema output request.
- `ModelCall`: model ref, messages, tools, tool choice, structured output,
  max output tokens, temperature, reasoning, cache intent, and retry policy.
  Timeout is supplied at the runtime method boundary.
- `ModelChunk`: streamed delta, tool call, provider artifact, provider request
  id, and terminal usage/status. Usage/status/incomplete details are terminal
  chunk only.
- `ModelResponse`: text, tool calls, structured output, provider artifacts,
  usage, request id, status/incomplete details.
- `TokenUsage`: input, output, total, reasoning, cache creation, cache read,
  cached input, provider raw usage.
- `TranscriptionCall` and `TranscriptionResponse`: shared OpenAI transcription
  request/response types. Nexus podcast Deepgram and YouTube transcript
  acquisition remain documented non-LLM media-provider ports until a shared
  transcription API preserves those modality-specific semantics.
- `CostBreakdown`: input/output/cache/reasoning cost from catalog pricing when
  the catalog carries verified price values.
- `ModelCallError`: closed error code, provider, retryability, HTTP status,
  `Retry-After`, provider request id, sanitized detail, bounded safe body
  snippet, and retry attempt trace.
- `RetryPolicy`: max attempts, deadline, retryable error classes, delay bounds,
  and jitter. Stream retry safety is enforced by the runtime: retries stop once
  visible streamed output, a tool call, or another side-effect-bearing chunk has
  been emitted.

Package modules:

- `types.py`: public dataclasses/protocols and invariants.
- `catalog.py`: model capabilities, context windows, prices, reasoning modes,
  cache support, routes, key-probe model, tool/streaming/structured-output
  support.
- `lowering.py`: provider-neutral validation and high-level lowering for cache
  intent. Provider-native request bodies for reasoning, tool choice, structured
  output, OpenAI-compatible extras, and routing settings are built inside the
  raw provider adapters after this shared validation step.
- `runtime.py`: `generate`, `stream`, `embed`, key probes, timeout/retry
  envelope.
- provider adapters: flat raw `httpx` modules for the current provider set;
  Pydantic AI remains a future fidelity spike, not current substrate.
- transport/retry behavior currently lives in the runtime and adapters: timeout,
  request id capture, bounded retry, safe error classification, and injected
  `httpx.AsyncClient`.
- `retry.py`: future extraction target for richer retry traces. Cross-model
  fallback is disabled and must not be automatic across materially different
  model policies.
- `usage.py`: normalized usage and cost fields.
- `errors.py`: typed error mapping.
- `testing.py`: `ScriptedRuntime`, `NoNetworkRuntime`, captured runtime calls,
  fake streams, fake embeddings, fake transcriptions, and fake key probes for
  app tests. Provider fixture and invariant tests live in the package test suite
  beside the adapters.

Public call semantics:

- Runtime validation happens before provider I/O.
- Unsupported required capabilities raise typed errors before provider I/O.
- Unsupported optional optimizations, such as cache on a route without cache
  support, are stripped during lowering and represented in the request plan for
  tests/diagnostics.
- Provider-native payloads are created only inside provider adapters after
  shared validation/lowering.
- Normalized response fields are stable even when raw provider payloads differ.
- Explicitly modeled raw provider artifacts and raw usage fragments are
  available to callers through opaque fields, not hidden globals.

## Provider Capability Contract

Capabilities are per model, not merely per provider. Provider-level defaults are
allowed only as defaults that each model can override. The authoritative
capability catalog is `provider_runtime.catalog.DEFAULT_CATALOG`; Nexus
`llm_catalog.py` is now an app overlay for display names, model tier/order, DB
availability, and key-mode overlays.

Required fields:

- `provider`
- `model`
- `routes`
- `default_route`
- `key_probe_model`
- `reasoning_modes`
- `reasoning_budget_tokens`
- `max_context_tokens`
- `max_output_tokens`
- `prompt_cache.mode`: `none`, `turn_ttl`, `keyed_ttl`, provider-specific later
- `prompt_cache.ttl_options`
- `prompt_cache.requires_key`
- `prompt_cache.affinity_hints`
- `streaming`
- `tool_calling`
- `tool_choice_required`
- `structured_output`
- `structured_output_streaming`
- `reasoning_continuation`
- `multimodal_input`
- `embeddings`
- `transcription`
- `provider_request_id`
- `usage.input_output_tokens`
- `usage.reasoning_tokens`
- `usage.cache_read_write_tokens`
- `raw_artifact_support`
- `retryable_errors`
- `default_timeout_s`
- `max_timeout_s`
- `price_input`, `price_output`, `price_cached_input`, `price_reasoning`

The catalog powers:

- backend request validation;
- `/models` frontend options through a UI-safe projection;
- provider lowering;
- live-provider matrix selection;
- cost estimates and ledger attribution.

The catalog is not allowed to be provider-only. Model-specific exceptions are
normal for reasoning, cache, context windows, structured output, and
OpenRouter-routed models. Provider defaults are only a way to reduce duplicated
metadata before per-model overrides are applied.

## Catalog And `/models`

DB `models` rows remain availability/id/cost storage. Code catalog remains the
curated capability source. The `/models` response is the complete UI contract,
not a raw dump of every provider-runtime catalog field. Internal retry,
pricing, timeout, usage-provenance, route, and opaque-artifact fields stay
backend-owned; `/models` exposes only the fields the browser needs to render
and submit valid chat choices:

- ordered models;
- provider/display names;
- model tier;
- `provider_rank`, `model_rank`, `is_default`;
- `reasoning_modes`;
- `available_via`, `available_key_modes`;
- max context;
- nested capabilities.

Frontend rules:

- no hardcoded chat provider order;
- no client-side reasoning normalization;
- no client-side default model policy;
- no rendering of choices missing from `/models`.

## Prompt Cache Policy

Prompt cache is represented as high-level intent before provider lowering.

Rules:

- Static prompt content is placed before dynamic/user content.
- Nexus marks cacheable prompt turns with high-level `ModelMessage.cache_ttl`
  only. It does not construct provider cache payloads or provider cache keys.
- OpenAI cache keys are deterministically derived inside
  `provider_runtime.lowering` from provider, model, and cacheable message
  identity. They are provider-runtime routing hints, not app persistence keys.
- OpenAI receives `prompt_cache_key` whenever any turn has cache TTL.
- Anthropic receives cache TTL block markers and no cache key.
- OpenRouter receives no cache TTL in the current implementation. Provider-
  supported cache controls, routing affinity, and optional session/provider
  preferences are future work and require runtime lowering plus live tests.
- Gemini/Cloudflare receive no cache TTL until their runtime implementation
  supports a cache contract.
- Unsupported cache intent is stripped when it is an optimization; it is a typed
  error only when the surface declares cache support mandatory for correctness.
- Cache usage metrics are normalized into ledger cache write/read/cached fields.
- Whole-transcript response caching is not the default chat optimization. The
  runtime optimizes stable prompt prefixes first; deterministic response caching
  can be a separate route-level feature for non-streaming, side-effect-free,
  idempotent calls.

## Reasoning And Tool Continuation

Opaque provider artifacts:

- OpenAI Responses reasoning encrypted content;
- Anthropic thinking and redacted thinking blocks;
- Gemini thought signatures.

Rules:

- Capture artifacts from provider streams/responses.
- Store them only in the in-memory continuation turn for the active provider
  loop by default.
- If a future provider contract requires cross-process replay, retention must be
  explicit: encrypted durable store, bounded TTL, redacted operational logs, and
  app-owned data-classification approval.
- Replay them exactly as received.
- Never parse, transform, log, render, or summarize hidden reasoning artifacts.
- Persist only sanitized metadata: provider, model, usage counts, request IDs,
  status, and typed error data.

Continuation writers are provider-specific:

- OpenAI Responses: replay encrypted reasoning items and function-call outputs
  without adopting `previous_response_id` as a server conversation cursor.
- Anthropic Messages: replay thinking/redacted-thinking signatures only in the
  provider-supported position for the active tool loop.
- Gemini GenerateContent: replay thought signatures exactly with the content
  parts that require them.
- OpenRouter/OpenAI-compatible routes: preserve reasoning blocks/details and
  provider extras without assuming OpenAI Responses semantics.

## Cost, Usage, And Ledger

The runtime normalizes usage. Nexus remains the ledger owner.

Current Nexus `llm_calls` rows record:

- owner kind/id and call sequence;
- provider/model/operation/streaming/reasoning;
- key mode requested/used;
- input/output/total/reasoning tokens;
- cache write/read/cached input tokens;
- latency;
- provider request id;
- sanitized error class/detail;
- raw provider usage object when safe and useful.
- attempt count, retry count, terminal attempt status, and the bounded provider
  attempt trace when the shared runtime reports attempts.
- provider route, advisory cost status, component/total cost fields in integer
  USD micros, and a pricing snapshot with catalog source, route/model key,
  cache-write TTL, rates, currency, unit, verified date, source URL, and
  reasoning billing mode.

Cost calculation belongs beside normalized usage and model price metadata, not in
frontend code or provider adapters.

Runtime cost output is advisory and deterministic from catalog price metadata.
Nexus persists the shared runtime's policy answer at the ledger boundary. The
catalog contains verified provider/public-API prices where the current price
shape can be represented honestly. Calls outside a represented pricing range,
calls with unverified/ad hoc prices, calls with provider-unit pricing, or calls
whose usage omits required token fields fail closed with `missing_pricing`,
`not_token_priced`, or `missing_usage` and no synthesized total. Live provider
proof remains a separate gate.

## Retry And Idempotency

Nexus application idempotency remains app-owned:

- `ChatRun` idempotency keys;
- job dedupe;
- durable message/event finalization;
- tool side-effect idempotency.

Provider retries belong in the shared runtime:

- bounded;
- closest to the provider operation;
- disabled provider-SDK retries unless the runtime has delegated retry ownership
  for that route explicitly;
- retry only timeouts, connection failures, 429, and 5xx when safe;
- honor `Retry-After`;
- preserve provider request id and safe response snippets per attempt;
- no retry for 400/schema/bad key/catalog mismatch;
- no retry after a streamed visible delta, tool call, or side effect unless the
  caller restarts the entire durable run under app idempotency.

Only one retry owner is active for a call. Hidden provider SDK retries are
disabled when the runtime owns retry. Automatic cross-model/provider fallback is
not part of this runtime because silent model changes can alter product
semantics.

## Nexus Integration

Keep:

- `resolve_api_key`
- `ChatRun`
- jobs and worker envelope
- `observed_generate` / `observed_generate_stream`
- `llm_calls`
- `run_kit.mark_terminal`
- prompt assembly per surface
- citations/search/resource tools
- budget reserve/commit/release
- key status updates
- domain-specific schema validation, repair, and finalization

Replace:

- `llm-calling` imports
- provider-specific request lowering in Nexus services
- frontend provider order/default policy
- duplicate model capability literals
- direct `ModelCall` construction outside approved runtime/request-plan modules
  and app service owners

Primary Nexus call sites to migrate:

- runtime construction/injection: `python/nexus/app.py`,
  `python/nexus/api/deps.py`, `python/nexus/tasks/llm_task.py`;
- chat streaming and prompt planning: `services/chat_runs.py`,
  `services/context_assembler.py`, `services/chat_prompt.py`,
  `services/llm_ledger.py`;
- oracle and structured synthesis: `services/oracle.py`,
  `services/structured_synthesis.py`;
- library intelligence and media intelligence:
  `services/library_intelligence_reduce.py`,
  `services/media_intelligence.py`;
- metadata enrichment: `tasks/enrich_metadata.py`,
  `services/metadata_enrichment.py`;
- key probes: `services/user_keys.py`, `api/routes/keys.py`;
- model surfacing: `llm_catalog.py`, `services/models.py`,
  `schemas/models.py`, `apps/web/src/components/chat/useChatModels.ts`;
- embedding edge: `services/semantic_chunks.py`.

Nexus-specific requirements:

- `observed_generate` and `observed_generate_stream` continue to create ledger
  rows before provider I/O and finalize them on terminal response/error.
- Streaming done events must carry terminal usage/status when available.
- The runtime error object maps into Nexus `ModelCallError`/run error codes without
  leaking provider bodies or keys.
- Key probes intentionally do not write `llm_calls`. Generation and structured
  calls do. Transcript embeddings use `provider_runtime.embed()` but remain a
  tracked non-ledgered exception for this slice because there is no embedding
  run owner yet. Probe telemetry must use the same request object returned by
  `provider_runtime.build_key_probe_call()` that `ModelRuntime.probe_key()` uses
  internally.
- Nexus sends only high-level cache/reasoning/structured-output intent into
  `provider_runtime`; it does not hand-build provider extras.
- `/models` becomes generated from or backed by the shared catalog plus Nexus DB
  availability/cost overlays. Frontend client-side defaults are removed.

## `llm-calling` Migration

`llm-calling` is retired as an import dependency but reworked in place as the
shared runtime repo. The source package becomes `provider_runtime`; the old
`llm_calling` package path is removed after its behavior is represented by
goldens and new public types.

Port first:

- `ModelCall`, `ModelMessage`, `ToolSpec`, `ToolCall`, `ToolResult`,
  `StructuredOutputSpec`, `ModelResponse`, `ModelChunk`, and `TokenUsage`
  invariants;
- OpenAI Responses lowering/parsing, including encrypted reasoning items,
  incomplete details, function calls, request id, structured output, and usage;
- Anthropic lowering/parsing, including system turns, tools, structured output
  via forced tool, thinking/redacted blocks, and usage;
- Gemini lowering/parsing, including JSON schema, function calls, usage, and
  thought signatures;
- OpenAI-compatible negative capability behavior;
- error classifier vocabulary.

Rewrite while porting:

- retry, timeout, and transport ownership;
- capability/catalog source of truth;
- OpenRouter and Cloudflare route handling;
- structured streaming contract;
- richer error objects with HTTP status, retry-after, request id, retryability,
  and safe body snippets;
- provider test fixtures into `provider_runtime.testing`.

## Implementation Slices

1. Shared repo rename/rework: in `/home/niels/src/personal/llm-calling`, rename
   the Python package/import surface from `llm_calling` to `provider_runtime`,
   update project metadata, and keep existing provider tests as behavior
   evidence while they are ported.
2. Shared package scaffold: `provider_runtime` types, catalog, errors, retry
   policy, testing helpers, golden fixture layout, and no-network invariant
   scanners.
3. Port `llm-calling` provider goldens into `provider_runtime` and freeze
   terminal chunk/tool/usage/error invariants before changing Nexus.
4. Implement first provider set in `provider_runtime`: OpenAI Responses,
   Anthropic Messages, Gemini, OpenRouter, Cloudflare/OpenAI-compatible, and
   embeddings. The current substrate is shared raw/provider SDK adapters; do
   not route current production calls through Pydantic AI.
5. Merge catalog truth: Nexus model availability/cost overlays derive from the
   shared model-capability source. Future app role defaults must overlay the same
   catalog rather than fork it.
6. Prove shared runtime locally with unit, type, golden, fake-runtime, and static
   gates, then run the unfiltered live matrix whenever provider keys/env or
   provider egress changes.
7. Cut Nexus from `llm-calling` to `provider_runtime` behind existing
   `observed_generate`/`observed_generate_stream` wrappers.
8. Delete retired Nexus imports, duplicated lowerers, duplicate catalog literals,
   dependency pins, stale docs, and compatibility flags.
9. Run Nexus-focused app integration gates and provider-runtime/Nexus negative
   scans.
10. Run live-provider matrix after keys/env are provided, then update
    steady-state docs.

## Acceptance Criteria

- AC-1 `[met]`: The prod OpenAI cache failure is impossible.
- AC-2 `[met for Nexus/provider-runtime]`: Provider/model/reasoning/cache choices are defined
  once in `provider_runtime.catalog`, with Nexus DB/display/key-mode overlays
  exposed through `/models`.
- AC-3 `[met]`: Frontend has no independent chat provider order, default model policy,
  or reasoning normalization.
- AC-4 `[met for Nexus]`: No direct provider wire calls remain outside the shared runtime.
- AC-5 `[met]`: Nexus keeps one durable `ChatRun` path; HTTP never calls providers
  directly.
- AC-6 `[met with explicit exceptions]`: Nexus generation calls go through key resolver,
  ledger, worker envelope, and terminal run writer; key probes and transcript
  embeddings are explicit non-ledgered exceptions. Podcast Deepgram
  transcription remains a documented non-LLM modality port with a removal gate,
  not a generation-provider bypass.
- AC-7 `[met for current provider set]`: Shared runtime
  normalizes usage, request IDs, cache tokens, reasoning tokens, timeouts,
  retries, typed errors, key probes, embeddings, advisory cost status, integer
  USD micros estimates, pricing snapshots, and persisted Nexus ledger cost
  fields. Verified catalog price rows are populated only where official
  provider/public API prices can be represented honestly; tiered context pricing
  uses fail-closed `applies_up_to_input_tokens` thresholds.
- AC-8 `[met by unit/golden tests]`: Streaming tool loops preserve opaque provider reasoning artifacts exactly.
- AC-9 `[met for current retry policy]`: Provider retries are bounded, recorded
  in runtime attempt metadata, and cannot duplicate durable messages or tool
  side effects.
- AC-10 `[met for Nexus/provider-runtime]`: Nexus consumes the shared runtime
  API; additional consumers are deferred out of this completion boundary.
- AC-11 `[met for Nexus/provider-runtime]`: `llm-calling` imports/config/docs
  are removed from Nexus production import paths, and Nexus pins
  `provider-runtime` to an immutable fetchable git revision.
- AC-12 `[met in shared package]`: `provider_runtime.testing` exposes
  `ScriptedRuntime` and `NoNetworkRuntime` for app tests without provider
  network calls.
- AC-13 `[met for provider-runtime; non-LLM media live proof is optional]`: The shared live matrix now
  covers every generation catalog row, every declared reasoning effort, default
  send, cacheable prompt send, forced tool continuation, structured output where
  supported, streaming where supported, embeddings, transcription, invalid key,
  and timeout. With the supplied production env, the pinned provider-runtime
  matrix passes for OpenAI, Anthropic, Gemini, OpenRouter, Cloudflare,
  embeddings, and OpenAI transcription. Podcast Index/Deepgram, YouTube Data
  API/transcript acquisition, and X remain Nexus-owned non-LLM media live
  proofs, not part of the shared runtime acceptance boundary. YouTube transcript
  egress remains optional because it requires a transcript-capable proxy from
  blocked datacenter hosts. Nexus
  `make test-live-providers` includes that matrix and verifies the checked-out
  provider-runtime repo matches the pinned revision before running it. The
  command unsets `LLM_RUNTIME_LIVE_PROVIDERS` so the acceptance gate cannot be
  accidentally narrowed. CI always runs the non-live pinned provider-runtime
  gate; the external live-provider job runs only when all required repository
  secrets are present and otherwise emits an explicit "not live-provider proof"
  notice. The YouTube transcript live test skips when no
  `YOUTUBE_TRANSCRIPT_PROXY_URL` is configured; runtime behavior remains
  fail-closed.
- AC-14 `[met]`: Embeddings use `provider_runtime.embed()`.
- AC-15 `[met before live keys]`: Before live keys are supplied, the shared runtime and Nexus port pass
  unit, golden, fake-runtime, static, formatting, type, and app integration
  gates without network access.

## Negative Gates

- No `llm-calling` imports in Nexus runtime paths.
- No LLM provider SDK imports outside `provider_runtime`.
- No LLM provider HTTP calls outside `provider_runtime`. Non-LLM provider ports
  are module-owned and live-gated separately: Deepgram podcast transcription,
  Podcast Index, YouTube Data API/transcript acquisition, X, and Brave.
- No `previous_response_id` or server-stored provider conversation cursor.
- No raw provider key reads outside app key resolution.
- No raw provider call outside Nexus ledger wrappers.
- No ambient live-provider matrix filter in `make test-live-providers`; the gate
  must run the full shared matrix.
- No frontend chat `PROVIDER_ORDER`, default-model policy, or reasoning
  normalization.
- No cache TTL emitted to unsupported providers.
- No OpenAI cached turn without `prompt_cache_key`.
- No provider reasoning artifact logging/persistence/rendering.
- No duplicated provider cache/reasoning lowering. The owner is
  `provider_runtime.lowering`; `python/nexus/services/llm_request_lowering.py`
  must not exist.
- No automatic cross-model or cross-provider fallback in this runtime.

Concrete static scans for the current Nexus slice:

```sh
rg -n "\\bllm_calling\\b" \
  /home/niels/src/personal/nexus-web/python/nexus \
  /home/niels/src/personal/nexus-web/apps/web/src

rg -n "^\\s*(from|import) (openai|anthropic|groq)\\b|^\\s*from google import genai\\b|^\\s*(from|import) google\\.(genai|generativeai)\\b|pydantic_ai\\.models|pydantic_ai\\.providers" \
  /home/niels/src/personal/nexus-web/python/nexus \
  /home/niels/src/personal/nexus-web/apps/web/src

rg -n "api\\.openai\\.com|api\\.anthropic\\.com|generativelanguage\\.googleapis\\.com|openrouter\\.ai|api\\.cloudflare\\.com" \
  /home/niels/src/personal/nexus-web/python

rg -n "provider_runtime\\.router|nexus\\.services\\.llm_request_lowering|lower_llm_request_for_provider" \
  /home/niels/src/personal/nexus-web/python \
  /home/niels/src/personal/nexus-web/apps/web/src

rg -n "\\.\\./\\.\\./llm-calling|editable = \"\\.\\./\\.\\./llm-calling\"" \
  /home/niels/src/personal/nexus-web/python/pyproject.toml \
  /home/niels/src/personal/nexus-web/python/uv.lock

rg -n "previous_response_id" \
  /home/niels/src/personal/nexus-web \
  /home/niels/src/personal/llm-calling

rg -n "prompt_cache_key|cache_ttl|cache_control" \
  /home/niels/src/personal/nexus-web/python

rg -n "encrypted_content|redacted_thinking|thoughtSignature|reasoning_content|ThinkingPart|reasoning_summary" \
  /home/niels/src/personal/nexus-web/python/nexus \
  /home/niels/src/personal/nexus-web/apps/web/src
```

## Test Plan

Focused local gates:

- catalog capability unit tests;
- request-lowering golden tests;
- `/models` API response contract tests;
- frontend model-selection tests;
- ledger usage normalization tests;
- chat prompt request tests;
- structured synthesis request tests.

Shared runtime gates:

- exact provider request-body goldens for text, stream, structured output,
  forced tool, reasoning, cache, unsupported feature, errors, retry, and
  idempotency;
- parser goldens for usage, request id, reasoning token counts, cache token
  counts, tool calls, incomplete/status fields, structured outputs, and provider
  artifacts;
- contract tests proving terminal-only stream usage/status;
- no retry after any visible streamed delta or tool call has escaped;
- SDK retry disabling tests;
- `ModelCallError` field stability tests;
- `ProviderArtifact` repr/logging redaction tests;
- bounded retry tests for retryable errors, non-retryable quota exhaustion, and
  stream retry only before the first visible chunk/tool/artifact escapes;
- `ScriptedRuntime` and `NoNetworkRuntime` tests used by Nexus and available to
  future consumers.

Invariant gates:

- static scan for direct provider SDK imports outside shared runtime;
- static scan for direct provider HTTP calls outside shared runtime;
- static scan for `llm-calling` imports after cutover;
- static scan for frontend provider order constants in chat model selection;
- static scan for low-level cache TTL construction outside approved lowering
  modules/tests.

Live gated provider matrix:

- provider x model class x reasoning mode;
- cacheable prompt;
- streaming text;
- forced tool call and continuation;
- structured output where supported;
- embeddings;
- transcription;
- invalid key;
- timeout/retry;
- rate-limit/429 behavior when safely reproducible.

Initial command shape:

```sh
cd /home/niels/src/personal/llm-calling
uv sync --all-extras --locked
uv run ruff check .
uv run ruff format --check .
uv run pyright
uv run pytest
uv build --no-sources
# Run with provider keys/env:
# env -u LLM_RUNTIME_LIVE_PROVIDERS LLM_RUNTIME_LIVE=1 uv run pytest -v -m live_provider tests/live/test_provider_matrix.py

cd /home/niels/src/personal/nexus-web
(cd python && NEXUS_ENV=test uv run pytest -v \
  tests/test_models_catalog.py \
  tests/test_chat_prompt.py \
  tests/test_structured_synthesis.py \
  tests/test_real_media_fixture_llm.py \
  tests/test_llm_ledger.py)
make test-provider-runtime
./scripts/with_test_services.sh make _test-back-db-ready _test-back-integration-raw
make test-live-providers
```

`make test-provider-runtime` verifies that the sibling `LLM_CALLING_DIR`
checkout matches the immutable Nexus pin, then runs provider-runtime's non-live
format, lint, type, and unit/golden tests. `make test-live-providers` in Nexus
then includes every generation row and declared reasoning effort from the shared
LLM matrix in the pinned `provider-runtime` source revision. It unsets
`LLM_RUNTIME_LIVE_PROVIDERS` before entering provider-runtime, so a local or CI
environment cannot pass by running a subset. With the current supplied env, the
pinned provider-runtime matrix passes for OpenAI, Anthropic, Gemini, OpenRouter,
Cloudflare, embeddings, and OpenAI transcription. Nexus-owned non-LLM media
live proofs are outside the shared runtime boundary. CI runs those live-provider
checks only when the required secrets are present; otherwise it records that the
run is not live-provider proof instead of failing unrelated protected merges.

## Key Decisions

- Package name is `provider_runtime`; `llm-calling` is a source repo, not the
  steady-state package name.
- The existing `/home/niels/src/personal/llm-calling` repo is the implementation
  home for `provider_runtime`; do not create a new repo for the first build.
- First app port is Nexus; additional consumer ports are deferred.
- First provider scope is OpenAI Responses, Anthropic Messages, Gemini,
  OpenRouter, Cloudflare/OpenAI-compatible, and embeddings.
- Pydantic AI direct model APIs are not part of the current production
  substrate. Treat them only as a future, separate fidelity spike that must
  prove exact replay/streaming/usage artifacts before any adoption.
- Keep raw HTTP/provider adapters when higher-level libraries cannot preserve
  exact reasoning artifacts, streaming terminal details, request IDs, or usage.
- Treat LiteLLM as a later optional gateway/control-plane candidate, not the
  first hard-cutover provider substrate for Nexus chat loops.
- Treat OpenRouter as a first-class provider route, not the only abstraction.
- Treat Cloudflare as a first-scope OpenAI-compatible route for chat/embeddings.
- Keep product lifecycle in consuming apps; share provider mechanics only.
- Keep provider artifacts opaque. Exact replay is a provider-runtime concern;
  durable retention is app-owned and opt-in.
- Keep retry at one layer per call. SDK retries are disabled unless explicitly
  delegated.
- Keep response caching separate from prompt-prefix cache optimization.
- Defer live-provider execution until the user provides provider keys/env after
  implementation and review.
- Prefer live-provider contract tests over confidence based on provider docs.

## External References To Verify During Build

- Pydantic AI direct model/provider APIs and provider/profile split:
  `https://pydantic.dev/docs/ai/models/overview/`
- LiteLLM routing, budgets, proxy, and cache features:
  `https://docs.litellm.ai/docs/routing`
- OpenAI prompt caching and Responses reasoning/tool continuation:
  `https://developers.openai.com/api/docs/guides/prompt-caching`
  `https://developers.openai.com/api/docs/guides/reasoning`
- Anthropic prompt caching and extended thinking:
  `https://platform.claude.com/docs/en/build-with-claude/prompt-caching`
  `https://platform.claude.com/docs/en/build-with-claude/extended-thinking`
- Gemini thinking/thought signatures:
  `https://ai.google.dev/gemini-api/docs/thinking`
- OpenRouter prompt caching, reasoning, and routing controls:
  `https://openrouter.ai/docs/guides/best-practices/prompt-caching`
- Vercel AI SDK provider/gateway shape:
  `https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway`

## Open Questions

- If a future SDK/Pydantic adapter replaces a raw route, what tests prove its
  retries are disabled or explicitly delegated so `provider_runtime` remains
  the single retry owner?
- Should model prices live in the shared package catalog, Nexus DB rows, or a
  generated synced artifact?
- Should prompt cache namespace include user/conversation scope by default, or
  only when cacheable blocks contain non-global prompt material?
- How should OpenRouter provider-specific routing, `session_id`, and provider
  preferences compose with Nexus BYOK/platform key modes?
- Which additional raw adapters are required after live-provider artifact proof
  for OpenAI, Anthropic, Gemini, OpenRouter, and Cloudflare?
