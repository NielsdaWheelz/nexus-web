# LLMs

## Scope

Every Nexus text or structured-output generation runs through one Nexus
`GenerationService`, backed only by the two separate `llm-calling` lanes:

- Codex Personal through `AgentRuntime` and the isolated Codex host;
- configured metered APIs through `ProviderRuntime`.

The shipped developer policy selects Codex Personal for every background
operation. Chat alone lets the user choose an exact route, model, and reasoning
value for each run from the complete configured `llm-calling` catalog. There is
no generation profile, Fast/Balanced/Deep preset, user default, AI Settings
surface, fallback, or compatibility route. Embeddings and transcription remain
separate non-generation capabilities.

The product owns intent, exact selection, operation policy, tool authority,
durable coordination, and publication. `llm-calling` owns source catalog facts,
route-local lowering, provider continuations, and provider/agent protocol
events. Domain owners build prompts, accept generated output, and commit final
domain writes.

Primary owners:

- `generation_catalog.py`: composed configured catalog and readiness;
- `generation_policy.py`: one reviewed Chat seed and the total background map;
- `generation_service.py`: catalog validation, policy resolution, admission,
  and route composition;
- `generation_spec.py`: immutable admitted selection, budgets, output, and tool
  authority;
- `generation_backend.py`: route-neutral execution result;
- `native_generation.py`: shared native supervisor and durable callback adapter;
- `provider_generation_*`: ProviderRuntime adapter and continuation loop;
- `llm_execution.py` and `llm_ledger.py`: parent/child/tool lifecycle and replay;
- `tool_authority.py` and `tool_runtime/`: frozen provider-function/native-callback authority, domain handlers, and effect positions;
- `memory_client.py`: the private owner-chat client of Jarvis shared memory;
- `apps/codex_agent/`: isolated subscription-backed Codex host.

queue ownership is documented in [jobs.md](jobs.md).

## Catalog and exact selection

`GET /llm-catalog` is the only product catalog API. It composes the authenticated
Codex model catalog with `api_model_catalog()` rows for exactly the API providers
present in `GENERATION_API_PROVIDERS`. Nexus neither reads Codex cache files nor
maintains a second model/reasoning allowlist. A model exposes every reasoning
value the source catalog reports. the catalog keeps typed readiness for all
pairs; the picker offers only selectable pairs and retains an unavailable
current identity without substitution.

The strict Chat selection is one tagged value:

```text
CodexPersonalSelection(model_key, reasoning_key)
| ProviderApiSelection(model_ref, reasoning)
```

The tag prevents same-named models on different routes from aliasing. The
browser submits the exact selection plus the catalog-definition revision and
never submits dispatch strings, credentials, capabilities, defaults, or
fallback order. The developer-owned Codex Personal / GPT-6 Sol / medium
seed initializes a new composer only; it is not a saved user preference and
does not override a causal or explicit per-run selection.

Background operations resolve their exact Codex selection only from the total
source-controlled policy. Users can inspect the effective selection but cannot
edit background generation policy.

## Operation and tool policy

Every admitted run freezes one `GenerationSpec`: exact selection and dispatch
target, source/catalog/policy/backend revisions, prompt reference, conservative
budgets, output contract, timeout, host preparation, and model-tool authority.
Workers execute that snapshot and never reread mutable process policy.

Model selection does not grant tools. The operation policy independently
resolves one of:

- `NoModelTools`;
- `ChatReadAdditiveWrite` for every new chat send, rerun, and regeneration;
- `MetadataResearch`.

on provider api chat, `ExactModelTools` grants `AdditiveWrites` over
`ChatAdmittedContext`: `web.search`, five nexus reads, and five owner-gated
additive writes. dossiers publish `NoModelTools`; idea research calls the web
search provider itself before the model turn. metadata enrichment selects codex
personal and freezes exactly `web.search`, `web.read`, `nexus.document.search`,
and `nexus.resource.read`.

codex freezes `CodexCallbacks` authority using the same operation-selected
portable declarations as `ProviderFunctions`. metadata publishes exactly the four
research tools above; no-model-tool helpers publish none. chat and dossiers retain
their selected scope/effect policy. prompts cannot broaden an operation grant.

