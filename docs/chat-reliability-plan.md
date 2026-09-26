# chat reliability: specification and implementation plan

status: implementation in `feature/chat-reliability`; release qualification pending
origin: 2026-09-25 chat investigation and owner request

## 1. outcome, evidence and scope

a supported chat send produces one durable run whose progress, completed
response or need for repair remains understandable after navigation, connection
loss and cancellation. history remains readable without a working model host.
no recovery action silently creates another generation or repeats tool effects.

the [review](chat-reliability-review.md) owns incident evidence and research.
its production snapshot was `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`; source
inspection used `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`. recheck identities
before implementation or production work. the latest codex run failed because
the requested tool/permission combination conflicts with the installed
provider contract. the user confirmed its eventual paused display. the earlier
pane crash still lacks its initiating exception. neither memory pressure nor
the known catalog-read defect is established as that crash's cause.

this plan owns capability-composition requirements, diagnostics, chat
cancellation, historical reads, recovery presentation, wire/data cutover and
verification. reuse the existing generation journal, queue, event stream,
command receipts, tool executor, catalog, error boundaries and logging.

the [model-refresh plan](latest-models-cutover-plan.md) owns its selected native
version, model set, provider protocols, process lifecycle and dependency pins.
its runtime package implements the capability requirements below once. this
plan does not introduce a competing adapter patch or another provider pin.
both plans must consume the same reviewed interfaces and release evidence.

out of scope: new models or picker redesign; a broker/workflow/observability
platform; fleet changes; speculative memory increases; a general error-boundary
rewrite; selection-history label repair; and deleting chat or domain data.
any separately authorized history reset belongs to the model-refresh plan and
cannot be inferred from approval of this plan. default migration here preserves
history and all domain effects.

## 2. invariants and owners

| invariant | sole owner |
| --- | --- |
| one immutable send command and admission receipt survive ambiguous delivery | browser draft store and server chat admission transaction |
| accepted work is reread; reconnect observes the same run; rerun is an explicit new command | chat engine and admission routes |
| supported output/tool/permission combinations describe enforceable execution, not independent feature names | provider-runtime capability and native adapter boundary |
| tools are exactly the frozen host-authorized plan; model selection grants no authority | nexus generation admission and shared tool executor |
| a completed generation/tool effect replays without redispatch; uncertainty never becomes permission to repeat | generation journal and tool position ledger |
| cancellation intent is distinct from confirmed completion | existing `ChatRun.cancel_requested_at` and generation cancellation owner |
| queue state describes execution liveness; it does not overwrite the run's product outcome | chat execution projection |
| history shows immutable dispatch facts; current eligibility belongs to new-generation admission | generation history projection and catalog service |
| unexpected defects remain defects and cannot emit a fabricated successful or failed product terminal | detecting owner, queue recovery and existing error boundary |

## 3. capability contract and release gate

extend the existing library contract to resolve supported combinations for the
exact route, model, reasoning choice, output contract, host-tool requirement
and backend/native revision. a flat claim that text, structured output and
tools each exist does not establish that their combination works.

the required distinction is:

- no model tools: retain the existing contained no-tool behavior, including
  the kernel's stricter read-only/offline/no-mcp request;
- host-managed tools: permit exactly the frozen host publication and scoped
  credentials; prevent ungranted native, external and delegated effects;
- qualify text-plus-tools and strict-output-plus-tools independently when
  offered. do not advertise a combination merely because a model is listed.

the library owns supported combinations and rejects invalid combinations
before external work. nexus composes these facts with configured credentials,
operation requirements and observed readiness. the catalog, admission and
pre-dispatch check consume that same contract. freeze its revisions with the
existing specification/fingerprints. the host verifies actual installed native
identity; a mismatch closes generation readiness rather than substituting a
model, effort, tool plan or runtime.

first determine whether authorized mcp can operate with read-only files and
disabled native network. use the narrowest permissions supported by actual
enforcement. removing the present guard, enabling built-ins, suppressing tools
in a prompt, or rejecting an authority event after an effect are not repairs.
the provider must identify the control that prevents each forbidden effect;
a new enum alone proves nothing.

