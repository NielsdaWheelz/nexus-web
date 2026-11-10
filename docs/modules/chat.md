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
| `quotes` | immutable reader captures, saved-highlight preview/revision, message-owned quote projection and invalidation |
| `deletion` | the account creation fence shared by admission, explicit create and hard deletion |
| `citations` | candidate numbering, attached evidence, publication, unpublished text |
| `retrievals` | `RetrievalCitation`, `citation_from_search_result`, `citation_from_evidence`, `web_citation`, the one `message_retrievals` writer |
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
- **draft**: immutable text, exact selection intent and optional frozen quotation, per tab and pane; caret is separate presentation state.
- **acceptance**: a pane-owned immutable receipt and canonical-read obligation; independent from mutation reservation and later delivery failures.
- **selection**: an exact catalog `route/model/reasoning`; never substituted.
- **account selection**: the last accepted generation choice, ordered by committed
  admission. it seeds untouched ordinary composers across chats and devices.
- **quote**: immutable captured evidence on a user turn; an existing `highlight_ref` or `null` for a raw passage.
- **context**: the chat's scope refs (future prompt membership), frozen per run as
  `tool_scope`.
- **citation**: a model-visible candidate ordinal, then a published edge with a dense
  final ordinal.
- **action**: a tool call's projection; undo authority only from saved authorship.

## Contracts

### index metadata

the index and destination picker share `presentConversationListItem` and
`ConversationMetadata`: a compact updated-age token, semantic time with an exact
timestamp including seconds/timezone in its expanded caption and native title,
and the message count once. exact timestamps stay passive; touch has no new
disclosure. only the age token has a three-character budget.

age floors completed minutes/hours/days/weeks/365-day years. below one minute
in either direction it says `now`; more than nine years says `>9y`; a timestamp
at least one minute ahead shows an em dash and explains clock uncertainty.
malformed wire instants are defects. duration rounding and prose relative-time
formatting have separate contracts.

`useChatAgeClock` owns one minute interval per visible list/picker, never per row.
the initial render instant preserves hydration; layout effects refresh after
mount, stable source-array replacement and pane visibility changes. hidden panes
and documents stop the interval; document return refreshes immediately. visible
unfocused panes keep aging. callbacks/effects alone read the clock; ticks only
re-present existing data and never refetch, publish, reorder or move focus.

### http (authenticated, `Data{data}`, every request carries `X-Nexus-Wire`)

| route | request | answer | retry rule |
|---|---|---|---|
| `GET /me/chat-selection` | none | `ChatSelectionOut{last_used: {route, selection, revision} \| null}`; private, no-store | read; failure is never absence |
| `POST /chat-runs` | `Idempotency-Key: <uuid>`; `{destination, content, selection, reader_selection}` | `ChatAdmissionReceipt{outcome: Accepted{conversation_id, run_id, assistant_message_id} \| Rejected{reason:{code}}}` | the key is the run id: the viewer's run with that id answers any resend; another user's is 409 `E_RESOURCE_CONFLICT`; a rejection is not stored, so a resend decides again |
| `POST /messages/{answer}/rerun`, `/regenerate` | `Idempotency-Key`; `{selection, expected_revision}` | the same receipt; a missing source, a changed chat, an ineligible answer and selection or context refusals are `Rejected` | as a send |
| `POST /chat-runs/{id}/cancel` | none | `ChatRunResponse` | idempotent stop intent; finalizes a run whose job is dead |
| `GET /chat-runs/{id}` | none | `ChatRunResponse{conversation, user_message, assistant_message}` | read |
| `POST /conversations` | `{id: uuid, initial_context_refs: [uri], expected_deletion_revision}` | 201 `ConversationOut` | client id: a resend answers the viewer's chat as it stands, relinking nothing; another owner's id is 409. one "Chat about this…" gesture is one id: an uncertain create offers "retry creation" with that id, its refs and its intent; another gesture is another chat |
| `GET /conversations` | `media_id`, `sort`, `direction`, `title_search`, `limit`, `cursor` | keyset page of `{id, title, message_count, updated_at}` | read |
| `GET /conversations/latest?media_id` | none | last owned admitted quotation of this reading, or null | read; ordered by admission, not chat activity |
| `GET /conversations/{id}/tree` | none | `{conversation, messages, active_leaf_message_id}` | read |
| `PATCH /messages/{id}/fork-title` | `{title, expected_title}` | `ForkTitleOut{fork_title, updated_at}` | absolute title plus the title it replaces: already so named succeeds; named otherwise is 409 with `details.current_title` |
| `DELETE /messages/{id}?conversation_id&expected_revision` | none | `{conversation_id, conversation_deleted}` | idempotent: an absent target is a no-op; a stale revision is 409 |
| `DELETE /conversations/{id}?expected_revision` | none | 204 | idempotent, as above |
| `POST /chat-reader-selections/preview` | `{key, expected_capture_revision}` | `ReaderSelectionPreview{key, expected_capture_revision, item, revision}` | private no-store read; no writes |
| `GET /stream/chat-runs/{id}/events?after=N` | none | sse `assistant_text_delta{text}`, `tool_call_start`, `tool_result`, `context_ref_added{id, resource_ref}`, `done{status}`; unsequenced `ExecutionAdvisory{phase, cancel_requested}` | resume from the last seen sequence |

