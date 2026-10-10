# LLMs

## Scope

Every Nexus text or structured-output generation runs through one call,
`generate` (`services/generation/run.py`), backed only by the two separate
`llm-calling` lanes:

- Codex Personal through `AgentRuntime` and the isolated Codex host;
- configured metered APIs through `ProviderRuntime`.

The shipped developer policy selects Codex Personal for every background
operation. Chat alone lets the user choose an exact route, model, and reasoning
value for each run from the complete configured `llm-calling` catalog. There is
no generation profile, Fast/Balanced/Deep preset, user default, AI Settings
surface, fallback, or compatibility route. Embeddings and transcription remain
separate non-generation capabilities.

The product owns intent, exact selection, operation policy, tool authority,
the ledger, and publication. `llm-calling` and `llm-agent-kernel` own source
catalog facts, route-local lowering, provider continuations, loop order, and
provider/agent protocol events. Domain owners build prompts, accept generated
output (the `decode` they pass), and commit final domain writes.

Primary owners (the first nine under `services/generation/`):

- `contract.py`: intent, spec, owner, tools, events, terminals and the one failure vocabulary;
- `policy.py`: the literal operation table (exact selection, timeout, input bound, tool plans);
- `catalog.py`: codex and provider rows, readiness, the picker wire, the chat budget rule;
- `run.py`: `generate` — resolve, open, watch, dispatch, decode, close;
- `codex.py`: the kernel's transient native mode (kernel ADR 0012);
- `provider.py`: ProviderRuntime on the kernel's `run_generation`, held in memory;
- `ledger.py`: `llm_calls`, one row per generation;
- `synthesis.py`: the strict-JSON prompt/intent/decode scaffold;
- `runtime.py`: the process runtime and the one job envelope;
- `tool_authority.py` and `tool_runtime/`: provider-function/native-callback authority, domain handlers, and one row per tool call;
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
browser submits the exact selection, validated against the current catalog at
admission, and never submits dispatch strings, credentials, capabilities,
defaults, or fallback order. The developer-owned Codex Personal / GPT-6 Sol / medium
seed initializes a new composer only; it is not a saved user preference and
does not override a causal or explicit per-run selection.

Background operations resolve their exact Codex selection only from the total
source-controlled policy. Users can inspect the effective selection but cannot
edit background generation policy.

## Operation and tool policy

A chat send stores one `GenerationSpec` on its run: operation, exact selection,
the presentation shown at dispatch, tool plan and admitted scope, effect mode,
and the context/output budgets it was assembled against. Every generation's
`llm_calls` row records the same shape for the call it ran. A generation reads
the catalog once more when it starts; a selection that is no longer runnable
fails `runtime_unavailable` rather than running something else.

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
evidence, citation and undo boundaries. every call that reaches dispatch writes
one `llm_tool_positions` row at `generation/{generation_seq}/tool/{n}` before it
runs and completes it in the transaction that commits its effects; a write's
effect id is that row's id. nothing replays a recorded result: within one codex
call the kernel answers a repeated native call id from memory, and a rerun
generation is new work. codex invalid-argument rejections never reach the host
and leave no row. budgets are counted in process memory per generation.

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
digest access remains required. ci and image builders fetch that exact
repository over ssh with the read-only deploy key `UNIVERSAL_MEMORY_DEPLOY_KEY`
(`deployment.md`). the process-scoped git helper never persists the key or
embeds it in urls, build arguments, caches or runtime images. ordinary local
dependency installs use authenticated git.

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

codex runs on the kernel's transient native mode (`TransientNative`, kernel ADR
0012): every in-process ordering guarantee, no durable journal and no recovery.
commentary streams as answer text; the sealed native final replaces it on
success, and a stop or failure keeps what streamed. a stop is a kernel preempt.

Provider API execution uses `ProviderRuntime` with the selected configured
credential on the kernel's `run_generation` loop: proposals equal continuation
calls, a stop is checked between tool calls, and a stop is never a synthetic
provider terminal. its lifecycle hooks record nothing — this host is transient,
as ADR 0012 states for native turns. one provider generation stops at 24 turns
(`output_limit`) and at its operation timeout. provider routes are chat-only:
text output with tools.

## Ledger, failures and no replay

`generate` writes one `llm_calls` row per call: opened before dispatch with its
spec and job id, closed once with `Succeeded | Failed | Cancelled`, one failure
code, route evidence (never model text) and summed usage. it is an unreplayable
multi-mutation: nothing survives a process. a worker that dies mid-generation
leaves its row open until its job's next attempt starts (`run_generation_job`
closes the job's open rows first), the job dies (dead-letter projection), the
job is revoked, or migration 0269 closes it `interrupted`. chat never reruns a
generation (the run fails `interrupted`; the user reruns); background jobs rerun
from scratch, repaying the call. completed additive writes still commit effect
receipts and target authorship with their row, so writes made before a crash
stay visible and undoable. a tool call that never completes (a stop, a lost
claim, a refused commit) keeps its row `Prepared` with no effect.

one watcher per generation polls every 0.25 s for the owner's stop (`Cancelled`),
a lost job claim (`interrupted`) and the operation deadline (`timeout`). failure
codes: auth, quota, rate_limited, timeout, output_limit, content_filtered,
context_too_large, invalid_output, policy_violation, runtime_unavailable,
interrupted, defect. a pre-dispatch refusal (catalog, readiness, tools, memory
grant) is a `runtime_unavailable` row. for chat it is the terminal value (the
user reruns); a background generation that never reached its model (refused, a
Codex session that did not open, or a turn Codex did not submit) instead raises
`RouteUnavailable` while its job has attempts left, so the queue retries it with
the kind's backoff, and only the last attempt settles the domain row. a failed
Codex catalog fetch is retried after 10 s (a good one is kept 60 s). a decode
rejection is `invalid_output` in the same terminal write. a stop that the tool
fence catches first is still `Cancelled`. anything unexpected closes the row
`defect` and goes on to the queue's retry. each consumer owns its total map from
these codes (chat failure, metadata, oracle, dossier).

native cumulative usage limits and subscription `CapacityPaused` machinery are
removed. nexus generation deadlines and per-operation bounds remain; 64,000/8,000
are admitted context/output reservations, without native hard token enforcement.
raw provider-api billing/admission keeps its existing contract.

migration 0269 removes replay: it fails open runs and rows `interrupted`, closes
unfinished tool positions as timed out, drops the turn and continuation tables,
the step journals and the replay columns, and rewrites chat specs and retired
failure codes. migration 0255 backfilled original historical principals, retains original effect
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

`POST /chat-runs`, rerun, and regenerate carry an explicit selection; chat
contract revision "3" turns a stale tab into a reload prompt. requests reject
the retired `tool_authority` field. policy owns new tool authority.
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
- One `generate` call is one `llm_calls` row; no generation state survives a process.
- One failure vocabulary covers both routes.
- One canonical tool authority serves eligible Chat and background operations.
- Domain owners alone accept model output and publish semantic results.
- No user generation defaults, profiles, presets, fallback, or compatibility
  path exists.
