# librarian

## purpose

one account-owned transcript, with immutable user/assistant pairs, source
references carrying saved quotes and explicit operational receipts. `/librarian`
is its sole destination.
opening an earlier message changes the visible window, never the append destination.

## owners

| module | contract |
| --- | --- |
| `schemas/chat.py`, `api/routes/chat.py` | typed turn, timeline and command boundaries |
| `chat/admit.py`, `chat/deletion.py` | client run uuid, exact generation choice, account sequence and deletion fence |
| `chat/timeline.py` | bounded pair windows, terminal-turn deletion, individual message read and run horizon |
| `chat/context.py`, `chat/references.py` | execution-time brief, mandatory saved attachments and bounded settled history |
| `services/live_references.py` | current structural coordinates, quote availability, private annotation authority |
| `chat/retrievals.py`, `chat/citations.py` | bounded saved evidence, resource targets, message-owned citation ordinals |
| `chat/events.py`, `chat/worker.py` | fifo head admission, durable frames, sole terminal fold and generation |
| `chat/reads.py`, `chat/selection.py` | current projections, action receipts and last admitted generation selection |

## durable state

`librarian_state` is the permanent account admission/deletion row. its `next_seq`
allocates consecutive message positions; `deletion_revision` prevents an uncertain
send from recreating a deleted turn. it is not a selectable conversation.

`messages` owns literal authored text and ordered saved references. a reference
contains source identity, a nullable place and a nullable frozen quote. unsaved
selections are proven against the reading before admission; whole resources and
messages carry no quote. an existing highlight remains a live highlight reference.
`chat_runs` owns the pair, frozen generation choice, queue status, cancellation
and optional weak
`retry_of_run_id`. context is assembled when execution starts. no frozen
run prompt belongs to chat. quotes belong to their turn, never the authored store.

only the earliest unsettled run has a `chat_run` job. the terminal writer and fresh
admission both recompute that head under the account mutex. cancelling a waiting
turn cannot release its successor past an earlier active turn. lock order is
generation when required, account state, run, job. no transaction spans generation.

`message_retrievals` owns saved resource references or urls and citation ordinals.
selected evidence freezes when retrieved; terminal settlement removes every
uncited quote. citation quotes are bounded to 2,000 codepoints and 64 kib of
structured excerpt, with larger evidence reduced to truncated plain words. local
citation edges project references without copying quotes. user attachments write
the same edges after current visibility is checked. web citations retain only
their url. deleting the turn removes its messages, retrievals and citation edges. source-owned documents, highlights and native citations keep their
own existing data contracts.

## command and read contracts

- `POST /chat-runs`: uuid `Idempotency-Key`, content, exact selection, at most sixteen
  attachments and observed deletion revision. an owned existing run acknowledges
  any resend before catalog resolution; an absent stale-fence send is rejected.
  acceptance carries the current turn, read through the ordinary turn projection
  in a fresh repeatable-read session after admission commits. a failed projection
  is a defect, never a refusal of an already committed question.
- `GET /librarian/messages`: latest window or one exclusive before/after cursor or
  message anchor, default twenty-five turns and maximum fifty. chronological whole
  pairs; absent anchor is 404. sequence values are decimal strings.
- `POST /librarian/attachments/resolve`: 1–16 reference or selection attachments, proven and presented
  in order in one authenticated repeatable-read snapshot; private/no-store.
  this read writes and adopts nothing.
- `GET /chat-runs/{id}` and existing event stream: current pair, execution, actions
  and resumable durable frames. waiting rows truthfully project `Queued` without a job.
- `POST /chat-runs/{id}/cancel`: durable stop intent. only known settled execution
  permits terminal recovery; a timeout is not proof that a provider stopped.
- `POST /chat-runs/{id}/retry`: a fresh uuid appends a new attempt of a failed or
  cancelled turn, with its original user text and saved refs. successful answers
  cannot be regenerated. completed actions are not rolled back.