before advertising this combination, require one bounded qualification receipt
for the exact library/kernel commits, binary, image, configuration and protocol:

1. pinned-source/control explanation and observed effective configuration;
2. a real authorized mcp call, scoped authorization, canonical tool identity,
   result consumption, durable receipt and usable final answer;
3. attempted native execution, delegation, unlisted mcp, another run's scope,
   and direct file/network effects denied before effects, checked through
   independent sentinels/receipts rather than the model's claim;
4. cancellation and process-death proof that owned descendants cannot continue
   using the grant; disconnection alone is insufficient;
5. the claimed output/tool combinations and native settings. share an authority
   proof only where source/control evidence establishes identical lowering and
   enforcement; a different or unknown combination needs its own proof. a
   combined release must still satisfy every configuration cell required by
   the model plan. reuse that evidence rather than reducing its coverage.

if the selected native runtime cannot enforce this contract, tool-bearing
codex stays ineligible and its restoration is blocked. an explicit api choice
can serve chat, but does not repair fixed background policies that require
codex tools. unsupported fixed policies also block the combined release until
the owner chooses a supported policy. do not silently weaken policy, invent
capability facts or treat a reduced model set as completed work.

qualification receipts are release evidence, not a new runtime certification
database. library-owned facts and host readiness retain their existing owners.

## 4. diagnostics and the original pane crash

at the detecting host boundary, record the original exception class, safe
cause/code, stage, generation/child identity, native version and contract
revision before reducing it to the wire failure kind. use bounded structured
fields in existing logs. known causes need safe diagnostic detail; unknown
exceptions must not dump prompts, credentials or arbitrary request bodies.
correlation must survive a later failure to normalize or persist the terminal.

record the first failure distinctly from later refusal to replay uncertainty.
neither a diagnostic log nor a host cancel acknowledgment is terminal evidence.
retain closed failure kinds and existing defect classification; do not add
`invalid_request` to the product's retryable-failure union.

fix the confirmed telemetry correlation collision at its route owner: keep
ingestion `request_id` in the normal log envelope and log the browser's failed
request as `origin_request_id`. preserve phase, command, run, release and
component stack. no new telemetry store is required.

the original pane crash has an explicit diagnostic gate: capture its browser
exception and first failed request/decoder, correlate any accepted receipt and
run, then repair the responsible owner. use the existing authenticated browser
and developer tools; add a bounded structural failure-site field only if the
captured evidence demonstrates it is necessary. do not broadly catch defects,
relax decoders, or add message boundaries without a demonstrated independent
rendering failure. this incident cannot be closed merely because the latest
run now pauses correctly.

## 5. cancellation and uncertain execution

`cancel_requested_at` remains the only stored cancellation intent. an accepted
cancel request means the request was recorded, not that all external work has
stopped. use the existing run-to-job lock order and lease fences. repeated
requests are idempotent and cannot reset retry budgets.

| observed state under the owning lock | cancellation behavior |
| --- | --- |
| run already terminal | return its existing outcome unchanged |
| no generation step | finalize cancellation without host admission or tools |
| prepared step, with verified absence of armed child/ledger evidence | complete the existing prepared-generation cancellation path before transport or tool binding, then project the cancelled run |
| currently owned dispatched work | record intent; the existing live cancellation signal interrupts it; complete only after the normal terminal/authority-drain boundary |
| completed generation awaiting chat projection | replay its accepted evidence; resolve cancellation/publication order at the existing locked chat finalizer without rewriting the generation terminal or effects |
| dead job with uncertain dispatch | record intent, retain dead/suspended execution, and report that the outcome remains unconfirmed; user cancellation never redispatches or requeues it |

use `cancel_prepared_generation_without_dispatch_in_current_transaction` for
its intended invariant, with the owning journal update in the same transaction.
do not call the bound-tool idle fence before any binding exists, and do not
make that fence silently tolerate a missing authority for dispatched work.

