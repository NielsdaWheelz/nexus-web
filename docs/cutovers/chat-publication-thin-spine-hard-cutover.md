# Chat Publication Thin-Spine Hard Cutover

Status: IMPLEMENTED
Date: 2026-07-26
Type: hard cutover; no legacy path, fallback parser, compatibility payload, or dual write

## North star

A chat run either publishes a trustworthy answer, publishes an explicitly
degraded answer whose references were rejected, or fails. Candidate evidence,
final citations, queue completion, and product outcome are distinct facts.
One run can be diagnosed from its row, trust trail, LLM ledger, and one terminal
log event.

This is the 80/20 reliability cutover. It reuses durable chat runs, run events,
`message_retrievals`, resource-graph citation edges, the LLM ledger, SSE replay,
and the two declared worker lanes. It adds no workflow engine, broker, tracing
platform, evidence registry, or new lifecycle state machine.

## Scope and rules

This owns citation candidate/final semantics, degraded publication, run facts,
support-id projection, terminal diagnosis, and activation of the declared
worker split. It does not redesign adjacent chat capabilities.

Follow `docs/rules/{boundaries,errors,tagged-unions,database,cleanliness,simplicity,testing}.md`:
generated markdown is untrusted at one ingress; unions are exhaustive; defects
never degrade; semantic absence uses `Presence`; domain invariants stay in
application code; tests assert behavior; superseded paths are deleted.

## Goals

- Accept sparse valid model citation markers and publish dense reader citations.
- Persist only actually cited sources as final citation edges.
- Preserve usable prose when generated citation syntax is invalid, with an
  explicit amber warning.
- Make selected, numbered, and cited evidence separate persisted facts.
- Use one closed chat-execution outcome inside the chat owner.
- Surface resolved run facts and the support id through every chat read model.
- Keep background work from head-of-line blocking interactive chat.
- Emit one compact terminal run receipt.
- Delete contradictory validation, projection, logging, and UI paths.

## Non-goals

- No `Generated -> Published` durable phase or publication replay.
- No FinalAnswer IR, claim verifier, evidence registry, or answer grader.
- No generic job-result framework or queue-schema redesign.
- No OpenTelemetry deployment, dashboards, paging, or formal SLO system.
- No worker autoscaling, priorities, chat-only lane, WebSockets, Kafka, or
  workflow platform.
- No provider retry, prompt, tool, retrieval-ranking, or citation-card redesign.
- No historical reconstruction of uncited candidate numbers that were never
  persisted.

## Target behavior

1. Evidence admitted to a prompt receives a turn-global
   `citation_candidate_ordinal` (`1..K`). This is the model-facing `n`.
2. Generated `[N]` markers refer to candidate ordinals, not final UI ordinals.
3. Valid referenced candidates are renumbered by first marker appearance:
   `[3] -> [1]`, `[2][4] -> [1][2]`. Repeated markers keep the same number.
4. No markers is valid. The answer publishes with no citation edges.
5. An unknown candidate or linked marker is a typed generated-output rejection.
   The sole degraded path removes citation-marker syntax, publishes the prose
   with no citations, stores `CitationsUnavailable`, and assigns a support id.
6. Database, graph, or same-system invariant failures are defects. They fail the
   run; they never become a degraded answer.
7. Final markdown, citation edges, retrieval back-pointers, context refs,
   terminal run/message facts, and terminal events commit atomically.
8. Terminal reconciliation replaces streamed draft text with canonical
   persisted markdown and backend-built citations.

## Final architecture

```text
retrieval/tool result
  -> message_retrievals.citation_candidate_ordinal
  -> model markdown using candidate [N]
  -> chat citation canonicalizer
       -> Published: canonical markdown + cited candidate map
       -> Degraded: marker-free markdown + CitationsUnavailable
  -> one finalization transaction
       -> final citation edges + cited_edge_id
       -> context refs + citation_index
       -> message + chat_run + done
  -> SSE terminal reconcile
  -> answer / amber warning / red failure
```

