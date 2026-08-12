# LLMs

## Scope

This module owns Nexus's direct-provider generation boundary: product profiles,
platform credentials, durable execution and admission, normalized outcomes and
the `llm_calls` ledger. Prompt and domain owners build and validate their own
content, schemas, tools, and final writes; the existing Postgres job queue,
leases, and durable step journal remain their owners.

`provider_runtime` is the immutable external direct-API dependency pinned in
`python/pyproject.toml`. `ProviderRuntime` owns registry resolution, canonical
provider endpoints, credentials selection, provider transport, retries,
normalized outcomes, and provider telemetry. Nexus never plans a wire request,
rewrites an endpoint, or implements provider retries.

There is no BYOK, per-user key, model-browser UI, gateway route, fallback, or
availability intersection. This boundary excludes `metadata_enrichment`.

Backend owners: `llm_profiles.py`, `llm_credentials.py`, `llm_execution.py`,
`llm_intent_state.py`, `llm_outcomes.py`, `llm_ledger.py`,
`tasks/llm_task.py`, `schemas/llm.py`, and `api/routes/llm_profiles.py`. Queue
ownership is documented in [jobs.md](jobs.md).

## Product profiles (`llm_profiles.py`)

`llm_profiles.py` owns labels, order, defaults, privacy copy, and background
operation-to-profile policy. `provider_runtime.registry` owns model facts:
limits, capabilities, reasoning fragments, continuation codec, and registry
revision. A product profile never duplicates provider facts.

`PROFILES` is this fixed nine-row order; `balanced` is the default:

| id | label | target | reasoning options | default |
|---|---|---|---|---|
| `fast` | Fast · Luna | `openai/gpt-5.6-luna` | none, low, medium, high, xhigh, max | low |
| `balanced` | Balanced · Terra | `openai/gpt-5.6-terra` | none, low, medium, high, xhigh, max | medium |
| `deep` | Deep · Sol | `openai/gpt-5.6-sol` | none, low, medium, high, xhigh, max | high |
| `claude` | Claude · Sonnet 5 | `anthropic/claude-sonnet-5` | low, medium, high, xhigh, max | medium |
| `fable` | Claude · Fable 5 | `anthropic/claude-fable-5` | low, medium, high, xhigh, max | high |
| `gemini` | Gemini · 3.5 Flash | `gemini/gemini-3.5-flash` | minimal, low, medium, high | medium |
| `kimi` | Kimi · K3 | `moonshot/kimi-k3` | low, high, max | high |
| `deepseek-flash` | DeepSeek · V4 Flash | `deepseek/deepseek-v4-flash` | none, high, max | high |
| `deepseek-pro` | DeepSeek · V4 Pro | `deepseek/deepseek-v4-pro` | none, high, max | high |

The existing picker renders these data rows without a provider branch. Selecting
a profile resets effort to its listed default. DeepSeek uses `StandardPrivacy`
with the direct-operator notice. Missing provider credentials do not hide a
profile or reroute a call; required staging/production credentials fail startup.

`validate_profiles()` runs at API and worker startup. Every profile and
background mapping must resolve through `provider_runtime.registry`, support
text, tools, streaming, strict structured output, and a continuation codec,
and exactly match its advertised reasoning options and default.

`OPERATION_PROFILES` maps direct operations only: Oracle, Media Summary, and
Synapse use `fast`; Dossier page, note, and idea-resolve use `fast`; other
Dossier bindings and Dawn Write use `balanced`. Chat is user-selected. Kimi and
both DeepSeek profiles are chat choices only.

## Credentials and runtime composition

`provider_credentials(settings)` is the one direct-generation credential
constructor. It supplies exactly five platform credentials: OpenAI, Anthropic,
Gemini, Moonshot, and DeepSeek. The runtime chooses the applicable key.
`embedding_credential(settings)` remains the narrow OpenAI embedding port.
Transcription is not an LLM runtime capability; Deepgram remains its separate
owner.

`ExecutionRuntime` is the structural test seam. Production composition returns
`ProviderRuntime` directly from `build_execution_runtime(settings, client)`.
API dependencies and `run_llm_task` share that composition; no wrapper or
generation-time credential map exists.

The only retry modes are:

| Mode | Owner behavior |
|---|---|
| `Default` | `ProviderRuntime` applies its provider retry policy. |
| `SingleAttempt` | `ProviderRuntime` receives one zero-delay attempt; it never retries or resumes a stream after a semantic event. |

Every composition uses `Default` except durable `BilledOnce` work: `chat_run`,
`dossier_build`, `media_unit_build`, and the API-owned Idea resolver use
`SingleAttempt`. Nexus selects the mode; `ProviderRuntime` implements it.