remove the unconditional cancellation requeue from dead-letter handling.
the first explicit cancel request may wake the same dead job once only when
the generation owner proves it can settle through undispatched cancellation
or accepted replay: exactly no step, prepared, or completed. all dead uncertain
jobs stay suspended for operator assessment, even if a provider continuation
could potentially settle them; the chat route does not acquire continuation or
tool-effect reconciliation authority. if a safe settlement attempt itself defects,
bounded exhaustion remains suspended for operator repair; duplicate requests
do not create another attempt budget.

operator repair uses the same run, generation, child, request fingerprint and
tool positions. actual retained terminal evidence or independently verified
non-dispatch may authorize a narrowly reviewed settlement. absent rows, elapsed
time, a 204 cancel response, healthy containers or a new software version do
not. no hand-edit from uncertain to prepared; no fabricated provider terminal.

the existing incident run stays suspended until such evidence is established.
this plan does not require a general reconciliation service or promise to
recover discarded evidence. if settlement needs a new owner operation, first
specify that one evidence-backed transition; lack of evidence remains an
explicit unresolved incident, not permission to erase or rerun it.

## 6. historical reads and generation availability

make `RunSelectionOut` historical-only:

```text
selection
catalog_definition_revision
source_catalog_definition_revision
display_at_dispatch
tool_authority
```

delete `current_state`, `current_state_observed_at` and `rerun_eligibility`
from this projection and its decoders. derive it exclusively from the stored
generation specification. keep strict storage validation; missing/corrupt
dispatch facts remain defects rather than guessed labels or default models.

remove catalog requirements from run get/list, tree and active-path projection,
cancellation response hydration, and undo response hydration. current model
availability belongs to `/llm-catalog`, the existing controlled picker, and
fresh admission for send/rerun/regenerate. remove readiness rows from historical
assistant details and the stale historical eligibility veto before rerun.

source-outcome eligibility remains the server's structural policy: an operator
defect cannot be rerun; a permitted failed/cancelled source can open candidate
selection even when its original model is unavailable. the new selected pair
must pass current admission. no automatic replacement. `can_rerun` describes
source applicability, not a promise that a current model is ready.

cold startup must satisfy the same separation. retain fail-fast local config,
schema and installed-contract validation, but remove required external catalog
io from the unrelated api lifespan. construct the existing catalog service
without fetching; its existing request/refresh owner obtains current facts
when generation/catalog is requested. absent initial facts keep generation
admission closed with the existing availability response. do not manufacture a
catalog, add another cache, or start a new polling supervisor. once discovery
succeeds, validate fixed policy against it before dispatch. a proven unsupported
policy remains a defect and release blocker; an unreachable host cannot make
saved conversations unreadable. verify recovery when it returns.

## 7. one chat execution projection and truthful controls

derive this chat-specific value once from the run and its one queue job:

```text
ChatRunExecution = {
  phase: Queued | Running | Recovering | Suspended,
  cancel_requested: boolean
}
```

the boolean projects `cancel_requested_at != null`; it is never stored
separately. read both facts in the same existing repeatable-read observation
transaction. terminal runs still have absent execution. use the same projection
for `ChatRunOut.execution`, `TrustRunOut.execution` and chat's existing
unsequenced `ExecutionAdvisory`. remove the unused top-level
`ChatRunOut.cancel_requested_at` wire field; retain the database timestamp.
other features keep their existing phase-only execution shape.

chat gets an exact decoder for the new value. the stream-kind owner returns
its typed advisory payload, and the shared tail only serializes it. publish
changes in either field through the existing listener/keepalive cadence;
advisories carry no event id and never advance the committed text cursor.
keep observing a suspended run so a later owned repair can become visible.

derive composer state and its cancel target from the selected pending
assistant's canonical trust run. a stream subscription id is not execution
authority: losing the connection must not remove a valid stop action. retain
only the local pending-http latch; canonical read/advisory facts own the result.