### Ownership

- `chat_run_citations.py` owns candidate numbering, canonicalization, final
  citation publication, and citation-event construction.
- `resource_graph/citations.py` owns the shared markdown marker parser. Artifact
  citation validation remains unchanged.
- `chat_run_finalize.py` owns the only terminal message/run/event fold.
- `chat_runs.py` orchestrates; it does not interpret citation syntax or build
  wire projections.
- `message_trust_trails.py` builds the only assistant trust read model.
- `chat_failure.py` owns expected failure and rerun policy only.
- `tasks/chat_run.py` converts the typed chat outcome once to the generic job
  result payload.
- The queue owns execution completion; it does not decide whether an answer was
  published.

## Persistence

Migration `0196_chat_publication_thin_spine.py`:

```text
message_retrievals.citation_candidate_ordinal  integer NULL
chat_runs.publication_warning_code             text NULL
```

Rules:

- Candidate ordinals are positive, dense, unique per assistant message, and
  immutable after emission into a provider prompt. Enforce in application code.
- One numbering helper assigns ordinals to selected citable retrieval rows and
  returns the numbered rows plus the next ordinal. Provider tool-output
  rendering consumes that result; it never maintains a second counter.
- `selected=true` does not imply a candidate ordinal.
- A candidate ordinal means the row was exposed to the model with that `n`.
- `cited_edge_id` is NULL until final publication and points only to a final
  `origin='citation'` edge.
- `publication_warning_code` is NULL except for a complete degraded run. The
  only value is `CitationsUnavailable`.
- A warning requires `support_id`; an ordinary published run has neither.
- Backfill `citation_candidate_ordinal` from the cited edge ordinal where
  `cited_edge_id` already exists. Leave unrecoverable historical candidates
  NULL. No runtime compatibility branch reads old semantics.
- Rewrite persisted historical `done` events once to the strict eight-field
  Presence contract; do not retain a legacy decoder.
- Add no indexes or database business-invariant constraints.

## Capability contracts

### Citation canonicalizer

Pure input:

```text
generated_markdown
candidates: [{ candidate_ordinal, retrieval_id, target_ref, snapshot }]
```

Pure output:

```text
CanonicalCitationResult =
  | { kind: "Published", content_md, citations:
        [{ candidate_ordinal, final_ordinal }] }
  | { kind: "Degraded", content_md,
      warning_code: "CitationsUnavailable", detail }
```

Rules:

- Parse once with the shared marker parser.
- Final ordinals follow first appearance, not retrieval order.
- Reject linked citation markers and candidate ordinals absent from the input.
- `Degraded.content_md` removes only recognized citation-marker syntax. It does
  not rewrite prose.
- The result is total for generated citation syntax. It performs no I/O.

### Chat execution outcome

`execute_chat_run` returns one closed chat-owned union:

```text
ChatExecutionOutcome =
  | { kind: "Published", run_id, message_id, citation_count }
  | { kind: "Degraded", run_id, message_id,
      warning_code: "CitationsUnavailable", support_id }
  | { kind: "Failed", run_id, error_code: Presence<string>,
      support_id: Presence<string> }
  | { kind: "Cancelled", run_id }
  | { kind: "Skipped", reason: "MissingRun" | "Terminal" }
```

All branches are exhaustive. `tasks/chat_run.py` is the only serializer to a
plain queue result object. A handled `Failed` chat outcome completes the queue
job because the handler successfully terminalized the domain run; queue retry
remains reserved for an exception escaping the chat boundary.

## API and event design

Add:

```text
ChatPublicationWarning = { code: "CitationsUnavailable" }

ChatRunOut:
  support_id: Presence<string>
  publication_warning: Presence<ChatPublicationWarning>

TrustRunOut:
  reasoning_effort: Presence<string>
  support_id: Presence<string>
  publication_warning: Presence<ChatPublicationWarning>

TrustRetrievalOut:
  citation_candidate_ordinal: Presence<int>
```

