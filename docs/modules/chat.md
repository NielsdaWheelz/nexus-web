# Chat Module

## Scope

The chat module owns durable, branchable, streamed, retrieval-grounded conversation UX:
conversation panes, resource-subject chats, fork replies, context refs,
assistant-answer selection forks, exact per-run generation selection, rerun and
regenerate, and the browser contract for `/api/chat-runs`.

The backend is one package, `python/nexus/services/chat/`, behind one route
module (`api/routes/chat.py`, every chat route) and one wire module
(`schemas/conversation.py`: quotes, conversations, messages, sends, receipts,
run events, trust trail). See [Backend: one package](#backend-one-package).

Web owners: `apps/web/src/lib/chat/*` (wire names, tree derivations, selection,
drafts, run tails, quote intents, index, message intents) and
`apps/web/src/components/chat/*` (the store and the views).

## The model: three primitives

The browser holds three things and derives everything else with pure functions.

1. **One copy of the server's tree.** `GET /conversations/{id}/tree` returns
   `{conversation, messages, active_leaf_message_id}`: every message once, in
   `seq` order, and the owner's selected leaf (the newest message when none is
   stored). `components/chat/conversationStore.ts` keeps that map. Saved state
   changes only by replacing whole messages from a server read (the tree, a run
   read, a rerun/regenerate/cancel response); an older `updated_at` never wins.
2. **A live overlay per pending answer.** `lib/chat/runTail.ts` folds a pending
   run's SSE events into `{text, tools, execution, link}` beside the saved
   message. The overlay paints; it never changes a message's status, text or
   trust trail. When the stream ends — `done` or lost — exactly one
   `GET /chat-runs/{run_id}` decides. A still-pending run after a lost stream
   shows Connection lost.
3. **One durable send per draft.** `lib/chat/drafts.ts` keeps one draft per
   account and conversation (plus one `new` draft per account per tab) in
   `sessionStorage` under `nx_chat_draft.v6:<account>:<conversationId|new>`. A
   send is written there, with its idempotency key and exact request bytes,
   before the POST. It leaves only with a receipt or a definite rejection.

`lib/chat/tree.ts::chatView` derives the rest from `(messages, leaf, history,
fork being composed)`: the active path, children by parent, the alternatives
at each fork point (the root included), the Forks outline, the send target,
the pending run that owns Stop, and the selection a reply inherits. Nothing it
returns is stored.

Invariants:

- O1: saved message state comes only from server reads.
- O2: the live overlay exists only for a pending assistant on this store and is
  dropped when a read settles it.
- O3: a stream's end is followed by one run read; status changes only from it.
- O4: a draft holds at most one pending command, written before its POST.

## Durable Execution And Recovery

`services/chat/worker.py` runs the queued run's one generation (`generate`,
[llms.md](llms.md)) from its admitted spec and frozen prompt
(`chat_runs.generation_spec`, `chat_runs.generation_intent`), then publishes it.
`services/tool_runtime/` and `tool_authority.py` own the immutable declarations,
grants, binding policy, and one durable tool executor.

chat admission always freezes `ChatReadAdditiveWrite` with `AdditiveWrites`
over `ChatAdmittedContext`. it publishes `web.search`, `nexus.search`, `nexus.resource.read`,
`nexus.document.search`, `nexus.resource.inspect`, and
`nexus.relations.list`, plus
`nexus.library.add`, `nexus.note.create`, `nexus.highlight.create`,
`nexus.edge.create`, and `nexus.queue.add`. the browser supplies no tool
authority. owner scope, eight-live-write limit, receipts, and undo remain
enforced. historical read-only runs retain their frozen facts.
canonical ids are the only executable identities.

