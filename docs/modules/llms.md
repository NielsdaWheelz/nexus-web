# LLMs

## Scope

This module owns the LLM substrate every generation in Nexus runs on: the
`llm-calling` provider client, the model catalog, the per-provider key spine, the
call ledger, the worker task envelope, and the structured-synthesis scaffold. It
is the mechanics layer the five generation surfaces share. The surfaces
themselves — chat, oracle, library intelligence, media units, metadata
enrichment — own their prompts, schemas, semantic validation, and finalization
writes; this module owns only what is genuinely identical across them.

Backend owners: `python/nexus/tasks/llm_task.py`,
`python/nexus/services/llm_ledger.py`, `python/nexus/services/structured_synthesis.py`,
`python/nexus/llm_catalog.py`, `python/nexus/db/retries.py`, and the external
`llm-calling` package. Key resolution and entitlements live in
[byok.md](byok.md); the worker envelope's queue side lives in [jobs.md](jobs.md).

## `llm-calling` (external provider client)

`llm-calling` is an owner-controlled git dependency, pinned by rev in
`python/pyproject.toml` and locked in `uv.lock`; the two repos move in lockstep.
It is the only code that speaks provider wire protocols. Nexus stays
provider-blind: it picks a provider name and model, hands over a key, and reads
back typed results.

- **Providers:** `openai`, `anthropic`, `gemini`, `deepseek`.
- **`LLMRouter.generate(provider, request, api_key, *, timeout_s)`** — one
  non-streamed call returning an `LLMResponse`.
  **`LLMRouter.generate_stream(...)`** — the same, yielding `LLMChunk`s with a
  terminal `done` chunk carrying usage. The router is constructed with the four
  `enable_*` provider flags; only enabled providers are reachable.