| state | visible/accessibility behavior | action |
| --- | --- | --- |
| accepted command awaiting canonical read | message received; loading the response | retry read of the same receipt if needed |
| queued | response queued | stop response |
| running | existing streaming/tool activity | stop response |
| recovering | recovering response; retain partial text | stop response |
| stop requested, execution not suspended | stop requested; preserve text; do not claim completion | repeat stop disabled |
| suspended without stop request | response paused; saved work needs repair | request stop once under the cancellation contract; no rerun/reconnect recovery button |
| suspended with stop request | stop requested; outcome unconfirmed and repair needed | no repeated stop or progress animation |
| connection lost while run remains nonterminal | existing reconnect presentation | reconnect the same run; cancellation remains independently available from canonical facts |
| terminal | existing complete/error/cancelled presentation | only the structurally eligible new-run action |

terminal state wins; suspension suppresses both progress animation and the
claim that a reconnect can repair execution. pending unresolved work continues
to block a new send on that path, with truthful paused/stop-requested wording.
draft editing and reading remain available. preserve focus and transcript
position; announce changed status without repeatedly taking focus.

replace operator-defect guidance to send a new message with concise repair
guidance. retain the existing support reference when present. do not invent an
available remedy or promise that no external work occurred.

## 8. strict wire and data cutover

this is one new chat wire shape, with no dual decoder or compatibility alias.
the existing tool-projection hash describes tools only; do not repurpose it.
add one backend-owned chat revision exported to the browser, request header
`X-Nexus-Chat-Contract`, and 409 `E_CHAT_CONTRACT_RELOAD_REQUIRED`.

require the exact revision before rich chat reads/mutations and direct chat
stream subscription: run create/get/list/cancel, rerun/regenerate, tree,
active-path and trail-bearing undo. normal authentication remains required.
attach the header in the browser api helper and direct stream opener; forward
it in the bff allowlist and permit it in stream cors. stream-token scope remains
authentication, not a schema version. reject mismatches before any mutation
or incompatible payload. reuse the existing reload notice, handling chat and
tool mismatches as distinct structured codes.

an already-open old client cannot understand a newly introduced error code.
use the single-user deployment window and verify browser/webview reload. old
clients fail closed and may show their old pane boundary; only clients with
the new handler can promise the new inline reload notice. do not add a
preparatory compatibility release solely to beautify this maintenance window.

`run_selection` is also persisted in chat `meta` events. inventory these and
any other serialized owners before migration. the forward migration removes
exactly the three retired dynamic fields from valid historical meta payloads;
it preserves event ids, sequence, timestamps, selection, dispatch labels,
generation identity and all tool/domain effects. malformed required facts
stop migration for explicit repair. never prune arbitrary json recursively.
verify pre/post identity and immutable-value equality, then replay old events
through the one new decoder. no generation-spec rewrite is required for this
projection change.

browser commands/receipts do not contain `RunSelectionOut`: preserve their
storage version, exact request and idempotency keys. a revision mismatch is
not permission to discard or reissue an acknowledged command. if the separate
model cutover also invalidates old commands or resets data, its explicitly
authorized migration owns that additional behavior; integrate the migrations
once, without assuming reset authorization here.

follow [deployment.md](../deployment.md): quiesce, verify backup as required,
apply the forward migration, align api/worker/host/browser, then verify reload.
the changed schema is not safely rolled back by swapping only an old image.
prefer forward repair; backup restoration has separate data consequences.

## 9. work packages and file ownership

publish the contracts above before parallel implementation. every shared file
has one owner; overlapping model-refresh work goes through that same owner.
unqualified nexus service names below live in `python/nexus/services/`;
browser library names live in `apps/web/src/lib/` and chat component names in
`apps/web/src/components/chat/`.

