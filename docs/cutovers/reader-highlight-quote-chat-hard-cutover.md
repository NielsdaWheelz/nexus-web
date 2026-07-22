# Reader Highlight Quote-To-Chat Hard Cutover

Status: SPECIFICATION
Author: SME council synthesis
Type: hard cutover
Date: 2026-07-22

## One-Line

Make a reader Highlight a visible, immutable, one-turn chat attachment from
selection through prompt, transcript, reload, branch, and rerun.

No inline reader chat, eager plain/Highlight blank-conversation creation,
generic pending-ref chips, client-authored quote text, live-history
reconstruction, legacy request shape, fallback parser, or compatibility path
survives in this contract.

## North Star

```text
reader Highlight
  -> typed ReaderHighlightChatIntent
  -> new or selected existing Conversation
  -> visible pending QuotedPassageCard
  -> one atomic chat-run mutation
  -> server-canonical immutable reader-quote snapshot
  -> <subject> + <reader_selection>
  -> identical sent-message card
  -> identical reload / pagination / tree / branch / rerun semantics
```

The quote card is the human projection of answer-determining turn context. It is
not a reply, branch anchor, conversation `ResourceEdge`, or assistant citation.

## Scope

In scope:

- web, EPUB, transcript, and text-backed PDF Highlights;
- new-chat and real existing-chat destinations;
- route-owned launch intent, pending draft, send, history, source activation;
- immutable backend snapshot, prompt assembly, historical pairing, rerun;
- atomic first send, idempotent ambiguous-failure retry, migration/backfill;
- removal of every superseded Highlight quote launch path.

Out of scope:

- more than one quoted Highlight per user turn;
- generic files, images, or arbitrary message attachments;
- quote-only implicit prompts; nonblank user text remains required;
- geometry-only PDF Highlights with blank `exact`;
- collaborative/server-synced drafts, offline queues, audit/compliance systems;
- multi-tenant policy machinery or distributed-service orchestration;
- source-version timelines or a generic attachment framework/table;
- redesign of non-Highlight resource-context launch/snapshot semantics.

## Goals

1. The user always sees the passage that will affect the next answer.
2. The server, model, and transcript use the same canonical passage.
3. A sent quote never changes when its live Highlight changes or disappears.
4. New-chat send has no committed empty-conversation failure prefix.
5. Every failure preserves the complete retryable draft until authoritative
   success.
6. One owner exists for launch intent, quote snapshot, rendering, and message
   projection.

## Product Contract

### Reader actions

- **Ask in new chat** opens `/conversations/new` with a typed Highlight intent.
  Chat launch performs no conversation mutation; creating a new durable
  Highlight from a fresh selection is the required preceding mutation.
- **Ask in existing chat…** opens a real destination picker. Selecting a row
  opens that exact conversation and performs no conversation mutation.
- Highlight creation must succeed before either navigation occurs.
- A new quote replaces an already-pending quote for that destination, preserves
  typed text, and announces the replacement.
- Both layouts use workspace canonical-pane adoption: reuse the destination
  pane or open one without duplicating it. Desktop shows it adjacent; mobile
  activates it while preserving the reader pane in the session. Back/source
  activation returns to that reader pane; draft/intent remain attached to chat.

### Destination picker

- Desktop uses `Dialog`; mobile uses the always-mounted `MobileSheet`.
- Initial results are recent owned conversations, ordered by `updated_at`.
- Search is client-debounced title search against `GET /conversations?q=` with
  existing cursor pagination. Global search is not reused.
- Rows show title, updated time, and `ConversationOut.message_count`, supplied
  by the list service's per-conversation message-count aggregate.
- Loading, empty, error, Retry, Escape/Back/backdrop, focus trap, and focus return
  are explicit states. A successful selection gives focus to the destination.
- The search field owns a listbox through `aria-controls` and
  `aria-activedescendant`; Arrow keys, Home/End, Enter, Escape, result-count
  announcements, and non-tabbable rows follow the shared combobox contract.
- Selection closes without returning focus to the reader. Add the same
  `skipReturnFocus` handoff to `Dialog` that `MobileSheet` already exposes.

### Pending quote

