# latest-model generation cutover

status: implementation in progress; live qualification incomplete
origin: 2026-09-25 owner approval; provider, runtime, product/content and adversarial review

## outcome and boundary

one current-model contract in llm-calling; llm-agent-kernel orchestrates;
nexus selects, authorizes, persists and presents. remove retired executable
paths instead of keeping compatibility. reuse existing catalogs, native
engines, sealed continuations, kernel generation loop, ledgers, tool plans,
picker primitives and codex isolation. no new framework or service platform.

approved installation scope: nexus runtime and repository-managed pins only.
approved policy mapping: old luna → gpt-6-luna; old terra/sol → gpt-6-sol;
preserve operation effort. new-chat seed becomes codex / gpt-6-sol / medium.
approved data reset: delete existing chat and generation history; preserve
users, libraries, media, notes and all other domain data.

non-goals: fleet/desktop updates, new providers, embeddings/transcription,
prompt rewrites, task-quality benchmarking, autonomous delegation, provider
native web/computer tools, broader chat reliability redesign, permanent tests.
existing tool authority, budgets, undo and uncertain-dispatch rules remain.

## exact supported catalog

these are the ONLY executable generation models. all combinations below must
be qualified; documented availability is not account access or a live pass.

| route and exact model ids | complete reasoning configurations |
| --- | --- |
| openai api: `gpt-6-astra` | standard/pro × low, medium, high, xhigh, max |
| openai api: `gpt-6-sol`, `gpt-6-luna` | standard/pro × none, low, medium, high, xhigh, max |
| codex personal: the same three gpt-6 ids | low, medium, high, xhigh, max; authenticated discovery must expose all five; ultra forbidden |
| deepseek api: `deepseek-flash` (v4.1) | none, low, high, max |
| gemini api: `gemini-3.8-flash` | low, medium, high |
| anthropic api: `claude-fable-5-1`, `claude-opus-5-5` | adaptive × low, medium, high, xhigh, max |
| anthropic api: `claude-sonnet-5` | adaptive/disabled × low, medium, high, xhigh, max |
| xai api: `grok-4.7` | low, medium, high, xhigh |

delete kimi/moonshot/openrouter support and routing pins; deepseek pro and old
flash ids; older gpt, gemini, claude and grok rows; their prices, aliases,
provider-specific branches, unused credentials/configuration, examples and
dependencies. retain shared chat-completions transport for deepseek/xai.
do not remove non-generation capabilities merely because their model is old.
remove application env wiring; do not delete unrelated credential stores.

