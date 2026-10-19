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

## state owners

the browser separates saved graph, pane endpoint, live presentation, commands and draft text.

1. **One copy of the server's tree.** `GET /conversations/{id}/tree` returns
   `{conversation, messages, active_leaf_message_id}`: every message once, in
   `seq` order, the last admitted send leaf and `conversation.branch_revision`.
   `components/chat/conversationStore.ts` keeps that map. only full tree reads
   establish graph membership and the send default; an older revision cannot replace
   a newer tree. run reads update still-present messages by `updated_at`;
   higher-revision run reads trigger a tree read. they never add a missing pair
   or select their answer.
2. **A live overlay per pending answer.** `lib/chat/runTail.ts` folds a pending
   run's SSE events into `{text, tools, execution, link}` beside the saved
   message. The overlay paints; it never changes a message's status, text or
   trust trail. When the stream ends — `done` or lost — exactly one
   `GET /chat-runs/{run_id}` decides. A still-pending run after a lost stream
   shows Connection lost.
3. **one existing-chat command per account/conversation/tab.**
   `lib/chat/commands.ts` freezes the target, revision, request and run uuid in
   memory. it retains unresolved work across pane remounts and distributes the
   canonical tree to mounted consumers before opening its gate. account change
   clears it. idle identity stays stable for the tab; unobserved owners retain
   no settled tree or request. there is no command journal,
   cross-tab synchronization or recovery after tab destruction.
4. **pane endpoint.** `Conversation` owns the displayed ancestor path's endpoint.
   `/conversations/<id>?leaf=<uuid|empty>` persists it in the existing visit href.
   absent means unseeded; an explicit empty view remains empty after another pane
   sends. a new untargeted view seeds once from the send default. shared graph
   refresh never advances a sibling's endpoint.
5. **draft text and selection.** `lib/chat/drafts.ts` stores per-account, per-pane,
   per-conversation/new convenience drafts. existing-chat dispatch belongs to the
   command owner; only new-chat dispatch persists its pending request. the
   `nx_chat_draft:` prefix hard-cuts the former shared draft records.

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
- O4: an existing-chat command gate opens only after definite refusal or
  canonical reconciliation; uncertainty never silently permits new intent.

## Durable Execution And Recovery

`services/chat/worker.py` runs the queued run's one generation (`generate`,
[llms.md](llms.md)) from its admitted spec and frozen prompt
(`chat_runs.generation_spec`, `chat_runs.generation_intent`), then publishes it.
`services/tools/` owns the tool contract, the plans and the one dispatcher
([model-tools.md](model-tools.md)).

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
`CodexCallbacks`. both use the same `run_tool`, principal, scope,
`tool_calls` row, evidence, citations, trust, and undo. host-owned authentication
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

Trust-run `execution` is a required, nullable value.
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

A tail opens `GET /api/stream/chat-runs/{run_id}/events?after=N` through the
shared `openStream` (eight automatic reconnects, 1–8 s backoff with jitter,
`?after=` resume inside one tail; the bff's planned cut at 280 s resumes at
once; [api edge](api-edge.md)). A pending answer found on a
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
LISTEN cap backs off and reconnects like a network failure; a `401` is final and
goes to login.

## Pane, Inspector And Dossier

`Conversation.tsx` is the pane adapter. The route id keys a fresh conversation
(store, scroll, docent); a changed id never reuses state. It owns route state
(`?leaf`, `?message`, `?draft`, the quote hash) and the fork being composed, and wires
the store, the draft, the inspector and the docent. the store owns graph/content;
the pane owns its endpoint and catalog read.

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

the reader composer uses existing chat admission for a nonblank prompt and the
quote launch intent for a blank prompt (see Reader Quote-To-Chat below).
generic resource-context chats go through `openConversationAbout`
(`lib/chat/conversationIndex.ts`), which creates a context-bearing
conversation via `POST /conversations {id, initial_context_refs}`. the client uuid
identifies the attempt: same-owner replay returns its first row/context unchanged,
foreign id is 409, and initial creation is atomic with its context links.
`conversationIndex.ts::openConversationAbout` shares this owner between menu and
reader shortcut. an uncertain retry offers the same id/inputs/sticky intent with
fresh placement authority; a separate create gesture starts another attempt.
success publishes `Chats`; `openAsyncResult` decides its landing or result offer.

