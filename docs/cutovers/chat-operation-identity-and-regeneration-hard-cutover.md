# Chat Operation Identity And Regeneration Hard Cutover

**Status:** PROPOSED · **Date:** 2026-08-03 · **Scope:** chat launch,
browser send recovery, and assistant candidate actions only · **Doctrine:** hard
cut; one owner; exact replay; immutable history; no compatibility path

## 1. Decision

Hard-cut the global provisional `path:new` draft/attempt model. A new-chat visit
gets a unique pane-visit-scoped draft key, and every send persists one exact
request before dispatch. An ambiguous retry replays only that request and key.

Make reader **Ask in new chat** create a fresh pane. Keep existing-chat launch
canonical. Restore **Regenerate** for eligible completed assistant answers as a
new sibling candidate, distinct from failed-turn **Run again**.

No blocking product question remains. Governing contracts are
[repository rules](../rules/index.md),
[testing standards](../local-rules/testing-standards.md),
[chat module](../modules/chat.md),
[reader quote cutover](reader-highlight-quote-chat-hard-cutover.md), and
[durable journal cutover](chat-durable-agent-step-journal-hard-cutover.md).
Repository rules and this document win on conflict.

## 2. Goals

- A “new chat” action always starts an independent provisional destination.
- One idempotency key always denotes one immutable semantic command.
- Unknown send outcome is recoverable across remount and reload without drift.
- Completed answers can produce preserved, navigable sibling candidates.
- Retry, reconnect, rerun, regenerate, fork, and suspension stay distinct.
- Reuse existing pane, branch, message, run, event, and profile primitives.
- Delete superseded keys, attempt shapes, routes, helpers, tests, and prose.

## 3. Scope And Non-Goals

In scope:

- reader Highlight launch disposition;
- structured chat draft identity;
- browser draft/send-operation state and strict `sessionStorage` persistence;
- completed-answer regeneration capability, BFF/API/service, and UI action;
- shared failed-rerun/completed-regeneration sibling-candidate kernel;
- focused state-machine, browser, PostgreSQL/API, and journey proof;
- final chat-module documentation.

Non-goals:

- no provider, prompt, tool-loop, SSE, worker, queue, journal, or event change;
- no conversation tree, branch schema, message schema, or database migration;
- no side chats, answer comparison, merge, branch map, new lineage table, or DAG;
- no model override on rerun/regeneration;
- no replay of any source run that attempted an assistant-write tool;
- no regeneration of pending, failed, cancelled, suspended, user, or system rows;
- no collaborative drafts, offline queue, cross-device recovery, or generic
  client-operation framework;
- no observability, readiness, deployment, or historical-data repair work.

## 4. Final-State Laws

1. `New` launch means fresh workspace pane; `Existing` means canonical adoption.
2. New-chat draft identity is the current `PaneVisitId`, never route text.
3. Request assembly occurs once, before operation persistence and dispatch.
4. A persisted ambiguous operation is immutable and locks its composer.
5. Only exact command replay reuses an idempotency key.
6. A definite rejection consumes the client attempt; the next send mints a key.
7. `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH` is an invariant defect, never recovery UI.
8. Messages and runs are immutable; rerun/regeneration creates a sibling path.
9. The mutation re-evaluates eligibility; projected capability is not authority.
10. Suspended durable work resumes the same journal through operator recovery.

## 5. Target Behavior

### 5.1 Reader Launch

- **Ask in new chat** activates the typed `/conversations/new#...` intent with
  workspace disposition `Fork`.
- **Ask in existing chat…** activates the chosen `/conversations/{id}#...`
  intent with `Adopt`.
- Hash remains route-entry intent and remains excluded from pane identity.
- Launch performs no chat mutation. First send atomically creates a conversation.
- Pane-limit rejection uses the existing workspace result; no alternate launch.

### 5.2 Draft Identity

```ts
type ChatDraftKey =
  | { kind: "NewConversation"; visitId: PaneVisitId }
  | { kind: "Path"; targetId: string }
  | { kind: "BranchMessage"; parentMessageId: string }
  | {
      kind: "BranchSelection";
      parentMessageId: string;
      clientSelectionId: string;
    };
```

