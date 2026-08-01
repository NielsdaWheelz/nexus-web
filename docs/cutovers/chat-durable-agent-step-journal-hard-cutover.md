# Chat Durable Agent-Step Journal Hard Cutover

Status: Implemented
Date: 2026-07-31
Type: hard cutover; no legacy path, fallback, compatibility decoder, dual write, or backfill

## Decision

A chat run is one durable operation. Each generation, tool, and publication step
has a small replay record in its existing `background_jobs.payload`. A reclaimed
job reuses completed results, continues at the first incomplete step, and never
blindly repeats an ambiguous paid call or write.

Extract the owner-neutral replay kernel currently misplaced in
`services/artifacts/coordination.py`; do not build a second journal, workflow
engine, or chat-specific retry system.

## Philosophy

- Persist decisions at irreversible boundaries, not every line of execution.
- A committed result is replay input. It is not a cache hint.
- Unknown external outcome is coordination state, not a user-facing failure.
- Resume the same operation; do not create a replacement run.
- Domain tables own product truth. The queue owns in-flight recovery truth.
- Prefer safe suspension over duplicate billing, writes, or citations.
- Keep reconnect, execution recovery, and product failure distinct.

Follow `docs/rules/`, especially `operation-types`, `correctness`, `retries`,
`concurrency`, `mutation-ordering`, `database`, `boundaries`, `errors`,
`keys-and-identities`, `cleanliness`, and `simplicity`. Proof follows
`docs/local-rules/testing-standards.md`.

## Scope / 80-20 Boundary

Build:

- one shared Postgres-backed step-journal kernel;
- durable chat preparation, generation, tool, and publication steps;
- exact recovery after a completed provider/tool step;
- safe suspension after an ambiguous paid call or write;
- the web-search source-identity fix that caused the reported failure;
- one derived execution advisory in existing chat read models;
- cancellation and operator requeue of the same suspended job;
- hard deletion of restart-from-scratch and generic-terminal-on-defect paths.

Do not build:

- Temporal, Redis, Kafka, a broker, event sourcing, or a generic agent framework;
- a new journal table, run status, public step API, or journal viewer;
- token-by-token checkpoints or reconstruction from streamed deltas;
- provider-specific background generation, webhook recovery, or result polling;
- automatic reconciliation for an effect whose owner has no authoritative read;
- cross-device/offline execution, multi-user collaboration, or human approval steps;
- historical journal reconstruction or compatibility decoding;
- a redesign of prompts, model routing, tools, citations, trust trails, or the queue.

## Target Behaviour

1. Create returns the existing queued `ChatRun`; one `chat_run` job owns it.
2. The worker snapshots exact prepared model input once.
3. Before each paid or externally effectful dispatch, the worker durably records
   `Uncertain` with a stable generation/effect id and request fingerprint.
4. After accepting the result, the worker records a strict normalized result as
   `Completed` before any later step may depend on it.
5. A retry skips every `Completed` step without calling its provider or tool.
6. `Prepared` may execute. `Uncertain` may execute only after the binding proves
   non-dispatch or attaches a reconciled result. Otherwise the run suspends.
7. Expected provider/tool outcomes retain existing product semantics and may
   terminalize the run. A code defect rolls back and escapes to queue retry.
8. Retry wait is `Recovering`. Exhaustion is `Suspended`; neither is a terminal
   `ChatRun` status and neither emits `done`.
9. Operator repair requeues the same dead job with the same journal. User
   cancellation requeues a dead job only to fold cancellation.
10. Terminal publication remains one atomic domain transaction. A crash after it
    observes the terminal run and performs no second publication.
11. Any terminal outcome clears journal material before the queue job completes.
12. SSE reconnect keeps tailing the same committed event log and cursor. It does
    not trigger execution or create a new run. Unsequenced execution-advisory
    frames report queue liveness without advancing that cursor.

## Final Architecture