A missing or foreign conversation is `404 E_CONVERSATION_NOT_FOUND`; the pane
shows "This chat couldn’t be opened." with the server's copy. `chatFailure`
(`lib/chat/wire.ts`) is total over `ApiError`: auth goes to the auth boundary,
a wire mismatch (426) to the "Nexus was updated" copy, a same-system defect to the error
boundary, and every other code to quiet feedback from one copy table
(`failureDetail`), which also words modeled send rejections.

## Transcript

`ChatSurface` renders the active path with memoized settled rows. its saved-view
projection supplies stable alternatives and callbacks; live token frames update
only their answer. the pane catalog flows to `MessageDialogs`, not every row.

the transcript uses inter 16px/24px with normal tracking in every room, a 700px
frame and 66ch prose measure. padding is 12px below a 480px primary pane and
16px otherwise. user text remains plain, whitespace-preserving text in a
content-sized neutral bubble aligned right. assistant prose is unboxed.
`MarkdownMessage presentation="chat"` owns paragraph, list and heading rhythm;
the default dossier presentation is unchanged. only bounded code/table
containers may scroll horizontally.

`MessageFooter` provides one stable band, 4px after content: details and
alternatives on the left; copy, eligible same-selection regenerate and more on
the right. targets are 28px on fine pointers and 44px with any coarse pointer.
older secondary actions reveal on hover/focus or portal engagement; latest
settled actions and coarse-input actions remain visible. engagement never moves
message text. copy uses the exact saved body, excluding chrome and withheld
invalid output, and announces success/failure.

`AssistantMessage` retains warnings, failure/reconnect cards, text selection,
inline citations and visible writes/undo. pending rows retain details and one
polite current-action/phase announcement, without settled-message commands.
closed activity visibly excerpts long subjects; opened details retains them.
`MessageDialogs` owns information or repeat by message id and opener;
information contains semantic creation time. dialogs observe workspace commits
so same-visit source arrivals close them before delivery is consumed.

`MessageDetails` is one local inline record: frozen route/model labels plus the
saved reasoning selection key, unnumbered context links, chronological actions.
native reasoning labels can be explanatory paragraphs; the compact identity
uses the exact selected key, without a catalog lookup. empty groups, ordinary
success, accounting, inclusion flags and repeated citations are absent. the
message row owns its disclosure state across live/saved replacement; actions
are keyed by message and call position. one acknowledged undo state feeds the
receipt and action record. remote saves without a confirmed receipt remain
visible as unconfirmed; local recovered tool refusals remain in the action list.

context membership is the saved `GenerationSpec.tool_scope`, not current links
or proof of a full read. null means no saved scope; empty means recorded empty.
captured attachment evidence supplies historical names/locations where known;
other names and all navigation obey current access. each item retains its saved
scope ref. context assembly returns its already-read identities for admission's
scope, so prompt and scope do not perform separate membership reads.

`ResourceLink` owns compact title activation for context, subjects and results;
plain web urls remain native anchors. separate action buttons reveal bounded
recorded parameters/results. opening details fetches nothing. the existing scroll
owner holds one inspected trigger through streamed growth/reconciliation;
actual manual scrolling or navigation releases it. native keyboard focus may
rebase the inspected eye-line to reveal the focused control. collapse clamping
and manually returning to the bottom do not resume following; explicit latest
or a new turn does. focus follows a surviving disclosure
only when an owned focused child disappears. details opts out of the transcript
log's live announcements.