- `Conversation` is the sole launch-intent owner. It strictly parses the active
  pane URL, hydrates one canonical preview through the reader-selection API,
  and passes one `PendingTurnContext` to `ChatComposer`.
- The quote card sits above the textarea; branch header, when present, sits
  above the quote card.
- The card shows canonical exact text, source label, source action, Expand /
  Collapse, and **Remove quoted passage**.
- Hydration loading or failure blocks send. Removal converts the draft to an
  ordinary message and preserves its text/profile.
- `LoadFailed` is retryable transport/server failure with Retry;
  `NonSendable` is authoritative forbidden/geometry-only/over-limit state.
  Missing after an accepted launch is a reported invariant defect. These states
  never collapse.
- Attach, replace, remove, and unavailable states use a polite status region
  without moving focus.
- New-chat launch focuses the textarea after successful hydration. Source
  activation reuses/focuses the reader pane and preserves the hash and draft.

### Send and history

- Send requires nonblank user text and a selected model profile.
- Success immediately renders the server-returned user message; no client quote
  text is inserted optimistically.
- The same `QuotedPassageCard` renders above the sent user-message body in
  read-only mode.
- Success replaces the provisional/hash route with canonical
  `/conversations/{id}` and then clears draft/attempt only after the response
  confirms the run. It does not push a consumed intent into Back history.
  Failure retains route and draft.
- An ambiguous response loss restores **Send status unknown — Retry send**,
  never auto-sends, and replays the same attempt. Reconciliation clears any
  duplicate-looking draft once the original server result is returned.
- Unknown state renders a locked reconciliation panel, not an ordinary unsent
  draft; text/profile/quote remain visible but cannot mutate until replay.
- Reload, pagination, selected path, path cache, branch switch, and rerun expose
  the identical immutable quote.
- If the live source is missing or forbidden, the quote remains and the card
  shows **Source unavailable** with no dead control.
- Available pending/sent cards delegate snapshot activation to `Conversation`,
  which uses `activateResource` to reuse/open and focus the canonical reader
  pane. `kind="none"` renders plain unavailable text, never a disabled button.

### Visual and accessibility rules

- Use the existing editorial user-message register: subtle left accent rail,
  source line, semantic `<blockquote>`, no speech-bubble chrome, no tiny chip.
- Clamp to four lines with an explicit disclosure; never truncate stored text.
- Remove/source/disclosure controls have visible focus and standard touch
  targets. Reduced motion, screen-reader naming, modal focus, and mobile
  keyboard behavior follow the shared primitives.

## Domain Rules

1. One reader quote belongs to one user message.
2. Derived subject, `reader_selection`, branch anchor, conversation context, and
   assistant citations remain separate contracts.
3. A quote send uses `highlight:<id>` as subject, `media:<id>` as its
   server-derived companion, and the owned
   `ReaderSelectionKey{media_id, highlight_id}` as selection identity.
4. The server resolves exact/prefix/suffix/source/locator from the locked
   Highlight. Client quote text is never accepted.
5. Pending preview carries `ReaderSelectionRevision` over canonical quote
   fields. Send rejects a stale revision, retains the draft, and rehydrates.
6. The successful send atomically adds subject/companion
   `ResourceEdge(kind="context")` rows. Removing a pending quote writes nothing.
7. The immutable snapshot drives current prompt selection, historical prompt
   pairing, transcript presentation, and rerun.
8. Live visibility gates activation; the immutable snapshot locator determines
   its destination. Live Highlight bounds never redirect a historical quote.
9. A geometry-only Highlight cannot be launched or sent as a quote.
10. Exact `1..20,000` and prefix/suffix `0..1,000` preserve existing selection
    bounds. Source label `1..1,000` is a new cutover-specific defensive bound
    for mandatory API/transcript/prompt data. Preview/send rejects excess with
    `E_READER_SELECTION_TOO_LARGE`; prompt truncation is never silent.

## Architecture And Ownership

