# Chat admission and recovery hard cutover

Status: implemented. Supersedes send/recovery rules in
[operation identity](chat-operation-identity-and-regeneration-hard-cutover.md)
where they conflict. Other chat contracts retain their existing owners.

## Goal and scope

An ordinary send rejection never destroys chat. Every submitted question has one
stable admission decision; navigation, response loss, and rendering failure cannot
lose it or create another run. Autonomous background work cannot consume chat's
execution lane. Retire the stale anonymous concurrency counter.

Repair admission, draft ownership, acknowledgment, coherent run reads, background
search, and incident diagnostics. Preserve existing branch, citation, shared
generation billing/selection, provider, cancellation, and durable-step semantics.

Non-goals: new workflow engine, semaphore platform, global outbox, offline or
cross-device sending, second draft, new operator dashboard, streaming redesign,
new ANN/ranking algorithm, broad performance/observability project. Rerun and
regeneration retain their existing endpoint contracts; they are not fallback
paths for a failed send.

## Architecture and decisions

```text
ChatComposer → draft/operation store → POST /api/chat-runs → transport-only BFF
  → serialized admission → existing mutation ledger + run/messages/job
  → immutable receipt → persisted acknowledgment → existing conversation/run GET
  → existing message reducer + cursor SSE

Existing interactive worker → chat execution
Existing background worker  → background intelligence/retrieval
Existing queue claims + Heavy capacity + step journal → ownership/recovery
```

- Keep one single-concurrency worker per existing lane. Delete redundant
  per-user execution counting; retain request-rate and shared generation
  admission/paid-effect ownership. No new accepted-backlog quota in this cutover.
- This controls local execution through topology; it does **not** promise a
  global maximum of three remote provider calls. Scaling requires a reviewed
  capacity contract. Slower background throughput is accepted for foreground
  isolation. Shared database contention is addressed by the bounded search work.
- Keep `sessionStorage` and existing draft-key/request formats. Persist the
  command's originating view identity and authenticated account, and add the
  acknowledgment variant. Cost: the hard cut rejects unsettled pre-cutover
  commands, and admission adds one local transition plus a canonical read;
  benefit: another pane visit or account cannot claim or erase admission evidence.
- Retain small accepted/rejected receipts for account lifetime. Cost: modest
  ledger growth; benefit: delayed replay cannot resurrect deleted conversations.

## A. Admission capability and API

`POST /chat-runs` keeps the current request and normalized opaque
`Idempotency-Key` contract (1–128 characters). A committed decision returns
`200 {data: receipt}`. This replaces the full run projection; no dual response
decoder. Receipt schema:

```text
{ idempotency_key, outcome:
    Accepted { conversation_id, run_id, assistant_message_id }
  | Rejected { reason: ChatAdmissionRejection }
}
```

`ChatAdmissionRejection` is closed: rate limited, message too long, invalid
branch/destination, forbidden, not found, stale reader selection, conversation
no longer empty, or billing required. Its catalog/selection wires are exactly
`E_CATALOG_DEFINITION_STALE`, `E_INVALID_GENERATION_SELECTION`, and
`E_GENERATION_SELECTION_UNAVAILABLE`; the last means the catalog does not admit
that exact selection. Volatile provider, route, or readiness failure is
operational `E_GENERATION_RUNTIME_UNAVAILABLE`, remains retryable, and never
becomes an immutable Rejected receipt. Define each wire value once in the Python
schema; the strict TypeScript codec and exhaustive presenter share one reviewed
conformance corpus. Refresh stale selection through its existing preview API;
receipts contain no prompt, quote, mutable run state, or arbitrary detail bag.

Processing order: authenticate/validate carrier → existing viewer/key advisory lock → read and
strictly decode receipt/check fingerprint → on first sight validate admission →
commit accepted run/messages/initial event/job/receipt **atomically**, or commit
rejection receipt only. Put provisional domain writes in a savepoint: on modeled
rejection roll it back, retain the outer lock, then record/commit rejection.
Existing receipts return before request-rate, catalog, selection, billing, or
source checks are repeated. Construct the receipt before commit; return
it without querying presentation. Retain the existing **send** fingerprint
semantics, including answer identity versus compare-on-send reader revision.