repeat dialogs own only a local selection editor; confirmation invokes the
shared command owner. failures and exact-request recovery remain in the dialog.
closing does not cancel admission or allow later completion to steal focus.
escape/cancel returns to the live opener without scrolling, else the conversation
region. source navigation transfers focus; loss of the source message closes
the dialog and announces it. menu fetching/eligibility and keyboard handling
remain with the shared resource menu and overlay owners.

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
`overflow-anchor` stays disabled. choosing a child alternative keeps its shared
parent at the same screen position. root selection focuses the conversation
region without scrolling, then reveals the chosen root through this owner.

`?message=<id>` inspects only its destination pane. retain an endpoint containing
the message; otherwise select its newest descendant leaf after resolution.
explicit `leaf` plus `message` requires membership on that path. pending
message-only hrefs stay message-only; success persists chosen leaf plus message.
cancelled arrivals cannot change endpoints. invalid/duplicate leaves and missing
cold endpoints show branch unavailable and require explicit choice.

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
viewport. IME composition owns Enter. the shared `Textarea` grows from one to
six rows. an uncertain send makes it readonly and leaves it focusable; async
completion never moves focus back from another control.

The request:

- `destination` — `{ kind: "New" }` or
  `{ kind: "Existing"; conversation_id; expected_revision; insertion }`, where `insertion` is
  `{ kind: "Empty" }` or `{ kind: "Reply"; parent_message_id; branch_anchor }`
- `content`
- `selection` — exact tagged route/model/reasoning, validated against the
  current catalog at admission
- `reader_selection` — `{ key: ReaderSelectionKey; revision } | null`

The fork being composed wins over a plain reply; a plain reply is an
`assistant_message` anchor on the leaf. New-chat sends use
`destination: { kind: "New" }`, which creates the conversation atomically on
send; a failed first send leaves no conversation. The request carries no
top-level `conversation_id`, no `chat_subject`, and no client
`exact`/`prefix`/`suffix` (`extra="forbid"`).

