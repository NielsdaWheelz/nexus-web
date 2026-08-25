# LLMs

## Scope

All Nexus generation uses the isolated Codex Personal host. There is no direct
provider-generation path, BYOK, model browser, provider fallback, price
projection, provider certification, or platform-AI token entitlement.
Transcript embedding remains a separate, narrow OpenAI operation and
transcription remains outside this module.

The product side owns intent, policy, durable coordination, and publication.
The host owns the pinned Codex SDK/runtime session and the private Unix-socket
transport. Domain owners still build prompts, validate semantic output, and
commit their own final writes.

The primary owners are:

- `generation_policy.py`: immutable operation/profile-to-plan policy;
- `generation_intent.py`: provider-independent instructions, input, and output;
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
`effort_label`. The browser sends only `profile_id`; there is no provider,
model, or effort selector. Rerun and regenerate inherit the source run's
profile and accept no replacement selection.

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
Its exact tool allowlist comes from the canonical chat declarations.

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
idempotent private controls. Policy violation terminalizes a matching active
turn as `Failed(policy_violation)`, never `Cancelled`.

The host admits one generation at a time and releases that slot only after the
runtime closes. It has no application configuration, database credential, API
key, application data mount, TCP listener, or writable workspace. Its only
application-facing transport is `/run/nexus-codex/agent.sock`.

## Chat MCP authority

The interactive worker serves the official MCP SDK's stateless Streamable HTTP
app at exactly `/internal/agent-tools/mcp` on its dedicated listener. Caddy
routes only that exact path. All other traffic keeps its existing route.

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

Each durable owner chooses a stable `request_id`, snapshots its intent, and
uses the shared `Prepared -> Uncertain -> Completed` journal. The owner stages
the `llm_calls` start beside its `Uncertain` checkpoint and the terminal beside
`Completed`, in the same caller-owned transaction; `llm_ledger.py` never
commits.

One ledger row records the owner/generation sequence, operation, plan and policy
revision, fixed Codex route, model/effort, capability, request/output/tool
fingerprints, session reference, normalized outcome/failure, usage,
SDK/runtime versions, acceptance time, latency, and completion. It stores no
provider price, cost estimate, provider credential, or raw response.

An owner may redispatch only when its journal replay policy permits it. A paid
generation that reached `Uncertain` stays suspended until reconciliation or
explicit cancellation; transport ambiguity is not automatic retry authority.

## API and historical eligibility

`POST /chat-runs` accepts `destination`, `content`, `profile_id`, and
`reader_selection`. Meta SSE carries the profile snapshot but no reasoning or
provider choice. `ChatRunOut` exposes the profile plus resolved model/effort;
the trust trail additionally exposes plan id/revision, usage, and runtime audit
facts. Neither surface exposes provider or cost.

Historical conversations remain readable. Rerun/regenerate eligibility is
fail-closed: a source without a post-cutover profile/plan snapshot, or whose
recorded plan id/revision no longer equals the active policy, is ineligible.
The check uses the typed ledger accessor and never probes raw provider/model
columns.

## Deployment invariants

- The host environment contains no `CODEX_HOME` or `OPENAI_API_KEY`.
- Both worker lanes mount the Codex UDS read-only and are start-ordered after
  the host without a health dependency.
- Only the interactive worker listens for MCP, on `0.0.0.0:8001` inside the
  Compose network.
- The host remains the sole member of `nexus_codex_egress`; MCP is reached as
  ordinary public TLS egress, not through a new application-service peer.
- The MCP origin is HTTPS with the exact path, a lowercase public DNS hostname,
  and no userinfo, query, or fragment.
- AppArmor and the inner bwrap/seccomp proof remain release gates.

## Invariants

- One policy catalog resolves every operation and chat profile.
- One private v2 client owns transport classification and bounds.
- One host owns SDK/runtime sessions and one-slot capacity.
- One staged ledger owns generation audit.
- Domain owners alone validate and publish semantic output.
- There is no direct-provider generation compatibility path.
