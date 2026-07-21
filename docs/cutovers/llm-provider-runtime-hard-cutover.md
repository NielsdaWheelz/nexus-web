# LLM Provider Runtime Hard Cutover

**Status:** SPECIFICATION · 2026-07-20
**Open design questions:** none
**Cutover prerequisites:** explicit Fable 30-day-retention acceptance and paid
OpenRouter pinned-endpoint cache certification
**Type:** hard cutover — one branch, no legacy API, compatibility shim, silent
fallback, dual read/write path, or old model lane.

This is the sole cutover contract for `provider_runtime` and Nexus LLM
execution. It replaces the previous contents of this file. It preserves the
durable run and streaming contracts owned by
[`generation-run-harness-hard-cutover.md`](generation-run-harness-hard-cutover.md),
[`sota-chat-streaming-hard-cutover.md`](sota-chat-streaming-hard-cutover.md), and
[`chat-subsystem-consolidation-hard-cutover.md`](chat-subsystem-consolidation-hard-cutover.md).

## 1. North star

Nexus expresses a product profile and prompt intent. The shared runtime turns
that intent into one immutable, provider-native request. The exact same plan
drives transport, retry, accounting, and diagnostics. Provider mechanics do not
control Nexus behavior outside the profile registry and operational ledger.

Target behavior:

- Chat offers one profile picker and one reasoning picker; no provider or key
  picker.
- Every offered profile independently supports the real Nexus system prompt,
  all tools, streaming, continuation, strict structured output, and prompt
  caching.
- Direct OpenAI, Anthropic, Gemini, and Moonshot/Kimi routes are primary.
- OpenRouter is a certified operator route, never a user-visible duplicate or
  automatic fallback.
- Sampling is provider-default and not a product setting.
- A failure is attributed to the layer that detected it. Local defects are not
  mislabeled as provider rejection or outage.
- A failed assistant turn retains valid partial model text and renders exactly
  one failure card with at most one context-correct action. A Fable refusal is
  the sole exception: Anthropic declares its partial output incomplete, so the
  terminal fold discards it.
- Every generation attempt gets an id and committed ledger row before planning,
  then exactly one durable terminal outcome.

## 2. 80/20 boundary

### In scope

- `provider_runtime` generation types, catalog, planner, codecs, transport,
  retries, usage, errors, and live certification.
- Nexus product profiles, platform credentials, execution/ledger boundary,
  chat request API, run persistence, failure UX, and all current generation
  owners.
- Direct GPT-5.6 Luna/Terra/Sol, Claude Sonnet 5/Fable 5, Gemini 3.5 Flash,
  Kimi K3, one constrained OpenRouter route, and every supported reasoning
  level listed in §4.
- Provider-native prompt-prefix caching for every active generation profile.
- Removal of stale models, Cloudflare LLM support, BYOK, duplicate catalogs,
  duplicate rerun paths, and broad error prose.

### Must remain

- Durable `ChatRun`, worker-owned execution, persisted run events, reconnectable
  SSE, cancellation, tool execution, citations, trust trails, and app
  idempotency.
- Surface-owned prompt assembly, domain validation, result persistence, and
  output schemas.
- `llm_calls` as Nexus's operator flight recorder and cost ledger.
- Direct OpenAI embedding and transcription contracts. Prompt caching does not
  apply to these non-generation operations.
- The monthly platform token cap and shared billing/entitlement services.
- Non-LLM provider ports such as Deepgram, Brave, YouTube, and Podcast Index.

### Non-goals

- No dynamic router, model marketplace, automatic optimizer, provider fallback,
  multi-tenant policy engine, or provider health control plane.
- No OpenRouter response cache; chat outputs and tool calls are not reusable
  application responses.
- No provider-stored conversation cursor (`previous_response_id`, Gemini
  stateful interactions, or equivalent).
- No unified wire protocol. OpenAI Responses, Anthropic Messages, Gemini
  `generateContent`, and Moonshot/OpenRouter Chat Completions remain distinct.
- No chat transport, event grammar, tool, citation, retrieval, or prompt rewrite.
- No generalized sampling controls, reasoning token budgets, schema repair, or
  malformed-tool-argument repair.
- No production hotfix lane. The cutover itself is the fix.

## 3. Verified problems and consolidation targets

| Current fact | Final owner/action |
|---|---|
| `ModelCall.prompt_cache_key` is hidden `init=False` state; cache lowering injects it, then schema normalization reconstructs the call and loses it | Delete hidden state and `lowering.py`; construct one complete finalized plan |
| Nexus and the ledger can lower the same request again | Only `ProviderPlanner` finalizes; transport and ledger consume its plan facts |
| Chat hard-codes `temperature=0.7`; Kimi and Sonnet 5 reject or constrain sampling | Remove sampling from Nexus and public runtime intent; omit native fields |
| `max` is rewritten to OpenAI `xhigh`; `xhigh` is absent from the shared type | Preserve exact, per-model reasoning levels |
| OpenRouter inherits a provider-branching generic OpenAI-compatible client and can silently route/fallback | Dedicated codec; one pinned upstream; fallbacks off |
| Unsupported cache controls and schema keywords can be stripped | Validate once and fail before network; never weaken intent |
| `tool_schema.py` force-adds required fields and nullable unions; Gemini strips schema keywords | Replace mutation with one validated canonical schema type; migrate every schema author before deleting the normalizer |
| Runtime catalog, Nexus `llm_catalog.py`, DB `models`, Pydantic, DB checks, and TypeScript repeat provider/model/reasoning truth | Runtime contract + Nexus profile registry only |
| DB `models` cost/context fields have no live owner; UUIDs exist chiefly to select/join chat | Snapshot exact resolved facts on runs; drop `models` |
| BYOK/key-mode/provider-enable policy spans API, DB, services, config, and UI | Platform credentials only; drop the entire BYOK/key-mode lane |
| Background model literals are spread across Oracle, artifacts, media, Synapse, Dawn, and enrichment | One operation-to-profile policy registry |
| Backend failure prose, `MessageRow`, `services/conversations.py`, global feedback copy, and retry/resend paths disagree | Run-owned structured failure + one exhaustive mapper/card + one rerun route |
| Dawn Write can return after a failed call without committing its ledger row | `llm_execution` owns durable start and terminalization for every call |

## 4. Final product portfolio