`POST /chat-runs` names its run: the `Idempotency-Key` must be a uuid (else 400
`E_INVALID_REQUEST`) and becomes `chat_runs.id`. Under an advisory lock on
`chat_admission:{key}` (apart from the generation ledger's `chat_run:{id}`), the
viewer's run with that id answers the send whatever the body; another
user's run with it is 409 `E_RESOURCE_CONFLICT`; otherwise the admission is
validated and the chat (when New), messages, run, attached evidence and job commit
atomically, and admission sets the conversation's active leaf to the new
assistant. A modeled rejection rolls everything back and is not stored: a resend
decides again. The response is `{data:{idempotency_key,outcome:Accepted|Rejected}}`;
it contains no run projection. A send refused with 426 `E_WIRE_MISMATCH` was never admitted: it is
a definite failure, so the draft stays a plain unsent draft across the tab's
reload.

### Drafts

an existing-chat send freezes its typed request and observed branch revision in
`commands.ts`; draft storage receives neither the command nor the revision.
busy/retry state comes from that owner. acceptance clears only the submitted
text, preserving later edits. an old stored existing-chat pending request is
never upgraded with a current revision or automatically replayed.

new-chat sending retains `{text, selection, pending}`. it writes `pending =
{key, request, openIntent}` before posting; one in-flight post per pane draft key
owns the request. its recovery remains separate from existing-chat commands.

- Accepted: the text and `pending` are cleared and the `new` draft resets to
  the seed. retained completion authority opens the exact admitted assistant
  endpoint; superseded completion offers it. shift changes the landing pane only.
- Rejected: only `pending` is cleared; text and selection stay editable, the
  catalog is reread, and the copy table words the reason. A stale quote
  refreshes its preview; `E_CONVERSATION_NO_LONGER_EMPTY` rereads the tree.
- A definite failure clears `pending`. An ambiguous failure (network, upstream,
  5xx) keeps it: the composer locks the text and selection and shows "Send
  status unknown"; **Retry send** resends the same key and bytes, and the
  server answers with the run that key named if it landed. The lock survives
  reload.

the `new` draft is one per account and pane, so workspace reload restores it;
two new-chat panes keep independent drafts. the
draft key is known at mount, so a restored draft paints with the composer's
first frame. An unreadable record is discarded with a console error. No earlier
storage version is read.

### conditional existing-chat commands

`commands.ts` owns send, repeat, delete message and delete chat.
each descriptor freezes its observed revision, target and exact request; a
generation uuid is the run identity. its states are `Idle`, `Sending`,
`Reconciling`, `Unconfirmed` and `RefreshRequired`. only idle admits fresh work.
successful writes read the canonical tree and synchronously deliver it to
subscribed stores before opening the gate. no lock lasts through generation.

`E_CONVERSATION_CHANGED` means the frozen observation is stale: show the
conflict and require refresh without resubmitting. initial definite refusal
returns idle. uncertain transport retains the descriptor; retry sends identical
bytes/uuid/revision. a later refusal cannot erase an earlier uncertain attempt
without accepted-run evidence or a revision/absence fence. accepted writes with
a failed tree read offer read-only retry refresh. reconciliation checks the
returned message/run identity, never equality with the global send default.
send/repeat freeze opening intent; retry may upgrade it to new-pane, never downgrade.
the initiating live view alone advances after acceptance; superseded views get
an exact result offer through `openAsyncResult`.
the offer names the frozen conversation title, or a bounded submitted-prompt
preview for a new chat. multiline shift-enter remains editing, including repeats.

the command owner is shared by the existing-chat composer, repeat, inspector and
resource actions. explicit reader new-chat sends use the new-chat transport;
there is no second existing-chat reader command path. branch browsing and
off-path reveal make no write.
one chat-owned
deletion helper captures state before native confirmation and executes that
frozen descriptor. whole-chat deletion reads the tree before confirmation;
message deletion uses its pane snapshot. cancellation dispatches nothing.
only authoritative absence clears graph/panes and removes the index item.
whole-chat deletion recovery uses the projected action's persistent feedback
rail; panes share its gate without duplicating its recovery controls.

### Generation selection

`Conversation` owns one pane-visit `useServerValue` read of the catalog and
passes it to the composer and message dialogs. `lib/chat/catalog.ts::readCatalog`
is the uncached typed loader; the reader owns its own read and an imperative
repeat reads it directly. opening a picker or pressing refresh rereads through
the existing request owner, retaining usable data on refresh failure. no
component cache, focus refresh or polling exists.

`GenerationPicker` composes three controls: provider, actual model/mode variant,
and effort. `ChoicePicker` owns exclusive listbox selection through maintained
react aria hooks; the shared `PickerSurface` owns anchored placement and the
existing mobile sheet/overlay behavior. navigation does not commit a provider
or model. `EffortPicker` uses native range indices over the selected variant's
ordered legal rows; each stop commits the exact execution key immediately.
missing effort requires an explicit choice, with no invented range thumb.

`lib/chat/selection.ts` owns exact selection transitions. changing provider
requires a model. changing model/mode within a provider preserves a selectable
native effort name, else takes that mode's declared default, else its sole
selectable effort, else requires effort. selecting the current value is a no-op.
refresh never substitutes a different identity. unavailable choices keep known
labels, block send and offer explicit repair.

the composer keeps incomplete provider/model/mode edits in memory. only a
complete `Selected` value reaches the existing draft owner; reload or leaving
the conversation restores the last complete choice. the persisted draft codec
is unchanged. untouched drafts still inherit the parent selection or seed.
repeat-dialog editors initialize from their source run, remain local, and execute
only through their explicit regenerate/rerun confirmation.

## Rerun And Regenerate

`POST /messages/{assistant_message_id}/rerun` recovers an eligible failed or
cancelled turn; `POST /messages/{assistant_message_id}/regenerate` makes a
fresh alternative for a completed answer. Both share one sibling-candidate
constructor (`services/chat/admit.py::repeat`): under the conversation lock it
clones the source user turn (content, parent, branch anchor, reader-selection
snapshot) into a new user sibling with a pending assistant and one queued run
with fresh context, and selects the new assistant as the active leaf. Each
request carries an exact selection and expected revision. An answer with no run (written before
0246 kept runs) answers 404 `E_MESSAGE_NOT_FOUND`; its action facts already
hide both actions.

Without an explicit choice the store reuses the source run's selection only
while the current catalog still offers it; otherwise it says "The original model
is unavailable" and the user picks one through **rerun with… / regenerate
with…**. each command's uuid `Idempotency-Key` is its run's id, as for a send;
the command owner retains it across uncertain delivery. an existing owned uuid
returns its run before current catalog validation, without reselecting its
answer. Rerun (failed turn),
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
`conversations.active_leaf_message_id` holds the last admitted send/repeat default.
the pane's endpoint may have unselected continuations, including a single child.

- **chooser.** `Alternatives` renders one `n / total` control in the shared
  parent footer, or one leading row for root alternatives. its dialog shows
  fork title/ordinal, current mark, saved immediate-answer preview, actual
  response state and frozen model/route/reasoning. absent answers label the
  prompt; pending answers expose no live excerpt; failed/cancelled saved text
  is partial; invalid output is withheld. `MarkdownPreview` reuses the existing
  parser to produce inert plain text capped at 240 grapheme clusters. choosing
  current closes without writing; another choice updates only that pane.
  shift-click/shift-enter, including current, opens a fresh focused pane.
- **Outline.** The Forks inspector tab (`ForksPanel`) lists every fork point's
  alternatives as an indented tree ("Conversation forks"), with a client-side
  "Search forks" filter over titles and text, and per row Open, Rename and
  Delete (with a confirmation). Delete is message delete of the fork's user
  turn and its subtree.
- **browse.** canonical endpoint links change only the pane's visit href, without
  history, command or revision. the active-path write API and recovery UI are removed.
- **Rename.** `PATCH /messages/{message_id}/fork-title {title}` answers `204`;
  owner-only, user turns only, else `404 E_MESSAGE_NOT_FOUND`.
- **Delete.** `DELETE /messages/{id}?conversation_id=…&expected_revision=…`
  removes the subtree and revokes its running jobs under the conversation lock.
  a surviving selected leaf stays selected; otherwise the newest remaining leaf
  is stored in the same transaction. deleting the only turn deletes the chat.
  an absent/foreign target is an indistinguishable no-op. confirmation and
  uncertainty handling use the same helper as transcript deletion.
  a live deleted endpoint repairs to its nearest known surviving ancestor and
  reports the deletion; no known ancestor means unavailable, never another branch.

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
`useAnchoredPosition` (text-selection line placement with a caret, viewport clamping,
mobile bottom clearance, re-measuring on scroll and resize). reader composers
measure their canonical passage against the live source pane and keep their
own selection paint; focusing the editor does not dismiss them.

`SelectionDock` shows visible actions above the canonical rich `NoteEditor`.
`useSelectionComposer` owns explicit save/chat commands and the visit's unsaved
note drafts; [highlight](highlight.md#reader-presentation) owns the interaction
contract. unrelated action surfaces retain their own selection behavior.

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
`{key:{media_id, highlight_id}, evidence:CapturedEvidence}`. evidence freezes full
words, adjacent context, known colour/attribution and the complete source target.
readers compose the [shared historical resource item](resource-references.md);
current source access and location are separate capabilities.

the request sends `reader_selection: { key: ReaderSelectionKey; revision } | null`.
the server derives the `highlight:<id>` subject and its
`media:<id>` companion under the Highlight row lock and writes them as
`ResourceEdge(kind="context")` rows in the same atomic commit; neither is client
input, and client quote text is rejected. `ReaderSelectionKey{media_id,
highlight_id}` is the durable selection identity. `ReaderSelectionRevision`
(lowercase 64-char SHA-256 hex) is a compare-on-send precondition; retry keeps
the same chat run id and submitted request.

`reader_selection` is not a branch anchor and is not cited. Assistant selection
and reader selection compose in one send only as separate fields.

`Conversation` is the sole quote launch-intent owner. It parses the pane-local
hash `#mediaId=<uuid>&highlightId=<uuid>` (`lib/chat/readerIntent.ts`; the
destination is the path), hydrates one `ReaderSelectionPreview` through
`GET /chat-reader-selections/highlights/{id}?media_id=`, and passes it to the
composer. `QuotedPassage` renders the quote pending (above the composer,
removable, with Retry on a failed preview) and sent (read-only, above the user
body). its bullet opens the captured passage; its source label opens the whole
source. a missing historical location disables only the passage capability. a send
carries only the key and the preview's revision; an accepted send spends the
hash. `ConversationDestinationOverlay` is the existing-chat picker: the 25
newest chats, or a title search over `GET /conversations?title_search=`.

the reader's `new chat` command freezes the entered `body_text.trim()` and
configured model selection before ensuring the highlight or reading its quote.
a nonblank prompt sends `destination: New` with the canonical preview's key and
revision; it does not save annotation edits. `createReaderChatSend` in
`lib/chat/drafts.ts` captures one key and serialized request, coalesces concurrent
attempts and keeps its terminal outcome. uncertain delivery retries the same
bytes while the tab lives. the existing reader visit retains that continuation
across body unmounts; it has no storage journal or reload recovery and does not
use the ordinary `new` chat draft. an acknowledged highlight survives a refused
send. only the same active, unchanged opening navigates automatically; otherwise
feedback offers `open chat`.

a blank prompt opens the quoted new-chat composer without a run. `existing
chat…` opens the existing quote handoff without sending the note field. both
paths retain the unsaved rich note and caret in the reader visit. ordinary chat
drafts retain the session-storage contract described above.

## Chats Index

`GET /conversations` returns the keyset page `{data:{items,nextCursor}}`
(architecture §8.12). `ConversationsPaneBody` shows one view through
`useServerList`, drains every page, filters rows client-side by title, counts
them, and rereads when a chat delete, a message delete or an accepted send
publishes `Chats`; `DELETE /conversations/{id}` answers 204. The pane URL owns the view through the
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
Attached evidence (the citable `<resources>`: retrievals of the answer with no
tool call, the trail's `attached`) is numbered at admission, `1..k`; every tool
call's candidates follow, in whatever order the calls complete. Selection or prompt inclusion alone does not make a row a
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

retrieval captures `CapturedEvidence` when the evidence is read; publication copies
those facts without rereading a mutable target for replacement bounds. the
retrieval's durable id opens uncited historical evidence through the same resolver
as citation edges and sent quotes. ordinal is display order, never opening identity.

`GET /conversations/{id}/context` returns canonical admitted roots and their observed
context version. removal atomically detaches every current admission reason; past
messages and citation edges remain. ordinary chat links participate in the same
user-edit version. admission records `admitted_context_version` after its attachment
changes. publication adds automatic future context only if that version still
matches, once for the batch; an intervening edit suppresses all such additions from
the old run while preserving its historical citations. pre-cutover null versions
suppress additions. [resource graph](resource-graph.md) owns the command and locks.

global note deletion removes its historical citation edges as well as its other
associations. the acknowledged `resource_deleted` graph event removes matching
citations and open previews from mounted conversation stores, refreshes context
and fences older reads. stored message text and surviving citation ordinals are
unchanged: removing `[1]` does not retarget `[2]`.

`message_retrievals` is chat-owned **telemetry** and the sole durable
per-result record: candidate generation and rerank/selection are transient,
in-memory passes over a tool call's results, and only the
selected/included outcome is ever written as a row. A cited row points back
at its final citation edge through `cited_edge_id`. Candidate ordinal lives on
the telemetry row; final reader ordinal lives on the edge.

assistant messages carry a backend-built `trust_trail`: a batched read model of
run/recovery facts, saved scope references and semantic tool actions. it is never
stored. citations are hydrated directly onto the message. messages ship `content`; the
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
| `admit` | send, rerun/regenerate, cancel: the run-id envelope (advisory key lock, the run that id names), destination, anchor, quote, message pair, run freeze, job |
| `context` | the system prompt, the turn's context blocks, two-budget history, the frozen intent |
| `quotes` | the reader-quote snapshot: build (locked highlight), encode/decode, revision, projection, preview, the XML quote renderer |
| `citations` | candidate numbering, attached evidence (retrievals with no call), publication |
| `retrievals` | `RetrievalCitation`, `citation_from_search_result`, the one `message_retrievals` writer |
| `events` | run lock, claim fence, append (and the threaded live append), tail read, stop flag, the terminal fold |
| `worker` | the `chat_run` job (`run_job`), its `on_dead` hook, the attempt, the text coalescer |
| `reads` | failure/rerun policy, run selection, owner gate, advisory, run response/tree, frozen context, semantic actions and stage-specific event projection |
| `conversations` | create, the index, fork title, deletes, owned ids, message action facts, the agent's page reader |

`branch_revision` is initially zero and changes once for an admitted pair or
surviving-chat subtree deletion, under the existing
conversation lock. stream completion, stop, titles and context do not change it.
deletion/admission compare the client's frozen revision; mismatch changes nothing.
absent deletion does not increment it. browsing never writes.
the send-default leaf is null exactly when the tree is empty, otherwise a childless
message of that chat. migration 0289 materializes prior effective selections
and rejects invalid graph data; reads never conceal invalid leaves with a fallback.
wire 5 requires every existing-chat writer to supply its precondition.

Invariants: one admission is one savepoint (or only a rejection receipt); every
nonterminal run has exactly one `chat_run:{id}` job; `events.finalize` is the
only terminal writer and no-ops on a terminal run; publication and deletion lock
conversation, then run, then job claim, while run/job-only writers use that suffix
order; nothing replays (an attempt that finds its run's
generation started, or a dead job, ends it `interrupted`, or `cancelled` when a
stop was asked); candidate ordinals are dense from 1 per answer and never
renumbered; a quote snapshot is written once;
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

tool frames have separate durable payloads and public outputs. current start/
arguments-ready payloads store call id/position; results add status/error type.
existing stored facts are retained. `reads.read_events` is the common live/replay
boundary: batch call lookup by answer/position and source/target hydration when
tool frames are present; text-only batches perform no tool lookup. public
activity comes from recorded arguments and stage-permitted results. start never
acquires a future result; result never acquires later undo state. public outputs
are validated before emission; original event ids/sequences survive. call ids
changed in migration 0274, so historical association uses position uniformly.
`tool_call_done` remains arguments-ready; only result or terminal saved read
settles a visible action. no raw input/result body enters the public frames.

Deletion (`conversations._delete`, under the conversation lock): the subtree's
ids, their runs' jobs revoked, every web-snapshot id their retrievals captured,
message edges, `DELETE FROM messages` (fk cascades take runs, events and
retrievals; tool calls retain receipts with a null answer id), the orphaned
snapshots, and when no message remains, the chat's
edges, its dossier subject and the chat. `llm_calls` has no FK and outlives the
chat as the operational ledger.

The index keeps no revision: an accepted send, a chat delete and a message
delete publish `Chats` (`lib/api/changes.ts`) in their tab, whose mounted index
rereads; acknowledged context-create publishes the same topic.

## Assumptions

Open owner questions the 2026-10-04 rewrite answered by default. Each holds
until the owner says otherwise.

1. alternatives use the compact chooser plus one outline with search, rename,
   delete and open. there is no inline strip or separate graph renderer.
2. Fork titles are kept, on the user turn (`messages.fork_title`).
3. docent remains. compact inline details owns model/context/actions; message
   information owns creation time. citations remain in the answer.
4. drafts are one per account, pane and conversation/new. fork mode is not persisted.
5. Reload resumes a pending run by replaying its events from 0. There is no
   server stream fold and no active-runs list.
6. mounted panes adopt graph/content settlements together while retaining their
   endpoints, drafts and scroll. other tabs read later; stale writes conflict.
   there is no live tab sync.
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
