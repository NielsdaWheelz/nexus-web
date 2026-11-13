# librarian

## purpose

one account-owned transcript, with immutable user/assistant pairs, live source
references and explicit operational receipts. `/librarian` is its sole destination.
opening an earlier message changes the visible window, never the append destination.

## owners

| module | contract |
| --- | --- |
| `schemas/chat.py`, `api/routes/chat.py` | typed turn, timeline and command boundaries |
| `chat/admit.py`, `chat/deletion.py` | client run uuid, exact generation choice, account sequence and deletion fence |
| `chat/timeline.py` | bounded pair windows, terminal-turn deletion, individual message read and run horizon |
| `chat/context.py`, `chat/references.py` | execution-time brief, mandatory live attachments and bounded settled history |
| `services/live_references.py` | current structural coordinates, bounded source text, private annotation authority |
| `chat/retrievals.py`, `chat/citations.py` | transient model evidence, persisted live targets, message-owned citation ordinals |
| `chat/events.py`, `chat/worker.py` | fifo head admission, durable frames, sole terminal fold and generation |
| `chat/reads.py`, `chat/selection.py` | current projections, action receipts and last admitted generation selection |

## durable state

`librarian_state` is the permanent account admission/deletion row. its `next_seq`
allocates consecutive message positions; `deletion_revision` prevents an uncertain
send from recreating a deleted turn. it is not a selectable conversation.

`messages` owns literal authored text and live attachments. `chat_runs` owns the
pair, frozen generation choice, queue status, cancellation and optional weak
`retry_of_run_id`. context is assembled when execution starts. no frozen prompt or
source snapshot belongs to chat.

only the earliest unsettled run has a `chat_run` job. the terminal writer and fresh
admission both recompute that head under the account mutex. cancelling a waiting
turn cannot release its successor past an earlier active turn. lock order is
generation when required, account state, run, job. no transaction spans generation.

`message_retrievals` owns resource references or urls and citation ordinals. local
citation edges project that state without copied evidence. web citations retain
only their url. source-owned documents, highlights and native citations keep their
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
- `POST /librarian/attachments/resolve`: 1–16 live references, ordered current
  presentations in one authenticated repeatable-read snapshot; private/no-store.
  this read writes and adopts nothing.
- `GET /chat-runs/{id}` and existing event stream: current pair, execution, actions
  and resumable durable frames. waiting rows truthfully project `Queued` without a job.
- `POST /chat-runs/{id}/cancel`: durable stop intent. only known settled execution
  permits terminal recovery; a timeout is not proof that a provider stopped.
- `POST /chat-runs/{id}/retry`: a fresh uuid appends a new attempt of a failed or
  cancelled turn, with its original user text and live refs. successful answers
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
published citations receive exact excerpts, owned annotations and source
bibliography. uncited retrievals and streams retain their slim shape.
full original intervals are admitted before a 601-codepoint display read; compact
projection publishes at most 600 with omission metadata. availability-only checks
validate bounds without constructing source text; prompt reads enforce byte limits.
whole-fragment attachments require the evidence owner's complete-passage
admission; fragment identity visibility alone never authorizes its body.
stream pages keep their own snapshot: text pages hydrate nothing, start frames
exclude later results, and result frames hydrate only that page's retrievals.

foreground tools may read authorized account resources. every message access is
bounded by the run's horizon: its current question and earlier settled pairs only.
later queued questions cannot enter an earlier run through attachments or tools.
failed/cancelled answers are explicitly incomplete and retain completed-action
receipts. mandatory request/brief/attachments that cannot fit settle
`context_too_large`; they are never silently truncated.

live offsets can refer to different words after editing. missing sources and invalid
ranges are unavailable; no quote matching repairs them. pdf geometry remains a
visual coordinate; any coarse page text supplied as context is labelled explicitly.
chat never claims exact selected words merely because it can read that page.

source text in tool input is transient. persisted tool receipts retain identity,
status/error, refs, created-effect refs and undo state. intentional authored outputs
belong to their canonical resources. optional jarvis saves use the account uuid as
the sole timeline association and the tool-call uuid as exact submission identity.

## presentation

one transcript keeps its generation control and send; queued turns are visible
and individually cancellable. a selection without a question opens an
attached empty composer. corrections are follow-ups. the settings-owned reading
brief is manual; chat has no brief-writing tool or automatic orientation document.

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
actions remain. ordinary message resource actions remain available.

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

`ReferenceFigure` renders supplied live presentations without reading. inline
markers and figures share source activation; annotation fields open their owning
highlight. unavailable citations retain their ordinal. exact selection words never
substitute a leading preview; invalid coordinates retain source navigation.
drafts use the same projection after their committed authored prefix uploads.

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
owns the shared column, gutter and question type/measure tokens. both transcript
and composer reserve scrollbar space. the rule alone marks line focus, using
the room's ring; motion and forced-colour preferences remain visible.
phone layouts own a 44px control minimum through the shared size hook, including
native webviews that report a fine pointer alongside touch input.

enter sends in a wide viewport and breaks the line on phone widths; shift-enter
always breaks it and mod-enter sends at every width. composition and repeated
keys never send. unmodified up in an empty line recalls only the newest literal
question when the latest window is ready and search is closed. recall changes
only line text. send is disabled exactly while the existing admission/selection/text
predicate disallows it; a refusal leaves the draft and uses send as retry.
