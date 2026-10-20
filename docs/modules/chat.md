# Chat Module

## Purpose

chat is a durable, branchable, streamed conversation with a model about the reader's own
material: grounded in attached context and quotes, citing what it used, acting on the
library only when asked, every action shown and undoable. a conversation is its owner's
alone; no read or write ever reaches another account's chat.

the backend is one package, `python/nexus/services/chat/`, behind one route module
(`api/routes/chat.py`) and one wire module (`schemas/conversation.py`). the web owners are
`apps/web/src/lib/chat/*` (wire names, tree derivations, selection, drafts, the command
owner, run tails, quote intents, pane views, the index) and `apps/web/src/components/chat/*` (the
store and the views).

| backend module | owns |
|---|---|
| `admit` | send, rerun/regenerate, cancel: the run-id envelope, destination, anchor, quote, message pair, run freeze, job |
| `context` | the fixed system prompt, the turn's context blocks, two-budget history, the frozen intent |
| `quotes` | the reader-quote snapshot: build from the locked highlight, encode/decode, revision, preview, renderer |
| `citations` | candidate numbering, attached evidence, publication, unpublished text |
| `retrievals` | `RetrievalCitation`, `citation_from_search_result`, `web_citation`, the one `message_retrievals` writer |
| `events` | run lock, claim fence, append, tail read, stop flag, the one terminal writer |
| `worker` | the `chat_run` job, its dead-letter hook, the attempt, the text coalescer |
| `reads` | failure/rerun policy, owner gate, advisory, run response, tree, trust trails, event projection |
| `conversations` | create, the index, fork title, deletes, message action facts, the agent's page reader |

## Concepts