`chatDraftKeyFor` returns this owned structured key. Only the storage adapter
serializes it. `Conversation` passes `paneRuntime.visitId` for an empty
`/conversations/new` visit. Existing path and branch semantics remain unchanged.

### 5.3 Exact Send Operation

```ts
type ChatSendCommand = Readonly<{
  idempotencyKey: string;
  request: ChatRunCreateRequest;
}>;

type ChatSendOperation =
  | { kind: "Absent" }
  | { kind: "Submitting"; command: ChatSendCommand }
  | { kind: "ReconcileRequired"; command: ChatSendCommand };

type ChatDraftRecord = Readonly<{
  text: string;
  profile: ChatProfileSelection | null;
  operation: ChatSendOperation;
}>;
```

Rules:

- `ChatComposer` resolves input and calls `buildChatRunBody` once.
- The operation owner mints a key and synchronously persists
  `{ kind: "Submitting", command }` before `POST /api/chat-runs` starts.
- Persist failure prevents POST and reports a defect. There is no memory fallback.
- Reload/remount promotes persisted `Submitting` to `ReconcileRequired`.
- `E_NETWORK` transitions `Submitting -> ReconcileRequired` without mutation.
- **Retry send** posts the stored request and key; current route/UI is irrelevant.
- Known API rejection transitions to `Absent`, retaining editable text/profile;
  a later explicit send assembles a new command and key.
- Success deletes the complete draft record before canonical route replacement.
- Switching `ChatDraftKey` selects the new record synchronously; no effect-driven
  stale record may render or mutate under another key.

The persisted record contains no `payloadIdentity`, duplicated profile snapshot,
standalone revision, or mutable reconstruction inputs. Those values already live
inside the canonical request.

### 5.4 Assistant Candidate Actions

| Source state | Action | Result |
| --- | --- | --- |
| eligible failed/cancelled | **Run again** | new sibling candidate through `/rerun` |
| eligible completed | **Regenerate** | new sibling candidate through `/regenerate` |
| connection lost | **Reconnect** | same run and cursor |
| suspended | none | same journal requires operator recovery |
| write attempted/profile unavailable or drifted | none | mutation also rejects |

Regeneration:

- preserves the original user and assistant messages;
- clones the source user’s canonical content/document, parent, branch root,
  branch anchor, reader-selection snapshot, turn context, profile, and reasoning;
- creates a new user sibling and pending assistant child in one transaction;
- persists branch metadata and selects the new assistant as active leaf;
- creates/enqueues one normal durable `ChatRun` and returns `ChatRunResponse`;
- uses existing fork/sibling navigation after creation;
- permits another explicit regeneration after completion, with a fresh key.

While a rerun/regeneration POST is unresolved, retain its key and disable a
second invocation. `E_NETWORK` exposes an explicit retry that posts the same
endpoint and key; never mint or auto-create another candidate. After full
reload, the committed branch tree is authoritative, so persisting these
action-attempts separately is out of scope.

The source assistant must map to exactly one owning `ChatRun`. Missing or
duplicate ownership is a defect; never scan for the “latest” run.

## 6. Architecture And Ownership

```text
PaneRuntime.visitId ──> structured ChatDraftKey
                              │
                              v
                   useChatDraft record store
                   - strict codec
                   - sessionStorage
                   - immutable operation FSM
                              │ exact command
buildChatRunBody ─────────────┴──> POST /api/chat-runs ──> existing durable run

MessageOut.can_regenerate ──> AssistantMessage ──> useConversation
       └──────────────────── POST /messages/{id}/regenerate
                              └─> shared sibling-candidate kernel
                                  └─> existing branch/run/job/event owners
```

| Capability | Sole Owner |
| --- | --- |
| launch intent URL | `readerHighlightChatIntent.ts` |
| launch disposition | reader action caller |
| pane-visit identity | `PaneRuntime` |
| draft key structure/serialization | `chatDraftKey.ts` |
| draft, operation FSM, storage | `useChatDraft.ts` plus pure transitions |
| chat request assembly | `chatRunBody.ts` |
| live message/run lifecycle | `useConversation.ts` |
| candidate eligibility/creation | consolidated chat candidate service |
| branch ancestry/navigation | existing message parents and branch services |
| durable execution | existing `ChatRun` + job + step journal |