`provider_runtime.catalog` owns exact model contracts. Nexus
`llm_profiles.py` owns only product labels, ordering, operation eligibility, and
the mapping to a certified runtime target. Profiles are validated at startup.

| Profile id | Display | Runtime target | Reasoning options | Default | Cache |
|---|---|---|---|---|---|
| `fast` | Fast · Luna | `openai/gpt-5.6-luna` | `none, low, medium, high, xhigh, max` | `low` | OpenAI explicit prefix, 30m |
| `balanced` | Balanced · Terra | `openai/gpt-5.6-terra` | `none, low, medium, high, xhigh, max` | `medium` | OpenAI explicit prefix, 30m |
| `deep` | Deep · Sol | `openai/gpt-5.6-sol` | `none, low, medium, high, xhigh, max` | `high` | OpenAI explicit prefix, 30m |
| `claude` | Claude · Sonnet 5 | `anthropic/claude-sonnet-5` | `low, medium, high, xhigh, max` | `medium` | Anthropic explicit stable prefix, 5m |
| `fable` | Claude · Fable 5 | `anthropic/claude-fable-5` | `low, medium, high, xhigh, max` | `high` | Anthropic explicit stable prefix, 5m |
| `gemini` | Gemini · 3.5 Flash | `gemini/gemini-3.5-flash` | `minimal, low, medium, high` | `medium` | Gemini implicit prefix |
| `kimi` | Kimi · K3 | `moonshot/kimi-k3` | `low, high, max` | `high` | Moonshot automatic prefix |

Rules:

- `balanced` is the default chat profile.
- Every reasoning option is explicit. Provider defaults are catalog facts, not
  selectable product behavior.
- Claude Haiku, Opus, Gemini previews, old GPT/Claude/Kimi rows, Cloudflare, and
  duplicate OpenRouter model rows are removed. Luna already covers the cheap
  tier; another adapter mode is not worth its verification surface.
- Final deployed API and worker startup require `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `MOONSHOT_API_KEY`. Missing or
  malformed platform configuration is a startup error; it never changes the
  product portfolio. `OPENROUTER_API_KEY` is required only by the separate
  operator certification command because no product owner routes through it.
- Final cutover also requires an explicit RFC 3339 deployment assertion in
  `NEXUS_FABLE_RETENTION_ACCEPTED_AT`. Fable requires 30-day retention and is
  not ZDR-eligible. This records informed acceptance; it is not an availability
  toggle, and Nexus does not build a content classifier.
- OpenRouter has one hidden `moonshotai/kimi-k3` operator candidate, pinned to
  endpoint `moonshotai/int4`; the catalog records canonical revision
  `moonshotai/kimi-k3-20260715`. It is absent from `/llm-profiles` and cannot be
  selected by chat. It becomes a usable operator target only after the release
  certification proves `low | high | max`, the pinned upstream, and a billed
  cache read. Current endpoint metadata does not claim implicit caching, so a
  successful ordinary call is not certification.
- Kimi K3's `low | high | max` effort contract is too recent to treat as a
  static remembered fact. Every release certification rechecks the official
  source and paid direct/OpenRouter wire behavior; drift fails the cutover.

Background policy:

| Operation | Profile |
|---|---|
| Oracle, conversation distillate, media summary, metadata enrichment, Synapse | `fast` |
| Library dossier, Dawn Write | `balanced` |
| Chat | user-selected active profile |

No generation owner contains a raw provider, model, route, or reasoning literal.

## 5. Capability contract

Use separate `ChatModelContract`, `EmbeddingContract`, and
`TranscriptionContract` types. Do not model unrelated modalities as a boolean
soup.

Every `ChatModelContract` guarantees the Nexus baseline:

- streamed final text;
- `auto | none` tool choice and stateless tool continuation;
- strict JSON output for non-tool calls;
- a declared prompt-cache strategy;
- normalized token/cache/reasoning usage and request correlation;
- a closed continuation codec and provider-response decoder.

`FinalizedProviderRequest` replaces only the runtime input. The built
`ModelStreamEvent` output union remains authoritative: typed text, tool,
continuation-artifact, usage, and terminal events. A modeled stream has exactly
one terminal event. A defect is not a terminal variant: it interrupts the
stream and is re-raised/reported by the generation-run harness. This supersedes
any reading of the streaming cutover that converts a defect into
`ModelCallError`.

It declares only model-varying facts:

```text
ChatModelContract {
  target: ProviderTarget
  protocol: openai_responses | anthropic_messages |
            gemini_generate_content | moonshot_chat | openrouter_chat
  context_limit, output_limit
  reasoning: {levels, provider_default, native_mapping}
  cache: CacheContract
  continuation_codec
  strict_schema_dialect
  privacy: {retention, zdr_eligible}
  pricing, source_urls, verified_at, certification
}
```

Rules:

- A model missing any baseline capability is not a chat model and cannot enter a
  profile.
- Tools plus strict structured output in one request are rejected. Nexus does
  not need that cross-product.
- `CanonicalTool.parameters` and `StrictJsonOutput.schema` accept only a
  validated `CanonicalJsonSchema`; arbitrary dictionaries cannot reach a
  codec.
- Catalog construction rejects duplicate targets, duplicate profile mappings,
  unsupported reasoning mappings, unpriced selectable routes, and stale source
  verification.

### Canonical JSON Schema subset

`CanonicalJsonSchema` uses JSON Schema 2020-12 meanings but admits only this
closed structural subset:

- the document root is an object schema and may contain one root `$defs` map;
- an object node has `type="object"`, finite `properties`, `required` equal to
  exactly every property name, and `additionalProperties=false`;
- an array node has `type="array"` and one homogeneous `items` schema;
- a scalar node has `type="string" | "number" | "integer" | "boolean"` and
  may have one non-empty, type-compatible `enum`; `{"type":"null"}` is the
  null node;
- a semantically optional value is still a required object property and is
  expressed only as `anyOf: [NonNullNode, {"type":"null"}]`; no other union
  is valid;
- `title` and `description` are the only annotations; `$ref` may target only an
  acyclic `#/$defs/<name>` definition and may have no siblings.

Everything else is rejected: omitted object fields, `nullable`, defaults,
open or schema-valued `additionalProperties`, tuple arrays, external or
recursive references, arbitrary `anyOf`, `oneOf`, `allOf`, `not`, conditional
schemas, `patternProperties`, formats, patterns, length/range/count
constraints, and unknown/provider keywords. Rich value constraints remain in
the surface's domain validator after decode and before persistence or a tool
side effect.