- **conversation**: an owner-only tree of messages with a stored leaf (the last admitted
  send's: the default a new pane view seeds from) and a `branch_revision`.
- **turn**: a user message and its one assistant answer, inserted together.
- **endpoint**: the last message of the path one pane shows, kept in its visit href
  (`?leaf=<uuid|empty>`); browsing changes only that. **path**: root to the endpoint.
  **alternatives**: two or more user children of one parent (an answer, or the root);
  **continuations**: a parent's children when the endpoint stops there. a fork title
  lives on the user turn.
- **run**: the one generation of an answer, named by the client's uuid, with a durable
  event log, a stop intent and a terminal status. every answer has its run.
- **live overlay**: a pending answer's streamed paint; never state.
- **command**: one frozen chat write per account and chat (a new chat's: per pane) and
  tab, with the revision it observed and where its answer opens.
- **draft**: the viewer's unsent text and explicitly picked model, per tab and pane.
- **selection**: an exact catalog `route/model/reasoning`; never substituted.
- **quote**: an immutable snapshot of a locked highlight on a user turn.
- **context**: the chat's scope refs (future prompt membership), frozen per run as
  `tool_scope`.
- **citation**: a model-visible candidate ordinal, then a published edge with a dense
  final ordinal.
- **action**: a tool call's projection; undo authority only from saved authorship.

## Contracts

### http (authenticated, `Data{data}`, every request carries `X-Nexus-Wire`)

| route | request | answer | retry rule |
|---|---|---|---|
| `POST /chat-runs` | `Idempotency-Key: <uuid>`; `{destination, content, selection, reader_selection}` | `ChatAdmissionReceipt{outcome: Accepted{conversation_id, run_id, assistant_message_id} \| Rejected{reason:{code}}}` | the key is the run id: the viewer's run with that id answers any resend; another user's is 409 `E_RESOURCE_CONFLICT`; a rejection is not stored, so a resend decides again |
| `POST /messages/{answer}/rerun`, `/regenerate` | `Idempotency-Key`; `{selection, expected_revision}` | the same receipt; a missing source, a changed chat, an ineligible answer and selection or context refusals are `Rejected` | as a send |
| `POST /chat-runs/{id}/cancel` | none | `ChatRunResponse` | idempotent stop intent; finalizes a run whose job is dead |
| `GET /chat-runs/{id}` | none | `ChatRunResponse{conversation, user_message, assistant_message}` | read |
| `POST /conversations` | `{id: uuid, initial_context_refs: [uri]}` | 201 `ConversationOut` | client id: a resend answers the viewer's chat as it stands, relinking nothing; another owner's id is 409. one "Chat about this…" gesture is one id: an uncertain create offers "retry creation" with that id, its refs and its intent; another gesture is another chat |
| `GET /conversations` | `media_id`, `sort`, `direction`, `title_search`, `limit`, `cursor` | keyset page of `{id, title, message_count, updated_at}` | read |
| `GET /conversations/{id}/tree` | none | `{conversation, messages, active_leaf_message_id}` | read |
| `PATCH /messages/{id}/fork-title` | `{title, expected_title}` | `ForkTitleOut{fork_title, updated_at}` | absolute title plus the title it replaces: already so named succeeds; named otherwise is 409 with `details.current_title` |
| `DELETE /messages/{id}?conversation_id&expected_revision` | none | `{conversation_id, conversation_deleted}` | idempotent: an absent target is a no-op; a stale revision is 409 |
| `DELETE /conversations/{id}?expected_revision` | none | 204 | idempotent, as above |
| `GET /chat-reader-selections/highlights/{id}?media_id` | none | `ReaderSelectionPreview{key, item, revision}` | read |
| `GET /stream/chat-runs/{id}/events?after=N` | none | sse `assistant_text_delta{text}`, `tool_call_start`, `tool_result`, `context_ref_added{id, resource_ref}`, `done{status}`; unsequenced `ExecutionAdvisory{phase, cancel_requested}` | resume from the last seen sequence |

a send's `destination` is `{kind:"New"}` (the chat, its pair and its run commit together;
a refused first send leaves nothing) or `{kind:"Existing", conversation_id,
expected_revision, insertion: {kind:"Empty"} | {kind:"Reply", parent_message_id,
branch_anchor}}`. `reader_selection` is `{key:{media_id, highlight_id}, revision} | null`:
the key and a compare-on-send revision, never text. requests forbid extra keys.

an optional `media_id` scopes the owned index to current direct context whose endpoint
or one-hop owner is that readable media; historical citations and transitive links do
not qualify. unreadable media is `404 E_MEDIA_NOT_FOUND`. cursors bind viewer,
normalized media filter, trimmed literal title search and sort plan. newest order is
`updated_at desc, id desc`; viewing or attaching context does not advance that clock.

a message is `{id, seq, role, content, status, parent_message_id, branch_anchor,
fork_title, reader_selection, citations, trust_trail, can_rerun, created_at,
updated_at}`. `branch_anchor` is the closed union `none | assistant_message{message_id} |
assistant_selection{message_id, exact, prefix, suffix, offset_status:"unmapped",
client_selection_id}`. `trust_trail` is null exactly for user turns; otherwise
`{run: TrustRunOut, context: [ResourceItemOut], tool_calls}`, where the run carries its
frozen `run_selection{selection, display_at_dispatch}`, `status`, `support_id`,
`publication_warning`, `failure: {code} | null` and the live `execution`.

### persisted

- `conversations`: owner, title (first send's text, else "Chat"), `next_seq`,
  `branch_revision`, `active_leaf_message_id`, timestamps.
- `messages`: per-chat `seq`, role, content, status, parent, branch anchor (kind plus
  object), fork title (user turns), reader-selection snapshot, timestamps. a fork rename
  moves `updated_at`.
- `chat_runs`: id = the client's key, the message pair, the frozen spec, the frozen prompt
  (kept for every run; `docs/issues/chat-run-intents-retained-forever.md`), the admitted
  context version, status, stop intent, terminal codes, support id, warning.
- `chat_run_events`: `(run_id, seq)` frames of the five types above. tool frames store
  identity only (`tool_call_id`, `tool_call_index`, plus `status`/`error_type` on results);
  their public projection is computed when read.
- `message_retrievals`: per (answer, call or attached, ordinal): result type, source id,
  media and span ids, context ref, `result_ref` (the model-visible `tool_citation` payload
  and search's web-snapshot source), `selected`, locator, captured evidence, candidate
  ordinal, cited edge.
- browser: `sessionStorage["nx_chat_draft.v7:<account>:<pane>:<scope>"] = {text,
  selection | null}` per tab (scope is the chat id or `new`), so a restored workspace
  finds each pane's draft. it is the per-viewer unsent draft the conventions allow; no
  request, run id or revision is ever stored. a pane's endpoint is its visit href.
  commands live in tab memory and die with it.

### module contracts other code uses

- `services/tools/run.py`: `events.lock_run`, `events.append` (caller holds the run lock),
  the start and result payloads, `citations.number_candidates`, `retrievals.insert_retrieval`
  and `lock_retrieval_media`, `RetrievalCitation`.
- `services/tools/reads.py`: `read_message_page`, `citation_from_search_result`,
  `web_citation` (the caller stores the snapshot first), `RetrievalCitation.result_ref_json`
  (search's selection budget measures it as built).
- `services/resource_items/actions.py`: `message_action_facts`.
- `api/routes/stream.py`: `reads.read_events`, `reads.advisory`, `reads.require_run`.
- `jobs/registry.py`: `worker.run_job`, `worker.on_dead_letter`.
- web: `getNewChatCommands`, `getConversationCommands`, `repeatMessage` and
  `confirmChatDeletion` (`lib/chat/commands.ts`; the menu's rerun and regenerate run
  through `repeatMessage` and land their answer through `openAsyncResult`),
  `openConversationAbout` (`lib/chat/conversationIndex.ts`), `useChatCommandFeedback`
  (`lib/chat/commandFeedback.tsx`), `conversationEndpoint`/`conversationViewHref`
  (`lib/chat/view.ts`), the quote-intent helpers (`lib/chat/readerIntent.ts`), the pane
  entries `ForkMessage | WalkMessageSources | DeleteMessage | ComposeReaderQuestion`.
- `convertReaderQuestion` (`lib/chat/readerQuestion.ts`) converts the complete
  `NoteBody` grammar to `Blank | Text{content} | Unsupported{reason: Images | Embeds}`.
  image and embed refusal is whole-body and precedes any reader chat write.

## Browser

- **one store per pane** (`conversationStore.ts`) holds the server's messages and stored
  leaf plus a live overlay per pending answer. only a tree read sets membership and the
  stored leaf; a run read updates present messages and never adds one.
- **the pane's endpoint** (`Conversation.tsx`): an explicit `?leaf` wins; a bare route
  keeps the visit's endpoint, else seeds it once from the stored leaf. alternatives and
  Forks rows are links to `conversationViewHref`: plain activation shows that branch in
  this pane, shift opens it in a new pane; nothing is written. an arrival or `?message`
  off the path moves a bare endpoint to the newest leaf under it; an explicit one must
  contain it. a deleted endpoint falls back to its nearest surviving ancestor ("this
  branch was deleted"); an invalid or missing one shows "this branch is no longer
  available" until the viewer chooses one.
- **one command owner per account and chat, and per pane for a new chat** (`commands.ts`,
  key `account:<id>` or `account:new:<pane>`) sends every write: send, repeat, delete
  message, delete chat. a command freezes its body, run uuid, observed revision and, for
  a send or repeat, its opening intent (a retry may upgrade it to a new pane, never back);
  a send names its pane. its state is `Idle | Busy | Unconfirmed | RefreshRequired`; the
  last feedback shown rides through a retry. `recoveryOf(state, owns)` tells a surface
  whether the pending command is its own (a composer owns only its pane's sends); the pane
  notice, the repeat dialog and the workspace condition of a menu deletion or repeat
  render it. an accepted existing-chat write reads the canonical tree, checks that it
  holds the accepted answer made by this run (another pane's send may move the stored
  leaf), and hands it to every mounted store before the gate reopens. a send's acceptance
  settles its source callback once, whichever surface retried it: ordinary chat spends
  its submitted text, while the reader keeps its annotation. the pane lands an accepted send, or
  a repeat once a read shows its answer (a retried read too), through `openAsyncResult`:
  while it still shows the path asked from, it selects the answer (a new chat's pane
  routes to the chat), shift opens it in a new pane, otherwise an offer ("message
  sent"/"response ready", "open response"); a menu's repeat lands the same way. the pane
  notice can discard an unconfirmed send, as a reload does: admission reopens and the
  draft keeps its text; the send may still land, fenced by the revision in an existing
  chat, as a second chat for a new one.
- **the composer** (`ChatComposer.tsx`) holds the draft, the model controls and the one
  button: Send, Sending, Stop response, Stop requested, Retry send, Retry refresh. an
  untouched draft follows the run of the answer it replies to, else the catalog seed; an
  explicit pick holds until the send that uses it. a new chat's unresolved first send
  holds its text and model; an existing chat's draft stays editable. the field takes text
  only once the app has hydrated. desktop Enter sends (a held key sends once), Shift+Enter
  is a newline, every Enter is a newline on a phone, and composition owns Enter;
  shift-click or Shift+Enter on the button opens the answer in a new pane. blankness
  checks ignore whitespace; admission retains the submitted text's exact characters.
- **reader continuation** (`useSelectionComposer.ts`) owns visit-local question and
  destination intent. a fresh passage defaults to the newest owned chat related to its
  canonical media; a later explicit choice wins over a pending lookup. a chosen chat's
  canonical tree supplies its stored leaf, revision, insertion and inherited model,
  independently of another pane's endpoint. sends use the same new-chat or conversation
  command owner as chat panes and freeze content, selection, quote revision, insertion
  and run uuid once. ambiguous admission offers the exact retry; an observed branch or
  quote change requires explicit refresh. acceptance invalidates the continuation
  snapshot and keeps the annotation draft. blank opens stage only the quote, with no
  model or replyability requirement. sends and explicit opens preserve the reader in a
  fresh pane; departure leaves an offer to open the response.
- **reader content** (`readerQuestion.ts`) retains literal prose and hard breaks,
  code contents with collision-free delimiters, emphasis, strike and link destinations.
  underline retains its text; contiguous code-marked text and breaks form a code run.
  multiline runs become fenced blocks. enclosing inline decoration is omitted on that
  block; each distinct link becomes an adjacent destination link with its original
  target and title. single-line code retains its inline mark scopes. fenced source
  retains the authored payload, with the line ending required by the closing fence;
  newline-only code is substantive, though the existing renderer displays a lone blank
  code line as empty. the
  markdown serializer owns escaping. formatting moves only edge whitespace outside
  its delimiters. internal hard breaks render as markdown; terminal paragraph line
  endings remain literal newlines in the source because commonmark cannot render a
  terminal hard break. conversion ignores `body_text`, never truncates
  and never saves or spends the annotation. user bubbles and recovery show markdown
  source through the existing literal chat views.
- **reader recovery** uses `ComposeReaderQuestion{text, selection}` on a fresh `Fork`
  pane. its href names the chat/observed leaf and quote, never the question. after
  hydration the composer claims that visit's entry and synchronously seeds text and
  the exact observed model (or null) in one draft write before enabling input. model
  availability does not gate staging. a failed catalog read blocks sending even with
  retained data; recovery keeps the exact last observed model. the quote preview and ordinary model picker
  retain their owners. failed history reads keep the staged editor visible with
  `retry chat`; sending remains blocked. other panes' drafts survive. this is fresh
  composition for review, never a retry of uncertain admission.
- **the tail** (`runTail.ts`) folds a pending answer's frames into its overlay; a stream
  end (done or lost) is followed by exactly one run read. reload replays from event 0.
- **the scroll owner** (`useChatScroll.ts`) pins a new question to the top, follows the
  newest text once it overflows, releases on a real gesture and shows Latest only while
  newer text is below and nothing follows it.
- **the views**: `ChatSurface` provides the pane context to rows, footers and dialogs;
  `AssistantMessage` owns its details disclosure and failure or reconnect card;
  `MessageDetails` shows `route · model · reasoning key`, the admitted context and the
  actions; `AssistantTrust` lists writes with Undo (a refused undo says why until the next
  undo and disables nothing);
  `Forks` holds the alternatives (or continuations) control and dialog and the Forks
  outline; `Docent` walks an answer's sources (n/→, p/←, Escape; never with modifiers,
  composition or in an editable target; its controls are links, shift opens a step in a
  new pane); `ConversationDestinationOverlay` changes only the reader's destination.
  its source/all views share literal title search and keyset paging; stale rows cannot
  be selected. plain Enter or click selects a chat, Escape keeps the prior choice, and
  both return the exact editor caret. composition, extra modifiers and repeated Enter
  never select. the reader editor owns save, newline, platform modifier+Enter for new
  chat, and platform modifier+Shift+Enter for the displayed destination or picker;
  reference linking owns its keys first.

## Invariants

1. every read and write is owner-scoped; a foreign id reads as not found.
2. a run id is the client's uuid key; under `pg_advisory_xact_lock(chat_admission:{id})`
   the viewer's run with that id answers any resend, another user's is a conflict.
3. one admission is one transaction, or a rejection receipt with nothing stored.
4. the stored leaf is null exactly when the chat is empty, else a childless message of
   it. admission and surviving deletion move it and bump `branch_revision` once; nothing
   else does (browsing never writes).
5. existing-chat writes lock the conversation and compare the revision before reading
   their targets; absent deletion targets are no-ops.
6. a reply's parent is a complete answer of this chat and its anchor names it; a selection
   anchor is always `unmapped`.
7. one nonterminal run has exactly one `chat_run:{id}` job. nothing replays: an attempt
   that finds its generation started, or a dead job, ends the run `interrupted`
   (`cancelled` when a stop was asked).
8. `events.finalize` is the only terminal writer, writes `done{status}` once and settles
   open tool calls.
9. lock order is conversation, run, job claim (publication, deletion); run, job
   everywhere else. deletion also locks generation owners, generation rows and retained
   x-post media in that order.
10. candidate ordinals are dense from 1 per answer, attached context first, never
    renumbered; publication canonicalizes used markers by first appearance; unknown or
    linked markers degrade to marker-free prose with a support id.
11. a succeeded generation always publishes, even when a stop landed after it finished;
    a stopped or failed answer stores its text without candidate markers.
12. citation edges, back-pointers, context additions and `done` commit together;
    automatic context additions only while the admitted context version is current.
13. a quote is written once from the locked highlight; every later read derives from the
    snapshot; its revision is the sha256 of the canonical json.
14. the frozen prompt: the fixed system prompt; then the quote, selection and resources
    context, contiguous newest-first history within the token and 512 KiB budgets, and the
    turn; mandatory context never drops (`E_GENERATION_CONTEXT_TOO_LARGE`).
15. text frames: at most 512 chars, 2048 bytes or 33 ms each, in order, each its own
    commit; text before a tool call lands before its frames.
16. a tool call writes one start frame and one result frame, identity only; projection
    happens at read.
17. a stored `result_ref` is the built ref with null, empty-list and unselected facts
    omitted; search's selection budget measures the built ref.
18. the browser's saved state comes only from server reads; an older revision never
    replaces a newer tree; a rename returns its saved `updated_at`, so an older read of
    that message loses. a pane's endpoint lives only in its visit href; another pane's
    write never moves it.
19. the overlay only paints; a stream end is followed by exactly one run read.
20. one command per account and chat (a new chat's per pane); only `Idle` admits; the canonical
    tree reaches every mounted store before an existing chat's gate reopens; a later
    refusal settles an earlier unconfirmed attempt only with accepted-run evidence or a
    revision or absence fence (a new chat has neither, so it stays unconfirmed until the
    viewer discards it or reloads).
21. a selection is never substituted: a provider change needs a model; within a provider
    keep the effort name, else the mode default, else the sole effort, else require one.
22. saved terminal calls win over replayed frames; only saved authorship authorizes undo.
23. browser storage holds `nx_chat_draft.v7:<account>:<pane>:<scope> = {text, selection}`
    per tab and nothing else.
24. every chat create names its id; every fork rename names the title it replaces.