- **Reasoning continuity (opaque provider items).** Providers emit
  reasoning/thinking artifacts (openai reasoning items, anthropic thinking
  blocks, gemini `thoughtSignature`) that must be replayed verbatim on the
  continuation request after a tool call, or the provider rejects the turn. Three
  carriers move these through unchanged: `LLMChunk.provider_item` (one per
  streamed reasoning fragment), `Turn.provider_items` (the assistant turn's
  captured items, in order), and `ToolCall.provider_metadata` (e.g. gemini's
  signature, openai's function-call item id). They are **opaque**: nexus never
  parses, transforms, logs the content of, or persists them — it captures them
  from the stream, holds them in memory for the live tool loop, replays them on
  the next request, and drops them. A worker retry re-executes from scratch, so
  no persistence is needed. The single nexus consumption site is the chat tool
  loop (`chat_runs.py`), which collects each iteration's `provider_item`s and
  rebuilds the assistant `Turn` with them; gemini thought-summary text is
  stripped inside `llm-calling` and never reaches `delta` events.
- **`LLMErrorCode`** is the closed provider-error vocabulary: `INVALID_KEY`,
  `RATE_LIMIT`, `CONTEXT_TOO_LARGE`, `TIMEOUT`, `PROVIDER_DOWN`, `BAD_REQUEST`,
  `MODEL_NOT_AVAILABLE`, `QUOTA_EXCEEDED`. The router's outermost catch widens to
  `httpx.HTTPError`, `httpx.StreamError`, `TypeError`, and `AttributeError` →
  `PROVIDER_DOWN`, so no transport or payload exception escapes unclassified into
  a nexus `E_INTERNAL`. Nexus maps these to its own codes through
  `LLM_ERROR_CODE_TO_API_ERROR_CODE` (`errors.py`), which includes
  `QUOTA_EXCEEDED → E_LLM_QUOTA_EXCEEDED`.

## Model catalog

`llm_catalog.py` is the single source of truth for which provider/model pairs
exist and what each supports.

- **`MODEL_CATALOG`** — a tuple of `ModelCatalogEntry` (provider, model name,
  display name, tier, `reasoning_modes`, max context). Every entry's
  `reasoning_modes` includes `"default"` (the honest "provider default" mode;
  `llm-calling` maps `"default"` to omitting the field for all providers). This
  is what makes a default-reasoning send valid for every model, not just the
  OpenAI tier.
- **`require_catalog_model(provider, model_name)`** — returns the entry or raises
  a defect. Every generation surface pins its model through this, so a
  code/catalog mismatch is caught at import/test time, not at request time.
- **`KEY_TEST_MODELS`** — the cheapest model per provider, used by the key probe
  ([byok.md](byok.md)) and as the catalog-valid floor for enrichment defaults.

## The ledger (`llm_calls`)

`services/llm_ledger.py` is the **sole writer** of the `llm_calls` table and the
one emitter of `llm.request.*` telemetry. It is the flight recorder the June-7
incident lacked: one row per provider call, on every terminal path.

- **`observed_generate` / `observed_generate_stream`** wrap the two router call
  shapes. Each emits `llm.request.started` then exactly one of
  `llm.request.finished` / `llm.request.failed` (one shared field schema), and
  records exactly one `llm_calls` row — on **success and on failure**, including
  repair and tool-loop iterations. For streams the row is written when the
  terminal `done` chunk is observed (before it is yielded, so a consumer that
  stops there still leaves a row), else when the stream raises or ends without a
  terminal chunk. The row is `flush`ed into the caller's transaction, not
  committed (run_kit doctrine), so a boundary exception still leaves it.
- **`LedgeredLLM`** is the `generate`-only seam bound to one owner that
  `run_structured_synthesis` calls, so a repaired synthesis ledgers one row per
  attempt.
- **`LlmCallOwner`** attributes each call to a run parent by `kind`:
  `chat_run`, `oracle_reading`, `li_revision`, `media_summary`,
  `media_enrichment`. `call_seq` is a per-owner ordinal (`MAX(call_seq)+1`),
  so a chat run with N tool iterations leaves rows `1..N`, a repaired synthesis
  leaves two rows, and enrichment failover attempts each get a row.
- The row captures provider, model, `llm_operation`, streaming flag, reasoning
  effort, requested vs used key mode, per-token usage columns, latency,
  `error_class` + truncated `error_detail` on failure, the provider request id,
  and the raw `provider_usage` JSON. It is operator-queryable only; there is no
  product surface ([deployment.md](../../deployment.md) has the query recipe).

The run-parent **error floor** is separate from the ledger:
`run_kit.mark_terminal(..., error_code, error_detail)` is the sole writer of the
`error_code`/`error_detail` pair on every run parent (and sets `failed_at` on
oracle readings to satisfy the CHECK). `error_detail` is the sanitized
`type(exc).__name__: message` plus provider request id — operator-facing, never
rendered. Chat's `ERROR_CODE_TO_MESSAGE` is the only backend code→user-copy map
(it writes assistant content); other surfaces own their failure copy on the
frontend.

## The worker envelope (`run_llm_task`)

`tasks/llm_task.py` is the one envelope every LLM task body runs inside, and the
only constructor of event loops, `httpx.AsyncClient`s, and `LLMRouter`s under
`nexus/tasks/` (AC-4, "one envelope").

- **`run_llm_task(spec, handler, *, on_worker_exception=None)`** owns the
  mechanics each task used to hand-copy: one DB session, one fresh event loop,
  one `httpx.AsyncClient` (per-kind timeout and pool limits), one router
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
  ledger. `LLMError` propagates unchanged from either attempt so the caller keeps
  its per-code mapping — provider failures are never repaired.

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
provider-native structured-output spec and multi-provider failover transport — it
adopts the envelope, key spine, ledger, and catalog, but not the synthesis
scaffold. The `user_keys.test_user_key` probe ([byok.md](byok.md)) emits the same
`llm.request.*` telemetry but does **not** write a ledger row.

## Invariants

- **Every provider call is observable.** No `generate`/`generate_stream` call
  outside `observed_generate`/`observed_generate_stream` (or `LedgeredLLM`).
- **Opaque means opaque.** Provider items are captured, replayed verbatim,
  dropped — never parsed, persisted, or logged with content.
- **Harness owns mechanics, surfaces own domain.** Prompts, schemas, semantic
  validation, and finalization writes stay per-surface.
- **One key spine** (`resolve_api_key`), **one model catalog**
  (`require_catalog_model`), **one ledger writer** (`llm_ledger`), **one
  worker envelope** (`run_llm_task`), **one error-pair writer**
  (`run_kit.mark_terminal`).

These are enforced by the §14 negative gates in
`python/tests/test_cutover_negative_gates.py`.