`schema.py` owns a pure parser/validator and immutable schema value. It never
rewrites trusted input. A codec may inline local definitions, omit annotations,
or translate the nullable union into exactly equivalent native syntax; it may
not add required/nullability, drop a validating keyword, or repair output. An
invalid authored schema is a startup/planning defect. A target unable to encode
the subset exactly cannot certify.

## 6. Finalized provider request

The public generation input is immutable and provider-neutral:

```text
GenerateIntent {
  target: ProviderTarget
  messages: tuple<PromptMessage>
  max_output_tokens
  reasoning: ReasoningLevel
  cache: RequiredCache
  tools: tuple<CanonicalTool>
  tool_choice: auto | none
  output: TextOutput | StrictJsonOutput
}
```

`PromptMessage` marks content as `dynamic | stable(CacheScope)`; stable content
must form one contiguous prefix. The Nexus prompt assembler supplies semantic
order and the privacy scope of each stable block. The planner validates that
order and encodes it without moving system instructions, context, history, or
the current turn. Nexus supplies no affinity hash, retry policy, TTL, provider
cache key, native reasoning object, or request-body extras.

The sole planner performs, in order:

1. require the exact catalog contract;
2. validate the complete intent and capability cross-product;
3. compile the canonical tool/schema subset;
4. encode messages and same-target continuation artifacts;
5. resolve provider-native reasoning and cache controls;
6. construct and fingerprint the final native body;
7. freeze wire, retry, cache, reasoning, and accounting facts in one
   `FinalizedProviderCall`.

```text
FinalizedProviderCall {
  request: FinalizedProviderRequest
  accounting: {currency, input_rate, output_rate, cache_write_rate,
               cache_read_rate, platform_token_reservation,
               maximum_cost_estimate_usd_micros}
  requested_reasoning, effective_reasoning, native_reasoning
  cache_plan, retry_policy
  catalog_revision, request_fingerprint, tool_fingerprint, schema_fingerprint
}

FinalizedProviderRequest {
  target, protocol, url, method
  safe_headers, body
}
```

Credentials remain outside the plan. A provider transport accepts only its own
finalized request plus an opaque credential. Transport owns auth, HTTP,
timeouts, and raw SSE framing only. Provider codecs alone parse success/error
envelopes into normalized events/signals. Neither layer may normalize, default,
strip, rebuild, or reinterpret intent. Derived fields are constructor fields,
never hidden mutation or `object.__setattr__` state.

The planner resolves `retry_policy` from the runtime's central external-service
policy catalog; callers cannot select or vary it.

`ContinuationArtifact(target, codec_id, opaque_payload)` replaces fragmented
artifact fields. It is ephemeral, never logged/rendered, and replayable only to
the identical provider/model/codec. A mismatch fails before network.

## 7. Provider codecs

| Codec | Required behavior |
|---|---|
| OpenAI Responses | Preserve `none` through `max`, including distinct `xhigh`; `store:false`; explicit prefix breakpoint + stable hashed `prompt_cache_key` + `prompt_cache_options.ttl=30m`; request `include:["reasoning.encrypted_content"]`; replay the entire ordered `response.output` sequence verbatim |
| Anthropic Messages | Omit sampling; explicit 5m breakpoint at the stable prefix, optionally plus top-level automatic caching for append-only chat; emit native effort; replay thinking/redacted blocks unchanged; Fable thinking is always on; HTTP-200 `stop_reason=refusal` is terminal `refused`, not provider failure, and invalidates any partial Fable output |
| Gemini `generateContent` | Stable `gemini-3.5-flash`; native `thinkingLevel`; implicit caching; preserve thought signatures for tool continuation |
| Moonshot Chat Completions | `reasoning_effort=low|high|max`; omit fixed sampling fields; use `max_completion_tokens`; replay the complete assistant message unchanged; rely on automatic context caching |
| OpenRouter Chat Completions | Dedicated `moonshotai/kimi-k3` contract; `provider.only=["moonshotai/int4"]`, `provider.order=["moonshotai/int4"]`, `allow_fallbacks=false`, `require_parameters=true`, `data_collection=deny`, `zdr=true`, hashed `session_id`; `reasoning:{effort,exclude:false}`; use routed `max_tokens`, not direct-only `max_completion_tokens`; send `X-OpenRouter-Cache: false` and `X-OpenRouter-Metadata: enabled`; preserve full `reasoning_details`; runtime `max_attempts=1` |

Moonshot and OpenRouter may share private, syntax-only Chat Completions wire
parsers. They do not inherit a generic provider-branching client.

## 8. Cache contract

`CachePlan` is a provider-tagged union, not a generic TTL field:

- `OpenAIExplicitPrefix(key, minimum_ttl="30m", breakpoints)`;
- `AnthropicPrefix(stable_breakpoint, ttl="5m", automatic_append_only)`;
- `ProviderAutomaticPrefix(provider="gemini" | "moonshot")`;
- `OpenRouterCertifiedPrefix(session_id, pinned_upstream, evidence_revision)`.

For OpenRouter, `evidence_revision` is the immutable id of the paid
certification artifact containing the endpoint-metadata snapshot, probe
generation ids, and observed cache usage. The planner rejects an absent or
non-matching revision.

`RequiredCache` has no off state. `CacheScope` is the closed union of `global`,
`owner(owner_id)`, and `conversation(conversation_id)`, ordered broadest to
narrowest. The assembler supplies already-authorized identities; a conversation
must belong to the stated owner, and incomparable/mismatched scopes are a
planning defect. The stable prefix must be non-empty. Its effective scope is the
narrowest contributing scope, and non-message cache inputs inherit that scope;
a cache can never be shared more broadly than any contributing block.

`OpaqueCacheAffinity` is private derived plan state, not public intent.
`planning.py` solely owns `CACHE_AFFINITY_VERSION = 1` and the binary
`frame(bytes) = uint64_be(length) || bytes` encoder. The planner computes:

```text
base64url(sha256(
  frame("nexus-cache-affinity") || frame(uint64_be(CACHE_AFFINITY_VERSION)) ||
  frame(scope-tag) || frame(scope-id-or-empty) || frame(exact-target) ||
  frame(protocol) || frame(canonical-cache-contract-bytes) ||
  frame(exact-provider-native-cache-affecting-prefix-bytes)
))
```