```text
POST chat run
  -> ChatRun + messages + chat_run job
  -> worker claim / lease / JobExecutionContext
  -> ChatStepRuntime
       prepare                         Completed exact GenerateIntent
       turn/{n}/generation             Prepared -> Uncertain -> Completed
       turn/{n}/tool/{global_index}    Prepared -> Uncertain -> Completed
       publication                     atomic Completed + terminal ChatRun
  -> existing domain facts
       llm_calls / message_tool_calls / message_retrievals
       external snapshots / chat_run_events / message / ChatRun
  -> clear journal -> queue completes

crash -> queue retry -> replay Completed prefix -> continue
ambiguous effect -> dead job -> Suspended -> operator requeue or user cancel
```

### Ownership

- `durable_step_journal.py`: strict state, codec, stable id, lease-fenced
  queue-payload checkpoint/clear operations, and the shared execution-phase
  projection. It runs no domain step.
- `chat_run_steps.py`: chat step paths, strict step results, replay policies,
  fingerprints, and `ChatStepRuntime`.
- `chat_runs.py`: chat control flow only; no raw journal JSON, web-result
  serialization, queue repair, or generic defect finalization.
- `chat_run_finalize.py`: the only terminal message/run/event publication fold.
- `chat_run_execution.py`: derive the unsequenced execution advisory from the
  run and its one queue job.
- `agent_tools/*`: execute one typed tool capability and return its canonical
  persisted result; no caller rebuilds its identity-bearing payload.
- `jobs/queue.py`: claim, lease, retry, dead letter, requeue, and payload CAS.
- `ChatRun`, messages, trust trail, and event tables remain domain truth.

## Journal Contract

Use the existing `background_jobs.payload["coordination"]` map. Add no table or
column.

```text
payload = {
  "run_id": UUID,
  "coordination": {
    step_path: {
      "generation_id": UUID,
      "dispatch_phase": "Prepared" | "Uncertain" | "Completed",
      "request_fingerprint": Presence[str],
      "terminal_result": Presence[str]
    }
  }
}
```

Rules:

- `generation_id = uuid5(shared_namespace, run_id + ":" + step_path)`.
- Paths are relative, deterministic, immutable, and created in this order:
  `prepare`, `turn/{turn}/generation`,
  `turn/{turn}/tool/{global_tool_index}`, `publication`.
- `request_fingerprint` is SHA-256 over the canonical serialized step request.
- `terminal_result` is JSON encoded by a step-owned frozen Pydantic model with
  `extra="forbid"`; arbitrary dictionaries never cross the journal boundary.
- State moves only `Absent -> Prepared -> Uncertain -> Completed`. A pure or
  single-transaction database step may commit directly as `Completed`.
- A phase and the database facts it claims must commit together where both are
  Postgres writes. External I/O never occurs inside a transaction.
- Checkpoint mutation is fenced by job id, worker id, attempt, and live lease.
  Lost lease aborts the attempt before any further work.
- `Completed` is immutable. Different fingerprint or result is a defect.
- The journal contains recovery material, including prompt/output text. Never
  log it, expose it in APIs, copy it into trust trails, or retain it after a
  terminal run.
- Dead `chat_run` jobs are never pruned. Completed/terminal jobs clear the
  `coordination` key to `{ "run_id": ... }` before returning.
- A dead journal remains only until operator repair, user cancellation, or
  conversation deletion. Conversation teardown deletes its chat jobs and
  journal payloads; generic queue cleanup never decides that lifecycle.

### Shared Kernel Hard Cut

Move the owner-neutral types/functions from
`services/artifacts/coordination.py` to `services/durable_step_journal.py`.
Rename Dossier-specific error text and parameters to `operation_id`. Update
Dossier, media-intelligence, and web-page-read imports directly. Leave only
Dossier runtime/yield behavior in `artifacts/coordination.py`.

Move Dossier's duplicate queue-status/attempt-count execution-phase derivation
to this owner too. Use one `DurableExecutionPhase` and one strict projection for
Dossier and chat. Product owners still decide whether a missing or succeeded
job is valid for their domain row.

Do not leave re-exports, aliases, old codecs, duplicate namespaces, or old test
imports. Existing non-chat behavior and persisted payload shape do not change.

## Chat Step Capability Contract

`ChatStepRuntime` is constructed only by the claimed job handler and contains:

```text
run_id
claimed JobRow
JobExecutionContext
ExecutionRuntime
web-search provider Presence
read(path, policy) -> StepState | None
prepare(path, fingerprint) -> Prepared
mark_uncertain(path) -> Uncertain
complete(path, strict_result) -> Completed
complete_database_step(path, fingerprint, strict_result) -> Completed
lock_active_attempt() -> held live-lease fence
clear() -> None
```

