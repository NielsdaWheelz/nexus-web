# Codex Personal Generation Hard Cutover

**Status:** PROPOSED IMPLEMENTATION SPECIFICATION

**Date:** 2026-08-24 (revision 2, adversarially validated against `main` @ `beb88775`)

**Type:** atomic hard cutover; no compatibility period

**Open questions:** none

## 1. Decision

Make the private `codex-personal` ChatGPT login the sole inference backend for
all Nexus text and structured-output generation. Keep one isolated Codex host,
one product policy catalog, one execution boundary, and one generation ledger.

This means one inference/auth channel, not one transport:

```text
Nexus operation -> durable generation -> private UDS -> Codex host -> ChatGPT subscription
                                                        |
chat only                                               +-> scoped HTTPS MCP -> Nexus tools
```

Hard-cut every direct generation provider, key, profile, retry, price, and
continuation path in the same change. There is no feature flag, dual write,
provider/API-key fallback, compatibility decoder, or automatic redispatch of
an accepted ambiguous turn.

Approved scope assumptions:

- “Everything” means generative text/JSON. OpenAI embeddings keep their
  behavior and model but stop composing the multi-provider credential bundle:
  `semantic_chunks` constructs its runtime from the narrow embedding credential
  alone. Deepgram transcription, Brave search, deterministic extraction, and
  projections are untouched.
- Authors remain deterministic where they are deterministic; model-proposed
  authors are part of metadata enrichment. Abstracts remain projections of the
  media summary, not a second generation.
- Existing host-planned retrieval remains app-owned. Chat alone exposes
  model-planned Nexus tools through MCP.
- One-user, low-volume, operator-paid subscription usage is the product
  boundary. A multi-user or externally billed service would require a new
  design.