Do not create context, global state, a second request builder, a second branch
model, or a reusable app-wide operation abstraction.

## 7. Storage And Cutover Contract

- Keep one `sessionStorage` namespace and one exact current record shape.
- Decoder accepts only the final `ChatDraftRecord` and exact nested variants.
- Browser storage is parsed once at ingress; malformed current data defects.
- No old-shape decoder, migrator, bridge, fallback, in-memory mirror, or dual write.
- `path:new`, `SendAttempt`, `SendAttemptStatus`, and `payloadIdentity` are deleted.
- Operational prerequisite: close all Nexus tabs before deployment. This clears
  the one user’s tab-scoped old records without committed migration code.

No database schema change is required. Existing parent/branch fields are the
canonical candidate lineage; do not duplicate them with `source_run_id`,
`retry_of`, `regenerated_from`, or an attempt table.

## 8. API Contract

Retain unchanged:

- `POST /chat-runs` request/response and strict payload fingerprint;
- `POST /messages/{assistant_message_id}/rerun` for eligible failure recovery;
- BFF proxy ownership and `Idempotency-Key` requirement.

Add:

```http
Browser: POST /api/messages/{assistant_message_id}/regenerate
BFF proxy: POST /messages/{assistant_message_id}/regenerate
Idempotency-Key: <required, 1..128 chars>
Body: none

200 { data: ChatRunResponse }
```

Mutation preconditions:

- owned assistant message and owned conversation;
- message and source run are both `complete`;
- exactly one source run exists;
- source profile/reasoning remains active and resolves to its historical target;
- source run has no attempted assistant-write tool;
- same key and source returns the existing generated run;
- same key with another source/operation returns replay mismatch;
- violated product eligibility returns new `E_REGENERATION_NOT_ALLOWED`;
- missing ownership returns the existing non-leaking message-not-found error.

Add required `can_regenerate: bool` to `MessageOut` and every frontend
`ConversationMessage`. It is true only for a currently eligible completed
assistant message and false for every other role/state. All message surfaces
project it through the single bulk message projector. The mutation recomputes
eligibility transactionally.

Add `compute_regeneration_payload_hash` with operation
`chat_response_regeneration` and the same immutable source facts used by rerun.
Do not weaken `compute_payload_hash` or mismatch handling.

## 9. Reuse, Consolidation, And Deletion

Reuse:

- `PaneRuntime.visitId`, `WorkspaceTargetDisposition`, `Fork`, and `Adopt`;
- `readerHighlightChatIntentHref`, `buildChatRunBody`, and `createRandomId`;
- current strict profile/target-drift and write-attempt policies;
- rerun’s message/context clone, event-emission, enqueue, response, and branch flow;
- `useStringIdSet`, `messageUpdateReducer`, run tailing, and `ForkStrip`;
- `Button` and existing message-action styling.

Consolidate rerun/regeneration into one private sibling-candidate constructor
with two explicit public commands and eligibility guards. The constructor owns
the transaction; HTTP handlers remain adapters.

Delete:

- `path:new` serializer/test contract;
- partial `SendAttempt` reconstruction and effect-switched active record;
- persistence inside React state updaters and swallowed storage errors;
- “rerun is the sole recovery route” and “no resend/regenerate” prose;
- any duplicated clone/enqueue/response code introduced by regeneration;
- superseded fixtures, assertions, exports, comments, selectors, and styles.

No feature flag, old storage reader, route alias, random URL identity, eager
conversation creation, or compatibility branch survives.

## 10. Files

