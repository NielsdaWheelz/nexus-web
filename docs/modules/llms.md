# LLMs

## Scope

This module owns the LLM substrate every generation in Nexus runs on: the
`provider_runtime` provider client, the model catalog, the per-provider key spine, the
call ledger, the worker task envelope, and the structured-synthesis scaffold. It
is the mechanics layer the five generation surfaces share. The surfaces
themselves — chat, oracle, library intelligence, media units, metadata
enrichment — own their prompts, schemas, semantic validation, and finalization
writes; this module owns only what is genuinely identical across them.

Backend owners: `python/nexus/tasks/llm_task.py`,
`python/nexus/services/llm_ledger.py`, `python/nexus/services/structured_synthesis.py`,
`python/nexus/llm_catalog.py`, `python/nexus/db/retries.py`, and the external
`provider_runtime` package. Key resolution and entitlements live in
[byok.md](byok.md); the worker envelope's queue side lives in [jobs.md](jobs.md).

## `provider_runtime` (external provider client)

`provider_runtime` is an owner-controlled dependency pinned to an immutable
`NielsdaWheelz/llm-calling` git revision. It is the only code that speaks
provider wire protocols. Nexus stays provider-blind: it picks a provider name,
model, key mode, and reasoning level, hands over a key, and reads back typed
results.

- **Providers:** `openai`, `anthropic`, `gemini`, `openrouter`, `cloudflare`.
- **`ModelRuntime.generate(call, *, key, timeout_s)`** — one non-streamed call
  returning a `ModelResponse`.
  **`ModelRuntime.stream(call, *, key, timeout_s)`** — the same, yielding
  `ModelChunk`s with a terminal `done` chunk carrying usage.
  **`ModelRuntime.embed(call, *, key, timeout_s)`** handles OpenAI-compatible
  embeddings. **`ModelRuntime.transcribe(call, *, key, timeout_s)`** handles
  OpenAI transcription routes exposed by the shared package. Nexus does not yet
  route podcast Deepgram or YouTube transcript acquisition through that API
  because those non-LLM media ports carry modality-specific semantics.
  **`ModelRuntime.probe_key(provider=..., key=...)`** runs the
  shared catalog's key-probe model. **`ModelRuntime.capabilities(ModelRef(...))`**
  reads the shared per-model capability catalog. The runtime is constructed with
  `enable_*` provider flags and optional provider base URLs; only enabled
  providers are reachable.
- **Reasoning continuity (opaque provider items).** Providers emit
  reasoning/thinking artifacts (openai reasoning items, anthropic thinking
  blocks, gemini `thoughtSignature`) that must be replayed verbatim on the
  continuation request after a tool call, or the provider rejects the turn. Three
  carriers move these through unchanged: `ModelChunk.provider_artifact` (one per
  streamed reasoning fragment), `ModelResponse.provider_artifacts` for
  non-streamed calls, and `ModelMessage.provider_artifacts` (the assistant turn's
  captured items, in order). Tool calls carry public call ids only; provider
  reasoning/signature payloads stay in `ProviderArtifact`. They are **opaque**:
  nexus never
  parses, transforms, logs the content of, or persists them — it captures them
  from the stream, holds them in memory for the live tool loop, replays them on
  the next request, and drops them. A worker retry re-executes from scratch, so
  no persistence is needed. The single nexus consumption site is the chat tool
  loop (`chat_runs.py`), which collects each iteration's `provider_artifact`s and
  rebuilds the assistant `ModelMessage` with them; gemini thought-summary text is
  stripped inside `provider_runtime` and never reaches `delta` events.
- **`ModelCallErrorCode`** is the closed provider-error vocabulary:
  `INVALID_KEY`, `RATE_LIMIT`, `CONTEXT_TOO_LARGE`, `TIMEOUT`, `PROVIDER_DOWN`,
  `BAD_REQUEST`, `MODEL_NOT_AVAILABLE`, `QUOTA_EXCEEDED`, and
  `TOOL_ARGUMENTS_INVALID`. The runtime classifies provider HTTP errors and
  transport failures, and provider adapters fail closed on malformed response
  payloads that would otherwise be silently coerced. Provider errors carry
  status code, retry-after, provider request id, and retryability when
  available. Nexus maps these to its own codes
  through `api_error_code_for_model_call` (`errors.py`), backed by
  `LLM_ERROR_CODE_TO_API_ERROR_CODE`; unknown shared-runtime error codes map
  fail-closed to `E_LLM_PROVIDER_DOWN` if shared-runtime and app versions drift.