Literal/enum fields use UTF-8; scoped UUIDs use RFC 4122 network-order 16-byte
form; `global` uses an empty id. No locale, JSON serializer, or object ordering
participates in framing.
Cache-affecting bytes include the stable messages and any tools/output schema
that precede or participate in the provider's cache prefix. Byte-identical
scope, target, contract/version, and prefix produce the same affinity across
same-target retries, explicit reruns, workers, and deployments. Changing any
input produces a new affinity. Raw scope ids and prompt bytes never enter wire
metadata, logs, or the ledger. OpenAI uses the derived value as
`prompt_cache_key`; OpenRouter uses it as `session_id`; other plans retain it
only for fingerprint/telemetry and use their native prefix mechanism.
Canonical cache-contract bytes are the deterministic encoding of the closed
strategy and parameters. Any framing, scope, prefix-encoding, or cache-contract
semantic change must increment `CACHE_AFFINITY_VERSION` and update checked-in
cross-worker golden vectors; the old value is never recomputed under new rules.

Rules:

- Caching is required for every active generation profile and operator route.
- Unsupported cache intent is a planning defect. It is never silently removed.
- “Enabled” means the correct provider mechanism is present; it does not promise
  a hit below the provider's minimum prefix length.
- Gemini and Moonshot caching are implicit: the catalog declares that fact and
  live certification proves reported cache reads; there is no invented wire
  control. OpenAI's `30m` is a minimum lifetime, not exact or maximum retention.
- Live certification uses an above-minimum stable prefix twice and requires
  cache-read usage on the second call where the provider reports it.
- OpenRouter's pinned endpoint currently reports no implicit-cache capability.
  The operator route therefore remains uncertified and unusable until a paid
  repeated-prefix probe reports a non-zero billed cache read for that exact
  endpoint. No `session_id` inference or price-table entry substitutes for the
  measurement; failure blocks cutover or requires this specification to be
  revised explicitly.
- The ledger records effective strategy/TTL plus cache writes and reads. No
  response cache or application-level transcript cache is added.

## 9. Execution, failures, and retries

`python/nexus/services/llm_execution.py` is the only Nexus generation module
allowed to resolve a profile, acquire a generation credential, finalize a
request, dispatch the runtime, or terminalize an `llm_calls` row.
`llm_credentials.py` is the only platform-key loader. Embedding and
transcription owners may request their typed credential from it and call their
non-generation runtime port. `llm_ledger.py` remains the generation storage
helper. Domain services supply prompt intent and consume typed results.

Execution order:

```text
domain prompt -> profile resolution -> entitlement check
-> allocate generation id + commit ledger start -> finalized plan
-> reserve platform token budget + commit exact plan/accounting facts
-> provider runtime
-> durable ledger terminal -> domain result/failure finalization
```

The start row contains `{owner, operation, profile_id}`. After planning, one
commit adds the exact resolved target, frozen accounting rates, catalog
revision, fingerprint, and reservation. A planning failure terminalizes the
already-committed row without a provider request id. No provider call runs
inside a database transaction. Every start, plan, and terminal ledger mutation
uses a dedicated named ledger unit-of-work, never the surface owner's session
or transaction. The terminal ledger write commits before domain postprocessing
or owner-row creation. One generation attempt produces exactly one terminal
outcome.

The existing limiter reserves tokens, not money. Each codec computes
`planned_input_token_upper_bound` as the UTF-8 byte length of the exact
finalized native JSON body plus its contract's fixed provider-framing overhead.
That deliberately conservative count includes every message role/content
part, tool name/description/schema, strict output schema, and replay artifact;
auth/HTTP headers are excluded. Catalog certification proves the bound is not
below provider-reported input usage on the golden/live corpus.

The plan's `platform_token_reservation` is that input bound plus
`max_output_tokens`, plus a catalog-declared reasoning reserve only when that
provider bills reasoning outside the output limit. `reserve_token_budget` is
keyed by generation id. A no-dispatch terminal releases it; a response with
usage commits provider-reported total tokens and releases the excess; a
provider-confirmed non-billable response releases it. Once a request may be
billable, missing usage conservatively commits the full reservation. Reported
usage above the bound is committed in full and raises a catalog-invariant
alert. `maximum_cost_estimate_usd_micros` is derived telemetry only; it is not
a second quota or a dollar reservation.

The runtime emits one closed terminal outcome; every branch carries shared
`CallMeta {provider, model, provider_request_id: Presence, usage: Presence}`:

```text
CallOutcome = Succeeded(CallMeta) | Refused(CallMeta, safe_detail) |
              Incomplete(CallMeta, reason) | Cancelled(CallMeta) |
              Failed(CallMeta, ExpectedModelFailure)
```

Only the failed branch carries a closed tagged union:

```text
ExpectedModelFailure =
  IntentContextTooLarge {limit, measured}
  | ProviderContextTooLarge
  | InvalidToolArguments {safe_detail}
  | TransientExhausted {
      attempts,
      cause: ProviderRateLimit {retry_after: Presence}
             | ProviderTimeout
             | ProviderHttpUnavailable
             | TransportUnavailable
             | ProviderStreamInterrupted {partial_output: bool}
    }
```

Each leaf fixes its code/origin pair; callers cannot combine free enums.
Transient leaves map respectively to `provider_http/rate_limited`,
`transport/timeout`, `provider_http/provider_unavailable`,
`transport/provider_unavailable`, and
`provider_stream/stream_interrupted`.
Owned optional correlation uses `Presence`, never raw nullable state. The public
JSON boundary omits absent fields.

Streaming maps `Refused` to the existing `incomplete` terminal event with
`status="refused"`; it adds no fifth terminal tag. Non-streamed calls preserve
the distinct `Refused` outcome.

Raw retryable transport/provider signals are private to the runtime retry
boundary. `TransientExhausted` is the intentional terminal wrapper after that
boundary, not the original retry signal leaking through it. Chat models it as
an expected rerunnable outcome. A background owner must exhaustively map it to
its own explicit unavailable/requeue contract; it cannot relabel it as a local
defect or silently switch targets.
The LLM ledger uses the closed origin union `intent | plan | budget | transport
| provider_http | provider_stream | provider_response | tool_arguments` and
retains the exact classified code, request id, and support id. The owning run
extends origin with `tool | postprocess | worker`; a later owner failure does
not rewrite a successfully terminal LLM call. Provider bodies, prompts,
credentials, and hidden reasoning never enter errors or logs.