| Concern | Sole owner | Reuse |
|---|---|---|
| Selection identity | `readerSelectionKey.ts` / owned schema | UUID parsers |
| Launch type and URL codec | `lib/conversations/readerHighlightChatIntent.ts` | pane router |
| Destination selection | `ConversationDestinationOverlay` | `Dialog`, `MobileSheet`, cursor pagination |
| Route intent and pending state | `Conversation` | pane runtime, reader-selection preview |
| Draft and retry identity | `useChatDraft` | canonical chat draft key |
| Quote presentation | `QuotedPassageCard` | `BranchComposerHeader`, `HighlightSnippet` visual language |
| Canonical snapshot | `chat_reader_selection.py` | Highlight owner, `highlight_locator` |
| Transcript persistence | `messages.reader_selection_snapshot` | existing message lifecycle |
| Subject/audit persistence | `chat_run_turn_contexts` | existing resource-subject spine |
| Message wire projection | one bulk message projector | run/history/tree callers |
| Prompt composition | `context_assembler` | existing prompt-block budget ledger |

`message_document` remains text-only. `message_context_items` is not restored.
Selection identity and content belong only to the user-message snapshot;
`chat_run_turn_contexts` retains subject/audit identity and drops its two
reader-selection columns.

## Frontend Capability Contract

```ts
type ChatDestination =
  | { kind: "New" }
  | { kind: "Existing"; conversationId: string };

type ReaderSelectionKey = Readonly<{
  mediaId: string;
  highlightId: string;
}>;

type ReaderHighlightChatIntent = {
  destination: ChatDestination;
  selection: ReaderSelectionKey;
};

type PendingTurnContext =
  | { kind: "Loading"; intent: ReaderHighlightChatIntent }
  | { kind: "ReaderHighlight"; preview: ReaderSelectionPreview }
  | { kind: "LoadFailed"; intent: ReaderHighlightChatIntent; error: UiError }
  | {
      kind: "NonSendable";
      intent: ReaderHighlightChatIntent;
      reason: "Forbidden" | "GeometryOnly" | "TooLarge";
    };
```

`ReaderSelectionKey` is the one meaningful identity type across frontend,
transport, service, and snapshot schemas. `parseReaderSelectionKey` owns wire
validation; `assumeReaderSelectionKey` defects on noncanonical trusted values.
Only `readerHighlightChatIntent(...)` creates intents. Subject and companion
refs are server-derived and cannot be represented independently. The existing
generic resource-context launcher remains context-only and is not migrated.

The codec serializes only `#mediaId=<uuid>&highlightId=<uuid>` in that order
using URL percent encoding; a redundant intent discriminant is forbidden. The
destination is the path. Unknown/repeated keys, invalid values, or extra data
are errors; parse then serialize returns the canonical string. Before success,
the hash is reload/workspace/navigation safe and excluded from pane identity.
On success, route replacement consumes the provisional entry so Back cannot
rehydrate a completed intent. `paneRuntime` exposes pane-local hash parameters;
components never read ambient `window.location`.

Malformed, partial, mismatched, unknown, or duplicate intent fields are route
errors. They do not degrade to generic chat. The hash is consumed only on
explicit removal or successful run creation.

`ChatComposer` accepts `Presence<PendingTurnContext>`, not independently nullable
`chatSubject`, `readerSelection`, and `pendingContextRefs` props. Only the
hydrated `ReaderHighlight` variant is sendable. A missing just-launched
Highlight is projection drift: raise/report a route defect, not `NonSendable`.

`useChatDraft` persists text, complete `ProfileSelection`, and the active send
attempt in `sessionStorage` by canonical draft key. The attempt stores one
idempotency key, payload identity, and exact precondition revision. Retries of
an unchanged ambiguous failure replay that stored request. While status is
unknown, answer-determining edits, removal, and new sends are blocked until
reconciliation. After a known failure, changing answer-determining input mints
a new key. Success clears the record. A stale `ReaderSelectionRevision` is a
failed precondition, not payload identity: refresh plus explicit reconfirmation
reuses the unconsumed key.

## API Contract

### `POST /chat-runs`

Hard-cut request shape:

```text
ChatRunCreateRequest
  destination:
    { kind: "New" }
    | {
        kind: "Existing"
        conversation_id: UUID
        insertion:
          { kind: "Empty" }
          | {
              kind: "Reply"
              parent_message_id: UUID
              branch_anchor: existing branch contract
            }
      }
  content: nonblank string
  profile_id: string
  reasoning_option_id: string
  reader_selection: Presence<{
    key: ReaderSelectionKey
    revision: ReaderSelectionRevision
  }>

ReaderSelectionKey
  media_id: UUID
  highlight_id: UUID

ReaderSelectionRevision
  lowercase SHA-256 hex, exactly 64 characters
```

Rules:

- `New` cannot represent a parent or branch anchor.
- `Existing.Empty` exists only because the retained generic resource-context
  launcher creates a context-bearing conversation before its first message. A
  picker row with `message_count=0` and that direct launcher use this insertion;
  populated conversations always use `Reply` to their active leaf.
- The server locks the conversation and linearizes `Empty` against message
  creation. If another tab wins, return `E_CONVERSATION_NO_LONGER_EMPTY` with
  the current active leaf; the UI refreshes and requires explicit resend as
  `Reply` with a new idempotency key because insertion changed. It never
  silently changes insertion semantics.
- `Existing.Reply` applies current visible-owner, parent-path, and branch rules;
  reader quote plus assistant-selection branch anchor composes in one send.
- `reader_selection=Present` makes the server derive the Highlight subject and
  parent-media companion under the row lock. Neither is client input.
- Legacy top-level `conversation_id`, nullable/omitted subject/selection shapes,
  `chat_subject`, client companion refs, and client `exact/prefix/suffix` are
  rejected by `extra="forbid"`.
- The response keeps the canonical conversation, run, user message, assistant
  message, and stream state. The returned user message contains the snapshot.

Plain and quote-first new-chat send move to `POST /chat-runs` with `New`; the
removed `useConversation` eager-create path cannot leave a blank conversation.
`POST /conversations` remains only for the separately owned generic
resource-context launcher in this cutover. `GET /conversations` gains strict
optional `q` title search for the destination picker.

### `GET /chat-reader-selections/highlights/{highlight_id}`

Requires the key's `media_id`. It returns the exact `ReaderSelectionPreview`
used by the pending card: `ReaderSelectionKey`, source label,
exact/prefix/suffix, `MediaRetrievalLocator`, snapshot activation, and a parsed
`ReaderSelectionRevision` digest of canonical answer/display fields. It rejects
a mismatched, unreadable, or geometry-only Highlight; a missing accepted launch
is projection drift and follows the defect path.

The send service rebuilds the same canonical fields under a Highlight row lock
and requires an equal revision. Stale state returns one typed conflict with the
fresh preview in `E_READER_SELECTION_STALE` details; the UI replaces the
preview and requires a new explicit send. The conflict persists no run/replay
row, so the key remains unconsumed. This internal endpoint distinguishes
`E_READER_SELECTION_FORBIDDEN` (`NonSendable`) from
`E_READER_SELECTION_NOT_FOUND`; a not-found response for a client-accepted
launch is reported as projection drift. Geometry-only and over-limit use their
own non-sendable errors.

`GET /conversations?q=` forces owned scope, trims and bounds `q`, composes only
with cursor/limit, and rejects other scope/context filters. Changing `q` clears
the cursor. Ordering remains `(updated_at DESC, id DESC)` for stable pagination.

### Message output

Every `MessageOut` has:

```text
reader_selection: Presence<ReaderSelectionOut>

ReaderSelectionOut
  key: ReaderSelectionKey
  source_label: nonblank string, max 1,000
  exact: nonblank string, max 20,000
  prefix: string, max 1,000
  suffix: string, max 1,000
  locator: MediaRetrievalLocator
  activation: ResourceActivationOut
```

It is `Present` only on a quoted user message. Snapshot fields are immutable;
activation is recomputed from the immutable locator and current source
visibility, and may be `kind="none"`. Same-system payloads use `Presence`, never
`null`, omission, or dual decoding. Malformed stored state raises a defect; it
never projects as `Absent`.

## Persistence And Transaction

Add nullable JSONB `messages.reader_selection_snapshot` with one strict owned
shape:

```text
ReaderSelectionSnapshot
  key: ReaderSelectionKey
  source_label: nonblank string, max 1,000
  exact: nonblank string, max 20,000
  prefix: string, max 1,000
  suffix: string, max 1,000
  locator: MediaRetrievalLocator
```