Primary frontend:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/lib/conversations/{chatDraftKey,chatRunBody,types}.ts`
- `apps/web/src/components/chat/useChatDraft.ts`
- `apps/web/src/components/chat/useConversation.ts`
- `apps/web/src/components/chat/{ChatComposer,Conversation,AssistantMessage,MessageRow,ChatSurface}.tsx`
- `apps/web/src/app/api/messages/[messageId]/regenerate/route.ts` (new)

Primary backend:

- `python/nexus/api/routes/chat_runs.py`
- `python/nexus/errors.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/services/{chat_run_idempotency,chat_run_response,conversations}.py`
- `python/nexus/services/chat_run_candidates.py` (rename/replace `chat_reruns.py`)
- `python/nexus/services/conversation_branches.py`

Proof/docs:

- colocated draft-key, draft-FSM, request, assistant-message, and conversation tests;
- `python/tests/{test_chat_failure,test_chat_runs,test_conversations}.py`
- `e2e/tests/{reader-quote-to-chat,pdf-reader,non-pdf-linked-items}.spec.ts`
- `docs/modules/chat.md` and this document.

Do not modify provider/runtime, prompt, tool, SSE, queue, journal, workspace
planner/identity, database model, migration, global theme, or generic UI files.
If a stated contract proves impossible, stop and amend this spec before widening.

## 11. Implementation Order

1. Capture demonstrated-red regressions for both current defects.
2. Correct New=`Fork`; retain Existing=`Adopt`; add existing-pane browser proof.
3. Introduce structured draft keys and exact operation FSM/codec.
4. Rewire composer to assemble once, persist-before-POST, and exact-replay.
5. Delete the old attempt/storage/effect path and run negative scans.
6. Add backend regeneration eligibility, hash, shared constructor, route, and BFF.
7. Project `can_regenerate`; wire engine, UI action, pending state, and run tail.
8. Add one thin real-stack journey; update canonical chat docs.
9. Run focused verification, close production tabs, deploy, and verify logs.

## 12. Acceptance Criteria

- **AC-1:** New reader launch creates a new pane even when `/conversations/new`
  and several durable conversations are already open.
- **AC-2:** Existing reader launch activates only its chosen conversation.
- **AC-3:** Two new-chat pane visits have different structured draft keys.
- **AC-4:** Reloading an in-flight send renders locked **Retry send** and posts
  byte-for-byte equivalent canonical request data with the same key.
- **AC-5:** Current route, quote, draft, profile, branch, or catalog cannot mutate
  a reconcile-required command.
- **AC-6:** No code path can send one key with different fingerprint inputs.
- **AC-7:** Known rejection retains editable draft and next send uses a new key.
- **AC-8:** Successful send clears local state and replaces `/new` with its
  returned conversation without adopting an earlier conversation.
- **AC-9:** Eligible completed answer exposes **Regenerate**; the result is a new
  selected sibling while original content remains navigable after reload.
- **AC-10:** Failed **Run again**, connection **Reconnect**, suspended state, and
  assistant **Fork** retain their exact distinct semantics.
- **AC-11:** Regeneration is unavailable and mutation-rejected after any write
  attempt, target drift, or unavailable profile.
- **AC-12:** Exact regeneration replay returns one run; changed-source key reuse
  conflicts; concurrent fresh keys create distinct serialized siblings.
- **AC-13:** Plain send, quote snapshot, branch anchor, profile inheritance,
  trust trail, citations, cancellation, and durable journal behavior do not drift.
- **AC-14:** No database migration, duplicate branch lineage, generic operation
  framework, compatibility path, fallback, or dead predecessor remains.

## 13. Verification And Negative Gates

- pure/state-machine: key construction and every operation transition;
- Chromium component: synchronous key switch, storage reload, exact retry lock,
  fresh reader pane, successful regeneration, sibling preservation;
- real PostgreSQL/API: eligibility matrix, exact replay, mismatch, ownership,
  write-attempt block, concurrency, copied snapshot/context, active leaf;
- one real-stack journey: open existing chats + pending `/new` → reader New →
  ambiguous send/reload/retry → completion → regenerate → reload/switch sibling;
- focused TypeScript, ESLint, Python, browser, E2E, `git diff --check`;
- demonstrate sensitivity against the unfixed behaviors before implementation;
- repository scans prove absence of `path:new`, `payloadIdentity`, `SendAttempt`,
  memory persistence fallback, old sole-rerun prose, and duplicate candidate flow.

## 14. Final Capability Contract

- New destination identity follows a pane visit, not a reused route.
- Replay identity follows an immutable command, not mutable UI state.
- Durable execution continues through existing run/job/journal owners.
- Conversation alternatives are immutable sibling paths, not overwritten text.
- Failure recovery and user-requested alternative generation are different APIs.
- One request builder, one draft/operation owner, one candidate constructor, one
  branch model, one message projector, one durable execution path.
