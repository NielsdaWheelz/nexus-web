# LLMs

## Scope

This module owns the single LLM generation boundary in Nexus: the external
`provider_runtime` package, the product profile registry (`llm_profiles.py`),
platform credentials (`llm_credentials.py`), the sole execution/ledger
boundary (`llm_execution.py` + `llm_ledger.py`), the worker task envelope
(`tasks/llm_task.py`), the structured-synthesis scaffold, and the chat
failure/rerun projection. The generation surfaces — chat, oracle, synapse,
dawn write, artifact revisions (conversation distillate, library dossier),
media summary, metadata enrichment — own their own prompts, schemas, semantic
validation, and finalization writes; this module owns only what is identical
across them.

There is no BYOK, no per-user key, no model catalog UI, and no key-mode. Every
generation call runs on a platform key against one of seven code-defined
product profiles.

Backend owners: `python/nexus/services/llm_profiles.py`,
`llm_credentials.py`, `llm_execution.py`, `llm_ledger.py`, `chat_failure.py`,
`chat_reruns.py`, `structured_synthesis.py`, `python/nexus/schemas/llm.py`,
`python/nexus/api/routes/llm_profiles.py`, `python/nexus/tasks/llm_task.py`,
and the external `provider_runtime` package pinned in `python/pyproject.toml`.
The worker envelope's queue side lives in [jobs.md](jobs.md).

## `provider_runtime` (external provider package)

`provider_runtime` is an owner-controlled dependency pinned to an immutable
git revision (`python/pyproject.toml`); `make test-live-providers` checks that
the local `LLM_CALLING_DIR` checkout matches the pin before running the paid
live matrix, and fails if it drifts. It is the only code that speaks provider
wire protocols; Nexus stays provider-blind past `ProviderTarget(provider,
model)`.

- **Public surface** (`provider_runtime.__all__`): `types` (frozen value
  vocabulary — intents, outcomes, stream events, plans), `schema` (the
  canonical JSON-Schema subset — parse/validate/serialize, never rewrites),
  `catalog` (`CATALOG` — exact provider contracts: limits, reasoning levels,
  cache mechanism, integer usd-micro pricing, privacy, certification),
  `errors` (`RuntimeDefect` hierarchy: `PlanningDefect`, `ProtocolDefect`,
  `CredentialRejected`, `SchemaViolation` — defects raise, they are never a
  returned value), `planning` (`plan_generate`: intent →
  `FinalizedProviderCall | PlanRejected`; cache affinity; retry-policy
  constants), `transport` (auth-header injection + HTTP + timeouts + raw SSE
  framing — parses/classifies nothing), `runtime` (`ProviderRuntime`:
  `generate`/`stream` — the sole same-target retry owner — plus `embed`/
  `transcribe` as non-generation ports), `usage` (`cost_from_accounting` over
  the plan's frozen `Accounting`), and `testing` (`NoNetworkRuntime`/
  `ScriptedRuntime` test doubles for the package's own `ProviderRuntime`
  interface).
- **Codecs** (`openai`, `anthropic`, `gemini`, `moonshot`, `openrouter`) and
  private helpers (`_chat_completions_wire`, `_signals`, `embeddings`) are
  implementation details reached only through the planner and the runtime;
  they are deliberately not re-exported.
- **Data flow:** `GenerateIntent -> plan_generate(CATALOG) ->
  FinalizedProviderCall -> ProviderRuntime.generate/stream -> CallOutcome /
  RuntimeStreamEvent`. `FinalizedProviderCall` is the one immutable input to
  transport and to the ledger's accounting/fingerprint facts — no second
  lowering exists.
- There is no dynamic control plane, no BYOK, no fallback, no sampling knobs,
  no response cache, and no JSON repair. See the package's own `README.md`
  (sibling `llm-calling-runtime` repo) for the cache-affinity formula, the
  canonical JSON-Schema subset, and the paid certification matrix; this doc
  covers only the Nexus integration layer below.

## Product profiles (`llm_profiles.py`)

`provider_runtime.CATALOG` owns exact model contracts. `llm_profiles.py` owns
only product labels, display order, operation eligibility, and the mapping
from a profile to its certified runtime target.

```text
LlmProfile {
  id, label, description, provider_label, model_label
  target: ProviderTarget
  reasoning_options: tuple[ReasoningOption]   # ReasoningOption{id, label}
  default_reasoning_option_id
  privacy_notice
}
```

`PROFILES` is a fixed tuple of exactly seven entries, in display order:

| id | label | target | reasoning options | default | privacy |
|---|---|---|---|---|---|
| `fast` | Fast · Luna | `openai/gpt-5.6-luna` | none,low,medium,high,xhigh,max | low | standard |
| `balanced` | Balanced · Terra | `openai/gpt-5.6-terra` | same GPT-5.6 set | medium | standard |
| `deep` | Deep · Sol | `openai/gpt-5.6-sol` | same GPT-5.6 set | high | standard |
| `claude` | Claude · Sonnet 5 | `anthropic/claude-sonnet-5` | low,medium,high,xhigh,max | medium | standard |
| `fable` | Claude · Fable 5 | `anthropic/claude-fable-5` | low,medium,high,xhigh,max | high | Fable 30-day-retention notice |
| `gemini` | Gemini · 3.5 Flash | `gemini/gemini-3.5-flash` | minimal,low,medium,high | medium | standard |
| `kimi` | Kimi · K3 | `moonshot/kimi-k3` | low,high,max | high | standard |

`DEFAULT_PROFILE_ID = "balanced"`. There is no OpenRouter product profile: no
`PROFILES` entry targets `provider="openrouter"`. `provider_runtime.CATALOG`
does carry a hidden OpenRouter Kimi K3 operator row
(`ProviderTarget(provider="openrouter", model="moonshotai/kimi-k3-20260715")`),
but its certification is `OperatorUncertified`, not `DirectCertification`.
`validate_profiles()` requires `DirectCertification` for every profile
target, so that row can never enter the product portfolio by construction —
it is purely a catalog fact, invisible to `/llm-profiles` and unreachable from
any Nexus credential/execution path today.

**Background operation → profile policy** (`OPERATION_PROFILES`, total —
`operation_profile()` asserts on any gap):

| Operation | Profile |
|---|---|
| `oracle`, `conversation_distillate`, `media_summary`, `metadata_enrichment`, `synapse` | `fast` |
| `library_dossier`, `dawn_write` | `balanced` |
| `chat` (`LlmOperation` adds this one) | user-selected `profile_id` |

No generation owner contains a raw provider/model/route/reasoning literal.
`validate_profiles()` runs at app and worker startup (and in a unit test): it
checks `DEFAULT_PROFILE_ID` and every `OPERATION_PROFILES` value resolve, that
every profile's target is `DirectCertification`-certified, that its offered
reasoning options are a subset of what the catalog contract supports, and that
its default reasoning option is among its own offered options.

## Platform credentials (`llm_credentials.py`)

The sole platform-key reader. No BYOK, no DB lookup, no encryption — reads
straight off `Settings`:

```python
generation_credential(settings, provider) -> ProviderCredential
embedding_credential(settings, provider) -> ProviderCredential
transcription_credential(settings, provider) -> ProviderCredential
```

All three delegate to one internal `_platform_credential`, keyed by
`ProviderName` to a `Settings` attribute (`openai_api_key`,
`anthropic_api_key`, `gemini_api_key`, `moonshot_api_key`; `openrouter` is
mapped too, but since no profile ever targets `openrouter` this branch is
never reached in product code). A missing key at call time raises
`RuntimeDefect` — never an empty credential — because key *presence* is
enforced earlier, at startup, by `config.py`'s `validate_required_settings`:
staging/prod require `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
and `MOONSHOT_API_KEY`, plus an RFC 3339 `NEXUS_FABLE_RETENTION_ACCEPTED_AT`
deployment assertion (Fable requires 30-day retention and is not
ZDR-eligible; this records informed operator acceptance, not a toggle).
`OPENROUTER_API_KEY` is not part of the deployed app's required settings —
it belongs only to the separate paid certification command run against the
`provider_runtime` package.

## The generation boundary (`llm_execution.py`)

`execute_generation` / `execute_generation_stream` are the only Nexus callers
of the `ExecutionRuntime` seam and of `llm_ledger`. Every owner (chat, oracle,
synapse, dawn write, artifact revisions, media summary/enrichment) builds one
`GenerationRequest` per provider call and calls one of these two functions;
neither ever appears twice for one call.

```text
GenerationRequest { owner: LlmCallOwner, operation: LlmOperation,
                     profile: LlmProfile, reasoning: ReasoningLevel,
                     intent: GenerateIntent }