api models receive the frozen plan as `ProviderFunctions`; codex receives it as
`CodexCallbacks`. both use the same `GenerationToolExecutor`, principal, scope,
position ledger, evidence, citations, trust, and undo. host-owned authentication
and the shared native adapter do not broaden the operation grant. see
[backend composition](llms.md#backend-composition). provider-function positions
use `generation/{generation_seq}/tool/{n}`; their one-based ordinal never
restarts at an api turn.

Nothing replays. A job attempt that finds its run's generation already started
knows an earlier attempt died: the run fails `interrupted` (an
`assistant_unavailable` card with Rerun) or ends `cancelled` when a stop was
asked, and the user reruns. A dead chat job ends its run the same way. Writes
made before a crash stay visible and undoable. Code defects emit no `done`.
conversation deletion removes its chat projections and queue owners. completed
write receipts and target authorship survive independently of generation
history. account settings lists all owned completed assistant writes, including
failed attempts and successes that created no items. only successful writes
with created items offer undo; chat and account settings share the same owner.

`events.finalize` is the one terminal writer. In the same
transaction it settles every tool call of the answer still `pending` or
`running`: `cancelled` for a cancelled run, else `error`. No tool call outlives
its run as `running`.

Trust-run `execution` is a required `Presence` value.
nonterminal runs project `Queued | Running | Recovering | Suspended` plus
`cancel_requested`, derived from the run's persisted stop intent. terminal
runs project `Absent`. sse sends the same value as an unsequenced
`ExecutionAdvisory`, so it never advances the committed event cursor. the
pending run at the end of the active path owns composer Stop; stream
connectivity does not erase that authority. the row and the composer both show
stop intent when the saved execution or the live advisory says so (it is
monotonic, so the OR is exact). a stop request records intent, not
a completed cancellation. a suspended answer keeps its overlay and shows
`Response paused` (or `Stop requested`); when its stream is lost, **Check saved
status** rereads the same run and tails it again. it never admits a new
generation.

## Stream, Reconnect, Recovery

A tail opens `GET /stream/chat-runs/{run_id}/events?after=N` through the shared
`openGenerationRunStream` (eight automatic reconnects, 1–8 s backoff with
jitter, `Last-Event-ID` resume inside one tail). A pending answer found on a
tree read is tailed from event 0: a reload replays the run's whole durable event
log, so the overlay rebuilds itself without a server fold. Events at or below
the overlay's last sequence are ignored.

On `done` or on loss the store reads the run once. A terminal read replaces the
message and drops the overlay. A pending read after loss, or a failed read,
marks the overlay `Lost`: the answer keeps its partial text and shows
**Connection lost** with **Reconnect**. Reconnect reads the same run, then
shows it or tails it again from the overlay's last sequence; it never calls
`/rerun`. A modeled read failure during Reconnect shows **Couldn’t reconnect**
with its request id, and retry only when the failure was ambiguous. The
browser's `online` event reconnects every `Lost` overlay. A `429` from the
LISTEN cap is an ordinary lost stream: the answer recovers through Reconnect.

## Pane, Inspector And Dossier

`Conversation.tsx` is the pane adapter. The route id keys a fresh conversation
(store, scroll, docent); a changed id never reuses state. It owns route state
(`?message`, `?draft`, the quote hash) and the fork being composed, and wires
the store, the draft, the inspector and the docent. It owns no server state.

An existing Conversation publishes one Resource Inspector group with
`Context | Forks | Dossier`; `/conversations/new` publishes none until the
resource exists. One shared inspector action opens the group on desktop and
mobile. Context and Forks remain chat-owned bodies; Dossier uses the universal
surface/controller. The Context body (`ContextRefsPanel`) rereads the
conversation's refs whenever a read settles a pending answer, keeps the last
list while rereading, and removes a ref with `DELETE`.

The Conversation Dossier binding collects every complete message on every
branch, deduplicates shared prefixes, includes branch topology and attached
Context, and derives a User audience from the conversation owner. Generation is
manual. The generic Dossier head/build API and build snapshot stream own
Generate, Regenerate, cancellation, retry, provenance, and citations; chat owns
no feature-specific synthesis
route, job, schema, deep link, or inline output.

Artifact and Artifact Revision resources use the existing generated-output
resource-context chat path. Chat reads only the head's `content_text`; it
never receives stored HTML and never mutates or incrementally
edits the Dossier.

There is no inline reader-chat adapter. Reader Highlight quotes launch through
the typed intent owned by `Conversation` (see Reader Quote-To-Chat below);
generic resource-context chats go through `executeResourceChat`
(`lib/resources/resourceActionExecution.ts`), which creates a context-bearing
conversation via `POST /conversations` and opens it as a `Conversation` pane.

A missing or foreign conversation is `404 E_CONVERSATION_NOT_FOUND`; the pane
shows "This chat couldn’t be opened." with the server's copy. `chatFailure`
(`lib/chat/wire.ts`) is total over `ApiError`: auth goes to the auth boundary,
a contract mismatch to the reload notice, a same-system defect to the error
boundary, and every other code to quiet feedback from one copy table
(`failureDetail`), which also words modeled send rejections.

## Transcript

`ChatSurface` renders the active path, a fork strip after every assistant on it
that has two or more user children, and a fork strip above the first turn when
the conversation has root alternatives. Each row owns the resource-menu intents
aimed at it (Fork from here, Walk the sources, Rerun, Regenerate, Delete).

User and assistant turns keep programmatic role identity and accessible group
labels without visible `You` or `Assistant` headings, a `66ch` maximum
measure, and the quiet accent rail on user turns. Chat assistant answers do not
compose `MachineText`.

`AssistantMessage` is the assistant-turn owner. Its visible order is the live
cue and run phase (pending only), the live tool line (from the overlay only),
the answer, the publication warning when present, `AssistantTrust` (write trail
with Undo, closed `Sources (N)`, closed `Details`), the selection popover, the
failure/paused/reconnect card, and the actions (Rerun or Regenerate with a
different model, the resource menu). Inline citations remain active. The
publication warning is a quiet amber `role="status"` notice, never a red
failure.

Details holds route, model, thinking, status, billing, privacy, usage, support
id, one counts line (tools, retrieved, selected, included,
cited, context refs), the tool list with each tool's retrievals, the citations
(each opens its source) and the context refs the run added. Undo renders only for a completed write whose tool call carries a
machine authorship and no `reverted_at`.

Ordinary prose and links wrap inside the pane. Only bounded code and table
containers may scroll horizontally.

### Scrollport and anchoring

`ChatSurface` owns the transcript scrollport. Desktop may reserve a stable
scrollbar gutter to keep transcript layout stable. Mobile must use platform
scrollbar gutter behavior and must not reserve a stable inline-end gutter.
Workspace layout must not compensate for chat transcript gutter policy.

`useChatScroll` is the single scroll owner. On a new user turn the question is
pinned to the top inset; once the streaming answer overflows the viewport the
transcript follows the newest text at the bottom edge; a genuine user scroll-up
releases following and shows `↓ Latest`; returning to the near-bottom band
re-engages it. Pin state is one `top | bottom | released` mode. Native
`overflow-anchor` stays disabled. Opening a fork from a strip keeps the strip's
anchor message where it was on screen.

`?message=<id>` reveals a message: off the active path, the store switches to
the newest leaf under it first; a message that is not in the tree shows "This
message isn’t here."

### Conversation Find

A loaded existing Conversation publishes Pane Find on `Cmd/Ctrl+F`; global
Search remains `Cmd/Ctrl+K`. The searchable document is the active
root-to-leaf path. Terminal visible primary message blocks are independent
literal-search units; pending bodies and all auxiliary transcript chrome are
absent.

`components/chat/conversationFind.ts` is the conversation's `FindSource` for
the shared `useFind`. only terminal blocks carry `data-pane-find-block`, so the
DOM is the source: each block is projected with `buildDomTextCursor` after
citation rewriting, Markdown/GFM and syntax highlighting, minus
`[data-pane-find-exclude]` descendants, matched with the shared matcher and
mapped back to exact `Range`s. the shared custom highlights render all matches
plus the active match; no React/Markdown `<mark>` path exists.

the source key is the conversation, the active leaf and the id and status of
each terminal message, so streaming tokens never re-run a search; a new key
re-runs the live query and drops the way back. `useChatScroll` remains the sole
viewport owner: `revealRange` releases the pin (streaming follow yields) and
scrolls the match to the top inset, nudging a code block sideways. close stays
at the match, and **Go back to reading position** restores the scroll offset
and pin mode captured at the first reveal.

## Send Path

`ChatComposer` owns input, the exact next-run selection and the one action
button. It never builds branch semantics itself: `chatView` hands it the send
target — `New`, `Empty`, `Reply {parentId, anchor}`, or `Blocked` with one of
`HistoryLoading | HistoryUnavailable | AssistantRunning |
ReplyTargetUnavailable` (announced to screen readers, never shown as an error).
Draft editing stays available while a run is pending.

The action button is one socket: `Send message`, `Sending message`,
`Stop response`, `Stop requested`, or `Retry send`. Desktop Enter sends and
Shift+Enter inserts a newline; every Enter inserts a newline in the mobile
viewport. IME composition owns Enter. The shared `Textarea` grows from two to
six rows. Focus returns to the input after a completed or known-failed send.

The request:

- `destination` — `{ kind: "New" }` or
  `{ kind: "Existing"; conversation_id; insertion }`, where `insertion` is
  `{ kind: "Empty" }` or `{ kind: "Reply"; parent_message_id; branch_anchor }`
- `content`
- `selection` — exact tagged route/model/reasoning, validated against the
  current catalog at admission
- `reader_selection` — `Presence<{ key: ReaderSelectionKey; revision }>`

The fork being composed wins over a plain reply; a plain reply is an
`assistant_message` anchor on the leaf. New-chat sends use
`destination: { kind: "New" }`, which creates the conversation atomically on
send; a failed first send leaves no conversation. The request carries no
top-level `conversation_id`, no `chat_subject`, and no client
`exact`/`prefix`/`suffix` (`extra="forbid"`).

`POST /chat-runs` is a receipt boundary. Under the viewer/key advisory lock it
first replays the immutable `ResourceMutation(scope="chat:admission")` decision
or validates a new admission. Accepted chat (when New), messages, run, attached
evidence, job, the owner's index-revision bump and the receipt commit atomically,
and admission sets the conversation's active leaf to the new assistant. A modeled rejection rolls provisional writes back to a savepoint and
commits only its closed reason. The response is
`{data:{idempotency_key,outcome:Accepted|Rejected}}`; it contains no run
projection. Every chat route requires `X-Nexus-Chat-Contract: 4`; an older tab
gets `409 E_CHAT_CONTRACT_RELOAD_REQUIRED` and the reload notice.

### Drafts

A draft is `{text, selection, pending}`. Sending writes `pending = {key,
request}` and then POSTs; one in-flight POST per storage key is shared by every
view in the tab.

- Accepted: the text and `pending` are cleared; an existing chat's draft keeps
  the selection it was sent with (the answer the next turn replies to), and the
  `new` draft resets to the seed. The sending view adopts the run: a new chat
  routes to `/conversations/<id>?message=<assistant>`, an existing chat reads
  the run, selects it and tails it. Other tabs see the send on their next read.
- Rejected: only `pending` is cleared; text and selection stay editable, the
  catalog is reread, and the copy table words the reason. A stale quote
  refreshes its preview; `E_CONVERSATION_NO_LONGER_EMPTY` rereads the tree.
- A definite failure clears `pending`. An ambiguous failure (network, upstream,
  5xx) keeps it: the composer locks the text and selection and shows "Send
  status unknown"; **Retry send** replays the same key and bytes, and the
  server answers with the original receipt. The lock survives reload.

The `new` draft is one per account per tab, so a reload of
`/conversations/new` restores it; two new-chat panes in one tab share it. The
draft key is known at mount, so a restored draft paints with the composer's
first frame. An unreadable record is discarded with a console error. No earlier
storage version is read.

### Generation selection

`GenerationPicker.tsx` holds one catalog per tab (`GET /api/llm-catalog`),
loaded on first use and reread only after a rejection or an explicit Retry,
never on focus. `lib/chat/selection.ts` owns the draft union
`Uninitialized | ModelRequired | ThinkingRequired | Selected` and its
transitions: changing a parent clears its children; a model takes a selectable
source default, otherwise its sole thinking setting, otherwise requires one.
Only an uninitialized draft is initialized, once history and the catalog are
ready, from the selection of the answer it replies to, else the catalog seed.
A current choice the catalog no longer offers stays shown, disabled, and blocks
send with its reason. The browser owns no allowlist and substitutes nothing.

## Rerun And Regenerate

`POST /messages/{assistant_message_id}/rerun` recovers an eligible failed or
cancelled turn; `POST /messages/{assistant_message_id}/regenerate` makes a
fresh alternative for a completed answer. Both share one sibling-candidate
constructor (`services/chat/admit.py::repeat`): under the conversation lock it
clones the source user turn (content, parent, branch anchor, reader-selection
snapshot) into a new user sibling with a pending assistant and one queued run
with fresh context, and selects the new assistant as the active leaf. Each
request carries an exact selection. An answer with no run (written before
0246 kept runs) answers 404 `E_MESSAGE_NOT_FOUND`; its action facts already
hide both actions.

Without an explicit choice the store reuses the source run's selection only
while the current catalog still offers it; otherwise it says "The original model
is unavailable" and the user picks one through **Rerun / Regenerate with a
different model**. Each command is idempotent under `Idempotency-Key`; the
store keeps the key per source and operation across an ambiguous failure, so an
identical retry replays it, and mints a new key otherwise. Rerun (failed turn),
Regenerate (completed answer), Reconnect (lost stream), suspended (operator
recovery) and Fork stay distinct.

The failure card's copy is a fixed table over the six run failure codes
(`NonNullable<Schema<"TrustRunOut">["failure"]>["code"]`), never a provider name
or raw code; a missing failure renders the generic defect copy. It shows the
run's Support ID, and **Rerun** only when the message's `can_rerun` holds (the
server checks again).

## Forks

A fork is a user turn with siblings: two or more user children of one parent
(an assistant, or the conversation root). There is no branch table:
`messages.fork_title` holds an optional title on the user turn (1–120
characters after trimming; NULL clears it), and
`conversations.active_leaf_message_id` holds the owner's selected leaf.

- **Strip.** `ForkStrip` renders the alternatives at a fork point on the path
  ("Forks from this answer", or "Forks from the start" for root alternatives).
  Each option is labelled by its title or its first words, status and whether
  it is current; choosing one switches to the newest leaf under it.
- **Outline.** The Forks inspector tab (`ForksPanel`) lists every fork point's
  alternatives as an indented tree ("Conversation forks"), with a client-side
  "Search forks" filter over titles and text, and per row Open, Rename and
  Delete (with a confirmation). Delete is message delete of the fork's user
  turn and its subtree.
- **Switch.** `POST /conversations/{id}/active-path {active_leaf_message_id}`
  answers `204`. The server locks the conversation row and requires a leaf of
  this conversation (`400 E_BRANCH_PATH_INVALID` otherwise). The browser shows
  the switch at once; a failure reloads the tree, never restores a snapshot.
- **Rename.** `PATCH /messages/{message_id}/fork-title {title}` answers `204`;
  owner-only, user turns only, else `404 E_MESSAGE_NOT_FOUND`.
- **Delete.** `DELETE /messages/{id}` removes the subtree (revoking a running
  run's job), the tree is reread, and deleting the active path's turn moves the
  leaf to the newest remaining message (`ON DELETE SET NULL`, newest-message
  fallback on read). Deleting the only turn deletes the chat.

The fork being composed (`BranchDraft {parentId, anchor, quote}`) is pane
state, not stored: the header shows "Fork reply" with the quoted passage, Jump
to parent and Cancel. It is dropped once its parent leaves the active path.

## Assistant Answer Selection

Selecting text inside a complete answer offers **Fork from selection** in a
`FloatingActionSurface`. The fork's anchor is `assistant_selection` with the
exact text, up to 80 characters of rendered prefix and suffix, a random client
selection id, and `offset_status: "unmapped"`: the browser never maps a
rendered selection to source offsets. It is not reader selection, not a
citation, and not a context ref.

## Floating Action Surfaces

`FloatingActionSurface` is the shared non-modal action-surface primitive for:

- assistant answer selection actions
- reader text-selection actions
- clicked-highlight actions
- nested action-bar render popovers

It is a transient layer of the overlay stack (`docs/modules/overlays.md`): Escape, a press
outside it and its anchor element and, inside a modal, Back dismiss it. Placement comes from
`useAnchoredPosition` (text-selection line placement with a caret, viewport clamping, mobile
bottom clearance, re-measuring on scroll and resize); pointerdown prevention keeps a live selection.

Fresh reader selection is the icon toolbar: `SelectionPopover` sequences
Highlight-first chat creation and `SelectionActionDock` renders **Ask** as a
direct icon control and **Ask in existing chat…** as a text-labeled item in the
**More** menu. The dock does not create conversations or own destination
behavior. Both actions create or reuse the default-yellow Highlight before
launch, and neither creates a Conversation before the first send.

`ActionMenu` remains separate because it owns menu semantics: roving keyboard behavior,
menu roles, focus restoration, and menuitem rendering. A menu opened inside a floating
surface is the newer transient, so a press inside the surface closes only the menu and a
press on the menu closes nothing.

`FloatingActionSurface` is the documented non-modal action-surface owner and must not migrate
to `MobileSheet`.

## Reader Quote-To-Chat: Immutable Snapshot

A reader Highlight quote is an immutable per-message snapshot, not a run
turn-context pair and never live-reconstructed at prompt time. On send the
server row-locks the Highlight, derives the canonical quote fields, and stores
one `ReaderSelectionSnapshot` on `messages.reader_selection_snapshot` (JSONB).
Every later read — transcript, reload, branch switch, rerun, and
prompt assembly — derives from that snapshot. `services/chat/quotes.py`
is the sole snapshot owner (build, encode/decode, revision, quote-subfield
projection, and prompt-render input); the snapshot shape is
`key{media_id, highlight_id}`, `source_label`, `exact`, `prefix`, `suffix`, and
`locator: MediaRetrievalLocator`.

The request sends `reader_selection: Present<{ key: ReaderSelectionKey;
revision }>` only. The server derives the `highlight:<id>` subject and its
`media:<id>` companion under the Highlight row lock and writes them as
`ResourceEdge(kind="context")` rows in the same atomic commit; neither is client
input, and client quote text is rejected. `ReaderSelectionKey{media_id,
highlight_id}` is the durable selection identity and part of the idempotency
hash; `ReaderSelectionRevision` (lowercase 64-char SHA-256 hex) is a
compare-on-send precondition only and is explicitly excluded from that hash.

`reader_selection` is not a branch anchor and is not cited. Assistant selection
and reader selection compose in one send only as separate fields.

`Conversation` is the sole quote launch-intent owner. It parses the pane-local
hash `#mediaId=<uuid>&highlightId=<uuid>` (`lib/chat/readerIntent.ts`; the
destination is the path), hydrates one `ReaderSelectionPreview` through
`GET /chat-reader-selections/highlights/{id}?media_id=`, and passes it to the
composer. `QuotedPassageCard` renders the quote pending (above the composer,
removable, with Retry on a failed preview) and sent (read-only, above the user
body); **Open source** reopens the passage from the snapshot's locator. A send
carries only the key and the preview's revision; an accepted send spends the
hash. `ConversationDestinationOverlay` is the existing-chat picker: the 25
newest chats, or a title search over `GET /conversations?title_search=`.

## Chats Index

`GET /conversations` returns the typed finite collection page
`{data:{items,nextCursor,collectionRevision}}`. `ConversationsPaneBody` shows
one exact view, drains every page, filters rows client-side by title, counts
them, and refreshes when a chat or message delete publishes an index change
(`publishConversationIndexChange`). The pane URL owns the view through the
shared updated/title codec (`lib/collections/updatedTitleIndexView.ts`):
newest update is canonical and has no keys; `sort=updated&direction=asc` and
`sort=title&direction=asc|desc` are the others. The Sort control writes the URL,
Reset view returns to canonical, and a malformed pair shows "Invalid chats view"
with Reset. The server sorts titles on the title (a DB CHECK keeps it nonblank), then
`updated_at DESC, id DESC`, and binds cursors to the order plan. Optional
`title_search` is a trimmed, case-insensitive literal substring of the stored
title, bounded to 200 characters. Any other key, `has_context_ref` included, is
400 `E_INVALID_REQUEST`.

## Citation Candidates And Final Edges

Chat keeps model-facing evidence candidates separate from reader-facing
citations. One numbering rule (`citations.number_candidates`) assigns dense
answer-global `message_retrievals.citation_candidate_ordinal` values only to
citable rows actually exposed to the model: under the run lock each numbering
continues after the answer's largest ordinal so far and never renumbers a row.
Attached evidence (the citable `<resources>`, tool call 0) is numbered at
admission, `1..k`; every tool call's candidates follow, in whatever order the
calls complete. Selection or prompt inclusion alone does not make a row a
candidate.

After generation, one canonicalizer maps the candidate markers used in the
answer to dense final ordinals by first appearance. Only then does publication
mint `origin='citation'` resource edges and set `cited_edge_id`. Sparse valid
markers are canonicalized, and no markers is a valid answer with no edges.
Unknown or linked markers publish marker-free prose with the closed
`CitationsUnavailable` warning and a support id. Graph or database defects fail
the run; they never degrade.

Final markdown, citation edges, retrieval back-pointers, context refs and their
`context_ref_added` events, warning state, and terminal `done` are one
transaction. A degraded answer writes no edges. Rendered citations are built from
the final edges by `build_citation_outs_for_sources` (in `reads`), uniformly with
Oracle and Universal Dossiers.

`message_retrievals` is chat-owned **telemetry** and the sole durable
per-result record: candidate generation and rerank/selection are transient,
in-memory passes over a tool call's results, and only the
selected/included outcome is ever written as a row. A cited row points back
at its final citation edge through `cited_edge_id`. Candidate ordinal lives on
the telemetry row; final reader ordinal lives on the edge.

Assistant messages also carry a backend-built `trust_trail`: the durable
inspector read model over `chat_runs`, tool calls, retrieval
rows, citation edges, and the `done`/`context_ref_added` events, read in one
batched pass and never stored. Messages ship their `content`; the
assistant's text is rendered as markdown, the user's as plain text.

The run is the sole support-id and publication-warning owner. The terminal run
read replaces the streamed overlay with the persisted canonical answer.

"Walk the sources" (`Docent.tsx`, from the answer's resource menu when it has
two or more citations) steps through the citations in order, driving the pane
to each source while the sentence that cites it stays in view (`n`/`→`,
`p`/`←`, `Escape`).

## Backend Validation And Prompt Rendering

FastAPI schemas accept `assistant_selection` branch anchors and `reader_selection`
key+revision inputs as separate concepts. An `assistant_selection` anchor is
always `offset_status: "unmapped"` (a mapped anchor is a 400); admission checks
that a reply's anchor names its parent, a complete answer of this chat, after
locking the conversation.

The frozen prompt (`services/chat/context.py`): the instructions are the fixed
system prompt alone. The input opens with the turn's context — for a quote turn
`<subject>` (Highlight identity/source metadata) and `<reader_selection>` (the
sole quote-text block) from the immutable snapshot, never the live Highlight; a
fork's selected answer text (`<assistant_selection>`); and the chat's
`<resources>`, with `n` only on citable rows and the quote's Highlight compact
so its text appears once — then history, then `<user>` and the turn. History is
the parent's root path as user/answer pairs, newest first while both the token
budget (`chat_budgets`, already net of the output) and chat's 512 KiB input
bound hold; the first pair that does not fit ends it, so history stays
contiguous. Historical quoted turns insert a `<historical_reader_selection>`
block before their user text. Mandatory context never drops: when it cannot fit,
the send is a recorded `E_GENERATION_CONTEXT_TOO_LARGE`. Source-activation
destination comes from the immutable locator (gated by live visibility), never
the live Highlight.

## Backend: one package

`services/chat/` (2026-10-10 rewrite, mig 0271):

| module | owns |
|---|---|
| `admit` | send, rerun/regenerate, cancel: the receipt envelope (advisory key lock, replay, one savepoint, memo), destination, anchor, quote, message pair, run freeze, job, the owner's index bump |
| `context` | the system prompt, the turn's context blocks, two-budget history, the frozen intent |
| `quotes` | the reader-quote snapshot: build (locked highlight), encode/decode, revision, projection, preview, the XML quote renderer |
| `citations` | candidate numbering, attached evidence, publication |
| `retrievals` | `RetrievalCitation`, `citation_from_search_result`, the one `message_retrievals` writer |
| `tool_calls` | the `message_tool_calls` writer: start, finish, attached (index 0), live write count |
| `events` | run lock, claim fence, append (and the threaded live append), tail read, stop flag, the terminal fold |
| `worker` | the `chat_run` job, its dead-letter projection, the attempt, the text coalescer |
| `reads` | failure and rerun policy, run selection, owner gate, advisory, run response, tree, trust trails, the Undo projection |
| `conversations` | create, the index, leaf select, fork title, deletes, owned ids, message action facts, the agent's page reader |

Invariants: one admission is one savepoint (or only a rejection receipt); every
nonterminal run has exactly one `chat_run:{id}` job; `events.finalize` is the
only terminal writer and no-ops on a terminal run; the lock order is run, then
job claim, everywhere; nothing replays (an attempt that finds its run's
generation started, or a dead job, ends it `interrupted`, or `cancelled` when a
stop was asked); candidate ordinals are dense from 1 per answer and never
renumbered; a quote snapshot is written once; the active leaf is a leaf or NULL;
every read and write is owner-scoped and foreign ids mask as not found; every
existing-chat insertion locks the conversation before it reads a parent, as
deletion does.

Streamed text frames commit on a worker thread, each in its own session, at 512
chars, 2048 bytes or 33 ms, in order. A frame waiting on a lock never holds the
job's loop, so the stop poll, claim check and deadline keep running; those stay
on the loop, as short reads in their own sessions. Adding text never waits on a
write: frames queue in memory behind one writer task, because the codex
runtime's event buffer is finite (256 events) and a consumer that stalls on the
database overflows it into a `defect`. Phases before and after the generation
run on the job's session.

Event payloads are the wire models (`ChatRunAssistantTextDeltaEventPayload`,
`ChatRunToolCall{Start,Done}EventOut`, `ChatRunToolResultEventOut`,
`ChatRunContextRefAddedEventPayload`, `ChatRunDoneEventPayload`): six types, one
model each, stored and streamed as is. A stored payload carries at least its
current model's keys (pre-0271 rows may carry more); nothing validates stored
frames on read, and the trust trail reads `done.usage` and four
`context_ref_added` keys by name.

Deletion (`conversations._delete`, under the conversation lock): the subtree's
ids, their runs' jobs revoked, every web-snapshot id their retrievals captured,
message edges, `DELETE FROM messages` (FK cascades take runs, events, tool calls
and retrievals), the orphaned snapshots, and when no message remains, the chat's
edges, its dossier subject and the chat. `llm_calls` has no FK and outlives the
chat as the operational ledger.

Index revisions are per owner: a send, delete or create bumps only its owner's
`ConversationIndex` revision, once.

## Assumptions

Open owner questions the 2026-10-04 rewrite answered by default. Each holds
until the owner says otherwise.

1. Forks UI is the inline strip (also above root alternatives) plus one Forks
   outline with search, rename, delete and open. The svg fork graph and its
   keyboard tree navigation are deleted (owner decision 2026-10-04, superseding
   "fork graph kept" of 2026-09-18).
2. Fork titles are kept, on the user turn (`messages.fork_title`).
3. The docent ("Walk the sources") and Details are kept whole: Details lists the
   run, counts, tools, citations and context refs.
4. Drafts are one per account and conversation, plus one `new` draft per
   account per tab. Fork mode is not persisted.
5. Reload resumes a pending run by replaying its events from 0. There is no
   server stream fold and no active-runs list.
6. Only the sending view adopts a send. Other tabs see it on their next read;
   panes in one tab share the draft record.
7. The Chats index keeps its behaviour: the updated/title sort, filter, drain
   and count.
8. The v4 draft-recovery panel and the "history cleared" notice are deleted.
9. Passage forks are always `unmapped` (exact plus rendered prefix/suffix).
10. A cancelled Codex answer keeps the commentary it streamed, as a provider
    answer keeps its streamed text; on success the sealed final answer replaces it.
11. The existing-chat picker shows the 25 newest chats or a title search, with
    no paging.

## verification

manually validate durable execution, citations, authorization, provider tools,
and browser composition when those boundaries change.