Rules:

- The detecting owner creates the failure. Mapping is exhaustive.
- Platform-token-reservation denial is the expected Nexus failure
  `{origin=budget, code=budget_exceeded, can_rerun=false}`. It terminalizes the
  started ledger/run before network; it is never an internal/provider error.
- Provider error type/code is parsed once at ingress. Each codec owns an exact,
  provider-contract retry classifier; a coarse HTTP status list never invents a
  domain error or retry decision.
- Invalid catalog, plan invariant, malformed provider protocol, unknown terminal
  provider response, platform credential rejection, unclassified exhaustion,
  and impossible state are defects. The worker boundary reports/re-raises the
  defect and records its exact origin/code/trace operator-side; it does not turn
  it into `provider_unavailable` or `bad_request`.
- Delete `E_LLM_BAD_REQUEST` and every broad “request rejected by the model
  provider” mapping.
- The runtime is the sole same-target retry owner. Retry only before any
  semantic provider event (reasoning, text, tool, artifact, or usage) and only
  an exactly classified transient provider signal. Never retry after a semantic
  event or tool side effect. Classified pre-event exhaustion, or a provider
  stream interruption after semantic output, returns `TransientExhausted` while
  preserving the normalized signal and attempt trace operator-side. For the
  stream-interruption leaf, `partial_output=false` means all pre-event attempts
  exhausted; `true` means semantic output made internal retry unsafe.
- No cross-model, cross-provider, or OpenRouter upstream fallback.

## 10. API and UX

### Profiles

`GET /llm-profiles` replaces `GET /models`:

```text
{
  data: {
    default_profile_id,
    profiles: [{
      id, label, description, provider_label, model_label,
      reasoning_options: [{id, label}],
      default_reasoning_option_id,
      privacy_notice
    }]
  }
}
```

The final deployment returns all seven certified profiles in §4. The browser
owns no provider/model/reasoning enum, ordering, default, capability, key, or
availability policy.

This cutover changes only the chat-create selection fields. Existing semantic
fields such as `conversation_id`, `parent_message_id`, `branch_anchor`,
`content`, `chat_subject`, and `reader_selection` remain. Replace:

```text
{ model_id, reasoning, key_mode }
-> { profile_id, reasoning_option_id }
```

Raw `model_id`, provider, model, route, `reasoning`, and `key_mode` are rejected.
`ChatRunOut` likewise replaces `model_id`, `reasoning`, and `key_mode` with
`profile_id` and `reasoning_option_id`. Resolved provider/model/native-reasoning
snapshots remain trust-trail/operator facts; they are not selection controls.

### Failure and rerun

- `ChatRun` owns expected `error_origin`/`error_code`, operator-only
  `error_detail`, and `support_id`.
- API/SSE exposes an optional closed `ExpectedChatFailure` tagged union. Its
  variants fix valid origin/code pairs for `refused`, `incomplete`, `cancelled`,
  `context_too_large`, `invalid_tool_arguments`, `budget_exceeded`,
  `rate_limited`, `timeout`, `provider_unavailable`, and
  `stream_interrupted`, plus `can_rerun` and `support_id: Presence`. The
  transient variants preserve the exact §9 leaf origin and attempt metadata.
  `can_rerun=true` for incomplete, cancelled, invalid-tool-argument, and
  transient-exhaustion outcomes only while the exact profile remains active
  and no side-effecting write tool was attempted. Any durable write-tool call
  event or `message_tool_calls.scope='assistant_write'` row fails that predicate,
  regardless of completion/revert state; read tools do not. Refusal and budget
  denial are not rerunnable. Public JSON omits absent correlation fields.
- A defect exposes no failure variant or `internal_error` code. Exact origin and
  trace remain operator-side. The existing terminal failed run status plus
  `support_id` makes the screen boundary render the same generic,
  non-rerunnable card; the defect never becomes product control flow.
  Assistant messages contain model text only; no synthesized failure prose.
- `ChatRunOut`, message hydration, terminal SSE, reconnect folding, and the
  trust trail all derive that same projection from `ChatRun`; none stores or
  synthesizes a second failure.
- `ChatFailureCard` is the only failure renderer. It uses one exhaustive
  `chatFailureMessage` helper, the shared feedback primitives, a quiet red
  border, concise title/body, optional support id, and at most one action.
- Valid partial text renders once above the card. For a Fable refusal, the
  terminal fold suppresses all accumulated text from the assistant message,
  hydration/reconnect, trust UI, and future continuation; the refusal card is
  the only product projection. No duplicate inline notice, toast, user-message
  retry, assistant resend, or other generic-content suppression remains.
- `POST /messages/{assistant_message_id}/rerun` replaces `/retry` and `/resend`.
  It creates one new durable run from the source prompt and its stored profile
  selection. It requires the normal idempotency key and returns the same run for
  a repeated key. A retired, uncertified, or changed profile makes
  `can_rerun=false`; rerun never remaps or resurrects a historical target.
  Provider retry and product rerun remain different concepts.
- `python/nexus/services/chat_reruns.py` owns the rerun transaction;
  `python/nexus/api/routes/chat_runs.py` owns the backend route; and
  `apps/web/src/app/api/messages/[messageId]/rerun/route.ts` is the sole BFF.
  The service rechecks profile and side-effect eligibility under the rerun
  transaction; the UI flag is not authority. Delete both old message
  retry/resend routes and their service projections.
- A Fable HTTP-200 refusal is `refused`, `can_rerun=false`. Nexus does not
  automatically retry it or fall back to Sonnet/another profile; the user may
  edit the prompt or explicitly select another profile.

### Connection lost, status unknown

`ConnectionLostStatusUnknown {run_id, last_cursor}` is a client-only state owned
by `apps/web/src/components/chat/useChatRunTail.ts`. It is never persisted on a
message/run, emitted as SSE, or mapped to an expected server failure; delete the
ambiguous `E_STREAM_INTERRUPTED` path. The hook first reconciles run status,
then resumes from `last_cursor`. During its bounded automatic reconnect budget,
the UI retains partial text and shows a quiet reconnecting state. After that
budget, `ChatFailureCard` renders exactly one action named `Reconnect`. It never
offers `Run again` or calls `/rerun`. Any rehydrated server state replaces this
local card, so it cannot coexist with a terminal failure card.