| package | exclusive implementation ownership | depends on |
| --- | --- | --- |
| a: provider/runtime capability and host diagnostics | model plan's provider owners: library `types/registry/runtime` capability interfaces and `agent_runtime/`; nexus `apps/codex_agent/`, `codex_generation_{client,contract,operations}.py`, host lifecycle/configuration/runbook | enforceability decision and exact native pin from model plan |
| b: generation recovery | nexus `llm_execution.py`, `chat_run_worker.py`, `tasks/chat_run.py`, `agent_tools_mcp.py`; cancellation transaction portion of `chat_runs.py` remains with c by an explicit requested change | cancellation contract; a for native-boundary proof |
| c: backend chat/read contract | nexus `generation_catalog.py`, lifespan in `python/nexus/app.py`, `chat_runs.py`, `chat_run_{selection,response,execution}.py`, `chat_failure.py`, conversation/trust projectors, python schemas, routes, stream-kind/advisory wiring, request guards/cors/errors, migration and telemetry logging route | frozen wire/ownership contracts; a for capability facts; b for cancellation semantics |
| d: browser transport and decoded models | `lib/api/{client,proxy,useGenerationRun}.ts`, chat api/sse decoders, `generationCatalog.ts`, `messageWire.ts`, `types.ts`, new chat execution decoder, `messageUpdateReducer.ts`, `useChatMessageUpdates.ts`, generated chat revision | c's published schema/revision |
| e: chat behavior and content | `useConversation.ts`, `useChatRunTail.ts`, `Conversation.tsx`, `ChatComposer.tsx`, `AssistantMessage.tsx`, `AssistantDetails.tsx`, `ChatFailureCard.tsx`, reload notice, failure copy and only necessary css | d and b/c's contracts |
| f: integration and original-crash diagnosis | manifests/locks, migration ordering, documentation/tickets, exact-tree integration and observed crash evidence; route any crash fix to its responsible file owner | all affected packages |

these are ownership packages, not six mandatory agents. parallelize independent
work within available capacity; serialize shared interfaces, files and pins.

the model plan's integrator owns shared manifest/lock changes; c coordinates
its shared catalog/schema/migration files with that plan's consumer owner.
do not assign separate agents to concurrently edit the same named file.
the diagnostics work in a shares its runtime owner rather than creating a
second host editor. f must identify any previously unnamed shared file before
assigning a change.

implementation sequence:

1. freeze the shared capability contract and wire shapes; capture current
   invalid-policy and cancellation failures using local, non-dispatch checks;
2. implement a's safe diagnostics and capability boundary alongside b's
   cancellation repair; the capability proof gate controls readiness;
3. c publishes historical reads, execution projection, cold-start behavior,
   migration and revision guard; d then e consume that exact shape;
4. identify and fix the original pane crash through its owner; do not relabel
   this investigation as passed if it cannot be reproduced/correlated;
5. integrate exact pins, run the acceptance cases, review effect/identity
   preservation and remove retired paths; record unresolved items separately;
6. after separate deployment authorization, use the owned release path and
   inspect the real user journey. no current-run reset/requeue is implicit.

## 10. acceptance and evidence boundaries

`./scripts/test` remains the only automated static gate, with no selectors or
new harness. follow [local verification rules](local-rules/testing-standards.md).
use a small manual real-stack proof with disposable accounts/data and bounded
external scripts where useful. no default obligation to recreate a test suite.
any permanent regression requires a separate concrete maintenance-cost
justification; cross-package capability composition and cancellation transitions
are the two candidate boundaries ordinary static checks miss.