It owns commits required by the coordination protocol. Domain code cannot
mutate queue payload JSON directly. The stored `ExecutionRuntime` is passed
unchanged into the sole `llm_execution` generation boundary; that boundary's
pre-dispatch checkpoint invokes `mark_uncertain(path)` immediately before the
runtime call.

### Step Results

```text
PreparedChatRun = {
  generate_intent,
  initial_citation_ordinal,
  initial_tool_call_index
}

GenerationStepResult =
  | { kind: "AssistantTurn", normalized_turn, usage,
      last_provider_event_seq }
  | { kind: "ExpectedFailure", failure, usage,
      last_provider_event_seq }
  | { kind: "Cancelled", last_provider_event_seq }

ToolStepResult = {
  tool_call_id,
  tool_name,
  tool_call_index,
  model_output,
  next_citation_ordinal,
  result_event
}

PublicationStepResult = {
  outcome: "Published" | "Degraded" | "Failed" | "Cancelled",
  message_id,
  terminal_event_seq
}
```

The concrete Pydantic schemas use rich existing types for generate intents,
tool messages, expected failures, usages, events, UUIDs, and `Presence`. They do
not duplicate provider SDK objects or create a second product outcome model.

### Dispatch Policy

| Step | Policy | Uncertain replay |
|---|---|---|
| model generation | `BilledOnce` | reconcile through provider capability or suspend |
| public web search | `ReDispatchable` only with stable provider request key; otherwise `BilledOnce` | redispatch or suspend, as declared |
| app/resource read | `ReDispatchable` | execute again from identical request |
| assistant write | `BilledOnce` | authoritative readback/idempotency proof or suspend |
| publication | database atomic | inspect terminal `ChatRun`; never republish |

The binding fixes policy by tool name. Callers cannot select it. A modeled tool
error is a completed tool result, not a journal failure.

Current assistant writes are Postgres effects. Pass the stable step
`generation_id` into the existing mutation key, and commit the write, Undo
fact, tool/event facts, and journal `Completed` together under the live-lease
fence. Where a future owner cannot make that atomic or authoritatively prove an
external effect, preserve `Uncertain` and suspend. Never use a new random replay
id on a repeated step.

## Web Search Identity Cut

The raw provider ref and persisted resource identity are different nominal
types:

```text
ProviderResultRef      # vendor result identity; provider boundary only
ExternalSnapshotId     # Nexus UUID; persisted/event/trust identity

PersistedWebSearchResult = {
  tool_call_id,
  citations: [{ external_snapshot_id, ... }],
  selected citations,
  model_output,
  strict result_event
}
```

Rules:

- `WebSearchCitation` never defaults `source_id` to `result_ref`.
- Persistence mints every `ExternalSnapshotId` and returns the canonical typed
  result. Callers serialize only that result.
- Snapshot rows, `message_tool_calls`, retrievals, candidate numbering,
  `tool_result`, and journal `Completed` commit in one transaction after the
  provider returns.
- Delete `WebSearchRun.retrieval_result_event()`, nullable `source_id`, and all
  raw-citation event construction.
- Keep strict UUID validation. Do not accept provider refs in
  `WebRetrievalResultRef`.
- Remove the internal commit from `persist_web_search_run`; the step owner owns
  the transaction.

## Defect, Retry, Dead Letter, and Cancellation

- Delete the broad `execute_chat_run` catch that calls `finalize_defect`.
  Roll back, log safe correlation fields, and let defects reach the queue.
- Delete `has_provider_output_without_terminal` and `finalize_interrupted` as
  execution control. The journal is the only resume decision owner.
- Keep bounded queue retry in one layer. Do not add provider/tool retry loops.
- Set `chat_run.never_prune_dead=True`.
- The dead-letter hook records safe diagnostics. It does not terminalize the
  run, assistant message, or event stream. Its sole state transition is to
  requeue that same dead row when cancellation was already committed, closing
  the cancel-before-dead ordering race.
- `requeue_dead_job` is the sole repair transition and preserves payload,
  journal, run id, and logical operation identity.