observation demand is distinct from mounted command/draft ownership. only a
presented foreground conversation tails runs. hiding silently stops tails and
retains accepted text/cursors; return first reads each pending run, then settles
terminal output or resumes the same run/cursor. generation fences cover replies,
tail callbacks and bookkeeping. suspension never resends a command or creates
`Lost`. chat retains its 280-second stream renewal and 15-second repair behavior.
passive history reads and retries inherit observation demand; deferred or
interrupted reads resume on return. accepted command landing retains its own
read lifetime, independent of presentation.

a send's `destination` is `{kind:"New", expected_deletion_revision}` or
`{kind:"Existing", conversation_id, expected_revision, insertion:
{kind:"Empty"} | {kind:"Reply", parent_message_id, branch_anchor}}`. creation,
message pair, run, frozen prompt, job and remembered selection commit together.
`reader_selection` is null, `{kind:"highlight", key, expected_capture_revision, revision}`, or
`{kind:"passage", reading_ref, source_ref, capture:SelectionCapture}`. the latter
carries no authored passage binding. raw capture and saved-highlight preview share
canonical evidence validation. neither creates a highlight; a chosen saved highlight
adds its owned annotation through ordinary live context. raw asks create no authored links.
requests forbid extra keys. `GET/PATCH /me` expose the read-only positive decimal
`chat_deletion_revision` used by fresh creation preparation.

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
- `chat_selections`: one account row with validated `{route, selection}` and a
  positive bigint revision, exposed as a decimal string. admission locks and
  replaces it in the run/message/job transaction. first-insert races retry that
  transaction. rejection and existing-run replay do not write it; completion and
  chat deletion leave it intact. malformed memory fails without repair.
- `chat_deletion_revisions`: one positive bigint per account. new identities hold its
  shared lock and compare their frozen revision; actual chat/subtree deletion takes
  it exclusively before chat locks and advances it. absent deletes do not advance.
  an accepted resource answers before this fence; stale absent-resource creation is
  `E_CHAT_CREATION_STALE`. no replay ledger.