`chat_reader_selection.py` solely owns canonical creation, JSON encode/decode,
quote-subfield projection, and prompt rendering input. The bulk message
projector remains the sole full-message projection owner. Unknown keys or
invalid trusted data are defects. No JSON fallback, version metadata, or
alternate spelling exists.

Application invariants: snapshots exist only on user messages; key and locator
media ids agree; locator branch matches the Highlight anchor; the
Highlight belongs to that media at creation; subject is that Highlight;
assistants/system messages project `Absent`; rerun clones preserve snapshot
value and subject exactly. Any mismatch is a trusted-state defect.

One run-create transaction:

1. Parse/canonicalize the request and compute its hash without live resolution.
2. Acquire the viewer/idempotency lock; matching replay returns before current
   source/revision validation, while a payload mismatch fails.
3. Lock/resolve `Existing` and validate its insertion, or create unpublished
   `New`, inside the transaction.
4. When selection is present, lock/authorize the Highlight, validate bounded
   media/locator/text, derive subject/companion, and verify revision.
5. Build the immutable snapshot when present.
6. Add derived subject/companion `ResourceEdge(kind="context")` rows when present.
7. Create user message with snapshot, assistant message, run, turn context,
   meta event, active path, and DB-backed job.
8. Commit once. Any failure rolls back every row and edge.

The idempotency hash uses canonical destination/insertion, content, complete
profile selection, and `ReaderSelectionKey`. `ReaderSelectionRevision` is a
live compare-on-send precondition and is explicitly excluded. Scalars have
fixed names; tagged unions use canonical JSON; keys are sorted and UUIDs use
lowercase hyphenated form before SHA-256. It never hashes client quote text or
live resolved fields. Replay of the same key returns the original
conversation/snapshot after later source change and cannot create a duplicate.

Rerun clones the current source user message as today, adding a value-equal copy
of its snapshot; the new run copies subject/audit turn context. It never
resolves or snapshots the live Highlight again.

## Prompt Contract

- For selection-backed turns, Highlight `<subject>` and `<reader_selection>`
  render from the stored snapshot, never the live Highlight. `<subject>`
  contains identity/source metadata only; `<reader_selection>` is the sole
  quote-text block. Selection-free stored subjects retain their existing live
  semantics.
- The selection Highlight is excluded from generic current-turn resource
  rendering, so canonical quote text appears exactly once in the prompt.
- Historical quoted turns insert a bounded
  `<historical_reader_selection>` block immediately before their user message.
- The history budget treats that block, user message, and paired assistant
  response as one indivisible turn unit.
- Prompt instructions state that a historical selection applies only to the
  immediately following historical user message.
- Deleting/editing/moving the Highlight or removing its context `ResourceEdge`
  after commit cannot change or suppress the historical quote-to-user-turn
  binding, quote text, queued execution, or rerun. Independently attached live
  resources retain their normal live-resource semantics.

## Migration

Add `0189_reader_highlight_quote_chat.py`, revising `0188`:

1. Add `messages.reader_selection_snapshot JSONB NULL`.
2. Preflight all selection-bearing turn contexts grouped by user message. Abort
   with an operator-readable report for a missing Highlight/media, malformed
   locator, blank/over-limit fields, role mismatch, absent/mismatched Highlight
   subject, or more than one distinct `ReaderSelectionKey` per message; write
   nothing on failure.
3. Remediation is explicit data loss, never migration fallback. The operator
   runs `python/scripts/remediate_reader_selection_backfill.py` with each
   reviewed `user_message_id`; it clears the selection pair on every associated
   run, or deletes an otherwise anchorless turn-context row. It prints the
   affected run/message manifest, commits once, and is safe to re-run. Then the
   operator reruns preflight/migration.
4. Build one snapshot per valid user message from current Highlight, typed
   anchor/quads, Media, source label, and `highlight_locator` grammar. Rerun-
   cloned messages are independent user messages and receive equal values.
5. Assert every selection-bearing message has one valid snapshot and every
   selection-free message has none.
6. Drop `chat_run_turn_contexts.reader_selection_media_id` and
   `reader_selection_highlight_id` plus their pair check; rewrite `has_anchor`
   for subject-only rows. No runtime compatibility reader remains. Downgrade is
   blocked.

