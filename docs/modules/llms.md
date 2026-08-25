# LLMs

## Scope

All Nexus text and structured-output generation uses the isolated Codex
Personal host. Transcript embedding remains a separate, narrow OpenAI API
operation, and transcription remains outside this module. Product billing
does not meter or entitle generation tokens; the operator-paid ChatGPT
subscription is the generation account boundary.

The product side owns intent, policy, durable coordination, and publication.
The host owns the pinned Codex SDK/runtime session and the private Unix-socket
transport. Domain owners still build prompts, validate semantic output, and
commit their own final writes.

The primary owners are:

- `generation_policy.py`: immutable operation/profile-to-plan policy;
- `generation_intent.py`: execution-route-free instructions, input, and output;
- `codex_generation_contract.py`: closed v2 command, frame, terminal, health,
  capacity, cancel, and policy-violation contracts;
- `codex_generation_client.py`: bounded HTTP-over-UDS client;
- `codex_generation_operations.py`: host-side lowering to pinned
  `AgentRuntime` types;
- `llm_ledger.py`: the sole staged writer and typed reader for `llm_calls`;
- `apps/codex_agent/`: the one-slot generation host.

Queue ownership is documented in [jobs.md](jobs.md).

## Product profiles

`GET /llm-profiles` returns exactly these presets in this order; `balanced` is
the default:

| id | label | product description | display target |
|---|---|---|---|
| `fast` | Fast | Quick responses for everyday questions. | GPT-5.6 Luna · Low |
| `balanced` | Balanced | The default profile: strong general-purpose reasoning. | GPT-5.6 Terra · Medium |
| `deep` | Deep | Slower, deeper reasoning for hard problems. | GPT-5.6 Sol · High |

The response carries only `id`, `label`, `description`, `model_label`, and
`effort_label`. The browser sends only `profile_id`; there is no independent
route, model, or effort selector. Rerun and regenerate inherit the source
run's profile and accept no replacement selection.

`generation_policy.py` is the authority for the resolved plan. The UI labels
are presentation, not an execution instruction. Startup validates the complete
policy catalog and its pinned evaluation fingerprint.

## Operation policy

Every synthesis operation has one revision and one fixed plan. Chat has one
revision per product profile and the `ChatTools` capability. The policy also
owns instruction/input bounds, turn timeout, stream bounds, close timeout, and
the full transport deadline.

Synthesis runs read-only with network disabled, built-ins and web search off,
no MCP servers, and no tool grant. Chat runs with workspace-write,
unrestricted network, explicit unsafe-network confirmation, built-ins and web
search off, and exactly one required Streamable HTTP MCP server named `nexus`.
Its exact tool allowlist comes from the canonical chat declarations. The MCP
client/server pins are Codex SDK/CLI `0.144.4`, `mcp==2.1.0`, and wire revision
`2025-06-18`; no other protocol revision is negotiable.

## Private v2 host protocol

`CodexGenerationClient.health()` validates the exact command schema, policy
revision, SDK version, and runtime version before dispatch. `stream(command)`
performs that health check and then posts once to `/v2/generations`. The host
returns bounded NDJSON frames with a contiguous zero-based sequence and exactly
one last terminal frame.

HTTP 503 is capacity only when its status, content type, and body exactly match
the versioned capacity response. A loss before acceptance is unavailable; a
loss after HTTP acceptance is ambiguous. An accepted stream without a terminal
is never reclassified as a known failure. Cancel and policy violation are
idempotent private controls. Policy violation is monotonic and terminalizes a
matching active turn as `Failed(policy_violation)`, never `Cancelled`, whether
it arrives before or after cancellation.

The host admits one generation at a time and releases that slot only after the
runtime closes. It has no application configuration, database credential, API
key, application data mount, TCP listener, or persistent writable runtime
state beyond one exact encrypted `auth.json`. Every turn owns a tmpfs root with
separate empty `workspace/` and ephemeral `state/` directories; the profile's
auth path is an absolute link to that exact writable bind, and the complete
turn root is deleted after runtime close. This is qualified only for pinned
Codex `0.144.4` truncate/write refresh persistence; any change to that write
primitive requires redesign and release qualification. Its only
application-facing transport is `/run/nexus-codex/agent.sock`.

## Chat MCP authority

The interactive worker serves `mcp==2.1.0` as a stateless, JSON-response
Streamable HTTP app at exactly `/internal/agent-tools/mcp` on its dedicated
listener. Caddy routes only that exact path. All other traffic keeps its
existing route.