## 11. Persistence hard cutover

`migrations/alembic/versions/0184_llm_provider_runtime_hard_cutover.py` performs
the whole ownership change; `python/tests/test_migrations.py` owns its upgrade
proof:

1. Add non-FK product snapshots `profile_id` and `reasoning_option_id`, resolved
   snapshots `provider`, `model_name`, and `reasoning_effort`, plus
   `error_origin` and `support_id` to `chat_runs`.
2. Backfill only from the polymorphic ledger join
   `llm_calls.owner_kind='chat_run' AND llm_calls.owner_id=chat_runs.id`. Select
   the first logical call with `row_number() over (partition by owner_id order
   by call_seq asc, created_at asc, id asc)=1`. Provider transport attempts live
   inside that row's attempt trace; they are not separate candidate rows.
   Backfill wire `provider` from legacy `provider_route`, `model_name` from
   `model_name`, and explicit effort from `reasoning_effort`.
3. Never infer from `models` or `chat_runs.reasoning`. The literal legacy value
   `default` is not a new reasoning option; leave resolved effort and selection
   snapshots null for it. Set `profile_id` and `reasoning_option_id` only when
   the selected exact target and explicit effort exactly match the frozen
   cutover registry. No ledger evidence means null historical snapshots. A
   preflight fails if later `call_seq` rows for one run disagree on target or
   explicit effort; migration never guesses.
4. In `llm_calls`, collapse `provider`/`provider_route` to wire `provider`, add
   nullable `upstream_provider`, `outcome`, `catalog_revision`,
   `request_fingerprint`, `cache_strategy`, `cache_ttl`, `error_origin`, and
   `error_code`; retain usage, costs, pricing snapshot, request ids, and attempt
   traces. Map recognized legacy `error_class` values through one frozen
   migration table; unknown/free class names leave the new origin/code null.
   Then drop `error_class`, `ck_llm_calls_provider`, and
   `ck_llm_calls_provider_route`; the old checks reject `moonshot` and cannot
   survive the application-owned target union.
5. All snapshots are application-required for new runs. They remain nullable
   only for unrecoverable history; `profile_id` never references a mutable
   registry row. Backfill, then rename/drop old columns. No read fallback.
6. Drop `messages.model_id`, `messages.error_code`,
   `chat_prompt_assemblies.model_id`, `chat_runs.model_id`,
   `chat_runs.reasoning`, `ck_chat_runs_reasoning`, `chat_runs.key_mode`,
   `ck_chat_runs_key_mode`, and obsolete key-mode ledger columns.
7. Drop `models` and `user_api_keys` after all foreign keys and consumers are
   removed. Preserve conversations, runs, messages, run events, and ledger
   rows; retiring a profile never deletes historical resolved snapshots.
8. Remove touched business-policy `CHECK` constraints; enforce finite variants
   in owned application types and defects.

Do not add a generic request/response JSON dump. The ledger stores query-worthy
facts and a non-secret fingerprint, not prompts or native bodies.

## 12. File and ownership map

### Shared runtime

Introduce/replace:

- `types.py`, `schema.py`, `catalog.py`, `planning.py`, `runtime.py`,
  `transport.py`, `errors.py`, `usage.py`;
- explicit `openai.py`, `anthropic.py`, `gemini.py`, `moonshot.py`, and
  `openrouter.py` codecs;
- private `_chat_completions_wire.py` syntax helpers;
- provider fixtures, plan goldens, negative gates, and
  `tests/live/test_provider_matrix.py` as the paid-live semantic owner;
- `README.md` documentation for the pinned contract and certification command.

Delete:

- `lowering.py`, `tool_schema.py`, `_adapter_runtime.py`, `cloudflare.py`, and
  the public provider-branching `openai_compatible.py` abstraction;
- obsolete catalog rows/fields, `ProviderArtifactRetention`, hidden cache-key
  state, caller sampling/token-budget fields, JSON repair, and `json-repair`;
- Cloudflare/generic-compat tests and stale fixtures.

### Nexus backend

Introduce:

- `services/llm_profiles.py`, `services/llm_credentials.py`,
  `services/llm_execution.py`, `services/chat_reruns.py`, `schemas/llm.py`,
  and `api/routes/llm_profiles.py`;
- one migration and focused service/integration tests.

Delete:

- `llm_catalog.py`, `services/models.py`, `schemas/models.py`,
  `api/routes/models.py`, `services/api_key_resolver.py`,
  `services/user_keys.py`, `schemas/keys.py`, and key routes;
- `services/crypto.py`, `python/tests/test_crypto.py`, the sole-use PyNaCl
  dependency, and all key-encryption configuration;
- `python/tests/test_keys.py` and `python/tests/test_models.py`; replace their
  surviving boundary coverage with profile/platform-credential tests, not
  renamed legacy fixtures;
- API runtime wiring used only for key probes;
- retry/resend helpers in `services/chat_run_access.py`, both message BFF
  routes, backend route handlers, hashing, and response variants.

Modify:

- `config.py`, `db/models.py`, `errors.py`, `app.py`, `api/deps.py`,
  `tasks/llm_task.py`, `services/llm_ledger.py`, `services/chat_*`,
  `services/context_assembler.py`, and `services/message_trust_trails.py`;
- `api/routes/__init__.py`, which removes model/key routers and registers the
  sole profiles router;
- `services/conversations.py`, `services/conversation_branches.py`,
  `schemas/conversation.py`, and `api/routes/chat_runs.py`; the first owns the
  three `messages.error_code` reads and retry/resend queries and is not covered
  by the `services/chat_*` glob;
- `services/prompt_budget.py`; retain its estimation utility, but resolve
  context/reservation facts only from the finalized profile/plan contract;
- `services/agent_tools/writes.py`, every other chat tool-schema author, and
  all strict-output/Pydantic schema authors;
- Oracle, artifact reducers, media intelligence, metadata enrichment, Synapse,
  Dawn Write, structured synthesis, embeddings/transcription credential wiring,
  and their tests;