both routes execute the canonical `GenerationToolExecutor`, authority, recorder,
evidence, citation and undo boundaries. provider-function positions remain
`generation/{generation_seq}/tool/{n}`. native callbacks retain original native
turn/call identity and immutable arguments before entering an effect; their stable
position/effect identity comes from the host. a duplicate callback replays its
recorded model-facing projection and never repeats the handler. original result
facts and cited model-facing text remain separate persisted values.

Untrusted tool arguments or output cannot widen the frozen plan, principal,
scope, limits, or effect authority. There is no tool-shaped text parser,
provider-native Web search, alternate executor, or transport fallback.

## owner chat shared memory

one optional backend-only client, `nexus-owner`, connects to Jarvis's private
streamable-http MCP endpoint. its private deployment JSON names one authenticated
viewer UUID, its bearer, independent read connection and note admission, and the
explicitly authorized model processor labels. `MEMORY_CLIENT_CONFIG_PATH` names
that file; omission denies access. the file uses Nexus's closed owned-absence
encoding: `{kind:"Absent"}` or `{kind:"Present",value:{client,owner_user_id,
mcp_url,bearer,connect,admit,processors}}`. dev-server renders it from the same stopped
sharing declaration that Jarvis validates. no credential enters the browser,
model arguments, prompt, chat history or ordinary logs.

only that viewer's send, rerun and regenerate operations may select the memory
chat plan. the complete selected frozen processor chain must be declared. a
connected client gets the five memory reads; admitted notes add the optional
text-only save tool. other viewers and background operations keep their original
grants. handlers recheck the principal, chat operation and processor chain through
the existing tool-position authority, for both provider functions and native
callbacks.

the backend supplies the existing `ToolPositionRecord.id` as the save submission
UUID and the host-known conversation UUID as a caller-reported association.
Jarvis stamps the configured owner/client into the tagged Nexus note producer.
identical retries return the original receipt; conflicting reuse fails. Nexus
notes remain agent-authored, with supporting provenance, rather than fabricating
a native machine/account or archive conversation. no Nexus conversation is
automatically captured. no metadata, dossier or automated helper gains memory.