provider source: [gpt-6](https://developers.openai.com/api/docs/guides/latest-model),
[mode](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode),
[codex](https://learn.chatgpt.com/docs/models),
[deepseek](https://api-docs.deepseek.com/api/create-chat-completion/),
[gemini](https://ai.google.dev/gemini-api/docs/thinking),
[claude](https://platform.claude.com/docs/en/build-with-claude/effort),
[grok](https://docs.x.ai/developers/models/grok-4.7).

## capability and api contract

extend the existing library catalog; do not create another catalog service.

```text
ReasoningKey = opaque string of 1..64 ascii characters, scoped to one model
ReasoningOption = { key: ReasoningKey, label: string }
ModelFacts = existing identity/capacity/modality/transport facts
           + ordered reasoning: tuple[ReasoningOption, ...]
           + source_default_reasoning: Presence[ReasoningKey]
```

keys are unique per model; labels are nonempty; ordering is stable; a present
default names exactly one option. the library privately maps each key to a
COMPLETE native configuration:
`standard/high` → openai `{reasoning: {mode: standard, effort: high}}`;
`disabled/high` → claude `{thinking: {type: disabled},
output_config: {effort: high}}`. omit thinking display when disabled.
single-axis keys remain `low`, `high`, etc. the keys are never split by
consumers. browser facts expose no native fragments, endpoints or secrets;
existing library-owned dispatch facts remain available to server consumers.

replace the global `ReasoningLevel` enum with `ReasoningKey`; require an
explicit key in library generation calls, including the `chat()` convenience
method. delete implicit `none` meaning “provider default.” only a declared
`none` option disables thinking. resolve and validate the exact model/key
before io. retain provider-option collision rejection; no override escape.

keep existing nexus endpoints and selection envelope:

```text
GET /llm-catalog -> existing routes/models/readiness + complete reasoning options
selection = {route: CodexPersonal, model: string, reasoning: ReasoningKey}
          | {route: ProviderApi, model_ref: string, reasoning: ReasoningKey}
POST /chat-runs, /messages/{id}/rerun, /messages/{id}/regenerate
  -> existing body + exact selection + catalog_definition_revision
```

llm-calling owns supported model membership, labels, sourced defaults, native
lowering, modalities, limits, pricing and capability facts. one library-owned
gpt-6 identity set serves api rows and codex filtering. codex still discovers
actual account/model/effort availability; no synthetic source rows or private
cache reads. filter ultra from selectable discovery; reject ultra requests
at admission/dispatch, including direct library callers. missing any approved
model/effort blocks that model's readiness and completion of this cutover;
never silently shrink the target. keep native delegation disabled.

nexus removes `ADMITTED_TARGET_KEYS`, its reasoning enum, model-name parsing
and provider-specific label/default logic. it composes library facts with
configured credentials/readiness and operation requirements. selection cannot
grant tools. capabilities must describe actual text/structured/tool-output
combinations; stop unconditionally marking every api row `StrictStructured`.
source absence stays absence. no invented capacities/defaults or “first row”
selection. changes to native mappings/capabilities rotate existing catalog,
row, backend and request fingerprints. freeze key, dispatch, authority and
revisions once; workers never substitute a fresh choice.

## native execution and composition

api engines retain responses/openai, messages/anthropic, generate-content/
gemini, and chat-completions/deepseek+xai. preserve native reasoning as opaque
protocol state, separately from display text. extend existing `generate()` /
`stream()` to accept one additional request arm:

```text
ProviderRequest = GenerateIntent | ContinueGeneration
ContinueGeneration = {
  continuation: ContinuationArtifact,
  tool_results: tuple[ToolResultMessage, ...]
}
```

every successful tool-bearing terminal returns a sealed artifact containing
the COMPLETE native prefix, frozen nonsecret request settings and ordered
pending calls. continuation accepts no replacement messages/tools/model/key.
validate exact ordered results, target/codec/fingerprint binding and cumulative
bounds before io; append once, never nest prior artifacts. nexus persists the
opaque artifact and normalized calls/results; delete its native-history and
assistant-text reconstruction. prompts stay in the existing sealed store,
never logs; credentials never enter artifacts. preflight the existing 16 mib
limit without truncation. paid output exceeding it yields an explicit failed
terminal with usage and executes no tools. bump incompatible codecs; never
strip signatures, rewrite prefixes or redispatch uncertainty. this fixes both
anthropic block reordering and lost earlier tool turns.

adopt current upstream websocket-over-unix-socket transport only. native
codex target is **0.157.1**, verified in the
[official changelog](https://learn.chatgpt.com/docs/changelog). nexus distributes
only `openai-codex-cli-bin==0.157.1`; remove python `openai-codex`, the obsolete
`provider-runtime[codex-sdk]` extra, stdio launching and fake sdk identity.
pin provider/kernel by immutable released commits after their changes land.
lock the exact binary distribution; launch only its absolute executable path.
compare the running service's initialization version with 0.157.1 before
admission. the existing dependency-light health contract owns expected identity;
api consumers do not import the host-only distribution.

nexus owns one foreground native process group per existing private generation
root and admission slot; bounded bootstrap/catalog sessions use the same
owner. start the pinned binary with a private home/tmp/cwd and enrolled auth:
`codex app-server --listen unix://PATH --strict-config`. await its private
socket, then pass `codex_endpoints` to `AgentRuntime`. account for native socket
symlinks: prove the resolved socket/state belongs to the disposable scope,
or explicitly own and clean its target, including after forced process death.
the library owns handshake/catalog/session/turn/events/interruption. close
clients, stop and await the process group, verify/sync auth, then release the
terminal/root/slot. a disconnected client is NOT proof of process exit.
unproven teardown closes readiness and retains uncertainty. keep the external
nexus `agent.sock` protocol and host isolation.

implementation finding (2026-09-26): pinned 0.157.1 has no app-server thread
tool policy and offers generic MCP resource methods whenever an MCP server is
mounted. native-tool and sandbox restrictions do not remove those methods.
the required frozen MCP-only authority therefore cannot be proved. provider
catalog v4 rejects nonempty Codex MCP publications before effects; Nexus
removes the private mount and credential path, admits only text-only Codex,
and marks every tool-bearing Codex workload ineligible. this is a blocker,
not a qualified substitute for the originally required Codex chat/tool turns.
do not restore MCP until a pinned native protocol can enforce the exact frozen
tool set before effects and pass live authority proof. keep the kernel's
read-only/offline/no-MCP policy. retain sanitized cause, stage and generation
identity through host failures. an API route for affected workloads requires
an explicit owner decision and independently qualified capability facts.

qualify 0.157.1 auth refresh against the existing writable-file boundary;
replace that narrow mechanism if native rename/write behavior changed.
do not assume the 0.144.4 contract survived. health reports actual native
version and library/protocol identity. preserve current resource limits until
measurements justify a change. kernel needs dependency/contract alignment,
not model tables or provider branches. llm-tools owns declared tool failures:
an exact bounded brave invalid-token rejection settles once as
`CredentialRejected`; unknown responses remain uncertain. no new execution primitive.

## interaction and content design

each feature owner includes a content designer; review content before code.

| feature / designer owner | content schema and definition of good |
| --- | --- |
| catalog and picker / a+d | retain provider → model → thinking. native selects; singleton is a labelled value. library owns complete labels: `standard · high`, `pro · high`, `adaptive · high`, `thinking off · high effort`; native single-axis values, with none labelled `off`. group by mode then ascending effort. no key parsing, rankings, help banners or reset toasts. |
| selection and history / c+d | preserve account-owned draft text; delete older drafts with no provable account owner. model change/reset chooses sourced default, otherwise sole option, otherwise requires selection. provider change clears incompatible model/configuration; never selects the first row. refresh never changes a choice. obsolete choices block every send path: `this model is no longer available. choose a current model.` or `this thinking setting is no longer available. choose another.` new history renders recorded labels. cutover notice: `chat history was cleared for the model update. your library, media and notes are unchanged.` |
| codex availability / b+c | existing error surface distinguishes `codex needs sign-in`, unavailable model, and `codex could not start`. operator evidence gives actual runtime version/profile, failure stage and bounded safe cause. no credential/prompt output and no new dashboard. |

reuse `SelectField`, catalog freshness, `SelectionDraft`, focus handling,
causal inheritance, candidate editing and existing error surfaces. replace
effort segments with one thinking select; no other picker redesign.

## hard cut and data

quiesce admissions/clients/consumers; drain known work, disable old jobs and
revoke old tool grants. stop and await every owned native process group;
resolve in-flight domain effects through their existing owners. verify a final
consistent backup/export, marking unresolved paid calls abandoned/uncertain:
remote computation may still bill. never invent cancellation/success or
redispatch. align libraries, host, workers, api and browser in one release;
retain exact prior artifacts for explicit rollback.

before migration, require an explicit table/dependent-reference and artifact
deletion allowlist. delete chat conversations/messages/branches/active paths,
runs/events, `chat_run_turn_contexts`, prompt assemblies, retrieval/tool-call
telemetry; generation ledger/turn/continuation/tool-position rows; chat-owned
graph/search/provenance dependents; owned continuation files/private roots.
inspect foreign keys first. preserve domain identities, contents, relationships,
tool effects, idempotency and undo evidence; detach references where necessary.
no blanket truncate/cascade. domain jobs follow their owner and updated policy.
preflight persisted workspace sessions against the expected pane/history shape;
the migration names any invalid session id and aborts transactionally for repair.

reject stale browser/job commands using the revised catalog/request identity
before reopening admission: deleting dedup rows must not turn old retries into
new sends. invalidate old selections and causal conversation/run pointers once,
preserving account-owned unsent text in each browser/webview and deleting drafts
whose account cannot be proved. start at the approved chat seed.
ship one current schema/codec/decoder only, with no model translation. new
history remains immutable. restoring the pre-reset backup loses subsequent
writes; rollback requires another drain and explicit data handling, not an
image swap. old history is intentionally recoverable only from that backup.

## non-overlapping work and proof

paths are relative to the named repository. shared files have one owner;
others request changes through that owner. publish interfaces before dependents.

| package | exclusive ownership |
| --- | --- |
| a — provider api + catalog designer | llm-calling `src/provider_runtime/{types,registry,runtime,prices}.py`, price snapshot, `engines/`, continuation/tool-adapter modules and relevant specs. exact catalog/configuration contract, removal of obsolete providers, complete native continuation. |
| b — codex protocol + runtime designer | llm-calling `src/provider_runtime/agent_runtime/`; nexus `apps/codex_agent/`, `python/nexus/services/codex_generation_{client,contract,operations}.py`, docker/deploy host configuration and runbook. protocol, native-tool/mcp contract, process/auth lifecycle and truthful health. a owns shared provider types. |
| c — consumer/backend + reset designer | nexus `python/nexus/services/{generation_catalog,generation_policy,generation_spec,generation_service,provider_generation_backend,provider_generation_contract,generation_continuations}.py`, affected ledger/history projections, `python/nexus/schemas/{llm,conversation}.py`, config/credentials, env contracts and `migrations/alembic/versions/` reset migration. consume library facts; exact selection and scoped reset. b owns codex wire files. |
| d — picker/content designer | nexus `apps/web/src/lib/conversations/{generationCatalog,generationSelection}.ts`, affected draft/request/history consumers, `apps/web/src/components/chat/{GenerationSelectionPicker,CandidateGenerationPicker}.tsx`, related css and privacy copy. no backend/catalog rules. |
| e — integration/reviewer | all package manifests/locks; kernel definitions/provider pins/spec/adr alignment; final composition, cutover and docs/tickets. assign no overlapping implementation files. |
| f — tool failure/reviewer | llm-tools `src/llm_tools/web/` and its contract evidence. classify only a conclusive credential rejection; e owns nexus pin, frozen plan revision and browser projection. |

a/b/f publish contracts, then c/d integrate; e serializes shared pin changes.
an independent reviewer challenges each contract, red, implementation, green,
refactor and cleanup. review authority, replay, exact selection, content and
deleted residue; resolve findings before the next dependent stage. no large
unrelated cleanup disguised as this cutover.

temporary tests are explicitly owner-authorized for this change. keep the
permanent `./scripts/test` static gate unchanged; use disposable external
integration/live scripts and existing injection boundaries, no test-only
production hooks or permanent harness dependencies.

1. **red:** establish actual missing-model/configuration, ultra rejection,
   mcp-authority and multi-round continuation failures on the current stack.
   working invariants may already pass; do not manufacture reds.
2. **green:** actual browser/bff/api/db/worker/library/provider, authenticated
   separately for every configured route. exercise every declared configuration
   with a successful usable terminal, exact native configuration evidence and
   matching persisted selection/labels: expected 80 cells (34 openai,
   15 codex, 4 deepseek, 3 gemini, 20 claude, 4 grok). explicitly prove
   pro+none and sonnet disabled+max. allow enough output for a usable answer at
   each effort. unavailable credentials/access block that cell; never shrink
   the contract.
3. **boundary proof:** real multi-round tool use for every distinct native
   continuation codec; at least three model turns and a unique fact from the
   first tool result. cover fable/opus ordered signed blocks, empty signed
   thinking, gemini signatures, and reasoning replay. exercise strict output
   wherever offered, codex frozen mcp auth and forbidden native/delegation
   attempts, cancellation/process death, auth refresh, linux isolation and
   resource fit and continuation overflow. reopen accepted work without
   duplicate paid calls/effects.
4. **consumer proof:** exact approved model set; reject retired ids, aliases,
   ultra, invalid/cross-model keys and stale revisions before dispatch. verify
   updated background policies, option order/default/reset/singletons and
   stale-setting copy; keyboard/touch/focus, reload and retained drafts.
   compare domain identities/contents/relationships after scoped reset and
   demonstrate retained undo; row counts alone are insufficient. verify new
   history and no implicit substitution or stale-command replay.
5. **refactor/delete:** remove duplication/dead paths; rerun affected proofs
   and required repo checks. after all cells and boundaries pass, delete the
   temporary tests, fixtures, dependencies, test data and owned processes.
   retain a terse nonsecret receipt with exact pins, cases, results and limits;
   run static checks on the final tree and remove resolved tickets.

explicit trade-offs: complete opaque choices trade a longer dropdown for no
provider schema in nexus; per-generation codex processes trade startup cost
for existing isolation; the approved reset sacrifices chat history to remove
old schemas/codecs outright; 80 configuration cells plus boundary journeys
cost money but qualify the declared contract;
deleting temporary tests leaves future regression coverage limited to static
checks and ordinary use; deleting unowned older drafts loses their text but
prevents exposing it after an account switch; bearer-backed codex turns defer
answer text until the selected final item, trading incremental display for
secret containment and an immutable text ledger. native app-server is vendor-experimental, so exact
pins and real boundary qualification are required. no fallback hides failure.