The production client is exactly `openai-codex==0.144.4` plus
`openai-codex-cli-bin==0.144.4`, speaking only MCP `2025-06-18`. Every POST
carries `Authorization: Bearer <generation grant>`,
`Content-Type: application/json`, and
`Accept: application/json, text/event-stream`. `initialize` declares
`protocolVersion: 2025-06-18` in its JSON body and omits the
`MCP-Protocol-Version` header; the mount accepts only that omission or the same
exact version on initialize. Every later POST must carry
`MCP-Protocol-Version: 2025-06-18`. Another revision, a missing later revision,
or any `Mcp-Session-Id` is rejected.

The advertised event-stream media type is a client compatibility header, not
a Nexus response mode. The server returns JSON for JSON-RPC requests and a
bodyless notification acknowledgement. It emits no session id, owns no GET
event stream, DELETE-session lifecycle, event store, resume cursor, OAuth
fallback, protocol downgrade, or dual-era path. Durable tool replay is keyed
only by the generation grant `jti` and typed JSON-RPC request id.

The host receives the public HTTPS MCP origin from deployment configuration and
admits `ChatTools` only when the deployment's explicit network attestation is
true. Each turn receives a short-lived, run/lease/generation-scoped bearer
grant signed by the dedicated `AGENT_TOOL_GRANT_SIGNING_KEY`; it never reuses a
stream token. The grant is resolved into an ephemeral header reference and is
removed with the per-turn state.

The MCP owner revalidates the live claimed job, attempt, generation, declared
tool, canonical input, and admitted resources for every call. Tool replay uses
the durable journal identity. A later authorization failure invokes the host's
policy-violation control for that active generation.

## Durable ownership and ledger

Each durable owner chooses a stable `request_id`, constructs one bounded intent,
stores its fingerprint, and uses the shared
`Prepared -> Uncertain -> Completed` journal. Raw prompts are not persisted for
repair. The owner stages the `llm_calls` start beside its `Uncertain` checkpoint
and the terminal beside `Completed`, in the same caller-owned transaction;
`llm_ledger.py` never commits.

One ledger row records the owner/generation sequence, operation, plan and policy
revision, fixed Codex route, model/effort, capability, request/output/tool
fingerprints, session reference, normalized outcome/failure, usage,
SDK/runtime versions, acceptance time, latency, and completion. It stores no
price, cost estimate, generation credential, or raw response.

An owner may redispatch only when its journal replay policy permits it. An
accepted generation that reached `Uncertain` stays suspended until
reconciliation or explicit cancellation; transport ambiguity is not automatic
retry authority. Every generation owner supports an operator's externally
established `ProveNotDispatched` decision against the exact journal/ledger
identity. Recovered-terminal attachment exists only where immutable durable
inputs can reconstruct the original command and reuse the live decoder.

## API and historical eligibility

`POST /chat-runs` accepts `destination`, `content`, `profile_id`, and
`reader_selection`. Meta SSE carries the profile snapshot but no execution
route choice. `ChatRunOut` exposes the profile plus resolved model/effort; the
trust trail additionally exposes plan id/revision, usage, and runtime audit
facts. Neither surface exposes route or cost.

Historical conversations remain readable. Rerun/regenerate eligibility is
fail-closed: a source without a post-cutover profile/plan snapshot, or whose
recorded plan id/revision no longer equals the active policy, is ineligible.
The check uses the typed ledger accessor and never probes raw ledger columns.

## Deployment invariants

- The host environment contains no `CODEX_HOME` or `OPENAI_API_KEY`.
- The API and both worker lanes mount the Codex UDS read-only and are
  start-ordered after the host without a health dependency. The API needs it
  only for request-scoped dossier idea resolution; no client receives the
  credential bind.
- Only the interactive worker listens for MCP, on `0.0.0.0:8001` inside the
  Compose network.
- The host has only the internal `nexus_codex_private` attachment. Its sole
  peer is the credential-free `codex-egress-policy` DNS/TLS-SNI sidecar; only
  that sidecar joins `nexus_codex_proxy_egress`. The release gate proves the
  exact two-network membership, fixed private addresses, DNS owner, and
  ChatGPT/auth/MCP hostname policy. TLS remains end-to-end.
- The MCP origin is HTTPS with the exact path, a lowercase public DNS hostname,
  and no userinfo, query, or fragment.
- AppArmor and the inner bwrap/seccomp proof remain release gates.

## Invariants

- One policy catalog resolves every operation and chat profile.
- One private v2 client owns transport classification and bounds.
- One host owns SDK/runtime sessions and one-slot capacity.
- One staged ledger owns generation audit.
- Domain owners alone validate and publish semantic output.
- Every generation reaches the one Codex Personal boundary.