Hard-cut `support_id` out of every `ExpectedChatFailure` variant. The run is the
single support-occurrence owner. `ChatFailureCard` receives the run support id
explicitly; it never extracts it from failure taxonomy.

Every terminal `done` payload carries:

```text
status
error_code: Presence<string>
support_id: Presence<string>
publication_warning: Presence<ChatPublicationWarning>
usage
final_chars
last_provider_event_seq
cancelled
```

`citation_index` keeps its current backend-built shape and is emitted only when
final citation edges exist. No new route is added.

## Run facts and receipt

When a run becomes `running`, atomically stamp:

- `provider = profile.target.provider`
- `model_name = profile.target.model`
- `reasoning_effort = resolved ReasoningLevel`

`llm_calls` remains authoritative for native plan/accounting/attempt facts.

Replace the existing chat terminal stream log with one `ChatRun.Finished`
event containing:

```text
nexus.chat_run.id
nexus.conversation.id
nexus.chat_run.outcome
nexus.chat_run.error_code
nexus.chat_run.warning_code
nexus.chat_run.support_id
nexus.llm.provider
nexus.llm.model
nexus.llm.reasoning
nexus.chat_run.queue_wait_ms
nexus.chat_run.execution_ms
nexus.chat_run.citation_finalize_ms
nexus.chat_run.first_visible_text_ms
nexus.chat_run.provider_event_count
```

Do not persist these derived durations. Rename `worker_job_succeeded` to
`worker_job_completed` and include the serialized result kind. Queue success
means handler completion, not product success.

An expected client SSE cancellation is logged as client detachment, not server
error. It never changes the durable run.

## UX

- `Published`: current answer, citation chips, footnotes, trust inspector.
- `Degraded`: complete answer plus one quiet amber inline notice:
  “References unavailable — the answer completed, but its references could not
  be attached reliably.” Show the support id in secondary text.
- `Failed`/`Cancelled`: current red failure card. Always show the run support id
  when present.
- Red means no successful publication. Amber means usable prose with rejected
  reference enrichment.
- The warning sits after the answer and before trust details. It uses
  `role="status"`, not an interruptive alert.
- The trust trail labels retrievals independently as selected, included,
  candidate `[N]`, and cited. An uncited candidate is not an integrity notice.

This composes with `chat-interface-hard-cutover.md`: that document owns
presentation hierarchy and final component names; this document owns warning
semantics and data. In their shared final state, `ChatPublicationNotice` renders
after `AssistantAnswer`, and diagnostics render in `AssistantDetails`. Do not
retain or recreate superseded `AssistantEvidenceDisclosure` or
`AssistantTrustInspector` paths.

## Worker topology

Production runs exactly:

- `worker-interactive`: the existing interactive kind set, including `chat_run`
- `worker-background`: the existing background kind set, including
  `synapse_scan`

The old undifferentiated `worker` service is absent. Keep the existing Postgres
queue, claim query, leases, retries, registry, and lane declarations. Deployment
must verify revision, lane, and exact allowlist for both processes.

## Hard-cut deletions and consolidation

- Delete chat’s dense-marker equality gate.
- Replace `record_tool_citations` with candidate numbering; it writes no graph
  edge and no `cited_edge_id`.
- Delete pre-terminal/provisional citation-edge behavior.
- Delete the rule and UI/test expectations for
  `selected_retrieval_missing_citation`.
- Delete support-id duplication inside `ExpectedChatFailure`.
- Delete `worker_job_succeeded`.
- Delete SSE-close classification that labels normal cancellation as an error.
- Keep the shared marker parser, citation read model, graph edge writer, Presence
  type, terminal finalizer, trust trail, LLM ledger, queue, and SSE replay.
- Do not add a second canonicalizer, warning projection, support-id projection,
  citation API, or worker allowlist.

## Files

Backend:

- `migrations/alembic/versions/0196_chat_publication_thin_spine.py`
- `python/nexus/db/models.py`
- `python/nexus/schemas/{conversation,llm}.py`
- `python/nexus/services/resource_graph/citations.py`
- `python/nexus/services/chat_run_{citations,event_store,finalize,response}.py`
- `python/nexus/services/{chat_runs,chat_failure,message_trust_trails}.py`
- `python/nexus/tasks/chat_run.py`
- `python/nexus/jobs/worker.py`
- `python/nexus/api/routes/_sse.py`

Frontend:

- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/api/sse/events.ts`
- `apps/web/src/components/chat/{AssistantMessage,AssistantDetails,ChatFailureCard}.tsx`
- new `ChatPublicationNotice.tsx` plus its local CSS module
- adjacent focused tests only

Primary tests:

- `python/tests/test_{chat_runs,chat_run_citations,resource_graph_citations}.py`
- `python/tests/test_{chat_failure,message_retrievals,message_citation_contracts}.py`
- `python/tests/test_{job_worker,worker_deployment_contract,migrations}.py`
- `apps/web/src/components/chat/{AssistantMessage,useChatRunTail}.test.tsx`
- `apps/web/src/lib/{api/sse/events,conversations/messageUpdateReducer}.test.ts`

Docs after implementation:

- `docs/modules/{chat,jobs}.md`
- `docs/architecture.md`
- mark this document `IMPLEMENTED`

## Implementation order

1. Migration, row models, and closed wire types.
2. Red tests for candidate numbering and citation canonicalization.
3. Replace provisional edges with candidate ordinals; publish final edges once.
4. Add typed outcome, warning finalization, run facts, and terminal receipt.
5. Cut support-id ownership and trust projection to the run.
6. Add amber UI and terminal SSE reconciliation.
7. Cut misleading queue/SSE logs.
8. Focused verification, deploy both lanes, and run one production chat smoke.

No old/new dual-write stage is permitted.

## Acceptance criteria

- Three candidates plus answer marker `[3]` persist as `[1]` with exactly one
  final edge to candidate 3.
- `[2][4]` persists as `[1][2]`; repeats keep stable final numbers.
- Candidates plus no markers publish normally with zero final edges.
- An unknown or linked marker publishes marker-free prose as `Degraded`, with
  no citation edges, an amber warning, and a visible support id.
- A graph/database invariant failure produces `Failed`, never `Degraded`.
- A selected or included retrieval may be uncited without an integrity notice.
- `cited_edge_id` is never populated before final publication.
- Final message, edges, pointers, context refs, warning, and `done` are
  transactionally consistent after reload.
- Provider, model, reasoning, warning, and support facts match across
  `ChatRunOut`, the trust trail, terminal SSE, and the terminal receipt.
- Generic defects display their support id even though `failure` is absent.
- A background `synapse_scan` cannot be claimed by the interactive worker.
- Production has both declared workers and no undifferentiated worker.
- One terminal receipt distinguishes queue wait, execution, publication
  outcome, and citation-finalization time.
- Normal browser stream detachment is not logged as a chat or server failure.

## Verification

- Unit: canonicalizer matrix, sanitizer, union exhaustiveness.
- Integration: chat run/API/SSE, final edges, warning persistence, trust trail,
  run facts, migration up/down.
- Component: published, degraded, generic defect, expected failure, reconnect.
- Worker: queue completion wording and existing lane/deployment contracts.
- Production smoke: one normal chat, terminal reconcile, both worker contracts,
  one queryable `ChatRun.Finished` receipt.

Run focused owner tests and static checks. Do not use a broad verification suite
unless a focused failure demonstrates cross-owner risk.

## Final decisions

- Candidate identity is one column on `message_retrievals`, not a new registry.
- Final citation order follows first use in the answer.
- Invalid generated citation syntax is the only degraded publication outcome.
- Complete-plus-warning is not a new run lifecycle status.
- Support id belongs to the run, not failure variants.
- Queue completion and chat publication remain separate semantics.
- Two worker lanes are sufficient until measured interactive latency proves
  otherwise.
- No open product or architecture questions block implementation.