The backfill captures current state because pre-cutover history was never
snapshotted. A remediated turn intentionally becomes an ordinary historical
user turn with no quote binding; post-cutover snapshots are immutable.

For parity with sibling message JSON, add only
`ck_messages_reader_selection_snapshot_object` over
`reader_selection_snapshot IS NULL OR jsonb_typeof(...) = 'object'`; do not
duplicate deep schema rules in SQL. Bind/read through the local JSON adapter so
database `NULL` remains distinct from JSON `null`: the ORM column uses
`JSONB(none_as_null=True)`, and SQL writes use the local JSON bind helper. JSON
`null` is invalid. Strict encode/decode remains the deep-shape owner.

## Hard-Cut Deletions

- `ResourceChatDetail.tsx`, stylesheet, tests, and stale doc references.
- `startResourceChat`; generic callers move mechanically to the accurately named
  `startResourceContextChat`, while Highlight callers move to the typed intent.
- `useConversation.resolveConversation` and eager plain/quote new-chat create;
  `POST /conversations.initial_context_refs` remains for generic resource context.
- `ChatComposer.pendingContextRefs` props, chip markup, styles, and tests.
- Loose composer `chatSubject` / `readerSelection` props.
- `ChatSubjectRequest`, client `chat_subject` body/types, and unreachable send
  path; stored historical turn subjects and the server resolver remain.
- Duplicate new/existing Highlight callbacks that call the same function;
  rename remaining callback-layer `Extant` symbols to `Existing` (the action
  layer is already correct).
- Client `ReaderSelectionRequest.exact/prefix/suffix` send fields and tests;
  canonical snapshot/locator/rendering fields remain.
- Live Highlight reconstruction and silent `None` fallback in prompt assembly.
- Direct/duplicate `MessageOut` construction; all run/history/tree paths use one
  bulk projector.
- Old `Quote to new chat` / `Quote to existing chat` copy/tests and remaining
  callback-layer `Extant` symbols.
- E2E assertions that “existing chat” creates a new conversation.
- Stale reader-sidecar claims that a context `ResourceEdge` substitutes for
  per-turn subject state.

Negative gates must prove removed symbols and payload keys do not survive.

## Files

Add:

- `migrations/alembic/versions/0189_reader_highlight_quote_chat.py`
- `python/scripts/remediate_reader_selection_backfill.py`
- `python/nexus/services/chat_reader_selection.py`
- `python/nexus/schemas/chat_reader_selection.py`
- `python/nexus/api/routes/chat_reader_selections.py` and
  `python/nexus/api/routes/__init__.py`
- `apps/web/src/app/api/chat-reader-selections/highlights/[highlightId]/route.ts`
- `apps/web/src/lib/conversations/readerSelectionKey.ts` and test
- `apps/web/src/lib/conversations/readerHighlightChatIntent.ts` and test
- `apps/web/src/components/chat/ConversationDestinationOverlay.tsx` + CSS/test
- `apps/web/src/components/chat/QuotedPassageCard.tsx` + CSS/test

Primary backend modifications:

- `python/nexus/db/models.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/services/{chat_runs,chat_run_validation,chat_run_idempotency}.py`
- `python/nexus/services/{chat_run_message_prep,chat_run_response,chat_reruns}.py`
- `python/nexus/services/{conversations,conversation_branches,context_assembler,chat_prompt}.py`
- `python/nexus/services/resource_items/chat_subjects.py`

Primary frontend modifications:

- `MediaPaneBody.tsx`, `PdfReader.tsx`, `SelectionPopover.tsx`
- Highlight action/popup/Evidence owners and their shared contracts
- `Conversation.tsx`, `ChatComposer.tsx`, `UserMessage.tsx`, `MessageRow.tsx`
- `useConversation.ts`, `useChatDraft.ts`, `chatRunBody.ts`, `types.ts`
- `app/api/chat-runs/route.ts` and `app/api/conversations/route.ts`
- `paneRuntime.tsx` and tests; `Dialog.tsx`; conversation list owner
- `lib/api/sse/requests.ts`, `messageUpdateReducer.ts`, and message fixtures
- replace `lib/resources/resourceChat.ts` with `resourceContextChat.ts`; update
  generic media/library/oracle/podcast callers