- `python/scripts/seed_e2e_data.py`, `e2e/seed-conversation-tree.py`,
  `e2e/global-setup.mjs`, `e2e/tests/conversation-tree-seed.ts`, and
  `python/tests/factories.py`; none may import or construct `Model`,
  `UserApiKey`, or legacy ChatRun selection fields after the migration.
- `python/pyproject.toml` and `python/uv.lock`, which own the immutable shared
  runtime pin and remove PyNaCl;
- `.env.example`, `deploy/env/env-prod-backend.example`,
  `deploy/hetzner/sync-env.sh`, `e2e/playwright.config.ts`,
  `e2e/playwright.csp.config.ts`, and `e2e/playwright.deployed.config.ts`;
  remove encryption-key wiring and require OpenAI, Anthropic, Gemini, Moonshot,
  and the Fable retention assertion in deployable API/worker environments;
- `python/tests/test_hetzner_env_sync_validation.py`; replace its encryption-key
  fixture with the new required direct-key/Fable deployment contract;
- `python/tests/test_cutover_negative_gates.py`; replace gates that require the
  old catalog, `default` reasoning, key spine, Cloudflare secrets,
  skip-success live checks, or duplicated error maps.

The repository-root `Makefile` owns `make certify-llm-providers`; it invokes the
pinned shared runtime matrix without a focused provider filter and refuses
missing required credentials or the Fable retention assertion.
`.github/workflows/ci.yml` owns the protected release-promotion job: normal PR
CI remains deterministic, but promotion invokes this target and fails closed
rather than succeeding/skipping when live secrets are absent.

### Web and docs

Introduce `useChatProfiles.ts`, `ChatProfilePicker.tsx`,
`ChatFailureCard.tsx`, `lib/llm/failure.ts`, and
`app/api/messages/[messageId]/rerun/route.ts`.

Delete `useChatModels.ts`, `ModelSettingsPopover.tsx`, `/api/models`, `/api/keys`,
the settings-keys pane/navigation, duplicated failure maps, and retry/resend
routes/actions, including `app/api/messages/[messageId]/retry/route.ts` and
`app/api/messages/[messageId]/resend/route.ts`. Modify the composer,
conversation hooks, message renderers,
`components/chat/AssistantTrustInspector.tsx`,
`components/chat/useChatRunTail.ts`, `e2e/tests/chatReadiness.ts`, the BFF
route-count guard, and the hand-authored contracts in
`lib/conversations/types.ts`, `lib/api/sse/requests.ts`, and
`lib/api/sse/events.ts`.

After implementation, update `docs/architecture.md`, `docs/modules/llms.md`,
`chat.md`, `jobs.md`, and `docs/local-rules/testing_standards.md`; delete
`docs/modules/byok.md`. The testing standard must remove BYOK readiness and the
Cloudflare generation matrix and name the new certification tiers.
`docs/architecture.md` must remove §7.5 BYOK and §8.3 Models claims and remain
in parity because the generation-run-harness G8 gate makes it contractual.
Built streaming/chat cutovers are not rewritten.

## 13. Ordered implementation

All slices land on one branch; `main` never contains both contracts.

1. Write failing catalog, canonical-schema, finalized-plan, cache-affinity,
   transient-exhaustion, codec-golden, error-origin, and negative-gate tests in
   `llm-calling`.
2. Migrate every schema author before deleting normalization. In
   `services/agent_tools/writes.py`, author `library_id/library_name`,
   `page_uri`, `prefix/suffix/color/note`, and `kind` as required-nullable;
   keep `queue_add` in the exhaustive suite. Migrate and validate `app_search`,
   `web_search`, `read_resource`, and `inspect_resource`; structural nullability
   uses the canonical union and `web_search` keeps its minimum in domain
   validation. Compile
   `metadata_enrichment.py` and the Oracle/Synapse/media/artifact structured
   synthesis Pydantic models to the structural subset while retaining richer
   constraints in their domain validators. Only after every real schema passes
   all codec round-trips, delete `tool_schema.py` and its mutation tests.
3. Build the new types/schema/planner/transport and five codecs; delete old
   runtime paths, including Gemini keyword stripping; run deterministic gates.
4. Add Nexus profiles, platform credentials, the sole execution/ledger
   boundary, and one rerun owner; cut every background generation owner to it.
5. Apply the one-way DB/API migration, migrate factories and both E2E seed
   paths, and delete models/BYOK/old selection and retry/resend projections.
6. Cut the frontend to profiles, one failure card, the client-only reconnect
   state, and one rerun action; delete old API/UI paths.
7. Run contradiction scans, integration/E2E and the unfiltered paid provider
   certification, pin the exact shared runtime revision, and update every
   steady-state doc named in §12.

## 14. Acceptance and negative gates

- Every profile validates against one catalog contract and has current
  official source/pricing/privacy provenance.
- Each declared reasoning level sends the exact native value. `xhigh` and `max`
  remain distinct; unsupported levels fail before network.
- Every real tool and structured-output schema validates without mutation and
  round-trips semantically through every active codec. The five write tools
  preserve their intended optional values as required-nullable. Streamed tool
  call plus same-target continuation succeeds without exposing hidden
  reasoning.
- One immutable finalized plan is the only transport input. Ledger plan facts
  and request fingerprint match that exact object; no second lowering occurs.
- Every profile passes repeated-prefix cache proof; explicit wire controls,
  derived affinity stability/scope, and observed read/write usage agree with
  the ledger. The OpenRouter route is unusable unless its pinned endpoint also
  reports a non-zero paid cache read. Versioned affinity vectors match across
  processes and change for every scope/target/contract/prefix mutation.
- Every generation attempt reaches exactly one terminal LLM-ledger outcome for
  planning, transport, provider, protocol, or cancellation. Tool, postprocess,
  and worker failures terminalize the owning run without rewriting a successful
  call. Dawn failure persists the appropriate row.
- Every token reservation settles exactly once: no dispatch releases, reported
  usage commits actuals, and a potentially billable request without usage
  commits the conservative full reservation.
- Planning failures terminalize the pre-existing ledger row with `origin=plan`
  and no provider request id. No local defect renders provider-rejection copy or
  enables product rerun.
- Rate-limit, timeout, provider-unavailable, and provider-stream exhaustion are
  expected chat outcomes after runtime retries. They retain attempt evidence
  and render one **Run again** action only when no write tool was attempted;
  unknown/unclassified failures remain non-rerunnable defects.