- `DELETE /chat-runs/{id}`: terminal pair only; absent is success, active is conflict.
  later retries and independent action/undo receipts survive.

one timeline/turn response loads shared facts once inside its existing database
snapshot. runs, messages, tools and retrievals feed both message projection and
trust trails. resource hydration deduplicates full references and reconstructs
input order and multiplicity. attachment availability distinguishes source,
field and locator; response-local reuse never crosses viewers or snapshots.
attachments reuse hydrated item authority and add the annotation owner's private
field check. source navigation composes those same proofs. only attachments and
published citations carry saved quotes, owned annotations and source bibliography.
uncited retrievals and streams expose coordinate-only targets. presentation never
derives words or starts the authored helper. text availability compares the saved
exact against the current substring inside sql; no source text is materialised.
source and annotation enrichment remain current. whole-fragment context requires
the evidence owner's complete-passage admission; fragment identity visibility
alone never authorizes its body.
stream pages keep their own snapshot: text pages hydrate nothing, start frames
exclude later results, and result frames hydrate only that page's retrievals.

foreground tools may read authorized account resources. every message access is
bounded by the run's horizon: its current question and earlier settled pairs only.
later queued questions cannot enter an earlier run through attachments or tools.
failed/cancelled answers are explicitly incomplete and retain completed-action
receipts. mandatory request/brief/attachments that cannot fit settle
`context_too_large`; they are never silently truncated.

saved words survive source edits, republication, deletion and access loss. a text
place that no longer begins with them says `source changed since quoted`. opening
checks current access, then resolves a unique exact-word match in the readable
source when its original place fails. ambiguity or absence preserves whole-source
navigation and reports location unavailable; it writes nothing. pdf and time
places retain their existing checks. captured pdf words come from the reader.

current attached quotes enter model context as saved exact words while the source
is readable, even when their place moved. earlier turns serialize references
without quotes and budget that actual serialization. oversized mandatory context
settles `context_too_large`; source access loss never grants model access to saved
words. new whole-reference inputs require current resource and private-field authority;
selection inputs additionally prove their captured words. both checks run before
the account lock and serializable admission. saved quotes retain their original
words across retries and availability changes.

source text in tool input is transient. persisted tool receipts retain identity,
status/error, refs, created-effect refs and undo state. intentional authored outputs
belong to their canonical resources. optional jarvis saves use the account uuid as
the sole timeline association and the tool-call uuid as exact submission identity.

## presentation

one transcript keeps its generation control and send; queued turns are visible
and individually cancellable. a selection without a question opens an
attached empty composer. corrections are follow-ups. the settings-owned reading
brief is manual; chat has no brief-writing tool or automatic orientation document.

each turn is one unpositioned article containing the labelled question and answer
groups. the question is its literal `h2`; more than 280 utf-16 units or a blank
line uses a body-size paragraph with an `sr-only` heading. attachments follow the
question. the first loaded turn of each device-zone day starts with an absolute
date rule, inside the user group and before any retry line. reading-text hooks
exclude dates, retry lines, apparatus and controls. message ancestry stays
unpositioned so the scroll owner measures message offsets in its scrollport.

the surface resolves the reader profile's measure once, capped at 72ch;
transcript, search and composer share that centred measure and side padding.
answers use the reader's face, size and leading in machine ink. answer markdown
headings start at `h3`. search excerpts retain stored words and match emphasis,
using the question's body hand or the answer's prose hand according to speaker.

`components/chat/MarkdownMessage` owns answer prose, citation adjacency and the
pending caret. settled markers share `ReaderCitation.module.css`'s sans accent
numeral; only immediately adjacent markers get a comma. pending brackets remain
literal until the terminal read. active fine-pointer panes preview the marker's
`ReferenceFigure` unless their figures are presented in an open companion column.
touch follows the source; reference controls open the companion. preview and menu
portal events never enter the transcript's dom-owned handlers.