```

`__post_init__` raises `PlanningDefect` if `intent.target`/`intent.reasoning`
disagree with `profile`/`reasoning` — a broken owner invariant caught before
any ledger row exists.

Execution order, every ledger mutation in its own dedicated, immediately
committed session from `session_factory` (never a shared transaction spanning
a provider dispatch):

1. Entitlement check (`billing_entitlements.can_use_platform_llm`) — before
   any `llm_calls` row. Denial raises `ApiError(E_BILLING_REQUIRED)` with no
   row at all.
2. Allocate the generation id + INSERT the `llm_calls` start row
   (`llm_ledger.start_call`), committed.
3. `plan_generate(intent)`. `PlanRejected` (oversize intent) terminalizes
   `{origin="intent", code="context_too_large"}` and returns a synthesized
   `Failed` outcome — no dispatch attempted. A raised `PlanningDefect`/
   `RuntimeDefect` terminalizes with its own origin/code and re-raises.
4. `reserve_token_budget(generation_id, plan.accounting.
   platform_token_reservation)` — denial terminalizes `{origin="budget",
   code=...}` (`budget_exceeded`, `rate_limiter_unavailable`,
   `billing_required`, or a generic `reservation_denied`) and re-raises.
   Success precedes `commit_plan_facts`, committed.
5. Dispatch `runtime.generate`/`runtime.stream` with the resolved platform
   `generation_credential`.
6. Terminalize from the outcome (`llm_ledger.terminalize`), committed before
   any owner-side postprocessing.
7. Settle the reservation exactly once — release on `NotDispatched`/
   `ConfirmedNonBillable`, commit actual usage when reported, else
   conservatively commit the full reservation. A `finally` block guarantees
   settlement on any exit past step 4, so nothing is ever left to limiter TTL
   expiry.
8. One structured log at terminalize (inside `llm_ledger`).

`ExecutionRuntime` is a `Protocol` (`generate`/`stream` over
`intent, plan, credential`). `ProductionExecutionRuntime` delegates to
`provider_runtime.ProviderRuntime`, ignoring `intent` (the finalized `plan` is
authoritative for dispatch); a real-media fixture
(`services/real_media_fixture_llm.RealMediaFixtureExecutionRuntime`) scripts
outcomes from `intent` instead. `tasks/llm_task.py` is the sole place that
chooses between them, keyed solely on `settings.real_media_provider_fixtures`
— there are no per-provider enable flags. The return type
(`CallOutcome{generation_id, outcome, support_id}`) exposes the generation id
only at the terminal; there is no pre-dispatch handle.

## The ledger (`llm_calls`, `llm_ledger.py`)

`services/llm_ledger.py` is the sole writer of `llm_calls`. Three helpers,
each opening its own dedicated, immediately committed session:

- **`start_call(session_factory, *, owner, operation, profile, streaming)`**
  — allocates the generation id and a per-owner `call_seq`
  (`MAX(call_seq)+1`), INSERTs the row (`cost_status="missing_usage"`
  initially), commits — before any provider dispatch.
- **`commit_plan_facts(session_factory, *, generation_id, profile, plan)`** —
  UPDATEs provider/model/reasoning/`catalog_revision`/`request_fingerprint`/
  cache strategy+ttl/`pricing_snapshot`, committed once the token-budget
  reservation has already succeeded.
- **`terminalize(session_factory, *, generation_id, outcome, accounting,
  latency_ms)`** — maps a real `ProviderCallOutcome` (`Succeeded` / `Refused`
  / `Incomplete` / `Cancelled` / `Failed`) to `(outcome, error_origin,
  error_code, error_detail)`, prices usage via `cost_from_accounting` when
  both usage and accounting are present, records the attempt trace, commits,
  and logs the one structured terminal event.
- **`terminalize_defect(session_factory, *, generation_id, origin, code,
  detail)`** — for a pre-dispatch or dispatch-boundary defect (never called
  for entitlement/budget denial, which has no row at all); always yields a
  `support_id`.

`LlmCallOwner{kind, id, user_id}` attributes a call to its run parent.
`kind` is a closed set of **seven** literals matching the `llm_calls`
`ck_llm_calls_owner_kind` check: `chat_run`, `oracle_reading`,
`artifact_revision`, `media_summary`, `media_enrichment`, `synapse_scan`,
`dawn_write`. `user_id` is the billing-scoped account `llm_execution` checks
entitlements/reserves budget against — distinct from `id`, the owning row's
own id.

The row (`db/models.py: LLMCall`) captures: `provider`, `upstream_provider`
(the transport target when routed), `model_name`, `llm_operation`,
`streaming`, `reasoning_effort`, per-token usage columns (input/output/
total/reasoning/cache-write/cache-read/cached), `latency_ms`, `outcome`,
`catalog_revision`, `request_fingerprint`, `cache_strategy`/`cache_ttl`,
`error_origin`/`error_code`/`error_detail`, `provider_request_id`, integer
usd-micro cost components/totals + `cost_status`, `pricing_snapshot`
(a copy of the plan's `Accounting`), `attempt_count`/`retry_count`/
`terminal_attempt_status`, the redacted `provider_attempts` trail, raw
`provider_usage` JSON, and `created_at`. It is operator-queryable only; there
is no product surface.

## The worker envelope (`run_llm_task`)

`tasks/llm_task.py` is the one envelope every LLM task body runs inside, and
the only constructor of event loops, `httpx.AsyncClient`s, and
`ExecutionRuntime`s under `nexus/tasks/`.

- **`run_llm_task(spec, handler, *, on_worker_exception=None)`** owns: one DB
  session, one fresh event loop, one `httpx.AsyncClient` (per-kind timeout and
  pool limits), one `ExecutionRuntime` construction (production or real-media
  fixture, keyed solely on `settings.real_media_provider_fixtures`), the
  worker exception boundary (logs `{label}_failed_unexpected` and delegates to
  `on_worker_exception`, which stores a safe terminal failure; without one the
  exception propagates to the queue's retry policy), and teardown
  (`loop.close()`, `db.close()`). The handler owns everything domain-specific:
  payload semantics, the `execute_generation`/`execute_generation_stream`
  call, and finalization.
- **`LlmTaskSpec(label, http_timeout_s=60.0, http_limits=(10,5))`** is the
  per-kind policy. Chat uses `(100, 20)` pool limits; library intelligence
  (the artifact-revision reducer) uses a 120s timeout; the rest take the
  defaults. The handler receives the shared client so chat can build its
  web-search provider without a second client.
- Seven task modules call it: `chat_run`, `oracle_reading`, `synapse_scan`,
  `dawn_write`, `artifacts` (the generic revision engine — covers both
  `conversation_distillate` and `library_dossier`), `media_unit_build`, and
  `enrich_metadata`. Each is thin: parse payload → `run_llm_task(SPEC,
  handler, on_worker_exception=...)`. The fixture router serving all kinds
  means fixture-mode runs never touch real providers.
- The process-global rate limiter is installed once at worker startup
  (`apps/worker/main.py`, the same construction as the API lifespan), so the
  first job of any kind has a working limiter.

## Structured-synthesis scaffold (`structured_synthesis.py`)

A *structured synthesis* is an `execute_generation` call whose response is
strict JSON validated into a caller-supplied schema. The generic mechanics
live here once; Oracle, Synapse, media intelligence, and the artifact-revision
reducers each keep their own prompt text, candidate rendering, schema, and
semantic judgement, and each still owns its own `GenerationRequest`/
`execute_generation` call — this module never calls `execute_generation`
itself.

- **`build_synthesis_prompt(persona, preamble, domain_rules, json_shape)`** —
  the shared system prompt: persona + optional preamble + a numbered `RULES.`
  block closed by the strict-JSON output rule. `INDEX_GROUNDING_RULE` is the
  shared index-grounding wording for call sites that ground by index.
- **`build_synthesis_intent(...)`** — the shared two-block `GenerateIntent`
  shape: a `Stable(GlobalScope())` system block (the assembled prompt) plus a
  `Dynamic` user block (caller-rendered candidates/instruction), with
  `output=StrictJsonOutput` derived from the caller's schema via the
  canonical-subset parser. The caller wraps this in one `GenerationRequest`.
- **`ground_indices(entries, candidates, *, index_of, policy)`** — the
  grounding invariant: a model-emitted integer index must denote an offered
  candidate. `"reject"` discards the whole output (Oracle), `"drop"` skips
  the offending entry.
- **`decode_structured_synthesis(...)`** — validates a `Succeeded` outcome's
  strict-JSON payload into the caller's schema and runs its optional semantic
  `validate` hook. There is no repair round: the runtime enforces strict JSON
  at the provider boundary, so a decode/schema/semantic failure here is
  terminal (`StructuredSynthesisError`), and the caller maps it to its own
  domain failure code.

## Chat failure projection + rerun

`schemas/llm.py` defines the closed, discriminated `ExpectedChatFailure`
union (`Field(discriminator="code")`) — ten variants, each fixing its own
valid `origin` Literal(s) (matching the runtime's closed origin union) and
carrying `support_id: Presence[str]` + `can_rerun: bool`; the four transient
variants additionally carry `attempts: int`:

| code | origin(s) | attempts |
|---|---|---|
| `refused` | `provider_http`, `provider_stream` | — |
| `incomplete` | `provider_response` | — |
| `cancelled` | (none — run status alone drives it) | — |
| `context_too_large` | `intent`, `provider_http` | — |
| `invalid_tool_arguments` | `tool_arguments` | — |
| `budget_exceeded` | `budget` | — |
| `rate_limited` | `provider_http` | yes |
| `timeout` | `transport` | yes |
| `provider_unavailable` | `provider_http`, `transport` | yes |
| `stream_interrupted` | `provider_stream` | yes |

`services/chat_failure.py:chat_failure_projection(run, *,
has_write_tool_attempt, attempts=None)` is the single owner of this
projection. It reads purely from already-stored `ChatRun.error_code`/
`error_origin`/`status` facts (written by `llm_ledger.terminalize`'s outcome
mapping) — never a heuristic. `has_write_tool_attempt` and `attempts` are not
`ChatRun` columns; the caller supplies them via
`compute_has_write_tool_attempt` (an `EXISTS` over `message_tool_calls`/
`chat_run_events` for any write-tool attempt, reverted or not) and
`compute_terminal_attempts` (the run's terminal `llm_calls.attempt_count`). A
terminal state this projection cannot represent (unrecognized code, an origin
outside a code's valid set, a transient code missing `attempts`) degrades to
`failure=None` — the generic non-rerunnable card — plus a loud operator log,
never a 500. `ChatRunOut`, message hydration, terminal SSE, reconnect
folding, and the trust trail all derive the same projection; none stores or
synthesizes a second failure.

**Rerun eligibility** (`rerun_eligibility`, the one policy function):

- Never rerunnable: `refused`, `budget_exceeded`, `context_too_large`.
- Conditionally rerunnable: `incomplete`, `cancelled`, `invalid_tool_arguments`,
  and the four transient codes — `true` only while `profile_selection_active`
  (the exact profile id + reasoning option still resolve, and any recorded
  resolved-target snapshot still matches) and no write-tool attempt was made.

`services/chat_reruns.py:rerun_assistant_response` is the single owner of
`POST /messages/{assistant_message_id}/rerun`. Under the normal idempotency
key, it re-evaluates `rerun_eligibility` against freshly queried facts (an
earlier read's `can_rerun` is never authority for the mutation), plus a
defense-in-depth check comparing the source run's terminal `llm_calls`
`(provider, model_name)` against what the *current* profile now resolves to
(catching drift a run with no resolved-target snapshot could otherwise miss).
On success it creates a new user/assistant message pair and a new `ChatRun`
carrying forward the source run's `profile_id`/`reasoning_option_id`, and
enqueues a fresh `chat_run` job. There is no separate retry/resend pair.

## API surface

- **`GET /llm-profiles`** (`api/routes/llm_profiles.py`) — a thin adapter:
  the entire response is `LlmProfilesOut.from_profiles()` over `PROFILES`/
  `DEFAULT_PROFILE_ID`. Identical for every viewer (auth-required, no
  per-user filtering). The browser owns no provider/model/reasoning enum,
  ordering, default, capability, key, or availability policy.
- **`POST /chat-runs`** accepts `profile_id` + `reasoning_option_id` (not a
  raw `model_id`/provider/`reasoning`/`key_mode`). Resolved
  provider/model_name/reasoning_effort are snapshotted onto `ChatRun` at
  execution as trust-trail facts, never selection controls.
- **`POST /messages/{assistant_message_id}/rerun`** — the sole recovery
  route; see above.

## Invariants

- **One generation boundary.** No LLM provider SDK/HTTP call exists outside
  `provider_runtime`; no Nexus generation-runtime call exists outside
  `llm_execution`.
- **One profile registry**, code-defined, startup-validated; no generation
  owner contains a raw provider/model/route/reasoning literal.
- **One ledger writer** (`llm_ledger`), **one worker envelope**
  (`run_llm_task`), **one platform-credential reader** (`llm_credentials`),
  **one failure projection + one rerun route** (`chat_failure` /
  `chat_reruns`).
- **Platform keys only.** No BYOK, no per-user key, no key-mode.

These are enforced by the hard-cutover negative gates in
`python/tests/test_cutover_negative_gates.py` (for example
`test_no_raw_provider_key_reads_outside_key_spine`,
`test_no_direct_provider_sdk_imports_in_nexus`,
`test_no_event_loop_construction_under_tasks_except_llm_task`, and
`test_message_llm_absent_from_production`).