Docs/tests:

- `docs/modules/{chat,highlight,reader-implementation,reader-design-rationale,workspace}.md`
- superseded claims in `reader-sidecar-consolidation-hard-cutover.md` and
  `resource-chat-subject-hard-cutover.md`; concise superseded notes in older
  pane-route/chat-streaming/resource-capability/generation/highlight documents
- focused migration, chat-run, reader-selection, conversation history/tree,
  prompt, rerun, component, workspace-route, web/EPUB/PDF, and real-media E2E
  tests.

## Acceptance Criteria

1. Web, EPUB, transcript, and text-backed PDF actions use one intent constructor.
2. New launch writes nothing before send; failed first send leaves no conversation.
3. Existing launch selects/sends into the exact conversation and composes with
   an assistant-selection branch anchor.
4. Pending quote/draft survive reload, pane reuse, and mobile unmount; success
   route-replaces the consumed intent so Back cannot recreate it.
5. Remove/replace preserves text; remove sends no subject/selection/companion.
6. The request contains `ReaderSelectionKey` plus revision only and rejects
   every client-authored quote-text payload.
7. Subject, media companion, selection, snapshot, messages, run, event,
   `ResourceEdge` rows, active path, and job are one atomic commit.
8. Immediate response and sent UI use the server-canonical snapshot.
9. Reload, pagination, tree cache, branch switch, and multiple reruns return
   equal message-owned snapshots.
10. Historical prompt assembly preserves quote-to-user-turn pairing.
11. Edit/delete/move or context-`ResourceEdge` removal after send cannot alter
    displayed or prompted quote text; historical activation targets its locator.
12. A sent quote whose source later disappears remains visible with unavailable
    activation; missing during first pending hydration is a projection defect.
13. Replay of the same idempotency key returns the original `New` conversation
    and cannot duplicate its send. Unknown status blocks edits/new send until
    reconciliation; intentional later sends may create another conversation.
14. Long quote, keyboard, screen reader, touch, focus, Back/Escape, and mobile
    keyboard behavior pass through observable UI tests.
15. Geometry-only/forbidden/over-limit quotes are explicitly `NonSendable` and
    cannot enter the send contract.
16. Stale preview refreshes the card and requires explicit resend with the same
    unconsumed key; revision is absent from idempotency identity.
17. Migration fails atomically on missing sources, over-limit/malformed
    snapshots, role/subject/locator mismatch, and conflicting run identities;
    explicit remediation can drop reviewed unrecoverable bindings before rerun.
18. Snapshot-on-assistant, malformed trusted shape, subject/locator mismatch,
    and inconsistent projector paths fail tests as defects.
19. Plain new chat uses atomic `New`; generic resource context remains on its
    accurately named, separately owned launcher with no behavior change.
20. No legacy Highlight launcher, inline chat, pending chip, client text hint,
    live-history fallback, duplicate message projector, old action copy, or
    stale “existing creates new” test remains.
21. `Existing.Empty` locks and either creates the first root or returns
    `E_CONVERSATION_NO_LONGER_EMPTY`; it never silently replies to a raced head.
22. Snapshot JSON uses the shared adapter, rejects JSON `null`, and passes the
    shallow object CHECK while strict decode owns its deep shape.

## Implementation Order

1. Preflight/remediation tool + migration + strict snapshot owner + backend red tests.
2. Atomic destination/request contract + subject/companion/selection validation.
3. Unified message projection + prompt history + rerun.
4. Intent codec + pane hash ownership + session draft/idempotency state.
5. Destination overlay + quote card + reader/chat wiring.
6. Delete legacy paths, update module docs, run residue gates.
7. Run focused backend/component tests, then the quote-specific real-stack E2E
   matrix on desktop/mobile and web/EPUB/PDF.

## Final-State Gate

This cutover is complete only when a quoted passage visible before send is the
same immutable passage visible after send and supplied to every current or
historical model turn, while new/existing destination selection, failures,
reload, source deletion, branches, and reruns preserve that contract without a
second path.
