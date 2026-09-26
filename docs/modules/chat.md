# Chat Module

## Scope

The chat module owns durable, branchable, streamed, retrieval-grounded conversation UX.
It covers full conversation panes, resource-subject chats, branch replies, context refs,
assistant-answer selection forks, exact per-run generation selection, optimistic run state,
rerun, and the frontend request contract for `/api/chat-runs`.

Backend owners live under `python/nexus/api/routes/chat_runs.py`,
`python/nexus/services/chat_run_*`, `python/nexus/services/context_assembler.py`, and
`python/nexus/services/conversation_branches.py`.

`chat_runs.py` is the Chat domain orchestrator. It assembles the prompt, admits
one immutable `GenerationSpec` through `GenerationService`, folds route-neutral
events, and finalizes the answer. The cohesive services it composes each have one owner:
`chat_run_citations` (candidate numbering, attached/read evidence, final
canonical publication, `citation_index`), `chat_run_tools` (`message_tool_calls`
lifecycle + numbered Provider API tool-output rendering), and the
`ChatRunEventEmitter` in `chat_run_event_store` — the single durable run-event
append owner (typed streaming methods commit inline for SSE visibility; batch
tool-result/citation/context events defer to the executor's transaction). The
cross-surface run-tail query + terminal check are `run_kit.get_run_events` /
`run_kit.is_run_terminal` (kind-dispatched for chat, Oracle, and Dossier
builds); viewer scoping stays in each `/stream/*` route's `assert_viewer`,
never in the query.

Frontend owners live under `apps/web/src/components/chat/*` and
`apps/web/src/lib/conversations/*`.

## Durable Execution And Recovery

`chat_runs.py` claims the queued run and executes only its persisted generation
admission. `llm_execution.py` and `llm_ledger.py` own the parent generation,
independently accepted child calls, provider continuation, and replay.
`services/tool_runtime/` and `tool_authority.py` own the immutable declarations,
grants, binding/replay policy, and one durable tool executor.

chat admission always freezes `ChatReadAdditiveWrite` with `AdditiveWrites`
over `ChatAdmittedContext`. it publishes `web.search`, `nexus.search`, `nexus.resource.read`,
`nexus.document.search`, `nexus.resource.inspect`, and
`nexus.relations.list`, plus
`nexus.library.add`, `nexus.note.create`, `nexus.highlight.create`,
`nexus.edge.create`, and `nexus.queue.add`. the browser supplies no tool
authority. owner scope, eight-live-write limit, receipts, and undo remain
enforced. historical read-only runs retain their frozen facts.
canonical ids are the only executable identities.

API models receive the frozen plan as provider functions and call the
`GenerationToolExecutor` with its authorization, position ledger, evidence,
citations, trust, and Undo. Codex admits no model tools. The new chat seed uses
Provider API / GPT-6 Sol / standard medium; this sends admitted prompts and
tool results to metered OpenAI API. The sole position path is
`generation/{generation_seq}/tool/{n}`; the one-based ordinal never restarts at
an API child turn.

Completed child calls and tool positions are replay input, never cache hints.
An accepted ambiguous model call, external read, or write is never blindly
redispatched. Operator reconciliation or user cancellation acts on the same
run; neither creates a compatibility run. Code defects emit no `done`.
Conversation deletion deletes every owned Chat job and post-cutover generation
row.

`ChatRunOut.execution` and trust-run `execution` are required `Presence` values.
Nonterminal runs project `Queued | Running | Recovering | Suspended`; terminal
runs project `Absent`. SSE sends the same value as an unsequenced
`ExecutionAdvisory`, so it never advances the committed event cursor. Suspended
UI retains partial text and provenance and renders `Response paused`; it offers
neither product rerun nor network reconnect.

## Engine, View, Adapter Split

`useConversation` is the live chat engine. It owns history loading, create-on-send,
optimistic run lifecycle, run resumption, message updates, rerun state, branch state,
conversation context refs, and selected leaf/path state. It holds the `messages`
state as a `useReducer` over `messageUpdateReducer` — there is no raw `setMessages`
caller.

`messageUpdateReducer` (`lib/conversations/messageUpdateReducer.ts`) is the single,
pure owner of every transcript transition. Each change to the rendered `messages[]`
is one named, total action (`set_all` / `seed_optimistic` /
`swap_meta_ids` / `fold_text_delta` / `apply_tool_call` / `apply_tool_result` /
`apply_citation_index` / `apply_context_ref` / `finalize_done` / `merge_run_pair`);
the fold layer (`useChatMessageUpdates`) and the run-tail orchestrator
(`useChatRunTail`) dispatch actions and never mutate the list directly.

`PerRunStreamContext` (`components/chat/perRunStreamContext.ts`) is the single
per-run stream-lifecycle owner — supersession token and abort handle in one
record per run (`abort === null` ⇔ not streaming). `createRunVisibility`
(`lib/conversations/runVisibility.ts`) is the single run-visibility factory
(`canStart` / `isVisible`) replacing the prior five scattered predicates.

`ChatSurface` owns transcript rendering and scroll behavior.

`Conversation` is the full-chat pane adapter. It owns pane chrome, the
route-owned Context and Forks bodies published into the shared Resource
Inspector, open-resource routing, and the full-chat composer target.

Conversation lists project summaries through `presentConversation` and the
shared `CollectionRow -> ResourceRow` path. `ResourceRow` expands the existing
real primary anchor/button across inert row chrome while keeping nested actions
independent. Conversation presentation helpers own `Untitled chat`, localized
message-count copy, and relative updated time derived from the injected render
environment; render code never reads the wall clock.

There is no inline reader-chat adapter. The deleted `ResourceChatDetail` is
replaced by opening a full `Conversation` pane. Reader Highlight quotes launch
through the typed intent owned by `Conversation` (see Reader Quote-To-Chat
below); generic resource-context chats go through `startResourceContextChat`
(`lib/resources/resourceContextChat.ts`), which creates a context-bearing
conversation via `POST /conversations` and opens it as a `Conversation` pane.
`startResourceChat` is deleted.

## Conversation Resource Inspector And Dossier

An existing Conversation publishes one Resource Inspector group with
`Context | Forks | Dossier`; `/conversations/new` publishes none until the
resource exists. One shared inspector action opens the group on desktop and
mobile. Context and Forks remain chat-owned bodies; Dossier uses the universal
surface/controller and workspace-local revision selection.

The Conversation Dossier binding collects every complete message on every
branch, deduplicates shared prefixes, includes branch topology and attached
Context, and derives a User audience from the conversation owner. Generation is
manual. The generic Dossier head/build/history API and
`artifact_build_events` stream own Generate, Regenerate, cancellation, retry,
history, provenance, and citations; chat owns no feature-specific synthesis
route, job, schema, deep link, or inline output.

Artifact and Artifact Revision resources use the existing generated-output
resource-context chat path. Chat reads only the revision's derived
`content_text`; it never receives stored HTML and never mutates or incrementally
edits the Dossier.

## Scrollport Contract

`ChatSurface` owns the transcript scrollport. Desktop may reserve a stable
scrollbar gutter to keep transcript layout stable. Mobile must use platform
scrollbar gutter behavior and must not reserve a stable inline-end gutter.

Workspace layout must not compensate for chat transcript gutter policy; chat
keeps that policy local to its scrollport.

## Transcript Presentation

`MessageRow` owns turn role and timestamp projection. User and assistant turns
keep programmatic role identity and accessible group labels without visible
`You` or `Assistant` headings. Both use the normal sans reading register at a
`66ch` maximum measure, `16px` minimum prose size, and `1.5-1.6` line height.
User turns retain the quiet accent rail. Chat assistant answers do not compose
`MachineText`; that component remains the machine-register owner for
non-conversational artifacts.

`AssistantMessage` is the sole assistant-turn composition owner. Its visible
order is active tool status, answer, publication warning when present,
consequential write trail with Undo, closed `Sources (N)`, closed `Details`,
failure/reconnect, Fork/Walk actions, and a fork strip when forks exist. Inline
citations remain active. The publication warning is a quiet amber
`role="status"` notice, never a red failure.
`AssistantDetails` owns run plan/model/effort, usage, tool/retrieval,
context-reference, and
integrity diagnostics. The deleted colophon has no compatibility replacement.

Fork deletion is pessimistic. A failed DELETE keeps the fork row, presents the
failure, and disarms the confirmation so a stale destructive action cannot be
submitted again without a new explicit request.

Ordinary prose and links wrap inside the pane. Only bounded code and table
containers may scroll horizontally.

### Transcript anchoring

`useChatScroll` is the single scroll owner. Transcript anchoring is a hybrid
model: on a new user turn the question is pinned to the top inset; once the
streaming answer overflows the viewport the transcript follows the newest text
at the bottom edge; a genuine user scroll-up releases following and shows the
`↓ Latest` affordance; returning to the near-bottom band re-engages it. Pin
state is a single `top | bottom | released` mode, not a boolean. Native
`overflow-anchor` stays disabled; the hook owns anchoring. Streaming follow
writes are instant and RAF-batched; `behavior: "smooth"` is only for discrete
jumps.

### Conversation Find

A loaded existing Conversation publishes Pane Find on `Cmd/Ctrl+F`; global
Search remains `Cmd/Ctrl+K`. The searchable document is the current selected
root-to-leaf path. Terminal visible primary message blocks are independent
literal-search units; pending/refused bodies and all auxiliary transcript
chrome are absent.

`conversationFind.ts` freezes source identity and maps the shared
`canonicalTextFind` result. `conversationFindDom.ts` projects the committed
message-block DOM after citation rewriting, Markdown/GFM, and syntax
highlighting, excludes resolved citation/code-control descendants, and maps
codepoint locators back to exact `Range`s. The shared Custom Highlight registry
renders all matches plus the active match; no React/Markdown `<mark>` path
exists.

`useConversationPaneFind` keeps its snapshot and adapter stable while only a
pending message streams. An effective selected-path projection change cancels
old work and synchronously clears highlights, active-message presentation,
the scroll preview lease, the one Return origin, and transient Inspector
results; it preserves and reruns a nonempty query once. `useChatScroll` remains
the sole viewport owner. Find preview pauses normal pin following without
writing progress or navigation state; Close stays at the match, and **Go back
to reading position** restores the saved eye-line and pin mode once.

## Send Path

`ChatComposer` owns user input, catalog loading, exact next-run selection,
and send action wiring. it does not construct api branch semantics directly.

`useGenerationCatalog` fetches `GET /api/llm-catalog` and retains the last
decoded catalog while refreshing. it loads initially, refreshes when focus enters
the controls and after catalog-related refusal, and offers retry when no pair is
selectable. it has no picker timer.
initialization waits for restored drafts, resolved history, and a catalog.
only an uninitialized draft inherits the causal assistant selection or the
developer seed. failed history blocks initialization and send.

`GenerationSelectionPicker` is controlled: provider and model are native
selects, effort uses native radio segments. only `Selectable` efforts and
their parents are alternatives. valid singleton models/efforts are labelled
values. unavailable current identities remain visible and block execution.
changing a parent clears its children; a model takes a selectable source default,
otherwise its sole effort, otherwise requires an explicit effort.
selection never executes a run. the browser owns no provider/model/
reasoning allowlist, invented default, or qualification rule — see
[modules/llms.md](llms.md).

`useConversation` inherits only the exact selection of the causal assistant
parent. `generationSelection.ts` owns the draft union and transitions:
`Uninitialized | ModelRequired | EffortRequired | Selected`.
`useChatDraft` stores text, that selection, and the exact in-flight command
under `nx_chat_draft.v4:`. partial choices survive reload and block send.
the decoder accepts only this shape; no earlier storage format is read.

`useConversation` is the sole owner of caller-level send availability. It
derives one `ChatSendCapability`: `Available`, `HistoryLoading`, `HistoryUnavailable`,
`AssistantRunning`, or `ReplyTargetUnavailable`. `ChatComposer` exhaustively
maps that value to send gating and one screen-reader status. Routine blocked
state never renders in the visible error slot. Draft editing and Stop remain
available while an assistant run is active; real errors and ambiguous-send
reconciliation remain visible.

The composer projects its existing send, cancel, and reconciliation conditions
through one fixed action socket: `Send message`, `Sending message`,
`Stop response`, `Stopping response`, or `Retry send`. Stop is neutral rather
than destructive. Desktop Enter sends, Shift+Enter inserts a newline, and
Cmd/Ctrl+Enter sends; every Enter variant inserts a newline in the product
mobile viewport. IME composition always owns Enter. The shared `Textarea` grows
and shrinks to its configured cap, then exposes native internal scrolling. The
composer configures it for two through six rows and restores input focus after
completed and known-failed sends without taking viewport ownership.

`buildChatRunBody` is the single frontend `/api/chat-runs` body assembler. It
produces the hard-cut request shape:

- `destination` — `{ kind: "New" }` or
  `{ kind: "Existing"; conversation_id; insertion }`, where `insertion` is
  `{ kind: "Empty" }` or `{ kind: "Reply"; parent_message_id; branch_anchor }`
- `content`
- `catalog_definition_revision`
- `selection` — exact tagged route/model/reasoning
- `reader_selection` — `Presence<{ key: ReaderSelectionKey; revision }>`

The branch anchor lives inside `Existing.Reply.branch_anchor`: branch drafts win
over plain continuation replies, and plain continuation replies become
`assistant_message` anchors. Plain and quote-first new-chat sends use
`destination: { kind: "New" }`, which creates the conversation atomically on
send — there is no eager blank-conversation prefix, and a failed first send
leaves no conversation. The request carries no top-level `conversation_id`, no
`chat_subject`, and no client `exact`/`prefix`/`suffix`; the server rejects all
three (`extra="forbid"`).

## Failure card and rerun

`ChatFailureCard` is the only failure renderer, in two modes:

- `{ failure: ExpectedChatFailure | null; supportId: Presence<string>;
  canRerun?; onRerun?; rerunning? }` — the support occurrence is owned by the
  run; copy comes from the exhaustive
  `chatFailureMessage(failure)` helper
  (`lib/llm/failure.ts`), a `switch` over `failure.code` with a compile-time
  `never` exhaustiveness guard; shows an optional `Support ID`; shows a
  **Run again** action iff `canRerun && onRerun`. `failure === null` (a defect
  with no stored closed code, or a still-healthy fold) renders the generic
  non-leaking copy.
- `{ mode: "reconnect"; onReconnect }` — fixed **Reconnect** copy and action;
  never calls `/rerun`.

At most one action ever renders. `ExpectedChatFailure` is the closed,
discriminated union (`code` as the tag) mirroring
`python/nexus/schemas/llm.py`; see [modules/llms.md](llms.md) for the six
variants, their valid origins, and the `chat_failure_projection`/
`rerun_eligibility` policy that produces them.

`POST /messages/{assistant_message_id}/rerun` recovers an eligible failed or
cancelled turn; `POST /messages/{assistant_message_id}/regenerate` produces a
fresh alternative for an eligible completed answer. Both reach FastAPI through
the BFF's structured catch-all (`app/api/[...path]/route.ts`) and both are
consolidated into one sibling-candidate constructor
(`services/chat_runs.py`) that each route calls with an explicit
`rerun`/`regenerate` operation and separate eligibility guards. Each request
carries only an exact selection and the current catalog-definition revision.
new runs use the fixed additive tool policy. the primary action reuses the source run's
selection only while the current catalog still marks it rerun-eligible;
otherwise `CandidateGenerationPicker` requires an explicit replacement. Nothing
silently substitutes a model. candidate edits are local and discarded on close;
only the explicit rerun/regenerate button admits a run. both commands clone the source user turn (content, parent, branch
lineage, reader-selection snapshot, turn context) into a new user sibling with a
pending assistant child and one queued durable run, then select the new
assistant as the active leaf. The complete migration reset leaves no
pre-cutover Chat run or compatibility eligibility branch. The source assistant must map to
exactly one owning `ChatRun`; missing or duplicate ownership is a defect, never a
latest-run scan. Each command is idempotent under the normal `Idempotency-Key`:
replaying the same key returns the existing generated run, while the same key
with another source or operation is `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`. There is
no separate retry/resend pair or key mode.

**Run again** (failed turn), **Regenerate** (completed answer), **Reconnect**
(dropped stream), suspended (operator recovery), and **Fork** (branch) stay
distinct. `AssistantMessage` renders **Regenerate this answer** only for a
completed assistant message, and the menu entry follows the resource-action
snapshot's `regenerate_applicable`, the sole read-side authority;
`useConversation` owns both mutations through one candidate action that retains
an idempotency key per source across a network loss (an explicit retry replays
it) and mints a fresh key otherwise.

## Connection lost, status unknown

`ConnectionLostStatusUnknown { run_id, last_cursor }` is a client-only state
owned by `useChatRunTail.ts` — never persisted on a message/run, never an SSE
event, and never mapped to a server failure. On a dropped stream the hook
first reconciles run status (`GET /api/chat-runs/{id}`); only if that doesn't
confirm a terminal status does it mark the connection lost. During a bounded
automatic-reconnect budget (`CHAT_STREAM_MAX_RECONNECTS`, backoff with
jitter) the UI retains partial text and shows a quiet reconnecting state.
After that budget, `ChatFailureCard`'s reconnect mode renders. Reconnecting
resumes from `last_cursor` and never calls `/rerun`. Any rehydrated server
state replaces the local card, so it can't coexist with a terminal failure
card.

## Branch Drafts And Anchors

`BranchDraft` is a composer mode, not an API request type. It identifies the parent assistant
message, parent sequence, preview text, and the assistant-owned branch anchor to apply on send.

Frontend branch drafts only use:

- `assistant_message`
- `assistant_selection`

Resource subjects and reader Highlight quotes are not branch anchors. The
`chat_subject` request field is removed: a reader quote travels as
`reader_selection` (a `ReaderSelectionKey` plus revision), and a generic
resource-context chat carries its subject as a conversation context
`ResourceEdge` created by its separately-owned workflow, not as a per-run
request field.

`chatDraftKeyFor` is the single draft-key constructor. It returns one structured
`ChatDraftKey`:

- `{ kind: "NewConversation"; visitId }` — a new-chat destination, keyed by the
  current `PaneVisitId` and never route text (the global `path:new` model is
  hard-cut, so two new-chat pane visits get independent drafts)
- `{ kind: "Path"; targetId }`
- `{ kind: "BranchMessage"; parentMessageId }`
- `{ kind: "BranchSelection"; parentMessageId; clientSelectionId }`

Only the `useChatDraft` storage adapter serializes it (`serializeChatDraftKey`).
`Conversation` owns the active leaf/new-route decision and passes
`paneRuntime.visitId` for an empty `/conversations/new` visit.

## Assistant Answer Selection

Assistant answer selection is branch-anchor context from a completed assistant message.
It is not reader selection, not a citation, and not a conversation context ref.

`useAssistantSelectionBranch` owns DOM selection capture for assistant answers:

- answer element ref
- mouse and keyboard capture handlers
- live selected rect/line rects
- outside/collapsed selection dismissal
- branch-from-selection action

`apps/web/src/lib/conversations/assistantSelection.ts` owns DOM-free mapping and branch-draft
helpers. It maps a visible selection to source offsets only when the rendered text exactly
matches the source text and the selected exact text is unique. Repeated text, markdown-rendered
differences, or any ambiguous selection becomes an unmapped `assistant_selection` anchor with
no offsets.

The assistant selection popover is presentational. It receives a captured selection plus
callbacks and renders inside `FloatingActionSurface`.

## Floating Action Surfaces

`FloatingActionSurface` is the shared non-modal action-surface primitive for:

- assistant answer selection actions
- reader text-selection actions
- clicked-highlight actions
- nested action-bar render popovers

It owns fixed positioning, viewport clamping, mobile visual-viewport handling, text-selection
line-rect placement, Escape/outside-pointer dismissal, scroll dismissal/reposition policy,
`data-dismiss-ignore`, and pointerdown prevention for preserving live text selections.

Fresh reader selection is the icon toolbar: `SelectionPopover` sequences
Highlight-first chat creation and `SelectionActionDock` renders **Ask** as a
direct icon control and **Ask in existing chat…** as a text-labeled item in the
**More** menu. The dock does not create conversations or own destination
behavior. Both actions create or reuse the default-yellow Highlight before
launch, and neither creates a Conversation before the first send.

`ActionMenu` remains separate because it owns menu semantics: roving keyboard behavior,
menu roles, focus restoration, and menuitem rendering. Its portaled `<ul role="menu">` carries
`data-dismiss-ignore`, because a portaled menu is logically inside its trigger: an enclosing
floating surface must not read a menu-item pointerdown as an outside dismissal.

`FloatingActionSurface` is the documented non-modal action-surface owner. It
keeps its own visual-viewport handling and must not migrate to `MobileSheet`
(`docs/modules/overlays.md`).

## Reader Quote-To-Chat: Immutable Snapshot

A reader Highlight quote is an immutable per-message snapshot, not a run
turn-context pair and never live-reconstructed at prompt time. On send the
server row-locks the Highlight, derives the canonical quote fields, and stores
one `ReaderSelectionSnapshot` on `messages.reader_selection_snapshot` (JSONB).
Every later read — transcript, reload, pagination, branch switch, rerun, and
prompt assembly — derives from that snapshot. `services/chat_reader_selection.py`
is the sole snapshot owner (build, encode/decode, revision, quote-subfield
projection, and prompt-render input); the snapshot shape is
`key{media_id, highlight_id}`, `source_label`, `exact`, `prefix`, `suffix`, and
`locator: MediaRetrievalLocator`. Reader-selection identity no longer lives on
`chat_run_turn_contexts`: the `messages` snapshot column carries it and that
table's two reader-selection columns are gone, leaving it subject/audit
identity only.

The request sends `reader_selection: Present<{ key: ReaderSelectionKey;
revision }>` only. The server derives the `highlight:<id>` subject and its
`media:<id>` companion under the Highlight row lock and writes them as
`ResourceEdge(kind="context")` rows in the same atomic commit; neither is client
input, and client quote text is rejected. `ReaderSelectionKey{media_id,
highlight_id}` is the durable selection identity and part of the idempotency
hash; `ReaderSelectionRevision` (lowercase 64-char SHA-256 hex) is a
compare-on-send precondition only and is explicitly excluded from that hash.

`reader_selection` is not a branch anchor and is not cited. Assistant selection
and reader selection compose in one send only as separate fields:

- assistant selection: `Existing.Reply.branch_anchor.kind === "assistant_selection"`
- reader selection: `reader_selection`

`Conversation` is the sole reader-Highlight launch-intent owner. It parses the
pane-local intent hash `#mediaId=<uuid>&highlightId=<uuid>` (the destination is
the path), hydrates one canonical `ReaderSelectionPreview` through
`GET /chat-reader-selections/highlights/{id}?media_id=`, and passes one
`PendingTurnContext` to `ChatComposer`. `QuotedPassageCard` renders the quote
pending (above the composer, removable) and sent (read-only, above the user
body). Both modes use the same three-line preview and explicit in-place
expansion. The semantic figure has zero outer margin and cannot exceed its
containing pane. `ConversationDestinationOverlay` is the existing-chat picker
(title search over `GET /conversations?q=`). `useChatDraft` persists text, an
explicit `SelectionDraft`, and the exact send
operation — one idempotency key, immutable `ChatRunCreateRequest`, and
originating view identity/account
assembled once before dispatch — in `sessionStorage`, keyed by the structured
`ChatDraftKey`. `chatDraftStore.ts` is the single storage, transition, and
dispatch-deduplication owner. The operation FSM is
`Absent | Submitting | ReconcileRequired | Acknowledged`: a persisted
`Submitting` promotes to `ReconcileRequired` at ingress, so an ambiguous outcome
locks reconciliation and replays the exact key and request. A modeled Rejected
receipt consumes only the operation and retains editable text/selection. An
Accepted receipt is persisted as `Acknowledged` before any presentation work;
reloads resume `GET /chat-runs/{run_id}` and never POST. Only the exact origin in
the same account may adopt automatically. Another view in that account exposes
an explicit **Open response** action, and an account mismatch is a same-system
ownership defect. The original record is deleted only after an authorized view
reads matching conversation, run, and assistant identities and adopts
`?message=<assistant_message_id>`. A deleted target remains acknowledged until
explicit dismissal.

`POST /chat-runs` is a receipt boundary. Under the viewer/key advisory lock it
first replays the immutable `ResourceMutation(scope="chat:admission")` decision
or validates a new admission. Accepted run/messages/event/job and receipt commit
atomically. A modeled rejection rolls provisional writes back to a savepoint and
commits only its closed reason. The response is
`{data:{idempotency_key,outcome:Accepted|Rejected}}`; it contains no run
projection, prompt, quote, or mutable detail. Accepted presentation always comes
from the canonical repeatable-read run GET. Rerun and regeneration keep their
existing rich HTTP responses while sharing the same key/mismatch ledger and
requiring a fresh exact selection. a new rerun can create new additions;
replaying the same command retains its original admission and effects.

The unmarked `GET /conversations` primary index returns the strict
complete-collection page and drains automatically in `ConversationsPaneBody`. The destination picker always sends an explicit `q`
(including `q=` for recent chats) and retains manual cursor paging.
`has_context_ref` retains the resource-graph page contract. These three modes
must not share cursor or response decoding.

The index additionally accepts the pane's domain view as `sort=updated|title`
plus `direction=asc|desc`. `Updated — newest` is canonical and omits both keys;
the only valid non-default pairs are `updated+asc` and `title+asc|desc`. A
partial pair, an unknown value, a duplicate key, or the explicit default pair is
`400 E_INVALID_REQUEST`, and the view keys are not accepted in the `q` or
`has_context_ref` modes. The title order sorts on the presented title
`coalesce(nullif(btrim(title), ''), 'Untitled chat')` so the server order and
the rendered text agree, then on `updated_at DESC, id DESC` in both directions.
Cursors are the `ConversationIndex:v2` family bound to viewer, order plan, and
collection revision; the retired unversioned family is not decodable.

## Citation Candidates And Final Edges

Chat keeps model-facing evidence candidates separate from reader-facing
citations. One numbering helper assigns dense turn-global
`message_retrievals.citation_candidate_ordinal` values only to citable rows
actually exposed to the model. Selection or prompt inclusion alone does not
make a row a candidate.

After generation, one canonicalizer maps the candidate markers used in the
answer to dense final ordinals by first appearance. Only then does publication
mint `origin='citation'` resource edges and set `cited_edge_id`. Sparse valid
markers are canonicalized, and no markers is a valid answer with no edges.
Unknown or linked markers publish marker-free prose with the closed
`CitationsUnavailable` warning and a support id. Graph or database defects fail
the run; they never degrade.

Final markdown, citation edges, retrieval back-pointers, context refs,
`citation_index`, warning state, and terminal `done` are one transaction.
Rendered citations are built from the final edges by `build_citation_outs`
(`chat_run_response.py`), uniformly with Oracle and Universal Dossiers.

`message_retrievals` is chat-owned **telemetry** and the sole durable
per-result record: candidate generation and rerank/selection are transient,
in-memory passes over a tool call's results, and only the
selected/included outcome is ever written as a row. A cited row points back
at its final citation edge through `cited_edge_id`. Candidate ordinal lives on
the telemetry row; final reader ordinal lives on the edge.

Assistant message reads also carry a backend-built `trust_trail`. It is the
durable inspector read model over `chat_runs`, prompt assemblies, tool calls,
retrieval rows, citation edges, and context-ref-added events. `message_document`
is text-only; `AssistantDetails` renders tool and retrieval diagnostics from
`message.trust_trail`, while `AssistantWriteTrail` renders consequential writes
and Undo outside the closed diagnostic disclosure.

The run is the sole support-id and publication-warning owner. Terminal SSE
reconciliation replaces streamed marker text with the persisted canonical
answer.

## Backend Validation And Prompt Rendering

FastAPI schemas accept `assistant_selection` branch anchors and `reader_selection`
key+revision inputs as separate concepts.

`conversation_branches` validates assistant-selection offsets, exact text,
prefix, and suffix against the parent assistant message. For a selection-backed
turn, `context_assembler` renders `<subject>` (Highlight identity/source
metadata) and `<reader_selection>` (the sole quote-text block) from the immutable
snapshot, never the live Highlight, and excludes the selection Highlight from the
generic `<resources>` block so the quote text appears exactly once. Historical
quoted turns insert a bounded `<historical_reader_selection>` block immediately
before their user message; that block, the user message, and its assistant
response are one indivisible history-budget unit. Live-highlight reconstruction
and the silent-`None` fallback in prompt assembly are removed. Source-activation
destination comes from the immutable locator (gated by live visibility), never
the live Highlight.

## verification

manually validate durable execution, citations, authorization, provider tools,
and browser composition when those boundaries change.