The official [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk),
[ChatGPT authentication](https://learn.chatgpt.com/docs/auth),
[model guidance](https://learn.chatgpt.com/docs/models), and
[MCP contract](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) are the
external authorities. The repository pins are the executable authority:
`provider-runtime` at its exact git rev, `openai-codex`/`openai-codex-cli-bin`
at their exact locked versions, the plan pins in `generation_policy.py`, and —
added by this cutover — the official MCP SDK at an exact locked version.
`python/uv.lock` moves with `python/pyproject.toml` in the owning package.

## 2. Goals and non-goals

Goals:

- Route every current generation operation through `codex-personal`.
- Select the lowest fixed, evaluated model/effort plan that clears each task's
  quality bar; spend extra reasoning only on rare, high-value work.
- Preserve prompts, schemas, citations, publication transactions, cancellation,
  streaming, rerun/regenerate semantics, and tool side-effect controls.
- Generalize the proven metadata host instead of building a second agent stack.
- Keep the credential host isolated from PostgreSQL and application secrets.
- Prove each ownership boundary once, then live-smoke unique plans and the
  operation portfolio without a Cartesian test matrix.
- Consolidate the two disjoint generation ledgers (`llm_calls` for
  direct-provider operations, `agent_turns` for the native lane) into one, and
  remove all unreachable provider-generation code.

Non-goals:

- Dynamic routing, cascades, judges, confidence-based escalation, A/B routing,
  quota prediction, or provider failover.
- Arbitrary model/effort controls, a model browser, BYOK, multi-user billing, or
  API-price estimation.
- Codex built-in web, shell, filesystem, skills, plugins, approvals,
  resume/fork, persistent native sessions, subagents, or Ultra mode.
- Replacing Nexus search/retrieval, Brave, the queue, durable step journal,
  canonical tool handlers, or the Nexus guest-agent run-step protocol in
  `docs/rules/modules/agent-runtime.md`, which is a mirrored subtree and owns
  different behavior than this host.
- Reworking embedding or transcription behavior. The embedding call is rewired
  to the single OpenAI credential in the same change; its inputs, dimensions,
  and outputs do not change.
- A priority scheduler, extra host replicas, or generalized workflow engine.
  §3 fixes the single-slot contention policy without one.

## 3. Target behavior and routing policy

### Fixed inference plans

Model and effort form one versioned plan. They are not independent knobs.

| Plan | Exact target | Use |
|---|---|---|
| `routine` | `gpt-5.6-luna` / `low` | frequent, bounded extraction/synthesis |
| `standard` | `gpt-5.6-terra` / `medium` | interpretive or compositional work |
| `thorough` | `gpt-5.6-terra` / `high` | rare, high-value dossier synthesis |
| `deep` | `gpt-5.6-sol` / `high` | user-requested hard chat only |

`Ultra` is an agent-orchestration mode, not a background-job reasoning setting;
it is intentionally absent. Subscription payment removes marginal API price
optimization, not latency, quota, reliability, or overthinking costs.

No plan may be pinned in a shipped policy revision until one live turn on
`codex-personal` has succeeded at its exact model/effort pair; only
`gpt-5.6-luna`/`low` holds that evidence today. Plan qualification precedes the
production switch (§9).

### Operation catalog

Each catalog row also fixes a turn bound: the operation's turn timeout, from
which §5 derives the transport deadline. The bounds column is policy, not
commentary.

| Entrypoint/product | Canonical operation | Plan | Turn bound |
|---|---|---|---|
| `enrich_metadata`; metadata; author proposals | `metadata_enrichment` | `routine` | 120 s |
| `media_unit_build`; summaries/abstract source | `media_summary` | `routine` | 120 s |
| `synapse_scan`; synapses/linking | `synapse` | `routine` | 120 s |
| `dawn_write_job` | `dawn_write` | `standard` | 180 s |
| `oracle_reading_generate` | `oracle` | `standard` | 180 s |
| `dossier_build`; dossier page, note | `dossier_page`, `dossier_note` | `routine` | 120 s |
| `dossier_build`; dossier media, conversation | `dossier_media`, `dossier_conversation` | `standard` | 180 s |
| `dossier_build`; dossier library, podcast, contributor, idea | corresponding `dossier_*` | `thorough` | 300 s |
| `POST /artifacts/dossiers/learn` (request-scoped); idea resolution | `dossier_idea_resolve` | `routine` | 60 s |
| `chat_run` Fast | `chat` / `fast` | `routine` | 900 s tool-run ceiling |
| `chat_run` Balanced (default) | `chat` / `balanced` | `standard` | 900 s tool-run ceiling |
| `chat_run` Deep | `chat` / `deep` | `deep` | 900 s tool-run ceiling |

`dossier_build` covers exactly the eight registered subject bindings (`media`,
`conversation`, `library`, `podcast`, `contributor`, `page`, `note_block`,
`idea`); adding a ninth binding requires a catalog row and a policy revision.
`dossier_idea_resolve` is the one request-scoped generation; it keeps its
existing learn-request step journal as its durable owner.

`oracle` is the one plan change in this cutover: it moves from luna/low to
terra/medium on the interpretive-writing eval family, and ships `standard` only
with that versioned eval result recorded at the initial policy revision; absent
the result it ships `routine`. Every other operation keeps its current model
and effort exactly.

Promotion or demotion requires a versioned eval result and policy revision. Do
not add a runtime router until observed failures justify it. The eval corpus
lives at `python/tests/evals/cases/generation_plans.v1.json` — its content
contract moves with package A's policy revision, its file and registration
belong to package G — versioned exactly like `tool_safety.v3.json`: reviewed rubric
version, per-case baseline, `max_hosted_calls`, and the exact consumer pins.
Cases are task-family based (extraction, summary/linking, interpretive writing,
dossier, chat) and assert deterministic invariants — schema validity, citation
presence, refusal of injected instructions — not a production LLM judge.
Deterministic replay runs in `full`; live re-recording is an operator-run
subscription task on the enrolled host, never a PR dependency. A plan promotion
or demotion is admissible only with a corpus result recorded at the new policy
revision.

### Turn-slot contention

The host admits one turn at a time for all operations and has no scheduler.
Nexus dispatch applies fixed courtesy, not priority:

- While a chat run is queued or executing, no new background generation is
  dispatched.
- A background dispatch that meets a busy or pressured host takes the bounded
  pre-accept reschedule path (§7): the shared `capacity_wait_index` and the
  delay schedule `30 / 60 / 120 / 300 / 600` seconds. The total background wait
  budget strictly exceeds the 900-second chat ceiling, so one chat run cannot
  exhaust it; exhaustion records the operation's visible `capacity_unavailable`
  terminal.
- A chat dispatch that meets a busy host uses a short interactive schedule —
  two waits of 5 and 10 seconds — and then completes the run with the visible
  `capacity_unavailable` terminal and one rerun affordance. Chat is never
  silently held past that ceiling while a user watches an open stream.
- `dossier_idea_resolve` never waits on host capacity: a busy host fails fast
  to the caller as the existing unresolved-idea outcome (§5).
- No accepted turn is preempted. If measured starvation appears, the answer is
  a second host replica in a later cutover, not a scheduler here.

### Tool composition

```text
host-planned workflows:
  Nexus/Brave retrieval -> frozen, cited evidence -> tool-free Codex synthesis

model-planned chat:
  Codex -> run-scoped Nexus MCP -> canonical ToolExecutor -> Codex continues
```

- Synthesis operations receive no tools and no tool network.
- Idea-dossier research keeps its current `HostTable` Brave loop; only final
  synthesis moves to Codex. The `HostTable` plan and its snapshot/validation
  helpers stay owned by `tool_runtime`; the adapters consume them unchanged.
- Chat receives exactly `CHAT_TOOL_DECLARATIONS`. MCP delegates to the existing
  `ToolExecutor`; it contains no copied domain logic or schemas.
  `CHAT_TOOL_DECLARATIONS` includes the Brave-backed `web.search`; it is a
  Nexus tool over MCP, not a Codex built-in.
- The model-planned loop is bounded server-side by the existing chat
  `RunLimits` (64 calls, 900-second elapsed), enforced by the run-scoped
  `ToolExecutor` behind MCP; `MAX_TOOL_ITERATIONS` is deleted with the
  Nexus-driven loop, and budget exhaustion is a declared tool failure the model
  sees, folding to the run's closed terminal.
- An undeclared tool name is rejected at the MCP boundary as `isError=true`,
  journaled at its position as the existing `rejected_provider_call` record
  with `unknown_tool`, and projected to the same tool-status event; the
  generation continues. A Codex built-in tool invocation or an approval event
  ends the generation as `Failed(policy_violation)`; §7 owns the full
  producer list for that terminal.
- Codex built-ins and native web search stay disabled in every plan.

## 4. Architecture and ownership

```text
prompt/domain owner
  -> GenerationIntent                         content and output contract
  -> generation_policy                       operation -> complete plan
  -> durable owner + llm_calls               replay, uncertainty, audit
  -> codex_generation_client                 bounded private UDS
  -> nexus-codex-agent-host                  credential/session/capability owner
  -> pinned AgentRuntime + official SDK      native protocol owner
  -> codex-personal
  <- normalized terminal
  -> existing publication owner              domain commit
```

Ownership laws:

- Prompt, evidence selection, output schema, validation, and publication stay
  with their current domain modules.
- `generation_policy.py` is the sole operation/profile-to-plan authority. A
  caller cannot supply model, effort, backend, auth, tools, or fallback.
- The generation service is the sole dispatch boundary; `llm_ledger.py` is the
  sole `llm_calls` writer and the sole typed reader.
- The host owns SDK construction, the Nexus-owned state root
  (`NEXUS_CODEX_STATE_ROOT_BASE`; ambient `CODEX_HOME` or `OPENAI_API_KEY` in
  the service environment is a startup defect), ChatGPT auth readiness, the
  fixed empty cwd, sandbox/permission policy resolution, the single active turn
  slot, host/cgroup capacity parsing and pre-accept admission, runtime close
  and session cleanup, and `AgentEvent`-to-wire normalization. It has no
  database or provider API credentials.
- The host is a distinct process and a distinct image command; it is not a
  distinct package. It imports the policy and contract modules from the shared
  image and nothing that opens a database, provider, or object-store handle.
- The queue/job journal owns scheduling and replay. The generation ledger is
  provenance, not a second scheduler.
- Tool declarations/profiles/execution remain owned by `tool_runtime`. The MCP
  adapter is transport and authorization only.
- The chat run's durable step journal has exactly one writer: the process
  holding the job lease. The MCP mount is therefore served by the interactive
  worker process that owns the run (§6); no API-process handler ever
  constructs a `ChatStepRuntime` or touches `background_jobs.payload`. Grant
  claims (`worker_id`, `attempt_no`) are admission facts, never a licence to
  forge the worker's fence identity.
- Nexus, never the model or host, authorizes and writes domain state.
- No database transaction spans UDS, SDK, MCP, Brave, or other external I/O.
- One new native session is opened per generation and closed after one turn.
  For `ChatTools` that one native turn contains the whole model-planned tool
  loop; the loop's server-side bound and cancellation are defined in §3 and §6.
  Nexus remains conversation-state authority; chat history is rendered into a
  canonical role-tagged transcript rather than native session replay.
- Cancellation is delivered by the explicit cancel call (§6): the host
  interrupts the active turn, closes the runtime, releases the slot, and the
  durable owner records `Cancelled`. Nexus additionally refuses every MCP tool
  call after cancellation, so a cancelled generation performs no further tool
  effect.

## 5. Capability contract

The app-owned command is a strict tagged union:

```text
GenerationCommand
  operation                     tagged catalog variant; owns its byte bounds
  policy_revision, policy_fingerprint      drift assertions (see below)
  intent
    instructions                bounded text
    input                       bounded text (chat: the Nexus-rendered
                                canonical role-tagged transcript)
    output = Text
           | JsonSchema(name, schema, strict=true)
  tool_grant                    ChatTools operations only (§6)
```

Rules:

- Intent contains no provider target, reasoning override, credential, native
  continuation, pricing, retry, or arbitrary tool declaration.
- Capability is policy, not intent: `generation_policy` maps `operation` (and,
  for `chat`, the profile) to exactly one of `Synthesis` or `ChatTools`.
  Capability never travels on the wire; the policy fingerprint covers the
  capability rules, and the host derives the capability from `operation`
  alone. A `tool_grant` present on a `Synthesis` operation, or absent on a
  `ChatTools` operation, fails closed.
- `max_output_tokens` is deleted. The agent lane has no output-token knob; the
  strict output schema, the pinned runtime's turn output-byte limit, and the
  operation turn timeout are the output bound. Input admission remains
  operation-owned: each catalog entry fixes its own `instructions`/`input`
  byte bounds, validated on the wire before session open.
- `generation_policy.py` owns the per-model context and output bounds table
  alongside the plans; it is part of the policy fingerprint and replaces the
  deleted provider-registry row as the sole admission authority. It is not a
  token reservation and is not billed.
- `input` is always one bounded UTF-8 text. For `chat`, that text is the
  canonical role-tagged transcript, rendered by Nexus — the conversation-state
  authority — from its typed history, including prior-turn tool receipts; the
  host never parses, validates, or reconstructs conversation structure. The
  current turn's tool results never travel as transcript; they arrive through
  MCP inside the native turn.
- Elapsed time is layered, not one number. Each catalog row fixes a turn
  timeout; the client request deadline is session-open + turn timeout +
  runtime-close + transport margin (the proven metadata shape:
  90 + 120 + 30 + 15 = 255 s inside a 300 s lease); each operation's queue
  lease strictly exceeds its derived request deadline by a stated
  terminal-checkpoint margin. No background turn timeout exceeds 300 seconds
  and none equals its own lease; where the derived deadline does not fit, the
  lease is raised in the same change (§8 states the raised values). Each
  `thorough` row's timeout is validated against measured live turns at its
  exact plan before the switch; never ship a bound its own plan predictably
  exceeds. `dawn_write` bounds one user's generation, not the sweep; the
  sweep's lease covers the population. Chat retains its existing 900-second
  `RunLimits` tool-run ceiling and the `chat_run` lease is restated so it
  strictly exceeds chat's derived deadline.
- `dossier_idea_resolve` is request-scoped — it executes inside
  `POST /artifacts/dossiers/learn` — and never waits on host capacity: a busy
  host or capacity refusal fails fast to the caller as the existing
  unresolved-idea outcome, and its catalog turn bound is sized so
  admission-to-terminal fits the route's synchronous budget.
- `Synthesis`: read-only filesystem in the fixed empty cwd,
  `builtin_tools="disabled"`, `web_search=false`, no MCP, approvals denied,
  additional directories empty, tool events forbidden.
- `ChatTools`: built-ins still disabled; one required Streamable HTTP MCP
  server with the exact tool allowlist from `CHAT_TOOL_DECLARATIONS`. The
  pinned Codex adapter has no network-allowlist mapping and no read-only
  network toggle, so a ChatTools session lowers to
  `filesystem=workspace_write`, `network=unrestricted`, `approval=deny`,
  `UnsafeConfirmation(("network_unrestricted",))`, with a private empty tmpfs
  cwd as the sole writable root and `additional_dirs=()`. The egress boundary
  for a ChatTools turn is therefore the host container's own network: the
  dedicated egress bridge plus an egress firewall admitting only the ChatGPT
  endpoints and the exact MCP origin. The host refuses ChatTools when that
  container network policy is not attested. Widening the adapter is an
  out-of-scope `provider-runtime` change.
- A policy revision fingerprints plans, operation mappings, capability rules,
  bounds, and tool-plan revision. `generation_policy.py` is the single
  implementation; the host imports it from the shared image rather than
  restating any plan (host-side lowering lives in
  `codex_generation_operations.py`), independently re-resolves the plan from
  `operation` alone, recomputes the fingerprint, and refuses the command
  before session open on any mismatch. The host trusts the caller for request
  facts only — instructions, input, output schema — and for nothing that
  selects runtime behavior.
- `request_fingerprint` covers operation, policy revision, prompt revision,
  output-schema digest, tool-plan revision, and input digest. It is the one
  fingerprint the grant, the ledger, and the durable step journal share.
  Prompt revision and output-schema digest remain domain-owned request facts.

## 6. APIs and schemas

### Private host API

Replace metadata-only `POST /v1/turns` with `POST /v2/generations`; retain
`GET /health`. Both remain HTTP over `/run/nexus-codex/agent.sock`, never TCP.

```json
{
  "schema_version": "nexus-generation-command.v2",
  "request_id": "<replay-stable UUID>",
  "operation": {"kind": "chat", "revision": "<catalog revision>"},
  "policy_revision": "<exact revision>",
  "policy_fingerprint": "<sha256>",
  "intent": {
    "instructions": "<bounded text>",
    "input": "<bounded text>",
    "output": {"kind": "Text"}
  },
  "tool_grant": {"kind": "Bearer", "token": "<sensitive run-scoped JWT>"}
}
```

`operation` remains a tagged variant, not a bare string: each catalog entry
owns its own `instructions`/`input` byte bounds and validates them before
acceptance. The host's request-body cap is re-derived from the largest
admitted decoded input (six-byte-per-byte JSON escaping plus envelope) rather
than kept at the metadata-era 256 KiB, and both bounds live in the shared
contract module so host and client cannot disagree.

`tool_grant` is required only for `ChatTools`, is transmitted as sensitive UDS
material, and is excluded from repr, logs, persistence, fingerprints, and
evidence. The host converts it to a
`CredentialRef(kind="secret_reference", profile_key="codex-personal",
name=<per-generation reference>)` and registers the value in a per-turn
in-memory table. The host constructs one `AgentRuntime` per admitted turn with
an `AgentRuntimeConfig.secret_resolver` bound to that table, and clears the
entry on every terminal, including cleanup paths. The pinned runtime resolves
the reference once at session open and injects the value into the Codex child
process environment under an opaque hash alias that the generated config binds
to the MCP `Authorization` header and excludes from the shell environment
policy; the grant is never a Nexus process argument, log field, or persisted
value, and the reference name is unique per generation. For the life of one
turn the grant therefore exists as an environment variable in the Codex child;
its containment is the disabled shell and built-in tools plus the runtime's
`shell_environment_policy` exclusion — re-enabling any built-in tool would
expose the grant, and no plan may do so. The grant is short-lived, run-scoped,
and single-purpose for exactly this reason.

Responses remain strict, bounded NDJSON with sequence numbers contiguous from
zero — a gap is a protocol defect, so a frame the host chooses not to relay
consumes no sequence — and one last terminal. The closed event union is
`text | tool_use | usage | permission_request | native | terminal`, unchanged
from v1. `tool_use` frames are valid only for `ChatTools`; a `tool_use` under
`Synthesis` and any `permission_request` under either capability are relayed
as evidence and then terminate the turn with the `policy_violation` failure —
a stream that observed a tool or permission event without that terminal is a
client-detected host defect. Approvals are never granted. Unknown fields,
revisions, operations, events, or a missing terminal fail closed.

Frame policy is per capability. `Synthesis` keeps the v1 coalescer and the v1
bounds (1,024 frames / 256 KiB per frame / 1 MiB per stream). `ChatTools`
streams text incrementally under a separate, evaluated frame budget — a
bounded flush interval and byte run rather than a 32 KiB buffer — with
frame/stream ceilings sized to admit a full 900-second tool-looping turn with
margin (derived from the chat plan's output allowance and tool-receipt budget).
Both budgets remain authored inside their bounds by construction, and a turn
that would overrun still ends with the typed `output_limit_exceeded` terminal.
Both budgets are named in the contract module so host and worker cannot
disagree.

Pre-accept capacity refusal is the sole non-200 response that means safe
scheduling rather than a rejected command. The host emits `HTTP 503` with
`Content-Type: application/json` and body exactly
`{"schema_version":"nexus-generation-rejection.v2","kind":"capacity_unavailable"}`
(the proven v1 semantics, re-versioned with the command union) only while
holding no accepted turn and before runtime/session construction. The client
recognizes capacity only when status, content type, schema, and body match
exactly; every other non-200 is a closed-contract rejection. No memory, PSI,
process, or credential fact crosses the response. This exact response is what
§7 means by a proven pre-accept refusal.

Cancellation is explicit: `POST /v2/generations/{request_id}/cancel`
interrupts the identified active turn; it is idempotent, returns 204 whether
or not the turn is still active, and never touches the turn slot. The
interrupted turn ends with one `terminal` of status `cancelled` on its
still-open response stream, so a cancelled turn that reaches its terminal is
`Completed`, not `Uncertain`; a stream that closes without a terminal remains
`Uncertain`. Chat maps its existing `cancel_requested_at` poll onto this call;
in-flight MCP tool calls continue to observe the run's cancellation through
the existing execution context.

Chat consumes the NDJSON response incrementally, frame by frame; the client
(`codex_generation_client.py`) exposes an async frame iterator, not a buffered
terminal observation. The frame `sequence` is the chat SSE
`provider_event_seq`. Host-side coalescing exists only to satisfy the stream
bounds; the 33 ms / 512-char / 2 KiB SSE flush cadence stays Nexus-owned and
is applied once, over host `text` frames.

The terminal frame carries `accepted_at` — the host's monotonic-to-wall
acceptance instant — which Nexus persists at the terminal checkpoint. No Nexus
write occurs between the `Uncertain` checkpoint and the terminal.

`GET /health` gains `command_schema_version`, `policy_revision`,
`sdk_version`, and `runtime_version`. The client asserts these against its own
before dispatch, so an image or policy mismatch is refused before any
`Uncertain` checkpoint is committed.

### Nexus MCP API

Add the official `mcp` Python SDK as a new pinned runtime dependency in
`python/pyproject.toml` and `python/uv.lock` (exact `==` version, recorded in
the module doc; `uv sync --frozen` must succeed unchanged) and serve its
Streamable HTTP ASGI app at `/internal/agent-tools/mcp`; do not hand-roll
JSON-RPC. Stateful sessions are enabled; SSE resumability/event-store replay
is disabled, so the only replay path is the durable tool journal below.

The mount is served by the interactive worker process that owns the chat run —
the single durable-journal writer of §4 — on a dedicated listener.
`python/nexus/services/agent_tools_mcp.py` owns server construction and
handlers; the worker entrypoint wires the listener; the API app and
`AuthMiddleware` are untouched, and no `/internal/*` exemption exists there.
Caddy routes exactly this path to the worker listener; every other path keeps
its current route. The handler resolves the live run by
`run_id`/`job_id`/`attempt_no` from the grant and refuses any call whose run
this process does not own. Each tool call opens and closes its own database
session under the run's lease fence; the mount never uses a request-scoped
session.

The MCP origin is the production Caddy origin; the hostname is a real,
publicly resolvable, lowercase DNS name (the pinned runtime's hostname rules
refuse `localhost`, `.local`, and `.internal` names, so no internal-only
origin is expressible). The path is therefore publicly routable, and its sole
boundary is the run-scoped grant plus per-call revalidation — a deliberate
decision matching the existing public bearer-scoped stream routes, not an
oversight. Every request without a valid grant receives an unauthenticated
rejection with no body distinguishing the route's existence, and the path is
rate-limited at the edge. No network peer is added between the Codex host and
any application service: the host reaches the origin as ordinary internet
egress over TLS, so `deploy/hetzner/release.py`'s exact `nexus_codex_egress`
single-member bridge inspection is unchanged and stays a release gate; the
host's egress firewall admits exactly the ChatGPT endpoints and this origin.

The dedicated HS256 grant reuses the proven token-codec pattern with its own
signing key, issuer, and audience — deliberately not the stream token's, which
the offline-reading scope shares. `AGENT_TOOL_GRANT_SIGNING_KEY` is a new
required secret in staging and prod: added to `python/nexus/config.py`, the
`deploy/hetzner/sync-env.sh` synced allowlist, and
`deploy/env/env-prod-backend.example`; absence fails boot rather than falling
back to any other key. Required claims are:

```text
iss, aud, scope, sub, jti, run_id, job_id, worker_id, attempt_no,
generation_id, tool_plan_revision, request_fingerprint, iat, nbf, exp
```

`exp` is at most the chat run ceiling. The token is multi-use within one MCP
session: on the first authenticated request the resolver binds `jti` to the
transport's `Mcp-Session-Id`; a presentation of the same `jti` under a
different session id is refused and terminates the run's grant. Every tool
call revalidates signature with `alg` pinned to HS256, exact
`iss`/`aud`/`scope`, `nbf`/`exp` against the database clock with no skew
allowance, the bound session id, the active job lease/fence, run/user
ownership, generation, plan revision, cancellation, declared tool, and
admitted resource scope. The grant is refused at every Nexus surface other
than the MCP mount.

Tool positions are assigned by Nexus at MCP-request admission via one
monotonic per-generation counter yielding
`generation/<generation_seq>/tool/<n>`, which replaces the retired
`turn/<n>/tool/<n>` grammar in the step-schema, reconciliation, and
write-`EffectId` owners; `<n>` is also `message_tool_calls.tool_call_index`
and the citation-ordinal cursor, both read from the journal. The protocol
identity of a call is the tuple `(grant jti, Mcp-Session-Id, JSON-RPC request
id)`. On first admission the handler binds that identity, under the run's
lease fence in one transaction, to the next durable tool position, recording
the identity tuple and the canonical input digest alongside it. A repeat of
the same identity tuple returns the journaled receipt verbatim; the same
identity tuple with a different canonical input digest is a defect, not a new
call. Concurrent calls serialize on the fence, so the ordinal is total. One
generation writes exactly one ledger row; `call_seq` is no longer derived
from a turn index.

MCP tool names are governed by one rule with three name spaces. The declared
MCP tool name is the canonical tool id where the pinned MCP SDK accepts it;
otherwise one generated, bijective adapter mapping is the sole translation,
fingerprinted into the tool-plan revision. The model-visible name is always
the server-prefixed form — built-ins-disabled turns off
`non_prefixed_mcp_tool_names` — so the canonical id is never what the model
sees. `McpServerSpec.allowed_tools` carries exactly the declared (unprefixed)
names; patterns are forbidden by the pin. The host validates the observed
`server/tool` event identity against the declaration set.
`message_tool_calls.provider_wire_name` records the declared MCP name for
every ChatTools call; a null wire name for an MCP call is a defect.

Tool schemas are mechanically projected from `CHAT_TOOL_DECLARATIONS`. A call
executes through `ChatStepRuntime`/`ToolExecutor` and existing
`message_tool_calls`; success returns one canonical JSON/citation receipt,
declared failure returns MCP `isError=true`, and protocol failure remains a
transport failure. No second tool table or executor is allowed.

### Product API

Hard-cut `GET /llm-profiles` to exactly three ordered chat presets: `fast`,
`balanced`, `deep`. The response envelope stays
`{default_profile_id, profiles[]}` with `default_profile_id = "balanced"`;
the browser continues to own no default. Each row contains exactly `id`,
`label`, `description`, `model_label`, and the new display-only
`effort_label`. Remove `provider_label`, privacy variants,
`reasoning_options`, and `default_reasoning_option_id`. The picker becomes a
three-option control that renders `label` as the option and `description` +
`model_label · effort_label` as its secondary line; the effort `Select` is
deleted with `reasoning_options`, and `ChatProfileSelection` collapses to
`{profileId}` with availability resolution collapsing to “unknown id falls
back to `balanced`”.

The selected profile is product intent. `model_label`/`effort_label` are
honest presentation of the fixed plan behind each preset — there are only
three and they never vary — while the authoritative executed plan, revision,
and fingerprints come from the generation ledger. The `LlmProfile` doc comment
in `apps/web/src/lib/conversations/types.ts` is updated accordingly.

`POST /chat-runs` accepts `profile_id` and no other selection field.
`POST /messages/{id}/rerun` and `/regenerate` keep their no-selection bodies
and continue to inherit the source run's `profile_id` verbatim; they never
accept or remap a profile. Remove `reasoning_option_id` from request,
response, SSE meta, browser state, and database snapshots; remove `provider`
and `total_cost_usd_micros` from `ChatRunOut`, `TrustRunOut`, and the
assistant details surface, and drop the `chat_runs.provider` column. The
trust trail's run block shows `profile_id`, `plan_id`/revision, `model_name`,
`reasoning_effort`, and usage only — an operator-subscription run has no
price.

Rerun/regenerate eligibility is recut onto the plan: a source run is eligible
only when its recorded `plan_id`+`plan_revision` equal what its `profile_id`
resolves to today, plus the unchanged terminal-code and no-write-tool-attempt
guards. `profile_selection_active`'s reasoning/provider comparison and the
`llm_calls.provider` ledger-drift probe are deleted; the drift guard compares
the recorded `plan_id`/revision against the active policy through an
`llm_ledger` accessor, never raw SQL. The cutover bumps every plan revision,
so no pre-migration run is rerunnable or regenerable; the actions are absent,
not failing. Historical messages remain readable.

The chat failure card union is recut with the §7 terminal union. Exactly:
`Cancelled` → `cancelled`; owner-side context admission → `context_too_large`
(never rerunnable); `Failed(invalid_output)` → `invalid_output`;
`Failed(timeout | output_limit)` → `incomplete`;
`Failed(auth | quota | capacity_unavailable | runtime_unavailable)` →
`assistant_unavailable`; `Failed(policy_violation)` and defects surface as the
operator defect card. `refused`, `budget_exceeded`, `rate_limited`,
`provider_unavailable`, `stream_interrupted`, `invalid_tool_arguments`,
`timeout`, and the `attempts` field are deleted with provider retry; there is
no tool-failure card because a declared tool failure never terminates a run.
Conditionally rerunnable = {`incomplete`, `cancelled`,
`assistant_unavailable`} under the unchanged guards; the browser's exhaustive
copy switch is recut in the same change.

The chat draft storage key is versioned in the same change (`nx_chat_draft:` →
`nx_chat_draft.v2:`); pre-cutover records are unreadable and simply absent,
and no persisted send command from the old request shape is ever replayed. The
strict codec gains no old-shape decoder.

## 7. Durability, failures, and persistence

Generalize `llm_calls`; remove `agent_turns` and its writer. The single ledger
keeps `agent_turn_ledger`'s transaction model, not `llm_ledger`'s: the start
row is STAGED in the caller's lease-fenced dispatch transaction and becomes
durable only when the `Uncertain` checkpoint commits, so an incomplete row can
exist only if dispatch was actually armed. The terminal is staged in the
caller's checkpoint transaction. Both paths take the advisory owner lock
FIRST, before any domain or queue row lock; `llm_ledger`'s current
self-committing `start_call`/`terminalize` sessions are deleted, not extended.
Final rows record:

```text
id; owner_kind/id; generation_seq; operation; plan_id/revision (covering the
admitted model bounds); backend=codex; transport=sdk;
auth_profile=codex-personal; model_name; reasoning_effort; capability_kind;
request/output-schema/tool-plan fingerprints; streaming; session_ref;
outcome; error_code from the closed Failed narrowing; error_detail (bounded,
redacted); normalized usage; SDK/runtime versions; latency;
created/accepted/completed timestamps
```

There is no estimated dollar cost, provider attempt trace, token reservation,
synthetic subscription price, `payer_kind`, or `error_origin`:
`auth_profile=codex-personal` is the sole payer fact, one backend has one
origin, and `chat_runs.error_origin` is dropped with its per-code origin
allowlists. The plan revision replaces the old provider registry revision as
the admission-bound provenance. Raw prompts, outputs, grants, credentials, and
provider diagnostics are never ledger data.

The row keeps its lifecycle invariants: usage is wholly absent or carries all
core totals; `session_ref`, `sdk_version`, and `runtime_version` are absent
only for a pre-accept failed terminal; a terminal may not change the
backend/transport/auth route recorded at start; and terminal facts are never
partially persisted. `generation_seq` keeps the existing per-owner ordering
semantics and the chat step-path correspondence
(`generation/<generation_seq>/…`); the rerun drift guard and the chat
reconciliation lookup are re-cut in the same change so no reader is left
querying a removed column. `owner_kind` is a closed vocabulary and the
migration extends it to exactly the owners the §3 catalog can produce —
`chat_run`, `oracle_reading`, `artifact_build`, `artifact_learn_request`,
`media_summary`, `synapse_scan`, `dawn_write`, and the re-admitted
`media_enrichment` (0216 removed it) — no more, no fewer. A ledger row whose
`operation` is not in the catalog, or whose `owner_kind` is not admitted for
that operation, is rejected.

The terminal union is closed: `Succeeded | Cancelled | Failed`. There is no
`Refused` or `Incomplete` constructor: the pinned agent terminal has no
refusal or truncation status, and a refusal-shaped final text is `Succeeded`
content, never a terminal kind. Provider-lane `Refused`/`Incomplete` decoders
are deleted. This union is the ledger's normalized outcome, not the wire
terminal: the wire keeps v1's `succeeded | failed | cancelled` statuses plus
typed failure kinds, and the execution owner derives the outcome
deterministically from the derivation table shipped in the contract module.
`Failed` narrows to exactly the host's typed causes:

```text
credential_unavailable | credential_rejected      -> auth
quota_exhausted                                   -> quota
turn_timeout                                      -> timeout
output_limit_exceeded                             -> output_limit
output_schema_violation                           -> invalid_output
policy_violation | approval_unanswered            -> policy_violation
executable_unavailable | sdk_unavailable
  | session_unavailable | backend_failed          -> runtime_unavailable
capacity_unavailable (bounded wait exhausted)     -> capacity_unavailable
owner-side context admission (before dispatch)    -> context_too_large
invalid_request | runtime_defect                  -> defect, never a product
                                                     terminal
```

Model unavailability is not separable on this lane; it surfaces as
`runtime_unavailable` with bounded redacted diagnostics and is diagnosed
operationally, never branched on. A declared tool failure is in-band model
feedback (MCP `isError=true`), never a generation terminal. The complete
`policy_violation` producer set is: a Codex built-in tool invocation, an
approval event, an unadmitted resource scope, or an MCP authorization
failure. An undeclared tool NAME at the MCP boundary is a declared rejection
that continues the generation (§3), and an MCP protocol failure is
`runtime_unavailable`. Unknown SDK/protocol
failures are defects; ambiguity is durable `Uncertain`, not a fabricated
terminal.

Every domain classification keyed to the old outcome vocabulary is re-cut in
the same change: `synapse._TRANSIENT_SCAN_CODES` is re-cut to the transient
members of the new narrowing (capacity/runtime unavailable, quota);
`DossierBuildFailureCode` drops `ProviderRefused`, `ProviderIncomplete`, and
`BudgetExceeded` in favour of the new codes; historical
`artifact_build_failures` rows stay readable and are never rewritten.
`ExpectedChatFailure` is re-cut per §6: the transient variants and their
`attempts` field, `BudgetExceededChatFailure`, and
`InvalidToolArgumentsChatFailure` are deleted; rerun eligibility keys on the
new codes only.

Replay state is `Prepared | Uncertain | Completed` in the existing durable
owner journal:

- `Prepared` may dispatch once.
- Commit `Uncertain` immediately before UDS dispatch.
- `synapse`, `dawn_write`, and `oracle` currently dispatch under a per-attempt
  `uuid4()` (oracle under its reading id) with no journal; the cutover gives
  each a stable, payload-derived generation id and the same
  `Prepared | Uncertain | Completed` checkpoint before it may reach the host.
- A proven pre-accept host capacity refusal (§6's exact 503) may return the
  same generation to `Prepared`. Metadata's bounded capacity wait is
  generalized into one owner in the generation service: a per-operation
  bounded wait schedule plus a `capacity_wait_index` in the durable owner
  journal, replacing `tasks/enrich_metadata.py`'s local copy. Background
  operations use the `30/60/120/300/600` schedule; chat uses the short
  interactive schedule of §3, whose exhaustion surfaces the visible
  `capacity_unavailable` terminal rather than a long silent wait. Each refusal
  increments the index in the same lease-fenced mutation that restores
  `Prepared`. Shared replay codecs still gain no capacity-specific branch. The
  cutover migration initializes `capacity_wait_index` to zero in every
  generation-bearing job payload, not only `enrich_metadata`'s.
- After host acceptance, transport loss, host crash, timeout without a proven
  terminal, or ambiguous MCP/tool completion remains `Uncertain` and is never
  automatically redispatched. The only automatic returns to `Prepared` are the
  proven pre-accept capacity refusal and the existing verified lease-recovery
  of a `ReDispatchable` tool position whose dispatch is proven abandoned;
  every `BilledOnce` position stays `Uncertain` until reconciled.
- An `Uncertain` generation is discharged only by the existing operator
  reconciliation seam: `ProveNotDispatched` returns it to `Prepared` when
  non-dispatch is proven from host evidence, and `AttachReconciledResult`
  attaches a strictly decoded terminal when the turn is proven to have
  completed. The seam covers every catalog operation after the cutover; there
  is no automatic path.
- `Completed` replay reuses the recorded terminal and republishes only through
  the domain owner's idempotent path.
- The MCP client and Nexus add no tool-call retry. Exact duplicate protocol
  requests replay through the existing tool journal. The durable tool journal
  at tool-call position replaces the old per-iteration `turn/{i}/generation`
  steps as the replay unit; one generation records one `llm_calls` row.

The host's existing-VPS envelope is re-qualified for the widest plan before
promotion: re-run `deploy/hetzner/prove-codex-capacity.sh` with one
`deep`/Sol-high chat turn holding an open MCP session in addition to the
metadata turns, asserting `memory.peak <= 320 MiB`, no OOM, PSI within the
committed thresholds, and file-descriptor headroom. If the widest plan does
not fit, raise `memory.max`, `_EXPECTED_MEMORY_MAX_BYTES`, and the compose
limits together in this cutover — never relax the admission predicate.

The irreversible migration runs in a maintenance window. A SELECT-only
preflight refuses, by name: `background_jobs` rows in `pending|running|failed`
for every generation kind; any `chat_runs` not in `complete|error|cancelled`;
any `artifact_builds` with no revision/failure/cancellation; any media
enrichment intent mid-flight; and any journaled step in `Uncertain`. Dead
(Suspended) rows are refused until the operator terminalizes them through the
existing paths — `reconcile_uncertain_build`/`ProveNotDispatched`/
`AttachReconciledResult` for dossiers, user Cancel for chat — which the
runbook states as the pre-window drain. The migration deletes every existing
`llm_calls` row before creating the final ledger shape and drops
`agent_turns` — both are execution audit, not domain state, and no historical
row can honestly carry the new plan/fingerprint facts; no row is fabricated,
backfilled, or decoded. It removes the chat selection columns
`chat_runs.reasoning_option_id` and `chat_runs.provider` (keeping
`profile_id`, `model_name`, `reasoning_effort` as the resolved-plan snapshot),
and proves no `background_jobs.payload.coordination[*]` record carrying an old
`GenerateIntentState` or `ContinuationState` remains dispatchable — journal
payloads are drained by the active-work refusal, never decoded or rewritten; a
surviving payload is a migration refusal, not a compatibility case. Domain
outputs and chat messages are preserved. Historical execution audit is
available only from the verified pre-migration backup; runtime code does not
decode old rows. Restoring from the operator's pre-migration backup is the
only downgrade; taking and verifying that backup is a runbook precondition of
the maintenance window, not a repository acceptance criterion
(`docs/local-rules/testing-standards.md`, production backup scope).

## 8. Non-overlapping implementation boundaries

| Work package | Sole ownership | Primary files | Depends on |
|---|---|---|---|
| A. Policy/contracts | plans, mappings, bounds, intents, strict wire unions, eval corpus, error family | `python/nexus/services/llm_profiles.py` -> `python/nexus/services/generation_policy.py`; `python/nexus/services/llm_intent_state.py`, `python/nexus/services/native_agent_contract.py` -> `python/nexus/services/{generation_intent,codex_generation_contract}.py`; `python/nexus/services/structured_synthesis.py`; `python/nexus/schemas/llm.py` (profile + failure unions, including the §6 card recut consumed by E and F); `python/nexus/errors.py` | none |
| B. Host | UDS v2, SDK lifecycle, capability lowering, secret resolver, isolation | `apps/codex_agent/**`; `python/nexus/services/native_agent_client.py` -> `codex_generation_client.py`; `python/nexus/services/native_agent_operations.py` -> `codex_generation_operations.py` (host-side lowering + fingerprint) | A |
| C. Execution/ledger | dispatch, uncertainty, capacity wait, one ledger, credentials, migration, durable journals for journal-less operations | `python/nexus/services/{llm_execution,llm_ledger,llm_outcomes,llm_credentials,semantic_chunks,rate_limit}.py`; `python/nexus/services/search/embedding.py`; `python/nexus/tasks/llm_task.py`; the `LlmTaskSpec` dispatch/journal seam in every `python/nexus/tasks/*` caller (the task files themselves stay with D and E); `python/nexus/api/deps.py`; `python/nexus/api/routes/dossiers.py` (learn dispatch); `python/nexus/app.py`; `python/nexus/jobs/process_executor.py`; `python/nexus/db/models.py`; new migration; delete `python/nexus/services/agent_turn_ledger.py`; journal/identity seams in `python/nexus/services/{synapse,dawn_write,oracle}.py` (prompts/evidence stay with D) | A |
| D. Operation adapters | prompts, evidence, output validation/publication, failure-code recuts | `python/nexus/services/{media_intelligence,synapse,dawn_write,oracle,metadata_enrichment,metadata_dispatch}.py`; `python/nexus/services/artifacts/**`; `python/nexus/tasks/{enrich_metadata,media_unit_build,synapse_scan,dawn_write,oracle_reading,artifacts}.py` | A, C, E |
| E. Chat/MCP/tools | grant, MCP transport + worker listener, canonical executor bridge, chat transcript/stream, chat failure recut | `python/nexus/services/{chat_runs,chat_run_tools,chat_run_steps,chat_run_usage,chat_run_validation,chat_run_response,chat_failure,message_trust_trails,chat_prompt,context_assembler,conversations}.py`; `python/nexus/services/tool_runtime/**`; `python/nexus/tasks/chat_run.py`; new `python/nexus/services/{agent_tool_grants,agent_tools_mcp}.py`; `python/nexus/auth/middleware.py` (assert-untouched proof only); `python/nexus/config.py`; `apps/web/src/lib/conversations/types.ts`; `python/pyproject.toml`, `python/uv.lock` | A, B, C |
| F. Product/operations | profile API/UI, deployment, canaries, docs | `python/nexus/api/routes/{llm_profiles,chat_runs}.py`; `python/nexus/schemas/conversation.py`; `python/nexus/services/chat_run_candidates.py`; `apps/web/src/components/chat/**` (incl. `ChatProfilePicker.tsx`); `apps/web/src/lib/conversations/**` (incl. `chatProfileSelection.ts`); `apps/web/src/lib/api/sse/{requests,events}.ts`; versioned chat-draft storage key; `docker/Dockerfile.backend`; `deploy/hetzner/{docker-compose.yml,release.py,sync-env.sh,prove-codex-capacity.sh,Caddyfile,nexus-codex-agent-host.apparmor}`; `deploy/vercel/sync-env.sh`; `deploy/env/env-prod-backend.example`; `.env.example`; `.github/workflows/{release.yml,codex-personal-nightly.yml}`; `docs/modules/{llms,chat,jobs}.md`; `docs/runbooks/codex-personal-agent-host.md` | B-E |
| G. Proof portfolio and test control | failing proofs, lanes, capabilities, routing, evidence schema, proof/fault registry | only files under `python/tests/**`, `testdata/**` (incl. `testdata/proofs.json`, `testdata/faults/manifest.json` and patches), `python/nexus_test_control/**` (registry digests included), and `python/nexus/ops/codex_hosted_evidence.py`; the affected rows and `nexus-test-routing-sha256` in `docs/local-rules/testing-standards.md` | A-F |

A lands first. B and C may then proceed in parallel. E follows B and C. D
follows C and E. F closes the cutover. G writes each package's failing proof
before that package's implementation and owns no production edits. No package
edits another package's owner without handing that file to the owner. The
production switch is atomic after all packages are green.

Table laws:

- The primary-files column is exhaustive for this cutover; a file discovered
  mid-implementation is handed to a package before it is edited. Every module
  importing the generation core belongs to exactly one package.
- A performs the §6 profile-schema cut in `schemas/llm.py` when it lands; F
  owns the route and browser wiring and consumes A's schema without redefining
  labels.
- The single migration is authored by C but merges last: F removes every
  `reasoning_option_id` and resolved-`provider` writer, reader, and wire field
  first, and the chat-selection-column drop is the migration's final step. C's
  package is green against the pre-drop schema.
- Proof-manifest ownership moves with the code: a package that deletes or
  renames a file listed in `testdata/proofs.json` or
  `testdata/faults/manifest.json` lands the corresponding registry edit in the
  same change under G's review, and G recomputes
  `PRIORITY_RISK_OWNERSHIP_SHA256` in `python/nexus_test_control/model.py`
  with it. No package may leave the registries naming a path it deleted.
- C raises `lease_seconds` where a §3 turn bound's derived deadline plus
  checkpoint margin no longer fits: `oracle_reading_generate` and
  `media_unit_build` to 450, `dawn_write_job` to 900 (the sweep's lease covers
  the population; 180 s bounds one user's generation), and `chat_run` to 1200
  (chat's derived deadline is 90 + 900 + 30 + 15 = 1035). `synapse_scan` and
  `enrich_metadata` keep 300 (turn 120 → deadline 255, the proven margin);
  `dossier_build` keeps 900 (thorough turn 300 → deadline 435).
- `worker-interactive` mounts `nexus_codex_run:/run/nexus-codex:ro` and sets
  `NEXUS_CODEX_AGENT_SOCKET` exactly as `worker-background` does; both worker
  lanes are start-ordered after `nexus-codex-agent-host` without a health
  dependency, so an unready host soft-fails only generation jobs.
- The Codex host reaches the MCP origin as public egress only; F amends
  `deploy/hetzner/docker-compose.yml` and `deploy/hetzner/Caddyfile` in the
  same change so `/internal/agent-tools/mcp` routes to the interactive
  worker's listener and nothing else changes route.

Deletion manifest for the final refactor:

- `provider_credentials()` and every non-embedding caller; all non-OpenAI
  generation key requirements; `semantic_chunks.py` constructs its embedding
  runtime from `embedding_credential()` alone;
- all Anthropic/Gemini/Moonshot/DeepSeek chat profiles and provider
  certification fixtures; `Capability.PROVIDER_CERTIFICATION`,
  `Workflow.RELEASE`'s certification requirement,
  `NEXUS_PROVIDER_CERTIFICATION` in `.github/workflows/release.yml` and
  `policy.py` ownership tokens, `python/tests/hosted/release/`,
  `python/tests/hosted/nightly/test_openai_canary.py`, and the empty
  `python/tests/live_providers/` — `release` keeps the Android device/signed
  proof and artifact gate and certifies no generation provider;
- provider retry modes — `oracle`, `synapse`, and `dawn_write` run today under
  `ProviderRetryMode.Default` and lose in-call retry; pre-accept transient
  failure is recovered only by the queue's existing job retry against a
  `Prepared` generation, and never after acceptance — plus provider
  continuation/lowering and direct-generation runtime composition;
- the `token_budget_reservations` and `token_budget_daily_usage` tables and
  every reserve/commit/release/check token-budget function in `rate_limit.py`;
  `AdmissionDenied` and the ledger's admission branch; `terminal_cost_facts`,
  `attempt_trace_facts` and the cost/attempt ledger columns;
  `_check_entitlement`/`can_use_platform_llm` on the generation path (the
  operator-paid subscription is the billing model; there is no AI tier to
  gate); `billing.py`'s token-usage read. The subscription is the quota and
  `Failed(quota)` is its only signal — post-hoc-only quota visibility is the
  accepted §1 trade. RETAINED: `RateLimiter.acquire_inflight_slot`
  (concurrency, not price — the app-side counterpart of the host's single turn
  slot) and `prompt_budget.py` (context-assembly admission, not billing);
- the trust-trail cost surface end to end — `message_trust_trails` cost
  aggregation, `TrustRunOut.total_cost_usd_micros`, its browser type, and the
  `AssistantDetails` cost row; the subscription has no per-run price and the
  trail must not display one;
- `DossierBinding.reasoning` and every per-binding effort override in
  `services/artifacts/bindings/**`, and every
  `profile.default_reasoning_option_id` read in `media_intelligence.py`,
  `oracle.py`, `synapse.py`, and `dawn_write.py`; effort comes only from the
  operation's plan;
- the `NEXUS_FABLE_RETENTION_ACCEPTED_AT` deployment assertion and its
  `config.py` startup requirement, env examples, sync scripts,
  release-workflow input, and test-control protection lists; subscription
  retention posture is a runbook fact, not a startup gate;
- per-operation output-token cap settings
  (`METADATA_ENRICHMENT_MAX_OUTPUT_TOKENS`-style) and the provider-lane
  `Refused`/`Incomplete` outcome constructors and decoders;
- metadata-only native operation/ledger paths and `/v1/turns`; the thirteen
  `E_METADATA_AGENT_*` codes and `E_METADATA_NO_FIELDS` — one generalized
  `E_GENERATION_*` family mirrors the closed `Failed` narrowing for every
  operation;
- browser reasoning selector and every `reasoning_option_id` branch, the
  deleted chat failure codes and `attempts` field, and the `chat_runs.provider`
  column;
- metadata-named fault patches whose contract is retired
  (`durable-codex-metadata-*`); every non-metadata codex fault — capacity
  admission, state encryption, diagnostic retention, canary output validation,
  operation-revision shadow, hosted-evidence bound — is retained and
  re-pointed at its successor proof node in the same change. Every deleted
  priority-risk proof names its replacement node and risk id in the same
  change; no fault may reference a deleted node. Re-target
  `python/tests/evals/cases/tool_safety.v3.json` and its eval at the Codex/MCP
  surface, and update the `llm-tool-safety` capability list in
  `testdata/proofs.json` in the same change that deletes the direct hosted
  canary;
- obsolete tests, module text, runbook sections, and both superseded cutover
  authorities (`docs/cutovers/codex-personal-metadata-hard-cutover.md`,
  `docs/cutovers/llm-provider-runtime-hard-cutover.md`), plus the affected
  module and runbook text: `docs/modules/llms.md`, `docs/modules/chat.md`,
  `docs/architecture.md`, `docs/runbooks/codex-personal-agent-host.md`, and
  the affected `docs/local-rules/testing-standards.md` rows. Update or delete;
  do not mark “legacy.”

## 9. Red / green / refactor and proof shape

Follow `docs/local-rules/testing-standards.md` and expose every lane only
through `./scripts/test`. Tests assert behavior, not implementation; owned
service code is real. External Codex/MCP protocol peers may be deterministic
fakes only as test-owned processes behind the production client at a
controller-owned loopback or UDS endpoint. A fake is never more permissive
than the real peer: it enforces the same frame/stream bounds, the same closed
event union, the same rejection of undeclared tools and unknown fields, and is
exercised by the same conformance cases as the pinned real adapter. Product
code contains no fixture mode, flag, or branch.

Levels are the typed capabilities `kernel-python`, `kernel-web`, `service`,
`component`, `migrations`, `llm-eval`, `codex-hosted`; the host proof is an
owned real-UDS process under `python/tests/service/`, not a separate level.

| Ownership boundary | One dominant proof | Level / lane |
|---|---|---|
| Policy | every operation and three chat profiles resolve to one exact complete plan with bounds; arbitrary model/effort is unrepresentable; a plan-table edit without a matching eval result fails | kernel-python / PR |
| Plan policy eval | corpus version, baselines, and pins match the shipped policy revision | llm-eval / FULL |
| Intent + wire algebra | strict tagged round trip; unknown fields/revisions/operations/events and a missing terminal are rejected | kernel-python / PR |
| UDS transport | bounded NDJSON, contiguous sequence, terminal-last, capability gating, per-capability frame budgets; synthesis rejects tool events | service / PR |
| Host lifecycle | one session/turn, correct auth root, built-ins off, exact MCP config/headers, cancel endpoint, cleanup on every terminal | service / PR |
| Host contention | a background dispatch behind a full-length chat turn reschedules within budget, never hard-fails; a chat dispatch against a busy host surfaces `capacity_unavailable` with rerun; an interactive-lane dispatch reaches the host socket | service / PR |
| Execution + ledger | real Postgres and the real worker process prove dispatch-once, completed replay, pre-accept reschedule, accepted-loss uncertainty, and exactly one ledger row, with the Codex peer as a protocol-valid loopback process behind the production client | service / PR |
| Journal coverage | every catalog operation checkpoints `Uncertain` before dispatch and refuses a second dispatch under a replayed identity | service / PR |
| Uncertainty discharge | reconciliation returns an uncertain generation to `Prepared` or attaches a proven terminal; neither path double-publishes | service / PR |
| Operation portfolio | parameterized catalog proves every operation renders a valid intent/schema within its bounds, cannot choose runtime policy, and publishes in one serializable transaction opened only after the durable terminal | kernel-python + service / PR |
| Bounds | the ChatTools bounds admit a maximal admitted transcript and a maximal streamed 900-second turn; overrun is the typed `output_limit_exceeded` terminal | service / PR |
| MCP authority + tools | real Postgres and local MCP transport prove one read and one reversible write; expired/cross-user/cross-run/cross-session grants fail; an exact protocol replay at the same identity returns the journaled receipt without re-executing, and a changed payload at that identity defects | service / PR |
| MCP exposure | a grantless or invalid-grant request to `/internal/agent-tools/mcp` is rejected without tool execution; the grant is accepted only at this mount; no other path changes route or gains an exemption | service / PR |
| Secret and capability confinement | the grant never appears in repr, logs, ledger rows, fingerprints, or evidence; built-ins/web search stay off; ChatTools lowering is exactly §5's | service / PR |
| Tool-authority containment | injected resource text, forged tool results, and cross-account requests cannot authorize a mutating MCP tool; deterministic corpus and rubric | llm-eval + service / PR |
| Chat tool budget + cancellation | the call after budget exhaustion is refused as a declared failure; a cancel during an in-flight tool call ends the run `Cancelled` with no further effect | service / PR |
| Chat profile API | real FastAPI returns exactly three ordered presets, `balanced` default, and rejects `reasoning_option_id` | service / PR |
| Chat product surface | real Chromium over a schema-valid fetch/SSE boundary proves preset selection, profile-only request body, streaming, citation, undo, cancel-to-`Cancelled`, rerun/regenerate inheriting the source profile with every pre-cutover run ineligible, and exhaustive rendering of the recut failure-card union | component / PR |
| Migration | real Postgres proves exact final schema, domain preservation, refusal of incompatible active state, the admitted `owner_kind` enumeration, runtime refusal to construct any pre-cutover intent shape | migrations / PR |
| Subscription reality | one turn for each of four unique plan pairs; suite includes text, strict JSON, and read-only MCP; bounded redacted receipt | `codex-nightly` |

RED: write the table's proofs first. Register one reviewed fault patch in
`testdata/faults/manifest.json` for each critical boundary — policy,
accepted-loss replay, grant scope, grant/diagnostic redaction, capability
lowering, migration admission — each naming its canonical node, its patch
SHA-256, and its exact expected failure, and demonstrate it with
`./scripts/test prove --proof <node> --against fault:<id>`.
`./scripts/test pr` additionally demands same-run red/green for every changed
proof owner and requires a clean committed checkout. Each dominant proof is
registered as one canonical node under its existing priority risk; one
physical file has one owning risk and at most one exact node.

GREEN: implement the smallest owner that makes each proof pass; use no live
provider in PR lanes.

REFACTOR: atomically switch every caller, delete all superseded owners/config/
docs, then run the `changed`, `confidence`, and `pr` workflows selected by
`./scripts/test`.

Live verification is deliberately two-shaped:

- Nightly: unique inference plans, strict JSON, and read-only MCP health. This
  detects auth, quota, model/effort, SDK/runtime, sandbox, and tool-protocol
  drift cheaply. The nightly owner becomes
  `python/tests/hosted/nightly/test_codex_personal_generation.py`; its receipt
  is `nexus-hosted-codex-canary.v2` with exactly four results, one per unique
  plan pair, each carrying plan id, model, effort, structured-output validity,
  usage, and SDK/runtime versions; `permission_requests == 0` in every result;
  `tool_events == 0` for synthesis results and bounded, non-zero only for the
  read-only MCP result. Exactly four subscription turns per run, each with a
  bounded elapsed ceiling, recorded in the receipt and enforced by the
  evidence contract; exceeding the declared turn or time budget fails the
  lane. The nightly's MCP peer is test-owned: the same pinned MCP SDK's
  Streamable HTTP app, served by the proof at a loopback origin with locally
  terminated TLS and one static read-only tool. The runner gains no database,
  Docker authority, or Nexus process; its credential-boundary provisioning is
  unchanged. Drift in the Nexus-side MCP mount, authorization, and tool
  bridge stays owned by the PR-level service proofs. The controller's
  exact-node pin, selection route, evidence validator, the `codex-nightly`
  row and `nexus-test-routing-sha256` in
  `docs/local-rules/testing-standards.md`, and the workflow's policy-pinned
  lines change in the same commit.
- Operator certification: a scripted, evidence-writing certification command
  executed on the enrolled subscription host after deployment — one synthetic
  fixture per canonical operation plus one reversible chat write and its undo,
  against a dedicated synthetic user with normal teardown. The command, not
  the operator, validates terminal status, plan/revision identity, and
  redaction, and writes bounded redacted machine-checked evidence (the
  `prove-codex-capacity.sh` pattern). It tests operations, not every
  operation × model × effort combination. It is not a `./scripts/test` lane
  and not a release-workflow gate.

Plan qualification precedes the production switch: `./scripts/test
codex-nightly` must pass all four plan pairs at the candidate revision, and
its evidence (model, effort, terminal, usage, versions) is a required input to
the atomic switch — not merely ongoing drift detection. The capacity canary
moves to the v2 generation command; `deploy/hetzner/prove-codex-capacity.sh
<source-sha>` is re-run for the cutover SHA against the heaviest admitted plan
before the first promotion, and its contract proof and registered fault are
re-authored with it.

Missing required live infrastructure, flags, or state roots is `not_run`. The
controller additionally probes subscription readiness on the enrolled state
root before dispatch and reports `not_run` when the account is
unauthenticated — this probe is new work owned by package G. Live proof is
never green and never skipped when a precondition fails. Evidence contains
identifiers, exact plan/revisions, timings, usage, and terminal status only —
no prompts, model output, grants, or credentials.

## 10. Acceptance criteria

1. Every generative entrypoint in §3 — including the interactive-lane job
   kinds and the request-scoped learn route — reaches `codex-personal`
   through the one generation boundary and exact plan; no direct generation
   HTTP call remains.
2. The only product choices are Fast/Luna-low, Balanced/Terra-medium, and
   Deep/Sol-high; background callers cannot override policy, and no
   per-binding or per-profile effort override survives.
3. Metadata uses the same intent, UDS, execution, failure, and ledger contracts
   as every other generation; no metadata-special runtime survives.
4. Synthesis has zero model tools. Chat sees only the canonical Nexus MCP tool
   set; host-planned retrieval behavior is unchanged.
5. Each MCP call is run-scoped, lease-fenced, owner-authorized, bounded,
   auditable, replay-safe at its protocol identity, and executed by the
   existing `ToolExecutor` in the lease-holding worker process.
6. No accepted ambiguous generation or externally effectful tool result is
   automatically repeated. The only automatic returns to `Prepared` are a
   proven pre-accept host capacity refusal and the existing verified
   lease-recovery of a `ReDispatchable` tool position whose dispatch is proven
   abandoned; every `BilledOnce` position stays `Uncertain` until an operator
   reconciles it.
7. The credential host has no DB, no provider API key, no ambient operator
   profile, no writable path outside its per-turn tmpfs cwd, and no egress
   beyond the container-enforced ChatGPT + MCP allowlist.
8. Under the profile-only contract: streamed text arrives incrementally and
   reconnect folds to the same final content; every tool receipt yields the
   same citation ordinals as today; tool status projects start/complete for
   each MCP call; one reversible write is undone through the existing
   endpoint; a cancel during a tool call terminates the run with no further
   effect; rerun and regenerate produce a new run with the same `profile_id`
   and no `reasoning_option_id` anywhere in request, SSE, or snapshot.
9. Transcription, Brave retrieval, deterministic authors, and abstract
   projection are unchanged; embeddings are behaviorally unchanged and depend
   on no generation credential. Brave keeps its provider, binding, and result
   contract: the idea-dossier `HostTable` loop is untouched, and chat's
   `web.search` executes through the same `ToolExecutor` binding, now reached
   over MCP.
10. The PR proofs, migration proof, and four-plan nightly smoke pass with
    redacted bounded evidence; fresh (<72 h) codex-capacity evidence exists
    for the shipped source SHA; and recorded per-operation
    operator-certification evidence exists after deployment.
11. Old providers, ledgers, schemas, configs, tests, docs, fallbacks, and dead
    dependencies are absent from the active tree, proved by the type checker,
    the import graph, and the closed policy/plan proofs — never by a committed
    source-grep test. The integrator's one-time deletion-manifest search is
    release evidence recorded in the change report, not a retained test.
    `provider-runtime` remains pinned — it owns embeddings, `AgentRuntime`,
    and the Codex SDK extra — and the deletion applies to Nexus-side profiles,
    credential composition, certification fixtures, and any dependency no
    longer imported by the active tree.
12. The cutover migration refuses incompatible active work and has no
    downgrade or compatibility runtime.
13. Each operation's domain output, observed contributors, and collection
    revisions converge in one serializable publication transaction opened only
    after the terminal is durably recorded; no publication transaction spans
    UDS, SDK, MCP, or Brave I/O.
14. Every plan assignment in §3 cites a versioned eval result at the shipped
    policy revision.

Implementation is complete only when all fourteen criteria hold in one
release.

## 11. Authoritative references

- `docs/modules/llms.md` (rewritten by this cutover)
- `docs/modules/chat.md`, `docs/modules/jobs.md`
- `docs/runbooks/codex-personal-agent-host.md`
- `docs/rules/modules/agent-runtime.md` (guest-agent protocol; out of scope)
- `llm-calling/docs/agent-runtime.md`
- [Official Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Official Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Official model guidance](https://learn.chatgpt.com/docs/models)
- [Official MCP contract](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

This document supersedes `docs/cutovers/codex-personal-metadata-hard-cutover.md`
and `docs/cutovers/llm-provider-runtime-hard-cutover.md`, both deleted on
merge.
