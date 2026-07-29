# Chat Module

## Scope

The chat module owns durable, branchable, streamed, retrieval-grounded conversation UX.
It covers full conversation panes, resource-subject chats, branch replies, context refs,
assistant-answer selection forks, profile/reasoning-option sends, optimistic run state,
rerun, and the frontend request contract for `/api/chat-runs`.

Backend owners live under `python/nexus/api/routes/chat_runs.py`,
`python/nexus/services/chat_run_*`, `python/nexus/services/context_assembler.py`, and
`python/nexus/services/conversation_branches.py`.

`chat_runs.py` is the run **executor** (provider-stream iteration, the tool loop,
finalization). The cohesive services it composes each have one owner:
`chat_run_citations` (candidate numbering, attached/read evidence, final
canonical publication, `citation_index`), `chat_run_tools` (`message_tool_calls`
lifecycle + numbered tool-output rendering + provider tool-event binding), and the
`ChatRunEventEmitter` in `chat_run_event_store` — the single durable run-event
append owner (typed streaming methods commit inline for SSE visibility; batch
tool-result/citation/context events defer to the executor's transaction). The
cross-surface run-tail query + terminal check are `run_kit.get_run_events` /
`run_kit.is_run_terminal` (kind-dispatched for chat, Oracle, and Dossier
builds); viewer scoping stays in each `/stream/*` route's `assert_viewer`,
never in the query.

Frontend owners live under `apps/web/src/components/chat/*` and
`apps/web/src/lib/conversations/*`.

## Cutover Specs

Hard-cutover specs that govern chat work. Each owns one axis; they compose.

- `docs/cutovers/chat-scroll-anchoring-hard-cutover.md` — transcript scroll
  anchoring (hybrid pin-to-top then stick-to-bottom). IMPLEMENTED.
- `docs/cutovers/chat-subsystem-consolidation-hard-cutover.md` — structural
  ownership + duplication collapse (message-update reducer, per-run stream
  context, visibility factory, `chat_run_citations` / `chat_run_tools` /
  run-event emitter, `run_kit.get_run_events` / `is_run_terminal`). IMPLEMENTED.
- `docs/cutovers/sota-chat-streaming-hard-cutover.md` — streaming transport,
  event grammar, coalescing, cursor replay, cancellation. IMPLEMENTED.
- `docs/cutovers/resource-chat-subject-hard-cutover.md` — surface/subject
  consolidation (one `ResourceRef` chat subject). IMPLEMENTED; the client
  `chat_subject` send path is superseded by the reader-selection snapshot cutover
  below.
- `docs/cutovers/reader-highlight-quote-chat-hard-cutover.md` — reader Highlight
  quote-to-chat as an immutable per-message reader-selection snapshot; atomic
  new/existing destination send; removes inline reader chat and the request
  `chat_subject`. IMPLEMENTED.
- `docs/cutovers/assistant-message-trust-trail-hard-cutover.md` — assistant
  trust-trail read model. IMPLEMENTED.
- `docs/cutovers/chat-publication-thin-spine-hard-cutover.md` — candidate/final
  citation separation, degraded publication, and terminal run facts.
  IMPLEMENTED.
- `docs/cutovers/chat-interface-hard-cutover.md` — readable transcript
  hierarchy, progressive disclosure, typed send/privacy state, quote reflow,
  and shared conversation-row activation. IMPLEMENTED.
- `docs/cutovers/chat-continuation-selection-hard-cutover.md` — causal,
  branch-correct profile/reasoning inheritance with explicit draft precedence.
  IMPLEMENTED.

## Engine, View, Adapter Split

`useConversation` is the live chat engine. It owns history loading, create-on-send,
optimistic run lifecycle, run resumption, message updates, rerun state, branch state,
conversation context refs, and selected leaf/path state. It holds the `messages`
state as a `useReducer` over `messageUpdateReducer` — there is no raw `setMessages`
caller.

`messageUpdateReducer` (`lib/conversations/messageUpdateReducer.ts`) is the single,
pure owner of every transcript transition. Each change to the rendered `messages[]`
is one named, total action (`set_all` / `prepend_older` / `seed_optimistic` /
`swap_meta_ids` / `fold_text_delta` / `apply_tool_call` / `apply_tool_result` /
`apply_citation_index` / `apply_context_ref` / `finalize_done` / `merge_run_pair`);
the fold layer (`useChatMessageUpdates`) and the run-tail orchestrator
(`useChatRunTail`) dispatch actions and never mutate the list directly.

`PerRunStreamContext` (`components/chat/perRunStreamContext.ts`) is the single
per-run stream-lifecycle owner — supersession token, abort handle, and first-delta
latch in one record per run (`abort === null` ⇔ not streaming). `createRunVisibility`
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
resource exists. One shared Companion action opens the group on desktop and
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
`AssistantDetails` owns run, usage, cost, tool/retrieval, context-reference, and
integrity diagnostics. The deleted colophon has no compatibility replacement.

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
jumps. See `docs/cutovers/chat-scroll-anchoring-hard-cutover.md`.

## Send Path

`ChatComposer` owns user input, the profile catalog, next-turn selection
resolution, the `ChatProfilePicker` (profile + reasoning option controls), and
send action wiring. It does not construct API branch semantics directly.

`useChatProfiles` fetches `GET /api/llm-profiles` (module-scope cached across
mounted composers) and exposes `{ profiles, defaultProfileId, isLoading,
error }`. Once the catalog is ready, `resolveChatProfileSelection` derives one
effective `{ profileId, reasoningOptionId }`: an explicit unsent draft choice
wins, otherwise the causal assistant run wins, otherwise the exact server
default wins. An unavailable draft or inherited pair is explicitly replaced by
the current server default and reported beside the picker. A malformed server
default is a defect; there is no first-profile substitute.

`useConversation` derives the inherited candidate from the exact branch-draft
parent when branching, otherwise from the selected-path assistant leaf. It
reads only the run's product `profile_id` and `reasoning_option_id`; it never
scans backward or infers product intent from provider, model, effort, or
timestamps. `useChatDraft.profile` stores only an explicit unsent choice.
Inherited and default selections are derived and never persisted as draft
preferences.

`ChatProfilePicker` is a pure controlled renderer of the ready catalog and
effective selection. User changes write the explicit draft choice. Each profile
carries a required `privacy` union:
`{ kind: "Standard"; notice } | { kind: "ExceptionalRetention"; notice }`.
`ChatProfilePicker` renders no privacy or retention copy for any profile. The
browser owns no provider/model/reasoning enum, ordering, default, capability,
key, privacy classification, or availability policy — see
[modules/llms.md](llms.md).

`useConversation` is the sole owner of caller-level send availability. It
derives one `ChatSendCapability`: `Available`, `HistoryLoading`,
`AssistantRunning`, or `ReplyTargetUnavailable`. `ChatComposer` exhaustively
maps that value to send gating and one screen-reader status. Routine blocked
state never renders in the visible error slot. Draft editing and Stop remain
available while an assistant run is active; real errors and ambiguous-send
reconciliation remain visible.

`buildChatRunBody` is the single frontend `/api/chat-runs` body assembler. It
produces the hard-cut request shape:

- `destination` — `{ kind: "New" }` or
  `{ kind: "Existing"; conversation_id; insertion }`, where `insertion` is
  `{ kind: "Empty" }` or `{ kind: "Reply"; parent_message_id; branch_anchor }`
- `content`
- `profile_id` / `reasoning_option_id`
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
`python/nexus/schemas/llm.py`; see [modules/llms.md](llms.md) for the ten
variants, their valid origins, and the `chat_failure_projection`/
`rerun_eligibility` policy that produces them.

`POST /messages/{assistant_message_id}/rerun` is the sole recovery route,
proxied by the sole BFF route
`app/api/messages/[messageId]/rerun/route.ts`. It creates one new durable run
from the source prompt and its stored profile selection; a retired,
uncertified, or changed profile, or any prior attempted write-tool call on the
source run, makes `can_rerun=false`. It is idempotent under the normal
`Idempotency-Key`: replaying the same key returns the existing replacement
run. There is no separate retry/resend pair, no model picker on rerun, and no
key mode.

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
`ResourceEdge` created by its separately-owned launcher, not as a per-run
request field.

`chatDraftKeyFor` is the single draft-key serializer. It produces:

- `path:new`
- `path:<target-id>`
- `branch:<parent-message-id>:message`
- `branch:<parent-message-id>:selection:<client-selection-id>`

Callers still decide the active path target. `Conversation` knows active leaf/new-route state;
`useChatDraft` knows only its fallback parent/conversation target.

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

`ActionMenu` remains separate because it owns menu semantics: roving keyboard behavior,
menu roles, focus restoration, and menuitem rendering.

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
`chat_run_turn_contexts` — migration `0189_reader_highlight_quote_chat` adds the
snapshot column and drops that table's two reader-selection columns, leaving it
subject/audit identity only.

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
containing pane. `ConversationDestinationOverlay` is the "Ask in existing chat…" picker
(title search over `GET /conversations?q=`). `useChatDraft` persists text, an
explicit `ChatProfileSelection`, and the active send attempt (idempotency key,
payload identity, exact sent profile selection, revision) in `sessionStorage`;
an unknown-status ambiguous failure locks reconciliation and replays the same
key, profile pair, and quote revision even if the catalog changed, and success
clears the record. The picker is hidden behind one locked retry status during
that reconciliation, so current catalog choices cannot misrepresent or mutate
the replay.

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

## Contract Tests

Keep these tests aligned with this module contract:

- `apps/web/src/lib/conversations/assistantSelection.test.ts`
- `apps/web/src/lib/conversations/chatDraftKey.test.ts`
- `apps/web/src/lib/conversations/chatRunBody.test.ts`
- `apps/web/src/components/chat/AssistantMessage.test.tsx`
- `apps/web/src/components/chat/MessageRow.test.tsx`
- `apps/web/src/components/chat/useChatRunTail.test.tsx`
- `apps/web/src/components/ui/FloatingActionSurface.test.tsx`
- `apps/web/src/__tests__/components/ChatComposer.test.tsx`
- `apps/web/src/__tests__/components/Conversation.test.tsx`
- `python/tests/test_chat_runs.py`
- `python/tests/test_reader_selection.py`
- `e2e/tests/conversations.spec.ts`
- `e2e/tests/quote-attach-references.spec.ts`