- **Retries are provider-runtime owned.** `ModelCall.retry` /
  `EmbeddingCall.retry` specify bounded retry policy. The runtime retries
  classified retryable failures before any response escapes; streams retry only
  before the first visible delta/tool/provider artifact. Application job retries
  still own durable idempotency and re-execution semantics. `ModelResponse`,
  terminal stream chunks, embedding responses, key probes, and `ModelCallError`
  carry bounded `RetryAttempt` metadata so Nexus can persist attempt counts and
  terminal attempt status without owning provider retry policy.

### OpenAI strict schemas

OpenAI-compatible strict schema rules apply to `openai`, `openrouter`, and
`cloudflare` model calls for strict tools and strict structured output. The
runtime normalizes schemas before provider I/O, and call-site authors should
treat the normalized shape as the contract:

- the root must be an object;
- every object schema is sealed with `additionalProperties: false`;
- every property listed under `properties` is also listed under `required`;
- optional fields are represented as required fields whose schema permits
  `null` (`type: ["string", "null"]`, an `anyOf` branch with `{"type":"null"}`,
  etc.), not by omitting the key.

Schemas with map-like `additionalProperties` objects,
`additionalProperties: true`, `patternProperties`, root `anyOf`, tuple-style
array items, or unsupported composition cannot be strictified and fail closed as
provider-runtime `BAD_REQUEST` before provider I/O. Do not add per-surface
OpenAI workarounds in Nexus; fix the shared schema or the `provider_runtime`
normalizer so chat tools and structured-output surfaces stay on the same
contract.

## Model catalog

`provider_runtime.catalog.DEFAULT_CATALOG` is the source of truth for per-model
capabilities: reasoning modes, prompt-cache support, context/output windows,
structured output, tool support, key-probe models, usage fields, and advisory
pricing slots. Catalog price rows include provider/source provenance and only
populate rates that can be represented honestly. Tiered provider pricing uses
fail-closed thresholds, so calls outside the represented range record
`cost_status='missing_pricing'` instead of an under-estimated total. The cost
policy and persisted ledger fields are wired; live provider proof remains the
external gate.
`llm_catalog.py` is Nexus's app overlay for display names, model tier, ordering,
DB availability rows, and key-mode availability.

`/models` is a browser contract derived from that overlay plus the shared
catalog. It intentionally exposes a UI-safe projection: ordered display rows,
available key modes, reasoning modes, max context, and chat-relevant capability
booleans. Internal provider-runtime fields such as routes, retry classes,
timeouts, pricing provenance, usage-provenance flags, and opaque artifact
support remain backend-owned.

- **`MODEL_CATALOG`** — a tuple of Nexus display overlay entries (provider,
  model name, display name, tier). Its `reasoning_modes` and max context
  properties are derived from `provider_runtime.catalog.DEFAULT_CATALOG`. Every
  shared catalog entry includes `"default"` (the runtime-owned safe default for
  that model; some providers omit the field, while others receive an explicit
  low-cost/visible-output setting).
- **Prompt-cache support** is shared-runtime capability data. OpenAI is
  `keyed_ttl`, Anthropic is `turn_ttl`, and Gemini/OpenRouter/Cloudflare are
  currently `none`; cache intent for unsupported providers is stripped inside
  `provider_runtime.lowering`, not in Nexus services.
- **`require_catalog_model(provider, model_name)`** — returns the entry or raises
  a defect. Every generation surface pins its model through this, so a
  code/catalog mismatch is caught at import/test time, not at request time.
- **`key_test_model(provider)`** delegates to the shared catalog key-probe model,
  used by the key probe ([byok.md](byok.md)).

## The ledger (`llm_calls`)

`services/llm_ledger.py` is the **sole writer** of the `llm_calls` table and the
one emitter of `llm.request.*` telemetry. It is the flight recorder the June-7
incident lacked: one row per ledgered generation call, on every terminal path.