- `reconcile_uncertain_chat_step(run_id, step_path, resolution)` is the
  operator-only service command. Under one job lock it accepts the existing
  `ProveNotDispatched` or `AttachReconciledResult`, strictly validates the
  step-owned result, changes `Uncertain` to `Prepared` or `Completed`, and
  requeues that job. It has no HTTP route or browser UI.
- Attachment repairs the journal only after canonical LLM-ledger or
  tool/event/domain facts prove the exact result already exists. It never
  fabricates missing billing, citation, retrieval, write, Undo, or SSE facts.
- Cancellation is checked before and after each step. No new step starts after
  `cancel_requested_at`.
- Cancelling a dead job requeues that same job; the worker publishes the normal
  cancelled terminal fold, clears the journal, and completes.
- If final publication commits first, later cancel is a no-op. Otherwise cancel
  wins before the next step.

## API and UX

Add one derived, read-only field to both `ChatRunOut` and `TrustRunOut`:

```text
execution: Presence<{
  phase: "Queued" | "Running" | "Recovering" | "Suspended"
}>
```

Projection:

| Run/job fact | Execution |
|---|---|
| nonterminal + queued | `Queued` |
| nonterminal + running first attempt | `Running` |
| nonterminal + retry wait or later attempt | `Recovering` |
| nonterminal + dead | `Suspended` |
| terminal run | `Absent` |
| nonterminal run with no unique job | defect |

This is an unsequenced advisory, not a `ChatRun` status, SSE cursor fact,
expected failure, or `done` event.

The existing cursor stream also emits the existing wire shape
`ExecutionAdvisory { phase }` without an SSE `id`. Generalize the current
Dossier `read_advisory` seam and strict decoder once; do not add a chat polling
loop, endpoint, or second advisory format. The response projection supplies the
initial/reload state; SSE supplies changes while attached.

UX rules:

- `Queued`, `Running`, and `Recovering` use the existing gutter/activity surface.
- `Suspended` replaces the spinner with the existing compact failure-card
  grammar: title `Response paused`; body `Nexus saved the completed work but
  could not safely continue.`
- Suspended partial text and completed tool provenance remain visible.
- Do not show `Run again`; that creates a different run. Preserve the existing
  cancellation command for abandoning this run.
- Network loss still shows `Reconnect`; reconnect never means execution retry.
- On operator requeue, the advisory changes `Suspended -> Recovering`; no new
  endpoint or client command is added.

## Intra-System Composition

- Queue claim supplies `JobExecutionContext` through `registry -> tasks/chat_run
  -> execute_chat_run`; no layer discards it.
- Every worker event/effect transaction first locks and validates that exact
  job id, worker id, attempt, status, and unexpired lease. Losing the lease
  aborts before any further durable fact commits.
- `chat_run_response` and batched trust-trail assembly call the same execution
  projection; do not issue per-message job queries.
- `ChatRunEventEmitter` receives only strict, canonical event payloads from the
  step result owner.
- The LLM ledger remains billing/provenance. It is not replay memoization.
- `chat_prompt_assemblies` remains a text-free trust artifact. It is not exact
  execution input.
- Journal state never becomes conversation history, prompt context, or a
  citation source.

## Files

Create:

- `python/nexus/services/durable_step_journal.py`
- `python/nexus/services/chat_run_steps.py`
- `python/nexus/services/chat_run_execution.py`
- `python/tests/kernel/test_durable_step_journal.py`
- `python/tests/service/test_durable_job_replay.py`
- `python/tests/service/test_auth_privacy.py`
- `python/tests/service/test_citation_provenance.py`
- `apps/web/src/components/chat/ChatComposer.browser.test.tsx`
- `apps/web/e2e/journeys/grounded-chat-citation.journey.spec.ts`

Modify:

- `python/nexus/services/artifacts/coordination.py` and its direct consumers;
- `python/nexus/jobs/registry.py`, `python/nexus/tasks/chat_run.py`;
- `python/nexus/services/chat_runs.py`, `chat_run_response.py`,
  `chat_run_finalize.py`, `chat_run_event_store.py`, `chat_run_tools.py`, and
  conversation teardown;