Reuse `ResourceMutation`: scope `chat:admission`; internal mutation ID is SHA-256
of the normalized wire key (the ledger's limit is 120); `response_json` is the
strict receipt; `changed_lanes={}`. A send's `request_hash` uses its existing
canonical fingerprint. The hard-cut candidate fingerprint hashes exactly the
operation, source `assistant_message_id`, `catalog_definition_revision`, exact
selection, and literal `ReadOnly` authority. It contains no source row, prompt,
or branch fact. Pass canonical request bytes to the shared helper, never a hex
digest for it to hash again. No parallel send ledger or runtime lookup fallback
to `ChatRun`.

Send, rerun, and regeneration share this identity/mismatch authority and record
Accepted receipts internally. Candidate endpoints compute the incoming hard-cut
fingerprint and perform receipt lookup/mismatch before reading the catalog or
source rows. A matching Accepted receipt hydrates its run through the read owner
even after source deletion; only first admission resolves and validates the
source. Preserve candidate HTTP responses. A key cannot bypass a rejection or
change operation through another endpoint; no competing `ChatRun`-only replay
authority exists.

Rejections are immutable: changed conditions require a deliberate new send/key.
Fingerprint mismatch, auth/carrier failure, projection-version mismatch,
dependency outage, malformed response, and transport failure do not prove
non-admission. Preserve prior uncertainty. A dependency failure must not be
relabeled as a modeled rejection. Actual defects remain operational defects.

Conversation deletion and job pruning retain receipts. Replay returns the same
Accepted IDs; a later authorized GET reporting deletion never triggers send.
Account teardown explicitly owns receipt cleanup.

## B. Browser operation ownership and behavior

One chat-local keyed store owns storage, immutable snapshots, transitions, and
dispatch deduplication. `useChatDraft` subscribes; `ChatComposer` presents/actions;
`useConversation` owns canonical reads/tails. No app-wide operation framework.

Keep `{text, selection, toolAuthority, operation}` and `nx_chat_draft.v3:`.
Final operations:

```text
ChatSendCommand(idempotencyKey, request, origin { identity, accountId })
Absent
Submitting(command)
ReconcileRequired(command)
Acknowledged(command, AcceptedReceipt)
```

Strictly decode the current request's complete nested schema, key, and nonempty
origin fields at storage ingress; delete the request cast. Every transition
targets the originating serialized draft key **and expected command identity**,
never a live render ref. One local command has at most one in-flight dispatch.
An exact originating view in the same account may resume and adopt automatically;
a different same-account view may only expose an explicit **Open response** action.
An account change is a same-system ownership defect. Stale completions cannot
mutate, focus, or navigate another view.

- Persist Submitting before POST; persistence failure prevents dispatch.
- Restore Submitting as ReconcileRequired. Network/upstream ambiguity retains
  the exact command. Recovery replays that POST with the same key/body.
- Valid Rejected clears only that operation, retains editable text/selection,
  shows the specific inline explanation/action, and restores composer focus.
- Validate Accepted, require its key equals the normalized command key, then
  persist Acknowledged before presentation decoding, callbacks, or navigation.
  Enforce that equality at storage ingress too. Acknowledged resumes GET only.
- Adopt through existing conversation plus `?message=<assistant_message_id>`
  navigation and run/history hydration. Clear the original record only after
  its intended view adopts that target and hydrated IDs match the receipt. If
  the view moved, retain acknowledgment; never redirect the current visit.
- Acknowledged GET 404 shows the removed/unavailable target with explicit
  dismissal; it never POSTs or silently returns to an editable submitted command.
- Keep history readable on modeled rejection. Distinguish Retry pane, Retry send,
  and Retry read. A genuine defect preserves recovery material and reports a
  correlated failure; remounting does not claim to repair the operation.

Remove admission's full-response decoding, clear-before-decode, mutable-ref
completion paths, and optimistic/history-load suppression made obsolete by
receipt-first hydration. Keep the reducer/tail path used by other operations.

## C. Execution ownership

Delete `check_concurrent_limit`, acquire/release methods, `rate_limit_inflight`,
its constant/configuration, and every caller. Audit chat, Oracle, Synapse,
media-unit, Dossier, and any remaining deployed metadata-enrichment usage.
Do not delete the shared request-rate facility.

Existing registry lane assignment, exact job claim/attempt, heartbeat, fencing,
process termination, and Heavy capacity are the sole local execution authority.
Background search must not occupy the interactive lane. Claim expiry/cleanup
cannot affect another attempt. A dead local executor never proves a remote
effect absent: keep paid/write uncertainty and usage exposure in their existing
owners; do not redispatch on lease expiry. No new recovery scheduler.

## D. Read and query contracts

Run/execution/trust/event-cursor projections use one fresh, bounded read-only
repeatable-read snapshot through the existing dependency; never mix a retained
pre-commit ORM row with later job state. Mutation endpoints needing a rich result
open a fresh read snapshot after commit. Never hold it for the SSE connection.
Audit assistant ownership and add true schema uniqueness for
`ChatRun.assistant_message_id`; replace latest-run selection with exact ownership.

For the timed-out background search: capture the existing plan on a representative
synthetic local corpus before editing. Form narrow eligible candidates, preserve
existing lexical/vector union and ranking, then compute snippets/metadata for
the bounded final result. Preserve ACLs, embedding identity, exclusions, ties,
and result semantics. Do not blindly change CTE materialization or candidate
limits. Record the failing fixture, fixed measurement environment, and latency
budget before optimizing; no global timeout increase or benchmark framework.

## E. Diagnostics

Add one authenticated, log-only `POST /api/telemetry/client-defects` BFF forwarding
to `/telemetry/client-defects`; reuse the existing web-vitals transport pattern,
Python telemetry route/schema, and logging. Do not overload the web-vitals schema
or the workspace's local-only telemetry emitter. Record
first failure with release, pane/visit, phase, command/run identity, error code,
request ID, and `errorInfo.componentStack`; bound/deduplicate reports. Server receipt
decisions and worker lifecycle retain correlatable identities. Never log draft
text, request bodies, tokens, or raw provider payloads. Sender failure cannot
recurse or change chat state. No new telemetry vendor.

## Work packages and primary proofs

Paths below are relative; service files are under `python/nexus/`, web files
under `apps/web/src/`. Each row owns its code and one canonical proof family;
parameterize related cases there rather than duplicating them at other tiers.

| Owner | Files / exclusive responsibility | Acceptance proof |
|---|---|---|
| A: admission | `schemas/conversation.py`, `api/routes/chat_runs.py` POST, `services/{chat_runs,chat_run_candidates,chat_run_validation,chat_run_idempotency,resource_mutation_replay}.py`, shared generation-admission error projection | Real PostgreSQL service: duplicates, cross-endpoint key reuse, rejection then policy change, and deleted target resolve one immutable decision; no partial/duplicate domain/job writes. |
| B: browser | `components/chat/{ChatComposer,useChatDraft,useConversation,Conversation,usePendingReaderSelection}*`, chat-local store/codec under `lib/conversations/`, `lib/api/sse` admission types | Real Chromium: modeled rejection preserves pane/draft/focus; A→B navigation cannot corrupt B; malformed receipt retains command; acknowledged reload/read failure never POSTs. |
| C: execution | removal of concurrency methods/configuration from `services/rate_limit.py` and all callers; existing `jobs/{queue,registry,worker,process_executor}.py` lane contract | Real PostgreSQL + worker process: stalled/killed background task cannot block foreground admission/execution through phantom capacity; stale cleanup cannot affect a reclaimed owner; existing uncertain-effect proof remains authoritative. |
| D: reads | `services/{chat_run_response,chat_run_execution,message_trust_trails,conversations}.py`, GET dependencies | Real PostgreSQL interleaving: terminal worker commit during hydration produces one coherent projection; duplicate assistant ownership is rejected. |
| E: search | `services/search/retrievers/{content_chunks,notes}.py`, `services/search/sql.py`, and `services/contributor_credits.py` | Targeted PostgreSQL proof: fixed visible results/order plus measured plan/latency improvement on the predeclared timeout fixture; no ACL/recall change. |
| F: diagnostics | `components/workspace/{WorkspaceHost,PaneRouteErrorBoundary}.tsx`, narrow client sender + `app/api/telemetry/client-defects/route.ts`, Python `api/routes/telemetry.py` + `schemas/telemetry.py` | Sociable boundary proof: one correlated structural report, component stack present, sensitive content absent; sender failure cannot recurse. |
| G: cutover | `db/models.py`, one next Alembic revision, deployment/doc updates, proof routing | Migration proof: pre-receipt chat history blocks the cutover; an empty history establishes sole receipt ownership, schema uniqueness, and complete counter retirement; no application fallback. |

A owns admission sections and C owns execution sections of `chat_runs.py`;
shared generation owns billing/selection admission, and C owns concurrency
deletion in `rate_limit.py`.
Land shared-file integration serially. G alone edits database models/migrations;
package owners supply storage requirements. B owns hydration changes; D supplies
read contracts. No parallel overlapping edits.

## Red / green / refactor and 80/20 verification

[Local testing standards](../local-rules/testing-standards.md) are authoritative,
including §§3, 5–8, 10, 15; do not substitute the older E2E-heavy generic doctrine.

1. Restore the locked environment; `./scripts/test doctor` must pass before
   implementation proof. It previously reported a stale Python environment.
2. **Red:** write each owner's target-behavior proof; capture failure on the
   unfixed revision or representative registered fault. Use independently
   reviewed contracts/fixtures, not current output as the oracle.
3. **Green:** implement there; run `./scripts/test changed <owned-path-or-node>`.
4. **Refactor:** consolidate into the named owners, delete superseded paths/tests
   only after sensitive replacement proof, rerun affected proof.
5. Extend the existing `grounded-chat-citation` journey for receipt → canonical
   hydration → real worker/SSE wiring; do not add a journey/error-case matrix.
   Reuse existing uncertain-dispatch/cancellation proofs without copying them.
6. Register priority owners/faults in `testdata/proofs.json` and
   `testdata/faults/manifest.json`; one canonical node per proof owner. Finish
   `confidence`, then `pr` with same-run sensitivity. Hosted/device gates stay
   in their existing workflows; no paid providers or production data in PR.

Static exhaustiveness plus the dominant service/Chromium middle and one thin
journey are the 80/20 shape. UI proofs may stub fetch per the local standard;
do not mock stores/hooks or database/worker behavior. No retries, sleeps,
coverage quotas, tombstone greps, or duplicated scenario matrices.

## Hard-cut rollout and final state

Use the existing maintenance release protocol in `deployment.md`; no rolling
compatibility. Preserve existing browser tabs/sessionStorage and reload them
after release; do not close tabs to erase commands.

Migration `0226` descends from the shared-kernel cutover at `0225`. Migration
`0224` resets chat history; keep the maintenance no-use window closed through
`0225` and `0226`. Before migration, delete, archive outside the live schema, or
otherwise explicitly dispose every chat run admitted under the old fingerprint.
If any pre-receipt `chat_runs` row remains, `0226` fails before mutation; it does
not infer or backfill a receipt from unverifiable legacy request bytes. Accepted
receipt IDs have no FK to deletable run/message rows. Stop/prove existing
execution owners before dropping the anonymous counter; retain unresolved
provider/journal evidence. No counter reset as the repair.

Inventory outstanding browser commands before cutover. Every pre-cutover record
whose operation is not `Absent` lacks the required durable origin and is rejected
by the final decoder; settle it under the old release before deployment. Only an
`Absent` draft record may cross the cut and reload under the new release. A
historical deleted run may have lost its old replay evidence: absence alone cannot
authorize a resend. Resolve such commands through explicit operator evidence or
review before release; unverifiable history blocks cutover. No runtime legacy
lookup, automatic key replacement, storage clearing, or compatibility decoder.

Final state: one receipt API, one send store, one queue execution authority,
coherent reads, preserved intent, actionable modeled rejection, sensitive proofs,
and no anonymous counter or old admission-response path. The module and
superseded-cutover owners now describe that final state. Changes to
scope, capacity, receipt retention, or retrieval semantics require an explicit
spec amendment with its tradeoff.