- `message_retrievals`: per (answer, call or attached, ordinal): result type, source id,
  media and span ids, context ref, `result_ref` (the model-visible `tool_citation` payload
  and search's web-snapshot source), `selected`, locator, captured evidence, candidate
  ordinal, cited edge.
- browser memory: unsent text and explicit model selection belong to their
  account/pane/chat owner (`new` for an unpublished chat). mobile remounts retain
  that owner, its quote and acceptance/read recovery; pane retirement and account teardown remove it. commands remain
  account/chat-owned, or pane-owned for a new chat. reload restores neither
  drafts nor commands. a pane's endpoint remains its visit href.

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
  entries `ForkMessage | DeleteMessage`. `launchChatDraft` and `launchReaderChat`
  synchronously adopt into a fresh pane; staging never relies on a mount effect.
- `convertReaderQuestion` (`@nexus/authored/markdown`) converts the complete
  `NoteBody` grammar to `Blank | Text{content} | Unsupported{reason: Images | Embeds}`.
  image and embed refusal is whole-body and precedes any reader chat write.

## Browser

- **one store per pane** (`conversationStore.ts`) holds the server's messages and stored
  leaf plus a live overlay per pending answer. only a tree read sets membership and the
  stored leaf; a run read updates present messages and never adds one.
- **the pane's endpoint** (`Conversation.tsx`): an explicit `?leaf` wins; a bare route
  keeps the visit's endpoint, else seeds it once from the stored leaf. alternatives and
  Forks rows are canonical destinations with `?leaf` and `?message` arrival selectors:
  plain activation follows a matching pane, shift opens a fresh pane; nothing is written. an arrival or `?message`
  off the path moves a bare endpoint to the newest leaf under it; an explicit one must
  contain it. exact find uses `/conversations/{id}?leaf=…&loc=…`: the closed
  `find_match` payload carries message id, codepoint bounds and sha-256 of complete
  rendered searched text, excluding find chrome. search freezes branch/text and
  hashes once per matched message. arrival verifies the terminal message on that
  exact branch and the rebuilt cursor/digest before positioning/paint; it never
  resolves via the backend, guesses a quote or substitutes a branch. native open
  and reload decode identically. local find/navigation retires arrival paint.
  without an exact `loc`, a deleted endpoint falls back to its nearest surviving ancestor ("this
  branch was deleted"); an invalid or missing one shows "this branch is no longer
  available" until the viewer chooses one.
- **command ownership** (`commands.ts`): one mutation reservation per account/chat,
  or per actual destination pane for a new chat. preparation freezes the authored
  prefix, exact catalog choice, quote and destination preconditions once. existing
  sends/repeats and saved highlights wait for their captured authored prefix; a new
  raw ask does not wait on unrelated writing. an attempt-local preparation deadline
  cannot poison the sealed command's signal. only active promises are busy.
- **transport recovery** (`lib/api/retry.ts`): one shared finite loop. replay-safe
  admission and context creation use at most three attempts within 30 seconds,
  including backoff and response bodies. only network/upstream/timeout failures
  retry automatically. every exit carries accumulated delivery uncertainty; a later
  unsent or auth refusal cannot erase an earlier ambiguous dispatch. exhaustion and
  internal errors remain instrumented defects. explicit retry preserves path, uuid,
  body and preconditions; a branch/deletion fence ends execution without claiming
  historical nonacceptance.
- **acceptance and reads** (`drafts.ts`, `conversationStore.ts`): record acceptance
  before callbacks, spend only the identical submitted draft, promote any successor
  text/quote/model to the canonical chat scope before route publication, then release
  the mutation reservation. the receipt stays with that pane, never another pane's
  pending command. only a canonical read begun after acceptance can account for it.
  read failure preserves certainty and offers `retry loading`; proven deletion ends
  read recovery without resend. late completion cannot move a newer visit. hiding
  or mobile unmount does not retire writing, attempts or accepted read obligations.
- **failure containment**: retained facts settle before the operation boundary
  reports a defect. that boundary sits beside the editable composer and valid
  transcript; reset never sends. ordinary transcript corruption still reaches the
  pane boundary. one failure has one home and occurrence. work-guard risk derives
  from writing and actual uncertainty, not reservation presence or accepted reads.
  a deleted chat retains successor writing and fenced uncertainty for copying or
  explicit review in a fresh unsent pane; it never silently rebases a command.
- **the composer** (`ChatComposer.tsx`) observes the retained draft. typing and
  caret movement remain available while an older request is unresolved; only the
  exact immutable submitted object can be spent. an untouched selection follows
  fresh account memory; an explicit or captured choice is never substituted.
  desktop enter sends, shift-enter inserts a newline, every enter is a newline on
  mobile, and composition owns enter. ordinary shift-send adopts synchronously into
  its fresh destination. blankness ignores whitespace; submitted characters stay
  literal. an unresolved command's retry acts on its frozen question, not later text.
- **reader transfer** (`useSelectionComposer.ts`): settle native editor input and
  freeze the provisional range before reading its retained source version. serialize
  the complete rich question; unsupported images/embeds refuse without truncation.
  synchronously fork, install the destination draft and guard, and reserve before
  eligible gesture-started preparation. only successful adoption retires the exact
  source revision. blank, unavailable-model and blocked-existing requests stage
  complete input; model arrival, remount and command settlement never autosend.
  no reader-owned network attempt, implicit highlight, combined lock or copied pane
  entry remains. independently saved annotations keep their own owner.
- **reader destination**: the default is the last owned admission quoting the viewed
  media/part, or a captured x fragment actually included there. context membership
  and chat activity are not continuation history. an explicit choice wins over a
  pending lookup. the picker reads related chats independently; no accepted
  default does not mean no related chats. the chosen tree supplies revision and
  insertion from its stored leaf, independently of other panes. choosing a
  destination never sends.
- **reader content** (`@nexus/authored/markdown`) preserves prose, hard breaks,
  code and links through the shared whole-body serializer. draft quotations use
  their real frozen capture and known attribution, without inventing a resource or
  fetching before transfer. saved-highlight drafts keep the existing destination-
  owned preview preparation. raw text never enters a URL or browser storage.
- **the tail** (`runTail.ts`) folds a pending answer's frames into its overlay; a stream
  end (done or lost) is followed by exactly one run read. reload replays from event 0.
- **the scroll owner** (`useChatScroll.ts`) pins a new question to the top, follows the
  newest text once it overflows, releases on a real gesture and shows Latest only while
  newer text is below and nothing follows it. `ChatSurface` lets an oversized composer
  scroll as a sibling of the transcript: at most half the pane when messages exist,
  or the whole available height when empty. quotations remain unabridged and have no
  scrollport of their own. wheel input scrolls the composer before the transcript;
  browser zoom remains native.
- **the views**: `ChatSurface` provides the pane context to rows, footers and dialogs;
  `AssistantMessage` owns its details disclosure and failure or reconnect card;
  successful answers expose regeneration only in message overflow; eligible
  failed or cancelled answers retain inline rerun in their failure card.
  `MessageDetails` shows the saved `route · model · reasoning` presentation, the admitted context and the
  actions; `AssistantTrust` lists writes with Undo (a refused undo says why until the next
  undo and disables nothing);
  `Forks` holds the alternatives (or continuations) control and dialog and the Forks
  outline; `ConversationDestinationOverlay` changes only the reader's destination.
  its source/all views share literal title search over the owned index; stale rows
  cannot be selected. plain Enter or click selects a chat; Escape keeps the prior
  choice. desktop restores the editor caret; mobile returns focus to the disclosure
  without opening the keyboard. composition, extra modifiers and repeated Enter
  never select. the reader editor owns save, newline, platform modifier+Enter for new
  chat, and platform modifier+Shift+Enter for the displayed destination or picker;
  reference linking owns its keys first.

### future context rows

`ChatContext` keeps server admission, order and aggregate detach versions. its
`useContextItem` overlays viewer-owned note/page/highlight content from the local
authored store; local absence suppresses stale server text but keeps the removable
row. loading and failed reads remain explicit. failed refresh may retain prior
local data with retry feedback. source attribution and authorized highlight-id
navigation remain supplied; local selection clears a stale location label.
absence is established only by an available authored scope with no item. an
unavailable scope retains type presentation and any held available projection.
cold context and destination regions use the shared ruling; shown content stays
quiet during refresh.

owned highlight previews read the single local annotation body and label it
separately from the source quotation. peer quotations never load that private
field. saved annotation content and unsubmitted question input have independent
owners; sending a question cannot consume or overwrite the annotation.

context previews describe current content eligible for future replies, not prior
prompt bytes. the existing finite upload barrier remains responsible for send.

## citation syntax

draft and sent reader quotes and citation previews share `ResourceQuotation`.
it presents supplied evidence without graph disclosure, management actions or
live authored-resource substitution. quotation text is selectable; title, authors
and location form its attribution. `QuotedPassage` owns attachment feedback and
remove/retry; `ReaderCitation` owns the ordinal and preview interaction. explicit
keyboard entry focuses the preview's first control or its readable dialog panel;
escape restores the trigger. source availability remains a server decision, so
captured evidence is not a promise of perpetual visibility after source deletion.

inline citations are the source-inspection control; chat owns no sequential
source tour. `ReaderCitation` keeps hover/focus preview, explicit keyboard
inspection, ordinary follow and shifted opening. `HoverPreview` owns touch-sheet
focus and dismissal; touch release is not hover leave, and escape cancels any
preview scheduled by restoring trigger focus. the renderer and publisher share
the locked remark/gfm grammar and
`lib/chat/markdownCitations.ts` literal-source projection. only complete positive
ascii `[N]` markers in prose become references; code, escaped/entity brackets,
links, images, reference definitions and html tokens stay literal. footnote
bodies are prose. native gfm autolinking retains its own classifications.

the worker's fixed `markdown_citations.mjs` executable receives raw utf-8 markdown
and returns canonical digit strings with original unicode-codepoint spans.
`markdown_citations.py` owns that closed stdio boundary; executable/schema failure
is a defect. it adds no server or persistent process. generated bundle freshness
is checked with wire freshness in the static gate.

publication validates candidate strings, splices only eligible spans, and
reparses before writing edges. final occurrences must equal expected remapped
spans; unknown candidates or renumbering collisions use the existing unavailable-
citations warning. partial/degraded cleanup strips only genuine markers.
all other stored characters survive exactly. historical rows are never rewritten
by a read; all answers use the current renderer. authorization, frozen evidence
and source arrival remain resource-owned.

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
9. admission locks its run-id advisory, creation fence when needed, chat, saved-
   highlight authored head and media family. deletion locks its exclusive fence
   before chat, generation owner/calls, runs, jobs and retained media. existing
   generation/event owners keep their run/job order.
10. candidate ordinals are dense from 1 per answer, attached context first, never
    renumbered; publication canonicalizes used markers by first appearance;
    unknown candidates or renumbering collisions degrade to marker-free prose with a support id.
11. a succeeded generation always publishes, even when a stop landed after it finished;
    a stopped or failed answer stores its text without candidate markers.
12. citation edges, back-pointers, context additions and `done` commit together;
    automatic context additions only while the admitted context version is current.
13. a quote freezes canonical evidence once. raw input proves current publication,
    selected words and reading scope; saved input compares its preview revision.
    historical words and credits never reread mutable content. the canonical snapshot is `{evidence, highlight_ref}`; raw
    `highlight_ref` is null. saved input freezes the displayed capture revision
    before upload; preview and admission must still match it. current disclosure
    gates current and historical prompt quotes. annotations stay live in ordinary
    context and never enter the frozen quote. source opening proves current selected
    coordinates in one read-only repeatable-read snapshot. transcript capture identity
    is provenance, while opening returns the current viewed document identity.
14. prompt preparation pages context metadata, measures stored bytes before bodies,
    then checks rendered bytes and estimated tokens. history is complete, contiguous
    and newest-first within both budgets. mandatory context never drops. automatic
    quote source facts remain identity/tool-scope only, including x follow-ups; direct
    citation construction consumes admitted evidence without discovery search.
    chosen saved highlights keep the owner's live annotation after a bounded
    read. selecting that same saved highlight quotes it once; the annotation stays
    separate and never enters captured reader evidence.
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
20. one mutation reservation per account/chat (new: pane). acceptance releases it;
    pane-owned canonical read recovery does not hold it. a missing run alone proves
    nothing about delivery. only accepted evidence or a monotonic destination/deletion
    fence ends exact replay; historical uncertainty remains truthful.
21. deliberate provider/model changes choose the catalog's model/mode/effort defaults
    together. a missing default preserves draft intent and permits explicit effort
    choice. only that unresolved intent can complete on a later catalog read; an exact
    selection is never substituted. captured choices and pending requests retain their identity.
22. saved terminal calls win over replayed frames; only saved authorship authorizes undo.
23. drafts and live command identity remain in memory. the common work guard
    warns before their actual loss; model selection alone is clean. accepted
    server runs continue after local discard, navigation or reload.
24. every chat create names its id; every fork rename names the title it replaces.
25. one account reader owns selection recall through the existing server-value
    primitive. acceptance, foreground/reconnection and composer entry invalidate
    it; automatic capture requires fresh successful data. acceptance never installs
    the command's selection optimistically. local commands carry captured provider
    identity outside the serialized request; old repeats start from their saved run.

reader maps project one native quote root per owned user turn, with a `quotes` count,
`chat quotes` facet and neutral marker. no authored edge is fabricated. the quote
connection opens its chat; source activation opens the authorized reading/capture.
existing annotation revisions and `Chats` invalidation refresh mounted maps. raw
asks retain source tool access without eagerly inserting the complete work into each
prompt. drafts/attempts survive tab-local remounts, not browser closure or reload.

quote review carries the original pane, visit, draft owner and attachment identity
through an adjacent source pane. replacement also proves the current route belongs
to that conversation before synchronously changing the quote. question, caret and
model survive; sending is a separate gesture. cancellation only leaves review mode
and preserves source writing. replacement retires only the unchanged source draft
after its guarded transfer succeeds. removing/replacing a quote or retiring its
draft revokes an undispatched preparation; hiding a pane does not. dispatched
requests retain their original bytes and run id.