- **`observed_generate` / `observed_generate_stream`** wrap the two router call
  shapes. Each emits `llm.request.started` then exactly one of
  `llm.request.finished` / `llm.request.failed` (one shared field schema), and
  records exactly one `llm_calls` row — on **success and on failure**, including
  repair and tool-loop iterations. For streams the row is written when the
  terminal `done` chunk is observed (before it is yielded, so a consumer that
  stops there still leaves a row), else when the stream raises or ends without a
  terminal chunk. Consumers that intentionally stop before the terminal chunk
  call `aclose()` / `record_abandoned()` before their terminal commit; chat
  cancellation records `E_CANCELLED`. The row is `flush`ed into the caller's
  transaction, not committed (run_kit doctrine), so a boundary exception still
  leaves it when the run finalizer commits the same transaction.
- **`LedgeredLLM`** is the `generate`-only seam bound to one owner that
  `run_structured_synthesis` calls, so a repaired synthesis ledgers one row per
  attempt.
- **`LlmCallOwner`** attributes each call to a run parent by `kind`:
  `chat_run`, `oracle_reading`, `li_revision`, `media_summary`,
  `media_enrichment`. `call_seq` is a per-owner ordinal (`MAX(call_seq)+1`),
  so a chat run with N tool iterations leaves rows `1..N`, a repaired synthesis
  leaves two rows, and metadata enrichment leaves one row for its configured
  provider attempt.
- The row captures provider, provider route, model, `llm_operation`, streaming
  flag, reasoning effort, requested vs used key mode, per-token usage columns,
  latency, `error_class` + truncated `error_detail` on failure, the provider
  request id, attempt count, retry count, terminal attempt status, the bounded
  provider attempt trace, the raw `provider_usage` JSON, advisory cost status,
  integer USD-micros cost components/totals, and a `pricing_snapshot` copied
  from `provider_runtime.catalog.Pricing`. It is operator-queryable only; there
  is no product surface ([deployment.md](../../deployment.md) has the query
  recipe).
- `provider_attempts` is the redacted provider-diagnostic trail. Each attempt may
  include `status_code`, retryability, retry-after/delay, provider request id,
  streamed-output-started, and `safe_body_snippet`. The snippet is a bounded,
  secret-redacted structured provider-error summary when the provider returned
  one; arbitrary raw text bodies are intentionally not persisted. Treat snippets
  as operator-only diagnostics for provider 400s and schema rejections, never
  render them to users or copy raw provider request/response bodies into product
  logs.
- Explicit exceptions: saved-key probes emit the shared `llm.request.*` telemetry
  but write no `llm_calls` row because there is no run owner; transcript
  embeddings call `provider_runtime.embed()` directly and are not yet ledgered
  because they are indexing infrastructure rather than generation-owner calls.

The run-parent **error floor** is separate from the ledger:
`run_kit.mark_terminal(..., error_code, error_detail)` is the sole writer of the
`error_code`/`error_detail` pair on every run parent (and sets `failed_at` on
oracle readings to satisfy the CHECK). `error_detail` is the sanitized
`type(exc).__name__: message` plus provider request id when the runtime exposes
one — operator-facing, never rendered. Chat's `ERROR_CODE_TO_MESSAGE` is the only
backend code→user-copy map (it writes assistant content); other surfaces own
their failure copy on the frontend.

## The worker envelope (`run_llm_task`)

`tasks/llm_task.py` is the one envelope every LLM task body runs inside, and the
only constructor of event loops, `httpx.AsyncClient`s, and `ModelRuntime`s under
`nexus/tasks/` (AC-4, "one envelope").