- OpenRouter cannot fallback, response-cache, or make a second upstream attempt;
  selected upstream and generation id are recorded.
- A failed chat persists no failure prose and renders one card/action in initial
  HTTP, live SSE, reconnect, and reload paths. A browser-only status-unknown
  disconnect instead renders at most one **Reconnect** action and creates no
  run/failure record. A mid-stream Fable refusal clears its partial text from
  every product projection before the refusal card is folded.
- `/llm-profiles` and chat requests have no raw provider/model/key policy. One
  `/rerun` route remains; both its projection and transaction reject a source
  run with any attempted write tool.
- No LLM provider SDK/HTTP call exists outside `provider_runtime`; no Nexus
  generation-runtime call exists outside `llm_execution`. Named embedding and
  transcription owners use only their non-generation runtime ports.
- Required direct platform keys and the Fable retention assertion are validated
  at API and worker startup; no missing key silently changes `/llm-profiles`.
  The operator command rejects a missing `OPENROUTER_API_KEY`.
- The protected release-promotion job runs the unfiltered certification and
  fails on missing live secrets; ordinary deterministic PR CI does not claim
  paid-live success.
- Migration fixtures prove the ledger-join/tie-break, literal `default`, missing
  history, contradictory later-call cases, legacy error map/null behavior, and
  provider-check removal. Both Playwright seed paths and global setup import
  successfully after `Model`/`UserApiKey` deletion.
- No `models`/`user_api_keys` table, `/models`, `/keys`, BYOK/key mode, provider
  enable flag, Cloudflare LLM, active old-model slug, generic provider-branch
  client, cache stripping, schema mutation, JSON repair, sampling knob,
  reasoning token budget, stateful cursor, or automatic fallback remains.

Verification tiers:

- unit/golden: every plan variant, error mapping, parser, continuation mismatch,
  cache mode, schema subset, usage, and negative scan;
- HTTP-boundary integration: exact native bodies/headers and malformed provider
  responses with only the external network mocked;
- Nexus integration: real DB, all seven owner kinds, terminal ledger/failure
  persistence, API contracts, and rerun idempotency;
- browser/E2E: profile selection, all reasoning options, stream/reconnect,
  partial-text failure, one card, and rerun;
- paid live: one minimal call per reasoning option; one above-minimum cache
  warm/read, strict-JSON call, and representative full-tool continuation per
  profile; plus invalid-key, timeout, request-id, usage/cost, and one prod-like
  canary per provider. Goldens exhaust the remaining cross-product.

`make certify-llm-providers` is the required release-build gate. The root
`Makefile` pins the `llm-calling` revision and invokes
`../llm-calling/tests/live/test_provider_matrix.py` with `LLM_RUNTIME_LIVE=1`,
all direct/OpenRouter credentials, the Fable assertion, and no provider focus
filter. It proves every declared effort (including newly shipped Kimi
`low | high | max` both direct and routed), cache reads, strict JSON, tools and
continuation, usage/request ids, and the pinned OpenRouter upstream. The normal
deterministic build makes no network calls, but its artifact is not promotable
without this current paid certification.

## 15. Key decisions

- Direct routes beat OpenRouter-only: they are cheaper to reason about, expose
  native capabilities first, and remove a routing/failure boundary. OpenRouter
  remains useful as one explicitly selected, certified operator adapter. No
  price advantage is assumed; the ledger and catalog use the currently
  certified direct/route prices.
- Platform credentials beat BYOK for a one-user prototype. The deleted UI,
  encryption, key lifecycle, probes, modes, and per-user availability do not buy
  product value here.
- Profiles beat provider × model × route selection. They preserve expert
  reasoning control while making invalid combinations unrepresentable.
- Static checked-in policy beats a dynamic control plane. Changes are reviewed,
  live-certified, and deployed like code.
- Provider-native prefix caches beat an app response cache. They save input cost
  without replaying stale answers or tool calls.
- Cache affinity is planner-derived from exact scoped prefix bytes, never
  caller-supplied or mutable hidden state. This preserves privacy boundaries and
  stable same-input reuse without another cache service.
- The cutover deliberately preserves one-click recovery for classified
  rate-limit, timeout, provider-down, and interrupted-stream exhaustion. It
  wraps exhausted retry signals in an explicit expected outcome instead of
  narrowing them into a generic defect card.
- The 80/20 rerun safety policy is conservative: any attempted write tool
  disables whole-turn rerun. Nexus does not add checkpoint replay or a new
  cross-run tool-idempotency system in this cutover.
- Fable requires one explicit retention-acceptance assertion because mandatory
  retention is an operator decision, not an implementation default. The final
  portfolio is otherwise static.
- Rejected: automatically retrying a Fable refusal with Sonnet or any fallback.
  A refusal is the chosen model's terminal safety result; hidden substitution
  would violate selection, privacy, cost, and failure truthfulness.

## 16. Done means

- One profile registry selects a certified exact target for every generation
  owner.
- One planner produces the immutable request used by transport and accounting.
- Direct providers and the constrained OpenRouter route pass paid live proof,
  including reasoning, tools, continuation, caching, usage, and errors.
- One expected failure projection, or one generic defect boundary state,
  produces one accurate card and at most one rerun path.
- Old models, mirrors, BYOK, duplicated lowering/errors, fallbacks, and dead
  provider code are gone; steady-state docs describe only the final system.

## Current provider references

- [OpenAI GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model)
  and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic models](https://platform.claude.com/docs/en/about-claude/models/overview),
  [effort](https://platform.claude.com/docs/en/build-with-claude/effort),
  [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
  [Fable refusals](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback),
  and [Fable retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- [Gemini 3.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash),
  [generateContent thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking),
  and [generateContent caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
- [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart),
  [thinking effort](https://platform.kimi.ai/docs/guide/use-thinking-effort), and
  [automatic context caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api)
- [OpenRouter Kimi K3](https://openrouter.ai/moonshotai/kimi-k3-20260715),
  [endpoint metadata](https://openrouter.ai/api/v1/models/moonshotai/kimi-k3-20260715/endpoints),
  [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
  [router metadata](https://openrouter.ai/docs/guides/features/router-metadata),
  [reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
  [prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
  and [response caching](https://openrouter.ai/docs/guides/features/response-caching)