## Native subscription metadata

`metadata_enrichment` is not a direct-provider operation. Its sole route is the
private `nexus-codex-agent-host` over a Unix socket, through the pinned public
`AgentRuntime` with `CredentialRef(local_account, codex-personal)`,
`gpt-5.6-luna`, and low reasoning. The durable metadata owner snapshots its
request, records `agent_turns`, and owns prepared/completed/uncertain replay;
`llm_calls`, direct credentials, provider retry, admission, and price facts do
not participate.

The host has no API key, TCP listener, database credentials, MCP, web search,
writable workspace, or approval path. The operation sets Codex
`builtin_tools="disabled"`; any residual tool-use or permission-request event
is a closed policy failure. A terminal stores the opaque session reference,
usage, SDK/runtime versions, and bounded diagnostics. The ChatGPT-authenticated
profile state is private to the host; re-enrollment, not credential export, is
the recovery path.

## Durable intent, execution, and admission

`GenerateIntentState` in `llm_intent_state.py` is the only persisted
generation-intent representation. It round-trips text prompt blocks, plain
JSON-schema tools and strict output, and continuation target/codec/opaque
payload. Provider wire requests and cache plans are never durable product state.

`GenerationRequest` carries the owner's replay-stable generation UUID and
validates the selected profile target and reasoning,
text-only input, no provider options, no tools with strict JSON, positive and
row-capped output, and the conservative context bound. Admission reserves:

```text
utf8_bytes(GenerateIntentState.model_dump_json()) + max_output_tokens
```

This is deterministic quota admission, not tokenization or a cost estimate.

`execute_generation` and `execute_generation_stream` are the only Nexus
generation boundary. Their order is: validate; check entitlement; atomically
insert-or-reuse the pre-dispatch ledger row and reserve admission under the
owner lock; commit a durable owner's uncertain checkpoint where it has one;
dispatch; atomically terminalize and settle exactly once. A concurrent replay
of the same UUID can neither add a ledger row nor recreate a settled
reservation.
Expected outcomes pass through after recording. Trusted impossible states record
a safe defect terminal and raise. The existing queue, leases, and step journal
continue to own durable orchestration.

## Outcomes, ledger, and migration

`llm_outcomes.py` is the exhaustive mapping from `ProviderRuntime` terminals
to Nexus failure facts. Refused, incomplete, context-too-large, invalid tool
arguments, invalid structured output, exhausted rate limit/timeout/unavailable,
and stream interruption have one normalized origin/code; success and
cancellation carry no error facts. `estimate_cost(CallMeta)` runs only after a
terminal: absent usage is `missing_usage`, present usage without pricing is
`missing_pricing`, and otherwise the row records the estimate and provenance.

`llm_ledger.py` is the sole writer of `llm_calls` and the transaction owner for
ledger plus token-budget state. It commits one requested profile row before
dispatch and terminal facts afterward: runtime target,
native reasoning, registry revision, normalized usage, attempt trace, outcome,
and cost provenance. It is the audit boundary; it has no product API.

Migration `0215_llm_provider_runtime.py` is the irreversible v2 hard cut. It
adds requested/native reasoning, registry revision, and cost provenance; removes
retired plan, cache, pricing-snapshot, raw-usage, and component-cost facts; and
rewrites prompt manifests without retired cache or reasoning-reserve fields.
Old durable chat intent payloads are unreadable: migration first refuses live
or suspended chat coordination, preserves durable domain data, and deletes only
succeeded `chat_run` queue coordination rows. It retains the existing Postgres
queue for all v2 work.

## API and failure projection

`GET /llm-profiles` returns the fixed profile tuple for every authenticated
viewer. Chat create/send keeps `profile_id` and `reasoning_option_id` as the
only selection inputs. SSE, reconnect, cancellation, failure cards, and trust
trail shapes are unchanged.

`chat_failure.py` projects stored normalized terminal facts into the closed
chat-failure union. `chat_run_candidates.py` owns rerun and regenerate sibling
construction. Neither recreates provider policy or invents a second failure
record.

## Invariants

- Product profile is policy; registry row is provider fact; `ProviderRuntime`
  is mechanism.
- One runtime owns retries, one durable boundary executes a generation, and one
  ledger writes its audit facts.
- Missing credentials, usage, pricing, or capability is explicit and never a
  fallback.
- Direct API execution and native subscription execution are different systems.
- The repository has one v2 direct-provider path for non-metadata operations
  and one exact native subscription metadata route.