- **`run_llm_task(spec, handler, *, on_worker_exception=None)`** owns the
  mechanics each task used to hand-copy: one DB session, one fresh event loop,
  one `httpx.AsyncClient` (per-kind timeout and pool limits), one `ModelRuntime`
  construction **including the real-media fixture swap for every kind**, the
  worker exception boundary (logs `{label}_failed_unexpected` and delegates to
  `on_worker_exception`, which stores a safe terminal failure; without one the
  exception propagates to the queue's retry policy), and teardown
  (`loop.close()`, `db.close()`).
- **`LlmTaskSpec(label, http_timeout_s, http_limits)`** is the per-kind policy.
  Chat uses `(100, 20)` pool limits; library intelligence uses a 120s timeout;
  the rest take the defaults. The handler receives the shared client so chat can
  build its web-search provider without a second client.
- The five task modules (`chat_run`, `oracle_reading`, `library_intelligence`,
  `media_unit_build`, `enrich_metadata`) are now thin: parse payload →
  `run_llm_task(SPEC, handler, ...)`. The fixture router serving all kinds means
  fixture-mode oracle/LI/unit runs never touch real providers.
- The process-global rate limiter is installed **once at worker startup**
  (`apps/worker/main.py`, the same construction as the API lifespan), not
  per-task, so the first job of any kind has a working limiter. Budget and
  inflight policy is applied uniformly across surfaces, including background ones
  ([byok.md](byok.md)).

## Structured-synthesis scaffold

`services/structured_synthesis.py` owns the generic mechanics of a
*structured synthesis* — an `llm.generate` call whose response text is strict
JSON validated into a caller schema. Oracle, the LI reduce, and the media-unit
build share it; each keeps its own prompt text, candidate rendering, schema, and
semantic judgement.

- **`build_synthesis_prompt(persona, preamble, domain_rules, json_shape)`** —
  the shared system prompt: persona + optional preamble + a numbered `RULES.`
  block closed by the strict-JSON output rule. The shared index-grounding wording
  is `INDEX_GROUNDING_RULE`; call sites that ground by index pass it as their
  first domain rule.
- **`build_synthesis_request(...)`** — the shared two-turn request (cached system
  turn + candidates user turn closed by the strict-JSON instruction),
  `reasoning_effort="none"`.
- **`ground_indices(entries, candidates, *, index_of, policy)`** — THE grounding
  invariant: a model-emitted integer index must denote an offered candidate
  (`0 <= index < len`). `"reject"` discards the whole output (oracle), `"drop"`
  skips the offending entry (LI, unit). Phase cover, ordinal dedupe, role
  coercion, and dense reordinaling stay caller-side.
- **`run_structured_synthesis(*, llm, request, schema, validate=None)`** — issues
  the call, parses the strict JSON, validates into the schema, runs the caller's
  optional semantic `validate` hook, and on the first failure re-issues **one**
  bounded repair round (appending the bad output and the rejection reason) before
  raising `StructuredSynthesisError`. `SynthesisResult` carries the validated
  value, summed usage across attempts, and the attempt count (1 or 2) for the
  ledger. `ModelCallError` propagates unchanged from either attempt so the caller
  keeps its per-code mapping — provider failures are never repaired.

## The five call sites + the key probe

All generation surfaces resolve keys through `resolve_api_key`
([byok.md](byok.md)) and pin models through `require_catalog_model`:

| Surface | Owner | `llm_operation` | Ledger owner kind |
|---|---|---|---|
| Chat | `services/chat_runs.py` | `chat_send` | `chat_run` |
| Oracle reading | `services/oracle.py` | `oracle_reading` | `oracle_reading` |
| LI reduce | `services/library_intelligence_reduce.py` | `li_reduce` | `li_revision` |
| Media unit | `services/media_intelligence.py` | `media_unit` | `media_summary` |
| Metadata enrichment | `tasks/enrich_metadata.py` | `metadata_enrichment` | `media_enrichment` |

Chat streams (the tool loop, with reasoning continuity); the other four are
single non-streamed structured calls. Metadata enrichment keeps its own
provider-native structured-output spec and configured provider/model selection —
it adopts the envelope, key spine, ledger, catalog, and catalog-derived
structured-output reasoning mode, but not the synthesis scaffold. The
`user_keys.test_user_key` probe ([byok.md](byok.md)) emits the same
`llm.request.*` telemetry but does **not** write a ledger row.

## Invariants

- **Every provider call is observable.** No `generate`/`stream` call outside
  `observed_generate`/`observed_generate_stream` (or `LedgeredLLM`).
- **Opaque means opaque.** Provider items are captured, replayed verbatim,
  dropped — never parsed, persisted, or logged with content.
- **Harness owns mechanics, surfaces own domain.** Prompts, schemas, semantic
  validation, and finalization writes stay per-surface.
- **One key spine** (`resolve_api_key`), **one model catalog**
  (`require_catalog_model`), **one ledger writer** (`llm_ledger`), **one
  worker envelope** (`run_llm_task`), **one error-pair writer**
  (`run_kit.mark_terminal`).

These are enforced by the hard-cutover negative gates in
`python/tests/test_cutover_negative_gates.py`.