- `python/nexus/api/routes/stream.py` and the shared cursor-stream advisory
  binding;
- `python/nexus/services/agent_tools/{web_search,app_search,writes}.py` and only
  other tool adapters required by the declared dispatch table;
- `python/nexus/schemas/conversation.py`, batched trust-trail projection;
- `apps/web/src/lib/conversations/types.ts`,
  `apps/web/src/components/chat/useChatRunTail.ts`, the shared strict SSE
  advisory decoder, `AssistantMessage.tsx`, `ChatFailureCard.tsx`, and the
  browser proofs above;
- `docs/architecture.md`, `docs/modules/{chat,jobs}.md`, and superseded cutovers.

Delete:

- restart-from-provider-output terminalization;
- dead-letter generic chat finalization;
- raw web-citation event serialization;
- artifact-owned copies/re-exports of shared journal primitives;
- tests and comments asserting retry-from-scratch or terminal-on-defect.

No database migration is required.

## Landing Plan

1. **Release gate:** stop chat workers and prove zero queued/running/retry-wait
   `chat_run` jobs. Existing terminal runs need no backfill.
2. **Shared kernel:** extract the current coordination primitive; update all
   consumers; prove no behavior or payload-shape change.
3. **Identity:** land the typed persisted web-search result and atomic event
   transaction; delete the defective serializer.
4. **Durability:** pass job context, add chat step runtime/results, cut executor
   to journal replay, and change dead-letter/cancel behavior.
5. **Projection:** add the one execution advisory and suspended UX.
6. **Extirpation and proof:** delete old paths, update authoritative docs, run
   source guards, recovery matrices, real Postgres, and one browser journey.

Each wave is reviewable and green. The release ships only after all waves;
there is no mixed old/new runtime.

## Acceptance Criteria

1. The reported case—provider refs that are not UUIDs—fails before the fix and
   passes with a persisted `ExternalSnapshotId` in `tool_result`.
2. A crash after generation `Completed` but before tool-result processing
   resumes without a second model call and publishes one answer.
3. A crash after a tool `Completed` resumes without a second tool effect and
   emits one canonical result event.
4. A crash at every `Prepared`, `Uncertain`, and `Completed` boundary preserves
   the state-machine and transaction rules.
5. An `Uncertain` billed/write step is never blindly redispatched. Prove
   reconciliation, operator attachment, proof-of-no-dispatch, and suspension.
6. A code defect retries through the queue without terminalizing the run or
   emitting `done`; exhaustion projects `Suspended` and retains the job.
7. Requeue continues the same job/run/journal. Cancel of a suspended run
   publishes one cancelled terminal and clears the journal.
8. Final publication is exactly once across crash/reclaim. Terminal runs expose
   no execution advisory and retain no coordination payload.
9. SSE disconnect/reload neither starts execution nor loses committed text,
   tool provenance, citations, or cursor position.
10. Conversation deletion removes queued/dead chat jobs and their journal
    material; generic dead-job pruning cannot remove a repairable chat job.
11. Shared Dossier/media/page-read recovery behavior remains unchanged after
    extraction; no old import or payload decoder survives.
12. Static guards find no `has_provider_output_without_terminal`,
    `finalize_interrupted`, raw `retrieval_result_event`, artifact re-export, or
    chat dead-letter finalization path.
13. Priority-risk proofs use independent oracles and demonstrated-red evidence.
    Run focused static/kernel checks, real PostgreSQL service recovery, and one
    real-worker Chromium journey. Report provider, CI, deploy, recovery-drill,
    and production evidence separately; unrun gates are not passed.

## Supersession

On implementation, amend these documents rather than leaving contradictions:

- `chat-publication-thin-spine-hard-cutover.md`: supersede “no durable
  Generated -> Published phase or publication replay” only.
- `llm-provider-runtime-hard-cutover.md`: supersede chat retry-from-scratch/no
  checkpoint-replay clauses only.
- `generation-run-harness-hard-cutover.md`: supersede, for durable chat only,
  the in-memory/drop-on-retry provider-result clause. Other generation owners
  keep their declared policy.
- any chat module text that makes worker retry the resume owner without
  persisted per-step state.

All other product, citation, provider, tool, queue, and trust-trail contracts
remain authoritative.