| case | required observation |
| --- | --- |
| capability mismatch | the old conflicting combination is rejected before new run/provider/tool dispatch; supported exact combination completes through its real native boundary |
| authority | successful authorized tool use and independently demonstrated denial of ungranted effects, with exact runtime/configuration identity |
| ordinary chat | new chat and continuation complete for each distinct offered execution route; at least one real tool round trip per relevant native tool protocol |
| lost admission reply | same immutable key/body recovers one receipt/run; no duplicate generation or domain effect |
| leave/reopen and stream loss | complete prior text plus subsequent updates for the same run; reconnect never calls admission |
| no-step/prepared cancellation | truthful cancellation with zero native admission/session/tool effects; prepared journal identity preserved |
| active cancellation and publication race | accepted intent, authority drain and deterministic finalization; terminal run and accepted generation evidence are not overwritten |
| uncertain cancellation | no redispatch, no automatic attempt-budget renewal; persisted stop intent survives duplicate requests/reload and remains explicitly unresolved without evidence |
| liveness | dead job projects paused within existing advisory cadence; composer and row agree; disconnect does not erase cancellation authority |
| unavailable catalog | warm and cold api still serve saved history, run reads, active paths and undo/cancel hydration; new generation stays gated; catalog can recover through its existing owner |
| history migration | old meta events decode strictly; exact immutable facts, command/receipt identities, tool effects and undo evidence survive |
| revision mismatch | exercise run get/post and direct sse: old requests mutate nothing; current clients show reload guidance; after reload an acknowledged command only rereads its existing run |
| diagnostics | original safe host cause remains correlated after caller normalization fails; telemetry preserves both ingestion and originating request ids |
| original pane crash | first failing owner is identified, trigger reproduced and repaired, then the same journey succeeds; otherwise its ticket stays open |
| memory | successful representative tool-bearing work has attributable peak/process/cgroup measurements; no cap increase is used as evidence of a contract fix |

prove adverse boundaries locally or on a disposable real stack. do not inject
faults or kill production processes to satisfy a checklist. distinguish source
proof, static pass, manual pass, blocked and not-run. ordinary chat success does
not close the original-crash, cancellation or authority cases by implication.
reuse valid exact-pin evidence from the model-refresh work; do not repeat its
entire model/configuration matrix for this reliability change.

## 11. trade-offs and completion

- exact authority may leave codex unavailable until the native mechanism is
  proven; that is a visible capability limit, not grounds for a permissive flag.
- unresolved cancellation can require operator attention and block a reply
  path; pretending completion or repeating work would destroy the evidence.
  conservatively leaving every dead uncertain job suspended also forgoes
  automatic closure of some recoverable provider continuations; it keeps
  continuation authority in its existing owner.
- removing dynamic history fields requires one forward migration and a
  coordinated reload; it removes a permanent cross-service dependency.
- cold-start read availability defers authenticated catalog observation until
  generation needs it; fixed unsupported policy still blocks generation/release.
- a chat-specific wire guard adds one narrow protocol contract; it avoids
  overloading tool identity or carrying permanent dual schemas.
- manual proof costs real provider time; retaining only justified regression
  checks leaves less continuous coverage than a full suite. use the current
  repository verification policy deliberately.
- no general reconciliation platform is added. an old incident without adequate
  evidence may remain suspended while future work is repaired.

close only the tickets whose acceptance has actually passed. update the chat,
llm and host module/runbook contracts and delete contradictory retired prose,
dynamic run-selection fields, catalog plumbing from history, cancellation
auto-requeue, unused wire fields and unsafe new-message guidance. retain one
terse nonsecret integration receipt with exact pins, cases and evidence limits.

tracked work: [dispatch](tickets/restored-chat-codex-dispatch-fails.md),
[host diagnostics](tickets/codex-host-discards-original-runtime-failure.md),
[origin correlation](tickets/client-defect-origin-request-id-is-overwritten.md),
[uncertain cancellation](tickets/chat-cancel-uncertain-codex-requeues-without-settlement.md),
[prepared cancellation](tickets/prepared-chat-cancel-requires-unbound-mcp-authority.md),
[historical reads](tickets/conversation-read-500s-without-generation-catalog.md),
[api startup](tickets/api-startup-requires-codex-catalog-availability.md),
[paused wording](tickets/chat-suspended-response-announces-in-progress.md),
[failure guidance](tickets/chat-operator-defect-copy-invites-new-command.md),
[original crash](tickets/production-chat-pane-crash-and-stalled-response.md), and
[memory](tickets/interactive-worker-startup-reaches-memory-cap.md).

the owner authorized implementation on 2026-09-25. this specification does not
authorize a history reset, merge or deployment; those retain their separate
owners and release gates.