visible write receipts precede one foot per turn. its disclosure names the
current phase or last running act, then the question's device-zone time and the
model and effort recorded at dispatch. only phase changes enter the live log;
the changing act is hidden from announcements. the foot keeps its block size at
settlement. its trail is one lazily constructed `MachineText` block, including
while pending. undo retains the receipt row and strikes its reverted target.

## product ownership

`components/chat/Librarian.tsx` owns mode, timeline reading and chrome.
`LibrarianTranscript` owns the displayed turn list, scroll and source arrival;
`LibrarianSearch` uses shared lexical message search and pane visit restoration.
first query pushes a search visit, edits replace it, and opening a result pushes
its exchange. back restores the query, result prefix, selection and scroll.
clearing returns to the originating timeline, or latest for direct search entry.
accepted sends push latest while normal history retains the prior search/exchange.
search and catalog readiness are independent. `ChatComposer`
owns editable input and one exact model/effort choice. `lib/chat/drafts.ts` retains pane input;
`commands.ts` retains one account admission's uuid, exact body, deletion fence
and uncertain outcome. acceptance publishes the chat change before adopting its
turn and clears only the submitted draft object in the same write. the pane
retains adopted turns until a ready, fresh latest window takes over. acceptance
navigates from search or an older window before paint. a held finished turn
outranks a pending copy; terminal reads upgrade the same keyed list. admission
is freed while the server continues generation. a retry adopts its turn without
consuming or clearing a refused composer draft. source
handoffs and the palette focus or submit through that same composer.
acceptance after leaving its visit still consumes the matched draft, but retains
no adopted turn or navigation obligation for that departed visit.

`IndexPaneEntry` starts the librarian's timeline and catalog reads while its lazy
code loads; a search visit starts only the catalog read. the body claims those
exact descriptors through `PaneEntryReads`;
subsequent cursor changes belong to the mounted hooks. active entry starts saved
selection recall once per activation. dispatch rechecks that recall's current
freshness for an uninitialized selection; explicit draft selections bypass it.
messages remain visible during refresh and expose retry if refresh fails.
the pane refresh adapter leaves modeled read failures with that read's feedback;
cancellation and defects retain the shared refresh owner's handling.

detail regions retain their identity but construct children only on first
opening. inspected children remain until the turn unmounts, preserving nested
state at the cost of that memory. visible mutation receipts remain outside the
disclosure; opening details requires no additional read.
the floating `latest` control contributes no height to the scroll range, so its
appearance cannot change an inspection anchor's available position.

