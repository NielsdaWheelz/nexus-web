# latest-model generation cutover

status: implementation in progress; codex shell redesign approved; live qualification incomplete
origin: 2026-09-25 owner approval; provider, runtime, product/content and adversarial review

## outcome and boundary

one current-model contract in llm-calling; llm-agent-kernel orchestrates;
nexus selects, authorizes, persists and presents. remove retired executable
paths instead of keeping compatibility. reuse existing catalogs, native
engines, sealed continuations, kernel generation loop, ledgers, tool plans,
picker primitives and codex isolation. no new framework or service platform.
[codex-shell-cutover-plan.md](codex-shell-cutover-plan.md) supersedes this
plan's earlier frozen-mcp-only codex authority and execution design: subscription
reading helpers use native shell, disposable scratch, public internet and the
private nexus generation api. its work boundaries and proof own that change.

approved installation scope: nexus runtime and repository-managed pins only.
approved policy mapping: old luna → gpt-6-luna; old terra/sol → gpt-6-sol;
preserve operation effort. new-chat seed becomes codex / gpt-6-sol / medium.
approved data reset: delete existing chat and generation history; preserve
users, libraries, media, notes and all other domain data.

non-goals: fleet/desktop updates, new providers, embeddings/transcription,
unrelated prompt rewrites, task-quality benchmarking, autonomous delegation,
browser/computer product integration, broader chat reliability redesign,
permanent tests. provider-function authority and domain effect guarantees
remain; the linked plan explicitly replaces codex's per-run tool grant.

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
configured credentials/readiness and operation requirements. browser selection
cannot invent authority; the server owns each route's contract. capabilities
must describe actual text/structured/tool-output
combinations; stop unconditionally marking every api row `StrictStructured`.
source absence stays absence. no invented capacities/defaults or “first row”
selection. changes to native mappings/capabilities rotate existing catalog,
row, backend and request fingerprints. freeze key, dispatch, authority and
revisions once; workers never substitute a fresh choice. codex freezes its
generation-api/execution policy, not a model-visible tool allowlist.

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

codex app-server and exec-server target **0.157.1**, using the locked
`openai-codex-cli-bin` distribution. remove python `openai-codex`, obsolete
`provider-runtime[codex-sdk]`, stdio launching and fake sdk identity. keep
private websocket-over-unix-socket app-server control and external `agent.sock`.
the [shell plan](codex-shell-cutover-plan.md) owns execution separation,
remote protocol, api authority, process teardown, auth refresh and readiness.
do not restore mcp or adopt the prepared metered-api route substitutions.
text-only codex admission is the current implementation, not acceptance of
the target. keep it ineligible for tool-bearing work until shell/api proof.
pin provider/kernel by immutable released commits after their changes land.
kernel needs dependency/contract alignment, not model tables or provider
branches. llm-tools owns declared tool failures:
an exact bounded brave invalid-token rejection settles once as
`CredentialRejected`; unknown responses remain uncertain. reuse the existing web executor.

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
consistent backup/export and actual restored-copy proof; record explicit archival
abandonment without changing original unresolved paid-call outcomes:
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
the reviewed input and finite drain/backup/restore/disposition/release sequence
live in [deployment.md](../deployment.md#reviewed-model-history-reset). completed
write receipts become independent of deleted ledger/chat history before reset;
existing 0255 data uses the forward 0256 storage migration. preserve original
unknowns, explicit orphan acknowledgement and the metadata uncertainty barrier.
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
others request changes through that owner. where both plans name a file, the
[shell plan's writer](codex-shell-cutover-plan.md#non-overlapping-implementation-and-content-ownership)
owns the whole file for the combined change; owners here request edits through
that writer. publish interfaces before dependents.

| package | exclusive ownership |
| --- | --- |
| a — provider api + catalog designer | llm-calling `src/provider_runtime/{types,registry,runtime,prices}.py`, price snapshot, `engines/`, continuation/tool-adapter modules and relevant specs. exact catalog/configuration contract, removal of obsolete providers, complete native continuation. |
| b — codex protocol + runtime designer | codex work is split by the exclusive owners in [the shell plan](codex-shell-cutover-plan.md); it owns native protocol, isolated execution, generation api and consumer integration. a here retains shared provider-api types. |
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
   native-shell/api and multi-round continuation failures on the current stack.
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
   wherever offered; qualify codex shell/api authority, credential separation,
   cancellation/process death, auth refresh, linux isolation and
   resource fit and continuation overflow. reopen accepted work without
   duplicate ledger-owned provider calls or generation-api effects. ordinary
   shell/public-internet effects are outside that replay guarantee.
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
provider schema in nexus; the shell plan owns codex authority/isolation costs;
the approved reset sacrifices chat history to remove
old schemas/codecs outright; 80 configuration cells plus boundary journeys
cost money but qualify the declared contract;
deleting temporary tests leaves future regression coverage limited to static
checks and ordinary use; deleting unowned older drafts loses their text but
prevents exposing it after an account switch; bearer-backed codex turns defer
answer text until the selected final item, trading incremental display for
secret containment and an immutable text ledger. native app-server is vendor-experimental, so exact
pins and real boundary qualification are required. no fallback hides failure.
