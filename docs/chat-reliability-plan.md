# chat reliability for the codex shell cutover

status: implementation candidate; release qualification incomplete · 2026-09-27
baseline: remote `main` at `fbd08ba68a699aa497c8281044a59f8709cf43ef`
scope: one combined release from the currently deployed `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, subject to a fresh preflight

implementation evidence and remaining gates: [verification receipt](chat-reliability-verification.md).

## outcome and evidence boundary

a chat send has one durable command and run. the browser either shows its reply,
its confirmed terminal outcome, or a truthful paused state requiring repair.
leaving the pane, losing the stream, or asking to stop never creates another
generation or silently repeats a nexus ledger-owned domain effect. shell and
public-network effects are outside that guarantee. saved conversations remain
readable when the model host or catalog is unavailable.

the new codex shell route has already produced replies and model-originated
api effects on an isolated pre-merge cohort; the
[verification receipt](codex-shell-cutover-verification.md) does not qualify
the merged main tree or production. its
[approved authority contract](codex-shell-cutover-plan.md) supersedes the
frozen-mcp design in the earlier `feature/chat-reliability` branch. this plan
does not restore exact model-visible tool grants or alter the shell's authority.

the original browser pane crash occurred earlier, is not reproducible, and has
no retained initiating exception. neither vps memory pressure nor the later
codex dispatch error is established as its cause. a fresh authenticated chat
journey is a release requirement; the original incident remains open unless
its first failure is captured, reproduced, and repaired.

## ownership and invariants

| invariant | owner |
| --- | --- |
| one immutable send key/body and accepted receipt survive an ambiguous reply | existing browser draft store and chat admission transaction |
| accepted work is reread or tailed under the same run; reconnect is never admission | chat engine and run routes |
| saved dispatch facts come from the frozen generation spec, not current model availability | chat history projection |
| current eligibility is checked only for a new generation | generation catalog and admission |
| stop intent is not a completed cancellation; terminal and effects are never fabricated | chat run, generation journal, and shell authority owner |
| queue state is liveness, distinct from the product outcome | chat execution projection |
| browser status and stop target use the selected pending run, not an sse connection id | conversation engine and composer |
| the first defect remains correlated across browser, api, worker, and host | detecting owner and existing telemetry/logging |

the shell plan owns native execution, isolation, its broad generation-api
grant, bearer lifetime, process drain, and external-effect limits. the
latest-model plan owns model membership, policy mapping, provider pins, and
the approved reset of old chat/generation history. this plan owns only the
remaining chat reliability delta. do not transplant the old branch's mcp
adapter, capability gate, retired binder, or `0242` migration.

## 1. separate history from admission

`RunSelectionOut` becomes a historical value derived solely from the stored
`GenerationSpec`:

```text
selection
catalog_definition_revision
source_catalog_definition_revision
display_at_dispatch
tool_authority
```

remove `current_state`, `current_state_observed_at`, and
`rerun_eligibility` from that value and its exact browser decoder. preserve
strict validation of the stored spec; missing or corrupt immutable facts
remain defects. do not reconstruct labels from current policy, substitute a
model, or imply that historical `tool_authority` is an exact shell tool list.
the current picker and `/llm-catalog` alone describe new-generation
availability.

remove `catalog.read_chat()` from saved run get/list, conversation tree and
active path, cancel response, and conversation undo response. after a send is
accepted, its response hydration also uses the frozen selection; a catalog
refresh failure must not turn a committed send into an ambiguous http failure.
failure `can_rerun` and message-level rerun affordances describe structural
source applicability, not current model readiness. an eligible source may
open a candidate picker even when its old model is gone. default exact-choice
rerun refreshes current catalog and requests an explicit new choice if that
selection is unavailable; server admission validates the new pair. operator
defects remain ineligible. preserve existing durable draft, command, receipt,
and same-run read recovery.

api startup validates local configuration, schema and installed contracts
without awaiting external codex catalog i/o. the existing catalog service
performs discovery at its request/refresh owner. until discovery succeeds,
new generation stays closed with typed unavailability; saved reads and other
api routes work. once it returns, validate the fixed background policy before
dispatch. no synthetic catalog, second cache, or polling supervisor.

## 2. stop without replaying uncertainty

`ChatRun.cancel_requested_at` remains the sole persisted intent. the cancel
transaction uses the existing chat-admission, generation-owner, run and job
lock order; closes the run's generation-api admission; and commits intent
before claiming success. an accepted request means intent was recorded.
the first null-to-timestamp transition is the one-shot wake latch; no second
cancel marker is stored. if intent was recorded while a job was active and the
job later dead-letters before folding it, the dead-letter owner may directly
settle, or wake once to settle, a proven no-step, undispatched prepared, or
completed state under the same locks. it never wakes uncertain work.
the shell owner still interrupts and drains the native process and sandbox;
closing the bearer alone is not proof that external work stopped.

| locked generation state | required behavior |
| --- | --- |
| run terminal | return the unchanged terminal |
| no generation step | settle cancellation without provider or shell admission |
| prepared, with no armed child or effect evidence | use the existing undispatched prepared cancellation transition atomically |
| active dispatched work | retain intent; interrupt and drain through the existing owner, then fold actual terminal evidence |
| completed generation awaiting publication | replay its accepted memo; the locked finalizer decides publication versus cancellation without rewriting the generation terminal |
| dead with uncertain dispatch or effects | close further api admission, request owner-owned shell interrupt/drain, and remain suspended; do not requeue, redispatch, reset attempts, or claim cancellation complete |

delete unconditional dead-job requeue on `POST /chat-runs/{id}/cancel` and the
automatic cancelled dead-letter loop. the first cancel may wake the same dead
job once only when the generation owner proves local settlement from no step,
prepared, or completed evidence. duplicate requests never renew that budget.
an uncertain provider continuation remains with the generation owner; chat
does not infer safety from a missing row, elapsed time, or an interrupt ack.
operator repair requires retained terminal evidence or independently verified
non-dispatch for the same run, generation, child and effect positions. the
existing suspended production run is not reset or silently requeued.

## 3. one durable execution state and truthful browser controls

derive one chat-specific value from the run and its queue job in a coherent
read transaction:

```text
ChatRunExecution = {
  phase: Queued | Running | Recovering | Suspended,
  cancel_requested: boolean
}
```

the boolean projects `cancel_requested_at != null`; it is not stored again.
remove the redundant top-level wire timestamp but retain the database field.
terminal runs have absent execution. use this value in run and trust-run
responses and the existing unsequenced `ExecutionAdvisory`. the chat stream
kind serializes this chat-only payload; the shared tail only transports it.
publish a change in either field without advancing the committed text cursor.
chat sse listens
to appended chat events, while cancellation and queue transitions need not
append one. use the existing listener's 15-second idle read fallback to
observe those changes; verify that bound after stop, suspension and reload.
do not add a second notification system. other features keep their phase-only
execution shape.

the selected active path's canonical pending assistant run owns the composer
status and stop target. enforce the existing one-pending-run-per-reply-path
invariant rather than choosing the first pending run across branches. an sse
subscription only transports updates; losing it cannot erase stop authority.
the browser retains its current pending-http latch and existing immutable
command/receipt store, with no second reconnect or cancellation state.

| observed state | presentation and action |
| --- | --- |
| accepted send awaiting canonical read | message received; read the same receipt/run |
| queued or running | show honest progress; stop targets that run |
| server recovering | say recovering response, retain text, and allow stop; do not present transport reconnect as an execution repair |
| connection lost while run is nonterminal | retain text and reconnect the same run; stop remains available from canonical facts |
| stop requested, work not terminal | say stop requested; disable duplicate stop; never claim stopped |
| suspended without stop intent | say response paused, preserve text, and permit one request stop against the canonical run; offer no progress animation or false reconnect remedy |
| suspended with stop intent | say stop requested and outcome unconfirmed; preserve text and disable repeat stop |
| terminal | show the accepted result; terminal wins over transport state |

unresolved work still blocks another send on its reply path, while draft
editing and reading remain available. codex shell publishes final-only answer
text under its secret-filtering contract; the ui must not promise incremental
tokens. preserve transcript position and focus, and announce status changes
without repeated focus theft. operator/generic defect copy must not invite a
new command; retain the support reference and state that this response could
not complete. do not promise repeatability or repair that the evidence lacks.

## 4. diagnostic ownership

at the detecting host boundary, record the original exception class, safe
cause/code, stage, generation/child identity and native revision before
normalizing a failure kind. retain the existing browser defect boundary. at
telemetry ingest, keep middleware `request_id` for the
ingestion request and log the browser's reported failed request as
`origin_request_id`; preserve command, run, phase and component identity.
do not log prompts, bearer values, arbitrary payloads, or a second telemetry
store. do not add broad catches or new message error boundaries to hide a
defect.

if the old pane crash recurs, capture the first browser exception and failed
request, match any accepted receipt/run, and repair its actual owner. until
then, keep its ticket open. a normal new/existing-chat browser journey can
qualify this release without claiming that vanished exception was fixed.

## 5. strict wire and release data boundary

the changed `RunSelectionOut` and chat-only execution advisory are one new
chat wire contract. add one backend-owned chat revision, request header
`X-Nexus-Chat-Contract`, and typed 409
`E_CHAT_CONTRACT_RELOAD_REQUIRED`. require the revision, after normal
authentication and before work, on rich chat run create/get/list/cancel,
rerun/regenerate, conversation tree/active-path and trail-bearing undo, and
direct chat sse. wire the existing browser api helper, bff allowlist, stream
cors, exact decoders, and reload notice to that revision. do not repurpose
the tool-projection hash, which describes tools. an old client may show its
old pane boundary during the single-user cutover, but must not mutate through
an incompatible contract. a post-cutover acknowledged command is reread after
reload, never discarded or automatically reissued. pre-cutover v4 commands
follow the already approved v4-to-v5 draft conversion and history reset: the
browser preserves recoverable text and choice but cannot promise the old
accepted run survives. both the existing tool-projection guard and the new
chat guard must run after authenticated viewer or stream-bearer resolution;
the current route-level tool dependency runs before stream authentication.

main's `0246` migration deliberately deletes old chat/generation history and
its `0247` adds generation-api credentials. this plan does not add the old
branch's history-preservation `0242` or rewrite pre-reset `meta` events. the
target combined release must confirm that no post-`0246` chat events already
exist. if a target has accepted such events, stop and replan their exact
forward migration before this wire change; do not recursively prune json or
silently drop those runs. no second history reset is authorized.

`0246` rejects nonterminal old chat/generation work and unsettled non-chat
generation owners. quiesce and census the production suspended run, all other
nonterminal chat jobs/calls, and domain admissions before migration. settle
only with real evidence. the latest-model plan permits abandoning uncertain
old paid work, but there is no executable abandonment transition today: this
is a release blocker. if settlement is impossible, the model-cutover owner
must specify and implement a reviewed, allowlisted pre-migration disposition
that records the exact ids, fingerprints, accepted effects, uncertainty,
stopped processes, revoked grants and verified backup; it may remove only
old chat-owned data under the approved reset and must not fabricate a
terminal, erase retained domain effects or undo, or redispatch anything.
prove the revised `0246` preflight and migration on that exact case before
release. the release controller owns ancestry preflight, stopped writers,
verified backup, forward migration, aligned api/worker/host/browser images, exact-head
check and browser/webview reload. an old image alone cannot roll back the
destructive reset after new writes.

## implementation order and file ownership

work in a fresh branch from current remote main; keep the dirty local main
and the obsolete feature branch untouched. these are owners, not mandatory
agent counts. serialize shared files and publish the backend wire before
browser edits. each package first captures its failing boundary in a bounded
temporary integration/live proof, then implements, refactors and reruns it;
an independent review challenges each contract and transition. delete
temporary proofs only after every required observation passes.

1. backend read owner: `generation_catalog.py`, `app.py`,
   `chat_run_{selection,response,execution}.py`, conversation/trust
   projections, read routes and schemas. establish catalog-outage and
   post-admission-read reds, then remove the live dependency and dead dynamic
   fields.
2. cancellation owner: `chat_runs.py`, `tasks/chat_run.py`,
   `chat_run_worker.py`, `llm_execution.py`, and the existing generation-api
   authority owner where needed. prove each locked state before editing;
   preserve bearer closure and shell drain. no retired mcp code.
3. browser/wire owner: chat revision guards and schemas first, then exact
   decoders, advisory fold, `useConversation`, `ChatComposer`, row and failure
   copy. keep the existing draft and stream mechanisms.
4. diagnostics owner: `apps/codex_agent/host.py` records the original safe
   failure before `codex_generation_contract.py` normalizes or rejects it;
   `api/routes/telemetry.py` preserves both request identities.
5. integration owner: narrowly necessary docs/tickets,
   migration/release preflight, final-tree proof and adversarial review of
   effect and identity preservation. update stale chat/llm module prose to
   describe the shipped shell contract.

## acceptance and release gates

`./scripts/test` is the sole automated static gate. use disposable real-stack
proofs for behavior that static checks cannot establish; remove temporary
proof scripts after their required cases pass, and retain a nonsecret receipt
with exact source, images, native revision, results and limits.

| case | required observation |
| --- | --- |
| cold/warm catalog outage | api serves saved tree, run, active path, cancel/undo hydration and unrelated reads; new generation stays unavailable; catalog recovery reopens admission |
| immutable send | lost admission reply rereads one receipt/run; a later catalog outage cannot turn acceptance into an ambiguous failure |
| cancellation | no-step/prepared settle with no shell/api effects; active stop proves authority drain or remains uncertain; completed memo replays once; uncertain and duplicate stops do not redispatch or renew attempts |
| browser liveness | new and existing chats reply; stream loss/reload rereads the same run; row and composer agree on queued, running, stop-requested, paused and terminal states; stop survives disconnection |
| wire mismatch | stale authenticated reads/mutations and direct sse fail before work; current client reloads and rereads a post-cutover acknowledged run; unauthenticated stream still rejects on auth first |
| diagnostics | first safe cause survives normalization; a browser defect log retains distinct ingestion and origin request ids; no bearer or prompt appears |
| original crash | if reproduced, first failing owner is fixed and replayed; otherwise keep its ticket open and report the fresh browser journey separately |
| migration | exact production ancestry, backup and quiescence; suspended old work is settled or handled by the newly reviewed allowlisted abandonment operation; domain data/effects/undo survive and post-cutover history is readable |

the combined release also inherits, without weakening, the
[shell cutover](codex-shell-cutover-plan.md) and
[latest-model](latest-models-cutover-plan.md) gates: final merged-tree chat and
provider cells, all twelve valid background roles including a model-originated
background write, browser effect list and browser undo, auth refresh,
process death/restart and network denials, resource fit, and protected
migration. the 20 anthropic nexus cells remain
blocked by the owner's retention decision. before release, the owner must
either authorize that retention and qualify those cells or explicitly amend
the offered catalog and its acceptance; no silent shrink. the four xai cells
are explicitly waived, not passed. do not label the combined candidate
deployable while a required configured cell or runtime boundary is unqualified.

## explicit trade-offs

- the approved shell gives every codex run scratch, public internet and the
  same broad account api. nexus can audit and undo its domain-api writes;
  shell and external-network effects have no equivalent nexus replay/undo.
- the approved `0246` cutover removes old chat history. the backup can recover
  it only through a separate restore with consequences for later writes.
- uncertain external work can remain paused indefinitely. operator evidence,
  not a retry button or elapsed time, is required to settle it.
- a narrow chat revision and coordinated reload add one protocol boundary so
  old clients fail closed during the incompatible wire change.
- temporary live proofs reduce permanent test maintenance, but leave less
  continuous behavioral coverage. static checks are never reported as a
  successful chat journey.

tracked reliability work: [cold startup](tickets/api-startup-requires-codex-catalog-availability.md),
[cancel](tickets/chat-cancel-requeues-uncertain-dead-job.md),
[browser state](tickets/chat-composer-loses-durable-stop-state.md),
[defect copy](tickets/chat-operator-defect-copy-invites-new-command.md),
[host diagnostics](tickets/codex-host-original-failure-not-retained.md),
[original crash](tickets/production-chat-pane-crash-unattributed.md),
[migration disposition](tickets/model-history-cutover-blocked-by-uncertain-work.md),
and the updated [chat](modules/chat.md) and [llm](modules/llms.md) module docs.
the [outstanding-issues register](outstanding-issues.md) tracks inherited
model and shell release gates.

this plan authorizes no production merge, migration, reset, or deployment.
those actions retain their separately approved owners. close only tickets
whose stated evidence has actually passed.