`ChatTurn` paints a pending run's event overlay, then adopts its terminal read in
the transcript owner. text, reference figures and arrival validation consume the
same saved turns. account, visit and the actual timeline descriptor key bound
that owner; a pending refresh cannot replace an adopted terminal answer.
per-turn cancel leaves send available. retries append using the current composer
model and effort; outside the librarian, retry opens the turn for this explicit
choice. retry never consumes the composer draft. successful answers expose
no regeneration. deletion names its question/answer pair and says completed
actions remain. the answer owns the turn's one resource menu: immediate `copy
question`, then prepared open, open in new pane, ask librarian and delete turn.
the question has no separate resource menu. copy answer keeps its checked icon;
menu copy only announces `copied`. unavailable copying offers selection of the
exact question or answer reading text. mouse users reveal the quiet copy/menu group by hover,
focus or an open menu; coarse pointers and forced colours keep it visible.

the search toolbar covers retained nonempty terminal text across account history,
including incomplete answers. metadata identifies speaker, admission time and
incomplete state. word/phrase semantics, ranking and bounded pages belong to search;
there is no total count or semantic message lane. search text never becomes a send.

message arrivals may carry paired `start_offset`/`end_offset` codepoint coordinates
beside `message` in the librarian url. they resolve through live `TextOffsets`;
invalid ranges do not substitute a whole-message success. the same markdown parser
maps source spans to a containing rendered passage or code line. a hidden link
destination marks its paragraph; source-only definitions may mark the message.
this is passage emphasis, not a claim that source and rendered glyphs coincide.

`ReferenceFigure` projects a saved quote through the shared excerpt kernel in
compact capture scope without reading its source. pdf and time places appear
below their words. a missing source retains the quote and per-kind unavailable
status, with no navigation. whole resources and live highlights use their current
presentation. inline
markers and figures share source activation; annotation fields open their owning
highlight. unavailable citations retain their ordinal. exact selection words never
substitute a leading preview; invalid coordinates retain source navigation.
drafts use the same projection after their committed authored prefix uploads.
preview admission writes nothing. selection refusals retain the draft, explain
the reason and offer remove quote; transport failures also offer retry.

`LibrarianReferences` publishes the shell's `librarian-references` companion.
fresh visits start closed; publication never opens it. the first column view is
margin, subsequent views retain the explicit margin/all choice. covering hosts
show chronological message groups. user figures appear inline except beside an
open column. citations anchor to their first rendered marker, attachments to their
message content onset. occurrences use message+attachment index or
message+retrieval uuid; repeated markers share one figure. ordinary links create
none. `references · n` reveals the message group; `show message` returns to the
canonical anchor. search withdraws this publication.

`lib/margin` owns shared packing, measured baselines and held controls. chat owns
membership and the source adapter; packing never changes transcript height or
scroll. `useChatScroll` retains a rendered canonical text point and visual offset.
changed prefixes retain message placement; absent messages end restoration.
explicit inspection outranks top/bottom follow, then released reading continuity.
controls and hidden descriptions contribute no reading text. child content commits
and source geometry changes notify after scroll corrections.

chat prose is lowercase except canonical titles and literal messages. the empty
transcript invites reading and inquiry without inventing a user biography. the
canonical destination is `Librarian`. its pane overflow exposes `Edit reading brief…`
in every mounted mode, including pending reads. the command opens the existing
account-settings field through the [workspace entry contract](workspace.md);
the composer has no brief control. examples state pursuits and exclusions, never
model-written standing instructions.

## generation selection

`GenerationPicker` owns one model-and-effort trigger and one responsive panel.
model variants stand in catalog order under their provider labels. unavailable
saved identities remain explicit unavailable rows; nothing substitutes a runnable
choice. native-route retry stays outside the listbox. navigation changes only
the active row; selection commits the exact model and its declared default.
without a default the panel stays open for explicit effort choice.

the effort region uses the selectable ordered efforts: a range for a selected
member of a multi-effort range, buttons to repair an unresolved or unavailable
effort, or its reason when none is selectable. a sole advertised selected effort
needs no region or dial. effort commits retain panel focus. a model commit that
closes the panel focuses the line, or the trigger after a touch open. escape
returns to the trigger; an outside press keeps the focus it placed.
the existing pointer-gesture owner holds the trigger's measured minimum size
through activation, so focus-triggered recall cannot shrink its pressed target.
labels and dispatch freshness still update immediately.

## writing line

the composer is the transcript's open entry: rule, optional passage figure, bare
one-to-eight-line textarea, facts, then generation control and `send`. the surface
exports `--librarian-column` and `--librarian-gutter` for transcript, search and
composer; `--question-font`, `--question-tracking` and `--question-measure` give
the question and writing line one hand. all three scroll owners reserve scrollbar
space. the rule alone marks line focus, using
the room's ring; motion and forced-colour preferences remain visible.
phone layouts own a 44px control minimum through the shared size hook, including
native webviews that report a fine pointer alongside touch input.

enter sends in a wide viewport and breaks the line on phone widths; shift-enter
always breaks it and mod-enter sends at every width. composition and repeated
keys never send. unmodified up in an empty line recalls only the newest literal
question when the latest window is ready and search is closed. recall changes
only line text. send is disabled exactly while the existing admission/selection/text
predicate disallows it; a refusal leaves the draft and uses send as retry.