the standalone universal-memory library owns the shared input/result schemas,
tool declarations and note append contract. Nexus owns its private client,
chat admission and durable tool positions; Jarvis owns corpus admission and
server authentication. this adopts
[Jarvis adr 0067](https://github.com/NielsdaWheelz/jarvis/blob/feature/universal-memory/docs/decisions/0067-nexus-owner-chat-memory.md).
temporary synthetic real-stack checks qualify both tool transports and denied
principals/processors. private credential installation and production activation
remain separate.

the library's git repository is private. the owner approved distributing its
installed python source in nexus's existing public backend images; anonymous
digest access remains required. ci and image builders use the contents-read-only
`UNIVERSAL_MEMORY_READ_TOKEN` secret only while fetching that exact repository.
the process-scoped git helper never persists credentials or embeds them in urls,
build arguments, caches or runtime images. ordinary local dependency installs
use authenticated git.

## Backend composition

codex personal attaches to one dedicated stock 0.160.0 app-server through its
private unix socket. the host retains authentication and owns process startup;
workers own the shared kernel/native callbacks and portable executor. no shell,
exec-server, http generation bridge, bearer or worker credential mount remains.
the provider-owned restricted complete model catalogue loads at HOST STARTUP;
exact public version/config preflight rejects unsupported hosts before thread
creation. inherited clock, CodeMode and native user-input are removed. declared
callbacks, strict json and read-only/no-network session containment qualify together.
see [the native host runbook](../runbooks/codex-personal-agent-host.md).

completed commentary persists before bounded chat progress delivery. only the
original sealed native final supplies product terminal output. control/fence/cleanup
facts cannot become native seals or replace original failure/usage. invalid callback
arguments remain raw rejected evidence, without handler entry.
decoded nul (`U+0000`) in callback arguments, keys or model-turn evidence is the
approved exception: postgres jsonb cannot preserve it. reject it before sql or
tool entry with a content-free defect, leave the chat incomplete and retain no
sanitized replacement or ordinary rejected-call receipt. recovery cannot infer
a completed call from that absence. worker logs retain only the error class and
closed code, without argument text, sql diagnostics or exception chains.

Provider API execution uses `ProviderRuntime` with the selected configured
credential. Each independently accepted provider call is a child model turn.
Tool proposals are executed only after durable admission; the sealed,
target-bound continuation advances only after the child terminal and tool
result are persisted. Nexus stores the library's complete opaque native
continuation rather than reconstructing assistant text or provider history.
Unsupported strict-output-plus-tool combinations are
ineligible at catalog qualification rather than silently losing strictness or
tools.

Both lanes project into the route-neutral `GenerationEvent` family without
importing one another. No cross-lane dispatcher shares credentials or protocol
state.

## Durable ownership and replay

One parent generation row records the frozen spec and terminal truth. One child
row records each independently accepted model call: normally one for Codex and
one per ProviderRuntime call in an API tool loop. tool positions belong to that
execution ledger. completed additive writes also commit independent effect
receipts and target authorship in the same transaction. receipts retain the
original principal, effect identity, result and undo state after history reset
or conversation deletion. credentials, raw
prompts, and decrypted continuation bytes never enter catalog, history,
evidence, or logs.

Completed children and tool positions replay without redispatch. A provider
loop may resume from its sealed next-child continuation; raw-api `ReDispatchable` tools may retry under their existing owner contract.
an unresolved accepted native callback cannot be redispatched merely because it
was a read. An unresolved external dispatch grants no retry
authority and remains suspended/terminal according to its owner contract.
There is no application entry point for resetting an uncertain generation or
attaching an out-of-band terminal result.

native recovery first reads the original frozen spec/intent and attempt facts,
before provider/catalogue/current tools. only its own exact sealed terminal or
authoritative original-attempt non-submission proof permits local settlement.
parent terminal state beside an Uncertain journal is not recovery authority.
local replay preserves original terminal/usage and performs no provider call;
publication still rechecks current source, access, credits and job claim. metadata
uses the public `generation_has_local_recovery` seam for its early guard.

native cumulative usage limits and subscription `CapacityPaused` machinery are
removed. nexus generation deadlines and per-operation bounds remain; 64,000/8,000
are admitted context/output reservations, without native hard token enforcement.
raw provider-api billing/admission keeps its existing contract.

migration 0255 backfills original historical principals, retains original effect
and continuation bytes without invented seals, then deletes shell credentials.
uncertain legacy shell work blocks migration. historical undo uses persisted
principal/effect ownership. the single combined chain is
0252 -> resource 0253 -> atlas 0254 -> native 0255 -> metadata 0256 -> effects 0257
-> local vault history 0258.
metadata owns 0256 and the independent receipt contract in 0257. the pre-release
0246 reset preserves original completed write receipts before deleting history;
0257 also backfills surviving post-metadata positions.
missing ownership or unfinished writes block either path. runtime
consumers use one receipt contract. earlier numbered integration receipts stay
historical and do not qualify this final graph.

## Product API and reset boundary

`POST /chat-runs`, rerun, and regenerate carry an explicit selection and
`catalog_definition_revision`. requests reject the retired `tool_authority`
field. policy owns new tool authority.
chat history, sse meta, and trust projections expose immutable dispatch
selection and frozen authority derived from the saved generation spec, plus
safe execution disclosure. saved run/tree/active-path and cancel reads do not
need a live model catalog; current availability is checked for new admission.
historical authority describes the exact grant frozen at dispatch. these
projections never expose
credentials, dispatch aliases, continuation bytes, or a generation default.

the hard-cut migration deletes the complete legacy chat aggregate and all
historical generation/metering rows. users, media, libraries, knowledge,
resource graph data not owned by conversations, non-conversation artifacts,
and independent completed-write receipts remain. crossing 0246 with history
requires stopped writers, an exact reviewed census and disposition, a verified
backup, and proof from an actual restore of that archive. historical orphan
parents require explicit acknowledgement; missing write principals remain
blocking. archival abandonment never invents provider or job completion.
there is no legacy eligibility decoder or historical selection translation.

## Invariants

- One configured catalog is the source of every selectable Chat pair.
- One developer policy owns the Chat seed and all background selections.
- One frozen `GenerationSpec` owns selection, budgets, output, and tool policy.
- One parent/child ledger owns generation truth across both routes.
- One canonical tool authority serves eligible Chat and background operations.
- Domain owners alone accept model output and publish semantic results.
- No user generation defaults, profiles, presets, fallback, or compatibility
  path exists.
